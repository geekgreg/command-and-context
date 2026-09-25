// Command & Context server: serves the diorama and streams world snapshots over SSE.
// Binds to localhost only, and rejects requests whose Host header is not localhost (DNS rebinding).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { loadConfig, HELP, ROOT } from './config.js';
import { Collector } from './collector.js';
import { SseHub } from './sse.js';

const cfg = loadConfig(process.argv.slice(2));
if (cfg.help) { console.log(HELP); process.exit(0); }

const stamp = () => new Date().toTimeString().slice(0, 8);
const log = {
  info: (m) => console.log(`[${stamp()}] ${m}`),
  warn: (m) => console.warn(`[${stamp()}] warn: ${m}`),
  error: (m) => console.error(`[${stamp()}] error: ${m}`),
};

const collector = new Collector(cfg, log);

if (cfg.dump) {
  collector.start();
  setTimeout(() => {
    console.log(JSON.stringify(collector.snapshot, null, 2));
    collector.stop();
    process.exit(0);
  }, 6000);
} else {
  serve();
}

function serve() {
  const PUBLIC = path.join(ROOT, 'public');
  const THREE = threeDir();
  const THREE_VERSION = (() => {
    try { return JSON.parse(fs.readFileSync(path.join(THREE, 'package.json'), 'utf8')).version; } catch { return null; }
  })();
  const TYPES = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
    '.woff2': 'font/woff2', '.map': 'application/json',
  };
  const allowedHosts = new Set([`localhost:${cfg.port}`, `127.0.0.1:${cfg.port}`, `[::1]:${cfg.port}`, 'localhost', '127.0.0.1']);
  const clients = new SseHub();
  let lastBody = '';
  let lastSent = 0;

  function sendFile(res, file, cache) {
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return; }
      res.writeHead(200, {
        'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': cache ? 'public, max-age=86400' : 'no-cache',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(data);
    });
  }

  function inside(base, rel) {
    const p = path.normalize(path.join(base, rel));
    return p.startsWith(base + path.sep) || p === base ? p : null;
  }

  // Any web page can make the browser request http://localhost:<port>/... (with a valid Host header),
  // so a throwing handler would let any site crash the dashboard.
  const server = http.createServer((req, res) => {
    try {
      route(req, res);
    } catch (e) {
      log.warn(`request failed: ${e.message}`);
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end();
    }
  });

  function route(req, res) {
    if (!allowedHosts.has(String(req.headers.host || '').toLowerCase())) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('forbidden host');
      return;
    }
    let p;
    try {
      p = decodeURIComponent(new URL(req.url, `http://localhost:${cfg.port}`).pathname);
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('bad request');
      return;
    }

    if (p === '/api/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write('retry: 3000\n\n');
      if (collector.snapshot) res.write(`data: ${JSON.stringify(collector.snapshot)}\n\n`);
      clients.add(res);
      return;
    }
    if (p === '/api/state') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
      res.end(JSON.stringify(collector.snapshot || {}));
      return;
    }
    if (p.startsWith('/vendor/three/')) {
      const rel = p.slice('/vendor/three/'.length);
      // Plain path characters only: rel ends up in a Location header (CR/LF or non-Latin-1 would throw)
      // and ".." would walk the redirect out of the three package on the CDN.
      if (!/^(build|examples\/jsm)\/[\w./-]+$/.test(rel) || rel.includes('..')) { res.writeHead(404); res.end(); return; }
      const file = THREE_VERSION && inside(THREE, rel);
      if (file && fs.existsSync(file)) return sendFile(res, file, true);
      // Not installed: fall back to the CDN build of the same major line.
      res.writeHead(302, { Location: `https://cdn.jsdelivr.net/npm/three@0.186.0/${rel}` });
      res.end();
      return;
    }
    const file = inside(PUBLIC, p === '/' ? 'index.html' : p.slice(1));
    if (!file) { res.writeHead(404); res.end(); return; }
    sendFile(res, file, false);
  }

  collector.on('snapshot', (snap) => {
    if (!clients.size) return;
    const body = JSON.stringify(snap);
    const comparable = body.replace(/^\{"v":1,"now":\d+,/, '');
    const now = Date.now();
    if (comparable === lastBody && now - lastSent < 5000) return;
    lastBody = comparable;
    lastSent = now;
    clients.broadcast(`data: ${body}\n\n`, now);
  });
  // The heartbeat also drops clients that have stayed backed up while no snapshot was due.
  setInterval(() => clients.broadcast(': ping\n\n'), 15_000);

  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      if (cfg.open || cfg.app) {
        // Most likely already running (e.g. the launcher was double-clicked twice): just open it.
        log.info(`port ${cfg.port} is already in use; opening the existing dashboard.`);
        openBrowser(`http://localhost:${cfg.port}/${cfg.demo ? '?demo' : ''}`, cfg.app);
        setTimeout(() => process.exit(0), 1500);
        return;
      }
      log.error(`port ${cfg.port} is busy. Is Command & Context already running? Try http://localhost:${cfg.port} or pass --port.`);
      process.exit(1);
    }
    throw e;
  });

  server.listen(cfg.port, cfg.host, () => {
    const url = `http://localhost:${cfg.port}/${cfg.demo ? '?demo' : ''}`;
    log.info(`Command & Context is live at ${url}`);
    if (!THREE_VERSION) log.warn('three.js is not installed locally (run npm install); loading it from the jsDelivr CDN instead.');
    collector.start();
    if (cfg.open || cfg.app) openBrowser(url, cfg.app);
  });

  const shutdown = () => { collector.stop(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// The installed three package. In a git clone it's ./node_modules/three; installed from npm (npx) it's usually a
// sibling of this package, so ask Node's resolver rather than assuming a path. three doesn't export its
// package.json, so resolve its main file and climb to the folder whose package.json says "three".
function threeDir() {
  try {
    let dir = path.dirname(createRequire(import.meta.url).resolve('three'));
    for (let i = 0; i < 4; i++, dir = path.dirname(dir)) {
      try { if (JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).name === 'three') return dir; } catch { /* keep climbing */ }
    }
  } catch { /* not installed: the CDN fallback below takes over */ }
  return path.join(ROOT, 'node_modules', 'three');
}

function openBrowser(url, app) {
  const warn = (e) => log.warn(`could not open a browser: ${e.message}`);
  try {
    let child;
    if (process.platform === 'win32') {
      const args = app ? ['/c', 'start', '""', 'msedge', `--app=${url}`] : ['/c', 'start', '""', url];
      child = spawn('cmd.exe', args, { detached: true, stdio: 'ignore', windowsHide: true });
    } else if (process.platform === 'darwin') {
      child = spawn('open', app ? ['-na', 'Google Chrome', '--args', `--app=${url}`] : [url], { detached: true, stdio: 'ignore' });
    } else {
      child = spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
    }
    child.on('error', warn); // a missing launcher is reported as an event, not thrown
    child.unref();
  } catch (e) {
    warn(e);
  }
}
