# Command & Context — Design Spec

A local dashboard for a spare monitor that renders every running Claude Code session on this machine as a
**low-poly isometric RTS diorama**: cartoony and vibrant like a toy diorama, but with the chrome and swagger
of StarCraft / Command & Conquer. Repos are islands with sci-fi bases, sessions are buildings, sub-agents are
workers, listening ports are docks with stubby boats. Humor is encouraged everywhere.

This document is the contract between modules. **Read all of it before writing code.** If something here is
ambiguous, pick the most fun interpretation that keeps the dashboard readable at a glance from across a room.

---

## 1. Layout of the project

```
server/                 Node collector + HTTP/SSE server (done; do not modify unless told)
public/index.html       import map (three -> /vendor/three/build/three.module.js), HUD root, loads js/main.js
public/css/hud.css      HUD + label styles
public/js/main.js       bootstrap: engine + world + hud + data feed
public/js/net.js        live SSE feed (/api/stream) or demo feed (?demo)
public/js/demo.js       simulated world that emits snapshots in the exact server format
public/js/world/
  kit.js                palette, materials, low-poly geometry helpers, easing/tween utils, seeded random
  engine.js             renderer, iso camera + controls, lights, day/night, sky, sea, pick, labels, fx, frame loop
  fx.js                 particles & floating text (may live inside engine.js if small)
  labels.js             HTML overlay labels anchored to 3D objects
  world.js              snapshot diffing -> create/update/remove entities; island layout; event routing
  islands.js            Island (procedural island by kind/tier) + PortTown (central harbor hub)
  buildings.js          Building (one per session)
  units.js              Unit (one per sub-agent + one "commander" per session)
  harbor.js             Dock + Vessel (one per port / container), sea life
public/js/hud/
  hud.js                top bar, minimap, selection card, EVA log, settings, tooltips, keyboard
docs/DESIGN.md          this file
tools/shot.ps1          headless screenshot helper (see §12)
```

No build step. Plain ES modules, modern JS (classes, optional chaining, etc.). The only dependency is `three`
(r186) via the import map (`import * as THREE from 'three'`; addons via `three/addons/...` mapped to
`/vendor/three/examples/jsm/...`). Do not add other libraries. Google Fonts via `<link>` is fine.

---

## 2. Data: the world snapshot

`GET /api/stream` is Server-Sent Events; every message's `data` is a full snapshot (about once a second while
something changes, at least every 5 s). `GET /api/state` returns the latest snapshot once. Demo mode produces
the same shape client-side. Times are epoch **milliseconds** from the server clock; the client should compute
`serverOffset = snap.now - Date.now()` and use `Date.now() + serverOffset` for ages.

```js
{
  v: 1, now, host,
  server:   { port, pid, startedAt, platform, cores, registry: bool, probe: bool, docker: bool|null },
  system:   { cpu: 0..1|null, mem: 0..1|null },            // whole-machine load (weather!)
  settings: { asleepAfterMin, hideAfterHours },
  islands:  [Island], sessions: [Session], ports: [Port], events: [Event]   // events: last 60, ascending id
}

Island = {
  id,                 // normalized root path, e.g. "c:/storefront-nuxt" (stable key)
  name,               // "storefront-nuxt", "Downloads", "Sandbox 437cc3", "Homestead"
  kind,               // 'repo' | 'camp' (not a git repo) | 'sandbox' (Claude scratch workspace) | 'home'
  root,               // display path
  tier,               // 0 (camp/sandbox/home) | 1 (<150 files) | 2 (<1500) | 3 (<6000) | 4 (huge)
  git: { files, commits, branches, langs: ['TypeScript','Vue'], branch, status } | { branch, status } | null,
  annexes: [{ id, name, branch, status }],   // git worktrees with sessions in them -> small islets joined by a bridge
  sessions            // count of visible sessions on it
}
// status (repo root, or the annex's own work tree): null until the first poll, then
//   { dirty, staged, untracked, conflicts, ahead, behind, stash, op, at }
// dirty = paths with any uncommitted change (staged, unstaged, conflicted or untracked); staged = paths
// with index changes; untracked = null when the repo is too slow to scan them (> 3 s: then polled once a
// minute, backing off to every 10 minutes while it keeps timing out); ahead/behind = commits vs the
// upstream, null without one; stash = stash entries (shared by worktrees); op = 'merge' | 'rebase' |
// 'cherry-pick' | 'revert' | 'bisect' | null (stopped half-way);
// at = when polled (about every 15 s). Read-only `git status`: it never takes the index lock.

Session = {                          // one building
  key,                // stable building id (survives /clear); use this, not sessionId, as the entity key
  sessionId,          // CHANGES on /clear
  pid, name,          // name = session title, e.g. "Local session dashboard diorama"
  island, annex,      // island id; annex id or null (session runs in a worktree)
  cwd, entrypoint,    // entrypoint: 'claude-desktop' | 'cli' | 'sdk-ts' | ...
  kind, permissionMode,
  model, modelLabel,  // "claude-opus-5-5", "Opus 5.5"
  faction,            // 'opus' | 'sonnet' | 'haiku' | 'fable' | 'merc'   (drives art style)
  state,              // 'working' | 'thinking' | 'waiting' | 'needs_input' | 'idle' | 'asleep' | 'ended'
  stateSince,
  tool,               // current tool while working/waiting/needs_input: { name, cat, detail, since } | null
  lastTool,           // { name, cat, detail, at } | null
  lastActivity, startedAt, endedAt,
  lastPrompt,         // user's last prompt (truncated) or null. Only show in the selection card.
  branch,
  context: { used, max },            // tokens in the context window right now, and the window size
  compactions,        // count; increments on compaction (also an event)
  lastCompaction: { at, pre, post, trigger } | null,
  clears,             // count of /clear seen by the server for this building
  tools: { edit, bash, read, search, web, agent, mcp, plan, skill, other },  // tool-use counts this session
  toolTotal, cost: { usd, added, removed } | null,
  agentsDone,         // sub-agents that finished in this session (veterancy)
  agents: [Agent],    // running ones plus recently finished ones (finished stay listed ~20 min)
  procs: [{ pid, name, cmd, cpu, since }],   // meaningful child processes (cpu = cores busy, 0..n)
  ports: [portId]     // ports owned via the process tree
}

Agent = {                            // one worker
  id, type,           // type = agentType: 'general-purpose','Explore','Plan','review-skeptical','claude',...
  description,        // "Wiring review: invoice export"
  model, modelLabel, faction,
  state,              // 'working' | 'thinking' | 'waiting' | 'stalled' | 'done' | 'failed' | 'lost'
  stateSince,
  tool,               // { name, cat, detail, since } | null
  startedAt, lastActivity, endedAt,
  depth,              // 1, or 2 for an agent spawned by an agent
  parent,             // parent agent id when depth 2, else null
  background, context, tools
}

Port = {                             // one vessel
  id,                 // "3000" or "ctr:<container name>" (stable key)
  port, ports,        // primary port and all ports (containers can publish several)
  addrs, pid, proc,   // proc = executable name
  kind,               // 'node'|'bun'|'deno'|'python'|'php'|'ruby'|'java'|'dotnet'|'go'|'web'|'db'|'docker'|
                      // 'browser'|'ai'|'lighthouse'|'app'|'system'|'claude'
  label,              // "Nuxt", "Vite", "pgsql", "Headless browser", "serve.js"
  cmd, cwd,
  owner,              // session key that owns the process tree, or null
  container: { name, image, project, status } | null,
  activity,           // 0..1 right now (CPU of the process tree / new connections)
  conns,              // established client connections
  lastActive, since, restarts, cpu,
  island,             // island id to dock at, or null => dock at Port Localhost (central hub)
  repo,               // repo name when the server runs inside a repo that has no session (label it)
  adrift              // nobody is tending it, or null:
                      // { since, reason: 'owner-ended' | 'orphaned', lastOwner: { key, name, guess } | null }
}
// kind 'lighthouse' is this dashboard's own port: render it as the lighthouse at Port Localhost.
// adrift: the server remembers each port's last owner. 'owner-ended' = no owner now and that session has
// ended (lastOwner is set; guess: true when the owner was inferred, see below). 'orphaned' = a dev server
// (node/bun/deno/python/php/ruby/java/dotnet/go/web) with a known cwd whose chain of launchers (shells, npm,
// runtimes) ends at an exited process, with no live session older than it whose folder contains its cwd,
// and with evidence that a session left it behind: a Claude Code session that is no longer running, whose
// folder is the server's cwd or contains it (a drive root or the home folder only counts as the cwd itself),
// and whose transcript was being written when the server process was created (first entry <= creation <=
// last write; for a server created while this dashboard was already running, one of the spans it saw that
// session live must cover the creation instead, since a resumed transcript also spans days it was not
// running). lastOwner = that session { key: its building key while it lingers, else null, name: its title
// or folder (never a prompt), guess: true }. Without such a session the server is the user's own (started
// with `start`, Start-Process, pm2, a daemon, ...) and not adrift. If a live session older than the server
// (by its process start: recorded creation time, else registry startedAt; not its transcript, which for a
// resumed session begins days earlier) sits in its folder, that session becomes the guessed lastOwner
// instead. Raised after two consecutive probes,
// lowered after two (or at once when an owner appears); `since` stays fixed while adrift. When another
// process with no owner takes the port over, the remembered owner and the flag are dropped at once (it is
// a new server), unless it was created before that owner's session ended (then it plausibly belongs to
// it, e.g. a watcher restarting its child). Never the
// lighthouse, nor the user's own dashboard seen from another instance (this repo's server/index.js on
// port 7420 or started with --app; other instances, e.g. a test server on 74xx, are ordinary node
// servers). A port a session once owned stays listed after it loses its owner, whatever its kind.

Event = { id, t, type, ...payload }
  session_start {key,name,cwd}   session_end {key,name}        clear {key,name,from,to}
  compaction {key,name,pre,post,trigger}   context_high {key,name,pct}
  agent_spawn / agent_done / agent_failed {key,agent,agentType,description}
  needs_input {key,name,detail}  asleep {key,name}   wake {key,name}
  turn_done {key,name,secs,agentsRunning}   (main agent finished a turn of >= 4 s and handed control back to the user)
  port_open {port,portId}   port_close {port,portId,label}   (portId = the Port.id of the vessel)
  port_adrift {port,portId,label,reason,lastOwner}   (once per drift; not for strays already adrift at startup)
  commit {island,annex,name,msg,author,hash,branch}   pull {island,annex,name,msg,hash,branch}
  checkout {island,annex,name,from,to,branch}
  merge {island,annex,name,msg,from,hash,branch}   (new local merge commit; from = merged branch if parsable)
  push {island,annex,name,remote,branch,hash,count,newBranch}   (remote-tracking ref caught up with HEAD)
  conflict {island,annex,name,count}   (a work tree's conflicted paths went from 0 to count; not on its first poll)
  pr {key,island,annex,name,number,url,action,repo}   (a session, or one of its sub-agents, touched a pull request:
      once per session and (repo, number, action), so a PR created and then merged in one session sends both;
      'edited' and 'linked' only as a PR's first news in that session (later edits are quiet), 'linked' after
      it has stood 2 s; never for what a transcript already says when first read (startup, /clear), though a
      later action on such a PR is news; name = session name; action = the latest 'created'|'merged'|
      'edited'|... from the shell results, else 'linked'; url = http(s) link or null; repo = "owner/name" or null)
```

Tool categories (`tool.cat`): `edit` (Edit/Write), `bash` (Bash/PowerShell), `read`, `search` (Grep/Glob),
`web` (WebFetch/WebSearch/browser MCP), `agent` (spawning/messaging agents), `mcp` (other MCP tools),
`plan` (todos, plan mode, questions), `skill`, `other`.

**Rules for animation triggers**
- The first snapshot after page load (or after a reconnect gap > 30 s) *materializes* the world with no
  per-entity entrance animations (a quick global intro pop is fine). Only later diffs animate.
- Persistent visuals come from **state** (what exists, its `state`, counts).
- One-shot effects come from **events** with an `id` greater than the highest id already seen:
  `clear` (demolition + rebuild), `compaction` (press), `commit` (rocket launch), `pull` (supply drop),
  `checkout` (flag swap), plus the EVA log. Never replay events that were already in the first snapshot.
- If an entity disappears from `sessions`/`agents`/`ports` without a terminal state, still animate it away.

---

## 3. World conventions

- Y is up. 1 unit ≈ 1 m. Sea level y = 0. Island plateau top y ≈ 1.2–2.0 (flat, walkable).
- Worker ≈ 0.7–0.9 tall. HQ building ≈ 2.2–3.6 tall on a ~3.2×3.2 footprint; a building "lot" is ~5×5.
- Orthographic camera at a classic RTS isometric angle (elevation ≈ 35°, azimuth 45°; Q/E rotate 90°).
- Central hub **Port Localhost** sits at the origin. Islands are laid out around it on a loose spiral
  (golden angle), sized by tier and building count, with ≥ 6 units of water between shores. Positions are
  stable: persisted in `localStorage` by island id; new islands take the next free spot.
- Water: large low-poly plane with gentle vertex waves; foam rings around islands.

---

## 4. Engine API (engine.js / world.js) — what other modules can rely on

```js
// kit.js
export const PAL      // named colors (see §5), faction palettes: PAL.faction.opus = { main, trim, glow, dark }
export function mat(color, opts)          // cached flat-shaded MeshLambertMaterial (opts.emissive etc.)
export function box(w,h,d,color,opts) / cyl(rt,rb,h,seg,color,opts) / cone(r,h,seg,color,opts) /
       ico(r,detail,color,opts) / sphere(r,color,opts)       // return THREE.Mesh, castShadow/receiveShadow set
export function group(...children)        // THREE.Group helper
export function jitter(geometry, amount, seed)   // low-poly vertex noise
export function rng(seed)                 // seeded PRNG: rng('c:/storefront-nuxt')() -> 0..1
export const ease = { outBack, outElastic, inOut, outCubic, ... }
export function tween(obj, props, dur, easeFn) -> Promise  // driven by the engine clock

// engine.js
engine = {
  THREE, renderer, scene, camera,
  root,                           // THREE.Group: parent for all world content
  time,                           // seconds since start (engine clock)
  onFrame(fn(dt, t)) -> off()     // per-frame callbacks (dt clamped to <= 0.1)
  serverNow() -> ms               // Date.now() + serverOffset
  daylight,                       // 0 night .. 1 day (follows the local clock unless settings say otherwise)
  labels,                         // labels.add({ object, offset: Vector3, html, className }) -> { el, set(html), setVisible(b), remove() }
                                  // labels.cluster(name, opts): one summary tag for many labels (see labels.js header)
  fx,                             // fx.puff(pos,{color,count,size}), fx.sparks(pos,color), fx.confetti(pos),
                                  // fx.text(pos, text, {color, size, rise}), fx.ring(pos,color), fx.smoke(pos),
                                  // fx.bubble(object, text, {secs})  (speech bubble above an object)
  pick,                           // pick.add(object3D, target) / pick.remove(object3D); target = { type, id }
  view,                           // view.focus(vec3, {zoom, secs}), view.fit(), view.rotate(±1), view.zoomBy(f)
  settings,                       // reactive settings object (see §10), settings.on(key, fn)
  bus,                            // tiny event emitter: bus.on('select', fn), bus.emit('select', target)
}

// world.js
world = {
  engine, islands: Map, buildings: Map, units: Map, vessels: Map, town,   // town = PortTown
  snapshot,                       // latest snapshot
  apply(snapshot),                // called by main.js for every snapshot
  islandOf(id) -> Island, buildingOf(key) -> Building, unitOf(agentId) -> Unit,
  layout: Map(islandId -> { x, z, r }),   // for the minimap
}
```

### Settings, CSS, feed
- `engine.settings` defaults `{ labels: 'all'|'hover'|'off', daynight: 'auto'|'day'|'night', director: true,
  voice: false, quality: 'high'|'low', showIdle: true, reduceMotion: false }`, persisted in localStorage
  (`cnc.settings`), `settings.set(key, value)` + `settings.on(key, fn)`.
- `engine.labels.css(id, cssText)` injects a module's label styles once (so modules don't edit shared CSS).
- `net.js`: `createFeed({ onSnapshot, onStatus }) -> { mode: 'live'|'demo', stop() }`; demo when the URL has
  `?demo` (with optional `speed`, `scene`). Status values: `connecting | live | reconnecting | demo`.
- `demo.js`: `startDemo({ onSnapshot, speed = 1, scene = null }) -> { stop() }` (no DOM or three.js imports).

### Island sizing (world.js computes, Island obeys)
`radius = {0: 6, 1: 7, 2: 8.5, 3: 10, 4: 12}[tier] + 1.4 * max(0, sessions - 2)`. Lots are ~5×5 on the plateau.
If more lots are requested than fit, the island adds **expansion platforms** (metal pads on stilts over the
water joined by a walkway) instead of failing. Worktree **annex islets** (radius ≈ 4) sit just off the main
island joined by a rope bridge; `allocLot(key, { annex: annexId })` places a building on that islet.

### Island (islands.js)
```js
class Island {
  constructor(world, data, { position: Vector3, radius })
  group; data; top /* plateau y */; radius;
  allocLot(key, { annex }?) -> Lot   releaseLot(key)   // Lot = { position: Vector3 (ground center, world space), facing: radians, size, annex }
  allocDock(id, { container }?) -> Dock  releaseDock(id)  // Dock = { root, berth: Vector3 (boat mooring point), dir: Vector3 outward, facing }
  stations = { crystals: [Vector3], archive: Vector3, shore: [Vector3], gitTree: Vector3, launchPad: Vector3 }
  randomPoint(rng?) -> Vector3                    // walkable point on the plateau (world space)
  walkable(p) -> bool
  update(data)                                    // tier/branch/annex changes
  launch(kind, text)                              // 'commit' rocket / 'pull' supply drop / 'checkout' flag swap
  dispose()
}
```
The PortTown (central hub) has the same `allocDock/stations` interface so vessels and units can use it.

### Building (buildings.js)
```js
class Building {
  constructor(world, session, lot, island, { instant })
  group; key; faction;
  door: Vector3; roof: Vector3;                   // world-space anchors
  lunch: { table: Vector3, seats: [Vector3] };    // picnic table beside the building
  workSpot(cat) -> Vector3                        // where a unit stands to do tool-category work near this base
  update(session, prev, { instant }?)             // react to new data (state, context, counts, procs); instant =
                                                  // the world is materializing (gap/stall): catch up, no one-shots
  tick(dt, t)
  compaction(ev)                                  // one-shot press animation
  clear(ev)                                       // one-shot demolition + rebuild
  end() -> Promise                                // decommission animation; world disposes after
  dispose()
}
```

### Unit (units.js)
```js
class Unit {
  constructor(world, { kind: 'agent' | 'commander', data, building, island, instant })
  group; id;
  update(data)                                    // agent (or session for commander) data
  tick(dt, t)
  finish(status) -> Promise                       // 'done' | 'failed' | 'lost': celebrate/sulk, walk home, enter door
  dispose()
}
```

### Vessel (harbor.js)
```js
class Vessel {
  constructor(world, port, dock, { instant })     // dock from island.allocDock or town.allocDock
  update(port); tick(dt, t);
  depart() -> Promise                             // sail away, then world disposes
  dispose()
}
```

**world.js responsibilities:** diff snapshots; create/update/remove islands (with layout), buildings
(allocLot), commanders (one per building), agent units (spawn at `building.door`; depth-2 agents spawn at their
parent unit), vessels (allocDock on `port.island` or the town); route events (`clear` -> building.clear,
`compaction` -> building.compaction, `commit/pull/checkout/merge/push/conflict/pr` -> island.launch); call `tick` on everything; register
picks; handle "agent became done/failed/lost" by calling `unit.finish(state)` then disposing; handle removed
sessions (`state==='ended'` or vanished) with `building.end()`. world.js must work even if a module is missing or
throws: wrap module calls in try/catch and fall back to a simple placeholder mesh so one bug never blanks the map.

---

## 5. Art direction

**Look:** chunky low-poly, flat shading (`flatShading: true`), saturated toy colors, soft warm sun + cool sky
fill (HemisphereLight + DirectionalLight with soft shadows, PCFSoft, 2048 map), light fog toward the horizon.
Think *Bad North* × *Townscaper* × a StarCraft base. Every object reads clearly from far away: strong
silhouettes, contrasting trims, one emissive accent per object (windows, crystals, beacons).

**Palette (kit.js PAL)** — tweak freely, but keep it vivid and harmonious:
```
sea #2EC4D6 / deep #1478A8 / foam #E9FFFB      sand #F6D38E   grass #86D34F #6CBF3E #A6E36B
cliff #C98A5B / dark #9A6440 / rock #9C95B5     wood #B97A4A / dark #7A4B2B   metal #B8C2D1 / dark #5A6478
crystal (token crystals) #5CF2FF glow           night windows #FFD66B
factions:
  opus   main #7A4DFF  trim #FFC53D  glow #FFE38A  dark #3B2280     ("The Opus Dominion")
  sonnet main #1FB5E8  trim #FF8A1F  glow #CFF6FF  dark #0B5F80     ("Sonnet Heavy Industries")
  haiku  main #9BE22D  trim #FF5FA2  glow #FFF3D6  dark #4C7A12     ("The Haiku Swarm")
  fable  main #E24BD0  trim #2ED3C5  glow #FFE45C  dark #7A1F70     ("The Fable Guild")
  merc   main #8A94A6  trim #FF4D4D  glow #FFD2D2  dark #3E4452     ("Freelancers")
```
**Night:** at night (local clock) the sky/sea darken to indigo, emissive windows glow warm, the lighthouse sweeps.
Transition smoothly. Optional stars.

**Performance budget:** steady 60 fps on a laptop GPU for ~10 islands, ~15 buildings, ~40 units, ~20 vessels.
Share geometries/materials, prefer merged static geometry and InstancedMesh for scatter (trees, rocks, grass
tufts), keep shadow casters sensible, pixel ratio ≤ 1.5, no per-frame allocations in hot loops.

---

## 6. Islands (repos)

Each island = one repo root (worktrees become annex islets connected by a little rope bridge; label them).
Island radius grows with tier and number of lots. Plateau with layered cliffs (2 strata colors), a sand beach
ring at the waterline, a grass cap with slight overhang, scattered trees/rocks/flowers. Banner flag on a pole:
repo name + branch. Features by kind/tier:

- **camp** (not a git repo): sandy islet, tents, campfire (flicker + smoke), driftwood, a crooked sign
  **"HERE BE DRAGONS — no version control"** and occasionally a small sea serpent loops around it.
- **sandbox** (Claude scratch workspace): a sandbox atoll with a sandcastle, bucket and spade, beach umbrella.
- **home**: a cozy cottage ("Homestead").
- **tier 1** outpost: small green island, a few trees, one crystal cluster, a tiny Archive shed.
- **tier 2** settlement: + fences/wall segments, lamp posts, two crystal clusters, Archive = small library.
- **tier 3** stronghold: + defense turrets that slowly idle-rotate, power pylons with sagging cables, silos,
  three crystal fields, Archive = data vault with a dish.
- **tier 4** citadel: + perimeter walls with gates, spires, a spaceport pad.
- **Git Tree**: every repo island has a stylized tree whose number of big branches = `git.branches` (cap 12);
  a little sign hangs from it with the current branch. It stands on the rim (screen-left for the default camera
  when there's room), so the plaza in the middle stays open ground for the workers.
- **Legacy Ruins**: repos with > 1500 commits get broken columns and a mossy statue head somewhere.
- **Launch pad**: `commit` event -> a small rocket (tier ≥ 3) or firework (lower tiers) launches with a trail and
  floating text of the commit message; `pull` -> supply crates parachute onto the island; `checkout` -> the
  banner flag lowers and rises with the new branch name.
- **Git work tree** (`git.status`, and each worktree's own `status`): props built the first time a state shows up,
  then reused. Uncommitted files: a laundry line, one garment per changed file (up to 8, then a "+N" tag), fluttering
  with the wind. Unpushed commits: crates on a pallet beside the launch pad (up to 6, then a count plate); a `push`
  airship loads them (they fly up into its cargo net) and the stack follows `status.ahead` again from the next poll.
  Stashes: a treasure chest half-buried behind a red X, with a "STASH ×N" sign. A merge / rebase / cherry-pick /
  revert / bisect stopped half-way: the Git Tree in plaster (white bands on the trunk and round the top crown) with a
  yellow "REBASING" (etc.) sign on a long side arm. Conflicts: the Git Tree on fire (flames, embers, smoke, a warm
  haze, the tree charred), fiercer up to 4 conflicts; the `conflict` event adds a flash, embers and a floating
  "MERGE CONFLICT!". Worktree islets show the fire and the plaster on their pennant pole; the laundry, crates and
  chest belong to the main work tree. `_layout` reserves their spots (the laundry gets a line-shaped search and may use
  the plaza's edge on crowded islands); they block units only while shown. The island card lists the same numbers in
  a "Work tree" block (uncommitted, staged, untracked, ahead / behind, stashes, conflicts, the operation in progress,
  and a line per worktree), and the EVA announces `conflict` (click: fly to the island).
- **PR carrier pigeon** (`pr` event, one-shot, skipped while the world materializes): a pigeon with a scroll tied
  to its leg takes off from the roof of the base that touched the pull request (else its worktree islet, else the Git
  Tree), flies one lap in front of it and heads off towards the horizon, shrinking, with a "PR #123" tag riding along
  (a check mark, and confetti at take-off, when merged). The EVA line names the PR and its repo, with the link as the
  line's tooltip (text only, never opened); clicking it flies to the base. The session card lists the pull requests
  that base touched since the page loaded, links shown as text. `?launchtest=pr[:secs:hold]` sends one from every
  island for screenshots.
- **Stations** units walk to: crystal clusters (bash = mining), the Archive (read), shore points (web = fishing),
  open ground (search = metal detecting), each building's work spots and lunch table.

**Port Localhost** (origin): a harbor town islet with a **lighthouse** (this dashboard; the beam sweeps; its
label says "Command & Context :7420"), a harbormaster hut, a **container terminal** with a gantry crane (moves
when container ships are busy), and piers for ports that have no session island (unowned dev servers, docker
containers). Docker ships dock at the container terminal; others at the plain piers.

---

## 7. Buildings (sessions)

**Faction HQ core** (one distinctive model per faction, faction palette):
- **Opus — Grand Athenaeum**: stately octagonal keep, golden dome, buttresses, a floating slowly rotating
  crystal above the dome. Heavy, expensive-looking.
- **Sonnet — Command Works**: boxy industrial HQ with a roll-up hangar door, rotating radar dish, smokestack,
  hazard stripes. Blue-collar reliable.
- **Haiku — Blossom Hive**: tiered pagoda-ish hive with a cherry-blossom tree growing out of it; petals drift off.
- **Fable — Storyteller's Spire**: crooked wizard tower, pointy hat roof, giant quill, floating book pages, moon window.
- **Merc — Rented Hangar**: a quonset hut with a "FOR LEASE" sign.

**Add-on modules** — built next to the core as the session uses tools (so every building ends up different).
Unlock at 3 uses (level 1), grow at 25 (level 2) and 100 (level 3). Generic sci-fi shapes tinted with the
faction palette. Each animates while its category is the *current* tool:
- `edit` -> **Forge** (anvil + robotic hammer arm; sparks)
- `bash` -> **Drill Rig** (derrick with pumping piston)
- `read`+`search` -> **Observatory** (dome with rotating telescope)
- `web` -> **Radar Array** (big dish that scans)
- `agent` -> **Barracks** (long hut, door flaps when spawning)
- `mcp` -> **Warp Gate** (ring with swirling particles)
Construction of a new module: scaffolding rises, module grows with outBack bounce, dust puffs, EVA line.

**Context Silo**: a glass tank beside the core, fill = `context.used / context.max`. Fill color cyan -> green ->
yellow -> orange -> red. Above 80%: it bulges, a warning light spins, steam vents. Label shows e.g. `212k / 1M`.

**Compaction** (`compaction` event): a big hydraulic press descends from above onto the silo, squashes it
(squash & stretch), "KA-CHUNK!" floating text, the fill drops, and a glowing **Summary Brick** pops out and lands
on a small stack beside the silo. Brick count = `compactions` (persistent).

**/clear** (`clear` event) must look clearly different from compaction: **controlled demolition**. Dynamite
flash, the core + modules + silo burst into chunky low-poly debris (simple ballistic chunks with gravity and
fade), big dust cloud, "CLEARED!" text; then scaffolding and a fresh level-0 building rises ("Construction
complete."). Workers already outside keep working (they duck and cover for a second).

**Veterancy**: a banner pole shows gold chevrons/stars for `agentsDone` (show up to 5, then "×N").

**Generators**: each entry in `procs` is a small generator/turbine hut behind the building; spin/glow speed
tracks its `cpu`. Removed when the process ends (powers down first).

**State visuals**
- `working`: windows bright, beacon pulses, chimney smoke, the module for `tool.cat` animates.
- `thinking`: a thought bubble with spinning gears or "…" floats above the building; core crystal/antenna pulses.
- `waiting` (long tool or unknown wait): hourglass icon; slower pulse.
- `needs_input`: a big bouncing **yellow "!"** above the building (RTS "needs attention") + flashing beacon.
  This must be the most eye-catching state on the map.
- `idle`: lights warm/dim; the commander goes to lunch (see units).
- `asleep` (> `asleepAfterMin` idle): windows dark, "Zzz" drifts up, a tiny moon icon; after hours, cobwebs /
  a tumbleweed rolls by.
- `ended`: lights off -> "CLOSED" sign -> the building sinks into the ground in a dust cloud -> removed.
- New session: construction from scaffolding ("Construction complete.").

**Label** (HTML, above the building): faction color chip, session name (truncate ~28 chars), a slim context bar
with `212k/1M`, and a state chip (WORKING / THINKING / WAITING / **NEEDS YOU** / LUNCH / ASLEEP). Labels shrink or
hide their detail line when zoomed far out so the map stays clean.

---

## 8. Units (sub-agents + commanders)

**Faction bodies** (chunky, cute, readable; big heads, dot eyes):
- **opus — Magister**: wide purple robe (cone), gold collar, floating gold halo ring, carries a tome. Slow waddle.
- **sonnet — Engineer**: cyan overalls, orange hard hat, tool belt. Normal walk with bob.
- **haiku — Sprite**: small round lime critter with two antennae tipped pink; hops quickly (fastest).
- **fable — Scribe**: hooded magenta cloak, pointy star-spangled hat, floats (no legs), sparkle trail.
- **merc — Drone**: boxy grey robot with antenna.

**Roles** (from `agent.type`; regex, case-insensitive) add a prop/hat so each type is distinct:
- `explore|scout|recon|search|find` -> **Scout**: binoculars; raises them periodically
- `plan|architect` -> **Architect**: blueprint roll under the arm
- `review-yagni|yagni` -> **YAGNI Inspector**: an axe (chops away what you ain't gonna need)
- `wiring|runtime` -> **Electrician**: coil of wire + multimeter
- `convention|style|lint` -> **Etiquette Officer**: monocle + rulebook
- `fidelity|design|ui|frontend` -> **Painter**: palette + brush
- `skeptic|review|audit|inspect|verify|qa` -> **Inspector**: clipboard + magnifying glass
- `test` -> **Tester**: test tube
- `guide|doc|librar|writer` -> **Librarian**: book stack on head
- `security|guard` -> **Guard**: shield
- `debug|fix|bug` -> **Exterminator**: bug-spray canister
- `statusline|paint` -> **Painter**
- anything else (general-purpose, claude, custom) -> **Engineer**: wrench; custom types get a hat color hashed from the type.

**Actions** by `tool.cat` while working (walk to the station, then loop the action):
- `bash` -> mine the island's token crystals with a pickaxe; shards pop.
- `edit` -> hammer at a small scaffold beside the building (the building's `workSpot('edit')`); sparks.
- `read` -> stand at the Archive reading a scroll (unrolls), head nodding.
- `search` -> zig-zag with a metal detector; ground ping rings; occasional "!" when it beeps.
- `web` -> walk to a shore point and **fish**: cast a line, bobber in the water, sometimes reel in a fish.
- `agent` -> megaphone shouting; the Barracks door flaps.
- `mcp` -> talk into a chunky old phone (calling an external service).
- `plan` -> write on a clipboard. `skill` -> read a glowing manual.
- `thinking` (no tool) -> stand still with a thought bubble of spinning gears.
- `waiting`/`stalled` -> lean, tap foot, check wristwatch; hourglass bubble.

**Lifecycle**
- Spawn: the building door opens, the unit pops out with a little jump + sparkle, EVA "Unit ready."
- Finish `done`: jump + spin, confetti, a ✓ icon (Inspectors stamp "APPROVED"), then walk back to the
  building door and shrink into it (the door flashes: report delivered). Nothing vanishes instantly.
- `failed`: slumped walk home under a tiny rain cloud. `lost` (session died): poof of smoke.
- Depth-2 agents are **apprentices**: 70% scale, spawn from their parent unit, follow it around loosely, and
  return to the parent (or the building if the parent is gone).

**Commander** (one per session = the main agent): a slightly larger hero unit of the faction with a cape/flag.
- Session `working`: performs the action for `session.tool.cat` near its own building (use the building's
  work spots / the island stations). `agent` cat -> stands on a crate directing troops with a megaphone.
- `thinking`: thought bubble. `needs_input`: stands on the roof waving both arms / a flag.
- `idle`: **lunch break** at the building's picnic table. Faction lunches: Opus = tea party (teacup + cake),
  Sonnet = lunch pail sitting on a steel I-beam (the classic skyscraper-lunch photo), Haiku = bento/onigiri in a
  circle, Fable = campfire marshmallows, Merc = oil can. Idle workers of the same building may join.
- `asleep`: dozing (hammock or slumped on the bench) with Zzz.

**Pathing**: straight-line walking on the flat plateau with simple steering around building footprints (circle
obstacles). Units stay on their own island (annex islets reachable over the bridge). Speeds by faction.

**Click quotes** (StarCraft-style): clicking a unit shows a speech bubble with a random line for its role/faction;
clicking the same unit 5+ times quickly gets annoyed lines. Seed lines (write more!):
- Engineer: "Job's a good'un." / "It works on my machine. I am the machine." / "Measure twice, `git reset` once."
- Scout: "Scouting ahead!" / "Found 47 files named utils.ts." / "Grep and ye shall find."
- Architect: "The plan is flawless. The plan is 400 lines." / "Load-bearing TODO detected."
- Inspector: "Hmm." / "Hmmmmmm." / "I have concerns." / "Nit: this entire file."
- YAGNI: "You ain't gonna need it." / "Delete it. Delete all of it."
- Electrician: "Is it plugged in? Is it though?" / "Don't touch the red wire."
- Etiquette: "We don't do that here." / "Two spaces. TWO."
- Magister (opus): "I shall ponder this at length." / "Verily, a semicolon."
- Sprite (haiku): speaks only in 5-7-5 haiku ("Tests pass in silence / the linter sleeps, unaware / main is red again").
- Scribe (fable): "Once upon a stack trace…" / "And then the tests passed. The end."
- Commander at lunch: "Lunch is a mandatory tool call." / "Awaiting orders. And a sandwich."
- Annoyed: "Stop poking me!" / "I'm WORKING here." / "Do you mind? I'm grepping." / "Keep clicking. See what happens."

---

## 9. Harbor (ports)

**Dock**: a wooden pier from the beach into the water with a signpost showing `:3000` (all ports for containers).
**Vessels** — stubby, cute, chunky; hull color by kind:
- `node`/`bun`/`deno` -> **tugboat** (node green #5FA04E / bun cream / deno black), smokestack, flag
- `python` -> little **steamer** (blue #3776AB with yellow #FFD43B trim)
- `php` -> purple barge with an elephant figurehead (PHP's mascot)
- `ruby` -> red sloop; `java` -> orange/brown freighter; `go` -> cyan speedboat; `dotnet` -> purple ferry
- `web` (nginx/caddy) -> green cutter; `ai` (ollama) -> llama-shaped pedal boat
- `docker` -> **container ship** with stacked colorful containers (one container per published port, min 2)
- `db` -> squat tanker barge with a round tank
- `browser` (headless test browsers owned by a session) -> a small yellow **submarine** with a periscope ("headless")
- `lighthouse` -> not a vessel: it is Port Localhost's lighthouse (make its beam brighter while browsers are connected)
- other -> grey dinghy
The vessel's flag uses the owning session's faction color (neutral white if unowned). Label: `label :port`
plus repo name when `repo` is set.

**Activity** (`activity`, 0..1): when active, two or three tiny **stevedores** carry crates between boat and pier,
the smokestack puffs, the boat bobs more, packets (tiny crates) hop along; a short "TOOT!" on a burst after a quiet
spell. When idle they sit on crates, then doze. **Wear** grows with time since `lastActive` (0 at < 5 min -> 1 at
~12 h): paint desaturates toward rust-brown, patch plates appear, it lists a few degrees, a seagull lands on the
mast, eventually barnacles and a hand-painted "4 SALE" sign. When activity resumes after a long idle, a
freshly-painted sparkle restores it.

**Arrival / departure**: a new port -> the boat sails in from the horizon with a wake trail and docks with a
bump; a closed port -> it casts off and sails away, fading out; the dock stays briefly then retracts.
`restarts` increments -> the boat does a quick "refuel" puff.

**Label cluster**: each island's (and Port Localhost's) boat labels form one labels.js cluster. With 5 or more
boats and the view not zoomed in (below lod-near), they fold into one tag over the middle of the berths,
`⚓ 11 docks · 2 busy · 1 adrift` (zero parts omitted), which stacks under the island / town name. Hovering the tag
shows the boats' labels; clicking it zooms in on the harbor, which unfolds it. A hovered or selected boat always
shows its label. Adrift and busy boats outrank idle ones in the declutter. The Zzz and the dock's 3D port sign
follow their boat's label (hidden while folded, decluttered or hidden by the zoom level / label mode).

**Adrift** (`port.adrift`, nobody is tending the server): the flag is torn, bleached and hangs limp, the stevedores
stop working, and once they sit down the boat slips 0.3-0.9 units off its berth along the dock's `dir`, lists a
few degrees and strains at its mooring line, which sags as the boat surges in and pulls taut as it runs out (a
7.5 s cycle). The time-based wear stays. It eases back when adrift clears. The label gets an ADRIFT chip; the card
an ADRIFT section (why, for how long, the pid and a copyable `Stop-Process -Id <pid>`, shown and never run); EVA
announces `port_adrift` (click: fly to the boat); the tactical map draws the boat orange; the tooltips mention it.

Ambient sea life (cheap, occasional): seagulls circling, a whale that surfaces and spouts, a sea serpent near camp islands.

---

## 10. HUD

Style: chunky cartoon-RTS chrome — dark navy translucent panels (#0E1630 @ 85%) with thick rounded bevels,
gold trim (#FFC53D), cyan accents (#39E5FF), bold readable text. Fonts: "Lilita One" (titles/numbers) and
"Chakra Petch" (body) from Google Fonts with system fallbacks. Must stay readable on a 1080p–4K spare monitor.

- **Top bar**: logo "COMMAND & CONTEXT"; resource counters (bases = sessions, supply = running agents / total
  agents listed, docks = vessels, tokens = total context in use (1.43M), cost when known, system CPU); clock;
  connection light (LIVE / DEMO / RECONNECTING); buttons: settings, voice on/off, fullscreen.
- **Minimap** (bottom-left): top-down islands (tinted by dominant faction), dots for buildings/units/boats,
  camera frustum rectangle, pulsing pings on events; click to move the camera.
- **Selection card** (bottom-center, appears on click): portrait/crest, name, faction + model, state + tool detail,
  context bar with numbers, compactions/clears, uptime, last prompt (for sessions), agents list with states,
  processes, ports; for a port: cmd, cwd, owner, activity; for an island: repo stats + langs + branch.
- **EVA log** (right side): C&C-style announcer lines for events, newest on top, fade after a while, click a line
  to jump the camera there. Lines (write more): session_start "Construction complete." · clear "Base demolished.
  Rebuilding… Memory is overrated." · compaction "Compaction complete. 812k → 96k." · agent_spawn "Unit ready:
  {agentType}." · agent_done "Mission accomplished: {description}." · agent_failed "Unit lost." · needs_input
  "Commander, your input is required." · asleep "{name} has gone to sleep." · wake "{name} is back on duty." ·
  port_open "New vessel docked at :{port}." · port_close "Vessel :{port} has departed." · commit "Launch detected!
  {name}: {msg}" · pull "Supply drop received." · checkout "Now flying the {to} flag." · context_high "Warning:
  context silo at {pct}%." · session_end "Structure decommissioned."
- **Voice** (off by default): speak EVA lines with `speechSynthesis` (low pitch, slightly slow), rate-limited.
- **Tooltips** on hover (raycast via engine.pick): one line, e.g. "Magister · Wiring review · reading IncomeStatement.vue".
- **Settings** panel (persist in localStorage): labels (all / hover / off), day-night (auto / always day / always
  night), director mode (camera gently drifts between points of interest when the user is idle; pans to events),
  voice, quality (high/low: shadows, pixel ratio), show idle bases, reduce motion.
- **Keyboard**: F fit all · Q/E rotate · +/- zoom · Space jump to last event · H hide HUD · L cycle labels ·
  Esc deselect · D toggle demo · ? help overlay.
- Empty world: a friendly card "No active Claude Code sessions. Start one and a base will be built here." plus a
  hint to try `?demo`.

---

## 11. Demo mode (`?demo`)

`demo.js` exports a feed with the same API as the live one and produces valid snapshots from a scripted,
looping simulation so every visual can be seen within ~3 minutes: 4–5 islands (one of each kind, tiers 1–4, one
with a worktree annex), one session per faction, agents of every role doing every tool category, a session in
`needs_input`, one idling at lunch, one asleep, a compaction, a /clear, a context climbing past 80%, agents
finishing (done and failed), a nested apprentice, ports opening/closing with activity bursts and a long-idle worn
boat, docker containers, a headless-browser submarine, commits/pulls/checkouts, and a session ending plus a new
one starting. Also adrift boats (the ending session's Storybook: owner-ended at ~65 s until it closes at 118 s; a
mock API: orphaned 35–100 s; the old Laravel server: orphaned throughout, each with the ended session that
probably left it behind as a guessed lastOwner), git work trees on every repo island
(edits dirty them, commits stack `ahead` until a push empties it, a stash pushed at 45 s and popped at 80 s, a
blog merge with 2 conflicts at 96 s resolved at 110 s and committed at 118 s, a monorepo rebase from 108 s with a
conflict at 114–128 s, done at 138 s; `conflict` events), and `pr` events (88 s, 163 s, every third loop 120 s).
`?demo&speed=4` speeds time up. `?demo&scene=<name>` can pin a fixed tableau for screenshots
(e.g. `scene=buildings`, `scene=units`, `scene=harbor` (with one adrift boat per reason), `scene=git` (every
git state at once: dirty, staged, untracked, ahead, behind, stash, a rebase and a merge with conflicts),
`scene=night`).

---

## 12. Testing

**Machine safety comes first.** Read the "Machine safety" section of `CLAUDE.md`. In short: render only
through `tools\shot.ps1` / `tools\dom.ps1` (one browser at a time machine-wide, CPU-capped, auto-cleanup).
Never launch msedge/chrome yourself (no CDP sessions). Render sparingly, never in parallel. Stop every
server you start.

- Start your own server instance on a spare port so agents don't collide:
  `node server/index.js --port 74xx` (run in background, stop it when done). Demo: `http://localhost:74xx/?demo`.
- Screenshot: `powershell -NoProfile -ExecutionPolicy Bypass -File tools\shot.ps1 -Url "http://localhost:74xx/?demo&scene=buildings" -Out <scratch>\x.png -Budget 8000`
  then look at the PNG with the Read tool. WebGL runs on SwiftShader there: slow but correct.
- Motion checks: `tools\dom.ps1` dumps the final DOM after a virtual-time budget. Have a temporary debug param
  log per-frame data into a `<pre>` and parse the dump. Still screenshots can't show jitter.
- Add `&shot=1` handling if useful (e.g. hide the HUD or freeze the camera for deterministic framing).
- Check the browser console for errors: `node --check` for syntax; for runtime errors add a temporary on-page
  error overlay (index.html already shows uncaught errors in a red box — keep that behavior).
- Stay within your own files. If you need an engine hook that does not exist, add it minimally and mention it
  in your final report.
