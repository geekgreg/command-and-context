// Shared vocabulary for every world module: palette, cached flat-shaded materials, low-poly primitives,
// seeded randomness, easing, and a tiny tween/timer system driven by the engine clock.
import * as THREE from 'three';

// ---- palette -------------------------------------------------------------------------------------

export const PAL = {
  sea: 0x2ec4d6, seaDeep: 0x1478a8, foam: 0xe9fffb,
  sand: 0xf6d38e, sandDark: 0xe2b86c,
  grass: 0x86d34f, grassDark: 0x6cbf3e, grassLight: 0xa6e36b,
  cliff: 0xc98a5b, cliffDark: 0x9a6440, rock: 0x9c95b5, rockDark: 0x736c8c,
  wood: 0xb97a4a, woodDark: 0x7a4b2b,
  metal: 0xb8c2d1, metalDark: 0x5a6478, white: 0xf7f7fb, black: 0x1d1f2b,
  crystal: 0x5cf2ff, window: 0xffd66b, leaf: 0x5fbf4a, leafDark: 0x3f9a3a, blossom: 0xff9ec7,
  hazard: 0xffc53d, danger: 0xff4d4d, ok: 0x3ddc84,
  faction: {
    opus:   { main: 0x7a4dff, trim: 0xffc53d, glow: 0xffe38a, dark: 0x3b2280, name: 'The Opus Dominion', unit: 'Magister', hq: 'Grand Athenaeum' },
    sonnet: { main: 0x1fb5e8, trim: 0xff8a1f, glow: 0xcff6ff, dark: 0x0b5f80, name: 'Sonnet Heavy Industries', unit: 'Engineer', hq: 'Command Works' },
    haiku:  { main: 0x9be22d, trim: 0xff5fa2, glow: 0xfff3d6, dark: 0x4c7a12, name: 'The Haiku Swarm', unit: 'Sprite', hq: 'Blossom Hive' },
    fable:  { main: 0xe24bd0, trim: 0x2ed3c5, glow: 0xffe45c, dark: 0x7a1f70, name: 'The Fable Guild', unit: 'Scribe', hq: "Storyteller's Spire" },
    merc:   { main: 0x8a94a6, trim: 0xff4d4d, glow: 0xffd2d2, dark: 0x3e4452, name: 'Freelancers', unit: 'Drone', hq: 'Rented Hangar' },
  },
};

export function factionPal(f) { return PAL.faction[f] || PAL.faction.merc; }

export function cssHex(c) { return '#' + new THREE.Color(c).getHexString(); }

// Lighten (amt > 0) or darken (amt < 0) a hex color.
export function tint(hex, amt) {
  const c = new THREE.Color(hex);
  if (amt >= 0) c.lerp(new THREE.Color(0xffffff), amt);
  else c.lerp(new THREE.Color(0x000000), -amt);
  return c.getHex();
}

export function mix(a, b, t) { return new THREE.Color(a).lerp(new THREE.Color(b), t).getHex(); }

// ---- materials (cached, shared) ----------------------------------------------------------------------

const matCache = new Map();

// Flat-shaded Lambert material. opts: { emissive, emissiveIntensity, transparent, opacity, side, fog, unique }
// Materials are shared by color/options unless opts.unique is set (use unique when you will animate the material).
export function mat(color, opts = {}) {
  const key = opts.unique ? null : `${color}|${opts.emissive ?? ''}|${opts.emissiveIntensity ?? ''}|${opts.opacity ?? ''}|${opts.side ?? ''}|${opts.transparent ?? ''}|${opts.depthWrite ?? ''}`;
  if (key && matCache.has(key)) return matCache.get(key);
  const m = new THREE.MeshLambertMaterial({
    color,
    flatShading: true,
    emissive: opts.emissive ?? 0x000000,
    emissiveIntensity: opts.emissiveIntensity ?? 1,
    transparent: opts.transparent ?? (opts.opacity != null && opts.opacity < 1),
    opacity: opts.opacity ?? 1,
    side: opts.side ?? THREE.FrontSide,
  });
  if (opts.depthWrite === false) m.depthWrite = false;
  if (key) { m.userData.shared = true; matCache.set(key, m); }
  return m;
}

// Glowing material (windows, crystals, beacons). Brightness is boosted at night by the engine via emissiveIntensity.
export function glow(color, intensity = 1, opts = {}) {
  return mat(color, { emissive: color, emissiveIntensity: intensity, ...opts });
}

// ---- geometry (cached, shared) -------------------------------------------------------------------------

const geoCache = new Map();
function cachedGeo(key, make) {
  let g = geoCache.get(key);
  if (!g) { g = make(); g.userData.shared = true; geoCache.set(key, g); }
  return g;
}

function mesh(geo, color, opts = {}) {
  const material = color && color.isMaterial ? color : mat(color ?? PAL.white, opts);
  const m = new THREE.Mesh(geo, material);
  m.castShadow = opts.cast ?? true;
  m.receiveShadow = opts.receive ?? true;
  return m;
}

// All primitives are created with their base on y = 0 unless noted, which makes stacking easy.
export function box(w, h, d, color, opts = {}) {
  const geo = cachedGeo(`box${w}|${h}|${d}|${opts.center ? 'c' : 'b'}`, () => {
    const g = new THREE.BoxGeometry(w, h, d);
    if (!opts.center) g.translate(0, h / 2, 0);
    return g;
  });
  return mesh(geo, color, opts);
}

export function cyl(rTop, rBottom, h, seg, color, opts = {}) {
  const geo = cachedGeo(`cyl${rTop}|${rBottom}|${h}|${seg}|${opts.open ? 'o' : ''}|${opts.center ? 'c' : 'b'}`, () => {
    const g = new THREE.CylinderGeometry(rTop, rBottom, h, seg, 1, !!opts.open);
    if (!opts.center) g.translate(0, h / 2, 0);
    return g;
  });
  return mesh(geo, color, opts);
}

export function cone(r, h, seg, color, opts = {}) {
  const geo = cachedGeo(`cone${r}|${h}|${seg}|${opts.center ? 'c' : 'b'}`, () => {
    const g = new THREE.ConeGeometry(r, h, seg);
    if (!opts.center) g.translate(0, h / 2, 0);
    return g;
  });
  return mesh(geo, color, opts);
}

// Centered at the origin.
export function ico(r, detail, color, opts = {}) {
  const geo = cachedGeo(`ico${r}|${detail}`, () => new THREE.IcosahedronGeometry(r, detail));
  return mesh(geo, color, opts);
}

// Centered low-poly sphere.
export function sphere(r, color, opts = {}) {
  const ws = opts.segments ?? 8, hs = opts.rings ?? 6;
  const geo = cachedGeo(`sph${r}|${ws}|${hs}`, () => new THREE.SphereGeometry(r, ws, hs));
  return mesh(geo, color, opts);
}

export function torus(r, tube, radial, tubular, color, opts = {}) {
  const geo = cachedGeo(`tor${r}|${tube}|${radial}|${tubular}|${opts.arc ?? 'full'}`, () => new THREE.TorusGeometry(r, tube, radial, tubular, opts.arc ?? Math.PI * 2));
  return mesh(geo, color, opts);
}

// Wrap an arbitrary (non-cached) geometry into a shadowed mesh.
export function meshOf(geometry, color, opts = {}) { return mesh(geometry, color, opts); }

export function group(...children) {
  const g = new THREE.Group();
  for (const c of children) if (c) g.add(c);
  return g;
}

// Position/rotate/scale helper: at(mesh, x, y, z, { ry, rx, rz, s }) -> mesh
export function at(obj, x = 0, y = 0, z = 0, o = {}) {
  obj.position.set(x, y, z);
  if (o.rx) obj.rotation.x = o.rx;
  if (o.ry) obj.rotation.y = o.ry;
  if (o.rz) obj.rotation.z = o.rz;
  if (o.s != null) typeof o.s === 'number' ? obj.scale.setScalar(o.s) : obj.scale.set(o.s[0], o.s[1], o.s[2]);
  return obj;
}

// Freeze a static object (and, by default, its subtree): compose its local matrix once and stop three.js from
// recomposing it every frame, which it otherwise does for every object in the scene. A frozen object must never be
// moved, rotated or scaled again (its parents still may: world matrices keep following them). Subtrees marked
// userData.dyn (animated, see buildings.js) are left alone. { deep: false } freezes just the object itself.
export function freeze(obj, { deep = true } = {}) {
  if (!obj || obj.userData.dyn) return obj;
  obj.updateMatrix();
  obj.matrixAutoUpdate = false;
  if (deep) for (const c of obj.children) freeze(c);
  return obj;
}

// Displace vertices for a hand-made low-poly look. Returns a new non-indexed geometry (faces stay flat).
export function jitter(geometry, amount, seed = 1, keepBottom = false) {
  const g = geometry.index ? geometry.toNonIndexed() : geometry.clone();
  const pos = g.attributes.position;
  const r = rng(seed);
  const offsets = new Map();
  if (keepBottom && !geometry.boundingBox) geometry.computeBoundingBox();
  const minY = keepBottom ? geometry.boundingBox.min.y + 1e-3 : -Infinity;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const k = `${x.toFixed(3)},${y.toFixed(3)},${z.toFixed(3)}`;
    let o = offsets.get(k);
    if (!o) { o = [(r() - 0.5) * amount, (r() - 0.5) * amount, (r() - 0.5) * amount]; offsets.set(k, o); }
    if (y <= minY) continue;
    pos.setXYZ(i, x + o[0], y + o[1], z + o[2]);
  }
  g.computeVertexNormals();
  return g;
}

// Canvas-texture text sign (cached by text+style). Returns a Mesh (plane) facing +Z, size w x h world units.
// Entries are reference-counted: disposeTree() releases a sign mesh, and once nothing uses an entry it waits in a
// small pool of spares (reused if the same text comes back) before its texture is freed. Signs whose text keeps
// changing (ephemeral ports, veterancy counts, branch names) would otherwise pile up textures forever.
const signCache = new Map();
const signOf = new WeakMap();          // sign mesh -> cache entry (not copied by clone(), unlike userData)
const SIGN_SPARES = 24;
export function textSign(text, { w = 1.6, h = 0.5, bg = '#2b1d12', fg = '#ffe9b0', font = 'bold 64px "Lilita One", "Arial Black", sans-serif', border = '#7a4b2b' } = {}) {
  const key = `${text}|${w}|${h}|${bg}|${fg}|${font}|${border}`;
  let entry = signCache.get(key);
  if (!entry) {
    const cw = 512, ch = Math.max(64, Math.round(512 * h / w));
    const c = document.createElement('canvas');
    c.width = cw; c.height = ch;
    const x = c.getContext('2d');
    x.fillStyle = bg; x.fillRect(0, 0, cw, ch);
    if (border) { x.strokeStyle = border; x.lineWidth = Math.max(6, ch * 0.08); x.strokeRect(0, 0, cw, ch); }
    x.fillStyle = fg; x.textAlign = 'center'; x.textBaseline = 'middle';
    let size = parseInt(font.match(/(\d+)px/)?.[1] || '64', 10);
    const fam = font.replace(/^.*?\d+px\s*/, '');
    const weight = font.match(/^(bold|\d{3})/)?.[1] || 'bold';
    do { x.font = `${weight} ${size}px ${fam}`; size -= 4; } while (x.measureText(text).width > cw * 0.9 && size > 12);
    x.fillText(text, cw / 2, ch / 2 + 2);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    const material = new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide });
    material.userData.shared = true;
    const geo = new THREE.PlaneGeometry(w, h);
    geo.userData.shared = true;
    entry = { key, geo, material, refs: 0 };
    signCache.set(key, entry);
  }
  entry.refs++;
  const m = new THREE.Mesh(entry.geo, entry.material);
  m.castShadow = false;
  signOf.set(m, entry);
  return m;
}

// Called by disposeTree for sign meshes: drop the reference; free the oldest unused entries beyond the spares.
function releaseSign(o) {
  const e = signOf.get(o);
  signOf.delete(o);
  if (!e || --e.refs > 0 || signCache.get(e.key) !== e) return;
  e.refs = 0;
  signCache.delete(e.key);
  signCache.set(e.key, e);                     // most recently released goes last (LRU order)
  let spare = 0;
  for (const x of signCache.values()) if (x.refs <= 0) spare++;
  for (const [k, x] of signCache) {
    if (spare <= SIGN_SPARES) break;
    if (x.refs > 0) continue;
    signCache.delete(k);
    spare--;
    x.material.map?.dispose();
    x.material.dispose();
    x.geo.dispose();
  }
}

// Remove from parent and free GPU resources that are not shared/cached.
export function disposeTree(obj) {
  if (!obj) return;
  obj.parent?.remove(obj);
  obj.traverse((o) => {
    if (signOf.has(o)) releaseSign(o);
    if (o.geometry && !o.geometry.userData?.shared) o.geometry.dispose();
    const ms = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of ms) {
      if (m.userData?.shared) continue;
      if (m.map && !m.map.userData?.shared) m.map.dispose();
      m.dispose();
    }
  });
}

// ---- randomness ------------------------------------------------------------------------------------------

function hashString(s) {
  let h = 1779033703 ^ s.length;
  for (let i = 0; i < s.length; i++) { h = Math.imul(h ^ s.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
  return () => { h = Math.imul(h ^ (h >>> 16), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909); return (h ^= h >>> 16) >>> 0; };
}

// Seeded PRNG (mulberry32). rng('some id')() -> [0, 1)
export function rng(seed) {
  let a = typeof seed === 'number' ? seed >>> 0 : hashString(String(seed))();
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick(r, arr) { return arr[Math.floor(r() * arr.length) % arr.length]; }
export function hashHue(str) { return (hashString(String(str))() % 360) / 360; }

// ---- easing & tweens -----------------------------------------------------------------------------------

export const ease = {
  linear: (t) => t,
  inQuad: (t) => t * t,
  outQuad: (t) => 1 - (1 - t) * (1 - t),
  inOut: (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
  outCubic: (t) => 1 - Math.pow(1 - t, 3),
  inCubic: (t) => t * t * t,
  outBack: (t) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); },
  outElastic: (t) => (t === 0 || t === 1 ? t : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * (2 * Math.PI) / 3) + 1),
  outBounce: (t) => {
    const n1 = 7.5625, d1 = 2.75;
    if (t < 1 / d1) return n1 * t * t;
    if (t < 2 / d1) return n1 * (t -= 1.5 / d1) * t + 0.75;
    if (t < 2.5 / d1) return n1 * (t -= 2.25 / d1) * t + 0.9375;
    return n1 * (t -= 2.625 / d1) * t + 0.984375;
  },
};

const active = new Set();

// Animate numeric props of a target (e.g. mesh.position, mesh.scale, a material) over `secs`.
// Returns a Promise that resolves when done (or immediately if secs <= 0).
export function tween(target, props, secs, easeFn = ease.outCubic) {
  if (!secs || secs <= 0) { Object.assign(target, props); return Promise.resolve(); }
  const from = {};
  for (const k of Object.keys(props)) from[k] = target[k];
  return animate(secs, (k) => { for (const p in props) target[p] = from[p] + (props[p] - from[p]) * k; }, easeFn);
}

// Run fn(k) every frame for `secs` with eased k in [0, 1].
export function animate(secs, fn, easeFn = ease.linear) {
  return new Promise((resolve) => {
    active.add({ t: 0, secs, fn, easeFn, resolve });
  });
}

// Engine-clock sleep.
export function wait(secs) { return animate(secs, () => {}); }

// Leak checks (soak tests): running tweens/animations/waits and shared-cache sizes.
export const kitStats = () => ({ tweens: active.size, mats: matCache.size, geos: geoCache.size, signs: signCache.size });

// Called once per frame by the engine.
export function tickTweens(dt) {
  for (const a of active) {
    a.t += dt;
    const k = Math.min(1, a.t / a.secs);
    try { a.fn(a.easeFn(k)); } catch (e) { console.error(e); active.delete(a); a.resolve(); continue; }
    if (k >= 1) { active.delete(a); a.resolve(); }
  }
}

// ---- misc -------------------------------------------------------------------------------------------------

export const V3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
export const lerp = (a, b, t) => a + (b - a) * t;
export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const damp = (a, b, lambda, dt) => lerp(a, b, 1 - Math.exp(-lambda * dt));

export function fmtTokens(n) {
  if (n == null) return '–';
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 2).replace(/\.?0+$/, '') + 'M';
  if (n >= 1e3) return Math.round(n / 1e3) + 'k';
  return String(n);
}

export function fmtAgo(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d`;
}
