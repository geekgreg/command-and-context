// Tactical map (bottom-left): a top-down radar of the diorama, rotated with the camera so "up" is always "away
// from you". Islands tinted by their dominant faction, buildings / units / boats as markers, the camera frustum,
// pulsing pings for events. Click or drag to move the camera. Drawn on a HiDPI canvas at ~30 fps.
import { el, fcol, ftext, prefs, islandTitle, vesselName, portText, clamp } from './util.js';
import { ICON } from './icons.js';

const TWO_PI = Math.PI * 2;
const PING_SECS = 2.6;

function hexToRgb(h) {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const rgba = (hex, a) => { const [r, g, b] = hexToRgb(hex); return `rgba(${r},${g},${b},${a})`; };
const mixHex = (a, b, t) => {
  const A = hexToRgb(a), B = hexToRgb(b);
  return '#' + A.map((x, i) => Math.round(x + (B[i] - x) * t).toString(16).padStart(2, '0')).join('');
};

export class Minimap {
  constructor(hud) {
    this.hud = hud;
    this.engine = hud.engine;
    this.world = hud.world;
    this.pings = [];
    this.factionOf = new Map();       // island id -> dominant faction
    this.sessionState = new Map();    // session key -> state
    this.portInfo = new Map();
    this.view = { cx: 0, cz: 0, R: 40, ready: false };
    this.hoverPt = null;
    this.frame = 0;

    this.canvas = el('canvas.mm-canvas');
    this.ctx = this.canvas.getContext('2d');
    const screen = el('div.mm-screen', null, this.canvas, el('div.mm-sweep'), el('div.mm-glass'));
    this.screen = screen;
    const fit = el('button.mini-btn', { type: 'button', 'data-tip': 'Fit everything (F)', html: ICON.target });
    fit.addEventListener('click', () => { this.engine.view.markInput(); this.engine.view.fit(); });
    const col = el('button.mini-btn', { type: 'button', 'data-tip': 'Collapse map', html: ICON.minus });
    col.addEventListener('click', () => this.setCollapsed(!this.collapsed));
    this.colBtn = col;
    const head = el('div.panel-head', null, el('span.ph-icon', { html: ICON.map }), el('span.ph-t', { text: 'Tactical map' }), el('span.ph-sp'), fit, col);
    head.addEventListener('dblclick', () => this.setCollapsed(!this.collapsed));
    this.root = el('div.minimap.panel', null, head, screen);
    this.setCollapsed(prefs.get('miniCollapsed', false), true);

    this.bindPointer();
    addEventListener('resize', () => { this.box = null; });
    this.engine.onFrame((dt) => {
      if (this.collapsed || this.hud.hidden) return;
      if ((++this.frame & 1) === 0) this.draw(dt * 2);
    });
  }

  setCollapsed(on, quiet) {
    this.collapsed = !!on;
    this.root.classList.toggle('collapsed', this.collapsed);
    this.colBtn.innerHTML = this.collapsed ? ICON.plus : ICON.minus;
    this.colBtn.setAttribute('data-tip', this.collapsed ? 'Expand map' : 'Collapse map');
    if (!quiet) prefs.set('miniCollapsed', this.collapsed);
  }

  // Snapshot-derived tints (called from Hud.apply).
  update(snap) {
    const count = new Map();
    this.sessionState.clear();
    for (const s of snap.sessions || []) {
      this.sessionState.set(s.key, s);
      if (s.state === 'ended') continue;
      let m = count.get(s.island);
      if (!m) count.set(s.island, (m = new Map()));
      const w = (m.get(s.faction) || 0) + 1 + (s.context?.used || 0) / 1e8;
      m.set(s.faction, w);
    }
    this.factionOf.clear();
    for (const [id, m] of count) {
      let best = null, bw = -1;
      for (const [f, w] of m) if (w > bw) { bw = w; best = f; }
      this.factionOf.set(id, best);
    }
    this.portInfo.clear();
    for (const p of snap.ports || []) this.portInfo.set(p.id, p);
    this.islandData = new Map((snap.islands || []).map((i) => [i.id, i]));
  }

  ping(pos, color = '#39e5ff') {
    if (!pos) return;
    this.pings.push({ x: pos.x, z: pos.z, color, t: this.engine.time });
    if (this.pings.length > 24) this.pings.shift();
  }

  // ---- coordinate transforms ---------------------------------------------------------------------------------------

  // CSS size of the canvas, cached via ResizeObserver so the frame loop never forces a layout.
  size() {
    if (!this.box) {
      const r = this.canvas.getBoundingClientRect();
      this.box = { w: Math.max(10, r.width), h: Math.max(10, r.height) };
      if (!this.ro && typeof ResizeObserver === 'function') {
        this.ro = new ResizeObserver(() => { this.box = null; });
        this.ro.observe(this.canvas);
      }
    }
    return this.box;
  }

  scale(w, h) { return (Math.min(w, h) / 2) / this.view.R; }

  toMap(x, z, out) {
    const { w, h } = this.dim, s = this.sc, c = this.cos, n = this.sin;
    const dx = x - this.view.cx, dz = z - this.view.cz;
    out.x = w / 2 + (dx * c - dz * n) * s;
    out.y = h / 2 + (dx * n + dz * c) * s;
    return out;
  }

  toWorld(px, py) {
    const { w, h } = this.size(), s = this.scale(w, h), az = this.engine.view.azimuth, c = Math.cos(az), n = Math.sin(az);
    const u = (px - w / 2) / s, v = (py - h / 2) / s;
    return { x: this.view.cx + u * c + v * n, z: this.view.cz - u * n + v * c };
  }

  // ---- input ---------------------------------------------------------------------------------------------------------

  bindPointer() {
    const cv = this.canvas;
    let down = false;
    const go = (e, secs) => {
      const r = cv.getBoundingClientRect();
      const p = this.toWorld(e.clientX - r.left, e.clientY - r.top);
      const v = this.engine.view;
      v.markInput();
      v.focus({ x: p.x, y: 0, z: p.z }, { secs });
    };
    cv.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      down = true;
      try { cv.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      go(e, 0.35);
      e.preventDefault();
    });
    cv.addEventListener('pointermove', (e) => {
      const r = cv.getBoundingClientRect();
      this.hoverPt = { x: e.clientX - r.left, y: e.clientY - r.top };
      if (down) go(e, 0);
      else this.hud.tip.showFor('minimap', this.hoverText(this.hoverPt));
    });
    const up = (e) => { down = false; try { cv.releasePointerCapture(e.pointerId); } catch { /* ignore */ } };
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', up);
    cv.addEventListener('pointerleave', () => { this.hoverPt = null; this.hud.tip.hideFor('minimap'); });
    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.engine.view.markInput();
      this.engine.view.zoomBy(e.deltaY > 0 ? 1 / 1.2 : 1.2);
    }, { passive: false });
  }

  hoverText(pt) {
    if (!pt || !this.dim) return '';
    const P = { x: 0, y: 0 };
    let best = null, bd = 9;
    const consider = (d, text) => { if (d < bd) { bd = d; best = text; } };
    for (const [key, b] of this.world.buildings) {
      if (!b.group) continue;
      const s = this.sessionState.get(key);
      this.pos(b.group, P);
      consider(Math.hypot(P.x - pt.x, P.y - pt.y), s ? `${s.name} · ${s.modelLabel || s.faction}` : 'Base');
    }
    for (const [id, v] of this.world.vessels) {
      if (!v.group) continue;
      const p = this.portInfo.get(id);
      this.pos(v.group, P);
      consider(Math.hypot(P.x - pt.x, P.y - pt.y) + 1, p ? `${p.label || p.proc} ${portText(p)} · ${vesselName(p.kind)}${p.adrift ? ' · ADRIFT' : ''}` : 'Vessel');
    }
    if (best) return best;
    for (const [id, L] of this.world.layout) {
      this.toMap(L.x, L.z, P);
      if (Math.hypot(P.x - pt.x, P.y - pt.y) <= L.r * this.sc + 3) {
        const d = this.islandData?.get(id);
        return d ? `${d.name} · ${islandTitle(d)}${d.git?.branch ? ' · ⎇ ' + d.git.branch : ''}` : 'Island';
      }
    }
    this.toMap(0, 0, P);
    if (Math.hypot(P.x - pt.x, P.y - pt.y) <= (this.world.town?.radius ?? 9) * this.sc) return 'Port Localhost · the harbor';
    return 'Click or drag to move the camera';
  }

  pos(obj, out) {
    const e = obj.matrixWorld.elements;
    return this.toMap(e[12], e[14], out);
  }

  // ---- drawing -------------------------------------------------------------------------------------------------------------

  fitTarget() {
    let x0 = -14, x1 = 14, z0 = -14, z1 = 14;
    for (const L of this.world.layout.values()) {
      const e = (L.ext || L.r) + 5;
      x0 = Math.min(x0, L.x - e); x1 = Math.max(x1, L.x + e);
      z0 = Math.min(z0, L.z - e); z1 = Math.max(z1, L.z + e);
    }
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    let R = 20;
    for (const L of this.world.layout.values()) R = Math.max(R, Math.hypot(L.x - cx, L.z - cz) + (L.ext || L.r) + 5);
    R = Math.max(R, Math.hypot(cx, cz) + 16);
    // Leave room for the camera frustum when zoomed out (capped), so the view box stays visible.
    let F = 0;
    this.quad2 = this.engine.view.groundQuad(this.quad2);
    for (const p of this.quad2) F = Math.max(F, Math.hypot(p.x - cx, p.z - cz) * 0.8);
    return { cx, cz, R: Math.max(R * 1.04, Math.min(F, R * 1.35)) };
  }

  draw(dt) {
    const cv = this.canvas, ctx = this.ctx;
    const { w, h } = this.size();
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const W = Math.round(w * dpr), H = Math.round(h * dpr);
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    if (!(w > 0 && h > 0)) return;                          // hidden: nothing to draw
    const t = this.fitTarget(), V = this.view;
    const ok = (o) => Number.isFinite(o.cx) && Number.isFinite(o.cz) && Number.isFinite(o.R) && o.R > 0;
    if (!ok(t)) return;                                     // camera not settled yet; never poison V with NaN
    if (!V.ready || !ok(V)) { Object.assign(V, t); V.ready = true; }
    const k = 1 - Math.exp(-3 * dt);
    V.cx += (t.cx - V.cx) * k; V.cz += (t.cz - V.cz) * k; V.R += (t.R - V.R) * k;

    const az = this.engine.view.azimuth;
    this.cos = Math.cos(az); this.sin = Math.sin(az);
    this.dim = { w, h };
    this.sc = this.scale(w, h);
    const s = this.sc, time = this.engine.time;
    const P = { x: 0, y: 0 }, Q = { x: 0, y: 0 };
    const day = this.engine.daylight ?? 1;

    // sea
    const seaKey = `${w}|${h}|${day > 0.5}`;
    if (this.seaKey !== seaKey) {
      this.seaKey = seaKey;
      const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.75);
      g.addColorStop(0, day > 0.5 ? '#135a7e' : '#1b2f6e');
      g.addColorStop(1, day > 0.5 ? '#0a2446' : '#0a1233');
      this.seaGrad = g;
    }
    ctx.fillStyle = this.seaGrad;
    ctx.fillRect(0, 0, w, h);

    // grid (world-aligned, so it turns with the camera)
    ctx.strokeStyle = 'rgba(120, 220, 255, 0.07)';
    ctx.lineWidth = 1;
    const step = 20, span = V.R * 1.6;
    ctx.beginPath();
    for (let gx = Math.floor((V.cx - span) / step) * step; gx <= V.cx + span; gx += step) {
      this.toMap(gx, V.cz - span, P); this.toMap(gx, V.cz + span, Q);
      ctx.moveTo(P.x, P.y); ctx.lineTo(Q.x, Q.y);
    }
    for (let gz = Math.floor((V.cz - span) / step) * step; gz <= V.cz + span; gz += step) {
      this.toMap(V.cx - span, gz, P); this.toMap(V.cx + span, gz, Q);
      ctx.moveTo(P.x, P.y); ctx.lineTo(Q.x, Q.y);
    }
    ctx.stroke();

    // Port Localhost
    const TR = (this.world.town?.radius ?? 9) * 0.8;
    this.toMap(0, 0, P);
    ctx.fillStyle = 'rgba(233, 255, 251, 0.12)';
    ctx.beginPath(); ctx.arc(P.x, P.y, TR * s + 2.5, 0, TWO_PI); ctx.fill();
    ctx.fillStyle = '#b98a5a';
    ctx.strokeStyle = '#f6d38e';
    ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.arc(P.x, P.y, TR * s, 0, TWO_PI); ctx.fill(); ctx.stroke();
    // lighthouse + sweeping beam
    const beamA = time * 0.9;
    ctx.save();
    ctx.translate(P.x, P.y);
    ctx.rotate(beamA);
    const bg = ctx.createLinearGradient(0, 0, TR * s * 3.2, 0);
    bg.addColorStop(0, 'rgba(255, 243, 184, 0.55)');
    bg.addColorStop(1, 'rgba(255, 243, 184, 0)');
    ctx.fillStyle = bg;
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, TR * s * 3.2, -0.22, 0.22); ctx.closePath(); ctx.fill();
    ctx.restore();
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#ff5a4d';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(P.x, P.y, 2.4, 0, TWO_PI); ctx.fill(); ctx.stroke();

    // islands: foam, beach, a faction-tinted plateau with a territory ring
    for (const [id, L] of this.world.layout) {
      const f = this.factionOf.get(id);
      const d = this.islandData?.get(id);
      const main = f ? fcol(f, 'main') : '#8a94a6';
      const sandy = d && (d.kind === 'camp' || d.kind === 'sandbox');
      this.toMap(L.x, L.z, P);
      const r = Math.max(3.5, L.r * s), pr = r * 0.78;
      ctx.fillStyle = 'rgba(233, 255, 251, 0.16)';
      ctx.beginPath(); ctx.arc(P.x, P.y, r + 2.4, 0, TWO_PI); ctx.fill();
      ctx.fillStyle = '#dcb872';
      ctx.beginPath(); ctx.arc(P.x, P.y, r, 0, TWO_PI); ctx.fill();
      ctx.fillStyle = sandy ? mixHex('#e9c47c', main, 0.3) : mixHex('#4f9e3e', main, 0.5);
      ctx.strokeStyle = f ? ftext(f) : '#dfe4ee';
      ctx.lineWidth = 1.3;
      ctx.beginPath(); ctx.arc(P.x, P.y, pr, 0, TWO_PI); ctx.fill(); ctx.stroke();
    }

    // vessels
    for (const [id, v] of this.world.vessels) {
      if (!v.group?.parent) continue;
      const p = this.portInfo.get(id);
      this.pos(v.group, P);
      const busy = (p?.activity || 0) > 0.15;
      const idleH = p ? (this.engine.serverNow() - (p.lastActive || 0)) / 3600000 : 0;
      const col = p?.adrift ? '#ff8a3a' : busy ? '#39e5ff' : idleH > 4 ? '#c98a5b' : '#e9fffb';   // adrift: warning orange
      const e = v.group.matrixWorld.elements;
      // heading: the group's local +Z axis projected into minimap space
      const hx = e[8], hz = e[10];
      const ux = hx * this.cos - hz * this.sin, uy = hx * this.sin + hz * this.cos;
      const L = Math.hypot(ux, uy) || 1, fx = ux / L, fy = uy / L, sz = 3.4;
      ctx.fillStyle = col;
      ctx.strokeStyle = 'rgba(4, 8, 24, 0.9)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(P.x + fx * sz * 1.25, P.y + fy * sz * 1.25);
      ctx.lineTo(P.x - fx * sz + -fy * sz * 0.8, P.y - fy * sz + fx * sz * 0.8);
      ctx.lineTo(P.x - fx * sz - -fy * sz * 0.8, P.y - fy * sz - fx * sz * 0.8);
      ctx.closePath(); ctx.fill(); ctx.stroke();
    }

    // buildings
    const blink = (Math.sin(time * 6) + 1) / 2;
    for (const [key, b] of this.world.buildings) {
      if (!b.group?.parent) continue;
      const sd = this.sessionState.get(key);
      const f = sd?.faction || b.faction || 'merc';
      this.pos(b.group, P);
      const hs = clamp(1.7 * s, 3, 7);
      if (sd?.state === 'needs_input') {
        ctx.fillStyle = `rgba(255, 210, 63, ${0.25 + 0.35 * blink})`;
        ctx.beginPath(); ctx.arc(P.x, P.y, hs * 2.6, 0, TWO_PI); ctx.fill();
      }
      ctx.fillStyle = sd?.state === 'needs_input' ? (blink > 0.5 ? '#ffd23f' : fcol(f, 'main')) : sd?.state === 'asleep' ? mixHex(fcol(f, 'main'), '#1a2040', 0.55) : fcol(f, 'main');
      ctx.strokeStyle = '#0b1026';
      ctx.lineWidth = 1.4;
      ctx.fillRect(P.x - hs, P.y - hs, hs * 2, hs * 2);
      ctx.strokeRect(P.x - hs, P.y - hs, hs * 2, hs * 2);
      ctx.fillStyle = fcol(f, 'trim');
      ctx.fillRect(P.x - hs, P.y - hs, hs * 2, Math.max(1.2, hs * 0.45));
    }

    // units
    for (const [id, u] of this.world.units) {
      if (!u.group?.parent) continue;
      const cmd = id.startsWith('cmd:');
      const f = u.faction || u.data?.faction || 'merc';
      this.pos(u.group, P);
      ctx.fillStyle = cmd ? fcol(f, 'trim') : ftext(f);
      ctx.strokeStyle = '#0b1026';
      ctx.lineWidth = 0.9;
      ctx.beginPath(); ctx.arc(P.x, P.y, cmd ? 2.1 : 1.45, 0, TWO_PI); ctx.fill(); ctx.stroke();
    }

    // selection marker
    const sel = this.engine.pick.selected?.object;
    if (sel?.parent) {
      this.pos(sel, P);
      const r = 7 + Math.sin(time * 5) * 1.2;
      ctx.strokeStyle = '#39e5ff';
      ctx.lineWidth = 1.6;
      for (let i = 0; i < 4; i++) {
        const a = i * Math.PI / 2 + time * 0.8;
        ctx.beginPath(); ctx.arc(P.x, P.y, r, a - 0.45, a + 0.45); ctx.stroke();
      }
    }

    // pings
    for (let i = this.pings.length - 1; i >= 0; i--) {
      const p = this.pings[i], age = time - p.t;
      if (age > PING_SECS) { this.pings.splice(i, 1); continue; }
      this.toMap(p.x, p.z, P);
      for (let j = 0; j < 2; j++) {
        const a = age - j * 0.45;
        if (a < 0) continue;
        const k2 = a / (PING_SECS - 0.45);
        ctx.strokeStyle = rgba(p.color, Math.max(0, 1 - k2) * 0.95);
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(P.x, P.y, 3 + k2 * 18, 0, TWO_PI); ctx.stroke();
      }
      ctx.fillStyle = rgba(p.color, Math.max(0, 1 - age / PING_SECS));
      ctx.beginPath(); ctx.arc(P.x, P.y, 2.6, 0, TWO_PI); ctx.fill();
    }

    // camera frustum
    const q = this.engine.view.groundQuad(this.quad);
    this.quad = q;
    ctx.beginPath();
    for (let i = 0; i < 4; i++) {
      this.toMap(q[i].x, q[i].z, P);
      if (i) ctx.lineTo(P.x, P.y); else ctx.moveTo(P.x, P.y);
    }
    ctx.closePath();
    ctx.fillStyle = 'rgba(255, 255, 255, 0.07)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.92)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // north arrow (world -Z) so rotations read
    const nx = -this.sin * -1, ny = this.cos * -1;   // map direction of world (0, -1)
    const ax = w - 12, ay = 12;
    ctx.save();
    ctx.translate(ax, ay);
    ctx.rotate(Math.atan2(ny, nx) + Math.PI / 2);
    ctx.fillStyle = '#ffc53d';
    ctx.strokeStyle = '#0b1026';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, -7); ctx.lineTo(4, 4); ctx.lineTo(0, 2); ctx.lineTo(-4, 4); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.restore();
  }
}
