# Command & Context: notes for Claude

A local dashboard that renders every running Claude Code session on this machine as a low-poly isometric
RTS diorama. Node server in `server/` (collector + SSE), three.js front end in `public/` (no build step).

**Start here: `docs/HANDOFF.md` has the current state, the next tasks and the known issues.**
`docs/DESIGN.md` is the spec and data contract; read the parts relevant to your change. `README.md` is the
user-facing field manual; keep it in sync with visible behavior.

## Machine safety (mandatory, for you and for every sub-agent you brief)

This runs on the user's everyday workstation. Headless browsers render WebGL in software on the CPU and can
make the whole machine unusable, and orphaned browsers keep burning CPU after an agent exits.

- Only render through `tools\shot.ps1` (screenshot) or `tools\dom.ps1` (DOM dump). They run **one browser at
  a time machine-wide**, cap it at 25% CPU and below-normal priority, time out, and kill it when done.
- The tools use **Chrome first** on purpose. Edge silently signs even a throwaway profile into the Windows
  user's Microsoft account, copying in personal account details (and syncing, unless sync is disabled).
  Don't switch it back to Edge.
- **Never** launch `msedge`/`chrome` yourself: no CDP / `--remote-debugging-port` sessions, no Playwright or
  Puppeteer. Never run renders in parallel or in background loops.
- Render sparingly. Prefer Node-based checks and `node --check`. Use small windows (the default 1280x720)
  and short virtual-time budgets.
- Start your own dev server on a spare port (`node server/index.js --port 74xx`) and **stop it** when you're
  done. Leave nothing running. Never kill the user's own processes (their Edge, their dashboard on :7420,
  other Claude sessions' browsers). The cleanup helpers only touch our own `cnc-*` temp profiles.
- Run at most one render-heavy sub-agent at a time.

## Working style

- Brief sub-agents in small, focused batches, and start fresh agents rather than resuming ones with long
  histories. Point them at the specific files and functions involved, not the whole spec.
- This is a PUBLIC git repo (github.com/geekgreg/command-and-context) and an npm package
  (`command-and-context`). Never commit real session data, prompts, personal paths or screenshots of the live
  dashboard: use `?demo` for anything visual. Keep commits small and focused, one per fix or feature, so any
  change can be reverted. Commit and push only when the user asks.
- Verify motion bugs per frame (`tools\dom.ps1` + a temporary debug param that logs into a `<pre>`),
  not from still screenshots. Remove debug params afterwards.
- `npm run demo` / `?demo` shows every animation. `?demo&scene=buildings|units|harbor|git|night|empty` pins
  a tableau.
