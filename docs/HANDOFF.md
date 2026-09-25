# Handoff: current state and next tasks

*Updated 2026-09-24 at the end of the third session. Read `CLAUDE.md` first (machine-safety rules are
mandatory), then this file. `README.md` is the user-facing manual; `docs/DESIGN.md` is the full spec and data
contract; `docs/ROADMAP.md` is the agreed work list and what came of it. Read only the parts you need.*

## Where things stand

The dashboard is feature-complete and in daily use on the user's third monitor (Greg). He launches it from
`C:\command-and-context\Command and Context.cmd`, a chromeless Edge window at `http://localhost:7420`. `?demo`
runs a simulated world that shows every visual; use it for testing, and for anything that might be shared
(it contains no real session data).

- `server/`: the collector (Claude Code session registry `~/.claude/sessions`, transcript tailing, the Windows
  process/port probe with CPU + I/O activity, git HEAD/push/merge detection and work-tree status, adrift ports,
  PR events, docker) plus the SSE server (`sse.js`). It needs a restart to pick up changes.
- `public/js/world/`: `engine`, `world` (snapshot diffing/orchestration), `islands` (incl. git-state props and
  the PR pigeon), `buildings`, `units` (commanders cast spells, workers do physical jobs), `harbor` (boats go
  fishing when ports are active; adrift boats), `alerts` (YOUR MOVE / NEEDS YOU / READY ✓), `labels` (island
  tags stack above session labels; crowded harbors fold into one tag). Front-end changes only need F5.
- `public/js/hud/`: RTS HUD. `public/js/demo.js`: demo simulator (`scene=git` and `scene=harbor` show the new
  features).
- Git: `main` on github.com/geekgreg/command-and-context (**public**, MIT), pushed over HTTPS as geekgreg (remote
  `origin`). Each verified change is committed separately so any one can be reverted, and pushed once Greg says
  so. Ask him before pushing. The public history starts fresh on 2026-09-24; the full earlier history lives in
  the private github.com/ccgreg/command-and-context (remote `ccgreg`, local branch `ccgreg-main`).
- npm: published as `command-and-context` (`npx command-and-context`). `bin/command-and-context.js` opens the
  window by default; `node server/index.js` never does. To release: bump `version` in `package.json`, commit,
  check `npm pack --dry-run`, then Greg runs `npm publish` (his npm login and 2FA).
- Web demo: https://geekgreg.github.io/command-and-context/ (GitHub Pages), rebuilt by `.github/workflows/pages.yml`
  on every push to `main` via `tools/build-site.mjs`. The page is marked `<html data-site="static">`: it always runs
  the demo and `D D` / the DEMO badge point to the install instead. Keep `public/index.html` paths relative.

## Next tasks

None queued. Everything Greg approved in `docs/ROADMAP.md` is done; the declined ideas are listed there in
case he asks for them later. Ask Greg what's next.

## Done (third session, 2026-09-24)

All of `docs/ROADMAP.md` phases 1-4, each item its own commit, plus two review passes whose findings were fixed:

- **Server bugs:** `--no-prompts` no longer leaks prompts through names; SSE backpressure; the probe no longer
  stalls the tick (request ids, failed/empty TCP reads kept as "unknown", backoff that settles at 10 min when
  blocked, rates timed by the probe's clock); Bash/PowerShell permission prompts raise NEEDS YOU (no new child
  process 15 s after the call, 30 s in auto mode); a pull is only a fast-forward; redaction gaps closed; caches
  pruned.
- **Front-end bugs:** no replayed demolitions after a stall (`Building.update(..., { instant })`); the
  commander re-aims when modules change; /clear races; EVA keeps missed ("while you were away") and urgent
  (pinned NEEDS YOU) news and merges harbor churn; the voice says when the browser blocks it; LIVE dims when
  stale and reconnects at once after wake; cards show departed boats/units; corrupt localStorage survives;
  `D` must be pressed twice (key repeat ignored).
- **Performance:** shadows redrawn at 15 Hz (`SHADOW_HZ` in `engine.js`), merged static meshes frozen
  (`kit.js freeze()`), labels skip sub-pixel moves and no longer force reflows. Fair numbers are in the roadmap.
- **Features:** harbor label cluster, adrift ships (with a copyable, never-run `Stop-Process` line), git
  work-tree state on islands (laundry, crates, stash chest, plaster cast, burning tree) and PR carrier pigeons.

## Known issues and backlog (not requested; don't start without asking)

- Heuristics never seen live on this machine: compaction and `/clear` detection (`/resume` looks like a
  `/clear`), the permission-prompt inference (quick tools > 20 s; shells with no new child process), and the
  adrift "orphaned" attribution from transcript history. Watch for false NEEDS YOU or ADRIFT and tune.
- Tool counts for very large transcripts are under-counted (only the first 256 KB and last 12 MB are read on
  attach); filling them in later would replay fake compaction/module animations.
- Harbor tag rough edges: a hidden pier sign leaves its blank board; on an island whose docks ring the shore
  the tag can land mid-island under base labels; dragging on the tag doesn't pan.
- Git-state props on tiny tier-1 islands sometimes have no room (then only the card shows the state); at the
  default zoom only the fire gets a size boost.
- Island name tags are sometimes missing in zoomed-out headless renders (see `docs/screenshots/hero.png`),
  probably a capture artifact. The README screenshots were re-rendered from `?demo` on 2026-09-24 with the
  `focus=`, `zoom`, `rotate`, `shot`, `select=`, `labels=hover`, `launchtest=`, `alerttest=` and `daynight=` params.
- "Click a label to open that session in the Claude desktop app": feasible only if the app's `claude://`
  handler supports a session route, which is unknown. Don't probe the app by firing links without Greg's OK.
- The macOS/Linux collector path is untested.
- Housekeeping: `screenshot1.png`–`screenshot3.png` in the repo root are Greg's own captures of the live
  dashboard. They show real session data, so they are kept out of the public repo (listed in
  `.git/info/exclude`) and live only in the private ccgreg repo. Don't commit, move or delete them.

Testing tip: headless renders advance only a few frames, so per-frame timing logic (fades, delays) doesn't run
there. Driving the module from Node with a stub world/engine (the modules import 'three' by bare specifier,
which resolves in Node) plus manual `tick(dt)` is quicker and more reliable. Screenshot hooks: `select=`,
`panel=`, `hud=0`, `evatest`, `tiptest` (hud.js header) and `launchtest=push|merge|commit|pull|checkout|pr`
(islands.js).

## Handy commands

```
node server/index.js --port 7455        # your own test server; stop it when done
node server/index.js --dump             # print one live snapshot as JSON
powershell -NoProfile -ExecutionPolicy Bypass -File tools\shot.ps1 -Url "http://localhost:7455/?demo" -Out <scratch>\x.png
powershell -NoProfile -ExecutionPolicy Bypass -File tools\dom.ps1  -Url "http://localhost:7455/?demo&<debug>" -Out <scratch>\dom.html -Budget 15000
```
