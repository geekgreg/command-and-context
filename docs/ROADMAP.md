# Roadmap

*Agreed with Greg on 2026-09-24, from a three-part audit (server, 3D world, HUD). Each item lands as its own
small commit so it can be reverted on its own. Tick items off here as they land, and keep `README.md` and
`docs/DESIGN.md` in step with anything visible or any change to the data contract.*

Machine-safety rules in `CLAUDE.md` apply to every step (renders only through `tools\shot.ps1` /
`tools\dom.ps1`, one at a time, own server on a spare port, stop it afterwards).

## Phase 1: server bugs

- [x] **S1 `--no-prompts` leaks prompt text.** An untitled session is named after its last prompt
  (`collector.js` `nameOf`), and a sub-agent's description falls back to its own prompt (`agentDesc`). Both
  names reach labels and events. With `showPrompts` off, fall back to the folder name / agent type instead.
- [x] **S2 No backpressure on the SSE stream** (`index.js`). A frozen tab makes the server buffer one snapshot
  per second forever. Skip writes to a client whose socket buffer is backed up; drop it if it stays stuck.
- [x] **S3 A slow or failing Windows probe stalls the collector.** The tick awaits the probe for up to 45 s,
  ports freeze during the retry backoff, and an empty TCP table read makes every boat leave and come back.
  Decouple the tick from the probe, treat an empty read as a failed read, and keep request/response pairing
  robust (`system.js`, `probe-win.ps1`).
- [x] **S4 Bash permission prompts are never detected.** Only "quick" tools can trigger NEEDS YOU. A Bash or
  PowerShell call pending more than ~15 s with no new child process since it started is almost certainly
  waiting for permission.
- [x] **S5 False "pull" events.** Any HEAD move to an older commit (e.g. `git reset --hard HEAD~1`) is
  announced as a supply drop (`repos.js`). Only a fast-forward to someone else's commits is a pull.
- [x] **S6 Redaction gaps** (`util.js`). `mysql -pSECRET`, `curl -u user:pass`, lowercase `password=x` and
  `ConvertTo-SecureString 'pw'` get through; Grep patterns, Glob patterns and web search queries are never
  redacted.
- [x] **Also (low severity):** maps that are never pruned (`Collector.index`, `Repos` caches, transcript
  `agentCalls`/`notifications`). *Skipped:* tool counts for very large transcripts stay under-counted; filling
  them in later would replay fake compaction and module animations after startup.

## Phase 2: front-end bugs

- [x] **F1 Old demolitions replay.** If the window was minimized when a session was /cleared or compacted, the
  animation plays when it is shown again, even hours later. `Building.update` must honour the world's
  materialize/stalled mode (`world.js`, `buildings.js`).
- [x] **F2 The commander aims at a stale spot.** Its spell target is recomputed only when the tool category
  changes, so bolts miss a Drill Rig that unlocked mid-command, or hit a module a /clear removed (`units.js`).
- [x] **F3 /clear races.** A /clear during the first build shows "Construction complete." mid-demolition; a
  session that ends during a /clear sinks while invisible; a compaction racing a /clear animates removed
  parts (`buildings.js`).
- [x] **F4 EVA log gaps.** Events during PC sleep never reach the log (the >30 s gap drops them), and port
  open/close churn pushes urgent NEEDS YOU lines out of the 6-line log (`world.js`, `eva.js`).
- [x] **F5 The voice fails silently.** After a restart the browser blocks speech until a click, with no hint;
  a stuck `speechSynthesis.speaking` stalls the queue forever (`eva.js`).
- [x] **F6 Stale LIVE light after wake.** A dead socket shows LIVE for ~20 s after the PC wakes. Check
  freshness on `visibilitychange` / `online` / `pageshow` and reconnect at once (`net.js`).
- [x] **F7 Cards outlive their subject.** A port's card keeps showing BUSY after its boat sailed; the same for
  agents that are gone (`card.js`).
- [x] **F8 Corrupt saved settings** are reported as "WebGL not available" (`engine.js`, `hud/util.js`).
- [x] **F9 A stray `D`** swaps into the demo world without asking (`hud.js`).
- [x] **Also (low severity):** unit label height not updated after a body rebuild; fallback spark pool reuses
  one colour; `renderer.render` unguarded.

## Phase 3: performance (runs 24/7)

- [x] **P1 Shadows.** The 2048² shadow map is re-rendered every frame. Update it at ~10 Hz, or only when
  something that casts shadows moves.
- [x] **P2 Static matrices.** Nothing turns off `matrixAutoUpdate`, so every static prop recomputes its matrix
  each frame. Freeze static decoration once built.
- [x] **P3 Labels during camera moves.** Director mode keeps the camera moving; every label's transform is
  rewritten each frame and the stacker allocates a new `Map` per stack per frame (`labels.js`). Skip
  sub-pixel moves and reuse buffers. Also cheapen the once-a-second pick-bounds refresh and the night-light
  scene traversal if they show up in measurements.

Measure before and after (frame CPU time and `renderer.info` in a fixed demo scene) and record the numbers in
the commit messages.

*Result (headless, camera held still, `scene=buildings`):* shadow passes per frame 1.0 → 0.5, shadow draw
calls 215 → 109, total draw calls 843 → 740 (−12%). The P1 commit message quotes 1327 → 1054 total, which
mixes in camera differences; the figures here are the fair ones. P2 froze about a quarter of all objects
(merged static meshes only) with no measurable change in matrix time; P3 removed per-frame `Map` allocations
and forced reflows. Set `SHADOW_HZ = 30` in `engine.js` if fast units' shadows ever look jittery.

## Phase 4: features

- [x] **H1 Harbor label cluster.** When a harbor has more than a handful of port labels and the view is not
  zoomed in, show one tag instead (`⚓ 11 docks · 2 busy · 1 adrift`); expand on zoom-in or hover. Busy
  ports rank above idle ones. The Zzz labels and pier signs follow their boat label's visibility.
- [x] **H2 Adrift ships.** The server remembers each port's last owning session. A port whose owner has ended
  (or whose parent process is gone, for dev-tool servers) is `adrift`. The boat shows a torn flag, lists and
  strains at a loose rope; the label and card say ADRIFT with the former owner, how long, the pid and a
  copyable `Stop-Process -Id <pid>` (shown, never run).
- [x] **G1 Git state on the island.** Per repo, every ~15 s: uncommitted, staged and conflicted file counts,
  commits ahead/behind, stash count, and any merge/rebase/cherry-pick/bisect in progress. Shown as:
  - uncommitted files: laundry on a line (one shirt per file, capped)
  - unpushed commits: crates stacking on the airship pad (the next push carries them off)
  - a stash: a buried treasure chest with a count
  - an operation in progress: the Git Tree in a plaster cast with a sign ("REBASING")
  - merge conflicts: the Git Tree on fire
  The island card lists the same numbers.
- [x] **G2 New PR.** The transcripts record PRs (`pr-link` entries and the Bash result's `gitOperation.pr`).
  A new `pr` event sends a carrier pigeon off from the base with a "PR #123" scroll, plus an EVA line.

Each feature also shows up in `?demo`, and gets a README line.

## Declined for now

- Command visuals (hologram terminal, per-command gags, outcome bursts, command ticker). The server
  groundwork notes are in the audit summary: `session.cmd` / `agent.cmd` and a `cmd_done` event built from
  the transcript's `is_error`, exit code, `interrupted`, timeout and `gitOperation` fields.
- Attention helpers (taskbar badge, desktop notifications, `N`/`R`/`[`/`]` keys, roster panel).
- Keeping labels out from under the top bar.
- Other transcript extras (rate-limit storm clouds, queued-prompt mailbag, richer debriefs, "while you were
  away" digest beyond the F4 fix, timeline strip).
