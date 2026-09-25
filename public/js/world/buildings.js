// Buildings (DESIGN §7): one Building per Claude Code session.
//
// A building is a little RTS base on a ~5x5 lot: a faction HQ core, add-on modules that unlock with tool use,
// a Context Silo, a Summary-Brick stack, a veterancy banner, generator huts for child processes and a picnic
// table for lunch breaks. Persistent visuals come from session state; one-shot animations (construction,
// compaction press, /clear demolition, decommission) are driven by the building's own clock in tick().
//
// Lot layout (lot-local, front = +Z = door side; the whole group is rotated by lot.facing):
//
//          -Z   [gen][gen][gen][gen][gen][gen]
//     [mod4]   +-------------+    (SILO)
//     [mod5]   |    CORE     |   [bricks]
//              +----door-----+
//     [table]   |banner  path  [mod0] [mod1]
//     [table]           path   [mod2] [mod3]      +Z
import * as THREE from 'three';
import {
  PAL, factionPal, cssHex, tint, mat, glow, box, cyl, cone, ico, sphere, torus, rng, ease, textSign,
  disposeTree, lerp, clamp, damp, fmtTokens, jitter, freeze,
} from './kit.js';

const TAU = Math.PI * 2;
const UP = new THREE.Vector3(0, 1, 0);
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _c = new THREE.Color();
const NC = { cast: false };

const FACTIONS = new Set(['opus', 'sonnet', 'haiku', 'fable', 'merc']);
const MOD_CATS = ['edit', 'bash', 'read', 'web', 'agent', 'mcp'];
const MOD_NAME = { edit: 'Forge', bash: 'Drill Rig', read: 'Observatory', web: 'Radar Array', agent: 'Barracks', mcp: 'Warp Gate' };
const MOD_SCALE = [0, 0.8, 0.9, 1];
const LEVEL_AT = [3, 25, 100];
const STATE_CHIP = { working: 'WORKING', thinking: 'THINKING', waiting: 'WAITING', needs_input: 'NEEDS YOU', idle: 'LUNCH', asleep: 'ASLEEP', ended: 'CLOSED' };
const WIN_ON = { working: 1, thinking: 0.85, waiting: 0.72, needs_input: 1, idle: 0.5, asleep: 0.03, ended: 0 };
const GLYPH = { opus: 'O', sonnet: 'S', haiku: 'H', fable: 'F', merc: 'M' };
const IND_H = { bubble: 1.15, hourglass: 1.0, bang: 1.75, moon: 1.05 };
// Beacon lamp colour per faction (the opus crystal, sonnet amber lamp, haiku lantern, fable star, merc antenna).
const BEACON = { opus: 0x7ff4ff, sonnet: 0xffb13b, haiku: 0xfff1c9, fable: 0xffe45c, merc: 0xff4d4d };

// Lot-local layout.
const CORE = { x: 0, z: -0.75 };
const SILO = { x: 1.95, z: -1.62 };
const BRICKS = { x: 1.98, z: -0.42 };
const TABLE = { x: -1.55, z: 1.66 };
const BANNER = { x: -0.95, z: 0.86 };
// Module slots, best-visible first; (wx, wz) = where a worker stands, relative to the slot.
const MOD_SLOTS = [
  { x: 0.95, z: 1.12, wx: -0.62, wz: 0.1 },
  { x: 2.0, z: 1.12, wx: 0.05, wz: -0.62 },
  { x: 0.95, z: 2.07, wx: -0.62, wz: 0.1 },
  { x: 2.0, z: 2.07, wx: 0, wz: 0.62 },
  { x: -1.95, z: -1.62, wx: -0.66, wz: 0 },
  { x: -1.95, z: -0.47, wx: 0, wz: 0.64 },
];
const GEN_SLOTS = [[-1.28, -2.3], [-0.78, -2.3], [-0.28, -2.3], [0.22, -2.3], [0.72, -2.3], [1.22, -2.3], [-2.3, 0.42], [-2.3, 0.9]];
const DEFAULT_SPOTS = {
  edit: [0.72, 0.95], bash: [1.3, -0.95], read: [-1.45, 0.3], search: [-1.2, 0.55], web: [1.35, 0.55],
  agent: [0.55, 1.05], mcp: [-0.45, 1.2], plan: [0.42, 1.3], skill: [-0.42, 1.35], other: [0.25, 1.35],
};

// Context fill ramp: cyan -> green -> yellow -> orange -> red.
const RAMP = [[0, 0x39e5ff], [0.38, 0x3ddc84], [0.6, 0xffe14d], [0.8, 0xff9a2e], [0.93, 0xff3b30]];
const _ra = new THREE.Color(), _rb = new THREE.Color();
function rampColor(f, out = new THREE.Color()) {
  f = clamp(f, 0, 1);
  for (let i = 1; i < RAMP.length; i++) {
    if (f <= RAMP[i][0]) {
      const [f0, c0] = RAMP[i - 1], [f1, c1] = RAMP[i];
      return out.copy(_ra.setHex(c0)).lerp(_rb.setHex(c1), (f - f0) / (f1 - f0));
    }
  }
  return out.setHex(RAMP[RAMP.length - 1][1]);
}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
const trunc = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s; };
const approach = (a, b, step) => (a < b ? Math.min(b, a + step) : Math.max(b, a - step));
const pulse = (x) => 0.5 + 0.5 * Math.sin(x);

// ---- shared resources ------------------------------------------------------------------------------------

const GEO = new Map();
function sgeo(key, make) {
  let g = GEO.get(key);
  if (!g) { g = make(); g.userData.shared = true; GEO.set(key, g); }
  return g;
}
const SMAT = new Map();
function smat(key, make) {
  let m = SMAT.get(key);
  if (!m) { m = make(); m.userData.shared = true; if (m.map) m.map.userData.shared = true; SMAT.set(key, m); }
  return m;
}

function canvasTex(w, h, draw, { repeat, nearest } = {}) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  if (nearest) { t.magFilter = THREE.NearestFilter; t.minFilter = THREE.NearestFilter; t.generateMipmaps = false; }
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(repeat[0], repeat[1]); }
  t.userData.shared = true;
  return t;
}

// Yellow/black diagonal hazard stripes; (rx, ry) = texture repeats across a face.
function hazardMat(rx = 4, ry = 1) {
  return smat(`haz${rx}|${ry}`, () => new THREE.MeshLambertMaterial({
    map: canvasTex(64, 64, (x, w) => {
      x.fillStyle = '#ffc53d'; x.fillRect(0, 0, w, w);
      x.fillStyle = '#20222e';
      for (let k = -3; k < 3; k++) {
        x.beginPath(); x.moveTo(k * 32, 0); x.lineTo(k * 32 + 16, 0); x.lineTo(k * 32 + 80, 64); x.lineTo(k * 32 + 64, 64); x.fill();
      }
    }, { repeat: [rx, ry] }),
  }));
}

function clothMat() {
  return smat('cloth', () => new THREE.MeshLambertMaterial({
    map: canvasTex(8, 8, (x) => {
      for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) { x.fillStyle = (i + j) % 2 ? '#fff6ea' : '#e8434e'; x.fillRect(i * 2, j * 2, 2, 2); }
    }, { nearest: true }),
  }));
}

function pageMat() {
  return smat('page', () => new THREE.MeshLambertMaterial({
    side: THREE.DoubleSide,
    map: canvasTex(32, 32, (x) => {
      x.fillStyle = '#fff8e6'; x.fillRect(0, 0, 32, 32);
      x.fillStyle = '#9a8f7a';
      for (let i = 0; i < 6; i++) x.fillRect(5, 5 + i * 4, i === 5 ? 12 : 22, 1.4);
    }),
  }));
}

function cobwebMat() {
  return smat('cobweb', () => new THREE.MeshBasicMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    map: canvasTex(128, 128, (x) => {
      x.strokeStyle = 'rgba(255,255,255,0.9)'; x.lineWidth = 2.2;
      const rays = [0, 0.3, 0.62, 0.95, 1.27, 1.5708];
      for (const a of rays) { x.beginPath(); x.moveTo(0, 0); x.lineTo(Math.cos(a) * 128, Math.sin(a) * 128); x.stroke(); }
      for (const r of [26, 50, 76, 102]) {
        x.beginPath();
        for (let i = 0; i < rays.length; i++) {
          const px = Math.cos(rays[i]) * r, py = Math.sin(rays[i]) * r;
          if (!i) x.moveTo(px, py);
          else { const m = (rays[i] + rays[i - 1]) / 2; x.quadraticCurveTo(Math.cos(m) * r * 0.8, Math.sin(m) * r * 0.8, px, py); }
        }
        x.stroke();
      }
    }),
  }));
}

let _glowTex = null;
function glowTex() {
  if (!_glowTex) {
    _glowTex = canvasTex(64, 64, (x) => {
      const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
      g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.3, 'rgba(255,255,255,0.55)'); g.addColorStop(1, 'rgba(255,255,255,0)');
      x.fillStyle = g; x.fillRect(0, 0, 64, 64);
    });
  }
  return _glowTex;
}

let _zTex = null;
function zTex() {
  if (!_zTex) {
    _zTex = canvasTex(64, 64, (x) => {
      x.font = 'bold 50px "Lilita One", "Arial Black", sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
      x.lineWidth = 9; x.strokeStyle = '#1b2350'; x.strokeText('Z', 32, 34);
      x.fillStyle = '#eef1ff'; x.fillText('Z', 32, 34);
    });
  }
  return _zTex;
}

// Two-line merc billboard ("FOR LEASE" + phone number).
function leaseMat() {
  return smat('lease', () => new THREE.MeshBasicMaterial({
    map: canvasTex(256, 100, (x) => {
      x.fillStyle = '#fbfaf3'; x.fillRect(0, 0, 256, 100);
      x.strokeStyle = '#d23a33'; x.lineWidth = 8; x.strokeRect(4, 4, 248, 92);
      x.fillStyle = '#d23a33'; x.textAlign = 'center'; x.textBaseline = 'middle';
      x.font = 'bold 44px "Lilita One", "Arial Black", sans-serif'; x.fillText('FOR LEASE', 128, 40);
      x.fillStyle = '#39404f'; x.font = 'bold 19px "Chakra Petch", "Arial", sans-serif'; x.fillText('CALL 555-TOKENS', 128, 78);
    }),
  }));
}

// ---- custom cached geometry ------------------------------------------------------------------------------

const G = {
  dome: (r, seg = 8) => sgeo(`dome${r}|${seg}`, () => new THREE.SphereGeometry(r, seg, Math.max(3, seg >> 1), 0, TAU, 0, Math.PI / 2)),
  oct: (r) => sgeo(`oct${r}`, () => new THREE.OctahedronGeometry(r, 0)),
  tetra: (r) => sgeo(`tet${r}`, () => new THREE.TetrahedronGeometry(r, 0)),
  circle: (r, seg) => sgeo(`circ${r}|${seg}`, () => new THREE.CircleGeometry(r, seg)),
  // Half cylinder lying along Z with its flat side on y = 0 (quonset huts).
  halfCyl: (r, len, seg) => sgeo(`hcyl${r}|${len}|${seg}`, () => {
    const g = new THREE.CylinderGeometry(r, r, len, seg, 1, false, -Math.PI / 2, Math.PI);
    g.rotateX(-Math.PI / 2);
    return g;
  }),
  // Gable roof: triangle (w wide, h tall) extruded d along Z.
  prism: (w, h, d) => sgeo(`prism${w}|${h}|${d}`, () => {
    const s = new THREE.Shape();
    s.moveTo(-w / 2, 0); s.lineTo(w / 2, 0); s.lineTo(0, h); s.closePath();
    const g = new THREE.ExtrudeGeometry(s, { depth: d, bevelEnabled: false });
    g.translate(0, 0, -d / 2);
    return g;
  }),
  // Sawtooth roof tooth: right triangle (depth d along Z, height h) extruded w along X; vertical face at +Z.
  tooth: (d, h, w) => sgeo(`tooth${d}|${h}|${w}`, () => {
    const s = new THREE.Shape();
    s.moveTo(0, 0); s.lineTo(d, 0); s.lineTo(d, h); s.closePath();
    const g = new THREE.ExtrudeGeometry(s, { depth: w, bevelEnabled: false });
    g.rotateY(-Math.PI / 2);
    g.translate(w / 2, 0, -d / 2);
    return g;
  }),
  gear: (teeth, ro, ri, rh, depth) => sgeo(`gear${teeth}|${ro}|${ri}|${rh}|${depth}`, () => {
    const s = new THREE.Shape();
    const n = teeth * 4;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU, r = (i % 4 === 1 || i % 4 === 2) ? ro : ri;
      if (i === 0) s.moveTo(Math.cos(a) * r, Math.sin(a) * r); else s.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    s.closePath();
    const hole = new THREE.Path(); hole.absarc(0, 0, rh, 0, TAU, true); s.holes.push(hole);
    const g = new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: false, curveSegments: 6 });
    g.translate(0, 0, -depth / 2);
    return g;
  }),
  // Paraboloid dish opening toward +Y.
  dish: (R, depth) => sgeo(`dish${R}|${depth}`, () => {
    const pts = [];
    for (let i = 0; i <= 5; i++) { const r = (i / 5) * R; pts.push(new THREE.Vector2(Math.max(0.001, r), depth * (r / R) ** 2)); }
    return new THREE.LatheGeometry(pts, 10);
  }),
  chevron: () => sgeo('chevron', () => {
    const s = new THREE.Shape();
    s.moveTo(-0.19, -0.03); s.lineTo(0, 0.1); s.lineTo(0.19, -0.03); s.lineTo(0.19, -0.11); s.lineTo(0, 0.02); s.lineTo(-0.19, -0.11); s.closePath();
    const g = new THREE.ExtrudeGeometry(s, { depth: 0.03, bevelEnabled: false });
    g.translate(0, 0, -0.015);
    return g;
  }),
  star: (ro, ri, d) => sgeo(`star${ro}|${ri}|${d}`, () => {
    const s = new THREE.Shape();
    for (let i = 0; i < 10; i++) {
      const a = Math.PI / 2 + (i * Math.PI) / 5, r = i % 2 ? ri : ro;
      if (i) s.lineTo(Math.cos(a) * r, Math.sin(a) * r); else s.moveTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    s.closePath();
    const g = new THREE.ExtrudeGeometry(s, { depth: d, bevelEnabled: false });
    g.translate(0, 0, -d / 2);
    return g;
  }),
  // Crescent moon ("C" opening to the right).
  crescent: (R) => sgeo(`cres${R}`, () => {
    const d = 0.45, rho = 0.82;
    const x = (1 - rho * rho + d * d) / (2 * d), y = Math.sqrt(1 - x * x);
    const a0 = Math.atan2(y, x), b0 = Math.atan2(y, x - d);
    const s = new THREE.Shape();
    s.absarc(0, 0, R, a0, TAU - a0, false);
    s.absarc(d * R, 0, rho * R, TAU - b0, b0, true);
    const g = new THREE.ExtrudeGeometry(s, { depth: 0.06, bevelEnabled: false, curveSegments: 10 });
    g.translate(0, 0, -0.03);
    return g;
  }),
  feather: () => sgeo('feather', () => {
    const s = new THREE.Shape();
    s.moveTo(0, 0); s.quadraticCurveTo(0.22, 0.32, 0.1, 0.95); s.quadraticCurveTo(0.02, 1.06, -0.05, 0.9); s.quadraticCurveTo(-0.17, 0.42, 0, 0);
    const g = new THREE.ExtrudeGeometry(s, { depth: 0.035, bevelEnabled: false, curveSegments: 6 });
    g.translate(0, 0, -0.0175);
    return g;
  }),
  petal: () => sgeo('petal', () => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
      0, 0, 0.06, 0.04, 0.01, 0, 0, 0, -0.06,
      0, 0, 0.06, 0, 0, -0.06, -0.04, 0.01, 0,
    ]), 3));
    g.computeVertexNormals();
    return g;
  }),
  blob: (r, seed) => sgeo(`blob${r}|${seed}`, () => jitter(new THREE.IcosahedronGeometry(r, 1), r * 0.28, seed)),
};

// ---- small helpers ---------------------------------------------------------------------------------------

// Position + rotation (yaw applied last: order YXZ) helper.
function put(o, x = 0, y = 0, z = 0, ry = 0, rx = 0, rz = 0) {
  o.position.set(x, y, z);
  o.rotation.set(rx, ry, rz, 'YXZ');
  return o;
}
function grp(parent, x = 0, y = 0, z = 0, ry = 0, rx = 0, rz = 0) {
  const g = put(new THREE.Group(), x, y, z, ry, rx, rz);
  if (parent) parent.add(g);
  return g;
}
function mesh(geo, material, cast = true) {
  const m = new THREE.Mesh(geo, material);
  m.castShadow = cast; m.receiveShadow = true;
  return m;
}
// Square beam between two points.
function beam(ax, ay, az, bx, by, bz, t, color, cast = false) {
  const dx = bx - ax, dy = by - ay, dz = bz - az, len = Math.hypot(dx, dy, dz) || 0.001;
  const m = box(t, len, t, color, { center: true, cast });
  m.position.set((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
  m.quaternion.setFromUnitVectors(UP, _v.set(dx / len, dy / len, dz / len));
  return m;
}
function flatDisc(r, seg, color, cast = false) { return cyl(r, r, 0.05, seg, color, { center: true, cast }); }
// Mark an Object3D (and its subtree) as animated so mergeStatic leaves it alone.
function dyn(o) { o.userData.dyn = true; return o; }

// Bake every static mesh under `root` into as few meshes as possible, expressed in root space:
// plain shared flat colors all go into ONE vertex-colored mesh; glowing / textured / transparent / unique
// materials get one merged mesh each. Animated subtrees (userData.dyn) keep their own transform: their rigid
// children are merged into them recursively. A ~100-mesh core becomes ~5 draw calls.
const _mInv = new THREE.Matrix4(), _mRel = new THREE.Matrix4();
function vcMat() { return smat('vc', () => new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true })); }
function plainColor(m) {
  return m.isMeshLambertMaterial && m.userData.shared && !m.map && !m.transparent && m.opacity === 1 && !m.vertexColors &&
    m.side === THREE.FrontSide && m.emissive && m.emissive.r + m.emissive.g + m.emissive.b === 0;
}
function mergeStatic(root) {
  root.updateMatrixWorld(true);
  _mInv.copy(root.matrixWorld).invert();
  const buckets = new Map();
  const nested = [];
  const visit = (o) => {
    for (const c of o.children) {
      if (c.userData.dyn) { if (!c.isMesh) nested.push(c); continue; }
      if (c.isMesh && !c.isInstancedMesh && c.visible && !Array.isArray(c.material) && c.geometry?.attributes?.position) {
        _mRel.multiplyMatrices(_mInv, c.matrixWorld);
        if (_mRel.determinant() > 0) {
          const vc = plainColor(c.material);
          const k = vc ? 'vc' : c.material.uuid;
          let b = buckets.get(k);
          if (!b) buckets.set(k, (b = { material: vc ? vcMat() : c.material, vc, cast: false, items: [] }));
          b.cast ||= c.castShadow;
          b.items.push({ mesh: c, m: _mRel.clone(), color: c.material.color });
        }
      }
      visit(c);
    }
  };
  visit(root);
  for (const n of nested) mergeStatic(n);
  _mInv.copy(root.matrixWorld).invert();
  for (const b of buckets.values()) {
    if (b.items.length < 2 && !b.vc) continue;
    let n = 0;
    const parts = b.items.map(({ mesh, m }) => {
      const g = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone();
      g.applyMatrix4(m);
      n += g.attributes.position.count;
      return g;
    });
    const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), uv = new Float32Array(n * 2);
    const col = b.vc ? new Float32Array(n * 3) : null;
    let o = 0;
    parts.forEach((g, gi) => {
      const P = g.attributes.position, N = g.attributes.normal, U = g.attributes.uv;
      const C = b.items[gi].color;
      for (let i = 0; i < P.count; i++) {
        const j = (o + i) * 3;
        pos[j] = P.getX(i); pos[j + 1] = P.getY(i); pos[j + 2] = P.getZ(i);
        if (N) { nor[j] = N.getX(i); nor[j + 1] = N.getY(i); nor[j + 2] = N.getZ(i); }
        if (U) { uv[(o + i) * 2] = U.getX(i); uv[(o + i) * 2 + 1] = U.getY(i); }
        if (col) { col[j] = C.r; col[j + 1] = C.g; col[j + 2] = C.b; }
      }
      o += P.count;
      g.dispose();
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    if (col) geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.computeBoundingSphere();
    const merged = new THREE.Mesh(geo, b.material);
    merged.castShadow = b.cast;
    merged.receiveShadow = true;
    merged.userData.merged = true;
    freeze(merged);                   // baked into root space: never moves on its own
    for (const { mesh } of b.items) mesh.parent?.remove(mesh);
    root.add(merged);
  }
  return root;
}

// ---- tiny particle systems (used when engine.fx is missing, and for building-scale bits) -----------------

class Puffs {
  constructor(parent) { this.parent = parent; this.live = []; this.pool = []; }
  emit(x, y, z, o = {}) {
    let p = this.pool.pop();
    if (!p) {
      const m = new THREE.Mesh(sgeo('puff', () => new THREE.IcosahedronGeometry(1, 0)), null);
      m.castShadow = false; m.receiveShadow = false; m.userData.noPick = true;
      p = { m };
    }
    p.m.material = mat(o.color ?? 0xffffff);
    p.m.position.set(x, y, z);
    p.m.scale.setScalar(0.001);
    p.m.rotation.set(Math.random() * 3, Math.random() * 3, 0);
    p.vx = o.vx ?? 0; p.vy = o.vy ?? 0.6; p.vz = o.vz ?? 0;
    p.t = 0; p.life = o.life ?? 1.2; p.size = o.size ?? 0.25; p.drag = o.drag ?? 0.8; p.grav = o.grav ?? 0;
    this.parent.add(p.m);
    this.live.push(p);
  }
  update(dt) {
    for (let i = this.live.length - 1; i >= 0; i--) {
      const p = this.live[i];
      p.t += dt;
      const k = p.t / p.life;
      if (k >= 1) {
        this.parent.remove(p.m);
        this.live[i] = this.live[this.live.length - 1]; this.live.pop();
        this.pool.push(p);
        continue;
      }
      const f = Math.exp(-p.drag * dt);
      p.vx *= f; p.vz *= f; p.vy = p.vy * f + p.grav * dt;
      p.m.position.x += p.vx * dt; p.m.position.y += p.vy * dt; p.m.position.z += p.vz * dt;
      const s = p.size * (k < 0.2 ? ease.outCubic(k / 0.2) : 1 - ease.inQuad((k - 0.2) / 0.8)) * (0.85 + 0.5 * k);
      p.m.scale.setScalar(Math.max(0.001, s));
      p.m.rotation.y += dt * 0.8;
    }
  }
  clear() { for (const p of this.live) this.parent.remove(p.m); this.pool.push(...this.live); this.live.length = 0; }
}

// Chunky ballistic debris (fallback for engine.fx.debris; also used for the brick/rubble bits).
class Chunks {
  constructor(parent) { this.parent = parent; this.live = []; }
  burst(cx, cy, cz, n, colors, { power = 1, spread = 1.2, size = 0.3 } = {}) {
    for (let i = 0; i < n; i++) {
      const k = i % 3;
      const geo = k === 0 ? sgeo('chunkB', () => new THREE.BoxGeometry(1, 1, 1)) : k === 1 ? G.tetra(0.75) : sgeo('chunkI', () => new THREE.IcosahedronGeometry(0.62, 0));
      const m = mesh(geo, mat(colors[i % colors.length]), i % 2 === 0);
      const s = size * (0.45 + Math.random() * 0.9);
      m.scale.setScalar(s);
      const a = Math.random() * TAU, r = Math.random() * spread;
      m.position.set(cx + Math.cos(a) * r, cy + Math.random() * 1.6, cz + Math.sin(a) * r);
      const sp = (1.5 + Math.random() * 4) * power;
      this.parent.add(m);
      this.live.push({
        m, s, t: 0, life: 2 + Math.random() * 1.1,
        vx: Math.cos(a) * sp, vy: (3.5 + Math.random() * 5) * power, vz: Math.sin(a) * sp,
        wx: (Math.random() - 0.5) * 12, wz: (Math.random() - 0.5) * 12,
      });
    }
  }
  update(dt) {
    for (let i = this.live.length - 1; i >= 0; i--) {
      const p = this.live[i], m = p.m;
      p.t += dt;
      if (p.t >= p.life) { this.parent.remove(m); this.live.splice(i, 1); continue; }
      p.vy -= 16 * dt;
      m.position.x += p.vx * dt; m.position.y += p.vy * dt; m.position.z += p.vz * dt;
      const floor = p.s * 0.4;
      if (m.position.y < floor) {
        m.position.y = floor;
        if (p.vy < -1.5) { p.vy = -p.vy * 0.33; p.vx *= 0.55; p.vz *= 0.55; p.wx *= 0.5; p.wz *= 0.5; } else { p.vy = 0; p.vx *= 0.85; p.vz *= 0.85; p.wx *= 0.8; p.wz *= 0.8; }
      }
      m.rotation.x += p.wx * dt; m.rotation.z += p.wz * dt;
      const k = p.t / p.life;
      if (k > 0.75) m.scale.setScalar(Math.max(0.001, p.s * (1 - (k - 0.75) / 0.25)));
    }
  }
  clear() { for (const p of this.live) this.parent.remove(p.m); this.live.length = 0; }
}

// ---- scaffolding -------------------------------------------------------------------------------------------

function makeScaffold(w, h, d) {
  const g = new THREE.Group();
  const P = PAL.hazard, R = 0xe0a526, PL = PAL.wood;
  const hw = w / 2, hd = d / 2, t = 0.06;
  const nx = Math.max(1, Math.round(w / 1.05)), nz = Math.max(1, Math.round(d / 1.05));
  for (let i = 0; i <= nx; i++) {
    for (let j = 0; j <= nz; j++) {
      if (i !== 0 && i !== nx && j !== 0 && j !== nz) continue;
      g.add(put(box(t, h, t, P, NC), -hw + (i / nx) * w, 0, -hd + (j / nz) * d));
    }
  }
  const levels = Math.max(1, Math.round(h / 0.6));
  for (let l = 1; l <= levels; l++) {
    const y = (l / levels) * h - 0.03;
    g.add(put(box(w + t, 0.045, 0.045, R, NC), 0, y, hd));
    g.add(put(box(w + t, 0.045, 0.045, R, NC), 0, y, -hd));
    g.add(put(box(0.045, 0.045, d + t, R, NC), hw, y, 0));
    g.add(put(box(0.045, 0.045, d + t, R, NC), -hw, y, 0));
    if (l % 2 === 1 || l === levels) {
      g.add(put(box(w, 0.035, 0.22, PL, NC), 0, y + 0.03, hd + 0.13));
      g.add(put(box(0.22, 0.035, d, PL, NC), hw + 0.13, y + 0.03, 0));
    }
  }
  for (let l = 0; l < levels; l++) {
    const y0 = (l / levels) * h, y1 = ((l + 1) / levels) * h;
    for (let i = 0; i < nx; i++) {
      const x0 = -hw + (i / nx) * w, x1 = x0 + w / nx;
      g.add(l % 2 ? beam(x0, y0, hd + 0.02, x1, y1, hd + 0.02, 0.035, R) : beam(x1, y0, hd + 0.02, x0, y1, hd + 0.02, 0.035, R));
    }
    for (let j = 0; j < nz; j++) {
      const z0 = -hd + (j / nz) * d, z1 = z0 + d / nz;
      g.add(l % 2 ? beam(hw + 0.02, y0, z0, hw + 0.02, y1, z1, 0.035, R) : beam(hw + 0.02, y0, z1, hw + 0.02, y1, z0, 0.035, R));
    }
  }
  return mergeStatic(g);
}

// ---- faction HQ cores --------------------------------------------------------------------------------------
// Each builder works in core-local space (origin = footprint center on the ground, front = +Z) and returns:
// { group, door (Object3D to animate), doorMode, doorOut (ground point outside the door), doorTop, doorFace,
//   doorX, doorW, roof (standable roof point), chimney (smoke point), smoke (color), beacon (world-ish point),
//   tick(dt, t, building) }

function coreOpus(c) {
  const { pal } = c;
  const g = new THREE.Group();
  const ST = 0xe9e2f7, STD = 0xb8acdb, R8 = Math.PI / 8;
  g.add(put(cyl(1.34, 1.42, 0.24, 8, STD), 0, 0, 0, R8));
  g.add(put(box(0.78, 0.12, 0.26, ST), 0, 0, 1.44));
  g.add(put(box(0.78, 0.24, 0.22, ST), 0, 0, 1.25));
  g.add(put(cyl(1.1, 1.13, 0.14, 8, pal.dark), 0, 0.24, 0, R8));
  g.add(put(cyl(1.0, 1.06, 1.36, 8, pal.main), 0, 0.38, 0, R8));
  g.add(put(cyl(1.16, 1.05, 0.16, 8, pal.trim), 0, 1.74, 0, R8));
  for (let i = 0; i < 8; i++) {
    const a = R8 + (i * Math.PI) / 4;
    g.add(put(box(0.17, 1.3, 0.3, pal.dark), Math.sin(a) * 1.08, 0.24, Math.cos(a) * 1.08, a));
    g.add(put(cone(0.09, 0.3, 4, pal.trim, NC), Math.sin(a) * 1.1, 1.9, Math.cos(a) * 1.1, a + Math.PI / 4));
  }
  for (let k = 1; k < 8; k++) {
    const a = (k * Math.PI) / 4, sx = Math.sin(a), cz = Math.cos(a);
    g.add(put(box(0.26, 0.54, 0.06, c.win, NC), sx * 0.96, 0.72, cz * 0.96, a));
    g.add(put(cyl(0.13, 0.13, 0.06, 6, c.win, { center: true, cast: false }), sx * 0.96, 1.26, cz * 0.96, a, Math.PI / 2));
    g.add(put(box(0.34, 0.05, 0.1, pal.trim, NC), sx * 0.98, 0.68, cz * 0.98, a));
  }
  // Door: gold arch frame + dark wood leaf hinged on the left.
  g.add(put(box(0.58, 0.78, 0.08, pal.trim, NC), 0, 0.24, 0.97));
  g.add(put(cyl(0.29, 0.29, 0.08, 8, pal.trim, { center: true, cast: false }), 0, 1.02, 0.97, 0, Math.PI / 2));
  const door = dyn(grp(g, -0.23, 0.25, 1.02));
  door.add(put(box(0.46, 0.76, 0.05, PAL.woodDark, NC), 0.23, 0, 0));
  door.add(put(cyl(0.23, 0.23, 0.05, 8, PAL.woodDark, { center: true, cast: false }), 0.23, 0.76, 0, 0, Math.PI / 2));
  door.add(put(sphere(0.035, pal.trim, NC), 0.4, 0.4, 0.04));
  // Rose window.
  g.add(put(flatDisc(0.15, 8, c.win), 0, 1.5, 0.97, 0, Math.PI / 2));
  g.add(put(torus(0.16, 0.035, 4, 8, pal.trim, NC), 0, 1.5, 0.99));
  // Drum, golden dome, lantern.
  g.add(put(cyl(0.8, 0.86, 0.42, 8, ST), 0, 1.9, 0, R8));
  for (let k = 0; k < 8; k++) { const a = (k * Math.PI) / 4; g.add(put(box(0.13, 0.2, 0.05, c.win, NC), Math.sin(a) * 0.8, 2.0, Math.cos(a) * 0.8, a)); }
  g.add(put(cyl(0.9, 0.9, 0.06, 8, pal.trim), 0, 2.32, 0, R8));
  g.add(put(mesh(G.dome(0.84, 8), mat(pal.trim)), 0, 2.36, 0, R8));
  for (let k = 0; k < 8; k++) {
    const a = R8 + (k * Math.PI) / 4;
    g.add(put(box(0.05, 0.05, 0.62, tint(pal.trim, -0.18), NC), Math.sin(a) * 0.52, 2.95, Math.cos(a) * 0.52, a, 0.72));
  }
  g.add(put(cyl(0.15, 0.18, 0.3, 8, ST), 0, 3.12, 0, R8));
  g.add(put(box(0.33, 0.12, 0.33, c.win, NC), 0, 3.2, 0, R8));
  g.add(put(cone(0.2, 0.36, 8, pal.trim), 0, 3.42, 0, R8));
  // Floating crystal with a golden halo.
  const crystal = dyn(grp(g, 0, 4.05, 0));
  const gem = mesh(G.oct(0.21), c.beacon, false);
  gem.scale.set(1, 1.55, 1);
  crystal.add(gem);
  const halo = dyn(grp(crystal, 0, 0, 0, 0, Math.PI / 2 - 0.4));
  halo.add(torus(0.4, 0.025, 3, 18, pal.trim, NC));
  for (let k = 0; k < 3; k++) { const a = (k * TAU) / 3; halo.add(put(mesh(G.oct(0.045), glow(pal.glow, 1.2), false), Math.cos(a) * 0.4, Math.sin(a) * 0.4, 0)); }
  return {
    group: g, door, doorMode: 'swing', doorOut: new THREE.Vector3(0, 0, 1.78), doorTop: 1.02, doorFace: 1.06, doorX: 0, doorW: 0.52,
    roof: new THREE.Vector3(0, 1.9, 0.95), chimney: new THREE.Vector3(0, 3.82, 0), smoke: 0xfff0c8, beacon: new THREE.Vector3(0, 4.05, 0),
    tick(dt, t, b) {
      crystal.rotation.y += dt * (b.state === 'thinking' ? 2.6 : b.state === 'working' ? 1.4 : 0.6);
      crystal.position.y = 4.05 + Math.sin(t * 1.6) * 0.09;
      halo.rotation.z += dt * 0.9;
    },
  };
}

function coreSonnet(c) {
  const { pal } = c;
  const g = new THREE.Group();
  const COND = 0x8f9aab;
  g.add(put(box(2.66, 0.16, 2.6, COND), 0, 0, 0));
  g.add(put(box(2.68, 0.06, 0.05, hazardMat(20, 0.45), NC), 0, 0.1, 1.29));
  // Main hall.
  g.add(put(box(2.34, 0.2, 1.96, pal.dark), 0, 0.16, 0.18));
  g.add(put(box(2.3, 1.1, 1.92, pal.main), 0, 0.36, 0.18));
  g.add(put(box(2.38, 0.08, 2.0, pal.trim), 0, 1.46, 0.18));
  for (const sx of [-1, 1]) g.add(put(box(0.1, 1.3, 0.1, pal.trim, NC), sx * 1.16, 0.16, 1.15));
  // Sawtooth roof on the right part.
  for (let i = 0; i < 3; i++) {
    const z0 = -0.78 + i * 0.64;
    g.add(put(mesh(G.tooth(0.64, 0.42, 1.24), mat(tint(pal.main, -0.14))), 0.5, 1.54, z0 + 0.32));
    g.add(put(box(1.14, 0.3, 0.03, c.win, NC), 0.5, 1.58, z0 + 0.645));
  }
  // Control tower + radar.
  g.add(put(box(0.92, 0.9, 0.92, tint(pal.main, 0.12)), -0.6, 1.54, -0.3));
  g.add(put(box(0.96, 0.26, 0.96, c.win, NC), -0.6, 1.98, -0.3));
  for (const o of [-0.24, 0.24]) {
    g.add(put(box(0.05, 0.26, 0.98, pal.dark, NC), -0.6 + o, 1.98, -0.3));
    g.add(put(box(0.98, 0.26, 0.05, pal.dark, NC), -0.6, 1.98, -0.3 + o));
  }
  g.add(put(box(1.02, 0.08, 1.02, pal.trim), -0.6, 2.44, -0.3));
  const radar = grp(g, -0.72, 2.52, -0.42);
  radar.add(cyl(0.04, 0.05, 0.3, 6, PAL.metalDark, NC));
  const yoke = dyn(grp(radar, 0, 0.3, 0));
  yoke.add(put(box(0.2, 0.05, 0.05, PAL.metalDark, NC), 0, 0, 0));
  const dish = grp(yoke, 0, 0.03, 0, 0, 1.35);
  dish.add(mesh(G.dish(0.28, 0.1), mat(0xb9c3d2, { side: THREE.DoubleSide })));
  dish.add(put(cyl(0.012, 0.012, 0.26, 4, PAL.metalDark, NC), 0, 0.02, 0));
  dish.add(put(sphere(0.035, glow(0xff4d4d, 1.2), NC), 0, 0.3, 0));
  // Beacon lamp on the tower corner.
  g.add(put(cyl(0.08, 0.09, 0.05, 8, pal.dark, NC), -0.24, 2.52, 0.06));
  g.add(put(cyl(0.065, 0.065, 0.14, 8, c.beacon, NC), -0.24, 2.57, 0.06));
  g.add(put(cone(0.07, 0.06, 8, pal.dark, NC), -0.24, 2.71, 0.06));
  // Smokestack.
  g.add(put(cyl(0.15, 0.2, 2.4, 8, 0xdde2ea), 0.84, 0.16, -0.5));
  g.add(put(cyl(0.165, 0.17, 0.14, 8, pal.trim, NC), 0.84, 1.92, -0.5));
  g.add(put(cyl(0.16, 0.162, 0.14, 8, pal.trim, NC), 0.84, 2.28, -0.5));
  g.add(put(cyl(0.18, 0.15, 0.08, 8, PAL.metalDark, NC), 0.84, 2.56, -0.5));
  // Roll-up hangar door with hazard band.
  g.add(put(box(1.34, 1.0, 0.08, pal.trim, NC), 0.2, 0.16, 1.12));
  g.add(put(box(1.18, 0.9, 0.02, 0x1d2230, NC), 0.2, 0.18, 1.165));
  const door = dyn(grp(g, 0.2, 0.2, 1.19));
  door.add(put(box(1.14, 0.86, 0.04, 0x566074, NC), 0, 0, 0));
  for (let i = 1; i < 6; i++) door.add(put(box(1.14, 0.025, 0.03, 0x3d4555, NC), 0, i * 0.143, 0.012));
  g.add(put(cyl(0.08, 0.08, 1.3, 8, pal.dark, { center: true, cast: false }), 0.2, 1.16, 1.19, 0, 0, Math.PI / 2));
  g.add(put(box(1.34, 0.13, 0.03, hazardMat(10, 1), NC), 0.2, 1.27, 1.175));
  // Windows + pipes.
  g.add(put(box(0.3, 0.3, 0.04, c.win, NC), -0.8, 0.72, 1.15));
  g.add(put(box(0.36, 0.05, 0.08, pal.trim, NC), -0.8, 0.68, 1.16));
  for (const z of [-0.45, 0.2, 0.8]) {
    g.add(put(box(0.04, 0.3, 0.34, c.win, NC), 1.16, 0.78, z));
    g.add(put(box(0.04, 0.3, 0.34, c.win, NC), -1.16, 0.78, z));
  }
  g.add(put(cyl(0.05, 0.05, 1.8, 6, pal.trim, { center: true, cast: false }), 1.21, 1.28, 0.18, 0, Math.PI / 2));
  g.add(put(cyl(0.05, 0.05, 1.8, 6, 0xc9d0da, { center: true, cast: false }), 1.21, 1.16, 0.18, 0, Math.PI / 2));
  return {
    group: g, door, doorMode: 'roll', doorOut: new THREE.Vector3(0.2, 0, 1.72), doorTop: 1.06, doorFace: 1.2, doorX: 0.2, doorW: 1.14,
    roof: new THREE.Vector3(-0.6, 2.52, 0.02), chimney: new THREE.Vector3(0.84, 2.72, -0.5), smoke: 0xd4dae4, beacon: new THREE.Vector3(-0.24, 2.64, 0.06),
    tick(dt, t, b) { yoke.rotation.y += dt * (b.state === 'working' ? 2.4 : b.state === 'asleep' ? 0 : 0.7); },
  };
}

function coreHaiku(c) {
  const { pal } = c;
  const g = new THREE.Group();
  const ST = 0xefe4cc, R6 = Math.PI / 6;
  g.add(put(cyl(1.26, 1.34, 0.16, 6, ST), 0, 0, 0, R6));
  g.add(put(box(0.6, 0.1, 0.3, ST), 0, 0, 1.28));
  const ROOF = 0xf0a42a, ROOF_L = 0xf7bd45;
  const tier = (y, rt, rb, h, eaveTop, eaveBot, eaveH, eaveY, stripeY) => {
    g.add(put(cyl(rt, rb, h, 6, pal.main), 0, y, 0, R6));
    g.add(put(cyl(rt + 0.05, rt + 0.06, 0.07, 6, pal.dark, NC), 0, stripeY, 0, R6));
    g.add(put(cyl(eaveTop, eaveBot, eaveH, 6, ROOF), 0, eaveY, 0, R6));
    g.add(put(cyl(eaveBot + 0.02, eaveBot + 0.02, 0.05, 6, pal.trim, NC), 0, eaveY - 0.03, 0, R6));
    for (let i = 0; i < 6; i++) {
      const a = R6 + (i * Math.PI) / 3;
      g.add(put(cone(0.07, 0.22, 4, pal.trim, NC), Math.sin(a) * (eaveBot + 0.02), eaveY - 0.04, Math.cos(a) * (eaveBot + 0.02), a, 0.75));
    }
  };
  tier(0.16, 0.98, 1.06, 0.76, 0.7, 1.34, 0.28, 0.9, 0.52);
  tier(1.16, 0.7, 0.76, 0.54, 0.48, 1.0, 0.24, 1.68, 1.42);
  g.add(put(cyl(0.46, 0.52, 0.42, 6, pal.main), 0, 1.92, 0, R6));
  g.add(put(cone(0.78, 0.6, 6, ROOF_L), 0, 2.32, 0, R6));
  g.add(put(cyl(0.8, 0.8, 0.05, 6, pal.trim, NC), 0, 2.3, 0, R6));
  for (let i = 0; i < 6; i++) {
    const a = R6 + (i * Math.PI) / 3;
    g.add(put(cone(0.06, 0.2, 4, pal.trim, NC), Math.sin(a) * 0.8, 2.28, Math.cos(a) * 0.8, a, 0.75));
  }
  g.add(put(cyl(0.03, 0.03, 0.2, 5, PAL.woodDark, NC), 0, 2.86, 0));
  g.add(put(ico(0.11, 0, c.beacon, NC), 0, 3.12, 0));
  // Honeycomb windows.
  const hex = (a, y, r, s = 0.12) => g.add(put(cyl(s, s, 0.05, 6, c.win, { center: true, cast: false }), Math.sin(a) * r, y, Math.cos(a) * r, a, Math.PI / 2));
  for (const a of [Math.PI / 3, -Math.PI / 3, (2 * Math.PI) / 3, (-2 * Math.PI) / 3]) { hex(a, 0.72, 0.9); hex(a + 0.2, 0.36, 0.92, 0.09); }
  for (const a of [0, Math.PI / 3, -Math.PI / 3, Math.PI]) hex(a, 1.3, 0.645, 0.1);
  hex(0, 2.12, 0.43, 0.09);
  // Round hive entrance with a round wooden door.
  g.add(put(flatDisc(0.3, 10, pal.dark), 0, 0.46, 0.9, 0, Math.PI / 2));
  g.add(put(torus(0.3, 0.05, 4, 12, tint(pal.dark, -0.2), NC), 0, 0.46, 0.93));
  const door = dyn(grp(g, -0.24, 0.46, 0.94));
  door.add(put(flatDisc(0.24, 10, PAL.wood), 0.24, 0, 0, 0, Math.PI / 2));
  door.add(put(box(0.36, 0.04, 0.02, PAL.woodDark, NC), 0.24, 0, 0.03));
  // Paper lantern (glows at night).
  g.add(put(cyl(0.008, 0.008, 0.16, 3, PAL.black, NC), 0.95, 0.72, 0.55));
  g.add(put(cyl(0.08, 0.08, 0.16, 8, c.win, NC), 0.95, 0.56, 0.55));
  // Cherry blossom tree growing out of the hive.
  const tree = grp(g, 0.42, 1.44, -0.36);
  const W = PAL.woodDark;
  tree.add(beam(0, 0, 0, 0.26, 0.62, -0.04, 0.13, W, true));
  tree.add(beam(0.26, 0.62, -0.04, 0.48, 1.18, -0.14, 0.11, W, true));
  tree.add(beam(0.48, 1.18, -0.14, 0.86, 1.4, -0.04, 0.07, W));
  tree.add(beam(0.48, 1.18, -0.14, 0.26, 1.58, -0.34, 0.07, W));
  const pinks = [0xff9ec7, 0xffc2dc, 0xff7fb4, 0xffb0d0];
  const blobs = [[0.52, 1.5, -0.14, 0.44, 1], [0.95, 1.46, 0.02, 0.34, 2], [0.26, 1.72, -0.36, 0.36, 3], [0.74, 1.84, -0.24, 0.32, 4], [0.1, 1.42, 0.05, 0.26, 5]];
  blobs.forEach(([x, y, z, r, s], i) => tree.add(put(mesh(G.blob(r, s), mat(pinks[i % pinks.length])), x, y, z)));
  // Drifting petals (core-local; emitted around the canopy).
  const pm = mat(0xffb3d1, { side: THREE.DoubleSide });
  const petals = [];
  const cx = 0.42 + 0.55, cy = 1.44 + 1.6, cz = -0.36 - 0.15;
  const spawn = (p, first) => {
    p.x = cx + (Math.random() - 0.5) * 0.9; p.z = cz + (Math.random() - 0.5) * 0.7;
    p.y = first ? 0.3 + Math.random() * 2.6 : cy + (Math.random() - 0.5) * 0.4;
    p.vy = 0.28 + Math.random() * 0.22; p.ph = Math.random() * TAU; p.sw = 0.5 + Math.random() * 0.6;
  };
  for (let i = 0; i < 9; i++) {
    const m = dyn(mesh(G.petal(), pm, false));
    m.receiveShadow = false;
    g.add(m);
    const p = { m };
    spawn(p, true);
    petals.push(p);
  }
  return {
    group: g, door, doorMode: 'swing', doorOut: new THREE.Vector3(0, 0, 1.62), doorTop: 0.7, doorFace: 0.97, doorX: 0, doorW: 0.48,
    roof: new THREE.Vector3(0, 1.16, 0.82), chimney: new THREE.Vector3(0, 3.2, 0), smoke: 0xffd7ea, beacon: new THREE.Vector3(0, 3.12, 0),
    tick(dt, t, b) {
      const wind = b.state === 'asleep' ? 0.12 : 0.3;
      for (const p of petals) {
        p.y -= p.vy * dt;
        p.x += wind * dt;
        p.z += Math.sin(t * p.sw * 2 + p.ph) * 0.25 * dt;
        if (p.y < 0.03 || p.x > 2.6) spawn(p, false);
        p.m.position.set(p.x, p.y, p.z);
        p.m.rotation.set(Math.sin(t * 2.3 + p.ph) * 0.9, t * p.sw + p.ph, Math.cos(t * 1.9 + p.ph) * 0.7);
      }
    },
  };
}

function coreFable(c) {
  const { pal } = c;
  const g = new THREE.Group();
  const HAT = 0x3d2c86, R8 = Math.PI / 8;
  g.add(put(cyl(1.12, 1.26, 0.26, 7, pal.dark), 0, 0, 0));
  g.add(put(box(0.6, 0.13, 0.3, tint(pal.dark, 0.2)), 0, 0, 1.2));
  const light = tint(pal.main, 0.2);
  const seg = (parent, x, y, z, tilt, rt, rb, h, col) => {
    const s = grp(parent, x, y, z, 0, 0, tilt);
    s.add(put(cyl(rt, rb, h, 8, col), 0, 0, 0, R8));
    s.add(put(cyl(rt + 0.05, rt + 0.05, 0.08, 8, pal.trim), 0, h - 0.04, 0, R8));
    return s;
  };
  const s0 = seg(g, 0, 0.26, 0, 0, 0.8, 0.88, 0.8, pal.main);
  const s1 = seg(s0, 0.03, 0.8, 0, 0.07, 0.7, 0.76, 0.7, light);
  const s2 = seg(s1, -0.02, 0.7, 0.02, -0.1, 0.6, 0.66, 0.6, pal.main);
  const s3 = seg(s2, 0.02, 0.6, 0, 0.12, 0.5, 0.56, 0.44, light);
  // Floppy wizard hat.
  const hat = grp(s3, 0, 0.44, 0, 0, 0, -0.06);
  hat.add(put(cyl(0.84, 0.84, 0.06, 10, HAT), 0, 0, 0));
  hat.add(put(cyl(0.3, 0.6, 0.62, 8, HAT), 0, 0.06, 0));
  hat.add(put(cyl(0.53, 0.57, 0.12, 8, pal.trim, NC), 0, 0.12, 0));
  const tip = grp(hat, 0, 0.66, 0, 0, 0, -0.62);
  tip.add(cone(0.3, 0.64, 8, HAT));
  const star = dyn(grp(tip, 0, 0.68, 0));
  star.add(mesh(G.star(0.15, 0.065, 0.06), c.beacon, false));
  for (let i = 0; i < 4; i++) hat.add(put(mesh(G.star(0.05, 0.022, 0.02), glow(pal.glow, 0.8), false), Math.sin(i * 1.7) * 0.42, 0.28 + (i % 2) * 0.16, Math.cos(i * 1.7) * 0.42, i * 1.7));
  // Moon window.
  s1.add(put(flatDisc(0.2, 10, 0x2a1030), 0, 0.36, 0.67, 0, Math.PI / 2));
  s1.add(put(mesh(G.crescent(0.16), c.win, false), 0, 0.36, 0.7));
  s1.add(put(torus(0.2, 0.035, 4, 12, pal.trim, NC), 0, 0.36, 0.7));
  // Arched windows.
  const win = (parent, a, y, r) => {
    parent.add(put(box(0.16, 0.26, 0.05, c.win, NC), Math.sin(a) * r, y, Math.cos(a) * r, a));
    parent.add(put(cyl(0.08, 0.08, 0.05, 6, c.win, { center: true, cast: false }), Math.sin(a) * r, y + 0.26, Math.cos(a) * r, a, Math.PI / 2));
  };
  win(s0, Math.PI / 2, 0.36, 0.78); win(s0, -Math.PI / 2, 0.36, 0.78); win(s0, Math.PI * 0.75, 0.36, 0.78);
  win(s2, Math.PI / 4, 0.2, 0.6); win(s2, -Math.PI / 3, 0.2, 0.6); win(s3, 0.3, 0.1, 0.5);
  // Door.
  s0.add(put(box(0.46, 0.62, 0.07, pal.trim, NC), 0, 0, 0.8));
  s0.add(put(cyl(0.23, 0.23, 0.07, 8, pal.trim, { center: true, cast: false }), 0, 0.62, 0.8, 0, Math.PI / 2));
  const door = dyn(grp(s0, -0.19, 0.01, 0.84));
  door.add(put(box(0.38, 0.6, 0.05, PAL.woodDark, NC), 0.19, 0, 0));
  door.add(put(cyl(0.19, 0.19, 0.05, 8, PAL.woodDark, { center: true, cast: false }), 0.19, 0.6, 0, 0, Math.PI / 2));
  // Balcony on s2.
  s2.add(put(cyl(0.84, 0.84, 0.06, 8, pal.trim), 0, 0, 0, R8));
  for (let i = 0; i < 8; i++) { const a = (i * TAU) / 8; s2.add(put(box(0.03, 0.18, 0.03, pal.trim, NC), Math.sin(a) * 0.8, 0.05, Math.cos(a) * 0.8)); }
  s2.add(put(torus(0.8, 0.022, 3, 16, pal.trim, NC), 0, 0.23, 0, 0, Math.PI / 2));
  const roofMark = grp(s2, 0, 0.06, 0.72);
  // Side turret.
  g.add(put(cyl(0.26, 0.3, 1.5, 6, tint(pal.main, -0.14)), -0.8, 0.26, -0.4));
  g.add(put(cone(0.38, 0.62, 6, HAT), -0.8, 1.76, -0.4));
  g.add(put(box(0.1, 0.16, 0.05, c.win, NC), -0.8, 1.2, -0.13));
  // Crooked chimney.
  const chim = grp(s2, 0.52, 0.2, -0.24, 0, 0, -0.28);
  chim.add(cyl(0.065, 0.075, 0.5, 6, PAL.metalDark));
  chim.add(put(cyl(0.09, 0.09, 0.06, 6, PAL.black, NC), 0, 0.5, 0));
  const chimMark = grp(chim, 0, 0.6, 0);
  // Giant quill in a giant inkpot.
  const ink = grp(g, 1.02, 0, 0.92);
  ink.add(cyl(0.2, 0.27, 0.34, 8, 0x262640));
  ink.add(put(cyl(0.21, 0.24, 0.1, 8, pal.trim, NC), 0, 0.12, 0));
  ink.add(put(cyl(0.12, 0.16, 0.08, 8, 0x262640, NC), 0, 0.34, 0));
  ink.add(put(cyl(0.11, 0.11, 0.02, 8, 0x0d0d1a, NC), 0, 0.42, 0));
  const quill = dyn(grp(ink, 0, 0.36, 0, Math.PI / 4, 0, -0.32));
  for (const ry of [0, Math.PI / 2]) {
    const f = put(mesh(G.feather(), mat(0xfff4dc)), 0, 0.14, 0, ry);
    f.scale.setScalar(1.35);
    quill.add(f);
    const tipF = put(mesh(G.feather(), mat(pal.trim), false), 0.01, 0.95, 0, ry);
    tipF.scale.setScalar(0.42);
    quill.add(tipF);
  }
  quill.add(put(cyl(0.014, 0.022, 1.45, 5, 0xb9ab8e, NC), 0, -0.12, 0));
  // Floating book pages.
  const pages = dyn(grp(g, 0, 0, 0));
  const pm = pageMat();
  const plist = [];
  for (let i = 0; i < 5; i++) {
    const m = dyn(mesh(sgeo('pageG', () => new THREE.BoxGeometry(0.28, 0.012, 0.2)), pm, false));
    pages.add(m);
    plist.push({ m, a: (i / 5) * TAU, r: 1.2 + (i % 2) * 0.18, y: 1.35 + i * 0.36, ph: i * 1.7 });
  }
  g.updateMatrixWorld(true);
  const roof = roofMark.getWorldPosition(new THREE.Vector3());
  const chimney = chimMark.getWorldPosition(new THREE.Vector3());
  const beacon = star.getWorldPosition(new THREE.Vector3());
  return {
    group: g, door, doorMode: 'swing', doorOut: new THREE.Vector3(0, 0, 1.62), doorTop: 1.05, doorFace: 1.14, doorX: 0, doorW: 0.42,
    roof, chimney, smoke: 0xe9c2ff, beacon,
    tick(dt, t, b) {
      const busy = b.state === 'working' ? 1 : 0;
      quill.rotation.z = -0.32 + Math.sin(t * (busy ? 7 : 1.2)) * (busy ? 0.12 : 0.05);
      quill.rotation.x = Math.cos(t * (busy ? 5.3 : 0.9)) * (busy ? 0.1 : 0.03);
      star.rotation.y += dt * 1.2;
      pages.rotation.y += dt * (b.state === 'asleep' ? 0.08 : 0.35);
      for (const p of plist) {
        p.m.position.set(Math.sin(p.a) * p.r, p.y + Math.sin(t * 1.3 + p.ph) * 0.14, Math.cos(p.a) * p.r);
        p.m.rotation.set(Math.sin(t * 2 + p.ph) * 0.5, p.a + Math.PI / 2, Math.cos(t * 1.7 + p.ph) * 0.35);
      }
    },
  };
}

function coreMerc(c) {
  const { pal } = c;
  const g = new THREE.Group();
  g.add(put(box(2.6, 0.12, 2.6, 0xa3aab5), 0, 0, 0));
  g.add(put(cyl(0.3, 0.3, 0.01, 8, 0x6b707c, NC), 0.78, 0.12, 1.12));
  g.add(put(cyl(0.16, 0.16, 0.01, 7, 0x6b707c, NC), 1.0, 0.12, 0.8));
  // Quonset hut with ribs.
  g.add(put(mesh(G.halfCyl(1.0, 2.12, 10), mat(pal.main)), 0, 0.12, -0.1));
  for (const z of [-1.12, -0.46, 0.24, 0.92]) g.add(put(torus(1.02, 0.035, 3, 10, pal.dark, { arc: Math.PI, cast: false }), 0, 0.12, z));
  g.add(put(mesh(G.halfCyl(0.99, 0.06, 10), mat(tint(pal.main, 0.24))), 0, 0.12, 0.96));
  g.add(put(torus(1.0, 0.05, 3, 10, pal.trim, { arc: Math.PI, cast: false }), 0, 0.12, 1.0));
  // Rust patches and a patch plate (it's a rental).
  g.add(put(box(0.3, 0.22, 0.02, 0xa0613c, NC), -0.56, 0.3, 1.0));
  g.add(put(box(0.32, 0.03, 0.28, 0x7c8494, { center: true, cast: false }), 0.76, 0.8, -0.3, 0, 0, -0.85));
  // Sliding door.
  g.add(put(box(1.1, 0.05, 0.06, pal.dark, NC), 0.2, 0.86, 1.02));
  g.add(put(box(0.8, 0.72, 0.03, 0x1d2230, NC), 0.18, 0.12, 0.995));
  const door = dyn(grp(g, 0.18, 0.12, 1.03));
  door.add(put(box(0.8, 0.72, 0.04, 0x59616f, NC), 0, 0, 0));
  for (const x of [-0.2, 0, 0.2]) door.add(put(box(0.025, 0.72, 0.03, 0x444b58, NC), x, 0, 0.012));
  door.add(put(box(0.06, 0.12, 0.04, pal.trim, NC), -0.32, 0.34, 0.03));
  // Portholes.
  g.add(put(flatDisc(0.12, 10, c.win), -0.52, 0.64, 1.0, 0, Math.PI / 2));
  g.add(put(torus(0.12, 0.03, 4, 10, pal.dark, NC), -0.52, 0.64, 1.02));
  const phi = 0.96;
  for (const z of [-0.72, 0.1]) {
    g.add(put(flatDisc(0.1, 10, c.win), Math.sin(phi) * 1.0, 0.12 + Math.cos(phi) * 1.0, z, 0, 0, -phi));
    g.add(put(flatDisc(0.1, 10, c.win), -Math.sin(phi) * 1.0, 0.12 + Math.cos(phi) * 1.0, z, 0, 0, phi));
  }
  // Stovepipe + antenna with the blinking beacon.
  g.add(put(cyl(0.06, 0.06, 0.62, 6, 0x6e7480), 0.5, 0.95, -0.62));
  g.add(put(cone(0.11, 0.1, 6, 0x4b505b, NC), 0.5, 1.57, -0.62));
  g.add(put(cyl(0.02, 0.03, 1.3, 5, PAL.metalDark, NC), -0.42, 0.95, -0.8));
  g.add(put(box(0.34, 0.02, 0.02, PAL.metalDark, NC), -0.42, 1.8, -0.8));
  g.add(put(box(0.22, 0.02, 0.02, PAL.metalDark, NC), -0.42, 2.02, -0.8));
  g.add(put(sphere(0.075, c.beacon, NC), -0.42, 2.3, -0.8));
  // Rooftop "FOR LEASE" billboard.
  const board = dyn(grp(g, 0, 1.08, 0.18, 0.35, -0.08));
  for (const x of [-0.46, 0.46]) board.add(put(box(0.05, 0.62, 0.05, PAL.woodDark), x, -0.08, -0.03));
  board.add(put(box(1.26, 0.52, 0.04, PAL.woodDark), 0, 0.22, -0.03));
  const sign = new THREE.Mesh(sgeo('leaseG', () => new THREE.PlaneGeometry(1.2, 0.47)), leaseMat());
  board.add(put(sign, 0, 0.475, 0.0));
  // Props: traffic cone, barrel.
  const coneG = grp(g, 1.02, 0.12, 1.1);
  coneG.add(box(0.26, 0.03, 0.26, 0xff7a1f, NC));
  coneG.add(put(cone(0.11, 0.32, 8, 0xff7a1f, NC), 0, 0.03, 0));
  coneG.add(put(cyl(0.065, 0.085, 0.06, 8, PAL.white, NC), 0, 0.12, 0));
  g.add(put(cyl(0.15, 0.15, 0.38, 8, 0xb5523b), -1.0, 0.12, 1.02));
  g.add(put(cyl(0.155, 0.155, 0.03, 8, 0x7a3526, NC), -1.0, 0.24, 1.02));
  g.add(put(cyl(0.155, 0.155, 0.03, 8, 0x7a3526, NC), -1.0, 0.4, 1.02));
  return {
    group: g, door, doorMode: 'slide', doorOut: new THREE.Vector3(0.18, 0, 1.6), doorTop: 0.84, doorFace: 1.06, doorX: 0.18, doorW: 0.8,
    roof: new THREE.Vector3(-0.1, 1.12, 0.62), chimney: new THREE.Vector3(0.5, 1.72, -0.62), smoke: 0x9aa0aa, beacon: new THREE.Vector3(-0.42, 2.3, -0.8),
    tick(dt, t) { board.rotation.z = Math.sin(t * 0.9) * 0.012; },
  };
}

const CORE_BUILDERS = { opus: coreOpus, sonnet: coreSonnet, haiku: coreHaiku, fable: coreFable, merc: coreMerc };

// ---- add-on modules ---------------------------------------------------------------------------------------
// Built at full size (level 3 footprint ~0.9) and scaled by MOD_SCALE[level]. tick(dt, t, active, building).

function modPad(g, c, lvl) {
  g.add(box(0.92, 0.07, 0.92, 0xa9b2c0));
  g.add(put(box(0.92, 0.02, 0.07, c.pal.trim, NC), 0, 0.07, 0.425));
  const pip = lvl >= 3 ? glow(0xffd447, 1.3) : glow(c.pal.glow, 1.0);
  for (let i = 0; i < lvl; i++) g.add(put(box(0.09, 0.045, 0.045, pip, NC), -0.33 + i * 0.13, 0.07, 0.46));
}

function modForge(c, lvl) {
  const g = new THREE.Group();
  modPad(g, c, lvl);
  g.add(put(box(0.44, 0.44, 0.4, c.pal.dark), -0.2, 0.07, -0.16));
  g.add(put(box(0.5, 0.07, 0.46, c.pal.main), -0.2, 0.51, -0.16));
  g.add(put(box(0.28, 0.2, 0.03, PAL.black, NC), -0.2, 0.14, 0.04));
  const fire = dyn(put(box(0.22, 0.14, 0.03, glow(0xff7a1a, 1.6), NC), -0.2, 0.15, 0.05));
  g.add(fire);
  let smokeAt = null;
  if (lvl >= 2) {
    g.add(put(cyl(0.06, 0.07, 0.4, 6, PAL.metalDark), -0.3, 0.58, -0.26));
    smokeAt = new THREE.Vector3(-0.3, 1.05, -0.26);
  }
  if (lvl >= 3) g.add(put(box(0.5, 0.05, 0.05, PAL.hazard, NC), -0.2, 0.44, 0.05));
  // Anvil.
  g.add(put(box(0.12, 0.12, 0.1, 0x3e4452), 0.2, 0.07, 0.14));
  g.add(put(box(0.3, 0.08, 0.14, 0x4a5163), 0.2, 0.19, 0.14));
  g.add(put(cone(0.05, 0.12, 4, 0x4a5163, NC), 0.41, 0.23, 0.14, 0, 0, -Math.PI / 2));
  if (lvl >= 3) g.add(put(box(0.1, 0.012, 0.06, glow(0x7af7ff, 1.3), NC), 0.2, 0.27, 0.14));
  // Robotic hammer arm.
  g.add(put(cyl(0.045, 0.06, 0.55, 6, c.pal.main), 0.2, 0.07, -0.26));
  g.add(put(sphere(0.06, c.pal.dark, NC), 0.2, 0.62, -0.26));
  const piv = dyn(grp(g, 0.2, 0.62, -0.26, 0, 0.3));
  piv.add(put(box(0.06, 0.06, 0.5, lvl >= 3 ? PAL.hazard : c.pal.trim, { center: true }), 0, 0, 0.25));
  piv.add(put(box(0.07, 0.12, 0.07, PAL.metalDark, { center: true, cast: false }), 0, -0.06, 0.5));
  piv.add(put(box(0.18, 0.1, 0.12, PAL.metal, { center: true }), 0, -0.14, 0.5));
  let ph = Math.random(), prevK = 0;
  return {
    group: g, smokeAt,
    tick(dt, t, active, b) {
      if (active) {
        ph += dt * 1.5;
        const k = ph % 1;
        let a;
        if (k < 0.62) a = lerp(0.36, -0.55, ease.inOut(k / 0.62));
        else if (k < 0.7) a = lerp(-0.55, 0.36, ease.inQuad((k - 0.62) / 0.08));
        else a = 0.36 - Math.sin(((k - 0.7) / 0.3) * Math.PI) * 0.06;
        piv.rotation.x = a;
        if (k >= 0.7 && prevK < 0.7) b._moduleSparks(g, 0.2, 0.32, 0.14);
        prevK = k;
        fire.scale.set(1, 0.75 + Math.random() * 0.5, 1);
      } else {
        piv.rotation.x = damp(piv.rotation.x, 0.3, 3, dt);
        fire.scale.y = 0.7 + Math.sin(t * 3) * 0.1;
      }
    },
  };
}

function modDrill(c, lvl) {
  const g = new THREE.Group();
  modPad(g, c, lvl);
  const H = 1.4, b = 0.28, tp = 0.07;
  for (const [x, z] of [[-b, -b], [b, -b], [b, b], [-b, b]]) g.add(beam(x, 0.07, z, Math.sign(x) * tp, H, Math.sign(z) * tp, 0.055, c.pal.main, true));
  for (const y of [0.42, 0.78, 1.1]) {
    const r = lerp(b, tp, (y - 0.07) / (H - 0.07));
    g.add(beam(-r, y, r, r, y, r, 0.035, c.pal.trim)); g.add(beam(-r, y, -r, r, y, -r, 0.035, c.pal.trim));
    g.add(beam(r, y, -r, r, y, r, 0.035, c.pal.trim)); g.add(beam(-r, y, -r, -r, y, r, 0.035, c.pal.trim));
  }
  const r0 = lerp(b, tp, (0.42 - 0.07) / (H - 0.07)), r1 = lerp(b, tp, (0.78 - 0.07) / (H - 0.07));
  g.add(beam(-r0, 0.42, r0 + 0.01, r1, 0.78, r1 + 0.01, 0.03, c.pal.trim));
  g.add(put(box(0.24, 0.1, 0.24, c.pal.dark), 0, H, 0));
  const wheel = dyn(grp(g, 0, H + 0.2, 0));
  wheel.add(put(cyl(0.1, 0.1, 0.04, 8, PAL.metal, { center: true, cast: false }), 0, 0, 0, 0, 0, Math.PI / 2));
  g.add(put(box(0.03, 0.12, 0.03, PAL.metalDark, NC), 0, H + 0.08, 0));
  const rod = dyn(grp(g, 0, 0, 0));
  rod.add(put(cyl(0.03, 0.03, 0.95, 6, PAL.metal, NC), 0, 0.3, 0));
  rod.add(put(cone(0.075, 0.2, 6, PAL.metalDark, NC), 0, 0.3, 0, 0, Math.PI));
  rod.add(put(box(0.12, 0.08, 0.12, c.pal.dark, NC), 0, 1.2, 0));
  g.add(put(cyl(0.12, 0.12, 0.012, 8, 0x1d1f2b, NC), 0, 0.07, 0));
  if (lvl >= 2) {
    g.add(put(cyl(0.1, 0.1, 0.34, 8, c.pal.trim), -0.33, 0.07, 0.3));
    g.add(put(sphere(0.1, c.pal.trim, NC), -0.33, 0.41, 0.3));
  }
  if (lvl >= 3) {
    g.add(put(cyl(0.012, 0.012, 0.4, 4, PAL.metalDark, NC), 0.1, H + 0.1, 0.1));
    g.add(put(box(0.18, 0.11, 0.012, PAL.hazard, NC), 0.19, H + 0.38, 0.1));
  }
  let ph = Math.random() * TAU, dust = 0;
  return {
    group: g,
    tick(dt, t, active, bld) {
      if (active) {
        ph += dt * 7;
        rod.position.y = 0.02 + (0.5 + 0.5 * Math.sin(ph)) * 0.22;
        wheel.rotation.x += dt * 9;
        dust -= dt;
        if (dust <= 0) { dust = 0.55; bld._modulePuff(g, 0, 0.12, 0.12, 0xc9b28a, 0.12); }
      } else {
        rod.position.y = damp(rod.position.y, 0.02, 4, dt);
      }
    },
  };
}

function modObservatory(c, lvl) {
  const g = new THREE.Group();
  modPad(g, c, lvl);
  g.add(put(cyl(0.34, 0.37, 0.42, 8, 0xeef1f7), 0, 0.07, 0, Math.PI / 8));
  g.add(put(cyl(0.375, 0.375, 0.06, 8, c.pal.main, NC), 0, 0.42, 0, Math.PI / 8));
  g.add(put(box(0.14, 0.24, 0.03, c.pal.dark, NC), 0, 0.07, 0.345));
  g.add(put(box(0.1, 0.08, 0.03, c.win, NC), 0.24, 0.26, 0.24, Math.PI / 4));
  const dome = dyn(grp(g, 0, 0.48, 0));
  dome.add(mesh(G.dome(0.35, 10), mat(0xd9dfeb)));
  dome.add(beam(0, 0.36, 0, 0, 0.04, 0.35, 0.1, 0x2a3150));
  const tele = dyn(grp(dome, 0, 0.12, 0, 0, -0.75));
  tele.add(put(cyl(0.055, 0.07, 0.58, 8, c.pal.main, { center: true }), 0, 0, 0.3, 0, Math.PI / 2));
  tele.add(put(cyl(0.075, 0.075, 0.04, 8, glow(c.pal.glow, 1.2), { center: true, cast: false }), 0, 0, 0.6, 0, Math.PI / 2));
  if (lvl >= 2) {
    g.add(put(cyl(0.012, 0.012, 0.36, 4, PAL.metalDark, NC), -0.3, 0.48, -0.2));
    g.add(put(sphere(0.035, glow(0xff4d4d, 1.2), NC), -0.3, 0.86, -0.2));
  }
  if (lvl >= 3) dome.add(put(mesh(G.star(0.09, 0.04, 0.03), glow(0xffd447, 1.1), false), 0, 0.46, 0));
  return {
    group: g,
    tick(dt, t, active) {
      if (active) { dome.rotation.y += dt * 1.1; tele.rotation.x = -0.75 + Math.sin(t * 1.4) * 0.28; } else dome.rotation.y += dt * 0.07;
    },
  };
}

function modRadar(c, lvl) {
  const g = new THREE.Group();
  modPad(g, c, lvl);
  g.add(put(cyl(0.14, 0.24, 0.3, 6, PAL.metalDark), 0, 0.07, 0));
  g.add(put(box(0.32, 0.18, 0.32, c.pal.main), 0, 0.37, 0));
  g.add(put(box(0.2, 0.06, 0.03, c.win, NC), 0, 0.44, 0.16));
  const yaw = dyn(grp(g, 0, 0.55, 0));
  yaw.add(cyl(0.05, 0.06, 0.16, 6, PAL.metal, NC));
  const tilt = dyn(grp(yaw, 0, 0.16, 0, 0, 0.7));
  tilt.add(mesh(G.dish(0.38, 0.14), mat(0xd6dde8, { side: THREE.DoubleSide })));
  for (let i = 0; i < 3; i++) { const a = (i * TAU) / 3; tilt.add(beam(Math.sin(a) * 0.33, 0.12, Math.cos(a) * 0.33, 0, 0.36, 0, 0.018, PAL.metalDark)); }
  tilt.add(put(cone(0.045, 0.09, 5, PAL.metalDark, NC), 0, 0.42, 0, 0, Math.PI));
  const tipLight = dyn(put(sphere(0.04, glow(0xff4d4d, 1.4), NC), 0, 0.44, 0));
  tilt.add(tipLight);
  if (lvl >= 3) {
    const d2 = grp(g, 0.24, 0.5, 0.2, 0.6, 1.1);
    d2.add(mesh(G.dish(0.14, 0.05), mat(0xeef2f8, { side: THREE.DoubleSide }), false));
  }
  return {
    group: g,
    tick(dt, t, active) {
      if (active) { yaw.rotation.y += dt * 2.4; tilt.rotation.x = 0.7 + Math.sin(t * 2.2) * 0.3; tipLight.visible = (t * 4) % 1 < 0.55; } else { yaw.rotation.y += dt * 0.22; tipLight.visible = (t * 0.8) % 1 < 0.3; }
    },
  };
}

function modBarracks(c, lvl) {
  const g = new THREE.Group();
  modPad(g, c, lvl);
  g.add(put(box(0.8, 0.38, 0.52, c.pal.main), 0, 0.07, -0.08));
  g.add(put(mesh(G.prism(0.62, 0.24, 0.9), mat(c.pal.dark)), 0, 0.45, -0.08, Math.PI / 2));
  g.add(put(box(0.24, 0.3, 0.02, PAL.black, NC), 0, 0.07, 0.185));
  const flap = dyn(grp(g, 0, 0.37, 0.2));
  flap.add(put(box(0.22, 0.29, 0.03, PAL.woodDark, NC), 0, -0.29, 0));
  for (const x of [-0.27, 0.27]) g.add(put(box(0.12, 0.1, 0.03, c.win, NC), x, 0.25, 0.185));
  g.add(put(cyl(0.012, 0.016, 0.7, 4, PAL.metalDark, NC), 0.38, 0.07, -0.36));
  const flag = dyn(grp(g, 0.38, 0.72, -0.36));
  flag.add(put(box(0.22, 0.13, 0.012, c.pal.trim, NC), 0.11, 0, 0));
  if (lvl >= 2) for (let i = 0; i < 3; i++) g.add(put(sphere(0.085, 0xc8b27e, { cast: false, segments: 6, rings: 4 }), -0.28 + i * 0.13, 0.11, 0.36));
  if (lvl >= 3) g.add(put(mesh(G.star(0.1, 0.045, 0.03), glow(0xffd447, 1.1), false), 0, 0.78, -0.08));
  return {
    group: g, flap,
    tick(dt, t, active) {
      if (active) { flap.rotation.x = -(0.5 + 0.5 * Math.sin(t * 10)) * 1.15; flag.rotation.y = Math.sin(t * 9) * 0.5; } else { flap.rotation.x = damp(flap.rotation.x, 0, 5, dt); flag.rotation.y = Math.sin(t * 2) * 0.3; }
    },
  };
}

function swirlMat(color) {
  return smat(`swirl${color}`, () => new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.6, side: THREE.DoubleSide, depthWrite: false }));
}

function modWarp(c, lvl) {
  const g = new THREE.Group();
  modPad(g, c, lvl);
  g.add(put(cyl(0.38, 0.42, 0.1, 8, PAL.metalDark), 0, 0.07, 0, Math.PI / 8));
  for (const sx of [-1, 1]) {
    g.add(put(box(0.1, 0.62, 0.14, c.pal.dark), sx * 0.37, 0.17, 0));
    g.add(put(box(0.11, 0.06, 0.15, glow(c.pal.glow, 1.3), NC), sx * 0.37, 0.8, 0));
  }
  const ring = grp(g, 0, 0.64, 0);
  ring.add(torus(0.3, 0.06, 5, 14, c.pal.main));
  for (let k = 0; k < 4; k++) ring.add(put(box(0.08, 0.08, 0.15, c.pal.trim, { center: true, cast: false }), Math.cos((k * Math.PI) / 2) * 0.3, Math.sin((k * Math.PI) / 2) * 0.3, 0, 0, 0, (k * Math.PI) / 2));
  const disc = dyn(mesh(G.circle(0.25, 12), swirlMat(c.pal.glow), false));
  ring.add(disc);
  // Motes on a static spiral inside a spinning group (one draw call).
  const mm = glow(tint(c.pal.glow, 0.3), 1.5);
  const swirl = dyn(grp(ring, 0, 0, 0.03));
  for (let i = 0; i < 8; i++) { const k = i / 8, r = 0.23 * (1 - k * 0.8), a = k * TAU * 1.5; swirl.add(put(mesh(G.oct(0.03 + 0.012 * (1 - k)), mm, false), Math.cos(a) * r, Math.sin(a) * r, 0)); }
  let outer = null;
  if (lvl >= 3) { outer = dyn(grp(g, 0, 0.64, 0)); outer.add(torus(0.42, 0.025, 3, 16, c.pal.trim, NC)); }
  let spin = 0;
  return {
    group: g,
    tick(dt, t, active) {
      const sp = active ? 5 : 0.9;
      spin += dt * sp;
      disc.rotation.z = spin * 0.4;
      disc.scale.setScalar(active ? 0.9 + 0.12 * Math.sin(t * 9) : 0.85);
      swirl.rotation.z = -spin * 1.3;
      swirl.scale.setScalar(active ? 0.95 + 0.1 * Math.sin(t * 7) : 1);
      if (outer) outer.rotation.y += dt * (active ? 3 : 0.5);
    },
  };
}

const MODULE_BUILDERS = { edit: modForge, bash: modDrill, read: modObservatory, web: modRadar, agent: modBarracks, mcp: modWarp };

// ---- context silo ---------------------------------------------------------------------------------------

function buildSilo(c, liquidMat, warnMat, topMat) {
  const g = new THREE.Group();
  g.add(cyl(0.53, 0.57, 0.16, 10, PAL.metalDark));
  const body = dyn(grp(g, 0, 0.16, 0));
  body.add(cyl(0.46, 0.46, 1.5, 10, mat(0xd8f7ff, { opacity: 0.2, transparent: true, depthWrite: false }), NC));
  const liquid = dyn(put(cyl(0.41, 0.41, 1, 10, liquidMat, NC), 0, 0.02, 0));
  body.add(liquid);
  const surface = dyn(put(mesh(G.circle(0.4, 10), topMat, false), 0, 0.5, 0, 0, -Math.PI / 2));
  body.add(surface);
  const bubbles = [];
  for (let i = 0; i < 3; i++) { const m = dyn(put(sphere(0.045, glow(0xffffff, 0.5), NC), (i - 1) * 0.16, 0.2, (i % 2) * 0.1 - 0.05)); body.add(m); bubbles.push({ m, ph: i * 0.37 }); }
  for (const y of [0.0, 0.74]) body.add(put(cyl(0.48, 0.48, 0.07, 10, c.pal.trim, { open: true, cast: false }), 0, y, 0));
  for (const f of [0.25, 0.5, 0.75]) body.add(put(box(0.12, 0.025, 0.02, PAL.black, NC), 0, 0.02 + 1.44 * f, 0.465));
  // Cap.
  body.add(put(cyl(0.5, 0.5, 0.08, 10, c.pal.dark), 0, 1.48, 0));
  body.add(put(cyl(0.22, 0.5, 0.26, 10, c.pal.main), 0, 1.56, 0));
  body.add(put(cyl(0.14, 0.16, 0.08, 8, c.pal.dark, NC), 0, 1.82, 0));
  for (const s of [-1, 1]) body.add(put(cyl(0.04, 0.04, 0.2, 6, PAL.metalDark, NC), s * 0.34, 1.58, -0.1, 0, 0, -s * 0.5));
  // Warning light (only above 80%).
  const warn = dyn(grp(body, 0, 1.9, 0));
  warn.add(cyl(0.07, 0.08, 0.05, 8, PAL.black, NC));
  warn.add(put(sphere(0.075, warnMat, NC), 0, 0.1, 0));
  const refl = dyn(grp(warn, 0, 0.1, 0));
  refl.add(put(box(0.02, 0.12, 0.17, PAL.metal, NC), 0, -0.06, 0));
  const beamM = new THREE.Mesh(sgeo('warnBeam', () => { const b = new THREE.ConeGeometry(0.22, 0.9, 6, 1, true); b.rotateZ(Math.PI / 2); b.translate(0.45, 0, 0); return b; }),
    smat('warnBeamM', () => new THREE.MeshBasicMaterial({ color: 0xff7a5a, transparent: true, opacity: 0.4, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending })));
  refl.add(beamM);
  warn.visible = false;
  // Ladder on the right side + base hatch.
  for (const z of [-0.09, 0.09]) g.add(put(box(0.025, 1.6, 0.025, PAL.metalDark, NC), 0.49, 0.16, z));
  for (let i = 0; i < 7; i++) g.add(put(box(0.02, 0.02, 0.2, PAL.metalDark, NC), 0.49, 0.32 + i * 0.2, 0));
  g.add(put(box(0.22, 0.22, 0.05, c.pal.dark, NC), -0.12, 0.02, 0.54, -0.25));
  mergeStatic(body);
  mergeStatic(g);
  return { group: g, body, liquid, surface, bubbles, warn, refl, top: 1.98, hatch: new THREE.Vector3(-0.16, 0.14, 0.62) };
}

// ---- props ------------------------------------------------------------------------------------------------

function buildTable() {
  const g = new THREE.Group();
  g.add(put(box(0.96, 0.05, 0.48, PAL.wood), 0, 0.4, 0));
  g.add(put(box(1.0, 0.025, 0.52, clothMat(), NC), 0, 0.445, 0));
  g.add(put(box(1.0, 0.1, 0.012, clothMat(), NC), 0, 0.37, 0.26));
  g.add(put(box(1.0, 0.1, 0.012, clothMat(), NC), 0, 0.37, -0.26));
  for (const x of [-0.36, 0.36]) {
    g.add(beam(x, 0, -0.22, x, 0.4, 0.05, 0.05, PAL.woodDark, true));
    g.add(beam(x, 0, 0.22, x, 0.4, -0.05, 0.05, PAL.woodDark, true));
  }
  for (const z of [-0.42, 0.42]) {
    g.add(put(box(0.96, 0.05, 0.16, PAL.wood), 0, 0.22, z));
    for (const x of [-0.36, 0.36]) g.add(put(box(0.05, 0.22, 0.1, PAL.woodDark, NC), x, 0, z));
  }
  return g;
}

function buildBannerPole(pal) {
  const g = new THREE.Group();
  g.add(cyl(0.1, 0.13, 0.12, 6, PAL.rockDark));
  g.add(cyl(0.035, 0.045, 3.0, 6, PAL.woodDark));
  g.add(put(sphere(0.07, pal.trim, NC), 0, 3.04, 0));
  g.add(put(cone(0.045, 0.2, 4, pal.trim, NC), 0, 3.08, 0));
  g.add(put(box(0.66, 0.05, 0.05, PAL.woodDark, NC), 0, 2.86, 0.04));
  const cloth = dyn(grp(g, 0, 2.84, 0.07));
  cloth.add(put(box(0.56, 1.2, 0.03, pal.trim), 0, -1.2, 0));
  cloth.add(put(box(0.48, 1.12, 0.035, pal.main, NC), 0, -1.16, 0.004));
  for (const s of [-1, 1]) cloth.add(put(box(0.2, 0.2, 0.03, pal.trim, { center: true, cast: false }), s * 0.14, -1.2, 0, 0, 0, Math.PI / 4));
  mergeStatic(g);
  const badges = grp(cloth, 0, 0, 0.03);
  return { group: g, cloth, badges };
}

// ---- state indicators ------------------------------------------------------------------------------------

function buildBubble(pal) {
  const g = new THREE.Group();
  const face = dyn(grp(g, 0, 0, 0));
  const W = mat(0xffffff, { emissive: 0xffffff, emissiveIntensity: 0.5 });
  for (const [x, y, r] of [[0, 0.55, 0.42], [-0.34, 0.5, 0.3], [0.34, 0.5, 0.3], [-0.14, 0.76, 0.3], [0.18, 0.78, 0.28]]) {
    const s = put(sphere(r, W, { cast: false, segments: 10, rings: 7 }), x, y, 0);
    s.scale.z = 0.62;
    face.add(s);
  }
  face.add(put(sphere(0.1, W, NC), -0.26, 0.08, 0));
  face.add(put(sphere(0.06, W, NC), -0.36, -0.12, 0));
  const g1 = dyn(put(mesh(G.gear(8, 0.2, 0.15, 0.06, 0.07), mat(pal.dark, { emissive: pal.dark, emissiveIntensity: 0.25 }), false), -0.1, 0.58, 0.28));
  const g2 = dyn(put(mesh(G.gear(6, 0.14, 0.1, 0.04, 0.07), mat(pal.trim, { emissive: pal.trim, emissiveIntensity: 0.25 }), false), 0.2, 0.7, 0.28));
  face.add(g1, g2);
  mergeStatic(g);
  return {
    group: g, base: 1,
    tick(dt, t, yaw) {
      face.rotation.y = yaw;
      g1.rotation.z -= dt * 2.4; g2.rotation.z += dt * 3.3;
      face.position.y = Math.sin(t * 2.2) * 0.06;
    },
  };
}

function buildHourglass() {
  const g = new THREE.Group();
  const flip = grp(g, 0, 0.55, 0);
  const glass = mat(0xd9f6ff, { opacity: 0.45, transparent: true, depthWrite: false });
  const sand = glow(0xffb13b, 0.9);
  for (const s of [-1, 1]) flip.add(put(box(0.5, 0.08, 0.5, 0xd9894a, { center: true, cast: false }), 0, s * 0.34, 0));
  for (const [x, z] of [[-0.19, -0.19], [0.19, -0.19], [0.19, 0.19], [-0.19, 0.19]]) flip.add(put(cyl(0.03, 0.03, 0.62, 5, 0xffd08a, { center: true, cast: false }), x, 0, z));
  flip.add(put(cone(0.19, 0.3, 8, glass, { center: true, cast: false }), 0, 0.15, 0, 0, Math.PI));
  flip.add(put(cone(0.19, 0.3, 8, glass, { center: true, cast: false }), 0, -0.15, 0));
  const top = dyn(put(cone(0.14, 0.2, 8, sand, { center: true, cast: false }), 0, 0.1, 0, 0, Math.PI));
  const bot = dyn(put(cone(0.16, 0.14, 8, sand, { center: true, cast: false }), 0, -0.23, 0));
  const stream = dyn(put(cyl(0.012, 0.012, 0.26, 4, sand, { center: true, cast: false }), 0, -0.13, 0));
  flip.add(top, bot, stream);
  dyn(flip);
  mergeStatic(g);
  let phase = 0;
  return {
    group: g, base: 1.3,
    tick(dt) {
      phase += dt / 3.2;
      const k = phase % 1;
      if (k < 0.82) {
        const f = k / 0.82;
        top.scale.setScalar(Math.max(0.05, 1 - f));
        bot.scale.setScalar(Math.max(0.05, f));
        stream.visible = true;
        flip.rotation.z = Math.floor(phase) % 2 ? Math.PI : 0;
      } else {
        stream.visible = false;
        flip.rotation.z = (Math.floor(phase) % 2 ? Math.PI : 0) + ease.inOut((k - 0.82) / 0.18) * Math.PI;
        top.scale.setScalar(0.05); bot.scale.setScalar(1);
        if (k > 0.99) { top.scale.setScalar(1); bot.scale.setScalar(0.05); }
      }
      g.rotation.y += dt * 0.4;
    },
  };
}

function buildBang(haloMat) {
  const g = new THREE.Group();
  const bob = grp(g, 0, 0, 0);
  const Y = mat(0xffd23f, { emissive: 0xffc21a, emissiveIntensity: 0.75 });
  const K = smat('bangOutline', () => new THREE.MeshBasicMaterial({ color: 0x2a1a00, side: THREE.BackSide }));
  const stem = cyl(0.19, 0.12, 0.78, 4, Y, NC);
  const dot = box(0.24, 0.24, 0.24, Y, { center: true, cast: false });
  const stemO = cyl(0.19, 0.12, 0.78, 4, K, NC);
  const dotO = box(0.24, 0.24, 0.24, K, { center: true, cast: false });
  put(stem, 0, 0.44, 0, Math.PI / 4); put(stemO, 0, 0.44, 0, Math.PI / 4); stemO.scale.set(1.22, 1.08, 1.22); stemO.position.y = 0.41;
  put(dot, 0, 0.16, 0, Math.PI / 4); put(dotO, 0, 0.16, 0, Math.PI / 4); dotO.scale.setScalar(1.25);
  bob.add(stem, dot, stemO, dotO);
  mergeStatic(dyn(bob));
  const halo = new THREE.Sprite(haloMat);
  halo.position.y = 0.7;
  halo.scale.setScalar(2.3);
  g.add(halo);
  return {
    group: g, base: 1.35, halo, bob,
    tick(dt, t, yaw, rm) {
      const k = rm ? 0.5 : Math.abs(Math.sin(t * 4.2));
      bob.position.y = k * 0.42;
      const sq = rm ? 1 : 1 + (1 - Math.min(1, k * 4)) * 0.18;
      bob.scale.set(sq, 2 - sq, sq);
      bob.rotation.y += dt * 1.6;
      haloMat.opacity = 0.35 + 0.3 * pulse(t * 8.4);
      halo.scale.setScalar(2.0 + 0.5 * pulse(t * 8.4));
      halo.position.y = 0.7 + bob.position.y;
    },
  };
}

function buildMoon() {
  const g = new THREE.Group();
  const face = grp(g, 0, 0.55, 0);
  const M = mat(0xfff1a8, { emissive: 0xffe27a, emissiveIntensity: 0.6 });
  const moon = dyn(put(mesh(G.crescent(0.3), M, false), 0, 0, 0, 0, 0, 0.5));
  face.add(moon);
  const stars = [];
  for (const [x, y, s] of [[0.42, 0.28, 0.06], [0.3, -0.26, 0.045], [-0.42, 0.34, 0.04]]) {
    const st = dyn(put(mesh(G.star(s, s * 0.45, 0.02), glow(0xfff6c9, 1.2), false), x, y, 0));
    face.add(st); stars.push(st);
  }
  return {
    group: g, base: 1,
    tick(dt, t, yaw) {
      face.rotation.y = yaw;
      moon.rotation.z = 0.5 + Math.sin(t * 0.9) * 0.15;
      face.position.y = 0.55 + Math.sin(t * 1.1) * 0.05;
      for (let i = 0; i < stars.length; i++) stars[i].scale.setScalar(0.6 + 0.5 * pulse(t * 2.5 + i * 2));
    },
  };
}

// ---- label ----------------------------------------------------------------------------------------------

const LABEL_CSS = `
.cnc-bld{display:flex;flex-direction:column;align-items:center;gap:2px;pointer-events:none;margin:0;padding:0 0 4px;
  font-family:"Chakra Petch",system-ui,sans-serif;line-height:1.1;white-space:nowrap;user-select:none;
  font-size:calc(12px * var(--ls,1));background:none;border:0;box-shadow:none;text-align:left}
.cnc-bld::after{content:'';display:block;width:0;height:0;margin-top:-1px;border:.4em solid transparent;border-top:.46em solid rgba(14,22,48,.85);border-bottom:0}
.cnc-bld .cb-r1{display:flex;align-items:center;gap:.42em;padding:.18em .42em .18em .22em;border-radius:.7em;margin:0;
  background:rgba(14,22,48,.88);border:2px solid rgba(255,197,61,.78);
  box-shadow:0 2px 0 rgba(0,0,0,.45),inset 0 1px 0 rgba(255,255,255,.14)}
.cnc-bld .cb-chip{display:inline-flex;align-items:center;justify-content:center;flex:none;width:1.3em;height:1.3em;border-radius:.34em;
  font:1em/1 "Lilita One","Arial Black",sans-serif;color:#fff;text-shadow:0 1px 0 rgba(0,0,0,.55);
  box-shadow:inset 0 -2px 0 rgba(0,0,0,.28),0 0 0 1px rgba(0,0,0,.4)}
.cnc-bld .cb-name{display:block;font-weight:700;font-size:1em;color:#fff;max-width:17em;overflow:hidden;text-overflow:ellipsis;
  text-shadow:0 1px 0 #000;letter-spacing:.01em}
.cnc-bld .cb-st{display:inline-block;flex:none;font:.86em/1 "Lilita One","Arial Black",sans-serif;letter-spacing:.05em;
  padding:.24em .42em .18em;border-radius:.42em;color:#08121f;background:#8fa3c0;text-transform:none}
.cnc-bld .cb-r2{display:flex;align-items:center;gap:.42em;padding:.12em .5em;border-radius:.5em;background:rgba(14,22,48,.78);margin:0}
.cnc-bld .cb-bar{display:block;position:relative;width:4.8em;height:.5em;border-radius:.25em;background:rgba(255,255,255,.14);
  overflow:hidden;box-shadow:inset 0 1px 1px rgba(0,0,0,.5)}
.cnc-bld .cb-bar>i{display:block;position:absolute;left:0;top:0;bottom:0;border-radius:.25em}
.cnc-bld .cb-ctx{font:.9em/1 "Lilita One","Arial Black",sans-serif;color:#cfe6ff;letter-spacing:.02em}
.cnc-bld.s-working .cb-st{background:#3ddc84}
.cnc-bld.s-thinking .cb-st{background:#b69cff}
.cnc-bld.s-waiting .cb-st{background:#ffb547}
.cnc-bld.s-needs_input .cb-st{background:#ffd23f;animation:cnc-bld-blink .8s ease-in-out infinite}
.cnc-bld.s-needs_input .cb-r1{border-color:#ffd23f;box-shadow:0 0 0 2px rgba(255,210,63,.35),0 0 14px rgba(255,210,63,.75),0 2px 0 rgba(0,0,0,.45)}
.cnc-bld.s-idle .cb-st{background:#ff9f5a}
.cnc-bld.s-asleep .cb-st{background:#6c7bc4;color:#e8ecff}
.cnc-bld.s-asleep .cb-r1,.cnc-bld.s-ended .cb-r1{border-color:rgba(160,170,200,.55)}
.cnc-bld.s-ended .cb-st{background:#e0524f;color:#fff}
.cnc-bld.s-ended{opacity:.8}
.cnc-bld.hot-ctx .cb-ctx{color:#ffb4a8}
@keyframes cnc-bld-blink{0%,100%{filter:brightness(1.25);transform:scale(1.06)}50%{filter:brightness(.8);transform:scale(.96)}}
.lod-far .cnc-bld .cb-r2{display:none}
.lod-far .cnc-bld .cb-name{max-width:9em}
.lod-far .cnc-bld:not(.s-needs_input) .cb-r1{padding:.12em .3em .12em .18em}
.hot .cnc-bld .cb-r2,.lod-far .hot .cnc-bld .cb-r2{display:flex}
`;

// ---- the Building -----------------------------------------------------------------------------------------

function factionOf(f) { return FACTIONS.has(f) ? f : 'merc'; }
function levelOf(n) { return n >= LEVEL_AT[2] ? 3 : n >= LEVEL_AT[1] ? 2 : n >= LEVEL_AT[0] ? 1 : 0; }
function toolCounts(s) {
  const t = s?.tools || {};
  return { edit: t.edit | 0, bash: t.bash | 0, read: (t.read | 0) + (t.search | 0), web: t.web | 0, agent: t.agent | 0, mcp: t.mcp | 0 };
}

export class Building {
  constructor(world, session, lot, island, opts = {}) {
    this.world = world || null;
    this.engine = world?.engine || null;
    this.island = island || null;
    this.session = session || {};
    this.key = this.session.key ?? this.session.sessionId ?? `bld-${Math.random().toString(36).slice(2)}`;
    this.faction = factionOf(this.session.faction);
    this.pal = factionPal(this.faction);
    this.rnd = rng(String(this.key));
    this.t = 0;
    this.state = null;
    this.stateT = 0;
    this._anims = [];
    this._ownMats = [];
    this._disposed = false;
    this._busy = null;
    this._endPromise = null;
    this._timers = { smoke: 0.3, ring: 0, anchors: 0, tumble: 3 + this.rnd() * 6, modsmoke: 0 };
    this._camYawLocal = Math.PI / 4;

    this.group = new THREE.Group();
    this.group.name = `Building:${this.key}`;
    this.group.userData.type = 'building';
    this.group.userData.key = this.key;
    this.grounds = grp(this.group);
    this.site = grp(this.group);
    this.fxl = grp(this.group);

    // Public anchors (world space; mutated in place so references stay current).
    this.door = new THREE.Vector3();
    this.roof = new THREE.Vector3();
    this.center = new THREE.Vector3();
    // lunch.table = ground point under the table centre; lunch.top = the tabletop; seats = bench seat surfaces.
    this.lunch = { table: new THREE.Vector3(), top: new THREE.Vector3(), seats: [0, 1, 2, 3].map(() => new THREE.Vector3()), facing: [0, 0, 0, 0] };
    this._spots = new Map();

    // Per-building animated materials.
    this.winMat = this._own(mat(0x1d2542, { emissive: PAL.window, emissiveIntensity: 0.8, unique: true }));
    this.beaconMat = this._own(mat(BEACON[this.faction], { emissive: BEACON[this.faction], emissiveIntensity: 1, unique: true }));
    this.liquidMat = this._own(mat(0x39e5ff, { emissive: 0x39e5ff, emissiveIntensity: 0.35, unique: true }));
    this.surfaceMat = this._own(mat(0xbff8ff, { emissive: 0xbff8ff, emissiveIntensity: 0.3, unique: true }));
    this.warnMat = this._own(mat(0xff3b30, { emissive: 0xff3b30, emissiveIntensity: 1.2, unique: true }));
    this.haloMat = this._own(new THREE.SpriteMaterial({ map: glowTex(), color: 0xffd23f, transparent: true, opacity: 0.5, depthWrite: false, blending: THREE.AdditiveBlending }));

    this.puffs = new Puffs(this.fxl);
    this.chunks = new Chunks(this.fxl);
    this.modules = new Map();
    this.gens = new Map();
    this.ind = {};
    this._zzz = null;
    this._winOn = 0.6;
    this._fill = 0;
    this._fillTarget = 0;
    this._fillHold = null;
    this._bricks = [];
    this._brickTarget = 0;
    this._brickSyncAt = 0;
    this._banner = { count: -1 };

    this.coreHolder = grp(this.site, CORE.x, 0, CORE.z);
    this._buildCore(this.faction);
    this.siloHolder = grp(this.site, SILO.x, 0, SILO.z);
    this._buildSilo();
    this._buildGrounds();

    this.labelAnchor = grp(this.group, CORE.x, this.core.top + 0.45, CORE.z);
    this.indAnchor = grp(this.group, CORE.x, this.core.top + 0.45, CORE.z);

    this.setLot(lot);
    this._sync(this.session, true, null, !!opts.instant);
    this._makeLabel();

    if (!opts.instant) {
      this._deferModules = true;
      this._construct('new');
    }
  }

  // ---- public API ------------------------------------------------------------------------------------------

  // Where a unit stands to do tool-category work near this base (world space, kept current).
  workSpot(cat) {
    const key = DEFAULT_SPOTS[cat] ? cat : 'other';
    let v = this._spots.get(key);
    if (!v) { v = new THREE.Vector3(); this._spots.set(key, v); this._spotFor(key, v); }
    return v;
  }

  // Move the building to a (new) lot; anchors follow.
  setLot(lot) {
    if (lot) this.lot = lot;
    const L = this.lot;
    if (L?.position) this.group.position.copy(L.position);
    this.group.rotation.y = L?.facing || 0;
    const s = L?.size >= 3 && L.size < 5 ? L.size / 5 : 1;
    this.group.scale.setScalar(s);
    this._refreshAnchors();
  }

  // opts.instant: the world is materializing (first snapshot after a gap, or nothing is being drawn): catch up
  // without one-shots or entrance animations.
  update(session, prev, opts) {
    if (!session || this._disposed || this._endPromise) return;
    try { this._sync(session, false, prev, !!opts?.instant); } catch (e) { console.error('[buildings] update failed', e); }
  }

  tick(dt, t) {
    if (this._disposed) return;
    dt = Math.min(Math.max(dt || 0, 0), 0.1);
    this.t += dt;
    this.stateT += dt;
    this._runAnims(dt);
    const night = 1 - this._daylight();
    const st = this.state;
    const rm = !!this.engine?.settings?.reduceMotion;
    this._camYawLocal = this._billboardYaw();

    // Windows.
    let on = this._lightsOff ? 0 : (WIN_ON[st] ?? 0.5);
    if (this._busy === 'construct' || this._busy === 'clear') on *= 0.25;
    if (st === 'working') on *= 0.94 + 0.06 * Math.sin(this.t * 11.3 + Math.sin(this.t * 3.1) * 2);
    this._winOn = damp(this._winOn, on, 3, dt);
    this.winMat.emissiveIntensity = this._winOn * (0.9 + 0.75 * night);

    // Beacon.
    let b = 0.3;
    const bm = this.beaconMat;
    if (this._lightsOff) b = 0;
    else if (st === 'needs_input') {
      const on2 = (this.t * 3) % 1 < 0.5;
      bm.emissive.setHex(on2 ? 0xffd23f : 0xff5a2a);
      bm.color.setHex(on2 ? 0xffd23f : 0xff5a2a);
      b = on2 ? 2.2 : 0.9;
    } else {
      if (this._beaconAlert) { bm.emissive.setHex(BEACON[this.faction]); bm.color.setHex(BEACON[this.faction]); }
      b = st === 'working' ? 0.7 + 0.8 * pulse(this.t * 4) : st === 'thinking' ? 0.5 + 0.8 * pulse(this.t * 1.8)
        : st === 'waiting' ? 0.4 + 0.4 * pulse(this.t * 1.0) : st === 'idle' ? 0.45 : st === 'asleep' ? 0.08 : 0.3;
    }
    this._beaconAlert = st === 'needs_input';
    bm.emissiveIntensity = b * (0.85 + 0.6 * night);

    // Core + modules.
    const core = this.core;
    if (core?.tick && !rm) core.tick(dt, this.t, this);
    else if (core?.tick && rm) core.tick(dt * 0.25, this.t * 0.25, this);
    const act = this._activeCat();
    for (const m of this.modules.values()) if (m.inst && !m.building) m.inst.tick(dt, this.t, m.cat === act && !this._busy, this);
    if (act && !this._busy) {
      const m = this.modules.get(act);
      if (m?.inst?.smokeAt) {
        this._timers.modsmoke -= dt;
        if (this._timers.modsmoke <= 0) { this._timers.modsmoke = 0.7; this._smoke(m.group, m.inst.smokeAt, 0xe6eaf0, 0.22); }
      }
    }

    this._tickSilo(dt, night);
    this._tickBricks(dt);
    this._tickGens(dt, night);
    this._tickIndicators(dt, rm);
    this._tickBanner();

    // Chimney smoke while working.
    if (st === 'working' && !this._busy && !this._lightsOff) {
      this._timers.smoke -= dt;
      if (this._timers.smoke <= 0) { this._timers.smoke = rm ? 1.2 : 0.55; this._smoke(this.coreHolder, core.chimney, core.smoke, 0.3); }
    }
    // needs_input: pulse a ground ring so it reads from across the room.
    if (st === 'needs_input' && !this._busy) {
      this._timers.ring -= dt;
      if (this._timers.ring <= 0) {
        this._timers.ring = 1.6;
        this.engine?.fx?.ring?.(this._wpos(CORE.x, 0.05, CORE.z), 0xffd23f, { radius: 3.4, secs: 1.1 });
      }
    }
    this._tickSleepy(dt);

    // Pending one-shots that never received their event.
    if (this._compactPending && this.t - this._compactPending.at > 1.6) { const p = this._compactPending; this._compactPending = null; this.compaction({ key: this.key, pre: p.pre, post: p.post, auto: true }); }
    if (this._clearPending && this.t - this._clearPending.at > 1.6) { this._clearPending = null; this.clear({ key: this.key, auto: true }); }
    if (this._deferModules && !this._busy) { this._deferModules = false; this._syncModules(false); }
    if (this._modsDirty && !this._busy) this._syncModules(false);

    this.puffs.update(dt);
    this.chunks.update(dt);

    this._timers.anchors -= dt;
    if (this._timers.anchors <= 0) { this._timers.anchors = 0.5; this._refreshAnchors(); }
    if (this._labelDirty) this._refreshLabel();
  }

  // One-shot: hydraulic press squashes the silo, fill drops, a Summary Brick pops onto the stack.
  compaction(ev = {}) {
    if (this._disposed || this._endPromise) return;
    this._compactPending = null;
    if (this._busy === 'compact') return;
    if (this._busy) { this._fillHold = null; return; }
    this._runCompaction(ev).catch((e) => { console.error('[buildings] compaction', e); this._afterCompaction(); });
  }

  // One-shot: controlled demolition, then a fresh level-0 building rises.
  clear(ev = {}) {
    if (this._disposed || this._endPromise) return;
    this._clearPending = null;
    if (this._busy === 'clear') return;
    if (this._lastClearAt != null && this.t - this._lastClearAt < 8) return;
    this._lastClearAt = this.t;
    const run = this._runClear(ev).catch((e) => { console.error('[buildings] clear', e); this._restoreAfterClear(); });
    this._clearRun = run;
    run.finally(() => { if (this._clearRun === run) this._clearRun = null; });
  }

  // Decommission: lights off -> CLOSED sign -> sinks into the ground in dust. Resolves when done. A /clear in flight
  // settles first (defused before the blast, or stopped short of its rebuild), so the base that closes is standing.
  end() {
    if (this._endPromise) return this._endPromise;
    this._endPromise = this._runEnd().catch((e) => { console.error('[buildings] end', e); });
    return this._endPromise;
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._anims.length = 0;   // pending sequences never resume on a disposed building
    try { this._label?.remove(); } catch { /* ignore */ }
    this._label = null;
    try { this._zzz?.stop?.(); } catch { /* ignore */ }
    this._zzz = null;
    this.puffs.clear();
    this.chunks.clear();
    disposeTree(this.group);
    for (const m of this._ownMats) m.dispose();
    this._ownMats.length = 0;
  }

  // Extras (optional hooks for units/world).
  openDoor(secs) {
    const hold = typeof secs === 'number' && Number.isFinite(secs) ? clamp(secs, 0, 10) : 1.2;
    const core = this.core;
    if (!core?.door || this._doorBusy || this._disposed) return;
    this._doorBusy = true;
    const d = core.door, mode = core.doorMode;
    const set = (k) => {
      if (mode === 'roll') { d.scale.y = Math.max(0.08, 1 - 0.88 * k); d.position.y = d.userData.y0 + 0.86 * 0.88 * k; }
      else if (mode === 'slide') d.position.x = d.userData.x0 + 0.72 * k;
      else d.rotation.y = -1.9 * k;
    };
    d.userData.y0 ??= d.position.y;
    d.userData.x0 ??= d.position.x;
    this._anim(0.25, set, ease.outCubic)
      .then(() => this._wait(hold))
      .then(() => this._anim(0.35, (k) => set(1 - k), ease.inOut))
      .then(() => { this._doorBusy = false; });
  }

  flashDoor() {
    const p = this.door;
    this.engine?.fx?.sparks?.(new THREE.Vector3(p.x, p.y + 0.6, p.z), this.pal.glow, { count: 10, speed: 2.5, size: 0.12 });
    this.openDoor(0.4);
  }

  // Top of the building (world y) for anyone who wants to float something above it.
  get height() { return this.core ? this.core.top : 3; }

  // ---- construction pieces -----------------------------------------------------------------------------

  _own(m) { this._ownMats.push(m); return m; }

  _ctx() { return { pal: this.pal, win: this.winMat, beacon: this.beaconMat }; }

  _buildCore(faction) {
    if (this.core) { disposeTree(this.core.group); this.core = null; }
    this.faction = factionOf(faction);
    this.pal = factionPal(this.faction);
    this.beaconMat.color.setHex(BEACON[this.faction]);
    this.beaconMat.emissive.setHex(BEACON[this.faction]);
    const core = (CORE_BUILDERS[this.faction] || coreMerc)(this._ctx());
    mergeStatic(core.group);
    core.group.updateMatrixWorld(true);
    const bb = new THREE.Box3().setFromObject(core.group);
    core.top = Math.max(2.2, bb.max.y);
    if (this.faction === 'opus') core.top = 4.35;
    this.coreHolder.add(core.group);
    this.core = core;
    if (this.labelAnchor) { this.labelAnchor.position.y = core.top + 0.45; this.indAnchor.position.y = core.top + 0.45; }
    this._refreshAnchors();
  }

  _buildSilo() {
    if (this.silo) disposeTree(this.silo.group);
    this.silo = buildSilo(this._ctx(), this.liquidMat, this.warnMat, this.surfaceMat);
    this.siloHolder.add(this.silo.group);
    this._applyFill(this._fill);
  }

  _buildGrounds() {
    const gr = this.grounds;
    // Stepping-stone path from the door to the lot edge.
    const stone = mat(0xd9d2c4);
    const dx = CORE.x + (this.core?.doorOut.x || 0);
    const path = grp(gr);
    [[0, 1.0, 0.28], [0.05, 1.46, 0.24], [-0.04, 1.9, 0.26], [0.03, 2.32, 0.22]].forEach(([x, z, r], i) => {
      path.add(put(cyl(r, r * 1.05, 0.05, 7, stone, NC), dx + x, 0, z, i));
    });
    mergeStatic(path);
    // Picnic table.
    this.table = mergeStatic(buildTable());
    put(this.table, TABLE.x, 0, TABLE.z);
    gr.add(this.table);
    // Veterancy banner.
    this.bannerPole = buildBannerPole(this.pal);
    put(this.bannerPole.group, BANNER.x, 0, BANNER.z);
    gr.add(this.bannerPole.group);
    // Brick pallet.
    this.pallet = grp(gr, BRICKS.x, 0, BRICKS.z);
    this.pallet.add(box(0.5, 0.06, 0.62, PAL.wood));
    for (const x of [-0.18, 0, 0.18]) this.pallet.add(put(box(0.06, 0.02, 0.62, PAL.woodDark, NC), x, 0.06, 0));
    mergeStatic(this.pallet);
  }

  _rebuildBanner() {
    const pole = this.bannerPole;
    for (const ch of [...pole.badges.children]) disposeTree(ch);
    const n = this._banner.count;
    const gold = glow(0xffd447, 0.55);
    if (n <= 0) {
      pole.badges.add(put(box(0.16, 0.16, 0.02, this.pal.trim, { center: true, cast: false }), 0, -0.55, 0, 0, 0, Math.PI / 4));
    } else if (n <= 5) {
      for (let i = 0; i < n; i++) pole.badges.add(put(mesh(G.chevron(), gold, false), 0, -0.2 - i * 0.2, 0));
    } else {
      pole.badges.add(put(mesh(G.star(0.2, 0.09, 0.03), gold, false), 0, -0.34, 0));
      const tag = textSign(`×${n}`, { w: 0.5, h: 0.34, bg: '#ffd447', fg: '#2b1d12', border: '#fff3c4', font: 'bold 220px "Lilita One", "Arial Black", sans-serif' });
      pole.badges.add(put(tag, 0, -0.76, 0.012));
    }
    if (n > 1 && n <= 5) mergeStatic(pole.badges);
  }

  // ---- data sync --------------------------------------------------------------------------------------

  // instant: on the first sync, the building is materialized (not constructed); on later syncs, the world is
  // materializing, so counters, bricks, fill and modules catch up at once and no one-shot is queued. The building's
  // clock only runs with frames: a press or demolition queued while nothing is drawn would play when the window is
  // shown again, however old it is.
  _sync(s, first, prev, instant = false) {
    const old = this.session;
    this.session = s;
    // Faction swap (model changed): rebuild the core in place.
    const f = factionOf(s.faction);
    if (!first && f !== this.faction && !this._busy && !this._endPromise) {
      this._buildCore(f);
      this._rebuildTints();
      if (!instant) this._construct('refit');
    }
    // Context fill.
    const max = s.context?.max || 0, used = s.context?.used || 0;
    this._fillTarget = max > 0 ? clamp(used / max, 0, 1) : 0;
    // Compactions (bricks).
    const comp = s.compactions | 0;
    if (first) {
      this._fill = this._fillTarget; this._applyFill(this._fill);
      this._seenComp = comp; this._brickTarget = comp; this._setBricks(comp);
      this._seenClears = s.clears | 0;
    } else if (instant) {
      this._compactPending = null;
      this._clearPending = null;
      this._seenComp = comp;
      this._seenClears = s.clears | 0;
      this._brickTarget = comp;
      if (!this._compacting) {         // a press already under way lands its brick, then syncs to _brickTarget
        this._fillHold = null;
        this._fill = this._fillTarget; this._applyFill(this._fill);
        this._setBricks(comp);
      }
      if (this._busy) this._modsDirty = true; else this._syncModules(true);
    } else {
      if (comp > (this._seenComp | 0)) {
        if (!this._busy || this._busy === 'construct') this._compactPending ??= { at: this.t, pre: s.lastCompaction?.pre, post: s.lastCompaction?.post };
        this._fillHold ??= this._fill;
      }
      this._seenComp = comp;
      if (comp !== this._brickTarget) { this._brickTarget = comp; this._brickSyncAt = this.t + 2.2; }
      const clears = s.clears | 0;
      if (clears > (this._seenClears | 0)) { this._clearPending ??= { at: this.t }; this._fillHold ??= this._fill; }
      this._seenClears = clears;
      if (!this._clearPending && this._busy !== 'clear') this._modsDirty = true;
      // New agents -> open the door so they can pop out.
      const before = new Set((old?.agents || []).map((a) => a.id));
      if ((s.agents || []).some((a) => !before.has(a.id) && a.state !== 'done' && a.state !== 'failed')) this.openDoor(1.4);
    }
    // Veterancy.
    const vet = s.agentsDone | 0;
    if (vet !== this._banner.count) {
      const up = !first && !instant && vet > this._banner.count && this._banner.count >= 0;
      this._banner.count = vet;
      this._rebuildBanner();
      if (up) { const p = this.bannerPole.group.position; this.engine?.fx?.sparks?.(this._wpos(p.x, 2.2, p.z + 0.1), 0xffd447, { count: 12, speed: 2.5, size: 0.12 }); }
    }
    // Generators.
    this._syncGens(first || instant);
    // Modules (first sync: instant, unless the building is still going to be constructed).
    if (first && instant) this._syncModules(true);
    // State.
    this._setState(s.state || 'idle', first || instant);
    this._labelDirty = true;
  }

  _rebuildTints() {
    // Faction-colored grounds (banner) follow a faction swap.
    const pos = this.bannerPole.group.position.clone();
    disposeTree(this.bannerPole.group);
    this.bannerPole = buildBannerPole(this.pal);
    this.bannerPole.group.position.copy(pos);
    this.grounds.add(this.bannerPole.group);
    this._rebuildBanner();
    this._buildSilo();
    for (const m of [...this.modules.values()]) this._removeModule(m.cat, false);
    this._modsDirty = true;
  }

  _setState(st, instant) {
    if (st === this.state) return;
    const prevSt = this.state;
    this.state = st;
    this.stateT = 0;
    this.winMat.emissive.setHex(st === 'idle' ? 0xffa04a : st === 'working' ? 0xffdf70 : PAL.window);
    if (!instant && st === 'needs_input') this._timers.ring = 0;
    if (!instant && prevSt === 'asleep' && st !== 'asleep') {
      this.engine?.fx?.sparks?.(this._wpos(CORE.x, this.core.top * 0.6, CORE.z), this.pal.glow, { count: 10, speed: 2, size: 0.12 });
    }
    this._labelDirty = true;
  }

  _activeCat() {
    const st = this.state;
    if (st !== 'working' && st !== 'waiting') return null;
    const c = this.session?.tool?.cat;
    if (!c) return null;
    return c === 'search' ? 'read' : c;
  }

  // ---- modules ----------------------------------------------------------------------------------------

  _syncModules(instant) {
    this._modsDirty = false;
    if (this._busy === 'clear' || this._endPromise) return;
    const counts = toolCounts(this.session);
    const cats = MOD_CATS.slice().sort((a, b) => counts[b] - counts[a]);
    let delay = 0;
    for (const cat of cats) {
      const lvl = levelOf(counts[cat]);
      const m = this.modules.get(cat);
      const cur = m?.level || 0;
      if (lvl === cur) continue;
      if (lvl > cur) {
        if (instant) this._placeModule(cat, lvl, false);
        else { this._placeModule(cat, lvl, true, delay); delay += 0.9; }
      } else if (!this._clearPending) {
        if (lvl === 0) this._removeModule(cat, !instant); else this._placeModule(cat, lvl, false);
      }
    }
  }

  _placeModule(cat, lvl, animate, delay = 0) {
    let m = this.modules.get(cat);
    const isNew = !m;
    if (!m) {
      const used = new Set([...this.modules.values()].map((x) => x.slot));
      const slot = MOD_SLOTS.findIndex((_, i) => !used.has(i));
      if (slot < 0) return;
      m = { cat, slot, level: 0, group: grp(this.site, MOD_SLOTS[slot].x, 0, MOD_SLOTS[slot].z), inst: null, building: false };
      this.modules.set(cat, m);
    }
    const prevLevel = m.level;
    m.level = lvl;
    const build = () => {
      if (this._disposed || this.modules.get(cat) !== m || m.level !== lvl) return;
      if (m.inst) { disposeTree(m.inst.group); m.inst = null; }
      m.inst = MODULE_BUILDERS[cat](this._ctx(), lvl);
      mergeStatic(m.inst.group);
      m.inst.group.scale.setScalar(MOD_SCALE[lvl]);
      m.group.add(m.inst.group);
      this._refreshSpots();
    };
    if (!animate) { build(); return; }
    m.building = true;
    const slot = MOD_SLOTS[m.slot];
    (async () => {
      if (delay) await this._wait(delay);
      if (this._disposed || this.modules.get(m.cat) !== m) return;
      const sc = makeScaffold(0.95, 1.05, 0.95);
      put(sc, slot.x, 0, slot.z);
      sc.scale.y = 0.01;
      this.fxl.add(sc);
      this._dust(slot.x, 0.1, slot.z, 6, 0.7);
      await this._tween(sc.scale, { y: 1 }, 0.35, ease.outBack);
      build();
      const g = m.inst?.group;
      if (g) {
        const s = MOD_SCALE[lvl], s0 = isNew ? 0.01 : MOD_SCALE[prevLevel] || 0.01;
        g.scale.set(s0, s0 * 0.2, s0);
        this._sparks(slot.x, 0.8, slot.z, 0xffd66b);
        await this._anim(0.7, (k) => { g.scale.set(lerp(s0, s, k), Math.max(0.001, lerp(s0 * 0.2, s, k)), lerp(s0, s, k)); }, ease.outBack);
      }
      this._dust(slot.x, 0.1, slot.z, 8, 0.8);
      await this._tween(sc.scale, { y: 0.01 }, 0.25, ease.inCubic);
      disposeTree(sc);
      m.building = false;
      const txt = isNew ? `+ ${MOD_NAME[cat]}` : `${MOD_NAME[cat]} Lv.${lvl}`;
      this._text(slot.x, 1.5, slot.z, txt, cssHex(this.pal.glow), 0.62);
    })().catch((e) => { console.error(e); m.building = false; });
  }

  _removeModule(cat, animate) {
    const m = this.modules.get(cat);
    if (!m) return;
    this.modules.delete(cat);
    if (animate && m.inst) {
      const slot = MOD_SLOTS[m.slot];
      this._dust(slot.x, 0.1, slot.z, 8, 0.8);
      const g = m.group;
      this._tween(g.scale, { x: 0.01, y: 0.01, z: 0.01 }, 0.4, ease.inCubic).then(() => disposeTree(g));
    } else disposeTree(m.group);
    this._refreshSpots();
  }

  // ---- generators ------------------------------------------------------------------------------------

  // first: materializing (the first sync, or the world catching up): no rise/wind-down animations.
  _syncGens(first) {
    const procs = (this.session.procs || []).slice(0, GEN_SLOTS.length);
    const seen = new Set();
    for (const p of procs) {
      const id = String(p.pid ?? p.name);
      seen.add(id);
      let g = this.gens.get(id);
      if (!g) {
        const used = new Set([...this.gens.values()].filter((x) => !x.dying).map((x) => x.slot));
        const slot = GEN_SLOTS.findIndex((_, i) => !used.has(i));
        if (slot < 0) continue;
        g = this._makeGen(slot);
        this.gens.set(id, g);
        if (!first) {
          g.group.scale.setScalar(0.01);
          this._tween(g.group.scale, { x: 1, y: 1, z: 1 }, 0.5, ease.outBack);
          this._dust(GEN_SLOTS[slot][0], 0.05, GEN_SLOTS[slot][1], 4, 0.4);
        }
      }
      g.cpu = Math.max(0, +p.cpu || 0);
    }
    for (const [id, g] of this.gens) {
      if (seen.has(id) || g.dying) continue;
      if (first) { disposeTree(g.group); this.gens.delete(id); continue; }   // materializing: gone at once
      g.dying = true;
      this._anim(1.2, (k) => { g.power = 1 - k; }).then(async () => {
        const [x, z] = GEN_SLOTS[g.slot];
        this._dust(x, 0.05, z, 5, 0.45);
        await this._tween(g.group.scale, { x: 0.01, y: 0.01, z: 0.01 }, 0.3, ease.inCubic);
        disposeTree(g.group);
        if (this.gens.get(id) === g) this.gens.delete(id);
      });
    }
    const overflow = Math.max(0, (this.session.procs || []).length - GEN_SLOTS.length);
    if (overflow !== this._genOverflow) {
      this._genOverflow = overflow;
      if (this._genTag) { disposeTree(this._genTag); this._genTag = null; }
      if (overflow > 0) {
        const [x, z] = GEN_SLOTS[GEN_SLOTS.length - 1];
        this._genTag = put(textSign(`+${overflow}`, { w: 0.4, h: 0.26, bg: '#20242f', fg: '#ffd447', border: '#ffd447', font: 'bold 220px "Lilita One", "Arial Black", sans-serif' }), x, 0.78, z + 0.05);
        this.grounds.add(this._genTag);
      }
    }
  }

  _makeGen(slot) {
    const [x, z] = GEN_SLOTS[slot];
    const pal = this.pal;
    const group = grp(this.grounds, x, 0, z);
    group.add(box(0.36, 0.26, 0.32, PAL.metalDark));
    group.add(put(box(0.4, 0.05, 0.36, pal.trim, NC), 0, 0.26, 0));
    const core = dyn(put(box(0.38, 0.06, 0.34, glow(pal.glow, 0.3), NC), 0, 0.12, 0));
    group.add(core);
    group.add(put(cyl(0.03, 0.03, 0.1, 6, PAL.metalDark, NC), 0, 0.31, 0));
    const rotor = dyn(grp(group, 0, 0.41, 0));
    for (let i = 0; i < 3; i++) rotor.add(put(box(0.24, 0.014, 0.07, 0xe3e8f0, NC), Math.cos((i * TAU) / 3) * 0.12, 0, Math.sin((i * TAU) / 3) * 0.12, -(i * TAU) / 3, 0, 0.35));
    group.add(put(cyl(0.025, 0.025, 0.18, 5, PAL.metalDark, NC), 0.13, 0.26, -0.1));
    mergeStatic(group);
    return { slot, group, core, rotor, cpu: 0, power: 1, lvl: -1, dying: false, spin: 0 };
  }

  _tickGens(dt, night) {
    for (const g of this.gens.values()) {
      const load = clamp(g.cpu, 0, 1.5);
      const p = this._lightsOff ? 0 : g.power;
      g.spin = damp(g.spin, (1.5 + load * 16) * p, 2, dt);
      g.rotor.rotation.y += g.spin * dt;
      const lvl = Math.round(clamp((0.15 + load * 1.2) * p * (0.8 + 0.4 * night), 0, 1.6) * 5) / 5;
      if (lvl !== g.lvl) { g.lvl = lvl; g.core.material = glow(this.pal.glow, lvl); }
    }
  }

  // ---- silo ------------------------------------------------------------------------------------------

  _applyFill(f) {
    const s = this.silo;
    if (!s) return;
    s.liquid.scale.y = Math.max(0.001, f * 1.42);
    s.liquid.visible = f > 0.002;
    rampColor(f, _c);
    this.liquidMat.color.copy(_c);
    this.liquidMat.emissive.copy(_c);
    _c.lerp(_ra.setHex(0xffffff), 0.5);
    this.surfaceMat.color.copy(_c);
    this.surfaceMat.emissive.copy(_c);
    const top = 0.02 + 1.42 * f;
    s.surface.position.y = top + 0.004;
    s.surface.visible = f > 0.002;
    for (const b of s.bubbles) b.m.visible = f > 0.08;
    s._top = top;
  }

  _tickSilo(dt, night) {
    const s = this.silo;
    if (!s) return;
    if (this._fillHold != null && !this._compacting && !this._compactPending && !this._clearPending && this._busy !== 'clear') this._fillHold = null;
    if (!this._compacting) {
      const target = this._fillHold ?? this._fillTarget;
      if (Math.abs(target - this._fill) > 0.0005) { this._fill = damp(this._fill, target, 2.5, dt); this._applyFill(this._fill); }
    }
    const f = this._fill;
    this.liquidMat.emissiveIntensity = 0.12 + 0.55 * night + (f > 0.8 ? 0.22 * pulse(this.t * 6) : 0);
    this.surfaceMat.emissiveIntensity = 0.25 + 0.6 * night;
    // Bubbles.
    const top = s._top || 0.1;
    for (const b of s.bubbles) {
      if (!b.m.visible) continue;
      const k = (this.t * 0.35 + b.ph) % 1;
      b.m.position.y = 0.05 + k * Math.max(0.05, top - 0.1);
    }
    // Danger zone.
    const hot = f > 0.8 && !this._lightsOff;
    s.warn.visible = hot;
    if (!this._compacting) {
      const bulge = hot ? 1.11 + 0.045 * Math.sin(this.t * 5.5) : 1;
      s.body.scale.x = damp(s.body.scale.x, bulge, 6, dt);
      s.body.scale.z = s.body.scale.x;
    }
    if (hot) {
      s.refl.rotation.y += dt * 7;
      this.warnMat.emissiveIntensity = 0.9 + 0.8 * pulse(this.t * 14);
      this._timers.steam = (this._timers.steam ?? 0) - dt;
      if (this._timers.steam <= 0) {
        this._timers.steam = 0.35 + Math.random() * 0.3;
        const side = Math.random() < 0.5 ? -1 : 1;
        this._siloPuff(side * 0.44, 1.86, -0.1, side);
      }
    }
  }

  _siloPuff(x, y, z, side) {
    const w = this._wposOf(this.siloHolder, x, y, z);
    const fx = this.engine?.fx;
    if (fx?.puff) fx.puff(w, { color: 0xffffff, count: 2, size: 0.32, spread: 0.35, rise: 0.9, life: 0.8 });
    else this.puffs.emit(SILO.x + x, y, SILO.z + z, { color: 0xffffff, size: 0.2, vx: side * 0.7, vy: 0.9, life: 0.9 });
  }

  // ---- bricks ----------------------------------------------------------------------------------------

  _brickSlot(i, out) {
    const layer = Math.floor(i / 2), j = i % 2;
    const alongX = layer % 2 === 0;
    out.set(alongX ? 0 : (j ? 0.085 : -0.085), 0.08 + layer * 0.105, alongX ? (j ? 0.085 : -0.085) : 0);
    return alongX ? Math.PI / 2 : 0;
  }

  _makeBrick() {
    const m = box(0.3, 0.1, 0.15, glow(0xffd447, 0.55), { center: true });
    m.add(put(box(0.18, 0.012, 0.155, glow(0xfff3c4, 0.9), { center: true, cast: false }), 0, 0.02, 0));
    return m;
  }

  _setBricks(n) {
    const show = Math.min(n, 12);
    if (show !== this._bricks.length) {
      if (this._brickStack) disposeTree(this._brickStack);
      this._brickStack = grp(this.pallet);
      this._bricks = [];
      for (let i = 0; i < show; i++) {
        const m = this._makeBrick();
        const ry = this._brickSlot(i, m.position);
        m.position.y += 0.05;
        m.rotation.y = ry;
        this._brickStack.add(m);
        this._bricks.push(m);
      }
      mergeStatic(this._brickStack);
    }
    this._brickCount = n;
    if (this._brickTagN !== (n > 12 ? n : 0)) {
      this._brickTagN = n > 12 ? n : 0;
      if (this._brickTag) { disposeTree(this._brickTag); this._brickTag = null; }
      if (n > 12) {
        this._brickTag = put(textSign(`×${n}`, { w: 0.44, h: 0.28, bg: '#ffd447', fg: '#2b1d12', border: '#fff3c4', font: 'bold 220px "Lilita One", "Arial Black", sans-serif' }), 0, 1.55, 0.1);
        this.pallet.add(this._brickTag);
      }
    }
  }

  _tickBricks() {
    if (this._compacting) return;
    if (this._brickCount !== this._brickTarget && this.t >= this._brickSyncAt) this._setBricks(this._brickTarget);
  }

  // ---- banner ------------------------------------------------------------------------------------------

  _tickBanner() {
    const c = this.bannerPole?.cloth;
    if (!c) return;
    c.rotation.y = Math.sin(this.t * 1.3) * 0.14;
    c.rotation.x = Math.sin(this.t * 0.9 + 1) * 0.04;
  }

  // ---- indicators -------------------------------------------------------------------------------------

  _wantInd(name) {
    if (this._busy === 'clear' || this._endPromise) return false;
    const st = this.state;
    return (name === 'bubble' && st === 'thinking') || (name === 'hourglass' && st === 'waiting') || (name === 'bang' && st === 'needs_input' && !this.bigAlert) || (name === 'moon' && st === 'asleep');
  }

  _tickIndicators(dt, rm) {
    let ext = 0;
    for (const name of ['bubble', 'hourglass', 'bang', 'moon']) {
      const want = this._wantInd(name);
      let ind = this.ind[name];
      if (!ind) {
        if (!want) continue;
        ind = this.ind[name] = name === 'bubble' ? buildBubble(this.pal) : name === 'hourglass' ? buildHourglass() : name === 'bang' ? buildBang(this.haloMat) : buildMoon();
        ind.k = 0;
        this.indAnchor.add(ind.group);
      }
      ind.k = approach(ind.k, want ? 1 : 0, dt * (want ? 2.4 : 4));
      const vis = ind.k > 0.001;
      ind.group.visible = vis;
      if (!vis) continue;
      let s = (want ? ease.outBack(ind.k) : ind.k * ind.k) * ind.base;
      if (name === 'bang') s *= this._farBoost();
      ind.group.scale.setScalar(Math.max(0.001, s));
      ind.tick(dt, this.t, this._camYawLocal, rm);
      ext = Math.max(ext, IND_H[name] * Math.max(0, s));
    }
    const ly = this.core.top + 0.6 + ext;
    this.labelAnchor.position.y = Math.abs(ly - this.labelAnchor.position.y) > 2 ? ly : damp(this.labelAnchor.position.y, ly, 5, dt);
    // Zzz (engine DOM effect when available, else drifting sprites).
    const sleepy = this.state === 'asleep' && !this._endPromise && !this._busy;
    const fx = this.engine?.fx;
    if (sleepy && !this._zzz) {
      try { if (fx?.zzz && this.engine?.labels) this._zzz = fx.zzz(this.indAnchor, { offset: new THREE.Vector3(0.95, 0.55, 0) }); } catch (e) { this._zzz = null; }
      if (!this._zzz) this._zzz = this._spriteZzz();
    } else if (!sleepy && this._zzz) { try { this._zzz.stop?.(); } catch { /* ignore */ } this._zzz = null; }
    this._zzz?.tick?.(dt);
  }

  _spriteZzz() {
    const items = [];
    for (let i = 0; i < 3; i++) {
      const m = new THREE.SpriteMaterial({ map: zTex(), transparent: true, depthWrite: false });
      const sp = new THREE.Sprite(m);
      this.indAnchor.add(sp);
      items.push({ sp, m, ph: i / 3 });
    }
    return {
      tick: (dt) => {
        for (const it of items) {
          it.ph = (it.ph + dt * 0.33) % 1;
          const k = it.ph;
          it.sp.position.set(0.3 + k * 0.7, 0.7 + k * 1.2, 0);
          it.sp.scale.setScalar(0.2 + k * 0.35);
          it.m.opacity = k < 0.15 ? k / 0.15 : 1 - (k - 0.15) / 0.85;
        }
      },
      stop: () => { for (const it of items) { this.indAnchor.remove(it.sp); it.m.dispose(); } },
    };
  }

  // Scale the "!" up when zoomed far out so it stays the loudest thing on the map.
  _farBoost() {
    const cam = this.engine?.camera, r = this.engine?.renderer;
    if (!cam?.isOrthographicCamera || !r?.domElement) return 1;
    const h = r.domElement.clientHeight || 900;
    const ppu = (h * cam.zoom) / Math.max(1e-3, cam.top - cam.bottom);
    return clamp(52 / (1.35 * ppu), 1, 3);
  }

  _billboardYaw() {
    const cam = this.engine?.camera;
    let yaw = Math.PI / 4;
    if (cam) { cam.getWorldDirection(_v2); yaw = Math.atan2(-_v2.x, -_v2.z); }
    return yaw - (this.group.rotation.y || 0);
  }

  // ---- sleepy extras -----------------------------------------------------------------------------------

  _tickSleepy(dt) {
    const s = this.session;
    const now = this.engine?.serverNow?.() ?? Date.now();
    const idleH = s?.lastActivity ? (now - s.lastActivity) / 3.6e6 : 0;
    const dusty = this.state === 'asleep' && idleH >= 2 && !this._busy && !this._endPromise;
    if (dusty && !this._webs) this._addCobwebs();
    else if (!dusty && this._webs) { for (const w of this._webs) disposeTree(w); this._webs = null; }
    if (dusty) {
      this._timers.tumble -= dt;
      if (this._timers.tumble <= 0 && !this._tumble) { this._timers.tumble = 25 + Math.random() * 25; this._rollTumbleweed(); }
    }
  }

  _addCobwebs() {
    const c = this.core;
    const g = grp(this.coreHolder, 0, 0, 0);
    const m = cobwebMat();
    const geo = sgeo('webG', () => new THREE.PlaneGeometry(0.46, 0.46));
    const l = new THREE.Mesh(geo, m);
    put(l, c.doorX - c.doorW / 2 + 0.2, c.doorTop + 0.02, c.doorFace + 0.05);
    l.scale.set(1, -1, 1);
    const r = new THREE.Mesh(geo, m);
    put(r, c.doorX + c.doorW / 2 - 0.2, c.doorTop + 0.02, c.doorFace + 0.05);
    r.scale.set(-1, -1, 1);
    g.add(l, r);
    const s = new THREE.Mesh(geo, m);
    put(s, 0.25, 1.6, 0.5, Math.PI / 4);
    s.scale.set(-0.8, -0.8, 0.8);
    this.siloHolder.add(s);
    this._webs = [g, s];
  }

  _rollTumbleweed() {
    const t = grp(this.fxl, -3.2, 0, 1.3);
    const a = mesh(G.blob(0.2, 11), mat(0xc9a66b), true);
    const b = mesh(G.blob(0.16, 12), mat(0xa9844f), false);
    b.rotation.set(1, 2, 0.5);
    t.add(a, b);
    this._tumble = t;
    this._anim(5.5, (k) => {
      const x = lerp(-3.2, 3.4, k);
      t.position.set(x, 0.2 + Math.abs(Math.sin(k * Math.PI * 6)) * 0.3 * (1 - k * 0.5), 1.3 + Math.sin(k * 5) * 0.2);
      t.rotation.z = -x / 0.2;
    }).then(() => { disposeTree(t); this._tumble = null; });
  }

  // ---- one-shot sequences ------------------------------------------------------------------------------

  async _construct(kind) {
    const token = (this._buildToken = (this._buildToken || 0) + 1);
    this._busy = 'construct';
    const holder = this.coreHolder, core = this.core;
    const h = Math.min(3.2, core.top * 0.82);
    const sc = makeScaffold(2.9, h, 2.9);
    put(sc, CORE.x, 0, CORE.z);
    sc.scale.y = 0.01;
    this.fxl.add(sc);
    try {
      await this._constructSteps(kind, token, sc, holder, h);
    } finally {
      disposeTree(sc);
      if (this._buildToken === token && this._busy === 'construct') {
        this._busy = null;
        holder.scale.set(1, 1, 1);
        this.siloHolder.scale.set(1, 1, 1);
      }
    }
  }

  async _constructSteps(kind, token, sc, holder, h) {
    holder.scale.set(0.9, 0.001, 0.9);
    const siloFresh = kind !== 'refit';
    if (siloFresh) this.siloHolder.scale.set(0.001, 0.001, 0.001);
    this._dust(CORE.x, 0.1, CORE.z, 10, 1.3);
    await this._tween(sc.scale, { y: 1 }, 0.45, ease.outBack);
    if (this._buildToken !== token || this._disposed || this._endPromise) return;
    let acc = 0;
    await this._anim(1.5, (k, raw) => {
      if (this._buildToken !== token) return;      // superseded (a /clear, or end() raising the base itself)
      holder.scale.set(lerp(0.9, 1, raw), Math.max(0.001, k), lerp(0.9, 1, raw));
      const tt = raw * 1.5;
      if (tt - acc > 0.22) {
        acc = tt;
        this._dust(CORE.x + (Math.random() - 0.5) * 2.6, 0.1, CORE.z + 1.3, 3, 0.6);
        if (Math.random() < 0.6) this._sparks(CORE.x + (Math.random() - 0.5) * 2.4, 0.5 + Math.random() * h, CORE.z + 1.45, 0xffd66b);
      }
    }, ease.outBack);
    if (this._buildToken !== token || this._disposed || this._endPromise) return;
    holder.scale.set(1, 1, 1);
    if (siloFresh) {
      this._tween(this.siloHolder.scale, { x: 1, y: 1, z: 1 }, 0.6, ease.outBack);
    }
    await this._wait(0.25);
    await this._tween(sc.scale, { y: 0.01 }, 0.35, ease.inCubic);
    if (this._buildToken !== token || this._disposed || this._endPromise) return;
    this.siloHolder.scale.set(1, 1, 1);
    this._dust(CORE.x, 0.1, CORE.z, 12, 1.4);
    this._busy = null;
    this._text(CORE.x, this.core.top + 0.4, CORE.z, 'Construction complete.', '#9cff7a', 0.9);
    this._modsDirty = true;
  }

  async _runCompaction(ev) {
    const s = this.silo;
    if (!s) return;
    const tok = (this._compToken = (this._compToken || 0) + 1);
    this._busy = 'compact';
    this._compacting = true;
    this.engine?.bus?.emit?.('building:compaction', { key: this.key, building: this });
    const max = this.session.context?.max || 0;
    const pre = ev.pre != null && max ? clamp(ev.pre / max, 0, 1) : (this._fillHold ?? this._fill);
    const post = ev.post != null && max ? clamp(ev.post / max, 0, 1) : this._fillTarget;
    this._fill = Math.max(pre, 0.05);
    this._applyFill(this._fill);
    // The press drops in from the sky.
    const top = s.top + 0.16;
    const press = this._makePress();
    this._press = press;
    const pg = press.group;
    put(pg, SILO.x, top + 7, SILO.z);
    this.fxl.add(pg);
    press.ram.position.y = 1.1;
    let brick = null;
    // A /clear cancels the press (it bumps _compToken): drop the props, unsquash the silo and leave fill, bricks and
    // _busy to the clear.
    const live = () => tok === this._compToken;
    const gone = () => {
      if (live()) return false;
      if (this._press === press) this._press = null;
      if (pg.parent) disposeTree(pg);
      if (brick?.parent) disposeTree(brick);
      if (this.silo === s) s.body.scale.set(1, 1, 1);
      return true;
    };
    await this._anim(0.5, (k) => { pg.position.y = top + 7 * (1 - k); }, ease.outCubic);
    if (gone()) return;
    this._dust(SILO.x, 0.1, SILO.z, 4, 0.5);
    await this._tween(press.ram.position, { y: 1.3 }, 0.22, ease.outQuad);
    if (gone()) return;
    // SLAM.
    await this._tween(press.ram.position, { y: 0 }, 0.11, ease.inCubic);
    if (gone()) return;
    this._text(SILO.x, top + 1.6, SILO.z, 'KA-CHUNK!', '#ffd23f', 1.35);
    this._dust(SILO.x, 0.1, SILO.z, 12, 1.2);
    this._sparks(SILO.x, top, SILO.z, 0xffffff);
    const body = s.body;
    const squash = 0.58;
    await this._anim(0.1, (k) => {
      if (!live()) return;
      const sy = lerp(1, squash, k);
      body.scale.set(lerp(1, 1.24, k), sy, lerp(1, 1.24, k));
      press.ram.position.y = -(1 - sy) * (top - 0.16);
    });
    if (gone()) return;
    // Fill drops while squashed.
    await this._anim(0.55, (k) => { if (live()) { this._fill = lerp(pre, post, k); this._applyFill(this._fill); } }, ease.inOut);
    if (gone()) return;
    // Retract + spring back.
    this._anim(0.8, (k) => {
      if (!live()) return;
      const sy = lerp(squash, 1, k);
      const sx = lerp(1.24, 1, k);
      body.scale.set(sx, Math.max(0.3, sy), sx);
    }, ease.outElastic);
    await this._tween(press.ram.position, { y: 1.2 }, 0.35, ease.outCubic);
    if (gone()) return;
    // Summary Brick pops out of the hatch and lands on the stack.
    const idx = Math.min(this._bricks.length, 11);
    brick = this._makeBrick();
    const from = new THREE.Vector3(SILO.x + s.hatch.x, s.hatch.y, SILO.z + s.hatch.z);
    const slotLocal = new THREE.Vector3();
    const ry = this._brickSlot(idx, slotLocal);
    const to = new THREE.Vector3(BRICKS.x + slotLocal.x, slotLocal.y + 0.05, BRICKS.z + slotLocal.z);
    brick.position.copy(from);
    this.fxl.add(brick);
    this._sparks(from.x, from.y + 0.1, from.z, 0xffd447);
    await this._anim(0.62, (k) => {
      brick.position.set(lerp(from.x, to.x, k), lerp(from.y, to.y, k) + Math.sin(k * Math.PI) * 1.3, lerp(from.z, to.z, k));
      brick.rotation.set(k * TAU, ry * k, k * Math.PI);
    });
    if (gone()) return;
    brick.rotation.set(0, ry, 0);
    this._sparks(to.x, to.y + 0.1, to.z, 0xffd447);
    this._anim(0.3, (k) => { brick.scale.set(1 + 0.3 * Math.sin(k * Math.PI), 1 - 0.25 * Math.sin(k * Math.PI), 1 + 0.3 * Math.sin(k * Math.PI)); });
    // The press leaves.
    await this._anim(0.45, (k) => { pg.position.y = top + 8 * k * k; }, ease.linear);
    if (gone()) return;
    disposeTree(pg);
    if (this._press === press) this._press = null;
    await this._wait(0.2);
    if (gone()) return;
    disposeTree(brick);
    this._afterCompaction(true);
  }

  _afterCompaction(landed = false) {
    this._compacting = false;
    this._fillHold = null;
    if (this.silo) this.silo.body.scale.set(1, 1, 1);
    if (this._busy === 'compact') this._busy = null;
    if (landed) this._setBricks(this._brickCount + 1);
    this._brickTarget = this.session.compactions | 0;
    this._brickSyncAt = this.t + 1.5;
  }

  _makePress() {
    const g = new THREE.Group();
    const pal = this.pal;
    // Housing (fixed within the press) + ram (plate + rod) that slides.
    g.add(put(cyl(0.27, 0.27, 1.25, 8, pal.main), 0, 1.35, 0));
    g.add(put(box(0.95, 0.34, 0.95, pal.dark), 0, 2.58, 0));
    g.add(put(box(1.0, 0.1, 1.0, hazardMat(6, 0.8), NC), 0, 2.5, 0));
    for (const s of [-1, 1]) {
      g.add(put(sphere(0.07, glow(0xff4d4d, 1.3), NC), s * 0.34, 2.97, 0.34));
      g.add(put(cyl(0.04, 0.04, 0.12, 6, PAL.black, NC), s * 0.34, 2.9, 0.34));
    }
    const label = textSign('10,000 T', { w: 0.8, h: 0.24, bg: '#1d1f2b', fg: '#ffd23f', border: '#ffc53d', font: 'bold 120px "Lilita One", "Arial Black", sans-serif' });
    g.add(put(label, 0, 2.75, 0.48));
    const ram = grp(g, 0, 1.1, 0);
    ram.add(box(1.16, 0.24, 1.16, PAL.metalDark));
    ram.add(put(box(1.18, 0.08, 1.18, hazardMat(8, 0.6), NC), 0, 0.08, 0));
    ram.add(put(cyl(0.13, 0.13, 1.3, 8, PAL.metal), 0, 0.24, 0));
    return { group: g, ram };
  }

  async _runClear() {
    this._busy = 'clear';
    this._buildToken = (this._buildToken || 0) + 1;   // an unfinished construction stops where it is
    this._compToken = (this._compToken || 0) + 1;     // so does a press (it removes its own props)
    this._compacting = false;
    this.engine?.bus?.emit?.('building:clear', { key: this.key, building: this });
    // Dynamite bundles pop onto the base, fuses fizz.
    const spots = [[-1.05, 1.05], [1.05, 1.05], [1.05, -1.05], [-1.05, -1.05]].map(([x, z]) => [CORE.x + x, CORE.z + z]);
    spots.push([SILO.x - 0.45, SILO.z + 0.4]);
    const bundles = [];
    for (let i = 0; i < spots.length; i++) {
      const b = this._makeDynamite();
      put(b.group, spots[i][0], 0, spots[i][1], this.rnd() * TAU);
      b.group.scale.setScalar(0.01);
      this.fxl.add(b.group);
      bundles.push(b);
      this._tween(b.group.scale, { x: 1, y: 1, z: 1 }, 0.3, ease.outBack);
      await this._wait(0.08);
    }
    // Detonator plunger in front of the door.
    const det = this._makeDetonator();
    put(det.group, CORE.x - 0.55, 0, 2.2, 0.5);
    det.group.scale.setScalar(0.01);
    this.fxl.add(det.group);
    await this._tween(det.group.scale, { x: 1, y: 1, z: 1 }, 0.3, ease.outBack);
    // Ended before the blast: defuse (the base stays standing for end()).
    const defuse = () => { for (const b of bundles) disposeTree(b.group); disposeTree(det.group); };
    if (this._endPromise) return defuse();
    this._text(CORE.x, this.core.top + 0.2, CORE.z, 'FIRE IN THE HOLE!', '#ffb547', 0.8);
    let acc = 0;
    await this._anim(1.0, (k, raw) => {
      for (const b of bundles) { b.spark.position.y = lerp(0.62, 0.36, raw); b.spark.scale.setScalar(0.8 + Math.random() * 0.6); }
      if (raw - acc > 0.18) { acc = raw; const b = bundles[(Math.random() * bundles.length) | 0]; const p = b.group.position; this._sparks(p.x, 0.6, p.z, 0xffd23f, 5); }
    });
    await this._tween(det.handle.position, { y: 0.18 }, 0.12, ease.inCubic);
    if (this._endPromise) return defuse();
    // BOOM.
    for (const b of bundles) disposeTree(b.group);
    disposeTree(det.group);
    if (this._press) { disposeTree(this._press.group); this._press = null; }
    const fx = this.engine?.fx;
    const center = this._wpos(CORE.x, 1.2, CORE.z);
    if (fx?.flash) fx.flash(center, { color: 0xfff3c4, size: 6, secs: 0.45 });
    else this._flash(CORE.x, 1.2, CORE.z);
    fx?.ring?.(this._wpos(CORE.x, 0.05, CORE.z), 0xffb547, { radius: 5, secs: 0.8 });
    this._text(CORE.x, this.core.top + 0.6, CORE.z, 'CLEARED!', '#ff5a3a', 1.7);
    const colors = [this.pal.main, this.pal.trim, this.pal.dark, PAL.metal, this.pal.main];
    // Hide everything that gets demolished.
    this.coreHolder.visible = false;
    this.siloHolder.visible = false;
    for (const m of this.modules.values()) m.group.visible = false;
    if (fx?.debris) {
      fx.debris(center, colors, { count: 30, power: 0.75, size: 0.5, floor: this._wpos(0, 0, 0).y });
      fx.debris(this._wpos(SILO.x, 1, SILO.z), [0xc8f4ff, rampColor(this._fill, _c).getHex(), this.pal.trim], { count: 10, power: 0.6, size: 0.35, floor: this._wpos(0, 0, 0).y });
    } else {
      this.chunks.burst(CORE.x, 0.4, CORE.z, 26, colors, { power: 1, spread: 1.2, size: 0.36 });
      this.chunks.burst(SILO.x, 0.4, SILO.z, 8, [0xc8f4ff, this.pal.trim], { power: 0.8, spread: 0.4, size: 0.26 });
    }
    for (const m of this.modules.values()) {
      const sl = MOD_SLOTS[m.slot];
      if (fx?.debris) fx.debris(this._wpos(sl.x, 0.3, sl.z), [this.pal.main, PAL.metalDark, this.pal.trim], { count: 5, power: 0.55, size: 0.3, floor: this._wpos(0, 0, 0).y });
      else this.chunks.burst(sl.x, 0.2, sl.z, 4, [this.pal.main, PAL.metalDark], { power: 0.6, spread: 0.3, size: 0.2 });
    }
    // Big dust cloud.
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * TAU;
      this._dustRing(CORE.x + Math.cos(a) * 0.8, CORE.z + Math.sin(a) * 0.8, Math.cos(a), Math.sin(a));
    }
    this._dust(CORE.x, 0.5, CORE.z, 16, 2.2);
    this._dust(SILO.x, 0.3, SILO.z, 8, 1.0);
    // Rubble pile.
    const rubble = grp(this.fxl, CORE.x, 0, CORE.z);
    for (let i = 0; i < 9; i++) {
      // random size by scale: G.blob caches (and uploads) one geometry per radius, and there is a /clear every day
      const k = (0.22 + this.rnd() * 0.16) / 0.22;
      const r = mesh(G.blob(0.22, 20 + i), mat(i % 3 ? PAL.rock : this.pal.dark), false);
      const a = this.rnd() * TAU, d = this.rnd() * 1.0;
      put(r, Math.cos(a) * d, 0.08, Math.sin(a) * d);
      r.scale.set(k, 0.5 * k, k);
      rubble.add(r);
    }
    await this._wait(1.6);
    // Remove modules; reset the silo; rebuild the core (the faction may have changed).
    for (const m of [...this.modules.values()]) this._removeModule(m.cat, false);
    this._fill = this._fillTarget;
    this._fillHold = null;
    this._buildCore(factionOf(this.session.faction));
    this._rebuildTints();
    this.coreHolder.visible = true;
    this.siloHolder.visible = true;
    this._tween(rubble.scale, { x: 0.01, y: 0.01, z: 0.01 }, 0.5, ease.inCubic).then(() => disposeTree(rubble));
    this._busy = null;
    if (this._endPromise) {   // ended meanwhile: no rebuild; end() raises the bare base from the rubble, then closes it
      this.coreHolder.scale.set(1, 0.001, 1);
      this.siloHolder.scale.setScalar(0.001);
      return;
    }
    await this._construct('rebuild');
    this._modsDirty = true;
  }

  _restoreAfterClear() {
    this.coreHolder.visible = true;
    this.siloHolder.visible = true;
    this.coreHolder.scale.set(1, 1, 1);
    this.siloHolder.scale.set(1, 1, 1);
    for (const m of this.modules.values()) m.group.visible = true;
    this._busy = null;
  }

  _makeDynamite() {
    const g = new THREE.Group();
    for (const [x, z] of [[-0.07, 0], [0.07, 0], [0, 0.1]]) g.add(put(cyl(0.065, 0.065, 0.42, 7, 0xd83a2e), x, 0, z));
    g.add(put(cyl(0.15, 0.15, 0.06, 8, 0x3b2a20, NC), 0, 0.26, 0.03));
    g.add(beam(0, 0.42, 0.03, 0.05, 0.62, 0.02, 0.018, PAL.black));
    const spark = put(sphere(0.06, glow(0xffe07a, 1.8), NC), 0.05, 0.62, 0.02);
    g.add(spark);
    return { group: g, spark };
  }

  _makeDetonator() {
    const g = new THREE.Group();
    g.add(box(0.32, 0.22, 0.26, 0xb5523b));
    const lbl = textSign('TNT', { w: 0.24, h: 0.11, bg: '#1d1f2b', fg: '#ffd23f', border: '#ffd23f', font: 'bold 160px "Lilita One", "Arial Black", sans-serif' });
    g.add(put(lbl, 0, 0.11, 0.135));
    const handle = grp(g, 0, 0.42, 0);
    handle.add(put(cyl(0.02, 0.02, 0.3, 5, PAL.metalDark, NC), 0, -0.2, 0));
    handle.add(put(cyl(0.035, 0.035, 0.34, 6, PAL.black, { center: true, cast: false }), 0, 0.1, 0, 0, 0, Math.PI / 2));
    return { group: g, handle };
  }

  _flash(x, y, z) {
    const m = new THREE.MeshBasicMaterial({ color: 0xfff3c4, transparent: true, opacity: 0.95, depthWrite: false });
    const s = new THREE.Mesh(sgeo('flashG', () => new THREE.IcosahedronGeometry(1, 1)), m);
    s.position.set(x, y, z);
    this.fxl.add(s);
    this._anim(0.4, (k) => { s.scale.setScalar(0.5 + k * 4); m.opacity = 0.95 * (1 - k); }).then(() => { this.fxl.remove(s); m.dispose(); });
  }

  async _runEnd() {
    const clearing = this._clearRun;
    this._labelDirty = true;
    this.state = 'ended';
    this._refreshLabel();
    if (clearing) await clearing;
    this._busy = null;
    this._wholeForEnd();
    await this._wait(0.3);
    this._lightsOff = true;
    await this._wait(0.6);
    // CLOSED sign + boards across the door.
    const c = this.core;
    const sign = grp(this.coreHolder, c.doorX, c.doorTop - 0.22, c.doorFace + 0.1);
    for (const r of [-0.45, 0.45]) sign.add(put(box(c.doorW + 0.3, 0.09, 0.03, PAL.wood, { center: true, cast: false }), 0, -0.1, -0.02, 0, 0, r));
    const plate = textSign('CLOSED', { w: 0.78, h: 0.28, bg: '#f3e3bf', fg: '#c62e2e', border: '#6b4226', font: 'bold 150px "Lilita One", "Arial Black", sans-serif' });
    sign.add(put(plate, 0, 0.12, 0.02, 0, 0, 0.1));
    sign.position.y += 1.2;
    const y0 = sign.position.y - 1.2;
    await this._anim(0.55, (k) => { sign.position.y = y0 + 1.2 * (1 - k); }, ease.outBounce);
    await this._wait(1.1);
    // Sink into the ground in a dust cloud.
    const base = this.group.position.clone();
    let acc = 0;
    await this._anim(2.4, (k, raw) => {
      this.group.position.set(base.x + Math.sin(raw * 90) * 0.04, base.y - 4.6 * k, base.z + Math.cos(raw * 77) * 0.04);
      if (raw - acc > 0.12) {
        acc = raw;
        const a = Math.random() * TAU;
        this._dustAbs(base.x + Math.cos(a) * 2.2, base.y + 0.1, base.z + Math.sin(a) * 2.2, 3, 0.9);
      }
    }, ease.inCubic);
    this.group.visible = false;
    this._label?.setVisible?.(false);
  }

  // An interrupted construction or /clear leaves the core or silo scaled down or hidden: stop the construction and
  // raise them, so the CLOSED sign and the sinking play on a standing base.
  _wholeForEnd() {
    this._buildToken = (this._buildToken || 0) + 1;
    for (const h of [this.coreHolder, this.siloHolder]) {
      h.visible = true;
      const s = h.scale;
      if (Math.abs(s.x - 1) + Math.abs(s.y - 1) + Math.abs(s.z - 1) > 0.01) this._tween(s, { x: 1, y: 1, z: 1 }, 0.35, ease.outCubic);
    }
    for (const m of this.modules.values()) m.group.visible = true;
  }

  // ---- per-building animation runner (driven by tick, so it follows the engine clock) --------------------

  _anim(secs, fn, easeFn = ease.linear) {
    if (this._disposed) return Promise.resolve();
    return new Promise((resolve) => { this._anims.push({ t: 0, secs: Math.max(1e-4, secs), fn, ease: easeFn, resolve }); });
  }

  _tween(target, props, secs, easeFn = ease.outCubic) {
    const from = {};
    for (const k in props) from[k] = target[k];
    return this._anim(secs, (k) => { for (const p in props) target[p] = from[p] + (props[p] - from[p]) * k; }, easeFn);
  }

  _wait(secs) { return this._anim(secs, null); }

  _runAnims(dt) {
    const list = this._anims;
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      a.t += dt;
      const raw = Math.min(1, a.t / a.secs);
      if (a.fn) {
        try { a.fn(a.ease(raw), raw); } catch (e) { console.error('[buildings] anim', e); a.t = a.secs; }
      }
      if (a.t >= a.secs) { list.splice(i--, 1); a.resolve(); }
    }
  }

  // ---- fx helpers ------------------------------------------------------------------------------------------

  _daylight() {
    const d = this.engine?.daylight;
    return typeof d === 'number' ? clamp(d, 0, 1) : 1;
  }

  _wpos(x, y, z) { return this._toWorld(new THREE.Vector3(), x, y, z); }

  _wposOf(obj, x, y, z) {
    const v = new THREE.Vector3(x, y, z);
    obj.updateWorldMatrix(true, false);
    return v.applyMatrix4(obj.matrixWorld);
  }

  _toWorld(out, x, y, z) {
    out.set(x, y, z);
    const g = this.group;
    if (g.parent) { g.updateWorldMatrix(true, false); out.applyMatrix4(g.matrixWorld); } else { g.updateMatrix(); out.applyMatrix4(g.matrix); }
    return out;
  }

  _smoke(obj, local, color, size) {
    const fx = this.engine?.fx;
    const w = this._wposOf(obj, local.x, local.y, local.z);
    if (fx?.smoke) fx.smoke(w, { count: 1, color, size: size * 1.6, rise: 1.1 });
    else {
      this.group.updateWorldMatrix(true, false);
      const l = this.group.worldToLocal(w);
      this.puffs.emit(l.x, l.y, l.z, { color, size, vy: 0.8, vx: 0.15, life: 1.6, drag: 0.4 });
    }
  }

  _dust(x, y, z, count, spread) {
    const fx = this.engine?.fx;
    if (fx?.puff) fx.puff(this._wpos(x, y, z), { color: 0xf3ead6, count, size: 0.5, spread, rise: 0.5, life: 0.9 });
    else for (let i = 0; i < count; i++) { const a = Math.random() * TAU, s = spread * (0.5 + Math.random()); this.puffs.emit(x, y, z, { color: 0xe9d9b4, size: 0.18 + Math.random() * 0.16, vx: Math.cos(a) * s, vz: Math.sin(a) * s, vy: 0.4, life: 0.8 + Math.random() * 0.4, drag: 2.2 }); }
  }

  _dustAbs(x, y, z, count, spread) {
    const fx = this.engine?.fx;
    if (fx?.puff) fx.puff(new THREE.Vector3(x, y, z), { color: 0xeee3cb, count, size: 0.6, spread, rise: 0.8, life: 1.1 });
    else {
      this.group.updateWorldMatrix(true, false);
      const l = this.group.worldToLocal(new THREE.Vector3(x, y, z));
      this._dust(l.x, l.y, l.z, count, spread);
    }
  }

  _dustRing(x, z, dx, dz) {
    const fx = this.engine?.fx;
    if (fx?.puff) fx.puff(this._wpos(x + dx * 0.6, 0.3, z + dz * 0.6), { color: 0xebdfc4, count: 3, size: 0.95, spread: 1.6, rise: 0.7, life: 1.8 });
    else this.puffs.emit(x, 0.3, z, { color: 0xdcc9a0, size: 0.5 + Math.random() * 0.3, vx: dx * 2.4, vz: dz * 2.4, vy: 0.5, life: 1.8, drag: 1.6 });
  }

  _sparks(x, y, z, color, count = 8) {
    const fx = this.engine?.fx;
    if (fx?.sparks) fx.sparks(this._wpos(x, y, z), color, { count, speed: 3, size: 0.12 });
    else for (let i = 0; i < Math.min(count, 5); i++) this.puffs.emit(x, y, z, { color, size: 0.05, vx: (Math.random() - 0.5) * 3, vy: 2 + Math.random() * 2, vz: (Math.random() - 0.5) * 3, grav: -9, life: 0.5, drag: 0.5 });
  }

  _text(x, y, z, text, color, size = 1) {
    const fx = this.engine?.fx;
    try { fx?.text?.(this._wpos(x, y, z), text, { color, size, rise: 1.8, secs: 2 }); } catch (e) { console.error(e); }
  }

  // Called by module tickers.
  _moduleSparks(obj, x, y, z) {
    const w = this._wposOf(obj, x, y, z);
    const fx = this.engine?.fx;
    if (fx?.sparks) fx.sparks(w, 0xffc34d, { count: 7, speed: 2.4, size: 0.1 });
    else {
      this.group.updateWorldMatrix(true, false);
      const l = this.group.worldToLocal(w);
      this._sparks(l.x, l.y, l.z, 0xffc34d, 5);
    }
  }

  _modulePuff(obj, x, y, z, color, size) {
    const w = this._wposOf(obj, x, y, z);
    const fx = this.engine?.fx;
    if (fx?.puff) fx.puff(w, { color, count: 2, size: size * 2.4, spread: 0.3, rise: 0.4, life: 0.7 });
    else {
      this.group.updateWorldMatrix(true, false);
      const l = this.group.worldToLocal(w);
      this.puffs.emit(l.x, l.y, l.z, { color, size, vy: 0.4, life: 0.7 });
    }
  }

  // ---- anchors -------------------------------------------------------------------------------------------

  _refreshAnchors() {
    const c = this.core;
    if (!c) return;
    this._toWorld(this.door, CORE.x + c.doorOut.x, 0, CORE.z + c.doorOut.z);
    this._toWorld(this.roof, CORE.x + c.roof.x, c.roof.y, CORE.z + c.roof.z);
    this._toWorld(this.center, CORE.x, 0, CORE.z);
    this._toWorld(this.lunch.table, TABLE.x, 0, TABLE.z);
    this._toWorld(this.lunch.top, TABLE.x, 0.47, TABLE.z);
    const seats = [[-0.24, -0.42], [0.24, -0.42], [-0.24, 0.42], [0.24, 0.42]];
    const yaw = this.group.rotation.y || 0;
    seats.forEach(([x, z], i) => {
      this._toWorld(this.lunch.seats[i], TABLE.x + x, 0.27, TABLE.z + z);
      this.lunch.facing[i] = yaw + (z < 0 ? 0 : Math.PI);
    });
    this._refreshSpots();
  }

  _refreshSpots() { for (const [k, v] of this._spots) this._spotFor(k, v); }

  _spotFor(key, out) {
    const cat = key === 'search' ? 'read' : key;
    const m = this.modules.get(cat);
    if (m) {
      const s = MOD_SLOTS[m.slot];
      return this._toWorld(out, s.x + s.wx, 0, s.z + s.wz);
    }
    const d = DEFAULT_SPOTS[key] || DEFAULT_SPOTS.other;
    return this._toWorld(out, d[0], 0, d[1]);
  }

  // ---- label ---------------------------------------------------------------------------------------------

  _makeLabel() {
    const labels = this.engine?.labels;
    if (!labels?.add) return;
    try {
      labels.css?.('buildings', LABEL_CSS);
      // member of the island's label stack (and its worktree islet's): the name tags float above it
      const isl = 'island:' + this.session?.island, ax = this.session?.annex;
      const stack = { group: ax ? ['annex:' + ax, isl] : isl, role: 'member' };
      this._label = labels.add({ object: this.labelAnchor, offset: new THREE.Vector3(), html: this._labelHtml(), className: 'cnc-bld-lbl', target: { type: 'session', id: this.key }, stack });
      this._labelHtmlCache = null;
      this._labelDirty = true;
    } catch (e) { console.error('[buildings] label', e); }
  }

  _labelHtml() {
    const s = this.session || {};
    const st = this.state || s.state || 'idle';
    const max = s.context?.max || 0, used = s.context?.used || 0;
    const f = max ? clamp(used / max, 0, 1) : 0;
    const bar = cssHex(rampColor(f, _c).getHex());
    const fc = cssHex(this.pal.main);
    const name = trunc(s.name || s.cwd || 'Session', 28);
    return `<div class="cnc-bld s-${esc(st)} f-${this.faction}${f > 0.8 ? ' hot-ctx' : ''}">` +
      `<div class="cb-r1"><span class="cb-chip" style="background:${fc}">${GLYPH[this.faction] || '?'}</span>` +
      `<span class="cb-name">${esc(name)}</span><span class="cb-st">${STATE_CHIP[st] || esc(String(st).toUpperCase())}</span></div>` +
      `<div class="cb-r2"><span class="cb-bar"><i style="width:${(f * 100).toFixed(1)}%;background:${bar}"></i></span>` +
      `<span class="cb-ctx">${fmtTokens(used)}/${fmtTokens(max)}</span></div></div>`;
  }

  _refreshLabel() {
    this._labelDirty = false;
    if (!this._label) return;
    const html = this._labelHtml();
    if (html !== this._labelHtmlCache) { this._labelHtmlCache = html; this._label.set(html); }
  }
}

export default Building;
