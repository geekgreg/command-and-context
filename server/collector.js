// The collector folds every data source into one "world" snapshot:
//
//   ~/.claude/sessions/<pid>.json   which Claude Code processes are running (the source of truth for
//                                   "active"), their session id, cwd, title, busy/idle status
//   ~/.claude/projects/**.jsonl     what each session and sub-agent is doing, model, context size
//   system probe                    process tree, listening ports, connections, CPU
//   git / docker                    island size, commits, container names
//
// The snapshot is pushed to browsers over SSE. Discrete happenings (clear, compaction, commit, ...)
// are also recorded in a small event ring so the HUD can announce them.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { TranscriptTail } from './transcripts.js';
import { Repos } from './repos.js';
import { Docker } from './docker.js';
import { createProbe } from './system.js';
import { ROOT, DEFAULT_PORT } from './config.js';
import {
  cleanPath, pathKey, isInside, basename, trunc, readJson, statSafe, factionOf, modelLabel, contextMax, shortCmd,
  isQuickTool, isQuestionTool, clamp, IS_WIN,
} from './util.js';

const AGENT_FILE = /^agent-([A-Za-z0-9_-]+)\.jsonl$/;
const ACTIVE_AGENT = new Set(['working', 'thinking', 'waiting', 'stalled']);
const SHELLS = /^(bash|sh|zsh|dash|cmd|powershell|pwsh|conhost|wsl|git|timeout|sleep|tail|tee|cat|winpty|winpty-agent|openconsole)(\.exe)?$/i;
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const PORT_KINDS_SHOWN = new Set(['node', 'bun', 'deno', 'python', 'php', 'ruby', 'java', 'dotnet', 'go', 'web', 'db', 'docker', 'ai', 'lighthouse']);
// Dev servers an agent may have left running. Databases, containers, AI runtimes and desktop apps are
// long-lived on purpose, so a missing parent says nothing about them.
const DEV_KINDS = new Set(['node', 'bun', 'deno', 'python', 'php', 'ruby', 'java', 'dotnet', 'go', 'web']);

const FRAMEWORKS = [
  [/nuxt/i, 'Nuxt'], [/[\\/]next[\\/]|next(-server|\.js)?\s+(dev|start)/i, 'Next'], [/\bvite\b/i, 'Vite'], [/\bastro\b/i, 'Astro'],
  [/\bremix\b/i, 'Remix'], [/svelte-?kit/i, 'SvelteKit'], [/storybook/i, 'Storybook'], [/webpack/i, 'Webpack'],
  [/\bparcel\b/i, 'Parcel'], [/\bng\s+serve|@angular/i, 'Angular'], [/gatsby/i, 'Gatsby'], [/\bexpo\b/i, 'Expo'],
  [/wrangler|workerd/i, 'Wrangler'], [/nodemon/i, 'Nodemon'], [/json-server/i, 'JSON Server'], [/@nestjs|\bnest\s+start/i, 'Nest'],
  [/uvicorn/i, 'Uvicorn'], [/gunicorn/i, 'Gunicorn'], [/\bflask\b/i, 'Flask'], [/runserver|django/i, 'Django'],
  [/streamlit/i, 'Streamlit'], [/jupyter/i, 'Jupyter'], [/http\.server/i, 'SimpleHTTP'], [/fastapi/i, 'FastAPI'],
  [/artisan\s+serve|laravel/i, 'Laravel'], [/php\s+-S/i, 'PHP'], [/\brails\b|\bpuma\b/i, 'Rails'], [/\bhugo\b/i, 'Hugo'],
  [/jekyll/i, 'Jekyll'], [/ollama/i, 'Ollama'], [/http-server|live-server|\bnpx\s+serve\b/i, 'Static'],
];
const WELL_KNOWN = {
  5432: 'Postgres', 6379: 'Redis', 3306: 'MySQL', 27017: 'Mongo', 11434: 'Ollama', 9229: 'Inspector', 5173: 'Vite',
  4200: 'Angular', 6006: 'Storybook', 24678: 'Vite HMR', 54321: 'Supabase API', 54322: 'Supabase DB',
  54323: 'Supabase Studio', 54324: 'Inbucket', 54327: 'Supabase Logs', 8888: 'Jupyter', 9200: 'Elastic', 1433: 'SQL Server',
};

function classify(name, cmd) {
  const n = String(name || '').toLowerCase().replace(/\.exe$/, '');
  if (/^(com\.docker\.backend|wslrelay|vpnkit|com\.docker\.vpnkit|docker|dockerd|docker-proxy|com\.docker\.proxy)$/.test(n)) return 'docker';
  if (/^(postgres|pg_ctl|redis-server|mongod|mysqld|mariadbd|memcached|clickhouse|cockroach|sqlservr)$/.test(n)) return 'db';
  if (/^(msedge|chrome|chromium|firefox|brave|headless_shell|chrome-headless-shell)$/.test(n)) {
    return /--headless|--remote-debugging/.test(cmd || '') ? 'browser' : 'app';
  }
  if (n === 'node' || n === 'bun' || n === 'deno') return n;
  if (/^(python\d*|pythonw|py|uv|uvicorn|gunicorn|flask|streamlit|jupyter.*)$/.test(n)) return 'python';
  if (/^php/.test(n)) return 'php';
  if (/^(ruby|rails|puma)$/.test(n)) return 'ruby';
  if (/^javaw?$/.test(n)) return 'java';
  if (n === 'dotnet') return 'dotnet';
  if (/^(go|air)$/.test(n)) return 'go';
  if (/^(nginx|httpd|caddy)$/.test(n)) return 'web';
  if (/ollama|lmstudio|llama/.test(n)) return 'ai';
  if (n === 'claude') return 'claude';
  if (/^(system|svchost|lsass|wininit|services|spoolsv|searchindexer|smss|csrss|winlogon|dashost|lsaiso)$/.test(n)) return 'system';
  return 'app';
}

function vesselLabel(kind, cmds, container, port) {
  if (container) return container.service || container.name;
  if (kind === 'docker') return WELL_KNOWN[port] || 'Container';
  if (kind === 'lighthouse') return 'Command & Context';
  const text = cmds.join(' ');
  for (const [re, label] of FRAMEWORKS) if (re.test(text)) return label;
  if (WELL_KNOWN[port]) return WELL_KNOWN[port];
  if (kind === 'browser') return 'Headless browser';
  const script = (cmds[0] || '').match(/(?:^|\s)"?(?:[^"\s]*[\\/])?([\w.-]+\.(?:m?js|cjs|ts|py|rb|php))\b/);
  if (script) return script[1];
  return kind[0].toUpperCase() + kind.slice(1);
}

// Processes that only launch other processes (shells, npm and other dev runtimes): a server's "parent"
// is the first ancestor that is none of these.
function isLauncher(name) {
  return SHELLS.test(name || '') || DEV_KINDS.has(classify(name));
}

// The user's own dashboard: this repo's server/index.js (absolute, or relative to the process's folder) on
// the default port or started with --app (the launcher starts it that way, through `start`, which exits at
// once). Seen from another instance (a --dump, an agent's test server on 74xx) it is never a leftover.
// Other instances of the dashboard are ordinary node servers.
const DASHBOARD_SCRIPT = pathKey(path.join(ROOT, 'server', 'index.js'));
const SCRIPT_ARG = /"([^"]*server[\\/]index\.js)"|(?:^|\s)([^\s"]*server[\\/]index\.js)(?=\s|$)/gi;
function isUsersDashboard(info, port) {
  const cmd = (info && info.cmd) || '';
  if (port !== DEFAULT_PORT && !/(?:^|\s)--app(?:[\s=]|$)/.test(cmd)) return false;
  for (const m of cmd.matchAll(SCRIPT_ARG)) {
    const p = m[1] || m[2];
    if (path.isAbsolute(p)) { if (pathKey(p) === DASHBOARD_SCRIPT) return true; }
    else if (!info.cwd || pathKey(path.resolve(info.cwd, p)) === DASHBOARD_SCRIPT) return true;
  }
  return false;
}

function procStartMs(reg) {
  if (reg.procStart) {
    try { return Number((BigInt(reg.procStart) - 116444736000000000n) / 10000n); } catch { /* ignore */ }
  }
  return reg.startedAt || 0;
}

export class Collector extends EventEmitter {
  constructor(cfg, log) {
    super();
    this.cfg = cfg;
    this.log = log;
    this.sessionsDir = path.join(cfg.claudeDir, 'sessions');
    this.projectsDir = path.join(cfg.claudeDir, 'projects');
    this.buildings = new Map();
    this.dead = new Set();            // "pid:procStart" of processes known to have exited
    this.sessionSpans = new Map();    // session id -> [[from, to], ...]: when this run saw it live (see leftBehindBy)
    this.repos = new Repos(log);
    this.repos.onEvent = (type, data) => this.pushEvent(type, data);
    this.docker = new Docker();
    this.probe = createProbe(log);
    this.sys = null;                  // latest good probe snapshot
    this.probing = null;              // the probe request in flight, if any
    this.probeResult = null;          // a finished probe waiting for the next tick: { snap, pids }
    this.listenCount = 0;             // listening sockets in the last TCP read that was trusted
    this.suspectReads = 0;            // consecutive failed / suspiciously empty TCP reads
    this.portState = new Map();
    this.procCpu = new Map();         // "pid:created" -> { k, t, rate }
    this.events = [];
    this.eventSeq = 0;
    this.warm = false;
    this.snapshot = null;
    this.index = new Map();           // session id -> transcript path, from a full scan of projects/
    this.indexAt = 0;
    this.indexGap = 15_000;
    this.next = { registry: 0, system: 0, agents: 0, heads: 0 };
    this.startedAt = Date.now();
    this.registryMissing = false;
  }

  start() {
    this.tick(true);
    this.timer = setInterval(() => this.tick(false), this.cfg.tickMs);
  }

  stop() {
    clearInterval(this.timer);
    this.probe.stop();
  }

  async tick(first) {
    if (this.ticking) return;
    this.ticking = true;
    try {
      let now = Date.now();
      // The first tick waits for `docker ps` so container ports are grouped from the first snapshot
      // (otherwise every container port closes and reopens under a new id a few seconds later).
      const docker = this.docker.poll().catch(() => {});
      if (first) await docker;
      if (first || now >= this.next.registry) { this.readRegistry(now); this.next.registry = now + this.cfg.registryMs; }
      let asked = false;
      if (first || now >= this.next.system) { this.next.system = now + this.cfg.systemMs; asked = this.requestSystem(); }
      // A probe usually answers in well under a second, so give a fresh one a moment to land in this
      // tick. A slow one is picked up by a later tick instead of freezing sessions and events. The first
      // tick waits longer so the first snapshot already has ports and processes (a cold PowerShell
      // takes seconds to start).
      if (asked && this.probing) {
        let timer;
        await Promise.race([this.probing, new Promise((r) => { timer = setTimeout(r, first ? 20_000 : 700); })]);
        clearTimeout(timer);
        now = Date.now();
      }
      if (this.probeResult) {
        const res = this.probeResult;
        this.probeResult = null;
        this.applySystem(res, now);
      }
      this.pollTranscripts(now);
      if (first || now >= this.next.agents) { this.scanAgents(now); this.next.agents = now + 2000; }
      if (now >= this.next.heads) { this.next.heads = now + 10_000; this.checkHeads(); }
      this.updateStates(now);
      this.snapshot = this.buildSnapshot(now);
      this.warm = true;
      this.emit('snapshot', this.snapshot);
    } catch (e) {
      this.log.error('tick failed: ' + (e && e.stack || e));
    } finally {
      this.ticking = false;
    }
  }

  pushEvent(type, data) {
    if (!this.warm) return;
    // id/t/type go last so a payload field can never clobber the strictly increasing event id.
    const ev = { ...data, id: ++this.eventSeq, t: Date.now(), type };
    this.events.push(ev);
    if (this.events.length > 120) this.events.splice(0, this.events.length - 120);
  }

  // ---- registry ----------------------------------------------------------------------------

  readRegistry(now) {
    let files;
    try {
      files = fs.readdirSync(this.sessionsDir).filter((f) => /^\d+\.json$/.test(f));
      this.registryMissing = false;
    } catch {
      this.registryMissing = true;
      return this.readFallback(now);
    }
    const byKey = new Map();
    const unreadable = new Set();     // pids whose file exists but is mid-write / incomplete right now
    const deadSeen = new Set();
    for (const f of files) {
      const reg = readJson(path.join(this.sessionsDir, f));
      if (!reg || !reg.pid || !reg.sessionId) { unreadable.add(parseInt(f, 10)); continue; }
      const deadKey = `${reg.pid}:${reg.procStart || reg.startedAt}`;
      if (this.dead.has(deadKey)) { deadSeen.add(deadKey); continue; }
      const key = reg.hostSessionId || `pid:${reg.pid}:${reg.procStart || reg.startedAt || ''}`;
      const prev = byKey.get(key);
      if (prev && (prev.startedAt || 0) > (reg.startedAt || 0)) continue;
      byKey.set(key, reg);
    }
    // Only stale files of dead processes need remembering; forget the rest so the set cannot grow.
    for (const k of this.dead) if (!deadSeen.has(k)) this.dead.delete(k);
    for (const [key, reg] of byKey) {
      const b = this.buildings.get(key);
      if (!b || b.endedAt) {
        if (b) this.buildings.delete(key);
        this.buildings.set(key, this.createBuilding(key, reg, now));
      } else {
        b.missing = 0;
        this.updateBuilding(b, reg, now);
      }
    }
    for (const b of this.buildings.values()) {
      if (b.source !== 'registry' || b.endedAt || byKey.has(b.key) || unreadable.has(b.pid)) continue;
      // Two consecutive misses, so one racy directory listing does not decommission a live session.
      if (++b.missing >= 2) this.endBuilding(b, now, false);
    }
  }

  // Older Claude Code builds have no session registry: treat recently written transcripts as live.
  readFallback(now) {
    const windowMs = this.cfg.fallbackActiveMin * 60_000;
    this.refreshIndex(now);
    const live = new Set();
    for (const [sid, file] of this.index) {
      const st = statSafe(file);
      if (!st || now - st.mtimeMs > windowMs) continue;
      const key = `sid:${sid}`;
      live.add(key);
      if (!this.buildings.has(key)) {
        const reg = { pid: 0, sessionId: sid, cwd: null, startedAt: st.birthtimeMs || st.mtimeMs, status: 'busy' };
        const b = this.createBuilding(key, reg, now);
        b.source = 'fallback';
        this.buildings.set(key, b);
      }
    }
    for (const b of this.buildings.values()) {
      if (b.source === 'fallback' && !b.endedAt && !live.has(b.key)) this.endBuilding(b, now);
    }
  }

  createBuilding(key, reg, now) {
    const b = {
      key, source: 'registry', reg, pid: reg.pid, procStart: procStartMs(reg), sessionId: reg.sessionId,
      firstSeen: now, endedAt: 0, clears: 0, tail: null, transcript: null, agentDirs: [], agents: new Map(),
      agentFiles: 0, state: null, stateSince: now, tool: null, detail: '', lastActivity: reg.startedAt || now,
      seenCompactions: null, ctxWarned: false, retryAt: 0, view: null, missing: 0,
      sidSince: procStartMs(reg) || now,   // since when this session id has been live in this process
      prsSeen: new Map(),             // PR number -> [{ repo, action }] this session has shown (announced or already there)
    };
    this.attachTranscript(b, now);
    this.pushEvent('session_start', { key, name: this.nameOf(b), cwd: reg.cwd });
    return b;
  }

  updateBuilding(b, reg, now) {
    b.reg = reg;
    if (reg.pid !== b.pid) { b.pid = reg.pid; b.procStart = procStartMs(reg); }
    if (reg.sessionId !== b.sessionId) {
      const from = b.sessionId;
      this.noteSpan(from, b.sidSince, now);
      b.sidSince = now;
      b.sessionId = reg.sessionId;
      b.clears++;
      b.tail = null;
      b.transcript = null;
      b.seenCompactions = null;
      b.ctxWarned = false;
      this.attachTranscript(b, now);
      this.pushEvent('clear', { key: b.key, name: this.nameOf(b), from, to: reg.sessionId });
    }
  }

  // markDead: the process itself is gone, so a registry file it leaves behind must not revive it.
  endBuilding(b, now, markDead = true) {
    if (b.endedAt) return;
    b.endedAt = now;
    this.noteSpan(b.sessionId, b.sidSince, now);
    if (b.pid && markDead) this.dead.add(`${b.pid}:${b.reg.procStart || b.reg.startedAt}`);
    this.pushEvent('session_end', { key: b.key, name: this.nameOf(b) });
  }

  // Remember when a session id was live, so leftBehindBy need not trust a resumed transcript's first..last.
  noteSpan(sid, from, to) {
    if (!sid) return;
    const spans = this.sessionSpans.get(sid) || [];
    this.sessionSpans.delete(sid);
    spans.push([from || to, to]);
    this.sessionSpans.set(sid, spans.slice(-20));
    if (this.sessionSpans.size > 500) this.sessionSpans.delete(this.sessionSpans.keys().next().value);
  }

  // With --no-prompts an untitled session is named after its folder: the name reaches labels and events.
  nameOf(b) {
    const s = b.tail && b.tail.state;
    const prompt = this.cfg.showPrompts && s && s.lastPrompt;
    return trunc(b.reg.name || (s && (s.title || s.aiTitle)) || prompt || basename(b.reg.cwd || (s && s.cwd)) || 'Session', 60);
  }

  // ---- transcripts ---------------------------------------------------------------------------

  // Rebuilt from scratch each time, so transcripts deleted from disk drop out of it.
  refreshIndex(now) {
    this.indexAt = now;
    let dirs;
    try { dirs = fs.readdirSync(this.projectsDir, { withFileTypes: true }); } catch { return; }
    const index = new Map();
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      let files;
      try { files = fs.readdirSync(path.join(this.projectsDir, d.name)); } catch { continue; }
      for (const f of files) if (f.endsWith('.jsonl')) index.set(f.slice(0, -6), path.join(this.projectsDir, d.name, f));
    }
    this.index = index;
  }

  findTranscript(sessionId, cwd, now) {
    if (cwd) {
      const guess = path.join(this.projectsDir, cwd.replace(/[^A-Za-z0-9-]/g, '-'), `${sessionId}.jsonl`);
      if (statSafe(guess)) return guess;
    }
    // The full scan reads every project folder. A session that has not been prompted yet has no
    // transcript and can stay that way for hours, so the scan backs off (to once a minute) while it
    // keeps missing. The cheap guess above is still tried on every attempt.
    if (!this.index.has(sessionId) && now - this.indexAt >= this.indexGap) {
      this.refreshIndex(now);
      this.indexGap = this.index.has(sessionId) ? 15_000 : Math.min(this.indexGap * 2, 60_000);
    }
    const hit = this.index.get(sessionId);
    return hit && statSafe(hit) ? hit : null;
  }

  attachTranscript(b, now) {
    const file = this.findTranscript(b.sessionId, b.reg.cwd, now);
    if (!file) { b.retryAt = now + 3000; return; }
    b.transcript = file;
    b.tail = new TranscriptTail(file);
    b.tail.poll();
    this.baselinePrs(b, b.tail);
    const dir = path.join(path.dirname(file), b.sessionId, 'subagents');
    b.agentDirs = [dir, ...b.agentDirs.filter((d) => d !== dir)].slice(0, 3);
    if (!b.reg.cwd && b.tail.state.cwd) b.reg.cwd = b.tail.state.cwd;
  }

  pollTranscripts(now) {
    for (const b of this.buildings.values()) {
      if (b.endedAt) continue;
      if (!b.tail && now >= b.retryAt) this.attachTranscript(b, now);
      if (b.tail) b.tail.poll();
      for (const a of b.agents.values()) a.tail.poll();
    }
  }

  scanAgents(now) {
    const linger = this.cfg.agentLingerMin * 60_000;
    for (const b of this.buildings.values()) {
      if (b.endedAt) continue;
      let total = 0;
      for (const dir of b.agentDirs) {
        let files;
        try { files = fs.readdirSync(dir); } catch { continue; }
        for (const f of files) {
          const m = AGENT_FILE.exec(f);
          if (!m) continue;
          total++;
          const id = m[1];
          if (b.agents.has(id)) continue;
          const file = path.join(dir, f);
          const st = statSafe(file);
          if (!st || now - st.mtimeMs > linger) continue;
          const a = {
            id, file, metaFile: path.join(dir, `agent-${id}.meta.json`), meta: null,
            tail: new TranscriptTail(file), firstSeen: now, fresh: this.warm,
            state: null, stateSince: now, doneAt: 0, tool: null,
          };
          a.meta = readJson(a.metaFile);
          a.tail.poll();
          this.baselinePrs(b, a.tail);
          b.agents.set(id, a);
        }
      }
      b.agentFiles = total;
    }
  }

  // ---- system: liveness, ports, processes ------------------------------------------------------

  // Start a probe unless one is still in flight (returns whether it did). The result is picked up by
  // applySystem in a tick.
  requestSystem() {
    if (this.probing) return false;
    const pids = [];
    for (const b of this.buildings.values()) if (!b.endedAt && b.pid) pids.push(b.pid);
    const done = (snap) => { this.probeResult = { snap, pids: new Set(pids) }; };
    this.probing = Promise.resolve()
      .then(() => this.probe.snapshot(pids))
      .then(done, (e) => { this.log.warn('system probe failed: ' + (e && e.message || e)); done(null); })
      .finally(() => { this.probing = null; });
    return true;
  }

  // Is the process with this creation time (ms) still the session's own, or a reused PID?
  sameProcess(b, created) {
    if (!b.procStart || !created) return true;
    // procStart is the exact creation time. Without it we only have startedAt, stamped after the
    // CLI booted (can be seconds later), so just require the process to predate it.
    return b.reg.procStart ? Math.abs(created - b.procStart) < 3000 : created < b.procStart + 3000;
  }

  applySystem({ snap, pids }, now) {
    // A process list without this very process is a failed OS snapshot, not proof every session died.
    if (snap && !snap.procs.has(process.pid)) {
      this.log.warn('system probe returned an implausible process list; skipping it');
      snap = null;
    }
    if (!snap) return this.fallbackLiveness(now);
    this.sys = snap;
    this.children = new Map();
    for (const p of snap.procs.values()) {
      if (!this.children.has(p.ppid)) this.children.set(p.ppid, []);
      this.children.get(p.ppid).push(p.pid);
    }
    for (const b of this.buildings.values()) {
      // Only judge sessions the probe was asked about: one that appeared while it ran may be missing.
      if (b.endedAt || !b.pid || !pids.has(b.pid)) continue;
      const info = snap.info.get(b.pid);
      if (!snap.procs.has(b.pid) || !this.sameProcess(b, info && info.c)) this.endBuilding(b, now);
    }
    // Rates use the probe's own clock: a reply that missed its tick is applied a tick late.
    this.updateProcCpu(snap, snap.t || now);
    // An empty or failed TCP table read means "unknown", not "every port closed" (which would make
    // every boat sail off and come back a probe later). Keep the ports we have unless the next probe
    // agrees; a machine with really no listeners left gets there one probe later.
    // An IPv6 read that has just started failing is suspect too, but one that fails every time is
    // ignored (its listeners are then simply unknown), or it would switch this protection off for good.
    const v6Lost = snap.tcp6Ok === false && this.tcp6Ok !== false;
    const suspect = !snap.tcpOk || v6Lost || (!snap.listen.length && this.listenCount > 0);
    this.suspectReads = suspect ? (this.suspectReads || 0) + 1 : 0;
    if (suspect && this.suspectReads < 2) return;
    this.tcp6Ok = snap.tcp6Ok !== false;
    this.listenCount = snap.listen.length;
    this.updatePorts(snap, now);
  }

  // No probe: signal 0 says whether *a* process has the pid. Now and then, also compare its creation
  // time with the session's, so a PID reused by another program does not keep a closed session alive.
  fallbackLiveness(now) {
    const check = [];
    for (const b of this.buildings.values()) {
      if (b.endedAt || !b.pid) continue;
      try { process.kill(b.pid, 0); } catch (e) { if (e.code === 'ESRCH') { this.endBuilding(b, now); continue; } }
      if (b.procStart) check.push([b, b.pid]);
    }
    if (!check.length || this.startCheck || now < (this.nextStartCheck || 0) || !this.probe.startTimes) return;
    // Each check is a PowerShell start: back off with the probe once it looks blocked for good.
    this.nextStartCheck = now + ((this.probe.failures || 0) > 8 ? 10 * 60_000 : 30_000);
    this.startCheck = this.probe.startTimes(check.map(([, pid]) => pid)).then((times) => {
      for (const [b, pid] of check) {
        const created = times.get(pid);
        if (!b.endedAt && b.pid === pid && created && !this.sameProcess(b, created)) this.endBuilding(b, Date.now());
      }
    }).catch(() => {}).finally(() => { this.startCheck = null; });
  }

  updateProcCpu(snap, now) {
    const seen = new Set();
    for (const [pid, info] of snap.info) {
      const key = `${pid}:${info.c}`;
      seen.add(key);
      const prev = this.procCpu.get(key);
      const io = +info.io || 0;
      if (prev && now > prev.t) {
        const rate = Math.max(0, (info.k - prev.k) / (now - prev.t));
        const ioRate = Math.max(0, (io - prev.io) / ((now - prev.t) / 1000));   // bytes per second, unsmoothed
        this.procCpu.set(key, { k: info.k, io, t: now, rate: prev.rate * 0.4 + rate * 0.6, ioRate });
      } else {
        this.procCpu.set(key, { k: info.k, io, t: now, rate: 0, ioRate: 0 });
      }
    }
    for (const k of this.procCpu.keys()) if (!seen.has(k)) this.procCpu.delete(k);
  }

  cpuOf(pid) {
    const info = this.sys && this.sys.info.get(pid);
    if (!info) return 0;
    const c = this.procCpu.get(`${pid}:${info.c}`);
    return c ? c.rate : 0;
  }

  ioOf(pid) {
    const info = this.sys && this.sys.info.get(pid);
    if (!info) return 0;
    const c = this.procCpu.get(`${pid}:${info.c}`);
    return c ? c.ioRate || 0 : 0;
  }

  // Child pids of `pid`, minus processes older than it: Windows keeps a dead parent's pid as ppid, and
  // that pid may since have been reused by an unrelated (e.g. Claude) process.
  kidsOf(pid) {
    const kids = this.children && this.children.get(pid);
    if (!kids) return null;
    const pc = (this.sys.info.get(pid) || {}).c;
    if (!pc) return kids;
    return kids.filter((k) => { const kc = (this.sys.info.get(k) || {}).c; return !kc || kc >= pc - 1000; });
  }

  descendants(pid, limit = 300) {
    const out = [];
    const stack = [pid];
    while (stack.length && out.length < limit) {
      const kids = this.kidsOf(stack.pop());
      if (!kids) continue;
      for (const k of kids) { out.push(k); stack.push(k); }
    }
    return out;
  }

  ownerOf(pid) {
    const snap = this.sys;
    if (!snap) return null;
    const byPid = new Map();
    for (const b of this.buildings.values()) if (!b.endedAt && b.pid) byPid.set(b.pid, b);
    let cur = pid;
    let childCreated = (snap.info.get(pid) || {}).c || Infinity;
    for (let i = 0; i < 24 && cur > 4; i++) {
      const b = byPid.get(cur);
      if (b) return b;
      const p = snap.procs.get(cur);
      if (!p || !p.ppid || p.ppid === cur) return null;
      const up = snap.info.get(p.ppid);
      if (up && up.c && up.c > childCreated + 1000) return null; // parent is younger: PID was reused
      if (up && up.c) childCreated = up.c;
      cur = p.ppid;
    }
    return null;
  }

  updatePorts(snap, now) {
    const groups = new Map();
    for (const l of snap.listen) {
      if (this.cfg.ignorePorts.includes(l.port)) continue;
      let g = groups.get(l.port);
      if (!g) { g = { port: l.port, pids: new Set(), addrs: new Set() }; groups.set(l.port, g); }
      g.pids.add(l.pid);
      g.addrs.add(l.addr);
    }
    const seen = new Set();
    for (const g of groups.values()) {
      const pids = [...g.pids];
      const pick = pids.find((p) => classify((snap.procs.get(p) || {}).name) !== 'docker') || pids[0];
      const proc = snap.procs.get(pick);
      const info = snap.info.get(pick);
      const name = proc ? proc.name : '?';
      const cmd = info && info.cmd || '';
      let kind = classify(name, cmd);
      const container = this.docker.byPort.get(g.port) || null;
      if (container) kind = 'docker';
      if (pick === process.pid && g.port === this.cfg.port) kind = 'lighthouse';
      const owner = kind === 'lighthouse' ? null : this.ownerOf(pick);
      // One vessel per container, however many ports it publishes.
      const id = container ? `ctr:${container.name}` : String(g.port);
      const prev = this.portState.get(id);
      if (prev && prev.pid !== pick && !owner && !seen.has(id)) this.handOver(prev, pick);
      // A vessel a session once owned stays listed after it loses its owner (an app or a headless
      // browser left behind is exactly the kind of stray worth seeing).
      const known = !!(prev && prev.lastOwner);
      if (!owner && !known && !PORT_KINDS_SHOWN.has(kind) && !this.cfg.showAllPorts) continue;
      if (kind === 'browser' && !owner && !known && !this.cfg.showAllPorts) continue;
      if (kind === 'claude' && !this.cfg.showAllPorts) continue;

      if (seen.has(id)) {
        const v = this.portState.get(id).view;
        if (v && !v.ports.includes(g.port)) v.ports.push(g.port);
        continue;
      }
      seen.add(id);
      let ps = this.portState.get(id);
      if (!ps) {
        ps = { since: now, lastActive: now, remotes: new Set(), pid: pick, activity: 0, restarts: 0, cold: !this.warm, updates: 0 };
        this.portState.set(id, ps);
        this.pushEvent('port_open', { port: g.port, portId: id });
      }
      if (ps.pid !== pick) { ps.restarts++; ps.pid = pick; }
      ps.updates++;

      // Activity: CPU of the serving process tree, plus brand-new client connections.
      const tree = [pick, ...this.descendants(pick, 60)];
      let rate = 0;
      for (const p of tree) rate += this.cpuOf(p);
      const remotes = [];
      for (const p of pids) remotes.push(...(snap.est.get(`${g.port}:${p}`) || []));
      let fresh = 0;
      for (const r of remotes) if (!ps.remotes.has(r)) fresh++;
      ps.remotes = new Set(remotes);
      let activity;
      if (kind === 'docker' && container) activity = clamp((this.docker.cpu.get(container.name) || 0) / 0.25, 0, 1);
      else {
        activity = clamp((rate - 0.02) / 0.3, 0, 1);
        // I/O bytes of the tree: a single small page load (a few KB) barely moves CPU but always shows here.
        // The baseline tracks the server's own idle chatter (IPC heartbeats, file watchers) and ignores bursts.
        let ioRate = 0;
        for (const p of tree) ioRate += this.ioOf(p);
        if (ps.ioBase == null) ps.ioBase = ioRate;
        if (ioRate < ps.ioBase * 3 + 512) ps.ioBase = ps.ioBase * 0.9 + ioRate * 0.1;
        activity = Math.max(activity, clamp((ioRate - ps.ioBase * 2 - 300) / 3000, 0, 1));
      }
      if (fresh) activity = Math.max(activity, clamp(0.3 + 0.12 * fresh, 0, 1));
      ps.activity = activity;
      if (activity > 0.06) ps.lastActive = now;

      const cmds = [cmd, ...tree.slice(1, 6).map((p) => (snap.info.get(p) || {}).cmd).filter(Boolean)];
      // A container's only meaningful cwd is its compose dir; the docker backend's own cwd is noise.
      const cwd = cleanPath(container ? container.workingDir : info && info.cwd);
      const label = vesselLabel(kind, cmds, container, g.port);
      const mine = kind === 'node' && isUsersDashboard(info, g.port);
      const adrift = kind === 'lighthouse' ? null : this.driftOf(ps, { id, port: g.port, label, owner, kind, pid: pick, cwd, mine }, now);
      ps.view = {
        id, port: g.port, ports: [g.port], addrs: [...g.addrs], pid: pick, proc: name, kind, label,
        cmd: shortCmd(cmd), cwd, owner: owner ? owner.key : null,
        container: container ? { name: container.name, image: container.image, project: container.project, status: container.status } : null,
        activity: Math.round(activity * 100) / 100, conns: remotes.length, lastActive: ps.lastActive, since: ps.since,
        restarts: ps.restarts,
        cpu: Math.round((container ? this.docker.cpu.get(container.name) || 0 : rate) * 1000) / 1000,
        adrift,
      };
    }
    for (const [id, ps] of this.portState) {
      if (!seen.has(id)) {
        this.portState.delete(id);
        this.pushEvent('port_close', { port: ps.view ? ps.view.port : null, portId: id, label: ps.view && ps.view.label });
      }
    }
  }

  // ---- adrift ports: servers nobody is tending ---------------------------------------------------
  //
  // Each port remembers its last owning session. A port is adrift when
  //   owner-ended  it has no owner now and the remembered owner's session has ended (or is gone), or
  //   orphaned     it never had one we know of, it is a dev server, the chain of shells and runtimes that
  //                launched it ends at an exited process, no live session could have started it (none
  //                whose folder contains the server's cwd and that is older than the server), and a
  //                session that has since ended was at work in its folder when it was created
  //                (leftBehindBy: the evidence, and the port's guessed lastOwner).
  // When such a live session does exist, the server is probably its background job: it becomes the
  // port's remembered owner (a guess), so the port is flagged owner-ended once that session ends. With
  // neither, the server is the user's own (started with `start`, Start-Process, pm2, a daemon, ...).
  // A condition must hold on two consecutive port updates to raise the flag, and fail on two to lower
  // it (a real owner lowers it at once), so a probe hiccup cannot make it flicker.
  // The user's own dashboard (v.mine) is never adrift, whoever started it.
  driftOf(ps, v, now) {
    if (v.mine) { ps.drift = null; ps.driftCand = null; ps.driftMiss = 0; return null; }
    if (v.owner) {
      ps.lastOwner = { key: v.owner.key, name: this.nameOf(v.owner), guess: false };
      ps.drift = null; ps.driftCand = null; ps.driftMiss = 0;
      return null;
    }
    let cand = null;
    const lo = ps.lastOwner;
    const lob = lo && this.buildings.get(lo.key);
    const loLive = !!lob && !lob.endedAt;
    if (loLive) lo.name = this.nameOf(lob);
    if (lob && lob.endedAt) lo.endedAt = lob.endedAt;   // kept for handOver: the building goes after a while
    if (lo && !loLive) cand = { reason: 'owner-ended', at: (lob && lob.endedAt) || now };
    else if (!lo && DEV_KINDS.has(v.kind) && v.cwd && this.orphaned(v.pid)) {
      const s = this.tenderOf(v.cwd, v.pid);
      if (s) ps.lastOwner = { key: s.key, name: this.nameOf(s), guess: true };
      else {
        // Looked up again every 30 s (or when another process takes the port): it reads the file system.
        if (ps.leftByPid !== v.pid || now - (ps.leftByAt || 0) > 30_000) {
          ps.leftBy = this.leftBehindBy(v.cwd, (this.sys.info.get(v.pid) || {}).c || 0, now);
          ps.leftByPid = v.pid;
          ps.leftByAt = now;
        }
        if (ps.leftBy) cand = { reason: 'orphaned', at: now };
      }
    }

    if (!cand) {
      ps.driftCand = null;
      if (ps.drift && ++ps.driftMiss >= 2) ps.drift = null;
    } else {
      ps.driftMiss = 0;
      if (!ps.driftCand || ps.driftCand.reason !== cand.reason) ps.driftCand = { ...cand, hits: 0, from: ps.updates };
      if (++ps.driftCand.hits >= 2) {
        if (!ps.drift) {
          ps.drift = { since: ps.driftCand.at, reason: cand.reason };
          // Strays that were already adrift when the dashboard started are shown, not announced.
          if (!(ps.cold && ps.driftCand.from === 1)) {
            this.pushEvent('port_adrift', { port: v.port, portId: v.id, label: v.label, reason: cand.reason, lastOwner: this.driftOwner(ps, cand.reason) });
          }
        } else ps.drift.reason = cand.reason;   // still adrift, for a new reason: keep `since`
      }
    }
    return ps.drift ? { since: ps.drift.since, reason: ps.drift.reason, lastOwner: this.driftOwner(ps, ps.drift.reason) } : null;
  }

  // Another process has taken over the port, and it has no owner. It is a new server (e.g. the user's
  // own dev server on the port a session's server used to hold), not the remembered owner's: forget
  // that owner and the drift. Unless it was created before that session ended (or while it still runs):
  // then it plausibly belongs to it (a watcher restarting its child, a second worker).
  handOver(ps, pick) {
    const lo = ps.lastOwner;
    if (lo) {
      const lob = this.buildings.get(lo.key);
      const ended = lob ? lob.endedAt || Infinity : lo.endedAt || 0;
      const created = ((this.sys && this.sys.info.get(pick)) || {}).c || 0;
      if (created && created < ended) return;
    }
    ps.lastOwner = null;
    ps.drift = null; ps.driftCand = null; ps.driftMiss = 0;
    ps.leftBy = null; ps.leftByPid = null;
  }

  driftOwner(ps, reason) {
    const lo = reason === 'owner-ended' ? ps.lastOwner : reason === 'orphaned' ? ps.leftBy : null;
    return lo ? { key: lo.key, name: lo.name, guess: lo.guess } : null;
  }

  // The session that most plausibly left a server behind: a Claude Code session that is no longer
  // running, whose folder is the server's cwd or contains it, and whose transcript was being written
  // when the server process was created (first entry at or before that moment, last write at or after
  // it). Transcripts live in projects/<the session's cwd with every character but A-Z a-z 0-9 - turned
  // into '-'>/<session id>.jsonl (as findTranscript guesses them), so the candidates are the project
  // folders of the server's cwd and of its parents. A drive root or the home folder counts only as the
  // server's own cwd: a session there would contain every server on the machine. The deepest folder
  // wins, then the session that started last. The folders are listed directly rather than through
  // this.index, which is only rebuilt when a transcript is missing and can be hours old.
  // A resumed transcript's first..last also covers the days it was not running: for a server created
  // while this dashboard was already watching, only the spans it saw the session live count.
  // Returns { key (its building while that lingers, else null), name, guess: true } or null.
  leftBehindBy(cwd, created, now) {
    if (!cwd || !created) return null;
    const SLACK = 5000;
    const watched = created > this.startedAt + 60_000;
    const live = new Set();
    for (const b of this.buildings.values()) if (!b.endedAt && b.sessionId) live.add(b.sessionId);
    const home = pathKey(os.homedir());
    let best = null;
    let dir = cleanPath(cwd);
    for (let depth = 0; dir && depth < 40 && !best; depth++) {
      const parent = path.dirname(dir);
      if (depth === 0 || (parent !== dir && pathKey(dir) !== home)) {
        for (const t of this.transcriptsIn(dir, now)) {
          if (live.has(t.sid) || t.mtime < created - SLACK) continue;
          if (watched && !(this.sessionSpans.get(t.sid) || []).some(([a, z]) => a <= created + SLACK && created <= z + SLACK)) continue;
          const head = this.headOf(t);
          if (!head.first || head.first > created + SLACK) continue;
          // Folder names are lossy ("a-b" could be "a\b"): trust the transcript's own cwd when it has one.
          if (head.cwd && pathKey(head.cwd) !== pathKey(dir)) continue;
          if (!best || head.first > best.first) best = { ...t, first: head.first, dir };
        }
      }
      if (parent === dir) break;
      dir = parent;
    }
    if (!best) return null;
    // Never a prompt: a title, else the folder, as nameOf gives with --no-prompts.
    let b = null;
    for (const x of this.buildings.values()) if (x.sessionId === best.sid) b = x;
    const s = b && b.tail && b.tail.state;
    const title = (b && b.reg.name) || (s && (s.title || s.aiTitle)) || this.titleOf(best);
    return { key: b ? b.key : null, name: trunc(title || basename(best.dir) || 'Session', 60), guess: true };
  }

  // Session transcripts in the project folder of `dir`: [{ sid, file, mtime, size }], listed at most every 30 s.
  transcriptsIn(dir, now) {
    const want = dir.replace(/[^A-Za-z0-9-]/g, '-');
    if (!this.projDirs || now - this.projDirs.at > 30_000) {
      const names = new Map();
      try {
        for (const d of fs.readdirSync(this.projectsDir, { withFileTypes: true })) {
          if (d.isDirectory()) names.set(IS_WIN ? d.name.toLowerCase() : d.name, d.name);
        }
      } catch { /* no projects folder */ }
      this.projDirs = { at: now, names, lists: new Map() };
    }
    const real = this.projDirs.names.get(IS_WIN ? want.toLowerCase() : want);
    if (!real) return [];
    let list = this.projDirs.lists.get(real);
    if (!list) {
      list = [];
      const base = path.join(this.projectsDir, real);
      let files = [];
      try { files = fs.readdirSync(base); } catch { /* gone */ }
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue;
        const file = path.join(base, f);
        const st = statSafe(file);
        if (st && st.isFile()) list.push({ sid: f.slice(0, -6), file, mtime: st.mtimeMs, size: st.size });
      }
      this.projDirs.lists.set(real, list);
    }
    return list;
  }

  // The first timestamp and cwd in a transcript's head (the first lines can lack both), read once per file.
  headOf(t) {
    if (!this.heads || this.heads.size > 4000) this.heads = new Map();
    const known = this.heads.get(t.file);
    if (known && t.size >= known.size && (known.first || t.size === known.size)) return known;
    const head = { size: t.size, first: 0, cwd: null, titleSize: -1, title: null };
    let fd;
    try {
      fd = fs.openSync(t.file, 'r');
      const buf = Buffer.allocUnsafe(64 * 1024);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      const text = buf.toString('utf8', 0, n);
      const lines = text.slice(0, text.lastIndexOf('\n') + 1).split('\n');
      for (const line of lines) {
        if (!line) continue;
        let o;
        try { o = JSON.parse(line); } catch { continue; }
        if (!head.first && o.timestamp) { const ts = Date.parse(o.timestamp); if (Number.isFinite(ts)) head.first = ts; }
        if (!head.cwd && typeof o.cwd === 'string') head.cwd = o.cwd;
        if (head.first && head.cwd) break;
      }
    } catch { /* unreadable: no evidence */ } finally {
      if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
    }
    this.heads.set(t.file, head);
    return head;
  }

  // The session's title from the end of its transcript (where title entries are rewritten): a custom
  // title, else an agent name, else the AI title. Never the last-prompt entry.
  titleOf(t) {
    const head = this.headOf(t);
    if (head.titleSize === t.size) return head.title;
    let custom = null, agent = null, ai = null, fd;
    try {
      fd = fs.openSync(t.file, 'r');
      const len = Math.min(t.size, 64 * 1024);
      const buf = Buffer.allocUnsafe(len);
      const n = fs.readSync(fd, buf, 0, len, t.size - len);
      for (const line of buf.toString('utf8', 0, n).split('\n')) {
        if (!/"type":"(custom-title|agent-name|ai-title)"/.test(line)) continue;
        let o;
        try { o = JSON.parse(line); } catch { continue; }
        if (o.type === 'custom-title' && typeof o.customTitle === 'string') custom = o.customTitle;
        else if (o.type === 'agent-name' && typeof o.agentName === 'string') agent = o.agentName;
        else if (o.type === 'ai-title' && typeof o.aiTitle === 'string') ai = o.aiTitle;
      }
    } catch { /* unreadable */ } finally {
      if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
    }
    head.title = custom || agent || ai || null;
    head.titleSize = t.size;
    return head.title;
  }

  // Did the process lose whoever launched it? Walk up through launchers (shells, npm, node, python, ...):
  // a chain that ends at an exited parent (or at a pid now worn by a younger process) is orphaned; one
  // that reaches a live terminal, IDE, service host or Claude process is being tended. Parents the probe
  // knows no start time for are taken at face value.
  orphaned(pid) {
    const snap = this.sys;
    let cur = pid;
    let created = (snap.info.get(pid) || {}).c || 0;
    for (let i = 0; i < 16; i++) {
      const p = snap.procs.get(cur);
      if (!p || !p.ppid || p.ppid === cur || p.ppid <= 4) return false;
      const parent = snap.procs.get(p.ppid);
      if (!parent) return true;
      const up = snap.info.get(p.ppid);
      if (up && up.c && created && up.c > created + 1000) return true;
      if (!isLauncher(parent.name)) return false;
      if (up && up.c) created = up.c;
      cur = p.ppid;
    }
    return false;
  }

  // The live session most likely to have started a server in `cwd`: the deepest session folder (its
  // start folder, its shell's current folder, or its repo / worktree root) containing the server's cwd,
  // among sessions whose process is older than the server. The process's own start, not the
  // transcript's: a resumed session's transcript begins days before the process that is running now.
  tenderOf(cwd, pid) {
    const key = pathKey(cwd);
    const info = this.sys ? this.sys.info : new Map();
    const created = (info.get(pid) || {}).c || 0;
    let best = null, bestLen = -1;
    for (const b of this.buildings.values()) {
      if (b.endedAt) continue;
      const ts = b.tail && b.tail.state;
      // The recorded creation time, else the one the probe saw, else when the CLI registered.
      const start = b.reg.procStart ? b.procStart : (info.get(b.pid) || {}).c || b.reg.startedAt || 0;
      if (created && start && start > created + 5000) continue;
      const r = b.resolved;
      const dirs = [ts && ts.projectCwd, b.reg.cwd, ts && ts.cwd, r && r.kind === 'repo' ? (r.annex ? r.annex.root : r.root) : null];
      for (const d of dirs) {
        const dk = pathKey(d);
        if (dk && dk.length > bestLen && isInside(key, dk)) { best = b; bestLen = dk.length; }
      }
    }
    return best;
  }

  // Meaningful processes a session is running (shell wrappers collapsed away).
  processesOf(b) {
    if (!this.sys || !b.pid || b.endedAt) return [];
    const out = [];
    const snap = this.sys;
    const visit = (pid, depth) => {
      const kids = this.kidsOf(pid);
      if (!kids || depth > 8) return;
      for (const k of kids) {
        const p = snap.procs.get(k);
        if (!p) continue;
        if (SHELLS.test(p.name) || /^(msedge|chrome)\.exe$/i.test(p.name) && /--type=/.test((snap.info.get(k) || {}).cmd || '')) {
          visit(k, depth + 1);
          continue;
        }
        const info = snap.info.get(k) || {};
        let cpu = this.cpuOf(k);
        for (const d of this.descendants(k, 40)) cpu += this.cpuOf(d);
        out.push({ pid: k, name: p.name.replace(/\.exe$/i, ''), cmd: shortCmd(info.cmd || p.name, 90), cpu: Math.round(cpu * 1000) / 1000, since: info.c || 0 });
        if (out.length >= 12) return;
      }
    };
    visit(b.pid, 0);
    return out;
  }

  // ---- git ---------------------------------------------------------------------------------------

  checkHeads() {
    const seen = new Set();
    for (const b of this.buildings.values()) {
      if (b.endedAt) continue;
      const r = b.resolved;
      if (!r || !r.gitDir) continue;
      const dirs = [[r.annex ? r.annex.gitDir : r.gitDir, r.annex ? r.annex.root : r.root]];
      for (const [gitDir, root] of dirs) {
        const k = pathKey(gitDir);
        if (seen.has(k)) continue;
        seen.add(k);
        this.repos.checkHead(gitDir, root).then((events) => {
          for (const ev of events || []) {
            this.pushEvent(ev.type, { island: r.islandId, annex: r.annex ? r.annex.id : null, name: r.annex ? r.annex.name : r.name, ...ev });
          }
        }).catch(() => {});
      }
    }
    // Forget repos nobody is in: a baseline from hours ago would announce old commits as a fresh "pull".
    this.repos.forgetExcept(seen);
  }

  // ---- state derivation --------------------------------------------------------------------------

  agentState(b, a, now) {
    const s = a.tail.state;
    if (!a.meta) a.meta = readJson(a.metaFile);
    const lastTs = Math.max(s.lastTs || 0, a.tail.mtime || 0);
    const note = b.tail && b.tail.state.notifications.get(a.id);
    const kids = [...b.agents.values()].filter((k) => k.meta && k.meta.parentAgentId === a.id && ACTIVE_AGENT.has(k.state));
    let pend = null;
    for (const p of s.pending.values()) if (!pend || p.since >= pend.since) pend = p;
    if (note && note.ts && note.ts >= (s.lastTs || 0) - 1500) {
      return { state: /complet|success|done|finish/i.test(note.status) ? 'done' : 'failed', tool: null, lastTs };
    }
    if (s.turn === 'done' && !kids.length) return { state: 'done', tool: null, lastTs };
    if (s.turn === 'done' && kids.length) return { state: 'waiting', tool: { name: 'Agent', cat: 'agent', detail: `waiting on ${kids.length} helper${kids.length > 1 ? 's' : ''}`, since: s.lastTs }, lastTs };
    if (s.errorAt && s.errorAt >= (s.lastTs || 0) - 1000 && now - lastTs > 45_000) return { state: 'failed', tool: null, lastTs };
    if (b.endedAt) return { state: 'lost', tool: null, lastTs };
    if (pend) return { state: now - pend.since > 90_000 ? 'waiting' : 'working', tool: pend, lastTs };
    if (now - lastTs > 10 * 60_000) return { state: 'stalled', tool: s.lastTool, lastTs };
    return { state: 'thinking', tool: null, lastTs };
  }

  buildingState(b, now, runningAgents, agentLast) {
    if (b.endedAt) return { state: 'ended', tool: null };
    const s = b.tail && b.tail.state;
    const reg = b.reg;
    const last = Math.max(s ? s.lastTs : 0, b.tail ? b.tail.mtime : 0, reg.statusUpdatedAt || 0, agentLast, reg.startedAt || 0);
    b.lastActivity = last;
    const idleOrAsleep = () => {
      if (runningAgents) return { state: 'idle', tool: null };
      return { state: now - last > this.cfg.asleepAfterMin * 60_000 ? 'asleep' : 'idle', tool: null };
    };
    if (!s) return reg.status === 'busy' && now - last < 5 * 60_000 ? { state: 'thinking', tool: null } : idleOrAsleep();
    let pend = null, head = null;
    for (const p of s.pending.values()) {
      if (isQuestionTool(p.name)) return { state: 'needs_input', tool: p };
      if (!pend || p.since >= pend.since) pend = p;
      if (!head || p.since < head.since) head = p;
    }
    const regIdle = reg.status === 'idle' && (reg.statusUpdatedAt || 0) >= s.lastTs - 2000;
    if (s.turn === 'tools' && pend && !regIdle) {
      const age = now - pend.since;
      const mode = s.permissionMode;
      // Calls run in order, so only the oldest pending one can be sitting on a permission prompt
      // (an Edit queued behind a long Bash is just waiting its turn).
      const gated = mode !== 'bypassPermissions' && !(mode === 'acceptEdits' && head.cat === 'edit');
      if (gated && isQuickTool(head.name) && now - head.since > 20_000) return { state: 'needs_input', tool: { ...head, detail: `${head.name} is waiting for permission?` } };
      if (gated && SHELL_TOOLS.has(head.name) && this.shellAwaitingPermission(b, head, now, mode)) {
        return { state: 'needs_input', tool: { ...head, detail: `${head.name} is waiting for permission?` } };
      }
      return { state: age > 90_000 ? 'waiting' : 'working', tool: pend };
    }
    if (s.turn === 'user' && !regIdle && now - Math.max(s.lastTs, b.tail.mtime) < 8 * 60_000) return { state: 'thinking', tool: null };
    return idleOrAsleep();
  }

  // A Bash/PowerShell call may legitimately run for many minutes, so its age alone proves nothing. But
  // an approved call starts a process straight away (Claude spawns a fresh shell, bash.exe or cmd.exe,
  // as its own child for every call). So when the oldest pending call is a shell call, it has been
  // pending for a while, and not a single process under the session was created since the call was
  // made, it is almost certainly sitting on a permission prompt. A false NEEDS YOU is worse than a
  // missed one, so: Windows probe only (it knows the creation time of every process under a session),
  // the snapshot must be fresh and taken well after the call, anything of unknown age counts as
  // started, and auto mode gets longer because its classifier decides before anything runs.
  shellAwaitingPermission(b, head, now, mode) {
    const sys = this.sys;
    if (!IS_WIN || !sys || !b.pid || now - sys.t > 10_000 || !sys.procs.has(b.pid)) return false;
    if (sys.t - head.since < (mode === 'auto' ? 30_000 : 15_000)) return false;
    const tree = this.descendants(b.pid, 300);
    if (tree.length >= 300) return false;
    for (const pid of tree) {
      const created = (sys.info.get(pid) || {}).c;
      if (!created || created >= head.since - 3000) return false;
    }
    return true;
  }

  updateStates(now) {
    const lingerAgent = this.cfg.agentLingerMin * 60_000;
    for (const [key, b] of this.buildings) {
      // Ended before any snapshot went out (a stale registry file at startup): nothing to decommission.
      if (b.endedAt && (!this.warm || now - b.endedAt > this.cfg.endedLingerSec * 1000)) { this.buildings.delete(key); continue; }
      let running = 0, agentLast = 0;
      for (const [id, a] of b.agents) {
        const r = this.agentState(b, a, now);
        const prev = a.state;
        if (r.state !== prev) {
          a.stateSince = now;
          const wasActive = prev && ACTIVE_AGENT.has(prev);
          if (ACTIVE_AGENT.has(r.state) && (a.fresh || (prev && !wasActive))) {
            this.pushEvent('agent_spawn', { key: b.key, agent: id, agentType: this.agentType(a), description: this.agentDesc(b, a) });
          } else if (r.state === 'done' && wasActive) {
            this.pushEvent('agent_done', { key: b.key, agent: id, agentType: this.agentType(a), description: this.agentDesc(b, a) });
          } else if ((r.state === 'failed' || r.state === 'lost') && wasActive) {
            this.pushEvent('agent_failed', { key: b.key, agent: id, agentType: this.agentType(a), description: this.agentDesc(b, a) });
          }
          // Already finished when first seen (e.g. at startup): it ended at its last activity, not now.
          if (!ACTIVE_AGENT.has(r.state)) a.doneAt = prev ? now : Math.min(now, r.lastTs || now);
          a.fresh = false;
          a.state = r.state;
        }
        a.tool = r.tool;
        a.lastTs = r.lastTs;
        if (ACTIVE_AGENT.has(a.state)) { running++; agentLast = Math.max(agentLast, r.lastTs); }
        else if (now - Math.max(a.doneAt, r.lastTs) > lingerAgent) b.agents.delete(id);
      }
      b.running = running;

      // The island is where the session was started (or relocated to, e.g. a worktree), not wherever
      // its shell last `cd`-ed.
      const ts = b.tail && b.tail.state;
      const cwd = (ts && ts.projectCwd) || b.reg.cwd || (ts && ts.cwd);
      b.resolved = cwd ? this.repos.resolve(cwd) : null;

      const r = this.buildingState(b, now, running, agentLast);
      if (r.state !== b.state) {
        const prev = b.state;
        const busy = (s) => s === 'working' || s === 'thinking' || s === 'waiting';
        if (busy(r.state) && !busy(prev)) b.busySince = now;
        b.state = r.state;
        b.stateSince = now;
        if (prev) {
          if (r.state === 'needs_input') this.pushEvent('needs_input', { key, name: this.nameOf(b), detail: r.tool && r.tool.detail });
          else if (r.state === 'asleep') this.pushEvent('asleep', { key, name: this.nameOf(b) });
          else if (prev === 'asleep' && r.state !== 'ended') this.pushEvent('wake', { key, name: this.nameOf(b) });
          // The main agent handed control back to the user ("your move"). Skip blips of a few seconds.
          if (busy(prev) && r.state === 'idle' && b.busySince) {
            const secs = Math.round((now - b.busySince) / 1000);
            if (secs >= 4) this.pushEvent('turn_done', { key, name: this.nameOf(b), secs, agentsRunning: running });
          }
        }
      }
      b.tool = r.tool;

      if (b.tail) {
        const s = b.tail.state;
        if (b.seenCompactions == null) b.seenCompactions = s.compactions;
        else if (s.compactions > b.seenCompactions) {
          b.seenCompactions = s.compactions;
          const c = s.lastCompaction || {};
          this.pushEvent('compaction', { key, name: this.nameOf(b), pre: c.pre || null, post: c.post || null, trigger: c.trigger || 'auto' });
        }
        const model = s.modelId || s.model;
        const pct = s.context / contextMax(model, s.context, this.cfg.contextWindows);
        if (pct > 0.8 && !b.ctxWarned) { b.ctxWarned = true; this.pushEvent('context_high', { key, name: this.nameOf(b), pct: Math.round(pct * 100) }); }
        else if (pct < 0.6) b.ctxWarned = false;
      }
      if (!b.endedAt) this.checkPrs(b, now);
    }
  }

  // Pull requests already in a transcript when it is first read (at startup, after a /clear, a new
  // sub-agent) are history, not news: what they say now counts as shown. A later action is news.
  baselinePrs(b, tail) {
    for (const pr of tail.state.prs.values()) this.notePr(b, pr);
  }

  notePr(b, pr) {
    const list = b.prsSeen.get(pr.number) || [];
    b.prsSeen.delete(pr.number);
    list.push({ repo: pr.repo, action: pr.action });
    b.prsSeen.set(pr.number, list.slice(-12));
    if (b.prsSeen.size > 100) b.prsSeen.delete(b.prsSeen.keys().next().value);
  }

  // News of a pull request in this session (its own transcript or a sub-agent's): one pr event per
  // (repo, number, action), a record with no repo matching any. created, merged, closed, ... are each
  // announced once, so a PR created and then merged in one session gets both. 'edited' and 'linked' are
  // announced only as a PR's first news here (touching someone's PR); after that they are quiet, so a
  // run of edits never repeats. A 'linked' waits 2 s, since the pr-link entry lands a moment before the
  // shell result that says what happened, and real actions go first (oldest first) for the same reason.
  checkPrs(b, now) {
    const prs = [];
    for (const t of [b.tail, ...[...b.agents.values()].map((a) => a.tail)]) if (t) prs.push(...t.state.prs.values());
    prs.sort((x, y) => ((x.action === 'linked') - (y.action === 'linked')) || (x.ts || 0) - (y.ts || 0));
    for (const pr of prs) {
      const shown = (b.prsSeen.get(pr.number) || []).filter((x) => !x.repo || !pr.repo || x.repo === pr.repo);
      if (shown.some((x) => x.action === pr.action)) continue;
      if ((pr.action === 'linked' || pr.action === 'edited') && shown.length) continue;
      if (pr.action === 'linked' && pr.ts && now - pr.ts < 2000) continue;
      this.notePr(b, pr);
      const r = b.resolved;
      this.pushEvent('pr', {
        key: b.key, island: r ? r.islandId : null, annex: r && r.annex ? r.annex.id : null, name: this.nameOf(b),
        number: pr.number, url: pr.url, action: pr.action, repo: pr.repo,
      });
    }
  }

  agentType(a) { return (a.meta && a.meta.agentType) || 'general-purpose'; }

  agentDesc(b, a) {
    if (a.meta && a.meta.description) return trunc(a.meta.description, 80);
    const call = a.meta && b.tail && b.tail.state.agentCalls.get(a.meta.toolUseId);
    if (call) return call.description;
    // The sub-agent's own prompt is prompt text too: with --no-prompts, say what kind of agent it is.
    return this.cfg.showPrompts ? trunc(a.tail.state.lastPrompt || '', 80) : this.agentType(a);
  }

  // ---- snapshot ----------------------------------------------------------------------------------

  modelFromCmd(b) {
    const info = this.sys && b.pid && this.sys.info.get(b.pid);
    const m = info && info.cmd && info.cmd.match(/--model\s+("?)([\w.[\]-]+)\1/);
    return m ? m[2] : null;
  }

  viewAgent(b, a) {
    const s = a.tail.state;
    const alias = a.meta && a.meta.model;
    const parentModel = b.tail && (b.tail.state.model || b.tail.state.modelId);
    const model = s.model || s.modelId || (alias ? `claude-${alias}` : parentModel);
    return {
      id: a.id,
      type: this.agentType(a),
      description: this.agentDesc(b, a),
      model, modelLabel: modelLabel(s.modelId || model), faction: factionOf(model),
      state: a.state, stateSince: a.stateSince,
      tool: a.tool ? { name: a.tool.name, cat: a.tool.cat, detail: a.tool.detail, since: a.tool.since } : null,
      startedAt: s.firstTs || a.firstSeen, lastActivity: a.lastTs || 0, endedAt: ACTIVE_AGENT.has(a.state) ? 0 : a.doneAt,
      depth: (a.meta && a.meta.spawnDepth) || 1,
      parent: (a.meta && a.meta.parentAgentId) || null,
      background: !!(a.meta && a.meta.requestShape === 'background'),
      context: s.context, tools: s.toolTotal,
    };
  }

  buildSnapshot(now) {
    const hideMs = this.cfg.hideAfterHours * 3_600_000;
    const islands = new Map();
    const sessions = [];
    const ports = [...this.portState.values()].map((p) => p.view).filter(Boolean);
    const ownedPorts = new Map();
    for (const p of ports) if (p.owner) ownedPorts.set(p.owner, [...(ownedPorts.get(p.owner) || []), p.id]);

    for (const b of this.buildings.values()) {
      const s = b.tail ? b.tail.state : null;
      const agents = [...b.agents.values()].map((a) => this.viewAgent(b, a));
      const running = agents.filter((a) => ACTIVE_AGENT.has(a.state)).length;
      const myPorts = ownedPorts.get(b.key) || [];
      if (!b.endedAt && b.state === 'asleep' && now - b.lastActivity > hideMs && !running && !myPorts.length) continue;

      const r = b.resolved || { islandId: 'unknown', kind: 'camp', root: b.reg.cwd || '?', name: 'Uncharted', gitDir: null, annex: null };
      let isl = islands.get(r.islandId);
      if (!isl) {
        const stats = this.repos.getStats(r);
        const files = stats ? stats.files : 0;
        const tier = r.kind !== 'repo' ? 0 : !stats ? 1 : files < 150 ? 1 : files < 1500 ? 2 : files < 6000 ? 3 : 4;
        const status = r.kind === 'repo' ? this.repos.getStatus(r.root, r.gitDir, { island: r.islandId, annex: null, name: r.name }) : null;
        isl = {
          id: r.islandId, name: r.name, kind: r.kind, root: r.root, tier,
          git: stats ? { ...stats, branch: this.repos.branchOf(r.gitDir), status } : (r.gitDir ? { branch: this.repos.branchOf(r.gitDir), status } : null),
          annexes: [], sessions: 0,
        };
        islands.set(r.islandId, isl);
      }
      isl.sessions++;
      if (r.annex && !isl.annexes.some((x) => x.id === r.annex.id)) {
        const status = this.repos.getStatus(r.annex.root, r.annex.gitDir, { island: r.islandId, annex: r.annex.id, name: r.annex.name });
        isl.annexes.push({ id: r.annex.id, name: r.annex.name, branch: this.repos.branchOf(r.annex.gitDir), status });
      }

      const model = (s && (s.model || s.modelId)) || this.modelFromCmd(b);
      const ctxModel = (s && s.modelId) || model;
      const used = s ? s.context : 0;
      const doneCount = Math.max(0, b.agentFiles - running);
      sessions.push({
        key: b.key, sessionId: b.sessionId, pid: b.pid, name: this.nameOf(b),
        island: r.islandId, annex: r.annex ? r.annex.id : null, cwd: cleanPath((s && s.cwd) || b.reg.cwd),
        entrypoint: b.reg.entrypoint || null, kind: b.reg.kind || null, permissionMode: s && s.permissionMode,
        model, modelLabel: modelLabel(ctxModel || model), faction: factionOf(model),
        state: b.state || 'idle', stateSince: b.stateSince,
        tool: b.tool ? { name: b.tool.name, cat: b.tool.cat, detail: b.tool.detail, since: b.tool.since } : null,
        lastTool: s && s.lastTool ? { name: s.lastTool.name, cat: s.lastTool.cat, detail: s.lastTool.detail, at: s.lastTool.ts } : null,
        lastActivity: b.lastActivity, startedAt: b.reg.startedAt || b.firstSeen, endedAt: b.endedAt || 0,
        lastPrompt: this.cfg.showPrompts && s ? s.lastPrompt : null,
        // Live HEAD first: the transcript's gitBranch lags checkouts and reads "HEAD" outside a repo.
        branch: this.repos.branchOf(r.annex ? r.annex.gitDir : r.gitDir) || (s && s.branch !== 'HEAD' && s.branch) || null,
        context: { used, max: contextMax(ctxModel, used, this.cfg.contextWindows) },
        compactions: s ? s.compactions : 0,
        lastCompaction: s && s.lastCompaction ? { at: s.lastCompaction.at, pre: s.lastCompaction.pre, post: s.lastCompaction.post, trigger: s.lastCompaction.trigger } : null,
        clears: b.clears,
        tools: s ? { ...s.counts } : {}, toolTotal: s ? s.toolTotal : 0,
        cost: s ? s.cost : null,
        agentsDone: doneCount,
        agents,
        procs: this.processesOf(b),
        ports: myPorts,
      });
    }

    // Ports: attach to the owner's island, else to the island whose repo contains the server's cwd.
    for (const p of ports) {
      let island = null;
      if (p.kind === 'lighthouse') { p.island = null; continue; } // always stands at Port Localhost
      if (p.owner) {
        const owner = sessions.find((x) => x.key === p.owner);
        island = owner ? owner.island : null;
      }
      if (!island && p.cwd) {
        const r = this.repos.resolve(p.cwd);
        if (r && islands.has(r.islandId)) island = r.islandId;
        else if (r && r.kind === 'repo') p.repo = r.name;
      }
      p.island = island;
    }

    const sys = this.sys;
    return {
      v: 1,
      now,
      host: os.hostname(),
      server: { port: this.cfg.port, pid: process.pid, startedAt: this.startedAt, platform: process.platform, cores: os.cpus().length, registry: !this.registryMissing, probe: !!sys, docker: this.docker.available },
      system: { cpu: sys && sys.cpu >= 0 ? sys.cpu : null, mem: sys && sys.mem >= 0 ? sys.mem : null },
      settings: { asleepAfterMin: this.cfg.asleepAfterMin, hideAfterHours: this.cfg.hideAfterHours },
      islands: [...islands.values()],
      sessions,
      ports,
      events: this.events.slice(-60),
    };
  }
}
