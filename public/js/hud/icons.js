// Inline SVG icon set for the HUD: chunky cartoon glyphs with a dark ink outline (paint-order: stroke), drawn on a
// 32×32 grid. Everything is a string so it can be dropped into innerHTML templates.
import { factionPal, cssHex } from '../world/kit.js';

const INK = '#0b1026';
const O = `stroke="${INK}" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round" paint-order="stroke"`;
const svg = (body, cls = 'ico', vb = '0 0 32 32') => `<svg class="${cls}" viewBox="${vb}" aria-hidden="true">${body}</svg>`;
// Two-pass stroke: dark ink under a colored line (for line-art glyphs).
const line = (d, color, w = 2.6, extra = '') =>
  `<path d="${d}" fill="none" stroke="${INK}" stroke-width="${w + 2.6}" stroke-linecap="round" stroke-linejoin="round" ${extra}/>` +
  `<path d="${d}" fill="none" stroke="${color}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" ${extra}/>`;

function gearPath(cx, cy, ro, ri, n) {
  const step = (Math.PI * 2) / n, pts = [];
  for (let i = 0; i < n; i++) {
    const a = i * step - Math.PI / 2;
    for (const [r, k] of [[ri, -0.3], [ro, -0.17], [ro, 0.17], [ri, 0.3]]) {
      pts.push(`${(cx + Math.cos(a + k * step) * r).toFixed(2)} ${(cy + Math.sin(a + k * step) * r).toFixed(2)}`);
    }
  }
  return 'M' + pts.join('L') + 'Z';
}

const GEAR = gearPath(16, 16, 13, 9.6, 8);
const cloudD = (x = 0, y = 0, s = 1) => {
  const p = (a, b) => `${(x + a * s).toFixed(2)} ${(y + b * s).toFixed(2)}`;
  return `M${p(8.5, 25)}h${(15 * s).toFixed(2)}A${(5.4 * s).toFixed(2)} ${(5.4 * s).toFixed(2)} 0 0 0 ${p(24.2, 14.3)}` +
    `A${(7.4 * s).toFixed(2)} ${(7.4 * s).toFixed(2)} 0 0 0 ${p(10.2, 13.2)}A${(5.9 * s).toFixed(2)} ${(5.9 * s).toFixed(2)} 0 0 0 ${p(8.5, 25)}Z`;
};

function sunBody(cx = 16, cy = 16, r = 6.4, color = '#ffd23f') {
  let rays = '';
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4, c = Math.cos(a), s = Math.sin(a);
    rays += `M${(cx + c * (r + 3)).toFixed(2)} ${(cy + s * (r + 3)).toFixed(2)}L${(cx + c * (r + 6.2)).toFixed(2)} ${(cy + s * (r + 6.2)).toFixed(2)}`;
  }
  return line(rays, color, 2.4) + `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${color}" ${O}/>`;
}
const MOON = `<path d="M20.5 4.5A11.5 11.5 0 1 0 27.8 22 9.4 9.4 0 0 1 20.5 4.5z" fill="#e3ebff" ${O}/>`;
const BOLT = `<path d="M17.5 17.5 12 26.2h4.2l-2.2 5.3 7.4-9.4h-4.3l2.6-4.6z" fill="#ffd23f" ${O}/>`;

// ---- plain icons ---------------------------------------------------------------------------------------------------

export const ICON = {
  hq: svg(
    line('M16 15V4.6', '#dfe9ff', 1.4) +
    `<path d="M16 4.6h7.2l-2.3 2.6 2.3 2.6H16z" fill="#ffc53d" ${O}/>` +
    `<path d="M4.5 29V15.5H9V12h4.5v3.5h5V12H23v3.5h4.5V29z" fill="#9aa8ff" ${O}/>` +
    `<path d="M13 29v-5.4a3 3 0 0 1 6 0V29z" fill="#28306e"/>` +
    `<path d="M7.4 19h3v3h-3zM21.6 19h3v3h-3z" fill="#ffe38a"/>`),
  supply: svg(
    `<path d="M5.5 29c0-5.4 4.6-8.4 10.5-8.4s10.5 3 10.5 8.4z" fill="#2fb7d8" ${O}/>` +
    `<circle cx="16" cy="13.5" r="8.4" fill="#bdf6ff" ${O}/>` +
    `<path d="M7.4 12.6a8.6 8.6 0 0 1 17.2 0z" fill="#ffc53d" ${O}/>` +
    `<circle cx="12.9" cy="16.4" r="1.45" fill="${INK}"/><circle cx="19.1" cy="16.4" r="1.45" fill="${INK}"/>`),
  anchor: svg(
    line('M16 9.6v18.2M10.4 14h11.2M5.6 19.6c.5 5.4 5 8.4 10.4 8.4s9.9-3 10.4-8.4', '#dfe9ff', 2.5) +
    line('M16 3.8a2.8 2.8 0 1 1 0 5.6a2.8 2.8 0 1 1 0-5.6', '#dfe9ff', 2.3) +
    `<path d="M2.8 21.6l2.6-4.3 3.7 3.4zM29.2 21.6l-2.6-4.3-3.7 3.4z" fill="#dfe9ff" ${O}/>`),
  crystal: svg(
    `<path d="M16 2.5 27.5 12 16 29.5 4.5 12z" fill="#39e5ff" ${O}/>` +
    `<path d="M16 2.5 27.5 12 16 15.6 4.5 12z" fill="#c9faff"/>` +
    `<path d="M16 15.6 27.5 12 16 29.5z" fill="#1fa6c9"/>` +
    `<path d="M16 2.5 27.5 12 16 29.5 4.5 12z" fill="none" stroke="${INK}" stroke-width="2.2" stroke-linejoin="round"/>`),
  coin: svg(
    `<circle cx="16" cy="16" r="12.3" fill="#ffc53d" ${O}/>` +
    `<circle cx="16" cy="16" r="8.8" fill="#ffd96b" stroke="#c98a12" stroke-width="1.4"/>` +
    `<path d="M19.3 12.4c-.8-1-2-1.5-3.3-1.5-1.8 0-3.1.9-3.1 2.3 0 3.2 6.6 1.8 6.6 5.2 0 1.5-1.4 2.5-3.4 2.5-1.5 0-2.8-.6-3.6-1.6M16 9v14" fill="none" stroke="#8a5a00" stroke-width="2" stroke-linecap="round"/>`),
  gear: svg(`<path d="${GEAR}" fill="#dfe9ff" ${O}/><circle cx="16" cy="16" r="4.2" fill="#28306e" ${O}/>`),
  voiceOn: svg(
    `<path d="M4.5 12.5h5l6.6-5.6v18.2l-6.6-5.6h-5z" fill="#dfe9ff" ${O}/>` +
    line('M20.4 11.8a6 6 0 0 1 0 8.4M23.8 8.4a10.6 10.6 0 0 1 0 15.2', '#39e5ff', 2.3)),
  voiceOff: svg(
    `<path d="M4.5 12.5h5l6.6-5.6v18.2l-6.6-5.6h-5z" fill="#8a94b8" ${O}/>` +
    line('M20.6 12.4l7 7.2M27.6 12.4l-7 7.2', '#ff6b6b', 2.4)),
  fullscreen: svg(line('M5 11.5V5h6.5M20.5 5H27v6.5M27 20.5V27h-6.5M11.5 27H5v-6.5', '#dfe9ff', 2.6)),
  fullscreenExit: svg(line('M11.5 5v6.5H5M27 11.5h-6.5V5M20.5 27v-6.5H27M5 20.5h6.5V27', '#dfe9ff', 2.6)),
  help: svg(
    `<circle cx="16" cy="16" r="12.4" fill="#39e5ff" ${O}/>` +
    `<path d="M12 12.4a4 4 0 1 1 5.8 3.6c-1.2.6-1.8 1.5-1.8 2.8v.8" fill="none" stroke="${INK}" stroke-width="3" stroke-linecap="round"/>` +
    `<circle cx="16" cy="23.6" r="1.9" fill="${INK}"/>`),
  close: svg(line('M9.5 9.5l13 13M22.5 9.5l-13 13', '#dfe9ff', 2.8)),
  minus: svg(line('M8.5 16h15', '#dfe9ff', 2.8)),
  plus: svg(line('M16 8.5v15M8.5 16h15', '#dfe9ff', 2.8)),
  target: svg(line('M16 6.5a9.5 9.5 0 1 1 0 19a9.5 9.5 0 1 1 0-19M16 2.5v6M16 23.5v6M2.5 16h6M23.5 16h6', '#dfe9ff', 2.2) +
    `<circle cx="16" cy="16" r="2.6" fill="#39e5ff" ${O}/>`),
  map: svg(`<path d="M4 8l7-3 10 3 7-3v19l-7 3-10-3-7 3z" fill="#86d34f" ${O}/>` +
    `<path d="M11 5v19M21 8v19" stroke="${INK}" stroke-width="1.6" fill="none"/>` +
    `<path d="M13.5 13.5l5 5M18.5 13.5l-5 5" stroke="#ff4d4d" stroke-width="2.2" stroke-linecap="round"/>`),
  book: svg(`<path d="M4 7c4-2 8-2 12 1 4-3 8-3 12-1v19c-4-2-8-2-12 1-4-3-8-3-12-1z" fill="#ffe38a" ${O}/>` +
    `<path d="M16 8v19" stroke="${INK}" stroke-width="1.8"/>` +
    `<path d="M7 11.5c2.4-.8 4.6-.6 6.4.4M7 15.5c2.4-.8 4.6-.6 6.4.4M18.6 11.9c1.8-1 4-1.2 6.4-.4M18.6 15.9c1.8-1 4-1.2 6.4-.4" stroke="#b7801a" stroke-width="1.4" fill="none" stroke-linecap="round"/>`),
  keys: svg(`<rect x="3" y="8" width="26" height="17" rx="3.5" fill="#dfe9ff" ${O}/>` +
    `<path d="M7.5 12.5h2M12 12.5h2M16.5 12.5h2M21 12.5h3.5M7.5 16.5h2M12 16.5h2M16.5 16.5h2M21 16.5h3.5M10 20.5h12" stroke="${INK}" stroke-width="2" stroke-linecap="round"/>`),
  sun: svg(sunBody()),
  moon: svg(MOON),
};

// Weather icon for the CPU counter: sun/moon when calm, clouds as load rises, a thunderstorm when stormy.
export function weatherIcon(cpu, night, storm) {
  const c = Number.isFinite(cpu) ? cpu : 0;
  if (storm || c >= 0.85) return svg(`<path d="${cloudD(0, -2)}" fill="#8e9ab8" ${O}/>` + BOLT, 'ico wx storm');
  if (c >= 0.6) return svg(line('M3 27.5h9M6 30.5h11', '#bfe9ff', 1.8) + `<path d="${cloudD(0, -1)}" fill="#dfe6f5" ${O}/>`, 'ico wx windy');
  const orb = night ? `<g transform="translate(-4 -3) scale(.8)">${MOON}</g>` : `<g transform="translate(-3.4 -3.2) scale(.78)">${sunBody()}</g>`;
  if (c >= 0.3) return svg(orb + `<path d="${cloudD(2.5, 3.2, 0.88)}" fill="#f4f7ff" ${O}/>`, 'ico wx partly');
  return svg(night ? MOON : sunBody(), 'ico wx clear');
}

// ---- event glyphs (EVA log) ----------------------------------------------------------------------------------------

const badge = (color, glyph) => `<circle cx="24.5" cy="24.5" r="6.2" fill="${color}" ${O}/>` + glyph;
const BOAT = (hull = '#ff8a1f') =>
  `<path d="M3.5 18.5h25l-3.8 7.4H8z" fill="${hull}" ${O}/>` +
  `<path d="M9.5 18.5v-5h10v5z" fill="#f2f6ff" ${O}/>` +
  `<path d="M12.6 13.5V8.4h3.2v5.1z" fill="#39e5ff" ${O}/>`;

export const EV_ICON = {
  session_start: svg(ICON.hq.replace(/^<svg[^>]*>|<\/svg>$/g, '') + badge('#3ddc84', line('M24.5 21.5v6M21.5 24.5h6', '#fff', 1.6))),
  session_end: svg(`<g opacity=".75">${ICON.hq.replace(/^<svg[^>]*>|<\/svg>$/g, '')}</g>` + badge('#8a94a6', line('M22.4 22.4l4.2 4.2M26.6 22.4l-4.2 4.2', '#fff', 1.5))),
  clear: svg(
    `<rect x="6" y="12" width="6" height="16" rx="2.4" fill="#e0453a" ${O}/><rect x="13" y="12" width="6" height="16" rx="2.4" fill="#ff5a4d" ${O}/>` +
    `<rect x="20" y="12" width="6" height="16" rx="2.4" fill="#e0453a" ${O}/><path d="M5.5 19h21v3h-21z" fill="#3a2a1a"/>` +
    line('M16 12c0-3 2-4.6 4.6-5.2', '#c9a27a', 1.6) + `<path d="M22.5 2.5l1 2.6 2.7.4-2 1.8.6 2.7-2.3-1.4-2.4 1.4.6-2.7-2-1.8 2.7-.4z" fill="#ffd23f" ${O}/>`),
  compaction: svg(
    `<path d="M14 1.5h4v4h-4z" fill="#8a94a6" ${O}/><path d="M5 5.5h22v6H5z" fill="#b8c2d1" ${O}/>` +
    `<path d="M5 9h22v2.5H5z" fill="#ffc53d"/>` + line('M16 14.5v5', '#ffd23f', 2.2) +
    `<path d="M12.5 18.5 16 22l3.5-3.5z" fill="#ffd23f" ${O}/>` +
    `<path d="M8 23.5h16v6H8z" fill="#39e5ff" ${O}/><path d="M8 23.5h16v2H8z" fill="#c9faff"/>`),
  context_high: svg(
    `<path d="M16 3.5 29 27.5H3z" fill="#ff8a1f" ${O}/>` +
    `<path d="M16 11v8.5" stroke="${INK}" stroke-width="3.4" stroke-linecap="round"/><circle cx="16" cy="23.4" r="1.9" fill="${INK}"/>`),
  agent_spawn: svg(ICON.supply.replace(/^<svg[^>]*>|<\/svg>$/g, '') + badge('#39e5ff', line('M24.5 21.5v6M21.5 24.5h6', '#0b1026', 1.4))),
  agent_done: svg(`<circle cx="16" cy="16" r="12.4" fill="#2fcf78" ${O}/>` + line('M10 16.6l4.2 4.2 8-9', '#fff', 3)),
  agent_failed: svg(`<path d="${cloudD(0, -4)}" fill="#aab4cc" ${O}/>` +
    `<path d="M10 24.5l-1.6 4M16 24.5l-1.6 4M22 24.5l-1.6 4" stroke="#39a0ff" stroke-width="2.4" stroke-linecap="round"/>`),
  // "your move": a green check badge under a pillar of light, with a spark
  turn_done: svg(`<path d="M12.6 1.5h6.8l1.9 15h-10.6z" fill="#c9ffe0" opacity=".9"/>` +
    `<circle cx="16" cy="19.5" r="10.4" fill="#3ddc84" ${O}/>` + line('M11.2 19.8l3.4 3.4 6.4-7', '#fff', 2.8) +
    `<path d="M26.6 2.6l1.1 2.5 2.5 1.1-2.5 1.1-1.1 2.5-1.1-2.5-2.5-1.1 2.5-1.1z" fill="#ffd23f" ${O}/>`),
  needs_input: svg(`<path d="M16 2 30 16 16 30 2 16z" fill="#ffd23f" ${O}/>` +
    `<path d="M16 8.5v10" stroke="${INK}" stroke-width="3.8" stroke-linecap="round"/><circle cx="16" cy="23.2" r="2.1" fill="${INK}"/>`),
  asleep: svg(`<g transform="translate(-3 1) scale(.86)">${MOON}</g>` +
    `<text x="22" y="13" font-family="Lilita One, Arial Black, sans-serif" font-size="11" fill="#bcd0ff" stroke="${INK}" stroke-width="2" paint-order="stroke">z</text>`),
  wake: svg(sunBody()),
  port_open: svg(BOAT('#ff8a1f') + line('M2.5 29.5c2-1.4 4-1.4 6 0s4 1.4 6 0 4-1.4 6 0 4 1.4 6 0', '#7fe8ff', 1.5) +
    `<path d="M26 4.5v7M22.5 8h7" stroke="#3ddc84" stroke-width="2.6" stroke-linecap="round"/>`),
  port_close: svg(`<g opacity=".8">${BOAT('#8a94a6')}</g>` + line('M22 6.5h7M26 3.5l3 3-3 3', '#dfe9ff', 1.8)),
  // adrift: a listing, rust-brown boat on a slack line, with a warning badge
  port_adrift: svg(line('M1.5 13.5c3 5 6 5.5 8.5 4.5', '#d8b98a', 1.3) + `<g transform="rotate(-9 16 22)">${BOAT('#b9784a')}</g>` +
    line('M2.5 29.5c2-1.4 4-1.4 6 0s4 1.4 6 0 4-1.4 6 0', '#7fe8ff', 1.5) +
    badge('#ff9f3a', `<path d="M24.5 21.3v3.6" stroke="${INK}" stroke-width="2.2" stroke-linecap="round"/><circle cx="24.5" cy="27.4" r="1.2" fill="${INK}"/>`)),
  commit: svg(
    `<path d="M10.5 17.5l-4.5 4 .8 4.8 4.8-3.3zM21.5 17.5l4.5 4-.8 4.8-4.8-3.3z" fill="#ff5a4d" ${O}/>` +
    `<path d="M13 22.5 16 30.5l3-8z" fill="#ffc53d" ${O}/>` +
    `<path d="M16 2c4.4 3.4 6.4 9 5.8 15.6L16 21.5l-5.8-3.9C9.6 11 11.6 5.4 16 2z" fill="#f2f6ff" ${O}/>` +
    `<circle cx="16" cy="10.5" r="2.5" fill="#39e5ff" ${O}/>`),
  pull: svg(
    `<path d="M4.5 12.5a11.5 8.5 0 0 1 23 0z" fill="#ff5fa2" ${O}/><path d="M12.2 12.5a3.9 8.3 0 0 1 7.6 0z" fill="#fff3f8"/>` +
    `<path d="M5 12.5l7 9M16 12.5v9M27 12.5l-7 9" stroke="${INK}" stroke-width="1.3"/>` +
    `<path d="M10.5 21h11v9h-11z" fill="#b97a4a" ${O}/><path d="M10.5 21l11 9M21.5 21l-11 9" stroke="#7a4b2b" stroke-width="1.4"/>`),
  checkout: svg(line('M8.5 29.5V3.5', '#dfe9ff', 1.6) + `<path d="M8.5 4.5h17l-4 5 4 5h-17z" fill="#e24bd0" ${O}/>` +
    `<path d="M8.5 4.5h17l-1.6 2H8.5z" fill="#ff9be9"/>`),
  // two branches fusing into one, with a spark where they meet
  merge: svg(line('M8.5 6v6.5c0 5 7.5 5.5 7.5 10.5v3M23.5 6v6.5c0 5-7.5 5.5-7.5 10.5', '#e86bff', 2.4) +
    `<circle cx="8.5" cy="5.5" r="3.2" fill="#39e5ff" ${O}/><circle cx="23.5" cy="5.5" r="3.2" fill="#ffc53d" ${O}/>` +
    `<circle cx="16" cy="27" r="3.6" fill="#e86bff" ${O}/>` +
    `<path d="M16 15.2l.9 2 2 .9-2 .9-.9 2-.9-2-2-.9 2-.9z" fill="#fff3a8" ${O}/>`),
  // the Git Tree on fire (merge conflict)
  conflict: svg(`<path d="M13.2 22h5.6l.8 8h-7.2z" fill="#7a4b2b" ${O}/>` +
    `<path d="M16 2c1.6 4.4 8.2 7.4 8.2 14.6a8.2 8.2 0 0 1-16.4 0c0-3.6 2-5.8 3.5-7.6.5 2.4 1.5 3.6 2.8 4.1C13.6 9.6 14.2 5.8 16 2z" fill="#ff5a2a" ${O}/>` +
    `<path d="M16.2 12.2c1.1 2.6 4.3 4.1 4.3 7.9a4.4 4.4 0 0 1-8.8 0c0-2.4 1.4-3.6 2.4-4.8.4 1.2 1 1.7 1.7 2-.2-2-.2-3.2.4-5.1z" fill="#ffd23f"/>`),
  // a sealed scroll on a wing: the carrier pigeon's pull request
  pr: svg(`<path d="M11.5 12c-2.6-4.6.4-9 6.4-9.5-.8 2.6.6 4.6 3.6 5.2-2.8 2.4-6 3.8-10 4.3z" fill="#f4f6fb" ${O}/>` +
    `<rect x="6" y="12" width="20" height="12" rx="2" fill="#f6e7c1" ${O}/>` +
    `<ellipse cx="6" cy="18" rx="2.4" ry="6" fill="#e2c88f" ${O}/><ellipse cx="26" cy="18" rx="2.4" ry="6" fill="#e2c88f" ${O}/>` +
    line('M10.5 16h11M10.5 19.5h7', '#b79a62', 1.2) + `<circle cx="20.5" cy="23.5" r="3.4" fill="#d62839" ${O}/>`),
  // cargo airship heading for origin
  push: svg(`<ellipse cx="17" cy="10" rx="12" ry="6.2" fill="#ffc53d" ${O}/><path d="M9 7.6h16" stroke="#fff3c4" stroke-width="1.6" stroke-linecap="round"/>` +
    `<path d="M4.5 6.5 2 3.5v13l2.5-3" fill="#ff8a1f" ${O}/>` +
    `<path d="M12.5 16.2v3M21.5 16.2v3" stroke="${INK}" stroke-width="1.5"/><path d="M11 19h12v7.5H11z" fill="#b97a4a" ${O}/>` +
    line('M17 29.8v-4.6M14.6 27.4l2.4-2.4 2.4 2.4', '#7fe8ff', 1.6)),
};

// ---- crests (hex badges) --------------------------------------------------------------------------------------------

const hex = (main, trim, dark, glyph) => svg(
  `<path d="M20 2.2 37.2 12v20L20 41.8 2.8 32V12z" fill="${main}" stroke="${INK}" stroke-width="3.2" stroke-linejoin="round"/>` +
  `<path d="M20 2.2 37.2 12v20L20 41.8 2.8 32V12z" fill="none" stroke="${trim}" stroke-width="1.8" stroke-linejoin="round"/>` +
  `<path d="M3.6 22.5h32.8V31.6L20 41 3.6 31.6z" fill="${dark}" opacity=".45"/>` +
  `<path d="M20 4.2 35.6 13v4.4L20 8.8 4.4 17.4V13z" fill="#fff" opacity=".2"/>` +
  `<g transform="translate(4 6)">${glyph}</g>`, 'crest', '0 0 40 44');

function factionGlyph(f, glow, trim) {
  switch (f) {
    case 'opus': return `<path d="M16 3.5l3.4 4.6-3.4 4.6-3.4-4.6z" fill="${glow}" ${O}/>` +
      `<path d="M7.5 25a8.5 8.5 0 0 1 17 0z" fill="${glow}" ${O}/><path d="M6 25h20v3.4H6z" fill="${trim}" ${O}/>` +
      `<path d="M16 16.5v-2" stroke="${INK}" stroke-width="2" stroke-linecap="round"/>`;
    case 'sonnet': return `<path d="${gearPath(16, 16, 11.6, 8.4, 8)}" fill="${glow}" ${O}/><circle cx="16" cy="16" r="3.8" fill="${trim}" ${O}/>`;
    case 'haiku': {
      let p = '';
      for (let i = 0; i < 5; i++) p += `<ellipse cx="16" cy="9.2" rx="3.9" ry="5.6" transform="rotate(${i * 72} 16 16.4)" fill="${glow}" ${O}/>`;
      return p + `<circle cx="16" cy="16.4" r="3.2" fill="${trim}" ${O}/>`;
    }
    case 'fable': return `<ellipse cx="16" cy="24" rx="12" ry="3.4" fill="${glow}" ${O}/>` +
      `<path d="M16 2.5c1.2 5 4.4 12 8.2 20.5H7.8C11 15 13.6 8.6 16 2.5z" fill="${glow}" ${O}/>` +
      `<path d="M16 11.2l1.1 2.3 2.5.3-1.9 1.7.5 2.5-2.2-1.3-2.2 1.3.5-2.5-1.9-1.7 2.5-.3z" fill="${trim}"/>`;
    default: return `<path d="M16 9.5V5" stroke="${INK}" stroke-width="2.2"/><circle cx="16" cy="4.4" r="2.2" fill="${trim}" ${O}/>` +
      `<rect x="7" y="9.5" width="18" height="15" rx="3" fill="${glow}" ${O}/>` +
      `<rect x="9.8" y="13.4" width="12.4" height="4.6" rx="2" fill="${trim}" ${O}/><path d="M11 28.5h10" stroke="${INK}" stroke-width="2.4" stroke-linecap="round"/>`;
  }
}

export function factionCrest(f) {
  const p = factionPal(f);
  const key = ['opus', 'sonnet', 'haiku', 'fable'].includes(f) ? f : 'merc';
  return hex(cssHex(p.main), cssHex(p.trim), cssHex(p.dark), factionGlyph(key, key === 'merc' ? '#dfe4ee' : '#fffaf0', cssHex(p.trim)));
}

export function islandCrest(d) {
  const kind = d?.kind || 'repo';
  const sea = `<ellipse cx="16" cy="25" rx="14" ry="4.4" fill="#2ec4d6" ${O}/>`;
  const mound = (c) => `<path d="M5.5 25c1.5-5.5 19.5-5.5 21 0z" fill="${c}" ${O}/>`;
  let top;
  if (kind === 'camp') top = mound('#f6d38e') + `<path d="M9 21.5l6-9 6 9z" fill="#ff8a1f" ${O}/><path d="M15 12.5v9" stroke="${INK}" stroke-width="1.4"/>` +
    `<path d="M22.5 21l1-3 1 3z" fill="#ff5a4d"/>`;
  else if (kind === 'sandbox') top = mound('#f6d38e') + `<path d="M11 21.5v-5h2v1.6h2V16.5h2v1.6h2v-1.6h2v5z" fill="#e2b86c" ${O}/>`;
  else if (kind === 'home') top = mound('#86d34f') + `<path d="M10 21.5v-6l6-5 6 5v6z" fill="#f7e4c4" ${O}/><path d="M8.6 16.2 16 10l7.4 6.2" fill="none" stroke="#e0453a" stroke-width="2.4" stroke-linecap="round"/>`;
  else if (kind === 'town') top = mound('#b97a4a') + `<path d="M13.5 21.5l1-12h3l1 12z" fill="#fff" ${O}/><path d="M14 16h4v2.4h-4z" fill="#ff5a4d"/><circle cx="16" cy="8" r="2" fill="#ffd66b" ${O}/>`;
  else {
    const t = d?.tier || 1;
    top = mound('#86d34f') + `<path d="M12.5 21.5v-${7 + t * 1.6}h7v${7 + t * 1.6}z" fill="#b8c2d1" ${O}/>` +
      `<path d="M16 ${14.5 - t * 1.6}V${9 - t * 1.6}" stroke="${INK}" stroke-width="1.6"/><path d="M16 ${9 - t * 1.6}h5l-1.6 1.7 1.6 1.7h-5z" fill="#ff5fa2" ${O}/>` +
      `<path d="M14.6 ${17 - t * 0.4}h2.8v2.2h-2.8z" fill="#ffe38a"/>`;
  }
  return hex('#1d8fb0', '#ffc53d', '#0b4f6a', sea + top);
}

export function vesselCrest(kind, color) {
  if (kind === 'lighthouse') {
    return hex('#2a3b7a', '#ffc53d', '#141c44',
      `<path d="M10.5 30l2.5-19h6l2.5 19z" fill="#f7f7fb" ${O}/><path d="M11.6 22h8.8l.5 4h-9.8zM12.6 14.5h6.8l.4 3.2h-7.6z" fill="#ff5a4d"/>` +
      `<path d="M12 7.5h8v3.6h-8z" fill="#ffd66b" ${O}/><path d="M11.5 7.5 16 3.5l4.5 4z" fill="#ff5a4d" ${O}/>` +
      `<path d="M21 9 30 5v8zM11 9 2 5v8z" fill="#fff3b8" opacity=".6"/>`);
  }
  return hex('#1d6f9a', '#39e5ff', '#0b3a56',
    `<path d="M1.5 27c2.5-1.6 5-1.6 7.5 0s5 1.6 7.5 0 5-1.6 7.5 0 5 1.6 7.5 0" fill="none" stroke="#bff6ff" stroke-width="1.6" stroke-linecap="round"/>` +
    `<g transform="translate(0 1)">${BOAT(color)}</g>`);
}

// Tiny git-branch glyph for inline text (inherits the text color).
export const BRANCH = `<svg class="ico-br" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 5.2v5.6M11.5 7.2c0 3.2-4.4 2.6-6.6 4.3" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>` +
  `<circle cx="4.5" cy="3.5" r="1.9" fill="currentColor"/><circle cx="4.5" cy="12.5" r="1.9" fill="currentColor"/><circle cx="11.5" cy="5.5" r="1.9" fill="currentColor"/></svg>`;

// Small colored diamond/dot for inline use.
export const dot = (color) => `<i class="dot" style="--c:${color}"></i>`;
