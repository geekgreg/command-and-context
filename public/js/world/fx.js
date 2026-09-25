// Pooled, cheap effects (DESIGN §4 `engine.fx`). Particles are drawn by four InstancedMeshes (one draw call
// each, no per-particle allocation): lit ico puffs, lit cube chunks, unlit glowing sparks and flat confetti.
// Rings come from a small mesh pool. Floating text, speech bubbles and Zzz are crisp DOM elements on the
// labels layer, styled comic-book in base.css. Positions can be any {x,y,z}; they are copied at spawn time.
import * as THREE from 'three';
import { PAL, ease, cssHex } from './kit.js';
import { esc } from './labels.js';

const POP = 0, SHRINK = 1, HOLD = 2, GROW = 3;       // particle size curves
const CONFETTI = [0xff5fa2, 0xffc53d, 0x39e5ff, 0x9be22d, 0x7a4dff, 0xff8a1f, 0xffffff];
const _o = new THREE.Object3D();
const _c = new THREE.Color();
const _v = new THREE.Vector3();
const _box = new THREE.Box3();
const rnd = Math.random;
const css = (c) => (typeof c === 'number' ? cssHex(c) : c);
const noop = () => {};
// Inert label handle (same shape as engine.labels.add) for effects skipped while nothing is being drawn.
const stubLabel = () => ({ el: document.createElement('div'), set: noop, setVisible: noop, setClass: noop, setPriority: noop, setObject: noop, setPosition: noop, remove: noop });

class Pool {
  constructor(parent, geo, material, cap) {
    const m = new THREE.InstancedMesh(geo, material, cap);
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.setColorAt(0, _c.set(0xffffff));
    m.instanceColor.setUsage(THREE.DynamicDrawUsage);
    m.count = 0;
    m.frustumCulled = false;
    m.castShadow = m.receiveShadow = false;
    m.userData.noPick = true;
    m.renderOrder = 2;
    parent.add(m);
    this.mesh = m;
    this.cap = cap;
    this.parts = [];
  }
}

export class Fx {
  constructor(engine) {
    this.engine = engine;
    const g = new THREE.Group();
    g.name = 'fx';
    engine.scene.add(g);
    this.group = g;
    const lit = new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true });
    this.lit = new Pool(g, new THREE.IcosahedronGeometry(0.5, 0), lit, 900);
    this.cube = new Pool(g, new THREE.BoxGeometry(1, 1, 1), lit, 500);
    this.glow = new Pool(g, new THREE.OctahedronGeometry(0.5, 0), new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }), 700);
    this.flat = new Pool(g, new THREE.PlaneGeometry(0.26, 0.16), new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide }), 600);
    this.pools = [this.lit, this.cube, this.glow, this.flat];
    this.free = [];
    this.rings = [];
    const ringGeo = new THREE.RingGeometry(0.8, 1, 40);
    for (let i = 0; i < 14; i++) {
      const mesh = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, toneMapped: false, fog: false }));
      mesh.rotation.x = -Math.PI / 2;
      mesh.visible = false;
      mesh.renderOrder = 3;
      mesh.userData.noPick = true;
      g.add(mesh);
      this.rings.push({ mesh, age: 0, life: 1, r: 1, active: false });
    }
    this.texts = [];
    this.timers = [];
    this.trails = new Set();
    this.bubbles = new Map();
  }

  // Scale particle counts down on low quality.
  n(count) { return Math.max(1, Math.round(count * (this.engine.settings.quality === 'low' ? 0.5 : 1))); }

  emit(pool, x, y, z, vx, vy, vz, size, life, color, curve, grav = 0, drag = 0, spin = 0, floor = -1e9, bounce = 0) {
    if (pool.parts.length >= pool.cap) return null;
    const p = this.free.pop() || {};
    p.x = x; p.y = y; p.z = z; p.vx = vx; p.vy = vy; p.vz = vz;
    p.size = size; p.life = life; p.age = 0; p.curve = curve;
    p.grav = grav; p.drag = drag; p.floor = floor; p.bounce = bounce;
    _c.set(color); p.r = _c.r; p.g = _c.g; p.b = _c.b;
    p.rx = rnd() * 6.28; p.ry = rnd() * 6.28; p.rz = rnd() * 6.28;
    p.sx = (rnd() - 0.5) * spin; p.sy = (rnd() - 0.5) * spin; p.sz = (rnd() - 0.5) * spin;
    pool.parts.push(p);
    return p;
  }

  // ---- particle effects ------------------------------------------------------------------------------

  // Soft dust puff (construction, landings, demolition clouds).
  puff(pos, { color = 0xf2e8d5, count = 10, size = 0.7, spread = 1, rise = 0.6, life = 0.9 } = {}) {
    const n = this.n(count);
    for (let i = 0; i < n; i++) {
      const a = rnd() * 6.283, sp = (0.8 + rnd() * 1.6) * spread;
      this.emit(this.lit, pos.x + Math.cos(a) * 0.3 * spread, pos.y + rnd() * 0.3, pos.z + Math.sin(a) * 0.3 * spread,
        Math.cos(a) * sp, rise + rnd() * rise, Math.sin(a) * sp, size * (0.6 + rnd() * 0.8), life * (0.7 + rnd() * 0.6),
        color, POP, 0, 2.2, 2);
    }
  }

  // Bright sparks with gravity (forge hits, zaps).
  sparks(pos, color = 0xffd66b, { count = 14, speed = 5, size = 0.16 } = {}) {
    const n = this.n(count);
    for (let i = 0; i < n; i++) {
      const a = rnd() * 6.283, sp = speed * (0.4 + rnd() * 0.8);
      this.emit(this.glow, pos.x, pos.y, pos.z, Math.cos(a) * sp, speed * (0.5 + rnd() * 0.9), Math.sin(a) * sp,
        size * (0.6 + rnd() * 0.8), 0.35 + rnd() * 0.4, color, SHRINK, 14, 0.5, 18);
    }
  }

  // Party time: a burst of fluttering confetti.
  confetti(pos, { count = 40, colors = CONFETTI, power = 1 } = {}) {
    const n = this.n(count);
    for (let i = 0; i < n; i++) {
      const a = rnd() * 6.283, sp = (1 + rnd() * 3) * power;
      this.emit(this.flat, pos.x, pos.y, pos.z, Math.cos(a) * sp, (4 + rnd() * 4) * power, Math.sin(a) * sp,
        0.8 + rnd() * 0.6, 1.6 + rnd() * 1.2, colors[i % colors.length], HOLD, 5, 2.4, 16);
    }
  }

  // Dark rising smoke puffs (poof, chimneys, failures).
  smoke(pos, { count = 6, color = 0x5d5f6b, size = 0.7, rise = 1.4 } = {}) {
    const n = this.n(count);
    for (let i = 0; i < n; i++) {
      this.emit(this.lit, pos.x + (rnd() - 0.5) * 0.5, pos.y + rnd() * 0.3, pos.z + (rnd() - 0.5) * 0.5,
        (rnd() - 0.5) * 0.6, rise * (0.6 + rnd() * 0.6), (rnd() - 0.5) * 0.6, size * (0.6 + rnd() * 0.6),
        1.4 + rnd() * 0.9, color, GROW, 0, 0.6, 1);
    }
  }

  // Chunky ballistic debris with gravity and a bounce, then shrink out (the /clear demolition).
  debris(pos, colors = [PAL.metal, PAL.metalDark, PAL.wood], { count = 24, power = 1, size = 0.5, floor } = {}) {
    const n = this.n(count), fl = floor ?? pos.y;
    const cols = Array.isArray(colors) && colors.length ? colors : [PAL.metal];
    for (let i = 0; i < n; i++) {
      const a = rnd() * 6.283, sp = (1.5 + rnd() * 4.5) * power;
      this.emit(this.cube, pos.x + (rnd() - 0.5) * 1.4, pos.y + 0.3 + rnd() * 1.8, pos.z + (rnd() - 0.5) * 1.4,
        Math.cos(a) * sp, (4 + rnd() * 6) * power, Math.sin(a) * sp, size * (0.45 + rnd() * 0.9), 2.2 + rnd() * 1.3,
        cols[i % cols.length], HOLD, 20, 0.15, 10, fl, 0.35);
    }
  }

  // Quick glowing flash ball (dynamite, teleports).
  flash(pos, { color = 0xfff3c4, size = 3, secs = 0.35 } = {}) {
    this.emit(this.glow, pos.x, pos.y, pos.z, 0, 0, 0, size, secs, color, POP);
  }

  // Expanding flat shockwave ring on the ground.
  ring(pos, color = 0x39e5ff, { radius = 3, secs = 0.8 } = {}) {
    let R = this.rings.find((r) => !r.active);
    if (!R) R = this.rings.reduce((a, b) => (a.age / a.life > b.age / b.life ? a : b));
    R.active = true; R.age = 0; R.life = secs; R.r = radius;
    R.mesh.material.color.set(color);
    R.mesh.position.set(pos.x, pos.y + 0.08, pos.z);
    R.mesh.scale.setScalar(0.01);
    R.mesh.visible = true;
  }

  // ---- DOM effects --------------------------------------------------------------------------------------

  // Floating comic-book text that pops, rises and fades. Returns the label handle.
  // While nothing is being drawn (minimized / covered window) DOM effects are skipped: they are only removed by
  // tick(), so they would pile up until the window is shown again.
  text(pos, text, { color = '#ffffff', size = 1, rise = 2.2, secs = 1.8, className = '' } = {}) {
    if (this.engine.renderStalled?.()) return stubLabel();
    const off = new THREE.Vector3();
    const lbl = this.engine.labels.add({
      position: pos, offset: off, className: 'fx-text always ' + className,
      html: `<span style="--c:${css(color)};--fs:${size}">${esc(text)}</span>`,
    });
    this.texts.push({ lbl, off, age: 0, life: secs, rise, op: 1 });
    return lbl;
  }

  // Speech bubble above an object. One bubble per object: a new one replaces the old. -> { el, remove() }
  bubble(object, text, { secs = 3, offset = null, className = '' } = {}) {
    if (this.engine.renderStalled?.()) return stubLabel();
    this.bubbles.get(object)?.remove();
    const off = offset ? offset.clone() : new THREE.Vector3(0, this.heightOf(object) + 0.3, 0);
    const lbl = this.engine.labels.add({ object, offset: off, className: 'always fx-bubble-lbl ' + className, html: `<div class="fx-bubble">${esc(text)}</div>` });
    const h = {
      el: lbl.el,
      remove: () => {
        if (h.dead) return;
        h.dead = true;
        lbl.remove();
        if (this.bubbles.get(object) === h) this.bubbles.delete(object);
      },
    };
    this.bubbles.set(object, h);
    this.after(secs, h.remove);
    return h;
  }

  // Drifting Zzz above a sleeping object. -> { el, stop() }
  zzz(object, { offset = null } = {}) {
    const off = offset ? offset.clone() : new THREE.Vector3(0.35, this.heightOf(object) + 0.15, 0);
    const lbl = this.engine.labels.add({ object, offset: off, className: 'always fx-zzz-lbl', html: '<div class="fx-zzz"><b>Z</b><b>z</b><b>z</b></div>' });
    return { el: lbl.el, stop: () => lbl.remove() };
  }

  // Emit particles behind a moving object every frame until stop(). kind: 'sparkle' | 'smoke' | 'wake'
  trail(object, { color = 0xfff3a0, rate = 22, size = 0.14, kind = 'sparkle', offset = null } = {}) {
    const t = { object, color, rate, size, kind, offset, acc: 0 };
    this.trails.add(t);
    return { stop: () => this.trails.delete(t) };
  }

  // Engine-clock timer.
  after(secs, fn) { this.timers.push({ at: this.engine.time + secs, fn }); }

  heightOf(object) {
    object.updateWorldMatrix(true, true);
    _box.setFromObject(object);
    if (_box.isEmpty()) return 1.5;
    _v.setFromMatrixPosition(object.matrixWorld);
    return Math.max(0.4, _box.max.y - _v.y);
  }

  // ---- per frame ----------------------------------------------------------------------------------------

  tick(dt) {
    for (const t of this.trails) this.tickTrail(t, dt);

    for (const pool of this.pools) {
      const P = pool.parts, mesh = pool.mesh;
      let n = 0;
      for (let i = 0; i < P.length; i++) {
        const p = P[i];
        p.age += dt;
        if (p.age >= p.life) { this.free.push(p); continue; }
        if (p.drag) {
          const d = Math.exp(-p.drag * dt);
          p.vx *= d; p.vz *= d;
          if (!p.grav) p.vy *= d;
        }
        p.vy -= p.grav * dt;
        p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
        if (p.y < p.floor) {
          p.y = p.floor;
          if (p.bounce && p.vy < -1.5) { p.vy = -p.vy * p.bounce; p.vx *= 0.6; p.vz *= 0.6; p.sx *= 0.5; p.sz *= 0.5; }
          else { p.vy = 0; p.vx *= 0.85; p.vz *= 0.85; p.sx *= 0.85; p.sy *= 0.85; p.sz *= 0.85; }
        }
        p.rx += p.sx * dt; p.ry += p.sy * dt; p.rz += p.sz * dt;
        const k = p.age / p.life;
        let s;
        if (p.curve === POP) s = k < 0.18 ? ease.outBack(k / 0.18) : 1 - ((k - 0.18) / 0.82) ** 2;
        else if (p.curve === SHRINK) s = 1 - k * k;
        else if (p.curve === HOLD) s = k < 0.75 ? 1 : 1 - (k - 0.75) / 0.25;
        else s = (0.45 + k * 0.9) * (k < 0.7 ? 1 : 1 - (k - 0.7) / 0.3);
        s = Math.max(0.001, s * p.size);
        _o.position.set(p.x, p.y, p.z);
        _o.rotation.set(p.rx, p.ry, p.rz);
        _o.scale.set(s, s, s);
        _o.updateMatrix();
        mesh.setMatrixAt(n, _o.matrix);
        mesh.setColorAt(n, _c.setRGB(p.r, p.g, p.b));
        P[n++] = p;
      }
      P.length = n;
      if (n || mesh.count) {
        mesh.count = n;
        mesh.instanceMatrix.needsUpdate = true;
        mesh.instanceColor.needsUpdate = true;
      }
    }

    for (const R of this.rings) {
      if (!R.active) continue;
      R.age += dt;
      const k = Math.min(1, R.age / R.life);
      R.mesh.scale.setScalar(R.r * (0.12 + 0.88 * ease.outCubic(k)));
      R.mesh.material.opacity = Math.pow(1 - k, 1.4) * 0.9;
      if (k >= 1) { R.active = false; R.mesh.visible = false; }
    }

    for (let i = this.texts.length - 1; i >= 0; i--) {
      const T = this.texts[i];
      T.age += dt;
      const k = T.age / T.life;
      if (k >= 1) { T.lbl.remove(); this.texts.splice(i, 1); continue; }
      T.off.y = T.rise * ease.outCubic(k);
      const op = k > 0.72 ? Math.round((1 - (k - 0.72) / 0.28) * 20) / 20 : 1;
      if (op !== T.op) { T.op = op; T.lbl.el.style.opacity = op; }
    }

    if (this.timers.length) {
      const now = this.engine.time;
      for (let i = this.timers.length - 1; i >= 0; i--) {
        if (now >= this.timers[i].at) {
          const { fn } = this.timers[i];
          this.timers.splice(i, 1);
          try { fn(); } catch (e) { console.error(e); }
        }
      }
    }
  }

  tickTrail(t, dt) {
    const o = t.object;
    if (!o.parent) { this.trails.delete(t); return; }
    t.acc += dt * t.rate;
    if (t.acc < 1) return;
    _v.setFromMatrixPosition(o.matrixWorld);
    if (t.offset) _v.add(t.offset);
    while (t.acc >= 1) {
      t.acc -= 1;
      if (t.kind === 'smoke') {
        this.emit(this.lit, _v.x, _v.y, _v.z, (rnd() - 0.5) * 0.4, 0.8 + rnd() * 0.5, (rnd() - 0.5) * 0.4, t.size * 4, 1.1 + rnd() * 0.5, t.color, GROW, 0, 0.5, 1);
      } else if (t.kind === 'wake') {
        this.emit(this.lit, _v.x + (rnd() - 0.5) * 0.6, 0.05, _v.z + (rnd() - 0.5) * 0.6, (rnd() - 0.5) * 0.8, 0, (rnd() - 0.5) * 0.8, t.size * 4, 0.9 + rnd() * 0.5, t.color, POP, 0, 1.5, 0.5);
      } else {
        this.emit(this.glow, _v.x + (rnd() - 0.5) * 0.3, _v.y + (rnd() - 0.5) * 0.3, _v.z + (rnd() - 0.5) * 0.3, (rnd() - 0.5) * 0.5, 0.3 + rnd() * 0.5, (rnd() - 0.5) * 0.5, t.size, 0.5 + rnd() * 0.4, t.color, SHRINK, 0, 1, 6);
      }
    }
  }
}
