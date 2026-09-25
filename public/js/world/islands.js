// Command & Context — islands.js
// Island: one procedural island per repo root (kind/tier driven) with worktree annex islets, expansion
// platforms, docks, stations and launch effects. PortTown: the central hub "Port Localhost".
// Contract: docs/DESIGN.md §3, §4 (Island), §6. Static geometry per island is merged into one
// vertex-coloured mesh, scatter is instanced, and only animated parts are separate objects.
import * as THREE from 'three';
import { PAL, mat, glow, box, rng, ease, tween, animate, wait, textSign, disposeTree, V3, lerp, clamp, tint, mix, freeze } from './kit.js';

const TAU = Math.PI * 2;
const LOT_SIZE = 5;
const LOT_HALF = 2.5;              // lots are true 5x5 squares (rotated by their facing)
const LOT_MARGIN = 0.5;            // features and scatter keep this far from any lot
const LOT_GAP = 0.3;               // walking room between neighbouring lots

// Rotated squares (lots): s = { x, z, f } with f = rotation.y. Local (lx, lz) -> world (lx cos f + lz sin f, -lx sin f + lz cos f).
function sqDist(px, pz, s, h) {
  const dx = px - s.x, dz = pz - s.z, c = Math.cos(s.f), sn = Math.sin(s.f);
  const lx = dx * c - dz * sn, lz = dx * sn + dz * c;
  return Math.hypot(Math.max(Math.abs(lx) - h, 0), Math.max(Math.abs(lz) - h, 0));
}
function sqSamples(s, h) {
  const c = Math.cos(s.f), sn = Math.sin(s.f), out = [];
  for (const [lx, lz, corner] of [[h, h, 1], [-h, h, 1], [h, -h, 1], [-h, -h, 1], [h, 0, 0], [-h, 0, 0], [0, h, 0], [0, -h, 0]]) out.push([s.x + lx * c + lz * sn, s.z - lx * sn + lz * c, corner]);
  return out;
}
function sqOverlap(a, b, h) {
  const range = (s, ax, az) => {
    const c = s.x * ax + s.z * az, cf = Math.cos(s.f), sf = Math.sin(s.f);
    const rr = h * (Math.abs(cf * ax - sf * az) + Math.abs(sf * ax + cf * az));
    return [c - rr, c + rr];
  };
  for (const s of [a, b]) for (const [ax, az] of [[Math.cos(s.f), -Math.sin(s.f)], [Math.sin(s.f), Math.cos(s.f)]]) {
    const p = range(a, ax, az), q = range(b, ax, az);
    if (p[1] < q[0] || q[1] < p[0]) return false;
  }
  return true;
}
const SIGN_YAW = Math.PI / 4;      // default camera azimuth: signs face +x+z
const TREE_SIDE = 3 * Math.PI / 4; // the Git Tree's rim: screen-left for the default camera (the banner flag goes screen-right of it)
const TIER_TITLE = ['', 'Outpost', 'Settlement', 'Stronghold', 'Citadel'];
const KIND_TITLE = { camp: 'Frontier Camp', sandbox: 'Sandbox Atoll', home: 'Homestead' };
const BANNER = [0xe63946, 0xff8a1f, 0xffc53d, 0x3ddc84, 0x1fb5e8, 0x7a4dff, 0xe24bd0, 0x2ed3c5];

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const trunc = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const angDiff = (a, b) => { let d = (a - b) % TAU; if (d > Math.PI) d -= TAU; if (d < -Math.PI) d += TAU; return d; };
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const hashNum = (s) => { let h = 2166136261; s = String(s); for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
const safe = (fn, ...a) => { try { return fn?.(...a); } catch (e) { console.warn('[islands]', e); return undefined; } };

// ---- shared materials ------------------------------------------------------------------------------

let SH = null;
function shared() {
  if (SH) return SH;
  const lam = (o) => new THREE.MeshLambertMaterial({ flatShading: true, ...o });
  SH = {
    vc: lam({ vertexColors: true }),
    windows: glow(PAL.window, 0.55),
    lamps: glow(0xffe6a8, 0.75),
    fire: lam({ color: 0xffa23a, emissive: new THREE.Color(0xff6a00), emissiveIntensity: 1.2 }),
    fireRed: lam({ color: 0xff4a1f, emissive: new THREE.Color(0xff2a00), emissiveIntensity: 1.0 }),   // outer flames (git conflicts)
    foam: new THREE.MeshBasicMaterial({ color: PAL.foam, transparent: true, opacity: 0.5, depthWrite: false }),
    lagoon: new THREE.MeshBasicMaterial({ color: 0x8ff5e6, transparent: true, opacity: 0.55, depthWrite: false }),
    beam: new THREE.MeshBasicMaterial({ color: 0xfff1b0, vertexColors: true, transparent: true, opacity: 0.12, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }),
    puff: lam({ color: 0xffffff }),
    spark: new THREE.MeshBasicMaterial({ color: 0xffffff }),
    rope: lam({ color: 0xd9c08a }),
  };
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const x = c.getContext('2d'); const gr = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.35, 'rgba(255,255,255,0.45)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = gr; x.fillRect(0, 0, 64, 64);
  SH.glowTex = new THREE.CanvasTexture(c); SH.glowTex.colorSpace = THREE.SRGBColorSpace;
  SH.glowTex.userData.shared = true;
  for (const m of Object.values(SH)) if (m?.isMaterial) m.userData.shared = true;
  return SH;
}

// A soft additive glow sprite (fire, lantern, beacons). Returns a Sprite with its own material.
function glowSprite(color, size, opacity = 0.6) {
  const m = new THREE.SpriteMaterial({ map: shared().glowTex, color, transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending });
  const s = new THREE.Sprite(m);
  s.scale.setScalar(size);
  s.renderOrder = 5;
  return s;
}

let lastSharedT = -1;
function updateShared(t, day) {
  if (t === lastSharedT) return;
  lastSharedT = t;
  const S = shared(), n = 1 - day;
  S.fire.emissiveIntensity = 1.0 + 0.3 * Math.sin(t * 17) * Math.sin(t * 7.3) + 0.6 * n;
  S.fireRed.emissiveIntensity = 0.9 + 0.25 * Math.sin(t * 13.1) * Math.sin(t * 6.1) + 0.5 * n;
  S.beam.opacity = 0.05 + 0.4 * n;
}

// ---- geometry builder (merge many primitives into one vertex-coloured mesh) --------------------------

const _v = new THREE.Vector3(), _q = new THREE.Quaternion(), _eu = new THREE.Euler(0, 0, 0, 'YXZ'), _sc = new THREE.Vector3();
const _col = new THREE.Color(), _m4 = new THREE.Matrix4(), _p3 = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

// o = { x, y, z, rx, ry, rz, s: number | [sx, sy, sz] }. Rotation order YXZ: yaw, then pitch, then roll.
function xform(o, out = new THREE.Matrix4()) {
  if (!o) return out.identity();
  _eu.set(o.rx || 0, o.ry || 0, o.rz || 0, 'YXZ');
  _q.setFromEuler(_eu);
  const s = o.s;
  if (s == null) _sc.set(1, 1, 1); else if (typeof s === 'number') _sc.set(s, s, s); else _sc.set(s[0], s[1], s[2]);
  _p3.set(o.x || 0, o.y || 0, o.z || 0);
  return out.compose(_p3, _q, _sc);
}

const PC = new Map();
const pc = (k, f) => { let g = PC.get(k); if (!g) { g = f(); g.userData.shared = true; PC.set(k, g); } return g; };
const r2 = (v) => Math.round(v * 100) / 100;
// Prototype geometries (base on y = 0 like kit.js, except ico/sph/tor which are centred).
const P = {
  box: (w, h, d) => pc(`b${w}|${h}|${d}`, () => new THREE.BoxGeometry(w, h, d).translate(0, h / 2, 0)),
  cyl: (rt, rb, h, s) => pc(`c${rt}|${rb}|${h}|${s}`, () => new THREE.CylinderGeometry(rt, rb, h, s).translate(0, h / 2, 0)),
  cone: (r, h, s) => pc(`k${r}|${h}|${s}`, () => new THREE.ConeGeometry(r, h, s).translate(0, h / 2, 0)),
  ico: (r, d) => pc(`i${r}|${d}`, () => new THREE.IcosahedronGeometry(r, d)),
  oct: (r) => pc(`o${r}`, () => new THREE.OctahedronGeometry(r, 0)),
  sph: (r, w, h) => pc(`s${r}|${w}|${h}`, () => new THREE.SphereGeometry(r, w, h)),
  hemi: (r, w, h) => pc(`h${r}|${w}|${h}`, () => new THREE.SphereGeometry(r, w, h, 0, TAU, 0, Math.PI / 2)),
  tor: (r, t, rs, ts, arc = TAU) => pc(`t${r}|${t}|${rs}|${ts}|${arc}`, () => new THREE.TorusGeometry(r, t, rs, ts, arc)),
};

class GeoBuilder {
  constructor(seed = 1) { this.p = []; this.c = []; this.stack = [new THREE.Matrix4()]; this.rand = rng(seed); }
  get top() { return this.stack[this.stack.length - 1]; }
  get empty() { return this.p.length === 0; }
  push(o) { this.stack.push(this.top.clone().multiply(xform(o))); return this; }
  pop() { if (this.stack.length > 1) this.stack.pop(); return this; }
  at(o, fn) { this.push(o); try { fn(this); } finally { this.pop(); } return this; }
  // Append a geometry transformed by the current matrix (and o). shade = per-triangle brightness jitter.
  add(geo, color, o, shade = 0, post = null) {
    const m = o ? new THREE.Matrix4().multiplyMatrices(this.top, xform(o)) : post ? this.top.clone() : this.top;
    if (post) m.multiply(_m4.makeScale(post[0], post[1], post[2]));
    const pos = geo.attributes.position, idx = geo.index, vc = geo.attributes.color;
    const n = idx ? idx.count : pos.count;
    _col.set(color ?? 0xffffff);
    const R = _col.r, G = _col.g, B = _col.b;
    let k = 1;
    for (let i = 0; i < n; i++) {
      const vi = idx ? idx.getX(i) : i;
      _v.fromBufferAttribute(pos, vi).applyMatrix4(m);
      this.p.push(_v.x, _v.y, _v.z);
      if (shade && i % 3 === 0) k = 1 + (this.rand() - 0.5) * 2 * shade;
      if (vc) this.c.push(R * vc.getX(vi) * k, G * vc.getY(vi) * k, B * vc.getZ(vi) * k);
      else this.c.push(R * k, G * k, B * k);
    }
    return this;
  }
  // Raw triangle in the current frame; hint = desired normal direction (winding is fixed to match).
  tri(a, b, c, color, hint) {
    let B = b, C = c;
    if (hint) {
      const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      if (nx * hint[0] + ny * hint[1] + nz * hint[2] < 0) { B = c; C = b; }
    }
    const m = this.top;
    for (const q of [a, B, C]) { _v.set(q[0], q[1], q[2]).applyMatrix4(m); this.p.push(_v.x, _v.y, _v.z); }
    _col.set(color);
    for (let i = 0; i < 3; i++) this.c.push(_col.r, _col.g, _col.b);
    return this;
  }
  quad(a, b, c, d, color, hint, color2) { this.tri(a, b, c, color, hint); return this.tri(a, c, d, color2 ?? color, hint); }
  // Primitives use unit prototypes scaled into place, so the prototype cache stays small.
  box(w, h, d, color, o, shade) { return this.add(P.box(1, 1, 1), color, o, shade, [w, h, d]); }
  cyl(rt, rb, h, seg, color, o, shade) {
    const big = Math.max(rt, rb) || 1e-3;
    return this.add(P.cyl(r2(rt / big), r2(rb / big), 1, seg), color, o, shade, [big, h, big]);
  }
  cone(r, h, seg, color, o, shade) { return this.add(P.cone(1, 1, seg), color, o, shade, [r, h, r]); }
  ico(r, d, color, o, shade) { return this.add(P.ico(1, d), color, o, shade, [r, r, r]); }
  oct(r, color, o) { return this.add(P.oct(1), color, o, 0, [r, r, r]); }
  sph(r, w, h, color, o) { return this.add(P.sph(1, w, h), color, o, 0, [r, r, r]); }
  hemi(r, w, h, color, o) { return this.add(P.hemi(1, w, h), color, o, 0, [r, r, r]); }
  tor(r, t, rs, ts, color, o, arc = TAU) { return this.add(P.tor(1, r2(t / r), rs, ts, r2(arc)), color, o, 0, [r, r, r]); }
  // A cylinder between two points (logs, poles, ropes).
  rod(a, b, radius, seg, color) {
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
    const L = Math.hypot(dx, dy, dz) || 1e-3;
    _q.setFromUnitVectors(UP, _v.set(dx / L, dy / L, dz / L));
    const m = new THREE.Matrix4().compose(_p3.set(a[0], a[1], a[2]), _q, _sc.set(radius, L, radius));
    this.stack.push(this.top.clone().multiply(m));
    this.add(P.cyl(1, 1, 1, seg), color);
    this.stack.pop();
    return this;
  }
  // Gable roof: ridge along local X at height h, eaves at z = ±d/2 (y = 0); endColor paints the gable ends.
  gable(w, h, d, color, o, endColor) {
    this.at(o || {}, () => {
      const x0 = -w / 2, x1 = w / 2, z0 = -d / 2, z1 = d / 2;
      this.quad([x0, 0, z1], [x1, 0, z1], [x1, h, 0], [x0, h, 0], color, [0, 1, 1]);
      this.quad([x0, 0, z0], [x0, h, 0], [x1, h, 0], [x1, 0, z0], tint(color, -0.1), [0, 1, -1]);
      const ec = endColor ?? tint(color, -0.18);
      this.tri([x0, 0, z0], [x0, 0, z1], [x0, h, 0], ec, [-1, 0, 0]);
      this.tri([x1, 0, z0], [x1, h, 0], [x1, 0, z1], ec, [1, 0, 0]);
    });
    return this;
  }
  // A thin tube through points ([x,y,z] arrays) — cables, ropes, rails.
  tube(pts, radius, color, segs = 10) {
    const curve = new THREE.CatmullRomCurve3(pts.map((q) => new THREE.Vector3(q[0], q[1], q[2])));
    const g = new THREE.TubeGeometry(curve, segs, radius, 4, false);
    this.add(g, color); g.dispose();
    return this;
  }
  // A beam between two points (box stretched from a to b).
  beam(a, b, w, h, color) {
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
    const L = Math.hypot(dx, dy, dz) || 1e-3;
    const m = new THREE.Matrix4();
    _q.setFromUnitVectors(UP, _v.set(dx / L, dy / L, dz / L));
    m.compose(_p3.set(a[0], a[1], a[2]), _q, _sc.set(w, L, h));
    this.stack.push(this.top.clone().multiply(m));
    this.add(P.box(1, 1, 1), color);
    this.stack.pop();
    return this;
  }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }
  mesh(material, { cast = true, receive = true } = {}) {
    if (this.empty) return null;
    const m = new THREE.Mesh(this.build(), material ?? shared().vc);
    m.castShadow = cast; m.receiveShadow = receive;
    return m;
  }
}

// ---- scatter prototypes (vertex-coloured, instanced) ------------------------------------------------

let PROTO = null;
function protos() {
  if (PROTO) return PROTO;
  const mk = (seed, fn) => { const b = new GeoBuilder(seed); fn(b); const g = b.build(); g.userData.shared = true; return g; };
  const leaf = PAL.leaf, leafD = PAL.leafDark, trunk = PAL.woodDark;
  PROTO = {
    lolly: mk(1, (b) => {
      b.cyl(0.07, 0.11, 0.78, 5, trunk);
      b.ico(0.52, 0, leaf, { y: 1.05, s: [1, 0.95, 1] }, 0.06);
      b.ico(0.3, 0, tint(leaf, 0.15), { x: 0.24, y: 1.36, z: 0.12 }, 0.05);
    }),
    cloud: mk(2, (b) => {
      b.cyl(0.07, 0.1, 0.62, 5, trunk);
      b.ico(0.42, 0, leafD, { y: 0.92 }, 0.06);
      b.ico(0.32, 0, leaf, { x: 0.33, y: 0.8, z: 0.1 }, 0.06);
      b.ico(0.3, 0, leaf, { x: -0.28, y: 0.84, z: -0.14 }, 0.06);
      b.ico(0.26, 0, tint(leaf, 0.12), { x: 0.02, y: 1.25, z: 0.05 }, 0.05);
    }),
    conifer: mk(3, (b) => {
      b.cyl(0.07, 0.1, 0.42, 5, trunk);
      b.cone(0.56, 0.78, 6, leafD, { y: 0.3 }, 0.05);
      b.cone(0.44, 0.68, 6, mix(leafD, leaf, 0.3), { y: 0.72 }, 0.05);
      b.cone(0.3, 0.56, 6, mix(leafD, leaf, 0.5), { y: 1.1 }, 0.05);
    }),
    blossom: mk(4, (b) => {
      b.cyl(0.07, 0.11, 0.74, 5, trunk);
      b.ico(0.5, 0, PAL.blossom, { y: 1.0, s: [1.05, 0.9, 1.05] }, 0.06);
      b.ico(0.28, 0, 0xffc2dc, { x: -0.22, y: 1.3, z: 0.1 }, 0.05);
    }),
    palm: mk(5, (b) => {
      let x = 0, y = 0;
      for (let i = 0; i < 5; i++) { b.cyl(0.075, 0.095, 0.42, 5, i % 2 ? 0xa0703f : 0x8a5c33, { x, y, rz: -0.1 - i * 0.05 }); x += 0.05 + i * 0.022; y += 0.4; }
      for (let k = 0; k < 7; k++) {
        const a = k / 7 * TAU + 0.3;
        b.cone(0.17, 1.05, 3, k % 2 ? leaf : leafD, { x, y: y + 0.02, ry: a, rx: Math.PI / 2 + 0.42, s: [1, 1, 0.3] });
      }
      b.ico(0.08, 0, 0x6b4a2a, { x: x + 0.08, y: y - 0.06, z: 0.05 });
      b.ico(0.08, 0, 0x6b4a2a, { x: x - 0.06, y: y - 0.08, z: -0.05 });
    }),
    rock: mk(6, (b) => {
      const g = new THREE.IcosahedronGeometry(0.34, 0);
      const pos = g.attributes.position; const r = rng(66);
      for (let i = 0; i < pos.count; i++) pos.setXYZ(i, pos.getX(i) * (0.8 + r() * 0.4), pos.getY(i) * (0.8 + r() * 0.4), pos.getZ(i) * (0.8 + r() * 0.4));
      b.add(g, PAL.rock, { y: 0.1, s: [1.1, 0.7, 1] }, 0.08);
      b.add(g, tint(PAL.rock, 0.1), { x: 0.3, y: 0.02, z: 0.12, s: 0.45 }, 0.08);
      g.dispose();
    }),
    bush: mk(7, (b) => {
      b.ico(0.32, 0, leafD, { y: 0.16, s: [1.2, 0.8, 1.1] }, 0.06);
      b.ico(0.22, 0, leaf, { x: 0.24, y: 0.14, z: 0.06, s: [1, 0.85, 1] }, 0.06);
    }),
    flowers: mk(8, (b) => {
      const spots = [[0, 0], [0.16, 0.08], [-0.12, 0.12], [0.05, -0.15], [-0.14, -0.08]];
      spots.forEach(([x, z], i) => {
        b.cyl(0.012, 0.012, 0.16 + i * 0.02, 3, 0x4f9a32, { x, z });
        b.ico(0.065, 0, 0xffffff, { x, y: 0.18 + i * 0.02, z });
      });
    }),
    tuft: mk(9, (b) => {
      b.cone(0.05, 0.34, 3, PAL.grassDark, { rz: 0.25 });
      b.cone(0.05, 0.42, 3, PAL.grassDark, { x: 0.06, rz: -0.12 });
      b.cone(0.045, 0.3, 3, mix(PAL.grassDark, PAL.grass, 0.4), { x: -0.05, z: 0.05, rx: 0.3 });
    }),
    shell: mk(10, (b) => { b.cone(0.09, 0.07, 5, 0xffd9c9, { s: [1, 1, 0.8] }); }),
  };
  return PROTO;
}

// ---- radial island profile ----------------------------------------------------------------------
// Everything is in the island's local frame (centre = origin, sea level y = 0). Angles: x = cos t, z = sin t.
function makeProfile(seed, R, top, opts = {}) {
  const r = rng(seed + '|shape');
  const amp = opts.amp ?? clamp((R - 6) / 6, 0.3, 1);
  const hs = [[2, 0.05], [3, 0.032], [5, 0.018], [7, 0.01]].map(([k, a]) => [k, a * amp * (0.6 + 0.8 * r()), r() * TAU]);
  const ph = [r() * TAU, r() * TAU, r() * TAU, r() * TAU, r() * TAU, r() * TAU];
  const raw = (t) => { let v = 1; for (const [k, a, p] of hs) v += a * Math.sin(k * t + p); return v; };
  let mx = 0;
  for (let i = 0; i < 256; i++) mx = Math.max(mx, raw(i / 256 * TAU));
  const beach = opts.beach ?? 1;
  const ledgeK = opts.ledge ?? 1;
  const over = opts.overhang ?? 0.2;
  const prof = {
    R, top, over,
    shore: opts.shore || ((t) => R * raw(t) / mx),
    beachW: (t) => beach * (0.68 + 0.18 * Math.sin(2 * t + ph[0]) + 0.1 * Math.sin(3 * t + ph[1])),
    ledge: (t) => ledgeK * (0.14 + 0.05 * Math.sin(3 * t + ph[2]) + 0.03 * Math.sin(5 * t + ph[3])),
    strata: (t) => 0.45 + 0.1 * Math.sin(2 * t + ph[4]) + 0.05 * Math.sin(4 * t + ph[5]),
  };
  prof.cliffBase = (t) => prof.shore(t) - prof.beachW(t);
  prof.cap = (t) => prof.cliffBase(t) - 0.1 - prof.ledge(t) - 0.08 + over;
  prof.plateau = (t) => prof.cap(t) - 0.2;
  let pmin = Infinity, pmax = 0;
  for (let i = 0; i < 128; i++) { const v = prof.plateau(i / 128 * TAU); pmin = Math.min(pmin, v); pmax = Math.max(pmax, v); }
  prof.pmin = pmin; prof.pmax = pmax;
  return prof;
}

// Terrain: underwater toe, sand beach, two cliff strata with a ledge, overhanging cap, flat top.
// pal = { cap, capSide, s1, s2, ledge, sand, wet, topFn(x, z) -> color }
function buildTerrain(b, prof, pal, seed, opts = {}) {
  const r = rng(seed + '|terrain');
  const R = prof.R, top = prof.top;
  const N = opts.N ?? Math.max(28, Math.round(TAU * R / 0.9));
  const J = (a) => (r() - 0.5) * a;
  const ang = [];
  for (let i = 0; i < N; i++) ang.push((i + J(0.5)) / N * TAU);
  const K = ['toe', 'water', 'beach', 's1b', 's1m', 's1t', 's2b', 's2m', 's2t', 'capB', 'capT'];
  const ring = Object.fromEntries(K.map((k) => [k, []]));
  const capY = top - (opts.capT ?? 0.3);
  for (let i = 0; i < N; i++) {
    const t = ang[i], c = Math.cos(t), s = Math.sin(t);
    const Pt = (rad, y) => [c * rad, y, s * rad];
    const shore = prof.shore(t), cb = prof.cliffBase(t), led = prof.ledge(t);
    const h1 = Math.min(capY - 0.12, 0.24 + (top - 0.62) * prof.strata(t) + J(0.08));
    ring.toe.push(Pt(shore + 0.75, -0.55));
    ring.water.push(Pt(shore + J(0.14), 0.03));
    ring.beach.push(Pt(cb + 0.05 + J(0.06), 0.3 + J(0.05)));
    const s1b = cb + 0.06, s1t = cb - 0.1 + J(0.08);
    ring.s1b.push(Pt(s1b, 0.18));
    ring.s1m.push(Pt((s1b + s1t) / 2 + J(0.16), (0.2 + h1) / 2 + J(0.1)));
    ring.s1t.push(Pt(s1t, h1));
    const s2b = s1t - led, s2t = s2b - 0.08 + J(0.06);
    ring.s2b.push(Pt(s2b, h1));
    ring.s2m.push(Pt((s2b + s2t) / 2 + J(0.14), (h1 + capY) / 2 + J(0.08)));
    ring.s2t.push(Pt(s2t, capY));
    const capR = prof.cap(t) + J(0.05);
    ring.capB.push(Pt(capR, capY - (prof.over > 0 ? r() * 0.16 : 0)));
    ring.capT.push(Pt(capR + 0.03, top));
  }
  const vary = (col, a) => { _col.set(col); const k = 1 + (r() - 0.5) * a; return new THREE.Color(_col.r * k, _col.g * k, _col.b * k); };
  const strip = (A, Bn, col, kind, a = 0.08, col2) => {
    for (let i = 0; i < N; i++) {
      const j = (i + 1) % N;
      const mxx = A[i][0] + A[j][0], mzz = A[i][2] + A[j][2];
      const hint = kind === 'up' ? [0, 1, 0] : kind === 'down' ? [0, -1, 0] : kind === 'slope' ? [mxx, Math.hypot(mxx, mzz) * 1.5, mzz] : [mxx, 0, mzz];
      b.tri(A[i], A[j], Bn[j], vary(col, a), hint);
      b.tri(A[i], Bn[j], Bn[i], vary(col2 ?? col, a), hint);
    }
  };
  strip(ring.toe, ring.water, pal.wet, 'slope', 0.05);
  strip(ring.water, ring.beach, pal.wet, 'slope', 0.06, pal.sand);
  strip(ring.s1b, ring.s1m, pal.s1, 'out', 0.12);
  strip(ring.s1m, ring.s1t, pal.s1, 'out', 0.12);
  strip(ring.s1t, ring.s2b, pal.ledge, 'up', 0.08);
  strip(ring.s2b, ring.s2m, pal.s2, 'out', 0.1);
  strip(ring.s2m, ring.s2t, pal.s2, 'out', 0.1);
  strip(ring.s2t, ring.capB, tint(pal.capSide, -0.25), 'down', 0.05);
  strip(ring.capB, ring.capT, pal.capSide, 'out', 0.08);
  // flat top: concentric rings towards the centre, coloured by a smooth patch function
  const fr = [1, 0.8, 0.6, 0.4, 0.22];
  const rings = [ring.capT];
  for (let k = 1; k < fr.length; k++) {
    rings.push(ring.capT.map((q) => { const f = fr[k] + (k ? J(0.05) : 0); return [q[0] * f, top, q[2] * f]; }));
  }
  const topFn = pal.topFn;
  for (let k = 0; k < rings.length - 1; k++) {
    const A = rings[k], Bn = rings[k + 1];
    for (let i = 0; i < N; i++) {
      const j = (i + 1) % N;
      const cx = (A[i][0] + A[j][0] + Bn[j][0]) / 3, cz = (A[i][2] + A[j][2] + Bn[j][2]) / 3;
      b.tri(A[i], A[j], Bn[j], topFn(cx, cz), [0, 1, 0]);
      const dx = (A[i][0] + Bn[j][0] + Bn[i][0]) / 3, dz = (A[i][2] + Bn[j][2] + Bn[i][2]) / 3;
      b.tri(A[i], Bn[j], Bn[i], topFn(dx, dz), [0, 1, 0]);
    }
  }
  const inner = rings[rings.length - 1];
  for (let i = 0; i < N; i++) {
    const j = (i + 1) % N;
    b.tri(inner[i], inner[j], [0, top, 0], topFn((inner[i][0] + inner[j][0]) / 3, (inner[i][2] + inner[j][2]) / 3), [0, 1, 0]);
  }
  return { N, ang, ring };
}

// Smooth-ish 2D noise from a few sines, roughly -1..1.
function noise2(seed) {
  const r = rng(seed + '|n');
  const p = [r() * TAU, r() * TAU, r() * TAU, r() * TAU];
  return (x, z) => 0.5 * Math.sin(x * 0.61 + p[0]) * Math.sin(z * 0.53 + p[1]) + 0.35 * Math.sin((x + z) * 1.13 + p[2]) + 0.25 * Math.sin((x - z) * 1.71 + p[3]);
}

// ---- particles (one instanced mesh per effect kind) -----------------------------------------------

class Particles {
  constructor(parent, kind = 'puff', max = 96) {
    const S = shared();
    const geo = kind === 'spark' ? P.oct(1) : P.ico(1, 0);
    this.mesh = new THREE.InstancedMesh(geo, kind === 'spark' ? S.spark : S.puff, max);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (let i = 0; i < max; i++) this.mesh.setColorAt(i, _col.set(0xffffff));
    this.mesh.count = 0;
    this.mesh.visible = false;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.max = max;
    this.ps = [];
    parent.add(this.mesh);
  }
  spawn(x, y, z, vx = 0, vy = 0, vz = 0, o = {}) {
    if (this.ps.length >= this.max) this.ps.shift();
    this.ps.push({ x, y, z, vx, vy, vz, age: o.age ?? 0, life: o.life ?? 1, size: o.size ?? 0.3, color: new THREE.Color(o.color ?? 0xffffff),
      grav: o.grav ?? 0, drag: o.drag ?? 0, grow: o.grow ?? 0, rot: Math.random() * TAU, spin: o.spin ?? 1 });
  }
  tick(dt) {
    let n = 0;
    const ps = this.ps;
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      p.age += dt;
      if (p.age >= p.life) continue;
      const d = Math.max(0, 1 - p.drag * dt);
      p.vx *= d; p.vz *= d; p.vy = p.vy * d - p.grav * dt;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      p.rot += p.spin * dt;
      const k = p.age / p.life;
      const s = p.size * (1 + p.grow * k) * Math.min(1, k / 0.12) * (1 - smooth(0.55, 1, k));
      _q.setFromAxisAngle(UP, p.rot);
      _m4.compose(_v.set(p.x, p.y, p.z), _q, _sc.set(s, s, s));
      this.mesh.setMatrixAt(n, _m4);
      this.mesh.setColorAt(n, p.color);
      ps[n++] = p;
    }
    ps.length = n;
    this.mesh.count = n;
    this.mesh.visible = n > 0;
    if (n || this._had) { this.mesh.instanceMatrix.needsUpdate = true; if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true; }
    this._had = n > 0;
  }
}

// ---- labels, floating text, canvas textures ---------------------------------------------------------

const LABEL_CSS = `
.isl-tag{font-family:"Chakra Petch",system-ui,sans-serif;background:rgba(14,22,48,.84);color:#fff;border:2px solid rgba(255,197,61,.85);
  border-radius:11px;padding:3px 11px 4px;text-align:center;box-shadow:0 3px 0 rgba(0,0,0,.35),inset 0 1px 0 rgba(255,255,255,.12);
  line-height:1.1;white-space:nowrap;pointer-events:none;transform-origin:50% 100%;zoom:var(--lk,1)}
.isl-tag .isl-name{font-family:"Lilita One","Arial Black",sans-serif;font-size:15px;letter-spacing:.3px;text-shadow:0 2px 0 rgba(0,0,0,.45)}
.isl-tag .isl-meta{font-size:11px;font-weight:700;margin-top:1px;opacity:.95}
.isl-tag .isl-title{color:#ffc53d;text-transform:uppercase;letter-spacing:.6px}
.isl-tag .isl-branch{color:#39e5ff}
.isl-tag .isl-dot{color:rgba(255,255,255,.45);margin:0 4px}
.isl-tag .isl-ico{display:inline-block;width:11px;height:11px;vertical-align:-1px;margin-right:3px}
.isl-tag.isl-t0{border-color:rgba(57,229,255,.7)}
.isl-tag.isl-t3,.isl-tag.isl-t4{border-width:3px}
.isl-tag.isl-t4 .isl-name{color:#ffe38a}
.isl-tag.isl-annex{border-color:rgba(57,229,255,.8);padding:2px 8px;border-radius:9px}
.isl-tag.isl-annex .isl-name{font-size:12px}
.isl-tag.isl-town{border-color:#39e5ff}
.isl-tag.isl-light{border-color:#ffe38a;background:rgba(40,20,8,.84)}
.isl-tag.isl-light .isl-name{color:#ffe38a;font-size:13px}
.isl-float{font-family:"Lilita One","Arial Black",sans-serif;font-size:15px;color:#fff;white-space:nowrap;pointer-events:none;zoom:var(--lk,1);
  text-shadow:0 2px 0 #0e1630,0 0 6px rgba(14,22,48,.8);animation:islFloat 3.4s ease-out forwards}
.isl-banner{font-family:"Lilita One","Arial Black",sans-serif;font-size:18px;letter-spacing:.4px;white-space:nowrap;pointer-events:none;color:#fff;
  padding:5px 15px 6px;border-radius:9px;border:2px solid #d8f4ff;background:linear-gradient(180deg,#2a8cf0,#1553b0);
  box-shadow:0 3px 0 rgba(0,0,0,.35),0 0 22px rgba(57,229,255,.55);text-shadow:0 2px 0 rgba(0,0,0,.4);transform-origin:50% 100%;
  animation:islBannerIn .6s ease-out both}
.isl-banner small{font-family:"Chakra Petch",sans-serif;font-weight:700;font-size:13px;opacity:.92;margin-left:6px}
.isl-banner.isl-maiden{background:linear-gradient(180deg,#8b5cf6,#5b2bc4);border-color:#f1e6ff;box-shadow:0 3px 0 rgba(0,0,0,.35),0 0 22px rgba(190,140,255,.6)}
.isl-banner.isl-merge{background:linear-gradient(180deg,#ffd54f,#f09a1a);border-color:#fff6cf;color:#3a2100;text-shadow:0 1px 0 rgba(255,255,255,.45);
  box-shadow:0 3px 0 rgba(0,0,0,.35),0 0 26px rgba(255,200,60,.75)}
.isl-banner .isl-arrow{margin:0 6px}
.isl-banner.isl-commit{background:linear-gradient(180deg,#ff7a4d,#d23a2c);border-color:#ffe3d6;box-shadow:0 3px 0 rgba(0,0,0,.35),0 0 22px rgba(255,120,80,.55)}
.isl-banner.isl-pull{background:linear-gradient(180deg,#35d17d,#138f55);border-color:#dcffe9;box-shadow:0 3px 0 rgba(0,0,0,.35),0 0 22px rgba(70,230,140,.5)}
.isl-banner.isl-prtag{font-size:14px;padding:3px 10px 4px;border-radius:7px;background:linear-gradient(180deg,#fff6dc,#efd9a3);border-color:#7a4b2b;
  color:#3b2a16;text-shadow:none;box-shadow:0 3px 0 rgba(0,0,0,.3)}
.isl-banner.isl-prtag .isl-ok{color:#1f9d55;margin-left:5px}
.isl-banner .isl-kick{font-size:12px;letter-spacing:.9px;margin-right:8px;padding:1px 6px 2px;border-radius:5px;background:rgba(0,0,0,.22);vertical-align:2px}
.isl-banner.isl-pulse{animation:islPulse .8s ease-out}
@keyframes islPulse{0%{transform:scale(1)}35%{transform:scale(1.22)}100%{transform:scale(1)}}
.isl-banner.isl-still{animation:none}
.isl-banner .isl-from{color:#8a2f00}
@keyframes islBannerIn{0%{opacity:0;transform:translateY(10px) scale(.35)}55%{opacity:1;transform:scale(1.14)}100%{opacity:1;transform:scale(1)}}
@keyframes islFloat{0%{opacity:0;transform:translateY(8px) scale(.7)}12%{opacity:1;transform:none}75%{opacity:1}100%{opacity:0;transform:translateY(-6px)}}
`;

function ensureCss(engine) { safe(() => engine?.labels?.css?.('cnc-islands', LABEL_CSS)); }
// stack: { group, role } lets engine.labels float a name tag above the island's session labels (labels.js).
function addLabel(engine, object, offset, html, className, kind = 'island', stack = null) {
  try { return engine?.labels?.add?.({ object, offset, html, className, kind, stack }) || null; } catch (e) { console.warn('[islands] label', e); return null; }
}

// Floating text: engine fx.text when available, otherwise an HTML label that rises and fades.
function floatText(owner, local, text, color = '#ffffff') {
  const eng = owner.engine;
  const wp = owner.group.localToWorld(local.clone());
  if (eng?.fx?.text) { try { eng.fx.text(wp, text, { color, size: 1, rise: 3 }); return; } catch (e) { /* fall through */ } }
  const o = new THREE.Object3D();
  o.position.copy(local);
  owner.group.add(o);
  const h = addLabel(eng, o, V3(0, 0, 0), `<div class="isl-float" style="color:${esc(color)}">${esc(text)}</div>`, 'isl-float-wrap', 'fx');
  const y0 = local.y;
  animate(3.4, (k) => { o.position.y = y0 + k * 2.4; }).then(() => { h?.remove?.(); o.removeFromParent(); });
}

function canvasTex(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function fitText(x, text, maxW, size, weight = 'bold', fam = '"Lilita One","Arial Black",sans-serif') {
  do { x.font = `${weight} ${size}px ${fam}`; size -= 2; } while (x.measureText(text).width > maxW && size > 10);
}

// Banner cloth texture: repo name + branch on a team colour.
function bannerTexture(name, branch, color) {
  const bg = '#' + new THREE.Color(color).getHexString();
  return canvasTex(256, 160, (x, w, h) => {
    x.fillStyle = bg; x.fillRect(0, 0, w, h);
    x.fillStyle = 'rgba(255,255,255,.18)'; x.fillRect(0, 0, w, 16); x.fillRect(0, h - 16, w, 16);
    x.fillStyle = 'rgba(0,0,0,.18)';
    for (let i = 0; i < 6; i++) x.fillRect(0, 16 + i * 22, 10, 11);
    x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillStyle = '#fff'; fitText(x, name, w - 36, 44);
    x.lineWidth = 6; x.strokeStyle = 'rgba(0,0,0,.35)'; x.strokeText(name, w / 2 + 4, 62); x.fillText(name, w / 2 + 4, 62);
    x.fillStyle = '#fff6c9'; fitText(x, branch, w - 70, 30, 'bold', '"Chakra Petch",sans-serif');
    const tw = x.measureText(branch).width, tx = w / 2 + 16, ty = 112;
    x.strokeText(branch, tx, ty); x.fillText(branch, tx, ty);
    const ix = tx - tw / 2 - 24, iy = ty - 12;
    x.strokeStyle = '#fff6c9'; x.lineWidth = 3.5;
    x.beginPath(); x.moveTo(ix, iy); x.lineTo(ix, iy + 24); x.moveTo(ix + 13, iy + 4); x.quadraticCurveTo(ix + 13, iy + 15, ix + 1, iy + 19); x.stroke();
    for (const [px, py] of [[ix, iy], [ix, iy + 24], [ix + 13, iy + 4]]) { x.beginPath(); x.arc(px, py, 4.2, 0, TAU); x.fill(); }
  });
}

const BRANCH_SVG = '<svg class="isl-ico" viewBox="0 0 16 16" aria-hidden="true"><g fill="currentColor"><circle cx="4" cy="3" r="2.2"/><circle cx="4" cy="13" r="2.2"/><circle cx="12" cy="4.5" r="2.2"/></g>'
  + '<path d="M4 5v6M12 6.5c0 3.5-5 3-7.2 5.2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';

// Two-sided wooden sign board with text on both faces. Returns a Group (board centred at origin).
function signBoard(text, w, h, { bg = '#6b4424', fg = '#ffe9b0', border = '#3e2612', thick = 0.07 } = {}) {
  const g = new THREE.Group();
  const board = box(w + 0.08, h + 0.08, thick, PAL.woodDark, { center: true });
  const front = textSign(text, { w, h, bg, fg, border });
  front.position.z = thick / 2 + 0.005;
  g.add(board, front);
  return g;
}

// ---- island parameters ------------------------------------------------------------------------------

const KINDS = ['repo', 'camp', 'sandbox', 'home'];
const topFor = (kind, tier) => ({ camp: 1.2, sandbox: 1.15, home: 1.45 })[kind] ?? [1.55, 1.55, 1.7, 1.85, 2.0][tier] ?? 1.6;
const kindOf = (d) => (KINDS.includes(d?.kind) ? d.kind : 'repo');
const tierOf = (d) => (kindOf(d) !== 'repo' ? 0 : clamp(Math.round(Number(d?.tier) || 1), 1, 4));
const baseRadius = (d) => ({ 0: 6, 1: 7, 2: 8.5, 3: 10, 4: 12 }[tierOf(d)] ?? 7) + 1.4 * Math.max(0, (d?.sessions || 0) - 2);
const branchCount = (d) => clamp(Math.round(Number(d?.git?.branches) || 1), 1, 12);
const defaultSign = (id) => (/^\d+$/.test(id) ? ':' + id : trunc(String(id).replace(/^ctr:/, ''), 16));

function paletteFor(kind, seed) {
  const n = noise2(seed);
  if (kind === 'camp') return {
    capSide: PAL.sandDark, s1: PAL.rockDark, s2: PAL.rock, ledge: tint(PAL.rock, 0.12), sand: PAL.sand, wet: PAL.sandDark,
    topFn: (x, z) => { const v = n(x, z); return v > 0.4 ? mix(PAL.grassLight, PAL.sand, 0.3) : v < -0.45 ? mix(PAL.sand, PAL.sandDark, 0.6) : mix(PAL.sand, PAL.sandDark, 0.2 + 0.15 * v); },
  };
  if (kind === 'sandbox') return {
    capSide: 0xe8bd72, s1: 0xd29b58, s2: 0xe6b872, ledge: 0xf3d08e, sand: 0xfbe3a8, wet: PAL.sandDark,
    topFn: (x, z) => mix(0xfbe6ae, PAL.sand, clamp(0.5 + 0.45 * n(x, z), 0, 1)),
  };
  return {
    capSide: PAL.grassDark, s1: PAL.cliffDark, s2: PAL.cliff, ledge: mix(PAL.grassDark, PAL.cliff, 0.3), sand: PAL.sand, wet: PAL.sandDark,
    topFn: (x, z) => { const v = n(x, z); return v > 0.42 ? PAL.grassLight : v < -0.5 ? mix(PAL.grass, PAL.grassDark, 0.7) : mix(PAL.grass, PAL.grassLight, clamp(0.3 + v * 0.4, 0, 1)); },
  };
}

// ---- Dock ---------------------------------------------------------------------------------------------
// root = landward end of the pier (world), berth = mooring point beside the pier (world, y = 0),
// dir = unit vector towards open water, facing = rotation.y that turns a boat's local +Z towards `dir`.

class Dock {
  constructor(owner, id, s) {
    this.owner = owner;
    this.id = id;
    this.container = !!s.container;
    this.t = s.t;
    this.halfW = s.halfW;
    this.ring = s.ring || 0;
    this.kind = s.kind || 'pier';
    const o = owner.position;
    this.dir = s.dir ? s.dir.clone() : new THREE.Vector3(Math.cos(s.t), 0, Math.sin(s.t));
    this.root = V3(o.x + s.root[0], s.rootY ?? 0.45, o.z + s.root[1]);
    this.pierEnd = V3(o.x + s.end[0], s.rootY ?? 0.45, o.z + s.end[1]);
    this.berth = V3(o.x + s.berth[0], 0, o.z + s.berth[1]);
    this.facing = s.facing ?? Math.atan2(this.dir.x, this.dir.z);
    this.pierHalfWidth = s.pierHalfWidth ?? (s.w != null ? s.w / 2 : undefined);
    this.group = new THREE.Group();
    this.group.name = `dock:${id}`;
    this.signAnchor = new THREE.Object3D();
    this.group.add(this.signAnchor);
    this.sign = null;
    this.signText = null;
    owner.group.add(this.group);
  }
  // Text on the dock's signpost, e.g. ":3000" or ":5432 :5433".
  setSign(text) {
    text = String(text ?? '').trim();
    if (text === this.signText) return;
    this.signText = text;
    if (this.sign) { disposeTree(this.sign); this.sign = null; }
    if (!text) return;
    const w = this.signW || 1.25;
    const g = textSign(text, { w: w - 0.08, h: 0.3, bg: '#1d2748', fg: '#ffe38a', border: '#ffc53d' });
    g.rotation.y = SIGN_YAW;
    g.position.set(Math.sin(SIGN_YAW) * 0.046, 0, Math.cos(SIGN_YAW) * 0.046);
    this.signAnchor.add(g);
    this.sign = g;
  }
  dispose() { disposeTree(this.group); }
}

// Wooden (or concrete, for container ships) pier built in the pier frame: +Z along the pier, +X to the berth side.
function buildPier(dock, s) {
  const b = new GeoBuilder(hashNum(dock.id));
  const bl = new GeoBuilder(2);
  const len = s.len, w = s.w, concrete = !!s.concrete;
  const frame = { x: s.root[0], z: s.root[1], ry: s.phi };
  for (const B of [b, bl]) B.push(frame);
  if (concrete) {
    b.box(w, 0.34, len, 0xcfcadb, { y: 0.14, z: len / 2 }, 0.03);
    for (const sx of [-1, 1]) {
      b.box(0.09, 0.03, len - 0.2, PAL.hazard, { x: sx * (w / 2 - 0.1), y: 0.48, z: len / 2 });
      for (let z = 0.8; z < len - 0.2; z += 1.6) b.cyl(0.07, 0.09, 0.2, 6, PAL.metalDark, { x: sx * (w / 2 - 0.22), y: 0.48, z });
    }
    for (let z = 1.2; z < len; z += 2.2) for (const sx of [-1, 1]) b.box(0.32, 1.3, 0.32, 0x9c97aa, { x: sx * w * 0.32, y: -1.1, z });
    b.box(w + 0.1, 0.18, 0.3, PAL.metalDark, { y: 0.32, z: len - 0.1 });
  } else {
    let i = 0;
    for (let z = 0.15; z < len; z += 0.3, i++) b.box(w, 0.07, 0.26, i % 3 === 1 ? tint(PAL.wood, -0.1) : PAL.wood, { y: 0.38, z, ry: (i % 2 - 0.5) * 0.04 }, 0.05);
    for (const sx of [-1, 1]) {
      b.box(0.1, 0.12, len, PAL.woodDark, { x: sx * (w / 2 - 0.08), y: 0.27, z: len / 2 });
      for (let z = 0.6; z < len; z += 1.2) b.cyl(0.07, 0.08, 1.45, 5, PAL.woodDark, { x: sx * (w / 2), y: -1.0, z });
    }
    b.cyl(0.08, 0.09, 0.75, 5, PAL.woodDark, { x: w / 2, y: 0.1, z: len - 0.12 });
    b.cyl(0.08, 0.09, 0.75, 5, PAL.woodDark, { x: -w / 2, y: 0.1, z: len - 0.12 });
    b.tor(0.13, 0.04, 4, 8, 0xd9c08a, { x: w / 2, y: 0.52, z: len - 0.5, rx: Math.PI / 2 });
  }
  // lantern at the end, signpost at the land end
  b.cyl(0.035, 0.045, 1.05, 5, PAL.metalDark, { x: -w / 2 + 0.08, y: 0.42, z: len - 0.2 });
  b.box(0.2, 0.05, 0.2, PAL.metalDark, { x: -w / 2 + 0.08, y: 1.66, z: len - 0.2 });
  bl.box(0.15, 0.2, 0.15, 0xfff0c0, { x: -w / 2 + 0.08, y: 1.46, z: len - 0.2 });
  b.cyl(0.05, 0.06, 1.6, 5, PAL.woodDark, { x: -w / 2 - 0.28, y: 0.15, z: 0.45 });
  dock.signW = concrete ? 1.7 : 1.25;
  b.box(dock.signW, 0.38, 0.07, PAL.woodDark, { x: -w / 2 - 0.28, y: 1.36, z: 0.45, ry: SIGN_YAW - s.phi });
  for (const B of [b, bl]) B.pop();
  const S = shared();
  const m = b.mesh(S.vc); if (m) dock.group.add(m);
  const ml = bl.mesh(S.lamps, { cast: false }); if (ml) dock.group.add(ml);
  // sign anchor in the pier frame (rotation about Y by phi: +X -> (cos, -sin), +Z -> (sin, cos))
  const c = Math.cos(s.phi), sn = Math.sin(s.phi);
  const lx = -w / 2 - 0.28, lz = 0.45;
  dock.signAnchor.position.set(s.root[0] + lx * c + lz * sn, 1.55, s.root[1] - lx * sn + lz * c);
}

function meanShore(prof) {
  if (!prof) return undefined;
  let s = 0;
  for (let i = 0; i < 64; i++) s += prof.shore(i / 64 * TAU);
  return s / 64 + 0.05;
}

function segDist(x, z, seg) {
  if (!seg) return Infinity;
  const [ax, az, bx, bz] = seg;
  const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz || 1e-6;
  const t = clamp(((x - ax) * dx + (z - az) * dz) / L2, 0, 1);
  return Math.hypot(x - ax - dx * t, z - az - dz * t);
}

// ---- Island ---------------------------------------------------------------------------------------------

export class Island {
  constructor(world, data, opts = {}) {
    this.world = world || {};
    this.engine = this.world.engine || {};
    this.data = data || {};
    this.id = String(this.data.id ?? 'island');
    this.kind = kindOf(this.data);
    this.tier = tierOf(this.data);
    this.radius = Math.max(4, Number(opts.radius) || baseRadius(this.data));
    this.position = new THREE.Vector3().copy(opts.position || V3());
    this.top = topFor(this.kind, this.tier);
    this.group = new THREE.Group();
    this.group.name = `island:${this.id}`;
    this.group.position.copy(this.position);
    this.group.userData.island = this;
    this.phase = (hashNum(this.id) % 1000) / 1000 * TAU;
    this.outAngle = Math.hypot(this.position.x, this.position.z) > 1 ? Math.atan2(this.position.z, this.position.x) : Math.PI / 4;
    this.backAngle = 5 * Math.PI / 4;
    this.lots = new Map();
    this.docks = new Map();
    this.annexes = new Map();
    this.platforms = [];
    this.fx = {};
    this.anim = [];
    this.born = this.engine.time ?? 0;
    this._disposed = false;
    this.nb = branchCount(this.data);
    this.ruins = (this.data.git?.commits ?? 0) > 1500;
    this.branch = this._branchName(this.data);
    ensureCss(this.engine);
    this._build();
    this._syncAnnexes();
    this._makeLabel();
    safe(() => this._gitSync());
    if (opts.instant === false) this._intro();
  }

  _branchName(d) { return d?.git?.branch || (this.kind === 'repo' ? 'main' : ''); }
  // Mean waterline radius (world.js sizes the engine foam ring with it).
  get shoreRadius() { return meanShore(this.prof); }
  get _young() { return (this.engine.time ?? 0) - this.born < 2.5; }
  _w(x, z, y = this.top) { return V3(this.position.x + x, y, this.position.z + z); }

  // ---- construction ----
  _build() {
    const keep = [...(this.L?.slots || [])].filter((s) => s.used);
    if (this.body) this._disposeBody();
    const body = this.body = new THREE.Group();
    body.name = 'body';
    this.group.add(body);
    this.anim = [];
    const kind = this.kind;
    const popt = kind === 'sandbox' ? { beach: 0.85 } : kind === 'camp' ? { beach: 0.8, overhang: 0.12 } : {};
    this.prof = makeProfile(this.id, this.radius, this.top, popt);
    const seed = hashNum(this.id);
    const ctx = { island: this, body, top: this.top, b: new GeoBuilder(seed), bw: new GeoBuilder(seed + 1), bl: new GeoBuilder(seed + 2), bc: new GeoBuilder(seed + 3), r: rng(this.id + '|feat') };
    buildTerrain(ctx.b, this.prof, paletteFor(kind, this.id), this.id);
    this._layout(keep);
    try { this._features(ctx); } catch (e) { console.warn('[islands] features', e); }
    try { this._scatter(ctx.b); } catch (e) { console.warn('[islands] scatter', e); }
    const S = shared();
    const add = (m, name) => { if (m) { m.name = name; body.add(freeze(m)); } return m; };   // merged statics: never move
    add(ctx.b.mesh(S.vc), 'static');
    add(ctx.bw.mesh(S.windows, { cast: false }), 'windows');
    add(ctx.bl.mesh(S.lamps, { cast: false }), 'lamps');
    this.crystalMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, emissive: new THREE.Color(PAL.crystal), emissiveIntensity: 0.7 });
    add(ctx.bc.mesh(this.crystalMat), 'crystals');
    if (!this.engine.addFoamRing) this._foam(body, this.prof, this.phase);
    this._computeStations();
    for (const s of this.L.slots) if (s.used) this._clearScatter(s, true);
  }

  _disposeBody() {
    this.body.traverse((o) => { if (o.isInstancedMesh) o.dispose(); });
    disposeTree(this.body);
    this.body = null;
    this.gitv = null;          // git props lived in the body; _gitSync rebuilds them on the new layout
    this.tree = null;
    this.flag = null;
    this.rocket = null;
    this.padTop = null;
  }

  _intro() {
    this.group.position.y = -2.5;
    this.group.scale.setScalar(0.85);
    tween(this.group.position, { y: this.position.y }, 1.4, ease.outBack);
    tween(this.group.scale, { x: 1, y: 1, z: 1 }, 1.4, ease.outBack);
    this._puff(V3(0, 0.3, 0), 0xe9fffb, 16, this.radius * 0.8);
  }

  // Lay out the plateau: lots (true rotated 5x5 squares, kept clear with a margin), plaza, centre piece (a repo's Git
  // Tree stands on the rim instead), flag, archive, pad, crystals, tier features, fishing spots, spare lots, and
  // tree-free walking corridors.
  _layout(keep = []) {
    const prof = this.prof, kind = this.kind, tier = this.tier;
    const r = rng(this.id + '|layout');
    const L = this.L = { occ: [], slots: [], crystals: [], lamps: [], turrets: [], pylons: [], silos: [], spires: [], shore: [], misc: {}, paths: [] };
    const occ = L.occ, slots = L.slots;
    const Pt = (t) => prof.plateau(t);
    const inside = (x, z, rad, slack = 0) => Math.hypot(x, z) + rad <= Pt(Math.atan2(z, x)) + slack;
    const free = (x, z, rad, pad = 0) => {
      for (const o of occ) if (Math.hypot(o.x - x, o.z - z) < o.r + rad + pad) return false;
      for (const s of slots) if (sqDist(x, z, s, LOT_HALF) < rad + LOT_MARGIN) return false;
      return true;
    };
    const take = (x, z, rad, tag, extra) => { const o = { x, z, r: rad, tag, ...extra }; occ.push(o); return o; };
    const find = (rad, score, { dMin = 0, dMax = 99, step = 0.33, slack = 0, pad = 0.2 } = {}) => {
      let best = null, bs = Infinity;
      const dm = Math.min(dMax, prof.pmax);
      for (let d = dMin; d <= dm; d += step) {
        const n = d < 0.05 ? 1 : Math.max(6, Math.floor(TAU * d / step));
        const a0 = r() * TAU;
        for (let i = 0; i < n; i++) {
          const t = a0 + i / n * TAU, x = Math.cos(t) * d, z = Math.sin(t) * d;
          if (!inside(x, z, rad, slack) || !free(x, z, rad, pad)) continue;
          const sc = score(x, z, d, t) + r() * 0.25;
          if (sc < bs) { bs = sc; best = { x, z, d, t }; }
        }
      }
      return best;
    };
    const place = (rad, tag, score, o = {}, extra) => {
      const p = find(rad, score, o) || (o.fallback !== false ? find(rad * 0.8, score, { ...o, slack: (o.slack || 0) + 0.3, pad: 0.05 }) : null);
      return p ? take(p.x, p.z, rad, tag, { t: Math.atan2(p.z, p.x), ...extra }) : null;
    };
    // a lot fits when its whole square is on the plateau and clear of other lots and features
    const lotOK = (x, z, f) => {
      const s = { x, z, f };
      for (const [px, pz, corner] of sqSamples(s, LOT_HALF)) if (Math.hypot(px, pz) > Pt(Math.atan2(pz, px)) + (corner ? 0.15 : 0)) return false;
      for (const o of slots) if (sqOverlap(s, o, LOT_HALF + LOT_GAP / 2)) return false;
      for (const o of occ) if (sqDist(o.x, o.z, s, LOT_HALF) < o.r + LOT_MARGIN) return false;
      return true;
    };
    // candidates face the plaza (radial) or the default camera; radial is slightly preferred
    const findLot = (score) => {
      let best = null, bs = Infinity;
      for (let d = 0; d <= prof.pmax; d += 0.1) {
        const n = d < 0.05 ? 1 : Math.max(8, Math.floor(TAU * d / 0.14));
        for (let i = 0; i < n; i++) {
          const t = i / n * TAU, x = Math.cos(t) * d, z = Math.sin(t) * d;
          const base = score(x, z, d, t);
          if (base >= bs) continue;
          const fr = Math.atan2(-x, -z);
          for (const [f, pen] of d < 0.05 ? [[SIGN_YAW, 0]] : [[fr, 0], [SIGN_YAW, 0.12]]) {
            if (base + pen >= bs || !lotOK(x, z, f)) continue;
            bs = base + pen; best = { x, z, f, d, t };
          }
        }
      }
      return best;
    };
    const addSlot = (p, hard) => { const s = { x: p.x, z: p.z, f: p.f, facing: p.f, hard, used: null, idx: slots.length }; slots.push(s); return s; };

    // lots already in use (rebuild after a tier change) stay exactly where they are
    for (const s of keep) { s.idx = slots.length; s.f = s.facing; slots.push(s); }
    // bridge landings of existing annexes
    for (const a of this.annexes.values()) take(Math.cos(a.t) * (Pt(a.t) - 0.4), Math.sin(a.t) * (Pt(a.t) - 0.4), 0.9, 'bridge');

    // 1) hard lots, pushed to the rim, starting at the back (the default camera looks from +x+z)
    const want = kind === 'repo' ? Math.max(2, this.data.sessions || 0) : Math.max(1, this.data.sessions || 0);
    const back = this.backAngle + (r() - 0.5) * 0.4;
    for (let i = keep.length; i < want; i++) {
      const p = findLot((x, z, d, t) => (prof.pmax - d) + Math.abs(angDiff(t, back)) * 0.9);
      if (!p) break;
      addSlot(p, true);
    }

    // 2) centre piece on the plaza: campfire (camp), sandcastle box (sandbox), cottage (home). A repo's plaza stays open
    //    ground (it is where the workers bustle) and its Git Tree stands on the rim, out of their way.
    const cpR = kind === 'repo' ? 1.0 + 0.055 * this.nb + 0.08 * tier : kind === 'camp' ? 1.15 : kind === 'sandbox' ? 1.5 : 1.45;
    if (kind === 'repo') {
      const plR = 1.2 + 0.08 * tier, rd = prof.pmin - cpR;
      L.plaza = place(plR, 'plaza', (x, z, d) => d, { pad: 0.3 }) || take(0, 0, plR, 'plaza');
      L.center = place(cpR, 'center', (x, z, d, t) => (Pt(t) - d) * 2 + Math.abs(angDiff(t, TREE_SIDE)) * 0.7, { pad: 0.3 })
        || take(Math.cos(TREE_SIDE) * rd, Math.sin(TREE_SIDE) * rd, cpR, 'center');
    } else L.center = L.plaza = place(cpR, 'center', (x, z, d) => d, { pad: 0.3 }) || take(0, 0, cpR, 'center');
    const C = L.center, P = L.plaza;
    const toP = (x, z) => Math.atan2(P.x - x, P.z - z);   // rotation.y that points local +Z at the plaza

    // 3) banner flag beside the centre piece (screen-right of it for the default camera, so it never hides it)
    const fa = -Math.PI / 4 + 0.45 + (r() - 0.5) * 0.3;
    const ft = [C.x + Math.cos(fa) * (C.r + 0.55), C.z + Math.sin(fa) * (C.r + 0.55)];
    L.flag = place(0.3, 'flag', (x, z) => Math.hypot(x - ft[0], z - ft[1]), { pad: 0.08 }) || take(ft[0], ft[1], 0.3, 'flag');

    // 4) archive near the plaza, door facing it
    const arR = kind === 'repo' ? [0, 0.85, 1.2, 1.35, 1.6][tier] : kind === 'camp' ? 0.55 : kind === 'sandbox' ? 0.5 : 0.6;
    const inFront = (x, z) => Math.max(0, Math.cos(Math.atan2(z - P.z, x - P.x) - Math.PI / 4));
    L.archive = place(arR, 'archive', (x, z) => Math.hypot(x - P.x, z - P.z) * 0.6 + inFront(x, z) * 2.2, { pad: 0.3 }) || take(P.x + P.r + arR, P.z, arR, 'archive');
    L.archive.face = toP(L.archive.x, L.archive.z);

    // 5) launch pad (spaceport on citadels) towards the front/rim
    const padR = tier >= 4 ? 2.05 : tier === 3 ? 1.15 : 0.55;
    L.pad = place(padR, 'pad', (x, z, d, t) => (Pt(t) - d) * 0.5 + Math.abs(angDiff(t, Math.PI / 4)) * 0.8 - Math.hypot(x - P.x, z - P.z) * 0.15, { pad: 0.35 })
      || take(P.x - P.r - padR, P.z, padR, 'pad');

    // 6) token crystals, spread out
    const nC = kind === 'repo' ? [0, 1, 2, 3, 3][tier] : 1;
    const cR = tier >= 3 ? 0.8 : 0.6;
    for (let i = 0; i < nC; i++) {
      const c = place(cR, 'crystal', (x, z, d) => {
        let md = 9; for (const o of L.crystals) md = Math.min(md, Math.hypot(o.x - x, o.z - z));
        return Math.abs(d - prof.pmin * 0.55) * 0.5 - Math.min(md, 6) * 0.45;
      }, { pad: 0.35, fallback: i === 0 });
      if (c) L.crystals.push(c);
    }

    // 7) legacy ruins for old repos
    if (this.ruins) L.ruins = place(1.3, 'ruins', (x, z, d, t) => (Pt(t) - d) * 0.6 + Math.abs(angDiff(t, this.backAngle + 1.2)) * 0.4, { pad: 0.3, fallback: false });

    // 8) kind features
    if (kind === 'camp') {
      L.misc.tents = [];
      for (let i = 0; i < 2; i++) {
        const tt = place(0.85, 'tent', (x, z) => Math.abs(Math.hypot(x - C.x, z - C.z) - (C.r + 1.1)), { pad: 0.2, fallback: false });
        if (tt) L.misc.tents.push(tt);
      }
      L.misc.sign = place(0.45, 'sign', (x, z, d, t) => (Pt(t) - d) + Math.abs(angDiff(t, Math.PI / 4 + 0.5)) * 0.8, { pad: 0.1, fallback: false });
    } else if (kind === 'sandbox') {
      L.misc.umbrella = place(0.75, 'umbrella', (x, z) => Math.abs(Math.hypot(x - C.x, z - C.z) - (C.r + 1.2)), { pad: 0.15, fallback: false });
      L.misc.bucket = place(0.35, 'bucket', (x, z) => Math.abs(Math.hypot(x - C.x, z - C.z) - (C.r + 0.5)), { pad: 0.05, fallback: false });
    } else if (kind === 'home') {
      L.misc.garden = place(0.95, 'garden', (x, z) => Math.hypot(x - C.x, z - C.z), { pad: 0.2, fallback: false });
      L.misc.doghouse = place(0.45, 'doghouse', (x, z) => Math.abs(Math.hypot(x - C.x, z - C.z) - (C.r + 0.9)), { pad: 0.15, fallback: false });
      L.misc.clothes = place(0.8, 'clothes', (x, z, d, t) => (Pt(t) - d) * 0.5, { pad: 0.15, fallback: false });
      L.misc.mailbox = place(0.2, 'mailbox', (x, z) => Math.abs(Math.hypot(x - C.x, z - C.z) - (C.r + 0.6)), { pad: 0.1, fallback: false });
    }

    // 9) tier features
    const spread = (list, x, z) => { let md = 9; for (const o of list) md = Math.min(md, Math.hypot(o.x - x, o.z - z)); return -Math.min(md, 7); };
    if (kind === 'repo' && tier >= 3) {
      for (let i = 0; i < (tier >= 4 ? 4 : 3); i++) {
        const tu = place(0.55, 'turret', (x, z, d, t) => (Pt(t) - d) * 2 + spread(L.turrets, x, z) * 0.5, { pad: 0.2, fallback: false });
        if (tu) L.turrets.push(tu);
      }
      for (let i = 0; i < (tier >= 4 ? 3 : 2); i++) {
        const si = place(0.62, 'silo', (x, z, d, t) => (L.silos.length ? Math.abs(Math.hypot(x - L.silos[0].x, z - L.silos[0].z) - 1.5) : (Pt(t) - d) * 0.5 + Math.abs(angDiff(t, this.backAngle - 1.4)) * 0.3), { pad: 0.15, fallback: false });
        if (si) L.silos.push(si);
      }
      for (let i = 0; i < (tier >= 4 ? 4 : 3); i++) {
        const prev = L.pylons[L.pylons.length - 1];
        const py = place(0.3, 'pylon', (x, z, d, t) => (prev ? Math.abs(Math.hypot(x - prev.x, z - prev.z) - 3.0) * 2 + (L.pylons.length > 1 ? -Math.hypot(x - L.pylons[0].x, z - L.pylons[0].z) * 0.3 : 0) : Math.abs(angDiff(t, this.backAngle + 2.2))) + (Pt(t) - d) * 0.6, { pad: 0.15, fallback: false });
        if (!py) break;
        L.pylons.push(py);
      }
    }
    if (kind === 'repo' && tier >= 4) {
      for (let i = 0; i < 3; i++) {
        const sp = place(0.45, 'spire', (x, z, d, t) => (Pt(t) - d) * 1.2 + spread(L.spires, x, z) * 0.6, { pad: 0.2, fallback: false });
        if (sp) L.spires.push(sp);
      }
    }
    if ((kind === 'repo' && tier >= 2) || kind === 'home') {
      const nl = kind === 'home' ? 2 : tier + 2;
      for (let i = 0; i < nl; i++) {
        const lp = place(0.16, 'lamp', (x, z) => Math.abs(Math.hypot(x - P.x, z - P.z) - (P.r + 1.25)) + spread(L.lamps, x, z) * 0.35, { pad: 0.3, fallback: false });
        if (lp) L.lamps.push(lp);
      }
    }

    // 10) fishing spots on the rim
    const nS = kind === 'repo' ? 4 : 3;
    for (let i = 0; i < nS; i++) {
      const sp = place(0.42, 'shore', (x, z, d, t) => (Pt(t) - d) * 3 + spread(L.shore, x, z) * 0.6, { dMin: prof.pmin * 0.6, pad: 0.05, fallback: false });
      if (sp) L.shore.push(sp);
    }

    // 10b) git work-tree props (see _gitSync; each shows only while the status calls for it): a laundry line on open
    //      ground towards the front, the crate stack beside the launch pad, the stash chest. Reserved so scatter keeps
    //      clear of them; they block units only while shown.
    if (kind === 'repo') {
      const pd = L.pad;
      const cratesAt = (x, z) => Math.abs(Math.hypot(x - pd.x, z - pd.z) - (pd.r + 1.1)) * 2 + Math.abs(Math.cos(Math.atan2(z - pd.z, x - pd.x) - Math.PI / 4)) * 0.9;
      const stashAt = (x, z, d, t) => Math.abs(angDiff(t, Math.PI / 2 + 0.2)) * 0.6 + Math.abs(d - prof.pmin * 0.55) * 0.45;
      // The laundry line is long and thin: test points along it, at a few headings near screen-across. Crowded little
      // islands get a shorter line, and as a last resort one along the edge of the plaza (open ground, not an obstacle).
      const lineAt = (half, plazaOK = false) => {
        const clear = (px, pz) => {
          if (!inside(px, pz, 0.3)) return false;
          for (const o of occ) if (!(plazaOK && o.tag === 'plaza') && Math.hypot(o.x - px, o.z - pz) < o.r + 0.38) return false;
          for (const s of slots) if (sqDist(px, pz, s, LOT_HALF) < 0.3 + LOT_MARGIN) return false;
          return true;
        };
        let best = null, bs = Infinity;
        for (let d = 0; d <= prof.pmax; d += 0.25) {
          const n = d < 0.05 ? 1 : Math.max(6, Math.floor(TAU * d / 0.25));
          for (let i = 0; i < n; i++) {
            const t = i / n * TAU, x = Math.cos(t) * d, z = Math.sin(t) * d;
            const base = Math.abs(angDiff(t, -0.1)) * 0.7 + Math.abs(d - prof.pmin * 0.5) * 0.45
              + (plazaOK ? Math.max(0, P.r + half * 0.3 - Math.hypot(x - P.x, z - P.z)) * 2 : 0);   // keep the plaza's middle open
            for (const [yaw, pen] of [[SIGN_YAW, 0], [SIGN_YAW + 0.4, 0.3], [SIGN_YAW - 0.4, 0.3], [SIGN_YAW + 0.8, 0.8], [SIGN_YAW - 0.8, 0.8]]) {
              if (base + pen >= bs) continue;
              const ux = Math.cos(yaw), uz = -Math.sin(yaw);        // the line's direction (local +X after rotation.y = yaw)
              let fits = true;
              for (const k of [-1, -0.5, 0, 0.5, 1, 1 + 0.45 / half]) if (!clear(x + ux * half * k, z + uz * half * k)) { fits = false; break; }
              if (fits) { bs = base + pen; best = { x, z, yaw, half }; }
            }
          }
        }
        return best;
      };
      // (the most common states claim their room first: dirty files, then unpushed commits, then stashes)
      const ln = lineAt(1.4) || lineAt(1.05) || lineAt(1.05, true) || lineAt(0.8, true);
      if (ln) {
        const ux = Math.cos(ln.yaw), uz = -Math.sin(ln.yaw), r = ln.half * 0.45 + 0.1;
        ln.parts = [-0.8, 0, 0.8].map((k) => take(ln.x + ux * ln.half * k, ln.z + uz * ln.half * k, r, 'laundry'));
      }
      L.git = {
        laundry: ln,
        crates: place(1.0, 'crates', cratesAt, { pad: 0.1, fallback: false }) || place(0.7, 'crates', cratesAt, { pad: 0.05 }),
        stash: place(0.85, 'stash', stashAt, { pad: 0.12, fallback: false }) || place(0.62, 'stash', stashAt, { pad: 0.05 }),
      };
    }

    // 11) spare lots (soft): trees may grow there until someone builds
    for (let i = 0; i < 6; i++) {
      const p = findLot((x, z, d, t) => (prof.pmax - d) + Math.abs(angDiff(t, back)) * 0.3);
      if (!p) break;
      addSlot(p, false);
    }

    // 12) walking corridors (lot doors -> stations) stay free of trees and rocks
    const targets = [L.plaza, L.archive, L.pad, ...L.crystals, ...L.shore];
    for (const s of slots) {
      if (!s.hard && !s.used) continue;
      const dx = s.x + Math.sin(s.f) * (LOT_HALF + 0.3), dz = s.z + Math.cos(s.f) * (LOT_HALF + 0.3);
      for (const g of targets) if (g) L.paths.push([dx, dz, g.x, g.z]);
    }
  }

  _computeStations() {
    const L = this.L, C = L.center, P = L.plaza;
    const st = this.stations || (this.stations = {});
    st.crystals = []; st.crystalClusters = [];
    for (const cr of L.crystals) {
      const a = Math.atan2(P.z - cr.z, P.x - cr.x);
      st.crystalClusters.push(this._w(cr.x, cr.z));
      for (const da of [-0.75, 0.75]) st.crystals.push(this._w(cr.x + Math.cos(a + da) * (cr.r + 0.4), cr.z + Math.sin(a + da) * (cr.r + 0.4)));
    }
    const ar = L.archive, aa = Math.atan2(P.z - ar.z, P.x - ar.x);
    st.archive = this._w(ar.x + Math.cos(aa) * (ar.r + 0.45), ar.z + Math.sin(aa) * (ar.r + 0.45));
    st.archiveCenter = this._w(ar.x, ar.z);
    st.shore = L.shore.map((s) => this._w(s.x, s.z));
    const ga = P === C ? Math.PI / 4 + 1.1 : Math.atan2(P.z - C.z, P.x - C.x);   // a rim tree: its plaza side
    st.gitTree = this._w(C.x + Math.cos(ga) * (C.r + 0.35), C.z + Math.sin(ga) * (C.r + 0.35));
    st.gitTreeCenter = this._w(C.x, C.z);
    st.launchPad = this._w(L.pad.x, L.pad.z);
    st.flag = this._w(L.flag.x, L.flag.z);
    const skip = new Set(['lot', 'soft', 'shore', 'flag', 'lamp', 'bridge', 'plaza', ...GIT_TAGS]);   // git props: _gitObs
    this.obstacles = L.occ.filter((o) => !skip.has(o.tag)).map((o) => ({ x: o.x + this.position.x, z: o.z + this.position.z, r: o.r, tag: o.tag }));
  }

  // ---- lots ----
  allocLot(key, opts = {}) {
    key = String(key);
    if (this.lots.has(key)) return this.lots.get(key);
    let lot = null;
    if (opts?.annex) lot = this._annexLot(key, String(opts.annex));
    if (!lot) {
      const slots = this.L.slots;
      const slot = slots.find((s) => s.hard && !s.used) || slots.find((s) => !s.used);
      if (slot) {
        slot.used = key;
        this._clearScatter(slot, this._young);
        lot = this._mkLot(key, slot.x, slot.z, slot.facing, { slot });
      }
    }
    if (!lot) lot = this._platformLot(key);
    this.lots.set(key, lot);
    return lot;
  }

  releaseLot(key) {
    key = String(key);
    const lot = this.lots.get(key);
    if (!lot) return;
    this.lots.delete(key);
    if (lot.slot) { lot.slot.used = null; this._restoreScatter(lot.slot); }
    if (lot.annexRec) {
      lot.annexRec.lotKey = null;
      if (!(this.data.annexes || []).some((a) => String(a.id) === lot.annexRec.id)) this._removeAnnex(lot.annexRec.id);
    }
    if (lot.plat) this._removePlatform(lot.plat);
  }

  _mkLot(key, x, z, facing, extra = {}) {
    return { key, position: this._w(x, z), facing, size: LOT_SIZE, annex: null, platform: false, island: this.id, ...extra };
  }

  // ---- stations & walking ----
  randomPoint(rnd = Math.random) {
    const prof = this.prof;
    for (let k = 0; k < 40; k++) {
      const t = rnd() * TAU, d = Math.sqrt(rnd()) * Math.max(0.5, prof.plateau(t) - 0.45);
      const x = Math.cos(t) * d, z = Math.sin(t) * d;
      if (this._blocked(x, z, 0.3)) continue;
      return this._w(x, z);
    }
    return this.stations.gitTree.clone();
  }

  _blocked(x, z, pad = 0) {
    for (const o of this.L.occ) {
      if (o.tag === 'soft' || o.tag === 'shore' || o.tag === 'bridge' || o.tag === 'lamp' || o.tag === 'lot' || o.tag === 'plaza') continue;
      if (Math.hypot(o.x - x, o.z - z) < o.r + pad) return true;
    }
    for (const l of this.lots.values()) {
      if (l.annexRec || l.plat || !l.slot) continue;
      if (sqDist(x, z, l.slot, LOT_HALF) < pad) return true;
    }
    return false;
  }

  walkable(p) {
    if (!p) return false;
    const x = p.x - this.position.x, z = p.z - this.position.z;
    if (Math.hypot(x, z) <= this.prof.plateau(Math.atan2(z, x)) - 0.05) return true;
    for (const a of this.annexes.values()) {
      const ax = x - a.x, az = z - a.z;
      if (Math.hypot(ax, az) <= a.prof.plateau(Math.atan2(az, ax)) - 0.05) return true;
      if (segDist(x, z, a.bridge) < 0.55) return true;
    }
    for (const pl of this.platforms) {
      if (pl.gone) continue;
      const dx = x - pl.x, dz = z - pl.z;
      const along = dx * pl.ux + dz * pl.uz, side = dx * pl.uz - dz * pl.ux;
      if (Math.abs(along) <= 2.8 && Math.abs(side) <= 2.8) return true;
      if (segDist(x, z, pl.walk) < 0.6) return true;
    }
    return false;
  }

  // ---- docks ----
  allocDock(id, opts = {}) {
    id = String(id);
    if (this.docks.has(id)) return this.docks.get(id);
    const spec = this._dockSpec(!!opts?.container);
    const dock = new Dock(this, id, spec);
    buildPier(dock, spec);
    dock.setSign(defaultSign(id));
    if (!this._young) {
      dock.group.position.y = -1.4;
      tween(dock.group.position, { y: 0 }, 0.7, ease.outBack);
    }
    this.docks.set(id, dock);
    return dock;
  }

  releaseDock(id) {
    id = String(id);
    const dock = this.docks.get(id);
    if (!dock) return;
    this.docks.delete(id);
    animate(2.4, (k) => { dock.group.position.y = k < 0.5 ? 0 : -1.8 * ease.inCubic((k - 0.5) / 0.5); }).then(() => dock.dispose());
  }

  _angleFree(t, halfW, Db, ring = 0) {
    for (const d of this.docks.values()) {
      if ((d.ring || 0) !== ring) continue;
      if (Math.abs(angDiff(t, d.t)) * Db < halfW + d.halfW + 0.3) return false;
    }
    for (const a of this.annexes.values()) {
      if (Math.abs(angDiff(t, a.t)) < Math.asin(clamp((a.R + 1.1) / a.D, 0, 1)) + halfW / Db) return false;
    }
    for (const p of this.platforms) {
      if (p.gone) continue;
      if (Math.abs(angDiff(t, p.t)) < Math.asin(clamp(3.4 / p.D, 0, 1)) + halfW / Db) return false;
    }
    return true;
  }

  // Search the shore for a free pier angle, starting at `start` and alternating outwards.
  _dockSpec(container, start = this.outAngle, exclude = null) {
    const prof = this.prof;
    const len0 = container ? 5.2 : 3.5, w = container ? 1.3 : 0.95, halfW = container ? 2.1 : 1.45, lat = container ? 1.8 : 1.3;
    for (let ring = 0; ring < 4; ring++) {
      const len = len0 + ring * 5.5;
      for (let k = 0; k < 150; k++) {
        const t = start + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 0.045;
        const Db = prof.shore(t) + len * 0.6;
        if (exclude?.(t, halfW / Db)) continue;
        if (!this._angleFree(t, halfW, Db, ring)) continue;
        return this._pierSpec(t, ring, container, len, w, halfW, lat);
      }
    }
    return this._pierSpec(start, 9, container, len0, w, halfW, lat);
  }

  _pierSpec(t, ring, container, len, w, halfW, lat) {
    const prof = this.prof;
    const a = prof.cliffBase(t) + 0.2, e = prof.shore(t) + len;
    const ux = Math.cos(t), uz = Math.sin(t), vx = uz, vz = -ux;
    const bAl = prof.shore(t) + len * 0.55;
    return {
      t, ring, container, halfW, len: e - a, w, concrete: container, phi: Math.atan2(ux, uz),
      root: [ux * a, uz * a], end: [ux * e, uz * e], berth: [ux * bAl + vx * lat, uz * bAl + vz * lat],
    };
  }

  // ---- label ----
  _labelHtml() {
    const d = this.data;
    const title = this.kind === 'repo' ? TIER_TITLE[this.tier] : KIND_TITLE[this.kind];
    const br = this.kind === 'repo' ? this.branch : (this.branch || (this.kind === 'camp' ? 'no git' : ''));
    return `<div class="isl-tag isl-t${this.tier} isl-${this.kind}"><div class="isl-name">${esc(trunc(d.name || this.id, 30))}</div>`
      + `<div class="isl-meta"><span class="isl-title">${esc(title)}</span>${br ? `<span class="isl-dot">·</span><span class="isl-branch">${BRANCH_SVG}${esc(trunc(br, 28))}</span>` : ''}</div></div>`;
  }

  _makeLabel() {
    if (!this.labelAnchor) { this.labelAnchor = new THREE.Object3D(); this.labelAnchor.name = 'labelAnchor'; this.group.add(this.labelAnchor); }
    // Above the island center (not the flag, which sat over the plaza); the labels layer also lifts it above the
    // island's session labels ('head' of the island's stack; buildings are its members).
    this.labelAnchor.position.set(0, this.top + 5.5, 0);
    if (!this.label) { this._labelLast = this._labelHtml(); this.label = addLabel(this.engine, this.labelAnchor, V3(0, 0, 0), this._labelLast, 'isl-label', 'island', { group: 'island:' + this.id, role: 'head' }); }
    else this._refreshLabel();
  }

  _refreshLabel() {
    const h = this._labelHtml();
    if (h === this._labelLast) return;
    this._labelLast = h;
    safe(() => this.label?.set(h));
  }

  // ---- data updates ----
  update(data) {
    if (!data || this._disposed) return;
    const prev = this.data;
    this.data = data;
    const kind = kindOf(data), tier = tierOf(data), nb = branchCount(data), ruins = (data.git?.commits ?? 0) > 1500;
    const branch = this._branchName(data);
    if (kind !== this.kind || tier !== this.tier || ruins !== this.ruins) {
      this.kind = kind; this.tier = tier; this.ruins = ruins; this.nb = nb; this.branch = branch;
      try { this._build(); } catch (e) { console.warn('[islands] rebuild', e); }
      this._makeLabel();
    } else {
      if (nb !== this.nb) { this.nb = nb; safe(() => this._rebuildTree()); }
      if (branch !== this.branch && this._pendingBranch !== branch) {
        // give a matching 'checkout' event a moment to take over (it lowers the flag first)
        this._pendingBranch = branch;
        wait(0.35).then(() => {
          if (this._disposed || this._swapping || this._pendingBranch !== branch) return;
          this._pendingBranch = null;
          this.branch = branch;
          safe(() => this._setBranchVisuals(branch));
        });
      } else if (prev?.name !== data.name) safe(() => this._setBranchVisuals(this.branch));
    }
    safe(() => this._syncAnnexes());
    safe(() => this._gitSync());
    this._refreshLabel();
  }

  // ---- per-frame ----
  tick(dt, t) {
    if (this._disposed) return;
    const day = this.engine.daylight ?? 1;
    updateShared(t, day);
    if (this.crystalMat) this.crystalMat.emissiveIntensity = 0.45 + 0.4 * (0.5 + 0.5 * Math.sin(t * 2.1 + this.phase)) + 0.7 * (1 - day);
    for (const f of this.anim) f(dt, t, day);
    for (const a of this.annexes.values()) for (const f of a.anim) f(dt, t, day);
    if (this.gitv) { try { this._gitTick(dt, t, day); } catch (e) { console.warn('[islands] git props', e); this.gitv = null; } }
    this._tickFx(dt, t);
    if (LAUNCH_TEST && t >= (this._testAt ??= t + (LAUNCH_TEST.hold ? 0 : 0.2))) {
      const first = !this._tested;
      this._tested = true;
      this._testAt = t + 11;
      const fx = safe(() => this._launchTest(LAUNCH_TEST.type, first ? LAUNCH_TEST.skip : 0));
      if (first && LAUNCH_TEST.hold && fx) { fx.hold = Math.min(LAUNCH_TEST.skip, fx.dur - 0.01); this._testAt = Infinity; }
    }
    this.fx.puffs?.tick(dt);
    this.fx.sparks?.tick(dt);
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    for (const f of this._fxList || []) safe(() => f.end());
    this._fxList = [];
    safe(() => this.label?.remove());
    for (const a of this.annexes.values()) { safe(() => a.label?.remove()); safe(() => a.foam?.remove()); }
    this.group.traverse((o) => { if (o.isInstancedMesh) o.dispose(); });
    disposeTree(this.group);
    this._fireMat?.dispose();
    this.gitv = null;
    this.docks.clear(); this.lots.clear(); this.annexes.clear(); this.platforms = [];
  }

  // ---- small effect helpers ----
  _parts(kind) {
    const k = kind === 'spark' ? 'sparks' : 'puffs';
    if (!this.fx[k]) this.fx[k] = new Particles(this.group, kind, kind === 'spark' ? 160 : 110);
    return this.fx[k];
  }

  _puff(p, color = 0xffffff, count = 6, spread = 0.5, o = {}) {
    const P = this._parts('puff');
    for (let i = 0; i < count; i++) {
      const a = Math.random() * TAU, s = Math.random() * spread;
      P.spawn(p.x + Math.cos(a) * s, p.y, p.z + Math.sin(a) * s, Math.cos(a) * (o.out ?? 0.8), (o.up ?? 0.9) + Math.random() * 0.6, Math.sin(a) * (o.out ?? 0.8),
        { life: o.life ?? 1.2, size: (o.size ?? 0.28) * (0.7 + Math.random() * 0.6), color, drag: 1.5, grow: 0.8 });
    }
  }

  _sparkBurst(p, colors, count = 30, speed = 4, o = {}) {
    const P = this._parts('spark');
    for (let i = 0; i < count; i++) {
      const a = Math.random() * TAU, e = Math.random() * Math.PI - Math.PI / 2;
      const v = speed * (0.6 + Math.random() * 0.5);
      P.spawn(p.x, p.y, p.z, Math.cos(a) * Math.cos(e) * v, Math.sin(e) * v + (o.up ?? 0), Math.sin(a) * Math.cos(e) * v,
        { life: (o.life ?? 1.3) * (0.7 + Math.random() * 0.6), size: o.size ?? 0.12, color: colors[i % colors.length], grav: o.grav ?? 3.5, drag: 1.2, spin: 6 });
    }
  }
}

// ---- feature builders (static parts go into the island's merged builders) --------------------------
// ctx = { island, body, top, b (opaque), bw (windows), bl (lamps), bc (crystal glow), r (rng) }

const tangentYaw = (a) => Math.atan2(-Math.cos(a), -Math.sin(a));   // rotation.y putting local +X along the tangent at angle a
const radialYaw = (a) => Math.atan2(Math.cos(a), Math.sin(a));      // rotation.y putting local +Z along the radial direction
const dampTo = (a, b, l, dt) => a + (b - a) * (1 - Math.exp(-l * dt));
// Island-local position of a point given in a feature frame (origin fx/fz, rotation.y = ry).
const frameXZ = (fx, fz, ry, lx, lz) => [fx + lx * Math.cos(ry) + lz * Math.sin(ry), fz - lx * Math.sin(ry) + lz * Math.cos(ry)];

function featFlag(isl, ctx, f) {
  const { b, top } = ctx;
  const H = 3.1;
  b.cyl(0.15, 0.19, 0.14, 6, PAL.metalDark, { x: f.x, y: top, z: f.z });
  b.cyl(0.045, 0.06, H, 6, 0xdfe5ee, { x: f.x, y: top, z: f.z });
  b.ico(0.09, 0, PAL.hazard, { x: f.x, y: top + H + 0.06, z: f.z });
  const color = BANNER[hashNum(isl.id) % BANNER.length];
  const geo = new THREE.PlaneGeometry(1.35, 0.85, 9, 3);
  geo.translate(0.725, 0, 0);
  const base = Float32Array.from(geo.attributes.position.array);
  const mat = new THREE.MeshLambertMaterial({ map: bannerTexture(isl.data.name || isl.id, isl._flagBranch(), color), side: THREE.DoubleSide });
  const cloth = new THREE.Mesh(geo, mat);
  cloth.castShadow = true;
  const holder = new THREE.Group();
  const y1 = top + H - 0.5;
  holder.position.set(f.x, y1, f.z);
  holder.rotation.y = SIGN_YAW;
  holder.add(cloth);
  isl.body.add(holder);
  isl.flag = { holder, cloth, geo, base, mat, color, y1 };
  const pos = geo.attributes.position;
  isl.anim.push((dt, t) => {
    const ph = isl.phase;
    for (let i = 0; i < pos.count; i++) {
      const x = base[i * 3], y = base[i * 3 + 1], k = x / 1.45;
      pos.setZ(i, Math.sin(x * 3.6 - t * 5.2 + ph) * 0.13 * k + Math.sin(y * 4 + t * 3.1) * 0.03 * k);
      pos.setY(i, y - k * k * 0.06);
    }
    pos.needsUpdate = true;
  });
}

function featArchive(isl, ctx, a) {
  const { b, bw, bl, bc, top } = ctx;
  const o = { x: a.x, y: top, z: a.z, ry: a.face };
  for (const B of [b, bw, bl, bc]) B.push(o);
  try {
    if (isl.kind === 'camp') archChest(b);
    else if (isl.kind === 'sandbox') archLibraryBox(b, bw);
    else if (isl.kind === 'home') archBench(b);
    else if (isl.tier <= 1) archShed(b, bw);
    else if (isl.tier === 2) archLibrary(b, bw, bl);
    else archVault(isl, ctx, a);
  } finally { for (const B of [b, bw, bl, bc]) B.pop(); }
}

function archChest(b) {
  b.box(0.72, 0.36, 0.46, PAL.wood, {}, 0.05);
  b.box(0.76, 0.06, 0.5, PAL.woodDark, { y: 0.08 });
  b.box(0.76, 0.06, 0.5, PAL.woodDark, { y: 0.26 });
  b.at({ y: 0.36, z: -0.23, rx: -1.15 }, () => b.box(0.74, 0.09, 0.47, tint(PAL.wood, 0.06), { z: 0.235 }));
  b.rod([-0.3, 0.2, 0.02], [0.05, 0.62, -0.05], 0.05, 6, 0xfff4d6);
  b.rod([0.28, 0.22, 0.05], [0.02, 0.58, 0.1], 0.045, 6, 0xf0e2b8);
  b.cyl(0.07, 0.07, 0.03, 8, 0xffc53d, { x: 0.3, z: 0.36 });
  b.cyl(0.07, 0.07, 0.03, 8, 0xffd966, { x: 0.38, y: 0.03, z: 0.3 });
  b.cyl(0.07, 0.07, 0.03, 8, 0xffc53d, { x: 0.22, z: 0.44 });
}

function archLibraryBox(b, bw) {
  b.cyl(0.05, 0.06, 0.8, 5, PAL.woodDark);
  b.box(0.64, 0.5, 0.44, 0xe8574a, { y: 0.8 }, 0.04);
  b.gable(0.74, 0.26, 0.56, 0x2e7d9a, { y: 1.3 }, 0xe8574a);
  bw.box(0.46, 0.34, 0.03, 0x9fd3ff, { y: 0.88, z: 0.22 });
  b.box(0.05, 0.36, 0.035, 0xffffff, { y: 0.87, z: 0.235 });
}

function archBench(b) {
  b.box(1.0, 0.07, 0.36, PAL.wood, { y: 0.38 }, 0.05);
  b.box(1.0, 0.28, 0.06, PAL.wood, { y: 0.5, z: -0.16 }, 0.05);
  for (const [x, z] of [[-0.42, 0.13], [0.42, 0.13], [-0.42, -0.13], [0.42, -0.13]]) b.box(0.07, 0.38, 0.07, PAL.woodDark, { x, z });
  [0xc0392b, 0x2e86de, 0xf1c40f, 0x27ae60].forEach((c, i) => b.box(0.3 - i * 0.02, 0.07, 0.22, c, { x: 0.28, y: 0.45 + i * 0.07, z: 0.02, ry: i * 0.2 }));
}

function archShed(b, bw) {
  b.box(1.25, 0.12, 1.05, 0xb3a48f, {}, 0.03);
  b.box(1.1, 0.78, 0.9, PAL.wood, { y: 0.12 }, 0.05);
  for (let i = 0; i < 4; i++) b.box(0.03, 0.78, 0.02, PAL.woodDark, { x: -0.45 + i * 0.3, y: 0.12, z: 0.46 });
  b.gable(1.3, 0.5, 1.12, 0x5b6f9e, { y: 0.9 }, PAL.wood);
  b.box(0.34, 0.56, 0.04, PAL.woodDark, { x: -0.18, y: 0.12, z: 0.46 });
  b.rod([-0.36, 0.82, 0.49], [0.02, 0.82, 0.49], 0.05, 6, 0xfff4d6);
  bw.box(0.24, 0.22, 0.03, 0x9fd3ff, { x: 0.3, y: 0.42, z: 0.46 });
}

function archLibrary(b, bw, bl) {
  const stone = 0xf1e6cf, stoneD = 0xd8c9a8, roof = 0x4e6aa8, glass = 0x9fd3ff;
  b.box(2.2, 0.14, 1.8, stoneD, {}, 0.02);
  b.box(2.05, 0.1, 0.34, stoneD, { y: 0.14, z: 0.82 });
  b.box(1.8, 1.0, 1.25, stone, { y: 0.14, z: -0.12 }, 0.03);
  for (let i = 0; i < 4; i++) b.cyl(0.08, 0.09, 0.95, 8, 0xfaf6ea, { x: -0.72 + i * 0.48, y: 0.24, z: 0.66 });
  b.box(2.0, 0.12, 0.52, stone, { y: 1.16, z: 0.6 });
  b.gable(1.95, 0.5, 2.12, roof, { y: 1.14, z: 0.02, ry: Math.PI / 2 }, stone);
  b.box(0.34, 0.22, 0.05, 0xc0392b, { y: 1.33, z: 1.0 });
  b.box(0.03, 0.22, 0.06, 0xffffff, { y: 1.33, z: 1.0 });
  b.box(0.42, 0.62, 0.05, PAL.woodDark, { y: 0.14, z: 0.52 });
  for (const sx of [-1, 1]) {
    bw.box(0.26, 0.42, 0.04, glass, { x: sx * 0.62, y: 0.4, z: 0.52 });
    bw.box(0.04, 0.42, 0.3, glass, { x: sx * 0.91, y: 0.5, z: -0.12 });
    bl.box(0.09, 0.14, 0.09, 0xfff0c0, { x: sx * 0.33, y: 0.92, z: 0.58 });
  }
}

function archVault(isl, ctx, a) {
  const { b, bl, bc } = ctx;
  const big = isl.tier >= 4, s = big ? 1.18 : 1.0;
  const body = 0x76819a, bodyL = 0x9aa5bc;
  b.box(2.1 * s, 0.12, 1.8 * s, PAL.metalDark, {}, 0.02);
  b.box(1.9 * s, 0.95 * s, 1.55 * s, body, { y: 0.12 }, 0.04);
  b.box(1.92 * s, 0.1, 1.57 * s, PAL.hazard, { y: 0.2 });
  b.box(1.7 * s, 0.14, 1.35 * s, bodyL, { y: 0.12 + 0.95 * s });
  const dy = 0.62 * s, dz = 0.775 * s;
  b.cyl(0.42 * s, 0.42 * s, 0.1, 12, 0xb8c2d1, { y: dy, z: dz, rx: Math.PI / 2 });
  b.tor(0.42 * s, 0.05, 4, 14, 0xffc53d, { y: dy, z: dz + 0.1 });
  for (let k = 0; k < 3; k++) b.box(0.62 * s, 0.05, 0.03, PAL.metalDark, { y: dy, z: dz + 0.11, rz: k * Math.PI / 3 });
  b.cyl(0.09, 0.09, 0.07, 8, 0xffc53d, { y: dy, z: dz + 0.1, rx: Math.PI / 2 });
  for (const sx of [-1, 1]) bc.box(0.03, 0.1, 1.05 * s, 0x7ff6ff, { x: sx * 0.96 * s, y: 0.72 * s });
  bl.box(0.1, 0.1, 0.1, 0xffd0b0, { x: 0.72 * s, y: 1.21 * s, z: 0.5 * s });
  let dishY = 0.12 + 1.09 * s, dishX = -0.4 * s, dishZ = -0.25 * s;
  if (big) {
    b.box(1.0, 0.55, 0.8, body, { x: 0.3, y: dishY, z: -0.2 }, 0.04);
    bc.box(0.8, 0.06, 0.02, 0x7ff6ff, { x: 0.3, y: dishY + 0.3, z: 0.21 });
    b.cyl(0.03, 0.05, 1.3, 5, PAL.metal, { x: 0.55, y: dishY + 0.55, z: -0.35 });
    bl.box(0.1, 0.1, 0.1, 0xffd0b0, { x: 0.55, y: dishY + 1.85, z: -0.35 });
  }
  // rotating dish (separate mesh)
  const db = new GeoBuilder(11);
  db.cyl(0.05, 0.07, 0.4, 5, PAL.metalDark);
  db.at({ y: 0.42, rx: -0.55 }, () => {
    db.cone(0.52 * s, 0.2 * s, 10, 0xe8edf5, { y: 0.2 * s, rx: Math.PI });
    db.beam([0, 0.2 * s, 0], [0, 0.58 * s, 0], 0.03, 0.03, PAL.metalDark);
    db.box(0.08, 0.08, 0.08, PAL.danger, { y: 0.56 * s });
  });
  const dish = db.mesh(shared().vc);
  const [x, z] = frameXZ(a.x, a.z, a.face, dishX, dishZ);
  dish.position.set(x, ctx.top + dishY, z);
  isl.body.add(dish);
  isl.anim.push((dt, t) => { dish.rotation.y = t * 0.35 + isl.phase; });
}

function makeRocket(isl, scale, x, y, z) {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  g.scale.setScalar(scale);
  const b = new GeoBuilder(21);
  b.cyl(0.13, 0.16, 0.14, 8, PAL.metalDark);
  b.cyl(0.2, 0.2, 0.95, 8, 0xf4f5fa, { y: 0.14 }, 0.03);
  b.cyl(0.205, 0.205, 0.12, 8, PAL.danger, { y: 0.32 });
  b.cone(0.2, 0.46, 8, PAL.danger, { y: 1.09 });
  for (let i = 0; i < 3; i++) {
    const a = i / 3 * TAU + 0.5;
    b.box(0.04, 0.4, 0.26, PAL.danger, { x: Math.cos(a) * 0.3, y: 0.08, z: Math.sin(a) * 0.3, ry: radialYaw(a) });
  }
  b.cyl(0.085, 0.085, 0.03, 8, 0x9fe8ff, { y: 0.78, z: 0.195, rx: Math.PI / 2 });
  const m = b.mesh(shared().vc);
  g.add(m);
  const flame = new THREE.Mesh(P.cone(0.13, 0.55, 6), shared().fire);
  flame.rotation.x = Math.PI;
  flame.position.y = 0.02;
  flame.visible = false;
  g.add(flame);
  isl.body.add(g);
  return { group: g, flame, home: V3(x, y, z), scale, busy: false };
}

function featPad(isl, ctx, p) {
  const { b, bl, top } = ctx;
  const tier = isl.tier;
  if (isl.kind === 'repo' && tier >= 3) {
    const big = tier >= 4, R = big ? 1.95 : 1.05;
    b.cyl(R, R + 0.08, 0.16, big ? 12 : 8, 0xc9c4d6, { x: p.x, y: top - 0.02, z: p.z }, 0.03);
    const nSeg = big ? 16 : 10;
    for (let i = 0; i < nSeg; i++) {
      const a = (i + 0.5) / nSeg * TAU;
      b.box(big ? 0.55 : 0.4, 0.02, 0.1, i % 2 ? PAL.black : PAL.hazard, { x: p.x + Math.cos(a) * (R - 0.14), y: top + 0.14, z: p.z + Math.sin(a) * (R - 0.14), ry: tangentYaw(a) });
    }
    b.cyl(big ? 0.85 : 0.45, big ? 0.85 : 0.45, 0.02, 12, 0x5a6478, { x: p.x, y: top + 0.14, z: p.z });
    if (big) b.tor(1.35, 0.05, 3, 24, PAL.hazard, { x: p.x, y: top + 0.16, z: p.z, rx: Math.PI / 2 });
    const ta = isl.backAngle, tx = p.x + Math.cos(ta) * (R - 0.25), tz = p.z + Math.sin(ta) * (R - 0.25);
    const TH = big ? 3.2 : 2.3;
    for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) b.box(0.07, TH, 0.07, PAL.danger, { x: tx + sx * 0.18, y: top + 0.14, z: tz + sz * 0.18 });
    for (let y = 0.5; y < TH; y += 0.55) {
      b.box(0.44, 0.05, 0.05, PAL.metalDark, { x: tx, y: top + 0.14 + y, z: tz + 0.18 });
      b.box(0.44, 0.05, 0.05, PAL.metalDark, { x: tx, y: top + 0.14 + y, z: tz - 0.18 });
      b.box(0.05, 0.05, 0.44, PAL.metalDark, { x: tx + 0.18, y: top + 0.14 + y, z: tz });
      b.box(0.05, 0.05, 0.44, PAL.metalDark, { x: tx - 0.18, y: top + 0.14 + y, z: tz });
    }
    b.box(0.52, 0.06, 0.52, PAL.metalDark, { x: tx, y: top + 0.14 + TH, z: tz });
    bl.box(0.12, 0.12, 0.12, 0xffd0b0, { x: tx, y: top + 0.2 + TH, z: tz });
    b.beam([tx, top + TH * 0.72, tz], [lerp(tx, p.x, 0.62), top + TH * 0.72, lerp(tz, p.z, 0.62)], 0.07, 0.07, PAL.metalDark);
    for (let i = 0; i < 4; i++) { const a = i / 4 * TAU + Math.PI / 4; bl.box(0.1, 0.07, 0.1, 0xfff0c0, { x: p.x + Math.cos(a) * (R - 0.05), y: top + 0.14, z: p.z + Math.sin(a) * (R - 0.05) }); }
    isl.rocket = makeRocket(isl, big ? 1.45 : 1.0, p.x, top + 0.15, p.z);
    isl.padTop = V3(p.x, top + 0.3, p.z);
  } else {
    b.box(0.56, 0.32, 0.46, PAL.wood, { x: p.x, y: top, z: p.z, ry: 0.3 }, 0.05);
    b.box(0.58, 0.05, 0.48, PAL.woodDark, { x: p.x, y: top + 0.14, z: p.z, ry: 0.3 });
    const cols = [0xff4d6d, 0x3da5ff, 0xffd23d];
    for (let i = 0; i < 3; i++) {
      b.cyl(0.075, 0.075, 0.42, 6, cols[i], { x: p.x + (i - 1) * 0.16, y: top + 0.2, z: p.z + (i % 2) * 0.05, rz: (i - 1) * 0.2 });
      b.cyl(0.08, 0.08, 0.03, 6, 0xffffff, { x: p.x + (i - 1) * 0.16 - (i - 1) * 0.08, y: top + 0.6, z: p.z + (i % 2) * 0.05, rz: (i - 1) * 0.2 });
    }
    isl.padTop = V3(p.x, top + 0.62, p.z);
  }
}

function featCrystals(ctx, c, big) {
  const { b, bc, top, r } = ctx;
  b.ico(c.r * 0.6, 0, PAL.rockDark, { x: c.x, y: top + 0.03, z: c.z, s: [1.25, 0.42, 1.15], ry: r() * TAU }, 0.1);
  const n = big ? 8 : 5;
  const cols = [PAL.crystal, 0x8ff7ff, 0x3fd8f0, 0xb4fbff];
  for (let i = 0; i < n; i++) {
    const a = i / n * TAU + r() * 0.6;
    const d = i === 0 ? 0 : c.r * (0.22 + r() * 0.38);
    const h = (i === 0 ? 1.1 : 0.4 + r() * 0.5) * (big ? 1.25 : 1);
    const rad = (i === 0 ? 0.15 : 0.07 + r() * 0.06) * (big ? 1.2 : 1);
    const col = cols[i % cols.length];
    bc.at({ x: c.x + Math.cos(a) * d, y: top - 0.04, z: c.z + Math.sin(a) * d, ry: radialYaw(a), rx: i === 0 ? 0.06 : 0.28 + r() * 0.35 }, (B) => {
      B.cyl(rad, rad * 1.1, h, 6, col);
      B.cone(rad, rad * 2.4, 6, tint(col, 0.3), { y: h });
    });
  }
  if (big) for (let i = 0; i < 5; i++) {
    const a = r() * TAU, d = c.r * (0.85 + r() * 0.3);
    bc.oct(0.08 + r() * 0.05, 0x8ff7ff, { x: c.x + Math.cos(a) * d, y: top + 0.04, z: c.z + Math.sin(a) * d, ry: r() * 3, rx: 0.4 });
  }
}

function featRuins(ctx, ru) {
  const { b, top, r } = ctx;
  const stone = 0xe6dfcc, stoneD = 0xc9c0a8, moss = 0x6fae3f;
  const cols = [[0.75, 0.2, 1.3], [-0.15, 0.85, 0.8], [0.5, -0.72, 0.5]];
  for (const [dx, dz, h] of cols) {
    const x = ru.x + dx, z = ru.z + dz;
    b.box(0.5, 0.18, 0.5, stoneD, { x, y: top, z }, 0.05);
    b.cyl(0.17, 0.2, h, 8, stone, { x, y: top + 0.18, z }, 0.05);
    b.ico(0.19, 0, stone, { x, y: top + 0.18 + h, z, s: [1, 0.6, 1], ry: r() * 3 }, 0.08);
    b.ico(0.12, 0, moss, { x: x + 0.05, y: top + 0.24 + h, z, s: [1.3, 0.45, 1.2] });
  }
  b.cyl(0.18, 0.18, 0.95, 8, stone, { x: ru.x - 0.65, y: top + 0.18, z: ru.z - 0.35, rz: Math.PI / 2, ry: 0.5 }, 0.05);
  b.cyl(0.18, 0.18, 0.5, 8, stoneD, { x: ru.x - 0.05, y: top + 0.18, z: ru.z - 0.9, rz: Math.PI / 2, ry: -0.3 }, 0.05);
  b.at({ x: ru.x - 0.35, y: top - 0.14, z: ru.z + 0.1, ry: Math.PI / 4 + 0.3, rz: 0.22 }, () => {
    b.box(0.7, 0.8, 0.64, stoneD, {}, 0.06);
    b.box(0.76, 0.18, 0.7, stone, { y: 0.8 });
    b.box(0.13, 0.26, 0.15, stoneD, { y: 0.26, z: 0.36 });
    b.box(0.52, 0.07, 0.08, tint(stoneD, -0.18), { y: 0.55, z: 0.33 });
    for (const sx of [-1, 1]) b.box(0.12, 0.08, 0.04, 0x4a4438, { x: sx * 0.16, y: 0.44, z: 0.33 });
    b.box(0.26, 0.05, 0.04, 0x4a4438, { y: 0.14, z: 0.33 });
    b.ico(0.2, 0, moss, { x: -0.2, y: 0.95, z: 0.05, s: [1.4, 0.5, 1.2] });
    b.ico(0.15, 0, tint(moss, 0.15), { x: 0.2, y: 0.92, z: -0.15, s: [1.2, 0.5, 1] });
    b.ico(0.12, 0, moss, { x: 0.36, y: 0.35, z: 0.1, s: [0.5, 1, 1] });
  });
}

function featLamp(ctx, x, z, h = 1.35) {
  const { b, bl, top } = ctx;
  b.cyl(0.1, 0.12, 0.12, 6, PAL.metalDark, { x, y: top, z });
  b.cyl(0.035, 0.045, h, 5, PAL.metalDark, { x, y: top, z });
  b.box(0.26, 0.05, 0.26, PAL.metalDark, { x, y: top + h + 0.2, z });
  b.cone(0.17, 0.13, 4, PAL.metalDark, { x, y: top + h + 0.25, z, ry: Math.PI / 4 });
  bl.box(0.17, 0.21, 0.17, 0xfff3c4, { x, y: top + h - 0.01, z });
}

function featFishingSpot(ctx, s) {
  const { b, top } = ctx;
  const a = Math.atan2(s.z, s.x);
  // a tiny fishing deck jutting over the cliff on two posts, with a bait bucket and a spare rod
  b.at({ x: s.x, y: top, z: s.z, ry: radialYaw(a) }, () => {
    for (let i = 0; i < 4; i++) b.box(0.7, 0.06, 0.24, i % 2 ? tint(PAL.wood, -0.1) : PAL.wood, { y: -0.03, z: 0.05 + i * 0.25 }, 0.05);
    for (const sx of [-0.3, 0.3]) {
      b.box(0.07, 0.07, 1.0, PAL.woodDark, { x: sx, y: -0.1, z: 0.38 });
      b.cyl(0.05, 0.06, top + 0.1, 5, PAL.woodDark, { x: sx, y: -top, z: 0.82 });
    }
    b.cyl(0.09, 0.07, 0.16, 6, 0x6aa8d8, { x: 0.45, y: 0, z: -0.15 });
    b.rod([-0.42, 0, -0.2], [-0.5, 1.1, 0.35], 0.012, 4, 0x7a4b2b);
  });
}

function featFences(isl, ctx) {
  const { b, top } = ctx;
  const prof = isl.prof, L = isl.L;
  const n = Math.max(24, Math.round(TAU * prof.pmax / 0.55));
  const pts = [];
  for (let i = 0; i < n; i++) {
    const t = i / n * TAU, d = prof.plateau(t) - 0.12, x = Math.cos(t) * d, z = Math.sin(t) * d;
    let ok = i % 9 !== 0;
    if (ok) for (const o of L.occ) { if (Math.hypot(o.x - x, o.z - z) < o.r + 0.3) { ok = false; break; } }
    if (ok) for (const sl of L.slots) if (sqDist(x, z, sl, LOT_HALF) < 0.35) { ok = false; break; }
    pts.push(ok ? [x, z] : null);
  }
  for (let i = 0; i < n; i++) {
    const p = pts[i], q = pts[(i + 1) % n];
    if (!p) continue;
    b.cyl(0.04, 0.05, 0.55, 4, PAL.woodDark, { x: p[0], y: top, z: p[1] });
    if (q) {
      b.beam([p[0], top + 0.22, p[1]], [q[0], top + 0.22, q[1]], 0.045, 0.045, PAL.wood);
      b.beam([p[0], top + 0.44, p[1]], [q[0], top + 0.44, q[1]], 0.045, 0.045, PAL.wood);
    }
  }
}

function featTurret(isl, ctx, tu) {
  const { b, top } = ctx;
  b.cyl(0.46, 0.52, 0.35, 8, PAL.metalDark, { x: tu.x, y: top, z: tu.z }, 0.05);
  b.cyl(0.42, 0.46, 0.1, 8, PAL.hazard, { x: tu.x, y: top + 0.35, z: tu.z });
  const hb = new GeoBuilder(5);
  hb.cyl(0.3, 0.34, 0.2, 8, PAL.metal);
  hb.box(0.52, 0.34, 0.56, 0x7d889c, { y: 0.18 }, 0.05);
  hb.box(0.4, 0.08, 0.46, PAL.metalDark, { y: 0.52 });
  for (const sx of [-0.13, 0.13]) {
    hb.cyl(0.05, 0.06, 0.72, 6, PAL.metalDark, { x: sx, y: 0.34, z: 0.22, rx: Math.PI / 2 });
    hb.cyl(0.065, 0.065, 0.08, 6, PAL.black, { x: sx, y: 0.34, z: 0.9, rx: Math.PI / 2 });
  }
  hb.box(0.12, 0.08, 0.04, PAL.danger, { x: 0.17, y: 0.4, z: 0.28 });
  const head = hb.mesh(shared().vc);
  head.position.set(tu.x, top + 0.45, tu.z);
  isl.body.add(head);
  const st = { cur: ctx.r() * TAU, target: 0, wait: ctx.r() * 3 };
  st.target = st.cur;
  isl.anim.push((dt) => {
    st.wait -= dt;
    if (st.wait <= 0) { st.target = st.cur + (Math.random() - 0.5) * 2.6; st.wait = 2.5 + Math.random() * 4; }
    st.cur = dampTo(st.cur, st.target, 1.5, dt);
    head.rotation.y = st.cur;
  });
}

function featSilo(ctx, s) {
  const { b, bl, top } = ctx;
  const H = 1.9;
  b.cyl(0.55, 0.58, H, 10, 0xe9edf5, { x: s.x, y: top, z: s.z }, 0.03);
  b.cyl(0.57, 0.57, 0.22, 10, PAL.hazard, { x: s.x, y: top + H * 0.62, z: s.z });
  b.hemi(0.55, 10, 4, 0xd4dae6, { x: s.x, y: top + H, z: s.z });
  b.cyl(0.08, 0.08, 0.22, 6, PAL.metalDark, { x: s.x, y: top + H + 0.48, z: s.z });
  const a = Math.PI / 4, lx = s.x + Math.cos(a) * 0.58, lz = s.z + Math.sin(a) * 0.58;
  for (const d of [-0.12, 0.12]) b.box(0.03, H, 0.03, PAL.metalDark, { x: lx - Math.sin(a) * d, y: top, z: lz + Math.cos(a) * d });
  for (let y = 0.2; y < H; y += 0.25) b.box(0.03, 0.03, 0.26, PAL.metalDark, { x: lx, y: top + y, z: lz, ry: -a });
  bl.box(0.1, 0.1, 0.1, 0xffc0a0, { x: s.x, y: top + H + 0.72, z: s.z });
}

function featPylons(ctx, list) {
  const { b, top } = ctx;
  const H = 2.7, arm = 0.55;
  const ends = [];
  for (let i = 0; i < list.length; i++) {
    const p = list[i], nx = list[i + 1], pv = list[i - 1];
    const dir = nx ? Math.atan2(nx.z - p.z, nx.x - p.x) : Math.atan2(p.z - pv.z, p.x - pv.x);
    b.at({ x: p.x, y: top, z: p.z, ry: -dir }, () => {
      for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) b.beam([sx * 0.28, 0, sz * 0.28], [sx * 0.07, H, sz * 0.07], 0.05, 0.05, PAL.metalDark);
      for (let k = 0; k < 3; k++) {
        const y0 = k * 0.8, y1 = y0 + 0.8, w0 = 0.28 - y0 / H * 0.21, w1 = 0.28 - y1 / H * 0.21;
        b.beam([-w0, y0, w0], [w1, y1, w1], 0.03, 0.03, PAL.metalDark);
        b.beam([w0, y0, -w0], [-w1, y1, -w1], 0.03, 0.03, PAL.metalDark);
      }
      b.box(0.08, 0.08, 2 * arm + 0.1, PAL.metalDark, { y: H - 0.3 });
      for (const sz of [-arm, arm]) b.cyl(0.045, 0.045, 0.2, 5, 0xbfe8ff, { y: H - 0.5, z: sz });
    });
    ends.push([-1, 1].map((sd) => [p.x - Math.sin(dir) * arm * sd, top + H - 0.5, p.z + Math.cos(dir) * arm * sd]));
  }
  for (let i = 0; i + 1 < ends.length; i++) {
    for (let s = 0; s < 2; s++) {
      const A = ends[i][s], B = ends[i + 1][s], pts = [];
      for (let k = 0; k <= 8; k++) { const u = k / 8; pts.push([lerp(A[0], B[0], u), lerp(A[1], B[1], u) - 0.45 * 4 * u * (1 - u), lerp(A[2], B[2], u)]); }
      b.tube(pts, 0.02, 0x2b2f3a, 12);
    }
  }
}

function featWalls(isl, ctx) {
  const { b, bl, top } = ctx;
  const prof = isl.prof, L = isl.L;
  const wallC = 0xd3d7e6, trimC = 0x8e97b5, capC = 0xb6bdd2, roofC = 0x5b6f9e;
  const n = Math.max(30, Math.round(TAU * prof.pmax / 0.7));
  const gates = [Math.PI / 4, Math.PI / 4 + Math.PI];
  const pts = [];
  for (let i = 0; i < n; i++) {
    const t = i / n * TAU, d = prof.plateau(t) - 0.18, x = Math.cos(t) * d, z = Math.sin(t) * d;
    let ok = true;
    for (const g of gates) if (Math.abs(angDiff(t, g)) * d < 0.75) ok = false;
    if (ok) for (const o of L.occ) { if (o.tag === 'lamp') continue; if (Math.hypot(o.x - x, o.z - z) < o.r + 0.35) { ok = false; break; } }
    if (ok) for (const sl of L.slots) if (sqDist(x, z, sl, LOT_HALF) < 0.4) { ok = false; break; }
    pts.push(ok ? [x, z, t] : null);
  }
  const tower = (p) => {
    b.cyl(0.3, 0.34, 1.35, 8, wallC, { x: p[0], y: top, z: p[1] }, 0.03);
    b.cyl(0.37, 0.37, 0.1, 8, trimC, { x: p[0], y: top + 1.35, z: p[1] });
    b.cone(0.3, 0.45, 8, roofC, { x: p[0], y: top + 1.45, z: p[1] });
    bl.box(0.1, 0.12, 0.1, 0xfff0c0, { x: p[0], y: top + 1.9, z: p[1] });
  };
  for (let i = 0; i < n; i++) {
    const p = pts[i], q = pts[(i + 1) % n], prev = pts[(i - 1 + n) % n];
    if (!p) continue;
    if (q) {
      const dx = q[0] - p[0], dz = q[1] - p[1], len = Math.hypot(dx, dz), yaw = -Math.atan2(dz, dx);
      const mx = (p[0] + q[0]) / 2, mz = (p[1] + q[1]) / 2;
      b.box(len + 0.06, 0.8, 0.3, wallC, { x: mx, y: top, z: mz, ry: yaw }, 0.03);
      b.box(len + 0.07, 0.08, 0.36, trimC, { x: mx, y: top + 0.8, z: mz, ry: yaw });
      b.box(0.22, 0.2, 0.34, capC, { x: mx, y: top + 0.88, z: mz, ry: yaw });
    }
    if (!prev || !q) tower(p);
  }
  // gate lintels across short gaps that straddle a gate angle
  for (let i = 0; i < n; i++) {
    if (!pts[i] || pts[(i + 1) % n]) continue;
    let j = i + 1, steps = 1;
    while (!pts[j % n] && steps < n) { j++; steps++; }
    const q = pts[j % n];
    if (!q || steps > 5) continue;
    const p = pts[i];
    b.beam([p[0], top + 1.25, p[1]], [q[0], top + 1.25, q[1]], 0.16, 0.22, trimC);
    const mx = (p[0] + q[0]) / 2, mz = (p[1] + q[1]) / 2;
    bl.box(0.3, 0.1, 0.1, 0xfff0c0, { x: mx, y: top + 1.18, z: mz, ry: -Math.atan2(q[1] - p[1], q[0] - p[0]) });
  }
}

function featSpire(ctx, s) {
  const { b, bc, top } = ctx;
  b.cyl(0.36, 0.42, 0.5, 6, PAL.metalDark, { x: s.x, y: top, z: s.z }, 0.04);
  b.cone(0.26, 3.3, 6, 0xeef0fa, { x: s.x, y: top + 0.5, z: s.z }, 0.03);
  b.tor(0.25, 0.05, 4, 10, PAL.hazard, { x: s.x, y: top + 1.2, z: s.z, rx: Math.PI / 2 });
  b.tor(0.17, 0.04, 4, 10, PAL.hazard, { x: s.x, y: top + 2.2, z: s.z, rx: Math.PI / 2 });
  bc.oct(0.17, PAL.crystal, { x: s.x, y: top + 4.05, z: s.z });
}

// ---- camp / sandbox / home props ---------------------------------------------------------------------

function featCampfire(isl, ctx, c) {
  const { b, top } = ctx;
  b.cyl(0.36, 0.38, 0.03, 8, 0x3a3230, { x: c.x, y: top, z: c.z });
  for (let i = 0; i < 9; i++) {
    const a = i / 9 * TAU;
    b.ico(0.12, 0, i % 2 ? PAL.rock : PAL.rockDark, { x: c.x + Math.cos(a) * 0.42, y: top + 0.05, z: c.z + Math.sin(a) * 0.42, s: [1, 0.7, 1], ry: a }, 0.1);
  }
  b.rod([c.x - 0.3, top + 0.08, c.z - 0.12], [c.x + 0.3, top + 0.16, c.z + 0.12], 0.06, 5, PAL.woodDark);
  b.rod([c.x - 0.1, top + 0.08, c.z + 0.3], [c.x + 0.12, top + 0.16, c.z - 0.3], 0.06, 5, 0x5e3a20);
  for (let i = 0; i < 3; i++) {
    const a = i / 3 * TAU + 0.5, x = c.x + Math.cos(a) * 0.98, z = c.z + Math.sin(a) * 0.98;
    const tx = -Math.sin(a) * 0.38, tz = Math.cos(a) * 0.38;
    b.rod([x - tx, top + 0.13, z - tz], [x + tx, top + 0.13, z + tz], 0.13, 6, PAL.wood);
  }
  const S = shared();
  const fg = new THREE.Group();
  fg.position.set(c.x, top + 0.08, c.z);
  const f1 = new THREE.Mesh(P.cone(0.25, 0.8, 5), S.fire);
  const f2 = new THREE.Mesh(P.cone(0.17, 0.58, 5), S.fire); f2.position.set(0.13, 0, 0.06);
  const f3 = new THREE.Mesh(P.cone(0.13, 0.46, 5), S.fire); f3.position.set(-0.12, 0, -0.07);
  const core = new THREE.Mesh(P.cone(0.13, 0.5, 5), mat(0xfff3a0, { emissive: 0xffe066, emissiveIntensity: 1.2 }));
  core.position.set(0.02, 0, 0.1);
  fg.add(f1, f2, f3, core);
  const gs = glowSprite(0xff9a3d, 2.8, 0.35);
  gs.position.y = 0.45;
  fg.add(gs);
  isl.body.add(fg);
  let next = 0;
  isl.anim.push((dt, t, day) => {
    f1.scale.set(1 + 0.08 * Math.sin(t * 11), 1 + 0.22 * Math.sin(t * 13.3) * Math.sin(t * 5.1), 1 + 0.08 * Math.cos(t * 9));
    f2.scale.y = 1 + 0.3 * Math.sin(t * 15.7 + 1);
    f3.scale.y = 1 + 0.3 * Math.sin(t * 12.1 + 2);
    f1.rotation.y += dt * 1.5;
    gs.material.opacity = (0.16 + 0.55 * (1 - day)) * (0.85 + 0.15 * Math.sin(t * 17));
    if (t > next) {
      next = t + 0.35 + Math.random() * 0.3;
      isl._parts('puff').spawn(c.x + (Math.random() - 0.5) * 0.15, top + 0.75, c.z + (Math.random() - 0.5) * 0.15, 0.12, 0.7, 0.05, { life: 2.6, size: 0.14, color: 0xc4c4cc, grow: 2.2, drag: 0.3 });
      if (Math.random() < 0.35) isl._parts('spark').spawn(c.x, top + 0.4, c.z, (Math.random() - 0.5) * 0.4, 1.4, (Math.random() - 0.5) * 0.4, { life: 1.1, size: 0.045, color: 0xffb03a, grav: -0.2 });
    }
  });
}

function featTent(ctx, t, color, ry) {
  const { b, top } = ctx;
  b.at({ x: t.x, y: top, z: t.z, ry }, () => {
    const w = 1.15, h = 0.95, d = 1.25, hz = d / 2;
    b.quad([-w / 2, 0, -hz], [-w / 2, 0, hz], [0, h, hz], [0, h, -hz], color, [-1, 0.6, 0]);
    b.quad([w / 2, 0, -hz], [0, h, -hz], [0, h, hz], [w / 2, 0, hz], tint(color, -0.14), [1, 0.6, 0]);
    b.tri([-w / 2, 0, -hz], [0, h, -hz], [w / 2, 0, -hz], tint(color, -0.22), [0, 0, -1]);
    b.tri([-w / 2, 0, hz], [-0.26, 0, hz], [0, h, hz], tint(color, 0.08), [0, 0, 1]);
    b.tri([0.26, 0, hz], [w / 2, 0, hz], [0, h, hz], tint(color, 0.02), [0, 0, 1]);
    b.tri([-0.26, 0, hz - 0.03], [0.26, 0, hz - 0.03], [0, h * 0.72, hz - 0.03], 0x2a1d14, [0, 0, 1]);
    b.cyl(0.03, 0.03, h + 0.16, 4, PAL.woodDark, { z: hz + 0.04 });
    b.cyl(0.03, 0.03, h + 0.16, 4, PAL.woodDark, { z: -hz - 0.04 });
    b.rod([0, h + 0.1, hz + 0.04], [0, 0, hz + 0.55], 0.012, 3, 0xd9c08a);
    b.rod([0, h + 0.1, -hz - 0.04], [0, 0, -hz - 0.55], 0.012, 3, 0xd9c08a);
  });
}

function featDragonSign(isl, ctx, s) {
  const { b, top } = ctx;
  b.rod([s.x, top - 0.05, s.z], [s.x + 0.14, top + 1.6, s.z - 0.1], 0.055, 5, PAL.woodDark);
  const g = new THREE.Group();
  const fwd = 0.1 / Math.SQRT2;   // boards hang in front of the post (towards the default camera)
  g.position.set(s.x + 0.12 + fwd, top + 1.32, s.z - 0.08 + fwd);
  g.rotation.set(0, SIGN_YAW, -0.13);
  g.add(signBoard('HERE BE DRAGONS', 1.75, 0.42, { bg: '#7a4a24', fg: '#ffe9b0', border: '#3e2612' }));
  const s2 = signBoard('— no version control —', 1.95, 0.27, { bg: '#5e3b1f', fg: '#ffcf9e', border: '#3e2612' });
  s2.position.set(0.14, -0.45, 0.02);
  s2.rotation.z = 0.22;
  g.add(s2);
  isl.body.add(g);
}

function featDriftwood(isl, ctx) {
  const { b } = ctx;
  const prof = isl.prof, r = rng(isl.id + '|drift');
  for (let i = 0; i < 4; i++) {
    const t = isl.outAngle + Math.PI * (0.45 + r() * 0.9) * (i % 2 ? 1 : -1);
    const d = prof.cliffBase(t) + prof.beachW(t) * (0.35 + r() * 0.3);
    const x = Math.cos(t) * d, z = Math.sin(t) * d, y = 0.2;
    const yaw = t + Math.PI / 2 + (r() - 0.5) * 0.8, len = 0.9 + r() * 0.6;
    const cx = Math.cos(yaw) * len / 2, cz = Math.sin(yaw) * len / 2;
    b.rod([x - cx, y, z - cz], [x + cx, y + 0.05, z + cz], 0.08 + r() * 0.04, 5, 0xa39380);
    b.rod([x, y + 0.04, z], [x + Math.cos(yaw + 1) * 0.32, y + 0.24, z + Math.sin(yaw + 1) * 0.32], 0.035, 4, 0x958472);
  }
}

function featSerpent(isl) {
  const g = new THREE.Group();
  g.name = 'serpent';
  g.visible = false;
  isl.body.add(g);
  const skin = 0x2fbf8f, belly = 0xc8f59a, dark = 0x1f8a66;
  const humps = [];
  for (let i = 0; i < 4; i++) {
    const hb = new GeoBuilder(40 + i);
    hb.tor(0.5, 0.2, 5, 9, skin, {}, Math.PI);
    hb.tor(0.5, 0.12, 4, 9, belly, { z: 0.1 }, Math.PI);
    for (let k = 0; k < 3; k++) { const a = 0.6 + k * 0.95; hb.cone(0.08, 0.24, 4, dark, { x: Math.cos(a) * 0.68, y: Math.sin(a) * 0.68, rz: a - Math.PI / 2 }); }
    const m = hb.mesh(shared().vc, { cast: false });
    m.scale.setScalar(1 - i * 0.16);
    g.add(m);
    humps.push(m);
  }
  const hb = new GeoBuilder(50);
  hb.ico(0.3, 0, skin, { s: [1, 0.85, 1.25] });
  hb.box(0.34, 0.16, 0.36, skin, { y: -0.14, z: 0.26 });
  hb.box(0.3, 0.06, 0.3, belly, { y: -0.17, z: 0.28 });
  for (const sx of [-1, 1]) {
    hb.ico(0.08, 0, 0xffffff, { x: sx * 0.14, y: 0.12, z: 0.18 });
    hb.ico(0.042, 0, 0x111111, { x: sx * 0.16, y: 0.13, z: 0.245 });
    hb.cone(0.05, 0.22, 4, 0xf3e6c0, { x: sx * 0.1, y: 0.2, z: -0.1, rx: -0.5 });
  }
  hb.cone(0.12, 0.26, 3, dark, { y: 0.22, z: -0.24, rx: -1.0 });
  hb.box(0.04, 0.02, 0.22, 0xff4d6d, { y: -0.12, z: 0.5 });
  const head = hb.mesh(shared().vc, { cast: false });
  g.add(head);
  const st = { on: false, next: (isl.engine.time ?? 0) + 8 + (hashNum(isl.id) % 12), t0: 0, dur: 14, th0: 0 };
  const Rs = isl.radius + 5.5;   // outside the pier line
  isl.anim.push((dt, t) => {
    if (!st.on) {
      if (t < st.next) return;
      st.on = true; st.t0 = t; st.th0 = Math.random() * TAU; g.visible = true;
      isl._puff(V3(Math.cos(st.th0) * Rs, 0.1, Math.sin(st.th0) * Rs), PAL.foam, 8, 0.4, { up: 1.2 });
    }
    const k = t - st.t0;
    if (k > st.dur) { st.on = false; g.visible = false; st.next = t + 30 + Math.random() * 45; return; }
    const em = Math.min(1, k / 1.5, (st.dur - k) / 1.5);
    const th = st.th0 + k * 0.32;
    humps.forEach((m, i) => {
      const a = th - (i + 1) * 0.2;
      m.position.set(Math.cos(a) * Rs, -0.7 + em * (0.62 + 0.12 * Math.sin(k * 3 - i * 1.3)), Math.sin(a) * Rs);
      m.rotation.y = tangentYaw(a);
    });
    head.position.set(Math.cos(th) * Rs, -0.45 + em * (1.05 + 0.08 * Math.sin(k * 3 + 1)), Math.sin(th) * Rs);
    head.rotation.set(-0.15 + 0.1 * Math.sin(k * 2), Math.atan2(-Math.sin(th), Math.cos(th)), 0);
  });
}

function featSandbox(isl, ctx, c) {
  const { b, top } = ctx;
  const S = Math.min(2.3, c.r * 1.45), h = S / 2;
  b.box(S - 0.05, 0.12, S - 0.05, 0xfbe6ae, { x: c.x, y: top, z: c.z });
  for (const [dx, dz, w, d] of [[0, h, S + 0.14, 0.14], [0, -h, S + 0.14, 0.14], [h, 0, 0.14, S], [-h, 0, 0.14, S]]) b.box(w, 0.24, d, PAL.wood, { x: c.x + dx, y: top, z: c.z + dz }, 0.06);
  for (const [dx, dz] of [[h, h], [-h, h], [h, -h], [-h, -h]]) b.box(0.2, 0.3, 0.2, PAL.woodDark, { x: c.x + dx, y: top, z: c.z + dz });
  const sand = 0xe7bd76, cx = c.x, cz = c.z, y0 = top + 0.12;
  b.cyl(0.3, 0.34, 0.62, 8, sand, { x: cx, y: y0, z: cz }, 0.05);
  for (let i = 0; i < 6; i++) { const a = i / 6 * TAU; b.box(0.1, 0.1, 0.1, sand, { x: cx + Math.cos(a) * 0.26, y: y0 + 0.62, z: cz + Math.sin(a) * 0.26, ry: -a }); }
  for (const [dx, dz] of [[0.55, 0.55], [-0.55, 0.55], [0.55, -0.55], [-0.55, -0.55]]) {
    b.cyl(0.16, 0.19, 0.46, 6, sand, { x: cx + dx, y: y0, z: cz + dz }, 0.05);
    for (let i = 0; i < 4; i++) { const a = i / 4 * TAU + 0.4; b.box(0.07, 0.08, 0.07, sand, { x: cx + dx + Math.cos(a) * 0.13, y: y0 + 0.46, z: cz + dz + Math.sin(a) * 0.13 }); }
  }
  const wall = tint(sand, -0.05);
  b.box(1.1, 0.26, 0.1, wall, { x: cx, y: y0, z: cz + 0.55 });
  b.box(1.1, 0.26, 0.1, wall, { x: cx, y: y0, z: cz - 0.55 });
  b.box(0.1, 0.26, 1.1, wall, { x: cx + 0.55, y: y0, z: cz });
  b.box(0.1, 0.26, 1.1, wall, { x: cx - 0.55, y: y0, z: cz });
  b.box(0.24, 0.2, 0.04, 0x8a6a3a, { x: cx + 0.2, y: y0, z: cz + 0.61 });
  b.cyl(0.012, 0.012, 0.45, 4, PAL.woodDark, { x: cx, y: y0 + 0.62, z: cz });
  b.tri([cx, y0 + 1.06, cz], [cx, y0 + 0.86, cz], [cx + 0.26, y0 + 0.96, cz], 0xff5fa2, [0, 0, 1]);
  b.tri([cx, y0 + 1.06, cz], [cx, y0 + 0.86, cz], [cx + 0.26, y0 + 0.96, cz], 0xe0408a, [0, 0, -1]);
  b.cone(0.05, 0.05, 5, 0xffb6c9, { x: cx - 0.3, y: y0, z: cz + 0.72 });
  b.cone(0.05, 0.05, 5, 0xfff0d0, { x: cx + 0.45, y: y0, z: cz + 0.75 });
}

function featBucket(ctx, p) {
  const { b, top } = ctx;
  b.cyl(0.19, 0.14, 0.3, 8, 0xff4d4d, { x: p.x, y: top, z: p.z }, 0.03);
  b.cyl(0.17, 0.17, 0.01, 8, 0x8a2020, { x: p.x, y: top + 0.3, z: p.z });
  b.tor(0.17, 0.015, 3, 8, 0x333a48, { x: p.x, y: top + 0.3, z: p.z, ry: 0.4 }, Math.PI);
  b.rod([p.x + 0.26, top + 0.02, p.z + 0.1], [p.x + 0.4, top + 0.62, p.z + 0.02], 0.022, 5, 0xffc53d);
  b.box(0.17, 0.2, 0.03, 0x3da5ff, { x: p.x + 0.25, y: top, z: p.z + 0.11, rz: 0.2 });
  b.ico(0.2, 0, 0xf5d28c, { x: p.x - 0.28, y: top, z: p.z + 0.12, s: [1, 0.45, 1] });
}

function featUmbrella(ctx, u) {
  const { b, top } = ctx;
  b.at({ x: u.x, y: top, z: u.z, rz: 0.12 }, () => {
    b.cyl(0.025, 0.03, 1.8, 5, 0xf4f4f4);
    const N = 8, R = 0.9, yRim = 1.38, yApex = 1.78;
    for (let i = 0; i < N; i++) {
      const a0 = i / N * TAU, a1 = (i + 1) / N * TAU, col = i % 2 ? 0xffffff : 0xff5a6e;
      const A = [0, yApex, 0], B = [Math.cos(a1) * R, yRim, Math.sin(a1) * R], C = [Math.cos(a0) * R, yRim, Math.sin(a0) * R];
      b.tri(A, B, C, col, [0, 1, 0]);
      b.tri(A, B, C, tint(col, -0.35), [0, -1, 0]);
    }
  });
  b.box(0.62, 0.02, 1.15, 0x39a0ff, { x: u.x + 0.75, y: top, z: u.z + 0.2, ry: 0.5 });
  b.box(0.62, 0.025, 0.18, 0xffffff, { x: u.x + 0.75, y: top, z: u.z + 0.2, ry: 0.5 });
  b.box(0.36, 0.26, 0.26, 0x3ddc84, { x: u.x - 0.55, y: top, z: u.z + 0.35, ry: 0.3 });
  b.box(0.38, 0.06, 0.28, 0xffffff, { x: u.x - 0.55, y: top + 0.26, z: u.z + 0.35, ry: 0.3 });
}

function featLagoon(isl, ctx) {
  const prof = isl.prof, N = 64, pos = [], idx = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N * TAU, s = prof.shore(t), c = Math.cos(t), sn = Math.sin(t);
    pos.push(c * (s + 0.35), 0, sn * (s + 0.35), c * (s + 2.7), 0, sn * (s + 2.7));
  }
  for (let i = 0; i < N; i++) { const a = i * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  const m = new THREE.Mesh(g, shared().lagoon);
  m.position.y = 0.05;
  m.renderOrder = 1;
  isl.body.add(m);
  const { b } = ctx, r = rng(isl.id + '|reef');
  for (let i = 0; i < 7; i++) {
    const t = i / 7 * TAU + r() * 0.5, d = prof.shore(t) + 2.4 + r() * 0.4, x = Math.cos(t) * d, z = Math.sin(t) * d;
    b.ico(0.5, 1, 0xf7dfa0, { x, y: -0.07, z, s: [1.8 + r(), 0.28, 0.7], ry: tangentYaw(t) }, 0.05);
    if (i % 3 === 0) b.add(protos().palm, 0xffffff, { x, y: 0.02, z, s: 0.6, ry: r() * TAU });
  }
}

function featCrab(isl) {
  const hb = new GeoBuilder(60);
  hb.ico(0.14, 0, 0xff5a3c, { y: 0.08, s: [1.3, 0.6, 1] });
  for (const sx of [-1, 1]) {
    hb.ico(0.065, 0, 0xff7a5c, { x: sx * 0.2, y: 0.1, z: 0.12 });
    hb.cyl(0.012, 0.012, 0.1, 3, 0xff5a3c, { x: sx * 0.05, y: 0.12, z: 0.06 });
    hb.ico(0.03, 0, 0x111111, { x: sx * 0.05, y: 0.23, z: 0.06 });
    for (let k = 0; k < 3; k++) hb.beam([sx * 0.12, 0.07, -0.06 + k * 0.06], [sx * 0.26, 0.0, -0.1 + k * 0.08], 0.02, 0.02, 0xd8452c);
  }
  const crab = hb.mesh(shared().vc);
  isl.body.add(crab);
  const prof = isl.prof, a0 = isl.outAngle + Math.PI * 0.8;
  isl.anim.push((dt, t) => {
    const a = a0 + Math.sin(t * 0.35 + isl.phase) * 0.35;
    const d = prof.cliffBase(a) + prof.beachW(a) * 0.45;
    crab.position.set(Math.cos(a) * d, 0.17 + Math.abs(Math.sin(t * 9)) * 0.02, Math.sin(a) * d);
    crab.rotation.y = radialYaw(a) + Math.PI;
  });
}

function featCottage(isl, ctx, c) {
  const { b, bw, bl, top } = ctx;
  const ry = Math.PI / 4, wall = 0xfff1d6, roof = 0xd0573f;
  const o = { x: c.x, y: top, z: c.z, ry };
  for (const B of [b, bw, bl]) B.push(o);
  b.box(1.9, 0.12, 1.5, 0xb8a58c, {}, 0.03);
  b.box(1.7, 1.05, 1.3, wall, { y: 0.12 }, 0.03);
  b.gable(2.0, 0.78, 1.64, roof, { y: 1.17 }, wall);
  b.box(0.28, 0.85, 0.28, 0xa0523a, { x: 0.52, y: 1.3, z: -0.32 }, 0.05);
  b.box(0.34, 0.08, 0.34, 0x7a3a2a, { x: 0.52, y: 2.15, z: -0.32 });
  b.box(0.38, 0.64, 0.05, PAL.woodDark, { y: 0.12, z: 0.66 });
  b.ico(0.035, 0, 0xffc53d, { x: 0.12, y: 0.44, z: 0.7 });
  for (const sx of [-1, 1]) {
    bw.box(0.32, 0.3, 0.04, 0x9fd3ff, { x: sx * 0.52, y: 0.55, z: 0.66 });
    b.box(0.08, 0.34, 0.04, 0x3f9a5a, { x: sx * 0.52 - 0.22, y: 0.53, z: 0.67 });
    b.box(0.08, 0.34, 0.04, 0x3f9a5a, { x: sx * 0.52 + 0.22, y: 0.53, z: 0.67 });
    b.box(0.38, 0.08, 0.12, 0x7a4b2b, { x: sx * 0.52, y: 0.45, z: 0.72 });
    for (let k = 0; k < 3; k++) b.ico(0.05, 0, k % 2 ? 0xff7fb0 : 0xffe066, { x: sx * 0.52 - 0.12 + k * 0.12, y: 0.56, z: 0.73 });
    bw.box(0.04, 0.3, 0.32, 0x9fd3ff, { x: sx * 0.86, y: 0.55, z: 0 });
  }
  bl.box(0.1, 0.13, 0.1, 0xfff0c0, { x: 0.28, y: 0.86, z: 0.72 });
  for (let k = 0; k < 3; k++) b.cyl(0.12, 0.13, 0.03, 6, 0xc9c0b0, { x: (k % 2 - 0.5) * 0.12, z: 0.95 + k * 0.3 });
  for (const B of [b, bw, bl]) B.pop();
  const [sx, sz] = frameXZ(c.x, c.z, ry, 0.52, -0.32);
  let next = 0;
  isl.anim.push((dt, t) => {
    if (t < next) return;
    next = t + 0.55 + Math.random() * 0.4;
    isl._parts('puff').spawn(sx, top + 2.3, sz, 0.15, 0.55, 0.05, { life: 2.8, size: 0.13, color: 0xdedee6, grow: 2.4, drag: 0.3 });
  });
}

function featGarden(ctx, g) {
  const { b, top } = ctx;
  b.box(1.35, 0.08, 1.05, 0x7a5236, { x: g.x, y: top, z: g.z, ry: 0.3 }, 0.04);
  b.at({ x: g.x, y: top + 0.08, z: g.z, ry: 0.3 }, () => {
    for (let row = 0; row < 3; row++) for (let k = 0; k < 4; k++) b.cone(0.07, 0.2, 4, row === 1 ? 0x9be22d : 0x5fbf4a, { x: -0.45 + k * 0.3, z: -0.32 + row * 0.32 });
    b.ico(0.13, 0, 0xff8a1f, { x: 0.5, y: 0.06, z: 0.36, s: [1.2, 0.85, 1.2] });
    b.ico(0.1, 0, 0xffa53d, { x: 0.3, y: 0.05, z: 0.42, s: [1.2, 0.85, 1.2] });
    for (let k = 0; k <= 6; k++) b.box(0.05, 0.32, 0.05, 0xf6f1e4, { x: -0.72 + k * 0.24, y: -0.08, z: 0.6 });
    b.box(1.5, 0.04, 0.03, 0xf6f1e4, { y: 0.12, z: 0.6 });
  });
}

function featDoghouse(ctx, d) {
  const { b, top } = ctx;
  b.at({ x: d.x, y: top, z: d.z, ry: Math.PI / 4 - 0.3 }, () => {
    b.box(0.62, 0.45, 0.62, 0xc0392b, {}, 0.04);
    b.gable(0.72, 0.3, 0.74, 0x5b4636, { y: 0.45, ry: Math.PI / 2 }, 0xc0392b);
    b.box(0.26, 0.3, 0.03, 0x241814, { z: 0.31 });
    b.box(0.3, 0.2, 0.42, 0xf4efe6, { x: 0.48, z: 0.25 });
    b.box(0.2, 0.18, 0.2, 0xf4efe6, { x: 0.48, y: 0.14, z: 0.5 });
    b.box(0.06, 0.1, 0.05, 0x5b4636, { x: 0.41, y: 0.28, z: 0.5 });
    b.box(0.06, 0.1, 0.05, 0x5b4636, { x: 0.55, y: 0.28, z: 0.5 });
    b.box(0.05, 0.05, 0.03, 0x111111, { x: 0.48, y: 0.2, z: 0.61 });
    b.cyl(0.03, 0.03, 0.16, 4, 0xf6f1e4, { x: 0.1, y: 0.03, z: 0.55, rz: Math.PI / 2 });
  });
}

function featClothesline(ctx, c) {
  const { b, top } = ctx;
  const a = Math.atan2(c.z, c.x) + Math.PI / 2, dx = Math.cos(a) * 0.7, dz = Math.sin(a) * 0.7;
  for (const s of [-1, 1]) {
    b.cyl(0.035, 0.04, 1.25, 5, PAL.woodDark, { x: c.x + dx * s, y: top, z: c.z + dz * s });
    b.box(0.3, 0.04, 0.04, PAL.woodDark, { x: c.x + dx * s, y: top + 1.2, z: c.z + dz * s, ry: -a + Math.PI / 2 });
  }
  const pts = [];
  for (let k = 0; k <= 6; k++) { const u = k / 6; pts.push([c.x + dx * (2 * u - 1), top + 1.18 - 0.12 * 4 * u * (1 - u), c.z + dz * (2 * u - 1)]); }
  b.tube(pts, 0.01, 0xf0f0f0, 10);
  [[0.28, 0x39a0ff], [0.5, 0xff5fa2], [0.72, 0xffe066]].forEach(([u, col]) => {
    const y = top + 1.18 - 0.12 * 4 * u * (1 - u);
    b.box(0.3, 0.36, 0.02, col, { x: c.x + dx * (2 * u - 1), y: y - 0.36, z: c.z + dz * (2 * u - 1), ry: -a });
  });
}

function featMailbox(ctx, m) {
  const { b, top } = ctx;
  b.cyl(0.035, 0.04, 0.8, 5, PAL.woodDark, { x: m.x, y: top, z: m.z });
  b.box(0.24, 0.2, 0.36, 0x2e86de, { x: m.x, y: top + 0.8, z: m.z, ry: Math.PI / 4 });
  b.cyl(0.12, 0.12, 0.36, 8, 0x2e86de, { x: m.x, y: top + 1.0, z: m.z, rx: Math.PI / 2, ry: Math.PI / 4 });
  b.box(0.03, 0.22, 0.06, 0xff4d4d, { x: m.x + 0.12, y: top + 0.92, z: m.z - 0.02 });
}

// ---- Island: feature dispatch, Git Tree, banner & branch visuals --------------------------------------

Object.assign(Island.prototype, {
  _features(ctx) {
    const L = this.L, kind = this.kind, tier = this.tier;
    const F = (fn, ...a) => { try { fn(...a); } catch (e) { console.warn('[islands] feature', fn.name, e); } };
    if (kind === 'repo') {
      F(() => this._makeTree());
      // a cobbled ring anchors the Git Tree as the island's landmark
      const C = L.center, b = ctx.b, top = ctx.top;
      b.cyl(C.r * 0.92, C.r * 0.98, 0.05, 16, 0xdccfb4, { x: C.x, y: top - 0.02, z: C.z }, 0.04);
      const n = Math.round(C.r * 9);
      for (let i = 0; i < n; i++) { const a = i / n * TAU; b.ico(0.1, 0, i % 2 ? 0xb9ad98 : 0xcfc3ad, { x: C.x + Math.cos(a) * C.r * 0.93, y: top + 0.03, z: C.z + Math.sin(a) * C.r * 0.93, s: [1.2, 0.5, 1] }); }
    }
    else if (kind === 'camp') F(featCampfire, this, ctx, L.center);
    else if (kind === 'sandbox') F(featSandbox, this, ctx, L.center);
    else F(featCottage, this, ctx, L.center);
    F(featFlag, this, ctx, L.flag);
    F(featArchive, this, ctx, L.archive);
    F(featPad, this, ctx, L.pad);
    for (const c of L.crystals) F(featCrystals, ctx, c, tier >= 3);
    if (L.ruins) F(featRuins, ctx, L.ruins);
    for (const l of L.lamps) F(featLamp, ctx, l.x, l.z);
    for (const s of L.shore) F(featFishingSpot, ctx, s);
    if (kind === 'repo' && tier === 2) F(featFences, this, ctx);
    for (const tu of L.turrets) F(featTurret, this, ctx, tu);
    for (const s of L.silos) F(featSilo, ctx, s);
    if (L.pylons.length > 1) F(featPylons, ctx, L.pylons);
    if (kind === 'repo' && tier >= 4) { F(featWalls, this, ctx); for (const s of L.spires) F(featSpire, ctx, s); }
    if (kind === 'camp') {
      const C = L.center;
      (L.misc.tents || []).forEach((t, i) => F(featTent, ctx, t, i ? 0x2ed3c5 : 0xff8a3d, Math.atan2(C.x - t.x, C.z - t.z)));
      if (L.misc.sign) F(featDragonSign, this, ctx, L.misc.sign);
      F(featDriftwood, this, ctx);
      F(featSerpent, this);
    } else if (kind === 'sandbox') {
      if (L.misc.umbrella) F(featUmbrella, ctx, L.misc.umbrella);
      if (L.misc.bucket) F(featBucket, ctx, L.misc.bucket);
      F(featLagoon, this, ctx);
      F(featCrab, this);
    } else if (kind === 'home') {
      if (L.misc.garden) F(featGarden, ctx, L.misc.garden);
      if (L.misc.doghouse) F(featDoghouse, ctx, L.misc.doghouse);
      if (L.misc.clothes) F(featClothesline, ctx, L.misc.clothes);
      if (L.misc.mailbox) F(featMailbox, ctx, L.misc.mailbox);
    }
  },

  _flagBranch() {
    if (this.kind === 'repo') return this.branch || 'main';
    return this.branch || ({ camp: 'no git', sandbox: 'sandbox', home: 'home sweet home' })[this.kind];
  },

  // The Git Tree: one big branch per git branch (cap 12), a sign with the current branch.
  _makeTree() {
    if (this.tree) { disposeTree(this.tree.group); this.tree = null; }
    const C = this.L.center, top = this.top, nb = this.nb, tier = this.tier;
    const r = rng(this.id + '|tree');
    const g = new THREE.Group();
    g.name = 'gitTree';
    g.position.set(C.x, top, C.z);
    const b = new GeoBuilder(hashNum(this.id) + 7);
    const sc = 1.0 + 0.12 * tier + 0.025 * nb;
    const H = 1.35 * sc;
    for (let i = 0; i < 5; i++) {
      const a = i / 5 * TAU + r() * 0.5;
      b.beam([Math.cos(a) * 0.12 * sc, 0.32 * sc, Math.sin(a) * 0.12 * sc], [Math.cos(a) * 0.5 * sc, -0.04, Math.sin(a) * 0.5 * sc], 0.13 * sc, 0.13 * sc, PAL.woodDark);
    }
    b.cyl(0.17 * sc, 0.27 * sc, H, 7, PAL.woodDark, {}, 0.06);
    const leaves = [0x7ed957, 0x57c46a, 0x9be22d, 0x3fb58a, 0x6fd08c, 0xa8e05a];
    const golden = 2.39996;
    const tips = [];
    for (let i = 0; i < nb; i++) {
      const yaw = i * golden + r() * 0.35 + this.phase;
      const el = 0.42 + ((i * 0.37) % 1) * 0.55;
      const h0 = H * (0.5 + 0.45 * ((i * 0.618 + 0.3) % 1));
      const len = (0.62 + r() * 0.4) * sc * (nb > 6 ? 1.12 : 1);
      const s = [Math.cos(yaw) * 0.1 * sc, h0, Math.sin(yaw) * 0.1 * sc];
      const e = [s[0] + Math.cos(yaw) * Math.cos(el) * len, h0 + Math.sin(el) * len, s[2] + Math.sin(yaw) * Math.cos(el) * len];
      b.beam(s, e, 0.1 * sc, 0.1 * sc, PAL.woodDark);
      const cr = (0.34 + r() * 0.14) * sc;
      b.ico(cr, 0, leaves[i % leaves.length], { x: e[0], y: e[1] + cr * 0.45, z: e[2], ry: r() * 3 }, 0.07);
      tips.push([e[0], e[1] + cr * 0.45, e[2], leaves[i % leaves.length]]);
    }
    b.ico(0.6 * sc, 0, 0x8fe060, { y: H + 0.3 * sc }, 0.06);
    b.ico(0.38 * sc, 0, 0xb4ef7a, { x: 0.18 * sc, y: H + 0.68 * sc, z: -0.08 * sc }, 0.06);
    // HEAD: a little golden star above the crown
    b.oct(0.16 * sc, 0xffc53d, { y: H + 1.25 * sc, ry: 0.4, s: [1, 1.3, 1] });
    const fruits = Math.min(6, 1 + Math.floor((this.data.git?.commits ?? 0) / 300));
    for (let i = 0; i < fruits; i++) {
      const a = r() * TAU;
      b.ico(0.075 * sc, 0, i % 2 ? 0xffc53d : 0xff5a4e, { x: Math.cos(a) * 0.5 * sc, y: H + (0.05 + r() * 0.5) * sc, z: Math.sin(a) * 0.5 * sc });
    }
    const armY = Math.min(H * 0.62, 1.05 * sc);
    const ax = Math.sin(SIGN_YAW) * 0.6 * sc, az = Math.cos(SIGN_YAW) * 0.6 * sc;
    b.beam([0, armY - 0.05, 0], [ax, armY, az], 0.07 * sc, 0.07 * sc, PAL.woodDark);
    const bx = Math.cos(SIGN_YAW), bz = -Math.sin(SIGN_YAW);   // board's local +X in the tree frame
    b.box(1.5, 0.38, 0.07, PAL.woodDark, { x: ax, y: armY - 0.61, z: az, ry: SIGN_YAW });
    for (const k of [-0.55, 0.55]) b.beam([ax + bx * k, armY - 0.24, az + bz * k], [ax, armY, az], 0.02, 0.02, 0xd9c08a);
    const treeMesh = b.mesh(shared().vc);
    g.add(treeMesh);
    const sign = new THREE.Group();
    sign.position.set(ax, armY - 0.42, az);
    g.add(sign);
    this.body.add(g);
    this.tree = { group: g, sign, board: null, mesh: treeMesh, tips, crown: H + 0.9 * sc, sc };
    this._treeSign(this.branch);
  },

  _treeSign(branch) {
    const tr = this.tree;
    if (!tr) return;
    if (tr.board) { disposeTree(tr.board); tr.board = null; }   // releases the cached sign texture
    const g = textSign(trunc(branch || 'main', 22), { w: 1.42, h: 0.3, bg: '#f3e2b3', fg: '#3b2a16', border: '#7a4b2b' });
    g.rotation.y = SIGN_YAW;
    g.position.set(Math.sin(SIGN_YAW) * 0.046, 0, Math.cos(SIGN_YAW) * 0.046);
    tr.sign.add(g);
    tr.board = g;
  },

  _rebuildTree() {
    if (this.kind !== 'repo' || !this.body) return;
    this._makeTree();
    this._gitTreeReset();      // the cast and the fire are fitted to the tree: refit them
  },

  // Flag texture, tree sign and label for a (new) branch.
  _setBranchVisuals(branch) {
    if (this.flag) {
      const old = this.flag.mat.map;
      this.flag.mat.map = bannerTexture(this.data.name || this.id, this._flagBranch(), this.flag.color);
      this.flag.mat.needsUpdate = true;
      old?.dispose();
    }
    if (this.tree) {
      this._treeSign(branch);
      const p = this.tree.board;
      if (p && !this._young) { p.scale.setScalar(0.2); tween(p.scale, { x: 1, y: 1, z: 1 }, 0.7, ease.outBack); }
    }
    this._refreshLabel();
  },
});

// ---- scatter tables ---------------------------------------------------------------------------------

const TREE_KINDS = new Set(['lolly', 'conifer', 'cloud', 'blossom', 'palm']);
const SCATTER = {
  camp: { palm: 0.045, rock: 0.05, tuft: 0.22, bush: 0.02 },
  sandbox: { palm: 0.03, tuft: 0.08, rock: 0.015 },
  home: { lolly: 0.05, blossom: 0.03, cloud: 0.02, bush: 0.05, flowers: 0.16, tuft: 0.2, rock: 0.02 },
  1: { lolly: 0.07, conifer: 0.05, cloud: 0.03, bush: 0.05, flowers: 0.1, tuft: 0.25, rock: 0.04 },
  2: { lolly: 0.05, conifer: 0.045, cloud: 0.025, bush: 0.045, flowers: 0.1, tuft: 0.22, rock: 0.04, blossom: 0.008 },
  3: { lolly: 0.035, conifer: 0.05, cloud: 0.015, bush: 0.035, flowers: 0.07, tuft: 0.2, rock: 0.05 },
  4: { lolly: 0.025, conifer: 0.04, bush: 0.03, flowers: 0.06, tuft: 0.15, rock: 0.04 },
};
const TINTS = {
  tree: [0xffffff, 0xeaffd6, 0xd9f7c0, 0xfff4cf, 0xd2f0e0],
  flowers: [0xff7fb0, 0xffe066, 0xffffff, 0xc39bff, 0xff9f5a],
  rock: [0xffffff, 0xe8e4f4, 0xd8d2e8],
  tuft: [0xffffff, 0xe6ffd0, 0xd8f0b0],
  shell: [0xffffff, 0xffd0e0, 0xfff0c8],
};

let CRATE = null;
function crateProtos() {
  if (CRATE) return CRATE;
  const cb = new GeoBuilder(77);
  cb.box(0.5, 0.5, 0.5, PAL.wood, {}, 0.04);
  for (const y of [0.04, 0.42]) cb.box(0.52, 0.06, 0.52, PAL.woodDark, { y });
  cb.box(0.52, 0.12, 0.12, PAL.hazard, { y: 0.19 });
  cb.box(0.12, 0.12, 0.52, PAL.hazard, { y: 0.19 });
  const crate = cb.build();
  crate.userData.shared = true;
  const pb = new GeoBuilder(78);
  const N = 8, Pt = (rr, y, a) => [Math.cos(a) * rr, y, Math.sin(a) * rr];
  for (let i = 0; i < N; i++) {
    const a0 = i / N * TAU, a1 = (i + 1) / N * TAU, am = (a0 + a1) / 2, col = i % 2 ? 0xffffff : 0xff4d4d;
    pb.tri(Pt(0, 0.95, 0), Pt(0.55, 0.85, a1), Pt(0.55, 0.85, a0), col, [0, 1, 0]);
    pb.quad(Pt(0.55, 0.85, a0), Pt(0.55, 0.85, a1), Pt(0.85, 0.5, a1), Pt(0.85, 0.5, a0), col, [Math.cos(am), 1, Math.sin(am)]);
    pb.tri(Pt(0, 0.93, 0), Pt(0.55, 0.83, a0), Pt(0.55, 0.83, a1), tint(col, -0.4), [0, -1, 0]);
    pb.quad(Pt(0.55, 0.83, a0), Pt(0.85, 0.48, a0), Pt(0.85, 0.48, a1), Pt(0.55, 0.83, a1), tint(col, -0.4), [-Math.cos(am), -1, -Math.sin(am)]);
  }
  for (const [x, z] of [[0.22, 0.22], [-0.22, 0.22], [0.22, -0.22], [-0.22, -0.22]]) {
    const a = Math.atan2(z, x);
    pb.beam([x, -0.05, z], [Math.cos(a) * 0.82, 0.5, Math.sin(a) * 0.82], 0.015, 0.015, 0xe8e8e8);
  }
  const canopy = pb.build();
  canopy.userData.shared = true;
  CRATE = { crate, canopy };
  return CRATE;
}

function annexHtml(rec) {
  return `<div class="isl-tag isl-annex"><div class="isl-name">${BRANCH_SVG}${esc(trunc(rec.name, 24))}</div>`
    + `<div class="isl-meta">${rec.branch ? `<span class="isl-branch">${esc(trunc(rec.branch, 26))}</span><span class="isl-dot">·</span>` : ''}<span class="isl-title">worktree</span></div></div>`;
}

// Rope bridge from A to B (island-local [x, z]) at plateau height, planks sag a little.
function buildRopeBridge(b, A, B, top) {
  const dx = B[0] - A[0], dz = B[1] - A[1], L = Math.hypot(dx, dz) || 1;
  const ux = dx / L, uz = dz / L, vx = -uz, vz = ux;
  const n = Math.max(4, Math.round(L / 0.3));
  const sag = Math.min(0.3, L * 0.06);
  const yAt = (u) => top - 0.05 - sag * 4 * u * (1 - u);
  const yaw = Math.atan2(ux, uz);
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    b.box(1.05, 0.06, 0.24, i % 3 === 1 ? tint(PAL.wood, -0.12) : PAL.wood, { x: A[0] + dx * u, y: yAt(u) - 0.04, z: A[1] + dz * u, ry: yaw + (i % 2 - 0.5) * 0.06 }, 0.05);
  }
  for (const s of [-1, 1]) {
    const px = vx * 0.6 * s, pz = vz * 0.6 * s;
    for (const P0 of [A, B]) b.cyl(0.06, 0.07, 1.0, 5, PAL.woodDark, { x: P0[0] + px, y: top - 0.1, z: P0[1] + pz });
    const hand = [], deck = [];
    for (let k = 0; k <= 10; k++) {
      const u = k / 10, x = A[0] + dx * u + px * 0.92, z = A[1] + dz * u + pz * 0.92;
      hand.push([x, top + 0.82 - sag * 1.6 * 4 * u * (1 - u), z]);
      deck.push([x, yAt(u) + 0.02, z]);
    }
    b.tube(hand, 0.022, 0xd9c08a, 14);
    b.tube(deck, 0.018, 0xc9ad78, 14);
    for (let k = 1; k < 10; k += 2) b.beam(deck[k], hand[k], 0.015, 0.015, 0xd9c08a);
  }
}

// ---- Island: scatter, foam, annexes, platforms, launches ---------------------------------------------

Object.assign(Island.prototype, {
  // Scatter: items that never need hiding are merged into the static mesh; items standing in a spare lot are
  // instanced so they can be cleared (and regrown) when a building arrives or leaves.
  _scatter(stat) {
    const prof = this.prof, L = this.L, top = this.top;
    const r = rng(this.id + '|scatter');
    const dens = SCATTER[this.kind === 'repo' ? this.tier : this.kind] || SCATTER[1];
    const area = Math.PI * prof.pmin * prof.pmin;
    const soft = L.slots.filter((s) => !s.hard && !s.used);
    const solid = L.slots.filter((s) => s.hard || s.used);
    const placed = [];
    const out = {};
    const blocked = (x, z, pad, tree, big) => {
      for (const o of L.occ) {
        const extra = tree ? (o.tag === 'center' || o.tag === 'plaza' ? 1.4 : o.tag === 'archive' || o.tag === 'pad' || o.tag === 'flag' ? 0.35 : 0) : 0;
        if (Math.hypot(o.x - x, o.z - z) < o.r + pad + extra) return true;
      }
      for (const s of solid) if (sqDist(x, z, s, LOT_HALF) < LOT_MARGIN + pad) return true;
      if (big) for (const p of L.paths) if (segDist(x, z, p) < 0.75) return true;
      return false;
    };
    for (const [k, dv] of Object.entries(dens)) {
      const tree = TREE_KINDS.has(k);
      const n = Math.round(area * dv);
      const gap = tree ? 0.95 : k === 'rock' || k === 'bush' ? 0.5 : 0.3;
      const pad = tree ? 0.35 : k === 'rock' || k === 'bush' ? 0.18 : 0.04;
      const arr = out[k] = [];
      let tries = n * 30;
      while (arr.length < n && tries-- > 0) {
        const t = r() * TAU, d = Math.sqrt(r()) * (prof.plateau(t) - (tree ? 0.45 : 0.18));
        const x = Math.cos(t) * d, z = Math.sin(t) * d;
        if (blocked(x, z, pad, tree, tree || k === 'rock' || k === 'bush')) continue;
        let ok = true;
        for (const p of placed) {
          const need = tree && p.tree ? Math.max(gap, p.gap) : Math.min(gap, p.gap) * 0.9;
          if (Math.hypot(p.x - x, p.z - z) < need) { ok = false; break; }
        }
        if (!ok) continue;
        placed.push({ x, z, gap, tree });
        const slots = soft.filter((s) => sqDist(x, z, s, LOT_HALF) < LOT_MARGIN + (tree ? 0.4 : 0.1)).map((s) => s.idx);
        arr.push({ x, y: top, z, s: tree ? 0.8 + r() * 0.5 : 0.7 + r() * 0.6, ry: r() * TAU, slots, tint: r() });
      }
    }
    // beach pebbles and shells, kept away from the dock side
    const nb = Math.round(TAU * this.radius * 0.18);
    out.rock = out.rock || [];
    const shells = out.shell = [];
    for (let i = 0; i < nb; i++) {
      const t = r() * TAU;
      if (Math.abs(angDiff(t, this.outAngle)) < 0.9) continue;
      const cb = prof.cliffBase(t), bw = prof.beachW(t), f = 0.2 + r() * 0.55;
      const d = cb + bw * f, y = 0.3 - 0.27 * f;
      const it = { x: Math.cos(t) * d, y: y - 0.04, z: Math.sin(t) * d, s: 0.45 + r() * 0.4, ry: r() * TAU, slots: [], tint: r() };
      if (r() < 0.55) out.rock.push(it); else shells.push({ ...it, s: 0.8 + r() * 0.5 });
    }
    const PR = protos(), S = shared();
    this.scat = [];
    for (const [k, all] of Object.entries(out)) {
      if (!all.length || !PR[k]) continue;
      const tints0 = TREE_KINDS.has(k) ? TINTS.tree : TINTS[k] || TINTS.tuft;
      const arr = stat ? all.filter((it) => it.slots.length) : all;
      if (stat) for (const it of all) if (!it.slots.length) stat.add(PR[k], tints0[Math.floor(it.tint * tints0.length) % tints0.length], { x: it.x, y: it.y, z: it.z, ry: it.ry, s: it.s });
      if (!arr.length) continue;
      const mesh = new THREE.InstancedMesh(PR[k], S.vc, arr.length);
      mesh.name = 'scatter:' + k;
      mesh.castShadow = TREE_KINDS.has(k) || k === 'rock' || k === 'bush';
      mesh.receiveShadow = true;
      const tints = TREE_KINDS.has(k) ? TINTS.tree : TINTS[k] || TINTS.tuft;
      arr.forEach((it, i) => {
        it.mesh = mesh; it.i = i; it.hidden = false; it.tree = TREE_KINDS.has(k);
        this._setInst(it, it.s);
        mesh.setColorAt(i, _col.set(tints[Math.floor(it.tint * tints.length) % tints.length]));
        this.scat.push(it);
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
      this.body.add(freeze(mesh));   // (clearing a lot animates the instances, never the mesh itself)
    }
  },

  _setInst(it, s) {
    _q.setFromAxisAngle(UP, it.ry);
    const k = Math.max(1e-4, s);
    _m4.compose(_v.set(it.x, it.y, it.z), _q, _sc.set(k, k, k));
    it.mesh.setMatrixAt(it.i, _m4);
    it.mesh.instanceMatrix.needsUpdate = true;
  },

  _clearScatter(slot, instant) {
    for (const it of this.scat || []) {
      if (it.hidden || !it.slots.includes(slot.idx)) continue;
      it.hidden = true;
      if (instant) { this._setInst(it, 0); continue; }
      const s0 = it.s;
      animate(0.45, (k) => { if (it.hidden) this._setInst(it, s0 * (1 - k)); }, ease.inCubic);
      if (it.tree) this._puff(V3(it.x, it.y + 0.4, it.z), 0xe8f5d0, 3, 0.3, { size: 0.2 });
    }
  },

  _restoreScatter(slot) {
    const used = new Set(this.L.slots.filter((s) => s.used).map((s) => s.idx));
    for (const it of this.scat || []) {
      if (!it.hidden || !it.slots.includes(slot.idx) || it.slots.some((i) => used.has(i))) continue;
      it.hidden = false;
      animate(0.9, (k) => { if (!it.hidden) this._setInst(it, it.s * k); }, ease.outBack);
    }
  },

  _foam(parent, prof, phase, list = this.anim) {
    const N = 72, pos = [], idx = [];
    for (let i = 0; i <= N; i++) {
      const t = i / N * TAU, s = prof.shore(t), c = Math.cos(t), sn = Math.sin(t);
      pos.push(c * (s - 0.15), 0, sn * (s - 0.15), c * (s + 0.5), 0, sn * (s + 0.5));
    }
    for (let i = 0; i < N; i++) { const a = i * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    const m = new THREE.Mesh(g, shared().foam);
    m.name = 'foam';
    m.position.y = 0.07;
    m.renderOrder = 1;
    parent.add(m);
    list.push((dt, t) => { const k = 1 + 0.012 * Math.sin(t * 1.4 + phase); m.scale.set(k, 1, k); });
    return m;
  },

  // ---- worktree annex islets ----
  _syncAnnexes() {
    const want = new Map();
    for (const a of this.data.annexes || []) if (a?.id != null) want.set(String(a.id), a);
    for (const [id, a] of want) {
      const rec = this.annexes.get(id);
      if (!rec) this._addAnnex(a);
      else if (!rec.leaving && (rec.branch !== (a.branch || '') || (a.name && rec.name !== a.name))) {
        rec.branch = a.branch || ''; rec.name = a.name || rec.name;
        safe(() => rec.label?.set(annexHtml(rec)));
      }
    }
    for (const [id, rec] of [...this.annexes]) if (!want.has(id) && !rec.lotKey && !rec.leaving) this._removeAnnex(id);
  },

  _addAnnex(a) {
    const id = String(a.id), prof = this.prof, aR = 4.7, top = this.top;
    let best = null, bs = Infinity;
    for (let k = 0; k < 48; k++) {
      const t = k / 48 * TAU, D = prof.shore(t) + 1.9 + aR;
      const wx = this.position.x + Math.cos(t) * D, wz = this.position.z + Math.sin(t) * D;
      let s = 0;
      const lay = this.world.layout;
      if (lay?.forEach) lay.forEach((o, oid) => { if (oid === this.id || !o) return; const gap = Math.hypot(o.x - wx, o.z - wz) - (o.r || 7) - aR; if (gap < 4) s += (4 - gap) * 3; });
      if (Math.hypot(wx, wz) < 7 + aR + 4) s += 20;
      for (const o of this.annexes.values()) { const da = Math.abs(angDiff(t, o.t)); if (da < 1.0) s += (1.0 - da) * 30; }
      for (const d of this.docks.values()) { const da = Math.abs(angDiff(t, d.t)); if (da < 0.7) s += (0.7 - da) * 10; }
      for (const p of this.platforms) { const da = Math.abs(angDiff(t, p.t)); if (da < 0.9) s += (0.9 - da) * 20; }
      const rd = prof.plateau(t) - 0.4, rx = Math.cos(t) * rd, rz = Math.sin(t) * rd;
      for (const o of this.L.occ) { if (o.tag === 'shore') continue; const g = Math.hypot(o.x - rx, o.z - rz) - o.r; if (g < 0.8) s += (0.8 - g) * 6; }
      for (const sl of this.L.slots) { const g = sqDist(rx, rz, sl, LOT_HALF); if (g < 0.9) s += (0.9 - g) * (sl.hard || sl.used ? 12 : 3); }
      s += Math.abs(angDiff(t, this.outAngle)) * 0.8 + Math.abs(angDiff(t, this.backAngle)) * 0.4;
      if (s < bs) { bs = s; best = { t, D }; }
    }
    const { t, D } = best;
    const f = Math.atan2(-Math.cos(t), -Math.sin(t));   // the islet's lot faces the bridge / main island
    const rec = { id, name: a.name || id.split(/[\/]/).pop(), branch: a.branch || '', t, D, R: aR, x: Math.cos(t) * D, z: Math.sin(t) * D, anim: [], lotKey: null, leaving: false };
    rec.prof = makeProfile(id, aR, top, { amp: 0.3, beach: 0.6 });
    const g = rec.group = new THREE.Group();
    g.name = `annex:${id}`;
    g.position.set(rec.x, 0, rec.z);
    this.group.add(g);
    const b = new GeoBuilder(hashNum(id));
    buildTerrain(b, rec.prof, paletteFor(this.kind, id), id, { N: 30 });
    // pennant on a free bit of rim (never inside the lot), facing the default camera
    const lotLocal = { x: 0, z: 0, f };
    let pp = null;
    for (let k = 0; k < 24 && !pp; k++) {
      const pa = Math.PI / 4 + 0.6 + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 0.26, pd = rec.prof.plateau(pa) - 0.3;
      const px = Math.cos(pa) * pd, pz = Math.sin(pa) * pd;
      if (sqDist(px, pz, lotLocal, LOT_HALF) > 0.45) pp = [px, pz];
    }
    rec.pp = pp;               // the git fire / cast on a worktree go on this pole (_gitSync)
    if (pp) {
      b.cyl(0.035, 0.045, 1.9, 5, PAL.metal, { x: pp[0], y: top, z: pp[1] });
      b.at({ x: pp[0], y: top + 1.55, z: pp[1], ry: SIGN_YAW }, () => {
        b.tri([0, 0.3, 0], [0, -0.05, 0], [0.7, 0.12, 0], 0x39e5ff, [0, 0, 1]);
        b.tri([0, 0.3, 0], [0, -0.05, 0], [0.7, 0.12, 0], 0x1fb5e8, [0, 0, -1]);
      });
    }
    g.add(b.mesh(shared().vc));
    if (this.engine.addFoamRing) rec.foam = safe(() => this.engine.addFoamRing(this._w(rec.x, rec.z, 0), aR));
    else this._foam(g, rec.prof, hashNum(id) % 7, rec.anim);
    const pa = prof.plateau(t) - 0.2, pb = D - (rec.prof.plateau(t + Math.PI) - 0.2);
    const A = [Math.cos(t) * pa, Math.sin(t) * pa], B = [Math.cos(t) * pb, Math.sin(t) * pb];
    rec.bridge = [A[0], A[1], B[0], B[1]];
    const bb = new GeoBuilder(hashNum(id) + 1);
    buildRopeBridge(bb, A, B, top);
    rec.bridgeMesh = bb.mesh(shared().vc);
    rec.bridgeMesh.name = 'bridge';
    this.group.add(rec.bridgeMesh);
    rec.anchor = new THREE.Object3D();
    rec.anchor.position.set((A[0] + B[0]) / 2, top + 1.2, (A[1] + B[1]) / 2);
    this.group.add(rec.anchor);
    // the worktree tag floats over its islet (stacking above the islet's session labels), clear of the island's tag
    rec.tagAnchor = new THREE.Object3D();
    rec.tagAnchor.position.set(rec.x, top + 3.2, rec.z);
    this.group.add(rec.tagAnchor);
    rec.label = addLabel(this.engine, rec.tagAnchor, V3(0, 0, 0), annexHtml(rec), 'isl-annex-label', 'island', { group: 'annex:' + id, role: 'head' });
    rec.slot = { x: rec.x, z: rec.z, f, facing: f };
    this.annexes.set(id, rec);
    if (!this._young) {
      g.position.y = -2.6;
      tween(g.position, { y: 0 }, 1.2, ease.outBack);
      rec.bridgeMesh.visible = false;
      wait(1.0).then(() => { rec.bridgeMesh.visible = true; this._puff(V3(rec.anchor.position.x, top, rec.anchor.position.z), 0xe8dcc0, 6, 1.0); });
    }
    return rec;
  },

  _annexLot(key, annexId) {
    let rec = this.annexes.get(annexId);
    if (!rec) rec = this._addAnnex({ id: annexId, name: annexId.split(/[\\/]/).pop(), branch: '' });
    if (!rec || rec.lotKey || rec.leaving) return null;
    rec.lotKey = key;
    return this._mkLot(key, rec.slot.x, rec.slot.z, rec.slot.facing, { annex: annexId, annexRec: rec });
  },

  _removeAnnex(id) {
    const rec = this.annexes.get(id);
    if (!rec || rec.leaving) return;
    rec.leaving = true;
    safe(() => rec.label?.remove());
    safe(() => rec.foam?.remove());
    const g = rec.group, bm = rec.bridgeMesh;
    animate(1.4, (k) => { g.position.y = -3 * ease.inCubic(k); if (bm) bm.position.y = -3 * ease.inCubic(k); }).then(() => {
      disposeTree(g);
      if (bm) disposeTree(bm);
      rec.anchor?.removeFromParent();
      rec.tagAnchor?.removeFromParent();
      if (this.annexes.get(id) === rec) this.annexes.delete(id);
    });
  },

  // ---- expansion platforms (lots that do not fit on the plateau) ----
  _platformLot(key) {
    let pl = this.platforms.find((p) => !p.key && !p.sinking);
    if (!pl) {
      pl = { ...this._platformSpec(), key: null, sinking: false, token: 0 };
      this._buildPlatform(pl);
      this.platforms.push(pl);
    }
    pl.key = key;
    pl.token++;
    return this._mkLot(key, pl.x, pl.z, Math.atan2(-pl.ux, -pl.uz), { platform: true, plat: pl });
  },

  _platformSpec() {
    const prof = this.prof;
    let best = null, bs = Infinity;
    for (let k = 0; k < 72; k++) {
      const t = k / 72 * TAU, D = prof.shore(t) + 3.3;
      const hw = Math.asin(clamp(3.3 / D, 0, 1));
      let bad = false;
      for (const p of this.platforms) if (p.ring === 0 && Math.abs(angDiff(t, p.t)) < hw + Math.asin(clamp(3.3 / p.D, 0, 1)) + 0.05) bad = true;
      for (const d of this.docks.values()) if (Math.abs(angDiff(t, d.t)) < hw + (d.halfW + 0.4) / (prof.shore(d.t) + 2.5)) bad = true;
      for (const a of this.annexes.values()) if (Math.abs(angDiff(t, a.t)) < hw + Math.asin(clamp((a.R + 1.2) / a.D, 0, 1))) bad = true;
      if (bad) continue;
      const rd = prof.plateau(t) - 0.3, rx = Math.cos(t) * rd, rz = Math.sin(t) * rd;
      let s = Math.abs(angDiff(t, this.backAngle)) * 0.6;
      for (const o of this.L.occ) { if (o.tag === 'shore') continue; const g = Math.hypot(o.x - rx, o.z - rz) - o.r; if (g < 0.8) s += (0.8 - g) * 5; }
      for (const sl of this.L.slots) { const g = sqDist(rx, rz, sl, LOT_HALF); if (g < 0.9) s += (0.9 - g) * (sl.hard || sl.used ? 10 : 2); }
      if (s < bs) { bs = s; best = { t, D, ring: 0, parent: null }; }
    }
    if (!best) {
      const leaf = [...this.platforms].sort((a, b) => b.ring - a.ring).find((p) => !this.platforms.some((q) => q.parent === p)) || this.platforms[0];
      best = { t: leaf.t, D: leaf.D + 6.4, ring: leaf.ring + 1, parent: leaf };
    }
    const { t, D } = best, ux = Math.cos(t), uz = Math.sin(t);
    const w0 = best.parent ? best.parent.D + 2.85 : prof.plateau(t) - 0.25;
    return { ...best, ux, uz, x: ux * D, z: uz * D, walk: [ux * w0, uz * w0, ux * (D - 2.85), uz * (D - 2.85)] };
  },

  _buildPlatform(pl) {
    const top = this.top, S = 5.7, h = 0.3;
    const g = pl.group = new THREE.Group();
    g.name = 'platform';
    g.position.set(pl.x, 0, pl.z);
    g.rotation.y = Math.atan2(pl.ux, pl.uz);
    const b = new GeoBuilder(hashNum(this.id) + pl.ring * 7 + Math.round(pl.t * 100)), bl = new GeoBuilder(9);
    b.box(S, h, S, 0xaab4c6, { y: top - h }, 0.02);
    b.box(S - 0.6, 0.02, S - 0.6, 0x9aa5ba, { y: top });
    for (const k of [-1, 1]) {
      b.box(0.05, 0.025, S - 0.7, 0x7b869c, { x: k * 0.95, y: top });
      b.box(S - 0.7, 0.025, 0.05, 0x7b869c, { z: k * 0.95, y: top });
    }
    const segs = 14, sl = S / segs;
    for (let i = 0; i < segs; i++) {
      const c = i % 2 ? PAL.black : PAL.hazard, p = -S / 2 + sl * (i + 0.5);
      b.box(sl, 0.05, 0.16, c, { x: p, y: top - 0.02, z: S / 2 - 0.08 });
      b.box(0.16, 0.05, sl, c, { x: S / 2 - 0.08, y: top - 0.02, z: p });
      b.box(0.16, 0.05, sl, c, { x: -S / 2 + 0.08, y: top - 0.02, z: p });
    }
    const legH = top - h + 1.3;
    for (const lx of [-1, 0, 1]) for (const lz of [-1, 1]) b.cyl(0.17, 0.2, legH, 6, PAL.metalDark, { x: lx * (S / 2 - 0.4), y: -1.3, z: lz * (S / 2 - 0.4) });
    for (const lz of [-1, 1]) for (const lx of [-1, 1]) b.beam([lx * (S / 2 - 0.4), -0.2, lz * (S / 2 - 0.4)], [0, top - h - 0.05, lz * (S / 2 - 0.4)], 0.08, 0.08, PAL.metalDark);
    for (const [cx, cz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      b.cyl(0.03, 0.03, 0.55, 4, PAL.metalDark, { x: cx * (S / 2 - 0.12), y: top, z: cz * (S / 2 - 0.12) });
      bl.box(0.12, 0.12, 0.12, 0xffe0a0, { x: cx * (S / 2 - 0.12), y: top + 0.55, z: cz * (S / 2 - 0.12) });
    }
    // walkway home (towards -Z in the platform frame)
    const wl = Math.hypot(pl.walk[2] - pl.walk[0], pl.walk[3] - pl.walk[1]);
    const z0 = -S / 2, z1 = -S / 2 - wl, zm = (z0 + z1) / 2;
    b.box(1.1, 0.12, wl + 0.1, 0x8e99ae, { y: top - 0.12, z: zm }, 0.03);
    for (let z = z0 - 0.2; z > z1; z -= 0.3) b.box(1.1, 0.02, 0.04, 0x6f7a90, { y: top, z });
    for (const sx of [-1, 1]) {
      for (let z = z0; z >= z1 - 0.01; z -= 0.8) b.cyl(0.025, 0.025, 0.7, 4, PAL.metalDark, { x: sx * 0.55, y: top, z });
      b.box(0.04, 0.04, wl, PAL.hazard, { x: sx * 0.55, y: top + 0.68, z: zm });
    }
    if (wl > 2.2) b.cyl(0.12, 0.14, top + 1.2, 6, PAL.metalDark, { y: -1.3, z: zm });
    g.add(b.mesh(shared().vc));
    const ml = bl.mesh(shared().lamps, { cast: false });
    if (ml) g.add(ml);
    this.group.add(g);
    if (!this._young) {
      g.position.y = -3.2;
      tween(g.position, { y: 0 }, 1.1, ease.outBack);
      this._puff(V3(pl.x, 0.2, pl.z), PAL.foam, 10, 2.5, { up: 1.4 });
    }
  },

  _removePlatform(pl) {
    pl.key = null;
    const token = ++pl.token;
    wait(2.5).then(() => {
      if (pl.key || pl.token !== token || this._disposed || pl.sinking) return;
      if (this.platforms.some((q) => q.parent === pl)) return;
      pl.sinking = true;
      animate(1.3, (k) => { pl.group.position.y = -3.4 * ease.inCubic(k); }).then(() => {
        disposeTree(pl.group);
        this.platforms = this.platforms.filter((q) => q !== pl);
        if (pl.parent && !pl.parent.key && !pl.parent.sinking) this._removePlatform(pl.parent);
      });
    });
  },

  // ---- one-shot events: commit rocket/firework, pull supply drop, checkout flag swap ----
  launch(type, ev) {
    if (this._disposed) return;
    try {
      const e = typeof ev === 'string' ? { msg: ev, to: ev } : (ev || {});
      const annex = e.annex != null ? this.annexes.get(String(e.annex)) : null;
      const skip = e._skip || 0;
      if (type === 'commit') this._fxCommit(e, annex, skip);
      else if (type === 'pull') this._fxPull(e, annex, skip);
      else if (type === 'checkout') this._fxCheckout(e, annex, skip);
      else if (type === 'push') this._fxPush(e, annex, skip);
      else if (type === 'merge') this._fxMerge(e, annex, skip);
      else if (type === 'conflict') this._fxConflict(e, annex);
      else if (type === 'pr') this._fxPigeon(e, annex, skip);
    } catch (err) { console.warn('[islands] launch', err); }
  },

  // COMMIT: rocket from the pad (tier >= 3) or a firework; the commit message lingers in a banner.
  // Runs on the effect runner (see _runFx), so it can overlap other launches and be held for screenshots.
  _fxCommit(e, annex, skip = 0) {
    const msg = trunc(e.msg || e.message || 'commit', 48);
    const hash = e.hash ? String(e.hash).slice(0, 7) : '';
    if (annex) return this._fxFirework(V3(annex.x, this.top + 0.3, annex.z), msg, { height: 6.5, hash }, skip);
    const padFree = (this.engine.time ?? 0) >= (this._padBusyUntil || 0);
    if (this.rocket && !this.rocket.busy && padFree) return this._fxRocket(msg, hash, skip);
    return this._fxFirework(this._launchSpot(), msg, { height: this.tier >= 3 ? 10 : 8.5, hash }, skip);
  },

  // Where a launch leaves from: the pad, or (while another launch is using the pad) a spot beside the plaza.
  _launchSpot() {
    if ((this.engine.time ?? 0) >= (this._padBusyUntil || 0) && this.padTop) return this.padTop.clone();
    const P = this.L.plaza, a = Math.PI / 4 + 1.35, d = P.r + 1.1;
    return V3(P.x + Math.cos(a) * d, this.top + 0.2, P.z + Math.sin(a) * d);
  },

  _occupyPad(start, secs) { this._padBusyUntil = Math.max(this._padBusyUntil || 0, start + secs); },

  _commitInner(msg, hash) {
    return `<span class="isl-kick">COMMIT</span>${esc(msg)}${hash ? `<small>${esc(hash)}</small>` : ''}`;
  },

  // Majestic rocket: long rumble, slow accelerating climb with a lingering smoke column, burst, then a fresh rocket
  // rises out of the pad.
  _fxRocket(msg, hash, skip = 0) {
    const R = this.rocket, rg = R.group, home = R.home, sc = R.scale;
    const rm = !!this.engine.settings?.reduceMotion;
    const RUMBLE = rm ? 0.3 : 1.6, ASC = rm ? 2.4 : 6.0, BURST = RUMBLE + ASC, RISE = BURST + (rm ? 0.3 : 1.7);
    const dur = RISE + (rm ? 0.8 : 1.9), bannerEnd = rm ? dur - 0.2 : RUMBLE + 9.2, H = rm ? 24 : 34;
    R.busy = true;
    const g = new THREE.Group();
    g.name = 'fx:rocket';
    const anchor = new THREE.Object3D();
    anchor.position.set(home.x, home.y + 7, home.z);
    g.add(anchor);
    this.group.add(g);
    const start = (this.engine.time ?? 0) - skip;
    this._occupyPad(start, RUMBLE + ASC * 0.6);
    const PF = this._parts('puff'), SP = this._parts('spark');
    const yAt = (el) => home.y + H * Math.pow(clamp((el - RUMBLE) / ASC, 0, 1), 2.3);
    const smoke = (x, y, z, age = 0) => PF.spawn(x + (Math.random() - 0.5) * 0.25 * sc, y, z + (Math.random() - 0.5) * 0.25 * sc,
      (Math.random() - 0.5) * 0.7, -0.9, (Math.random() - 0.5) * 0.7, { life: rm ? 1.6 : 4.2, size: 0.3 * sc, color: 0xf2f2f6, grow: 2.2, drag: 1.1, age });
    if (!rm && skip > RUMBLE) for (let s = RUMBLE; s < Math.min(skip, BURST); s += 0.06) { const age = skip - s; if (age < 4.2) smoke(home.x, yAt(s) - 0.15, home.z, age); }
    let label = null, burst = false, lastPuff = -1;
    return this._runFx({
      dur,
      step: (el) => {
        if (el < RUMBLE) {                                              // rumble on the pad
          const a = rm ? 0 : 0.06 * (el / RUMBLE);
          rg.visible = true;
          rg.position.set(home.x + (Math.random() - 0.5) * a, home.y, home.z + (Math.random() - 0.5) * a);
          R.flame.visible = el > RUMBLE * 0.7;
          R.flame.scale.set(0.6, 0.5 + Math.random() * 0.4, 0.6);
          if (Math.random() < 0.55) PF.spawn(home.x + (Math.random() - 0.5) * 0.9 * sc, home.y + 0.05, home.z + (Math.random() - 0.5) * 0.9 * sc,
            (Math.random() - 0.5) * 2.2, 0.35, (Math.random() - 0.5) * 2.2, { life: 1.8, size: 0.3 * sc, color: 0xeeeeee, grow: 1.6, drag: 1.8 });
        } else if (el < BURST) {                                        // slow, majestic climb
          const y = yAt(el), k = (el - RUMBLE) / ASC;
          rg.visible = true;
          rg.position.set(home.x + (rm ? 0 : Math.sin(el * 2.1) * 0.05), y, home.z);
          rg.rotation.z = rm ? 0 : Math.sin(el * 1.6) * 0.03;
          R.flame.visible = true;
          R.flame.scale.set(1 + Math.random() * 0.2, 1.1 + Math.random() * 0.7 + k * 0.4, 1 + Math.random() * 0.2);
          if (el - lastPuff > 0.05) {
            lastPuff = el;
            smoke(home.x, y - 0.15, home.z);
            if (Math.random() < 0.7) SP.spawn(home.x, y - 0.2, home.z, (Math.random() - 0.5) * 1.2, -3, (Math.random() - 0.5) * 1.2, { life: 0.5, size: 0.09, color: Math.random() < 0.5 ? 0xffb03a : 0xfff3a0 });
          }
        } else if (!burst) {                                            // burst at the top, rocket gone
          burst = true;
          if (el - BURST < 0.6) this._sparkBurst(V3(home.x, yAt(BURST), home.z), [0xffe38a, 0xff5a4e, 0xffffff], 60, 4.8, { life: 1.8, grav: 1.4, size: 0.16 });
          rg.visible = false;
          R.flame.visible = false;
          rg.rotation.z = 0;
        }
        if (el >= RISE) {                                               // a fresh rocket rises out of the pad
          const k = clamp((el - RISE) / (dur - RISE - 0.1), 0, 1);
          rg.visible = true;
          rg.position.set(home.x, home.y - 1.25 * sc * (1 - ease.outBack(k)), home.z);
        }
        if (!label && el >= RUMBLE) label = this._banner(anchor, 'isl-commit', this._commitInner(msg, hash));
        this._bannerFade(label, el, bannerEnd);
      },
      end: () => {
        R.busy = false;
        rg.visible = true;
        rg.position.copy(home);
        rg.rotation.z = 0;
        R.flame.visible = false;
        safe(() => label?.remove());
        disposeTree(g);
      },
    }, skip);
  },

  // Firework: a slow shell with a sparkling trail, a big burst, two crackles and a lingering gold willow.
  // opts: { height, palette, quiet (no banner), hash }
  _fxFirework(from, msg, opts = {}, skip = 0) {
    const rm = !!this.engine.settings?.reduceMotion;
    const height = opts.height ?? 8.5, quiet = opts.quiet || !msg;
    const pals = [[0xff4d6d, 0xffd23d, 0xffffff], [0x3da5ff, 0x9be22d, 0xffffff], [0xe24bd0, 0x39e5ff, 0xffe38a], [0xff8a1f, 0xfff3a0, 0xff5fa2]];
    const pal = opts.palette || pals[Math.floor(Math.random() * pals.length)];
    const RISE = rm ? 0.9 : (quiet ? 1.8 : 2.2), dur = quiet ? RISE + (rm ? 1.2 : 2.4) : RISE + (rm ? 3.0 : 9.0), bannerEnd = dur - 0.2;
    const g = new THREE.Group();
    g.name = 'fx:firework';
    const shell = new THREE.Mesh(P.ico(0.13, 0), shared().spark);
    shell.position.copy(from);
    const anchor = new THREE.Object3D();
    g.add(shell, anchor);
    this.group.add(g);
    if (this._occupyPad && this.padTop && from.distanceTo(this.padTop) < 0.5) this._occupyPad((this.engine.time ?? 0) - skip, RISE);
    const dx = (Math.random() - 0.5) * 1.2, dz = (Math.random() - 0.5) * 1.2;
    const apex = V3(from.x + dx, from.y + height, from.z + dz);
    anchor.position.copy(apex).add(V3(0, 1.0, 0));
    const SP = this._parts('spark');
    if (skip < 0.2) this._puff(from, 0xdedee6, 6, 0.15, { up: 1.5, size: 0.2 });
    const shots = rm ? [] : [[0.55, 0.9, 40, 3.4], [1.15, -0.8, 36, 3.0]];   // crackles: [delay, offset, count, speed]
    let fired = 0, burst = false, label = null, lastTrail = -1;
    return this._runFx({
      dur,
      step: (el) => {
        if (el < RISE) {
          const k = ease.outCubic(el / RISE);
          shell.visible = true;
          shell.position.set(from.x + dx * k, from.y + height * k, from.z + dz * k);
          if (el - lastTrail > 0.03) {
            lastTrail = el;
            SP.spawn(shell.position.x, shell.position.y - 0.1, shell.position.z, (Math.random() - 0.5) * 0.3, -0.5, (Math.random() - 0.5) * 0.3, { life: rm ? 0.5 : 1.0, size: 0.08, color: 0xffc070, grav: 0.8 });
          }
          return;
        }
        shell.visible = false;
        if (!burst) {
          burst = true;
          if (el - RISE < 0.6) {
            this._sparkBurst(apex, pal, rm ? 60 : 110, rm ? 5 : 6.5, { life: rm ? 1.3 : 2.2, grav: 1.6, size: 0.2 });
            this._puff(apex, 0xfff3c4, 4, 0.2, { up: 0.2, out: 0.5, size: 0.4, life: 0.6 });
            if (!rm) this._sparkBurst(apex, [0xffd27a, 0xfff1c4], 44, 1.8, { life: 3.4, grav: 0.35, size: 0.12 });   // gold willow
            safe(() => this.engine.fx?.confetti?.(this.group.localToWorld(apex.clone())));
          }
        }
        while (fired < shots.length && el >= RISE + shots[fired][0]) {
          const [dt0, off, n, v] = shots[fired++];
          if (el - (RISE + dt0) < 0.6) this._sparkBurst(apex.clone().add(V3(off, 0.4 - fired * 0.5, -off * 0.6)), [pal[(fired + 1) % 3], 0xffffff], n, v, { life: 1.6, grav: 1.8, size: 0.14 });
        }
        if (!quiet && !label) label = this._banner(anchor, 'isl-commit', this._commitInner(msg, opts.hash));
        this._bannerFade(label, el, bannerEnd);
      },
      end: () => { safe(() => label?.remove()); disposeTree(g); },
    }, skip);
  },

  // Compatibility wrapper (PortTown and older callers).
  _firework(from, msg, height = 7.5, palette = null) {
    return this._fxFirework(from, msg, { height, palette, quiet: !msg });
  },

  // PULL: 2-3 supply crates drift down under striped parachutes, land, sit a while, then unpack in a sparkle.
  _fxPull(e, annex, skip = 0) {
    if (this._disposed) return null;
    const rm = !!this.engine.settings?.reduceMotion;
    const n = 2 + (hashNum(String(e.hash || e.msg || Math.random())) % 2);
    const STAG = rm ? 0.3 : 0.8, DESC = rm ? 1.4 : 5.2, FOLD = rm ? 0.3 : 0.9, SIT = rm ? 0.8 : 3.0, POP = 0.5;
    const each = DESC + FOLD + SIT + POP, dur = (n - 1) * STAG + each + 0.1;
    const { crate, canopy } = crateProtos(), S = shared();
    const g = new THREE.Group();
    g.name = 'fx:pull';
    this.group.add(g);
    const crates = [];
    for (let i = 0; i < n; i++) {
      let p;
      if (annex) { const a = Math.random() * TAU, d = Math.random() * 1.2; p = V3(annex.x + Math.cos(a) * d, this.top, annex.z + Math.sin(a) * d); }
      else { const w = this.randomPoint(); p = V3(w.x - this.position.x, this.top, w.z - this.position.z); }
      const cg = new THREE.Group();
      const cm = new THREE.Mesh(crate, S.vc);
      cm.castShadow = true;
      const chute = new THREE.Group();
      const cn = new THREE.Mesh(canopy, S.vc);
      cn.castShadow = true;
      chute.add(cn);
      chute.position.y = 0.55;
      cg.add(cm, chute);
      cg.rotation.y = Math.random() * TAU;
      cg.visible = false;
      g.add(cg);
      crates.push({ g: cg, chute, p, t0: i * STAG, ph: Math.random() * TAU, landed: false, popped: false, y0: p.y + (rm ? 8 : 15) });
    }
    const C = annex ? V3(annex.x, this.top, annex.z) : V3(this.L.plaza.x, this.top, this.L.plaza.z);
    const anchor = new THREE.Object3D();
    anchor.position.set(C.x, C.y + (annex ? 3.2 : 4.4), C.z);
    g.add(anchor);
    const inner = `<span class="isl-kick">SUPPLY DROP</span>${esc(trunc(e.msg || 'fresh commits from upstream', 40))}`;
    let label = null;
    return this._runFx({
      dur,
      step: (el) => {
        for (const c of crates) {
          const k = el - c.t0;
          if (k < 0) { c.g.visible = false; continue; }
          c.g.visible = true;
          if (k < DESC) {
            const u = k / DESC;
            c.g.position.set(c.p.x, lerp(c.y0, c.p.y, 1 - Math.pow(1 - u, 1.35)), c.p.z);
            const sw = (1 - u) * (rm ? 0 : 0.16);
            c.g.rotation.z = Math.sin(k * 2.2 + c.ph) * sw;
            c.g.rotation.x = Math.cos(k * 1.7 + c.ph) * sw;
            c.chute.scale.set(1, 1, 1); c.chute.position.set(0, 0.55, 0); c.chute.visible = true;
            continue;
          }
          c.g.position.set(c.p.x, c.p.y, c.p.z);
          c.g.rotation.x = c.g.rotation.z = 0;
          if (!c.landed) { c.landed = true; if (k - DESC < 0.5) this._puff(V3(c.p.x, c.p.y + 0.05, c.p.z), 0xe8dcc0, 7, 0.35, { up: 0.6, out: 1.4, size: 0.22 }); }
          const f = clamp((k - DESC) / FOLD, 0, 1);
          c.chute.visible = f < 1;
          c.chute.scale.set(1 + f * 0.3, Math.max(0.05, 1 - f), 1 + f * 0.3);
          c.chute.position.set(f * 0.6, 0.55 - f * 0.5, 0);
          const q = k - (DESC + FOLD + SIT);
          if (q >= 0) {
            if (!c.popped) { c.popped = true; if (q < 0.4) this._sparkBurst(V3(c.p.x, c.p.y + 0.35, c.p.z), [0xffe38a, 0x9be22d, 0xffffff], 18, 2.2, { life: 0.9, grav: 3 }); }
            c.g.scale.setScalar(Math.max(0.001, 1 - ease.inCubic(clamp(q / POP, 0, 1))));
          } else c.g.scale.setScalar(1);
        }
        if (!label && el >= 0.3) label = this._banner(anchor, 'isl-pull', inner);
        this._bannerFade(label, el, dur - 0.1);
      },
      end: () => { safe(() => label?.remove()); disposeTree(g); },
    }, skip);
  },

  // CHECKOUT: the banner flag slowly lowers, swaps to the new branch at the bottom, and rises again.
  _fxCheckout(e, annex, skip = 0) {
    const to = String(e.to || e.branch || '').trim();
    if (!to) return null;
    if (annex) {
      annex.branch = to;
      safe(() => annex.label?.set(annexHtml(annex)));
      this._puff(V3(annex.x, this.top + 0.5, annex.z), 0xffffff, 6, 0.8);
      return null;
    }
    this._pendingBranch = null;
    if (!this.flag) { this.branch = to; this._setBranchVisuals(to); return null; }
    const cur = this._checkoutFx;
    if (cur && !cur.over) {                                           // already swapping: retarget, never fight over the flag
      cur.to = to;
      if (cur.swapped) { this.branch = to; this._setBranchVisuals(to); }
      return cur;
    }
    const rm = !!this.engine.settings?.reduceMotion;
    const DOWN = rm ? 0.6 : 2.4, PAUSE = rm ? 0.1 : 0.9, UP = rm ? 0.8 : 2.7, dur = DOWN + PAUSE + UP + (rm ? 0.1 : 0.6);
    const flag = this.flag, h = flag.holder, y1 = flag.y1, yLow = this.top + 0.75;
    this._swapping = true;
    const fx = {
      dur, to, swapped: false, over: false, sparkled: false,
      step: (el) => {
        if (this.flag !== flag) return;                                   // island rebuilt mid-swap
        if (el < DOWN) h.position.y = lerp(y1, yLow, ease.inOut(el / DOWN));
        else if (el < DOWN + PAUSE) {
          h.position.y = yLow + (rm ? 0 : Math.sin((el - DOWN) * 9) * 0.03);
        } else h.position.y = lerp(yLow, y1, ease.outBack(clamp((el - DOWN - PAUSE) / UP, 0, 1)));
        if (!fx.swapped && el >= DOWN) {
          fx.swapped = true;
          this.branch = fx.to;
          this._setBranchVisuals(fx.to);
          this._puff(V3(h.position.x, yLow, h.position.z), 0xffffff, 5, 0.3, { size: 0.16 });
        }
        if (!fx.sparkled && el >= DOWN + PAUSE + UP) {
          fx.sparkled = true;
          this._sparkBurst(V3(h.position.x + 0.5, y1 + 0.4, h.position.z), [0xffe38a, 0x39e5ff, 0xffffff], 16, 2, { life: 0.8, grav: 2 });
        }
      },
      end: () => {
        fx.over = true;
        if (!fx.swapped) { this.branch = fx.to; safe(() => this._setBranchVisuals(fx.to)); }
        if (this.flag === flag) h.position.y = y1;
        if (this._checkoutFx === fx) { this._checkoutFx = null; this._swapping = false; }
      },
    };
    this._checkoutFx = fx;
    return this._runFx(fx, skip);
  },
});

// ---- PortTown: "Port Localhost", the central harbour hub -----------------------------------------------

const LH_T = Math.PI + 0.35;            // lighthouse promontory angle (back-left for the default camera)
const CONTAINER_COLS = [0xe63946, 0xffc53d, 0x1fb5e8, 0x3ddc84, 0xff8a1f, 0x7a4dff, 0xe24bd0, 0x2ed3c5];

function townProfile(R, top) {
  const quayX = R * 0.8;
  const raw = (t) => R * 0.97 * (1 + 0.03 * Math.sin(3 * t + 1) + 0.02 * Math.sin(5 * t + 2));
  const prof = { R, top, over: 0.06, quayX };
  prof.shore = (t) => {
    let r = raw(t);
    const c = Math.cos(t);
    if (c > 0.05) r = Math.min(r, quayX / c + 0.12);
    const d = angDiff(t, LH_T);
    return r + 1.3 * Math.exp(-(d * d) / 0.045);
  };
  prof.beachW = (t) => lerp(0.55, 0.12, smooth(0.5, 0.78, Math.cos(t)));
  prof.ledge = () => 0.05;
  prof.strata = (t) => 0.5 + 0.05 * Math.sin(3 * t);
  prof.cliffBase = (t) => prof.shore(t) - prof.beachW(t);
  prof.cap = (t) => prof.cliffBase(t) - 0.1 - prof.ledge(t) - 0.08 + prof.over;
  prof.plateau = (t) => prof.cap(t) - 0.28;
  let pmin = Infinity, pmax = 0;
  for (let i = 0; i < 128; i++) { const v = prof.plateau(i / 128 * TAU); pmin = Math.min(pmin, v); pmax = Math.max(pmax, v); }
  prof.pmin = pmin; prof.pmax = pmax;
  return prof;
}

export class PortTown {
  // new PortTown(world, { position, radius }) — also accepts (world, data, { position, radius }).
  constructor(world, a = {}, b = {}) {
    const opts = a && (a.position || a.radius != null) ? a : (b || {});
    this.world = world || {};
    this.engine = this.world.engine || {};
    this.id = 'port-localhost';
    this.data = { id: this.id, name: 'Port Localhost', kind: 'town', tier: 0, annexes: [] };
    this.kind = 'town';
    const r = Number(opts.radius) || 7;
    this.footprint = r;
    this.radius = r > 9 ? clamp(r * 0.64, 6, 7.5) : Math.max(6, r);
    this.position = new THREE.Vector3().copy(opts.position || V3());
    this.top = 1.1;
    this.group = new THREE.Group();
    this.group.name = 'port-localhost';
    this.group.position.copy(this.position);
    this.group.userData.town = this;
    this.phase = 0.7;
    this.outAngle = Math.PI;
    this.docks = new Map();
    this.annexes = new Map();
    this.platforms = [];
    this.berths = [null, null];
    this.fx = {};
    this.anim = [];
    this.born = this.engine.time ?? 0;
    this.craneManual = false;
    this.lightPort = null;
    this.beamAngle = 0;
    this._disposed = false;
    ensureCss(this.engine);
    this._build();
    this._makeLabels();
  }

  get _young() { return (this.engine.time ?? 0) - this.born < 2.5; }
  get shoreRadius() { return meanShore(this.prof); }

  _build() {
    const R = this.radius, top = this.top;
    const prof = this.prof = townProfile(R, top);
    const qx = prof.quayX;
    const b = new GeoBuilder(4242), bw = new GeoBuilder(4243), bl = new GeoBuilder(4244);
    const n = noise2('port-localhost');
    const lhx = Math.cos(LH_T) * (prof.plateau(LH_T) - 1.0), lhz = Math.sin(LH_T) * (prof.plateau(LH_T) - 1.0);
    this.lh = { x: lhx, z: lhz };
    const pal = {
      capSide: 0xc9c4d6, s1: 0x7f7c94, s2: 0xaaa6bd, ledge: 0x9894ab, sand: PAL.sand, wet: PAL.sandDark,
      topFn: (x, z) => {
        const v = n(x, z);
        if (x > qx - 3.9) return mix(0x9aa0b3, 0x8a90a3, 0.5 + 0.4 * v);                       // terminal asphalt
        if (Math.hypot(x - lhx, z - lhz) < 1.9) return v > 0 ? PAL.grass : PAL.grassDark;      // lighthouse knoll
        const d = Math.hypot(x, z);
        if (d < 2.5) return mix(0xe3d6bb, 0xd2c3a3, 0.5 + 0.5 * v);                          // plaza cobbles
        return v > 0.25 ? PAL.grass : mix(0xd9ccb2, 0xcbbd9f, 0.5 + 0.5 * v);                  // paving & lawns
      },
    };
    buildTerrain(b, prof, pal, 'port-localhost', { N: 60 });
    this.occ = [];
    const take = (x, z, r, tag) => this.occ.push({ x, z, r, tag });

    // --- container terminal: stacks, rails, lane marks, bollards
    const stackX = [qx - 3.7, qx - 3.05];
    const rr = rng('port-stacks');
    for (const sx of stackX) for (let z = -3.1; z <= 3.1; z += 1.4) {
      const h = 1 + Math.floor(rr() * 3);
      for (let k = 0; k < h; k++) {
        const c = CONTAINER_COLS[Math.floor(rr() * CONTAINER_COLS.length)];
        b.box(0.55, 0.52, 1.25, c, { x: sx, y: top + k * 0.53, z }, 0.04);
        b.box(0.57, 0.04, 1.27, tint(c, -0.25), { x: sx, y: top + k * 0.53 + 0.5, z });
      }
    }
    take(qx - 3.4, 0, 1.0, 'stacks'); take(qx - 3.4, 2.4, 1.0, 'stacks'); take(qx - 3.4, -2.4, 1.0, 'stacks');
    this.stackTop = top + 3 * 0.53;
    const railX = [qx - 1.55, qx - 0.35];
    for (const x of railX) b.box(0.08, 0.04, 9.2, PAL.metalDark, { x, y: top, z: 0 });
    for (let z = -4; z <= 4; z += 0.8) b.box(0.07, 0.012, 0.4, PAL.hazard, { x: qx - 2.2, y: top, z });
    for (let z = -3.9; z <= 3.9; z += 1.3) {
      b.cyl(0.08, 0.1, 0.22, 6, PAL.metalDark, { x: qx - 0.1, y: top, z });
      b.cyl(0.11, 0.11, 0.05, 6, PAL.metalDark, { x: qx - 0.1, y: top + 0.22, z });
    }
    b.box(0.12, 0.05, 8.6, PAL.hazard, { x: qx - 0.02, y: top, z: 0 });

    // --- lighthouse on its knoll
    this._buildLighthouse(b, bw, bl);
    take(lhx, lhz, 1.3, 'lighthouse');

    // --- harbourmaster hut (faces the plaza)
    const ha = Math.PI * 0.62, hd = 3.7, hx = Math.cos(ha) * hd, hz = Math.sin(ha) * hd, hry = Math.atan2(-hx, -hz);
    this.hut = { x: hx, z: hz, ry: hry };
    for (const B of [b, bw, bl]) B.push({ x: hx, y: top, z: hz, ry: hry });
    b.box(1.8, 0.12, 1.5, 0x9c97aa, {}, 0.02);
    b.box(1.6, 1.1, 1.3, 0xe8f1ff, { y: 0.12 }, 0.03);
    b.box(1.75, 0.12, 1.45, 0x2b5f9e, { y: 1.22 });
    b.box(0.9, 0.62, 0.8, 0xe8f1ff, { x: -0.25, y: 1.34 }, 0.03);
    b.box(1.05, 0.1, 0.95, 0x2b5f9e, { x: -0.25, y: 1.96 });
    bw.box(0.92, 0.3, 0.82, 0x9fd3ff, { x: -0.25, y: 1.5 });
    b.box(0.36, 0.66, 0.05, 0x2b5f9e, { x: 0.35, y: 0.12, z: 0.66 });
    for (const sx of [-0.45]) bw.box(0.36, 0.34, 0.04, 0x9fd3ff, { x: sx, y: 0.5, z: 0.66 });
    bw.box(0.04, 0.34, 0.4, 0x9fd3ff, { x: 0.81, y: 0.5 });
    b.cyl(0.03, 0.035, 1.6, 5, PAL.metal, { x: 0.55, y: 1.28, z: -0.4 });
    b.tri([0.55, 2.85, -0.4], [0.55, 2.55, -0.4], [1.15, 2.7, -0.4], 0x39e5ff, [0, 0, 1]);
    b.tri([0.55, 2.85, -0.4], [0.55, 2.55, -0.4], [1.15, 2.7, -0.4], 0x1fb5e8, [0, 0, -1]);
    bl.box(0.1, 0.12, 0.1, 0xfff0c0, { x: 0.35, y: 0.95, z: 0.72 });
    for (const B of [b, bw, bl]) B.pop();
    const hs = signBoard('HARBORMASTER', 1.3, 0.26, { bg: '#1d2748', fg: '#ffe38a', border: '#ffc53d' });
    const [hsx, hsz] = frameXZ(hx, hz, hry, 0.0, 0.72);
    hs.position.set(hsx, top + 1.02, hsz);
    hs.rotation.y = hry;
    this.group.add(hs);
    take(hx, hz, 1.2, 'hut');

    // --- plaza: anchor monument + "PORT LOCALHOST" arch facing the default camera
    b.cyl(0.55, 0.62, 0.25, 8, 0xb9b2c6, { y: top }, 0.03);
    b.at({ y: top + 0.25, ry: SIGN_YAW }, () => {
      const ink = 0x3a4458;
      b.cyl(0.07, 0.07, 1.25, 6, ink, { y: 0.15 });
      b.tor(0.14, 0.04, 4, 10, ink, { y: 1.5 });
      b.box(0.7, 0.08, 0.08, ink, { y: 1.18 });
      b.tor(0.42, 0.055, 4, 12, ink, { y: 0.52, rz: Math.PI }, Math.PI);
      b.cone(0.1, 0.2, 4, ink, { x: 0.44, y: 0.44, rz: -0.6 });
      b.cone(0.1, 0.2, 4, ink, { x: -0.44, y: 0.44, rz: 0.6 });
    });
    take(0, 0, 0.8, 'anchor');
    const aa = Math.PI / 4, ad = 2.35, ax = Math.cos(aa) * ad, az = Math.sin(aa) * ad;
    const px = Math.cos(aa + Math.PI / 2) * 1.35, pz = Math.sin(aa + Math.PI / 2) * 1.35;
    for (const s of [-1, 1]) {
      b.cyl(0.09, 0.11, 2.2, 6, PAL.woodDark, { x: ax + px * s, y: top, z: az + pz * s });
      b.cone(0.13, 0.2, 6, PAL.hazard, { x: ax + px * s, y: top + 2.2, z: az + pz * s });
    }
    const arch = signBoard('PORT LOCALHOST', 2.5, 0.5, { bg: '#1d2748', fg: '#ffe38a', border: '#ffc53d' });
    arch.position.set(ax, top + 1.85, az);
    arch.rotation.y = SIGN_YAW;
    this.group.add(arch);

    // --- lamps, barrels, crates, trees
    const lamps = [[-2.6, 1.4], [-1.2, -2.8], [1.2, 2.9], [qx - 2.2, -4.2], [qx - 2.2, 4.2], [-4.3, -0.6]];
    for (const [x, z] of lamps) { featLamp({ b, bl, top }, x, z); take(x, z, 0.25, 'lamp'); }
    const deco = rng('port-deco');
    for (let i = 0; i < 6; i++) {
      const a = Math.PI * (0.35 + deco() * 1.3), d = 3.0 + deco() * 1.8, x = Math.cos(a) * d, z = Math.sin(a) * d;
      if (this.occ.some((o) => Math.hypot(o.x - x, o.z - z) < o.r + 0.5)) continue;
      if (i % 2) { for (let k = 0; k < 3; k++) b.cyl(0.17, 0.19, 0.42, 7, 0x8a5a36, { x: x + (k % 2) * 0.36, y: top, z: z + (k > 1 ? 0.34 : 0) }, 0.05); }
      else { b.box(0.45, 0.45, 0.45, PAL.wood, { x, y: top, z, ry: deco() }, 0.05); b.box(0.35, 0.35, 0.35, tint(PAL.wood, -0.08), { x: x + 0.05, y: top + 0.45, z, ry: deco() }, 0.05); }
      take(x, z, 0.5, 'deco');
    }
    const PR = protos();
    for (const [a, d, k] of [[Math.PI * 0.85, 4.6, 'lolly'], [Math.PI * 1.45, 4.4, 'cloud'], [Math.PI * 0.5, 4.9, 'lolly'], [Math.PI * 1.2, 2.9, 'conifer']]) {
      const x = Math.cos(a) * d, z = Math.sin(a) * d;
      if (this.occ.some((o) => Math.hypot(o.x - x, o.z - z) < o.r + 0.5)) continue;
      b.add(PR[k], 0xffffff, { x, y: top, z, ry: a * 3, s: 0.95 });
      take(x, z, 0.5, 'tree');
    }

    const S = shared();
    const add = (m, name) => { if (m) { m.name = name; this.group.add(freeze(m)); } };   // merged statics: never move
    add(b.mesh(S.vc), 'static');
    add(bw.mesh(S.windows, { cast: false }), 'windows');
    add(bl.mesh(S.lamps, { cast: false }), 'lamps');
    if (!this.engine.addFoamRing) this._foam(this.group, prof, 0.3);
    this._buildCrane();
    this._buildGulls();
    this.stations = {
      crystals: [], crystalClusters: [],
      archive: this._w(...frameXZ(hx, hz, hry, 0.35, 1.2)),
      archiveCenter: this._w(hx, hz),
      shore: [0.55, 0.8, 1.2, 1.4].map((f) => { const t = Math.PI * f; const d = prof.plateau(t) - 0.35; return this._w(Math.cos(t) * d, Math.sin(t) * d); }),
      gitTree: this._w(Math.cos(SIGN_YAW) * 1.2, Math.sin(SIGN_YAW) * 1.2),
      gitTreeCenter: this._w(0, 0),
      launchPad: this._w(-1.6, 0.6),
      flag: this._w(0, 0),
    };
    this.obstacles = this.occ.filter((o) => o.tag !== 'lamp').map((o) => ({ x: o.x + this.position.x, z: o.z + this.position.z, r: o.r, tag: o.tag }));
  }

  _buildLighthouse(b, bw, bl) {
    const top = this.top, { x, z } = this.lh;
    const r = rng('lighthouse');
    for (let i = 0; i < 5; i++) {
      const a = i / 5 * TAU + r(), d = 0.9 + r() * 0.3;
      b.ico(0.45 + r() * 0.25, 0, i % 2 ? PAL.rock : PAL.rockDark, { x: x + Math.cos(a) * d, y: top + 0.05, z: z + Math.sin(a) * d, s: [1.2, 0.6, 1.1], ry: r() * 3 }, 0.1);
    }
    b.cyl(0.95, 1.05, 0.35, 10, 0xb9b2c6, { x, y: top, z }, 0.03);
    const segs = 5, segH = 1.05;
    for (let i = 0; i < segs; i++) {
      const r0 = 0.78 - i * 0.065, r1 = r0 - 0.065;
      b.cyl(r1, r0, segH, 10, i % 2 ? 0xe63946 : 0xf4f4f8, { x, y: top + 0.35 + i * segH, z }, 0.02);
    }
    const gy = top + 0.35 + segs * segH;
    this.lh.y = gy;
    b.cyl(0.72, 0.62, 0.14, 10, PAL.metalDark, { x, y: gy, z });
    b.tor(0.68, 0.025, 3, 16, PAL.metalDark, { x, y: gy + 0.42, z, rx: Math.PI / 2 });
    for (let i = 0; i < 10; i++) { const a = i / 10 * TAU; b.cyl(0.02, 0.02, 0.42, 3, PAL.metalDark, { x: x + Math.cos(a) * 0.68, y: gy + 0.12, z: z + Math.sin(a) * 0.68 }); }
    b.cyl(0.48, 0.48, 0.08, 10, PAL.metalDark, { x, y: gy + 0.14, z });
    b.cone(0.58, 0.55, 10, 0xe63946, { x, y: gy + 0.85, z });
    b.ico(0.1, 0, PAL.hazard, { x, y: gy + 1.45, z });
    b.box(0.42, 0.7, 0.1, 0x3a4458, { x: x + Math.cos(SIGN_YAW) * 0.78, y: top + 0.35, z: z + Math.sin(SIGN_YAW) * 0.78, ry: SIGN_YAW });
    for (let i = 1; i < segs; i += 2) bw.box(0.14, 0.24, 0.14, 0x9fd3ff, { x: x + Math.cos(SIGN_YAW) * (0.74 - i * 0.065), y: top + 0.65 + i * segH, z: z + Math.sin(SIGN_YAW) * (0.74 - i * 0.065), ry: SIGN_YAW });
    // lantern (own material so it can blaze at night) + beams + glow
    this.lanternMat = new THREE.MeshLambertMaterial({ color: 0xfff6d0, emissive: new THREE.Color(0xffe38a), emissiveIntensity: 0.8, flatShading: true });
    const lantern = new THREE.Mesh(P.cyl(0.4, 0.4, 0.62, 10), this.lanternMat);
    lantern.position.set(x, gy + 0.22, z);
    this.group.add(lantern);
    const beams = new THREE.Group();
    beams.position.set(x, gy + 0.53, z);
    const bg = new THREE.ConeGeometry(1.7, 14, 12, 6, true);
    bg.translate(0, -7, 0);
    {
      // brightness falls off along the beam (additive blending: dark vertices fade out)
      const p = bg.attributes.position, cols = new Float32Array(p.count * 3);
      for (let i = 0; i < p.count; i++) { const k = Math.pow(1 - clamp(-p.getY(i) / 14, 0, 1), 1.6); cols[i * 3] = cols[i * 3 + 1] = cols[i * 3 + 2] = k; }
      bg.setAttribute('color', new THREE.BufferAttribute(cols, 3));
    }
    bg.rotateZ(Math.PI / 2 - 0.07);
    for (const ry of [0, Math.PI]) {
      const m = new THREE.Mesh(bg, shared().beam);
      m.rotation.y = ry;
      m.renderOrder = 6;
      m.castShadow = false;
      beams.add(m);
    }
    this.group.add(beams);
    this.beams = beams;
    this.lhGlow = glowSprite(0xffe9a0, 3.2, 0.3);
    this.lhGlow.position.set(x, gy + 0.53, z);
    this.group.add(this.lhGlow);
    // Pick target: world.js registers town.lighthouse as the dashboard's own port (the tower itself is merged into
    // the town mesh, so an invisible proxy covers it). The label anchor sits under it so the label lights up too.
    const lh = new THREE.Group();
    lh.name = 'lighthouse';
    lh.position.set(x, top, z);
    const hit = new THREE.Mesh(P.cyl(1, 1, 1, 8), new THREE.MeshBasicMaterial());
    hit.scale.set(0.95, gy + 1.6 - top, 0.95);
    hit.visible = false;
    hit.userData.pickProxy = true;
    lh.add(hit);
    this.group.add(lh);
    this.lighthouse = lh;
    this.lhAnchor = new THREE.Object3D();
    this.lhAnchor.position.set(0, gy + 1.9 - top, 0);
    lh.add(this.lhAnchor);
  }

  _buildCrane() {
    const top = this.top, qx = this.prof.quayX;
    const railX = [qx - 1.55, qx - 0.35];
    const H = 3.6, boomY = H + 0.25, x0 = qx - 4.2, x1 = qx + 2.9;
    const gb = new GeoBuilder(505);
    const yel = 0xffc53d, dark = PAL.metalDark;
    for (const lx of railX) for (const lz of [-0.55, 0.55]) {
      gb.box(0.16, H, 0.16, yel, { x: lx, y: 0.12, z: lz }, 0.03);
      gb.box(0.3, 0.14, 0.36, dark, { x: lx, y: 0, z: lz });
    }
    for (const lz of [-0.55, 0.55]) {
      gb.box(railX[1] - railX[0] + 0.16, 0.14, 0.14, yel, { x: (railX[0] + railX[1]) / 2, y: 1.4, z: lz });
      gb.beam([railX[0], 0.3, lz], [railX[1], 1.35, lz], 0.07, 0.07, yel);
    }
    gb.box(x1 - x0, 0.26, 0.22, yel, { x: (x0 + x1) / 2, y: boomY, z: -0.45 }, 0.02);
    gb.box(x1 - x0, 0.26, 0.22, yel, { x: (x0 + x1) / 2, y: boomY, z: 0.45 }, 0.02);
    for (let x = x0 + 0.3; x < x1; x += 0.9) gb.box(0.08, 0.08, 0.9, dark, { x, y: boomY + 0.1, z: 0 });
    gb.box(1.1, 0.7, 1.2, 0xe8edf5, { x: x0 + 0.7, y: boomY + 0.26 }, 0.03);
    gb.box(0.9, 0.5, 1.3, 0x5a6478, { x: x0 + 0.7, y: boomY - 0.5 });
    gb.box(0.6, 0.35, 0.02, 0x9fd3ff, { x: x0 + 0.7, y: boomY + 0.45, z: 0.61 });
    for (const lx of railX) gb.beam([lx, H + 0.1, 0], [(x0 + x1) / 2, H + 1.3, 0], 0.07, 0.07, yel);
    gb.box(0.2, 0.2, 0.2, PAL.danger, { x: x1 - 0.1, y: boomY + 0.26 });
    const crane = new THREE.Group();
    crane.add(gb.mesh(shared().vc));
    crane.position.set(0, top, 0);
    const tb = new GeoBuilder(506);
    tb.box(0.7, 0.3, 1.1, 0x5a6478, { y: 0 }, 0.03);
    tb.box(0.2, 0.12, 0.2, PAL.danger, { y: 0.3 });
    const trolley = new THREE.Group();
    trolley.add(tb.mesh(shared().vc));
    trolley.position.set(qx + 1.2, boomY - 0.3, 0);
    crane.add(trolley);
    const cable = new THREE.Mesh(P.box(1, 1, 1), mat(0x2b2f3a));
    cable.scale.set(0.04, 1, 0.04);
    trolley.add(cable);
    const sb = new GeoBuilder(507);
    sb.box(0.7, 0.1, 1.35, yel, {}, 0.03);
    for (const sx of [-0.3, 0.3]) for (const sz of [-0.6, 0.6]) sb.box(0.06, 0.12, 0.06, dark, { x: sx, y: -0.1, z: sz });
    const spreader = new THREE.Group();
    spreader.add(sb.mesh(shared().vc));
    const cargo = new THREE.Mesh(P.box(0.55, 0.52, 1.25), mat(CONTAINER_COLS[0]));
    cargo.position.y = -0.62;
    cargo.castShadow = true;
    cargo.visible = false;
    spreader.add(cargo);
    trolley.add(spreader);
    this.group.add(crane);
    this.crane = { group: crane, trolley, cable, spreader, cargo, boomY, x0, x1, z: 0, tx: qx + 1.2, drop: 1.0, cyc: 0, dir: 1, busy: false, carry: false, colorI: 0 };
    this._craneSet(qx + 1.2, 1.0);
  }

  // Trolley at local x, spreader `drop` metres under the boom.
  _craneSet(x, drop) {
    const C = this.crane;
    C.trolley.position.x = x;
    C.spreader.position.y = -drop - 0.1;
    C.cable.position.y = -drop - 0.05;
    C.cable.scale.y = Math.max(0.05, drop);
  }

  _buildGulls() {
    const gb = new GeoBuilder(808);
    gb.ico(0.09, 0, 0xffffff, { s: [1, 0.8, 1.6] });
    gb.cone(0.04, 0.1, 4, PAL.hazard, { z: 0.16, rx: Math.PI / 2 });
    const bodyGeo = gb.build();
    const wb = new GeoBuilder(809);
    wb.tri([0, 0, -0.05], [0, 0, 0.07], [0.32, 0.02, -0.02], 0xf4f4f8, [0, 1, 0]);
    wb.tri([0, 0, -0.05], [0, 0, 0.07], [0.32, 0.02, -0.02], 0xd8dce6, [0, -1, 0]);
    const wingGeo = wb.build();
    const S = shared();
    this.gulls = [];
    for (let i = 0; i < 2; i++) {
      const g = new THREE.Group();
      g.add(new THREE.Mesh(bodyGeo, S.vc));
      const wl = new THREE.Mesh(wingGeo, S.vc), wr = new THREE.Mesh(wingGeo, S.vc);
      wr.scale.x = -1;
      g.add(wl, wr);
      this.group.add(g);
      this.gulls.push({ g, wl, wr, r: 2.2 + i * 0.9, h: this.lh.y + 1.2 + i * 0.5, sp: 0.45 + i * 0.12, ph: i * 2.1 });
    }
  }

  _makeLabels() {
    this.labelAnchor = new THREE.Object3D();
    this.labelAnchor.position.set(0, this.top + 5.5, 0);   // off the container terminal; stacks above the lighthouse tag
    this.group.add(this.labelAnchor);
    this.label = addLabel(this.engine, this.labelAnchor, V3(0, 0, 0),
      '<div class="isl-tag isl-town"><div class="isl-name">Port Localhost</div><div class="isl-meta"><span class="isl-title">Harbor</span><span class="isl-dot">·</span><span class="isl-branch">127.0.0.1</span></div></div>', 'isl-label', 'island', { group: 'town', role: 'head' });
    this.lhLabel = addLabel(this.engine, this.lhAnchor, V3(0, 0, 0), this._lhHtml(), 'isl-label', 'island', { group: 'town', role: 'member' });
  }

  _lhHtml() {
    const p = this.lightPort;
    return `<div class="isl-tag isl-light"><div class="isl-name">Command &amp; Context${p ? ' :' + esc(p) : ''}</div></div>`;
  }

  // The dashboard's own port: `port` may be a Port object ({ port, conns }) or a number.
  setLighthouse(port) {
    const num = typeof port === 'object' && port ? port.port ?? port.id : port;
    this.lightConns = typeof port === 'object' && port ? (port.conns || 0) : 0;
    if (num != null && String(num) !== String(this.lightPort)) {
      this.lightPort = String(num);
      safe(() => this.lhLabel?.set(this._lhHtml()));
    }
  }

  setCraneBusy(b) { this.craneManual = !!b; }

  // ---- docks: terminal berths along the quay first (container ships), then radial piers ----
  allocDock(id, opts = {}) {
    id = String(id);
    if (this.docks.has(id)) return this.docks.get(id);
    const container = !!opts?.container;
    let spec = container ? this._berthSpec() : null;
    if (!spec) {
      const start = container ? 1.05 : Math.PI * 0.7;
      spec = this._dockSpec(container, start, (t, hw) => Math.abs(angDiff(t, 0)) < 0.8 + hw || Math.abs(angDiff(t, LH_T)) < 0.42 + hw);
    }
    const dock = new Dock(this, id, spec);
    if (spec.kind === 'berth') {
      this.berths[spec.bi] = id;
      dock.bi = spec.bi;
      const sz = spec.berth[1] - 1.4 * Math.sign(spec.berth[1]);
      dock.signAnchor.position.set(this.prof.quayX - 0.45, this.top + 0.75, sz);
      const b = new GeoBuilder(33);
      b.cyl(0.04, 0.05, 0.75, 5, PAL.metalDark, { x: this.prof.quayX - 0.45, y: this.top, z: sz });
      dock.signW = 1.7;
      b.box(1.7, 0.38, 0.07, PAL.woodDark, { x: this.prof.quayX - 0.45, y: this.top + 0.56, z: sz, ry: SIGN_YAW });
      const m = b.mesh(shared().vc);
      if (m) dock.group.add(m);
    } else buildPier(dock, spec);
    dock.setSign(defaultSign(id));
    if (!this._young && spec.kind !== 'berth') {
      dock.group.position.y = -1.4;
      tween(dock.group.position, { y: 0 }, 0.7, ease.outBack);
    }
    this.docks.set(id, dock);
    return dock;
  }

  releaseDock(id) {
    id = String(id);
    const dock = this.docks.get(id);
    if (!dock) return;
    if (dock.bi != null) this.berths[dock.bi] = null;
    Island.prototype.releaseDock.call(this, id);
  }

  _berthSpec() {
    const bi = this.berths.findIndex((x) => x == null);
    if (bi < 0) return null;
    const qx = this.prof.quayX, sg = bi === 0 ? 1 : -1, z = 1.8 * sg;
    return {
      kind: 'berth', bi, t: 0, ring: -1, container: true, halfW: 2.3,
      root: [qx - 0.05, z - 1.6 * sg], end: [qx - 0.05, z + 1.6 * sg], rootY: this.top, berth: [qx + 1.3, z],
      dir: new THREE.Vector3(0, 0, sg), facing: Math.atan2(0, sg), pierHalfWidth: 0.05,
    };
  }

  randomPoint(rnd = Math.random) {
    for (let k = 0; k < 40; k++) {
      const t = rnd() * TAU, d = Math.sqrt(rnd()) * (this.prof.plateau(t) - 0.5);
      const x = Math.cos(t) * d, z = Math.sin(t) * d;
      if (this.occ.some((o) => Math.hypot(o.x - x, o.z - z) < o.r + 0.3)) continue;
      return this._w(x, z);
    }
    return this.stations.gitTree.clone();
  }

  walkable(p) {
    if (!p) return false;
    const x = p.x - this.position.x, z = p.z - this.position.z;
    return Math.hypot(x, z) <= this.prof.plateau(Math.atan2(z, x)) - 0.05;
  }

  allocLot() { return null; }
  releaseLot() {}
  update() {}

  launch(type, ev) {
    if (this._disposed) return;
    try {
      const e = typeof ev === 'string' ? { msg: ev } : (ev || {});
      if (type === 'commit') Island.prototype._firework.call(this, V3(-1.6, this.top + 0.3, 0.6), trunc(e.msg || 'commit', 46), 7);
    } catch (err) { console.warn('[islands] town launch', err); }
  }

  tick(dt, t) {
    if (this._disposed) return;
    const day = this.engine.daylight ?? 1, night = 1 - day;
    updateShared(t, day);
    const conns = this.lightConns > 0 ? 1 : 0;
    shared().beam.opacity = (0.05 + 0.4 * night) * (1 + 0.5 * conns);
    this.beamAngle += dt * (0.35 + 0.35 * night);
    if (this.beams) this.beams.rotation.y = this.beamAngle;
    if (this.lanternMat) this.lanternMat.emissiveIntensity = 0.7 + 1.6 * night + 0.3 * conns * (0.5 + 0.5 * Math.sin(t * 6));
    if (this.lhGlow) this.lhGlow.material.opacity = 0.12 + 0.55 * night + 0.1 * conns;
    for (const f of this.anim) f(dt, t, day);
    this._tickCrane(dt, t);
    for (const g of this.gulls || []) {
      const a = t * g.sp + g.ph;
      g.g.position.set(this.lh.x + Math.cos(a) * g.r, g.h + Math.sin(t * 0.7 + g.ph) * 0.3, this.lh.z + Math.sin(a) * g.r);
      g.g.rotation.set(0, Math.atan2(-Math.sin(a), Math.cos(a)), -0.25);
      const flap = Math.sin(t * 7 + g.ph) * 0.5;
      g.wl.rotation.z = flap; g.wr.rotation.z = -flap;
    }
    this._tickFx(dt, t);
    this.fx.puffs?.tick(dt);
    this.fx.sparks?.tick(dt);
  }

  _craneWanted() {
    if (this.craneManual) return this.berths.findIndex((x) => x != null) >= 0 ? this.berths.findIndex((x) => x != null) : 0;
    const ports = this.world.snapshot?.ports;
    for (let i = 0; i < this.berths.length; i++) {
      const id = this.berths[i];
      if (id == null) continue;
      let act = 0;
      if (Array.isArray(ports)) { const p = ports.find((q) => String(q.id) === id); act = p?.activity ?? 0; }
      const v = this.world.vessels?.get?.(id);
      act = Math.max(act, v?.port?.activity ?? v?.data?.activity ?? 0);
      if (act > 0.15) return i;
    }
    return -1;
  }

  _tickCrane(dt, t) {
    const C = this.crane;
    if (!C) return;
    const qx = this.prof.quayX;
    const want = this._craneWanted();
    const busy = want >= 0;
    const tz = busy ? (want === 0 ? 2.5 : -2.5) : 0;
    C.z = dampTo(C.z, tz, 0.9, dt);
    C.group.position.z = C.z;
    const ship = qx + 1.35, stack = qx - 3.35;
    if (!busy && C.cyc === 0) {
      C.tx = dampTo(C.tx, qx + 0.6, 1.2, dt);
      C.drop = dampTo(C.drop, 0.8, 1.5, dt);
      this._craneSet(C.tx, C.drop);
      return;
    }
    C.cyc += dt;
    const k = C.cyc, P = 9;
    const from = C.dir > 0 ? ship : stack, to = C.dir > 0 ? stack : ship;
    const deepFrom = C.dir > 0 ? C.boomY - 1.2 : C.boomY - 1.9, deepTo = C.dir > 0 ? C.boomY - 1.9 : C.boomY - 1.2;
    let x = from, drop = 0.8;
    if (k < 1.4) { x = lerp(C.tx, from, ease.inOut(k / 1.4)); drop = 0.8; }
    else if (k < 2.6) { x = from; drop = lerp(0.8, deepFrom, ease.inOut((k - 1.4) / 1.2)); }
    else if (k < 3.8) { x = from; drop = lerp(deepFrom, 0.8, ease.inOut((k - 2.6) / 1.2)); if (!C.carry) { C.carry = true; C.cargo.visible = true; C.cargo.material = mat(CONTAINER_COLS[C.colorI++ % CONTAINER_COLS.length]); } }
    else if (k < 5.6) { x = lerp(from, to, ease.inOut((k - 3.8) / 1.8)); drop = 0.8; }
    else if (k < 6.8) { x = to; drop = lerp(0.8, deepTo, ease.inOut((k - 5.6) / 1.2)); }
    else if (k < 8.0) { x = to; drop = lerp(deepTo, 0.8, ease.inOut((k - 6.8) / 1.2)); if (C.carry) { C.carry = false; C.cargo.visible = false; } }
    else { x = to; drop = 0.8; }
    if (k < 1.4) { /* travelling to the pick-up side */ } else C.tx = x;
    this._craneSet(x, drop);
    if (k >= P) { C.cyc = 0; C.tx = to; C.dir = -C.dir; if (!busy) { C.carry = false; C.cargo.visible = false; } }
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    for (const f of this._fxList || []) safe(() => f.end());
    this._fxList = [];
    safe(() => this.label?.remove());
    safe(() => this.lhLabel?.remove());
    this.group.traverse((o) => { if (o.isInstancedMesh) o.dispose(); });
    disposeTree(this.group);
    this.docks.clear();
  }
}

for (const k of ['_angleFree', '_dockSpec', '_pierSpec', '_parts', '_puff', '_sparkBurst', '_foam', '_w']) PortTown.prototype[k] = Island.prototype[k];

// ---- push (supply airship) & merge (branch fusion) launches -------------------------------------------------
// Both run on the island's own effect runner (ticked by Island.tick) rather than promise chains, so they can start
// part-way through (screenshots: ?launchtest=push:3) and are cleaned up if the island is disposed mid-flight.

// ?launchtest=push|maiden|merge|commit|pull|checkout|pr[:seconds[:hold]] fires a test launch on every island shortly after
// it is built (then every 11 s). The optional seconds start the first one part-way through; ':hold' also freezes it
// there, so a headless screenshot (few, slow frames) captures that exact moment.
const LAUNCH_TEST = (() => {
  try {
    const v = new URLSearchParams(globalThis.location?.search || '').get('launchtest');
    if (!v) return null;
    const [type, skip, hold] = v.split(':');
    return { type: type.toLowerCase(), skip: Math.max(0, Number(skip) || 0), hold: hold === 'hold' };
  } catch { return null; }
})();

const lerpAngle = (a, b, t) => a + angDiff(b, a) * t;

let AIRSHIP = null;
function airshipProto() {
  if (AIRSHIP) return AIRSHIP;
  const mk = (seed, fn) => { const b = new GeoBuilder(seed); fn(b); const g = b.build(); g.userData.shared = true; return g; };
  const hull = 0xf6f1e4, red = 0xe63946, navy = 0x1d2748, brass = 0xffc53d, strut = 0x3a4458;
  AIRSHIP = {
    body: mk(91, (b) => {
      b.sph(1, 14, 9, hull, { s: [0.95, 0.85, 2.1] });
      for (const z of [-1.25, 0, 1.25]) {
        const k = Math.sqrt(Math.max(0.05, 1 - (z / 2.1) ** 2));
        b.tor(1, 0.06, 4, 18, red, { z, s: [0.97 * k, 0.87 * k, 1] });
      }
      b.sph(0.24, 8, 6, red, { z: 2.0, s: [1, 1, 0.6] });
      for (const rz of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) b.at({ z: -1.55, rz }, () => b.box(0.07, 0.78, 0.95, red, { y: 0.5 }));
      b.box(0.72, 0.42, 1.25, navy, { y: -1.5 }, 0.03);
      b.box(0.8, 0.08, 1.33, brass, { y: -1.12 });
      for (const [x, z] of [[0.3, 0.5], [-0.3, 0.5], [0.3, -0.5], [-0.3, -0.5]]) b.beam([x, -1.1, z], [x * 1.3, -0.7, z * 1.15], 0.045, 0.045, strut);
      b.cyl(0.07, 0.09, 0.32, 6, strut, { y: -1.3, z: -0.62, rx: -Math.PI / 2 });
    }),
    windows: mk(92, (b) => {
      for (const s of [-1, 1]) for (let i = 0; i < 3; i++) b.box(0.03, 0.14, 0.22, 0xfff0c0, { x: s * 0.37, y: -1.4, z: -0.36 + i * 0.36 });
      b.box(0.5, 0.14, 0.03, 0xfff0c0, { y: -1.4, z: 0.64 });
    }),
    prop: mk(93, (b) => {
      for (let k = 0; k < 3; k++) b.box(0.11, 0.62, 0.04, 0xd9c08a, { rz: k * TAU / 3 });
      b.cyl(0.08, 0.08, 0.1, 6, brass, { rx: Math.PI / 2, z: -0.05 });
    }),
    stencil: (() => { const g = new THREE.PlaneGeometry(2.7, 0.68); g.userData.shared = true; return g; })(),
    cargo: [],
  };
  return AIRSHIP;
}

// Cargo net with n (1..5) crates, origin at the bottom of the net, ropes up to the gondola (y = +1.05).
function cargoProto(n) {
  const A = airshipProto();
  if (A.cargo[n]) return A.cargo[n];
  const b = new GeoBuilder(95 + n), crate = crateProtos().crate, rope = 0xd9c08a;
  const spots = [[-0.32, 0, 0], [0.32, 0, 0.04], [0, 0, -0.02], [-0.16, 0.3, 0.02], [0.16, 0.3, -0.02]];
  const order = n === 1 ? [2] : n === 2 ? [0, 1] : [0, 1, 2, 3, 4].slice(0, n);
  for (const i of order) { const [x, y, z] = spots[i]; b.add(crate, 0xffffff, { x, y, z, s: 0.58, ry: i * 0.35 }); }
  const hw = n <= 2 ? 0.4 : 0.52;
  for (const [x, z] of [[hw, 0.3], [-hw, 0.3], [hw, -0.3], [-hw, -0.3]]) b.beam([x * 0.55, 1.05, z * 0.7], [x, 0.02, z], 0.018, 0.018, rope);
  for (let k = -1; k <= 1; k++) {
    b.beam([-hw, 0.03, k * 0.28], [hw, 0.03, k * 0.28], 0.015, 0.015, rope);
    b.beam([k * hw * 0.66, 0.03, -0.3], [k * hw * 0.66, 0.03, 0.3], 0.015, 0.015, rope);
  }
  for (const y of [0.17, 0.33]) { b.beam([-hw, y, 0.31], [hw, y, 0.31], 0.012, 0.012, rope); b.beam([-hw, y, -0.31], [hw, y, -0.31], 0.012, 0.012, rope); }
  const g = b.build();
  g.userData.shared = true;
  A.cargo[n] = g;
  return g;
}

// Painted-on remote name for the balloon (transparent background, freed with the airship).
function stencilTexture(text) {
  return canvasTex(512, 128, (x, w, h) => {
    x.clearRect(0, 0, w, h);
    x.textAlign = 'center'; x.textBaseline = 'middle';
    fitText(x, text, w - 44, 92);
    x.lineJoin = 'round'; x.lineWidth = 16; x.strokeStyle = '#ffffff';
    x.strokeText(text, w / 2, h / 2 + 4);
    x.fillStyle = '#d62839';
    x.fillText(text, w / 2, h / 2 + 4);
  });
}

Object.assign(Island.prototype, {
  // Effect runner: fx = { dur, step(elapsed, dt), end() }. skip starts it part-way through.
  _runFx(fx, skip = 0) {
    (this._fxList || (this._fxList = [])).push(fx);
    fx.start = (this.engine.time ?? 0) - skip;
    return fx;
  },

  _tickFx(dt, t) {
    const list = this._fxList;
    if (!list?.length) return;
    for (let i = list.length - 1; i >= 0; i--) {
      const f = list[i], el = f.hold != null ? f.hold : t - f.start;
      let done = el >= f.dur;
      if (!done) { try { f.step(el, dt); } catch (e) { console.warn('[islands] fx', e); done = true; } }
      if (done) { list.splice(i, 1); safe(() => f.end()); }
    }
  },

  // The island's name label steps aside while a launch plays over the plaza (reference-counted); returns release().
  _holdLabel() {
    this._lh = (this._lh || 0) + 1;
    safe(() => this.label?.setVisible?.(false));
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      this._lh = Math.max(0, this._lh - 1);
      if (!this._lh && !this._disposed) safe(() => this.label?.setVisible?.(true));
    };
  },

  // Screen-space banner that follows an object; its CSS animation pops it in and fades it out over `secs`.
  _banner(object, cls, inner) {
    const still = LAUNCH_TEST?.hold ? ' isl-still' : '';   // held test launches: no pop-in, so stills capture it
    return addLabel(this.engine, object, V3(0, 0, 0), `<div class="isl-banner ${cls}${still}">${inner}</div>`, 'isl-banner-wrap always', 'fx');
  },

  // Fade a banner out so it is gone `end` seconds into its effect (engine time).
  _bannerFade(label, el, end, fade = 0.8) {
    const b = label?.el?.firstElementChild;
    if (b) b.style.opacity = String(clamp((end - el) / fade, 0, 1));
  },

  _launchTest(type, skip) {
    const br = this.branch || 'main';
    if (type === 'push') return this._fxPush({ remote: 'origin', branch: br, count: 3, newBranch: false }, null, skip);
    if (type === 'maiden') return this._fxPush({ remote: 'origin', branch: 'feature/lighthouse', count: null, newBranch: true }, null, skip);
    if (type === 'merge') return this._fxMerge({ from: 'feature/login', branch: br, msg: "Merge branch 'feature/login'" }, null, skip);
    if (type === 'commit') return this._fxCommit({ msg: 'feat: add rocket boosters to the release train', hash: 'c0ffee1' }, null, skip);
    if (type === 'firework') return this._fxFirework(this._launchSpot(), 'fix: stop the linter from eating tests', { height: 8.5, hash: 'bada55e' }, skip);
    if (type === 'pull') return this._fxPull({ msg: "Merge branch 'main' of origin", hash: 'feed123' }, null, skip);
    if (type === 'checkout') return this._fxCheckout({ to: br === 'main' ? 'feature/lighthouse' : 'main' }, null, skip);
    if (type === 'pr') return this._fxPigeon({ key: [...this.lots.keys()][0], number: 123, action: 'merged' }, null, skip);
    return null;
  },

  // PUSH: a supply airship lifts off the launch pad with min(count, 5) crates in its cargo net and sails off towards
  // the far horizon, shrinking, trailing a dotted contrail; a banner rides along above it.
  _fxPush(e, annex, skip = 0) {
    if (this._disposed) return;
    const rm = !!this.engine.settings?.reduceMotion;
    const remote = trunc(String(e.remote || 'origin'), 18);
    const branch = trunc(String(e.branch || this.branch || 'main'), 34);
    const count = e.count == null || !Number.isFinite(Number(e.count)) ? null : Math.max(0, Math.round(Number(e.count)));
    const maiden = !!e.newBranch;
    const A = airshipProto(), S = shared();
    const g = new THREE.Group();
    g.name = 'fx:airship';
    const body = new THREE.Mesh(A.body, S.vc);
    body.castShadow = true;
    const win = new THREE.Mesh(A.windows, S.lamps);
    const prop = new THREE.Mesh(A.prop, S.vc);
    prop.position.set(0, -1.3, -0.98);
    const cargo = new THREE.Mesh(cargoProto(clamp(count ?? 1, 1, 5)), S.vc);
    cargo.position.y = -2.77;
    cargo.castShadow = true;
    const smat = new THREE.MeshBasicMaterial({ map: stencilTexture(remote.toUpperCase()), transparent: true, depthWrite: false });
    for (const s of [-1, 1]) {
      const p = new THREE.Mesh(A.stencil, smat);
      p.position.set(0.965 * s, 0.05, 0);
      p.rotation.y = s * Math.PI / 2;
      g.add(p);
    }
    const navR = new THREE.Mesh(P.box(0.1, 0.1, 0.1), glow(0xff4d4d, 1.4));
    navR.position.set(-0.42, -1.5, 0.5);
    const navG = new THREE.Mesh(P.box(0.1, 0.1, 0.1), glow(0x3ddc84, 1.4));
    navG.position.set(0.42, -1.5, 0.5);
    const gs = glowSprite(0xffe7a0, 2.4, 0.2);
    gs.position.y = -1.5;
    const anchor = new THREE.Object3D();
    anchor.position.y = 2.25;
    g.add(body, win, prop, cargo, navR, navG, gs, anchor);
    this.group.add(g);

    // path: pop in above the pad, rise, then accelerate away up the screen (the far horizon of the iso view)
    const from = annex ? V3(annex.x, this.top + 0.2, annex.z) : this._launchSpot();   // the pad, unless a launch is using it
    const BIG = 1.65;                                              // chunky enough to read from far zoom
    const p0 = from.clone().add(V3(0, 3.2 * BIG, 0));
    const ox = Math.cos(this.outAngle), oz = Math.sin(this.outAngle);
    const [ux, uz] = -ox >= -oz ? [-1, 0] : [0, -1];          // back-left or back-right, whichever leads out to sea
    const heading = Math.atan2(ux, uz), pose0 = SIGN_YAW + Math.PI / 2;   // start broadside to the default camera
    const POP = rm ? 0.5 : 1.2, T = rm ? 2.2 : 5.0, dur = rm ? 3.5 : 15.2, rise = rm ? 2.6 : 4.2;
    const bannerEnd = rm ? dur - 0.3 : 10.6, RELEASE = rm ? 1.5 : 5.5, TRAIL = 3.6;
    if (!annex && this.padTop && from.distanceTo(this.padTop) < 0.5) this._occupyPad((this.engine.time ?? 0) - skip, T);
    const pos = (el, out) => {
      if (el < POP) return out.set(p0.x, p0.y + 0.5 * ease.outCubic(el / POP), p0.z);
      if (rm || el < T) return out.set(p0.x, p0.y + 0.5 + rise * ease.inOut(clamp((el - POP) / (T - POP), 0, 1)), p0.z);
      const k = (el - T) / (dur - T), kk = Math.pow(k, 1.7);             // lazy drift, gently accelerating
      return out.set(p0.x + ux * 46 * kk, p0.y + 0.5 + rise + 12 * k + 3 * kk, p0.z + uz * 46 * kk);
    };
    const scaleAt = (el) => {
      if (el < POP) return BIG * (0.25 + 0.75 * ease.outBack(el / POP));
      const s = rm ? lerp(1, 0.15, smooth(T, dur, el)) : lerp(1, 0.26, smooth(T, dur, el));
      return BIG * s * (el > dur - 0.9 ? Math.max(0, (dur - el) / 0.9) : 1);
    };
    const q = new THREE.Vector3();
    const tail = (el, sc) => pos(el, q) && [q.x - ux * 1.95 * sc, q.y - 1.25 * sc, q.z - uz * 1.95 * sc];
    const PF = this._parts('spark');                                // unlit dots: the contrail reads at night too
    if (!rm && skip > T) {                                       // back-fill the contrail when starting part-way
      for (let s = T; s < skip; s += 0.14) {
        const age = skip - s;
        if (age >= TRAIL) continue;
        const d = tail(s, scaleAt(s));
        PF.spawn(d[0], d[1], d[2], 0, 0.05, 0, { life: TRAIL, size: 0.17, color: 0xf2f8ff, age, spin: 2 });
      }
    }
    // the unpushed-commit crates stacked by the pad go with it: they fly up into the cargo net as it hovers there
    const crates = !annex ? this.gitv?.crates : null;
    const claim = crates && crates.shown > 0 && !crates.fly ? { done: false } : null;
    if (claim) crates.claim = claim;
    const LOAD = rm ? 0.2 : 0.45;
    const nTxt = count == null ? '' : `${count} commit${count === 1 ? '' : 's'}`;
    const inner = maiden
      ? `MAIDEN VOYAGE<span class="isl-arrow">→</span>${esc(remote)}/${esc(branch)}`
      : `PUSHED<span class="isl-arrow">→</span>${esc(remote)}/${esc(branch)}${nTxt ? `<small>· ${nTxt}</small>` : ''}`;
    let label = null, lastDot = skip;
    const release = skip < RELEASE ? this._holdLabel() : () => {};
    if (skip < 0.3) this._puff(from.clone().add(V3(0, 0.3, 0)), 0xe8f0ff, 12, 0.7, { up: 0.5, out: 1.8, size: 0.32 });
    return this._runFx({
      dur,
      step: (el, dt) => {
        const sc = scaleAt(el);
        pos(el, q);
        g.position.set(q.x, q.y + (rm ? 0 : Math.sin(el * 2.3) * 0.12), q.z);
        g.scale.setScalar(Math.max(0.001, sc));
        g.rotation.set(0, lerpAngle(pose0, heading, rm ? smooth(0.5, 2, el) : smooth(1.5, 5.5, el)), rm ? 0 : Math.sin(el * 1.3) * 0.05);
        prop.rotation.z += dt * 22;
        gs.material.opacity = 0.08 + 0.5 * (1 - (this.engine.daylight ?? 1));
        if (!label && el >= 0.5) label = this._banner(anchor, maiden ? 'isl-maiden' : 'isl-push', inner);
        this._bannerFade(label, el, bannerEnd);
        if (el >= RELEASE) release();
        if (claim && !claim.done && el >= LOAD) { claim.done = true; safe(() => this._cratesLoad(crates, claim, cargo, rm)); }
        if (!rm && el > T && el - lastDot > 0.14) {
          lastDot = el;
          const d = tail(el, sc);
          PF.spawn(d[0], d[1], d[2], 0, 0.05, 0, { life: TRAIL, size: 0.17, color: 0xf2f8ff, spin: 2 });
        }
      },
      end: () => {
        if (claim && crates.claim === claim) crates.claim = null;
        if (crates?.fly?.cargo === cargo) crates.fly.cargo = null;   // still flying up: finish at the last target
        release(); safe(() => label?.remove()); disposeTree(g);
      },
    }, skip);
  },

  // MERGE: two ribbons of light (the merged branch and the target) spiral up from two of the Git Tree's branches,
  // fuse into a golden burst above the canopy, the tree glows gold, a few fireworks go up, and a banner names it.
  _fxMerge(e, annex, skip = 0) {
    if (this._disposed) return;
    const rm = !!this.engine.settings?.reduceMotion;
    const branch = trunc(String(e.branch || this.branch || 'main'), 30);
    const from = e.from ? trunc(String(e.from), 26) : null;
    const tr = !annex ? this.tree : null;
    let base, tips, F, treeMesh = null, sc = 1;
    if (tr) {
      const gp = tr.group.position;
      sc = tr.sc || 1;
      base = gp.clone();
      const ts = tr.tips?.length ? tr.tips : [[0.7, tr.crown * 0.6, 0.2], [-0.7, tr.crown * 0.6, -0.2]];
      const a = ts[0], b = ts.length > 1 ? ts[Math.floor(ts.length / 2)] : [-a[0], a[1], -a[2]];
      tips = [a, b].map((t) => V3(gp.x + t[0], gp.y + t[1], gp.z + t[2]));
      F = V3(gp.x, gp.y + tr.crown + 1.8 * sc, gp.z);
      treeMesh = tr.mesh || null;
    } else {
      const c = annex ? V3(annex.x, this.top, annex.z) : V3(this.L.center.x, this.top, this.L.center.z);
      base = c;
      tips = [c.clone().add(V3(1.1, 0.5, 0.3)), c.clone().add(V3(-1.0, 0.5, -0.4))];
      F = c.clone().add(V3(0, 3.8, 0));
    }
    const cols = [0x39e5ff, 0xff5fa2];
    const g = new THREE.Group();
    g.name = 'fx:merge';
    this.group.add(g);
    const ribbons = [];
    if (!rm) tips.forEach((S0, i) => {
      const r0 = Math.max(0.55, Math.hypot(S0.x - base.x, S0.z - base.z)), a0 = Math.atan2(S0.z - base.z, S0.x - base.x);
      const pts = [];
      for (let k = 0; k <= 40; k++) {
        const u = k / 40, a = a0 + u * TAU * 1.2;
        const rr = lerp(r0, 0.12, ease.inOut(u)) * (1 + 0.3 * Math.sin(u * Math.PI));
        pts.push(new THREE.Vector3(base.x + Math.cos(a) * rr, lerp(S0.y, F.y, u), base.z + Math.sin(a) * rr));
      }
      const curve = new THREE.CatmullRomCurve3(pts);
      const TS = 120, RS = 6;
      const core = new THREE.Mesh(new THREE.TubeGeometry(curve, TS, 0.09 * Math.min(1.4, sc), RS, false),
        new THREE.MeshBasicMaterial({ color: cols[i], transparent: true, depthWrite: false }));
      const halo = new THREE.Mesh(new THREE.TubeGeometry(curve, TS, 0.24 * Math.min(1.4, sc), RS, false),
        new THREE.MeshBasicMaterial({ color: cols[i], transparent: true, opacity: 0.38, blending: THREE.AdditiveBlending, depthWrite: false }));
      core.renderOrder = 7; halo.renderOrder = 8;
      core.visible = halo.visible = false;
      const head = new THREE.Mesh(P.ico(0.17, 1), shared().spark);
      head.visible = false;
      g.add(core, halo, head);
      ribbons.push({ core, halo, head, curve, TS, RS, color: cols[i] });
    });
    const T0 = rm ? 0 : 0.5, T1 = rm ? 0.25 : 4.3, dur = rm ? 3.8 : 10.4, LAG = rm ? 0.9 : 1.6;
    const bannerAt = rm ? 0.25 : 1.0, bannerEnd = rm ? dur - 0.3 : 10.2;
    const fwAt = rm ? [] : [T1 + 0.7, T1 + 1.6, T1 + 2.5];
    let fw = fwAt.filter((x) => x < skip - 0.5).length;
    const anchor = new THREE.Object3D();
    anchor.position.set(F.x, F.y + 1.1, F.z);
    g.add(anchor);
    const inner = `MERGED${from ? ` <span class="isl-from">${esc(from)}</span>` : ''}<span class="isl-arrow">→</span>${esc(branch)}`;
    const PS = this._parts('spark');
    let burst = null, gold = null, label = null, lastSpark = -1;
    const release = this._holdLabel();
    if (!rm && skip < T0) for (const t of tips) this._sparkBurst(t, [0xffffff, 0xfff3a0], 10, 1.2, { life: 0.6, grav: 0.5, size: 0.1 });
    return this._runFx({
      dur,
      step: (el) => {
        const uh = ease.inOut(clamp((el - T0) / (T1 - T0), 0, 1));
        const ut = clamp((el - T0 - LAG) / (T1 - T0), 0, 1);
        const spark = el - lastSpark > 0.035;
        if (spark) lastSpark = el;
        for (const R of ribbons) {
          const i0 = Math.min(R.TS, Math.floor(ut * R.TS)), i1 = Math.max(i0, Math.floor(uh * R.TS));
          const start = i0 * R.RS * 6, count = (i1 - i0) * R.RS * 6;
          R.core.geometry.setDrawRange(start, count);
          R.halo.geometry.setDrawRange(start, count);
          R.core.visible = R.halo.visible = count > 0;
          R.head.visible = el >= T0 && uh < 0.995;
          if (R.head.visible) {
            R.curve.getPointAt(Math.min(uh, 0.999), R.head.position);
            if (spark) PS.spawn(R.head.position.x, R.head.position.y, R.head.position.z, (Math.random() - 0.5) * 0.7, (Math.random() - 0.5) * 0.7, (Math.random() - 0.5) * 0.7, { life: 0.7, size: 0.1, color: R.color, grav: 0.3 });
          }
        }
        if (!label && el >= bannerAt) label = this._banner(anchor, 'isl-merge', inner);
        if (!burst && el >= T1) {
          burst = this._fusionBurst(g, F, sc, el - T1 < 0.4, !rm);
          gold = this._treeGold(treeMesh, rm ? 2.4 : 4.8);
          if (el - T1 < 0.5) safe(() => label?.el?.firstElementChild?.classList.add('isl-pulse'));
        }
        this._bannerFade(label, el, bannerEnd);
        burst?.step(el - T1);
        gold?.step(el - T1);
        if (fw < fwAt.length && el >= fwAt[fw]) {
          const a = SIGN_YAW + (fw - 1) * 1.1, d = 1.9 * sc;
          this._fxFirework(V3(base.x + Math.cos(a) * d, this.top + 0.3, base.z + Math.sin(a) * d), null, {
            height: 4.4 + (fw % 2) * 1.1, quiet: true,
            palette: [[0xffd23d, 0xffffff, 0xfff1a8], [0x39e5ff, 0xffd23d, 0xffffff], [0xff5fa2, 0xffd23d, 0xffffff], [0xffd23d, 0x9be22d, 0xffffff]][fw],
          });
          fw++;
        }
      },
      end: () => { release(); safe(() => label?.remove()); gold?.end(); disposeTree(g); },
    }, skip);
  },

  // Golden burst where the ribbons meet: expanding glow, two shock rings and a shower of sparks.
  _fusionBurst(g, F, sc, emit, slow = true) {
    const sprite = glowSprite(0xffd23d, 1, 1);
    sprite.position.copy(F);
    const ringMat = new THREE.MeshBasicMaterial({ color: 0xffc93a, transparent: true, depthWrite: false, side: THREE.DoubleSide });
    const rs = Math.min(1.25, sc);
    const flat = new THREE.Mesh(P.tor(1, 0.07, 3, 36), ringMat);
    flat.rotation.x = Math.PI / 2;
    flat.position.copy(F);
    const face = new THREE.Mesh(P.tor(1, 0.07, 3, 36), ringMat);
    face.rotation.y = SIGN_YAW;
    face.position.copy(F);
    g.add(sprite, flat, face);
    if (emit) {
      this._sparkBurst(F, [0xffd23d, 0xffffff, 0xfff1a8, 0xffb13d], 120, 6.5, { life: 1.9, grav: 1.3, size: 0.2 });
      this._puff(F, 0xfff3c4, 6, 0.3, { up: 0.3, out: 0.9, size: 0.55, life: 0.9 });
    }
    return {
      step: (k) => {
        const S = slow ? 1.9 : 1;                                        // slow: the glow holds before fading
        const grow = clamp(k / (0.8 * S), 0, 1), fade = slow ? smooth(1.3, 2.7, k) : clamp(k / 1.4, 0, 1);
        const b = clamp(k / (0.9 * S), 0, 1), c = clamp((k - 0.18 * S) / (0.9 * S), 0, 1);
        sprite.scale.setScalar((1.5 + 7 * ease.outCubic(slow ? grow : fade)) * rs);
        sprite.material.opacity = 0.95 * (1 - fade);
        flat.scale.setScalar((0.4 + 3.1 * ease.outCubic(b)) * rs);
        face.scale.setScalar((0.3 + 2.3 * ease.outCubic(c)) * rs);
        ringMat.opacity = 0.9 * (1 - Math.max(b, c * 0.9));
        flat.visible = b < 1; face.visible = c < 1;
      },
    };
  },

  // Gold glow on the Git Tree: its mesh borrows an emissive twin of the shared vertex-colour material.
  _treeGold(mesh, secs = 2.4) {
    if (!mesh) return null;
    const goldMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, emissive: new THREE.Color(0xffc53d), emissiveIntensity: 0 });
    mesh.material = goldMat;
    return {
      step: (k) => { const a = clamp(k / secs, 0, 1); goldMat.emissiveIntensity = Math.min(1, k / 0.15) * (1 - a * a) * (0.85 + 0.25 * Math.sin(k * 11)); },
      end: () => { if (mesh.material === goldMat) mesh.material = shared().vc; goldMat.dispose(); },
    };
  },
});

// ---- git work-tree state on the island ----------------------------------------------------------------------------
// Island.git.status (and each worktree annex's own status, DESIGN §2) drives persistent props. Each one is built the
// first time its state shows up, then kept and reused; _gitTick eases them towards the latest status (no per-frame
// allocations). _gitSync runs on every update():
//   dirty > 0      laundry on a line, one garment per changed file (cap 8, then a "+N" tag), fluttering in the wind
//   ahead > 0      crates stacked on a pallet beside the launch pad, one per unpushed commit (cap 6, then a count
//                  plate). A push's airship loads them (they fly up into its cargo net); after that the stack follows
//                  status.ahead again from the next poll on
//   stash > 0      a treasure chest half-buried behind a red X, with a "STASH ×N" sign
//   op             the Git Tree's trunk in a plaster cast, with a yellow "REBASING" (etc.) sign on a side arm
//   conflicts > 0  the Git Tree on fire (flames on its crowns, a glow, smoke, the tree lit orange), fiercer with more
//                  conflicts; the `conflict` event adds a one-shot flash and "MERGE CONFLICT!" (_fxConflict)
// Worktree islets show the fire and the cast (on their pennant pole) from their own status; the laundry, crates and
// chest belong to the main work tree only. Their spots are reserved in _layout (L.git); they block units only while
// they are shown.

const GIT_TAGS = ['laundry', 'crates', 'stash'];
const OP_WORD = { merge: 'MERGING', rebase: 'REBASING', 'cherry-pick': 'CHERRY-PICKING', revert: 'REVERTING', bisect: 'BISECTING' };
const opWord = (op) => OP_WORD[op] || String(op).toUpperCase().slice(0, 16);
const LAUNDRY_MAX = 8, CRATE_MAX = 6, LINE_HALF = 1.4, LINE_Y = 1.55;
const CLOTH = [0xff5a4d, 0x39a0ff, 0xffd23d, 0x3ddc84, 0xff8ad8, 0xf7f7fb, 0xff9f3a, 0x9b7bff, 0x2ed3c5];
const CLOTH_KINDS = ['shirt', 'sock', 'towel', 'shirt'];
const PEG_ORDER = [3, 4, 2, 5, 1, 6, 0, 7];                                                  // the line fills from the middle out
const CRATE_SPOTS = [[0, 0], [-0.68, 0], [0.68, 0], [-0.34, 0.6], [0.34, 0.6], [0, 1.2]];   // [x, y] on the pallet: a pyramid
const FLAMES = [0, 3, 5, 7, 9];                                                              // flames per conflict level (1..4+)
const lineY = (u) => LINE_Y - 0.13 * 4 * u * (1 - u);
const approach = (a, b, step) => (a < b ? Math.min(b, a + step) : Math.max(b, a - step));
const count0 = (v) => Math.max(0, Math.round(Number(v) || 0));
const _gp = new THREE.Vector3(), _gs = new THREE.Vector2();

// A garment hanging from its pegs: origin at the top centre, cloth in the XY plane (faces +Z), hanging down.
function garmentGeo(kind, color) {
  return pc(`cloth|${kind}|${color}`, () => {
    const b = new GeoBuilder(7 + (color % 97));
    const dk = tint(color, -0.2), lt = tint(color, 0.25), peg = 0xd8b27a;
    if (kind === 'sock') {
      b.box(0.13, 0.28, 0.035, color, { y: -0.34 });
      b.box(0.21, 0.1, 0.035, color, { x: 0.04, y: -0.42 });
      b.box(0.07, 0.1, 0.04, dk, { x: 0.115, y: -0.42 });
      b.box(0.135, 0.06, 0.04, lt, { y: -0.13 });
      b.box(0.04, 0.09, 0.05, peg, { y: -0.08 });
    } else if (kind === 'towel') {
      b.box(0.3, 0.46, 0.035, color, { y: -0.52 });
      for (const y of [-0.19, -0.44]) b.box(0.305, 0.045, 0.04, lt, { y });
      for (const x of [-0.1, 0.1]) b.box(0.04, 0.09, 0.05, peg, { x, y: -0.08 });
    } else {
      b.box(0.34, 0.36, 0.035, color, { y: -0.44 });
      b.box(0.13, 0.14, 0.035, color, { x: -0.2, y: -0.24, rz: 0.3 });
      b.box(0.13, 0.14, 0.035, color, { x: 0.2, y: -0.24, rz: -0.3 });
      b.box(0.14, 0.05, 0.04, dk, { y: -0.13 });
      b.box(0.345, 0.05, 0.04, lt, { y: -0.32 });
      for (const x of [-0.12, 0.12]) b.box(0.04, 0.09, 0.05, peg, { x, y: -0.08 });
    }
    return b.build();
  });
}

Object.assign(Island.prototype, {
  // Called on every update(): read the status, build what is newly needed, set the targets _gitTick eases towards.
  _gitSync() {
    if (this._disposed || !this.body || this.kind !== 'repo') return;
    const G = this.gitv || (this.gitv = {});
    const st = this.data?.git?.status || null, spots = this.L?.git || {};
    const dirty = count0(st?.dirty), ahead = count0(st?.ahead), stash = count0(st?.stash), conflicts = count0(st?.conflicts);
    const op = st?.op || null;
    if (dirty && !G.laundry && spots.laundry) G.laundry = this._mkLaundry(spots.laundry);
    if (G.laundry) { G.laundry.n = Math.min(LAUNDRY_MAX, dirty); this._laundryTag(G.laundry, dirty - LAUNDRY_MAX); }
    if (ahead && !G.crates && spots.crates) G.crates = this._mkCrates(spots.crates);
    if (G.crates) G.crates.target = ahead;
    if (stash && !G.stash && spots.stash) G.stash = this._mkStash(spots.stash);
    if (G.stash) this._stashCount(G.stash, stash);
    if (op && !G.cast && this.tree) G.cast = this._mkTreeCast();
    if (G.cast) this._castSet(G.cast, op);
    if (conflicts && !G.fire && this.tree) G.fire = this._mkTreeFire();
    if (G.fire) G.fire.level = Math.min(4, conflicts);
    // worktree islets: the fire and the cast, from their own status
    for (const a of this.data?.annexes || []) {
      const rec = a?.id != null ? this.annexes.get(String(a.id)) : null;
      if (!rec || rec.leaving || !rec.pp) continue;
      const ac = count0(a.status?.conflicts), aop = a.status?.op || null;
      if (!rec.gitv && !ac && !aop) continue;
      const A = rec.gitv || (rec.gitv = {});
      if (aop && !A.cast) A.cast = this._mkAnnexCast(rec);
      if (A.cast) this._castSet(A.cast, aop);
      if (ac && !A.fire) A.fire = this._mkAnnexFire(rec);
      if (A.fire) A.fire.level = Math.min(4, ac);
    }
  },

  _gitTick(dt, t, day) {
    const G = this.gitv, instant = this._young || G.snap;
    G.snap = false;
    // zoomed far out the flames grow a little (up to 1.35x), like a base's "!", so a burning tree still reads
    const cam = this.engine.camera, rdr = this.engine.renderer;
    G.far = 1;
    if (cam?.isOrthographicCamera && rdr?.getSize) {
      rdr.getSize(_gs);                                     // (three's own size: no DOM read, no reflow)
      G.far = clamp(13 / Math.max(1e-3, (_gs.y * cam.zoom) / Math.max(1e-3, cam.top - cam.bottom)), 1, 1.35);
    }
    if (G.laundry) this._tickLaundry(G.laundry, dt, t, instant);
    if (G.crates) this._tickCrates(G.crates, dt, instant);
    if (G.stash) this._tickStash(G.stash, dt, instant);
    if (G.cast) this._tickCast(G.cast, dt, t, instant);
    if (G.fire) this._tickFire(G.fire, dt, t, day, instant, this.tree?.mesh || null, G.far);
    for (const rec of this.annexes.values()) {
      const A = rec.gitv;
      if (!A || rec.leaving) continue;
      if (A.cast) this._tickCast(A.cast, dt, t, instant);
      if (A.fire) this._tickFire(A.fire, dt, t, day, instant, null, G.far);
    }
  },

  // The Git Tree was rebuilt (branch count changed): refit the cast and the fire to it, without an entrance.
  _gitTreeReset() {
    const G = this.gitv;
    if (!G) return;
    for (const k of ['cast', 'fire']) if (G[k]) { disposeTree(G[k].g); G[k] = null; }
    this._gitSync();
    G.snap = true;
  },

  // A shown prop blocks units (island.obstacles, read by units.js every frame); a hidden one does not. The laundry
  // line blocks as three circles along its length (spot.parts).
  _gitObs(p, tag, on) {
    if (p.obs === on) return;
    p.obs = on;
    const list = this.obstacles;
    if (!Array.isArray(list)) return;
    for (let i = list.length - 1; i >= 0; i--) if (list[i].tag === tag) list.splice(i, 1);
    if (on) for (const c of p.spot.parts || [p.spot]) list.push({ x: c.x + this.position.x, z: c.z + this.position.z, r: c.r, tag });
  },

  // ---- laundry (uncommitted files) ----
  _mkLaundry(spot) {
    const g = new THREE.Group();
    g.name = 'git:laundry';
    g.position.set(spot.x, this.top, spot.z);
    g.rotation.y = spot.yaw ?? SIGN_YAW;            // the line runs (about) across the screen for the default camera
    g.visible = false;
    const H = spot.half || LINE_HALF;               // half its length: shorter on crowded little islands
    const b = new GeoBuilder(hashNum(this.id) + 41);
    for (const s of [-1, 1]) {
      b.cyl(0.05, 0.065, LINE_Y + 0.12, 5, PAL.woodDark, { x: s * H });
      b.box(0.08, 0.06, 0.42, PAL.woodDark, { x: s * H, y: LINE_Y - 0.02 });
      b.ico(0.11, 0, 0x7a6244, { x: s * H, y: 0.02, s: [1.5, 0.4, 1.5] });
    }
    const pts = [];
    for (let k = 0; k <= 8; k++) { const u = k / 8; pts.push([-H + 2 * H * u, lineY(u), 0]); }
    b.tube(pts, 0.016, 0xf2efe6, 12);
    // a wicker basket by the right-hand post
    b.cyl(0.25, 0.2, 0.24, 8, 0xc9a26a, { x: H + 0.45, z: 0.3 }, 0.06);
    b.tor(0.245, 0.03, 3, 10, 0xa5804c, { x: H + 0.45, y: 0.24, z: 0.3, rx: Math.PI / 2 });
    b.ico(0.18, 0, 0xf7f7fb, { x: H + 0.43, y: 0.25, z: 0.3, s: [1.1, 0.5, 1] });
    g.add(b.mesh(shared().vc));
    const r = rng(this.id + '|laundry'), pegs = [];
    for (let i = 0; i < LAUNDRY_MAX; i++) {
      const u = (i + 0.5) / LAUNDRY_MAX;
      pegs.push({ x: -H + 2 * H * u, y: lineY(u), kind: CLOTH_KINDS[Math.floor(r() * CLOTH_KINDS.length)],
        color: CLOTH[Math.floor(r() * CLOTH.length)], ph: r() * TAU, m: null, k: 0 });
    }
    this.body.add(g);
    return { g, pegs, spot, H, n: 0, more: 0, tag: null, k: 0, obs: false };
  },

  // "+N" tag on the right-hand post for the files beyond the eighth.
  _laundryTag(W, more) {
    more = Math.max(0, more);
    if (more === W.more) return;
    W.more = more;
    if (W.tag) { disposeTree(W.tag); W.tag = null; }
    if (!more) return;
    const g = new THREE.Group();
    g.add(box(0.52, 0.34, 0.05, PAL.woodDark, { center: true }));
    const face = textSign(`+${more}`, { w: 0.44, h: 0.27, bg: '#fff3c4', fg: '#3b2a16', border: '#7a4b2b' });
    face.position.z = 0.03;
    g.add(face);
    g.position.set(W.H, LINE_Y - 0.5, 0.09);
    W.g.add(g);
    W.tag = g;
  },

  _tickLaundry(W, dt, t, instant) {
    const wind = clamp(this.engine.wind ?? 0.2, 0, 1);
    const lean = 0.08 + 0.42 * wind, amp = 0.05 + 0.2 * wind, f = 2.6 + 4 * wind;
    let any = false;
    for (let j = 0; j < LAUNDRY_MAX; j++) {
      const p = W.pegs[PEG_ORDER[j]], want = j < W.n ? 1 : 0;
      if (!p.m) {
        if (!want) continue;
        p.m = new THREE.Mesh(garmentGeo(p.kind, p.color), shared().vc);
        p.m.castShadow = true;
        p.m.position.set(p.x, p.y, 0);
        W.g.add(p.m);
      }
      p.k = instant ? want : approach(p.k, want, dt * (want ? 2.6 : 3.5));
      p.m.visible = p.k > 0.001;
      if (!p.m.visible) continue;
      any = true;
      p.m.scale.set(1, Math.max(0.001, want ? ease.outBack(p.k) : p.k), 1);   // hung up: unrolls down from the pegs
      const light = p.kind === 'sock' ? 1.35 : p.kind === 'towel' ? 0.8 : 1;
      p.m.rotation.z = lean * light * (0.75 + 0.25 * Math.sin(t * 0.8 + p.ph)) + amp * light * Math.sin(t * f + p.ph * 3);
      p.m.rotation.x = -amp * 0.8 * light * Math.sin(t * f * 1.3 + p.ph * 5);
    }
    const want = W.n > 0 || any ? 1 : 0;
    W.k = instant ? want : approach(W.k, want, dt * 3);
    W.g.visible = W.k > 0.001;
    if (W.g.visible) W.g.scale.set(1, Math.max(0.001, want ? ease.outBack(W.k) : W.k), 1);
    this._gitObs(W, 'laundry', W.g.visible);
  },

  // ---- crates (unpushed commits) ----
  _mkCrates(spot) {
    const g = new THREE.Group();
    g.name = 'git:crates';
    g.position.set(spot.x, this.top, spot.z);
    const r = rng(this.id + '|crates');
    g.rotation.y = SIGN_YAW + (r() - 0.5) * 0.4;
    g.visible = false;
    const b = new GeoBuilder(hashNum(this.id) + 43);
    for (const z of [-0.32, 0, 0.32]) b.box(2.1, 0.06, 0.14, PAL.woodDark, { z });
    b.box(2.15, 0.05, 0.86, PAL.wood, { y: 0.06 }, 0.05);
    g.add(b.mesh(shared().vc));
    const proto = crateProtos().crate;
    const items = CRATE_SPOTS.map(([x, y]) => {
      const m = new THREE.Mesh(proto, shared().vc);
      m.castShadow = true;
      m.visible = false;
      m.scale.setScalar(1.2);
      m.rotation.y = (r() - 0.5) * 0.6;
      const c = { m, x, y: 0.11 + y, z: (r() - 0.5) * 0.08, k: 0, fx: 0, fy: 0, fz: 0 };
      m.position.set(c.x, c.y, c.z);
      g.add(m);
      return c;
    });
    this.body.add(g);
    return { g, items, spot, target: 0, shown: 0, dropAt: null, claim: null, fly: null, hold: null, plate: null, plateN: 0, obs: false };
  },

  // Count plate on a stake for more than six unpushed commits.
  _cratePlate(C, n) {
    C.plateN = n;
    if (C.plate) { disposeTree(C.plate); C.plate = null; }
    if (!n) return;
    const g = new THREE.Group();
    g.add(box(0.06, 0.62, 0.06, PAL.woodDark));
    const bd = box(0.66, 0.38, 0.05, PAL.woodDark, { center: true });
    bd.position.y = 0.62;
    const face = textSign(`×${n}`, { w: 0.58, h: 0.3, bg: '#ffc53d', fg: '#2a1d00', border: '#2a1d00' });
    face.position.set(0, 0.62, 0.03);
    g.add(bd, face);
    g.position.set(1.25, 0, 0.42);
    C.g.add(g);
    C.plate = g;
  },

  _tickCrates(C, dt, instant) {
    const now = this.engine.time ?? 0, st = this.data?.git?.status || null;
    // what the stack shows: status.ahead, except right after a push carried it off (until the next poll)
    let want = C.target;
    if (C.hold) { if (now < C.hold.until && (st?.at ?? null) === C.hold.at) want = 0; else C.hold = null; }
    if (C.fly) { this._tickCrateFly(C, dt); return; }
    if (!C.claim) {
      if (want >= C.shown || instant) { C.shown = want; C.dropAt = null; }
      else if (C.dropAt == null) C.dropAt = now + 0.45;      // a push event may be about to claim them: wait a moment
      else if (now >= C.dropAt) { C.shown = want; C.dropAt = null; }
    }
    const plate = C.shown > CRATE_MAX ? C.shown : 0;
    if (plate !== C.plateN) this._cratePlate(C, plate);
    const n = Math.min(CRATE_MAX, C.shown);
    let any = false;
    for (let i = 0; i < CRATE_MAX; i++) {
      const c = C.items[i], w = i < n ? 1 : 0, was = c.k;
      c.k = instant ? w : approach(c.k, w, dt * (w ? 2.2 : 3));
      c.m.visible = c.k > 0.001;
      if (!c.m.visible) continue;
      any = true;
      if (w) {                                               // new commit: the crate drops onto the stack
        const u = 1 - c.k;
        c.m.position.set(c.x, c.y + 2.2 * u * u, c.z);
        c.m.scale.setScalar(1.2);
        if (was < 1 && c.k === 1 && !instant && this.engine.fx?.puff) {
          c.m.getWorldPosition(_gp);
          this.engine.fx.puff(_gp, { color: 0xe8dcc0, count: 4, size: 0.35, spread: 0.4, rise: 0.3, life: 0.6 });
        }
      } else { c.m.position.set(c.x, c.y, c.z); c.m.scale.setScalar(1.2 * c.k); }
    }
    C.g.visible = any || n > 0;
    this._gitObs(C, 'crates', C.g.visible);
  },

  // A push's airship hovers over the pad: the stack flies up into its cargo net (reduced motion: it just goes).
  _cratesLoad(C, claim, cargo, rm) {
    if (C.claim === claim) C.claim = null;
    if (!C.shown || this._disposed) return;
    if (rm) { this._cratesLoaded(C); return; }
    for (const c of C.items) { c.fx = c.m.position.x; c.fy = c.m.position.y; c.fz = c.m.position.z; }
    C.fly = { t: 0, dur: 0.85, cargo, tx: 0, ty: 3, tz: 0 };
  },

  _tickCrateFly(C, dt) {
    const F = C.fly;
    F.t += dt;
    if (F.cargo) {                                           // the net, in the stack's own frame
      F.cargo.getWorldPosition(_gp);
      C.g.worldToLocal(_gp);
      F.tx = _gp.x; F.ty = _gp.y + 0.3; F.tz = _gp.z;
    }
    const k = clamp(F.t / F.dur, 0, 1);
    for (let i = 0; i < CRATE_MAX; i++) {
      const c = C.items[i];
      if (!c.m.visible) continue;
      const u = clamp(k * 1.3 - i * 0.05, 0, 1), e = ease.inCubic(u);
      c.m.position.set(lerp(c.fx, F.tx, e), lerp(c.fy, F.ty, e) + Math.sin(u * Math.PI) * 0.5, lerp(c.fz, F.tz, e));
      c.m.scale.setScalar(1.2 * (1 - 0.6 * e));
    }
    if (k >= 1) this._cratesLoaded(C);
  },

  _cratesLoaded(C) {
    C.fly = null;
    for (const c of C.items) { c.k = 0; c.m.visible = false; c.m.position.set(c.x, c.y, c.z); c.m.scale.setScalar(1.2); }
    C.shown = 0;
    C.dropAt = null;
    C.hold = { at: this.data?.git?.status?.at ?? null, until: (this.engine.time ?? 0) + 20 };
  },

  // ---- buried stash ----
  _mkStash(spot) {
    const g = new THREE.Group();
    g.name = 'git:stash';
    g.position.set(spot.x, this.top, spot.z);
    const r = rng(this.id + '|stash');
    g.rotation.y = SIGN_YAW + (r() - 0.5) * 0.5;
    g.visible = false;
    const inner = new THREE.Group();                        // rises out of / sinks back into the ground
    g.add(inner);
    const b = new GeoBuilder(hashNum(this.id) + 47), bl = new GeoBuilder(48);
    const dirt = 0x8a6240;
    b.ico(0.5, 0, dirt, { x: -0.1, y: -0.06, z: -0.5, s: [1.5, 0.45, 0.9] }, 0.08);          // the dug-out heap
    b.ico(0.62, 0, tint(dirt, -0.12), { y: -0.05, s: [1.2, 0.12, 0.95] }, 0.05);              // the hole's rim
    for (const a of [Math.PI / 4, -Math.PI / 4]) b.box(1.0, 0.04, 0.2, 0xe63946, { y: 0.01, z: 0.78, ry: a });   // X marks the spot
    // the chest, a third of it still in the ground, lid ajar
    b.box(0.86, 0.42, 0.56, PAL.wood, { y: -0.14 }, 0.05);
    for (const y of [0.02, 0.2]) b.box(0.88, 0.06, 0.58, PAL.woodDark, { y });
    for (const x of [-0.3, 0.3]) b.box(0.07, 0.43, 0.585, 0xc9a13a, { x, y: -0.14 });
    b.box(0.12, 0.13, 0.04, 0xffc53d, { y: 0.12, z: 0.29 });
    b.at({ y: 0.28, z: -0.28, rx: -0.5 }, () => {
      b.box(0.88, 0.11, 0.58, tint(PAL.wood, 0.06), { z: 0.29 });
      for (const x of [-0.3, 0.3]) b.box(0.07, 0.115, 0.585, 0xc9a13a, { x, z: 0.29 });
    });
    for (const [x, z] of [[-0.2, 0.05], [0.05, -0.05], [0.22, 0.08]]) b.ico(0.1, 0, 0xffc53d, { x, y: 0.27, z, s: [1, 0.6, 1] });
    for (const [x, z] of [[-0.12, 0.1], [0.14, 0]]) bl.box(0.07, 0.07, 0.07, 0xfff0a0, { x, y: 0.31, z, ry: 0.7 });
    // a shovel left in the heap
    b.rod([0.62, 0.02, -0.4], [0.8, 1.0, -0.5], 0.035, 5, PAL.woodDark);
    b.box(0.2, 0.26, 0.04, PAL.metal, { x: 0.6, y: -0.08, z: -0.39, rz: -0.18 });
    // sign post (the board with the count is added by _stashCount)
    b.cyl(0.04, 0.05, 1.0, 5, PAL.woodDark, { x: -0.72, z: 0.3 });
    inner.add(b.mesh(shared().vc));
    const glints = bl.mesh(shared().lamps, { cast: false });
    if (glints) inner.add(glints);
    this.body.add(g);
    return { g, inner, spot, n: 0, board: null, boardN: 0, k: 0, obs: false };
  },

  _stashCount(S, n) {
    const was = S.n;
    S.n = n;
    if (n > 0 && n !== S.boardN) {
      S.boardN = n;
      if (S.board) disposeTree(S.board);
      const g = new THREE.Group();
      g.add(box(1.06, 0.34, 0.05, PAL.woodDark, { center: true }));
      const face = textSign(`STASH ×${n}`, { w: 0.98, h: 0.27, bg: '#f3e2b3', fg: '#3b2a16', border: '#7a4b2b' });
      face.position.z = 0.03;
      g.add(face);
      g.position.set(-0.72, 0.86, 0.34);
      g.rotation.z = 0.05;
      S.inner.add(g);
      S.board = g;
    }
    if (n > 0 && !was && !this._young) this._puff(V3(S.spot.x, this.top + 0.1, S.spot.z), 0x9a7050, 9, 0.6, { up: 0.9, size: 0.3 });
  },

  _tickStash(S, dt, instant) {
    const want = S.n > 0 ? 1 : 0;
    S.k = instant ? want : approach(S.k, want, dt * (want ? 1.3 : 1.0));
    S.g.visible = S.k > 0.001;
    if (S.g.visible) S.inner.position.y = -1.1 * (1 - (want ? ease.outBack(S.k) : S.k));
    this._gitObs(S, 'stash', S.g.visible);
  },

  // ---- plaster cast + operation sign (merge / rebase / ... stopped half-way) ----
  _mkTreeCast() {
    const tr = this.tree, sc = tr.sc || 1, H = 1.35 * sc;
    const g = new THREE.Group();
    g.name = 'git:cast';
    g.position.copy(tr.group.position);
    g.visible = false;
    const b = new GeoBuilder(hashNum(this.id) + 53);
    const rAt = (y) => (0.27 - 0.1 * y / H) * sc;
    [0.3, 0.5, 0.7].forEach((f, i) => {
      const y = H * f, rr = rAt(y) * 1.4 + 0.06;
      b.cyl(rr, rr * 1.06, 0.26 * sc, 8, i % 2 ? 0xf1ede4 : 0xfbfaf6, { y: y - 0.13 * sc, rz: (i - 1) * 0.07 }, 0.04);
    });
    const ym = H * 0.5, rm = rAt(ym) * 1.46 + 0.07, cx = Math.sin(SIGN_YAW) * rm, cz = Math.cos(SIGN_YAW) * rm;
    b.box(0.2, 0.06, 0.02, 0xe63946, { x: cx, y: ym - 0.03, z: cz, ry: SIGN_YAW });            // a red cross, towards the camera
    b.box(0.06, 0.2, 0.02, 0xe63946, { x: cx, y: ym - 0.1, z: cz, ry: SIGN_YAW });
    // from the default camera the trunk hides behind the branch sign and the canopy: a bandage round the top crown shows
    const cy = H + 0.3 * sc, br = 0.64 * sc;
    b.at({ y: cy, rz: 0.22, rx: -0.12 }, () => {
      b.cyl(br, br, 0.24 * sc, 10, 0xfbfaf6, { y: -0.12 * sc }, 0.03);
      const px = Math.sin(SIGN_YAW) * (br + 0.01), pz = Math.cos(SIGN_YAW) * (br + 0.01);
      b.box(0.2, 0.06, 0.02, 0xe63946, { x: px, y: -0.03, z: pz, ry: SIGN_YAW });
      b.box(0.06, 0.2, 0.02, 0xe63946, { x: px, y: -0.1, z: pz, ry: SIGN_YAW });
    });
    // a long, low arm off the tree's screen-left side (the island's rim), so the sign hangs clear of the canopy and of
    // the branch sign in front
    const armY = H * 0.6, L = 1.2 * sc, lx = -Math.SQRT1_2 * L, lz = Math.SQRT1_2 * L;
    b.beam([0, armY - 0.12, 0], [lx, armY, lz], 0.075 * sc, 0.075 * sc, PAL.woodDark);
    b.beam([lx * 0.45, armY - 0.06, lz * 0.45], [lx * 0.45 - 0.1, armY + 0.22, lz * 0.45 + 0.1], 0.045, 0.045, PAL.woodDark);   // a twig
    g.add(b.mesh(shared().vc));
    const sign = new THREE.Group();
    sign.position.set(lx, armY - 0.02, lz);
    sign.rotation.y = SIGN_YAW;
    g.add(sign);
    this.body.add(g);
    return { g, sign, bw: 1.3, bh: 0.34, hang: true, word: '', board: null, on: false, k: 0, ph: this.phase };
  },

  // On a worktree islet: two bands on the pennant pole and a small sign nailed to it.
  _mkAnnexCast(rec) {
    const g = new THREE.Group();
    g.name = 'git:cast';
    g.position.set(rec.pp[0], this.top, rec.pp[1]);
    g.visible = false;
    const b = new GeoBuilder(hashNum(rec.id) + 59);
    [0.42, 0.72].forEach((y, i) => b.cyl(0.09, 0.095, 0.15, 7, i ? 0xf1ede4 : 0xfbfaf6, { y }, 0.04));
    g.add(b.mesh(shared().vc));
    const sign = new THREE.Group();
    sign.position.set(Math.sin(SIGN_YAW) * 0.08, 1.12, Math.cos(SIGN_YAW) * 0.08);
    sign.rotation.y = SIGN_YAW;
    g.add(sign);
    rec.group.add(g);
    return { g, sign, bw: 0.95, bh: 0.25, hang: false, word: '', board: null, on: false, k: 0, ph: hashNum(rec.id) % 7 };
  },

  _castSet(Cst, op) {
    const on = !!op;
    if (on && !Cst.on && !this._young) {                    // (a worktree's cast sits in its islet's group)
      const p = Cst.g.position.clone().add(Cst.g.parent && Cst.g.parent !== this.body ? Cst.g.parent.position : V3());
      this._puff(p.setY(p.y + 0.9), 0xffffff, 7, 0.35, { size: 0.22, up: 0.6 });
    }
    Cst.on = on;
    if (!on) return;
    const word = opWord(op);
    if (word === Cst.word) return;
    Cst.word = word;
    if (Cst.board) disposeTree(Cst.board);
    const g = new THREE.Group(), w = Cst.bw, h = Cst.bh, y = Cst.hang ? -0.26 - h / 2 : 0;
    if (Cst.hang) {
      const rb = new GeoBuilder(3);
      for (const x of [-w * 0.36, w * 0.36]) rb.beam([x, y + h / 2, 0], [x * 0.25, 0, 0], 0.018, 0.018, 0xd9c08a);
      g.add(rb.mesh(shared().vc, { cast: false }));
    }
    const back = box(w + 0.08, h + 0.08, 0.05, 0x2a1d00, { center: true });
    back.position.y = y;
    const face = textSign(word, { w, h, bg: '#ffd23f', fg: '#2a1d00', border: '#2a1d00' });
    face.position.set(0, y, 0.03);
    g.add(back, face);
    Cst.sign.add(g);
    Cst.board = g;
  },

  _tickCast(Cst, dt, t, instant) {
    const want = Cst.on ? 1 : 0;
    Cst.k = instant ? want : approach(Cst.k, want, dt * (want ? 2 : 2.5));
    Cst.g.visible = Cst.k > 0.001;
    if (!Cst.g.visible) return;
    const s = Math.max(0.001, want ? ease.outBack(Cst.k) : Cst.k);
    Cst.g.scale.set(s, 1, s);                               // the bands wrap on, the arm grows out
    Cst.sign.rotation.z = Math.sin(t * 1.3 + Cst.ph) * 0.05;
  },

  // ---- fire (merge conflicts) ----
  // spots: [x, y, z, size] in the parent's frame; smoke / glowAt: [x, y, z].
  _mkFire(spots, sc, smoke, glowAt, glowSize) {
    const g = new THREE.Group();
    g.name = 'git:fire';
    g.visible = false;
    const S = shared(), core = mat(0xfff3a0, { emissive: 0xffe066, emissiveIntensity: 1.2 });
    const seed = hashNum(this.id) % 7;
    const flames = spots.map((p, i) => {
      const fl = new THREE.Group();
      fl.position.set(p[0], p[1], p[2]);
      // like the campfire: an orange body, red tongues either side, a yellow heart in front (towards the camera)
      const o = new THREE.Mesh(P.cone(1, 1, 5), S.fire);
      o.scale.set(0.26, 0.78, 0.26);
      const tl = new THREE.Mesh(P.cone(1, 1, 5), S.fireRed);
      tl.scale.set(0.14, 0.46, 0.14);
      tl.position.set(0.15, 0, -0.12);
      tl.rotation.set(0.2, 0, -0.35);
      const tr = new THREE.Mesh(P.cone(1, 1, 5), S.fireRed);
      tr.scale.set(0.13, 0.5, 0.13);
      tr.position.set(-0.14, 0, 0.13);
      tr.rotation.set(-0.2, 0, 0.35);
      const c = new THREE.Mesh(P.cone(1, 1, 5), core);
      c.scale.set(0.15, 0.5, 0.15);
      c.position.set(0.09, 0.01, 0.09);
      fl.add(o, tl, tr, c);
      fl.visible = false;
      g.add(fl);
      return { fl, o, s: p[3] * sc, ph: i * 1.9 + seed, k: 0 };
    });
    const glowS = glowSprite(0xff6a1a, glowSize, 0);
    glowS.material.blending = THREE.NormalBlending;           // a warm haze that also shows by day
    glowS.position.set(glowAt[0], glowAt[1], glowAt[2]);
    g.add(glowS);
    return { g, flames, glow: glowS, smoke, sc, level: 0, count: 0, k: 0, next: 0, nextEmber: 0,
      smokeOpt: { count: 1, color: 0x9a9ca6, size: 0.7 * sc, rise: 1.7 } };
  },

  // On the Git Tree: a big flame on top, the rest on its branch crowns and around the canopy.
  _mkTreeFire() {
    const tr = this.tree, sc = tr.sc || 1, H = 1.35 * sc, cy = H + 0.3 * sc;
    const spots = [[0, cy + 0.45 * sc, 0, 1.5]];
    const tips = (tr.tips || []).map((p) => [p[0], p[1] + 0.12 * sc, p[2], 1.05]);
    const ring = [];
    for (let k = 0; k < 6; k++) { const a = k * 2.1 + this.phase; ring.push([Math.cos(a) * 0.45 * sc, cy + 0.15 * sc, Math.sin(a) * 0.45 * sc, 1.1]); }
    for (let i = 0; spots.length < FLAMES[4] && (i < tips.length || i < ring.length); i++) {
      if (i < tips.length) spots.push(tips[i]);
      if (spots.length < FLAMES[4] && i < ring.length) spots.push(ring[i]);
    }
    const F = this._mkFire(spots, sc, [0, cy + 1.2 * sc, 0], [0, cy, 0], 4.4 * sc);
    F.g.position.copy(tr.group.position);
    this.body.add(F.g);
    return F;
  },

  // On a worktree islet: around the foot of the pennant pole, and one up the pole.
  _mkAnnexFire(rec) {
    const [px, pz] = rec.pp, top = this.top;
    const spots = [[px + 0.22, top, pz + 0.1, 0.95], [px - 0.2, top, pz + 0.16, 0.8], [px + 0.02, top + 0.8, pz, 0.6],
      [px + 0.04, top, pz - 0.24, 0.85], [px - 0.34, top, pz - 0.1, 0.7], [px + 0.38, top, pz - 0.14, 0.7], [px - 0.02, top + 0.3, pz + 0.3, 0.6]];
    const F = this._mkFire(spots, 1, [px, top + 1.9, pz], [px, top + 0.5, pz], 2.6);
    rec.group.add(F.g);
    return F;
  },

  _tickFire(F, dt, t, day, instant, treeMesh, far = 1) {
    const want = F.level > 0 ? 1 : 0;
    if (want) F.count = FLAMES[F.level];                    // (a dying fire keeps its flames while it shrinks)
    F.k = instant ? want : approach(F.k, want, dt * (want ? 1.5 : 0.7));
    F.g.visible = F.k > 0.001;
    if (!F.g.visible) {
      if (treeMesh && treeMesh.material === this._fireMat) treeMesh.material = shared().vc;
      return;
    }
    for (let i = 0; i < F.flames.length; i++) {
      const f = F.flames[i];
      f.k = instant ? (i < F.count ? 1 : 0) : approach(f.k, i < F.count ? 1 : 0, dt * 1.8);
      const k = f.k * F.k * f.s * far;
      f.fl.visible = k > 0.01;
      if (!f.fl.visible) continue;
      const lick = 0.8 + 0.3 * Math.sin(t * 13 + f.ph) * Math.sin(t * 5.3 + f.ph * 2);
      f.fl.scale.set(k * (1 + 0.1 * Math.sin(t * 9 + f.ph)), k * lick * 1.1, k);
      f.o.rotation.y += dt * 1.5;
    }
    F.glow.material.opacity = F.k * (0.26 + 0.34 * (1 - day)) * (0.85 + 0.15 * Math.sin(t * 17 + F.flames[0].ph));
    if (want && t >= F.nextEmber && F.count) {              // embers drifting up out of the flames
      F.nextEmber = t + 0.5 / (1 + F.level);
      const f = F.flames[Math.floor(Math.random() * F.count)];
      _gp.copy(f.fl.position);
      F.g.localToWorld(_gp);
      this.group.worldToLocal(_gp);
      this._parts('spark').spawn(_gp.x, _gp.y + 0.3 * f.s, _gp.z, (Math.random() - 0.5) * 0.5, 1.2 + Math.random(), (Math.random() - 0.5) * 0.5,
        { life: 1.3, size: 0.06 * F.sc, color: Math.random() < 0.5 ? 0xffb03a : 0xfff3a0, grav: -0.2 });
    }
    if (want && t >= F.next && this.engine.fx?.smoke) {
      F.next = t + (0.62 - 0.08 * F.level) * (0.75 + Math.random() * 0.5);
      _gp.set(F.smoke[0] + (Math.random() - 0.5) * 0.4 * F.sc, F.smoke[1], F.smoke[2] + (Math.random() - 0.5) * 0.4 * F.sc);
      F.g.localToWorld(_gp);
      F.smokeOpt.count = F.level > 2 ? 2 : 1;
      this.engine.fx.smoke(_gp, F.smokeOpt);
    }
    if (treeMesh) {                                         // the tree chars and glows red (never over a merge's gold)
      const fm = this._fireMat || (this._fireMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, emissive: new THREE.Color(0xff3a00), emissiveIntensity: 0 }));
      if (treeMesh.material === shared().vc) treeMesh.material = fm;
      fm.color.setRGB(1 - 0.3 * F.k, 1 - 0.45 * F.k, 1 - 0.52 * F.k);
      fm.emissiveIntensity = F.k * (0.24 + 0.1 * Math.sin(t * 9.1) * Math.sin(t * 5.3));
    }
  },

  // CONFLICT (one-shot; the fire itself follows the status): a flash in the tree (or on the worktree islet), a burst
  // of embers, black smoke and a floating "MERGE CONFLICT!".
  _fxConflict(e, annex) {
    if (this._disposed) return;
    let local;
    if (annex) local = V3(annex.x + (annex.pp?.[0] ?? 0), this.top + 1.2, annex.z + (annex.pp?.[1] ?? 0));
    else if (this.tree) { const gp = this.tree.group.position; local = V3(gp.x, gp.y + this.tree.crown * 0.75, gp.z); }
    else local = V3(this.L.plaza.x, this.top + 1.5, this.L.plaza.z);
    const eng = this.engine, world = this.group.localToWorld(local.clone());
    safe(() => eng.fx?.flash?.(world, { color: 0xff7a2a, size: 5, secs: 0.5 }));
    this._sparkBurst(local, [0xff5a1f, 0xffc53d, 0xfff3a0, 0xff3b2f], 46, 4.6, { life: 1.3, grav: 2.2, size: 0.15 });
    this._puff(local, 0x55565f, 7, 0.5, { up: 1.6, out: 0.9, size: 0.42, life: 1.8 });
    const txt = 'MERGE CONFLICT!';
    if (eng.fx?.text) safe(() => eng.fx.text(world.add(V3(0, 1.4, 0)), txt, { color: '#ff5a4d', size: 1.35, rise: 2.4, secs: 3.4 }));
    else floatText(this, local.add(V3(0, 1.4, 0)), txt, '#ff5a4d');
  },
});

// ---- PR carrier pigeon ----------------------------------------------------------------------------------------------

let PIGEON = null;
function pigeonProto() {
  if (PIGEON) return PIGEON;
  const mk = (seed, fn) => { const b = new GeoBuilder(seed); fn(b); const g = b.build(); g.userData.shared = true; return g; };
  const grey = 0xaeb8cc, dark = 0x6f7992, beak = 0xffb25a;
  PIGEON = {
    body: mk(131, (b) => {                                   // faces +Z, like the gulls
      b.ico(0.2, 1, grey, { s: [0.85, 0.8, 1.35] }, 0.04);
      b.ico(0.13, 1, 0x3fb59a, { y: 0.13, z: 0.17, s: [0.95, 1, 0.95] }, 0.05);        // an iridescent neck
      b.ico(0.08, 0, 0x9a6bd6, { x: 0.05, y: 0.12, z: 0.2 });
      b.ico(0.1, 1, dark, { y: 0.24, z: 0.25 }, 0.03);
      b.cone(0.03, 0.09, 4, beak, { y: 0.225, z: 0.33, rx: Math.PI / 2 });
      for (const x of [-0.065, 0.065]) { b.ico(0.028, 0, 0xffffff, { x, y: 0.26, z: 0.3 }); b.ico(0.016, 0, PAL.black, { x: x * 1.12, y: 0.262, z: 0.318 }); }
      b.at({ y: 0.02, z: -0.24, rx: -0.25 }, () => b.box(0.22, 0.035, 0.28, dark, { z: -0.12 }));   // tail fan
      for (const x of [-0.05, 0.05]) b.box(0.025, 0.1, 0.025, beak, { x, y: -0.26, z: 0.02 });
      // the scroll tied to its leg: parchment with a red ribbon
      b.cyl(0.055, 0.055, 0.26, 7, 0xf6e7c1, { x: 0.18, y: -0.28, z: 0.03, rz: Math.PI / 2 });
      b.cyl(0.06, 0.06, 0.05, 7, 0xd62839, { x: 0.075, y: -0.28, z: 0.03, rz: Math.PI / 2 });
    }),
    wing: mk(132, (b) => {                                   // the left wing: root at the origin, reaching along +X
      b.box(0.34, 0.035, 0.24, grey, { x: 0.17, y: -0.017 }, 0.03);
      b.box(0.19, 0.036, 0.2, dark, { x: 0.42, y: -0.018, z: -0.02 });
      for (const x of [0.12, 0.22]) b.box(0.05, 0.037, 0.23, dark, { x, y: -0.018 });
    }),
  };
  return PIGEON;
}

const _pq = new THREE.Vector3();

Object.assign(Island.prototype, {
  // PR: a carrier pigeon with a scroll on its leg takes off from the base that touched the pull request (its roof;
  // else the worktree islet, else the Git Tree), circles once and flies off towards the horizon with a "PR #123" tag
  // (a check mark when merged, plus confetti at take-off). Everything is disposed once it has gone.
  _fxPigeon(e, annex, skip = 0) {
    if (this._disposed) return null;
    const rm = !!this.engine.settings?.reduceMotion;
    const num = Number(e.number);
    const merged = e.action === 'merged';
    const bld = e.key != null ? safe(() => this.world.buildingOf?.(e.key)) : null;
    let S;
    if (bld?.roof?.isVector3) S = bld.roof.clone().sub(this.position).add(V3(0, 0.2, 0));   // (world -> island frame)
    else if (annex) S = V3(annex.x + (annex.pp?.[0] ?? 0), this.top + 1.9, annex.z + (annex.pp?.[1] ?? 0));
    else if (this.tree) { const gp = this.tree.group.position; S = V3(gp.x, gp.y + this.tree.crown, gp.z); }
    else S = V3(this.L.plaza.x, this.top + 1, this.L.plaza.z);
    const A = pigeonProto(), SH = shared();
    const g = new THREE.Group();
    g.name = 'fx:pigeon';
    const model = new THREE.Group();
    const body = new THREE.Mesh(A.body, SH.vc);
    body.castShadow = true;
    const wl = new THREE.Mesh(A.wing, SH.vc), wr = new THREE.Mesh(A.wing, SH.vc);
    wl.position.set(0.1, 0.07, 0.04);
    wr.position.set(-0.1, 0.07, 0.04);
    wr.scale.x = -1;
    wl.castShadow = wr.castShadow = true;
    model.add(body, wl, wr);
    const anchor = new THREE.Object3D();
    anchor.position.y = 0.62;
    g.add(model, anchor);
    g.visible = false;
    this.group.add(g);

    // path (island frame): hop up, one lap in front of the base, then off towards the horizon, shrinking
    const BIG = 1.9, R = 2.3, yaw0 = 3 * Math.PI / 4;          // starts heading screen-right for the default camera
    const HOP = rm ? 0.5 : 0.9, LAP = rm ? 0 : 3.8, LEAVE = rm ? 3.2 : 6.2, dur = HOP + LAP + LEAVE;
    const T1 = HOP, T2 = HOP + LAP;
    const vx = Math.sin(yaw0), vz = Math.cos(yaw0), a0 = Math.atan2(-vx, vz);
    const cx = S.x - R * Math.cos(a0), cz = S.z - R * Math.sin(a0);   // the lap's centre: in front of the take-off point
    const y1 = S.y + 1.6, y2 = y1 + 0.5;
    const ox = Math.cos(this.outAngle), oz = Math.sin(this.outAngle);
    const [ux, uz] = -ox >= -oz ? [-1, 0] : [0, -1];           // like the push airship: back-left or back-right, out to sea
    const Q = [S.x + vx * 4, y2 + 1, S.z + vz * 4], F = [S.x + ux * 46, y2 + 12, S.z + uz * 46];
    const bez = (u, i, p0) => (1 - u) * (1 - u) * p0 + 2 * (1 - u) * u * Q[i] + u * u * F[i];
    const dbez = (u, i, p0) => 2 * (1 - u) * (Q[i] - p0) + 2 * u * (F[i] - Q[i]);
    const inner = `PR${Number.isFinite(num) && num > 0 ? ` #${num}` : ''}${merged ? '<span class="isl-ok">\u2713</span>' : ''}`;
    let label = null, started = false;
    return this._runFx({
      dur,
      step: (el) => {
        let yaw = yaw0, pitch = 0, roll = 0, flapF = 11, flapA = 0.7, sc = BIG;
        if (el < T1) {                                          // hop up off the roof, wings going hard
          const k = el / T1;
          g.position.set(S.x + vx * 0.4 * k, S.y + (y1 - S.y) * ease.outCubic(k), S.z + vz * 0.4 * k);
          pitch = -0.45 * (1 - k); flapF = 17; flapA = 1.0;
          sc = BIG * (0.55 + 0.45 * ease.outBack(Math.min(1, k * 1.6)));
        } else if (el < T2) {                                   // one lap
          const u = (el - T1) / LAP, a = a0 + TAU * u;
          g.position.set(cx + R * Math.cos(a), y1 + (y2 - y1) * u + 0.6 * Math.sin(Math.PI * u), cz + R * Math.sin(a));
          yaw = Math.atan2(-Math.sin(a), Math.cos(a));
          roll = 0.35;
          if (Math.sin(el * 1.1) > 0.55) flapA = 0.18;          // a glide now and then
        } else {                                                // and away
          const k = (el - T2) / LEAVE, u = Math.pow(k, 1.5);
          g.position.set(bez(u, 0, S.x), bez(u, 1, y2), bez(u, 2, S.z));
          yaw = Math.atan2(dbez(u, 0, S.x), dbez(u, 2, S.z));
          pitch = -0.12; flapF = 9; flapA = 0.6;
          sc = BIG * lerp(1, 0.35, smooth(0, 1, k)) * (el > dur - 0.6 ? Math.max(0, (dur - el) / 0.6) : 1);
        }
        g.visible = true;
        g.rotation.y = yaw;
        g.scale.setScalar(Math.max(0.001, sc));
        model.rotation.set(pitch, 0, rm ? 0 : roll);
        const flap = rm ? 0.3 : Math.sin(el * flapF) * flapA;
        wl.rotation.z = flap;
        wr.rotation.z = -flap;
        if (!started) {                                         // take-off: a few feathers (and a party when merged)
          started = true;
          if (el < 0.4) {
            this._puff(S.clone(), 0xeef2f8, 6, 0.25, { size: 0.14, up: 0.5, out: 0.6 });
            if (merged) {
              safe(() => this.engine.fx?.confetti?.(this.group.localToWorld(_pq.copy(S)), { count: 36, power: 0.8 }));
              this._sparkBurst(S.clone(), [0x3ddc84, 0xffd23f, 0xffffff], 20, 2.5, { life: 0.9, grav: 2 });
            }
          }
        }
        if (!label && el >= 0.2) label = this._banner(anchor, 'isl-prtag', inner);
        this._bannerFade(label, el, dur - (rm ? 0.2 : 1.0));
      },
      end: () => { safe(() => label?.remove()); disposeTree(g); },
    }, skip);
  },
});

// PortTown shares the launch-effect runner (these are defined after the PortTown class above).
for (const k of ['_runFx', '_tickFx', '_banner', '_bannerFade', '_fxFirework', '_firework', '_commitInner']) PortTown.prototype[k] = Island.prototype[k];
