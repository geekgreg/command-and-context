// HTML overlay labels anchored to 3D objects (DESIGN §4 `engine.labels`). One absolutely positioned element
// per label, moved with translate3d right after each render. Off-screen or hidden anchors are display:none'd,
// and styles are only written when something changed, so ~100 labels cost next to nothing.
// The container carries the zoom LOD class (lod-near / lod-mid / lod-far), the label mode (mode-all / mode-hover /
// mode-off) and two scale variables: --lk follows the screen (viewport height, like the HUD's own scale, times the
// HUD size setting via setUserScale) and --ls = zoom scale x --lk. Labels with class `always` (fx text, bubbles)
// ignore the mode.
//
// Decluttering: every label has a kind (session / island / agent / port / other / fx, from opts.kind, the pick
// target type or the className) and a priority (opts.priority, else by kind; needs_input sessions highest,
// hovered/selected labels above everything). Every few frames the labels are laid out greedily in priority order
// in screen space; one that overlaps a higher-priority label fades out (class `occluded`). Sizes are measured only
// when a label changes (set/setClass/LOD/zoom), and only in measure(), which the engine calls first thing in a frame,
// before anything writes to the DOM: the reads find a clean layout, so nothing forces a synchronous reflow.
//
// Stacking: labels.add({ ..., stack: { group, role: 'head' | 'member' } }). Every frame a head (an island's name tag)
// is placed, never below its own anchor, so its bottom sits STACK_GAP px above the highest visible member (the island's
// session labels) that it overlaps horizontally. The position is computed exactly from the current member rects, so
// the tag moves rigidly with the camera (no lag, no overshoot); only discrete changes (a member entering/leaving the
// overlap set, a size change) glide, via a decaying offset capped at STACK_SPEED. The overlap test has hysteresis and
// ignores declutter fading, so nothing can flip-flop. Members culled at the screen edge still count (anchors are
// projected for culled labels too), so panning / zooming a member out of view never restacks the head.
// Groups in use: 'island:<id>', 'annex:<id>', 'town'.
// A member may join several groups (group: [..]): a worktree session belongs to its islet and to the island.
// topOver(groups, x, hw) reports the top edge of a stack so 3D markers can float above it.
//
// Clusters: labels.add({ ..., cluster: name }) makes a label a member of cluster `name`, and labels.cluster(name, opts)
// gives the cluster a summary tag (a normal label: position/object, offset, html, className, stack, priority, plus
// min and onClick). While the cluster has at least `min` visible members and the zoom LOD is not lod-near, it folds:
// the members hide (hot ones, i.e. hovered / selected, still show) and the summary tag shows. Hovering the tag peeks:
// the members show again while the tag stays on top (it neither blocks nor fades in the declutter). Clicking it calls
// onClick. Used by the harbor ('harbor:<host id>'). handle.showing tells whether a label is really on screen right
// now (not culled, folded away, decluttered or hidden by CSS), so companions (Zzz, 3D signs) can follow it.
import * as THREE from 'three';
import { fmtTokens, clamp } from './kit.js';

const _v = new THREE.Vector3();

// ---- markup helpers (shared by placeholders and any module that wants the standard look) ---------------

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
export const trunc = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s; };

export const STATE_TEXT = {
  working: 'Working', thinking: 'Thinking', waiting: 'Waiting', needs_input: 'Needs you', idle: 'Lunch',
  asleep: 'Asleep', ended: 'Closed', stalled: 'Stalled', done: 'Done', failed: 'Failed', lost: 'Lost',
};

export function stateChip(state, text) {
  return `<b class="st st-${esc(state)}">${esc(text ?? STATE_TEXT[state] ?? state)}</b>`;
}

// Context fill color: cyan -> green -> yellow -> orange -> red.
export function ctxColor(p) {
  return p < 0.4 ? '#39e5ff' : p < 0.6 ? '#3ddc84' : p < 0.75 ? '#ffd23f' : p < 0.9 ? '#ff8a1f' : '#ff4d4d';
}

export function ctxBar(used, max) {
  const p = max ? clamp(used / max, 0, 1) : 0;
  return `<span class="ctx" style="--p:${(p * 100).toFixed(1)}%;--cc:${ctxColor(p)}"><i></i></span>` +
    `<span class="ctxn">${fmtTokens(used || 0)}/${fmtTokens(max || 0)}</span>`;
}

export function factionChip(f) { return `<i class="fchip f-${esc(f || 'merc')}"></i>`; }

// Standard building label: faction chip + name + state chip, detail line with the context bar.
export function sessionLabel(s) {
  const st = s.state || 'idle';
  return `<div class="lbl-card${st === 'needs_input' ? ' alert' : ''}">` +
    `<div class="l1">${factionChip(s.faction)}<span class="name">${esc(trunc(s.name || 'Session', 28))}</span>${stateChip(st)}</div>` +
    `<div class="l2 detail">${ctxBar(s.context?.used || 0, s.context?.max || 0)}</div></div>`;
}

// ---- priorities ---------------------------------------------------------------------------------------------

export const LABEL_PRIORITY = { session: 50, island: 40, cluster: 36, other: 30, agent: 20, port: 10, fx: 0 };
const ALERT_BONUS = 40;          // needs_input sessions beat everything but hover/selection
const HOT_BONUS = 1000;
const STACK_GAP = 7;             // px between a stack head and the member label under it
const STACK_PAD = 10;            // horizontal slack when deciding whether a member sits under a head
const STACK_HOLD = 14;           // extra px a member must move away before it stops counting (hysteresis)
const STACK_GLIDE = 0.12;        // s: time constant of the glide after a stack change
const STACK_SPEED = 240;         // px/s: top speed of that glide (a big restack must not jump in one frame)
const ALERT_RE = /needs_input|needs-you|\balert\b/;

function kindOf(opts, cls) {
  if (opts.kind) return opts.kind;
  if (/\balways\b|zzz|bubble|\bfx-/.test(cls)) return 'fx';
  const t = opts.target?.type;
  if (t === 'session' || t === 'island' || t === 'port' || t === 'agent') return t;
  if (/sess|bld|building/i.test(cls)) return 'session';
  if (/isl|island|annex|town|lighthouse/i.test(cls)) return 'island';
  if (/port|vessel|harbor|\bhb-|dock|ship|boat/i.test(cls)) return 'port';
  if (/unit|agent/i.test(cls)) return 'agent';
  return 'other';
}

// The members a stack head sits above in one frame: member, its height and its offset from the head's anchor (screen
// px), plus member -> index. Each head keeps two and alternates, so stacking allocates nothing per frame.
function stackBuf() { return { ms: [], h: [], rel: [], at: new Map() }; }
function clearBuf(b) { b.ms.length = 0; b.h.length = 0; b.rel.length = 0; b.at.clear(); }

// Screen y for a stack head's anchor point: STACK_GAP above the highest member of buffer `b`, and never below the
// head's own anchor. With frame `f` (a previous configuration), members that are gone (not projected in frame f) are
// placed at their remembered offset from the head's anchor.
function stackY(H, b, f) {
  let top = Infinity;
  for (let i = 0; i < b.ms.length; i++) {
    const M = b.ms[i];
    const live = !f || (M.proj === f && M.visible);
    const ay = live ? M.ay : H.ay + b.rel[i];
    const t = M.center ? ay - b.h[i] / 2 : ay - b.h[i];
    if (t < top) top = t;
  }
  if (top === Infinity) return H.ay;
  const bottom = H.center ? H.ay + H.h / 2 : H.ay;
  return H.ay - Math.max(0, bottom - (top - STACK_GAP));
}

// Declutter order: rank (see layout), then nearer first.
const byRank = (a, b) => b.rank - a.rank || a.depth - b.depth;

function isUnder(obj, root) {
  for (let o = obj; o; o = o.parent) if (o === root) return true;
  return false;
}

// ---- the layer --------------------------------------------------------------------------------------------

export class Labels {
  constructor(engine, root) {
    this.engine = engine;
    this.root = root;
    this.list = new Set();
    this.items = [];              // scratch for layout
    this.rects = [];              // scratch for layout: x0, y0, x1, y1 per placed label
    this.hover = null;
    this.selected = null;
    this.frame = 0;
    this.lod = '';
    this.ls = 0;
    this.lk = 0;
    this.zs = 1;                  // zoom part of --ls
    this.user = 1;                // HUD size setting (setUserScale)
    this.groups = new Map();      // stack group -> { heads: Set, members: Set }
    this.clusters = new Map();    // cluster name -> { members: Set, sum (summary label) | null, min, fold, peek, hide, onClick }
    this.lastT = 0;
    this.relayout = true;
    this.w = root.clientWidth || innerWidth;
    this.h = root.clientHeight || innerHeight;
    this.setMode(engine.settings?.labels || 'all');
    this.applyScale();
  }

  // opts: { object, position, offset, html, className, center, target, visible, kind, priority, stack, cluster }
  //   object: Object3D to follow (world position of its origin + offset); or position: fixed world point.
  //   offset: Vector3 in world units, used BY REFERENCE (mutate it to animate the label).
  //   center: center the element on the anchor instead of sitting on top of it.
  //   target: optional pick target ({type,id}); the label counts as hovered when that target is hovered.
  //   kind / priority: decluttering overrides (see the header comment).
  //   stack: { group, role: 'head' | 'member' } (see the header comment).
  //   cluster: name of the cluster this label belongs to (see the header comment).
  add(opts = {}) { return this.make(opts).handle; }

  // Summary tag of cluster `name` (created on the first call; later calls update min / onClick and return the same
  // handle). opts: label options (position | object, offset, html, className, stack, priority) + min (default 5),
  // onClick(). The handle is a normal label handle; remove() drops the tag (the members stay, never folded).
  cluster(name, opts = {}) {
    const C = this.clusterRec(String(name));
    if (Number.isFinite(opts.min)) C.min = opts.min;
    if (opts.onClick) C.onClick = opts.onClick;
    if (C.sum) return C.sum.handle;
    const S = this.make({ ...opts, cluster: null, kind: 'cluster', visible: false });
    S.sumOf = C;
    C.sum = S;
    const el = S.el;
    el.classList.add('lbl-sum');
    el.addEventListener('pointerenter', () => { C.peek = true; this.relayout = true; });
    el.addEventListener('pointerleave', () => { C.peek = false; this.relayout = true; });
    el.addEventListener('click', (e) => { e.stopPropagation(); try { C.onClick?.(); } catch (err) { console.error('[labels] cluster click', err); } });
    // the tag takes pointer events: pass the wheel on to the canvas so zooming over it still works
    el.addEventListener('wheel', (e) => {
      const dom = this.engine.renderer?.domElement;
      if (!dom) return;
      e.preventDefault();
      dom.dispatchEvent(new WheelEvent('wheel', e));
    }, { passive: false });
    return S.handle;
  }

  clusterRec(name) {
    let C = this.clusters.get(name);
    if (!C) this.clusters.set(name, (C = { name, members: new Set(), sum: null, min: 5, fold: false, peek: false, hide: false, onClick: null }));
    return C;
  }

  make(opts) {
    const el = document.createElement('div');
    const cls = opts.className || '';
    const kind = kindOf(opts, cls);
    el.className = `lbl k-${kind}` + (cls ? ' ' + cls : '');
    if (opts.html) el.innerHTML = opts.html;
    this.root.appendChild(el);
    const L = {
      el, kind, object: opts.object || null, pos: opts.position ? new THREE.Vector3().copy(opts.position) : null,
      offset: opts.offset || new THREE.Vector3(), html: opts.html || '', target: opts.target || null,
      center: !!opts.center, align: opts.center ? ' translate(-50%,-50%)' : ' translate(-50%,-100%)',
      x: -1e6, y: -1e6, z: -1, depth: 0, shown: true, visible: opts.visible !== false, hot: false,
      base: Number.isFinite(opts.priority) ? opts.priority : (LABEL_PRIORITY[kind] ?? 30),
      alert: ALERT_RE.test(opts.html || '') || ALERT_RE.test(cls),
      w: 0, h: 0, dirty: true, occluded: false,
      always: el.classList.contains('always') || kind === 'fx',
      ax: 0, ay: 0, proj: 0, lift: 0, blend: 0, prev: null, bufs: null, stack: null, rank: 0,
      cl: null, sumOf: null, float: false, handle: null,
    };
    if (opts.cluster != null) {
      L.cl = this.clusterRec(String(opts.cluster));
      L.cl.members.add(L);
    }
    if (opts.stack && opts.stack.group != null) {
      const head = opts.stack.role === 'head';
      const groups = (Array.isArray(opts.stack.group) ? opts.stack.group : [opts.stack.group]).filter((x) => x != null).map(String);
      for (const name of head ? groups.slice(0, 1) : groups) {
        let g = this.groups.get(name);
        if (!g) this.groups.set(name, (g = { heads: new Set(), members: new Set() }));
        (head ? g.heads : g.members).add(L);
      }
      L.stack = { groups, head };
    }
    if (!L.visible) { el.hidden = true; L.shown = false; }
    const handle = {
      el,
      get object() { return L.object; },
      get offset() { return L.offset; },
      // on screen as of the last frame: not culled, folded into a cluster, decluttered or hidden by CSS (LOD / mode)
      get showing() { return L.shown && L.visible && !L.occluded && L.w > 0; },
      set: (html) => {
        if (html === L.html) return;
        L.html = html;
        el.innerHTML = html;
        L.alert = ALERT_RE.test(html) || el.classList.contains('alert');
        L.dirty = true;
      },
      setVisible: (b) => { L.visible = !!b; if (!b && L.shown) { el.hidden = true; L.shown = false; } },
      setClass: (c, on = true) => { if (el.classList.contains(c) !== !!on) { el.classList.toggle(c, !!on); L.dirty = true; } },
      setPriority: (p) => { if (p !== L.base) { L.base = p; this.relayout = true; } },
      setObject: (o) => { L.object = o; L.pos = null; },
      setPosition: (p) => { L.pos = (L.pos || new THREE.Vector3()).copy(p); L.object = null; },
      remove: () => {
        if (!this.list.delete(L)) return;
        el.remove();
        this.relayout = true;
        for (const name of L.stack?.groups || []) {
          const g = this.groups.get(name);
          if (!g) continue;
          (L.stack.head ? g.heads : g.members).delete(L);
          if (!g.heads.size && !g.members.size) this.groups.delete(name);
        }
        const C = L.cl || L.sumOf;
        if (C) {
          if (L.sumOf) { C.sum = null; C.fold = C.peek = C.hide = false; } else C.members.delete(L);
          if (!C.sum && !C.members.size) this.clusters.delete(C.name);
        }
      },
    };
    L.handle = handle;
    this.list.add(L);
    this.markHot(L);
    return L;
  }

  // Inject a module's label CSS once.
  css(id, cssText) {
    const sid = 'lblcss-' + String(id).replace(/[^\w-]/g, '_');
    let s = document.getElementById(sid);
    if (!s) { s = document.createElement('style'); s.id = sid; document.head.appendChild(s); }
    if (s.textContent !== cssText) { s.textContent = cssText; this.dirtyAll(); }
  }

  dirtyAll() { for (const L of this.list) L.dirty = true; this.relayout = true; }

  setMode(mode) {
    this.mode = mode;
    const c = this.root.classList;
    c.toggle('mode-all', mode === 'all');
    c.toggle('mode-hover', mode === 'hover');
    c.toggle('mode-off', mode === 'off');
    this.dirtyAll();
  }

  // Zoom LOD: near >= 1.3, mid >= 0.65, far below. --ls scales label text with zoom (and the screen, see applyScale).
  setZoom(zoom) {
    const lod = zoom >= 1.3 ? 'lod-near' : zoom >= 0.65 ? 'lod-mid' : 'lod-far';
    if (lod !== this.lod) {
      if (this.lod) this.root.classList.remove(this.lod);
      this.root.classList.add(lod);
      this.lod = lod;
      this.dirtyAll();
    }
    this.zs = clamp(0.78 + 0.22 * zoom, 0.8, 1.15);
    this.applyScale();
  }

  // HUD size setting (S/M/L/XL): world labels follow it like the HUD does.
  setUserScale(k) {
    this.user = clamp(Number(k) || 1, 0.5, 3);
    this.applyScale();
  }

  // The world is drawn at a fixed world height per screen (ortho camera), so labels scale with the viewport height
  // to keep their size next to the models and the HUD (1600x900 = 1; width-guarded for narrow windows).
  applyScale() {
    const lk = Math.round(clamp(Math.min(this.h / 900, this.w / 1200), 0.8, 2.6) * this.user * 50) / 50;
    const ls = Math.round(this.zs * lk * 50) / 50;
    let dirty = false;
    if (lk !== this.lk) { this.lk = lk; this.root.style.setProperty('--lk', lk); dirty = true; }
    if (ls !== this.ls) { this.ls = ls; this.root.style.setProperty('--ls', ls); dirty = true; }
    if (dirty) this.dirtyAll();
  }

  // Hovered / selected pick roots ({ object, target }); labels under them get the `hot` class.
  setHot(hover, selected) {
    this.hover = hover;
    this.selected = selected;
    for (const L of this.list) this.markHot(L);
    this.relayout = true;
  }

  markHot(L) {
    const h = this.hover, s = this.selected;
    let hot = false;
    for (const x of [h, s]) {
      if (!x || hot) continue;
      if (L.object && x.object && (isUnder(L.object, x.object) || isUnder(x.object, L.object))) hot = true;
      else if (L.target && x.target && L.target.type === x.target.type && L.target.id === x.target.id) hot = true;
    }
    if (hot !== L.hot) { L.hot = hot; L.el.classList.toggle('hot', hot); L.dirty = true; }
  }

  resize(w, h) { this.w = w; this.h = h; this.relayout = true; this.applyScale(); }

  // Reads the sizes of labels whose content, class or scale changed. The engine calls this first thing in a frame,
  // before anything writes to the DOM, so the reads find the layout the browser has just done (reading after this
  // frame's writes would force a synchronous style + layout pass).
  measure() {
    for (const L of this.list) {
      if (!L.dirty || !L.shown || !L.visible || L.always) continue;
      L.dirty = false;
      const w = L.el.offsetWidth, h = L.el.offsetHeight;
      if (w !== L.w || h !== L.h) { L.w = w; L.h = h; this.relayout = true; }
    }
  }

  // Called by the engine right after rendering (matrices are fresh).
  update() {
    const cam = this.engine.camera, scene = this.engine.scene;
    const w = this.w, h = this.h;
    const f = ++this.frame;
    const sort = f % 10 === 0;
    const now = performance.now(), dt = Math.min(0.1, Math.max(0, (now - (this.lastT || now)) / 1000));
    this.lastT = now;
    if (this.clusters.size) this.fold();
    for (const L of this.list) {
      if (!L.visible) continue;
      if (L.cl?.hide && !L.hot) {                                // folded into its cluster's summary tag
        if (L.shown) { L.el.hidden = true; L.shown = false; this.relayout = true; }
        continue;
      }
      let ok = true;
      if (L.object) {
        for (let o = L.object; ; o = o.parent) {
          if (!o || !o.visible) { ok = false; break; }
          if (o === scene) break;
        }
        if (ok) _v.setFromMatrixPosition(L.object.matrixWorld);
      } else if (L.pos) _v.copy(L.pos);
      else ok = false;
      if (ok) {
        _v.add(L.offset).project(cam);
        ok = _v.z > -1 && _v.z < 1;
        if (ok) {
          // screen anchor, kept for labels culled at the screen edge too: stacks must not change when a member leaves the view
          L.ax = (_v.x * 0.5 + 0.5) * w; L.ay = (0.5 - _v.y * 0.5) * h; L.proj = f;
          ok = _v.x > -1.12 && _v.x < 1.12 && _v.y > -1.25 && _v.y < 1.04;
        }
      }
      if (!ok) { if (L.shown) { L.el.hidden = true; L.shown = false; } continue; }
      if (!L.shown) { L.el.hidden = false; L.shown = true; L.dirty = true; this.relayout = true; }
      L.depth = _v.z;
      if (!L.stack?.head) this.place(L, L.ax, L.ay);           // stack heads are placed by stack() below
      if (sort) {
        const z = Math.round((1 - _v.z) * 4000) + (L.always ? 20000 : 0);
        if (z !== L.z) { L.z = z; L.el.style.zIndex = z; }
      }
    }
    if (this.groups.size) this.stack(dt);
    if (this.relayout || f % 3 === 0) this.layout();
  }

  // Cluster state for this frame (see the header comment). The summary tag is shown while folded (peeking included);
  // members hide while folded and not peeking. Zoomed in (lod-near) nothing folds.
  fold() {
    const near = this.lod === 'lod-near';
    for (const C of this.clusters.values()) {
      const S = C.sum;
      let n = 0;
      if (S && !near) for (const M of C.members) if (M.visible) n++;
      const fold = !!S && !near && n >= C.min;
      if (fold !== C.fold) {
        C.fold = fold;
        this.relayout = true;
        if (S) {
          S.visible = fold;
          if (!fold) {
            C.peek = false;                                     // a hidden tag gets no pointerleave
            if (S.shown) { S.el.hidden = true; S.shown = false; }
          }
        }
      }
      const peek = fold && C.peek;
      if (S && peek !== S.float) { S.float = peek; S.el.classList.toggle('peek', peek); }
      C.hide = fold && !C.peek;
    }
  }

  // Positions snap to half pixels: a label that moved less than that (slow camera drift) keeps its transform.
  place(L, x, y) {
    x = Math.round(x * 2) / 2; y = Math.round(y * 2) / 2;
    if (x === L.x && y === L.y) return;
    L.x = x; L.y = y;
    L.el.style.transform = `translate3d(${x}px,${y}px,0)${L.align}`;
  }

  // Place each stack head above the members it overlaps horizontally, on screen or just off it (see the header comment).
  stack(dt) {
    const f = this.frame, decay = Math.exp(-dt / STACK_GLIDE), cap = STACK_SPEED * dt;
    for (const g of this.groups.values()) {
      for (const H of g.heads) {
        const bufs = H.bufs || (H.bufs = [stackBuf(), stackBuf()]);
        if (!H.shown || !H.visible) { H.prev = null; H.blend = 0; clearBuf(bufs[0]); clearBuf(bufs[1]); continue; }
        const reach = (H.w || 0) / 2 + STACK_PAD;
        const set = H.prev === bufs[0] ? bufs[1] : bufs[0];   // members used this frame (the other buffer is H.prev)
        clearBuf(set);
        let pending = !H.w && H.dirty;
        for (const M of g.members) {
          if (!M.visible || M.proj !== f) continue;             // hidden / not projected (culled members still count)
          if (!M.w || !M.h) { if (M.dirty && M.shown) pending = true; continue; }   // not measured yet / hidden by CSS
          const lim = reach + M.w / 2 + (H.prev?.at.has(M) ? STACK_HOLD : 0);
          if (Math.abs(M.ax - H.ax) <= lim) { set.at.set(M, set.ms.length); set.ms.push(M); set.h.push(M.h); set.rel.push(M.ay - H.ay); }
        }
        const y = stackY(H, set, 0);
        // a changed configuration would jump: carry the jump in `blend` and let it decay (monotonic glide, at most
        // STACK_SPEED). The previous configuration is evaluated at the current positions; a member that just vanished
        // keeps its last offset.
        if (H.prev && !pending) {
          H.blend += stackY(H, H.prev, f) - y;
          H.blend -= Math.sign(H.blend) * Math.min(Math.abs(H.blend) * (1 - decay), cap);
          if (Math.abs(H.blend) < 0.05) H.blend = 0;
        } else H.blend = 0;                                     // first sight / still measuring: snap
        H.prev = pending ? null : set;
        H.lift = H.ay - (y + H.blend);
        this.place(H, H.ax, y + H.blend);
      }
    }
  }

  // Top edge (screen px) of the visible labels in the given stack group(s) that overlap [x - hw, x + hw], or null.
  // Lets 3D markers (alerts' giant "!", READY checks) float clear above an island's label stack.
  topOver(groups, x, hw = 0) {
    let top = Infinity;
    for (const name of Array.isArray(groups) ? groups : [groups]) {
      const g = this.groups.get(name);
      if (!g) continue;
      for (let k = 0; k < 2; k++) {
        for (const L of k ? g.members : g.heads) {
          if (!L.shown || !L.visible || L.occluded || !L.w || !L.h) continue;
          if (Math.abs(L.x - x) > hw + L.w / 2) continue;
          const t = L.center ? L.y - L.h / 2 : L.y - L.h;
          if (t < top) top = t;
        }
      }
    }
    return top < Infinity ? top : null;
  }

  // Greedy screen-space declutter over the sizes measure() read (no DOM reads here); writes only class flips. A label
  // that changed during this frame keeps its previous size until the next frame's measure().
  layout() {
    this.relayout = false;
    const items = this.items;
    items.length = 0;
    for (const L of this.list) {
      if (!L.shown || !L.visible || L.always) continue;
      if (L.float) {                                     // a peeked cluster tag: on top, neither blocks nor fades
        if (L.occluded) { L.occluded = false; L.el.classList.remove('occluded'); }
        continue;
      }
      L.rank = L.base + (L.alert ? ALERT_BONUS : 0) + (L.hot ? HOT_BONUS : 0) - (L.stack?.head ? 0.5 : 0);
      items.push(L);
    }
    items.sort(byRank);
    const R = this.rects;
    let n = 0;
    for (const L of items) {
      if (!L.w || !L.h) continue;                       // hidden by CSS (mode / LOD): neither blocks nor fades
      const x0 = L.x - L.w / 2, x1 = L.x + L.w / 2;
      const y0 = L.center ? L.y - L.h / 2 : L.y - L.h, y1 = L.center ? L.y + L.h / 2 : L.y;
      // hysteresis: a faded label needs 4px of clearance to come back, a visible one tolerates 3px of overlap
      const pad = L.occluded ? 4 : -3;
      let hit = false;
      if (!L.hot) {
        for (let i = 0; i < n; i += 4) {
          if (x0 - pad < R[i + 2] && x1 + pad > R[i] && y0 - pad < R[i + 3] && y1 + pad > R[i + 1]) { hit = true; break; }
        }
      }
      if (!hit) { R[n++] = x0; R[n++] = y0; R[n++] = x1; R[n++] = y1; }
      if (hit !== L.occluded) { L.occluded = hit; L.el.classList.toggle('occluded', hit); }
    }
  }
}
