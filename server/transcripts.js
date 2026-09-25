// Incremental reader for Claude Code JSONL transcripts (main sessions and sub-agents).
//
// Each TranscriptTail remembers its byte offset and only parses what was appended since the last
// poll, folding every entry into a compact `state` object: model, context size, pending tool calls,
// tool usage counts, compactions, background-task notifications, titles, cost.
import fs from 'node:fs';
import { toolCategory, toolDetail, trunc, statSafe } from './util.js';

const HEAD_BYTES = 256 * 1024;            // metadata usually lives near the top
const MAX_INITIAL = 12 * 1024 * 1024;     // first read of a huge transcript only parses its tail
const CHUNK = 4 * 1024 * 1024;

export function newTranscriptState() {
  return {
    model: null, modelId: null, modelName: null,
    context: 0, contextIn: 0,
    firstTs: 0, lastTs: 0,
    turn: 'none',                // 'user' (model is up) | 'tools' (waiting on tools) | 'done' | 'none'
    lastStop: null,
    pending: new Map(),          // tool_use id -> { name, cat, detail, since }
    counts: { edit: 0, bash: 0, read: 0, search: 0, web: 0, agent: 0, mcp: 0, plan: 0, skill: 0, other: 0 },
    toolTotal: 0,
    lastTool: null,              // { name, cat, detail, ts }
    compactions: 0, lastCompaction: null, awaitingPost: false,
    notifications: new Map(),    // background task / agent id -> { status, ts }
    agentCalls: new Map(),       // Agent tool_use id -> { description, type, ts }
    prs: new Map(),              // "repo#number" -> { number, url, action, repo, ts } (latest real action)
    lastPromptAt: 0, lastCommand: null,
    title: null, aiTitle: null, lastPrompt: null, permissionMode: null,
    cost: null, cwd: null, projectCwd: null, branch: null, version: null, worktree: null, relocatedCwd: null,
    errorAt: 0, interruptedAt: 0,
  };
}

function readRange(fd, pos, len) {
  const buf = Buffer.allocUnsafe(len);
  const n = fs.readSync(fd, buf, 0, len, pos);
  return n === len ? buf : buf.subarray(0, n);
}

function tsOf(o) {
  if (!o.timestamp) return 0;
  const t = Date.parse(o.timestamp);
  return Number.isFinite(t) ? t : 0;
}

const TASK_NOTE = /<task-notification>([\s\S]*?)<\/task-notification>/g;

// Per-transcript maps keyed by agent / tool call: only recent agents are ever looked up, so a session
// that runs for days keeps just the latest entries (Maps iterate oldest first).
const MAX_REMEMBERED = 500;
function remember(map, key, value) {
  map.delete(key);
  map.set(key, value);
  if (map.size > MAX_REMEMBERED) map.delete(map.keys().next().value);
}

const MAX_PRS = 50;
const PR_URL = /^https?:\/\/[^\s/]+\/([\w.-]+)\/([\w.-]+)\/pull\/\d+/i;
const PR_REPO = /^[\w.-]+\/[\w.-]+$/;

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let s = '';
  for (const c of content) if (c && c.type === 'text' && typeof c.text === 'string') s += c.text;
  return s;
}

export class TranscriptTail {
  constructor(file) {
    this.file = file;
    this.offset = 0;
    this.partial = null;
    this.skipFirst = false;
    this.initialized = false;
    this.mtime = 0;
    this.size = 0;
    this.state = newTranscriptState();
  }

  // Returns true when new data was consumed.
  poll() {
    const st = statSafe(this.file);
    if (!st) return false;
    this.mtime = st.mtimeMs;
    if (st.size < this.offset) {
      this.offset = 0; this.partial = null; this.initialized = false;
      this.state = newTranscriptState();
    }
    if (st.size === this.offset) return false;
    let fd;
    try {
      fd = fs.openSync(this.file, 'r');
      if (!this.initialized && st.size > MAX_INITIAL) {
        this.consume(readRange(fd, 0, HEAD_BYTES), true);
        this.partial = null;
        this.offset = st.size - MAX_INITIAL;
        this.skipFirst = true;
      }
      this.initialized = true;
      while (this.offset < st.size) {
        const buf = readRange(fd, this.offset, Math.min(st.size - this.offset, CHUNK));
        if (!buf.length) break;
        this.offset += buf.length;
        this.consume(buf, false);
      }
      this.size = st.size;
    } catch {
      // transient read errors (file being rotated) are retried on the next poll
    } finally {
      if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
    }
    return true;
  }

  consume(buf, headOnly) {
    let data = this.partial && !headOnly ? Buffer.concat([this.partial, buf]) : buf;
    this.partial = null;
    let start = 0, idx;
    while ((idx = data.indexOf(10, start)) !== -1) {
      if (this.skipFirst && !headOnly) { this.skipFirst = false; start = idx + 1; continue; }
      if (idx > start) this.line(data.toString('utf8', start, idx));
      start = idx + 1;
    }
    if (!headOnly && start < data.length) this.partial = Buffer.from(data.subarray(start));
  }

  line(text) {
    let o;
    try { o = JSON.parse(text); } catch { return; }
    if (o && typeof o === 'object') this.apply(o);
  }

  apply(o) {
    const s = this.state;
    const ts = tsOf(o);
    if (ts) {
      if (!s.firstTs) s.firstTs = ts;
      if (ts > s.lastTs) s.lastTs = ts;
    }
    if (o.cwd) s.cwd = o.cwd;
    if (o.gitBranch) s.branch = o.gitBranch;
    if (o.version) s.version = o.version;
    // Current builds stamp the mode on each user prompt rather than writing 'permission-mode' entries.
    if (typeof o.permissionMode === 'string') s.permissionMode = o.permissionMode;

    switch (o.type) {
      case 'assistant': return this.assistant(o, ts);
      case 'user': return this.user(o, ts);
      case 'system': return this.system(o, ts);
      case 'attachment': {
        const a = o.attachment;
        if (a && a.type === 'model' && a.identity) {
          s.modelId = a.identity.modelId || s.modelId;
          s.modelName = a.identity.marketingName || s.modelName;
        }
        return;
      }
      case 'queue-operation':
        if (typeof o.content === 'string' && o.content.includes('<task-notification>')) this.notes(o.content, ts);
        return;
      case 'custom-title': if (o.customTitle) s.title = o.customTitle; return;
      case 'ai-title': if (o.aiTitle) s.aiTitle = o.aiTitle; return;
      case 'agent-name': if (o.agentName && !s.title) s.title = o.agentName; return;
      case 'last-prompt': if (o.lastPrompt) s.lastPrompt = trunc(o.lastPrompt, 240); return;
      case 'permission-mode': if (o.permissionMode) s.permissionMode = o.permissionMode; return;
      case 'cost-state':
        s.cost = { usd: +o.totalCostUSD || 0, added: +o.totalLinesAdded || 0, removed: +o.totalLinesRemoved || 0 };
        return;
      // `cwd` on entries follows the shell's `cd`s; projectCwd only moves when the session itself relocates.
      case 'worktree-state':
        s.worktree = o.worktreeSession || null;
        s.projectCwd = (o.worktreeSession && o.worktreeSession.worktreePath) || null;
        return;
      case 'relocated': if (o.relocatedCwd) { s.relocatedCwd = o.relocatedCwd; s.projectCwd = o.relocatedCwd; } return;
      // Written (and repeated) whenever the session is linked to a pull request.
      case 'pr-link': this.pr(o.prNumber, o.prUrl, null, o.prRepository, ts); return;
    }
  }

  // A pull request sighting: a `pr-link` entry, or a shell result's gitOperation.pr (which knows what
  // happened to it: created, merged, ...). One entry per PR (a sighting without a repo, e.g. a merge
  // result without a link, belongs to the latest entry with that number). It keeps the latest real
  // action ('linked' until there is one; ts = when that action was seen); a sighting also fills gaps.
  pr(number, url, action, repo, ts) {
    const n = typeof number === 'number' ? number : parseInt(number, 10);
    if (!Number.isSafeInteger(n) || n <= 0) return;
    const link = typeof url === 'string' && url.length <= 400 && /^https?:\/\/\S+$/i.test(url) ? url : null;
    const m = link && PR_URL.exec(link);
    const name = m ? `${m[1]}/${m[2]}` : typeof repo === 'string' && PR_REPO.test(repo) ? repo : null;
    const act = typeof action === 'string' && /^[a-z][\w-]{0,19}$/i.test(action) ? action.toLowerCase() : null;
    const prs = this.state.prs;
    let key = null;
    for (const [k, e] of prs) if (e.number === n && (!name || !e.repo || e.repo === name)) key = k;
    const known = key != null && prs.get(key);
    if (known) {
      if (!known.url && link) known.url = link;
      if (!known.repo && name) known.repo = name;
      if (act && act !== 'linked' && act !== known.action) {
        known.action = act;
        known.ts = ts;
        prs.delete(key);           // most recently touched last, so the cap drops stale PRs first
        prs.set(key, known);
      }
      return;
    }
    prs.set(`${name || ''}#${n}`, { number: n, url: link, action: act || 'linked', repo: name, ts });
    if (prs.size > MAX_PRS) prs.delete(prs.keys().next().value);
  }

  assistant(o, ts) {
    const s = this.state;
    const m = o.message;
    if (!m || typeof m !== 'object') return;
    const synthetic = m.model === '<synthetic>' || o.isApiErrorMessage;
    if (synthetic) { s.errorAt = ts || s.lastTs; return; }
    if (m.model) s.model = m.model;

    const u = m.usage;
    if (u) {
      const input = (+u.input_tokens || 0) + (+u.cache_read_input_tokens || 0) + (+u.cache_creation_input_tokens || 0);
      if (input > 0) {
        const prev = s.contextIn;
        const recentMarker = s.lastCompaction && ts && ts - s.lastCompaction.at < 3 * 60_000;
        if (s.awaitingPost && s.lastCompaction) {
          s.lastCompaction.post = input;
          s.awaitingPost = false;
        } else if (prev > 60_000 && input < prev * 0.45 && !recentMarker && !o.isSidechain) {
          // No explicit marker, but the context collapsed: treat it as a compaction.
          s.compactions++;
          s.lastCompaction = { at: ts || s.lastTs, pre: prev, post: input, trigger: 'inferred' };
        }
        s.contextIn = input;
        s.context = input + (+u.output_tokens || 0);
      }
    }

    if (Array.isArray(m.content)) {
      for (const c of m.content) {
        if (!c || c.type !== 'tool_use') continue;
        const cat = toolCategory(c.name);
        const detail = toolDetail(c.name, c.input);
        if (!s.pending.has(c.id)) {
          s.counts[cat] = (s.counts[cat] || 0) + 1;
          s.toolTotal++;
        }
        s.pending.set(c.id, { name: c.name, cat, detail, since: ts || s.lastTs });
        s.lastTool = { name: c.name, cat, detail, ts: ts || s.lastTs };
        if (c.name === 'Agent' || c.name === 'Task') {
          remember(s.agentCalls, c.id, { description: detail, type: c.input && c.input.subagent_type, ts });
        }
      }
    }
    if (m.stop_reason === 'tool_use') s.turn = 'tools';
    else if (m.stop_reason) {
      // A finished turn means every tool call before it was answered, even if we missed a result.
      s.pending.clear();
      s.turn = 'done';
    } else s.turn = 'user';
    s.lastStop = m.stop_reason || null;
  }

  user(o, ts) {
    const s = this.state;
    const m = o.message;
    if (o.isCompactSummary) {
      const recent = s.lastCompaction && ts && ts - s.lastCompaction.at < 60_000;
      if (!recent) {
        s.compactions++;
        s.lastCompaction = { at: ts || s.lastTs, pre: s.contextIn, post: null, trigger: 'summary' };
        s.awaitingPost = true;
      }
      s.pending.clear();
      // A manual /compact leaves the session waiting for the user; an auto-compaction carries on.
      s.turn = s.lastCompaction && s.lastCompaction.trigger === 'manual' ? 'done' : 'user';
      return;
    }
    if (!m) return;
    const content = m.content;
    let sawResult = false;
    if (Array.isArray(content)) {
      for (const c of content) {
        if (c && c.type === 'tool_result') {
          sawResult = true;
          s.pending.delete(c.tool_use_id);
        }
      }
    }
    const r = o.toolUseResult;
    if (r && typeof r === 'object' && r.agentId && r.status && r.status !== 'async_launched') {
      remember(s.notifications, String(r.agentId), { status: String(r.status), ts });
    }
    const pr = r && typeof r === 'object' && r.gitOperation && typeof r.gitOperation === 'object' && r.gitOperation.pr;
    if (pr && typeof pr === 'object') this.pr(pr.number, pr.url, pr.action, null, ts);
    if (sawResult) {
      s.turn = s.pending.size ? 'tools' : 'user';
      return;
    }
    if (o.isMeta) return;
    const text = textOf(content);
    if (!text) return;
    if (text.includes('<task-notification>')) {
      this.notes(text, ts);
      s.turn = 'user';
      return;
    }
    if (text.startsWith('[Request interrupted')) {
      s.interruptedAt = ts;
      s.pending.clear();
      s.turn = 'done';
      return;
    }
    const cmd = text.match(/<command-name>\/?([^<]+)<\/command-name>/);
    if (cmd) { s.lastCommand = { name: cmd[1].trim(), ts }; return; }
    if (text.startsWith('<local-command') || text.startsWith('<bash-')) return;
    s.lastPromptAt = ts || s.lastTs;
    s.pending.clear();
    s.turn = 'user';
  }

  system(o, ts) {
    const s = this.state;
    if (o.subtype === 'compact_boundary') {
      const meta = o.compactMetadata || {};
      s.compactions++;
      s.lastCompaction = { at: ts || s.lastTs, pre: +meta.preTokens || s.contextIn || null, post: null, trigger: meta.trigger || 'auto' };
      s.awaitingPost = true;
      s.pending.clear();
    } else if (o.subtype === 'turn_duration' || o.subtype === 'stop_hook_summary') {
      if (!s.pending.size) s.turn = 'done';
    } else if (o.subtype === 'api_error') {
      s.errorAt = ts;
    }
  }

  notes(text, ts) {
    for (const m of text.matchAll(TASK_NOTE)) {
      const body = m[1];
      const status = ((body.match(/<status>([^<]+)<\/status>/) || [])[1] || 'completed').trim();
      // One notification can cover several tasks (e.g. "stopped" for a batch of agents).
      for (const id of body.matchAll(/<task-id>([^<]+)<\/task-id>/g)) {
        remember(this.state.notifications, id[1].trim(), { status, ts });
      }
    }
  }
}
