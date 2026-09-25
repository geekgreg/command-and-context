// The HUD (DESIGN §10): top bar, tactical map, selection card, EVA log, tooltips, settings + field manual, help,
// keyboard, the empty-world card and the NEEDS YOU attention glow. main.js does `new Hud(engine, world)` and
// then calls hud.apply(snapshot) for every snapshot and hud.status(s) for feed status changes.
//
// Screenshot / debugging URL params (all optional):
//   select=session|agent|port|island[:<id>]   pre-select something (no id: a sensible first one; session:needs = a
//                                              session that needs input) and fly the camera to it
//   panel=settings|manual|help                 open a panel
//   hud=0                                      start with the HUD hidden
//   evatest                                    fill the EVA log with one sample line per event type
//   tiptest                                    (with select=) show that target's hover tooltip mid-screen
// With `shot` present the select= camera move is instant (headless SwiftShader runs the engine clock slowly).
import * as THREE from 'three';
import { STATIC_SITE, PROJECT_URL, el, esc, trunc, prefs, clamp, indexSnapshot, doingText, roleName, funit, fhq, vesselName, portText, islandTitle, fmtPct, fmtAgo, RUNNING } from './util.js';
import { TopBar } from './topbar.js';
import { Minimap } from './minimap.js';
import { SelectionCard } from './card.js';
import { Eva, TONE_COLOR } from './eva.js';
import { Tip, Toast, Panels } from './panels.js';
import { targetOf } from './lines.js';

const LABEL_CYCLE = ['all', 'hover', 'off'];
const DEMO_ARM_MS = 2000;        // D must be pressed twice within this to switch between the live and demo worlds
const typing = (e) => { const t = e.target; return t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)); };

export class Hud {
  constructor(engine, world) {
    this.engine = engine;
    this.world = world;
    this.snap = null;
    this.idx = indexSnapshot(null);
    this.agentCache = new Map();     // agent id -> last seen agent record (+ sessionKey), for finished units
    this.portCache = new Map();      // port id -> last seen port (labels for port_close lines)
    this.prs = new Map();            // session key -> the pull requests it touched since the page loaded (newest first)
    this.hidden = false;
    this.firstApplied = false;
    this.needs = [];
    this.needsIdx = 0;
    this.jump = { at: 0, i: -1 };
    this.params = new URLSearchParams(location.search);
    this.failed = new Set();

    let root = document.getElementById('hud');
    if (!root) { root = el('div', { id: 'hud' }); document.body.appendChild(root); }
    this.root = root;
    root.classList.add('hud-ready');

    this.tip = new Tip();
    this.toast = new Toast();
    this.panels = new Panels(this);
    this.top = new TopBar(this);
    this.mini = new Minimap(this);
    this.card = new SelectionCard(this);
    this.eva = new Eva(this);
    this.hint = el('div.hud-hint', { hidden: true, html: 'HUD hidden · press <kbd>H</kbd>' });

    root.append(this.panels.attn, this.top.root, this.eva.root, this.mini.root, this.card.root, this.panels.empty,
      this.panels.drawer, this.panels.help, this.toast.el, this.hint, this.tip.el);

    this.applyScale();
    addEventListener('resize', () => this.applyScale());
    this.fitLogo();

    // HUD element tooltips ([data-tip]) share the cursor tooltip with the world hover.
    root.addEventListener('pointerover', (e) => {
      const t = e.target.closest?.('[data-tip]');
      if (t && t.getAttribute('data-tip')) this.tip.showFor('hud', t.getAttribute('data-tip'));
      else this.tip.hideFor('hud');
    });
    root.addEventListener('pointerout', (e) => {
      const to = e.relatedTarget;
      if (!to || !root.contains(to) || !to.closest?.('[data-tip]')) this.tip.hideFor('hud');
    });
    // Mouse clicks should not leave focus on a HUD button (Space would re-press it).
    root.addEventListener('click', (e) => {
      if (e.detail > 0 && e.target.closest?.('button')) requestAnimationFrame(() => { if (root.contains(document.activeElement)) document.activeElement.blur(); });
    });

    // engine wiring
    const bus = engine.bus;
    bus.on('select', (t) => this.guard('select', () => { if (t) this.card.show(t); else this.card.close(); }));
    bus.on('hover', (t, info) => this.guard('hover', () => this.onHover(t, info)));
    bus.on('event', (ev) => this.guard('event', () => this.onEvent(ev)));
    bus.on('away', (evs) => this.guard('away', () => this.onAway(evs)));
    bus.on('weather', (w) => { this.storm = !!w?.storm; this.top.syncWeather(); });

    const S = engine.settings;
    this.top.setVoice(S.voice);
    S.on('voice', (v) => { this.top.setVoice(v, this.eva.voice.blocked); if (!v) this.eva.voice.stop(); else this.eva.voice.say('EVA online.', 3, true); });
    S.on('reduceMotion', (v) => root.classList.toggle('rm', !!v));
    S.on('showIdle', () => this.guard('empty', () => this.updateEmpty()));
    root.classList.toggle('rm', !!S.reduceMotion);

    // keyboard: Esc closes overlays first (capture phase, before the engine deselects); the rest bubbles.
    addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.panels.closeTop()) { e.preventDefault(); e.stopImmediatePropagation(); }
    }, true);
    addEventListener('keydown', (e) => this.guard('key', () => this.onKey(e)));

    setInterval(() => this.guard('tick', () => this.tick()), 1000);

    if (this.params.get('hud') === '0') this.setHidden(true, true);
    const panel = this.params.get('panel');
    if (panel === 'settings' || panel === 'manual') this.panels.toggleSettings(panel);
    else if (panel === 'help') this.panels.toggleHelp(true);
  }

  // One failing piece must never take the rest of the HUD (or the red overlay) down with it.
  guard(label, fn) {
    try { return fn(); } catch (e) {
      if (!this.failed.has(label)) { this.failed.add(label); console.error(`[hud] ${label} failed (reported once)`, e); }
      return undefined;
    }
  }

  now() { return this.engine.serverNow?.() ?? Date.now(); }

  applyScale() {
    const base = Math.min(innerWidth / 1600, innerHeight / 900);
    const size = Number(prefs.get('size', 1)) || 1;
    // The top bar is ~96em wide with the wordmark, ~86em without: L/XL on a 16:9 screen would push its plates into
    // each other. Cap the scale so the compact bar always fits, and drop the wordmark whenever the full one doesn't.
    const k = Math.min(clamp(base, 0.7, 2.8) * size, innerWidth / (14 * 90));
    this.root.style.setProperty('--k', k.toFixed(3));
    this.root.classList.toggle('tb-tight', innerWidth / (14 * k) < 98);
    this.engine.labels?.setUserScale?.(size);     // world labels scale with the screen themselves; the nudge is ours
  }

  // The logo is SVG text: once the web font is in, shrink-wrap its viewBox to the real glyph extents.
  fitLogo() {
    const fit = () => {
      const svg = this.root.querySelector('.logo-svg'), t = svg?.querySelector('.lt-ext');
      if (!t) return;
      try {
        const b = t.getBBox();
        if (b.width > 10) {
          const w = b.width + 10, h = b.height + 6;
          svg.setAttribute('viewBox', `${(b.x - 5).toFixed(1)} ${(b.y - 4).toFixed(1)} ${w.toFixed(1)} ${h.toFixed(1)}`);
          svg.style.width = `${((w / h) * 2.05).toFixed(2)}em`;
        }
      } catch { /* not rendered yet */ }
    };
    fit();
    document.fonts?.ready?.then(fit);
    document.fonts?.load?.('40px "Lilita One"').then(fit).catch(() => {});
  }

  // ---- data ------------------------------------------------------------------------------------------------------

  apply(snap) {
    if (!snap) return;
    this.snap = snap;
    this.idx = indexSnapshot(snap);
    // seenAt (local clock) ages the caches; lastSeen (server clock) is when a departed entity was last there
    const now = Date.now(), lastSeen = snap.now;
    for (const s of snap.sessions || []) for (const a of s.agents || []) this.agentCache.set(a.id, { ...a, sessionKey: s.key, seenAt: now, lastSeen });
    for (const p of snap.ports || []) this.portCache.set(p.id, { ...p, seenAt: now, lastSeen });
    if (this.agentCache.size > 400 || this.portCache.size > 200) {
      for (const [k, v] of this.agentCache) if (now - v.seenAt > 30 * 60000) this.agentCache.delete(k);
      for (const [k, v] of this.portCache) if (now - v.seenAt > 30 * 60000) this.portCache.delete(k);
    }

    this.needs = this.guard('topbar', () => this.top.update(snap)) || [];
    this.guard('minimap', () => this.mini.update(snap));
    this.guard('attention', () => this.panels.attn.hidden = !this.needs.length);
    this.guard('empty', () => this.updateEmpty());
    if (this.card.open) this.guard('card', () => this.card.render());

    if (!this.firstApplied) {
      this.firstApplied = true;
      this.guard('history', () => this.eva.history(snap.events));
      this.guard('url', () => this.applyUrl());
    }
  }

  // Empty world: nobody running at all, or everybody asleep while sleeping bases are hidden.
  updateEmpty() {
    const snap = this.snap;
    if (!snap) return;
    const live = (snap.sessions || []).filter((s) => s.state !== 'ended');
    const shown = this.engine.settings.showIdle ? live : live.filter((s) => s.state !== 'asleep');
    this.panels.setEmpty(shown.length ? null : live.length ? 'asleep' : 'none', !!snap.demo, live.length);
  }

  status(s) {
    this.feedStatus = s;
    this.guard('status', () => this.top.status(s));
  }

  // The browser blocks speech until the page gets a click or key press (e.g. after a restart or F5).
  voiceBlocked(on) {
    this.guard('voice', () => {
      this.top.setVoice(this.engine.settings.voice, on);
      if (on && this.engine.settings.voice) this.toast.show('Click anywhere to enable the <b>voice</b>', 6);
    });
  }

  // Lookup context for EVA lines (the world's snapshot is already the newest when events are routed).
  lineCtx() {
    const snap = this.world.snapshot || this.snap;
    if (snap !== this.lcSnap) {
      this.lcSnap = snap;
      this.lc = { ...(snap === this.snap ? this.idx : indexSnapshot(snap)), agentCache: this.agentCache, portCache: this.portCache };
    }
    return this.lc;
  }

  tick() {
    this.top.tickClock();
    this.eva.tick();
    if (this.card.open) this.card.render();
  }

  // ---- events ------------------------------------------------------------------------------------------------------

  onEvent(ev) {
    if (!ev || !ev.type) return;
    this.cacheAgentOf(ev);
    if (ev.type === 'pr' && ev.key) this.notePr(ev);
    const entry = this.eva.push(ev);
    const pos = this.posOfEvent(ev);
    if (pos) this.mini.ping(pos, TONE_COLOR[entry?.info?.tone] || '#39e5ff');
  }

  // Events that arrived during a gap (sleep, outage, server restart): a dimmed digest, no voice, no pings.
  onAway(evs) {
    if (!Array.isArray(evs) || !evs.length) return;
    for (const ev of evs) if (ev?.type) this.cacheAgentOf(ev);
    this.eva.away(evs);
  }

  // The session card lists the pull requests a base touched (one entry per number, the newest action wins).
  notePr(ev) {
    const list = (this.prs.get(ev.key) || []).filter((x) => x.number !== ev.number);
    const url = /^https?:\/\//i.test(ev.url || '') ? String(ev.url) : null;
    list.unshift({ number: ev.number, action: ev.action, url, repo: ev.repo || null });
    this.prs.set(ev.key, list.slice(0, 5));
    if (this.prs.size > 200) this.prs.delete(this.prs.keys().next().value);
  }

  // remember finished agents from the freshest snapshot so their lines and cards stay rich
  cacheAgentOf(ev) {
    const snap = this.world.snapshot;
    if (!ev.agent || !snap) return;
    for (const s of snap.sessions || []) {
      const a = (s.agents || []).find((x) => x.id === ev.agent);
      if (a) { this.agentCache.set(a.id, { ...a, sessionKey: s.key, seenAt: Date.now(), lastSeen: snap.now }); break; }
    }
  }

  posOfEvent(ev) {
    const w = this.world;
    try {
      if (ev.agent) {
        const u = w.unitOf(ev.agent);
        if (u?.group?.parent) return u.group.getWorldPosition(new THREE.Vector3());
      }
      return w.positionOf(ev) || null;
    } catch { return null; }
  }

  posOfTarget(t) {
    if (!t) return null;
    const w = this.world;
    try {
      let p = w.positionOf(t);
      if (!p && t.type === 'agent') {
        const sk = t.session || this.agentCache.get(t.id)?.sessionKey;
        if (sk) p = w.positionOf({ type: 'session', id: sk });
      }
      if (!p && t.type === 'port') {
        const lh = w.town?.lighthouse;
        const port = this.idx.ports.get(t.id);
        if (lh?.isObject3D && port?.kind === 'lighthouse') p = lh.getWorldPosition(new THREE.Vector3());
        else if (port?.owner) p = w.positionOf({ type: 'session', id: port.owner });
      }
      return p;
    } catch { return null; }
  }

  // Fly the camera to a target and select it. Units that already went home just open their card.
  select(t, { focus = true, zoom, secs } = {}) {
    if (!t) return;
    const pick = this.engine.pick, v = this.engine.view;
    const obj = pick.objectOf(t);
    if (obj) pick.select(t);
    else {
      if (pick.selected) pick.select(null);      // drop the old ring; the card now shows something off the map
      this.card.show(t);
    }
    if (focus) {
      const p = this.posOfTarget(t);
      if (p) {
        const z = zoom ?? Math.max(v.zoom, t.type === 'island' ? 1.05 : 1.3);
        this.flyTo(t.type === 'island' ? p : p.clone().setY(p.y + 1), z, secs);
      }
    }
  }

  // Focus a world point so it lands in the open space above the selection card, not underneath it.
  flyTo(p, zoom, secs) {
    const v = this.engine.view;
    v.markInput();
    const lift = (0.1 * 2 * 30) / zoom / Math.sin((35 * Math.PI) / 180);   // 10% of the screen height, on the ground
    const q = p.clone();
    q.x += Math.sin(v.azimuth) * lift;
    q.z += Math.cos(v.azimuth) * lift;
    return v.focus(q, { zoom, secs: secs ?? (this.engine.settings.reduceMotion ? 0 : 0.9) });
  }

  // "agent:<id>" / "session:<key>" / "port:<id>" / "island:<id>" (ids may contain colons).
  selectRef(ref, opts) {
    const i = String(ref).indexOf(':');
    if (i < 0) return;
    const type = ref.slice(0, i), id = ref.slice(i + 1);
    const t = { type, id };
    if (type === 'agent') t.session = this.idx.agents.get(id)?.session?.key || this.agentCache.get(id)?.sessionKey;
    this.select(t, opts);
  }

  jumpTo(entry) {
    const t = entry?.info?.target || targetOf(entry?.ev);
    if (!t) return;
    // the event's entity may be gone (session ended, boat left): fall back to where it happened
    if (!this.engine.pick.objectOf(t) && !(t.type === 'agent' && this.agentCache.has(t.id))) {
      const p = this.posOfEvent(entry.ev);
      if (p) this.flyTo(p, Math.max(this.engine.view.zoom, 1.2));
      else this.toast.show('That one has <b>left the map</b>.');
      return;
    }
    this.select(t);
    entry.node?.classList.add('picked');
    setTimeout(() => entry.node?.classList.remove('picked'), 700);
  }

  // Space: latest event; pressing again within a few seconds walks back through the log.
  jumpLatest() {
    const list = this.eva.latest();
    if (!list.length) { this.toast.show('No events yet. <b>Peaceful.</b>'); return; }
    const now = performance.now();
    this.jump.i = now - this.jump.at < 6000 ? (this.jump.i + 1) % list.length : 0;
    this.jump.at = now;
    this.jumpTo(list[this.jump.i]);
  }

  jumpToNeeds() {
    if (!this.needs.length) return;
    const s = this.needs[this.needsIdx++ % this.needs.length];
    this.select({ type: 'session', id: s.key }, { zoom: Math.max(this.engine.view.zoom, 1.5) });
  }

  // ---- hover tooltips --------------------------------------------------------------------------------------------------

  onHover(t) {
    if (!t) { this.tip.hideFor('world'); return; }
    this.tip.showFor('world', this.hoverText(t));
  }

  hoverText(t) {
    const idx = this.idx, w = this.world;
    if (t.type === 'session') {
      const s = idx.sessions.get(t.id);
      if (t.unit) {
        const u = w.unitOf(t.unit);
        if (typeof u?.tooltip === 'function') { try { const x = u.tooltip(); if (x) return x; } catch { /* fall through */ } }
        if (s) return [`${funit(s.faction)} Commander`, trunc(s.name, 40), doingText(s)].filter(Boolean).join(' · ');
      }
      if (!s) return 'Base';
      return [trunc(s.name, 44), fhq(s.faction), doingText(s)].filter(Boolean).join(' · ');
    }
    if (t.type === 'agent') {
      const u = w.unitOf(t.id);
      if (typeof u?.tooltip === 'function') { try { const x = u.tooltip(); if (x) return x; } catch { /* fall through */ } }
      const a = idx.agents.get(t.id)?.agent || this.agentCache.get(t.id);
      if (!a) return 'Unit';
      return [`${funit(a.faction)} ${roleName(a.type)}`, trunc(a.description || a.type, 44), doingText(a)].filter(Boolean).join(' · ');
    }
    if (t.type === 'port') {
      const p = idx.ports.get(t.id);
      if (!p) return 'Vessel';
      if (p.kind === 'lighthouse') return `Lighthouse · ${p.label || 'Command & Context'} :${p.port} · ${p.conns || 0} watching`;
      const idle = this.now() - (p.lastActive || 0);
      const act = (p.activity || 0) > 0.03 ? `busy ${fmtPct(p.activity)}` : `idle ${fmtAgo(idle)}`;
      const owner = p.owner ? idx.sessions.get(p.owner)?.name : '';
      const adrift = p.adrift ? `ADRIFT ${fmtAgo(this.now() - (p.adrift.since || this.now()))}: ${p.adrift.reason === 'orphaned' ? 'probably left behind' : 'its session ended'}` : '';
      return [`${p.label || p.proc || 'Vessel'} ${portText(p)}`, vesselName(p.kind), adrift, act, owner && trunc(owner, 30)].filter(Boolean).join(' · ');
    }
    if (t.type === 'island') {
      const d = idx.islands.get(t.id);
      if (!d) return 'Island';
      const g = d.git;
      return [d.name, islandTitle(d), g?.files != null ? `${g.files.toLocaleString('en-US')} files` : '', g?.branch ? `⎇ ${g.branch}` : '',
        `${d.sessions || 0} base${d.sessions === 1 ? '' : 's'}`].filter(Boolean).join(' · ');
    }
    return `${t.type}`;
  }

  // ---- actions & keys ---------------------------------------------------------------------------------------------------

  action(act) {
    const S = this.engine.settings;
    if (act === 'settings') this.panels.toggleSettings('settings');
    else if (act === 'help') this.panels.toggleHelp();
    else if (act === 'voice') {
      S.set('voice', !S.voice);
      this.toast.show(`EVA voice <b>${S.voice ? 'on' : 'off'}</b>`);
    } else if (act === 'fullscreen') {
      if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
      else document.documentElement.requestFullscreen?.().catch(() => this.toast.show('Fullscreen was blocked by the browser. Try F11.'));
    }
  }

  onKey(e) {
    if (e.defaultPrevented || typing(e) || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key;
    if (k === 'Escape') {
      // the engine deselects; a card opened for a unit that already went home has no world selection to clear
      if (this.card.open && !this.engine.pick.selected) this.card.close();
      return;
    }
    const isD = k === 'd' || k === 'D';
    // a held D auto-repeats well inside the arming window: that is still one press
    if (isD && e.repeat) { e.preventDefault(); return; }
    if (!isD) this.demoArmedAt = 0;
    if (k === ' ' || k === 'Spacebar') {
      // a keyboard-focused button or link keeps Space for itself (activation)
      if (e.target?.closest?.('button, a[href], [role="button"], summary')) return;
      e.preventDefault();
      this.jumpLatest();
    } else if (k === 'h' || k === 'H') this.setHidden(!this.hidden);
    else if (k === 'l' || k === 'L') this.cycleLabels();
    else if (isD) this.armDemo();
    else if (k === '?' || (k === '/' && e.shiftKey)) this.panels.toggleHelp();
    else return;
    this.engine.view.markInput?.();
  }

  // D reloads into the other world, so it takes a second press within DEMO_ARM_MS: a stray key never does it.
  armDemo() {
    if (STATIC_SITE) { this.getIt(); return; }
    const now = performance.now();
    if (this.demoArmedAt && now - this.demoArmedAt < DEMO_ARM_MS) { this.demoArmedAt = 0; this.toggleDemo(); return; }
    this.demoArmedAt = now;
    const on = new URLSearchParams(location.search).has('demo');
    this.toast.show(`Press <b>D</b> again to ${on ? 'return to the live world' : 'switch to the demo world'}`, DEMO_ARM_MS / 1000);
  }

  setHidden(on, quiet) {
    this.hidden = !!on;
    // quiet = programmatic (e.g. ?hud=0): apply instantly. A fade may never finish in a hidden tab or a
    // headless screenshot, which left the HUD visible.
    if (quiet) {
      this.root.classList.add('hud-instant');
      setTimeout(() => this.root.classList.remove('hud-instant'), 120);
    }
    this.root.classList.toggle('hud-off', this.hidden);
    this.tip.hideFor();
    this.hint.hidden = !this.hidden;
    if (this.hidden && !quiet) {
      this.hint.classList.remove('in');
      void this.hint.offsetWidth;
      this.hint.classList.add('in');
    }
  }

  cycleLabels() {
    const S = this.engine.settings;
    const next = LABEL_CYCLE[(LABEL_CYCLE.indexOf(S.labels) + 1) % LABEL_CYCLE.length];
    S.set('labels', next);
    this.toast.show(`Labels: <b>${esc(next)}</b>`);
  }

  // The web demo has no live world: point at the real thing instead.
  getIt(open = false) {
    this.toast.show('This is the web demo. Run <b>npx command-and-context</b> to watch your own Claude Code sessions.', 4);
    if (open) window.open(PROJECT_URL, '_blank', 'noopener');
  }

  toggleDemo() {
    if (STATIC_SITE) { this.getIt(true); return; }
    const q = new URLSearchParams(location.search);
    const on = q.has('demo');
    if (on) { q.delete('demo'); q.delete('scene'); q.delete('speed'); } else q.set('demo', '');
    this.toast.show(on ? 'Switching to <b>live</b>…' : 'Switching to the <b>demo</b> world…');
    const s = q.toString().replace(/=(?=&|$)/g, '');
    setTimeout(() => { location.href = location.pathname + (s ? '?' + s : '') + location.hash; }, 250);
  }

  // ---- URL helpers (screenshots) -------------------------------------------------------------------------------------------

  applyUrl() {
    const sel = this.params.get('select');
    if (sel) {
      const i = sel.indexOf(':');
      const type = i < 0 ? sel : sel.slice(0, i), id = i < 0 ? '' : sel.slice(i + 1);
      const t = this.resolveSelect(type, id);
      const secs = this.params.has('shot') ? 0 : undefined;   // screenshots: no flight (SwiftShader runs the clock slow)
      if (t) {
        setTimeout(() => this.guard('url-select', () => {
          this.select(t, { focus: !this.params.has('focus'), secs });
          // tiptest: show that target's hover tooltip mid-screen (hover can't be scripted in a headless shot)
          if (this.params.has('tiptest')) {
            this.tip.x = innerWidth * 0.56; this.tip.y = innerHeight * 0.36;
            this.tip.showFor('world', this.hoverText(t));
          }
        }), 60);
      }
    }
    if (this.params.has('evatest')) this.evaTest();
  }

  resolveSelect(type, id) {
    const snap = this.snap, live = (snap.sessions || []).filter((s) => s.state !== 'ended');
    if (type === 'session') {
      const s = id === 'needs' ? live.find((x) => x.state === 'needs_input') : id ? live.find((x) => x.key === id || x.name === id) : null;
      const pickS = s || [...live].sort((a, b) => (b.agents?.length || 0) - (a.agents?.length || 0))[0];
      return pickS ? { type: 'session', id: pickS.key } : null;
    }
    if (type === 'agent') {
      for (const s of live) for (const a of s.agents || []) {
        if (id ? a.id === id : RUNNING(a) && this.world.unitOf(a.id)) return { type: 'agent', id: a.id, session: s.key };
      }
      return null;
    }
    if (type === 'port') {
      const ports = snap.ports || [];
      const p = id ? ports.find((x) => x.id === id || String(x.port) === id) : ports.find((x) => x.container) || ports.find((x) => x.owner) || ports[0];
      return p ? { type: 'port', id: p.id } : null;
    }
    if (type === 'island') {
      const isl = snap.islands || [];
      const d = id ? isl.find((x) => x.id === id || x.name === id) : [...isl].sort((a, b) => (b.tier || 0) - (a.tier || 0))[0];
      return d ? { type: 'island', id: d.id } : null;
    }
    return null;
  }

  evaTest() {
    const snap = this.snap;
    const s = (snap.sessions || [])[0] || { key: 'x', name: 'Fix flaky checkout tests' };
    const a = (s.agents || [])[0] || { id: 'a1', type: 'Explore', description: 'Scout: where checkout state lives' };
    const p = (snap.ports || []).find((x) => x.kind !== 'lighthouse') || { id: '3000', port: 3000, label: 'Nuxt' };
    const isl = (snap.islands || []).find((x) => x.git) || { id: 'i', name: 'storefront-nuxt' };
    const t = this.now();
    const evs = [
      { type: 'session_start', key: s.key, name: s.name },
      { type: 'agent_spawn', key: s.key, agent: a.id, agentType: a.type, description: a.description },
      { type: 'compaction', key: s.key, name: s.name, pre: 812000, post: 96000, trigger: 'auto' },
      { type: 'context_high', key: s.key, name: s.name, pct: 84 },
      { type: 'port_open', port: p.port, portId: p.id },
      { type: 'port_adrift', port: p.port, portId: p.id, label: p.label, reason: 'owner-ended', lastOwner: { key: s.key, name: s.name, guess: false } },
      { type: 'commit', island: isl.id, name: isl.name, msg: 'fix: await the thing we were not awaiting', author: 'Sam Rivera', hash: 'a1b2c3d', branch: isl.git?.branch || 'main' },
      { type: 'conflict', island: isl.id, annex: null, name: isl.name, count: 2 },
      { type: 'pr', key: s.key, island: isl.id, annex: null, name: s.name, number: 123, url: 'https://github.com/octo-org/storefront-nuxt/pull/123', action: 'created', repo: 'octo-org/storefront-nuxt' },
      { type: 'agent_done', key: s.key, agent: a.id, agentType: a.type, description: a.description },
      { type: 'needs_input', key: s.key, name: s.name, detail: 'has a question for you' },
    ];
    evs.forEach((ev, i) => this.onEvent({ ...ev, id: 1e9 + i, t: t - (evs.length - i) * 1000 }));
  }
}

export default Hud;
