// Data feed: live world snapshots from the local server, or a simulated world in demo mode.
//
//   createFeed({ onSnapshot, onStatus }) -> { mode: 'live' | 'demo', stop() }
//
// Live: Server-Sent Events from /api/stream, one full snapshot per message. EventSource retries on its own; on top
// of that a watchdog replaces streams that go silent (sleep, half-open sockets), and when SSE keeps failing the feed
// polls /api/state with exponential backoff, probing SSE again now and then. Malformed messages are dropped.
// Waking up (tab shown again, network back, page restored from the back/forward cache) checks how old the last
// message is and reopens the stream at once when it is stale, instead of trusting a socket that died in the sleep.
// Demo: ?demo (optional &speed=4, &scene=units) loads ./demo.js, which emits snapshots in the same format.
// Status: 'connecting' -> 'live' -> 'reconnecting' -> 'live' ..., or 'demo'. 'stale' = still connected as far as
// the browser knows, but no snapshot for SOFT_STALE_MS (back to 'live' with the next one).
// Callers may override the URL: createFeed({ ..., demo: true, speed: 4, scene: 'units' }) (e.g. a demo toggle key).

const STALE_MS = 20_000;       // the server sends at least every 5 s, so this much silence means a dead stream
const SOFT_STALE_MS = 12_000;  // this much silence dims the LIVE light, and on wake reopens the stream at once
const BACKOFF_MIN = 1000;
const BACKOFF_MAX = 30_000;
const SSE_FAILS = 3;           // consecutive stream errors before falling back to polling
const POLL_MS = 2000;
const PROBE_MAX = 60_000;      // while polling, retry SSE after 0 s, then 15 s, 30 s, 60 s ... (reset once it works)

// The hosted web demo (tools/build-site.mjs marks its page <html data-site="static">) has no server behind it: always demo.
export const STATIC_SITE = globalThis.document?.documentElement?.dataset?.site === 'static';

export function createFeed({ onSnapshot, onStatus, demo, speed, scene } = {}) {
  const params = new URLSearchParams(globalThis.location?.search || '');
  const wantDemo = STATIC_SITE || (demo ?? (params.has('demo') && !/^(0|false|off|no)$/i.test(params.get('demo'))));
  let status = null, inner = null, stopped = false;

  const setStatus = (s) => {
    if (stopped || s === status) return;
    status = s;
    try { onStatus?.(s); } catch (e) { console.error('[feed] onStatus failed', e); }
  };
  const deliver = (snap) => {
    if (stopped) return;
    try { onSnapshot?.(snap); } catch (e) { console.error('[feed] onSnapshot failed', e); }
  };

  const feed = {
    mode: wantDemo ? 'demo' : 'live',
    stop() { stopped = true; inner?.stop(); },
  };

  if (!wantDemo) {
    inner = liveFeed(deliver, setStatus);
  } else {
    setStatus('demo');
    import('./demo.js').then(({ startDemo }) => {
      if (stopped) return;
      inner = startDemo({ onSnapshot: deliver, speed: Number(speed ?? params.get('speed')) || 1, scene: scene ?? params.get('scene') ?? null });
    }).catch((e) => {
      console.error('[feed] demo failed to load, using the live feed', e);
      if (stopped) return;
      feed.mode = 'live';
      inner = liveFeed(deliver, setStatus);
    });
  }
  return feed;
}

// ---- live ----------------------------------------------------------------------------------------------------------

function liveFeed(deliver, setStatus) {
  const url = (p) => new URL(p, globalThis.location?.href || 'http://localhost/').href;
  let es = null, polling = false, stopped = false, everLive = false, lastNow = null, ctrl = null;
  let fails = 0, backoff = BACKOFF_MIN, probeDelay = 0, nextProbe = 0;
  let watchdog = 0, retryTimer = 0, pollTimer = 0, pollBusy = false;
  let shown = null, lastMsgAt = 0, openedAt = 0;

  const show = (s) => { shown = s; setStatus(s); };
  const trouble = () => show(everLive ? 'reconnecting' : 'connecting');
  const nextBackoff = () => {
    const d = backoff;
    backoff = Math.min(BACKOFF_MAX, backoff * 2);
    return d * (0.8 + Math.random() * 0.4);
  };

  // Returns true when the text was a usable snapshot (duplicates of the last one are accepted but not re-delivered).
  function accept(text) {
    const snap = parse(text);
    if (!snap) return false;
    everLive = true;
    lastMsgAt = Date.now();
    fails = 0;
    backoff = BACKOFF_MIN;
    show('live');
    if (snap.now !== lastNow) { lastNow = snap.now; deliver(snap); }
    return true;
  }

  function openStream() {
    closeStream();
    if (stopped) return;
    if (typeof EventSource !== 'function') { startPolling(); return; }
    try { es = new EventSource(url('api/stream')); } catch { startPolling(); return; }
    openedAt = Date.now();
    armWatchdog();
    es.onmessage = (e) => {
      armWatchdog();
      if (accept(e.data)) { probeDelay = 0; stopPolling(); }
    };
    es.onerror = () => streamFailed(!es || es.readyState === 2);   // 2 = CLOSED: the browser gave up on its own retries
  }

  function streamFailed(closed) {
    if (stopped) return;
    fails++;
    trouble();
    if (polling) { closeStream(); scheduleProbe(); return; }   // a probe failed: keep polling
    if (fails >= SSE_FAILS) { closeStream(); startPolling(); return; }
    if (closed) { closeStream(); retryTimer = setTimeout(openStream, nextBackoff()); }
    // otherwise EventSource is already reconnecting (the server asks for a 3 s retry)
  }

  function armWatchdog() {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => streamFailed(true), STALE_MS);
  }

  function closeStream() {
    clearTimeout(watchdog);
    clearTimeout(retryTimer);
    if (es) { es.onmessage = es.onerror = null; es.close(); es = null; }
  }

  function scheduleProbe() {
    nextProbe = Date.now() + probeDelay;
    probeDelay = Math.min(PROBE_MAX, probeDelay ? probeDelay * 2 : 15_000);
  }

  function startPolling() {
    if (polling || stopped) return;
    polling = true;
    scheduleProbe();
    poll();
  }

  function stopPolling() {
    polling = false;
    clearTimeout(pollTimer);
    ctrl?.abort();
    ctrl = null;
  }

  async function poll() {
    if (!polling || stopped || pollBusy) return;
    let ok = false;
    pollBusy = true;
    try {
      ctrl = new AbortController();
      const res = await fetch(url('api/state'), { cache: 'no-store', signal: ctrl.signal });
      ok = res.ok && accept(await res.text());
    } catch { /* server down or aborted */ }
    pollBusy = false;
    if (!polling || stopped) return;
    if (!ok) trouble();
    else if (!es && Date.now() >= nextProbe) openStream();   // the server answers: try the stream again
    clearTimeout(pollTimer);
    pollTimer = setTimeout(poll, ok ? POLL_MS : nextBackoff());
  }

  // Connected as far as the browser knows, but nothing for a while: dim the LIVE light (the watchdog reconnects).
  function checkFresh() {
    if (!stopped && shown === 'live' && Date.now() - lastMsgAt > SOFT_STALE_MS) show('stale');
  }

  // Back from sleep / hidden / offline: a stale feed reconnects now instead of waiting for the watchdog.
  function wake(e) {
    if (stopped) return;
    if (e?.type === 'visibilitychange' && globalThis.document?.hidden) return;
    if (Date.now() - Math.max(lastMsgAt, openedAt) <= SOFT_STALE_MS) return;
    checkFresh();
    if (polling) { if (!pollBusy) { clearTimeout(pollTimer); poll(); } } else openStream();
  }

  const freshTimer = setInterval(checkFresh, 2000);
  const doc = globalThis.document;
  doc?.addEventListener?.('visibilitychange', wake);
  globalThis.addEventListener?.('online', wake);
  globalThis.addEventListener?.('pageshow', wake);

  show('connecting');
  openStream();
  return {
    stop() {
      stopped = true;
      clearInterval(freshTimer);
      doc?.removeEventListener?.('visibilitychange', wake);
      globalThis.removeEventListener?.('online', wake);
      globalThis.removeEventListener?.('pageshow', wake);
      closeStream();
      stopPolling();
    },
  };
}

// A snapshot must be an object with a numeric `now`; missing lists become empty, wrong types reject it.
// Events without an integer id or a type are dropped (and ids must ascend), so a stale server build can never
// poison the world's "highest event id seen".
function parse(text) {
  let s;
  try { s = JSON.parse(text); } catch { return null; }
  if (!s || typeof s !== 'object' || !Number.isFinite(s.now)) return null;
  for (const k of ['islands', 'sessions', 'ports', 'events']) {
    if (s[k] == null) s[k] = [];
    else if (!Array.isArray(s[k])) return null;
  }
  let last = -Infinity;
  s.events = s.events.filter((e) => {
    const ok = e && Number.isInteger(e.id) && typeof e.type === 'string' && e.id > last;
    if (ok) last = e.id;
    return ok;
  });
  return s;
}
