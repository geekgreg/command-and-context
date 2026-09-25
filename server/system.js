// OS view: processes (with parent links), listening TCP ports, established connection counts,
// and working directories / command lines for the processes that matter.
//
// Windows uses the long-lived PowerShell helper in probe-win.ps1. macOS/Linux use ps + lsof
// (best effort; the Windows path is the one that is exercised day to day).
import { spawn, execFile } from 'node:child_process';
import readline from 'node:readline';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { IS_WIN } from './util.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Normalized snapshot shape returned by every backend:
// { t, cpu, mem, procs: Map(pid -> {pid, ppid, name}), info: Map(pid -> {c, k, cmd, cwd}),
//   listen: [{addr, port, pid}], est: Map("port:pid" -> number[] remote ports),
//   tcpOk / tcp6Ok: false when the IPv4 / IPv6 TCP table could not be read (its part of listen/est is then
//   unknown, not empty) }
function normalize(raw) {
  const procs = new Map();
  for (const [pid, ppid, name] of raw.procs || []) procs.set(pid, { pid, ppid, name });
  const info = new Map();
  for (const [pid, v] of Object.entries(raw.info || {})) info.set(+pid, v);
  const listen = (raw.listen || []).map(([addr, port, pid]) => ({ addr, port, pid }));
  const est = new Map();
  for (const [port, pid, remotes] of raw.est || []) est.set(`${port}:${pid}`, remotes || []);
  return { t: raw.t || Date.now(), cpu: raw.cpu, mem: raw.mem, procs, info, listen, est, tcpOk: raw.tcpOk !== false, tcp6Ok: raw.tcp6Ok !== false };
}

const FILETIME_EPOCH = 116444736000000000n;

// Options exist so tests can drive the protocol with a stub helper instead of PowerShell.
export class WinProbe {
  constructor(log, { command = 'powershell.exe', args, readyMs = 30_000, replyMs = 10_000 } = {}) {
    this.log = log;
    this.command = command;
    this.args = args || ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(HERE, 'probe-win.ps1')];
    this.readyMs = readyMs;
    this.replyMs = replyMs;
    this.child = null;      // { ps, ready, waiters: Map(request id -> callback), alive }
    this.seq = 0;
    this.failures = 0;
    this.errors = 0;
    this.retryAt = 0;
  }

  start() {
    const ps = spawn(this.command, this.args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let resolveReady;
    // Waiters belong to this helper process: a dying helper must not answer (or flush) its successor's.
    const child = { ps, ready: new Promise((r) => { resolveReady = r; }), waiters: new Map(), alive: true };
    this.child = child;
    const rl = readline.createInterface({ input: ps.stdout });
    rl.on('line', (line) => {
      let o;
      try { o = JSON.parse(line); } catch { return; }
      if (!o || typeof o !== 'object') return;
      if (o.ready) { resolveReady(true); return; }
      // Replies echo their request id; anything else (a stray line, a reply we gave up on) is dropped
      // so one extra line can never shift every later reply onto the wrong request.
      const w = child.waiters.get(o.id);
      if (w) { child.waiters.delete(o.id); w(o); }
    });
    let err = '';
    ps.stderr.on('data', (d) => { err += d; if (err.length > 4000) err = err.slice(-4000); });
    const down = () => {
      child.alive = false;
      if (this.child === child) this.child = null;
      resolveReady(false);
      for (const w of child.waiters.values()) w(null);
      child.waiters.clear();
    };
    // Without this, a missing or blocked powershell.exe crashes the server (and 'exit' never fires).
    ps.on('error', (e) => { this.log.warn(`system probe could not start: ${e.message}`); down(); });
    ps.on('exit', (code) => {
      down();
      if (code) this.log.warn(`system probe exited (${code})${err ? ': ' + err.trim().split('\n').slice(-3).join(' ') : ''}`);
    });
    ps.stdin.on('error', () => {});
  }

  // Kill a hung or broken helper; the next snapshot() spawns a fresh one.
  discard(child) {
    child.alive = false;
    if (this.child === child) this.child = null;
    try { child.ps.kill(); } catch { /* ignore */ }
  }

  fail() {
    this.failures++;
    // A one-off failure respawns at once; a helper that keeps failing is retried after 5 s, 10 s, 20 s,
    // ... at most a minute apart, so ports and processes are never frozen for long. One that has failed
    // many times in a row is probably blocked for good (Constrained Language Mode, AppLocker, AV holding
    // up Add-Type): every retry costs a PowerShell start, so then only try every 10 minutes.
    if (this.failures >= 2) this.retryAt = Date.now() + (this.failures > 8 ? 10 * 60_000 : Math.min(60_000, 5000 * 2 ** (this.failures - 2)));
  }

  async snapshot(extraPids) {
    if (!this.child) {
      if (Date.now() < this.retryAt) return null;
      this.start();
    }
    const child = this.child;
    // Bounded: a PowerShell stuck before "ready" (e.g. Add-Type held up by AV) must not wait forever.
    let timer;
    const ok = await Promise.race([child.ready, new Promise((r) => { timer = setTimeout(r, this.readyMs, false); })]);
    clearTimeout(timer);
    if (!ok || !child.alive) {
      this.discard(child);
      this.fail();
      return null;
    }
    const id = ++this.seq;
    const res = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.waiters.delete(id);
        resolve(null);
        this.discard(child);   // hung: a fresh helper is spawned next time
      }, this.replyMs);
      child.waiters.set(id, (o) => { clearTimeout(timer); resolve(o); });
      child.ps.stdin.write(`snap #${id} ${extraPids.join(',')}\n`);
    });
    if (!res || res.error) {
      if (res && res.error) {
        this.log.warn('system probe error: ' + res.error);
        // A helper that errors on every request is replaced rather than asked forever.
        if (++this.errors >= 3) { this.errors = 0; this.discard(child); }
      }
      this.fail();
      return null;
    }
    this.failures = 0;
    this.errors = 0;
    this.retryAt = 0;
    return normalize(res);
  }

  // Creation times (ms) of the given pids, for liveness checks while the helper is down. A one-shot
  // Get-Process still works where the helper cannot (e.g. Add-Type blocked by Constrained Language Mode).
  async startTimes(pids) {
    const list = pids.filter((p) => Number.isInteger(p) && p > 0);
    if (!list.length) return new Map();
    const script = `Get-Process -Id ${list.join(',')} -ErrorAction SilentlyContinue | ForEach-Object { try { '{0} {1}' -f $_.Id, $_.StartTime.ToFileTimeUtc() } catch { } }`;
    const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], 8000);
    const times = new Map();
    for (const line of (out || '').split(/\r?\n/)) {
      const m = line.trim().match(/^(\d+) (\d+)$/);
      if (m) times.set(+m[1], Number((BigInt(m[2]) - FILETIME_EPOCH) / 10000n));
    }
    return times;
  }

  stop() {
    const child = this.child;
    if (child) { try { child.ps.stdin.end('quit\n'); } catch { /* ignore */ } this.child = null; }
  }
}

function run(cmd, args, timeout = 8000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8', windowsHide: true }, (err, stdout) => resolve(err && !stdout ? null : stdout));
  });
}

const LSTART = /^(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})/;

// ps + lsof. CPU time comes from `ps -o time`, working directories from lsof or /proc.
class PosixProbe {
  constructor(log) { this.log = log; this.lastCpu = null; }

  async snapshot(extraPids) {
    const ps = await run('ps', ['-axo', 'pid=,ppid=,time=,comm=']);
    if (!ps) return null;
    const procs = [];
    const cpuMs = new Map();
    for (const line of ps.split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
      if (!m) continue;
      const pid = +m[1];
      procs.push([pid, +m[2], path.basename(m[4])]);
      const parts = m[3].replace('-', ':').split(':').map(Number);
      let secs = 0;
      for (const p of parts) secs = secs * 60 + (Number.isFinite(p) ? p : 0);
      cpuMs.set(pid, Math.round(secs * 1000));
    }
    const lsof = await run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN,ESTABLISHED', '-FpnT']);
    const listen = [], est = {};
    const listenPorts = new Set();
    const estRows = [];
    if (lsof) {
      let pid = 0, name = '';
      for (const line of lsof.split('\n')) {
        if (line[0] === 'p') pid = +line.slice(1);
        else if (line[0] === 'n') name = line.slice(1);
        else if (line.startsWith('TST=')) {
          const st = line.slice(4);
          if (st === 'LISTEN') {
            const m = name.match(/^(.*):(\d+)$/);
            if (m) { listen.push([m[1].replace(/^\[|\]$/g, '') || '*', +m[2], pid]); listenPorts.add(+m[2]); }
          } else if (st === 'ESTABLISHED') {
            const m = name.match(/:(\d+)->.*:(\d+)$/);
            if (m) estRows.push([+m[1], pid, +m[2]]);
          }
        }
      }
    }
    for (const [lp, pid, rp] of estRows) {
      if (!listenPorts.has(lp)) continue;
      (est[`${lp}:${pid}`] ||= []).push(rp);
    }
    const interesting = new Set([...extraPids, ...listen.map((l) => l[2])]);
    const info = {};
    const now = Date.now();
    const cmds = await run('ps', ['-o', 'pid=,lstart=,args=', '-p', [...interesting].join(',') || '1']);
    if (cmds) {
      for (const line of cmds.split('\n')) {
        const m = line.trim().match(/^(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/);
        if (!m) continue;
        const c = Date.parse(m[2]) || now;
        info[m[1]] = { c, k: cpuMs.get(+m[1]) || 0, cmd: m[3], cwd: null };
      }
    }
    for (const pid of interesting) {
      if (!info[pid]) continue;
      try { info[pid].cwd = fs.readlinkSync(`/proc/${pid}/cwd`); } catch { /* not linux */ }
    }
    const needCwd = [...interesting].filter((p) => info[p] && !info[p].cwd);
    if (needCwd.length) {
      const out = await run('lsof', ['-a', '-d', 'cwd', '-Fn', '-p', needCwd.join(',')]);
      let pid = 0;
      for (const line of (out || '').split('\n')) {
        if (line[0] === 'p') pid = +line.slice(1);
        else if (line[0] === 'n' && info[pid]) info[pid].cwd = line.slice(1);
      }
    }
    return normalize({ t: now, cpu: -1, mem: -1, procs, info, listen, est: Object.entries(est).map(([k, v]) => [...k.split(':').map(Number), v]), tcpOk: lsof != null });
  }

  async startTimes(pids) {
    const times = new Map();
    const list = pids.filter((p) => Number.isInteger(p) && p > 0);
    const out = list.length ? await run('ps', ['-o', 'pid=,lstart=', '-p', list.join(',')]) : null;
    for (const line of (out || '').split('\n')) {
      const m = line.trim().match(LSTART);
      const c = m && Date.parse(m[2]);
      if (c) times.set(+m[1], c);
    }
    return times;
  }

  stop() {}
}

export function createProbe(log) {
  return IS_WIN ? new WinProbe(log) : new PosixProbe(log);
}
