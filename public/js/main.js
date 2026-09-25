// Bootstrap: engine + world, then the data feed (net.js, or /api/state polling as a fallback) and the optional HUD.
import { createEngine } from './world/engine.js';
import { World } from './world/world.js';

const splash = window.__splash || { hide() {}, status() {}, fail() {} };

let engine;
try {
  engine = createEngine({ container: document.getElementById('stage'), labelRoot: document.getElementById('labels') });
} catch (e) {
  splash.fail('WebGL is not available here. Command & Context needs a GPU-capable browser.');
  throw e;
}
const world = new World(engine);
window.cnc = { engine, world };                     // devtools handle

let hud = null, feed = null, lastSnap = null, lastStatus = null, first = true;

const STATUS_TEXT = { connecting: 'Connecting to the collector', live: 'Live feed established', reconnecting: 'Reconnecting…', demo: 'Demo mode' };

function onSnapshot(snap) {
  if (!snap || snap.v !== 1) return;
  lastSnap = snap;
  world.apply(snap).then(() => {
    if (hud?.apply) { try { hud.apply(snap); } catch (e) { console.error('[hud] apply threw', e); } }
    if (first) { first = false; splash.hide(); }
  }).catch((e) => console.error('[main] world.apply failed', e));
}

function onStatus(s) {
  lastStatus = s;
  splash.status(STATUS_TEXT[s] || String(s));
  if (hud?.status) { try { hud.status(s); } catch (e) { console.error('[hud] status threw', e); } }
}

// A module that is simply not written yet is fine (info); one that exists but fails is an error (red overlay).
async function report(path, e) {
  const missing = await fetch(new URL(path, import.meta.url), { method: 'HEAD', cache: 'no-store' }).then((r) => !r.ok).catch(() => true);
  if (missing) console.info(`[main] ${path} not present; continuing without it.`);
  else console.error(`[main] ${path} failed to load`, e);
}

function startPolling() {
  let ok = false, stopped = false, timer = 0;
  onStatus('connecting');
  const poll = async () => {
    try {
      const r = await fetch('/api/state', { cache: 'no-store' });
      const snap = await r.json();
      if (snap && snap.v === 1) {
        if (!ok) { ok = true; onStatus('live'); }
        onSnapshot(snap);
      }
    } catch {
      if (ok) { ok = false; onStatus('reconnecting'); }
    }
    if (!stopped) timer = setTimeout(poll, 2000);
  };
  poll();
  feed = { mode: 'live', stop() { stopped = true; clearTimeout(timer); } };
}

// Headless screenshots (?shot): a never-ending SSE stream stalls Chrome's virtual-time budget, so poll instead.
const params = new URLSearchParams(location.search);
const staticSite = document.documentElement.dataset.site === 'static';   // the hosted web demo: no server to poll
if (params.has('shot') && !params.has('demo') && !staticSite) {
  startPolling();
  window.cnc.feed = feed;
} else {
  import('./net.js')
    .then((m) => {
      if (typeof m.createFeed !== 'function') throw new Error('net.js does not export createFeed');
      feed = m.createFeed({ onSnapshot, onStatus });
      window.cnc.feed = feed;
    })
    .catch((e) => { report('./net.js', e); startPolling(); window.cnc.feed = feed; });
}

import('./hud/hud.js')
  .then((m) => {
    const Hud = m.Hud || m.default;
    if (typeof Hud !== 'function') throw new Error('hud.js does not export Hud');
    hud = new Hud(engine, world);
    window.cnc.hud = hud;
    if (lastStatus && hud.status) hud.status(lastStatus);
    if (lastSnap && hud.apply && !first) hud.apply(lastSnap);
  })
  .catch((e) => report('./hud/hud.js', e));

setTimeout(() => { if (first && !staticSite) splash.status('Still waiting for the collector… is `npm start` running?'); }, 12000);
