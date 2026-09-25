// Repository awareness: which "island" a working directory belongs to, how big that repo is, and
// whether HEAD moved (commits become rocket launches, checkouts change the flag).
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { cleanPath, pathKey, basename, homeDir, IS_WIN } from './util.js';

const SCRATCH = /[\\/]AppData[\\/]Roaming[\\/]Claude[\\/]scratch-workspaces[\\/][^\\/]+[\\/][^\\/]+[\\/]([^\\/]+)/i;

const LANG = {
  ts: 'TypeScript', tsx: 'TypeScript', mts: 'TypeScript', cts: 'TypeScript', js: 'JavaScript', jsx: 'JavaScript',
  mjs: 'JavaScript', cjs: 'JavaScript', vue: 'Vue', svelte: 'Svelte', astro: 'Astro', py: 'Python', php: 'PHP',
  rb: 'Ruby', go: 'Go', rs: 'Rust', java: 'Java', kt: 'Kotlin', cs: 'C#', fs: 'F#', cpp: 'C++', cc: 'C++',
  hpp: 'C++', c: 'C', h: 'C', swift: 'Swift', m: 'Obj-C', dart: 'Dart', scala: 'Scala', ex: 'Elixir',
  exs: 'Elixir', erl: 'Erlang', hs: 'Haskell', lua: 'Lua', r: 'R', jl: 'Julia', sql: 'SQL', sh: 'Shell',
  ps1: 'PowerShell', css: 'CSS', scss: 'CSS', less: 'CSS', html: 'HTML', zig: 'Zig', clj: 'Clojure', gd: 'GDScript',
};

function git(cwd, args, { timeout = 20_000, maxBuffer = 128 * 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, ...args], { timeout, maxBuffer, windowsHide: true, encoding: 'utf8' }, (err, stdout) => {
      resolve(err ? null : stdout);
    });
  });
}

// `git status` for the working-tree state. Never takes the index lock (--no-optional-locks), is killed
// after `timeout`, and reports whether that happened.
function gitStatus(root, untracked, timeout) {
  const args = ['--no-optional-locks', '-C', root, 'status', '--porcelain=v2', '--branch',
    `--untracked-files=${untracked ? 'normal' : 'no'}`, '--ignore-submodules=dirty'];
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };
  return new Promise((resolve) => {
    execFile('git', args, { timeout, maxBuffer: 64 * 1024 * 1024, windowsHide: true, encoding: 'utf8', env }, (err, stdout) => {
      resolve({ out: err ? null : stdout, timedOut: !!(err && err.killed) });
    });
  });
}

// Counts from `git status --porcelain=v2 --branch`. dirty = paths with any uncommitted change.
export function parseStatus(out, withUntracked) {
  const s = { dirty: 0, staged: 0, untracked: withUntracked ? 0 : null, conflicts: 0, ahead: null, behind: null };
  for (const raw of out.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line.length < 2 || line[1] !== ' ') continue;
    switch (line[0]) {
      case '#': {
        const ab = /^# branch\.ab \+(\d+) -(\d+)/.exec(line);
        if (ab) { s.ahead = +ab[1]; s.behind = +ab[2]; }
        break;
      }
      case '1': case '2':   // "1 XY ..." / "2 XY ..." (renamed or copied): X = index, Y = work tree
        s.dirty++;
        if (line[2] !== '.') s.staged++;
        break;
      case 'u': s.dirty++; s.conflicts++; break;
      case '?': s.dirty++; if (withUntracked) s.untracked++; break;
    }
  }
  return s;
}

// Status polling (ms). A repo whose status is slow skips untracked files and is polled less often.
const STATUS_TIMING = { every: 15_000, slowEvery: 60_000, slowMs: 3000, timeout: 10_000, retryFull: 15 * 60_000, maxBackoff: 10 * 60_000 };
const STATUS_RUNNING_MAX = 2;      // git status processes at once, machine-wide

function readText(file) { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } }
function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
function exists(p) { try { fs.accessSync(p); return true; } catch { return false; } }

export class Repos {
  constructor(log) {
    this.log = log;
    this.resolved = new Map();   // cwd key -> resolution
    this.stats = new Map();      // island root key -> stats
    this.heads = new Map();      // gitDir key -> { branch, hash }
    this.remoteRefs = new Map(); // "gitDir key|remote ref" -> hash (push detection)
    this.queue = [];
    this.busy = false;
    this.swept = Date.now();
    this.status = new Map();     // work tree gitDir key -> status poller state (see getStatus)
    this.statusQueue = [];
    this.statusRunning = 0;
    this.onEvent = null;         // (type, payload) => void, for `conflict`
    this.statusTiming = { ...STATUS_TIMING };
  }

  // Sessions and ports come and go (and with them their cwds and islands): forget what nobody asks for.
  prune(now) {
    if (now - this.swept < 5 * 60_000) return;
    this.swept = now;
    for (const [k, v] of this.resolved) if (now - v.at > 60_000) this.resolved.delete(k);   // expired anyway
    for (const [k, v] of this.stats) {
      if (now - v.used > 30 * 60_000 && !this.queue.some((q) => q.islandId === k)) this.stats.delete(k);
    }
    for (const [k, v] of this.status) if (now - v.used > 5 * 60_000 && !v.running && !v.queued) this.status.delete(k);
  }

  // Forget HEAD baselines and remote-tracking refs of repos nobody is in (keys: gitDir keys still in use).
  forgetExcept(keys) {
    for (const k of this.heads.keys()) if (!keys.has(k)) this.heads.delete(k);
    for (const k of this.remoteRefs.keys()) if (!keys.has(k.slice(0, k.indexOf('|refs/')))) this.remoteRefs.delete(k);
  }

  // Map a working directory to { islandId, kind, root, name, gitDir, annex }.
  resolve(cwd) {
    this.prune(Date.now());
    const clean = cleanPath(cwd);
    const key = pathKey(clean);
    if (!key) return null;
    const hit = this.resolved.get(key);
    if (hit && Date.now() - hit.at < 60_000) return hit.r;
    const r = this.resolveFresh(clean);
    this.resolved.set(key, { r, at: Date.now() });
    return r;
  }

  resolveFresh(p) {
    const scratch = SCRATCH.exec(p);
    if (scratch) {
      const root = p.slice(0, scratch.index + scratch[0].length);
      const tag = scratch[1].split('-').pop();
      return { islandId: pathKey(root), kind: 'sandbox', root, name: `Sandbox ${tag}`, gitDir: null, annex: null };
    }
    let dir = p;
    for (let i = 0; i < 40; i++) {
      const dotGit = path.join(dir, '.git');
      if (isDir(dotGit)) {
        return { islandId: pathKey(dir), kind: 'repo', root: dir, name: basename(dir), gitDir: dotGit, annex: null };
      }
      const txt = exists(dotGit) ? readText(dotGit) : null;
      if (txt && /^gitdir:/i.test(txt.trim())) {
        const gitDir = path.resolve(dir, txt.trim().slice(7).trim());
        const wt = gitDir.replace(/\\/g, '/').match(/^(.*)\/\.git\/worktrees\/[^/]+$/i);
        if (wt) {
          const mainRoot = cleanPath(IS_WIN ? wt[1].replace(/\//g, '\\') : wt[1]);
          return {
            islandId: pathKey(mainRoot), kind: 'repo', root: mainRoot, name: basename(mainRoot),
            gitDir: path.join(mainRoot, '.git'),
            annex: { id: pathKey(dir), root: dir, name: basename(dir), gitDir },
          };
        }
        return { islandId: pathKey(dir), kind: 'repo', root: dir, name: basename(dir), gitDir, annex: null };
      }
      const up = path.dirname(dir);
      if (!up || up === dir) break;
      dir = up;
    }
    const home = cleanPath(homeDir());
    if (pathKey(p) === pathKey(home)) return { islandId: pathKey(p), kind: 'home', root: p, name: 'Homestead', gitDir: null, annex: null };
    return { islandId: pathKey(p), kind: 'camp', root: p, name: basename(p), gitDir: null, annex: null };
  }

  // Cached size stats for an island root; refreshes in the background.
  getStats(r) {
    if (!r || r.kind !== 'repo') return null;
    const s = this.stats.get(r.islandId);
    if (s) s.used = Date.now();
    const stale = !s || Date.now() - s.at > 10 * 60_000;
    if (stale && !this.queue.some((q) => q.islandId === r.islandId)) {
      this.queue.push(r);
      this.pump().catch((e) => this.log.warn('repo stats failed: ' + e.message));
    }
    return s ? s.data : null;
  }

  async pump() {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.queue.length) {
        const r = this.queue[0]; // stays queued while collecting so getStats does not queue it again
        try {
          const data = await this.collect(r.root);
          this.stats.set(r.islandId, { at: Date.now(), used: Date.now(), data });
        } finally { this.queue.shift(); }
      }
    } finally {
      this.busy = false;
    }
  }

  async collect(root) {
    const [files, commits, branches] = await Promise.all([
      git(root, ['ls-files', '-z']),
      git(root, ['rev-list', '--count', 'HEAD']),
      git(root, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']),
    ]);
    const data = { files: 0, commits: 0, branches: 0, langs: [] };
    if (files) {
      const counts = {};
      let n = 0;
      for (const f of files.split('\0')) {
        if (!f) continue;
        n++;
        const dot = f.lastIndexOf('.');
        if (dot < 0 || f.includes('node_modules/') || f.includes('vendor/')) continue;
        const lang = LANG[f.slice(dot + 1).toLowerCase()];
        if (lang) counts[lang] = (counts[lang] || 0) + 1;
      }
      data.files = n;
      data.langs = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([l]) => l);
    }
    if (commits) data.commits = parseInt(commits.trim(), 10) || 0;
    if (branches) data.branches = branches.split('\n').filter(Boolean).length;
    return data;
  }

  // Worktrees keep HEAD locally but refs (and config) in the common dir.
  commonDir(gitDir) {
    const cd = readText(path.join(gitDir, 'commondir'));
    return cd ? path.resolve(gitDir, cd.trim()) : gitDir;
  }

  // Resolve a full ref name (refs/heads/x, refs/remotes/origin/x) to a hash: loose file first, then packed-refs.
  readRef(gitDir, ref) {
    const common = this.commonDir(gitDir);
    let hash = readText(path.join(gitDir, ref)) || readText(path.join(common, ref));
    if (!hash) {
      const packed = readText(path.join(common, 'packed-refs')) || '';
      const line = packed.split('\n').find((l) => l.endsWith(' ' + ref));
      hash = line ? line.split(' ')[0] : null;
    }
    return hash ? hash.trim().slice(0, 40) : null;
  }

  // Cheap HEAD read straight from .git. Returns { branch, hash } or null.
  readHead(gitDir) {
    const head = readText(path.join(gitDir, 'HEAD'));
    if (!head) return null;
    const t = head.trim();
    if (!t.startsWith('ref:')) return { branch: null, hash: t.slice(0, 40) };
    const ref = t.slice(4).trim();
    return { branch: ref.replace(/^refs\/heads\//, ''), hash: this.readRef(gitDir, ref) };
  }

  // The remote-tracking ref a branch pushes to: [branch "x"] remote/merge from config, else origin/x.
  upstreamOf(gitDir, branch) {
    const config = readText(path.join(this.commonDir(gitDir), 'config')) || '';
    const esc = branch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const section = config.match(new RegExp(`\\[branch "${esc}"\\]([^\\[]*)`));
    const remote = section && (section[1].match(/^\s*remote\s*=\s*(\S+)/m) || [])[1];
    const merge = section && (section[1].match(/^\s*merge\s*=\s*refs\/heads\/(\S+)/m) || [])[1];
    return { remote: remote && remote !== '.' ? remote : 'origin', ref: `refs/remotes/${remote && remote !== '.' ? remote : 'origin'}/${merge || branch}` };
  }

  // Compare HEAD (and the branch's remote-tracking ref) with last time. Returns a list of event descriptors:
  // commit (new local commit) | merge (new local merge commit) | pull (HEAD fast-forwarded to older work) |
  // checkout (branch switch) | push (the remote-tracking ref caught up with HEAD).
  async checkHead(gitDir, root) {
    const key = pathKey(gitDir);
    const now = this.readHead(gitDir);
    if (!now) return [];
    const prev = this.heads.get(key);
    this.heads.set(key, now);
    const events = [];

    if (prev && prev.branch !== now.branch) {
      events.push({ type: 'checkout', from: prev.branch, to: now.branch, branch: now.branch });
    } else if (prev && now.hash && prev.hash !== now.hash) {
      const [log, forward] = await Promise.all([
        git(root, ['log', '-1', '--format=%P%x1f%s%x1f%ct%x1f%an', now.hash], { timeout: 5000 }),
        prev.hash ? this.isAncestor(root, prev.hash, now.hash) : false,
      ]);
      const [parents, subject, ct, author] = (log || '').trim().split('\x1f');
      const age = Date.now() - (parseInt(ct, 10) || 0) * 1000;
      const isMerge = (parents || '').trim().split(/\s+/).filter(Boolean).length > 1;
      // Invalidate the size cache so the island can grow.
      const cached = this.stats.get(pathKey(root));
      if (cached) cached.at = 0;
      const base = { msg: subject || '', author: author || '', hash: now.hash.slice(0, 7), branch: now.branch };
      if (age < 5 * 60_000) {
        // HEAD stepping back to one of its own ancestors is a reset (e.g. undoing the last commit).
        const back = !forward && prev.hash && await this.isAncestor(root, now.hash, prev.hash);
        const from = isMerge && (subject || '').match(/Merge (?:branch|remote-tracking branch|pull request #\d+ from) '?([^'\s]+)'?/);
        if (!back) events.push(isMerge ? { type: 'merge', from: from ? from[1] : null, ...base } : { type: 'commit', ...base });
      } else if (forward) {
        // Older work on top of ours: a fast-forward to someone else's commits. A reset, a checkout of an
        // old commit or a rebase also moves HEAD to older work, but is no pull and is not announced.
        events.push({ type: 'pull', ...base });
      }
    }

    // Push: git updates refs/remotes/<remote>/<branch> locally on a successful push, to exactly our HEAD.
    // (A fetch also moves it, but to someone else's commit, so it won't equal HEAD.)
    if (now.branch && now.hash) {
      const up = this.upstreamOf(gitDir, now.branch);
      const hash = this.readRef(gitDir, up.ref);
      const rkey = `${key}|${up.ref}`;
      const had = this.remoteRefs.has(rkey);
      const before = this.remoteRefs.get(rkey);
      this.remoteRefs.set(rkey, hash);
      if (had && hash && hash !== before && hash === now.hash) {
        let count = null;
        if (before) {
          const n = await git(root, ['rev-list', '--count', `${before}..${hash}`], { timeout: 5000 });
          count = n ? parseInt(n.trim(), 10) || null : null;
        }
        events.push({ type: 'push', remote: up.remote, branch: now.branch, hash: hash.slice(0, 7), count, newBranch: !before });
      }
    }
    return events;
  }

  // Is commit a an ancestor of (or equal to) commit b? Errors (unknown or pruned commits) count as no.
  async isAncestor(root, a, b) {
    return (await git(root, ['merge-base', '--is-ancestor', a, b], { timeout: 5000 })) !== null;
  }

  // ---- working-tree status -------------------------------------------------------------------------
  //
  // Latest { dirty, staged, untracked, conflicts, ahead, behind, stash, op, at } of a work tree (a repo
  // root or one of its worktrees), or null until the first poll lands. Asking keeps the tree polled:
  // about every 15 s, staggered, one git process per tree and at most two machine-wide, never waiting
  // on the caller. A tree whose status takes over 3 s (or times out) drops untracked files (untracked:
  // null) and is polled once a minute, trying a full status again every 15 minutes. One that keeps
  // timing out even so is polled half as often after each timeout in a row, down to every 10 minutes.
  // `who` = { island, annex, name } names the tree in a `conflict` event.
  getStatus(root, gitDir, who) {
    if (!root || !gitDir) return null;
    const key = pathKey(gitDir);
    const now = Date.now();
    let e = this.status.get(key);
    if (!e) {
      // Spread the first polls of trees that appear together (a restart, several sessions at once).
      e = { key, root, gitDir, data: null, next: now + Math.random() * 2000, queued: false, running: false,
        slow: false, fullAt: 0, conflicts: null, used: now, who, ms: 0, timeouts: 0 };
      this.status.set(key, e);
    }
    e.used = now;
    e.root = root;
    e.who = who;
    if (!e.queued && !e.running && now >= e.next) {
      e.queued = true;
      this.statusQueue.push(e);
      this.pumpStatus();
    }
    return e.data;
  }

  pumpStatus() {
    while (this.statusRunning < STATUS_RUNNING_MAX && this.statusQueue.length) {
      const e = this.statusQueue.shift();
      e.queued = false;
      e.running = true;
      this.statusRunning++;
      this.pollStatus(e)
        .catch((err) => this.log.warn('git status failed: ' + (err && err.message || err)))
        .finally(() => { e.running = false; this.statusRunning--; this.pumpStatus(); });
    }
  }

  async pollStatus(e) {
    const T = this.statusTiming;
    const full = !e.slow || Date.now() >= e.fullAt;
    const t0 = Date.now();
    const res = await gitStatus(e.root, full, T.timeout);
    const ms = Date.now() - t0;
    e.ms = ms;
    if (full) {
      const slow = res.timedOut || ms > T.slowMs;
      if (slow && !e.slow) this.log.info(`git status took ${res.timedOut ? 'too long' : ms + ' ms'} in ${basename(e.root)}; skipping untracked files there`);
      e.slow = slow;
      if (slow) e.fullAt = Date.now() + T.retryFull;
    }
    // A status that keeps timing out (killed each time, even without untracked files) backs off: the
    // interval doubles with every timeout in a row, up to 10 minutes. Any answer resets it.
    e.timeouts = res.timedOut ? (e.timeouts || 0) + 1 : 0;
    const every = e.timeouts ? Math.min(T.slowEvery * 2 ** (e.timeouts - 1), T.maxBackoff) : e.slow ? T.slowEvery : T.every;
    const jitter = Math.random() * 1000;
    e.next = Date.now() + every + jitter;
    // Not a repo (any more) or git missing: nothing to show. A timeout keeps the last reading.
    if (res.out == null) { if (!res.timedOut) e.data = null; return; }
    const st = parseStatus(res.out, full);
    st.stash = this.stashCount(e.gitDir);
    st.op = this.opOf(e.gitDir);
    st.at = Date.now();
    const before = e.conflicts;
    e.conflicts = st.conflicts;
    e.data = st;
    // A tree's first reading is the baseline: conflicts already there when we started are no news.
    if (before === 0 && st.conflicts > 0 && this.onEvent && e.who) {
      this.onEvent('conflict', { island: e.who.island, annex: e.who.annex, name: e.who.name, count: st.conflicts });
    }
  }

  // Stash entries: one line each in the stash reflog, which lives in the common dir (shared by worktrees).
  stashCount(gitDir) {
    const log = readText(path.join(this.commonDir(gitDir), 'logs', 'refs', 'stash'));
    return log ? log.split('\n').filter((l) => l.trim()).length : 0;
  }

  // An operation stopped half-way, from the work tree's own git dir.
  opOf(gitDir) {
    if (isDir(path.join(gitDir, 'rebase-merge')) || isDir(path.join(gitDir, 'rebase-apply'))) return 'rebase';
    if (exists(path.join(gitDir, 'MERGE_HEAD'))) return 'merge';
    if (exists(path.join(gitDir, 'CHERRY_PICK_HEAD'))) return 'cherry-pick';
    if (exists(path.join(gitDir, 'REVERT_HEAD'))) return 'revert';
    if (exists(path.join(gitDir, 'BISECT_LOG'))) return 'bisect';
    return null;
  }

  // Branch (or short hash when detached) from HEAD alone. This runs every tick, so unlike readHead it
  // must not resolve the ref (packed-refs can be megabytes in big repos).
  branchOf(gitDir) {
    const head = gitDir ? readText(path.join(gitDir, 'HEAD')) : null;
    if (!head) return null;
    const t = head.trim();
    return (t.startsWith('ref:') ? t.slice(4).trim().replace(/^refs\/heads\//, '') : t.slice(0, 7)) || null;
  }
}
