// The engine: renderer, iso camera + controls, lights, day/night sky, sea, weather, picking, labels, fx and the
// frame loop. Everything world modules rely on hangs off the object returned by createEngine() (DESIGN §4).
//
// Conventions: the camera orbits a ground point (y = 0) at a fixed 35° elevation; `view.zoom` is a scalar
// (1 = default framing, 2 = twice as close). Programmatic moves (focus/fit/rotate) never count as user input,
// so a director can drive the camera and still tell when the human last touched it (view.lastInputAt).
import * as THREE from 'three';
import { tickTweens, clamp, lerp, damp, ease, freeze } from './kit.js';
import { Labels } from './labels.js';
import { Fx } from './fx.js';

const EL = THREE.MathUtils.degToRad(35);
const SIN_EL = Math.sin(EL), COS_EL = Math.cos(EL), TAN_EL = Math.tan(EL);
const BASE_HALF = 30;            // visible half-height (world units) at zoom 1
const CAM_DIST = 450;
const ZOOM_MIN = 0.2, ZOOM_MAX = 4.5;
const HOME_AZ = Math.PI / 4;
const SEA_SEG = 128;
const MAX_FOAM = 32;
const SHADOW_MAP = 2048;
const SHADOW_HZ = 15;            // shadow map redraws per second (every other frame at the default 30 fps cap)
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

// ---- settings (reactive, persisted) ----------------------------------------------------------------------

// fps: frame cap as a string ('60' | '30' | '20'); 30 keeps an always-on spare-monitor display light on the GPU.
export const SETTING_DEFAULTS = { labels: 'all', daynight: 'auto', director: true, voice: false, quality: 'high', showIdle: true, reduceMotion: false, fps: '30' };
const SETTINGS_KEY = 'cnc.settings';

// A plain JSON object (not null, an array, a string or a number): anything else in storage is corrupt.
const isPlainObject = (x) => !!x && typeof x === 'object' && !Array.isArray(x);

// URL params override settings for this page load only (handy for screenshots): ?daynight=night&labels=hover
function createSettings() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); } catch { /* storage blocked or corrupt */ }
  if (!isPlainObject(saved)) saved = {};   // corrupt saved settings fall back to the defaults
  const vals = { ...SETTING_DEFAULTS };
  if (!('reduceMotion' in saved) && window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) vals.reduceMotion = true;
  for (const k in SETTING_DEFAULTS) if (k in saved && typeof saved[k] === typeof SETTING_DEFAULTS[k]) vals[k] = saved[k];
  const stored = { ...vals };
  const q = new URLSearchParams(location.search);
  for (const k in SETTING_DEFAULTS) {
    if (!q.has(k)) continue;
    const raw = q.get(k);
    vals[k] = typeof SETTING_DEFAULTS[k] === 'boolean' ? !/^(0|false|off|no)$/i.test(raw) : raw;
  }
  const subs = new Map();
  const settings = {
    defaults: { ...SETTING_DEFAULTS },
    get: (k) => vals[k],
    set(k, v) {
      if (!(k in SETTING_DEFAULTS) || vals[k] === v) return;
      const prev = vals[k];
      vals[k] = stored[k] = v;
      try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(stored)); } catch { /* ignore */ }
      for (const fn of [...(subs.get(k) || []), ...(subs.get('*') || [])]) {
        try { fn(v, prev, k); } catch (e) { console.error(e); }
      }
    },
    // on(key, fn(value, prev, key)) -> off(); key '*' listens to every setting.
    on(k, fn) {
      if (!subs.has(k)) subs.set(k, new Set());
      subs.get(k).add(fn);
      return () => subs.get(k)?.delete(fn);
    },
    toJSON: () => ({ ...vals }),
  };
  for (const k in SETTING_DEFAULTS) {
    Object.defineProperty(settings, k, { get: () => vals[k], set: (v) => settings.set(k, v), enumerable: true });
  }
  return settings;
}

// ---- tiny event bus ------------------------------------------------------------------------------------------

function createBus() {
  const m = new Map();
  return {
    on(ev, fn) {
      if (!m.has(ev)) m.set(ev, new Set());
      m.get(ev).add(fn);
      return () => m.get(ev)?.delete(fn);
    },
    off(ev, fn) { m.get(ev)?.delete(fn); },
    once(ev, fn) { const off = this.on(ev, (...a) => { off(); fn(...a); }); return off; },
    emit(ev, ...args) {
      const s = m.get(ev);
      if (!s) return;
      for (const fn of [...s]) { try { fn(...args); } catch (e) { console.error(e); } }
    },
  };
}

// ---- sky palette keyframes (sRGB hex, blended in linear space) -------------------------------------------------

const KF = {
  day:   { hi: '#e8fbff', lo: '#9fe3ff', sun: '#fff3de', hs: '#d6f1ff', hg: '#9bb57a', sea: '#27bfd6', deep: '#1573ad', shallow: '#6cebdc', foam: '#f4fffd', spec: '#ffffff', sunI: 2.9, hemI: 1.55 },
  gold:  { hi: '#ffe3c8', lo: '#ffae8f', sun: '#ffb06a', hs: '#ffd6bf', hg: '#8f735a', sea: '#35a6c8', deep: '#1d5690', shallow: '#86d9cf', foam: '#fff1e4', spec: '#ffdcae', sunI: 2.5, hemI: 1.3 },
  night: { hi: '#3b3f8c', lo: '#1d2259', sun: '#b4c4ff', hs: '#7486d8', hg: '#2c3163', sea: '#1f4c8a', deep: '#10245a', shallow: '#2f82ad', foam: '#bccfff', spec: '#dbe4ff', sunI: 1.6, hemI: 1.4 },
  storm: { hi: '#aeb8c4', lo: '#7b8898', sun: '#d6dbe4', hs: '#a4b0be', hg: '#565f6b', sea: '#2c7a8e', deep: '#17445e', shallow: '#5a9aa3', foam: '#f2f7fa', spec: '#e6edf4', sunI: 1.3, hemI: 1.45 },
};
const COLOR_KEYS = ['hi', 'lo', 'sun', 'hs', 'hg', 'sea', 'deep', 'shallow', 'foam', 'spec'];
for (const k of Object.values(KF)) for (const c of COLOR_KEYS) k[c] = new THREE.Color(k[c]);

// ---- sea shader --------------------------------------------------------------------------------------------------

const HASH = /* glsl */ `float h21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }`;

const SEA_VERT = /* glsl */ `
uniform float uTime;
uniform float uAmp;
uniform float uCell;
uniform float uChop;
varying vec3 vW;
varying float vH;
${HASH}
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vec2 id = floor(w.xz / uCell + 0.5);
  float r1 = h21(id), r2 = h21(id + 17.31);
  w.xz += (vec2(r1, r2) - 0.5) * uCell * 0.62;          // irregular low-poly facets, stable in world space
  vec2 p = w.xz;
  float t = uTime;
  float h = sin(dot(p, vec2(0.23, 0.11)) + t * 0.9) * 0.5
          + sin(dot(p, vec2(-0.13, 0.27)) + t * 1.25) * 0.35
          + sin(dot(p, vec2(0.41, -0.33)) + t * 1.8) * 0.2;
  h += sin(t * (1.3 + r1 * 1.4) + r2 * 6.2831) * uChop;  // per-vertex bob: facets catch the sun and twinkle
  w.y = h * uAmp;
  vH = h;
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const SEA_FRAG = /* glsl */ `
#define MAX_FOAM ${MAX_FOAM}
uniform float uTime;
uniform vec3 uSunDir;
uniform vec3 uViewDir;
uniform vec3 uSea;
uniform vec3 uDeep;
uniform vec3 uShallow;
uniform vec3 uFoamCol;
uniform vec3 uSpec;
uniform vec3 uHazeLo;
uniform vec3 uHazeHi;
uniform vec2 uRes;
uniform vec2 uHaze;
uniform float uNight;
uniform float uFlash;
uniform float uStorm;
uniform vec4 uFoam[MAX_FOAM];
uniform int uFoamN;
varying vec3 vW;
varying float vH;
${HASH}
void main() {
  vec3 n = normalize(cross(dFdx(vW), dFdy(vW)));
  if (n.y < 0.0) n = -n;

  // distance to the nearest registered shore (foam rings)
  float d = 1e4, ang = 0.0, fs = 1.0;
  for (int i = 0; i < MAX_FOAM; i++) {
    if (i >= uFoamN) break;
    vec4 f = uFoam[i];
    vec2 q = vW.xz - f.xy;
    float di = length(q) - f.z;
    if (di < d) { d = di; ang = atan(q.y, q.x) + f.x * 0.37; fs = f.w; }
  }

  // shallows near islands -> open sea -> deep water far out
  float shallow = 1.0 - smoothstep(-1.0, 8.5, d);
  float deep = smoothstep(5.0, 42.0, d);
  vec3 col = mix(uSea, uDeep, deep);
  col = mix(col, uShallow, shallow * shallow);

  // faceted light (slopes exaggerated so the low-poly facets read) + sun glints
  vec3 ns = normalize(vec3(n.x * 3.2, n.y, n.z * 3.2));
  col *= 0.8 + 0.32 * dot(ns, uSunDir);
  // glints: facets tilted toward the sun (relative to flat water) flash as the waves roll through
  vec3 hv = normalize(uSunDir + uViewDir);
  float tilt = dot(n.xz, normalize(hv.xz + vec2(1e-4)));
  col += uSpec * (smoothstep(0.15, 0.2, tilt) * 0.4 + pow(max(dot(n, hv), 0.0), 24.0) * 0.08);

  // foam: wobbly band hugging the shore + a ripple rolling outward
  float wob = sin(ang * 6.0 + uTime * 0.7) * 0.3 + sin(ang * 11.0 - uTime * 1.3) * 0.18;
  float band = (1.0 - smoothstep(0.15, 1.15, d - wob)) * smoothstep(-1.6, -0.6, d);
  float ph = fract(uTime * 0.16);
  float rip = (1.0 - smoothstep(0.0, 0.3, abs(d - wob * 0.6 - (0.9 + ph * 3.4)))) * (1.0 - ph) * 0.7;
  col = mix(col, uFoamCol, clamp(band + rip, 0.0, 1.0) * fs);

  // storm whitecaps on the wave crests
  col = mix(col, uFoamCol, smoothstep(0.95, 1.25, vH) * uStorm * 0.65);

  // atmospheric haze toward the top of the screen = the "sky" of an iso diorama
  float sy = gl_FragCoord.y / uRes.y;
  float hz = smoothstep(uHaze.x, 1.12, sy);
  col = mix(col, mix(uHazeLo, uHazeHi, smoothstep(uHaze.x + 0.15, 1.0, sy)), hz * uHaze.y);

  // stars twinkle in the night haze
  if (uNight > 0.01) {
    float r = h21(floor(gl_FragCoord.xy / 3.0));
    float tw = 0.55 + 0.45 * sin(uTime * (0.8 + r * 2.5) + r * 60.0);
    col += vec3(0.9, 0.95, 1.0) * step(0.9983, r) * tw * uNight * hz;
  }
  col += uFlash * vec3(0.5, 0.56, 0.7);
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

// ---- rain shader (drawn only in storms; all motion on the GPU) ---------------------------------------------------

const RAIN_VERT = /* glsl */ `
uniform float uTime;
uniform vec3 uCenter;
uniform vec3 uSize;
uniform float uWind;
attribute float aTail;
void main() {
  vec3 p = position;
  float fall = fract(p.y - uTime * (1.2 + p.x * 0.5));
  vec3 w = vec3((p.x - 0.5) * uSize.x, fall * uSize.y, (p.z - 0.5) * uSize.z) + uCenter;
  w.x += aTail * uWind * 0.8;
  w.y += aTail * 2.2;
  gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
}`;
const RAIN_FRAG = /* glsl */ `
uniform float uOpacity;
uniform vec3 uColor;
void main() {
  gl_FragColor = vec4(uColor, uOpacity);
  #include <colorspace_fragment>
}`;

// ---- engine --------------------------------------------------------------------------------------------------------

export function createEngine({ container = document.body, labelRoot = null } = {}) {
  const settings = createSettings();
  const bus = createBus();
  const params = new URLSearchParams(location.search);

  // renderer ----------------------------------------------------------------------------------------------------
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NeutralToneMapping;   // keeps toy colors saturated (ACES washes them out)
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;      // r186: PCFSoft was removed; PCF is the soft Vogel-disk filter
  renderer.shadowMap.autoUpdate = false;             // redrawn at SHADOW_HZ, see updateShadows()
  renderer.domElement.className = 'cnc-canvas';
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const root = new THREE.Group();
  root.name = 'world';
  scene.add(root);
  // Neither ever moves. Frozen, they no longer force every world matrix in the tree to be recomputed each frame; a
  // subtree is then only updated below objects that still recompose themselves (anything not frozen, kit.js freeze).
  freeze(scene, { deep: false });
  freeze(root, { deep: false });
  const camera = new THREE.OrthographicCamera(-10, 10, 10, -10, 5, 1400);
  scene.fog = new THREE.Fog(0xcdefff, 500, 800);

  let labelsEl = labelRoot;
  if (!labelsEl) {
    labelsEl = document.createElement('div');
    labelsEl.id = 'labels';
    document.body.appendChild(labelsEl);
  }

  const engine = {
    THREE, renderer, scene, camera, root, settings, bus,
    time: 0,
    frame: 0,
    daylight: 1,
    nightBoost: 1,
    wind: 0.2,
    storm: 0,
    sunDir: new THREE.Vector3(0, 1, 0),
    serverOffset: 0,
  };

  const frameFns = new Set();
  const failedFns = new WeakSet();
  engine.onFrame = (fn) => { frameFns.add(fn); return () => frameFns.delete(fn); };
  engine.frameFnCount = () => frameFns.size;          // leak checks (soak tests)
  // Nothing has been drawn for a while (window minimized / fully covered: the browser stops animation frames, but
  // snapshots keep arriving). world.js applies snapshots without animations then, so nothing piles up.
  let lastFrameAt = performance.now();
  engine.renderStalled = () => performance.now() - lastFrameAt > 2500;
  // Updates to existing entities still start tweens then: finish them on a slow timer (they would otherwise queue up,
  // holding on to whatever they animate, until the window is shown again). Hidden tabs run this about once a minute.
  let bgTickAt = performance.now();
  setInterval(() => {
    const now = performance.now(), secs = Math.min(60, (now - bgTickAt) / 1000);
    bgTickAt = now;
    if (engine.renderStalled()) tickTweens(secs);
  }, 1000);
  engine.serverNow = () => Date.now() + engine.serverOffset;
  engine.syncClock = (snapNow) => { if (Number.isFinite(snapNow)) engine.serverOffset = snapNow - Date.now(); };

  // lights --------------------------------------------------------------------------------------------------------
  const hemi = new THREE.HemisphereLight(0xd6f1ff, 0x9bb57a, 1.5);
  const sun = new THREE.DirectionalLight(0xfff3de, 2.9);
  sun.castShadow = true;
  sun.shadow.mapSize.set(SHADOW_MAP, SHADOW_MAP);
  sun.shadow.radius = 2.5;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.04;
  sun.shadow.intensity = 0.82;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 320;
  scene.add(hemi, sun, sun.target);
  engine.lights = { hemi, sun };

  // sky background (screen-space gradient; mostly peeks out when zoomed far out) ----------------------------------
  const bgCanvas = document.createElement('canvas');
  bgCanvas.width = 2; bgCanvas.height = 128;
  const bgCtx = bgCanvas.getContext('2d');
  const bgTex = new THREE.CanvasTexture(bgCanvas);
  bgTex.colorSpace = THREE.SRGBColorSpace;
  scene.background = bgTex;
  let bgKey = '';
  function paintBackground(top, bottom) {
    const key = top.getHexString() + bottom.getHexString();
    if (key === bgKey) return;
    bgKey = key;
    const g = bgCtx.createLinearGradient(0, 0, 0, 128);
    g.addColorStop(0, '#' + top.getHexString());
    g.addColorStop(1, '#' + bottom.getHexString());
    bgCtx.fillStyle = g;
    bgCtx.fillRect(0, 0, 2, 128);
    bgTex.needsUpdate = true;
  }

  // sea -------------------------------------------------------------------------------------------------------------
  const foamRings = new Set();
  let foamDirty = true;
  const seaU = {
    uTime: { value: 0 }, uAmp: { value: 0.22 }, uCell: { value: 1.4 }, uChop: { value: 0.32 },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) }, uViewDir: { value: new THREE.Vector3(0, 1, 0) },
    uSea: { value: new THREE.Color() }, uDeep: { value: new THREE.Color() }, uShallow: { value: new THREE.Color() },
    uFoamCol: { value: new THREE.Color() }, uSpec: { value: new THREE.Color() },
    uHazeLo: { value: new THREE.Color() }, uHazeHi: { value: new THREE.Color() },
    uRes: { value: new THREE.Vector2(1, 1) }, uHaze: { value: new THREE.Vector2(0.48, 0.62) },
    uNight: { value: 0 }, uFlash: { value: 0 }, uStorm: { value: 0 },
    uFoam: { value: Array.from({ length: MAX_FOAM }, () => new THREE.Vector4()) }, uFoamN: { value: 0 },
  };
  const seaGeo = new THREE.PlaneGeometry(SEA_SEG, SEA_SEG, SEA_SEG, SEA_SEG);
  seaGeo.rotateX(-Math.PI / 2);
  const sea = new THREE.Mesh(seaGeo, new THREE.ShaderMaterial({ uniforms: seaU, vertexShader: SEA_VERT, fragmentShader: SEA_FRAG }));
  sea.frustumCulled = false;
  sea.renderOrder = -10;
  sea.name = 'sea';
  sea.userData.noPick = true;
  scene.add(sea);

  // Foam ring + shallows at an island's waterline. -> { set(center, radius), remove() }
  engine.addFoamRing = (center, radius, { strength = 1 } = {}) => {
    const f = { x: center.x, z: center.z, r: radius, s: strength };
    foamRings.add(f);
    foamDirty = true;
    return {
      set(c, r) { if (c) { f.x = c.x; f.z = c.z; } if (r != null) f.r = r; foamDirty = true; },
      remove() { foamRings.delete(f); foamDirty = true; },
    };
  };

  // rain --------------------------------------------------------------------------------------------------------------
  const RAIN_N = 900;
  const rainPos = new Float32Array(RAIN_N * 6), rainTail = new Float32Array(RAIN_N * 2);
  for (let i = 0; i < RAIN_N; i++) {
    const x = Math.random(), y = Math.random(), z = Math.random();
    rainPos.set([x, y, z, x, y, z], i * 6);
    rainTail[i * 2 + 1] = 1;
  }
  const rainGeo = new THREE.BufferGeometry();
  rainGeo.setAttribute('position', new THREE.BufferAttribute(rainPos, 3));
  rainGeo.setAttribute('aTail', new THREE.BufferAttribute(rainTail, 1));
  const rainU = { uTime: { value: 0 }, uCenter: { value: new THREE.Vector3() }, uSize: { value: new THREE.Vector3(80, 26, 80) }, uWind: { value: 1 }, uOpacity: { value: 0 }, uColor: { value: new THREE.Color(0xd8ecff) } };
  const rain = new THREE.LineSegments(rainGeo, new THREE.ShaderMaterial({ uniforms: rainU, vertexShader: RAIN_VERT, fragmentShader: RAIN_FRAG, transparent: true, depthWrite: false }));
  rain.frustumCulled = false;
  rain.visible = false;
  rain.renderOrder = 5;
  scene.add(rain);

  // ---- view: iso camera + controls -------------------------------------------------------------------------------------
  const st = { tx: 0, tz: 0, zoom: 1, zoomGoal: 1, az: HOME_AZ, w: 1, h: 1, aspect: 1 };
  const anchor = new THREE.Vector2();             // NDC anchor for smooth wheel zoom
  const vel = new THREE.Vector2();                // pan inertia (world units / s)
  const keys = new Set();
  const inputFns = new Set();
  let flight = null, spin = null, boundsFn = null;
  const loadedAt = Date.now();
  const _g = new THREE.Vector3(), _g2 = new THREE.Vector3();

  const basis = () => {
    const s = Math.sin(st.az), c = Math.cos(st.az);
    return { dx: COS_EL * s, dy: SIN_EL, dz: COS_EL * c, rx: c, rz: -s, ux: -SIN_EL * s, uy: COS_EL, uz: -SIN_EL * c, gx: -s, gz: -c };
  };
  const halfH = () => BASE_HALF / st.zoom;

  // Ground point (y = gy) under NDC (nx, ny) for the current (or given) camera state. Pure math, no matrices.
  function groundAtNdc(nx, ny, out, gy = 0, zoom = st.zoom) {
    const b = basis(), hh = BASE_HALF / zoom, hw = hh * st.aspect;
    const ox = st.tx + b.dx * CAM_DIST + b.rx * nx * hw + b.ux * ny * hh;
    const oy = b.dy * CAM_DIST + b.uy * ny * hh;
    const oz = st.tz + b.dz * CAM_DIST + b.rz * nx * hw + b.uz * ny * hh;
    const t = (oy - gy) / SIN_EL;
    return out.set(ox - b.dx * t, gy, oz - b.dz * t);
  }

  function applyCamera() {
    const b = basis(), hh = halfH(), hw = hh * st.aspect;
    camera.position.set(st.tx + b.dx * CAM_DIST, b.dy * CAM_DIST, st.tz + b.dz * CAM_DIST);
    camera.up.set(0, 1, 0);
    camera.lookAt(st.tx, 0, st.tz);
    if (camera.top !== hh || camera.right !== hw) {
      camera.left = -hw; camera.right = hw; camera.top = hh; camera.bottom = -hh;
      camera.updateProjectionMatrix();
    }
    camera.updateMatrixWorld();
  }

  function markInput() {
    view.lastInputAt = Date.now();
    for (const fn of inputFns) { try { fn(); } catch (e) { console.error(e); } }
  }

  function cancelMoves() {
    if (flight) { flight.res(); flight = null; }
  }

  // Animate target/zoom. Long hops zoom out a little mid-flight (cinematic, and it keeps context on screen).
  function flyTo(x, z, zoom, secs, easeFn = ease.inOut) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) { x = st.tx; z = st.tz; }
    zoom = clamp(Number.isFinite(zoom) ? zoom : st.zoomGoal, ZOOM_MIN, ZOOM_MAX);
    vel.set(0, 0);
    if (flight) { flight.res(); flight = null; }
    if (!secs || secs <= 0) {
      st.tx = x; st.tz = z; st.zoom = st.zoomGoal = zoom;
      return Promise.resolve();
    }
    const dist = Math.hypot(x - st.tx, z - st.tz);
    const span = halfH() * st.aspect * 2;
    const hop = span > 0 ? clamp(dist / span - 0.4, 0, 0.35) : 0;
    return new Promise((res) => {
      flight = { t: 0, secs, fx: st.tx, fz: st.tz, fzoom: Math.log(st.zoom), tx: x, tz: z, tzoom: Math.log(zoom), ease: easeFn, hop, res };
    });
  }

  // Zoom + ground target that frame a shape for the given azimuth. shape: Box3 | Sphere | [{ x, z, r, h }] (flat
  // discs such as islands: r = radius, h = height of stuff on them). Discs fit much tighter than a Box3 at 45°.
  function fitFor(shape, az = st.az, pad = 1.1) {
    const s = Math.sin(az), c = Math.cos(az);
    const rx = c, rz = -s, ux = -SIN_EL * s, uy = COS_EL, uz = -SIN_EL * c;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    const add = (px, py, pz, r, h) => {
      const a = px * rx + pz * rz, b = px * ux + py * uy + pz * uz;
      x0 = Math.min(x0, a - r); x1 = Math.max(x1, a + r);
      y0 = Math.min(y0, b - r * SIN_EL); y1 = Math.max(y1, b + r * SIN_EL + h * COS_EL);
    };
    if (shape?.isBox3) {
      for (let i = 0; i < 8; i++) add(i & 1 ? shape.max.x : shape.min.x, i & 2 ? shape.max.y : shape.min.y, i & 4 ? shape.max.z : shape.min.z, 0, 0);
    } else if (shape?.isSphere) add(shape.center.x, shape.center.y, shape.center.z, shape.radius, shape.radius);
    else for (const d of shape || []) add(d.x, d.y || 0, d.z, d.r || 0, d.h || 0);
    if (!Number.isFinite(x0)) return { x: st.tx, z: st.tz, zoom: st.zoom };
    const hh = Math.max((y1 - y0) / 2, (x1 - x0) / 2 / st.aspect, 6) * pad;
    // ground point whose projection is the middle of the extents
    const mx = (x0 + x1) / 2, my = (y0 + y1) / 2 / SIN_EL;
    return { x: c * mx - s * my, z: -s * mx - c * my, zoom: clamp(BASE_HALF / hh, ZOOM_MIN, 1.8) };
  }

  const view = {
    get target() { return new THREE.Vector3(st.tx, 0, st.tz); },
    get zoom() { return st.zoom; },
    get azimuth() { return st.az; },
    get halfHeight() { return halfH(); },
    // CSS pixels per world unit at the current zoom (pure math: safe to call every frame, no DOM reads).
    ppu() { return st.h / (2 * halfH()); },
    lastInputAt: 0,                 // Date.now() of the last user camera input (0 = never)
    keyboard: true,                 // set false if another module wants to own F/Q/E/+/-/arrows
    onUserInput(fn) { inputFns.add(fn); return () => inputFns.delete(fn); },
    idleSecs() { return (Date.now() - Math.max(view.lastInputAt, loadedAt)) / 1000; },
    userMovedWithin(secs) { return view.lastInputAt > 0 && Date.now() - view.lastInputAt < secs * 1000; },
    // fit-all provider: fn() -> Box3 | Sphere | [{ x, z, r, h }]
    setBounds(fn) { boundsFn = fn; },
    bounds() {
      const b = boundsFn?.();
      if (Array.isArray(b) ? b.length : b && !(b.isBox3 && b.isEmpty())) return b;
      return new THREE.Box3(new THREE.Vector3(-25, 0, -25), new THREE.Vector3(25, 4, 25));
    },
    // Center a world point (on screen, not just its ground projection). zoom optional.
    focus(v, { zoom, secs = 1.2 } = {}) {
      const t = (v.y || 0) / SIN_EL, b = basis();
      return flyTo(v.x - b.dx * t, v.z - b.dz * t, zoom ?? st.zoomGoal, secs);
    },
    // Fit a Box3 (default: everything, via setBounds). swoop: start zoomed out + rotated for an intro flourish.
    fit(box, { secs = 1.2, pad = 1.12, swoop = false } = {}) {
      const f = fitFor(box || view.bounds(), st.az, pad);
      if (swoop && secs > 0 && !settings.reduceMotion) {
        st.tx = f.x; st.tz = f.z; st.zoom = st.zoomGoal = f.zoom * 0.55;
        st.az = HOME_AZ - 0.35;
        spin = { t: 0, secs: secs * 1.1, from: st.az, to: HOME_AZ };
      }
      return flyTo(f.x, f.z, f.zoom, secs, swoop ? ease.outCubic : ease.inOut);
    },
    rotate(dir = 1, { secs = 0.7 } = {}) {
      const to = (spin ? spin.to : st.az) + Math.sign(dir || 1) * Math.PI / 2;
      if (!secs || settings.reduceMotion) { st.az = to; spin = null; return; }
      spin = { t: 0, secs, from: st.az, to };
    },
    zoomBy(f, { secs } = {}) {
      if (secs != null) return flyTo(st.tx, st.tz, st.zoomGoal * f, secs);
      cancelMoves();
      anchor.set(0, 0);
      st.zoomGoal = clamp(st.zoomGoal * f, ZOOM_MIN, ZOOM_MAX);
    },
    worldToScreen(v, out = {}) {
      _g.copy(v).project(camera);
      out.x = (_g.x * 0.5 + 0.5) * st.w; out.y = (0.5 - _g.y * 0.5) * st.h;
      out.visible = _g.z > -1 && _g.z < 1 && Math.abs(_g.x) <= 1 && Math.abs(_g.y) <= 1;
      return out;
    },
    screenToGround(px, py, out = new THREE.Vector3(), gy = 0) {
      return groundAtNdc((px / st.w) * 2 - 1, 1 - (py / st.h) * 2, out, gy);
    },
    // The visible ground quad (for the minimap frustum): [bottom-left, bottom-right, top-right, top-left].
    groundQuad(out = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()]) {
      groundAtNdc(-1, -1, out[0]); groundAtNdc(1, -1, out[1]); groundAtNdc(1, 1, out[2]); groundAtNdc(-1, 1, out[3]);
      return out;
    },
    markInput,
  };

  function updateView(dt) {
    // Self-heal: one bad input must never leave the camera stuck on NaN (a blank map forever).
    if (!Number.isFinite(st.zoom) || !Number.isFinite(st.zoomGoal)) st.zoom = st.zoomGoal = 1;
    if (!Number.isFinite(st.tx) || !Number.isFinite(st.tz)) { st.tx = 0; st.tz = 0; }
    if (flight) {
      flight.t += dt;
      const k = flight.ease(Math.min(1, flight.t / flight.secs));
      st.tx = lerp(flight.fx, flight.tx, k);
      st.tz = lerp(flight.fz, flight.tz, k);
      st.zoom = st.zoomGoal = Math.exp(lerp(flight.fzoom, flight.tzoom, k)) * (1 - flight.hop * Math.sin(Math.PI * k));
      if (flight.t >= flight.secs) { const f = flight; flight = null; f.res(); }
    } else if (Math.abs(st.zoom - st.zoomGoal) > 1e-4 * st.zoom) {
      // Zoom toward the anchor: keep the ground point under it fixed.
      groundAtNdc(anchor.x, anchor.y, _g);
      st.zoom = Math.abs(st.zoom - st.zoomGoal) < 1e-3 ? st.zoomGoal : damp(st.zoom, st.zoomGoal, 13, dt);
      groundAtNdc(anchor.x, anchor.y, _g2);
      st.tx += _g.x - _g2.x;
      st.tz += _g.z - _g2.z;
    }
    if (!drag && vel.lengthSq() > 1e-3) {
      st.tx += vel.x * dt; st.tz += vel.y * dt;
      vel.multiplyScalar(Math.exp(-5 * dt));
    }
    if (keys.size) {
      const b = basis(), sp = halfH() * 1.3 * dt;
      let mx = 0, my = 0;
      if (keys.has('ArrowLeft')) mx -= 1;
      if (keys.has('ArrowRight')) mx += 1;
      if (keys.has('ArrowUp')) my += 1;
      if (keys.has('ArrowDown')) my -= 1;
      st.tx += (b.rx * mx + (b.gx * my) / SIN_EL) * sp;
      st.tz += (b.rz * mx + (b.gz * my) / SIN_EL) * sp;
      if (mx || my) markInput();
    }
    if (spin) {
      spin.t += dt;
      st.az = lerp(spin.from, spin.to, ease.inOut(Math.min(1, spin.t / spin.secs)));
      if (spin.t >= spin.secs) spin = null;
    }
    st.tx = clamp(st.tx, -600, 600);
    st.tz = clamp(st.tz, -600, 600);
    applyCamera();
  }

  // pointer / wheel / keyboard -----------------------------------------------------------------------------------
  const dom = renderer.domElement;
  const pointers = new Map();
  let drag = null;                 // { id, moved, lastT }
  let pinch = null;                // { d, mx, my }
  let pointerNdc = null;           // last hover position (NDC) or null when outside
  let hoverDirty = false;

  const toNdc = (e) => ({ x: (e.clientX / st.w) * 2 - 1, y: 1 - (e.clientY / st.h) * 2 });

  function panPixels(dx, dy) {
    const b = basis(), s = (2 * halfH()) / st.h;
    st.tx += -b.rx * dx * s + (b.gx * dy * s) / SIN_EL;
    st.tz += -b.rz * dx * s + (b.gz * dy * s) / SIN_EL;
  }

  dom.addEventListener('contextmenu', (e) => e.preventDefault());
  dom.addEventListener('pointerdown', (e) => {
    try { dom.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, button: e.button });
    cancelMoves();
    vel.set(0, 0);
    if (pointers.size === 1) drag = { id: e.pointerId, moved: false, lastT: performance.now() };
    else if (pointers.size === 2) { drag = null; pinch = null; }
    markInput();
  });
  dom.addEventListener('pointermove', (e) => {
    pointerNdc = toNdc(e);
    hoverDirty = true;
    const p = pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    if (pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      if (pinch) {
        panPixels(mx - pinch.mx, my - pinch.my);
        anchor.set((mx / st.w) * 2 - 1, 1 - (my / st.h) * 2);
        groundAtNdc(anchor.x, anchor.y, _g);
        st.zoom = st.zoomGoal = clamp(st.zoom * (d / Math.max(1, pinch.d)), ZOOM_MIN, ZOOM_MAX);
        groundAtNdc(anchor.x, anchor.y, _g2);
        st.tx += _g.x - _g2.x; st.tz += _g.z - _g2.z;
      }
      pinch = { d, mx, my };
      markInput();
      return;
    }
    if (!drag || drag.id !== e.pointerId) return;
    if (!drag.moved && Math.hypot(e.clientX - p.x0, e.clientY - p.y0) < 5) return;
    drag.moved = true;
    dom.classList.add('dragging');
    panPixels(dx, dy);
    // inertia estimate (world units / s)
    const now = performance.now(), dts = Math.max(0.008, (now - drag.lastT) / 1000);
    drag.lastT = now;
    const b = basis(), s = (2 * halfH()) / st.h;
    const wx = (-b.rx * dx * s + (b.gx * dy * s) / SIN_EL) / dts, wz = (-b.rz * dx * s + (b.gz * dy * s) / SIN_EL) / dts;
    vel.set(lerp(vel.x, wx, 0.5), lerp(vel.y, wz, 0.5));
    // a big jump right after pointerdown (coarse touchpads, remote desktop) would fling the camera far out to sea:
    // cap it so a flick coasts at most about one screen height (the coast distance is |vel| / 5)
    const vmax = halfH() * 10;
    if (vel.lengthSq() > vmax * vmax) vel.setLength(vmax);
    markInput();
  });
  const endPointer = (e) => {
    const p = pointers.get(e.pointerId);
    pointers.delete(e.pointerId);
    try { dom.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    if (pointers.size < 2) pinch = null;
    if (!p) return;
    const wasDrag = drag && drag.id === e.pointerId && drag.moved;
    if (drag && drag.id === e.pointerId) {
      if (!wasDrag || performance.now() - drag.lastT > 90) vel.set(0, 0);
      drag = null;
      dom.classList.remove('dragging');
    }
    if (!wasDrag && e.type === 'pointerup' && p.button === 0 && pointers.size === 0) click(toNdc(e));
  };
  dom.addEventListener('pointerup', endPointer);
  dom.addEventListener('pointercancel', endPointer);
  dom.addEventListener('pointerleave', () => { if (!pointers.size) { pointerNdc = null; hoverDirty = true; } });

  dom.addEventListener('wheel', (e) => {
    e.preventDefault();
    cancelMoves();
    const unit = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? st.h : 1;
    const dx = e.deltaX * unit, dy = e.deltaY * unit;
    if (!e.ctrlKey && (e.shiftKey || Math.abs(dx) > Math.abs(dy))) {
      // touchpad two-finger horizontal swipe / shift+wheel: pan
      panPixels(-(e.shiftKey ? dy : dx), e.shiftKey ? 0 : -dy);
    } else {
      // wheel or pinch (ctrlKey): zoom toward the cursor, proportional to the delta (smooth on touchpads)
      const k = e.ctrlKey ? 0.01 : 0.0017;
      anchor.copy(toNdc(e));
      st.zoomGoal = clamp(st.zoomGoal * Math.exp(-clamp(dy, -240, 240) * k), ZOOM_MIN, ZOOM_MAX);
    }
    markInput();
  }, { passive: false });

  const typing = (e) => { const t = e.target; return t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)); };
  addEventListener('keydown', (e) => {
    if (!view.keyboard || e.defaultPrevented || typing(e) || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key;
    let used = true;
    if (k === 'f' || k === 'F') view.fit();
    else if (k === 'q' || k === 'Q') view.rotate(-1);
    else if (k === 'e' || k === 'E') view.rotate(1);
    else if (k === '+' || k === '=' || k === 'Add') view.zoomBy(1.35);
    else if (k === '-' || k === '_' || k === 'Subtract') view.zoomBy(1 / 1.35);
    else if (k.startsWith('Arrow')) { keys.add(k); cancelMoves(); }
    else used = false;
    if (k === 'Escape') { pick.select(null); return; }
    if (used) { e.preventDefault(); markInput(); }
  });
  addEventListener('keyup', (e) => keys.delete(e.key));
  addEventListener('blur', () => keys.clear());

  // ---- picking ------------------------------------------------------------------------------------------------------
  const pickMap = new Map();       // Object3D -> target
  const pickList = [];
  const raycaster = new THREE.Raycaster();
  const hits = [];
  const _ndc = new THREE.Vector2();

  function resolve(obj) {
    let hidden = false;
    for (let o = obj; o; o = o.parent) {
      if (!o.visible && !obj.userData.pickProxy) hidden = true;
      if (o.userData.noPick) return null;
      if (pickMap.has(o)) return hidden ? null : o;
    }
    return null;
  }

  // Cheap prefilter: each pick root keeps a bounding sphere measured about once a second, stored as an offset from
  // its origin so moving units stay pickable between measurements. Only roots the ray passes near are raycast.
  const bounds = new WeakMap(), candidates = [], _sph = new THREE.Sphere(), _bb = new THREE.Box3(), _o = new THREE.Vector3();
  function nearRay(o) {
    let b = bounds.get(o);
    if (!b) { b = { off: new THREE.Vector3(), r: 0, t: -9 }; bounds.set(o, b); }
    _o.setFromMatrixPosition(o.matrixWorld);
    if (engine.time - b.t > 1) {
      b.t = engine.time;
      _bb.setFromObject(o);
      if (_bb.isEmpty()) b.r = 0;
      else { _bb.getBoundingSphere(_sph); b.off.copy(_sph.center).sub(_o); b.r = _sph.radius + 0.6; }
    }
    if (!b.r) return false;
    _sph.center.copy(_o).add(b.off);
    _sph.radius = b.r;
    return raycaster.ray.intersectsSphere(_sph);
  }

  function pickAt(ndc) {
    if (!pickList.length || !ndc) return null;
    _ndc.set(ndc.x, ndc.y);
    raycaster.setFromCamera(_ndc, camera);
    candidates.length = 0;
    for (const o of pickList) if (nearRay(o)) candidates.push(o);
    hits.length = 0;
    if (candidates.length) raycaster.intersectObjects(candidates, true, hits);
    for (const h of hits) {
      const o = resolve(h.object);
      if (o) return { object: o, target: pickMap.get(o), point: h.point.clone() };
    }
    return null;
  }

  const sameTarget = (a, b) => !!a && !!b && a.type === b.type && a.id === b.id;

  const pick = {
    hovered: null,                 // { object, target } | null
    selected: null,                // { object, target, lostAt } | null
    add(obj, target, { hitRadius } = {}) {
      if (!obj || !target) return;
      if (!pickMap.has(obj)) pickList.push(obj);
      pickMap.set(obj, target);
      if (hitRadius) {
        const proxy = new THREE.Mesh(new THREE.CylinderGeometry(hitRadius, hitRadius, hitRadius * 2.4, 8), new THREE.MeshBasicMaterial());
        proxy.position.y = hitRadius * 1.2;
        proxy.visible = false;
        proxy.userData.pickProxy = true;
        proxy.castShadow = false;
        obj.add(proxy);
      }
      // re-attach a selection that was waiting for its entity to come back (e.g. an island rebuild)
      if (pick.selected && !pick.selected.object && sameTarget(pick.selected.target, target)) {
        pick.selected.object = obj;
        pick.selected.target = target;
        selRing.r = 0;
        labels.setHot(pick.hovered, pick.selected);
      }
    },
    remove(obj) {
      if (!pickMap.has(obj)) return;
      pickMap.delete(obj);
      const i = pickList.indexOf(obj);
      if (i >= 0) pickList.splice(i, 1);
      if (pick.hovered?.object === obj) setHover(null);
      if (pick.selected?.object === obj) { pick.selected.object = null; pick.selected.lostAt = engine.time; }
    },
    objectOf(target) {
      for (const [o, t] of pickMap) if (sameTarget(t, target)) return o;
      return null;
    },
    // Programmatic selection (HUD minimap, EVA log...). Emits 'select' like a click.
    select(target, info = {}) {
      if (!target) {
        const had = !!pick.selected;
        pick.selected = null;
        labels.setHot(pick.hovered, null);
        if (had || info.force) bus.emit('select', null, {});
        return;
      }
      const object = info.object || pick.objectOf(target);
      const repeat = !!pick.selected && sameTarget(pick.selected.target, target);
      pick.selected = { object, target: object ? pickMap.get(object) || target : target, lostAt: object ? 0 : engine.time };
      selRing.r = 0;
      labels.setHot(pick.hovered, pick.selected);
      bus.emit('select', pick.selected.target, { object, point: info.point || null, repeat });
    },
    at: (clientX, clientY) => pickAt({ x: (clientX / st.w) * 2 - 1, y: 1 - (clientY / st.h) * 2 }),
  };

  function setHover(h) {
    if (h?.object === pick.hovered?.object) return;
    pick.hovered = h;
    dom.style.cursor = h ? 'pointer' : '';
    hovRing.r = 0;
    labels.setHot(pick.hovered, pick.selected);
    bus.emit('hover', h ? h.target : null, h ? { object: h.object } : {});
  }

  function click(ndc) {
    const h = pickAt(ndc);
    if (h) pick.select(h.target, { object: h.object, point: h.point });
    else pick.select(null, { force: true });   // always emit: a card opened for a unit that went home has no selection
  }

  let hoverTick = 0;
  function updateHover() {
    if (drag?.moved || pinch) return;
    if (++hoverTick % 8 !== 0 && !hoverDirty) return;   // re-pick periodically: things move under a still cursor
    hoverDirty = false;
    setHover(pointerNdc ? pickAt(pointerNdc) : null);
  }

  // selection + hover rings (RTS style, faction-agnostic cyan) -------------------------------------------------------
  function makeRing(color, opacity, arcs) {
    const g = new THREE.Group();
    const m = new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, toneMapped: false, side: THREE.DoubleSide, fog: false });
    const flat = (geo) => { const x = new THREE.Mesh(geo, m); x.rotation.x = -Math.PI / 2; x.renderOrder = 6; return x; };
    g.add(flat(new THREE.RingGeometry(0.93, 1.0, 56)));
    if (arcs) {
      const spinner = new THREE.Group();
      for (let i = 0; i < 4; i++) spinner.add(flat(new THREE.RingGeometry(1.07, 1.24, 10, 1, i * Math.PI / 2 - 0.4, 0.8)));
      g.add(spinner);
      g.userData.spinner = spinner;
    }
    g.visible = false;
    g.userData.noPick = true;
    scene.add(g);
    return { g, m, r: 0, t: 0 };
  }
  const selRing = makeRing(0x39e5ff, 0.95, true);
  const hovRing = makeRing(0xffffff, 0.45, false);
  const _box = new THREE.Box3(), _size = new THREE.Vector3(), _p = new THREE.Vector3();

  function placeRing(R, object, dt, pulse) {
    if (!object || !object.parent) { R.g.visible = false; return; }
    R.t += dt;
    if (!R.r || R.t > 1) {             // (re)measure about once a second: objects grow and move
      R.t = 0;
      _box.setFromObject(object);
      _box.getSize(_size);
      R.r = clamp(Math.max(_size.x, _size.z) * 0.5 * 0.92, 0.55, 40);
    }
    _p.setFromMatrixPosition(object.matrixWorld);
    R.g.position.set(_p.x, Math.max(_p.y, 0.05) + 0.06, _p.z);
    const s = R.r * (pulse ? 1 + 0.05 * Math.sin(engine.time * 5) : 1);
    R.g.scale.set(s, 1, s);
    if (R.g.userData.spinner) R.g.userData.spinner.rotation.y += dt * 0.8;
    R.g.visible = true;
  }

  function updateRings(dt) {
    const sel = pick.selected;
    if (sel && !sel.object && engine.time - sel.lostAt > 2.5) pick.select(null);
    placeRing(selRing, pick.selected?.object, dt, true);
    const hov = pick.hovered?.object;   // (islands are too big for a hover ring; they still emit 'hover')
    if (hov && hov !== pick.selected?.object && pick.hovered.target?.type !== 'island') placeRing(hovRing, hov, dt, false);
    else hovRing.g.visible = false;
  }

  // ---- labels + fx --------------------------------------------------------------------------------------------------
  const labels = new Labels(engine, labelsEl);
  engine.labels = labels;
  engine.fx = new Fx(engine);
  engine.pick = pick;
  engine.view = view;
  settings.on('labels', (m) => labels.setMode(m));

  // ---- day / night + weather -------------------------------------------------------------------------------------
  const sky = { day: 1, gold: 0, tDay: 1, tGold: 0, phi: -0.5, alt: 0.95, nextEval: 0, lastNotified: -1, boostAt: 0, boostVal: 1 };
  const wx = { cpu: 0, wind: 0.2, storm: 0, on: false, flash: 0, nextFlash: 0, flicker: 0 };
  const forced = params.get('weather');
  if (forced === 'storm') Object.assign(wx, { cpu: 0.95, wind: 1, storm: 1, on: true, nextFlash: 0.2 });   // test hook
  const dayFns = new Set();
  engine.onDaylight = (fn) => { dayFns.add(fn); try { fn(engine.daylight); } catch (e) { console.error(e); } return () => dayFns.delete(fn); };
  engine.setWeather = (cpu) => { if (!forced && typeof cpu === 'number' && Number.isFinite(cpu)) wx.cpu = clamp(cpu, 0, 1); };

  // Temporary sky override that is not persisted ('day' | 'night' | null), e.g. the demo's night scene. Snaps
  // instantly (pinned tableaus are for screenshots); settings.daynight changes fade smoothly instead.
  let skyOverride = null;
  engine.forceSky = (mode) => {
    mode = mode === 'day' || mode === 'night' ? mode : null;
    if (mode === skyOverride) return;
    skyOverride = mode;
    evalClock();
    sky.day = sky.tDay;
    sky.gold = sky.tGold;
    sky.nextEval = engine.time + 2;
    shadowDirty = true;              // the sun jumps: redraw the shadows with the frame that shows it
  };

  function evalClock() {
    const mode = skyOverride || settings.daynight;
    if (mode === 'day') { sky.tDay = 1; sky.tGold = 0; sky.phi = -0.45; sky.alt = 0.95; return; }
    if (mode === 'night') { sky.tDay = 0; sky.tGold = 0; return; }
    const d = new Date();
    const h = d.getHours() + d.getMinutes() / 60;
    const sunH = -Math.cos(((h - 1) / 24) * Math.PI * 2);        // -1 at 1:00, +1 at 13:00, 0 near 7:00 / 19:00
    sky.tDay = smooth(-0.28, 0.2, sunH);
    sky.tGold = (1 - smooth(0.03, 0.42, Math.abs(sunH + 0.02))) * 0.9;
    const f = clamp((h - 6.5) / 13, 0, 1);
    sky.phi = lerp(0.26, -0.96, f);                               // morning front-left light -> evening back-left
    sky.alt = lerp(0.42, 1.05, Math.sin(Math.PI * f));
  }

  evalClock();
  sky.day = sky.tDay;
  sky.gold = sky.tGold;
  settings.on('daynight', () => { sky.nextEval = 0; });

  const C = {};
  for (const k of COLOR_KEYS) C[k] = new THREE.Color();
  const _tmp = new THREE.Color(), _sunV = new THREE.Vector3(), _moonV = new THREE.Vector3();
  const _fogC = new THREE.Color(), _bgTop = new THREE.Color(), _bgBot = new THREE.Color();

  function updateSky(dt) {
    if (engine.time >= sky.nextEval) { evalClock(); sky.nextEval = engine.time + 2; }
    sky.day = Math.abs(sky.day - sky.tDay) < 0.002 ? sky.tDay : damp(sky.day, sky.tDay, 1.2, dt);
    sky.gold = damp(sky.gold, sky.tGold, 1.2, dt);

    // weather: wind from machine load, storm above ~85% (with hysteresis), lightning while stormy
    wx.wind = damp(wx.wind, clamp((wx.cpu - 0.05) / 0.8, 0, 1), 0.5, dt);
    const on = wx.on ? wx.cpu > 0.75 : wx.cpu > 0.85;
    if (on !== wx.on) { wx.on = on; bus.emit('weather', { storm: on, cpu: wx.cpu }); }
    wx.storm = damp(wx.storm, on ? 1 : 0, 0.35, dt);
    if (wx.storm > 0.6 && !settings.reduceMotion && engine.time > wx.nextFlash) {
      wx.flash = 1; wx.flicker = 0.14; wx.nextFlash = engine.time + 6 + Math.random() * 12;
    }
    if (wx.flicker > 0) { wx.flicker -= dt; if (wx.flicker <= 0) wx.flash = Math.max(wx.flash, 0.7); }
    wx.flash *= Math.exp(-11 * dt);
    engine.wind = wx.wind;
    engine.storm = wx.storm;

    const day = sky.day, gold = sky.gold * (0.25 + 0.75 * Math.min(day * 2, 1)), storm = wx.storm * (0.25 + 0.4 * day);
    for (const k of COLOR_KEYS) {
      C[k].lerpColors(KF.night[k], KF.day[k], day).lerp(KF.gold[k], gold);
      if (storm > 0.001) C[k].lerp(KF.storm[k], storm);
    }
    const blend = (key) => lerp(lerp(lerp(KF.night[key], KF.day[key], day), KF.gold[key], gold), KF.storm[key], storm);

    // sun by day, moon by night (same light, blended direction)
    _sunV.set(Math.cos(sky.alt) * Math.sin(sky.phi), Math.sin(sky.alt), Math.cos(sky.alt) * Math.cos(sky.phi));
    _moonV.set(Math.cos(0.95) * Math.sin(-0.35), Math.sin(0.95), Math.cos(0.95) * Math.cos(-0.35));
    engine.sunDir.copy(_moonV).lerp(_sunV, smooth(0.15, 0.6, day)).normalize();
    sun.color.copy(C.sun);
    sun.intensity = blend('sunI');
    hemi.color.copy(C.hs);
    hemi.groundColor.copy(C.hg);
    hemi.intensity = blend('hemI') + wx.flash * 2.6;

    const u = seaU;
    u.uSea.value.copy(C.sea); u.uDeep.value.copy(C.deep); u.uShallow.value.copy(C.shallow);
    u.uFoamCol.value.copy(C.foam); u.uSpec.value.copy(C.spec).multiplyScalar((0.35 + 0.65 * day) * (1 - 0.9 * wx.storm));
    u.uStorm.value = wx.storm;
    u.uHazeLo.value.copy(C.lo); u.uHazeHi.value.copy(C.hi);
    u.uNight.value = 1 - smooth(0.1, 0.45, day);
    u.uFlash.value = wx.flash * 0.45;
    u.uSunDir.value.copy(engine.sunDir);
    const calm = settings.reduceMotion ? 0.5 : 1;
    u.uAmp.value = (0.2 + 0.22 * wx.wind + 0.14 * wx.storm) * calm;
    u.uChop.value = 0.2 + 0.2 * wx.wind;
    u.uTime.value = engine.time;

    // fog matches the haze color around the upper third of the screen; distance scales with zoom (see sea shader)
    _fogC.copy(C.lo).lerp(C.hi, 0.35);
    scene.fog.color.copy(_fogC);
    const R = halfH() / TAN_EL;
    scene.fog.near = CAM_DIST - 0.05 * R;
    scene.fog.far = CAM_DIST + 1.65 * R;
    _bgTop.copy(C.hi); _bgBot.copy(C.lo);
    if (wx.flash > 0.05) _bgTop.lerp(_tmp.set(0xffffff), wx.flash * 0.5);
    paintBackground(_bgTop, _bgBot);

    // rain
    rain.visible = wx.storm > 0.02;
    if (rain.visible) {
      rainU.uTime.value = engine.time;
      rainU.uOpacity.value = 0.7 * wx.storm;
      rainU.uWind.value = 0.6 + 1.6 * wx.wind;
      const r = footprint() * 1.1;
      rainU.uSize.value.set(r * 2, 30, r * 2);
      rainU.uCenter.value.set(st.tx, -2, st.tz);
    }

    // night: shared glowing materials get brighter; everyone else can use onDaylight / nightBoost
    engine.daylight = day;
    engine.nightBoost = 1 + 0.8 * (1 - day);
    if (Math.abs(day - sky.lastNotified) > 0.004) {
      sky.lastNotified = day;
      for (const fn of dayFns) { try { fn(day); } catch (e) { console.error(e); } }
    }
    if (engine.time >= sky.boostAt) {
      sky.boostAt = engine.time + (Math.abs(engine.nightBoost - sky.boostVal) > 0.01 ? 0.5 : 2);
      sky.boostVal = engine.nightBoost;
      boostEmissive(engine.nightBoost);
    }
  }

  function boostEmissive(b) {
    root.traverse((o) => {
      const m = o.material;
      if (!m) return;
      for (const x of Array.isArray(m) ? m : [m]) {
        if (!x.userData?.shared || !x.emissive || (x.emissive.r + x.emissive.g + x.emissive.b) === 0) continue;
        const base = x.userData.baseEmissive ?? (x.userData.baseEmissive = x.emissiveIntensity);
        x.emissiveIntensity = base * b;
      }
    });
  }

  // visible ground radius around the view target
  const footprint = () => Math.hypot(halfH() * st.aspect, halfH() / SIN_EL);

  // sea + shadow camera follow the view -----------------------------------------------------------------------------
  let shadowR = 0, shadowDirty = true, shadowAge = 0;
  const _lx = new THREE.Vector3(), _ly = new THREE.Vector3(), _c = new THREE.Vector3(), UP = new THREE.Vector3(0, 1, 0);
  function updateFollowers() {
    const fp = footprint();
    const cell = Math.pow(2, Math.ceil(Math.log2((fp * 2.25) / SEA_SEG) * 2) / 2);   // quantized: no swimming facets
    sea.scale.set(cell, 1, cell);
    sea.position.set(Math.round(st.tx / cell) * cell, 0, Math.round(st.tz / cell) * cell);
    seaU.uCell.value = cell;
    const b = basis();
    seaU.uViewDir.value.set(b.dx, b.dy, b.dz);
    if (foamDirty) {
      foamDirty = false;
      let i = 0;
      for (const f of foamRings) { if (i >= MAX_FOAM) break; seaU.uFoam.value[i++].set(f.x, f.z, f.r, f.s); }
      seaU.uFoamN.value = i;
    }

    if (!sun.castShadow) return;
    // shadow frustum sized to the visible area (quantized), texel-snapped so shadows don't shimmer when panning
    const want = Math.pow(2, Math.ceil(Math.log2(Math.min(fp * 0.85 + 8, 170)) * 4) / 4);
    const cam = sun.shadow.camera;
    if (want !== shadowR) {
      shadowR = want;
      cam.left = -want; cam.right = want; cam.top = want; cam.bottom = -want;
      cam.updateProjectionMatrix();
      shadowDirty = true;              // zoom step: cover the new view at once
    }
    const L = engine.sunDir;
    _lx.crossVectors(UP, L).normalize();
    _ly.crossVectors(L, _lx);
    const texel = (2 * shadowR) / SHADOW_MAP;
    _c.set(st.tx, 0, st.tz);
    const px = Math.round(_c.dot(_lx) / texel) * texel, py = Math.round(_c.dot(_ly) / texel) * texel, pz = _c.dot(L);
    _c.copy(_lx).multiplyScalar(px).addScaledVector(_ly, py).addScaledVector(L, pz);
    sun.target.position.copy(_c);
    sun.position.copy(_c).addScaledVector(L, 150);
  }

  // The shadow map (a 2048² depth pass over every caster) is redrawn SHADOW_HZ times a second, not every frame.
  // In between, the old map stays consistent: three.js updates the shadow matrix only when it redraws the map, so
  // the shadows of everything that stands still stay put while the shadow camera follows the view or the sun
  // drifts. Only movers' shadows trail, by at most 1/SHADOW_HZ s (one frame at the default 30 fps cap).
  function updateShadows(dt) {
    if (!sun.castShadow) { shadowDirty = true; return; }   // quality 'low'; redraw at once when it comes back
    shadowAge += dt;
    if (shadowDirty || shadowAge >= 1 / SHADOW_HZ - 0.008) {   // (slack for frame-time jitter)
      renderer.shadowMap.needsUpdate = true;
      shadowDirty = false;
      shadowAge = 0;
    }
  }

  // quality ------------------------------------------------------------------------------------------------------------
  function applyQuality() {
    const low = settings.quality === 'low';
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, low ? 1 : 1.5));
    sun.castShadow = !low;             // toggling the light (not shadowMap.enabled) recompiles programs correctly
    resize();
  }
  settings.on('quality', applyQuality);

  function resize() {
    const w = container.clientWidth || innerWidth, h = container.clientHeight || innerHeight;
    // A page opened in a hidden/minimized window measures 0x0: keep the last good shape until it's visible.
    if (!(w > 0 && h > 0)) return;
    st.w = w; st.h = h; st.aspect = w / h;
    renderer.setSize(w, h);
    seaU.uRes.value.set(w * renderer.getPixelRatio(), h * renderer.getPixelRatio());
    labels.resize(w, h);
    camera.top = NaN;                  // force a projection update
    applyCamera();
  }
  addEventListener('resize', resize);
  if (typeof ResizeObserver === 'function') new ResizeObserver(() => resize()).observe(container);
  applyQuality();

  // ---- frame loop --------------------------------------------------------------------------------------------------
  let last = performance.now();
  let zoomSeen = -1;
  let renderErrs = 0, renderErrAt = -Infinity;
  function loop(now) {
    requestAnimationFrame(loop);
    const cap = Math.min(Number(settings.fps) || 60, settings.quality === 'low' ? 30 : 60);
    const minDt = 1 / cap - 0.004;
    const elapsed = (now - last) / 1000;
    if (elapsed < minDt) return;
    last = now;
    const dt = Math.min(0.1, Math.max(0, elapsed));
    engine.time += dt;
    engine.frame++;
    labels.measure();                  // DOM reads first, before this frame writes anything (no forced reflow)
    tickTweens(dt);
    updateView(dt);
    updateSky(dt);
    for (const fn of frameFns) {
      try { fn(dt, engine.time); } catch (e) {
        if (!failedFns.has(fn)) { failedFns.add(fn); console.error('[engine] onFrame callback threw (reported once)', e); }
      }
    }
    engine.fx.tick(dt);
    updateFollowers();
    updateShadows(dt);
    updateHover();
    updateRings(dt);
    if (Math.abs(st.zoom - zoomSeen) > 0.005) { zoomSeen = st.zoom; labels.setZoom(st.zoom); }
    // A throw here must not skip lastFrameAt: the world would treat the page as stalled (materialize every snapshot).
    try { renderer.render(scene, camera); } catch (e) {
      renderErrs++;
      if (now - renderErrAt > 10000) { renderErrAt = now; console.error(`[engine] render threw (${renderErrs} so far; logged at most every 10 s)`, e); }
    }
    labels.update();
    lastFrameAt = performance.now();
  }
  requestAnimationFrame(loop);

  // ?debug: tiny perf/view readout (bottom-right). Only with the explicit param.
  if (params.has('debug')) {
    const d = document.createElement('pre');
    d.id = 'cnc-debug';
    document.body.appendChild(d);
    let n = 0, t0 = performance.now();
    engine.onFrame(() => {
      n++;
      const now = performance.now();
      if (now - t0 < 500) return;
      const fps = (n * 1000) / (now - t0), r = renderer.info.render;
      n = 0; t0 = now;
      let shown = 0, faded = 0;
      for (const L of labels.list) if (L.shown && L.visible) { shown++; if (L.occluded) faded++; }
      d.textContent = `${fps.toFixed(0)} fps  ${r.calls} calls  ${(r.triangles / 1000).toFixed(0)}k tris
` +
        `zoom ${st.zoom.toFixed(2)}  az ${Math.round((st.az * 180) / Math.PI)}°  target ${st.tx.toFixed(1)}, ${st.tz.toFixed(1)}
` +
        `labels ${shown} (${faded} faded)  day ${engine.daylight.toFixed(2)}  storm ${wx.storm.toFixed(2)}`;
    });
  }

  engine.footprint = footprint;
  return engine;
}
