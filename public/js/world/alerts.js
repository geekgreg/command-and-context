// Alerts: the loud "look here, Commander" layer, drawn at island scale so it reads from across the room.
//   turn_done   one-shot (~4.5 s): a light pillar shoots up from the base (faction color, white core), 2-3
//               staggered shockwaves race across the sea under a faint energy dome, the island top flashes and a
//               YOUR MOVE banner pops (WAITING ON n AGENTS in calm cyan while sub-agents still run). Then a calm
//               READY check beacon hovers over the base for as long as the session stays idle, but only once all
//               of its sub-agents are back.
//   needs_input one big entry burst (shockwaves across the sea, a pillar flash, a NEEDS YOU banner), then only a
//               giant chunky "!" hovering over the waiting base(s) (never smaller than ~150 px on screen, gently
//               bobbing) until the state ends. Buildings hide their own "!" meanwhile (this sets building.bigAlert).
//   agent_done  a modest cyan ring + flash at the building door.
// Everything is pooled and capped. The shaders output premultiplied alpha: a normal "over" color that stays
// readable on the bright daytime sea plus an additive glow that blooms at night. settings.reduceMotion gets
// single rings, no domes and no bobbing. world.js owns one Alerts: onEvent(ev) for fresh events,
// sync(snapshot, { instant, events }) per snapshot and tick(dt) per frame.
import * as THREE from 'three';
import { factionPal, ease, mix, damp, V3 } from './kit.js';
import { esc, trunc } from './labels.js';

const YELLOW = 0xffd23f, ORANGE = 0xff8a1f, CYAN = 0x39e5ff, GREEN = 0x3ddc84;
const MAX_TURNS = 3;             // full turn_done sequences at once; extra ones get a lighter version
const SEA_Y = 0.35;              // shockwaves ride just above the waves
const SETTLE = 4;                // secs after the last sub-agent is back before READY shows (the main agent usually wakes)
const TERMINAL = new Set(['done', 'failed', 'lost']);
const _v = new THREE.Vector3(), _f = new THREE.Vector3(), _scr = { x: 0, y: 0 }, _groups = [];

const vec = (p) => (p?.isVector3 ? p.clone() : p && Number.isFinite(p.x) ? V3(p.x, p.y || 0, p.z) : null);
const dur = (s) => (s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
  : `${Math.floor(s / 3600)}h ${String(Math.floor(s / 60) % 60).padStart(2, '0')}m`);

// ---- shared geometry + shaders ---------------------------------------------------------------------------------

const RING_GEO = new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2);
const DOME_GEO = new THREE.SphereGeometry(1, 40, 12, 0, Math.PI * 2, 0, Math.PI / 2);
const PILLAR_GEO = new THREE.CylinderGeometry(1, 1, 1, 24, 1, true).translate(0, 0.5, 0);
const BANG_BAR = new THREE.CylinderGeometry(0.66, 0.44, 3.0, 4, 1).rotateY(Math.PI / 4);
const BANG_DOT = new THREE.BoxGeometry(0.84, 0.84, 0.84);
const CHECK_SHORT = new THREE.BoxGeometry(0.42, 0.95, 0.42);
const CHECK_LONG = new THREE.BoxGeometry(0.42, 1.9, 0.42);
const BLEND = { transparent: true, depthWrite: false, premultipliedAlpha: true, toneMapped: false };

// Flat ring (or soft disc) on a 2x2 quad: sharp bright leading edge, softer band behind it, faint inner haze.
const RING_VERT = /* glsl */ `varying vec2 vP;
void main() { vP = position.xz; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const RING_FRAG = /* glsl */ `uniform vec3 uColor; uniform vec3 uGlow; uniform float uR; uniform float uW; uniform float uAlpha;
uniform float uGlowAmt; uniform float uFill; uniform float uDisc; uniform float uTime;
varying vec2 vP;
void main() {
  float d = length(vP);
  if (d > 1.0) discard;
  float ang = atan(vP.y, vP.x);
  float dw = d + (sin(ang * 7.0 + uTime * 2.3) + sin(ang * 12.0 - uTime * 3.1)) * 0.0045;
  float a, g;
  if (uDisc > 0.5) {
    a = pow(1.0 - d, 1.5) * uAlpha;
    g = a;
  } else {
    float inside = 1.0 - smoothstep(uR - 0.003, uR + 0.012, dw);
    float band = inside * smoothstep(uR - uW, uR, dw);
    a = clamp(band * 0.9 + inside * uFill * smoothstep(0.0, uR, dw), 0.0, 1.0) * uAlpha;
    g = exp(-pow((dw - uR) / 0.013, 2.0)) * uAlpha;
  }
  gl_FragColor = vec4(uColor * a + uGlow * g * uGlowAmt, a);
  #include <colorspace_fragment>
}`;

// Energy dome: fresnel hemisphere, bright at the rim, clear in the middle.
const DOME_VERT = /* glsl */ `varying vec3 vN; varying float vY;
void main() { vN = normalMatrix * normal; vY = position.y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const DOME_FRAG = /* glsl */ `uniform vec3 uColor; uniform float uAlpha; varying vec3 vN; varying float vY;
void main() {
  float f = 1.0 - abs(normalize(vN).z);
  float a = pow(f, 2.5) * uAlpha * (0.4 + 0.6 * (1.0 - vY));
  gl_FragColor = vec4(uColor * a * 1.5, a);
  #include <colorspace_fragment>
}`;

// Light pillar: open cylinder, white core down the middle, fading upward, energy streaks rushing up.
const PILLAR_VERT = /* glsl */ `varying vec3 vN; varying float vV;
void main() { vN = normalMatrix * normal; vV = position.y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const PILLAR_FRAG = /* glsl */ `uniform vec3 uColor; uniform float uAlpha; uniform float uTime; uniform float uStreak;
varying vec3 vN; varying float vV;
void main() {
  float c = 1.0 - abs(normalize(vN).x);
  float fall = pow(1.0 - vV, 1.3) * smoothstep(0.0, 0.015, vV);
  float streak = 1.0 + uStreak * 0.4 * sin(vV * 46.0 - uTime * 10.0);
  float a = clamp(pow(c, 1.4) * fall * streak * uAlpha, 0.0, 1.0);
  vec3 col = mix(uColor, vec3(1.0), smoothstep(0.74, 0.99, c) * 0.85);
  gl_FragColor = vec4(col * a * 1.2, a);
  #include <colorspace_fragment>
}`;

function haloTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const x = c.getContext('2d'), g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.45)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g;
  x.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

class Pool {
  constructor(max, make) { this.max = max; this.make = make; this.items = []; }
  get() {
    let it = this.items.find((x) => !x.busy);
    if (!it && this.items.length < this.max) { it = this.make(); this.items.push(it); }
    if (it) it.busy = true;
    return it || null;
  }
  release(it) { it.busy = false; it.mesh.visible = false; }
}

const CSS = `
.ab-banner{pointer-events:none}
.ab-plate{display:flex;flex-direction:column;align-items:center;gap:.08em;margin-bottom:.25em;padding:.1em .65em .2em;
border-radius:.32em;border:.085em solid #0b1026;background:linear-gradient(180deg,var(--b1),var(--b2));color:#fff;
font:400 calc(40px * var(--ls,1))/1 'Lilita One','Arial Black',sans-serif;letter-spacing:.035em;white-space:nowrap;
text-shadow:0 .07em 0 #0b1026,-.035em -.035em 0 #0b1026,.035em -.035em 0 #0b1026,-.035em .035em 0 #0b1026,.035em .035em 0 #0b1026;
box-shadow:0 .12em 0 #0b1026,0 0 1.1em var(--gl),0 .35em 1em rgba(0,0,0,.3);transform-origin:50% 100%;
animation:ab-pop .62s cubic-bezier(.2,1.9,.4,1) both}
.ab-plate small{font:700 .34em/1.15 'Chakra Petch',system-ui,sans-serif;letter-spacing:.08em;text-transform:uppercase;text-shadow:0 1px 0 #0b1026}
.ab-go{--b1:#6af5a6;--b2:#12a35a;--gl:rgba(61,220,132,.8)}
.ab-calm{--b1:#7cecff;--b2:#1689bd;--gl:rgba(57,229,255,.65)}
.ab-alert{--b1:#ffe36b;--b2:#f29a00;--gl:rgba(255,210,63,.9)}
.ab-still .ab-plate{animation:none}
@keyframes ab-pop{0%{transform:scale(.15) rotate(-8deg);opacity:0}55%{opacity:1}100%{transform:scale(1) rotate(0)}}
`;

export class Alerts {
  constructor(world) {
    this.world = world;
    this.engine = world.engine;
    this.group = new THREE.Group();
    this.group.name = 'alerts';
    this.engine.scene.add(this.group);          // outside world.root: never picked, never night-boosted
    this.t = 0;
    this.tracks = [];                            // running one-shots
    this.rings = new Pool(18, () => this.makeRing());
    this.domes = new Pool(4, () => this.makeDome());
    this.pillars = new Pool(16, () => this.makePillar());
    this.bangs = new Map();                      // island id -> giant "!"
    this.spareBangs = [];
    this.checks = new Map();                     // session key -> READY beacon
    this.spareChecks = [];
    this.needs = new Set();                      // sessions in needs_input at the last sync
    this.ready = new Map();                      // session key -> { at, agents, keep } (READY beacon wanted once agents is 0)
    this.forced = new Set();                     // test hook: sessions shown as needs_input
    this.banners = [];
    this.lastAgent = new Map();
    this.bandBusy = new Map();                   // island id -> time until which a banner occupies its label band
    this.turns = 0;
    this.halo = haloTexture();
    this.engine.labels.css('alerts', CSS);
  }

  rm() { return !!this.engine.settings.reduceMotion; }
  night() { return 1 - (this.engine.daylight ?? 1); }
  ppu() { return this.engine.view.ppu?.() || 15; }

  // Session key -> where its base and island are right now.
  where(key) {
    const w = this.world, b = w.buildings.get(key), m = w.bmeta.get(key);
    const L = m && w.layout.get(m.island);
    if (!b?.group || !L) return null;
    return { b, L, island: m.island, top: w.islands.get(m.island)?.top ?? 1.5, pos: b.group.getWorldPosition(new THREE.Vector3()), s: m.session || {} };
  }

  isReady(key) { return this.checks.has(key) && this.ready.get(key)?.agents === 0; }

  // Screen-space layout over an island, in world units for the current zoom: banners sit ~100 px above the island
  // top (clear of the island and building labels); the giant "!" floats ~230 px up while a banner is showing, then
  // settles to ~140 px (just clear of the labels).
  bannerAt(L, top) { return V3(L.x, top + Math.max(6, 100 / (this.ppu() * 0.82)), L.z); }

  // Pixels a marker standing on world point p must rise to clear the label stack(s) above it (labels.topOver).
  clearStack(groups, p, hw, margin) {
    const st = this.engine.labels.topOver?.(groups, this.engine.view.worldToScreen(p, _scr).x, hw);
    return st == null ? 0 : _scr.y - st + margin;
  }

  // ---- inputs ----------------------------------------------------------------------------------------------------

  onEvent(ev) {
    if (ev.type === 'turn_done') this.turnDone(ev);
    else if (ev.type === 'agent_done') this.agentDone(ev);
  }

  // Per snapshot: persistent needs_input visuals and READY beacon bookkeeping. `instant` (first snapshot, catching
  // up) shows states without their entrance bursts and revives READY beacons from recent turn_done events.
  sync(snap, { instant = false, events = null } = {}) {
    const w = this.world;
    const byKey = new Map((snap?.sessions || []).map((s) => [s.key, s]));
    const now = new Set();
    for (const s of byKey.values()) {
      if ((s.state === 'needs_input' || this.forced.has(s.key)) && w.buildings.has(s.key)) now.add(s.key);
    }
    for (const key of now) if (!this.needs.has(key) && !instant) this.needsBurst(key);
    this.needs = now;

    const islands = new Set();
    for (const key of now) { const m = w.bmeta.get(key); if (m) islands.add(m.island); }
    for (const [id, B] of this.bangs) B.want = islands.has(id);
    for (const id of islands) if (!this.bangs.has(id)) this.addBang(id, instant);
    for (const [key, b] of w.buildings) b.bigAlert = now.has(key);   // buildings.js hides its own "!" then


    if (instant && Array.isArray(events)) {
      for (const s of byKey.values()) {
        if (s.state !== 'idle' || this.ready.has(s.key) || !w.buildings.has(s.key)) continue;
        let ev = null;
        for (let i = events.length - 1; i >= 0 && !ev; i--) if (events[i]?.type === 'turn_done' && events[i].key === s.key) ev = events[i];
        if (ev && (ev.t || 0) >= (s.stateSince || 0) - 3000) this.ready.set(s.key, { at: this.t, agents: 0, instant: true });
      }
    }
    for (const [key, r] of this.ready) {
      const s = byKey.get(key);
      if (!r.keep && (!s || s.state !== 'idle' || !w.buildings.has(key))) { this.ready.delete(key); continue; }
      if (r.keep || !s) continue;
      // No READY while sub-agents are still out. Once the last one is back, wait a moment: the main agent usually
      // wakes up to read their results, and the check would only flash.
      let n = 0;
      for (const a of s.agents || []) if (!TERMINAL.has(a.state)) n++;
      if (n) r.instant = false;
      else if (r.agents) r.at = Math.max(r.at, this.t + SETTLE);
      r.agents = n;
    }
  }

  // ---- the three moments ----------------------------------------------------------------------------------------

  turnDone(ev) {
    const W = this.where(ev.key);
    if (!W) return;
    const { L, top, pos, s, b } = W;
    const P = factionPal(s.faction || b.faction);
    const n = Math.max(0, ev.agentsRunning | 0), busy = n > 0, rm = this.rm();
    const full = this.turns < MAX_TURNS;
    this.turns++;
    this.play(null, 4.6, 0, null, () => {}, () => { this.turns--; });
    const body = busy ? CYAN : P.main, edge = busy ? 0xd8fbff : mix(P.glow, 0xffffff, 0.4);
    this.pillarShot(pos, { color: busy ? CYAN : mix(P.main, P.glow, 0.45), height: busy ? 30 : 42, radius: busy ? 1.0 : 1.5, secs: 3.4 });
    this.flashDisc(L.x, top + 0.15, L.z, { r: L.r * 0.95, color: busy ? 0xc8f6ff : mix(P.glow, 0xffffff, 0.6), secs: 1.0, alpha: busy ? 0.45 : 0.8 });
    const maxR = L.r * 2.5, rings = rm ? 1 : busy || !full ? 2 : 3;
    for (let i = 0; i < rings; i++) {
      this.ringBurst(L.x, SEA_Y, L.z, { maxR: maxR * (1 - i * 0.1), color: body, glow: edge, delay: i * 0.42, secs: 2.6, width: i ? 0.06 : 0.1, fill: i ? 0.05 : 0.15, alpha: i ? 0.7 : 0.9 });
    }
    if (full && !rm) this.domeBurst(L.x, 0.1, L.z, { r: maxR * 0.8, color: body, alpha: busy ? 0.16 : 0.45 });
    const roof = vec(b.roof) || pos.clone().add(V3(0, 3.2, 0));
    this.engine.fx.flash(roof, { color: busy ? 0xc8f6ff : P.glow, size: 3.6, secs: 0.5 });
    if (!busy && !rm) this.engine.fx.confetti(roof.clone().add(V3(0, 0.6, 0)), { count: 34, power: 0.85 });
    const name = trunc(ev.name || s.name || 'Session', 30), at = this.bannerAt(L, top);
    if (busy) this.banner(at, `WAITING ON ${n} AGENT${n === 1 ? '' : 'S'}`, `${name} · your move meanwhile`, 'calm', W.island);
    else this.banner(at, 'YOUR MOVE', `Done ✓ ${name}${ev.secs ? ' · ' + dur(ev.secs) : ''}`, 'go', W.island);
    this.ready.set(ev.key, { at: this.t + 0.9, agents: n, keep: !!ev.test });
  }

  needsBurst(key) {
    const W = this.where(key);
    if (!W) return;
    const { L, top, pos, s } = W, rm = this.rm();
    for (let i = 0, n = rm ? 1 : 3; i < n; i++) {
      this.ringBurst(L.x, SEA_Y, L.z, { maxR: L.r * (3.0 - i * 0.35), color: i % 2 ? ORANGE : YELLOW, glow: 0xfffbe0, delay: i * 0.33, secs: 2.9, width: i ? 0.07 : 0.12, fill: i ? 0.06 : 0.18, alpha: 0.92 });
    }
    if (!rm) this.domeBurst(L.x, 0.1, L.z, { r: L.r * 2.4, color: YELLOW, alpha: 0.5 });
    this.flashDisc(L.x, top + 0.15, L.z, { r: L.r * 0.95, color: 0xfff1b0, secs: 1.1, alpha: 0.85 });
    this.pillarShot(pos, { color: YELLOW, height: 46, radius: 1.9, secs: 2.2 });
    this.engine.fx.flash(pos.clone().add(V3(0, 3, 0)), { color: YELLOW, size: 5, secs: 0.5 });
    this.banner(this.bannerAt(L, top), 'NEEDS YOU!', trunc(s.name || 'Session', 30), 'alert', W.island, 4.6);
  }

  agentDone(ev) {
    const w = this.world, b = w.buildings.get(ev.key);
    if (!b?.group) return;
    if (this.t - (this.lastAgent.get(ev.key) ?? -9) < 0.6) return;   // a wave of finishers: one burst per beat
    this.lastAgent.set(ev.key, this.t);
    const door = vec(b.door) || b.group.getWorldPosition(new THREE.Vector3());
    this.ringBurst(door.x, door.y + 0.1, door.z, { maxR: 5.5, color: CYAN, glow: 0xe8fdff, secs: 1.3, width: 0.16, fill: 0.2, alpha: 0.85 });
    this.engine.fx.flash(door.clone().add(V3(0, 0.9, 0)), { color: 0xc9faff, size: 2.2, secs: 0.4 });
    this.engine.fx.sparks(door.clone().add(V3(0, 1, 0)), CYAN, { count: 14, speed: 4 });
  }

  // ---- effect primitives (one-shot tracks on pooled meshes) ---------------------------------------------------------

  play(pool, secs, delay, setup, step, done) {
    const item = pool ? pool.get() : null;
    if (pool && !item) return null;                              // pool exhausted: skip this piece
    if (item) { setup?.(item); item.mesh.visible = false; }
    const tr = { item, pool, t: -delay, secs, step, done };
    this.tracks.push(tr);
    return tr;
  }

  ringBurst(x, y, z, { maxR, color, glow = 0xffffff, secs = 2.4, delay = 0, width = 0.09, fill = 0.12, alpha = 0.85, glowAmt = 1.3 }) {
    const g = glowAmt * (1 + 0.9 * this.night());
    return this.play(this.rings, secs, delay, (it) => {
      it.mesh.position.set(x, y, z);
      it.mesh.scale.set(maxR, 1, maxR);
      const u = it.u;
      u.uColor.value.set(color); u.uGlow.value.set(glow);
      u.uW.value = width; u.uFill.value = fill; u.uDisc.value = 0; u.uGlowAmt.value = g; u.uAlpha.value = 0; u.uR.value = 0.05;
    }, (k, tr) => {
      const u = tr.item.u;
      u.uR.value = 0.05 + 0.95 * ease.outCubic(k);
      u.uAlpha.value = alpha * (k < 0.55 ? 1 : 1 - (k - 0.55) / 0.45);
      u.uTime.value = this.t;
    });
  }

  flashDisc(x, y, z, { r, color = 0xffffff, secs = 0.9, alpha = 0.8 }) {
    return this.play(this.rings, secs, 0, (it) => {
      it.mesh.position.set(x, y, z);
      it.mesh.scale.set(r, 1, r);
      const u = it.u;
      u.uColor.value.set(color); u.uGlow.value.set(color); u.uDisc.value = 1; u.uGlowAmt.value = 0.6 + 0.8 * this.night();
    }, (k, tr) => { tr.item.u.uAlpha.value = alpha * Math.pow(1 - k, 1.6); });
  }

  domeBurst(x, y, z, { r, color, secs = 2.3, delay = 0, alpha = 0.4 }) {
    return this.play(this.domes, secs, delay, (it) => {
      it.mesh.position.set(x, y, z);
      it.u.uColor.value.set(color);
    }, (k, tr) => {
      tr.item.mesh.scale.setScalar(r * (0.18 + 0.82 * ease.outCubic(k)));
      tr.item.u.uAlpha.value = alpha * Math.pow(1 - k, 1.3) * (1 + 0.5 * this.night());
    });
  }

  pillarShot(pos, { color, height = 38, radius = 1.4, secs = 3.2, delay = 0, alpha = 1 }) {
    return this.play(this.pillars, secs, delay, (it) => {
      it.mesh.position.copy(pos);
      it.u.uColor.value.set(color);
      it.u.uStreak.value = this.rm() ? 0 : 1;
    }, (k, tr) => {
      const it = tr.item, rise = ease.outCubic(Math.min(1, tr.t / 0.4)), w = radius * (1.5 - 0.7 * ease.outCubic(k));
      it.mesh.scale.set(w, height * rise, w);
      it.u.uAlpha.value = alpha * (k < 0.35 ? 1 : Math.pow(1 - (k - 0.35) / 0.65, 1.2)) * (1 + 0.35 * this.night());
      it.u.uTime.value = this.t;
    });
  }

  banner(pos, title, sub, tone, island, secs = 4.4) {
    while (this.banners.length >= 4) this.banners.shift().lbl.remove();
    if (island) this.bandBusy.set(island, Math.max(this.bandBusy.get(island) || 0, this.t + secs));
    const off = new THREE.Vector3();
    const html = `<div class="ab-plate"><b>${esc(title)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}</div>`;
    const lbl = this.engine.labels.add({ position: pos, offset: off, kind: 'fx', className: `always ab-banner ab-${tone}${this.rm() ? ' ab-still' : ''}`, html });
    this.banners.push({ lbl, off, t: 0, secs, rise: this.rm() ? 0 : 1.8, op: 1 });
  }

  // ---- pooled meshes ---------------------------------------------------------------------------------------------------

  shader(geo, vert, frag, uniforms, order, side = THREE.FrontSide) {
    const mesh = new THREE.Mesh(geo, new THREE.ShaderMaterial({ uniforms, vertexShader: vert, fragmentShader: frag, side, ...BLEND }));
    mesh.visible = false;
    mesh.renderOrder = order;
    mesh.userData.noPick = true;
    this.group.add(mesh);
    return { mesh, u: uniforms, busy: false, k: 0 };
  }

  makeRing() {
    return this.shader(RING_GEO, RING_VERT, RING_FRAG, {
      uColor: { value: new THREE.Color() }, uGlow: { value: new THREE.Color() }, uR: { value: 0 }, uW: { value: 0.08 },
      uAlpha: { value: 0 }, uGlowAmt: { value: 1 }, uFill: { value: 0 }, uDisc: { value: 0 }, uTime: { value: 0 },
    }, 3, THREE.DoubleSide);
  }

  makeDome() { return this.shader(DOME_GEO, DOME_VERT, DOME_FRAG, { uColor: { value: new THREE.Color() }, uAlpha: { value: 0 } }, 4); }

  makePillar() {
    return this.shader(PILLAR_GEO, PILLAR_VERT, PILLAR_FRAG, {
      uColor: { value: new THREE.Color() }, uAlpha: { value: 0 }, uTime: { value: 0 }, uStreak: { value: 1 },
    }, 5);
  }

  makeBang() {
    const mat = new THREE.MeshLambertMaterial({ color: YELLOW, emissive: 0xffa800, emissiveIntensity: 0.6, flatShading: true });
    const ink = new THREE.MeshBasicMaterial({ color: 0x14121c, side: THREE.BackSide });
    const part = (geo, y, s) => {
      const m = new THREE.Mesh(geo, mat), o = new THREE.Mesh(geo, ink);
      m.position.y = o.position.y = y;
      o.scale.set(...s);
      return [m, o];
    };
    const body = new THREE.Group();
    body.add(...part(BANG_BAR, 2.75, [1.17, 1.06, 1.17]), ...part(BANG_DOT, 0.42, [1.2, 1.2, 1.2]));
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.halo, color: 0xffc83a, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: false }));
    const group = new THREE.Group();
    group.name = 'giant-bang';
    group.add(body, halo);
    group.traverse((o) => { o.userData.noPick = true; });
    this.group.add(group);
    return { group, body, halo, mat, k: 0, want: false, phase: 0 };
  }

  addBang(id, instant) {
    const B = this.spareBangs.pop() || this.makeBang();
    Object.assign(B, { k: instant ? 1 : 0, want: true, phase: Math.random() * 6, lift: instant ? 140 : 230, x: null, z: 0 });
    B.group.visible = true;
    this.bangs.set(id, B);
  }

  makeCheck() {
    const mat = new THREE.MeshLambertMaterial({ color: GREEN, emissive: 0x16b85f, emissiveIntensity: 0.6, flatShading: true });
    const ink = new THREE.MeshBasicMaterial({ color: 0x0b1026, side: THREE.BackSide });
    const arm = (geo, x, y, rz) => {
      const m = new THREE.Mesh(geo, mat), o = new THREE.Mesh(geo, ink);
      for (const q of [m, o]) { q.position.set(x, y, 0); q.rotation.z = rz; }
      o.scale.set(1.3, 1.1, 1.3);
      return [m, o];
    };
    const inner = new THREE.Group();
    inner.add(...arm(CHECK_SHORT, -0.31, 0.31, Math.atan2(-0.62, -0.62)), ...arm(CHECK_LONG, 0.525, 0.725, Math.atan2(-1.05, 1.45)));
    inner.position.set(-0.2, 0.25, 0);
    const group = new THREE.Group();
    group.name = 'ready-beacon';
    group.add(inner);
    group.traverse((o) => { o.userData.noPick = true; });
    this.group.add(group);
    return { group, mat, k: 0, ring: 0, phase: 0 };
  }

  takeCheck(instant) {
    const C = this.spareChecks.pop() || this.makeCheck();
    Object.assign(C, { k: instant ? 1 : 0, ring: 2 + Math.random(), phase: Math.random() * 6, lift: null });
    C.beam = this.pillars.get();
    if (C.beam) { C.beam.u.uColor.value.set(GREEN); C.beam.u.uStreak.value = 0; }
    C.group.visible = true;
    return C;
  }

  // ---- per frame -----------------------------------------------------------------------------------------------------

  tick(dt) {
    this.t += dt;
    const rm = this.rm(), night = this.night(), ppu = this.ppu();
    this.engine.camera.getWorldDirection(_f);
    for (let i = this.tracks.length - 1; i >= 0; i--) {
      const tr = this.tracks[i];
      tr.t += dt;
      if (tr.t < 0) continue;
      const k = Math.min(1, tr.t / tr.secs);
      if (tr.item) tr.item.mesh.visible = true;
      tr.step(k, tr);
      if (k >= 1) {
        if (tr.item) tr.pool.release(tr.item);
        this.tracks.splice(i, 1);
        tr.done?.();
      }
    }
    this.tickBangs(dt, rm, night, ppu);
    this.tickChecks(dt, rm, night, ppu);
    this.tickBanners(dt);
  }

  tickBangs(dt, rm, night, ppu) {
    const w = this.world;
    for (const [id, B] of this.bangs) {
      const L = w.layout.get(id);
      if (!L) B.want = false;
      B.k = B.want ? Math.min(1, B.k + dt / 0.9) : Math.max(0, B.k - dt / 0.35);
      if (!B.want && B.k <= 0) { B.group.visible = false; this.bangs.delete(id); this.spareBangs.push(B); continue; }
      if (!L) continue;
      const top = w.islands.get(id)?.top ?? 1.5;
      const s = Math.max(1.35, 150 / (4.25 * ppu));             // never smaller than ~150 px on screen
      // hover over the waiting base(s): the island center for one on the main island, the islet for a worktree
      let n = 0, x = 0, z = 0;
      _groups.length = 0;
      _groups.push('island:' + id);
      for (const key of this.needs) {
        const b = w.buildings.get(key), m = w.bmeta.get(key);
        if (!b?.group || m?.island !== id) continue;
        if (m.annex) _groups.push('annex:' + m.annex);
        b.group.getWorldPosition(_v);
        x += _v.x; z += _v.z; n++;
      }
      if (n) { x /= n; z /= n; if (B.x == null) { B.x = x; B.z = z; } B.x = damp(B.x, x, 4, dt); B.z = damp(B.z, z, 4, dt); }
      else if (B.x == null) { B.x = L.x; B.z = L.z; }
      // high while a banner shows, then just above the island's label stack (never lower than 140 px)
      const want = Math.max((this.bandBusy.get(id) || 0) > this.t ? 230 : 140, this.clearStack(_groups, _v.set(B.x, top, B.z), 70, 16));
      B.lift = damp(B.lift, want, 3, dt);
      const lift = Math.max(8, B.lift / (ppu * 0.82));
      const appear = B.want ? (rm ? B.k : ease.outElastic(B.k)) : B.k * B.k;
      const drop = B.want && !rm ? (1 - ease.outBounce(Math.min(1, B.k * 1.1))) * 9 : 0;
      const bob = rm ? 0 : Math.sin(this.t * 2.1 + B.phase) * 0.35 * s;
      B.group.position.set(B.x, top + lift + drop + bob, B.z);
      B.body.scale.setScalar(Math.max(0.001, s * appear));
      if (rm) B.body.rotation.y = this.engine.view.azimuth;
      else B.body.rotation.y += dt * 0.75;
      B.halo.position.set(0, 2.1 * s, 0).addScaledVector(_f, 8);   // behind the "!" so the body occludes it
      B.halo.scale.setScalar(Math.max(0.001, s * appear * 8.5));      // steady glow: the entry burst was the one pulse
      B.halo.material.opacity = (0.35 + 0.35 * night) * Math.min(1, appear);
      B.mat.emissiveIntensity = 0.65 * (1 + 0.6 * night);
    }
  }

  tickChecks(dt, rm, night, ppu) {
    const w = this.world;
    for (const [key, r] of this.ready) {
      if (r.at <= this.t && !r.agents && !this.checks.has(key) && w.buildings.has(key)) this.checks.set(key, this.takeCheck(r.instant));
    }
    for (const [key, C] of this.checks) {
      const want = this.ready.get(key)?.agents === 0, b = w.buildings.get(key);
      C.k = want ? Math.min(1, C.k + dt / 0.6) : Math.max(0, C.k - dt / 0.3);
      if ((!want && C.k <= 0) || !b?.group) {
        C.group.visible = false;
        if (C.beam) { this.pillars.release(C.beam); C.beam = null; }
        this.checks.delete(key);
        this.spareChecks.push(C);
        continue;
      }
      const roof = vec(b.roof) || b.group.getWorldPosition(new THREE.Vector3()).add(V3(0, 3.5, 0));
      const s = Math.max(1, 46 / (2.1 * ppu));                    // at least ~46 px tall
      const m = w.bmeta.get(key);                                 // clear above the label stack over this base
      const goal = Math.max(70, this.clearStack(m?.annex ? 'annex:' + m.annex : 'island:' + m?.island, roof, 34, 12));
      C.lift = C.lift == null ? goal : damp(C.lift, goal, 4, dt);
      const lift = Math.max(3, C.lift / (ppu * 0.82));
      const bob = rm ? 0 : Math.sin(this.t * 1.8 + C.phase) * 0.18 * s;
      C.group.position.set(roof.x, roof.y + lift + bob, roof.z);
      const breathe = rm ? 1 : 1 + 0.05 * Math.sin(this.t * 2.4 + C.phase);
      C.group.scale.setScalar(Math.max(0.001, s * breathe * (want ? ease.outBack(C.k) : C.k)));
      C.group.rotation.y = this.engine.view.azimuth;              // faces the camera
      C.mat.emissiveIntensity = (0.5 + 0.25 * Math.sin(this.t * 2.4 + C.phase)) * (1 + 0.7 * night);
      if (C.beam) {                                               // a faint beam from the roof up to the check
        C.beam.mesh.visible = true;
        C.beam.mesh.position.copy(roof);
        C.beam.mesh.scale.set(0.2, lift + 0.3, 0.2);
        C.beam.u.uAlpha.value = (0.35 + 0.15 * Math.sin(this.t * 2.4 + C.phase)) * (want ? C.k : C.k * C.k) * (1 + 0.5 * night);
      }
      if (!rm && want && (C.ring -= dt) <= 0) {
        C.ring = 4.5;
        b.group.getWorldPosition(_v);
        this.ringBurst(_v.x, _v.y + 0.12, _v.z, { maxR: 4.2, color: GREEN, glow: 0xffffff, secs: 1.6, width: 0.14, fill: 0.08, alpha: 0.5, glowAmt: 0.8 });
      }
    }
  }

  tickBanners(dt) {
    for (let i = this.banners.length - 1; i >= 0; i--) {
      const B = this.banners[i];
      B.t += dt;
      const k = B.t / B.secs;
      if (k >= 1) { B.lbl.remove(); this.banners.splice(i, 1); continue; }
      B.off.y = B.rise * ease.outCubic(Math.min(1, k * 1.4));
      const op = k > 0.8 ? Math.round((1 - (k - 0.8) / 0.2) * 20) / 20 : 1;
      if (op !== B.op) { B.op = op; B.lbl.el.style.opacity = op; }
    }
  }

  // ---- dev hook ---------------------------------------------------------------------------------------------------------

  // ?alerttest=turn|busy|needs|agent|all (&alertseek=secs): fire effects on demand after the first snapshot and
  // fast-forward them, so a headless screenshot lands mid-animation. Test states stick (they ignore the feed).
  test(kind, seek = 1.2) {
    const w = this.world, keys = [...w.buildings.keys()];
    if (!keys.length) return;
    const first = new Map();
    for (const k of keys) { const i = w.bmeta.get(k)?.island; if (!first.has(i)) first.set(i, k); }
    const spread = [...first.values(), ...keys];
    const kinds = kind === 'all' ? ['turn', 'needs', 'agent', 'busy'] : [kind];
    kinds.forEach((k, i) => {
      const key = spread[i % spread.length], s = w.bmeta.get(key)?.session || {};
      if (k === 'turn' || k === 'busy') this.turnDone({ type: 'turn_done', key, name: s.name, secs: k === 'busy' ? 95 : 272, agentsRunning: k === 'busy' ? 2 : 0, test: true });
      else if (k === 'agent') this.agentDone({ type: 'agent_done', key });
      else if (k === 'needs') { this.forced.add(key); this.sync(w.snapshot); }
    });
    const q = new URLSearchParams(location.search);
    if (!q.has('focus')) {
      const p = w.positionOf({ type: 'session', id: spread[0] });
      if (p) this.engine.view.focus(p, { zoom: parseFloat(q.get('zoom')) || (kinds.length > 1 ? 0.85 : 1.1), secs: 0 });
    }
    for (let t = 0; t < seek; t += 1 / 30) { this.tick(1 / 30); this.engine.fx.tick(1 / 30); }
  }
}
