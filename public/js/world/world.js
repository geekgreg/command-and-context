// World: turns snapshots into entities (DESIGN §4 "world.js responsibilities").
// Diffing, island layout (golden spiral + persisted positions), lifecycle orchestration (buildings, commanders,
// agents, vessels), event routing, the idle "director" camera and the CPU weather hook. alerts.js (turn_done /
// needs_input / agent_done spectacle) gets fresh events, per-snapshot state and frames from here.
// Every call into islands/buildings/units/harbor modules is guarded: a missing or throwing module falls back to
// the placeholder classes at the bottom of this file, so one bug never blanks the map.
import * as THREE from 'three';
import {
  PAL, factionPal, rng, box, cyl, cone, ico, sphere, group, meshOf, glow, mat, at, jitter, disposeTree,
  ease, tween, wait, clamp, lerp, V3,
} from './kit.js';
import { sessionLabel, esc, trunc } from './labels.js';

const RADIUS = { 0: 6, 1: 7, 2: 8.5, 3: 10, 4: 12 };
export const islandRadius = (tier, sessions) => (RADIUS[tier] ?? 7) + 1.4 * Math.max(0, (sessions || 0) - 2);
const GAP = 8;                 // minimum water between shores (spec: >= 6; docks need the room)
const TOWN_R = 11;             // Port Localhost footprint incl. piers
const ANNEX_PAD = 9;           // extra layout room for worktree islets
const TOWN = '__town';
const TERMINAL = new Set(['done', 'failed', 'lost']);
const HOT_EVENTS = new Set(['needs_input', 'turn_done', 'clear', 'compaction', 'commit', 'merge', 'push', 'conflict', 'pr', 'session_start']);
const GIT_EVENTS = new Set(['commit', 'pull', 'checkout', 'merge', 'push', 'conflict', 'pr']);   // -> island.launch(type, payload)
// the director never leaves a louder event for a quieter one
const EVENT_PRIO = { needs_input: 3, turn_done: 2, commit: 1.5, merge: 1.5, push: 1.5, conflict: 1.5, pr: 1.5 };
const LAYOUT_KEY = 'cnc.layout';
const GOLDEN = Math.PI * (3 - Math.sqrt(5));
const UP = new THREE.Vector3(0, 1, 0);
const _v = new THREE.Vector3();

export class World {
  constructor(engine) {
    this.engine = engine;
    this.islands = new Map();
    this.buildings = new Map();
    this.units = new Map();          // agent id -> Unit; commanders under 'cmd:<session key>'
    this.vessels = new Map();
    this.town = null;
    this.snapshot = null;
    this.layout = new Map();         // island id -> { x, z, r, ext }
    this.mods = {};
    this.bmeta = new Map();          // session key -> { island, annex, session, lot }
    this.umeta = new Map();          // unit id -> { session, kind, finishing, promise }
    this.vmeta = new Map();          // port id -> { dock: islandId | TOWN, host }
    this.ending = new Map();         // session key -> { building, island, promise }
    this.leaving = new Map();        // port id -> { vessel, island, promise }
    this.sinking = new Map();        // island id -> Island (removal in progress)
    this.foam = new Map();           // island id -> foam ring handle
    this.reinstate = new Set();      // entity ids torn down by an island rebuild: re-create them instantly
    this.maxEventId = -Infinity;
    this.seenFp = new Set();
    this.lastApplyAt = 0;
    this.serverStart = null;
    this.firstDone = false;
    this.logged = new Set();
    this.saved = loadLayout();
    this.director = new Director(this);
    engine.view.setBounds(() => this.discs());
    engine.onFrame((dt, t) => this.tick(dt, t));
    engine.settings.on('showIdle', () => { if (this.loaded) { this.flushed = null; this.flush(); } });
    this.ready = this.loadModules();
  }

  // ---- public API ----------------------------------------------------------------------------------------

  // Called by main.js for every snapshot. Resolves once the snapshot has been applied.
  apply(snapshot) {
    if (!snapshot || snapshot.v !== 1) return Promise.resolve();
    this.raw = snapshot;
    return this.ready.then(() => this.flush());
  }

  islandOf(id) { return this.islands.get(id) || (id === TOWN || id === 'localhost' ? this.town : null); }
  buildingOf(key) { return this.buildings.get(key) || null; }
  unitOf(agentId) { return this.units.get(agentId) || null; }

  // World-space box around every island (for fit-all).
  bounds() {
    const b = new THREE.Box3(V3(-TOWN_R, 0, -TOWN_R), V3(TOWN_R, 6, TOWN_R));
    for (const L of this.layout.values()) {
      const e = L.ext + 3;
      b.expandByPoint(_v.set(L.x - e, 0, L.z - e));
      b.expandByPoint(_v.set(L.x + e, 5, L.z + e));
    }
    return b;
  }

  // Fit-all shape for the camera: one flat disc per island (+ docks) and the harbor. Much tighter than a Box3.
  discs() {
    const out = [{ x: 0, z: 0, r: TOWN_R + 2, h: 8 }];
    for (const L of this.layout.values()) out.push({ x: L.x, z: L.z, r: L.ext + 4, h: 6 });
    return out;
  }

  // Where is a pick target ({type,id}) or an event? -> Vector3 | null
  positionOf(x) {
    if (!x) return null;
    const objPos = (o) => (o ? o.getWorldPosition(new THREE.Vector3()) : null);
    if (x.type === 'session' || (x.key && !x.type?.startsWith?.('port'))) {
      const b = this.buildings.get(x.type === 'session' ? x.id : x.key);
      if (b?.group) return objPos(b.group);
    }
    if (x.type === 'agent') return objPos(this.units.get(x.id)?.group);
    if (x.type === 'port') return objPos(this.vessels.get(x.id)?.group);
    if (x.type === 'port_open' || x.type === 'port_close' || x.type === 'port_adrift') {
      const v = this.vessels.get(x.portId) || this.vessels.get(String(x.port));
      return objPos(v?.group);
    }
    const iid = x.type === 'island' ? x.id : x.island;
    const L = iid && this.layout.get(iid);
    if (L) return V3(L.x, 1.5, L.z);
    return null;
  }

  // ---- modules ----------------------------------------------------------------------------------------------

  async loadModules() {
    const load = async (name) => {
      const url = new URL(`./${name}.js`, import.meta.url);
      try { return await import(url.href); } catch (e) {
        const missing = await fetch(url, { method: 'HEAD', cache: 'no-store' }).then((r) => !r.ok).catch(() => true);
        if (missing) console.warn(`[world] ${name}.js not found yet; using placeholder visuals.`);
        else console.error(`[world] ${name}.js failed to load; using placeholder visuals.`, e);
        return null;
      }
    };
    const [islands, buildings, units, harbor, alerts] = await Promise.all(['islands', 'buildings', 'units', 'harbor', 'alerts'].map(load));
    this.mods = {
      Island: fn(islands?.Island), PortTown: fn(islands?.PortTown),
      Building: fn(buildings?.Building), Unit: fn(units?.Unit), Vessel: fn(harbor?.Vessel),
    };
    this.createTown();
    const A = fn(alerts?.Alerts);
    this.alerts = A ? this.make('Alerts.constructor', () => new A(this)) : null;
    this.loaded = true;
  }

  fail(label, e) {
    if (this.logged.has(label)) return;
    this.logged.add(label);
    console.error(`[world] ${label} threw; continuing (reported once)`, e);
  }

  // Guarded method call: missing methods are skipped, exceptions logged once per Class.method.
  call(obj, method, ...args) {
    const f = obj?.[method];
    if (typeof f !== 'function') return undefined;
    try { return f.apply(obj, args); } catch (e) { this.fail(`${obj.constructor?.name || 'object'}.${method}`, e); return undefined; }
  }

  make(label, factory) {
    try { return factory(); } catch (e) { this.fail(label, e); return null; }
  }

  // Await a module promise, but never longer than `secs` (engine clock) and never throw.
  settle(p, secs, label) {
    const guarded = Promise.resolve(p).catch((e) => this.fail(label || 'async', e));
    return Promise.race([guarded, wait(secs)]);
  }

  adopt(group) { if (group?.isObject3D && !group.parent) this.engine.root.add(group); }
  detach(group) { group?.parent?.remove(group); }

  // ---- snapshot flow ----------------------------------------------------------------------------------------

  flush() {
    const raw = this.raw;
    if (!raw || raw === this.flushed) return;
    this.flushed = raw;
    const e = this.engine;
    e.syncClock?.(raw.now);
    e.forceSky?.(raw.demo?.forceNight ? 'night' : null);
    const now = Date.now();
    const gap = this.lastApplyAt > 0 && now - this.lastApplyAt > 30000;
    const restarted = this.serverStart != null && raw.server?.startedAt != null && raw.server.startedAt !== this.serverStart;
    // Nothing is being drawn (minimized / covered window): apply without animations, like after a gap. Animations
    // only advance with frames, so entrances, exits and one-shots would otherwise pile up for as long as it lasts.
    const stalled = this.firstDone && !!e.renderStalled?.();
    const materialize = !this.firstDone || gap || stalled;
    this.lastApplyAt = now;
    this.serverStart = raw.server?.startedAt ?? this.serverStart;
    this.snapshot = raw;
    const snap = this.filter(raw);

    let changed = false;
    try { changed = this.syncIslands(snap, materialize); } catch (err) { this.fail('world.syncIslands', err); }
    try { this.syncBuildings(snap, materialize); } catch (err) { this.fail('world.syncBuildings', err); }
    try { this.syncUnits(snap, materialize); } catch (err) { this.fail('world.syncUnits', err); }
    try { this.syncVessels(snap, materialize); } catch (err) { this.fail('world.syncVessels', err); }
    this.reinstate.clear();              // rebuilt entities are re-created within the same pass
    try {
      if (restarted) this.maxEventId = -Infinity;
      // back after a gap or a server restart: no one-shots, but the HUD gets the missed news as a digest
      this.routeEvents(raw, materialize || restarted, stalled && !gap && !restarted, this.firstDone && (gap || restarted));
    } catch (err) { this.fail('world.routeEvents', err); }
    this.call(this.alerts, 'sync', snap, { instant: materialize, events: raw.events });
    e.setWeather?.(raw.system?.cpu);

    if (!this.firstDone) {
      this.firstDone = true;
      this.intro(snap);
      const q = new URLSearchParams(location.search);   // dev hook: ?alerttest=turn|busy|needs|agent|all
      if (q.has('alerttest')) this.call(this.alerts, 'test', q.get('alerttest') || 'all', parseFloat(q.get('alertseek')) || 1.2);
    } else if (changed) this.autoFit();
    e.bus.emit('snapshot', raw);
  }

  // Something finished leaving (a boat, a decommissioned base, a sunk island) but the latest snapshot still wants
  // it (it moved or came back): re-apply that snapshot now instead of waiting for the next one.
  refresh() {
    if (this.refreshing) return;
    this.refreshing = true;
    queueMicrotask(() => {
      this.refreshing = false;
      if (this.loaded && this.raw) { this.flushed = null; this.flush(); }
    });
  }

  // settings.showIdle = false hides asleep bases (and islands left empty by that).
  filter(raw) {
    const base = { ...raw, islands: raw.islands || [], sessions: raw.sessions || [], ports: raw.ports || [] };
    if (this.engine.settings.showIdle) return base;
    const sessions = base.sessions.filter((s) => s.state !== 'asleep');
    const count = new Map();
    for (const s of sessions) count.set(s.island, (count.get(s.island) || 0) + 1);
    const islands = base.islands.filter((i) => count.has(i.id)).map((i) => ({ ...i, sessions: count.get(i.id) }));
    return { ...base, sessions, islands };
  }

  // First framing. URL helpers for screenshots: ?shot (no intro swoop), ?focus=<island name|id|x,z>, ?zoom=<n>,
  // ?rotate=<n> (quarter turns, like pressing E n times; negative = Q).
  intro(snap) {
    const q = new URLSearchParams(location.search), v = this.engine.view;
    const zoom = parseFloat(q.get('zoom')), focus = q.get('focus'), rot = parseInt(q.get('rotate'), 10) || 0;
    for (let i = 0; i < Math.abs(rot); i++) v.rotate(Math.sign(rot), { secs: 0 });
    if (!q.has('shot') && !focus && !zoom) { v.fit(undefined, { secs: 2.2, swoop: true }); return; }
    v.fit(undefined, { secs: 0 });
    let p = null;
    const xz = focus?.match(/^(-?[\d.]+),(-?[\d.]+)$/);
    if (xz) p = V3(+xz[1], 0, +xz[2]);
    else if (focus) {
      const d = snap.islands.find((i) => i.id === focus || i.name === focus);
      const L = d && this.layout.get(d.id);
      if (L) p = V3(L.x, TOP, L.z);
    }
    if (p || zoom) v.focus(p || v.target, { zoom: zoom || v.zoom, secs: 0 });
  }

  autoFit() {
    const v = this.engine.view;
    if (v.userMovedWithin(60)) return;
    v.fit(undefined, { secs: this.engine.settings.reduceMotion ? 0 : 1.8 });
  }

  // ---- islands ------------------------------------------------------------------------------------------------

  syncIslands(snap, instant) {
    let changed = false;
    const want = new Map(snap.islands.map((d) => [d.id, d]));
    for (const id of [...this.islands.keys()]) {
      if (!want.has(id)) { this.removeIsland(id, instant); changed = true; }
    }
    for (const d of snap.islands) {
      const isl = this.islands.get(d.id);
      if (!isl) continue;
      this.call(isl, 'update', d);
      this.growIsland(d);
    }
    const fresh = snap.islands.filter((d) => !this.islands.has(d.id) && !this.sinking.has(d.id));
    if (fresh.length) {
      this.placeIslands(fresh);
      for (const d of fresh) this.createIsland(d, instant || this.reinstate.delete('island:' + d.id));
      changed = true;
    }
    return changed;
  }

  // Assign layout slots: remembered islands keep their spot (nudged only if it is now taken), new ones take the
  // first free slot of a golden-angle spiral around Port Localhost.
  placeIslands(list) {
    const order = [...list].sort((a, b) => (this.saved[a.id]?.t ?? Infinity) - (this.saved[b.id]?.t ?? Infinity));
    for (const d of order) {
      if (this.layout.has(d.id)) continue;       // rebuilt islands keep their (possibly nudged) entry
      const r = islandRadius(d.tier, d.sessions), ext = extentOf(d, r);
      const s = this.saved[d.id];
      const p = s ? this.findFree(s.x, s.z, ext, d.id) : this.findFree(0, 0, ext, d.id, true);
      this.layout.set(d.id, { x: p.x, z: p.z, r, ext });
      this.persist(d.id);
    }
  }

  findFree(px, pz, ext, skip, spiral = false) {
    const circles = [{ x: 0, z: 0, r: TOWN_R }];
    for (const [id, L] of this.layout) if (id !== skip) circles.push({ x: L.x, z: L.z, r: L.ext });
    const fits = (x, z) => circles.every((c) => Math.hypot(x - c.x, z - c.z) >= c.r + ext + GAP);
    const d0 = spiral ? TOWN_R + ext + GAP : 0, step = spiral ? 2.4 : 1.5, a0 = -Math.PI / 4;
    for (let k = 0; k < 5000; k++) {
      const a = a0 + k * GOLDEN, d = d0 + step * Math.sqrt(k);
      const x = px + Math.cos(a) * d, z = pz + Math.sin(a) * d;
      if (fits(x, z)) return { x: Math.round(x * 10) / 10, z: Math.round(z * 10) / 10 };
    }
    return { x: px + 400, z: pz };
  }

  // Islands grow with tier/sessions. If the Island can't resize itself (no setRadius) and it grew noticeably, it
  // is rebuilt in place; neighbours it now overlaps are nudged (rebuilt at the nearest free spot).
  growIsland(d) {
    const L = this.layout.get(d.id);
    if (!L) return;
    const r = islandRadius(d.tier, d.sessions), ext = extentOf(d, r);
    if (r <= L.r + 0.01 && ext <= L.ext + 0.01) return;      // never shrink a live island
    const isl = this.islands.get(d.id);
    let rebuild = false;
    if (r > L.r + 0.01) {
      if (typeof isl?.setRadius === 'function') this.call(isl, 'setRadius', r);
      else if (r - L.r >= 1) rebuild = true;
    }
    L.r = Math.max(L.r, r);
    L.ext = Math.max(L.ext, ext);
    if (Math.hypot(L.x, L.z) < TOWN_R + L.ext + GAP) {         // grew into the harbor: move it instead
      const p = this.findFree(L.x, L.z, L.ext, d.id);
      L.x = p.x; L.z = p.z;
      rebuild = true;
    }
    if (rebuild) this.rebuildIsland(d.id);
    for (const [id, o] of this.layout) {
      if (id === d.id || Math.hypot(o.x - L.x, o.z - L.z) >= o.ext + L.ext + GAP) continue;
      const p = this.findFree(o.x, o.z, o.ext, id);
      o.x = p.x; o.z = p.z;
      this.persist(id);
      this.rebuildIsland(id);
    }
    this.persist(d.id);
  }

  // Tear an island and everything on it down (no animations); the rest of this sync pass re-creates it all
  // instantly at its layout entry.
  rebuildIsland(id) {
    const isl = this.islands.get(id);
    if (!isl) return;
    for (const [key, m] of this.bmeta) {
      if (m.island !== id || !this.buildings.has(key)) continue;
      for (const [uid, um] of this.umeta) {
        if (um.session !== key) continue;
        this.reinstate.add(uid);
        this.dropUnit(uid);
      }
      this.reinstate.add(key);
      this.dropBuilding(key);
    }
    for (const [pid, m] of this.vmeta) {
      if (m.dock !== id || !this.vessels.has(pid)) continue;
      this.reinstate.add('port:' + pid);
      this.dropVessel(pid);
    }
    this.dropIsland(id);
    this.reinstate.add('island:' + id);
    const L = this.layout.get(id);
    if (L && this.firstDone) {
      this.engine.fx.ring(V3(L.x, 0.3, L.z), 0x39e5ff, { radius: L.r + 3, secs: 1.2 });
      this.engine.fx.puff(V3(L.x, 1, L.z), { count: 18, spread: 3, size: 1.1 });
    }
  }

  createIsland(d, instant) {
    const L = this.layout.get(d.id);
    const opts = { position: V3(L.x, 0, L.z), radius: L.r, instant };
    let isl = this.mods.Island && this.make('Island.constructor', () => new this.mods.Island(this, d, opts));
    if (!isl?.group) isl = new PlaceholderIsland(this, d, opts);
    this.adopt(isl.group);
    this.engine.pick.add(isl.group, { type: 'island', id: d.id });
    this.islands.set(d.id, isl);
    this.foam.get(d.id)?.remove();
    this.foam.set(d.id, this.engine.addFoamRing({ x: L.x, z: L.z }, isl.shoreRadius ?? L.r * 0.99));
    if (!instant) {
      this.engine.fx.ring(V3(L.x, 0.3, L.z), 0xe9fffb, { radius: L.r + 4, secs: 1.4 });
      this.engine.fx.puff(V3(L.x, 0.6, L.z), { count: 16, spread: 3.2, size: 1.2, color: PAL.foam });
    }
  }

  dropIsland(id) {
    const isl = this.islands.get(id);
    if (!isl) return;
    this.islands.delete(id);
    this.engine.pick.remove(isl.group);
    this.call(isl, 'dispose');
    this.detach(isl.group);
    this.foam.get(id)?.remove();
    this.foam.delete(id);
  }

  // Island left the snapshot: wait for its buildings to finish decommissioning and its boats to leave, then sink.
  removeIsland(id, instant) {
    const isl = this.islands.get(id);
    if (!isl) return;
    this.islands.delete(id);
    this.sinking.set(id, isl);
    this.engine.pick.remove(isl.group);
    (async () => {
      await null;   // let this sync pass register the endings / departures first
      const pending = [];
      for (const x of this.ending.values()) if (x.island === id) pending.push(x.promise);
      for (const x of this.leaving.values()) if (x.island === id) pending.push(x.promise);
      if (!instant) {
        await this.settle(Promise.allSettled(pending), 16);
        await tween(isl.group.position, { y: -4.5 }, 1.8, ease.inCubic);
      }
    })().catch((e) => this.fail('world.removeIsland', e)).finally(() => {
      this.call(isl, 'dispose');
      this.detach(isl.group);
      this.foam.get(id)?.remove();
      this.foam.delete(id);
      this.sinking.delete(id);
      this.layout.delete(id);
      this.autoFit();
      if (this.raw?.islands?.some((i) => i.id === id)) this.refresh();
    });
  }

  createTown() {
    // One object serves as both `data` and `opts`, so PortTown(world, opts) and PortTown(world, data, opts) both work.
    const arg = { id: 'localhost', name: 'Port Localhost', kind: 'town', position: V3(0, 0, 0), radius: TOWN_R, instant: true };
    const P = this.mods.PortTown;
    let t = P && this.make('PortTown.constructor', () => new P(this, arg, arg));
    if (t?.group && t.group.children.length === 0) {       // a stub town (nothing built): use the placeholder harbor
      console.info('[world] PortTown built no geometry yet; using the placeholder harbor.');
      this.call(t, 'dispose');
      t = null;
    }
    if (!t?.group) t = new PlaceholderTown(this, arg);
    this.adopt(t.group);
    this.town = t;
    this.engine.addFoamRing({ x: 0, z: 0 }, t.shoreRadius ?? t.radius ?? 8.6);
  }

  // ---- buildings -------------------------------------------------------------------------------------------------

  syncBuildings(snap, instant) {
    const seen = new Set();
    const sessions = [...snap.sessions].sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
    for (const s of sessions) {
      seen.add(s.key);
      const b = this.buildings.get(s.key);
      if (s.state === 'ended') { if (b) this.endBuilding(s.key, 'ended', instant); continue; }
      if (b) {
        const m = this.bmeta.get(s.key);
        if (m.island === s.island && m.annex === (s.annex ?? null)) {
          this.call(b, 'update', s, m.session, { instant });
          m.session = s;
          continue;
        }
        // moved to another island / worktree: decommission and rebuild (materializing: swap right away)
        if (!instant) { this.endBuilding(s.key, 'moved', false); continue; }
        this.dropSession(s.key);
      }
      if (this.ending.has(s.key)) continue;            // previous incarnation still decommissioning
      const isl = this.islands.get(s.island);
      if (!isl) continue;
      this.createBuilding(s, isl, instant || this.reinstate.delete(s.key));
    }
    for (const key of [...this.buildings.keys()]) if (!seen.has(key)) this.endBuilding(key, 'vanished', instant);
  }

  createBuilding(s, isl, instant) {
    let lot = this.make(`${isl.constructor?.name}.allocLot`, () => isl.allocLot(s.key, { annex: s.annex || null }));
    if (!lot?.position) lot = fallbackLot(isl, this.layout.get(s.island), s.key);
    let b = this.mods.Building && this.make('Building.constructor', () => new this.mods.Building(this, s, lot, isl, { instant }));
    if (!b?.group) b = new PlaceholderBuilding(this, s, lot, isl, { instant });
    this.adopt(b.group);
    this.engine.pick.add(b.group, { type: 'session', id: s.key });
    this.buildings.set(s.key, b);
    this.bmeta.set(s.key, { island: s.island, annex: s.annex ?? null, session: s, lot });
    const cid = 'cmd:' + s.key;
    this.createUnit(cid, { kind: 'commander', data: s, building: b, island: isl, instant: instant || this.reinstate.delete(cid), session: s.key });
  }

  // why: 'ended' | 'vanished' | 'moved'
  endBuilding(key, why, instant) {
    const b = this.buildings.get(key);
    if (!b) return;
    const m = this.bmeta.get(key);
    this.buildings.delete(key);
    this.engine.pick.remove(b.group);
    const isl = this.islands.get(m.island) || this.sinking.get(m.island);
    const units = [];
    for (const [uid, um] of this.umeta) {
      if (um.session === key) units.push(this.finishUnit(uid, uid.startsWith('cmd:') && why === 'ended' ? 'done' : 'lost', instant));
    }
    const promise = (async () => {
      if (!instant) await Promise.all([this.settle(Promise.all(units), 10), this.settle(this.call(b, 'end'), 14, 'Building.end')]);
    })().finally(() => {
      this.call(b, 'dispose');
      this.detach(b.group);
      if (isl) this.call(isl, 'releaseLot', key);
      this.ending.delete(key);
      this.bmeta.delete(key);
      if (this.raw?.sessions?.some((s) => s.key === key && s.state !== 'ended')) this.refresh();
    });
    this.ending.set(key, { building: b, island: m.island, promise });
  }

  // Immediate removal of a building and its units (island rebuilds, materialize swaps).
  dropSession(key) {
    for (const [uid, um] of this.umeta) if (um.session === key) this.dropUnit(uid);
    this.dropBuilding(key);
  }

  // Immediate removal (island rebuilds): no animation, lot released, meta dropped.
  dropBuilding(key) {
    const b = this.buildings.get(key);
    if (!b) return;
    const m = this.bmeta.get(key);
    this.buildings.delete(key);
    this.engine.pick.remove(b.group);
    this.call(b, 'dispose');
    this.detach(b.group);
    this.call(this.islands.get(m.island), 'releaseLot', key);
    this.bmeta.delete(key);
  }

  // ---- units --------------------------------------------------------------------------------------------------------

  syncUnits(snap, instant) {
    const alive = new Set();
    for (const s of snap.sessions) {
      if (s.state === 'ended') continue;
      const b = this.buildings.get(s.key);
      if (!b) continue;
      const isl = this.islands.get(s.island);
      const cid = 'cmd:' + s.key;
      alive.add(cid);
      const cu = this.units.get(cid);
      if (cu) { if (!this.umeta.get(cid)?.finishing) this.call(cu, 'update', s); } else if (isl) {
        this.createUnit(cid, { kind: 'commander', data: s, building: b, island: isl, instant, session: s.key });
      }
      // parents before apprentices so depth-2 agents can spawn at their parent
      const agents = [...(s.agents || [])].sort((a, c) => (a.depth || 1) - (c.depth || 1));
      for (const a of agents) {
        const u = this.units.get(a.id);
        if (TERMINAL.has(a.state)) {
          if (u) { alive.add(a.id); this.finishUnit(a.id, a.state, instant); }
          continue;                                  // never create units for already-finished agents
        }
        alive.add(a.id);
        if (u) { if (!this.umeta.get(a.id)?.finishing) this.call(u, 'update', a); continue; }
        if (!isl) continue;
        this.createUnit(a.id, { kind: 'agent', data: a, building: b, island: isl, instant: instant || this.reinstate.delete(a.id), session: s.key });
      }
    }
    for (const id of [...this.units.keys()]) {
      if (!alive.has(id) && !this.umeta.get(id)?.finishing) this.finishUnit(id, 'lost', instant);
    }
  }

  createUnit(id, { kind, data, building, island, instant, session }) {
    const parent = kind === 'agent' && (data.depth || 1) > 1 && data.parent ? this.units.get(data.parent) || null : null;
    const spawn = parent?.group ? parent.group.getWorldPosition(new THREE.Vector3()) : vec(building.door);
    const opts = { kind, data, building, island, instant, parent, spawn };
    let u = this.mods.Unit && this.make('Unit.constructor', () => new this.mods.Unit(this, opts));
    if (!u?.group) u = new PlaceholderUnit(this, opts);
    this.adopt(u.group);
    this.engine.pick.add(u.group, kind === 'commander' ? { type: 'session', id: data.key, unit: id } : { type: 'agent', id: data.id, session });
    this.units.set(id, u);
    this.umeta.set(id, { session, kind, finishing: false, promise: null });
  }

  finishUnit(id, status, instant) {
    const u = this.units.get(id), m = this.umeta.get(id);
    if (!u || !m) return Promise.resolve();
    if (m.finishing) return m.promise;
    m.finishing = true;
    this.engine.pick.remove(u.group);
    m.promise = (async () => {
      if (!instant) await this.settle(this.call(u, 'finish', status), 16, 'Unit.finish');
    })().finally(() => {
      this.call(u, 'dispose');
      this.detach(u.group);
      if (this.units.get(id) === u) { this.units.delete(id); this.umeta.delete(id); }
    });
    return m.promise;
  }

  dropUnit(id) {
    const u = this.units.get(id);
    if (!u) return;
    this.units.delete(id);
    this.umeta.delete(id);
    this.engine.pick.remove(u.group);
    this.call(u, 'dispose');
    this.detach(u.group);
  }

  // ---- vessels ----------------------------------------------------------------------------------------------------

  syncVessels(snap, instant) {
    const seen = new Set();
    for (const p of snap.ports) {
      if (p.kind === 'lighthouse') { this.setLighthouse(p); continue; }
      seen.add(p.id);
      const where = p.island && this.islands.has(p.island) ? p.island : TOWN;
      const v = this.vessels.get(p.id);
      if (v) {
        if (this.vmeta.get(p.id).dock === where) { this.call(v, 'update', p); continue; }
        if (!instant) { this.departVessel(p.id, false); continue; }   // cast off; re-docks once it has left
        this.dropVessel(p.id);
      }
      if (this.leaving.has(p.id)) continue;           // the old boat is still casting off
      const host = where === TOWN ? this.town : this.islands.get(where);
      if (!host) continue;
      this.createVessel(p, where, host, instant || this.reinstate.delete('port:' + p.id));
    }
    for (const id of [...this.vessels.keys()]) if (!seen.has(id)) this.departVessel(id, instant);
  }

  createVessel(p, where, host, instant) {
    let dock = this.make(`${host.constructor?.name}.allocDock`, () => host.allocDock(p.id, { container: p.kind === 'docker' }));
    if (!dock?.berth) dock = fallbackDock(host, where === TOWN ? { x: 0, z: 0, r: 9 } : this.layout.get(where), p.id);
    let v = this.mods.Vessel && this.make('Vessel.constructor', () => new this.mods.Vessel(this, p, dock, { instant }));
    if (!v?.group) v = new PlaceholderVessel(this, p, dock, { instant });
    this.adopt(v.group);
    this.engine.pick.add(v.group, { type: 'port', id: p.id });
    this.vessels.set(p.id, v);
    this.vmeta.set(p.id, { dock: where, host });
  }

  departVessel(id, instant) {
    const v = this.vessels.get(id), m = this.vmeta.get(id);
    if (!v) return;
    this.vessels.delete(id);
    this.engine.pick.remove(v.group);
    const promise = (async () => {
      if (!instant) await this.settle(this.call(v, 'depart'), 12, 'Vessel.depart');
    })().finally(() => {
      this.call(v, 'dispose');
      this.detach(v.group);
      this.call(m.host, 'releaseDock', id);
      this.leaving.delete(id);
      if (!this.vessels.has(id)) this.vmeta.delete(id);
      if (this.raw?.ports?.some((p) => p.id === id)) this.refresh();
    });
    this.leaving.set(id, { vessel: v, island: m.dock, promise });
  }

  dropVessel(id) {
    const v = this.vessels.get(id), m = this.vmeta.get(id);
    if (!v) return;
    this.vessels.delete(id);
    this.vmeta.delete(id);
    this.engine.pick.remove(v.group);
    this.call(v, 'dispose');
    this.detach(v.group);
    this.call(m?.host, 'releaseDock', id);
  }

  setLighthouse(p) {
    this.call(this.town, 'setLighthouse', p);
    const lh = this.town?.lighthouse;
    if (lh?.isObject3D && this.lhObject !== lh) {
      this.lhObject = lh;
      this.engine.pick.add(lh, { type: 'port', id: p.id });
    }
  }

  // ---- events -------------------------------------------------------------------------------------------------------

  // Route events newer than anything seen: event ids are strictly increasing numbers (port events carry the
  // vessel id in `portId`), tracked with a high-water mark. A non-numeric id (older servers) falls back to
  // fingerprint de-duplication. `skip` records without routing (first snapshot / reconnect / server restart);
  // `logOnly` (renderer stalled) still announces fresh events (EVA log) but plays no one-shot animations; `away`
  // (after a gap or a server restart) hands the fresh events to the HUD in one 'away' bus event instead, for a
  // compact "while you were away" digest. The first snapshot's events are never announced.
  routeEvents(raw, skip, logOnly = false, away = false) {
    const evs = Array.isArray(raw.events) ? raw.events : [];
    const fps = new Set(), fresh = [];
    let max = this.maxEventId;
    for (const ev of evs) {
      if (!ev || !ev.type) continue;
      if (typeof ev.id === 'number' && Number.isFinite(ev.id)) {
        if (ev.id > this.maxEventId) fresh.push(ev);
        if (ev.id > max) max = ev.id;
      } else {
        const fp = `${ev.t}|${ev.type}|${ev.id}|${ev.port ?? ''}`;
        fps.add(fp);
        if (!this.seenFp.has(fp)) fresh.push(ev);
      }
    }
    this.maxEventId = max;
    this.seenFp = fps;
    if (skip) {
      if (logOnly) for (const ev of fresh) this.engine.bus.emit('event', ev);
      else if (away && fresh.length) this.engine.bus.emit('away', fresh);
      return;
    }
    for (const ev of fresh) this.route(ev);
  }

  route(ev) {
    const b = ev.key ? this.buildings.get(ev.key) : null;
    if (ev.type === 'clear' && b) this.call(b, 'clear', ev);
    else if (ev.type === 'compaction' && b) this.call(b, 'compaction', ev);
    else if (GIT_EVENTS.has(ev.type)) {
      const isl = this.islands.get(ev.island);
      if (isl) this.call(isl, 'launch', ev.type, launchPayload(ev));
    }
    this.call(this.alerts, 'onEvent', ev);
    this.director.onEvent(ev);
    this.engine.bus.emit('event', ev);
  }

  // ---- per frame ----------------------------------------------------------------------------------------------------

  tick(dt, t) {
    if (this.town) this.call(this.town, 'tick', dt, t);
    for (const x of this.islands.values()) this.call(x, 'tick', dt, t);
    for (const x of this.sinking.values()) this.call(x, 'tick', dt, t);
    for (const x of this.buildings.values()) this.call(x, 'tick', dt, t);
    for (const x of this.ending.values()) this.call(x.building, 'tick', dt, t);
    for (const x of this.units.values()) this.call(x, 'tick', dt, t);
    for (const x of this.vessels.values()) this.call(x, 'tick', dt, t);
    for (const x of this.leaving.values()) this.call(x.vessel, 'tick', dt, t);
    this.call(this.alerts, 'tick', dt, t);
    this.director.tick(dt);
  }

  // ---- layout persistence ----------------------------------------------------------------------------------------------

  persist(id) {
    const L = this.layout.get(id);
    if (!L) return;
    this.saved[id] = { x: L.x, z: L.z, t: this.saved[id]?.t ?? Date.now() };
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      const entries = Object.entries(this.saved).sort((a, b) => (b[1].seen ?? b[1].t) - (a[1].seen ?? a[1].t)).slice(0, 80);
      for (const [k, v] of entries) if (this.layout.has(k)) v.seen = Date.now();
      this.saved = Object.fromEntries(entries);    // in memory too: every scratch sandbox is a new island id
      try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(this.saved)); } catch { /* ignore */ }
    }, 400);
  }
}

// ---- helpers -----------------------------------------------------------------------------------------------------------

const fn = (x) => (typeof x === 'function' ? x : null);
const vec = (p) => (p?.isVector3 ? p.clone() : p && Number.isFinite(p.x) ? V3(p.x, p.y || 0, p.z) : null);
const extentOf = (d, r) => r + ((d.annexes?.length || 0) > 0 ? ANNEX_PAD : 0);

// Remembered island positions; anything that is not a plain object of { x, z } entries is ignored.
function loadLayout() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(LAYOUT_KEY) || '{}'); } catch { /* storage blocked or corrupt */ }
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return {};
  return Object.fromEntries(Object.entries(saved).filter(([, v]) => v && typeof v === 'object' && Number.isFinite(v.x) && Number.isFinite(v.z)));
}

// DESIGN says launch(kind, text); the brief says launch(type, ev). Hand over a String object of the display text
// (commit message / new branch / merged branches / pushed ref) that also carries every event field, so both work.
function launchPayload(ev) {
  const text = ev.type === 'checkout' ? (ev.to || ev.branch || '')
    : ev.type === 'merge' ? (ev.from ? `${ev.from} → ${ev.branch || 'HEAD'}` : ev.msg || 'merge')
    : ev.type === 'push' ? `${ev.remote || 'origin'}/${ev.branch || ''}`
    : (ev.msg || ev.name || '');
  return Object.assign(new String(text), ev);
}

function fallbackLot(isl, L, key) {
  const c = L || { x: isl.group?.position.x || 0, z: isl.group?.position.z || 0, r: 6 };
  const R = rng(key), a = R() * Math.PI * 2, d = R() * c.r * 0.35;
  return { position: V3(c.x + Math.cos(a) * d, isl.top ?? 1.5, c.z + Math.sin(a) * d), facing: Math.PI / 4, size: 5, annex: null };
}

function fallbackDock(host, L, id) {
  const c = L || { x: 0, z: 0, r: 8 };
  const a = rng('dock' + id)() * Math.PI * 2, dir = V3(Math.cos(a), 0, Math.sin(a));
  return { root: null, berth: V3(c.x + dir.x * (c.r + 4.5), 0, c.z + dir.z * (c.r + 4.5)), dir, facing: Math.atan2(dir.x, dir.z) };
}

// ---- director: gentle camera tour while the user is away -------------------------------------------------------------

class Director {
  constructor(world) {
    this.w = world;
    this.timer = 2;
    this.hold = 0;
    this.holdPrio = 0;
    this.hops = 0;
    this.cursor = 0;
  }

  get active() {
    const e = this.w.engine;
    return e.settings.director && this.w.firstDone && e.view.idleSecs() >= 45;
  }

  tick(dt) {
    if (!this.active) { this.timer = 1.5; this.hold = 0; return; }
    if (this.hold > 0) { this.hold -= dt; return; }
    if ((this.timer -= dt) > 0) return;
    const rm = this.w.engine.settings.reduceMotion;
    this.timer = rm ? 24 : 15;
    const poi = this.next();
    if (!poi) return;
    const v = this.w.engine.view;
    if (poi.fit) v.fit(undefined, { secs: rm ? 0 : 7 });
    else v.focus(poi.pos, { zoom: poi.zoom, secs: rm ? 0 : 7 });
  }

  // needs_input bases first, then working ones, then busy docks; every 4th hop shows the whole map.
  next() {
    const w = this.w, list = [];
    for (const [key, b] of w.buildings) {
      const s = w.bmeta.get(key)?.session;
      if (!s || !b.group) continue;
      const prio = s.state === 'needs_input' ? 3 : s.state === 'working' || s.state === 'thinking' || w.alerts?.isReady?.(key) ? 2 : 0;
      if (prio) list.push({ prio, obj: b.group, zoom: prio === 3 ? 1.9 : 1.5 });
    }
    for (const [id, v] of w.vessels) {
      const p = w.snapshot?.ports?.find((x) => x.id === id);
      if (p && p.activity > 0.25 && v.group) list.push({ prio: 1, obj: v.group, zoom: 1.7 });
    }
    const top = list.reduce((m, x) => Math.max(m, x.prio), 0);
    if (!top || (top < 3 && this.hops++ % 4 === 3)) return { fit: true };
    const cands = list.filter((x) => x.prio === top);
    const pick = cands[this.cursor++ % cands.length];
    return { pos: pick.obj.getWorldPosition(new THREE.Vector3()), zoom: pick.zoom };
  }

  onEvent(ev) {
    if (!HOT_EVENTS.has(ev.type) || !this.active) return;
    const prio = EVENT_PRIO[ev.type] || 1;
    if (this.hold > 0 && prio < this.holdPrio) return;
    const pos = this.w.positionOf(ev);
    if (!pos) return;
    const rm = this.w.engine.settings.reduceMotion;
    this.w.engine.view.focus(pos, { zoom: ev.type === 'turn_done' ? 1.3 : 1.7, secs: rm ? 0 : 2.4 });
    this.hold = 6;
    this.holdPrio = prio;
    this.timer = 1;
  }
}

// =====================================================================================================================
// Placeholders: simple but honest visuals with the full module interfaces (they double as test fixtures).
// =====================================================================================================================

const TOP = 1.5;                         // placeholder plateau height
const TREE_COLORS = [PAL.leaf, PAL.leafDark, 0x7bcf52];

function local(group, x, y, z) { return V3(x, y, z).applyAxisAngle(UP, group.rotation.y).add(group.position); }

class PlaceholderIsland {
  constructor(world, data, { position, radius }) {
    this.world = world;
    this.engine = world.engine;
    this.data = data;
    this.radius = radius;
    this.top = TOP;
    this.center = position.clone().setY(0);
    const g = this.group = new THREE.Group();
    g.name = 'island:' + data.id;
    g.position.copy(this.center);
    const r = radius, R = rng(data.id), sandy = data.kind === 'camp' || data.kind === 'sandbox';
    this.pr = r * 0.78;                                           // plateau (walkable) radius

    const beach = meshOf(jitter(new THREE.CylinderGeometry(r * 0.96, r * 1.03, 0.9, 18), 0.22, R() * 1e6, true), PAL.sand);
    beach.position.y = -0.33;
    const cliffGeo = jitter(new THREE.CylinderGeometry(this.pr * 1.0, this.pr * 1.07, TOP - 0.35, 15, 2), 0.28, R() * 1e6, true);
    cliffGeo.translate(0, (TOP - 0.35) / 2 + 0.05, 0);
    const cliff = meshOf(cliffGeo, PAL.cliff);
    const cap = cyl(this.pr * 1.03, this.pr * 0.99, 0.32, 15, sandy ? PAL.sandDark : PAL.grass);
    cap.position.y = TOP - 0.32;
    g.add(beach, cliff, cap);

    this.slots = layoutSlots(this.pr, R() * Math.PI);
    this.lots = new Map();
    this.platforms = [];
    this.docks = new Map();
    this.annexes = new Map();
    const blocked = (x, z, pad = 0.4) => this.slots.some((s) => Math.abs(x - s.x) < 2.7 + pad && Math.abs(z - s.z) < 2.7 + pad);
    const free = (n, minR = 0, maxR = this.pr - 1) => {
      const out = [];
      for (let i = 0; i < 400 && out.length < n; i++) {
        const a = R() * Math.PI * 2, d = minR + Math.sqrt(R()) * (maxR - minR);
        const x = Math.cos(a) * d, z = Math.sin(a) * d;
        if (!blocked(x, z) && out.every((p) => Math.hypot(p.x - x, p.z - z) > 1.6)) out.push({ x, z });
      }
      return out;
    };
    const W = (p) => V3(p.x + this.center.x, TOP, p.z + this.center.z);

    // stations
    const crystals = free(data.kind === 'repo' ? Math.min(3, 1 + Math.floor((data.tier || 1) / 2)) : 1, 1, this.pr - 1.2);
    for (const p of crystals) g.add(crystalCluster(p.x, p.z, R));
    const [arch] = free(1, 1, this.pr - 1.5);
    if (arch) g.add(at(group(box(1.4, 1.1, 1.2, PAL.wood), at(cone(1.1, 0.7, 4, PAL.woodDark), 0, 1.1, 0, { ry: Math.PI / 4 })), arch.x, TOP, arch.z));
    const [tree] = free(1, 0.5, this.pr - 1.5);
    if (tree) g.add(at(group(cyl(0.18, 0.26, 1.4, 6, PAL.woodDark), at(ico(0.95, 0, PAL.leafDark), 0, 1.8, 0)), tree.x, TOP, tree.z));
    const [pad] = free(1, 1, this.pr - 1.4);
    if (pad) g.add(at(cyl(0.9, 1.0, 0.12, 8, PAL.metalDark), pad.x, TOP, pad.z));
    const shore = [];
    for (let i = 0; i < 6; i++) { const a = (i / 6) * Math.PI * 2 + R(); shore.push(V3(this.center.x + Math.cos(a) * (this.pr - 0.6), TOP, this.center.z + Math.sin(a) * (this.pr - 0.6))); }
    const fallback = V3(this.center.x, TOP, this.center.z);
    this.stations = {
      crystals: crystals.map(W), archive: arch ? W(arch) : fallback, shore, gitTree: tree ? W(tree) : fallback, launchPad: pad ? W(pad) : fallback,
    };

    // scenery
    for (const p of free(Math.round(2 + r * 0.5), 1, this.pr - 0.7)) {
      if (sandy) g.add(at(cone(0.5, 1.4, 5, 0x8fbf4a), p.x, TOP, p.z));
      else g.add(at(group(cyl(0.1, 0.14, 0.6, 5, PAL.woodDark), at(cone(0.62, 1.3, 6, TREE_COLORS[Math.floor(R() * 3)]), 0, 0.5, 0)), p.x, TOP, p.z, { s: 0.7 + R() * 0.6 }));
    }
    for (let i = 0; i < 4; i++) {
      const a = R() * Math.PI * 2;
      g.add(at(ico(0.4 + R() * 0.4, 0, PAL.rock), Math.cos(a) * r * 0.93, 0.15, Math.sin(a) * r * 0.93, { ry: R() * 3 }));
    }
    if (data.kind === 'camp') g.add(campfire(free(1, 0.5, 2)[0] || { x: 0, z: 0 }));
    if (data.kind === 'sandbox') {
      const p = free(1, 0.5, this.pr - 1.5)[0];
      if (p) g.add(at(group(cyl(0.7, 0.8, 0.6, 6, PAL.sand), at(cone(0.35, 0.6, 6, PAL.sandDark), 0, 0.6, 0)), p.x, TOP, p.z));
    }

    // banner flag
    const fp = free(1, this.pr * 0.4, this.pr - 0.8)[0] || { x: 0, z: 0 };
    const flagMat = mat(data.kind === 'repo' ? 0xff5fa2 : 0xffc53d, { unique: true });
    this.flag = at(box(0.9, 0.55, 0.05, flagMat), 0.45, 2.3, 0);
    g.add(at(group(cyl(0.05, 0.05, 2.7, 5, PAL.white), this.flag), fp.x, TOP, fp.z));

    // name tag above the island center; the labels layer stacks it above the island's session labels
    this.label = this.engine.labels.add({ object: g, offset: V3(0, TOP + 5.5, 0), className: 'lbl-island', target: { type: 'island', id: data.id }, html: islandHtml(data), stack: { group: 'island:' + data.id, role: 'head' } });
  }

  allocLot(key, { annex } = {}) {
    if (this.lots.has(key)) return this.lots.get(key);
    let lot;
    if (annex) lot = this.annexLot(annex);
    if (!lot) {
      const used = new Set([...this.lots.values()].map((l) => l.slot));
      const i = this.slots.findIndex((_, k) => !used.has(k));
      if (i >= 0) {
        const s = this.slots[i];
        lot = { position: V3(this.center.x + s.x, TOP, this.center.z + s.z), facing: Math.PI / 4, size: 5, annex: null, slot: i };
      } else lot = this.platformLot();
    }
    this.lots.set(key, lot);
    return lot;
  }

  // Expansion platform: a metal pad on stilts over the water, joined by a walkway.
  platformLot() {
    const k = this.platforms.length, a = -Math.PI / 4 + (k % 2 ? 1 : -1) * (0.7 + Math.floor(k / 2) * 0.75);
    const d = this.radius + 3.2, x = Math.cos(a) * d, z = Math.sin(a) * d;
    const p = group(box(5.4, 0.3, 5.4, PAL.metal), at(box(5.6, 0.12, 0.25, PAL.hazard), 0, 0.3, 2.6), at(box(5.6, 0.12, 0.25, PAL.hazard), 0, 0.3, -2.6));
    for (const [sx, sz] of [[-2.2, -2.2], [2.2, -2.2], [-2.2, 2.2], [2.2, 2.2]]) p.add(at(cyl(0.18, 0.18, TOP + 1.2, 6, PAL.metalDark), sx, -TOP - 1.2, sz));
    p.position.set(x, TOP - 0.3, z);
    const walk = at(box(1.4, 0.18, d - this.pr + 1, PAL.wood), Math.cos(a) * (this.pr + d) / 2, TOP - 0.2, Math.sin(a) * (this.pr + d) / 2, { ry: Math.PI / 2 - a });
    this.group.add(p, walk);
    this.platforms.push(p, walk);
    return { position: V3(this.center.x + x, TOP, this.center.z + z), facing: Math.PI / 4, size: 5, annex: null, slot: -1 };
  }

  annexLot(id) {
    let A = this.annexes.get(id);
    if (!A) {
      const k = this.annexes.size, a = Math.PI * 0.75 + k * 1.1, d = this.radius + 7.5;
      const x = Math.cos(a) * d, z = Math.sin(a) * d;
      const islet = group(at(cyl(4.0, 4.2, 0.9, 12, PAL.sand), 0, -0.4, 0), at(cyl(3.2, 3.4, TOP, 12, PAL.cliff), 0, 0, 0), at(cyl(3.3, 3.2, 0.3, 12, PAL.grass), 0, TOP - 0.3, 0));
      islet.position.set(x, 0, z);
      const bridge = at(box(1.1, 0.14, d - this.pr - 3.0, PAL.wood), Math.cos(a) * (this.pr + d - 3.2) / 2, TOP - 0.15, Math.sin(a) * (this.pr + d - 3.2) / 2, { ry: Math.PI / 2 - a });
      this.group.add(islet, bridge);
      A = { x, z, used: 0, foam: this.engine.addFoamRing({ x: this.center.x + x, z: this.center.z + z }, 4.1) };
      A.label = this.engine.labels.add({ object: islet, offset: V3(0, TOP + 2.6, 0), className: 'lbl-island minor', kind: 'island', priority: 35, stack: { group: 'annex:' + id, role: 'head' }, html: `<div class="lbl-card"><div class="l1"><span class="name">⎇ ${esc(annexName(this.data, id))}</span></div></div>` });
      this.annexes.set(id, A);
    }
    if (A.used++ > 0) return null;
    return { position: V3(this.center.x + A.x, TOP, this.center.z + A.z), facing: Math.PI / 4, size: 5, annex: id, slot: -1 };
  }

  releaseLot(key) { this.lots.delete(key); }

  allocDock(id, { container } = {}) {
    if (this.docks.has(id)) return this.docks.get(id);
    const n = this.docks.size, base = rng(this.data.id + 'docks')() * Math.PI * 2;
    const a = base + (n % 10) * (Math.PI * 2 / 10) + Math.floor(n / 10) * 0.31;
    const dir = V3(Math.cos(a), 0, Math.sin(a));
    const root = pier(this.radius, a, container);
    this.group.add(root);
    const far = this.radius + (container ? 6.6 : 5.2) + Math.floor(n / 10) * 2.5;
    const dock = { root, berth: V3(this.center.x + dir.x * far, 0, this.center.z + dir.z * far), dir, facing: Math.atan2(dir.x, dir.z) };
    this.docks.set(id, dock);
    return dock;
  }

  releaseDock(id) {
    const d = this.docks.get(id);
    if (!d) return;
    this.docks.delete(id);
    disposeTree(d.root);
  }

  randomPoint(r = Math.random) {
    const a = r() * Math.PI * 2, d = Math.sqrt(r()) * this.pr * 0.85;
    return V3(this.center.x + Math.cos(a) * d, TOP, this.center.z + Math.sin(a) * d);
  }

  walkable(p) { return Math.hypot(p.x - this.center.x, p.z - this.center.z) <= this.pr * 0.95; }

  update(data) {
    this.data = data;
    this.label.set(islandHtml(data));
  }

  launch(kind, text) {
    const fx = this.engine.fx, pad = this.stations.launchPad.clone();
    const msg = trunc(String(text || ''), 48);
    if (kind === 'commit') {
      const rocket = group(cyl(0.22, 0.3, 1.1, 6, PAL.white), at(cone(0.24, 0.5, 6, PAL.danger), 0, 1.1, 0), at(box(0.7, 0.3, 0.08, PAL.danger), 0, 0.1, 0));
      rocket.position.copy(pad);
      this.engine.root.add(rocket);
      const trail = fx.trail(rocket, { kind: 'smoke', color: 0xdddddd, rate: 30, size: 0.15 });
      fx.puff(pad, { count: 12, spread: 1.4 });
      tween(rocket.position, { y: pad.y + 16 }, 1.6, ease.inQuad).then(() => {
        trail.stop();
        fx.confetti(rocket.position, { count: 50 });
        fx.sparks(rocket.position, 0xffd66b, { count: 24, speed: 7 });
        fx.text(rocket.position, msg || 'Launch!', { color: '#ffe38a', size: 0.9, secs: 2.6 });
        disposeTree(rocket);
      });
    } else if (kind === 'pull') {
      const crate = group(box(0.8, 0.8, 0.8, PAL.wood), at(cone(0.9, 0.5, 6, PAL.white), 0, 1.9, 0), at(cyl(0.02, 0.02, 1.2, 3, PAL.white), 0, 0.8, 0));
      crate.position.copy(pad).setY(pad.y + 12);
      this.engine.root.add(crate);
      tween(crate.position, { y: pad.y }, 2.4, ease.outCubic).then(() => {
        fx.puff(pad, { count: 10 });
        fx.text(pad, 'Supply drop!', { color: '#9be22d', size: 0.8 });
        wait(3).then(() => disposeTree(crate));
      });
    } else if (kind === 'merge') {
      const at = this.stations.gitTree.clone().add(V3(0, 2, 0));
      fx.ring(this.stations.gitTree, 0xe86bff, { radius: 4, secs: 1.2 });
      fx.sparks(at, 0xe86bff, { count: 24, speed: 5 });
      fx.flash(at, { color: 0xf3c2ff, size: 3 });
      fx.text(at, `⑂ ${msg}`, { color: '#f0a8ff', size: 0.85, secs: 2.4 });
    } else if (kind === 'push') {
      const crate = group(box(0.8, 0.6, 0.8, PAL.wood), at(ico(0.75, 0, PAL.hazard), 0, 1.5, 0));
      crate.position.copy(pad);
      this.engine.root.add(crate);
      const trail = fx.trail(crate, { kind: 'smoke', color: 0xeeeeee, rate: 22, size: 0.12 });
      const away = pad.clone().add(V3(-18, 16, -18));
      fx.text(pad.clone().add(V3(0, 2.5, 0)), `⇪ ${msg}`, { color: '#ffe38a', size: 0.85, secs: 2.4 });
      tween(crate.position, { x: away.x, y: away.y, z: away.z }, 2.6, ease.inQuad).then(() => { trail.stop(); disposeTree(crate); });
    } else if (kind === 'checkout') {
      tween(this.flag.scale, { y: 0.01 }, 0.5, ease.inCubic).then(() => {
        this.flag.material.color.setHSL(Math.random(), 0.7, 0.6);
        return tween(this.flag.scale, { y: 1 }, 0.7, ease.outBack);
      });
      fx.text(this.stations.gitTree, `⚑ ${msg}`, { color: '#39e5ff', size: 0.85, secs: 2.4 });
    }
  }

  tick(dt, t) { if (this.flag) this.flag.rotation.y = Math.sin(t * 2.2 + this.radius) * 0.25 * (0.5 + this.engine.wind); }

  dispose() {
    this.label.remove();
    for (const A of this.annexes.values()) { A.label.remove(); A.foam.remove(); }
    disposeTree(this.group);
  }
}

function islandHtml(d) {
  const branch = d.git?.branch ? `<div class="l2 detail"><span class="branch">⎇ ${esc(trunc(d.git.branch, 26))}</span></div>` : '';
  return `<div class="lbl-card"><div class="l1"><span class="name">${esc(trunc(d.name, 26))}</span></div>${branch}</div>`;
}

function annexName(d, id) { return d.annexes?.find((a) => a.id === id)?.name || 'worktree'; }

// Lot centers (5x5 lots) that fit on a plateau of radius pr: best of a few grid offsets, rotated by `rot`.
function layoutSlots(pr, rot) {
  const S = 5.4;
  let best = [];
  for (const [ox, oz] of [[0, 0], [S / 2, 0], [S / 2, S / 2]]) {
    const list = [];
    for (let i = -4; i <= 4; i++) for (let j = -4; j <= 4; j++) {
      const x = i * S + ox, z = j * S + oz;
      if (Math.hypot(Math.abs(x) + 2.2, Math.abs(z) + 2.2) <= pr + 0.5) list.push({ x, z });
    }
    if (list.length > best.length) best = list;
  }
  const c = Math.cos(rot * 0.25), s = Math.sin(rot * 0.25);
  return best.map((p) => ({ x: p.x * c - p.z * s, z: p.x * s + p.z * c })).sort((a, b) => Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z));
}

function crystalCluster(x, z, R) {
  const g = new THREE.Group();
  const m = glow(PAL.crystal, 0.75);
  for (let i = 0; i < 4; i++) {
    const h = 0.7 + R() * 0.8;
    const c = cone(0.22 + R() * 0.12, h, 5, m);
    c.position.set((R() - 0.5) * 0.7, 0, (R() - 0.5) * 0.7);
    c.rotation.set((R() - 0.5) * 0.5, R() * 3, (R() - 0.5) * 0.5);
    g.add(c);
  }
  g.position.set(x, TOP, z);
  return g;
}

function campfire(p) {
  const g = group(at(cone(0.35, 0.6, 5, glow(0xff8a1f, 1.2)), 0, 0.05, 0));
  for (let i = 0; i < 3; i++) g.add(at(box(0.9, 0.12, 0.12, PAL.woodDark), 0, 0.06, 0, { ry: (i * Math.PI) / 3 }));
  g.position.set(p.x, TOP, p.z);
  return g;
}

function pier(r, a, container) {
  const g = new THREE.Group();
  const len = container ? 5.6 : 4.4, w = container ? 1.8 : 1.2;
  const deck = box(w, 0.16, len, PAL.wood);
  deck.position.set(0, 0.42, r - 0.8 + len / 2);
  g.add(deck);
  for (let i = 0; i < 3; i++) {
    const z = r - 0.2 + (i + 1) * (len / 3.2);
    g.add(at(cyl(0.1, 0.1, 1.5, 5, PAL.woodDark), -w / 2, -0.9, z), at(cyl(0.1, 0.1, 1.5, 5, PAL.woodDark), w / 2, -0.9, z));
  }
  g.rotation.y = Math.PI / 2 - a;
  return g;
}

class PlaceholderTown {
  constructor(world, { position }) {
    this.world = world;
    this.engine = world.engine;
    this.radius = 8.6;
    this.top = 1.1;
    this.center = (position || V3()).clone();
    const g = this.group = new THREE.Group();
    g.name = 'Port Localhost';
    g.position.copy(this.center);
    const T = this.top;
    g.add(at(meshOf(jitter(new THREE.CylinderGeometry(8.6, 9.2, 1.4, 10), 0.2, 7, true), PAL.rock), 0, -0.5, 0));
    g.add(at(cyl(8.1, 8.3, 0.3, 10, PAL.wood), 0, T - 0.3, 0));
    g.add(at(box(6, 0.1, 4.2, 0x8d97a8), 3.3, T, 1.4));                                           // container yard
    const cols = [0xff4d4d, 0x1fb5e8, 0xffc53d, 0x9be22d, 0xff8a1f];
    for (let i = 0; i < 5; i++) g.add(at(box(1.6, 0.8, 0.8, cols[i]), 2.2 + (i % 3) * 1.7, T + 0.1 + Math.floor(i / 3) * 0.8, 0.6 + (i % 2) * 0.9));
    this.crane = group(at(box(0.3, 3.2, 0.3, PAL.hazard), -1.6, 0, 0), at(box(0.3, 3.2, 0.3, PAL.hazard), 1.6, 0, 0), at(box(3.8, 0.35, 0.45, PAL.hazard), 0, 3.2, 0), at(box(0.5, 0.4, 0.6, PAL.metalDark), 0, 2.8, 0));
    this.crane.position.set(3.4, T, 2.8);
    g.add(this.crane);
    g.add(at(group(box(2.2, 1.5, 1.8, PAL.wood), at(cone(1.7, 0.9, 4, 0xd94f45), 0, 1.5, 0, { ry: Math.PI / 4 }), at(box(0.5, 0.5, 0.06, glow(PAL.window, 0.9)), 0.5, 0.8, 0.92)), -3.4, T, 2.6));

    // lighthouse: this dashboard
    const lh = this.lighthouse = new THREE.Group();
    lh.add(cyl(1.25, 1.45, 0.8, 10, PAL.white));
    for (let i = 0; i < 5; i++) lh.add(at(cyl(1.0 - i * 0.08, 1.08 - i * 0.08, 1.0, 10, i % 2 ? PAL.white : 0xe0453c), 0, 0.8 + i, 0));
    lh.add(at(cyl(0.95, 0.95, 0.18, 10, PAL.metalDark), 0, 5.8, 0));
    this.lampMat = glow(0xfff1a8, 1.6, { unique: true });
    lh.add(at(sphere(0.5, this.lampMat), 0, 6.45, 0), at(cone(0.75, 0.8, 10, 0xe0453c), 0, 6.95, 0));
    const beamMat = new THREE.MeshBasicMaterial({ color: 0xffe9a0, transparent: true, opacity: 0.1, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false });
    const beamGeo = new THREE.ConeGeometry(1.3, 13, 12, 1, true);
    beamGeo.translate(0, -6.5, 0);
    beamGeo.rotateZ(Math.PI / 2);
    this.beam = new THREE.Mesh(beamGeo, beamMat);
    this.beam.position.y = 6.45;
    this.beam.userData.noPick = true;
    lh.add(this.beam);
    lh.position.set(-3.2, T, -3.2);
    g.add(lh);

    this.docks = new Map();
    this.stations = { crystals: [], archive: V3(-3.4, T, 2.6), shore: [V3(5, T, -5), V3(-6, T, 3), V3(6, T, 4)], gitTree: V3(0, T, 0), launchPad: V3(0, T, 0) };
    this.label = null;
  }

  allocDock(id, { container } = {}) {
    if (this.docks.has(id)) return this.docks.get(id);
    const used = new Set([...this.docks.values()].map((d) => d.slot));
    // container ships moor off the terminal (+x side), everyone else around the rest of the harbor
    const slots = container ? [0.35, -0.25, 0.95, -0.85, 1.55, -1.45, 2.1, -2.0] : [2.6, 3.2, 3.8, 4.4, 5.0, 2.0, 5.6, 1.4];
    let slot = slots.find((s) => !used.has(s));
    if (slot == null) slot = 100 + this.docks.size;
    const ring = slot >= 100 ? 1 : 0, a = slot >= 100 ? (slot - 100) * 0.7 : slot;
    const dir = V3(Math.cos(a), 0, Math.sin(a));
    const root = pier(this.radius, a, container);
    this.group.add(root);
    const far = this.radius + (container ? 6.6 : 5.2) + ring * 6;
    const dock = { root, slot, berth: V3(this.center.x + dir.x * far, 0, this.center.z + dir.z * far), dir, facing: Math.atan2(dir.x, dir.z) };
    this.docks.set(id, dock);
    return dock;
  }

  releaseDock(id) {
    const d = this.docks.get(id);
    if (!d) return;
    this.docks.delete(id);
    disposeTree(d.root);
  }

  randomPoint(r = Math.random) {
    const a = r() * Math.PI * 2, d = Math.sqrt(r()) * 6;
    return V3(this.center.x + Math.cos(a) * d, this.top, this.center.z + Math.sin(a) * d);
  }

  walkable(p) { return Math.hypot(p.x - this.center.x, p.z - this.center.z) <= 7.5; }

  setLighthouse(port) {
    const html = `<div class="lbl-card lbl-lighthouse"><div class="l1"><span class="name">Command &amp; Context</span><b class="st st-port">:${esc(port.port)}</b></div></div>`;
    if (!this.label) this.label = this.engine.labels.add({ object: this.lighthouse, offset: V3(0, 8.4, 0), className: 'lbl-town', kind: 'island', html, target: { type: 'port', id: port.id } });
    else this.label.set(html);
    this.conns = port.conns || 0;
  }

  tick(dt, t) {
    this.beam.rotation.y = t * 0.9;
    this.beam.material.opacity = (0.02 + 0.3 * (1 - this.engine.daylight)) * (this.conns ? 1.3 : 1);
    this.lampMat.emissiveIntensity = (1.4 + Math.sin(t * 3) * 0.3) * this.engine.nightBoost;
    this.crane.position.x = 3.4 + Math.sin(t * 0.4) * 0.8;
  }

  dispose() { this.label?.remove(); disposeTree(this.group); }
}

class PlaceholderBuilding {
  constructor(world, s, lot, island, { instant }) {
    this.world = world;
    this.engine = world.engine;
    this.key = s.key;
    this.faction = s.faction || 'merc';
    this.session = s;
    this.island = island;
    const P = this.P = factionPal(this.faction);
    const g = this.group = new THREE.Group();
    g.name = 'building:' + s.key;
    g.position.copy(lot.position);
    g.rotation.y = lot.facing ?? Math.PI / 4;

    const core = this.core = new THREE.Group();
    core.add(box(3.0, 2.2, 3.0, P.main));
    core.add(at(box(3.3, 0.32, 3.3, P.trim), 0, 2.2, 0));
    core.add(at(cone(1.75, 1.2, 4, P.dark), 0, 2.52, 0, { ry: Math.PI / 4 }));
    core.add(at(box(0.9, 1.3, 0.12, P.dark), 0, 0, 1.52));
    this.winMat = glow(PAL.window, 0.9, { unique: true });
    for (const x of [-0.95, 0.95]) core.add(at(box(0.55, 0.5, 0.08, this.winMat), x, 1.25, 1.52));
    core.add(at(box(0.08, 0.5, 0.55, this.winMat), 1.52, 1.25, 0));
    this.beaconMat = glow(P.glow, 1.2, { unique: true });
    this.beacon = at(sphere(0.24, this.beaconMat), 0, 4.0, 0);
    core.add(at(cyl(0.05, 0.05, 0.5, 4, PAL.metalDark), 0, 3.6, 0), this.beacon);
    g.add(core);

    // context silo: glass tank + fill
    this.silo = new THREE.Group();
    this.silo.add(cyl(0.62, 0.62, 2.4, 10, mat(0xd8f6ff, { opacity: 0.35, transparent: true, depthWrite: false }), { cast: false }));
    this.fillMat = glow(0x39e5ff, 0.5, { unique: true });
    this.fill = cyl(0.52, 0.52, 2.3, 10, this.fillMat);
    this.silo.add(this.fill, at(cyl(0.68, 0.68, 0.14, 10, PAL.metalDark), 0, 2.4, 0));
    this.silo.position.set(-2.15, 0, 0.6);
    g.add(this.silo);

    // big bouncing "!" for needs_input
    const bang = glow(0xffd23f, 1.4);
    this.alert = group(at(box(0.36, 1.0, 0.36, bang), 0, 0.5, 0), at(box(0.36, 0.34, 0.36, bang), 0, -0.1, 0));
    this.alert.position.y = 5.6;
    this.alert.visible = false;
    g.add(this.alert);

    this.label = this.engine.labels.add({ object: g, offset: V3(0, 4.9, 0), className: 'lbl-session', target: { type: 'session', id: s.key }, html: sessionLabel(s), stack: { group: s.annex ? ['annex:' + s.annex, 'island:' + s.island] : 'island:' + s.island, role: 'member' } });
    this.smokeT = 0;
    this.applyState(s);
    if (!instant) {
      g.scale.set(1, 0.01, 1);
      tween(g.scale, { y: 1 }, 0.9, ease.outBack);
      this.engine.fx.puff(lot.position, { count: 16, spread: 2.2, size: 0.9 });
    }
  }

  get door() { return local(this.group, 0, 0, 2.1); }
  get roof() { return local(this.group, 0, 3.2, 0); }
  get lunch() { return { table: local(this.group, 2.3, 0, 1.8), seats: [local(this.group, 2.3, 0, 2.6), local(this.group, 2.3, 0, 1.0), local(this.group, 3.1, 0, 1.8)] }; }

  workSpot(cat) {
    const st = this.island?.stations;
    if (cat === 'bash' && st?.crystals?.length) return st.crystals[0].clone();
    if (cat === 'read' && st?.archive) return st.archive.clone();
    if (cat === 'web' && st?.shore?.length) return st.shore[0].clone();
    const o = { edit: [-1.6, 2.2], search: [1.8, -1.8], agent: [0, 2.6], mcp: [1.9, 1.2], plan: [-1.2, 2.4], skill: [1.2, 2.4] }[cat] || [0.8, 2.4];
    return local(this.group, o[0], 0, o[1]);
  }

  applyState(s) {
    const st = s.state;
    this.alert.visible = st === 'needs_input';
    const c = { working: 0x3ddc84, thinking: 0xb68cff, waiting: 0xffc53d, needs_input: 0xffd23f, idle: 0xffb36b, asleep: 0x445080, ended: 0x333333 }[st] ?? this.P.glow;
    this.beaconMat.color.set(c);
    this.beaconMat.emissive.set(c);
    const dark = st === 'asleep' || st === 'ended';
    this.winMat.emissiveIntensity = dark ? 0.05 : 0.9;
    if (st === 'asleep' && !this.zzz) this.zzz = this.engine.fx.zzz(this.core, { offset: V3(0.6, 3.6, 0) });
    if (st !== 'asleep' && this.zzz) { this.zzz.stop(); this.zzz = null; }
    const ctx = s.context?.max ? clamp(s.context.used / s.context.max, 0, 1) : 0;
    this.fill.scale.y = Math.max(0.02, ctx);
    this.fillMat.color.set(ctx < 0.4 ? 0x39e5ff : ctx < 0.6 ? 0x3ddc84 : ctx < 0.75 ? 0xffd23f : ctx < 0.9 ? 0xff8a1f : 0xff4d4d);
    this.fillMat.emissive.copy(this.fillMat.color);
  }

  update(s) {
    this.session = s;
    this.label.set(sessionLabel(s));
    this.applyState(s);
  }

  tick(dt, t) {
    const st = this.session.state, boost = this.engine.nightBoost;
    this.alert.visible = st === 'needs_input' && !this.bigAlert;      // alerts.js flies a giant one instead
    if (this.alert.visible) {
      this.alert.position.y = 5.6 + Math.abs(Math.sin(t * 4)) * 0.6;
      this.alert.rotation.y += dt * 2.5;
    }
    const pulse = st === 'needs_input' ? 0.5 + 0.5 * Math.sin(t * 10) : st === 'working' ? 0.6 + 0.4 * Math.sin(t * 5) : st === 'thinking' ? 0.6 + 0.4 * Math.sin(t * 2) : 0.4;
    this.beaconMat.emissiveIntensity = (st === 'asleep' ? 0.15 : 0.4 + pulse * 1.4) * boost;
    if (st !== 'asleep' && st !== 'ended') this.winMat.emissiveIntensity = 0.9 * boost;
    if (st === 'working' && (this.smokeT -= dt) < 0) {
      this.smokeT = 1.1;
      this.engine.fx.smoke(this.roof.add(V3(0, 0.6, 0)), { count: 2, color: 0xe8e8ee, size: 0.45 });
    }
  }

  compaction(ev) {
    const fx = this.engine.fx, top = this.roof;
    fx.text(top.add(V3(0, 1.5, 0)), 'KA-CHUNK!', { color: '#ffd23f', size: 1.2 });
    tween(this.silo.scale, { y: 0.45, x: 1.35, z: 1.35 }, 0.18, ease.inQuad)
      .then(() => tween(this.silo.scale, { y: 1, x: 1, z: 1 }, 0.7, ease.outElastic));
    fx.puff(local(this.group, -2.15, 0.2, 0.6), { count: 10, spread: 1.2, color: 0xe8f6ff });
  }

  clear(ev) {
    const fx = this.engine.fx, base = this.group.position.clone();
    fx.flash(base.clone().add(V3(0, 1.4, 0)), { size: 4.5 });
    fx.debris(base, [this.P.main, this.P.trim, this.P.dark, PAL.metal], { count: 30, power: 1.1, floor: base.y });
    fx.puff(base, { count: 26, spread: 3.2, size: 1.3, life: 1.6 });
    fx.text(base.clone().add(V3(0, 4, 0)), 'CLEARED!', { color: '#ff5f5f', size: 1.4, secs: 2 });
    this.core.scale.set(1, 0.01, 1);
    this.silo.scale.set(1, 0.01, 1);
    wait(1.4).then(() => {
      tween(this.core.scale, { y: 1 }, 1.0, ease.outBack);
      tween(this.silo.scale, { y: 1 }, 1.0, ease.outBack);
      fx.puff(base, { count: 12, spread: 2 });
    });
  }

  async end() {
    this.label.set(sessionLabel({ ...this.session, state: 'ended' }));
    this.applyState({ ...this.session, state: 'ended' });
    const fx = this.engine.fx, base = this.group.position.clone();
    await wait(0.6);
    fx.puff(base, { count: 20, spread: 2.6, size: 1.2, life: 1.4 });
    await tween(this.group.position, { y: base.y - 3.6 }, 1.8, ease.inCubic);
  }

  dispose() {
    this.zzz?.stop();
    this.label.remove();
    disposeTree(this.group);
  }
}

const SPEED = { opus: 1.0, sonnet: 1.6, haiku: 2.3, fable: 1.4, merc: 1.5 };
const capsuleGeo = new THREE.CapsuleGeometry(0.22, 0.34, 3, 8);
capsuleGeo.userData.shared = true;

class PlaceholderUnit {
  constructor(world, { kind, data, building, island, instant, spawn, parent }) {
    this.world = world;
    this.engine = world.engine;
    this.kind = kind;
    this.data = data;
    this.building = building;
    this.island = island;
    this.parent = parent;
    this.id = kind === 'commander' ? 'cmd:' + data.key : data.id;
    const f = data.faction || 'merc', P = factionPal(f);
    this.speed = SPEED[f] ?? 1.5;
    this.r = rng(this.id);
    const g = this.group = new THREE.Group();
    g.name = 'unit:' + this.id;
    const body = meshOf(capsuleGeo, P.main);
    body.position.y = 0.4;
    const head = at(sphere(0.2, P.glow), 0, 0.86, 0);
    const eyes = group(at(box(0.05, 0.08, 0.04, PAL.black), -0.07, 0.9, 0.18), at(box(0.05, 0.08, 0.04, PAL.black), 0.07, 0.9, 0.18));
    this.body = group(body, head, eyes, at(box(0.46, 0.08, 0.3, P.trim), 0, 0.5, 0));
    if (kind === 'commander') {
      this.body.add(at(cyl(0.025, 0.025, 1.2, 4, PAL.metalDark), -0.2, 0.4, -0.18), at(box(0.42, 0.28, 0.03, P.trim), 0.02, 1.4, -0.18));
      this.body.scale.setScalar(1.25);
    }
    if ((data.depth || 1) > 1) this.body.scale.setScalar(0.7);
    g.add(this.body);
    const start = spawn || island.randomPoint(this.r);
    g.position.copy(start);
    this.goal = null;
    this.pause = this.r() * 1.5;
    this.phase = this.r() * 10;
    if (!instant) {
      this.body.scale.multiplyScalar(0.01);
      const s = kind === 'commander' ? 1.25 : (data.depth || 1) > 1 ? 0.7 : 1;
      tween(this.body.scale, { x: s, y: s, z: s }, 0.5, ease.outBack);
      this.engine.fx.sparks(start.clone().add(V3(0, 0.6, 0)), P.glow, { count: 10, speed: 3 });
    } else g.position.copy(this.chooseGoal() || island.randomPoint(this.r));
  }

  update(d) { this.data = d; }

  chooseGoal() {
    const d = this.data, st = d.state, cat = d.tool?.cat, b = this.building;
    if (this.kind === 'commander') {
      if (st === 'idle' || st === 'asleep') { const L = b.lunch; return L?.seats?.[0] || b.door; }
      if (st === 'needs_input') return b.door;
      if (st === 'working' && cat) return b.workSpot?.(cat) || null;
    } else if (this.parent?.group?.parent) {
      return this.parent.group.position.clone().add(V3((this.r() - 0.5) * 2, 0, (this.r() - 0.5) * 2));
    } else if (st === 'working' && cat) {
      const S = this.island.stations;
      if (cat === 'bash' && S?.crystals?.length) return S.crystals[Math.floor(this.r() * S.crystals.length)].clone().add(V3(0.9, 0, 0.3));
      if (cat === 'read' && S?.archive) return S.archive.clone().add(V3(1.1, 0, 0.4));
      if (cat === 'web' && S?.shore?.length) return S.shore[Math.floor(this.r() * S.shore.length)].clone();
      if (cat === 'edit') return b.workSpot?.('edit') || null;
    }
    return st === 'thinking' ? null : this.island.randomPoint(this.r);
  }

  tick(dt, t) {
    if (this.leaving) return;
    const p = this.group.position;
    if (!this.goal) {
      if ((this.pause -= dt) > 0) { this.body.position.y = Math.abs(Math.sin(t * 2 + this.phase)) * 0.03; return; }
      this.goal = this.chooseGoal();
      this.pause = 1 + this.r() * 2.5;
      if (!this.goal) return;
    }
    const dx = this.goal.x - p.x, dz = this.goal.z - p.z, dist = Math.hypot(dx, dz);
    if (dist < 0.15) { this.goal = null; return; }
    const step = Math.min(dist, this.speed * dt);
    p.x += (dx / dist) * step;
    p.z += (dz / dist) * step;
    p.y = lerp(p.y, this.goal.y ?? p.y, 0.1);
    this.group.rotation.y = Math.atan2(dx, dz);
    this.body.position.y = Math.abs(Math.sin(t * 9 + this.phase)) * 0.09;
  }

  async finish(status) {
    this.leaving = true;
    const fx = this.engine.fx, g = this.group, pos = g.position.clone();
    if (status === 'done') {
      fx.confetti(pos.clone().add(V3(0, 1, 0)), { count: 24, power: 0.7 });
      fx.text(pos.clone().add(V3(0, 1.6, 0)), '✓', { color: '#3ddc84', size: 1.1 });
      await tween(this.body.position, { y: 0.8 }, 0.25, ease.outQuad);
      await tween(this.body.position, { y: 0 }, 0.3, ease.outBounce);
      const door = vec(this.building?.door);
      if (door && this.building?.group?.parent) {
        const secs = Math.min(6, pos.distanceTo(door) / (this.speed * 1.4));
        g.rotation.y = Math.atan2(door.x - pos.x, door.z - pos.z);
        await tween(g.position, { x: door.x, y: door.y, z: door.z }, secs, ease.linear);
      }
      await tween(this.body.scale, { x: 0.01, y: 0.01, z: 0.01 }, 0.3, ease.inCubic);
    } else if (status === 'failed') {
      fx.smoke(pos.clone().add(V3(0, 1.2, 0)), { count: 5, color: 0x6a6f86, size: 0.5 });
      await tween(this.body.rotation, { x: 0.5 }, 0.6);
      await tween(this.body.scale, { x: 0.01, y: 0.01, z: 0.01 }, 1.2, ease.inCubic);
    } else {
      fx.smoke(pos.clone().add(V3(0, 0.5, 0)), { count: 8, size: 0.6 });
      await tween(this.body.scale, { x: 0.01, y: 0.01, z: 0.01 }, 0.25, ease.inCubic);
    }
  }

  dispose() { disposeTree(this.group); }
}

const HULL = { node: 0x5fa04e, bun: 0xf3e2c0, deno: 0x2a2a2a, python: 0x3776ab, php: 0x7a86b8, ruby: 0xcc342d, java: 0xc76f26, go: 0x00add8, dotnet: 0x7b44d1, web: 0x2f9e5b, ai: 0xf2f2f2, docker: 0x2566c9, db: 0x5a6478, browser: 0xffd23f };

class PlaceholderVessel {
  constructor(world, port, dock, { instant }) {
    this.world = world;
    this.engine = world.engine;
    this.port = port;
    this.dock = dock;
    const g = this.group = new THREE.Group();
    g.name = 'vessel:' + port.id;
    const hull = HULL[port.kind] ?? 0x9aa3b2, big = port.kind === 'docker', sub = port.kind === 'browser';
    const L = big ? 3.6 : 2.2, W = big ? 1.5 : 1.1;
    this.boat = new THREE.Group();
    if (sub) {
      this.boat.add(at(sphere(0.62, hull, { segments: 10, rings: 6 }), 0, 0.2, 0, { s: [1, 0.75, 1.8] }), at(cyl(0.28, 0.32, 0.5, 8, hull), 0, 0.72, 0.1), at(cyl(0.05, 0.05, 0.6, 4, PAL.metalDark), 0, 1.1, 0.25));
    } else {
      this.boat.add(at(box(W, 0.5, L, hull), 0, -0.1, 0), at(cyl(W * 0.58, W * 0.58, 0.5, 3, hull), 0, -0.1, L / 2 - W * 0.25), at(box(W + 0.06, 0.1, L, PAL.white), 0, 0.12, 0));
      if (big) {
        const cols = [0xff4d4d, 0xffc53d, 0x39e5ff, 0x9be22d, 0xff5fa2, 0xff8a1f];
        const n = Math.max(2, Math.min(6, (port.ports || []).length || 2));
        for (let i = 0; i < n; i++) this.boat.add(at(box(0.62, 0.5, 0.9, cols[i % cols.length]), (i % 2 ? 0.34 : -0.34), 0.2 + Math.floor(i / 4) * 0.5, -1.0 + Math.floor(i / 2) % 2 * 1.0));
        this.boat.add(at(box(W * 0.9, 0.8, 0.6, PAL.white), 0, 0.2, -L / 2 + 0.3));
      } else {
        this.boat.add(at(box(W * 0.7, 0.55, L * 0.4, PAL.white), 0, 0.2, -0.2), at(cyl(0.14, 0.16, 0.6, 6, 0x3b3f4d), 0, 0.75, -0.3));
      }
    }
    g.add(this.boat);
    g.position.copy(dock.berth);
    g.rotation.y = dock.facing ?? 0;
    this.phase = rng(port.id)() * 10;
    this.label = this.engine.labels.add({ object: g, offset: V3(0, 2.1, 0), className: 'lbl-port minor', target: { type: 'port', id: port.id }, html: portHtml(port) });
    if (!instant) {
      const from = dock.berth.clone().addScaledVector(dock.dir, 40);
      g.position.copy(from);
      this.wake = this.engine.fx.trail(g, { kind: 'wake', color: PAL.foam, rate: 16, size: 0.2 });
      tween(g.position, { x: dock.berth.x, z: dock.berth.z }, 3.5, ease.outCubic).then(() => this.wake?.stop());
    }
  }

  update(p) { this.port = p; this.label.set(portHtml(p)); }

  tick(dt, t) {
    const a = this.port.activity || 0;
    this.boat.position.y = Math.sin(t * 1.6 + this.phase) * (0.06 + a * 0.08) + (this.engine.wind * 0.04);
    this.boat.rotation.z = Math.sin(t * 1.1 + this.phase) * (0.04 + this.engine.wind * 0.05);
    if (a > 0.3 && Math.random() < dt * 1.5) this.engine.fx.smoke(this.group.position.clone().add(V3(0, 1.1, 0)), { count: 1, color: 0xeeeeee, size: 0.35 });
  }

  async depart() {
    this.label.setVisible(false);
    const g = this.group, to = g.position.clone().addScaledVector(this.dock.dir, 40);
    this.wake = this.engine.fx.trail(g, { kind: 'wake', color: PAL.foam, rate: 16, size: 0.2 });
    await tween(g.position, { x: to.x, z: to.z }, 3.5, ease.inCubic);
    this.wake.stop();
  }

  dispose() { this.wake?.stop(); this.label.remove(); disposeTree(this.group); }
}

function portHtml(p) {
  const repo = p.repo ? ` <span class="repo">${esc(p.repo)}</span>` : '';
  return `<div class="lbl-card"><div class="l1"><span class="name">${esc(trunc(p.label || p.kind, 14))}</span><b class="st st-port">:${esc(p.port)}</b>${repo}</div></div>`;
}
