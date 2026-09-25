// Harbor (DESIGN §9): a stubby, chunky Vessel for every listening dev port / docker container, moored at a dock
// handed out by island.allocDock() or town.allocDock(), plus ambient SeaLife (circling gulls, a whale that surfaces
// and spouts, and a small sea serpent that loops around 'camp' islands).
//
// Exports: Vessel (DESIGN §4), SeaLife (constructor(world), tick(dt, t), dispose(); if the world never makes one, the
// first Vessel starts one itself via engine.onFrame; world.seaLife = false opts out), seaHeight(x, z, t, amp).
//
// Docks. Required: berth (Vector3, y = 0) and dir (toward open water). Optional, used when present:
//   root + pierEnd (Vector3s on the pier axis; islands.js): berth beside the axis -> moor alongside, bow to shore,
//     pushed clear of pierHalfWidth; berth on the axis -> moor alongside the quay edge (owner.position picks the bow);
//     the stevedores work on the pier deck (height root.y);
//   setSign(text) -> ':3000' / ':80 :5173 :8080'. Without it we plant our own signpost.
//   Without a pier axis the boat moors bow-in to its own little pontoon.
//
// Frames. vessel.group sits at the berth, rotated so local +Z points along the berth (bow toward shore). Inside it:
//   boat   arrival / departure offset + turn
//     float  rides the engine's sea waves (heave, pitch, roll) + list from wear + activity wobble; scaled per kind
//       model  hull + superstructure (static parts merged into one vertex-coloured mesh) + dynamic bits
//       wear   patch plates, barnacles, the perched gull, the "4 SALE" sign
//   shore  crate pile (the stevedores' seats), mooring line, pontoon / signpost when the dock has none
// Stevedores and packet crates are drawn by a few scene-wide InstancedMeshes shared by every vessel.
import * as THREE from 'three';
import {
  PAL, mat, glow, box, cyl, cone, sphere, ico, torus, at, textSign, disposeTree, rng, ease, tween, animate,
  clamp, lerp, damp, cssHex, factionPal, freeze,
} from './kit.js';

const TAU = Math.PI * 2;
const RUST = 0x8e4f2c;
const FOAM = 0xf4fffd;
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _p = new THREE.Vector3(), _s = new THREE.Vector3();
const _q = new THREE.Quaternion(), _e = new THREE.Euler(), _m = new THREE.Matrix4(), _m2 = new THREE.Matrix4();
const _m3 = new THREE.Matrix4(), _c = new THREE.Color(), _c2 = new THREE.Color(), _hsl = { h: 0, s: 0, l: 0 };
const ZERO_M = new THREE.Matrix4().makeScale(0, 0, 0);
const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const rand = Math.random;

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
const trunc = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s; };

// ---- the sea (mirrors the engine's SEA_VERT so boats ride the very waves that are drawn) ----------------------------

export function seaHeight(x, z, t, amp = 0.22) {
  return (Math.sin(x * 0.23 + z * 0.11 + t * 0.9) * 0.5
    + Math.sin(-x * 0.13 + z * 0.27 + t * 1.25) * 0.35
    + Math.sin(x * 0.41 - z * 0.33 + t * 1.8) * 0.2) * amp;
}

function seaAmp(engine) {
  const calm = engine?.settings?.reduceMotion ? 0.5 : 1;
  return (0.2 + 0.28 * (engine?.wind ?? 0.2) + 0.22 * (engine?.storm ?? 0)) * calm;
}

// ---- custom geometry ------------------------------------------------------------------------------------------------

const geoCache = new Map();
function cachedGeo(key, make) {
  let g = geoCache.get(key);
  if (!g) { g = make(); g.userData.shared = true; geoCache.set(key, g); }
  return g;
}

function toGeo(pos) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

// Triangle a,b,c ([x,y,z]) wound so its normal points along the hint vector.
function tri(out, a, b, c, hx, hy, hz) {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  if (nx * hx + ny * hy + nz * hz < 0) out.push(a[0], a[1], a[2], c[0], c[1], c[2], b[0], b[1], b[2]);
  else out.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
}

// Quads between two rings of equal length. mode 1 = face away from the Y axis, -1 = toward it, 0 = up.
function band(out, A, B, mode) {
  const n = A.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const a = A[i], b = A[j], c = B[j], d = B[i];
    const hx = mode ? (a[0] + b[0] + c[0] + d[0]) * mode : 0, hz = mode ? (a[2] + b[2] + c[2] + d[2]) * mode : 0;
    tri(out, a, b, c, hx, mode ? 0 : 1, hz);
    tri(out, a, c, d, hx, mode ? 0 : 1, hz);
  }
}

function cap(out, R, up) {
  let cx = 0, cy = 0, cz = 0;
  for (const p of R) { cx += p[0]; cy += p[1]; cz += p[2]; }
  const c = [cx / R.length, cy / R.length, cz / R.length];
  for (let i = 0; i < R.length; i++) tri(out, c, R[i], R[(i + 1) % R.length], 0, up, 0);
}

// Deck outline (convex ring, bow = +Z): square-ish stern, straight sides, a pointed bow.
function outline(L, B, o) {
  const h = L / 2, b = B / 2, bl = o.bow ?? L * 0.32;
  const half = [[0, -h], [b * (o.sternW ?? 0.82), -h], [b, -h + L * 0.2], [b, h - bl], [b * (o.bowW ?? 0.62), h - bl * 0.36], [0, h]];
  const ring = half.map((p) => p.slice());
  for (let i = half.length - 2; i >= 1; i--) ring.push([-half[i][0], half[i][1]]);
  return ring;
}

// Chunky low-poly hull: keel -> chine -> gunwale (sheer rises toward the bow) -> bulwark rail -> deck.
// Waterline y = 0. Returns cached { sides, deck, stripe, deckY(z) }.
const hullCache = new Map();
function hullParts(o) {
  const key = JSON.stringify(o);
  let e = hullCache.get(key);
  if (e) return e;
  const L = o.L, B = o.B, h = L / 2, b = B / 2;
  const draft = o.draft ?? 0.32, fb = o.fb ?? 0.42, sheer = o.sheer ?? 0.18, rail = o.rail ?? 0.1, wall = o.wall ?? 0.07;
  const ring = outline(L, B, o);
  const sy = (z) => fb + sheer * Math.pow(Math.max(0, z / h), 2) + (o.sternRise ?? 0) * Math.pow(Math.max(0, -z / h), 2);
  const keel = ring.map(([x, z]) => [x * (o.keelW ?? 0.55), -draft, z * 0.84]);
  const chine = ring.map(([x, z]) => [x * 0.95, -draft * 0.2, z * 0.97]);
  const gun = ring.map(([x, z]) => [x, sy(z), z]);
  const inX = 1 - wall / b, inZ = 1 - wall / h;
  const rIn = ring.map(([x, z]) => [x * inX, sy(z), z * inZ]);
  const dIn = ring.map(([x, z]) => [x * inX, sy(z) - rail, z * inZ]);
  const sides = [], deck = [];
  band(sides, keel, chine, 1);
  band(sides, chine, gun, 1);
  band(sides, gun, rIn, 0);
  band(sides, rIn, dIn, -1);
  cap(sides, keel, -1);
  cap(deck, dIn, 1);
  let stripe = null;
  if (o.stripe) {
    const lerpRing = (s) => chine.map((c, i) => {
      const g = gun[i];
      return [(c[0] + (g[0] - c[0]) * s) * 1.03, c[1] + (g[1] - c[1]) * s, (c[2] + (g[2] - c[2]) * s) * 1.015];
    });
    const out = [];
    band(out, lerpRing(o.stripe[0]), lerpRing(o.stripe[1]), 1);
    stripe = toGeo(out);
    stripe.userData.shared = true;
  }
  e = { sides: toGeo(sides), deck: toGeo(deck), stripe, deckY: (z) => sy(z) - rail };
  e.sides.userData.shared = e.deck.userData.shared = true;
  hullCache.set(key, e);
  return e;
}

// Flat triangle (sails, fins), double-sided material expected.
function triGeo(a, b, c) {
  return cachedGeo('tri' + a + b + c, () => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([...a, ...b, ...c], 3));
    g.computeVertexNormals();
    return g;
  });
}

// ---- merging -------------------------------------------------------------------------------------------------------
// Every static leaf mesh under a root (not under a userData.dynamic node) is baked into the root's frame. Plain opaque
// Lambert parts become ONE vertex-coloured mesh (shared material); glowing, glass, double-sided and textured parts are
// merged per material. A boat drops from ~40 draw calls to ~4. Paint colours are recorded as vertex ranges so wear can
// re-tint them in the colour buffer. Returns { vc, ranges: [{ start, count, hex }] }.

const VC_MAT = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
VC_MAT.userData.shared = true;

function concatGeos(list, colors = null) {
  let n = 0;
  for (const g of list) n += g.attributes.position.count;
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), col = colors ? new Float32Array(n * 3) : null;
  let o = 0;
  list.forEach((g, i) => {
    const c = g.attributes.position.count;
    pos.set(g.attributes.position.array.subarray(0, c * 3), o * 3);
    if (g.attributes.normal) nor.set(g.attributes.normal.array.subarray(0, c * 3), o * 3);
    if (col) {
      const k = colors[i];
      for (let j = 0; j < c; j++) { col[(o + j) * 3] = k.r; col[(o + j) * 3 + 1] = k.g; col[(o + j) * 3 + 2] = k.b; }
    }
    o += c;
    g.dispose();
  });
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  if (col) out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.computeBoundingSphere();
  return out;
}

const isPlain = (m) => m.isMeshLambertMaterial && !m.transparent && m.side === THREE.FrontSide && !m.vertexColors &&
  (!m.emissive || (m.emissive.r + m.emissive.g + m.emissive.b) === 0);

function mergeStatic(root) {
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const buckets = new Map(), dead = [], vcGeos = [], vcCols = [], ranges = [];
  let vcCast = false, vcCount = 0;
  const visit = (o) => {
    if (o.userData.dynamic) return;
    if (o.isMesh && !o.isInstancedMesh && !o.children.length && !o.material.map && !Array.isArray(o.material)) {
      const g = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone();
      g.applyMatrix4(_m.multiplyMatrices(inv, o.matrixWorld));
      const m = o.material;
      if (isPlain(m)) {
        const c = g.attributes.position.count;
        if (m.userData.paintHex != null) ranges.push({ start: vcCount, count: c, hex: m.userData.paintHex });
        vcGeos.push(g);
        vcCols.push(m.color);
        vcCount += c;
        vcCast = vcCast || o.castShadow;
      } else {
        let b = buckets.get(m);
        if (!b) buckets.set(m, (b = { list: [], cast: false }));
        b.list.push(g);
        b.cast = b.cast || (o.castShadow && !(m.emissive && (m.emissive.r + m.emissive.g + m.emissive.b) > 0));
      }
      dead.push(o);
      return;
    }
    for (const c of o.children) visit(c);
  };
  for (const c of [...root.children]) visit(c);
  for (const o of dead) o.parent.remove(o);
  let vc = null;
  if (vcGeos.length) {
    vc = new THREE.Mesh(concatGeos(vcGeos, vcCols), VC_MAT);
    vc.castShadow = vcCast;
    vc.receiveShadow = true;
    root.add(freeze(vc));          // merged meshes are baked into root space: they never move on their own
  }
  for (const [material, b] of buckets) {
    const m = new THREE.Mesh(concatGeos(b.list), material);
    m.castShadow = b.cast;
    m.receiveShadow = true;
    root.add(freeze(m));
  }
  return { vc, ranges };
}

// Re-tint the paint ranges of a merged vertex-coloured mesh for wear w.
function tintRanges(part, w) {
  const attr = part.vc?.geometry?.attributes?.color;
  if (!attr || !part.ranges.length) return;
  const a = attr.array;
  for (const r of part.ranges) {
    wornColor(_c, r.hex, w);
    for (let i = r.start, e = r.start + r.count; i < e; i++) { a[i * 3] = _c.r; a[i * 3 + 1] = _c.g; a[i * 3 + 2] = _c.b; }
  }
  attr.needsUpdate = true;
}

// ---- wear: desaturate toward rust ------------------------------------------------------------------------------------

function wornColor(out, base, w) {
  out.setHex(base);
  if (w <= 0) return out;
  out.getHSL(_hsl);
  out.setHSL(_hsl.h, _hsl.s * (1 - 0.72 * w), lerp(_hsl.l, 0.3, 0.3 * w));
  return out.lerp(_c2.setHex(RUST), 0.42 * w);
}

// ---- small shared parts ------------------------------------------------------------------------------------------------

const M = {
  black: () => mat(0x262833), tire: () => mat(0x2b2d36), white: () => mat(PAL.white), metal: () => mat(PAL.metal),
  metalDark: () => mat(PAL.metalDark), wood: () => mat(PAL.wood), woodDark: () => mat(PAL.woodDark),
  deck: () => mat(0xd9a877), rope: () => mat(0xd8b98a), win: () => glow(0xffe7a3, 0.45), red: () => mat(0xff4d4d),
  glass: () => mat(0xa9e4ff, { emissive: 0x6fc7ff, emissiveIntensity: 0.25 }),
};

// Seagull: white bean body, grey wings with black tips, orange beak. Faces +Z. -> { g, wl, wr, head }
function gullModel() {
  const g = new THREE.Group();
  const white = mat(0xfbfbff), grey = mat(0xc3cad6), orange = mat(0xffa53d), black = M.black();
  g.add(at(sphere(0.12, white, { segments: 6, rings: 4 }), 0, 0.14, 0, { s: [0.8, 0.78, 1.4] }));
  const head = new THREE.Group();
  head.position.set(0, 0.25, 0.12);
  head.add(sphere(0.075, white, { segments: 6, rings: 4 }));
  head.add(at(cone(0.03, 0.1, 4, orange), 0, -0.01, 0.05, { rx: Math.PI / 2 }));
  head.add(at(sphere(0.018, black, { segments: 4, rings: 3 }), 0.045, 0.02, 0.035));
  head.add(at(sphere(0.018, black, { segments: 4, rings: 3 }), -0.045, 0.02, 0.035));
  g.add(head);
  g.add(at(box(0.1, 0.03, 0.12, grey), 0, 0.14, -0.2, { rx: -0.25 }));
  g.add(at(box(0.02, 0.07, 0.02, orange), 0.04, 0, 0), at(box(0.02, 0.07, 0.02, orange), -0.04, 0, 0));
  const wing = (side) => {
    const w = new THREE.Group();
    w.position.set(side * 0.07, 0.19, 0.01);
    w.add(at(box(0.3, 0.025, 0.15, grey), side * 0.15, 0, 0));
    w.add(at(box(0.09, 0.026, 0.12, black), side * 0.33, 0, -0.01));
    w.userData.dynamic = true;
    g.add(w);
    mergeStatic(w);
    return w;
  };
  const wl = wing(1), wr = wing(-1);
  head.userData.dynamic = true;
  mergeStatic(head);
  mergeStatic(g);
  return { g, wl, wr, head };
}

function tire(parent, x, y, z) {
  parent.add(at(torus(0.11, 0.05, 5, 8, M.tire()), x, y, z, { ry: Math.PI / 2 }));
}

function lifebuoy(parent, x, y, z, ry = 0) {
  const g = at(new THREE.Group(), x, y, z, { ry });
  g.add(torus(0.12, 0.045, 6, 10, M.red()));
  for (let i = 0; i < 4; i++) g.add(at(box(0.05, 0.1, 0.1, M.white(), { center: true }), Math.cos(i * TAU / 4 + 0.78) * 0.12, Math.sin(i * TAU / 4 + 0.78) * 0.12, 0, { rz: i * TAU / 4 + 0.78 }));
  parent.add(g);
}

// Round glowing portholes along both sides at height y, from z0 to z1, at half-width hw.
function portholes(parent, n, y, z0, z1, hw, r = 0.065) {
  for (let i = 0; i < n; i++) {
    const z = n === 1 ? (z0 + z1) / 2 : lerp(z0, z1, i / (n - 1));
    for (const s of [1, -1]) parent.add(at(cyl(r, r, 0.04, 8, M.win(), { center: true }), s * hw, y, z, { rz: Math.PI / 2 }));
  }
}

// A cabin block with an overhanging roof and a band of windows on all four sides.
function cabin(parent, x, y, z, w, h, d, wall, roof, { win = true, winH = 0.16, roofH = 0.07, over = 0.07 } = {}) {
  parent.add(at(box(w, h, d, wall), x, y, z));
  parent.add(at(box(w + over * 2, roofH, d + over * 2, roof), x, y + h, z));
  if (!win) return;
  const wy = y + h * 0.58;
  parent.add(at(box(w * 0.82, winH, 0.03, M.win(), { center: true }), x, wy, z + d / 2 + 0.005));
  parent.add(at(box(w * 0.82, winH, 0.03, M.win(), { center: true }), x, wy, z - d / 2 - 0.005));
  parent.add(at(box(0.03, winH, d * 0.74, M.win(), { center: true }), x + w / 2 + 0.005, wy, z));
  parent.add(at(box(0.03, winH, d * 0.74, M.win(), { center: true }), x - w / 2 - 0.005, wy, z));
}

// Simple rectangular deck railing (posts + top rail).
function railing(parent, x, y, z, w, d, color, h = 0.16) {
  const m = mat(color);
  parent.add(at(box(w, 0.03, 0.03, m), x, y + h, z + d / 2), at(box(w, 0.03, 0.03, m), x, y + h, z - d / 2));
  parent.add(at(box(0.03, 0.03, d, m), x + w / 2, y + h, z), at(box(0.03, 0.03, d, m), x - w / 2, y + h, z));
  for (const [px, pz] of [[1, 1], [1, -1], [-1, 1], [-1, -1], [0, 1], [0, -1]]) parent.add(at(box(0.03, h, 0.03, m), x + px * w / 2, y, z + pz * d / 2));
}

// ---- the rig: builders fill in a context B while creating a kind's model -------------------------------------------
//   B.root (model group), B.P(hex) per-vessel paint material (rusts with wear), B.flagColor
//   filled in: L, beam, bowZ, sternZ, deckY, cargoZ, top, perch, horn, stacks[{o,c}], spin[{o,axis,idle,gain}], flags[]

function mk(geo, material, cast = true) {
  const m = new THREE.Mesh(geo, material);
  m.castShadow = cast;
  m.receiveShadow = true;
  return m;
}

function hull(B, o, { paint, stripe = null, deck = M.deck() }) {
  const H = hullParts(o);
  B.root.add(mk(H.sides, B.P(paint)));
  B.root.add(mk(H.deck, deck));
  if (H.stripe && stripe != null) B.root.add(mk(H.stripe, B.P(stripe)));
  B.L = o.L; B.beam = o.B; B.bowZ = o.L / 2; B.sternZ = -o.L / 2;
  B.deckY = H.deckY(0); B.deckAt = H.deckY; B.fb = o.fb ?? 0.42;
  return H;
}

function dynGroup(B, x = 0, y = 0, z = 0) {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  g.userData.dynamic = true;
  B.root.add(g);
  return g;
}

// Smokestack with a colored band and a sooty cap; registers a smoke emitter at the top.
function stack(B, x, y, z, r, h, body, bandColor, { seg = 10, rake = 0.12, smoke = 0xbfc2cd } = {}) {
  const g = at(new THREE.Group(), x, y, z, { rx: -rake });
  g.add(cyl(r * 0.88, r, h, seg, B.P(body)));
  if (bandColor != null) g.add(at(cyl(r * 0.925, r * 0.95, h * 0.2, seg, B.P(bandColor)), 0, h * 0.55, 0));
  g.add(at(cyl(r * 0.93, r * 0.9, h * 0.12, seg, M.black()), 0, h * 0.94, 0));
  const top = new THREE.Object3D();
  top.position.set(0, h * 1.1, 0);
  g.add(top);
  B.root.add(g);
  B.stacks.push({ o: top, c: smoke });
  if (!B.horn) B.horn = top;
  return g;
}

// Flag on a pole top at (x,y,z): two hinged panels that flutter aft. Colored with the owner's faction.
function addFlag(B, x, y, z, s = 1) {
  const f = dynGroup(B, x, y, z);
  const m = mat(B.flagColor);
  const a = at(box(0.34 * s, 0.28 * s, 0.035, m, { center: true }), 0.17 * s, -0.14 * s, 0);
  const seg = at(new THREE.Group(), 0.34 * s, 0, 0);
  const b = at(box(0.28 * s, 0.28 * s, 0.035, m, { center: true }), 0.14 * s, -0.14 * s, 0);
  seg.add(b);
  f.add(a, seg);
  a.castShadow = b.castShadow = false;
  f.rotation.y = Math.PI / 2;
  B.flags.push({ f, seg, meshes: [a, b], ph: rand() * TAU, s, geo: null });
  return f;
}

// Adrift (ROADMAP H2): the flag's two panels swap to torn outlines (a bite out of the hoist panel, a ragged fly end),
// extruded to the panels' thickness and centred like them, and fade toward sun-bleached canvas.
const TORN = [
  [[-0.17, 0.14], [0.17, 0.14], [0.17, -0.14], [0.08, -0.14], [0.03, -0.05], [-0.03, -0.14], [-0.17, -0.14]],
  [[-0.14, 0.14], [0.11, 0.14], [0.02, 0.07], [0.12, 0.0], [-0.02, -0.03], [0.04, -0.1], [-0.07, -0.07], [-0.14, -0.14]],
];
function tornFlagGeo(i, s) {
  return cachedGeo(`flagTorn${i}|${s}`, () => {
    const sh = new THREE.Shape(TORN[i].map(([x, y]) => new THREE.Vector2(x * s, y * s)));
    const g = new THREE.ExtrudeGeometry(sh, { depth: 0.035, bevelEnabled: false });
    g.translate(0, 0, -0.0175);
    return g;
  });
}
const BLEACH = 0xbdb298;
function fadedHex(hex) { return _c.setHex(hex).lerp(_c2.setHex(BLEACH), 0.6).getHex(); }

function mast(B, x, y, z, h, { color = M.woodDark(), flag = true, light = true, r = 0.045, perch = true } = {}) {
  B.root.add(at(cyl(r * 0.7, r, h, 6, color), x, y, z));
  const top = new THREE.Object3D();
  top.position.set(x, y + h + 0.02, z);
  B.root.add(top);
  if (perch && !B.perch) B.perch = top;
  if (light) B.root.add(at(sphere(0.06, M.win(), { segments: 6, rings: 4 }), x, y + h + 0.05, z));
  if (flag) addFlag(B, x, y + h - 0.03, z);
  B.top = Math.max(B.top || 0, y + h + 0.1);
  return top;
}

// Horizontal half-ring rubber fender hugging the bow.
function bowFender(B, z, y, r = 0.3) {
  B.root.add(at(torus(r, 0.085, 5, 10, M.tire(), { arc: Math.PI }), 0, y, z, { rx: Math.PI / 2 }));
}

// ---- vessel builders by kind -----------------------------------------------------------------------------------------

const TUG_STYLE = {
  node: { hull: 0x5fa04e, trim: 0xf3f8ee, cabin: 0xf6f2e8, roof: 0x3c873a, stack: 0x3c873a, band: 0x8cc84b, seg: 6 },
  bun: { hull: 0xfbf0df, trim: 0x4a3223, cabin: 0xfff8ec, roof: 0xd99a5b, stack: 0xfbf0df, band: 0x4a3223, seg: 10, face: true },
  deno: { hull: 0x23252f, trim: 0xf4f4f7, cabin: 0xeceef3, roof: 0x23252f, stack: 0xf4f4f7, band: 0x23252f, seg: 10, dino: true },
};

function buildTug(B, r, port, kind) {
  const st = TUG_STYLE[kind] || TUG_STYLE.node;
  hull(B, { L: 2.7, B: 1.5, bow: 0.95, bowW: 0.66, sternW: 0.86, fb: 0.5, sheer: 0.3, draft: 0.34, stripe: [0.72, 0.9], rail: 0.12 },
    { paint: st.hull, stripe: st.trim });
  const dy = B.deckY;
  for (const z of [-0.8, -0.1, 0.5]) { tire(B.root, 0.78, 0.3, z); tire(B.root, -0.78, 0.3, z); }
  bowFender(B, 1.08, 0.66, 0.27);
  const cz = 0.02;
  cabin(B.root, 0, dy, cz, 0.95, 0.55, 0.92, B.P(st.cabin), B.P(st.roof));
  const wy = dy + 0.62;
  if (st.face) {
    // bun: the wheelhouse wears a toasty bun dome
    cabin(B.root, 0, wy, cz + 0.14, 0.72, 0.36, 0.56, B.P(st.cabin), B.P(st.roof), { roofH: 0.02, over: 0.02 });
    B.root.add(at(sphere(0.46, B.P(st.roof), { segments: 10, rings: 6 }), 0, wy + 0.36, cz + 0.14, { s: [0.95, 0.42, 0.75] }));
  } else {
    cabin(B.root, 0, wy, cz + 0.14, 0.72, 0.4, 0.56, B.P(st.cabin), B.P(st.roof));
  }
  stack(B, 0, wy, cz - 0.3, 0.18, 0.8, st.stack, st.band, { seg: st.seg, rake: 0.1, smoke: 0xb3b6c3 });
  mast(B, 0.24, wy + 0.46, cz + 0.28, 0.62);
  lifebuoy(B.root, 0.5, dy + 0.26, cz, Math.PI / 2);
  lifebuoy(B.root, -0.5, dy + 0.26, cz, Math.PI / 2);
  // towing bitts + a coil of rope on the stern deck
  B.root.add(at(cyl(0.06, 0.07, 0.2, 6, M.black()), 0.2, dy, -1.0), at(cyl(0.06, 0.07, 0.2, 6, M.black()), -0.2, dy, -1.0));
  B.root.add(at(torus(0.14, 0.045, 4, 10, M.rope()), 0, dy + 0.04, -0.72, { rx: Math.PI / 2 }));
  if (st.face) {
    // bun: googly bow eyes and pink cheeks
    for (const s of [1, -1]) {
      B.root.add(at(sphere(0.085, M.white(), { segments: 7, rings: 5 }), s * 0.52, 0.5, 0.86, { s: [0.5, 1, 1] }));
      B.root.add(at(sphere(0.045, M.black(), { segments: 6, rings: 4 }), s * 0.56, 0.5, 0.9));
      B.root.add(at(sphere(0.08, mat(0xff9ec0), { segments: 6, rings: 4 }), s * 0.6, 0.33, 0.66, { s: [0.35, 0.7, 1] }));
    }
  }
  if (st.dino) {
    // deno: a small black sauropod rides on the stern, peering over the cabin
    const d = new THREE.Group();
    at(d, -0.22, dy, -0.85);
    const skin = B.P(0x2b2e3a);
    d.add(at(sphere(0.2, skin, { segments: 7, rings: 5 }), 0, 0.2, 0, { s: [0.85, 0.8, 1.2] }));
    d.add(at(cyl(0.06, 0.09, 0.5, 6, skin), 0, 0.25, 0.1, { rx: 0.45 }));
    d.add(at(box(0.17, 0.14, 0.24, skin), 0, 0.72, 0.36));
    d.add(at(sphere(0.03, M.white(), { segments: 5, rings: 3 }), 0.085, 0.77, 0.42), at(sphere(0.03, M.white(), { segments: 5, rings: 3 }), -0.085, 0.77, 0.42));
    d.add(at(cone(0.07, 0.35, 5, skin), 0, 0.14, -0.2, { rx: -2.0 }));
    B.root.add(d);
  }
  B.cargoZ = 0.72;
  B.top = Math.max(B.top, wy + 1.0);
  B.toot = 'TOOT!';
}

function buildSteamer(B) {
  const blue = 0x3776ab, yellow = 0xffd43b, cream = 0xf6f1e4;
  hull(B, { L: 3.2, B: 1.42, bow: 1.0, bowW: 0.6, sternW: 0.9, fb: 0.46, sheer: 0.22, draft: 0.32, stripe: [0.7, 0.88] },
    { paint: blue, stripe: yellow });
  const dy = B.deckY;
  cabin(B.root, 0, dy, -0.2, 1.06, 0.5, 1.66, B.P(cream), B.P(blue), { winH: 0.14 });
  const uy = dy + 0.57;
  railing(B.root, 0, uy, -0.2, 1.12, 1.7, cream, 0.13);
  cabin(B.root, 0, uy, 0.4, 0.72, 0.38, 0.46, B.P(cream), B.P(yellow));
  stack(B, 0, uy, -0.42, 0.2, 1.02, yellow, blue, { rake: 0.16, smoke: 0xeeeef4 });
  mast(B, 0, dy, 1.08, 1.25);
  portholes(B.root, 4, 0.16, -0.9, 0.6, 0.705);
  lifebuoy(B.root, 0.55, dy + 0.25, 0.25, Math.PI / 2);
  // stern paddle wheel, spins with activity
  const w = dynGroup(B, 0, 0.3, -1.84);
  w.add(at(cyl(0.1, 0.1, 1.0, 8, M.metalDark(), { center: true }), 0, 0, 0, { rz: Math.PI / 2 }));
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * TAU;
    w.add(at(box(0.9, 0.06, 0.3, B.P(yellow), { center: true }), 0, Math.sin(a) * 0.27, Math.cos(a) * 0.27, { rx: -a }));
  }
  for (const s of [1, -1]) w.add(at(torus(0.43, 0.03, 4, 12, B.P(blue)), s * 0.47, 0, 0, { ry: Math.PI / 2 }));
  B.spin.push({ o: w, axis: 'x', idle: 0.35, gain: 4.5 });
  B.cargoZ = 0.95;
  B.top = Math.max(B.top, uy + 1.2);
  B.toot = 'TOOT TOOT!';
}

function buildBarge(B) {
  const purple = 0x777bb4, dark = 0x4f5b93, eleph = 0x8d95c9;
  hull(B, { L: 3.0, B: 1.75, bow: 0.45, bowW: 0.86, sternW: 0.96, fb: 0.36, sheer: 0.1, draft: 0.28, stripe: [0.5, 0.74], rail: 0.08 },
    { paint: purple, stripe: dark });
  const dy = B.deckY;
  cabin(B.root, 0, dy, -1.0, 0.86, 0.5, 0.56, B.P(0xeceaf8), B.P(dark));
  stack(B, 0.26, dy + 0.57, -1.12, 0.1, 0.42, dark, purple, { seg: 8, rake: 0.05 });
  mast(B, -0.26, dy + 0.57, -1.0, 0.7);
  // cargo: crates and sacks
  const crate = M.wood(), sack = mat(0xe8d6a4);
  B.root.add(at(box(0.38, 0.32, 0.38, crate), 0.4, dy, -0.25), at(box(0.38, 0.32, 0.38, crate), 0.4, dy, 0.18));
  B.root.add(at(box(0.34, 0.3, 0.34, crate), 0.38, dy + 0.32, -0.04, { ry: 0.3 }));
  B.root.add(at(sphere(0.2, sack, { segments: 6, rings: 4 }), -0.38, dy + 0.14, -0.2, { s: [1, 0.7, 1.3] }));
  B.root.add(at(sphere(0.2, sack, { segments: 6, rings: 4 }), -0.32, dy + 0.14, 0.2, { s: [1, 0.7, 1.3], ry: 0.5 }));
  // the elePHPant figurehead
  const E = new THREE.Group();
  at(E, 0, dy + 0.32, 1.28);
  const em = B.P(eleph);
  E.add(at(sphere(0.3, em, { segments: 8, rings: 6 }), 0, 0.12, 0, { s: [1, 0.92, 0.95] }));
  for (const s of [1, -1]) {
    E.add(at(sphere(0.25, em, { segments: 7, rings: 5 }), s * 0.3, 0.14, -0.04, { s: [0.32, 1, 0.9], ry: s * 0.35 }));
    E.add(at(sphere(0.035, M.black(), { segments: 5, rings: 3 }), s * 0.13, 0.22, 0.25));
    E.add(at(cone(0.035, 0.18, 5, M.white()), s * 0.12, -0.03, 0.2, { rx: 2.0 }));
  }
  E.add(at(cyl(0.085, 0.1, 0.25, 6, em), 0, 0.03, 0.24, { rx: 2.0 }));
  E.add(at(cyl(0.07, 0.085, 0.2, 6, em), 0, -0.075, 0.47, { rx: 2.6 }));
  E.add(at(cyl(0.055, 0.07, 0.16, 6, em), 0, -0.25, 0.57, { rx: 0.7 }));
  B.root.add(E);
  const horn = new THREE.Object3D();
  horn.position.set(0, dy + 0.3, 1.9);
  B.root.add(horn);
  B.horn = horn;
  B.cargoZ = 0.55;
  B.top = Math.max(B.top, dy + 1.4);
  B.toot = 'PAWOOO!';
}

function buildSloop(B) {
  const red = 0xcc342d;
  hull(B, { L: 2.9, B: 1.2, bow: 1.15, bowW: 0.55, sternW: 0.72, fb: 0.36, sheer: 0.22, draft: 0.3, stripe: [0.78, 0.93] },
    { paint: red, stripe: 0xfff1e0 });
  const dy = B.deckY;
  cabin(B.root, 0, dy, -0.5, 0.7, 0.28, 0.8, B.P(0xfff1e0), B.P(0x8e1f1a), { winH: 0.1 });
  const mz = 0.28, mh = 2.5;
  mast(B, 0, dy, mz, mh, { color: M.wood(), r: 0.05 });
  B.root.add(at(cyl(0.028, 0.028, 1.35, 6, M.wood()), 0, dy + 0.42, mz, { rx: -Math.PI / 2 }));
  const sails = dynGroup(B, 0, 0, mz);
  const cloth = mat(0xfff6e5, { side: THREE.DoubleSide });
  sails.add(mk(triGeo([0, dy + 0.46, -0.05], [0, dy + mh - 0.12, -0.05], [0, dy + 0.46, -1.3]), cloth));
  sails.add(mk(triGeo([0, dy + 0.3, 1.16], [0, dy + mh - 0.3, 0.05], [0, dy + 0.4, 0.14]), cloth));
  sails.add(at(ico(0.15, 0, mat(0xe0115f, { emissive: 0x80002a, emissiveIntensity: 0.5 })), 0, dy + 1.0, -0.42, { s: [0.35, 1.2, 1] }));
  B.sails = sails;
  B.root.add(at(cyl(0.012, 0.012, 1.6, 4, M.rope()), 0, dy + 0.1, 1.3, { rx: -0.62 }));
  B.cargoZ = 0.75;
  B.top = Math.max(B.top, dy + mh + 0.1);
  B.toot = 'AHOY!';
  B.horn = B.perch;
}

function buildFreighter(B) {
  const orange = 0xf89820, brown = 0x6b4226, javaBlue = 0x5382a1, cream = 0xf6ead8;
  hull(B, { L: 3.7, B: 1.5, bow: 1.1, bowW: 0.6, sternW: 0.9, fb: 0.5, sheer: 0.24, draft: 0.34, stripe: [0.02, 0.24], rail: 0.1 },
    { paint: orange, stripe: brown });
  const dy = B.deckY;
  cabin(B.root, 0, dy, -1.12, 1.12, 0.62, 0.72, B.P(cream), B.P(brown));
  cabin(B.root, 0, dy + 0.69, -1.06, 0.92, 0.36, 0.5, B.P(cream), B.P(brown));
  stack(B, 0, dy + 0.69, -1.5, 0.17, 0.66, javaBlue, orange, { smoke: 0xb3b6c3 });
  mast(B, 0.32, dy + 1.12, -1.0, 0.58);
  lifebuoy(B.root, 0.58, dy + 0.3, -1.12, Math.PI / 2);
  // the cargo: one enormous cup of coffee, steaming when busy
  const mz = 0.3;
  B.root.add(at(cyl(0.44, 0.38, 0.64, 12, M.white()), 0, dy, mz));
  B.root.add(at(cyl(0.4, 0.4, 0.03, 12, mat(0x4a2c17)), 0, dy + 0.585, mz));
  B.root.add(at(cyl(0.434, 0.418, 0.1, 12, B.P(orange)), 0, dy + 0.38, mz));
  B.root.add(at(torus(0.17, 0.05, 5, 8, M.white(), { arc: Math.PI }), 0.41, dy + 0.32, mz, { rz: -Math.PI / 2 }));
  const steam = new THREE.Object3D();
  steam.position.set(0, dy + 0.7, mz);
  B.root.add(steam);
  B.stacks.push({ o: steam, c: 0xfdfaf2, steam: true });
  // a little cargo derrick at the bow
  B.root.add(at(cyl(0.04, 0.05, 1.0, 6, B.P(brown)), 0, dy, 1.1));
  B.root.add(at(cyl(0.025, 0.025, 0.8, 5, B.P(brown)), 0, dy + 0.35, 1.08, { rx: -0.9 }));
  B.cargoZ = 1.0;
  B.top = Math.max(B.top, dy + 1.8);
  B.toot = 'BRRREW!';
}

function buildSpeedboat(B) {
  const cyan = 0x00add8, fur = 0x8fdcef;
  hull(B, { L: 2.7, B: 1.15, bow: 1.25, bowW: 0.5, sternW: 0.95, fb: 0.34, sheer: 0.16, draft: 0.26, stripe: [0.42, 0.62], rail: 0.07 },
    { paint: cyan, stripe: 0xffffff });
  const dy = B.deckY;
  B.root.add(at(box(0.92, 0.1, 0.8, B.P(cyan)), 0, dy + 0.02, 0.78, { rx: 0.1 }));
  B.root.add(at(box(0.96, 0.3, 0.04, M.glass()), 0, dy + 0.02, 0.33, { rx: -0.5 }));
  B.root.add(at(box(0.8, 0.16, 0.34, M.white()), 0, dy, -0.35), at(box(0.8, 0.3, 0.08, M.white()), 0, dy, -0.54));
  // the gopher at the wheel
  const G = new THREE.Group();
  at(G, 0.2, dy, 0.02);
  const f = B.P(fur);
  G.add(at(sphere(0.2, f, { segments: 8, rings: 6 }), 0, 0.2, 0, { s: [1, 1.15, 0.9] }));
  G.add(at(sphere(0.17, f, { segments: 8, rings: 6 }), 0, 0.47, 0.02));
  for (const s of [1, -1]) {
    G.add(at(sphere(0.075, M.white(), { segments: 7, rings: 5 }), s * 0.075, 0.53, 0.13));
    G.add(at(sphere(0.035, M.black(), { segments: 5, rings: 4 }), s * 0.075, 0.535, 0.195));
    G.add(at(sphere(0.05, f, { segments: 5, rings: 4 }), s * 0.13, 0.6, -0.02));
  }
  G.add(at(box(0.07, 0.06, 0.03, M.white()), 0, 0.37, 0.17), at(sphere(0.035, mat(0xb5835a), { segments: 5, rings: 4 }), 0, 0.43, 0.18));
  B.root.add(G);
  B.root.add(at(cyl(0.1, 0.1, 0.04, 8, M.black(), { center: true }), 0.2, dy + 0.34, 0.2, { rx: 1.1 }));
  // outboard motor
  B.root.add(at(box(0.3, 0.4, 0.28, M.black()), 0, dy - 0.04, -1.42), at(box(0.32, 0.12, 0.3, B.P(0xffffff)), 0, dy + 0.34, -1.42));
  B.root.add(at(box(0.08, 0.5, 0.08, M.metalDark()), 0, -0.3, -1.48));
  const prop = dynGroup(B, 0, -0.24, -1.56);
  for (let i = 0; i < 3; i++) prop.add(at(box(0.05, 0.2, 0.02, M.metal(), { center: true }), 0, 0, 0, { rz: (i / 3) * TAU }));
  B.spin.push({ o: prop, axis: 'z', idle: 1, gain: 30 });
  mast(B, -0.36, dy, -1.15, 0.8, { light: false });
  const horn = new THREE.Object3D();
  horn.position.set(0.2, dy + 0.75, 0.05);
  B.root.add(horn);
  B.horn = horn;
  B.cargoZ = 0.7;
  B.top = Math.max(B.top, dy + 0.9);
  B.toot = 'VROOM!';
}

function buildFerry(B) {
  const purple = 0x512bd4, white = 0xf7f5ff;
  hull(B, { L: 3.4, B: 1.75, bow: 0.8, bowW: 0.72, sternW: 0.9, fb: 0.46, sheer: 0.12, sternRise: 0.06, draft: 0.3, stripe: [0.62, 0.8] },
    { paint: purple, stripe: white });
  const dy = B.deckY;
  cabin(B.root, 0, dy, -0.2, 1.45, 0.52, 2.2, B.P(white), B.P(purple), { winH: 0.17 });
  const uy = dy + 0.59;
  cabin(B.root, 0, uy, -0.3, 1.2, 0.42, 1.5, B.P(white), B.P(purple), { winH: 0.15 });
  const by = uy + 0.49;
  cabin(B.root, 0, by, 0.05, 0.8, 0.32, 0.5, B.P(white), B.P(purple));
  stack(B, 0, by, -0.6, 0.14, 0.5, purple, white, { rake: 0.08, smoke: 0xe5e5ee });
  mast(B, 0.3, by + 0.39, 0.05, 0.5);
  lifebuoy(B.root, 0.74, dy + 0.26, 0.55, Math.PI / 2);
  lifebuoy(B.root, -0.74, dy + 0.26, 0.55, Math.PI / 2);
  // a commuter car waiting on the bow ramp
  B.root.add(at(box(0.42, 0.18, 0.62, mat(0xff5f5f)), -0.3, dy, 1.25), at(box(0.34, 0.14, 0.34, M.glass()), -0.3, dy + 0.18, 1.22));
  B.cargoZ = 1.2;
  B.top = Math.max(B.top, by + 1.0);
  B.toot = 'DING DING!';
}

function buildCutter(B) {
  const green = 0x009639, white = 0xf6f8f7;
  hull(B, { L: 3.2, B: 1.3, bow: 1.2, bowW: 0.55, sternW: 0.85, fb: 0.46, sheer: 0.22, draft: 0.3, stripe: [0.66, 0.9] },
    { paint: green, stripe: white });
  const dy = B.deckY;
  cabin(B.root, 0, dy, -0.25, 0.95, 0.5, 1.2, B.P(white), B.P(green));
  cabin(B.root, 0, dy + 0.57, 0.05, 0.75, 0.36, 0.55, B.P(white), B.P(green));
  B.root.add(at(cyl(0.035, 0.05, 0.62, 6, M.metal()), 0, dy + 0.57, -0.4));
  const radar = dynGroup(B, 0, dy + 1.2, -0.4);
  radar.add(at(box(0.62, 0.06, 0.09, M.white(), { center: true }), 0, 0, 0));
  B.spin.push({ o: radar, axis: 'y', idle: 0.9, gain: 3 });
  // siren light bar: red + blue, flashes when busy
  const bar = dynGroup(B, 0, dy + 1.0, 0.05);
  bar.add(at(box(0.5, 0.06, 0.12, M.metalDark(), { center: true }), 0, 0, 0));
  const red = at(box(0.16, 0.1, 0.13, glow(0xff3344, 1.2), { center: true }), 0.15, 0.07, 0);
  const blue = at(box(0.16, 0.1, 0.13, glow(0x3d7bff, 1.2), { center: true }), -0.15, 0.07, 0);
  bar.add(red, blue);
  B.siren = { red, blue };
  // a water cannon on the bow
  B.root.add(at(cyl(0.08, 0.1, 0.2, 6, M.metalDark()), 0, dy, 1.0), at(cyl(0.035, 0.045, 0.34, 6, M.metal()), 0, dy + 0.2, 1.0, { rx: 1.0 }));
  mast(B, -0.3, dy + 0.99, 0.05, 0.5);
  const horn = new THREE.Object3D();
  horn.position.set(0, dy + 1.15, 0.05);
  B.root.add(horn);
  B.horn = horn;
  B.cargoZ = 0.95;
  B.top = Math.max(B.top, dy + 1.4);
  B.toot = 'WOOP WOOP!';
}

function buildLlama(B) {
  const wool = 0xf5efe3, snout = 0xe8d9c0;
  hull(B, { L: 2.3, B: 1.35, bow: 0.85, bowW: 0.7, sternW: 0.9, fb: 0.4, sheer: 0.12, draft: 0.26, stripe: [0.58, 0.86], rail: 0.08 },
    { paint: wool, stripe: 0xff7a59 });
  const dy = B.deckY;
  const W = B.P(wool);
  // woolly tufts along the rail
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * TAU;
    B.root.add(at(ico(0.12, 0, W), Math.sin(a) * 0.62, 0.43, Math.cos(a) * 0.95 - 0.1, { s: [1, 0.8, 1] }));
  }
  // long neck and head at the bow: tan snout, pink bridle, tasselled ears, a woolly topknot
  const N = new THREE.Group();
  at(N, 0, dy, 0.6);
  N.add(at(cyl(0.15, 0.2, 1.15, 7, W), 0, 0, 0, { rx: 0.16 }));
  N.add(at(cyl(0.215, 0.225, 0.13, 7, mat(0x2ed3c5)), 0, 0.12, 0.02, { rx: 0.16 }));
  N.add(at(ico(0.14, 0, W), 0, 0.62, 0.12), at(ico(0.13, 0, W), 0, 0.9, 0.16));
  const H = at(new THREE.Group(), 0, 1.16, 0.22);
  H.add(at(box(0.36, 0.32, 0.4, W), 0, 0, 0));
  H.add(at(box(0.25, 0.2, 0.26, B.P(0xd9b68a)), 0, -0.01, 0.28));
  H.add(at(torus(0.16, 0.028, 4, 10, mat(0xff5fa2)), 0, 0.09, 0.3));
  H.add(at(sphere(0.022, M.black(), { segments: 4, rings: 3 }), 0.06, 0.13, 0.42), at(sphere(0.022, M.black(), { segments: 4, rings: 3 }), -0.06, 0.13, 0.42));
  H.add(at(ico(0.12, 0, W), 0, 0.33, -0.02));
  for (const s of [1, -1]) {
    H.add(at(sphere(0.06, M.black(), { segments: 6, rings: 4 }), s * 0.15, 0.2, 0.13));
    H.add(at(sphere(0.02, M.white(), { segments: 4, rings: 3 }), s * 0.17, 0.23, 0.18));
    H.add(at(cone(0.075, 0.3, 5, W), s * 0.12, 0.3, -0.08, { rz: -s * 0.32 }));
    H.add(at(sphere(0.05, mat(0xff5fa2), { segments: 5, rings: 3 }), s * 0.21, 0.56, -0.08));
  }
  N.add(H);
  B.root.add(N);
  const horn = new THREE.Object3D();
  horn.position.set(0, dy + 1.6, 1.0);
  B.root.add(horn);
  B.horn = horn;
  // pedal seats under a striped sunshade
  B.root.add(at(box(0.9, 0.2, 0.34, mat(0x2ed3c5)), 0, dy, -0.2), at(box(0.9, 0.3, 0.08, mat(0x2ed3c5)), 0, dy, -0.4));
  for (const [x, z] of [[0.46, -0.62], [-0.46, -0.62], [0.46, 0.2], [-0.46, 0.2]]) B.root.add(at(cyl(0.022, 0.022, 0.78, 4, M.metal()), x, dy, z));
  const stripes = [0xff5fa2, 0xffc53d, 0x2ed3c5, 0xff7a59, 0x7a4dff];
  for (let i = 0; i < 5; i++) B.root.add(at(box(0.22, 0.05, 1.0, B.P(stripes[i])), -0.44 + i * 0.22, dy + 0.78, -0.21));
  mast(B, 0.46, dy + 0.83, -0.62, 0.4, { light: false });
  const w = dynGroup(B, 0, 0.2, -1.26);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * TAU;
    w.add(at(box(0.5, 0.05, 0.2, B.P(0xff7a59), { center: true }), 0, Math.sin(a) * 0.18, Math.cos(a) * 0.18, { rx: -a }));
  }
  B.spin.push({ o: w, axis: 'x', idle: 0.3, gain: 6 });
  B.cargoZ = 0.25;
  B.top = Math.max(B.top, dy + 1.85);
  B.toot = 'PTOO!';
}

function buildContainerShip(B) {
  const blue = 0x2496ed, navy = 0x1d63b8, white = 0xf6f8fb;
  hull(B, { L: 4.5, B: 1.8, bow: 1.2, bowW: 0.62, sternW: 0.92, fb: 0.5, sheer: 0.22, draft: 0.34, stripe: [0.0, 0.24], rail: 0.1 },
    { paint: blue, stripe: 0xd8313b });
  const dy = B.deckY;
  cabin(B.root, 0, dy, -1.62, 1.3, 0.62, 0.7, B.P(white), B.P(navy));
  cabin(B.root, 0, dy + 0.69, -1.56, 1.56, 0.34, 0.44, B.P(white), B.P(navy));
  stack(B, 0, dy + 0.69, -1.88, 0.16, 0.6, navy, white, { smoke: 0xb3b6c3 });
  mast(B, 0.36, dy + 1.1, -1.5, 0.55);
  B.containerArea = { y: dy, z0: -1.12, z1: 1.28 };
  B.cargoZ = 1.6;
  B.top = Math.max(B.top, dy + 1.75);
  B.toot = 'BWOOOM!';
}

const CONTAINER_COLORS = [0xff5f5f, 0xffa53d, 0xffd23f, 0x3ddc84, 0x39c5e5, 0x7a4dff, 0xff5fa2, 0x2d7ff9];

// Containers: one per published port (min 2), two abreast, filled from the bow aft (so a small load is never hidden
// behind the bridge), three rows, then a second tier.
function containerStack(v, ports) {
  const area = v.B.containerArea;
  const g = new THREE.Group();
  g.name = 'containers';
  const n = clamp(Math.max(2, ports.length), 2, 12);
  for (let i = 0; i < n; i++) {
    const tier = Math.floor(i / 6), k = i % 6, row = Math.floor(k / 2), col = k % 2;
    const x = (col - 0.5) * 0.64, z = area.z1 - 0.4 - row * 0.8, y = area.y + tier * 0.46;
    const port = Number(ports[i]) || (i * 37 + 11);
    const color = CONTAINER_COLORS[(port * 7 + (port >> 3)) % CONTAINER_COLORS.length];
    const body = v.paint(color);
    g.add(at(box(0.6, 0.44, 0.74, body), x, y, z));
    g.add(at(box(0.62, 0.46, 0.05, v.paint(tintHex(color, -0.25))), x, y - 0.01, z + 0.35));
    g.add(at(box(0.62, 0.46, 0.05, v.paint(tintHex(color, -0.25))), x, y - 0.01, z - 0.35));
    g.add(at(box(0.04, 0.38, 0.6, v.paint(tintHex(color, 0.18))), x + (col ? 0.3 : -0.3), y + 0.03, z));
  }
  g.userData.vcPart = mergeStatic(g);
  return g;
}

function tintHex(hex, amt) {
  _c.setHex(hex);
  if (amt >= 0) _c.lerp(_c2.setHex(0xffffff), amt);
  else _c.lerp(_c2.setHex(0x000000), -amt);
  return _c.getHex();
}

const DB_COLORS = [[/postgres|\bpg/i, 0x336791], [/redis|valkey/i, 0xd82c20], [/mongo/i, 0x47a248], [/mysql|maria/i, 0x00758f],
  [/sql ?server|mssql/i, 0xcc2927], [/elastic|opensearch/i, 0xfec514], [/supabase/i, 0x3ecf8e], [/clickhouse/i, 0xfadb14]];

function buildTanker(B, r, port) {
  const hullC = 0x4a5468;
  const text = `${port?.label || ''} ${port?.proc || ''} ${port?.container?.image || ''}`;
  const tankC = (DB_COLORS.find(([re]) => re.test(text)) || [0, 0x39b6d6])[1];
  hull(B, { L: 3.0, B: 1.85, bow: 0.55, bowW: 0.8, sternW: 0.95, fb: 0.4, sheer: 0.1, draft: 0.32, stripe: [0.55, 0.8] },
    { paint: hullC, stripe: 0xffc53d });
  const dy = B.deckY;
  // the tank is the universal "database" icon: stacked drums with pale lids and a dome
  const T = at(new THREE.Group(), 0, dy, 0.18);
  const tm = B.P(tankC), lid = B.P(tintHex(tankC, 0.45));
  for (let k = 0; k < 3; k++) {
    T.add(at(cyl(0.64, 0.64, 0.27, 14, tm), 0, k * 0.3, 0));
    T.add(at(cyl(0.62, 0.62, 0.035, 14, lid), 0, k * 0.3 + 0.27, 0));
  }
  T.add(at(sphere(0.64, tm, { segments: 14, rings: 6 }), 0, 0.9, 0, { s: [1, 0.28, 1] }));
  T.add(at(cyl(0.035, 0.035, 0.25, 5, M.metalDark()), 0, 1.0, 0));
  T.add(at(torus(0.11, 0.025, 4, 8, M.red()), 0, 1.25, 0, { rx: Math.PI / 2 }));
  B.root.add(T);
  B.root.add(at(cyl(0.05, 0.05, 1.2, 6, M.metal(), { center: true }), 0.62, dy + 0.12, 0.2, { rx: Math.PI / 2 }));
  cabin(B.root, 0, dy, -1.12, 0.84, 0.46, 0.5, B.P(0xf1f3f7), B.P(hullC));
  stack(B, 0.26, dy + 0.53, -1.22, 0.09, 0.4, 0x2b2e3a, 0xffc53d, { seg: 8, rake: 0.05 });
  mast(B, -0.22, dy + 0.53, -1.12, 0.6);
  const horn = new THREE.Object3D();
  horn.position.set(0, dy + 1.35, 0.18);
  B.root.add(horn);
  B.horn = horn;
  B.cargoZ = 1.05;
  B.top = Math.max(B.top, dy + 1.45);
  B.toot = 'GLUG GLUG!';
}

function buildSub(B) {
  const yellow = 0xffd23f, orange = 0xff8a1f;
  const hm = B.P(yellow), om = B.P(orange);
  B.L = 3.1; B.beam = 1.0; B.bowZ = 1.45; B.sternZ = -1.65; B.deckY = 0.52; B.fb = 0.52;
  B.root.add(at(cyl(0.48, 0.48, 1.9, 10, hm, { center: true }), 0, 0.05, 0.05, { rx: Math.PI / 2 }));
  B.root.add(at(sphere(0.48, hm, { segments: 10, rings: 6 }), 0, 0.05, 1.0, { s: [1, 1, 0.95] }));
  B.root.add(at(cone(0.48, 0.75, 10, hm, { center: true }), 0, 0.05, -1.27, { rx: -Math.PI / 2 }));
  B.root.add(at(cyl(0.495, 0.495, 0.12, 10, om, { center: true }), 0, 0.05, 0.55, { rx: Math.PI / 2 }));
  B.root.add(at(box(0.36, 0.5, 0.74, hm), 0, 0.42, 0.1), at(box(0.42, 0.07, 0.8, om), 0, 0.92, 0.1));
  B.root.add(at(box(0.92, 0.035, 0.2, om), 0, 0.7, 0.3));
  portholes(B.root, 2, 0.72, -0.06, 0.2, 0.185, 0.06);
  portholes(B.root, 3, 0.1, -0.5, 0.65, 0.47, 0.085);
  // periscope (spins around to look about while submerged)
  const peri = dynGroup(B, 0, 0.99, 0.28);
  peri.add(at(cyl(0.035, 0.035, 0.62, 6, M.metalDark()), 0, 0, 0));
  peri.add(at(box(0.08, 0.08, 0.18, M.metalDark()), 0, 0.62, 0.05));
  peri.add(at(cyl(0.035, 0.035, 0.02, 6, glow(0x9ff4ff, 1.0), { center: true }), 0, 0.66, 0.145, { rx: Math.PI / 2 }));
  B.periscope = peri;
  B.root.add(at(box(0.9, 0.04, 0.3, om), 0, 0.05, -1.45), at(box(0.04, 0.72, 0.3, om), 0, -0.31, -1.45));
  const prop = dynGroup(B, 0, 0.05, -1.72);
  for (let i = 0; i < 4; i++) prop.add(at(box(0.06, 0.34, 0.03, M.metal(), { center: true }), 0, 0, 0, { rz: (i / 4) * TAU }));
  B.spin.push({ o: prop, axis: 'z', idle: 0.6, gain: 14 });
  mast(B, -0.11, 0.99, -0.14, 0.42);
  const horn = new THREE.Object3D();
  horn.position.set(0, 1.1, 0.1);
  B.root.add(horn);
  B.horn = horn;
  B.cargoZ = 0.72;
  B.top = 1.6;
  B.sub = true;
  B.toot = 'PING!';
}

function buildDinghy(B) {
  const grey = 0x9aa3af;
  hull(B, { L: 1.9, B: 0.95, bow: 0.65, bowW: 0.55, sternW: 0.8, fb: 0.3, sheer: 0.14, draft: 0.2, stripe: [0.8, 0.96], rail: 0.18, wall: 0.05 },
    { paint: grey, stripe: 0xd6dbe2 });
  const dy = B.deckY;
  B.root.add(at(box(0.84, 0.05, 0.16, M.wood()), 0, 0.2, 0.18), at(box(0.84, 0.05, 0.16, M.wood()), 0, 0.2, -0.45));
  for (const s of [1, -1]) {
    B.root.add(at(box(0.05, 0.035, 1.3, M.wood()), s * 0.28, 0.28, -0.12, { ry: s * 0.12 }));
    B.root.add(at(box(0.13, 0.025, 0.3, M.wood()), s * 0.36, 0.28, -0.82, { ry: s * 0.12 }));
  }
  B.root.add(at(cyl(0.09, 0.07, 0.16, 7, M.metal()), -0.2, dy, -0.7));
  mast(B, 0.28, dy, -0.72, 0.75, { light: false });
  B.cargoZ = 0.4;
  B.top = Math.max(B.top, 1.0);
  B.toot = 'toot.';
}

// 'lighthouse' belongs to Port Localhost; if a world ever hands us one anyway, it becomes a humble bell buoy.
function buildBuoy(B) {
  B.L = 1.0; B.beam = 1.0; B.bowZ = 0.5; B.sternZ = -0.5; B.deckY = 0.3; B.fb = 0.3;
  B.root.add(at(cyl(0.38, 0.46, 0.55, 8, B.P(0xff4d4d)), 0, -0.25, 0), at(cyl(0.39, 0.39, 0.12, 8, B.P(0xffffff)), 0, 0.02, 0));
  for (let i = 0; i < 4; i++) B.root.add(at(box(0.04, 0.7, 0.04, M.metalDark()), Math.cos(i * TAU / 4) * 0.22, 0.3, Math.sin(i * TAU / 4) * 0.22));
  B.root.add(at(cone(0.2, 0.22, 6, M.metal()), 0, 0.5, 0), at(sphere(0.1, glow(0xfff2b0, 1.4), { segments: 6, rings: 4 }), 0, 1.06, 0));
  const top = new THREE.Object3D();
  top.position.set(0, 1.15, 0);
  B.root.add(top);
  B.perch = B.horn = top;
  addFlag(B, 0.25, 1.0, 0, 0.7);
  B.root.add(at(cyl(0.02, 0.02, 0.4, 4, M.metalDark()), 0.25, 0.62, 0));
  B.cargoZ = 0.2;
  B.top = 1.3;
  B.toot = 'DONG!';
}

// Fishing-trip style per hull: route shape, cruise speed (units/s), turn rate (rad/s), gear.
const TRIP = {
  tug: { route: 'eight', speed: 1.5, turn: 0.95, gear: 'rods' },
  steamer: { route: 'eight', speed: 1.25, turn: 0.7, gear: 'net' },
  barge: { route: 'patrol', speed: 0.8, turn: 0.5, gear: null },
  sloop: { route: 'eight', speed: 1.4, turn: 0.85, gear: 'rods' },
  freighter: { route: 'eight', speed: 1.1, turn: 0.55, gear: 'net' },
  speedboat: { route: 'eight', speed: 2.3, turn: 1.3, gear: 'rods' },
  ferry: { route: 'loop', speed: 1.1, turn: 0.55, gear: 'net' },
  cutter: { route: 'eight', speed: 1.8, turn: 1.0, gear: 'rods' },
  llama: { route: 'circles', speed: 0.75, turn: 0.95, gear: null },
  ship: { route: 'loop', speed: 0.9, turn: 0.4, gear: null },
  tanker: { route: 'patrol', speed: 0.75, turn: 0.45, gear: null },
  sub: { route: 'eight', speed: 1.2, turn: 0.8, gear: null, dive: true },
  dinghy: { route: 'small', speed: 1.0, turn: 1.1, gear: 'rods' },
};

const KINDS = {
  node: { build: buildTug, name: 'Tugboat', trip: TRIP.tug },
  bun: { build: buildTug, name: 'Tugboat', trip: TRIP.tug },
  deno: { build: buildTug, name: 'Tugboat', trip: TRIP.tug },
  python: { build: buildSteamer, name: 'Steamer', trip: TRIP.steamer },
  php: { build: buildBarge, name: 'Barge', scale: 1.12, trip: TRIP.barge },
  ruby: { build: buildSloop, name: 'Sloop', trip: TRIP.sloop },
  java: { build: buildFreighter, name: 'Freighter', trip: TRIP.freighter },
  go: { build: buildSpeedboat, name: 'Speedboat', trip: TRIP.speedboat },
  dotnet: { build: buildFerry, name: 'Ferry', scale: 1.12, trip: TRIP.ferry },
  web: { build: buildCutter, name: 'Cutter', trip: TRIP.cutter },
  ai: { build: buildLlama, name: 'Llama pedalo', trip: TRIP.llama },
  docker: { build: buildContainerShip, name: 'Container ship', scale: 1.15, trip: TRIP.ship },
  db: { build: buildTanker, name: 'Tanker', scale: 1.12, trip: TRIP.tanker },
  browser: { build: buildSub, name: 'Submarine', trip: TRIP.sub },
  lighthouse: { build: buildBuoy, name: 'Bell buoy' },
  other: { build: buildDinghy, name: 'Dinghy', trip: TRIP.dinghy },
};

const normKind = (k) => (KINDS[k] ? k : 'other');

// ---- stevedores + packet crates: a few scene-wide InstancedMeshes shared by every vessel ------------------------------

const CREW_CAP = 240, CRATE_CAP = 900;
const SKIN = [0xffd6b0, 0xf0bd92, 0xd49a6a, 0xa86f48, 0x7c4f33];
const VEST = 0xff8a1f, CRATE = 0xc98d5a;
const S_SIT = 0, S_WALK = 1, S_PAUSE = 2, S_WAVE = 3;
const T_PICK = 1, T_DROP = 2, T_SEAT = 3;
const pools = new WeakMap();

function boxGeo(w, h, d, x, y, z) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return g.toNonIndexed();
}

class CrewPool {
  static acquire(scene) {
    let p = pools.get(scene);
    if (!p) { p = new CrewPool(scene); pools.set(scene, p); }
    p.refs++;
    return p;
  }

  constructor(scene) {
    this.scene = scene;
    this.refs = 0;
    this.meshes = [];
    this.group = new THREE.Group();
    this.group.name = 'harbor-crew';
    this.group.userData.noPick = true;
    scene.add(this.group);
    const body = new THREE.CylinderGeometry(0.095, 0.12, 0.27, 7);
    body.translate(0, 0.135, 0);
    const head = new THREE.IcosahedronGeometry(0.1, 0);
    head.translate(0, 0.36, 0);
    const hat = new THREE.CylinderGeometry(0.07, 0.1, 0.08, 7);
    hat.translate(0, 0.445, 0);
    const arms = concatGeos([boxGeo(0.05, 0.22, 0.05, 0.12, 0.33, 0.02), boxGeo(0.05, 0.22, 0.05, -0.12, 0.33, 0.02)]);
    const crate = new THREE.BoxGeometry(0.22, 0.2, 0.22);
    crate.translate(0, 0.1, 0);
    this.body = this.inst(body, CREW_CAP);
    this.head = this.inst(head, CREW_CAP);
    this.hat = this.inst(hat, CREW_CAP);
    this.arms = this.inst(arms, CREW_CAP);
    this.crate = this.inst(crate, CRATE_CAP);
    this.crewMeshes = [this.body, this.head, this.hat, this.arms];
    this.freeCrew = [];
    this.nCrew = 0;
    this.freeCrates = [];
    this.nCrate = 0;
  }

  inst(geo, cap) {
    const m = new THREE.InstancedMesh(geo, new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true }), cap);
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (let i = 0; i < cap; i++) m.setMatrixAt(i, ZERO_M);
    m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3).fill(1), 3);
    m.count = 0;
    m.frustumCulled = false;
    m.castShadow = false;
    m.receiveShadow = false;
    m.userData.noPick = true;
    this.group.add(m);
    this.meshes.push(m);
    return m;
  }

  allocCrew() {
    let i = this.freeCrew.pop();
    if (i === undefined) {
      if (this.nCrew >= CREW_CAP) return -1;
      i = this.nCrew++;
      for (const m of this.crewMeshes) m.count = this.nCrew;
    }
    return i;
  }

  freeCrewSlot(i) {
    if (i < 0) return;
    for (const m of this.crewMeshes) m.setMatrixAt(i, ZERO_M);
    this.freeCrew.push(i);
    this.touch();
  }

  allocCrate() {
    let i = this.freeCrates.pop();
    if (i === undefined) {
      if (this.nCrate >= CRATE_CAP) return -1;
      i = this.nCrate++;
      this.crate.count = this.nCrate;
    }
    return i;
  }

  freeCrateSlot(i) {
    if (i < 0) return;
    this.crate.setMatrixAt(i, ZERO_M);
    this.freeCrates.push(i);
    this.touch();
  }

  color(mesh, i, hex) {
    if (i < 0) return;
    mesh.setColorAt(i, _c.setHex(hex));
    mesh.instanceColor.needsUpdate = true;
  }

  touch() { for (const m of this.meshes) m.instanceMatrix.needsUpdate = true; }

  release() {
    if (--this.refs > 0) return;
    pools.delete(this.scene);
    this.group.parent?.remove(this.group);
    for (const m of this.meshes) { m.geometry.dispose(); m.material.dispose(); m.dispose?.(); }
  }
}

// Three stevedores per vessel: they haul crates between the boat's cargo spot and the landing while the port is busy
// (more of them the busier it is), sit on the crate pile when it is quiet, and doze off when it stays quiet.
// Positions are in the vessel group's frame; anything on the boat side of the gap also rides the boat's heave.
class Dockhands {
  constructor(v) {
    this.v = v;
    this.pool = CrewPool.acquire(v.engine.scene);
    this.crew = [];
    this.packets = [];
    this.packetAcc = 0;
    this.hidden = false;
    this.deckSlots = [];              // catch crates aboard (float frame)
    this.landSlots = [];              // unloaded catch on the landing (group frame)
    const r = v.seed;
    for (let i = 0; i < 3; i++) {
      this.crew.push({
        i, slot: this.pool.allocCrew(), crate: this.pool.allocCrate(), mode: S_SIT, task: 0,
        x: 0, y: 0, z: 0, ry: Math.PI, droop: 0, carry: false, fx: 0, fy: 0, fz: 0, tx: 0, ty: 0, tz: 0, s: 0, len: 1,
        wait: 0.3 + i * 0.5, ph: r() * TAU, skin: SKIN[Math.floor(r() * SKIN.length)], dir: i === 1 ? 1 : 0,
      });
    }
    this.seatAll();
    this.recolor();
  }

  seatAll() {
    const S = this.v.spots;
    for (const c of this.crew) {
      const st = S.seats[c.i];
      c.x = st.x; c.y = st.y; c.z = st.z; c.ry = st.ry; c.mode = S_SIT; c.carry = false; c.task = 0;
    }
  }

  recolor() {
    const P = this.pool, f = this.v.flagHex;
    const capHex = f === PAL.white ? 0xd8313b : f;
    for (const c of this.crew) {
      P.color(P.body, c.slot, VEST);
      P.color(P.arms, c.slot, VEST);
      P.color(P.head, c.slot, c.skin);
      P.color(P.hat, c.slot, capHex);
      P.color(P.crate, c.crate, CRATE);
    }
  }

  // Where stevedore c stands at the boat (0) or on the landing (1).
  spot(c, which, out) {
    const S = this.v.spots, off = (c.i - 1) * 0.2, n = S.n;
    const base = which === 0 ? S.boat : S.land, back = which === 0 ? -Math.abs(off) * 0.6 : Math.abs(off) * 0.4;
    return out.set(base.x - n.z * off + n.x * back, base.y, base.z + n.x * off + n.z * back);
  }

  // Distance along the boat -> landing path (0 at the boat spot); below S.edge you are standing on the boat.
  along(x, z) {
    const S = this.v.spots;
    return (x - S.boat.x) * S.n.x + (z - S.boat.z) * S.n.z;
  }

  walk(c, x, y, z, task) {
    c.fx = c.x; c.fy = c.y; c.fz = c.z;
    c.tx = x; c.ty = y; c.tz = z;
    c.len = Math.max(0.05, Math.hypot(x - c.x, z - c.z));
    c.s = 0;
    c.mode = S_WALK;
    c.task = task;
    c.droop = 0;
  }

  // While there is catch aboard everyone unloads (boat -> landing); otherwise half load, half unload.
  goPick(c) { c.cur = this.v.hold > 0 ? 0 : c.dir; this.spot(c, c.cur === 0 ? 0 : 1, _v2); this.walk(c, _v2.x, _v2.y, _v2.z, T_PICK); }
  goDrop(c) { this.spot(c, c.cur === 0 ? 1 : 0, _v2); this.walk(c, _v2.x, _v2.y, _v2.z, T_DROP); }
  goSeat(c) { const st = this.v.spots.seats[c.i]; this.walk(c, st.x, st.y, st.z, T_SEAT); }

  tick(dt, t, G, visible) {
    const v = this.v, P = this.pool;
    const moored = v.mode === 'moored' && !v.subDown && !v.adriftOn && v.slipK < 0.05;   // nobody works an adrift boat
    const act = v.act;
    const actWant = !moored ? 0 : act > 0.62 ? 3 : act > 0.3 ? 2 : act > 0.06 ? 1 : 0;
    const want = moored ? Math.max(actWant, Math.min(3, v.hold)) : 0;
    const speed = 0.75 + Math.max(act, v.hold > 0 ? 0.5 : 0) * 0.6;
    if (v.landed > 0) {                 // the landed catch goes off to market, one crate at a time
      v.landedT += dt;
      if (v.landedT > 30) { v.landedT = 28.5; v.landed--; }
    }
    for (const c of this.crew) {
      const working = c.i < want;
      if (v.mode === 'depart' && c.mode !== S_WAVE) {
        const st = v.spots.seats[c.i];
        c.x = st.x; c.z = st.z; c.y = v.spots.land.y; c.carry = false; c.mode = S_WAVE; c.droop = 0;
        c.ry = Math.PI;
        if (c.catch) { c.catch = false; P.color(P.crate, c.crate, CRATE); }
      }
      if (c.mode === S_SIT) {
        c.droop = damp(c.droop, v.idleFor > 24 ? 1 : 0, 1.2, dt);
        if (working) { c.wait -= dt; if (c.wait <= 0) this.goPick(c); } else c.wait = 0.25 + c.i * 0.45;
      } else if (c.mode === S_WALK) {
        c.s += (dt * speed) / c.len;
        const k = Math.min(1, c.s);
        c.x = lerp(c.fx, c.tx, k); c.y = lerp(c.fy, c.ty, k); c.z = lerp(c.fz, c.tz, k);
        c.ry = Math.atan2(c.tx - c.fx, c.tz - c.fz);
        if (k >= 1) {
          if (c.task === T_SEAT) { c.mode = S_SIT; c.ry = v.spots.seats[c.i].ry; } else { c.mode = S_PAUSE; c.wait = 0.28; }
        }
      } else if (c.mode === S_PAUSE) {
        c.wait -= dt;
        if (c.wait <= 0) {
          if (c.task === T_PICK) {
            if (c.cur === 0 && v.hold > 0) { v.hold--; c.catch = true; P.color(P.crate, c.crate, CATCH); c.carry = true; this.goDrop(c); }
            else if (c.i < actWant) { c.carry = true; this.goDrop(c); }
            else { c.carry = false; this.goSeat(c); }
          } else {
            if (c.catch) { c.catch = false; v.landed = Math.min(FISHING.HOLD_MAX, v.landed + 1); v.landedT = 0; P.color(P.crate, c.crate, CRATE); }
            c.carry = false;
            working ? this.goPick(c) : this.goSeat(c);
          }
        }
      }
      this.write(c, t, G, visible && !this.hidden);
    }
    this.tickPackets(dt, G, visible && !this.hidden, moored);
    this.writeStacks(G, visible && !this.hidden);
    P.touch();
  }

  syncSlots(arr, n) {
    const P = this.pool;
    while (arr.length < n) {
      const s = P.allocCrate();
      if (s < 0) break;
      P.color(P.crate, s, CATCH);
      arr.push(s);
    }
    while (arr.length > n) P.freeCrateSlot(arr.pop());
  }

  // Catch crates: a little stack on deck (rides the boat) and the unloaded pile on the landing.
  writeStacks(G, visible) {
    const v = this.v, P = this.pool;
    const nd = visible ? Math.min(FISHING.HOLD_MAX, v.hold) : 0;
    this.syncSlots(this.deckSlots, nd);
    if (nd) {
      const F = v.float.matrixWorld, cm = v.cargoM;
      for (let i = 0; i < nd; i++) {
        const col = i % 2, row = (i >> 1) % 2, tier = i >> 2;
        _p.set((col - 0.5) * 0.23, cm.y + tier * 0.17, cm.z + (row - 0.5) * 0.23);
        _e.set(0, (i * 0.37) % 0.3, 0);
        _q.setFromEuler(_e);
        _s.setScalar(0.82);
        P.crate.setMatrixAt(this.deckSlots[i], _m.compose(_p, _q, _s).premultiply(F));
      }
    }
    const nl = visible && v.shore.visible ? v.landed : 0;
    this.syncSlots(this.landSlots, nl);
    if (nl) {
      const S = v.spots, cp = S.catchPile, n = S.n;
      for (let i = 0; i < nl; i++) {
        const col = i % 2, row = (i >> 1) % 2, tier = i >> 2;
        const a = (col - 0.5) * 0.25, b = (row - 0.5) * 0.25;
        _p.set(cp.x - n.z * a + n.x * b, cp.y + tier * 0.18, cp.z + n.x * a + n.z * b);
        _e.set(0, (i * 0.53) % 0.4, 0);
        _q.setFromEuler(_e);
        _s.setScalar(0.85);
        P.crate.setMatrixAt(this.landSlots[i], _m.compose(_p, _q, _s).premultiply(G));
      }
    }
  }

  write(c, t, G, visible) {
    const P = this.pool;
    if (c.slot < 0) return;
    if (!visible) {
      P.body.setMatrixAt(c.slot, ZERO_M); P.head.setMatrixAt(c.slot, ZERO_M); P.hat.setMatrixAt(c.slot, ZERO_M);
      P.arms.setMatrixAt(c.slot, ZERO_M);
      if (c.crate >= 0) P.crate.setMatrixAt(c.crate, ZERO_M);
      return;
    }
    const v = this.v, S = v.spots;
    let y = c.y, tilt = 0, sy = 1;
    const al = this.along(c.x, c.z);
    if (c.mode === S_WALK) {
      const g = clamp((al - S.edge) / (S.landEdge - S.edge), 0, 1);
      y = lerp(S.boat.y + v.heave, S.land.y, g) + Math.abs(Math.sin(t * 11 + c.ph)) * 0.035;
      if (g > 0 && g < 1) y += Math.sin(Math.PI * g) * 0.22;
    } else if (al < S.edge) y += v.heave;
    if (c.mode === S_SIT) {
      y -= 0.03; sy = 0.88; tilt = 0.3 * c.droop;
    } else if (c.mode === S_PAUSE) {
      tilt = 0.35;
    } else if (c.mode === S_WAVE) {
      y += Math.max(0, Math.sin(t * 7 + c.ph)) * 0.09;
    }
    _e.set(tilt, c.ry, 0);
    _q.setFromEuler(_e);
    _p.set(c.x, y, c.z);
    _s.set(1, sy, 1);
    _m.compose(_p, _q, _s).premultiply(G);
    P.body.setMatrixAt(c.slot, _m);
    if (c.droop > 0.01) _m2.makeTranslation(0, -0.07 * c.droop, 0.08 * c.droop).premultiply(_m);
    else _m2.copy(_m);
    P.head.setMatrixAt(c.slot, _m2);
    P.hat.setMatrixAt(c.slot, _m2);
    P.arms.setMatrixAt(c.slot, c.carry || c.mode === S_WAVE ? _m : ZERO_M);
    if (c.crate >= 0) {
      if (c.carry) P.crate.setMatrixAt(c.crate, _m3.makeTranslation(0, 0.45, 0.02).premultiply(_m));
      else P.crate.setMatrixAt(c.crate, ZERO_M);
    }
  }

  // Little data packets (cyan = requests coming in, gold = responses going out) hop between boat and landing.
  tickPackets(dt, G, visible, moored) {
    const v = this.v, P = this.pool, S = v.spots;
    if (moored && v.act > 0.12 && this.packets.length < 5) {
      this.packetAcc += dt * v.act * v.act * 3.4;
      if (this.packetAcc >= 1) {
        this.packetAcc = 0;
        const slot = P.allocCrate();
        if (slot >= 0) {
          const dir = rand() < 0.5 ? 0 : 1;
          this.packets.push({ slot, s: 0, dur: 1.0 + rand() * 0.5, dir, off: (rand() - 0.5) * 0.35, spin: rand() * TAU });
          P.color(P.crate, slot, dir ? 0xffc53d : 0x39e5ff);
        }
      }
    }
    for (let i = this.packets.length - 1; i >= 0; i--) {
      const p = this.packets[i];
      p.s += dt / p.dur;
      if (p.s >= 1 || !moored) { P.freeCrateSlot(p.slot); this.packets.splice(i, 1); continue; }
      if (!visible) { P.crate.setMatrixAt(p.slot, ZERO_M); continue; }
      const a = p.dir ? S.boat : S.land, b = p.dir ? S.land : S.boat, k = p.s;
      const x = lerp(a.x, b.x, k) - S.n.z * p.off, z = lerp(a.z, b.z, k) + S.n.x * p.off;
      const g = clamp((this.along(x, z) - S.edge) / (S.landEdge - S.edge), 0, 1);
      const y = lerp(S.boat.y + v.heave, S.land.y, g) + Math.abs(Math.sin(Math.PI * 3 * k)) * 0.3;
      const sc = 0.55 * Math.min(1, k * 7, (1 - k) * 7);
      _e.set(0, p.spin + k * 5, 0);
      _q.setFromEuler(_e);
      _p.set(x, y, z);
      _s.setScalar(Math.max(sc, 0.001));
      P.crate.setMatrixAt(p.slot, _m.compose(_p, _q, _s).premultiply(G));
    }
  }

  allDozing() {
    for (const c of this.crew) if (c.mode !== S_SIT || c.droop < 0.6) return false;
    return true;
  }

  allSeated() {
    for (const c of this.crew) if (c.mode !== S_SIT) return false;
    return true;
  }

  dispose() {
    for (const c of this.crew) { this.pool.freeCrewSlot(c.slot); this.pool.freeCrateSlot(c.crate); }
    for (const p of this.packets) this.pool.freeCrateSlot(p.slot);
    this.syncSlots(this.deckSlots, 0);
    this.syncSlots(this.landSlots, 0);
    this.crew.length = 0;
    this.packets.length = 0;
    this.pool.release();
  }
}

// ---- fishing trips: shared pieces -----------------------------------------------------------------------------------
// A docked boat whose port gets used casts off, works a route in open water off its dock (each vessel has its own lane
// and phase), lands a fish for every fresh burst of activity, and heads home after RETURN_AFTER quiet seconds, where
// the stevedores unload the catch. Boats steer smoothly (shortest-arc yaw, per-kind speed and turn rate), keep clear
// of island / islet / platform / harbour discs and of each other.

export const FISHING = {
  ACT_ON: 0.08,        // port.activity that counts as "being used" (so does port.lastActive moving forward)
  DOCK_MIN: 8,         // seconds docked before a boat may leave again (anti-flap)
  RETURN_AFTER: 35,    // seconds without activity before it heads home
  CATCH_EVERY: 12,     // sustained activity lands one fish per this many seconds (a fresh burst always does)
  HOLD_MAX: 8,         // catch crates shown aboard / on the landing
  MARGIN: 3.2,         // soft clearance kept from island discs (piers stick out this far)
  LOOK: 2.4,           // pursuit look-ahead along the route
};
const CATCH = 0x2fa7d8;  // catch crates: ice-blue

// Every live vessel, for separation steering and the gulls (plain array: no iterator garbage per frame).
const FLEET = [];
let prioSeq = 0;
const _rp = { x: 0, z: 0 }, _rl = { x: 0, z: 0 };
// Route placement attempts: [swing (rad) away from straight out, scale]. First clear one wins.
const ROUTE_TRY = [];
const APPROACH = [6.5, 5.2, 4, 3];
const HEADING_TRY = [0, 0.3, -0.3, 0.6, -0.6, 0.9, -0.9, 1.2, -1.2, 1.5, -1.5, 1.8, -1.8];
for (const rot of [0, 0.35, -0.35, 0.7, -0.7, 1.05, -1.05]) for (const sc of [1, 0.8, 0.62, 0.48]) ROUTE_TRY.push([rot, sc]);

// Obstacle discs { x, z, r } (r = hard radius, the margin is added by the steering), refreshed once a second.
const obstacleCache = new WeakMap();
function obstaclesOf(world, now) {
  let c = obstacleCache.get(world);
  if (!c) { c = { t: -1e9, n: 0, list: [] }; obstacleCache.set(world, c); }
  if (now >= c.t && now - c.t < 1) return c;
  c.t = now;
  c.n = 0;
  const add = (x, z, r) => {
    if (!Number.isFinite(x) || !Number.isFinite(z) || !(r > 0)) return;
    let o = c.list[c.n];
    if (!o) o = c.list[c.n] = { x: 0, z: 0, r: 0 };
    o.x = x; o.z = z; o.r = r;
    c.n++;
  };
  try {
    const lay = world.layout;
    if (lay?.forEach) lay.forEach((o) => { if (o) add(o.x, o.z, (Number(o.r) || 7) + 0.6); });
    if (world.islands?.forEach) {
      world.islands.forEach((isl, id) => {
        const p = isl?.group?.position || isl?.position;
        if (!p) return;
        if (!lay?.has?.(id)) add(p.x, p.z, (Number(isl.radius) || 6) + 0.6);
        isl.annexes?.forEach?.((a) => { if (a) add(p.x + a.x, p.z + a.z, (Number(a.R) || 4) + 0.6); });
        if (Array.isArray(isl.platforms)) for (const pl of isl.platforms) if (pl && !pl.gone) add(p.x + pl.x, p.z + pl.z, 3.4);
      });
    }
    const town = world.town, tp = town?.group?.position || town?.position;
    if (tp) add(tp.x, tp.z, (Number(town.radius) || 7) + 0.6);
  } catch (e) { /* the world is mid-update; keep what we have */ }
  return c;
}

// A leaping fish (orange, so it reads against the sea). One shared merged geometry.
let FISH_GEO = null;
function fishMesh() {
  if (!FISH_GEO) {
    const g = new THREE.Group();
    g.add(at(sphere(0.14, mat(0xff9a3c), { segments: 7, rings: 5 }), 0, 0, 0, { s: [0.55, 0.85, 1.45] }));
    g.add(at(cone(0.13, 0.2, 4, mat(0xff7a1f)), 0, 0, -0.42, { rx: Math.PI / 2 }));
    g.add(at(box(0.02, 0.1, 0.14, mat(0xffd23f)), 0, 0.12, 0));
    g.add(at(sphere(0.026, M.black(), { segments: 4, rings: 3 }), 0.07, 0.04, 0.13), at(sphere(0.026, M.black(), { segments: 4, rings: 3 }), -0.07, 0.04, 0.13));
    FISH_GEO = mergeStatic(g).vc.geometry;
    FISH_GEO.userData.shared = true;
  }
  const m = new THREE.Mesh(FISH_GEO, VC_MAT);
  m.castShadow = false;
  m.visible = false;
  return m;
}

const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

// Adrift boats (port.adrift): how far they slip off the berth (units, at full stretch), and the rope's slack-then-taut
// cycle (s): drift out until the line snaps taut, get tugged back, repeat.
const DRIFT = 0.85;
const DRIFT_PERIOD = 7.5;

// ---- labels ---------------------------------------------------------------------------------------------------------

const LABEL_CSS = `
.hb-lbl .l1{gap:.36em}
.hb-lbl .hb-fl{display:inline-block;width:.74em;height:.74em;border-radius:.2em;background:var(--fc,#fff);box-shadow:0 0 0 .13em rgba(0,0,0,.5);flex:none}
.hb-lbl .hb-pt{font-family:var(--font-title,"Lilita One"),"Arial Black",sans-serif;font-weight:400;color:#39e5ff;letter-spacing:.02em}
.hb-lbl.busy .lbl-card{border-color:rgba(61,220,132,.85)}
.hb-lbl.busy .hb-pt{color:#7dffb0}
.hb-lbl.worn .lbl-card{background:linear-gradient(180deg,rgba(78,54,38,.93),rgba(48,33,24,.9));border-color:rgba(214,150,100,.55)}
.hb-lbl.worn .lbl-card::after{border-top-color:rgba(48,33,24,.9)}
.hb-lbl.worn .hb-pt{color:#f0bf92}
.hb-lbl.adrift .lbl-card{border-color:rgba(255,159,58,.85)}
.hb-lbl .st-adrift{font-size:.66em}
#labels.lod-far .hb-lbl .name{display:none}
.hb-zzz{display:flex;gap:.08em;font-family:var(--font-title,"Lilita One"),"Arial Black",sans-serif;font-size:1.05em;color:#fff;
  -webkit-text-stroke:.08em #1b1433;paint-order:stroke}
.hb-zzz b{display:inline-block;font-weight:400;opacity:0;animation:hbzz 2.6s ease-in-out infinite}
.hb-zzz b:nth-child(2){animation-delay:.55s;font-size:1.2em}
.hb-zzz b:nth-child(3){animation-delay:1.1s;font-size:1.45em}
@keyframes hbzz{0%{opacity:0;transform:translate(0,.4em)}30%{opacity:1}100%{opacity:0;transform:translate(.55em,-1.2em)}}
#labels.lod-far .hb-zzz-lbl{display:none}
.hb-sum .lbl-card{padding:.24em .58em .3em;border-color:rgba(57,229,255,.5)}
.hb-sum .l1{gap:.32em;font-weight:700;font-size:.9em;color:#cfe6ff}
.hb-sum .hb-anc{font-size:1.15em;line-height:1;filter:drop-shadow(0 1px 0 rgba(0,0,0,.5))}
.hb-sum b{font-family:var(--font-title,"Lilita One"),"Arial Black",sans-serif;font-weight:400;font-size:1.12em;color:#39e5ff}
.hb-sum .hb-sep{opacity:.45}
.hb-sum .hb-busy{color:#7dffb0}
.hb-sum .hb-adr{color:#ffb35a}
.hb-sum.adrift .lbl-card{border-color:rgba(255,159,58,.8)}
.hb-sum:hover .lbl-card,.hb-sum.peek .lbl-card{border-color:rgba(57,229,255,.95);box-shadow:0 0 0 1px rgba(57,229,255,.4),0 .35em .9em rgba(0,0,0,.3)}
`;
const cssDone = new WeakSet();
const UP = new THREE.Vector3(0, 1, 0);

// Stretch a unit-height centred cylinder from P to Q.
function span(m, P, Q) {
  _p.subVectors(Q, P);
  const len = _p.length();
  m.position.copy(P).addScaledVector(_p, 0.5);
  m.scale.set(1, Math.max(len, 0.01), 1);
  m.quaternion.setFromUnitVectors(UP, _p.multiplyScalar(1 / Math.max(len, 1e-4)));
}

function portList(p) {
  if (Array.isArray(p?.ports) && p.ports.length) return p.ports;
  return p?.port != null ? [p.port] : [];
}

// ---- harbor label clusters (ROADMAP H1) ---------------------------------------------------------------------------------
// Every island (and Port Localhost) with docks is a Harbor: its vessels' labels form one labels.js cluster, and while the
// view is not zoomed in a harbor with CLUSTER_MIN or more boats shows one summary tag instead ("⚓ 11 docks · 2 busy ·
// 1 adrift") at the middle of its berths, as a member of the host's label stack (the island / town name floats above
// it). Clicking the tag zooms in on the harbor, which unfolds it.

const CLUSTER_MIN = 5;
const CLUSTER_ZOOM = 1.5;          // clicking a summary tag zooms in to at least this (labels.js lod-near starts at 1.3)
const harborsOf = new WeakMap();   // labels layer -> Map(cluster name -> Harbor)

class Harbor {
  constructor(engine, name, stack) {
    this.engine = engine;
    this.name = name;
    this.stack = stack;
    this.ships = new Set();
    this.pos = new THREE.Vector3();
    this.tag = null;
    this.html = '';
    this.adrift = false;
  }

  static of(vessel) {
    const L = vessel.engine.labels;
    if (!L?.cluster) return null;
    const host = vessel.dock?.owner;
    const hid = host?.id ?? (vessel.port.island || 'town');
    const town = host ? host.kind === 'town' : !vessel.port.island;
    const name = `harbor:${hid}`;
    let map = harborsOf.get(L);
    if (!map) harborsOf.set(L, (map = new Map()));
    let h = map.get(name);
    if (!h) map.set(name, (h = new Harbor(vessel.engine, name, host ? (town ? 'town' : `island:${hid}`) : null)));
    return h;
  }

  join(v) {
    this.ships.add(v);
    if (!this.tag) {
      try {
        this.tag = this.engine.labels.cluster(this.name, {
          position: this.pos, html: '', className: 'hb-sum', min: CLUSTER_MIN,
          stack: this.stack ? { group: this.stack, role: 'member' } : null, onClick: () => this.focus(),
        });
      } catch (e) { console.error('[harbor] cluster tag failed', e); }
    }
    this.place();
    this.refresh();
  }

  leave(v) {
    if (!this.ships.delete(v)) return;
    if (this.ships.size) { this.place(); this.refresh(); return; }
    this.tag?.remove();
    this.tag = null;
    harborsOf.get(this.engine.labels)?.delete(this.name);
  }

  // The tag floats over the middle of the berths.
  place() {
    let x = 0, z = 0, n = 0;
    for (const v of this.ships) { x += v.group.position.x; z += v.group.position.z; n++; }
    if (!n) return;
    this.pos.set(x / n, 3.1, z / n);
    this.tag?.setPosition(this.pos);
  }

  // Counts live boats (not the ones casting off for good). Called when a boat joins, leaves or changes busy / adrift.
  refresh() {
    let n = 0, busy = 0, adrift = 0;
    for (const v of this.ships) {
      if (v.mode === 'depart' || v.mode === 'gone') continue;
      n++;
      if (v.lblBusy) busy++;
      if (v.lblAdrift) adrift++;
    }
    const sep = '<span class="hb-sep">·</span>';
    const html = `<div class="lbl-card"><div class="l1"><span class="hb-anc">⚓</span>` +
      (n ? `<b>${n}</b>${n === 1 ? 'dock' : 'docks'}` : 'casting off') +
      (busy ? `${sep}<b class="hb-busy">${busy}</b>busy` : '') +
      (adrift ? `${sep}<b class="hb-adr">${adrift}</b>adrift` : '') + '</div></div>';
    if (html === this.html) return;
    this.html = html;
    this.tag?.set(html);
    if (!!adrift !== this.adrift) { this.adrift = !!adrift; this.tag?.setClass?.('adrift', this.adrift); }
  }

  focus() {
    const view = this.engine.view;
    if (!view?.focus) return;
    view.markInput?.();
    _v.set(this.pos.x, 0.5, this.pos.z);
    view.focus(_v, { zoom: Math.max(view.zoom || 1, CLUSTER_ZOOM), secs: this.engine.settings?.reduceMotion ? 0 : 0.9 });
  }
}

// ---- Vessel -------------------------------------------------------------------------------------------------------------

export class Vessel {
  constructor(world, port, dock, { instant = false } = {}) {
    this.world = world || {};
    this.engine = this.world.engine || {};
    this.port = port || {};
    this.id = this.port.id ?? String(this.port.port ?? '?');
    this.dock = dock || {};
    this.kind = normKind(this.port.kind);
    this.seed = rng('vessel:' + this.id);
    this.phase = this.seed() * TAU;
    this.listDir = this.seed() < 0.5 ? -1 : 1;
    this.turnDir = this.seed() < 0.5 ? -1 : 1;
    this.time = 0;
    this.tAct = clamp(Number(this.port.activity) || 0, 0, 1);
    this.act = instant ? this.tAct : 0;
    this.idleFor = this.tAct > 0.06 ? 0 : 40;
    this.quietFor = this.tAct >= 0.12 ? 0 : 60;
    this.lastToot = -99;
    this.restarts = this.port.restarts | 0;
    this.wear = 0; this.wearShown = -1; this.list = 0; this.painting = false; this.wearClock = 0.5;
    this.heave = 0; this.hop = 0; this.bumpT = -1; this.tootT = -1; this.speed = 0; this.prevX = 0; this.prevZ = 0;
    this.smokeAcc = 0; this.smokeI = 0; this.bubbleAcc = 0;
    this.subState = 'up'; this.subT = 6 + this.seed() * 6; this.subY = 0; this.subDown = false;
    this.subK = 0; this.subIdleDown = false; this.surfaceT = 0;
    this.mode = 'moored'; this.mt = 0;
    // fishing trips
    this.trip = null; this.tripStyle = null; this.trips = 0; this.catches = 0; this.hold = 0; this.landed = 0; this.landedT = 0;
    this.dockedFor = 0; this.lastSignalAt = -1e9; this.lastCatchAt = -1e9; this.prevSignal = false;
    this.prevLA = Number(this.port.lastActive);
    this.wx = 0; this.wz = 0; this.wyaw = 0; this.wr = 1; this.vel = 0; this.ax = 0; this.az = 0; this.crowd = 0;
    this.fish = null; this.fishK = -1; this.gear = null; this.prio = ++prioSeq;
    // adrift (port.adrift): driftK drives the look (torn flag droop, list, bob), slipK the pull off the berth
    this.adriftOn = !!this.port.adrift;
    this.driftK = this.slipK = this.adriftOn && instant ? 1 : 0;
    this.tug = 0; this.rope2 = null; this.ropeRest = 0;
    this.timers = [];
    this.paints = new Map();
    this.flagHex = this.flagColor();

    this.group = new THREE.Group();
    this.group.name = `vessel:${this.id}`;
    this.boat = new THREE.Group();
    this.float = new THREE.Group();
    this.shore = new THREE.Group();
    this.boat.add(this.float);
    this.group.add(this.boat, this.shore);

    this.buildModel();
    this.applyFlag();
    this.place();
    this.buildShore();
    this.crew = this.engine.scene ? new Dockhands(this) : null;
    this.wr = this.halfLen * 0.72 + this.beam * 0.2;
    this.readLocalPose();
    FLEET.push(this);
    this.initLabel();
    this.applySign();
    this.updateWear(true);
    if (!instant) this.startArrival();
    ensureSeaLife(this.world);
  }

  // ---- building ---------------------------------------------------------------------------------------------------

  paint(hex) {
    let m = this.paints.get(hex);
    if (!m) {
      m = mat(hex, { unique: true });
      m.userData.shared = true;             // owned by this vessel (disposed in dispose()), not by disposeTree
      m.userData.paintHex = hex;
      this.paints.set(hex, m);
      if (this.wear > 0) wornColor(m.color, hex, this.wear);
    }
    return m;
  }

  flagColor() {
    const owner = this.port.owner;
    if (!owner) return PAL.white;
    const list = this.world.snapshot?.sessions;
    const s = Array.isArray(list) ? list.find((x) => x && x.key === owner) : null;
    const f = s?.faction || this.world.buildings?.get?.(owner)?.faction;
    return f ? factionPal(f).main : PAL.white;
  }

  // Flag panels: the owner's colour, or torn and bleached while adrift.
  applyFlag() {
    const torn = this.adriftOn, m = mat(torn ? fadedHex(this.flagHex) : this.flagHex);
    for (const f of this.B.flags) {
      const [a, b] = f.meshes;
      if (!f.geo) f.geo = [a.geometry, b.geometry];
      a.geometry = torn ? tornFlagGeo(0, f.s) : f.geo[0];
      b.geometry = torn ? tornFlagGeo(1, f.s) : f.geo[1];
      a.material = b.material = m;
    }
  }

  buildModel() {
    const B = {
      v: this, root: new THREE.Group(), P: (hex) => this.paint(hex), flagColor: this.flagHex,
      flags: [], stacks: [], spin: [], perch: null, horn: null, top: 0, sails: null, siren: null, periscope: null, sub: false,
    };
    B.root.name = 'model';
    try {
      KINDS[this.kind].build(B, this.seed, this.port, this.kind);
    } catch (e) {
      console.error('[harbor] vessel build failed, using a dinghy', this.kind, e);
      disposeTree(B.root);
      Object.assign(B, { root: new THREE.Group(), flags: [], stacks: [], spin: [], perch: null, horn: null, top: 0, sails: null, siren: null, periscope: null, sub: false, containerArea: null });
      buildDinghy(B);
    }
    this.vcParts = [mergeStatic(B.root)];
    for (const s of B.spin) this.vcParts.push(mergeStatic(s.o));
    if (B.sails) this.vcParts.push(mergeStatic(B.sails));
    if (B.periscope) this.vcParts.push(mergeStatic(B.periscope));
    this.float.add(B.root);
    this.model = B.root;
    this.B = B;
    this.S = KINDS[this.kind].scale ?? 1.2;           // models are authored small; the float scales them up
    this.float.scale.setScalar(this.S);
    this.halfLen = ((B.L || 2.4) / 2) * this.S;
    this.beam = (B.beam || 1.2) * this.S;
    if (B.containerArea) this.rebuildContainers();
    this.buildWear();
  }

  rebuildContainers() {
    if (!this.B?.containerArea) return;
    if (this.containers) {
      this.vcParts = this.vcParts.filter((p) => p !== this.containers.userData.vcPart);
      disposeTree(this.containers);
    }
    const ports = portList(this.port);
    this.containers = containerStack(this, ports);
    this.containers.userData.dynamic = true;
    this.model.add(this.containers);
    this.containerKey = ports.join(',');
    const part = this.containers.userData.vcPart;
    this.vcParts.push(part);
    tintRanges(part, this.wear);
  }

  buildWear() {
    const B = this.B, hl = (B.L || 2.4) / 2, hb = (B.beam || 1.2) / 2, fb = B.fb ?? 0.4;
    const r = rng('wear:' + this.id);
    const g = new THREE.Group();
    g.name = 'wear';
    const patches = new THREE.Group();
    const pm = [mat(0x8b93a3), mat(0x6f5a4a), mat(0xa0826d)];
    // random sizes come from scaling unit primitives: kit caches geometry by size, so random dimensions would add
    // new cached geometries for every boat ever built
    for (let i = 0; i < 5; i++) {
      const side = i % 2 ? 1 : -1, z = lerp(-hl * 0.65, hl * 0.3, r()), y = lerp(0.04, fb * 0.7, r());
      const ph = 0.14 + r() * 0.1, pd = 0.18 + r() * 0.12;
      patches.add(at(box(0.05, 1, 1, pm[i % 3], { center: true }), side * (hb + 0.005), y, z, { rx: (r() - 0.5) * 0.6, s: [1, ph, pd] }));
    }
    const barn = new THREE.Group();
    const bm = [mat(0xe4ddcf), mat(0x6d8f5a), mat(0xcfc6b3)];
    for (let i = 0; i < 16; i++) {
      const side = i % 2 ? 1 : -1, z = lerp(-hl * 0.85, hl * 0.55, r());
      const br = 0.045 + r() * 0.035;
      barn.add(at(ico(1, 0, bm[i % 3]), side * hb * 0.93, 0.0 + r() * 0.1, z, { s: br }));
    }
    mergeStatic(patches);
    mergeStatic(barn);
    const sale = new THREE.Group();
    const board = textSign('4 SALE', { w: 0.64, h: 0.32, bg: '#f4ecd6', fg: '#c62828', border: '#7a4b2b', font: 'bold 76px "Comic Sans MS", "Chalkboard SE", "Marker Felt", cursive' });
    board.position.set(0, 0.36, 0.02);
    board.rotation.z = -0.09;
    sale.add(board, at(box(0.04, 0.36, 0.04, M.woodDark()), 0, 0, 0));
    sale.position.set(hb * 0.45, (B.deckY ?? 0.35) + 0.02, -hl * 0.3);
    const gull = gullModel();
    gull.wl.rotation.y = 1.25; gull.wr.rotation.y = -1.25;
    const perch = new THREE.Group();
    perch.add(gull.g);
    if (B.perch) perch.position.copy(B.perch.position); else perch.position.set(0, B.top || 1.2, 0);
    perch.rotation.y = this.seed() * TAU;
    g.add(patches, barn, sale, perch);
    g.traverse((o) => { if (o.isMesh) o.castShadow = false; });
    patches.visible = barn.visible = sale.visible = perch.visible = false;
    this.float.add(g);
    this.wearBits = { g, patches, barn, sale, perch, gull, gullT: 0, flyT: -1 };
  }

  // Moor at the berth. Docks from islands.js expose the pier axis (root -> pierEnd, Vector3s):
  //  - berth beside the pier: lie alongside it, bow toward the shore, pushed clear of the pier deck;
  //  - berth out on the axis (a quay berth, e.g. Port Localhost's container terminal): lie alongside the quay edge,
  //    bow pointing away from the town so neighbouring ships don't overlap.
  // Other docks (no pier axis) get a bow-in mooring (local +Z = -dock.dir) with our own little pontoon.
  place() {
    const d = this.dock;
    const dir = V().copy(d.dir || V(0, 0, 1));
    dir.y = 0;
    if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1);
    dir.normalize();
    this.dir = dir;
    this.heading = Math.atan2(-dir.x, -dir.z);
    const b = d.berth || V();
    const bx = Number(b.x) || 0, bz = Number(b.z) || 0;
    let px = bx, pz = bz, at = null;
    this.pier = null;
    this.quay = false;
    if (d.root?.isVector3 && d.pierEnd?.isVector3) {
      const ux0 = d.pierEnd.x - d.root.x, uz0 = d.pierEnd.z - d.root.z, ul = Math.hypot(ux0, uz0) || 1;
      const ux = ux0 / ul, uz = uz0 / ul;
      const al = (bx - d.root.x) * ux + (bz - d.root.z) * uz;
      const qx = d.root.x + ux * al, qz = d.root.z + uz * al;
      let sx = bx - qx, sz = bz - qz;
      const lat = Math.hypot(sx, sz);
      const y = Number.isFinite(d.root.y) ? d.root.y : 0.45;
      if (lat > 0.05) {
        sx /= lat; sz /= lat;
        const halfW = Number(d.pierHalfWidth) || (d.container ? 0.66 : 0.49);
        const push = Math.max(0, this.beam / 2 + halfW + 0.1 - lat);
        const shift = Math.max(0, this.halfLen - 1.6);
        px += sx * push + dir.x * shift;
        pz += sz * push + dir.z * shift;
        this.pier = { halfW, lat: lat + push, y };
        at = [qx + dir.x * shift, qz + dir.z * shift];
      } else {
        const o = d.owner?.position;
        let fx = -uz, fz = ux;
        if (o && (bx - o.x) * fx + (bz - o.z) * fz < 0) { fx = -fx; fz = -fz; }
        this.heading = Math.atan2(fx, fz);
        const edge = (bx - d.pierEnd.x) * ux + (bz - d.pierEnd.z) * uz;
        const push = Math.max(0, this.beam / 2 + 0.12 - edge);
        const shift = Math.max(0, this.halfLen - 2.1);
        px += ux * push + fx * shift;
        pz += uz * push + fz * shift;
        this.pier = { halfW: 0, lat: edge + push, y };
        at = [px - ux * (edge + push), pz - uz * (edge + push)];
        this.quay = true;
      }
      const s = Math.sin(this.heading), c = Math.cos(this.heading);
      this.pier.side = Math.sign((at[0] - px) * c - (at[1] - pz) * s) || 1;
    } else {
      const shift = Math.max(0, this.halfLen - 1.6);
      px += dir.x * shift;
      pz += dir.z * shift;
    }
    this.group.position.set(px, 0, pz);
    this.group.rotation.set(0, this.heading, 0);
    // open water in the boat's frame: astern, or abeam away from a quay
    this.sea = this.quay ? { x: -this.pier.side, z: 0 } : { x: 0, z: -1 };
    // an adrift boat slips out along the dock's dir (and a little away from a pier it lies alongside)
    const s = Math.sin(this.heading), c = Math.cos(this.heading);
    const lat = this.pier && !this.quay ? -this.pier.side * 0.3 : 0;
    this.drift = { x: (dir.x * c - dir.z * s) * DRIFT + lat, z: (dir.x * s + dir.z * c) * DRIFT };
  }

  // Landing, crate pile (the stevedores' seats), mooring line; a signpost only if the dock has no setSign.
  buildShore() {
    const B = this.B, S = this.shore, st = new THREE.Group();
    const k = this.S, mBow = B.bowZ ?? (B.L || 2.4) / 2;
    const bowZ = mBow * k, hb = this.beam / 2;
    const mcz = Math.min(B.cargoZ ?? mBow - 0.6, mBow - 0.35), cz = mcz * k;
    const deckY = (B.deckAt ? B.deckAt(mcz) : B.deckY ?? 0.4) * k;
    const P = this.pier;
    let seats, land, boat, n, edge, landEdge, ropeEnd, ropeAt, pile;
    if (P) {
      const sg = P.side, ly = P.y, px = sg * P.lat, inl = Math.max(0, 0.45 - P.halfW);   // pier axis / quay edge at local x = px
      boat = V(sg * hb * 0.35, deckY, cz);
      land = V(px - sg * (P.halfW - 0.24), ly, cz);
      n = { x: sg, z: 0 };
      edge = hb * 0.6;
      landEdge = P.lat - P.halfW - hb * 0.35;
      const face = -sg * Math.PI / 2;
      seats = [
        { x: px + sg * (0.02 + inl), y: ly + 0.26, z: cz + 0.62, ry: face },
        { x: px + sg * (inl - 0.18), y: ly + 0.26, z: cz + 0.98, ry: face + 0.4 },
        { x: px + sg * (0.08 + inl), y: ly + 0.3, z: cz - 0.68, ry: face - 0.3 },
      ];
      pile = V(px + sg * (0.26 + inl), ly, cz + 1.02);
      ropeAt = V(sg * hb, deckY + 0.05, bowZ - 0.55);
      ropeEnd = V(px - sg * P.halfW * 0.85, ly + 0.12, bowZ - 0.1);
    } else {
      const ly = 0.36, lz = bowZ + 0.78;
      st.add(at(box(1.6, 0.1, 1.1, M.wood()), 0, ly - 0.1, lz));
      for (const dz of [-0.33, 0, 0.33]) st.add(at(box(1.6, 0.012, 0.05, M.woodDark()), 0, ly, lz + dz));
      for (const dz of [-0.3, 0.3]) st.add(at(cyl(0.17, 0.17, 1.4, 8, mat(0x5a6478), { center: true }), 0, ly - 0.22, lz + dz, { rz: Math.PI / 2 }));
      for (const [qx, qz] of [[0.74, -0.5], [-0.74, -0.5], [0.74, 0.5], [-0.74, 0.5]]) st.add(at(cyl(0.05, 0.06, 1.0, 6, M.woodDark()), qx, ly - 0.85, lz + qz));
      const bx = 0.5, bz = lz - 0.38;
      st.add(at(cyl(0.07, 0.09, 0.2, 7, M.black()), bx, ly, bz), at(sphere(0.09, M.black(), { segments: 7, rings: 4 }), bx, ly + 0.2, bz, { s: [1, 0.6, 1] }));
      boat = V(0, deckY, cz);
      land = V(0.08, ly, lz - 0.3);
      n = { x: 0, z: 1 };
      edge = bowZ - 0.08 - cz;
      landEdge = lz - 0.55 - cz;
      const px = -0.42, pz = lz + 0.12;
      seats = [
        { x: px, y: ly + 0.26, z: pz, ry: Math.PI * 0.85 },
        { x: px + 0.36, y: ly + 0.26, z: pz + 0.14, ry: Math.PI * 1.1 },
        { x: px + 0.84, y: ly + 0.3, z: pz - 0.26, ry: Math.PI * 1.25 },
      ];
      pile = V(px - 0.02, ly, pz + 0.34);
      ropeAt = V(0.12, deckY + 0.06, bowZ - 0.25);
      ropeEnd = V(bx, ly + 0.22, bz);
      this.signAt = V(-0.62, ly, lz - 0.4);
    }
    // two crates and a barrel to sit on, plus a small stack for show
    const wood = M.wood(), dark = mat(0xa86a3d);
    st.add(at(box(0.3, 0.26, 0.3, wood), seats[0].x, seats[0].y - 0.26, seats[0].z));
    st.add(at(box(0.3, 0.26, 0.3, wood), seats[1].x, seats[1].y - 0.26, seats[1].z, { ry: 0.25 }));
    st.add(at(cyl(0.12, 0.12, 0.3, 8, mat(0x3c7fb1)), seats[2].x, seats[2].y - 0.3, seats[2].z));
    st.add(at(box(0.28, 0.24, 0.28, dark), pile.x, pile.y, pile.z, { ry: -0.2 }), at(box(0.26, 0.22, 0.26, dark), pile.x, pile.y + 0.24, pile.z, { ry: 0.3 }));
    mergeStatic(st);
    S.add(st);
    this.rope = cyl(0.02, 0.02, 1, 4, M.rope(), { center: true });
    this.rope.userData.dynamic = true;
    this.rope.castShadow = false;
    S.add(this.rope);
    this.rope2 = null;                 // second half of a sagging line (adrift), made when first needed
    this.ropeRest = 0;
    this.ropeAt = ropeAt;
    this.ropeEnd = ropeEnd;
    this.zzzAnchor = at(new THREE.Object3D(), seats[0].x, seats[0].y + 0.3, seats[0].z);
    S.add(this.zzzAnchor);
    this.cargoM = { y: deckY / k, z: mcz };
    const catchPile = P ? V(land.x + P.side * 0.45, land.y, cz) : V(0.55, land.y, land.z + 0.65);
    this.spots = { boat, land, n, edge, landEdge, seats, catchPile };
    // how the arrival nudges into the berth: sideways into a pier, bow-first into the pontoon
    this.bumpX = P ? P.side : 0;
    this.bumpZ = P ? 0 : 1;
  }

  signText() {
    const ports = portList(this.port);
    if (!ports.length) return ':?';
    return ports.slice(0, 3).map((p) => ':' + p).join(' ') + (ports.length > 3 ? ' …' : '');
  }

  applySign() {
    const text = this.signText();
    if (text === this.signShown) return;
    this.signShown = text;
    if (typeof this.dock.setSign === 'function') {
      try { this.dock.setSign(text); } catch (e) { console.error('[harbor] dock.setSign failed', e); }
      return;
    }
    if (!this.signPost) {
      const L = this.spots.land, a = this.signAt || V(L.x, L.y, L.z - 0.9);
      this.shore.add(at(cyl(0.035, 0.045, 0.95, 5, M.woodDark()), a.x, a.y, a.z));
      this.signPost = at(new THREE.Group(), a.x, a.y + 0.86, a.z);
      this.shore.add(this.signPost);
    }
    if (this.signMesh) disposeTree(this.signMesh);   // releases the cached sign texture
    const w = clamp(0.3 + text.length * 0.13, 0.62, 1.7);
    this.signMesh = textSign(text, { w, h: 0.32 });
    this.signPost.add(this.signMesh);
  }

  initLabel() {
    const L = this.engine.labels;
    if (!L?.add) return;
    if (!cssDone.has(L)) { cssDone.add(L); try { L.css?.('harbor', LABEL_CSS); } catch { /* optional */ } }
    this.labelOff = V(0, (this.B.top || 1.5) * this.S + 0.3, 0);
    this.harbor = Harbor.of(this);
    try {
      this.label = L.add({
        object: this.boat, offset: this.labelOff, html: this.labelHtml(), className: 'lbl-port hb-lbl', target: { type: 'port', id: this.id },
        cluster: this.harbor?.name,
      });
    } catch (e) { console.error('[harbor] label failed', e); }
    this.refreshLabel();
    this.harbor?.join(this);
  }

  labelHtml() {
    const p = this.port, ports = portList(p);
    const pt = ports.slice(0, 4).map((x) => ':' + x).join(' ') + (ports.length > 4 ? ` +${ports.length - 4}` : '');
    const name = p.label || KINDS[this.kind].name;
    const repo = p.repo ? `<div class="l2 detail"><span class="repo">${esc(trunc(p.repo, 28))}</span></div>` : '';
    const adrift = p.adrift ? '<b class="st st-adrift">Adrift</b>' : '';
    return `<div class="lbl-card"><div class="l1"><i class="hb-fl" style="--fc:${cssHex(this.flagHex)}"></i>` +
      `<span class="name">${esc(trunc(name, 22))}</span><b class="hb-pt">${esc(pt)}</b>${adrift}</div>${repo}</div>`;
  }

  // busy: the port is in use (a boat out fishing counts), for the label look, its declutter rank and the harbor tag.
  get busy() { return this.tAct > 0.15 || this.act > 0.35 || this.fishing || this.mode === 'docking'; }

  refreshLabel() {
    const L = this.label;
    if (!L) return;
    L.set(this.labelHtml());
    const busy = this.busy, worn = this.wear > 0.6, adrift = !!this.port.adrift;
    let changed = false;
    if (busy !== this.lblBusy) { this.lblBusy = busy; L.setClass?.('busy', busy); changed = true; }
    if (worn !== this.lblWorn) { this.lblWorn = worn; L.setClass?.('worn', worn); }
    if (adrift !== this.lblAdrift) { this.lblAdrift = adrift; L.setClass?.('adrift', adrift); changed = true; }
    if (changed) {
      // declutter: adrift and busy boats keep their labels over idle neighbours (base port priority 10)
      L.setPriority?.(adrift ? 14 : busy ? 13 : 10);
      this.harbor?.refresh();
    }
  }

  // Zzz and the dock's 3D sign follow the boat's label: hidden while it is folded into the harbor tag, decluttered
  // away or hidden by the zoom / label mode. Checked every frame (a boolean read, no DOM access).
  followLabel() {
    const s = this.label?.showing;
    const on = s === undefined ? true : s;
    if (on === this.lblOn) return;
    this.lblOn = on;
    this.zzz?.setVisible?.(on);
    this.showSign(on);
  }

  showSign(on) {
    if (typeof this.dock.setSign === 'function') { if (this.dock.signAnchor) this.dock.signAnchor.visible = on; }
    else if (this.signPost) this.signPost.visible = on;
  }

  // ---- data --------------------------------------------------------------------------------------------------------

  update(port) {
    if (!port || this.disposed) return;
    this.port = port;
    const kind = normKind(port.kind);
    if (kind !== this.kind) { this.kind = kind; this.rebuild(); }
    const a = clamp(Number(port.activity) || 0, 0, 1);
    // fishing: any use of the port (activity, or lastActive moving on) sends a docked boat out / lands a fish
    const la = Number(port.lastActive);
    const advanced = Number.isFinite(la) && Number.isFinite(this.prevLA) && la > this.prevLA + 250;
    if (Number.isFinite(la)) this.prevLA = la;
    const signal = a >= FISHING.ACT_ON || advanced;
    if (signal) {
      const fresh = this.time - this.lastSignalAt > 3;    // a new burst = activity after >= 3 s of quiet
      this.lastSignalAt = this.time;
      if (this.mode === 'moored') {
        if (this.dockedFor >= FISHING.DOCK_MIN && KINDS[this.kind].trip) this.startTrip();
      } else if (this.fishing || this.mode === 'docking') {
        if (fresh || this.time - this.lastCatchAt >= FISHING.CATCH_EVERY) this.catchFish();
        if (this.mode === 'return') this.resumeFishing();
      }
    }
    this.prevSignal = signal;
    if (a >= 0.45 && this.quietFor >= 20 && this.mode === 'moored') this.toot();
    this.tAct = a;
    if (a >= 0.12) this.quietFor = 0;
    const rs = port.restarts | 0;
    if (rs > this.restarts && this.mode !== 'depart') this.refuel();
    this.restarts = rs;
    const fh = this.flagColor(), adrift = !!port.adrift;
    if (fh !== this.flagHex || adrift !== this.adriftOn) {
      const recolor = fh !== this.flagHex;
      this.flagHex = fh;
      this.adriftOn = adrift;
      this.applyFlag();
      if (recolor) this.crew?.recolor();
    }
    if (this.B.containerArea && portList(port).join(',') !== this.containerKey) { this.rebuildContainers(); this.wearShown = -1; this.applyWear(true); }
    this.applySign();
    this.refreshLabel();
    this.wearClock = Math.min(this.wearClock, 0.1);
  }

  rebuild() {
    this.crew?.dispose();
    this.crew = null;
    this.zzz?.remove();
    this.zzz = null;
    this.stopWake();
    this.sternAnchor?.removeFromParent();
    this.bowAnchor?.removeFromParent();
    this.sternAnchor = this.bowAnchor = null;
    if (this.gear) {
      if (this.gear.rods) disposeTree(this.gear.rods);
      for (const o of [...this.gear.floats, ...this.gear.lines]) disposeTree(o);
      this.gear = null;
    }
    disposeTree(this.model);
    disposeTree(this.wearBits?.g);
    for (const m of this.paints.values()) m.dispose();
    this.paints.clear();
    for (const c of [...this.shore.children]) disposeTree(c);
    this.signPost = this.signMesh = this.signShown = null;
    this.containers = this.containerKey = null;
    this.buildModel();
    this.applyFlag();
    this.place();
    this.buildShore();
    this.crew = this.engine.scene ? new Dockhands(this) : null;
    if (this.labelOff) this.labelOff.y = (this.B.top || 1.5) * this.S + 0.3;
    this.wearShown = -1;
    this.applyWear(true);
    this.applySign();
    this.lblOn = null;
  }

  // ---- wear -----------------------------------------------------------------------------------------------------------

  // 0 until 5 minutes idle, then log-scaled up to 1 at ~12 hours.
  wearTarget() {
    const la = Number(this.port.lastActive);
    if (!Number.isFinite(la) || la <= 0) return 0;
    const now = this.engine.serverNow?.() ?? Date.now();
    const age = now - la;
    if (age <= 300e3) return 0;
    return clamp(Math.log(age / 300e3) / Math.log(144), 0, 1);
  }

  updateWear(instant) {
    if (this.painting) return;
    const w = this.wearTarget();
    const home = this.mode === 'moored' || this.fishing || this.mode === 'docking';
    if (!instant && this.wear > 0.3 && w < this.wear - 0.2 && home) { this.freshPaint(w); return; }
    this.wear = w;
    this.applyWear(instant);
  }

  applyWear(instant) {
    const w = this.wear;
    if (Math.abs(w - this.wearShown) < 0.004) return;
    this.wearShown = w;
    for (const [hex, m] of this.paints) wornColor(m.color, hex, w);
    for (const part of this.vcParts) tintRanges(part, w);
    const W = this.wearBits;
    if (!W) return;
    this.showBit(W.patches, w > 0.3, instant);
    this.showBit(W.barn, w > 0.62, instant);
    this.showBit(W.sale, w >= 0.93, instant);
    const gull = w > 0.45 && (this.mode === 'moored' || this.fishing || this.mode === 'docking');
    if (gull && (!W.perch.visible || W.flyT >= 0)) { W.perch.visible = true; W.flyT = -1; W.gullT = instant ? 9 : 0; W.gull.g.position.set(0, 0, 0); }
    else if (!gull && W.perch.visible && W.flyT < 0) { if (instant) W.perch.visible = false; else W.flyT = 0; }
  }

  showBit(o, on, instant) {
    if (o.visible === on) return;
    o.visible = on;
    if (on && !instant) { o.scale.setScalar(0.01); tween(o.scale, { x: 1, y: 1, z: 1 }, 0.5, ease.outBack); }
  }

  // Activity resumed after a long idle: sparkles sweep the hull and the rust fades back to fresh paint.
  freshPaint(target) {
    this.painting = true;
    const from = this.wear, fx = this.engine.fx;
    this.float.localToWorld(_v.set(0, (this.B.top || 1.4) * 0.7, 0));
    fx?.text?.(_v, 'FRESH PAINT!', { color: '#9bffcf', size: 0.8, rise: 1.6, secs: 1.7 });
    let n = 0;
    animate(1.5, (k) => {
      if (this.disposed) return;
      this.wear = lerp(from, target, k);
      this.applyWear();
      if (fx?.sparks && n++ % 3 === 0) {
        this.float.localToWorld(_v.set((rand() - 0.5) * (this.B.beam || 1.2), 0.15 + rand() * 0.7, (rand() - 0.5) * (this.B.L || 2.4) * 0.85));
        fx.sparks(_v, rand() < 0.5 ? 0xffffff : 0xfff1a0, { count: 4, speed: 1.6, size: 0.14 });
      }
    }, ease.inOut).then(() => {
      this.painting = false;
      if (this.disposed) return;
      this.wear = target;
      this.wearShown = -1;
      this.applyWear();
    });
  }

  // ---- one-shots ----------------------------------------------------------------------------------------------------

  later(secs, fn) { this.timers.push({ t: secs, fn }); }

  hornPos(out) {
    const h = this.B.horn || this.B.perch;
    if (h) return h.getWorldPosition(out);
    return this.float.localToWorld(out.set(0, this.B.top || 1.5, 0));
  }

  toot(text, force = false) {
    if (!force && this.time - this.lastToot < 8) return;
    this.lastToot = this.time;
    this.tootT = 0;
    const fx = this.engine.fx;
    if (!fx) return;
    this.hornPos(_v);
    fx.puff?.(_v, { color: 0xffffff, count: 5, size: 0.3, spread: 0.35, rise: 1.3, life: 0.8 });
    fx.text?.(_v2.copy(_v).setY(_v.y + 0.3), text || this.B.toot || 'TOOT!', { color: '#fff7d6', size: 0.9, rise: 1.8, secs: 1.5 });
  }

  refuel() {
    this.hop = 1;
    const fx = this.engine.fx;
    if (!fx) return;
    const s = this.B.stacks[0]?.o;
    if (s) s.getWorldPosition(_v); else this.hornPos(_v);
    fx.smoke?.(_v, { count: 4, color: 0x2e3040, size: 0.45, rise: 1.6 });
    fx.puff?.(_v, { color: 0xfff1a8, count: 6, size: 0.35, spread: 0.5, rise: 0.9 });
    fx.text?.(_v2.copy(_v).setY(_v.y + 0.25), 'REFUELED!', { color: '#ffd23f', size: 0.7, rise: 1.4, secs: 1.3 });
  }

  startArrival() {
    this.mode = 'arrive';
    this.mt = 0;
    const D = 34 + this.seed() * 8, side = this.pier?.side ?? 0;
    this.path = this.quay ? [-side * D * 0.8, -D * 0.55, -side * 3, -7]
      : this.pier ? [-side * 4, -D, -side * 2.2, -7] : [0, -D, 0, -D * 0.4];
    // swing the far end of the approach so the run-in doesn't cross another island
    const a0 = Math.atan2(this.path[0], this.path[1]), yawW = this.openHeading(this.group.position.x, this.group.position.z, this.heading + a0, D);
    const a1 = yawW - this.heading, r0 = Math.hypot(this.path[0], this.path[1]);
    this.path[0] = Math.sin(a1) * r0;
    this.path[1] = Math.cos(a1) * r0;
    this.arriveSecs = this.engine.settings?.reduceMotion ? 3.5 : 6.5;
    this.boat.position.set(this.path[0], 0, this.path[1]);
    this.prevX = this.path[0];
    this.prevZ = this.path[1];
    this.act = 0;
    this.rope.visible = false;
    this.startWake();
  }

  startWake(trip = false) {
    const fx = this.engine.fx;
    if (!fx?.trail) return;
    if (!this.sternAnchor) {
      this.sternAnchor = at(new THREE.Object3D(), 0, 0.05, (this.B.sternZ ?? -this.halfLen) - 0.15);
      this.bowAnchor = at(new THREE.Object3D(), 0, 0.05, (this.B.bowZ ?? this.halfLen) - 0.2);
      this.float.add(this.sternAnchor, this.bowAnchor);
    }
    this.stopWake();
    if (trip && this.B.sub && this.B.periscope) {
      this.wake = fx.trail(this.B.periscope, { kind: 'wake', color: FOAM, rate: 10, size: 0.1 });
      return;
    }
    this.wake = fx.trail(this.sternAnchor, { kind: 'wake', color: FOAM, rate: trip ? 12 : 26, size: 0.16 });
    this.bowWake = fx.trail(this.bowAnchor, { kind: 'wake', color: FOAM, rate: trip ? 5 : 12, size: 0.12 });
  }

  stopWake() {
    this.wake?.stop(); this.bowWake?.stop();
    this.wake = this.bowWake = null;
  }

  bump() {
    this.bumpT = 0;
    this.rope.visible = true;
    const fx = this.engine.fx;
    if (fx?.puff) {
      if (this.bumpX) this.float.localToWorld(_v.set(this.bumpX * (this.B.beam || 1.2) * 0.5, 0.25, 0.3));
      else this.float.localToWorld(_v.set(0, 0.25, this.B.bowZ ?? this.halfLen));
      fx.puff(_v, { color: FOAM, count: 8, size: 0.35, spread: 0.6, rise: 0.4, life: 0.7 });
    }
    this.later(0.45, () => this.toot(null, true));
  }

  // Cast off, back out, swing around and steam off over the horizon, fading out. Resolves when gone.
  depart() {
    if (this.departP) return this.departP;
    if (this.disposed) return Promise.resolve();
    this.departP = new Promise((res) => { this.departRes = res; });
    this.departOff = this.mode === 'moored';
    this.showGear(false);
    this.fishK = -1;
    if (this.fish) this.fish.visible = false;
    this.mode = 'depart';
    this.mt = 0;
    this.harbor?.refresh();
    this.departZ0 = this.boat.position.z;
    this.departX0 = this.boat.position.x;
    this.departYaw0 = this.boat.rotation.y;
    this.readLocalPose();
    const yawW = this.openHeading(this.wx, this.wz, this.heading + Math.atan2(this.sea.x, this.sea.z), 34);
    let dy = wrapAngle(yawW - this.heading - this.departYaw0);
    if (this.departOff && this.pier && Math.abs(dy) > 2.6) dy = -(this.pier.side || 1) * Math.abs(dy);
    this.yawOut = this.departYaw0 + dy;
    this.departDir = { x: Math.sin(this.yawOut), z: Math.cos(this.yawOut) };
    this.bumpT = -1;
    this.rope.visible = false;
    this.stopWake();
    this.wearBits.sale.visible = false;
    if (this.wearBits.perch.visible && this.wearBits.flyT < 0) this.wearBits.flyT = 0;
    this.makeFadeable();
    this.zzz?.remove();
    this.zzz = null;
    this.later(0.25, () => this.toot(null, true));
    return this.departP;
  }

  makeFadeable() {
    this.fadeMats = [];
    this.boat.traverse((o) => {
      if (!o.isMesh || !o.material || o.material.map) return;
      const c = o.material.clone();
      c.transparent = true;
      c.userData = { fadeClone: true };
      o.material = c;
      this.fadeMats.push(c);
    });
  }

  setOpacity(a) { for (const m of this.fadeMats || []) m.opacity = a; }

  finishDepart() {
    this.mode = 'gone';
    this.group.visible = false;
    this.stopWake();
    if (this.crew) this.crew.hidden = true;
    const r = this.departRes;
    this.departRes = null;
    r?.();
  }

  // ---- fishing trips --------------------------------------------------------------------------------------------------

  get fishing() { return this.mode === 'castoff' || this.mode === 'out' || this.mode === 'return'; }

  // Boat pose in world space (x, z, yaw) <-> the boat node's pose in the berth frame.
  readLocalPose() {
    const b = this.boat.position, h = this.heading, s = Math.sin(h), c = Math.cos(h);
    this.wx = this.group.position.x + b.x * c + b.z * s;
    this.wz = this.group.position.z - b.x * s + b.z * c;
    this.wyaw = h + this.boat.rotation.y;
  }

  writeLocalPose() {
    const h = this.heading, s = Math.sin(h), c = Math.cos(h);
    const dx = this.wx - this.group.position.x, dz = this.wz - this.group.position.z;
    this.boat.position.x = dx * c - dz * s;
    this.boat.position.z = dx * s + dz * c;
    this.boat.rotation.y = wrapAngle(this.wyaw - h);
  }

  toLocal(x, z, out) {
    const h = this.heading, s = Math.sin(h), c = Math.cos(h);
    const dx = x - this.group.position.x, dz = z - this.group.position.z;
    out.x = dx * c - dz * s;
    out.z = dx * s + dz * c;
    return out;
  }

  startTrip() {
    const st = KINDS[this.kind].trip;
    if (!st || this.mode !== 'moored') return;
    this.tripStyle = st;
    this.trips++;
    this.planRoute();
    this.mode = 'castoff';
    this.mt = 0;
    this.dockedFor = 0;
    this.bumpT = -1;
    this.castX0 = this.boat.position.x;
    this.castZ0 = this.boat.position.z;
    if (this.rope.visible) {
      this.rope.visible = false;
      const fx = this.engine.fx;
      if (fx?.puff) {
        this.shore.localToWorld(_v.copy(this.ropeEnd));
        _v.y = 0.1;
        fx.puff(_v, { color: FOAM, count: 5, size: 0.25, spread: 0.4, rise: 0.5, life: 0.6 });
      }
    }
    this.startWake(true);
    this.showGear(true);
    this.later(0.35, () => this.toot(null, true));
    seaLifeOf(this.world)?.notice(this);
  }

  // A route in open water off the dock: its own lane straight out from the berth (away from the home island),
  // swung and/or shrunk until every sample point keeps clear of all island discs.
  planRoute() {
    const st = this.tripStyle, r = rng(`route:${this.id}:${this.trips}`);
    const T = this.trip || (this.trip = { cx: 0, cz: 0, ux: 0, uz: 0, a: 0, b: 0, th: Math.PI, dir: 1, shape: 'eight', ax: 0, az: 0, path: [0, 0, 0, 0, 0, 0, 0, 0] });
    const gx = this.group.position.x, gz = this.group.position.z;
    let ox = 0, oz = 0;
    const o = this.dock.owner?.position;
    if (o) { ox = gx - o.x; oz = gz - o.z; } else {
      const obs = obstaclesOf(this.world, this.clock());
      let best = 12;
      for (let i = 0; i < obs.n; i++) {
        const q = obs.list[i], d = Math.hypot(gx - q.x, gz - q.z) - q.r;
        if (d < best) { best = d; ox = gx - q.x; oz = gz - q.z; }
      }
    }
    if (Math.hypot(ox, oz) < 1e-3) { ox = this.dir.x; oz = this.dir.z; }
    const ol = Math.hypot(ox, oz);
    ox /= ol; oz /= ol;
    let dn = 99;
    for (let i = 0; i < FLEET.length; i++) {
      const f = FLEET[i];
      if (f !== this && f.world === this.world) dn = Math.min(dn, Math.hypot(f.group.position.x - gx, f.group.position.z - gz));
    }
    const shape = st.route;
    let d0 = 10.5 + r() * 2, a0 = 4.5, b0 = 2.2;
    if (shape === 'loop') { d0 = 10 + r() * 2; a0 = 4.2; b0 = 2.4; } else if (shape === 'patrol') { d0 = 10 + r() * 1.5; a0 = 4.4; b0 = 0.7; } else if (shape === 'circles') { d0 = 7 + r(); a0 = 1.9; b0 = 1.9; } else if (shape === 'small') { d0 = 8 + r(); a0 = 3; b0 = 1.4; }
    if (shape !== 'circles') b0 = Math.min(b0, Math.max(0.8, dn * 0.4));
    T.shape = shape;
    T.dir = r() < 0.5 ? 1 : -1;
    T.th = Math.PI;
    // if something sits in the lane, swing away from it (not into the neighbour's lane on the other side)
    let flip = 1, bd = Infinity;
    const obs = obstaclesOf(this.world, this.clock());
    for (let i = 0; i < obs.n; i++) {
      const q = obs.list[i], rx = q.x - gx, rz = q.z - gz, along = rx * ox + rz * oz;
      if (along < 2 || along > d0 + a0 + 6) continue;
      const side = ox * rz - oz * rx, clear = Math.abs(side) - q.r;
      if (clear < b0 + FISHING.MARGIN + this.wr && clear < bd) { bd = clear; flip = side > 0 ? -1 : 1; }
    }
    let done = false;
    for (let i = 0; i < ROUTE_TRY.length && !done; i++) {
      const rot = ROUTE_TRY[i][0] * flip, sc = ROUTE_TRY[i][1], c = Math.cos(rot), s = Math.sin(rot);
      T.ux = ox * c - oz * s;
      T.uz = ox * s + oz * c;
      T.a = a0 * sc;
      T.b = b0 * Math.min(1, sc + 0.25);
      const d = Math.max(T.a + 3 + this.halfLen, d0 * sc);
      T.cx = gx + T.ux * d;
      T.cz = gz + T.uz * d;
      done = this.routeClear();
    }
  }

  routePoint(th, out) {
    const T = this.trip, c = Math.cos(th), s = Math.sin(th);
    const along = T.a * c, lat = T.shape === 'eight' || T.shape === 'small' ? 2 * T.b * s * c : T.b * s;
    out.x = T.cx + T.ux * along - T.uz * lat;
    out.z = T.cz + T.uz * along + T.ux * lat;
    return out;
  }

  routeClear() {
    const obs = obstaclesOf(this.world, this.clock()), m = FISHING.MARGIN * 0.8 + this.wr;
    for (let k = 0; k < 20; k++) {
      this.routePoint((k / 20) * TAU, _rp);
      for (let i = 0; i < obs.n; i++) {
        const o = obs.list[i];
        if (Math.hypot(_rp.x - o.x, _rp.z - o.z) < o.r + m) return false;
      }
    }
    return true;
  }

  // Push a target point out of any disc (plus margin).
  clearOf(p) {
    const obs = obstaclesOf(this.world, this.clock()), m = FISHING.MARGIN * 0.6 + this.wr;
    for (let i = 0; i < obs.n; i++) {
      const o = obs.list[i], dx = p.x - o.x, dz = p.z - o.z, d = Math.hypot(dx, dz) || 1e-3, R = o.r + m;
      if (d < R) { p.x = o.x + (dx / d) * R; p.z = o.z + (dz / d) * R; }
    }
    return p;
  }

  clock() { return Number.isFinite(this.engine.time) ? this.engine.time : this.time; }

  // World yaw near yaw0 whose ray from (x, z) keeps clear of every island disc for `len` units (else the clearest).
  openHeading(x, z, yaw0, len = 30) {
    const obs = obstaclesOf(this.world, this.clock());
    let best = yaw0, bestGap = -Infinity;
    for (let k = 0; k < HEADING_TRY.length; k++) {
      const yaw = yaw0 + HEADING_TRY[k], fx = Math.sin(yaw), fz = Math.cos(yaw);
      let gap = Infinity;
      for (let d = 3; d <= len && gap > bestGap; d += 2.5) {
        const px = x + fx * d, pz = z + fz * d;
        for (let i = 0; i < obs.n; i++) {
          const o = obs.list[i];
          gap = Math.min(gap, Math.hypot(px - o.x, pz - o.z) - o.r - this.wr);
        }
      }
      if (gap >= 1) return yaw;
      if (gap > bestGap) { bestGap = gap; best = yaw; }
    }
    return best;
  }

  // Repulsion from island discs and from every other vessel; `crowd` > 0 when someone is right ahead. soft (0..1)
  // scales the comfort margin around islands (the hard ring just outside the disc always pushes).
  avoid(soft = 1, solid = 1, home = false) {
    let ax = 0, az = 0, crowd = 0;
    const M = FISHING.MARGIN, obs = obstaclesOf(this.world, this.clock());
    for (let i = 0; i < obs.n && solid > 0; i++) {
      const o = obs.list[i], dx = this.wx - o.x, dz = this.wz - o.z, d = Math.hypot(dx, dz) || 1e-3;
      const gap = d - o.r - this.wr;
      if (gap < M) {
        const k = (M - gap) / M, hard = gap < 0.6 ? (0.6 - gap) * 4 : 0, f = (k * k * 3 * soft + hard) * solid;
        ax += (dx / d) * f;
        az += (dz / d) * f;
      }
    }
    const fx = Math.sin(this.wyaw), fz = Math.cos(this.wyaw);
    for (let i = 0; i < FLEET.length; i++) {
      const o = FLEET[i];
      if (o === this || o.world !== this.world || o.mode === 'gone' || o.disposed) continue;
      if (home && o.mode === 'moored') continue;        // coming alongside: the berths are laid out clear already
      const dx = this.wx - o.wx, dz = this.wz - o.wz, d = Math.hypot(dx, dz) || 1e-3;
      const min = this.wr + o.wr + 0.3, zone = min + 3;
      if (d < zone) {
        const q = (zone - d) / (zone - min * 0.6), k = Math.min(4, q * q * 2.4);
        ax += (dx / d) * k;
        az += (dz / d) * k;
        const ahead = (-dx * fx - dz * fz) / d;
        if (ahead > 0.3) {
          crowd = Math.max(crowd, clamp((zone - d) / zone, 0, 1) * ahead);
          if (fx * Math.sin(o.wyaw) + fz * Math.cos(o.wyaw) < -0.3) {
            ax -= fz * k * 0.8 * ahead;         // meeting head-on: both give way to the same side
            az += fx * k * 0.8 * ahead;
          }
        }
        // too close abreast: the junior boat eases off so the other pulls ahead and they string out
        if (d < min + 0.8 && this.prio > o.prio && o.mode !== 'moored') crowd = Math.max(crowd, 0.75);
      }
    }
    this.ax = ax;
    this.az = az;
    this.crowd = crowd;
  }

  // Turn smoothly (shortest arc, limited rate) toward a world point, easing off in tight turns / traffic.
  steerTo(tx, tz, vmax, dt, soft = 1, solid = 1, home = false) {
    const st = this.tripStyle;
    let dx = tx - this.wx, dz = tz - this.wz;
    const dist = Math.hypot(dx, dz) || 1e-3;
    dx /= dist;
    dz /= dist;
    this.avoid(soft, solid, home);
    dx += this.ax;
    dz += this.az;
    const d = wrapAngle(Math.atan2(dx, dz) - this.wyaw);
    const turn = st.turn * dt;
    this.wyaw = wrapAngle(this.wyaw + clamp(d, -turn, turn));
    const align = Math.cos(Math.min(Math.abs(d), Math.PI / 2));
    const target = vmax * (0.35 + 0.65 * align) * (1 - 0.65 * this.crowd);
    this.vel = damp(this.vel, target, 1.2, dt);
    this.wx += Math.sin(this.wyaw) * this.vel * dt;
    this.wz += Math.cos(this.wyaw) * this.vel * dt;
    this.writeLocalPose();
    return dist;
  }

  castStep(dt) {
    this.mt += dt;
    const t = this.mt, side = this.pier?.side ?? 0, b = this.boat, st = this.tripStyle;
    const off = ease.inOut(clamp((t - 0.15) / 1.8, 0, 1));
    const ox = this.pier ? -side * (this.quay ? 1.4 : 1.1) : 0, oz = this.pier ? (this.quay ? 0 : -0.9) : -2.0;
    b.position.x = this.castX0 + ox * off;
    b.position.z = this.castZ0 + oz * off;
    if (t > 0.8) {
      this.toLocal(this.routePoint(this.trip.th, _rp).x, _rp.z, _rl);
      let d = wrapAngle(Math.atan2(_rl.x - b.position.x, _rl.z - b.position.z) - b.rotation.y);
      if (this.pier && Math.abs(d) > 2.6) d = -side * Math.abs(d);   // swing the bow away from the pier
      b.rotation.y += clamp(d, -st.turn * dt, st.turn * dt);
    }
    if (t >= 2.2) { this.readLocalPose(); this.vel = 0.35; this.mode = 'out'; }
  }

  fishStep(dt) {
    const T = this.trip;
    if (this.time - this.lastSignalAt > FISHING.RETURN_AFTER) { this.startReturn(); return; }
    for (let k = 0; k < 40; k++) {                  // keep the pursuit target LOOK ahead along the route
      this.routePoint(T.th, _rp);
      if (Math.hypot(_rp.x - this.wx, _rp.z - this.wz) >= FISHING.LOOK) break;
      T.th += T.dir * 0.05;
    }
    this.clearOf(_rp);
    this.steerTo(_rp.x, _rp.z, this.tripStyle.speed, dt);
  }

  // Fresh activity while heading home: back to the grounds, picking the route up at its nearest point.
  resumeFishing() {
    const T = this.trip;
    let best = Infinity;
    for (let k = 0; k < 24; k++) {
      const th = (k / 24) * TAU;
      this.routePoint(th, _rp);
      const d = Math.hypot(_rp.x - this.wx, _rp.z - this.wz);
      if (d < best) { best = d; T.th = th; }
    }
    this.mode = 'out';
  }

  // Head for an approach point out along the berth line (as far as 6.5 out, nearer if an island is in the way).
  startReturn() {
    const T = this.trip, side = this.pier?.side ?? 0, h = this.heading, s = Math.sin(h), c = Math.cos(h);
    const obs = obstaclesOf(this.world, this.clock());
    let best = -Infinity;
    for (const dist of APPROACH) {
      const lx = this.quay ? -side * dist : -side * 0.8, lz = this.quay ? -1.5 : -dist;
      const x = this.group.position.x + lx * c + lz * s, z = this.group.position.z - lx * s + lz * c;
      let gap = Infinity;
      for (let i = 0; i < obs.n; i++) {
        const o = obs.list[i];
        gap = Math.min(gap, Math.hypot(x - o.x, z - o.z) - o.r - this.wr);
      }
      if (gap > best + 0.05) { best = gap; T.ax = x; T.az = z; }
      if (gap >= 0.7) break;
    }
    this.mode = 'return';
    this.mt = 0;
  }

  returnStep(dt) {
    const T = this.trip, d = Math.hypot(T.ax - this.wx, T.az - this.wz);
    this.mt += dt;
    this.steerTo(T.ax, T.az, this.tripStyle.speed * clamp(d / 4 + 0.5, 0.5, 1), dt, clamp((d - 1.5) / 5, 0, 1), clamp((d - 1.3) / 3, 0, 1), d < 6);
    if (d < 1.3 || this.mt > 25) this.startDocking();      // never strand a boat: after 25 s it just comes in
  }

  // The last stretch home: a cubic Bezier in the berth frame that starts along the current heading and ends
  // straight in, timed so the speed carries over.
  startDocking() {
    const b = this.boat.position, yaw = this.boat.rotation.y, P = this.trip.path;
    const d = Math.hypot(b.x, b.z), L = clamp(d * 0.35, 1, 3);
    P[0] = b.x; P[1] = b.z;
    P[2] = b.x + Math.sin(yaw) * L; P[3] = b.z + Math.cos(yaw) * L;
    P[4] = 0; P[5] = -2.6; P[6] = 0; P[7] = 0;
    this.dockSecs = clamp((2 * (d + 1)) / Math.max(this.vel, 0.45), 2.5, 7);
    this.mode = 'docking';
    this.mt = 0;
  }

  dockStep(dt) {
    this.mt += dt;
    const k = Math.min(1, this.mt / this.dockSecs), s = 1 - (1 - k) * (1 - k), u = 1 - s, P = this.trip.path, b = this.boat;
    const w0 = u * u * u, w1 = 3 * u * u * s, w2 = 3 * u * s * s, w3 = s * s * s;
    b.position.x = w0 * P[0] + w1 * P[2] + w2 * P[4] + w3 * P[6];
    b.position.z = w0 * P[1] + w1 * P[3] + w2 * P[5] + w3 * P[7];
    const tx = 3 * u * u * (P[2] - P[0]) + 6 * u * s * (P[4] - P[2]) + 3 * s * s * (P[6] - P[4]);
    const tz = 3 * u * u * (P[3] - P[1]) + 6 * u * s * (P[5] - P[3]) + 3 * s * s * (P[7] - P[5]);
    if (Math.abs(tx) + Math.abs(tz) > 1e-4) b.rotation.y = Math.atan2(tx, tz);
    if (k >= 1) this.finishDocking();
  }

  finishDocking() {
    this.mode = 'moored';
    this.slipK = 0;
    this.boat.position.set(0, 0, 0);
    this.boat.rotation.y = 0;
    this.dockedFor = 0;
    this.vel = 0;
    this.stopWake();
    this.showGear(false);
    this.bump();
    if (this.hold > 0) {
      const n = this.hold;
      this.later(1.1, () => {
        this.hornPos(_v);
        this.engine.fx?.text?.(_v2.copy(_v).setY(_v.y + 0.2), `CATCH x${n}`, { color: '#7fe3ff', size: 0.75, rise: 1.5, secs: 1.6 });
      });
    }
  }

  // A burst of activity out at sea: a fish leaps out of the water into the boat.
  catchFish() {
    this.lastCatchAt = this.time;
    this.catches++;
    if (this.B.sub) this.surfaceT = 3.5;
    if (!this.fish) { this.fish = fishMesh(); this.boat.add(this.fish); }
    const side = rand() < 0.5 ? -1 : 1;
    this.fishX0 = side * (this.beam / 2 + 0.9);
    this.fishZ0 = (rand() - 0.3) * this.halfLen * 0.6;
    this.fishK = 0;
    this.fish.visible = true;
    const fx = this.engine.fx;
    if (fx) {
      this.boat.localToWorld(_v.set(this.fishX0, 0.05, this.fishZ0));
      fx.puff?.(_v, { color: FOAM, count: 7, size: 0.3, spread: 0.45, rise: 1.3, life: 0.7 });
      this.float.localToWorld(_v2.set(0, (this.B.top || 1.4) * 0.8, 0));
      fx.text?.(_v2, '+1', { color: '#ffd23f', size: 0.75, rise: 1.4, secs: 1.2 });
    }
    if (rand() < 0.35) seaLifeOf(this.world)?.squawkAt(this);
  }

  animateFish(dt) {
    if (this.fishK < 0) return;
    this.fishK += dt / 0.95;
    const k = Math.min(1, this.fishK), f = this.fish, cm = this.cargoM;
    const tx = 0, ty = cm.y * this.S + this.heave + 0.15, tz = cm.z * this.S;
    f.position.set(lerp(this.fishX0, tx, k), lerp(-0.2, ty, k) + Math.sin(Math.PI * k) * 1.7, lerp(this.fishZ0, tz, k));
    f.rotation.set(-k * TAU * 1.25, Math.atan2(tx - this.fishX0, tz - this.fishZ0), 0, 'YXZ');
    if (k >= 1) {
      f.visible = false;
      this.fishK = -1;
      this.hold = Math.min(12, this.hold + 1);
      if (this.engine.fx?.puff) {
        this.boat.localToWorld(_v.set(tx, ty, tz));
        this.engine.fx.puff(_v, { color: 0xffffff, count: 3, size: 0.18, spread: 0.3, rise: 0.4, life: 0.4 });
      }
    }
  }

  // Rods with trailing bobbers (small boats) or a cork-line net astern (bigger ones), only while out fishing.
  buildGear() {
    const st = this.tripStyle || KINDS[this.kind].trip || {}, B = this.B, S = this.S;
    const G = this.gear = { on: false, kind: st.gear, rods: null, tips: [], floats: [], lines: [] };
    if (!st.gear) return;
    const hb = (B.beam || 1.2) / 2, sz = B.sternZ ?? -(B.L || 2.4) / 2, dy = B.deckY ?? 0.4;
    const addLine = () => {
      const m = cyl(0.008, 0.008, 1, 3, mat(0xf2f2f2), { center: true });
      m.castShadow = false;
      this.boat.add(m);
      G.lines.push(m);
    };
    const addFloat = (x, z, color, r) => {
      const f = sphere(r, mat(color), { segments: 6, rings: 4 });
      f.castShadow = false;
      f.userData.x = x;
      f.userData.z = z;
      this.boat.add(f);
      G.floats.push(f);
    };
    if (st.gear === 'rods') {
      const rods = new THREE.Group();
      for (const s of [1, -1]) {
        const bx = s * hb * 0.72, by = dy + 0.04, bz = sz + 0.35;
        rods.add(at(cyl(0.012, 0.024, 1.15, 4, M.woodDark()), bx, by, bz, { rx: -0.8, rz: -s * 0.6 }));
        G.tips.push(V(0, 1.15, 0).applyEuler(_e.set(-0.8, 0, -s * 0.6)).add(_v.set(bx, by, bz)));
        addFloat(s * (hb * S + 1.0), sz * S - 2.3, 0xff4d4d, 0.075);
        addLine();
      }
      rods.visible = false;
      this.float.add(rods);
      G.rods = rods;
    } else {
      for (let i = 0; i < 5; i++) {
        const a = (i / 4 - 0.5) * 1.8;
        addFloat(Math.sin(a) * 1.6, sz * S - 1.0 - Math.cos(a) * 1.5, 0xffa53d, 0.065);
      }
      for (const s of [1, -1]) { G.tips.push(V(s * hb * 0.9, dy + 0.12, sz + 0.12)); addLine(); }
    }
    for (const o of G.floats) o.visible = false;
    for (const o of G.lines) o.visible = false;
  }

  showGear(on) {
    if (on && !this.gear) this.buildGear();
    const G = this.gear;
    if (!G) return;
    G.on = on;
    if (G.rods) G.rods.visible = on;
    for (const o of G.floats) o.visible = on;
    for (const o of G.lines) o.visible = on;
  }

  updateGear(T) {
    const G = this.gear;
    if (!G?.on) return;
    const S = this.S, fp = this.float.position;
    for (let i = 0; i < G.floats.length; i++) {
      const f = G.floats[i];
      f.position.set(f.userData.x + Math.sin(T * 0.8 + i * 1.3) * 0.12, this.heave * 0.6 + 0.03 + Math.sin(T * 3.1 + i * 1.7) * 0.035, f.userData.z);
    }
    for (let i = 0; i < G.lines.length; i++) {
      const tip = G.tips[i], f = G.kind === 'rods' ? G.floats[i] : G.floats[i === 0 ? 0 : G.floats.length - 1], l = G.lines[i];
      _v.set(fp.x + tip.x * S, fp.y + tip.y * S, fp.z + tip.z * S);
      _p.subVectors(f.position, _v);
      const len = _p.length();
      l.position.copy(_v).addScaledVector(_p, 0.5);
      l.scale.set(1, Math.max(len, 0.01), 1);
      l.quaternion.setFromUnitVectors(UP, _p.multiplyScalar(1 / Math.max(len, 1e-4)));
    }
  }

  // ---- per frame --------------------------------------------------------------------------------------------------

  tick(dt, t) {
    if (this.disposed || this.mode === 'gone') return;
    dt = Math.min(Math.max(Number(dt) || 0, 0), 0.1);
    this.time += dt;
    const T = Number.isFinite(this.engine.time) ? this.engine.time : Number.isFinite(t) ? t : this.time;
    for (let i = this.timers.length - 1; i >= 0; i--) {
      const tm = this.timers[i];
      if ((tm.t -= dt) > 0) continue;
      this.timers.splice(i, 1);
      try { tm.fn(); } catch (e) { console.error(e); }
    }
    const tgt = this.mode === 'moored' ? this.tAct : 0;
    this.act = damp(this.act, tgt, tgt > this.act ? 2.2 : 0.6, dt);
    if (this.tAct > 0.06) this.idleFor = 0; else this.idleFor += dt;
    if (this.tAct < 0.12) this.quietFor += dt;
    this.wearClock -= dt;
    if (this.wearClock <= 0) {
      this.wearClock = 0.5;
      this.updateWear(false);
      this.refreshLabel();
      this.updateZzz();
    }
    if (this.mode === 'moored') this.dockedFor += dt;
    this.updateDrift(dt);
    this.followLabel();
    this.updateMotion(dt);
    this.readLocalPose();
    if (this.B.sub) this.updateSub(dt);
    this.updateFloat(dt, T);
    this.animateParts(dt, T);
    this.animateFish(dt);
    this.updateGear(T);
    this.emitSmoke(dt);
    this.updateRope();
    this.billboard();
    if (this.crew) {
      this.float.updateWorldMatrix(true, false);
      this.crew.tick(dt, T, this.group.matrixWorld, this.shown());
    }
  }

  shown() {
    for (let o = this.group; o; o = o.parent) {
      if (!o.visible) return false;
      if (o.isScene) return true;
    }
    return false;
  }

  updateMotion(dt) {
    const b = this.boat;
    if (this.mode === 'castoff') this.castStep(dt);
    else if (this.mode === 'out') this.fishStep(dt);
    else if (this.mode === 'return') this.returnStep(dt);
    else if (this.mode === 'docking') this.dockStep(dt);
    else if (this.mode === 'arrive') {
      // a curve in from open water (quadratic Bezier, decelerating) that straightens out alongside the berth
      this.mt += dt;
      const k = Math.min(1, this.mt / this.arriveSecs), s = 1 - (1 - k) * (1 - k), P = this.path;
      const u = 1 - s;
      b.position.x = u * u * P[0] + 2 * u * s * P[2];
      b.position.z = u * u * P[1] + 2 * u * s * P[3];
      const tx = 2 * u * (P[2] - P[0]) - 2 * s * P[2], tz = 2 * u * (P[3] - P[1]) - 2 * s * P[3];
      const straighten = 1 - clamp((k - 0.72) / 0.28, 0, 1);
      b.rotation.y = Math.atan2(tx, tz) * straighten * straighten;
      if (k > 0.85 && this.wake) this.stopWake();
      if (k >= 1) { this.mode = 'moored'; b.position.set(0, 0, 0); b.rotation.y = 0; this.bump(); }
    } else if (this.mode === 'depart') {
      // slide off the berth (back out of a pontoon), swing the bow to open water, then steam away and fade
      this.mt += dt;
      const t = this.mt, sea = this.sea, side = this.pier?.side ?? 0;
      const off = ease.inOut(clamp((t - 0.3) / 1.8, 0, 1));
      const turn = ease.inOut(clamp((t - 1.3) / 2.4, 0, 1));
      const go = Math.max(0, t - 3.2), dist = 0.9 * go + 0.84 * go * go;
      const ox = !this.departOff ? 0 : this.pier ? -side * 1.3 : 0, oz = !this.departOff ? 0 : this.pier ? 0 : -2.2;
      b.position.x = this.departX0 + ox * off + this.departDir.x * dist;
      b.position.z = this.departZ0 + oz * off + this.departDir.z * dist;
      b.rotation.y = this.departYaw0 + (this.yawOut - this.departYaw0) * turn;
      if (t > 3.2 && !this.wake) this.startWake();
      const sh = clamp((t - 4.4) / 1.5, 0, 1);
      if (sh > 0) {
        this.shore.scale.setScalar(Math.max(0.001, 1 - ease.inCubic(sh)));
        if (this.crew) this.crew.hidden = sh > 0.5;
        if (sh >= 1) this.shore.visible = false;
      }
      const fade = clamp((t - 7.2) / 2.8, 0, 1);
      if (fade > 0) {
        this.setOpacity(1 - fade);
        if (this.label) this.label.el.style.opacity = String(1 - fade);
      }
      if (t >= 10) this.finishDepart();
    }
    let bx = 0, bz = 0;
    if (this.bumpT >= 0) {
      this.bumpT += dt;
      const w = 0.16 * Math.sin(this.bumpT * 11) * Math.exp(-this.bumpT * 4.5);
      bx = this.bumpX * w * 0.6; bz = this.bumpZ * w;
      if (this.bumpT > 1.4) { this.bumpT = -1; bx = bz = 0; }
    }
    // moored: at the berth (plus the arrival bump), or slipped off it while adrift
    this.tug = 0;
    if (this.mode === 'moored') {
      let yaw = 0;
      if (this.slipK > 0.001) {
        // surge out until the line snaps taut, get tugged back part way, repeat (slack -> taut)
        const u = (((this.time + this.phase) / DRIFT_PERIOD) % 1 + 1) % 1;
        const out = u < 0.7 ? 0.35 + 0.65 * ease.inOut(u / 0.7) : 1 - 0.65 * ease.outCubic((u - 0.7) / 0.3);
        const k = this.slipK * out;
        this.tug = u < 0.7 ? 0 : Math.sin((Math.PI * (u - 0.7)) / 0.3) * this.slipK;
        bx += this.drift.x * k; bz += this.drift.z * k;
        yaw = this.slipK * (0.08 * Math.sin(this.time * 0.31 + this.phase) + 0.05 * this.turnDir * this.tug);
      }
      b.position.set(bx, 0, bz);
      b.rotation.y = yaw;
    }
    if (dt > 0) {
      const sp = Math.hypot(b.position.x - this.prevX, b.position.z - this.prevZ) / dt;
      this.speed = damp(this.speed, sp, 6, dt);
    }
    this.prevX = b.position.x;
    this.prevZ = b.position.z;
  }

  // Ride the engine's waves: heave from the local sea height, pitch/roll from its slope. Busy boats wobble more.
  updateFloat(dt, T) {
    const e = this.engine, amp = seaAmp(e);
    const s = Math.sin(this.heading), c = Math.cos(this.heading), bz = this.boat.position.z, bx = this.boat.position.x;
    const wx = this.group.position.x + s * bz + c * bx, wz = this.group.position.z + c * bz - s * bx;
    const yaw = this.heading + this.boat.rotation.y, fs = Math.sin(yaw), fc = Math.cos(yaw);
    const hl = this.halfLen * 0.7, hb = this.beam * 0.5;
    const h0 = seaHeight(wx, wz, T, amp);
    const hf = seaHeight(wx + fs * hl, wz + fc * hl, T, amp), ha = seaHeight(wx - fs * hl, wz - fc * hl, T, amp);
    const hr = seaHeight(wx + fc * hb, wz - fs * hb, T, amp), hp = seaHeight(wx - fc * hb, wz + fs * hb, T, amp);
    const a = this.act, ph = this.phase, calm = e.settings?.reduceMotion ? 0.4 : 1;
    const dk = this.driftK;
    this.list = damp(this.list, this.listDir * (this.wear * 0.075 + dk * 0.07), 0.8, dt);
    let heave = h0 * 0.8 + Math.sin(T * 1.7 + ph) * 0.025 * (1 + 2.4 * a) * calm + Math.sin(T * 0.75 + ph) * 0.05 * dk * calm;
    let pitch = -Math.atan2(hf - ha, 2 * hl) * 0.75 + Math.sin(T * 2.3 + ph) * 0.025 * a * calm + 0.035 * this.tug;
    let roll = Math.atan2(hr - hp, 2 * hb) * 0.8 + Math.sin(T * 1.9 + ph * 1.3) * (0.015 + 0.04 * a) * calm + this.list -
      0.03 * this.listDir * this.tug;
    pitch -= Math.min(0.1, this.speed * 0.012);
    if (this.bumpT >= 0) {
      const w = Math.sin(this.bumpT * 11) * Math.exp(-this.bumpT * 4.5);
      pitch += 0.08 * w * this.bumpZ;
      roll -= 0.07 * w * this.bumpX;
    }
    if (this.hop > 0) {
      this.hop = Math.max(0, this.hop - dt * 2.2);
      heave += Math.sin((1 - this.hop) * Math.PI) * 0.2;
    }
    if (this.B.sub) heave += this.subY;
    this.float.position.y = heave;
    this.float.rotation.x = pitch;
    this.float.rotation.z = roll;
    this.heave = heave;
    if (this.tootT >= 0) {
      this.tootT += dt;
      const k = this.tootT, sq = Math.sin(k * 14) * Math.exp(-k * 5) * 0.07;
      this.float.scale.set(this.S * (1 - sq * 0.5), this.S * (1 + sq), this.S * (1 - sq * 0.5));
      if (k > 1.1) { this.tootT = -1; this.float.scale.setScalar(this.S); }
    }
  }

  // Browser submarine. Docked: surfaced while busy, and when quiet it dives until only the tower and periscope peek
  // out. Out fishing: cruises submerged (periscope wake), surfacing for a few seconds whenever it lands a catch.
  updateSub(dt) {
    const trip = this.mode === 'out' || this.mode === 'return';
    if (this.surfaceT > 0) this.surfaceT -= dt;
    let want = false;
    if (trip) want = this.surfaceT <= 0;
    else if (this.mode === 'moored') {
      this.subT -= dt;
      if (this.subT <= 0) { this.subIdleDown = !this.subIdleDown; this.subT = this.subIdleDown ? 9 + this.seed() * 7 : 12 + this.seed() * 8; }
      want = this.subIdleDown && this.act <= 0.25 && this.hold === 0 && (!this.crew || this.crew.allSeated());
    }
    const D = -0.82 * this.S;
    if (this.subState === 'up' && want) { this.subState = 'diving'; this.subK = 0; this.splash(8); }
    else if (this.subState === 'down' && !want) { this.subState = 'rising'; this.subK = 0; }
    if (this.subState === 'diving') {
      this.subK += dt / 2.2;
      this.subY = D * ease.inOut(Math.min(1, this.subK));
      if (this.subK >= 1) this.subState = 'down';
    } else if (this.subState === 'rising') {
      this.subK += dt / 1.6;
      this.subY = D * (1 - ease.outBack(Math.min(1, this.subK)));
      if (this.subK >= 1) { this.subState = 'up'; this.subY = 0; this.splash(10); }
    } else if (this.subState === 'down') {
      this.subY = D;
      this.bubbleAcc += dt;
      if (this.bubbleAcc > 1.3) { this.bubbleAcc = 0; this.splash(2, 0.12); }
    } else this.subY = 0;
    this.subDown = this.subState !== 'up';
    const p = this.B.periscope;
    if (p) {
      if (trip) p.rotation.y = damp(p.rotation.y, 0, 2, dt);
      else p.rotation.y = wrapAngle(p.rotation.y + dt * (this.subState === 'down' ? 1.1 : 0.2));
    }
  }

  splash(count, size = 0.3) {
    const fx = this.engine.fx;
    if (!fx?.puff) return;
    this.boat.localToWorld(_v.set((rand() - 0.5) * 0.6, 0.05, (rand() - 0.5) * this.halfLen));
    fx.puff(_v, { color: FOAM, count, size, spread: 0.5, rise: 0.8, life: 0.8 });
  }

  animateParts(dt, T) {
    const B = this.B, a = this.act, under = this.mode === 'moored' ? 1 : 3;
    for (const s of B.spin) s.o.rotation[s.axis] += dt * (s.idle + a * s.gain) * under;
    const dk = this.driftK;
    for (const f of B.flags) {
      f.f.rotation.y = Math.PI / 2 + Math.sin(T * 2.1 + f.ph) * 0.2 * (1 - 0.5 * dk);
      f.f.rotation.z = -0.45 * dk;                       // adrift: hangs limp
      f.seg.rotation.y = Math.sin(T * 4.3 + f.ph) * 0.4 + dk * Math.sin(T * 7.3 + f.ph * 2) * 0.22;
    }
    if (B.sails) B.sails.rotation.y = Math.sin(T * 0.7 + this.phase) * 0.08;
    if (B.siren) {
      const on = a > 0.3 || this.mode !== 'moored';
      const blink = Math.floor(T * 4) % 2 === 0;
      B.siren.red.visible = !on || blink;
      B.siren.blue.visible = !on || !blink;
    }
    const W = this.wearBits;
    if (W?.perch.visible) {
      const g = W.gull;
      if (W.flyT >= 0) {
        // shooed off by fresh paint (or leaving port): flap up and away
        W.flyT += dt;
        const k = W.flyT;
        g.g.position.set(0, k * k * 1.6 + k * 1.2, -k * 2.2);
        g.wl.rotation.set(0, 0, Math.sin(k * 26) * 0.9);
        g.wr.rotation.set(0, 0, -Math.sin(k * 26) * 0.9);
        if (k > 1.6) { W.perch.visible = false; W.flyT = -1; g.g.position.set(0, 0, 0); }
      } else {
        W.gullT += dt;
        const k = Math.min(1, W.gullT / 1.3);
        g.g.position.set(0, (1 - ease.outCubic(k)) * 1.8, 0);
        if (k < 1) {
          g.wl.rotation.set(0, 0, Math.sin(W.gullT * 24) * 0.8);
          g.wr.rotation.set(0, 0, -Math.sin(W.gullT * 24) * 0.8);
        } else {
          const stretch = Math.sin(W.gullT * 0.8 + this.phase) > 0.96;
          g.wl.rotation.set(0, stretch ? 0.3 : 1.25, stretch ? Math.sin(W.gullT * 20) * 0.5 : 0);
          g.wr.rotation.set(0, stretch ? -0.3 : -1.25, stretch ? -Math.sin(W.gullT * 20) * 0.5 : 0);
          const look = Math.sin(W.gullT * 0.5 + this.phase * 2);
          g.head.rotation.y = look > 0.55 ? 0.9 : look < -0.55 ? -0.9 : 0;
        }
      }
    }
  }

  emitSmoke(dt) {
    const fx = this.engine.fx, B = this.B;
    if (!fx || !B.stacks.length || B.sub) return;
    const a = this.mode === 'moored' ? this.act : this.fishing || this.mode === 'docking' ? Math.max(0.3, this.act) : 0.7;
    this.smokeAcc = Math.min(this.smokeAcc + dt * (0.08 + a * 2.6), 2);
    if (this.smokeAcc < 1) return;
    this.smokeAcc -= 1;
    const s = B.stacks[this.smokeI++ % B.stacks.length];
    if (s.steam && a < 0.2) return;
    s.o.getWorldPosition(_v);
    if (s.steam) fx.puff?.(_v, { color: s.c, count: 1, size: 0.22, spread: 0.15, rise: 1.0, life: 1.1 });
    else fx.smoke?.(_v, { count: 1, color: s.c, size: 0.28 + a * 0.25, rise: 1.1 + a * 0.6 });
  }

  // Mooring line from the boat to the shore. Adrift, it sags in the middle (two pieces) when the boat surges in, and
  // pulls straight once the boat has run out its length.
  updateRope() {
    const r = this.rope, r2 = this.rope2;
    if (!r?.visible) { if (r2?.visible) r2.visible = false; return; }
    const a = this.ropeAt, b = this.boat.position, E = this.ropeEnd, ry = this.boat.rotation.y;
    const cs = Math.cos(ry), sn = Math.sin(ry);
    _v.set(a.x * cs + a.z * sn + b.x, a.y + this.heave, -a.x * sn + a.z * cs + b.z);
    let sag = 0;
    if (this.slipK > 0.01) {
      // slack length: taut at 80% of the full slip
      if (!this.ropeRest) this.ropeRest = Math.hypot(E.x - a.x - this.drift.x * 0.8, E.y - a.y, E.z - a.z - this.drift.z * 0.8);
      const d = _v.distanceTo(E), L = this.ropeRest;
      if (d < L) sag = Math.min(0.42, Math.sqrt(L * L - d * d) * 0.5) * this.slipK;
    }
    if (sag < 0.005) {
      if (r2?.visible) r2.visible = false;
      span(r, _v, E);
      return;
    }
    if (!r2) {
      this.rope2 = cyl(0.02, 0.02, 1, 4, M.rope(), { center: true });
      this.rope2.userData.dynamic = true;
      this.rope2.castShadow = false;
      this.shore.add(this.rope2);
    }
    this.rope2.visible = true;
    _v2.addVectors(_v, E).multiplyScalar(0.5);
    _v2.y -= sag;
    span(r, _v, _v2);
    span(this.rope2, _v2, E);
  }

  // Adrift eases in and out: the look (flag droop, list, bob) at once; the slip off the berth waits for the stevedores
  // to sit down (nobody works an untended boat) and starts over from the berth after every docking.
  updateDrift(dt) {
    this.driftK = damp(this.driftK, this.adriftOn ? 1 : 0, 0.6, dt);
    if (this.mode !== 'moored') { this.slipK = 0; return; }
    const slip = this.adriftOn && (!this.crew || this.crew.allSeated());
    this.slipK = damp(this.slipK, slip ? 1 : 0, slip ? 0.3 : 0.5, dt);
  }

  // Signs turn to face the camera (Q/E rotate the view by 90°).
  billboard() {
    const az = this.engine.view?.azimuth ?? Math.PI / 4;
    if (this.signPost) this.signPost.rotation.y = az - this.heading;
    const S = this.wearBits?.sale;
    if (S?.visible) S.rotation.y = az - this.heading - this.boat.rotation.y;
  }

  updateZzz() {
    const on = !!this.crew && this.mode === 'moored' && this.crew.allDozing();
    if (on && !this.zzz && this.engine.labels?.add) {
      this.zzz = this.engine.labels.add({ object: this.zzzAnchor, html: '<div class="hb-zzz"><b>z</b><b>z</b><b>Z</b></div>', className: 'hb-zzz-lbl', visible: this.lblOn !== false });
    } else if (!on && this.zzz) {
      this.zzz.remove();
      this.zzz = null;
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    const fi = FLEET.indexOf(this);
    if (fi >= 0) FLEET.splice(fi, 1);
    this.stopWake();
    this.harbor?.leave(this);
    this.harbor = null;
    this.showSign(true);
    this.label?.remove();
    this.zzz?.remove();
    this.label = this.zzz = null;
    this.crew?.dispose();
    this.crew = null;
    disposeTree(this.group);
    for (const m of this.paints.values()) m.dispose();
    this.paints.clear();
    const r = this.departRes;
    this.departRes = null;
    r?.();
  }
}

// ---- ambient sea life: circling gulls, a whale that surfaces and spouts, a sea serpent around camp islands -------------

const SQUAWKS = ['SQUAWK!', 'MINE!', 'MINE?', 'KYAAA!', 'MEW!'];

function seaLifeOf(world) { return world ? autoSea.get(world)?.sea || null : null; }

// The world may create its own SeaLife. If it has not by the time the first vessel docks, the harbor starts one
// itself (ticked via engine.onFrame); a SeaLife the world creates later replaces it. world.seaLife = false opts out.
const autoSea = new WeakMap();
function ensureSeaLife(world) {
  if (!world || world.seaLife === false || autoSea.has(world)) return;
  for (const k of ['seaLife', 'sealife', 'sea']) if (world[k] instanceof SeaLife) return;
  const e = world.engine;
  if (!e?.onFrame || !e.scene) return;
  try {
    const sea = new SeaLife(world);
    autoSea.set(world, { sea, off: e.onFrame((dt, t) => sea.tick(dt, t)) });
  } catch (err) { console.error('[harbor] sea life failed', err); }
}

export class SeaLife {
  constructor(world) {
    this.world = world || {};
    this.engine = this.world.engine || {};
    const auto = world && autoSea.get(world);
    if (auto?.off) { auto.off(); auto.sea.dispose(); }
    if (world) autoSea.set(world, { sea: this, off: null });
    this.group = new THREE.Group();
    this.group.name = 'sealife';
    (this.engine.root || this.engine.scene)?.add(this.group);
    this.time = 0;
    this.spots = [{ x: 0, z: 0, r: 8, land: true }];
    this.spotT = 0;
    this.gulls = [];
    for (let i = 0; i < 5; i++) this.gulls.push(this.makeGull());
    this.fishers = [];
    this.squawkT = 25 + rand() * 30;
    this.whale = this.makeWhale();
    this.whaleT = 10 + rand() * 12;
    this.serpent = this.makeSerpent();
    this.serpentT = 5 + rand() * 8;
  }

  // Islands (with radius) and moored vessels: gulls circle them, the whale avoids them.
  scan() {
    const out = [], w = this.world;
    try {
      if (w.islands?.values) {
        for (const isl of w.islands.values()) {
          const p = isl?.group?.position;
          if (p) out.push({ x: p.x, z: p.z, r: Number(isl.radius) || 7, land: true, kind: isl.data?.kind, isl });
        }
      }
      if (w.town?.group?.position) out.push({ x: w.town.group.position.x, z: w.town.group.position.z, r: Number(w.town.radius) || 9, land: true });
      if (w.vessels?.values) {
        for (const v of w.vessels.values()) {
          const p = v?.group?.position;
          if (p) out.push({ x: p.x, z: p.z, r: 2.5, land: false });
        }
      }
    } catch (e) { /* the world is mid-update; try again next scan */ }
    if (!out.length) out.push({ x: 0, z: 0, r: 8, land: true });
    this.spots = out;
    this.fishers.length = 0;
    for (let i = 0; i < FLEET.length; i++) if (FLEET[i].world === this.world && FLEET[i].fishing) this.fishers.push(FLEET[i]);
  }

  // ---- gulls ------------------------------------------------------------------------------------------------------

  makeGull() {
    const m = gullModel();
    m.g.scale.setScalar(1.5);
    this.group.add(m.g);
    const G = { ...m, cx: 0, cz: 0, tx: 0, tz: 0, R: 4 + rand() * 4, h: 5 + rand() * 3, w: (0.35 + rand() * 0.3) * (rand() < 0.5 ? -1 : 1), a: rand() * TAU, flapT: rand() * 5, retarget: 0, dive: -1, ph: rand() * TAU, follow: null };
    m.wl.rotation.set(0, 0, 0);
    m.wr.rotation.set(0, 0, 0);
    return G;
  }

  // Gulls tail the fishing boats (low and tight); otherwise they circle islands and moored boats.
  notice(v) {
    let n = 0;
    for (const G of this.gulls) if (G.follow === v) n++;
    for (const G of this.gulls) {
      if (n >= 2) break;
      if (!G.follow && G.dive < 0) { this.follow(G, v); n++; }
    }
  }

  follow(G, v) {
    G.follow = v;
    G.R = 1.8 + rand() * 1.2;
    G.h = 2.4 + rand() * 1.3;
    G.retarget = 25 + rand() * 20;
  }

  squawkAt(v) {
    for (const G of this.gulls) {
      if (G.follow !== v) continue;
      this.engine.fx?.text?.(_v.copy(G.g.position).setY(G.g.position.y + 0.6), 'MINE!', { color: '#ffffff', size: 0.6, rise: 1.0, secs: 1.1 });
      return;
    }
  }

  tickGull(G, dt) {
    if (G.follow && (G.follow.disposed || !G.follow.fishing)) { G.follow = null; G.retarget = 0; G.h = 5 + rand() * 3; }
    G.retarget -= dt;
    if (G.retarget <= 0) {
      let f = null;
      if (this.fishers.length && rand() < 0.55) {
        f = this.fishers[Math.floor(rand() * this.fishers.length)];
        let n = 0;
        for (const o of this.gulls) if (o.follow === f) n++;
        if (n >= 2) f = null;
      }
      if (f) this.follow(G, f);
      else {
        G.follow = null;
        G.h = 5 + rand() * 3;
        const s = this.spots[Math.floor(rand() * this.spots.length)];
        G.tx = s.x + (rand() - 0.5) * 3;
        G.tz = s.z + (rand() - 0.5) * 3;
        G.R = s.r * 0.55 + 2 + rand() * 3;
        G.retarget = 16 + rand() * 22;
      }
      if (G.cx === 0 && G.cz === 0) { G.cx = G.tx; G.cz = G.tz; }
    }
    if (G.follow) { G.tx = G.follow.wx; G.tz = G.follow.wz; }
    const pull = G.follow ? 1.6 : 0.2;
    G.cx = damp(G.cx, G.tx, pull, dt);
    G.cz = damp(G.cz, G.tz, pull, dt);
    G.a += (G.w * dt * 4) / Math.max(2, G.R);
    const sa = Math.sin(G.a), ca = Math.cos(G.a), dir = G.w > 0 ? 1 : -1;
    let y = G.h + Math.sin(this.time * 0.7 + G.ph) * 0.4;
    if (G.dive >= 0) {
      G.dive += dt;
      const k = G.dive / 2.6;
      y -= Math.sin(Math.PI * Math.min(1, k)) * (G.h - 0.5);
      if (k >= 1) G.dive = -1;
    } else if (rand() < dt / 45) G.dive = 0;
    G.g.position.set(G.cx + ca * G.R, y, G.cz + sa * G.R);
    G.g.rotation.set(0, Math.atan2(-sa * dir, ca * dir), -dir * 0.3);
    G.flapT += dt;
    const flapping = Math.sin(G.flapT * 0.7 + G.ph) > 0.35 || G.dive >= 0;
    const f = flapping ? Math.sin(G.flapT * 12) * 0.7 : 0.1;
    G.wl.rotation.z = f;
    G.wr.rotation.z = -f;
  }

  // ---- whale --------------------------------------------------------------------------------------------------------

  makeWhale() {
    const g = new THREE.Group();
    g.visible = false;
    const skin = mat(0x3f6aa8), belly = mat(0xd3e6f4), dark = mat(0x2d4f82);
    const body = new THREE.Group();
    body.scale.setScalar(1.25);
    g.add(body);
    body.add(at(sphere(1, skin, { segments: 10, rings: 7 }), 0, 0, 0, { s: [1.05, 0.82, 2.3] }));
    body.add(at(sphere(0.95, belly, { segments: 10, rings: 6 }), 0, -0.24, 0.25, { s: [0.92, 0.58, 1.95] }));
    for (const s of [1, -1]) {
      body.add(at(sphere(0.1, M.black(), { segments: 6, rings: 4 }), s * 0.86, 0.05, 1.35));
      body.add(at(sphere(0.05, M.white(), { segments: 4, rings: 3 }), s * 0.91, 0.1, 1.4));
      body.add(at(box(0.9, 0.08, 0.42, skin, { center: true }), s * 1.1, -0.38, 0.55, { rz: s * 0.5, ry: s * 0.3 }));
    }
    body.add(at(cyl(0.1, 0.13, 0.1, 6, dark), 0, 0.76, 0.95));
    const tail = at(new THREE.Group(), 0, 0.08, -2.05);
    tail.add(at(cyl(0.2, 0.42, 1.0, 7, skin, { center: true }), 0, 0, -0.35, { rx: Math.PI / 2 }));
    tail.add(at(box(1.05, 0.1, 0.55, dark, { center: true }), 0.5, 0, -0.95, { ry: 0.28 }));
    tail.add(at(box(1.05, 0.1, 0.55, dark, { center: true }), -0.5, 0, -0.95, { ry: -0.28 }));
    body.add(tail);
    this.group.add(g);
    return { g, body, tail, t: -1, spouts: 0 };
  }

  // Open water near the middle of the view, away from islands and boats.
  pickWater() {
    const v = this.engine.view, c = v?.target, fp = Math.min(40, (this.engine.footprint?.() ?? 30) * 0.55);
    for (let i = 0; i < 24; i++) {
      const a = rand() * TAU, d = (0.25 + rand() * 0.75) * fp;
      const x = (c?.x ?? 0) + Math.cos(a) * d, z = (c?.z ?? 0) + Math.sin(a) * d;
      let ok = true;
      for (const s of this.spots) if (Math.hypot(x - s.x, z - s.z) < s.r + (s.land ? 6 : 4)) { ok = false; break; }
      if (ok) return { x, z };
    }
    let R = 10;
    for (const s of this.spots) R = Math.max(R, Math.hypot(s.x, s.z) + s.r);
    const a = rand() * TAU;
    return { x: Math.cos(a) * (R + 8), z: Math.sin(a) * (R + 8) };
  }

  tickWhale(dt) {
    const W = this.whale, fx = this.engine.fx;
    if (W.t < 0) {
      this.whaleT -= dt;
      if (this.whaleT > 0) return;
      const p = this.pickWater();
      W.t = 0; W.spouts = 0; W.yaw = rand() * TAU;
      W.g.position.set(p.x, -1.8, p.z);
      W.g.rotation.set(0, W.yaw, 0);
      W.body.rotation.set(0, 0, 0);
      W.tail.rotation.set(0, 0, 0);
      W.g.visible = true;
      return;
    }
    W.t += dt;
    const t = W.t, g = W.g;
    // glide forward the whole time
    const sp = 0.55 * dt;
    g.position.x += Math.sin(W.yaw) * sp;
    g.position.z += Math.cos(W.yaw) * sp;
    if (t < 1.8) g.position.y = lerp(-1.8, -0.38, ease.outCubic(t / 1.8));
    else if (t < 4.2) g.position.y = -0.38 + Math.sin((t - 1.8) * 2) * 0.05;
    else {
      const k = clamp((t - 4.2) / 3.2, 0, 1);
      W.body.rotation.x = ease.inOut(k) * 0.62;
      W.tail.rotation.x = -Math.sin(Math.PI * Math.min(1, k * 1.2)) * 0.9;
      g.position.y = -0.38 - ease.inQuad(k) * 1.9;
    }
    const spoutAt = [2.0, 2.7, 3.4];
    if (W.spouts < spoutAt.length && t >= spoutAt[W.spouts]) {
      W.spouts++;
      if (fx) {
        W.body.localToWorld(_v.set(0, 0.8, 0.95));
        fx.puff?.(_v, { color: 0xeafcff, count: 12, size: 0.45, spread: 0.3, rise: 4.2, life: 1.3 });
        fx.sparks?.(_v, 0xbff6ff, { count: 8, speed: 3.5, size: 0.14 });
        if (W.spouts === 1) fx.text?.(_v2.copy(_v).setY(_v.y + 1.8), 'PFFOOSH!', { color: '#c9f6ff', size: 0.75, rise: 1.4, secs: 1.4 });
      }
    }
    if (t > 6.6 && t - dt <= 6.6 && fx?.puff) {
      W.tail.localToWorld(_v.set(0, 0, -0.9));
      _v.y = 0.1;
      fx.puff(_v, { color: FOAM, count: 12, size: 0.5, spread: 1.2, rise: 0.8, life: 0.9 });
    }
    if (t > 8) {
      W.t = -1;
      g.visible = false;
      this.whaleT = 40 + rand() * 60;
    }
  }

  // ---- sea serpent ("HERE BE DRAGONS") --------------------------------------------------------------------------------

  makeSerpent() {
    const g = new THREE.Group();
    g.visible = false;
    const skin = mat(0x3fbf6a), fin = mat(0xffc53d), light = mat(0xc8f08a);
    const humps = [];
    for (let i = 0; i < 4; i++) {
      const h = new THREE.Group();
      const s = 1 - i * 0.12;
      h.add(at(torus(0.52 * s, 0.23 * s, 5, 10, skin, { arc: Math.PI }), 0, 0, 0));
      h.add(at(cone(0.12 * s, 0.34 * s, 4, fin), 0, 0.7 * s, 0));
      h.add(at(torus(0.52 * s, 0.1 * s, 4, 10, light, { arc: Math.PI }), 0, 0, 0.16 * s));
      g.add(h);
      humps.push(h);
    }
    const head = new THREE.Group();
    head.add(at(sphere(0.38, skin, { segments: 8, rings: 6 }), 0, 0, 0, { s: [0.95, 0.85, 1.2] }));
    head.add(at(box(0.4, 0.24, 0.42, skin), 0, -0.17, 0.32));
    head.add(at(box(0.34, 0.06, 0.36, light), 0, -0.2, 0.33));
    for (const s of [1, -1]) {
      head.add(at(sphere(0.12, M.white(), { segments: 6, rings: 4 }), s * 0.18, 0.15, 0.26));
      head.add(at(sphere(0.06, M.black(), { segments: 5, rings: 3 }), s * 0.2, 0.16, 0.36));
      head.add(at(cone(0.06, 0.26, 4, fin), s * 0.14, 0.27, -0.1, { rx: -0.5, rz: -s * 0.3 }));
      head.add(at(cone(0.08, 0.3, 4, fin), s * 0.32, 0.02, -0.14, { rz: -s * 1.2 }));
    }
    g.add(head);
    const tail = at(cone(0.16, 0.62, 5, skin), 0, 0, 0);
    g.add(tail);
    this.group.add(g);
    return { g, humps, head, tail, t: -1 };
  }

  tickSerpent(dt) {
    const S = this.serpent;
    if (S.t < 0) {
      this.serpentT -= dt;
      if (this.serpentT > 0) return;
      const camps = this.spots.filter((s) => s.kind === 'camp');
      if (!camps.length) { this.serpentT = 8; return; }
      const c = camps[Math.floor(rand() * camps.length)];
      S.t = 0; S.cx = c.x; S.cz = c.z; S.R = c.r + 2.4; S.a0 = rand() * TAU; S.dir = rand() < 0.5 ? 1 : -1;
      S.g.visible = true;
      return;
    }
    S.t += dt;
    const w = 0.42, dur = TAU / w, t = S.t;
    const emerge = Math.min(1, t / 1.4, Math.max(0, (dur - t) / 1.4));
    const sink = (1 - ease.inOut(emerge)) * -0.9;
    const a = S.a0 + S.dir * w * t;
    this.onRing(S, S.head, a, 0.4 + Math.sin(t * 3) * 0.06 + sink);
    S.head.rotation.set(0, Math.atan2(S.tx, S.tz), Math.sin(t * 2) * 0.1);
    for (let i = 0; i < S.humps.length; i++) {
      const h = S.humps[i];
      this.onRing(S, h, a - S.dir * (i + 1) * 0.24, -0.1 + Math.sin(t * 3.2 - i * 1.1) * 0.14 + sink);
      h.rotation.set(0, Math.atan2(-S.tz, S.tx), 0);
    }
    this.onRing(S, S.tail, a - S.dir * 5 * 0.24, 0.05 + Math.sin(t * 3.2 - 5) * 0.1 + sink);
    S.tail.rotation.set(-1.9, Math.atan2(S.tx, S.tz), 0, 'YXZ');
    if (t > 1.2 && t - dt <= 1.2) {
      S.head.getWorldPosition(_v);
      this.engine.fx?.text?.(_v2.copy(_v).setY(_v.y + 0.7), 'rawr.', { color: '#8dffb0', size: 0.6, rise: 1.2, secs: 1.3 });
    }
    if (t >= dur) {
      S.t = -1;
      S.g.visible = false;
      this.serpentT = 25 + rand() * 30;
    }
  }

  // Put o on the serpent's circle at angle ang, height y; leaves the travel direction in S.tx / S.tz.
  onRing(S, o, ang, y) {
    const sa = Math.sin(ang), ca = Math.cos(ang);
    o.position.set(S.cx + ca * S.R, y, S.cz + sa * S.R);
    S.tx = -sa * S.dir;
    S.tz = ca * S.dir;
  }

  // ---- per frame ------------------------------------------------------------------------------------------------------

  tick(dt, t) {
    if (this.disposed) return;
    dt = Math.min(Math.max(Number(dt) || 0, 0), 0.1);
    this.time += dt;
    if (!this.group.parent) (this.engine.root || this.engine.scene)?.add(this.group);
    this.spotT -= dt;
    if (this.spotT <= 0) { this.spotT = 6; this.scan(); }
    for (const G of this.gulls) this.tickGull(G, dt);
    this.squawkT -= dt;
    if (this.squawkT <= 0) {
      this.squawkT = 45 + rand() * 60;
      const G = this.gulls[Math.floor(rand() * this.gulls.length)];
      this.engine.fx?.text?.(_v.copy(G.g.position).setY(G.g.position.y + 0.6), SQUAWKS[Math.floor(rand() * SQUAWKS.length)], { color: '#ffffff', size: 0.6, rise: 1.0, secs: 1.2 });
    }
    this.tickWhale(dt);
    this.tickSerpent(dt);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    disposeTree(this.group);
  }
}
