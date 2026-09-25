// Shared HUD helpers: formatting, faction/role/vessel vocabulary, tiny DOM helpers.
// Pure functions only (no engine state), so every HUD module can import them freely.
import { fmtTokens, fmtAgo, factionPal, cssHex, PAL, clamp, tint } from '../world/kit.js';
import { esc, trunc, stateChip, ctxColor, STATE_TEXT } from '../world/labels.js';

export { fmtTokens, fmtAgo, factionPal, cssHex, PAL, clamp, esc, trunc, stateChip, ctxColor, STATE_TEXT };

// ---- DOM ------------------------------------------------------------------------------------------------------

// el('div.a.b', { attrs }, children...) -> HTMLElement. Children may be strings (text) or nodes.
export function el(spec, attrs = null, ...kids) {
  const [tag, ...cls] = spec.split('.');
  const e = document.createElement(tag || 'div');
  if (cls.length) e.className = cls.join(' ');
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'html') e.innerHTML = v;
      else if (k === 'text') e.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const k of kids) if (k != null) e.append(k);
  return e;
}

// Set text only when it changed (avoids layout churn on 1 Hz updates).
export function setText(node, text) {
  const t = String(text ?? '');
  if (node && node.textContent !== t) node.textContent = t;
}

export function setHtml(node, html) {
  if (node && node.__html !== html) { node.__html = html; node.innerHTML = html; }
}

// Tiny persisted HUD-only preferences (engine.settings owns the shared ones).
const PREFS_KEY = 'cnc.hud';
export const prefs = (() => {
  let v = {};
  try { v = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}'); } catch { /* storage blocked or corrupt */ }
  if (!v || typeof v !== 'object' || Array.isArray(v)) v = {};   // corrupt prefs (a string, a number, null, an array)
  return {
    get: (k, d) => (k in v ? v[k] : d),
    set(k, x) { v[k] = x; try { localStorage.setItem(PREFS_KEY, JSON.stringify(v)); } catch { /* ignore */ } },
  };
})();

// ---- numbers & time ---------------------------------------------------------------------------------------------

export function fmtUsd(n) {
  if (!Number.isFinite(n)) return '–';
  if (n >= 10000) return '$' + (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  if (n >= 1000) return '$' + Math.round(n).toLocaleString('en-US');
  return '$' + n.toFixed(2);
}

export const fmtPct = (x) => (Number.isFinite(x) ? Math.round(x * 100) + '%' : '–');
export const fmtInt = (n) => (Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '–');

// Long-form duration: "2h 14m", "3m 05s", "42s".
export function fmtDur(ms) {
  if (!Number.isFinite(ms)) return '–';
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${String(m % 60).padStart(2, '0')}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function fmtClock(d = new Date()) {
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

// ---- factions -------------------------------------------------------------------------------------------------

export const FACTIONS = ['opus', 'sonnet', 'haiku', 'fable', 'merc'];
export const fpal = (f) => factionPal(f);
export const fcol = (f, k = 'main') => cssHex(factionPal(f)[k]);
// Faction color lightened enough to read as text on the navy panels.
export const ftext = (f) => cssHex(tint(factionPal(f).main, 0.42));
export const fname = (f) => factionPal(f).name;
export const funit = (f) => factionPal(f).unit;
export const fhq = (f) => factionPal(f).hq;

export const FACTION_BLURB = {
  opus: 'Stately, thorough, expensive-looking. Magisters waddle, ponder at length and carry a tome.',
  sonnet: 'Blue-collar and reliable. Engineers in hard hats who clock in, fix it, and clock out.',
  haiku: 'Small, fast and numerous. Sprites hop everywhere and speak only in 5-7-5.',
  fable: 'Crooked towers and floating pages. Scribes drift about trailing sparkles and plot twists.',
  merc: 'Any model that is not Claude. Boxy drones in a rented hangar. They bill elsewhere.',
};

// ---- roles (DESIGN §8; mirrors units.js so the HUD never depends on a module that might be mid-edit) --------------

const ROLE_RULES = [
  [/explore|scout|recon|search|find/i, 'scout'],
  [/plan|architect/i, 'architect'],
  [/review-yagni|yagni/i, 'yagni'],
  [/wiring|runtime/i, 'electrician'],
  [/convention|style|lint/i, 'etiquette'],
  [/fidelity|design|(^|[^a-z])ui([^a-z]|$)|frontend/i, 'painter'],
  [/skeptic|review|audit|inspect|verify|qa/i, 'inspector'],
  [/test/i, 'tester'],
  [/guide|doc|librar|writer/i, 'librarian'],
  [/security|guard/i, 'guard'],
  [/debug|fix|bug/i, 'exterminator'],
  [/statusline|paint/i, 'painter'],
];

export const ROLE_NAMES = {
  engineer: 'Engineer', scout: 'Scout', architect: 'Architect', yagni: 'YAGNI Inspector', electrician: 'Electrician',
  etiquette: 'Etiquette Officer', painter: 'Painter', inspector: 'Inspector', tester: 'Tester', librarian: 'Librarian',
  guard: 'Guard', exterminator: 'Exterminator', commander: 'Commander',
};

export const ROLE_PROPS = {
  engineer: 'wrench', scout: 'binoculars', architect: 'blueprint roll', yagni: 'axe', electrician: 'coil of wire + multimeter',
  etiquette: 'monocle + rulebook', painter: 'palette + brush', inspector: 'clipboard + magnifier', tester: 'test tube',
  librarian: 'stack of books (on head)', guard: 'shield', exterminator: 'bug-spray canister',
};

export function roleOf(type) {
  const t = String(type || '');
  for (const [re, role] of ROLE_RULES) if (re.test(t)) return role;
  return 'engineer';
}
export const roleName = (type) => ROLE_NAMES[roleOf(type)] || 'Engineer';

// ---- tools & states --------------------------------------------------------------------------------------------

export const TOOL_VERB = {
  edit: 'editing', bash: 'running', read: 'reading', search: 'searching', web: 'browsing', agent: 'briefing',
  mcp: 'calling', plan: 'planning', skill: 'using skill', other: 'using',
};

export const TOOL_CAT_NAME = {
  edit: 'Forge', bash: 'Drill Rig', read: 'Observatory', search: 'Observatory', web: 'Radar Array', agent: 'Barracks',
  mcp: 'Warp Gate', plan: 'Clipboard', skill: 'Manual', other: 'Misc',
};

// "editing CheckoutForm.vue" / "thinking…" / "on lunch break" for a session or agent record.
export function doingText(x) {
  if (!x) return '';
  const t = x.tool;
  if (t && (x.state === 'working' || x.state === 'waiting' || x.state === 'needs_input' || x.state === 'stalled')) {
    const what = t.detail || t.name || '';
    if (x.state === 'needs_input') return what ? `asks: ${what}` : 'needs your input';
    return `${TOOL_VERB[t.cat] || 'using'} ${what}`.trim();
  }
  return {
    thinking: 'thinking…', waiting: 'waiting…', needs_input: 'needs your input', idle: 'on lunch break', asleep: 'asleep',
    ended: 'closed', stalled: 'stalled', done: 'mission accomplished', failed: 'mission failed', lost: 'lost in action',
  }[x.state] || x.state || '';
}

const THINK = {
  opus: 'Pondering at length…', sonnet: 'Crunching the numbers…', haiku: 'Counting syllables…', fable: 'Plotting the next chapter…',
  merc: 'Processing. Please hold.',
};
const LUNCH = {
  opus: 'Tea party at the picnic table (cake included)', sonnet: 'Lunch pail on a steel I-beam, feet dangling',
  haiku: 'Onigiri circle by the blossom tree', fable: 'Toasting marshmallows over a tiny campfire', merc: 'Sipping a can of oil',
};

// The card's "what's happening" line: the tool when there is one, otherwise something with a bit of character.
export function flavorText(x, faction, now) {
  if (!x) return '';
  const f = faction || x.faction || 'merc';
  if (x.tool && (x.state === 'working' || x.state === 'waiting' || x.state === 'needs_input' || x.state === 'stalled')) return doingText(x);
  switch (x.state) {
    case 'thinking': return THINK[f] || 'Thinking…';
    case 'idle': return LUNCH[f] || 'On lunch break';
    case 'asleep': return `Zzz… no activity for ${fmtAgo(now - (x.lastActivity || now))}`;
    case 'waiting': return 'Tapping foot, checking wristwatch…';
    case 'stalled': return `Stalled: nothing for ${fmtAgo(now - (x.lastActivity || now))}`;
    case 'ended': return 'Closed. The CLOSED sign is up.';
    case 'done': return 'Mission accomplished. Report delivered.';
    case 'failed': return 'Mission failed. Walking home under a rain cloud.';
    case 'lost': return 'Lost in action. A poof of smoke.';
    case 'needs_input': return 'Waiting for your orders, Commander!';
    default: return doingText(x);
  }
}

// What the unit is physically doing on the map (DESIGN §8 actions), so the card explains the animation.
export const MAP_ACTION = {
  bash: 'Mining token crystals with a pickaxe', edit: 'Hammering away at a scaffold (sparks!)', read: 'Reading a scroll at the Archive',
  search: 'Sweeping the island with a metal detector', web: 'Fishing off the shore', agent: 'Shouting orders through a megaphone',
  mcp: 'Talking into a chunky old phone', plan: 'Scribbling on a clipboard', skill: 'Studying a glowing manual', other: 'Tinkering',
};
export function mapAction(x) {
  if (!x) return '';
  if (x.tool && (x.state === 'working' || x.state === 'waiting')) return MAP_ACTION[x.tool.cat] || MAP_ACTION.other;
  return {
    thinking: 'Standing still, a thought bubble of spinning gears', waiting: 'Leaning on something, checking the wristwatch',
    stalled: 'Leaning, tapping a foot, hourglass overhead', needs_input: 'On the roof, waving both arms at you',
    idle: 'At the picnic table', asleep: 'Dozing, with drifting Zzz', done: 'Victory spin, then back through the door',
    failed: 'Trudging home under a tiny rain cloud', lost: 'Vanished in a poof of smoke',
  }[x.state] || '';
}

export const STATE_LONG = {
  working: 'Working', thinking: 'Thinking', waiting: 'Waiting', needs_input: 'Needs you', idle: 'Lunch break',
  asleep: 'Asleep', ended: 'Closed', stalled: 'Stalled', done: 'Done', failed: 'Failed', lost: 'Lost',
};

export const TERMINAL = new Set(['done', 'failed', 'lost']);
export const RUNNING = (a) => a && !TERMINAL.has(a.state);

export const ENTRY_NAME = {
  'claude-desktop': 'Desktop app', cli: 'Terminal (CLI)', 'sdk-ts': 'Agent SDK (TS)', 'sdk-py': 'Agent SDK (Py)',
  'claude-vscode': 'VS Code', 'claude-jetbrains': 'JetBrains', 'claude-code-web': 'Web', 'github-action': 'GitHub Action',
};
export const entryName = (e) => ENTRY_NAME[e] || (e ? String(e) : 'unknown');

export const PERM_NAME = {
  default: 'Ask first', acceptEdits: 'Accept edits', bypassPermissions: 'YOLO (bypass)', plan: 'Plan mode', auto: 'Auto',
  dontAsk: "Don't ask",
};
export const permName = (p) => (p ? PERM_NAME[p] || p : 'Default');

// ---- islands & vessels -------------------------------------------------------------------------------------------

export const TIER_NAME = ['Outpost', 'Outpost', 'Settlement', 'Stronghold', 'Citadel'];

export function islandTitle(d) {
  if (!d) return '';
  if (d.kind === 'camp') return 'Base camp';
  if (d.kind === 'sandbox') return 'Sandbox atoll';
  if (d.kind === 'home') return 'Homestead';
  if (d.kind === 'town') return 'Harbor town';
  return TIER_NAME[d.tier] || 'Outpost';
}

export function islandBlurb(d) {
  if (!d) return '';
  if (d.kind === 'camp') return 'HERE BE DRAGONS — no version control.';
  if (d.kind === 'sandbox') return 'A Claude scratch workspace. Sandcastles only.';
  if (d.kind === 'home') return 'Your home directory. Mind the dotfiles.';
  const c = d.git?.commits || 0;
  const bits = [];
  if (d.tier >= 4) bits.push('Walls, spires and a spaceport.');
  else if (d.tier === 3) bits.push('Turrets, pylons and silos.');
  else if (d.tier === 2) bits.push('Fences, lamp posts, a small library.');
  else bits.push('A few trees and one crystal cluster.');
  if (c > 1500) bits.push('Legacy ruins detected.');
  return bits.join(' ');
}

export const VESSEL = {
  node: 'Tugboat', bun: 'Tugboat', deno: 'Tugboat', python: 'Steamer', php: 'Elephant barge', ruby: 'Sloop',
  java: 'Freighter', go: 'Speedboat', dotnet: 'Ferry', web: 'Cutter', ai: 'Llama pedal boat', docker: 'Container ship',
  db: 'Tanker barge', browser: 'Yellow submarine', lighthouse: 'Lighthouse', claude: 'Dinghy', app: 'Dinghy', system: 'Dinghy',
};
export const vesselName = (k) => VESSEL[k] || 'Dinghy';

export const HULL = {
  node: '#5fa04e', bun: '#f3e2c0', deno: '#3a3a3a', python: '#3776ab', php: '#7a86b8', ruby: '#cc342d', java: '#c76f26',
  go: '#00add8', dotnet: '#7b44d1', web: '#2f9e5b', ai: '#f2f2f2', docker: '#2566c9', db: '#6b7690', browser: '#ffd23f',
  lighthouse: '#ff5a4d',
};
export const hullColor = (k) => HULL[k] || '#b8c2d1';

// Wear from time since last activity (0 fresh .. 1 "4 SALE"), as harbor.js paints it.
export function wearOf(idleMs) {
  const h = idleMs / 3600000;
  if (idleMs < 5 * 60000) return { k: 0, text: 'Fresh paint' };
  if (h < 1) return { k: 0.2, text: 'Weathered' };
  if (h < 4) return { k: 0.45, text: 'Rusty' };
  if (h < 12) return { k: 0.75, text: 'Barnacled' };
  return { k: 1, text: '4 SALE' };
}

export const portText = (p) => (p?.ports?.length > 1 ? p.ports.map((x) => ':' + x).join(' ') : p?.port != null ? ':' + p.port : '');

// ---- misc ------------------------------------------------------------------------------------------------------------

export const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
export const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
export const shortPath = (p, n = 48) => {
  const s = String(p || '');
  if (s.length <= n) return s;
  const parts = s.split(/[\\/]/);
  let out = parts.pop();
  while (parts.length && out.length + parts[parts.length - 1].length + 1 < n - 2) out = parts.pop() + '\\' + out;
  return '…\\' + out;
};

// Look up the last few things by id quickly: an index over a snapshot.
export function indexSnapshot(snap) {
  const sessions = new Map(), agents = new Map(), ports = new Map(), islands = new Map();
  for (const s of snap?.sessions || []) {
    sessions.set(s.key, s);
    for (const a of s.agents || []) agents.set(a.id, { agent: a, session: s });
  }
  for (const p of snap?.ports || []) ports.set(p.id, p);
  for (const i of snap?.islands || []) islands.set(i.id, i);
  return { sessions, agents, ports, islands };
}
