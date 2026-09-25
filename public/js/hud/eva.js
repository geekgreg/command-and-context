// EVA log (right side): announcer lines for new events, newest on top, fading with age; click a line to fly there.
// NEEDS YOU lines stay pinned while that session still needs input; bursts of harbor events share one line; news
// that arrived during a gap (sleep, outage, server restart) comes in as a few dimmed "while you were away" lines.
// Optional voice via speechSynthesis (low pitch, a little slow, rate-limited, silent while the tab is hidden).
import { el, prefs, fmtAgo } from './util.js';
import { ICON } from './icons.js';
import { announce } from './lines.js';

const MAX_LINES = 6;
const KEEP = 4;              // the newest few stay (dimmed) so the log is never blank after the first news
const FRESH_SECS = 40;       // bright for this long
const DROP_SECS = 150;       // older lines beyond KEEP disappear after this
const AWAY_LINES = 3;        // "while you were away": at most this many lines (the rest is counted on the marker)
const MERGE_MS = 15000;      // a port event this soon after the last one joins its line ("3 vessels docked · 1 departed")
const MERGE_SPAN_MS = 120000;  // ... but one merged line covers at most this long
const PORT_EV = /^port_(open|close)$/;

export const TONE_COLOR = {
  good: '#3ddc84', bad: '#ff5a4d', warn: '#ff9f3a', alert: '#ffd23f', info: '#39e5ff', port: '#5fe3c0', git: '#e86bff', dim: '#8f9ccc',
};

// Chrome/Edge refuse to speak until the page has had a user gesture ('not-allowed'): the voice then waits for the
// next pointerdown/keydown and says the line it missed (or "EVA online." once that is stale). Chromium can also get
// stuck reporting `speaking` forever (long uptime, audio device change, wake): a line "speaking" for longer than
// STUCK_MS resets the engine so the queue recovers.
const STUCK_MS = 15000;
const RETRY_FRESH_MS = 30000;   // a missed line older than this is not worth saying after the unblocking click

class Voice {
  constructor() {
    this.last = 0;
    this.queued = null;
    this.timer = 0;
    this.voice = null;
    this.blocked = false;         // the browser refused to speak (no user gesture yet)
    this.retry = null;            // { text, priority, at }: the line to say once unblocked
    this.onBlocked = null;        // (blocked: boolean) => void, for the HUD hint
    this.enabled = () => true;    // is the voice setting still on?
    this.ok = typeof window !== 'undefined' && 'speechSynthesis' in window && typeof SpeechSynthesisUtterance === 'function';
    if (this.ok) {
      const pick = () => { this.voice = this.pickVoice(); };
      try { speechSynthesis.addEventListener?.('voiceschanged', pick); } catch { /* old browsers */ }
      pick();
    }
  }

  // speaking/pending, unless that has lasted impossibly long: then the engine is wedged, so reset it.
  busy() {
    let b = false;
    try { b = speechSynthesis.speaking || speechSynthesis.pending; } catch { /* ignore */ }
    if (b && performance.now() - this.last > STUCK_MS) {
      try { speechSynthesis.cancel(); } catch { /* ignore */ }
      return false;
    }
    return b;
  }

  setBlocked(on, text, priority) {
    if (on) {
      if (text && (!this.retry || priority >= this.retry.priority || performance.now() - this.retry.at > RETRY_FRESH_MS)) {
        this.retry = { text, priority, at: performance.now() };
      }
      clearTimeout(this.timer);
      this.queued = null;
      this.armGesture();
    }
    if (this.blocked === on) return;
    this.blocked = on;
    try { this.onBlocked?.(on); } catch (e) { console.error('[eva] voice hint failed', e); }
  }

  // The next click or key press is the user gesture the browser wants: try again right after it.
  armGesture() {
    if (this.gesture) return;
    const go = () => {
      removeEventListener('pointerdown', go, true);
      removeEventListener('keydown', go, true);
      this.gesture = null;
      setTimeout(() => this.unblock(), 250);   // after the click itself (it may be the voice toggle)
    };
    this.gesture = go;
    addEventListener('pointerdown', go, true);
    addEventListener('keydown', go, true);
  }

  unblock() {
    if (!this.blocked) return;
    const r = this.retry;
    this.retry = null;
    this.setBlocked(false);
    if (!this.enabled()) return;
    this.utter(r && performance.now() - r.at < RETRY_FRESH_MS ? r.text : 'EVA online.', r?.priority ?? 1);
  }

  pickVoice() {
    const vs = speechSynthesis.getVoices?.() || [];
    const en = vs.filter((v) => /^en[-_]/i.test(v.lang || ''));
    const pref = [/Zira/i, /Hazel/i, /Susan/i, /Samantha/i, /Karen/i, /Moira/i, /Aria/i, /Jenny/i, /Female/i, /UK English/i];
    for (const re of pref) {
      const v = en.find((x) => re.test(x.name) && x.localService !== false) || en.find((x) => re.test(x.name));
      if (v) return v;
    }
    return en[0] || vs[0] || null;
  }

  stop() {
    clearTimeout(this.timer);
    this.queued = null;
    this.retry = null;
    if (this.ok) try { speechSynthesis.cancel(); } catch { /* ignore */ }
  }

  say(text, priority = 1, force = false) {
    if (!this.ok || !text) return;
    if (!force && document.hidden) return;
    if (this.blocked) { this.setBlocked(true, text, priority); return; }   // wait for the user's click
    const now = performance.now();
    const busy = this.busy();
    const gap = now - this.last;
    if (!force && (busy || gap < 2600)) {
      // keep only the most important pending line; urgent news jumps the queue
      if (!this.queued || priority >= this.queued.priority) this.queued = { text, priority };
      if (priority >= 3 && busy) { try { speechSynthesis.cancel(); } catch { /* ignore */ } }
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.flush(), Math.max(400, 2600 - gap));
      return;
    }
    this.utter(text, priority);
  }

  flush() {
    const q = this.queued;
    if (!q || this.blocked) return;
    if (this.busy()) { this.timer = setTimeout(() => this.flush(), 700); return; }
    this.queued = null;
    if (!document.hidden) this.utter(q.text, q.priority);
  }

  utter(text, priority = 1) {
    try {
      const u = new SpeechSynthesisUtterance(text);
      if (this.voice) u.voice = this.voice;
      u.pitch = 0.55;
      u.rate = 0.9;
      u.volume = 0.9;
      u.onend = () => { if (this.queued) this.timer = setTimeout(() => this.flush(), 900); };
      u.onerror = (e) => {
        const err = e?.error;
        if (err === 'not-allowed') { this.setBlocked(true, text, priority); return; }
        // 'interrupted' / 'canceled' are our own cancel(); anything else: carry on with the queue
        if (err !== 'interrupted' && err !== 'canceled') console.warn('[eva] speech failed:', err);
        if (this.queued) { clearTimeout(this.timer); this.timer = setTimeout(() => this.flush(), 900); }
      };
      if (speechSynthesis.paused) speechSynthesis.resume();
      speechSynthesis.speak(u);
      this.last = performance.now();
    } catch { /* speech unavailable */ }
  }
}

export class Eva {
  constructor(hud) {
    this.hud = hud;
    this.entries = [];          // newest first: { ev, node, at, hist, info }
    this.seq = 0;
    this.voice = new Voice();
    this.voice.enabled = () => !!hud.engine.settings.voice;
    this.voice.onBlocked = (on) => hud.voiceBlocked?.(on);
    this.seen = new Set();
    this.groups = new Set();    // separator lines ("earlier", "while you were away")
    const col = el('button.mini-btn', { type: 'button', 'data-tip': 'Collapse log', html: ICON.minus });
    col.addEventListener('click', () => this.setCollapsed(!this.collapsed));
    this.colBtn = col;
    this.rec = el('i.rec');
    const head = el('div.panel-head', null, this.rec, el('span.ph-t', { text: 'EVA' }), el('span.ph-s', { text: 'field reports' }), el('span.ph-sp'), col);
    head.addEventListener('dblclick', () => this.setCollapsed(!this.collapsed));
    this.list = el('ol.eva-list');
    this.empty = el('div.eva-empty', { text: 'All quiet on the localhost front.' });
    this.root = el('div.eva.panel', null, head, this.list, this.empty);
    this.list.addEventListener('click', (e) => {
      const li = e.target.closest('li[data-i]');
      const entry = li && this.entries.find((x) => String(x.id) === li.getAttribute('data-i'));
      if (entry) hud.jumpTo(entry);
    });
    this.setCollapsed(prefs.get('evaCollapsed', false), true);
  }

  setCollapsed(on, quiet) {
    this.collapsed = !!on;
    this.root.classList.toggle('collapsed', this.collapsed);
    this.colBtn.innerHTML = this.collapsed ? ICON.plus : ICON.minus;
    this.colBtn.setAttribute('data-tip', this.collapsed ? 'Expand log' : 'Collapse log');
    if (!quiet) prefs.set('evaCollapsed', this.collapsed);
  }

  // Marks an event as shown; false when it already was (ids restart with the server; the timestamp keeps keys unique).
  claim(ev) {
    const key = `${ev.id}|${ev.t}|${ev.type}`;
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    if (this.seen.size > 500) this.seen = new Set([...this.seen].slice(-250));
    return true;
  }

  // First snapshot: a few dimmed lines of recent history so the log is not empty (never spoken, never pinged).
  // Every event in it counts as seen, so none of them can come back later as news.
  history(events) {
    const all = (events || []).filter((e) => e && e.type);
    const fresh = new Set(all.filter((e) => this.claim(e)));
    // prefer real news over routine harbor churn (dev servers opening and closing ports all day)
    const pool = all.slice(-24).filter((e) => fresh.has(e));
    const rich = pool.filter((e) => !PORT_EV.test(e.type));
    const list = (rich.length >= 2 ? rich : pool).slice(-KEEP).reverse();
    if (!list.length) return;
    const sep = this.group('earlier', false);
    for (const ev of list) this.add(ev, { hist: true, grp: sep, bottom: true });
    this.finish();
  }

  // Back after a gap (sleep, outage, server restart), when the world materializes without animations: the news that
  // arrived meanwhile, compacted into a few dimmed, unspoken lines under a "while you were away" marker.
  away(events) {
    const fresh = (events || []).filter((e) => e && e.type && this.claim(e));
    if (!fresh.length) return;
    const ports = fresh.filter((e) => PORT_EV.test(e.type));
    // one line per kind of news per subject (the newest), the most important first
    const latest = new Map();
    for (const e of fresh) if (!PORT_EV.test(e.type)) latest.set(`${e.type}|${e.key ?? e.island ?? e.portId ?? ''}`, e);
    const pick = [...latest.values()].sort((a, b) => awayRank(b) - awayRank(a) || (b.t || 0) - (a.t || 0)).slice(0, AWAY_LINES);
    const lines = pick.map((ev) => ({ ev, t: ev.t || 0 }));
    if (ports.length && lines.length < AWAY_LINES) lines.push({ ev: ports[ports.length - 1], evs: ports, t: ports[ports.length - 1].t || 0 });
    const shown = pick.length + (lines.length > pick.length ? ports.length : 0);
    const more = fresh.length - shown;
    lines.sort((a, b) => a.t - b.t);   // inserted at the top one by one: oldest first ends newest first
    const sep = this.group(`while you were away${more > 0 ? ` · +${more} more` : ''}`, true);
    for (const x of lines) this.add(x.ev, { hist: true, grp: sep, evs: x.evs });
    this.list.insertBefore(sep, this.list.firstChild);
    this.finish();
    this.blip();
  }

  push(ev) {
    if (!this.claim(ev)) return null;
    const merged = this.mergePort(ev);
    const entry = merged || this.add(ev);
    if (!entry) return null;
    this.finish();
    this.blip();
    // a merged harbor line stays quiet: one "vessel docked" is plenty
    if (!merged && this.hud.engine.settings.voice) this.voice.say(entry.info.text, entry.info.priority);
    return entry;
  }

  blip() {
    this.rec.classList.remove('blip');
    void this.rec.offsetWidth;
    this.rec.classList.add('blip');
  }

  // A separator line ("earlier", "while you were away"); it goes away with the last line under it.
  group(text, away) {
    const sep = el(`li.eva-sep${away ? '.away' : ''}`, { text });
    if (!away) this.list.appendChild(sep);
    this.groups.add(sep);
    return sep;
  }

  // opts: hist (dimmed, not animated in), grp (its separator), bottom (append below), evs (merged harbor events)
  add(ev, { hist = false, grp = null, bottom = false, evs = null } = {}) {
    let info;
    try { info = evs ? portInfo(evs, ev, this.hud.lineCtx()) : announce(ev, this.hud.lineCtx()); } catch (e) { console.error('[hud] EVA line failed', e); return null; }
    const id = ++this.seq;
    const at = ev.t || this.hud.now();
    const txt = el('span.ev-txt', { html: info.html });
    const node = el(`li.eva-line.t-${info.tone}${hist ? '.hist' : ''}`, { 'data-i': String(id), 'data-tip': lineTip(info) },
      el('span.ev-ico', { html: info.icon }), txt,
      el('span.ev-age', { text: hist ? fmtAgo(this.hud.now() - at) : 'now' }));
    node.style.setProperty('--tone', TONE_COLOR[info.tone] || TONE_COLOR.info);
    const born = performance.now();
    const entry = { id, ev: info.ev || ev, node, txt, at, hist, info, born, grp, evs: evs ? [...evs] : PORT_EV.test(ev.type) ? [ev] : null, since: born, touched: born };
    if (bottom) {
      this.list.appendChild(node);
      this.entries.push(entry);
    } else {
      this.list.insertBefore(node, this.list.firstChild);
      this.entries.unshift(entry);
      if (!hist) node.classList.add('in');
    }
    return entry;
  }

  // Harbor churn (docker / supabase restarting its ports): a port event right after another fold into one line,
  // "3 vessels docked · 1 departed", instead of pushing everything else out of the log.
  mergePort(ev) {
    if (!PORT_EV.test(ev.type)) return null;
    const top = this.entries[0], perf = performance.now();
    if (!top?.evs || top.hist || perf - top.touched > MERGE_MS || perf - top.since > MERGE_SPAN_MS) return null;
    let info;
    try { info = portInfo([...top.evs, ev], ev, this.hud.lineCtx()); } catch (e) { console.error('[hud] EVA line failed', e); return null; }
    top.evs.push(ev);
    top.ev = info.ev;
    top.info = info;
    top.at = ev.t || this.hud.now();
    top.born = top.touched = perf;
    top.txt.innerHTML = info.html;
    top.node.setAttribute('data-tip', lineTip(info) || '');
    top.node.lastChild.textContent = 'now';
    return top;
  }

  // NEEDS YOU lines stay until that session no longer needs input (only its newest such line).
  pinned(x) {
    const ev = x?.ev;
    if (ev?.type !== 'needs_input' || !ev.key) return false;
    if (this.hud.lineCtx?.()?.sessions?.get(ev.key)?.state !== 'needs_input') return false;
    return this.entries.find((y) => y.ev?.type === 'needs_input' && y.ev.key === ev.key) === x;
  }

  finish() {
    this.trim();
    this.sync();
  }

  // Too many lines: the oldest one that is not pinned goes (pinned ones only past twice the limit). The
  // line just added (index 0) is never the one to go, or news would be spoken but never shown.
  trim() {
    while (this.entries.length > MAX_LINES) {
      let i = this.entries.length - 1;
      while (i >= 1 && this.pinned(this.entries[i])) i--;
      if (i < 1) {
        if (this.entries.length <= MAX_LINES * 2) break;
        i = this.entries.length - 1;
      }
      const [x] = this.entries.splice(i, 1);
      x.node.remove();
    }
    for (const sep of this.groups) {
      if (!this.entries.some((x) => x.grp === sep)) { sep.remove(); this.groups.delete(sep); }
    }
  }

  sync() {
    this.empty.hidden = this.entries.length > 0;
    this.root.classList.toggle('quiet', !this.entries.some((x) => !x.hist && !x.node.classList.contains('dim')));
  }

  // 1 Hz: ages, fading, dropping.
  tick() {
    const now = this.hud.now();
    const perf = performance.now();
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const x = this.entries[i];
      const age = (perf - x.born) / 1000;
      const pin = this.pinned(x);
      x.node.classList.toggle('pinned', pin);
      x.node.classList.toggle('dim', !pin && (x.hist || age > FRESH_SECS));
      if (!pin && i >= KEEP && age > DROP_SECS) { x.node.classList.add('out'); setTimeout(() => x.node.remove(), 600); this.entries.splice(i, 1); continue; }
      const t = Math.max(0, now - x.at);
      const txt = t < 5000 ? 'now' : fmtAgo(t);
      if (x.node.lastChild.textContent !== txt) x.node.lastChild.textContent = txt;
    }
    this.finish();
  }

  latest() { return this.entries.filter((x) => x.info.target); }
}

// ---- helpers ------------------------------------------------------------------------------------------------------

const lineTip = (info) => [info.tip, info.target ? 'Click to jump there' : ''].filter(Boolean).join(' · ') || null;

// "while you were away" order: what needs you first, then outcomes, then the rest; harbor churn last.
function awayRank(ev) {
  const t = ev.type;
  if (t === 'needs_input') return 5;
  if (t === 'agent_failed' || t === 'conflict') return 4;
  if (t === 'turn_done') return 3.5;
  if (t === 'commit' || t === 'push' || t === 'merge' || t === 'pr') return 3;
  if (/^(session_start|session_end|clear|compaction|context_high)$/.test(t)) return 2;
  return 1;
}

// One line for several harbor events: "3 vessels docked · 1 departed". A single event reads as its normal line.
// Clicking goes to the newest boat that docked (or the newest event's).
function portInfo(evs, newest, ctx) {
  const open = evs.filter((e) => e.type === 'port_open'), close = evs.filter((e) => e.type === 'port_close');
  const target = [...open].reverse().find((e) => ctx.ports?.has(e.portId)) || newest;
  if (evs.length === 1) return { ...announce(evs[0], ctx), ev: evs[0] };
  const base = announce(target, ctx);
  const portOf = (e) => (e.port != null ? `:${e.port}` : ctx.portCache?.get(e.portId)?.port != null ? `:${ctx.portCache.get(e.portId).port}` : '');
  const list = (xs) => { const u = [...new Set(xs.map(portOf).filter(Boolean))]; return u.slice(0, 6).join(' ') + (u.length > 6 ? ` +${u.length - 6}` : ''); };
  const n = (k, one, many) => `<b class="e-num">${k}</b> ${k === 1 ? one : many}`;
  const html = [open.length ? n(open.length, 'vessel docked', 'vessels docked') : '', close.length ? n(close.length, 'departed', 'departed') : ''].filter(Boolean).join(' · ');
  const text = [open.length ? `${open.length} vessel${open.length === 1 ? '' : 's'} docked` : '', close.length ? `${close.length} departed` : ''].filter(Boolean).join(', ');
  const tip = [open.length ? `Docked ${list(open)}` : '', close.length ? `Departed ${list(close)}` : ''].filter(Boolean).join(' · ');
  return { ...base, html, text, tip, ev: target, icon: base.icon, tone: 'port', priority: 1 };
}
