// Smaller HUD pieces: cursor tooltip, toasts, the settings drawer (with the Field Manual), the help overlay,
// the empty-world card and the NEEDS YOU edge glow.
import { el, esc, prefs, ftext, fname, funit, fhq, FACTIONS, FACTION_BLURB } from './util.js';
import { ICON, EV_ICON, factionCrest, islandCrest, vesselCrest } from './icons.js';

// ---- tooltip ------------------------------------------------------------------------------------------------------

export class Tip {
  constructor() {
    this.el = el('div.hud-tip', { hidden: true, role: 'tooltip' });
    this.src = null;
    this.x = -999; this.y = -999;
    this.raf = 0;
    addEventListener('pointermove', (e) => {
      this.x = e.clientX; this.y = e.clientY;
      if (this.src && !this.raf) this.raf = requestAnimationFrame(() => { this.raf = 0; this.place(); });
    }, { passive: true, capture: true });
  }

  showFor(src, html, { text = true } = {}) {
    if (!html) { this.hideFor(src); return; }
    this.src = src;
    if (this.el.__c !== html) {
      this.el.__c = html;
      if (text) this.el.textContent = html; else this.el.innerHTML = html;
    }
    this.el.hidden = false;
    this.place();
  }

  hideFor(src) {
    if (src && this.src !== src) return;
    this.src = null;
    this.el.hidden = true;
  }

  place() {
    if (this.el.hidden) return;
    const w = this.el.offsetWidth, h = this.el.offsetHeight, pad = 8;
    let x = this.x + 16, y = this.y + 20;
    if (x + w > innerWidth - pad) x = Math.max(pad, this.x - w - 12);
    if (y + h > innerHeight - pad) y = Math.max(pad, this.y - h - 14);
    this.el.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
  }
}

// ---- toast ------------------------------------------------------------------------------------------------------------

export class Toast {
  constructor() {
    this.el = el('div.hud-toast', { hidden: true, 'aria-live': 'polite' });
    this.timer = 0;
  }

  show(html, secs = 1.8) {
    this.el.innerHTML = html;
    this.el.hidden = false;
    this.el.style.animationDuration = `${secs}s`;   // the fade in / hold / fade out keyframes stretch with it
    this.el.classList.remove('in');
    void this.el.offsetWidth;
    this.el.classList.add('in');
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.el.hidden = true; }, secs * 1000);
  }
}

// ---- field manual -------------------------------------------------------------------------------------------------------

function manualHtml() {
  const factions = FACTIONS.map((f) => `<div class="fm-fac"><span class="fm-crest">${factionCrest(f)}</span><div>` +
    `<b style="color:${ftext(f)}">${esc(fname(f))}</b><small>${esc(fhq(f))} · ${esc(funit(f))}s</small>` +
    `<p>${esc(FACTION_BLURB[f])}</p></div></div>`).join('');
  const row = (icon, title, text) => `<div class="fm-row"><span class="fm-i">${icon}</span><div><b>${title}</b><p>${text}</p></div></div>`;
  const chip = (t, cls) => `<b class="st ${cls}">${t}</b>`;
  return `
  <p class="fm-lead">Welcome, Commander. Every Claude Code session on this machine is a base on this map. Here is what you are looking at.</p>
  <h4>Islands are repos</h4>
  ${row(islandCrest({ kind: 'repo', tier: 3 }), 'Repo islands grow with the codebase', 'Outpost (&lt;150 files) → Settlement → Stronghold → Citadel (huge). The Git Tree has one big branch per git branch; the banner flies the current one. Over 1,500 commits? Legacy ruins.')}
  ${row(islandCrest({ kind: 'camp' }), 'Camps: no version control', 'Tents, a campfire and a sign that says HERE BE DRAGONS. Sometimes an actual sea serpent.')}
  ${row(islandCrest({ kind: 'sandbox' }), 'Sandbox atolls & the Homestead', 'Claude scratch workspaces get a sandcastle; your home folder gets a cozy cottage. Git worktrees are little islets over a rope bridge.')}
  ${row(islandCrest({ kind: 'town' }), 'Port Localhost', 'The harbor in the middle. Its lighthouse is this dashboard: the beam brightens while someone is watching.')}
  <h4>Factions = models</h4>
  <div class="fm-facs">${factions}</div>
  <h4>Bases = sessions</h4>
  ${row(ICON.hq, 'Add-ons show the tools a session uses', 'Unlocked at 3 uses, upgraded at 25 and 100: Forge (edits), Drill Rig (shell), Observatory (read &amp; search), Radar Array (web), Barracks (sub-agents), Warp Gate (MCP). The one in use animates.')}
  ${row(EV_ICON.compaction, 'Context silo &amp; summary bricks', 'The glass tank is the context window: cyan → green → yellow → orange → red. Past 80% it bulges and steams. A compaction is the hydraulic press (KA-CHUNK!), which leaves a glowing Summary Brick on the pile.')}
  ${row(EV_ICON.clear, '/clear = controlled demolition', 'Dynamite, debris, a dust cloud, then a fresh level-0 base rises from scaffolding. Same lot, new memories.')}
  ${row(EV_ICON.needs_input, 'The giant yellow “!”', `The session is waiting for YOU (a question, a plan to approve, a permission). When it starts, one big shockwave rolls across the sea from its island with a flash of light at the base; then a giant “!” hovers over the waiting base (it never shrinks below readable, even zoomed all the way out) until you answer. Most important thing on the map: the screen edge glows too, and the ${chip('Needs you', 'st-needs_input')} pill jumps you there.`)}
  ${row(EV_ICON.turn_done, 'Your move: the READY beacon', 'When a session finishes its turn and hands control back, a pillar of light shoots up from the base, shockwaves race across the sea and a YOUR MOVE banner pops (a calmer cyan WAITING ON n AGENTS if its sub-agents are still out). A green ✓ then hovers over the base, pulsing gently, until the session gets busy again, dozes off or closes.')}
  ${row(EV_ICON.agent_done, 'Sub-agent done', 'A cyan ring and a flash at the base’s door: a unit delivered its report.')}
  ${row(EV_ICON.asleep, 'Lunch, Zzz and cobwebs', `Idle bases send their commander to lunch at the picnic table (${chip('Lunch', 'st-idle')}). After a while they fall ${chip('Asleep', 'st-asleep')}: dark windows, drifting Zzz, a tiny moon; much later, cobwebs and tumbleweeds.`)}
  ${row(EV_ICON.agent_done, 'Veterancy', 'Gold chevrons on the banner pole count finished sub-agents. Generators behind a base are its child processes; they spin with CPU.')}
  <h4>Units = sub-agents</h4>
  ${row(ICON.supply, 'Hats and props tell the role', 'Scout (binoculars) · Architect (blueprints) · Inspector (clipboard &amp; magnifier) · YAGNI Inspector (axe) · Electrician (wire) · Etiquette Officer (monocle) · Painter (palette) · Tester (test tube) · Librarian (books on head) · Guard (shield) · Exterminator (bug spray) · Engineer (wrench).')}
  ${row(EV_ICON.agent_spawn, 'What they do shows the tool', 'Mining crystals = shell · hammering = editing · reading scrolls at the Archive = reading · metal detecting = searching · fishing = web · megaphone = briefing agents · old phone = MCP · clipboard = planning. Apprentices (small) are agents spawned by agents.')}
  ${row(EV_ICON.agent_failed, 'Endings', 'Done: a little victory spin and confetti, then back through the door. Failed: a slumped walk home under a tiny rain cloud. Lost: a poof of smoke.')}
  <h4>Boats = listening ports</h4>
  ${row(vesselCrest('node', '#5fa04e'), 'Every dev server is a boat', 'Docked at its repo island, or at Port Localhost when nobody owns it. Tugboat (Node/Bun/Deno), steamer (Python), elephant barge (PHP), container ship (Docker), tanker (databases), llama pedal boat (Ollama), yellow submarine (headless browsers).')}
  ${row(EV_ICON.port_open, 'Busy boats vs. rusty boats', 'Traffic sends stevedores hauling crates and puffs of smoke. Idle boats rust, list, collect seagulls and barnacles, and after half a day get a hand-painted “4 SALE” sign.')}
  <h4>Sky, launches and flags</h4>
  ${row(ICON.sun, 'Weather = machine load', 'Calm seas when the machine is idle, wind as the CPU climbs, a thunderstorm above ~85%. Day and night follow your clock.')}
  ${row(EV_ICON.commit, 'Commits launch rockets', 'Rockets (or fireworks on small islands) carry the commit message. Pulls parachute in supply crates. Switching branches lowers the banner and raises a new flag.')}
  ${row(EV_ICON.push, 'Pushes and merges', 'A push loads the commits onto a cargo airship bound for origin (a brand-new branch gets a maiden voyage). A merge fuses two branches at the Git Tree in a burst of light.')}
  <p class="fm-foot">Tip: click anything on the map for details. Press <kbd>?</kbd> for all the keys.</p>`;
}

// ---- settings drawer ---------------------------------------------------------------------------------------------------

const SEGS = {
  labels: [['all', 'All'], ['hover', 'Hover'], ['off', 'Off']],
  daynight: [['auto', 'Auto'], ['day', 'Day'], ['night', 'Night']],
  quality: [['high', 'High'], ['low', 'Low']],
  fps: [['60', '60'], ['30', '30'], ['20', '20']],
};
const HUD_SIZES = [[0.85, 'S'], [1, 'M'], [1.2, 'L'], [1.45, 'XL']];

export class Panels {
  constructor(hud) {
    this.hud = hud;
    const S = hud.engine.settings;

    // drawer
    const tab = (id, label, icon) => {
      const b = el('button.tab', { type: 'button', 'data-tab': id, html: `${icon}<span>${label}</span>` });
      b.addEventListener('click', () => this.setTab(id));
      return b;
    };
    const close = el('button.mini-btn', { type: 'button', 'data-tip': 'Close (Esc)', html: ICON.close });
    close.addEventListener('click', () => this.closeDrawer());
    const seg = (key, opts, label, hint) => {
      const wrap = el('div.seg', { 'data-key': key });
      for (const [v, t] of opts) {
        const b = el('button', { type: 'button', 'data-v': v, text: t });
        b.addEventListener('click', () => S.set(key, v));
        wrap.appendChild(b);
      }
      return el('div.set-row', null, el('div.set-l', null, el('b', { text: label }), el('small', { text: hint })), wrap);
    };
    const tog = (key, label, hint, extra) => {
      const b = el('button.tog', { type: 'button', 'data-key': key, 'aria-label': label }, el('i'));
      b.addEventListener('click', () => S.set(key, !S.get(key)));
      return el('div.set-row', null, el('div.set-l', null, el('b', { text: label }), el('small', { text: hint })), el('div.set-r', null, extra || null, b));
    };
    const test = el('button.pill-btn', { type: 'button', text: 'Test' });
    test.addEventListener('click', () => this.hud.eva.voice.say('Construction complete. EVA online, Commander.', 3, true));
    const size = el('div.seg', { 'data-key': 'hudsize' });
    for (const [v, t] of HUD_SIZES) {
      const b = el('button', { type: 'button', 'data-v': String(v), text: t });
      b.addEventListener('click', () => { prefs.set('size', v); this.hud.applyScale(); this.sync(); });
      size.appendChild(b);
    }
    this.setBody = el('section.tab-body', { 'data-tab': 'settings' },
      seg('labels', SEGS.labels, 'Labels', 'Name tags over bases, units and boats (L cycles)'),
      seg('daynight', SEGS.daynight, 'Day / night', 'Auto follows your clock'),
      tog('director', 'Director mode', 'When you look away for 45 s the camera tours the map and pans to big events'),
      tog('voice', 'EVA voice', 'Announcer reads the log aloud (low, slow, rate-limited)', test),
      seg('quality', SEGS.quality, 'Quality', 'Low = no shadows, lower resolution, 30 fps'),
      seg('fps', SEGS.fps, 'Frame rate', '30 is plenty for an always-on monitor; 60 is buttery'),
      tog('showIdle', 'Show sleeping bases', 'Turn off to hide asleep sessions (and islands left empty)'),
      tog('reduceMotion', 'Reduce motion', 'Calmer sea, instant camera moves, fewer pulses'),
      el('div.set-row', null, el('div.set-l', null, el('b', { text: 'HUD size' }), el('small', { text: 'Scales with the window; this nudges it (map labels too)' })), size),
      el('div.set-foot', { html: `Settings are saved in this browser. <span class="muted">Command &amp; Context · a localhost RTS for your Claude Code sessions.</span>` }),
    );
    this.manBody = el('section.tab-body.manual', { 'data-tab': 'manual', html: manualHtml() });
    this.tabs = el('div.tabs', null, tab('settings', 'Settings', ICON.gear), tab('manual', 'Field manual', ICON.book));
    this.drawer = el('div.drawer.panel', { hidden: true },
      el('div.panel-head', null, this.tabs, el('span.ph-sp'), close),
      el('div.drawer-scroll', null, this.setBody, this.manBody));
    this.setTab('settings');

    // help overlay
    const key = (k, t) => `<div class="k-row"><span class="keys">${[].concat(k).map((x) => `<kbd>${esc(x)}</kbd>`).join('')}</span><span>${t}</span></div>`;
    const helpClose = el('button.mini-btn', { type: 'button', 'data-tip': 'Close (Esc)', html: ICON.close });
    helpClose.addEventListener('click', () => this.closeHelp());
    this.help = el('div.help-wrap', { hidden: true },
      el('div.help.panel', null,
        el('div.panel-head', null, el('span.ph-icon', { html: ICON.keys }), el('span.ph-t', { text: 'Controls' }), el('span.ph-sp'), helpClose),
        el('div.help-body', { html:
          `<div class="k-col"><h5>Camera</h5>` +
          key('Drag', 'Pan the map') + key('Wheel', 'Zoom toward the cursor') + key(['←', '↑', '→', '↓'], 'Pan') + key(['+', '−'], 'Zoom in / out') +
          key(['Q', 'E'], 'Rotate 90°') + key('F', 'Fit everything') + key('Click minimap', 'Jump the camera there') + `</div>` +
          `<div class="k-col"><h5>Command</h5>` +
          key('Click', 'Select a base, unit, boat or island') + key('Esc', 'Deselect / close panels') + key('Space', 'Jump to the latest event (again: older)') +
          key('H', 'Hide / show the HUD') + key('L', 'Labels: all → hover → off') + key(['D', 'D'], 'Demo world on / off (press twice)') + key('?', 'This screen') + `</div>` +
          `<p class="help-foot">Pro tip: click a unit five times. It gets grumpy.</p>` })));
    this.help.addEventListener('click', (e) => { if (e.target === this.help) this.closeHelp(); });

    // empty world
    this.empty = el('div.empty-card.panel', { hidden: true });
    this.empty.addEventListener('click', (e) => {
      if (e.target.closest('[data-act="show-idle"]')) { e.preventDefault(); S.set('showIdle', true); }
    });

    // attention glow
    this.attn = el('div.hud-attn', { hidden: true });

    S.on('*', () => this.sync());
    this.sync();
  }

  // mode: null (hide) | 'none' (no sessions at all) | 'asleep' (only sleeping ones, and those are hidden)
  setEmpty(mode, demo, count = 0) {
    this.empty.hidden = !mode;
    if (!mode) return;
    const key = `${mode}|${demo}|${count}`;
    if (this.empty.__k === key) return;
    this.empty.__k = key;
    this.empty.innerHTML = mode === 'asleep'
      ? `<div class="ec-art">${EV_ICON.asleep}</div><h3>Everybody is asleep</h3>` +
        `<p>${count === 1 ? 'One base is' : `${count} bases are`} napping, and sleeping bases are hidden. Shh.</p>` +
        `<button type="button" class="pill-btn gold" data-act="show-idle">Show sleeping bases</button>`
      : `<div class="ec-art">${islandCrest({ kind: 'town' })}</div><h3>No active Claude Code sessions</h3>` +
        `<p>Start one and a base will be built here. The harbor is quiet. Too quiet.</p>` +
        `<a class="pill-btn gold" href="?demo">${demo ? 'Back to the busy demo →' : 'Try the demo world →'}</a>`;
  }

  setTab(id) {
    this.tab = id;
    for (const b of this.tabs.children) b.classList.toggle('on', b.getAttribute('data-tab') === id);
    this.setBody.hidden = id !== 'settings';
    this.manBody.hidden = id !== 'manual';
    this.drawer.querySelector('.drawer-scroll').scrollTop = 0;
  }

  toggleSettings(tab = 'settings') {
    if (!this.drawer.hidden && this.tab === tab) { this.closeDrawer(); return; }
    this.setTab(tab);
    this.drawer.hidden = false;
    this.drawer.classList.remove('in');
    void this.drawer.offsetWidth;
    this.drawer.classList.add('in');
    this.hud.root.classList.add('drawer-open');
    this.sync();
  }

  closeDrawer() {
    this.drawer.hidden = true;
    this.hud.root.classList.remove('drawer-open');
  }

  toggleHelp(on = this.help.hidden) {
    this.help.hidden = !on;
    if (on) { this.help.classList.remove('in'); void this.help.offsetWidth; this.help.classList.add('in'); }
  }

  closeHelp() { this.help.hidden = true; }

  // Esc: close the topmost overlay. Returns true when something was closed.
  closeTop() {
    if (!this.help.hidden) { this.closeHelp(); return true; }
    if (!this.drawer.hidden) { this.closeDrawer(); return true; }
    return false;
  }

  sync() {
    const S = this.hud.engine.settings;
    for (const w of this.drawer.querySelectorAll('.seg[data-key]')) {
      const k = w.getAttribute('data-key');
      const v = k === 'hudsize' ? String(prefs.get('size', 1)) : String(S.get(k));
      for (const b of w.children) b.classList.toggle('on', b.getAttribute('data-v') === v);
    }
    for (const b of this.drawer.querySelectorAll('.tog[data-key]')) {
      const on = !!S.get(b.getAttribute('data-key'));
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    }
  }
}
