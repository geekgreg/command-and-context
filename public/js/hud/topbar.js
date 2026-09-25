// Top bar: game logo, resource counters, the NEEDS YOU pill, clock, connection light and the chrome buttons.
import { STATIC_SITE, el, setText, fmtTokens, fmtUsd, fmtClock, fmtPct, plural, RUNNING, esc, trunc } from './util.js';
import { ICON, weatherIcon, EV_ICON } from './icons.js';

const LOGO_TEXT = 'COMMAND & CONTEXT';

function logoSvg() {
  const txt = `COMMAND <tspan class="amp">&amp;</tspan> CONTEXT`;
  return `<svg class="logo-svg" viewBox="-6 -40 398 56" preserveAspectRatio="xMinYMid meet" aria-label="${LOGO_TEXT}">
    <defs>
      <linearGradient id="cnc-logo-gold" x1="0" y1="-30" x2="0" y2="4" gradientUnits="userSpaceOnUse">
        <stop offset="0" stop-color="#fff6cf"/><stop offset=".42" stop-color="#ffd65c"/>
        <stop offset=".5" stop-color="#f2a51c"/><stop offset="1" stop-color="#ffcf47"/>
      </linearGradient>
      <linearGradient id="cnc-logo-cyan" x1="0" y1="-30" x2="0" y2="4" gradientUnits="userSpaceOnUse">
        <stop offset="0" stop-color="#e6fdff"/><stop offset=".45" stop-color="#5eeaff"/><stop offset="1" stop-color="#1596c9"/>
      </linearGradient>
      <linearGradient id="cnc-logo-glint" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".5" stop-color="#fffdf0" stop-opacity="1"/><stop offset="1" stop-color="#fff" stop-opacity="0"/>
      </linearGradient>
      <clipPath id="cnc-logo-clip"><text x="0" y="0" font-size="40" class="lt-clip">${txt}</text></clipPath>
    </defs>
    <g class="lt" font-size="40">
      <text class="lt-ext" x="0" y="5">${txt}</text>
      <text class="lt-out" x="0" y="0">${txt}</text>
      <text class="lt-fill" x="0" y="0">${txt}</text>
      <text class="lt-shine" x="0" y="0">${txt}</text>
      <g clip-path="url(#cnc-logo-clip)"><g transform="skewX(-22)"><rect class="lt-glint" x="-64" y="-44" width="42" height="56" fill="url(#cnc-logo-glint)"/></g></g>
    </g>
  </svg>`;
}

const EMBLEM = `<svg class="emblem" viewBox="0 0 48 52" aria-hidden="true">
  <path d="M24 2 45 13.5v25L24 50 3 38.5v-25z" fill="#16204a" stroke="#0b1026" stroke-width="4" stroke-linejoin="round"/>
  <path d="M24 2 45 13.5v25L24 50 3 38.5v-25z" fill="none" stroke="#ffc53d" stroke-width="2.4" stroke-linejoin="round"/>
  <path d="M24 7.5 40.5 16.5v19.5L24 45 7.5 36V16.5z" fill="none" stroke="#39e5ff" stroke-opacity=".35" stroke-width="1.2"/>
  <path d="M24 10 35 19.5 24 42 13 19.5z" fill="#39e5ff" stroke="#0b1026" stroke-width="2.2" stroke-linejoin="round"/>
  <path d="M24 10 35 19.5 24 23.5 13 19.5z" fill="#d6fcff"/>
  <path d="M24 23.5 35 19.5 24 42z" fill="#1596c9"/>
  <path d="M24 10 35 19.5 24 42 13 19.5z" fill="none" stroke="#0b1026" stroke-width="2.2" stroke-linejoin="round"/>
  <path d="M9 44.5l4-2.4M39 44.5l-4-2.4" stroke="#ffc53d" stroke-width="2.4" stroke-linecap="round"/>
</svg>`;

const CONN = {
  live: ['LIVE', 'Live feed from the collector'],
  stale: ['LIVE', 'No update from the collector for a while: checking the line…'],
  demo: ['DEMO', STATIC_SITE ? 'Simulated world: the web demo' : 'Simulated world (press D twice for live)'],
  reconnecting: ['RECONNECTING', 'Lost the collector, retrying…'],
  connecting: ['CONNECTING', 'Looking for the collector…'],
};

export class TopBar {
  constructor(hud) {
    this.hud = hud;
    this.vals = {};
    const res = (k, icon, label) => {
      const v = el('b.rv-n', { text: '–' });
      const node = el('div.res', { 'data-k': k, 'data-tip': label }, el('span.ri', { html: icon }), el('span.rv', null, v, el('small', { text: label })));
      this.vals[k] = { node, v, label, prev: null };
      return node;
    };

    this.logo = el('button.logo', { type: 'button', 'data-tip': 'Field manual: what am I looking at?', html: EMBLEM + `<span class="logo-t">${logoSvg()}<span class="logo-sub">Localhost theatre of operations</span></span>` });
    this.logo.addEventListener('click', () => hud.panels.toggleSettings('manual'));
    this.demo = el('button.demo-badge', { type: 'button', hidden: true, 'data-tip': STATIC_SITE
      ? 'Web demo: a simulated world. Click to get Command & Context for your own Claude Code sessions (npx command-and-context).'
      : 'Demo world. Click, or press D twice, to switch to your live sessions.' });
    this.demo.addEventListener('click', () => hud.toggleDemo());

    this.cpuIcon = null;
    const mid = el('div.tb-mid.plate', null,
      res('bases', ICON.hq, 'Bases'),
      res('supply', ICON.supply, 'Supply'),
      res('docks', ICON.anchor, 'Docks'),
      res('tokens', ICON.crystal, 'Tokens'),
      res('cost', ICON.coin, 'Cost'),
      res('cpu', weatherIcon(0, false, false), 'CPU'),
    );
    this.vals.cost.node.hidden = true;
    this.cpuIconEl = this.vals.cpu.node.querySelector('.ri');

    this.pill = el('button.needs-pill', { type: 'button', hidden: true });
    this.pill.addEventListener('click', () => hud.jumpToNeeds());

    this.clock = el('div.clock', { 'data-tip': '' });
    this.conn = el('div.conn', { 'data-tip': '' }, el('i'), el('span', { text: 'CONNECTING' }));
    const btn = (act, icon, tip) => {
      const b = el('button.btn', { type: 'button', 'data-act': act, 'data-tip': tip, 'aria-label': tip, html: icon });
      b.addEventListener('click', () => hud.action(act));
      return b;
    };
    this.btnVoice = btn('voice', ICON.voiceOff, 'EVA voice: off');
    this.btnFull = btn('fullscreen', ICON.fullscreen, 'Fullscreen');
    const right = el('div.tb-right.plate', null, this.clock, this.conn,
      el('div.btns', null, btn('settings', ICON.gear, 'Settings & field manual'), this.btnVoice, this.btnFull, btn('help', ICON.help, 'Keyboard & mouse (?)')));

    this.root = el('div.topbar', null, el('div.tb-left.plate', null, this.logo, this.demo), el('div.tb-midwrap', null, mid, this.pill), right);
    this.status('connecting');
    this.tickClock();
    document.addEventListener('fullscreenchange', () => this.syncFullscreen());
  }

  set(k, text, tip) {
    const x = this.vals[k];
    if (!x) return;
    // only the discrete counters bump; tokens / cost / cpu tick constantly and would never sit still
    if (x.prev !== null && x.prev !== text && (k === 'bases' || k === 'supply' || k === 'docks')) {
      x.node.classList.remove('bump');
      void x.node.offsetWidth;
      x.node.classList.add('bump');
    }
    x.prev = text;
    setText(x.v, text);
    if (tip != null && x.node.getAttribute('data-tip') !== tip) x.node.setAttribute('data-tip', tip);
  }

  update(snap) {
    const sessions = (snap.sessions || []).filter((s) => s.state !== 'ended');
    const by = (st) => sessions.filter((s) => s.state === st).length;
    this.set('bases', String(sessions.length), [
      plural(sessions.length, 'base'),
      by('working') + by('waiting') ? `${by('working') + by('waiting')} working` : '',
      by('thinking') ? `${by('thinking')} thinking` : '',
      by('needs_input') ? `${by('needs_input')} need you` : '',
      by('idle') ? `${by('idle')} at lunch` : '',
      by('asleep') ? `${by('asleep')} asleep` : '',
    ].filter(Boolean).join(' · '));

    let run = 0, listed = 0, agentCtx = 0;
    for (const s of sessions) for (const a of s.agents || []) {
      listed++;
      if (RUNNING(a)) { run++; agentCtx += Number(a.context) || 0; }
    }
    this.set('supply', `${run}/${listed}`, `${plural(run, 'sub-agent')} in the field · ${listed - run} back at base (finished recently)`);

    const ports = (snap.ports || []).filter((p) => p.kind !== 'lighthouse');
    const busy = ports.filter((p) => (p.activity || 0) > 0.15).length;
    const ctr = ports.filter((p) => p.kind === 'docker').length;
    const adrift = ports.filter((p) => p.adrift).length;
    this.set('docks', String(ports.length), [plural(ports.length, 'vessel') + ' in the harbor', busy ? `${busy} busy` : 'all quiet',
      adrift ? `${adrift} adrift` : '', ctr ? `${plural(ctr, 'container ship')}` : ''].filter(Boolean).join(' · '));

    let ctx = 0;
    for (const s of sessions) ctx += Number(s.context?.used) || 0;
    this.set('tokens', fmtTokens(ctx + agentCtx), `Context in use right now: bases ${fmtTokens(ctx)} + sub-agents ${fmtTokens(agentCtx)}`);

    const priced = sessions.filter((s) => s.cost && Number.isFinite(s.cost.usd));
    this.vals.cost.node.hidden = !priced.length;
    if (priced.length) {
      const usd = priced.reduce((m, s) => m + s.cost.usd, 0);
      const add = priced.reduce((m, s) => m + (s.cost.added || 0), 0), rem = priced.reduce((m, s) => m + (s.cost.removed || 0), 0);
      this.set('cost', fmtUsd(usd), `Estimated spend across ${plural(priced.length, 'base')} · +${add.toLocaleString('en-US')} / −${rem.toLocaleString('en-US')} lines`);
    }

    const cpu = snap.system?.cpu, mem = snap.system?.mem;
    this.cpu = cpu;
    this.set('cpu', Number.isFinite(cpu) ? fmtPct(cpu) : '–',
      `Machine load ${fmtPct(cpu)} · memory ${fmtPct(mem)} · the sea gets choppy with load; storms above 85%`);
    this.syncWeather();

    // demo badge
    const d = snap.demo;
    this.demo.hidden = !d;
    if (d) {
      const t = STATIC_SITE ? 'DEMO · GET IT ↗' : `DEMO${d.scene ? ' · ' + d.scene : ''}${d.speed && d.speed !== 1 ? ' ×' + d.speed : ''}`;
      setText(this.demo, t);
    }

    // needs-you pill
    const needs = sessions.filter((s) => s.state === 'needs_input').sort((a, b) => (a.stateSince || 0) - (b.stateSince || 0));
    this.pill.hidden = !needs.length;
    if (needs.length) {
      const s = needs[0];
      const html = `${EV_ICON.needs_input}<span class="np-t">NEEDS YOU:</span><b>${esc(trunc(s.name || 'a session', 30))}</b>` +
        (needs.length > 1 ? `<span class="np-more">+${needs.length - 1}</span>` : '');
      if (this.pill.__html !== html) { this.pill.__html = html; this.pill.innerHTML = html; }
      this.pill.setAttribute('data-tip', needs.map((x) => x.name).join(' · ') + ' — click to jump there');
    }
    return needs;
  }

  syncWeather() {
    const e = this.hud.engine;
    // the engine's own storm level too: a storm already raging before the HUD subscribed (or ?weather=storm) never
    // sends a 'weather' event
    const night = (e.daylight ?? 1) < 0.35, storm = !!this.hud.storm || (e.storm ?? 0) > 0.5;
    const key = `${Math.round((this.cpu || 0) * 20)}|${night}|${storm}`;
    if (key === this.wxKey) return;
    this.wxKey = key;
    this.cpuIconEl.innerHTML = weatherIcon(this.cpu || 0, night, storm);
  }

  status(s) {
    const [text, tip] = CONN[s] || [String(s || '').toUpperCase(), ''];
    this.conn.className = 'conn c-' + s;
    setText(this.conn.querySelector('span'), text);
    this.conn.setAttribute('data-tip', tip);
  }

  // blocked: on, but the browser will not speak until the page gets a click or a key press
  setVoice(on, blocked = false) {
    this.btnVoice.innerHTML = on ? ICON.voiceOn : ICON.voiceOff;
    this.btnVoice.classList.toggle('on', !!on);
    this.btnVoice.classList.toggle('blocked', !!on && !!blocked);
    const tip = on && blocked ? 'EVA voice: on, but the browser is holding it until you click anywhere' : `EVA voice: ${on ? 'on' : 'off'}`;
    this.btnVoice.setAttribute('data-tip', tip);
    this.btnVoice.setAttribute('aria-label', tip);
  }

  syncFullscreen() {
    const fs = !!document.fullscreenElement;
    this.btnFull.innerHTML = fs ? ICON.fullscreenExit : ICON.fullscreen;
    this.btnFull.setAttribute('data-tip', fs ? 'Exit fullscreen' : 'Fullscreen');
  }

  tickClock() {
    const d = new Date();
    const t = fmtClock(d);
    if (t !== this.clockText) {
      this.clockText = t;
      const [hm, ap] = t.split(/\s+/);
      this.clock.innerHTML = `<b>${esc(hm)}</b>${ap ? `<small>${esc(ap)}</small>` : ''}`;
      this.clock.setAttribute('data-tip', d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' }));
    }
    this.syncWeather();
  }
}
