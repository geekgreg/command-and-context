// Demo world: a scripted, looping simulation that emits snapshots in the exact server format (docs/DESIGN.md §2,
// server/collector.js buildSnapshot). Pure logic with no DOM or three.js imports, so it also runs under Node.
//
//   startDemo({ onSnapshot, speed = 1, scene = null }) -> { stop() }
//
// Sim time runs `speed`x real time (speed 0.05..100). Snapshots go out about once a second (twice at speed >= 4,
// four times at >= 40); consecutive snapshots never skip more than 25 sim-seconds. One 3-minute loop exercises every visual
// in the spec; across loops the world keeps evolving (counters grow, contexts fill, the rotating seat changes
// hands) instead of resetting. `scene` pins a static tableau for screenshots, one of SCENES.
//
// Extra top-level field on every demo snapshot: demo = { scene, speed, loopT, forceNight } (loopT = seconds
// into the loop, null for pinned scenes). Events match the server's pushEvent: `id` is always the increasing
// event id, port_open / port_close / port_adrift name the vessel as `portId`, and agent_* events carry { key,
// agent, description } (their `type` is the event type; look the agent up by id for its role).
//
// Each loop also has adrift boats (the rotating seat's Storybook is left behind when that session ends:
// owner-ended; a mock API left behind by an already ended session appears: orphaned; the old Laravel server has
// been orphaned all along), git work-tree states on every repo island (laundry from edits, crates from commits that a push
// carries off, a stash pushed and popped, a merge on the blog and a rebase on the monorepo that each hit
// conflicts, with `conflict` events, and later resolve), and a few `pr` events.

export const SCENES = ['buildings', 'units', 'harbor', 'git', 'night', 'empty'];

const LOOP = 180_000;             // one scripted loop, sim ms
const STEP = 250;                 // fixed sim step: the world is identical however steps are grouped into ticks
const WARMUP = 60_000;            // simulated before the first snapshot so the world starts mid-flow
const AGENT_LINGER = 120_000;     // finished agents stay listed this long
const ENDED_LINGER = 60_000;      // an ended session stays listed this long
const WAITING_AFTER = 90_000;     // a call pending longer than this reads as 'waiting'
const NIGHT_AT = LOOP + 45_000;   // the night scene freezes the default world at this busy moment
const MIN = 60_000, HOUR = 60 * MIN;
const SEED = 0xc0ffee;
const CATS = ['edit', 'bash', 'read', 'search', 'web', 'agent', 'mcp', 'plan', 'skill', 'other'];
const ACTIVE = new Set(['working', 'thinking', 'waiting', 'stalled']);
const BUSY_MODES = new Set(['work', 'think', 'wait', 'ask']);   // modes in which a session's context grows

// ---- helpers -------------------------------------------------------------------------------------------------

// Seeded PRNG (mulberry32, as in world/kit.js): the same seed replays the same world.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;
const zeroTools = () => Object.fromEntries(CATS.map((c) => [c, 0]));
const total = (o) => Object.values(o).reduce((a, b) => a + b, 0);
// [from, to] in loop seconds; from > to wraps past the end of the loop.
const within = ([from, to], sec) => (from <= to ? sec >= from && sec < to : sec >= from || sec < to);

// ---- models (mirrors server/util.js so labels and window sizes match the live feed) ------------------------------

const MODEL = {
  opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5', sonnet45: 'claude-sonnet-4-5', haiku: 'claude-haiku-4-5',
  fable: 'claude-fable-5-1', merc: 'gpt-oss-120b',
};
// Rough $ per token of context growth (cache reads are cheap). Mercs bill elsewhere, so their cost stays null.
const PRICE = { opus: 5e-6, fable: 4e-6, sonnet: 1.5e-6, haiku: 4e-7 };

function factionOf(model) {
  const m = String(model || '').toLowerCase();
  return ['opus', 'sonnet', 'haiku', 'fable'].find((f) => m.includes(f)) || 'merc';
}

function modelLabel(model) {
  const m = String(model).replace(/\[1m\]/i, '').toLowerCase();
  const fam = factionOf(m);
  if (fam === 'merc') return model;
  const ver = (m.match(new RegExp(`${fam}-(\\d{1,2}(?:-\\d{1,2})?)(?!\\d)`)) || m.match(/claude-(\d(?:-\d)?)-/) || [])[1];
  const name = fam[0].toUpperCase() + fam.slice(1);
  return ver ? `${name} ${ver.replace('-', '.')}` : name;
}

function contextMax(model, used) {
  const m = String(model || '');
  return /\[1m\]/i.test(m) || /(opus|sonnet|fable)-([5-9]|\d\d)/i.test(m) || /fable/i.test(m) || used > 200_000 ? 1_000_000 : 200_000;
}

// ---- the map -------------------------------------------------------------------------------------------------------

const SANDBOX = 'C:\\Users\\demo\\AppData\\Roaming\\Claude\\scratch-workspaces\\6f2d8a1c-4b7e-4d21-9c3a-0e5b7f9d2a11\\c1e4b9d0-77a2-4f3e-8d5c-2b9a6e0f4c83\\scratch-2026-09-23-5f1c2a';
const PLACES = {
  shop: { id: 'c:/demo/storefront-nuxt', name: 'storefront-nuxt', kind: 'repo', root: 'C:\\demo\\storefront-nuxt',
    git: { files: 1621, commits: 1769, branches: 29, langs: ['TypeScript', 'Vue'], branch: 'fix/flaky-checkout' } },
  tiny: { id: 'c:/demo/tiny-cli', name: 'tiny-cli', kind: 'repo', root: 'C:\\demo\\tiny-cli',
    git: { files: 42, commits: 57, branches: 2, langs: ['Go'], branch: 'main' } },
  mono: { id: 'c:/demo/monorepo', name: 'monorepo', kind: 'repo', root: 'C:\\demo\\monorepo',
    git: { files: 9000, commits: 4200, branches: 64, langs: ['TypeScript', 'Rust', 'Python'], branch: 'feat/passkeys' } },
  blog: { id: 'c:/demo/blog', name: 'blog', kind: 'repo', root: 'C:\\demo\\blog',
    git: { files: 380, commits: 212, branches: 3, langs: ['TypeScript', 'CSS'], branch: 'main' } },
  downloads: { id: 'c:/users/demo/downloads', name: 'Downloads', kind: 'camp', root: 'C:\\Users\\demo\\Downloads', git: null },
  sandbox: { id: SANDBOX.toLowerCase().replace(/\\/g, '/'), name: 'Sandbox 5f1c2a', kind: 'sandbox', root: SANDBOX, git: null },
  home: { id: 'c:/users/demo', name: 'Homestead', kind: 'home', root: 'C:\\Users\\demo', git: null },
};
// A git worktree of storefront-nuxt with a session in it: an annex islet joined to the island by a rope bridge.
const ANNEX = {
  id: 'c:/demo/storefront-nuxt/.claude/worktrees/billing-webhooks', name: 'billing-webhooks', branch: 'refactor/billing-webhooks',
  root: 'C:\\demo\\storefront-nuxt\\.claude\\worktrees\\billing-webhooks',
};
const tierOf = (p) => (p.kind !== 'repo' ? 0 : p.git.files < 150 ? 1 : p.git.files < 1500 ? 2 : p.git.files < 6000 ? 3 : 4);

// Work-tree state per repo place (annex = the worktree), shown as git.status. tracked = changed tracked paths
// (staged is a subset); dirty = tracked + untracked + conflicts, like `git status`. ahead/behind read null
// while the branch has no upstream (it has never been pushed). The stash is shared by a repo and its worktrees.
const GIT0 = {
  shop: { tracked: 3, staged: 1, untracked: 1, conflicts: 0, ahead: 0, behind: 0, stash: 1, op: null },
  annex: { tracked: 2, staged: 0, untracked: 0, conflicts: 0, ahead: 1, behind: 0, stash: 1, op: null },
  mono: { tracked: 5, staged: 2, untracked: 2, conflicts: 0, ahead: 3, behind: 0, stash: 2, op: null },
  blog: { tracked: 1, staged: 0, untracked: 1, conflicts: 0, ahead: 0, behind: 0, stash: 0, op: null },
  tiny: { tracked: 1, staged: 0, untracked: 0, conflicts: 0, ahead: 0, behind: 0, stash: 0, op: null },
};
const GITHUB = { shop: 'acme/storefront-nuxt', mono: 'acme/monorepo', blog: 'acme/blog', tiny: 'acme/tiny-cli' };

// ---- what gets worked on where ---------------------------------------------------------------------------------------
// Per place and tool category: a string is the call's detail; [name, detail] pins the tool name;
// { d, proc: [name, cmd, cpu] } also runs a child process while the call is pending.

const WORK = {
  shop: {
    edit: ['CheckoutForm.vue', 'useCart.ts', 'checkout.spec.ts', 'payment.ts', 'CartDrawer.vue', 'playwright.config.ts'],
    read: ['CheckoutForm.vue', 'useCart.ts', 'checkout.spec.ts', 'payment.ts', 'nuxt.config.ts', 'ci.yml', 'stripe-elements.ts'],
    search: ['/useCart\\(/', '**/*.spec.ts', '/waitForSelector/', 'components/**/Checkout*.vue', '/iframe\\[name=/'],
    bash: [{ d: 'npx vitest run checkout', proc: ['node', 'node.exe node_modules/vitest/vitest.mjs run checkout', 2.2] },
      'npm run typecheck', 'git diff --stat', 'Lint and autofix the checkout module', 'git log -8 --oneline -- tests/e2e'],
    web: ['playwright.dev', 'docs.stripe.com', 'playwright flaky test iframe detached', 'github.com'],
    mcp: [['mcp__linear__create_issue', 'create issue'], ['mcp__github__get_pull_request', 'get pull request']],
    skill: ['webapp-testing', 'code-review'],
  },
  annex: {
    edit: ['BillingService.ts', 'webhooks.post.ts', 'idempotency.ts', 'stripe.mock.ts', 'billing.spec.ts'],
    read: ['webhooks.post.ts', 'BillingService.ts', 'ledger.ts', 'stripe.d.ts', 'README.md'],
    search: ['/constructEvent\\(/', 'server/api/**/webhook*.ts', '/idempotencyKey/'],
    bash: ['npx vitest run billing', 'stripe trigger invoice.paid', 'git status --short'],
    web: ['docs.stripe.com', 'stripe webhook idempotency best practice'],
    mcp: [['mcp__stripe__list_events', 'list events'], ['mcp__stripe__retrieve_event', 'retrieve event']],
  },
  blog: {
    edit: ['v2-4-release-notes.mdx', 'CHANGELOG.md', 'og-image.tsx', 'authors.json'],
    read: ['CHANGELOG.md', 'v2-3-release-notes.mdx', 'next.config.mjs', 'style-guide.md'],
    search: ['posts/**/*.mdx', '/BREAKING/', '/TODO\\(notes\\)/'],
    bash: ['git log --oneline v2.3.0..HEAD', { d: 'npm run build', proc: ['node', 'node.exe node_modules/next/dist/bin/next build', 1.9] },
      'npx prettier --write posts'],
    web: ['github.com', 'how to write release notes people actually read', 'keepachangelog.com'],
    skill: ['de-ai-edit', 'docs'],
  },
  mono: {
    edit: ['webauthn.ts', 'session_store.rs', 'auth_middleware.py', 'PasskeyModal.tsx', 'recovery_codes.py', 'schema.prisma'],
    read: ['webauthn.ts', 'session_store.rs', 'auth_middleware.py', 'Cargo.toml', 'ARCHITECTURE.md', 'login.tsx'],
    search: ['/legacyLogin\\(/', 'packages/**/auth*.ts', '/set_cookie/', 'services/**/*.py'],
    bash: [{ d: 'cargo test -p auth-core', proc: ['cargo', 'cargo.exe test -p auth-core', 3.4] },
      { d: 'pytest tests/auth -q', proc: ['python', 'python.exe -m pytest tests/auth -q', 1.3] }, 'pnpm -r typecheck', 'docker compose ps'],
    web: ['webauthn.guide', 'passkeys.dev', 'w3c.github.io', 'conditional mediation passkeys autofill'],
    mcp: [['mcp__supabase__execute_sql', 'execute sql'], ['mcp__supabase__list_tables', 'list tables'], ['mcp__linear__create_issue', 'create issue']],
    skill: ['security-review', 'simplify'],
  },
  tiny: {
    edit: ['output.go', 'flags.go', 'output_test.go', 'README.md'],
    read: ['main.go', 'output.go', 'flags.go', 'go.mod'],
    search: ['/fmt\\.Printf/', '**/*_test.go', '/tabwriter/'],
    bash: [{ d: 'go test ./...', proc: ['go', 'go.exe test ./...', 1.4] }, 'go build -o tiny.exe ./cmd/tiny', 'gofmt -l .'],
  },
  downloads: {
    edit: ['rename-plan.csv', 'rename.ps1'],
    read: ['rename-plan.csv', 'Screenshot 2026-09-12 101532.png', 'Screenshot 2026-09-14 170245.png'],
    search: ['Screenshot*.png', '*.heic'],
    bash: ['Count the screenshots', { d: 'Shrink every PNG by half', proc: ['magick', 'magick.exe mogrify -resize 50% *.png', 3.3] },
      'Rename files from the plan', 'Get-ChildItem -Filter *.png | Measure-Object'],
    mcp: [['mcp__filesystem__move_file', 'move file'], ['mcp__filesystem__list_directory', 'list directory']],
  },
  sandbox: {
    edit: ['widget.js', 'clouds.js', 'index.html', 'palette.css'],
    read: ['widget.js', 'clouds.js', 'sprites.png', 'notes.md'],
    search: ['/drawCloud/', '*.js'],
    bash: [{ d: 'Screenshot the widget', proc: ['node', 'node.exe tools/shot.mjs', 0.8] }, 'curl -s localhost:8123/health', 'ls sprites'],
    web: [['mcp__claude-in-chrome__computer', 'computer'], ['mcp__claude-in-chrome__navigate', 'navigate'],
      ['mcp__claude-in-chrome__read_page', 'read page'], 'opengameart.org', 'pixel art cloud palette 16 colors'],
    skill: ['frontend-design'],
  },
  home: {
    edit: ['Microsoft.PowerShell_profile.ps1', 'starship.toml', '.gitconfig'],
    read: ['Microsoft.PowerShell_profile.ps1', 'starship.toml', 'modules.txt'],
    search: ['/Import-Module/', '*.ps1'],
    bash: ['Measure profile load time', 'pwsh -NoProfile -Command . $PROFILE', 'winget upgrade --all'],
  },
};
const GENERIC = {
  edit: ['README.md', 'CHANGELOG.md'],
  read: ['package.json', 'README.md', 'CLAUDE.md'],
  search: ['/TODO|FIXME/', '**/*.test.*'],
  bash: ['git status', 'git diff --stat'],
  web: ['developer.mozilla.org', 'stackoverflow.com'],
  agent: [['SendMessage', 'status check'], ['TaskOutput', 'collect results']],
  mcp: [['mcp__linear__list_issues', 'list issues'], ['mcp__github__create_pull_request', 'create pull request'], ['mcp__sentry__search_issues', 'search issues']],
  plan: [['TodoWrite', '5 todos'], ['TodoWrite', '8 todos'], ['TaskCreate', 'Write the failing test first'], ['EnterPlanMode', '']],
  skill: ['code-review', 'simplify'],
  other: [['SendUserFile', ''], ['ListMcpResourcesTool', '']],
};
const DUR = { edit: [2, 5], bash: [3, 10], read: [1.5, 3.5], search: [1.5, 3.5], web: [3, 8], agent: [2, 3], mcp: [2, 6], plan: [1, 2.5], skill: [2, 4], other: [1, 2] };
const AGENT_CTX = { edit: 2500, bash: 3000, read: 6000, search: 2000, web: 7000, agent: 1500, mcp: 3000, plan: 1200, skill: 4000, other: 800 };

// ---- the cast ----------------------------------------------------------------------------------------------------------
// Standing seats. plan: [from, to, mode, opts] in loop seconds. Modes: work (tool calls with thinking beats), think,
// wait (one long call; 'waiting' after 90 s), ask (needs_input), idle (lunch), asleep. tools: counts at the first
// snapshot, parked just under the 3 / 25 / 100 module thresholds; opening: the categories of the first calls after
// that, so every module (Forge, Drill, Observatory, Radar, Barracks, Warp Gate) crosses every threshold in loop one.

const CAST = [
  { id: 'checkout', place: 'shop', name: 'Fix flaky checkout tests', model: 'opus', entry: 'claude-desktop', perm: 'acceptEdits',
    pid: 28932, age: 2.2 * HOUR, used: 780_000, ctxRate: 4200, cost: 31.6, added: 412, removed: 198, agentsDone: 14, compactions: 2,
    prompt: 'the checkout e2e test fails 1 in 5 runs on CI but never locally. find out why and fix it properly, no retries',
    mix: { bash: 22, read: 20, edit: 20, search: 14, web: 6, mcp: 5, plan: 5, skill: 3, agent: 2, other: 1 },
    tools: { edit: 99, bash: 71, read: 61, search: 38, web: 12, agent: 24, mcp: 6, plan: 9, skill: 2, other: 1 }, opening: ['edit', 'read'],
    plan: [[0, 8, 'think'], [8, 146, 'work'], [146, 156, 'think'], [156, 180, 'work']] },
  { id: 'billing', place: 'shop', annex: true, name: 'Refactor billing webhooks', model: 'sonnet', entry: 'cli', perm: 'default',
    pid: 41236, age: 55 * MIN, used: 310_000, ctxRate: 900, cost: 6.4, added: 233, removed: 305, agentsDone: 3,
    prompt: 'make the stripe webhooks idempotent and move them into BillingService',
    mix: { edit: 24, read: 20, search: 12, bash: 14, mcp: 18, web: 4, plan: 4, skill: 2, other: 2 },
    tools: { edit: 24, bash: 40, read: 30, search: 12, web: 4, agent: 6, mcp: 24, plan: 3, skill: 0, other: 0 }, opening: ['edit', 'mcp'],
    plan: [[0, 25, 'work'], [25, 135, 'wait', { detail: 'Run the webhook e2e suite',
      proc: ['node', 'node.exe node_modules/@playwright/test/cli.js test --project=webhooks', 2.4] }], [135, 180, 'work']] },
  { id: 'notes', place: 'blog', name: 'Write release notes', model: 'haiku', entry: 'claude-desktop', perm: null,
    pid: 17804, age: 40 * MIN, used: 62_000, ctxRate: 300, cost: 0.41, added: 96, removed: 12, agentsDone: 1,
    prompt: 'write release notes for v2.4 from the git log, friendly tone, group by feature',
    mix: { edit: 28, read: 24, bash: 12, search: 10, web: 16, plan: 5, skill: 5 },
    tools: { edit: 9, bash: 11, read: 20, search: 4, web: 24, agent: 1, mcp: 0, plan: 2, skill: 1, other: 0 }, opening: ['read', 'web'],
    plan: [[0, 28, 'work'], [28, 48, 'ask'], [48, 98, 'work'], [98, 180, 'idle']] },
  { id: 'passkeys', place: 'mono', name: 'Migrate auth to passkeys', model: 'fable', entry: 'claude-desktop', perm: 'bypassPermissions',
    pid: 9120, age: 3.1 * HOUR, used: 190_000, ctxRate: 1500, cost: 12.9, added: 1310, removed: 842, agentsDone: 22, clears: 2,
    prompt: 'migrate login to passkeys (webauthn), keep the password fallback behind a flag',
    mix: { edit: 22, read: 18, bash: 16, search: 10, web: 8, mcp: 12, plan: 6, skill: 4, agent: 2, other: 2 },
    tools: { edit: 70, bash: 64, read: 88, search: 41, web: 30, agent: 98, mcp: 99, plan: 12, skill: 4, other: 2 }, opening: ['mcp'],
    plan: [[0, 95, 'work'], [95, 98, 'idle'], [98, 104, 'think'], [104, 180, 'work']] },
  { id: 'jsonflag', place: 'tiny', name: 'Add --json output flag', model: 'sonnet45', entry: 'cli', perm: 'acceptEdits',
    pid: 36610, age: 25 * MIN, used: 48_000, ctxRate: 260, cost: 1.12, added: 58, removed: 9, agentsDone: 2,
    prompt: 'add a --json flag to every command that prints a table',
    mix: { edit: 30, read: 24, bash: 24, search: 16, plan: 6 },
    tools: { edit: 2, bash: 4, read: 8, search: 3, web: 2, agent: 2, mcp: 0, plan: 1, skill: 0, other: 0 }, opening: ['edit', 'web'],
    plan: [[0, 45, 'work'], [45, 180, 'idle']] },
  { id: 'screens', place: 'downloads', name: 'Rename 400 screenshots', model: 'merc', entry: 'sdk-ts', perm: 'bypassPermissions',
    pid: 50212, age: 1.5 * HOUR, used: 38_000, ctxRate: 350, agentsDone: 0, shell: 'PowerShell',
    prompt: 'rename every screenshot in Downloads to YYYY-MM-DD_what-it-shows.png',
    mix: { bash: 44, read: 20, edit: 12, search: 10, mcp: 10, other: 4 },
    tools: { edit: 3, bash: 99, read: 14, search: 6, web: 0, agent: 1, mcp: 2, plan: 1, skill: 0, other: 0 }, opening: ['bash', 'mcp'],
    plan: [[0, 60, 'idle'], [60, 150, 'work'], [150, 160, 'think'], [160, 180, 'idle']] },
  { id: 'weather', place: 'sandbox', name: 'Prototype a pixel-art weather widget', model: 'opus', entry: 'claude-desktop', perm: 'acceptEdits',
    pid: 21944, age: 4 * HOUR, used: 420_000, ctxRate: 1000, cost: 21.7, added: 880, removed: 301, agentsDone: 5,
    prompt: 'prototype a tiny pixel-art weather widget with animated clouds, then screenshot it',
    mix: { web: 26, edit: 24, bash: 18, read: 16, search: 8, skill: 4, other: 4 },
    tools: { edit: 45, bash: 24, read: 30, search: 9, web: 99, agent: 4, mcp: 1, plan: 3, skill: 5, other: 2 }, opening: ['bash', 'web'],
    plan: [[0, 100, 'work'], [100, 125, 'think'], [125, 180, 'work']] },
  { id: 'dotfiles', place: 'home', name: 'Speed up my PowerShell profile', model: 'haiku', entry: 'cli', perm: 'default',
    pid: 12876, age: 26 * HOUR, used: 22_000, ctxRate: 200, cost: 0.06, added: 14, removed: 31, agentsDone: 0, shell: 'PowerShell',
    sleepAge: 3.2 * HOUR, prompt: 'my PowerShell profile takes 4 seconds to load, make it fast',
    mix: { bash: 36, read: 30, edit: 24, search: 10 },
    tools: { edit: 1, bash: 2, read: 3, search: 1, web: 0, agent: 0, mcp: 0, plan: 0, skill: 0, other: 0 }, opening: ['bash'],
    plan: [[0, 10, 'asleep'], [10, 50, 'work'], [50, 85, 'idle'], [85, 180, 'asleep']] },
];
const CLEAR_PROMPTS = [
  'now wire up the recovery-code flow and make sure it is rate limited',
  'add passkey management to the account page (list, rename, revoke)',
  'write the migration guide for the support team',
];

// The rotating seat on storefront-nuxt: each loop the current one ends at 60 s (listed as ended for a minute, its
// running agent is lost) and a new one starts at 130 s. Templates alternate between resumed sessions (the transcript
// already has history, so modules level up past 25 / 100) and fresh ones (modules unlock from zero).
const SLOT_PLAN = [[130, 136, 'think'], [136, 60, 'work']];
const SLOT_MIX = { edit: 20, bash: 18, read: 16, search: 12, web: 10, mcp: 10, plan: 6, skill: 4, other: 2 };
const SLOTS = [
  { name: 'Bump Nuxt to 4.2', model: 'sonnet', entry: 'cli', perm: 'acceptEdits', used: 180_000, cost: 2.4,
    prompt: 'upgrade nuxt to 4.2 and fix whatever breaks', commit: 'chore(deps): nuxt 4.2, and nothing caught fire',
    tools: { edit: 60, bash: 97, read: 40, search: 22, web: 23, agent: 11, mcp: 23, plan: 6, skill: 2, other: 0 },
    agents: [['review-skeptical', 'Skeptic pass: nuxt 4.2 breaking changes', 'opus', 'read:4 search:3 read:4 think:4 read:3'],
      ['bug-fixer', 'Fix the hydration mismatch in CartDrawer', 'sonnet', 'read:5 search:4 edit:6 bash:9 edit:5 bash:10 think:4 bash:8']] },
  { name: 'Hotfix: login redirect loop', model: 'haiku', entry: 'claude-vscode', perm: 'default',
    prompt: 'users get bounced between /login and /account forever, fix it', commit: 'fix(auth): stop the login page from logging in to itself',
    agents: [['Explore', 'Map every redirect to /login', 'haiku', 'search:3 read:3 search:3 read:3 think:2'],
      ['test-runner', 'Reproduce the loop in e2e', 'haiku', 'bash:6 read:3 bash:9 think:3 bash:12 read:4 bash:10']] },
  { name: 'Add dark mode to invoices', model: 'opus', entry: 'claude-desktop', perm: 'acceptEdits', used: 240_000, cost: 9.8,
    prompt: 'invoices should respect dark mode, accountants work at night too', commit: 'feat(invoices): dark mode (accountants rejoice)',
    tools: { edit: 23, bash: 24, read: 97, search: 1, web: 98, agent: 23, mcp: 2, plan: 3, skill: 1, other: 1 },
    agents: [['review-design-fidelity', 'Check invoice contrast in dark mode', 'fable', 'web:5 read:3 web:4 think:3'],
      ['general-purpose', 'Port the invoice PDF styles', 'opus', 'read:5 edit:6 bash:8 edit:6 web:6 edit:5 think:4 bash:8']] },
  { name: 'Kill the last jQuery plugin', model: 'fable', entry: 'cli', perm: 'bypassPermissions',
    prompt: 'remove jquery.datepicker and use the native date input', commit: 'chore: jQuery has left the building',
    agents: [['review-yagni', 'YAGNI: do we even need a datepicker?', 'opus', 'search:3 read:4 think:4 read:3'],
      ['general-purpose', 'Replace every datepicker usage', 'fable', 'search:4 edit:6 edit:5 bash:9 edit:5 bash:8 think:3 edit:6']] },
];

// ---- the harbor ------------------------------------------------------------------------------------------------------
// Vessels. owner: a cast seat whose process tree owns the server (own: it is listed as one of its procs); island: the
// place its cwd resolves to (used only when that island is on the map); repo: named when it is not; when: [from, to]
// loop seconds while listening (default: always); age / idle: how long it has been up / quiet; act(w) -> activity;
// orphan: whoever launched it has exited, and the session named leftBy (ended before the dashboard saw the server) was at
// work in its folder when it started (it drifts off as 'orphaned', that session as its guessed lastOwner).

const DOCKER = { kind: 'docker', pid: 11480, proc: 'com.docker.backend.exe', cmd: 'com.docker.backend.exe services', addrs: ['0.0.0.0', '::', '::1'] };
const HARBOR = [
  { key: 'nuxt', port: 3000, kind: 'node', label: 'Nuxt', proc: 'node.exe', pid: 32460, addrs: ['0.0.0.0', '::'], age: 6 * HOUR,
    cmd: 'node.exe --max-old-space-size=8192 node_modules/nuxt/bin/nuxt.mjs dev', cwd: 'C:\\demo\\storefront-nuxt', island: 'shop',
    act: (w) => (w.busy('checkout', 'bash') || w.crewBusy('checkout', 'bash') || w.present('browser-e2e') ? w.rnd(0.35, 1) : w.blip()) },
  { key: 'vite', port: 5173, kind: 'node', label: 'Vite', proc: 'node.exe', pid: 41876, addrs: ['::1'], age: 50 * MIN, owner: 'billing', own: true,
    cmd: 'node.exe node_modules/vite/bin/vite.js --port 5173', cwd: ANNEX.root,
    act: (w) => (w.recent('billing', 'edit', 4000) ? w.rnd(0.5, 0.9) : w.modeOf('billing') === 'wait' ? w.rnd(0.25, 0.7) : w.blip()) },
  { key: 'next', port: 3001, kind: 'node', label: 'Next', proc: 'node.exe', addrs: ['::'], owner: 'notes', own: true, when: [20, 140],
    cmd: 'node.exe node_modules/next/dist/bin/next dev -p 3001', cwd: 'C:\\demo\\blog',
    act: (w) => (w.busy('notes') ? w.rnd(0.15, 0.6) : w.blip()) },
  { key: 'serve', port: 8123, kind: 'node', label: 'serve.js', proc: 'node.exe', pid: 28572, addrs: ['127.0.0.1'], age: 3 * HOUR, owner: 'weather', own: true,
    cmd: 'node.exe serve.js 8123', cwd: `${SANDBOX}\\tools`,
    act: (w) => (w.busy('weather', 'web') ? w.rnd(0.4, 0.9) : w.blip()) },
  { key: 'browser-sandbox', kind: 'browser', label: 'Headless browser', proc: 'msedge.exe', addrs: ['127.0.0.1'], owner: 'weather', own: true, when: [40, 62],
    cmd: 'msedge.exe --headless=new --remote-debugging-port=0 --user-data-dir=C:\\Users\\demo\\AppData\\Local\\Temp\\weather-cdp --window-size=1280,720 --no-first-run …',
    cwd: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\153.0.4234.48', act: (w) => w.rnd(0.6, 1) },
  { key: 'browser-e2e', kind: 'browser', label: 'Headless browser', proc: 'chrome-headless-shell.exe', addrs: ['127.0.0.1'], owner: 'checkout', when: [95, 115],
    cmd: 'chrome-headless-shell.exe --headless --remote-debugging-port=0 --no-sandbox --user-data-dir=C:\\Users\\demo\\AppData\\Local\\Temp\\playwright_chromiumdev_profile-x9Kq2 …',
    cwd: 'C:\\Users\\demo\\AppData\\Local\\ms-playwright\\chromium_headless_shell-1187\\chrome-win', act: (w) => w.rnd(0.7, 1) },
  { key: 'uvicorn', port: 8000, kind: 'python', label: 'Uvicorn', proc: 'python.exe', pid: 19044, addrs: ['127.0.0.1'], age: 2.5 * HOUR, owner: 'passkeys', own: true,
    cmd: 'python.exe -m uvicorn app.main:app --reload --port 8000', cwd: 'C:\\demo\\monorepo\\services\\auth',
    act: (w) => (w.busy('passkeys', 'bash') ? w.rnd(0.3, 0.8) : w.chance(0.15) ? w.rnd(0.1, 0.3) : 0) },
  { key: 'laravel', port: 8081, kind: 'php', label: 'Laravel', proc: 'php.exe', pid: 7716, addrs: ['127.0.0.1'], age: 11 * HOUR, idle: 9 * HOUR,
    cmd: 'php.exe artisan serve --port=8081', cwd: 'C:\\demo\\legacy-crm', repo: 'legacy-crm', orphan: true, leftBy: 'legacy-crm', act: () => 0 },
  // The rotating seat's Storybook outlives the session that started it (adrift, owner-ended) until it is closed.
  { key: 'storybook', port: 6006, kind: 'node', label: 'Storybook', proc: 'node.exe', pid: 38124, addrs: ['::1'], owner: 'slot', own: true, when: [140, 118],
    cmd: 'node.exe node_modules/storybook/bin/index.cjs dev -p 6006 --no-open', cwd: 'C:\\demo\\storefront-nuxt', island: 'shop',
    act: (w) => (w.recent('slot', 'edit', 5000) ? w.rnd(0.3, 0.7) : w.blip()) },
  // A mock API a session started from a script and left behind: the session had ended before the dashboard saw the
  // server, in a repo nobody has a session in now (adrift, orphaned).
  { key: 'mockapi', port: 3004, kind: 'node', label: 'JSON Server', proc: 'node.exe', pid: 26880, addrs: ['127.0.0.1'], orphan: true, leftBy: 'Mock the payments API', when: [30, 100],
    cmd: 'node.exe node_modules/json-server/lib/bin.js db.json --port 3004', cwd: 'C:\\demo\\shop-rails\\mock', repo: 'shop-rails', act: () => 0 },
  { key: 'mongo', port: 27017, kind: 'db', label: 'Mongo', proc: 'mongod.exe', pid: 5120, addrs: ['127.0.0.1'], age: 26 * HOUR, idle: 2.2 * HOUR,
    cmd: 'mongod.exe --dbpath C:\\data\\db --bind_ip 127.0.0.1', cwd: 'C:\\Program Files\\MongoDB\\Server\\8.0\\bin',
    act: (w) => (w.flags.mongo > w.now ? w.rnd(0.3, 0.7) : 0) },
  { key: 'ollama', port: 11434, kind: 'ai', label: 'Ollama', proc: 'ollama.exe', pid: 14388, addrs: ['127.0.0.1'], age: 30 * HOUR, cpuScale: 4,
    cmd: 'ollama.exe serve', cwd: 'C:\\Users\\demo', island: 'home', act: (w) => (w.busy('screens') || w.seat('screens')?.state === 'thinking' ? w.rnd(0.6, 1) : 0) },
  { key: 'lighthouse', port: 7420, kind: 'lighthouse', label: 'Command & Context', proc: 'node.exe', pid: 13370, addrs: ['127.0.0.1'], age: 4 * MIN,
    cmd: 'node.exe server/index.js', cwd: 'C:\\Users\\demo\\command-and-context', act: (w) => w.rnd(0.02, 0.12) },
  { key: 'laravel-ctr', ...DOCKER, ports: [80, 8080, 5175], label: 'laravel.test', cwd: 'C:\\demo\\storefront', repo: 'storefront', age: 6 * HOUR,
    container: { name: 'storefront-laravel.test-1', image: 'sail-8.4/app', project: 'storefront', status: 'Up 6 hours' }, act: (w) => w.blip() },
  { key: 'pgsql-ctr', ...DOCKER, ports: [5432], label: 'pgsql', cwd: 'C:\\demo\\storefront', repo: 'storefront', age: 6 * HOUR,
    container: { name: 'storefront-pgsql-1', image: 'pgvector/pgvector:pg17', project: 'storefront', status: 'Up 6 hours (healthy)' },
    act: (w) => (w.modeOf('billing') === 'wait' ? w.rnd(0.1, 0.45) : w.blip()) },
  { key: 'redis-ctr', ...DOCKER, ports: [6379], label: 'redis', cwd: 'C:\\demo\\monorepo', island: 'mono', age: 3 * HOUR,
    container: { name: 'monorepo-redis-1', image: 'redis:7-alpine', project: 'monorepo', status: 'Up 3 hours' },
    act: (w) => (w.busy('passkeys') ? w.rnd(0.05, 0.35) : 0) },
  { key: 'supa-db', ...DOCKER, ports: [54322], label: 'supabase_db_demo', cwd: null, age: 50 * HOUR,   // no compose dir: no cwd
    container: { name: 'supabase_db_demo', image: 'public.ecr.aws/supabase/postgres:17.6.1.029', project: 'demo', status: 'Up 2 days (healthy)' },
    act: (w) => (w.busy('passkeys', 'mcp') ? w.rnd(0.2, 0.6) : w.blip()) },
  { key: 'supa-kong', ...DOCKER, ports: [54321], label: 'supabase_kong_demo', cwd: null, age: 50 * HOUR,
    container: { name: 'supabase_kong_demo', image: 'public.ecr.aws/supabase/kong:2.8.1', project: 'demo', status: 'Up 2 days (healthy)' },
    act: (w) => (w.busy('passkeys', 'mcp') ? w.rnd(0.1, 0.4) : w.blip()) },
];
// Extra hull types that only the harbor scene shows (every vessel kind in one frame).
const HARBOR_EXTRA = [
  { key: 'bun', port: 3002, kind: 'bun', label: 'server.ts', proc: 'bun.exe', addrs: ['::'], cmd: 'bun.exe run --hot server.ts', cwd: 'C:\\demo\\monorepo\\apps\\edge', island: 'mono' },
  { key: 'deno', port: 8008, kind: 'deno', label: 'main.ts', proc: 'deno.exe', addrs: ['127.0.0.1'], owner: 'passkeys', own: true,
    cmd: 'deno.exe run -A --watch main.ts', cwd: 'C:\\demo\\monorepo\\tools\\og-images' },
  { key: 'rails', port: 3030, kind: 'ruby', label: 'Rails', proc: 'ruby.exe', addrs: ['127.0.0.1'], cmd: 'ruby.exe bin/rails server -p 3030', cwd: 'C:\\demo\\shop-rails', repo: 'shop-rails' },
  { key: 'java', port: 8085, kind: 'java', label: 'Java', proc: 'java.exe', addrs: ['::'],
    cmd: 'java.exe -jar build/libs/inventory-0.0.1-SNAPSHOT.jar --server.port=8085', cwd: 'C:\\demo\\inventory', repo: 'inventory' },
  { key: 'dotnet', port: 5000, kind: 'dotnet', label: 'Dotnet', proc: 'dotnet.exe', addrs: ['127.0.0.1'], cmd: 'dotnet.exe watch run --urls http://localhost:5000',
    cwd: 'C:\\demo\\ledger-api', repo: 'ledger-api' },
  { key: 'air', port: 8090, kind: 'go', label: 'Go', proc: 'air.exe', addrs: ['::'], cmd: 'air.exe -c .air.toml', cwd: 'C:\\demo\\tiny-cli', repo: 'tiny-cli' },
  { key: 'nginx', port: 8088, kind: 'web', label: 'Web', proc: 'nginx.exe', addrs: ['0.0.0.0'], cmd: 'nginx.exe -p C:\\nginx', cwd: 'C:\\nginx' },
  { key: 'electron', port: 9333, kind: 'app', label: 'App', proc: 'electron.exe', addrs: ['127.0.0.1'], owner: 'passkeys', own: true,
    cmd: 'electron.exe . --inspect=9333', cwd: 'C:\\demo\\monorepo\\apps\\desktop' },
];
const DOCKS = new Map([...HARBOR, ...HARBOR_EXTRA].map((d) => [d.key, d]));
// An orphaned stray's lastOwner: the ended session that probably left it behind (a guess; no building to link to).
function leftBy(d) { return d && d.leftBy ? { key: null, name: d.leftBy, guess: true } : null; }

// ---- the loop script ---------------------------------------------------------------------------------------------------
// [second, action(world, loopIndex)], fired once per loop in order. Agent scripts are "cat:secs" tool calls plus
// think:secs, wait:secs (one long bash call), stall:secs (goes quiet), spawn:secs (launches its apprentice), helper
// (waits for the apprentice). Every agent role, tool category and agent state shows up each loop.

const BEATS = [
  [5, (w) => w.spawn('passkeys', 'Plan', 'Blueprint: passkey rollout in four phases', 'opus', 'read:4 search:3 think:5 plan:3 read:4 plan:3 think:3')],
  [9, (w) => w.spawn('checkout', 'Explore', 'Scout: where checkout state lives', 'haiku', 'search:4 read:3 search:3 read:4 bash:3 read:3 think:2')],
  [10, (w) => w.spawn('billing', 'review-runtime-wiring', 'Wiring review: webhook → ledger', 'opus', 'read:4 search:4 bash:5 read:4 think:3')],
  [12, (w) => w.spawn('passkeys', 'general-purpose', 'Implement the WebAuthn challenge endpoint', 'fable',
    'read:4 edit:5 bash:6 spawn:3 helper edit:5 bash:7 think:3',
    { apprentice: ['Explore', 'Find every call to legacyLogin()', 'haiku', 'search:4 read:3 search:4 read:4 think:2'] })],
  [14, (w) => w.spawn('checkout', 'review-skeptical', 'Skeptic pass: cart race condition', 'opus', 'read:4 read:3 think:4 search:3 bash:6 read:4 think:3')],
  [18, (w) => w.checkout('tiny')],
  [20, (w) => w.spawn('passkeys', 'security-audit', 'Audit session token storage', 'sonnet', 'search:4 read:4 mcp:5 web:5 read:3 stall:22', { fail: true })],
  [20, (w) => w.openPort('next')],
  [25, (w) => w.spawn('jsonflag', 'statusline-setup', 'Statusline: Go version + branch', 'sonnet', 'read:3 edit:4 bash:4 read:2')],
  [30, (w) => w.spawn('checkout', 'test-runner', 'Run the checkout e2e suite 20 times', 'sonnet', 'bash:5 wait:100 read:4 think:2', { wait: {
    detail: 'Run the checkout e2e suite 20 times', proc: ['node', 'node.exe node_modules/@playwright/test/cli.js test checkout --repeat-each=20', 2.6] } })],
  [30, (w) => w.spawn('weather', 'Explore', 'Find the sprite atlas loader', 'haiku', 'search:3 read:4 search:3 read:3')],
  [40, (w) => w.spawn('passkeys', 'review-design-fidelity', 'Pixel-peep the passkey modal', 'fable', 'web:6 read:3 web:5 edit:4 think:3')],
  [40, (w) => w.openPort('browser-sandbox')],
  [40, (w) => w.slotSpawn(1)],
  [42, (w) => w.commit('tiny')],
  [52, (w) => w.push('tiny')],
  [50, (w) => w.slotCommit()],
  [55, (w) => w.spawn('passkeys', 'kraken-wrangler', 'Untangle the auth middleware kraken', 'merc', 'bash:5 read:4 mcp:4 edit:5 bash:6 think:3 read:3')],
  [60, (w) => w.endSlot()],
  [60, (w) => w.pull('mono')],
  [60, (w) => w.spawn('checkout', 'bug-fixer', 'Exterminate the flaky waitForSelector', 'opus', 'read:4 search:3 think:4 edit:5 bash:8 edit:4 bash:6 think:2')],
  [62, (w) => w.closePort('browser-sandbox')],
  [70, (w) => w.spawn('notes', 'claude-code-guide', 'Look up the new /rewind docs', 'haiku', 'web:5 read:4 skill:4 web:4 think:2')],
  [75, (w) => w.commit('shop')],
  [85, (w) => w.push('shop')],
  [90, (w) => w.spawn('screens', 'general-purpose', 'Dedupe screenshots by perceptual hash', 'merc', 'bash:6 read:3 bash:8 think:3 bash:5')],
  [95, (w) => w.commit('blog')],
  [95, (w) => w.openPort('browser-e2e')],
  [98, (w) => w.clear('passkeys')],
  [110, (w) => w.spawn('passkeys', 'review-runtime-wiring', 'Wiring review: recovery codes → API', 'opus', 'read:4 search:3 bash:6 read:4 think:3')],
  [115, (w) => w.closePort('browser-e2e')],
  [128, (w, n) => w.spawn('weather', 'general-purpose', 'Draw 12 cloud sprites (cumulus only)', 'opus', 'edit:5 bash:4 web:5 edit:4 think:3', { fail: n % 3 === 2 })],
  [130, (w) => w.startSlot()],
  [130, (w) => w.spawn('passkeys', 'recon-capability', 'Recon: which browsers support conditional UI?', 'sonnet', 'web:6 web:5 search:3 mcp:4 think:3')],
  [140, (w) => w.closePort('next')],
  [140, (w) => w.restartPort('vite')],
  // still tagging when its commander hands back control at 160 s: turn_done with agentsRunning > 0
  [145, (w) => w.spawn('screens', 'general-purpose', 'Tag every screenshot with what it shows', 'merc', 'bash:6 read:4 bash:8 mcp:5 bash:6 think:3')],
  [150, (w) => w.compact(w.seat('checkout'))],
  [150, (w) => w.commit('annex')],
  [160, (w) => w.push('annex')],
  [150, (w) => w.slotSpawn(0)],
  [160, (w) => w.spawn('checkout', 'review-house-conventions', 'Etiquette pass on checkout tests', 'sonnet', 'read:5 search:3 read:4 think:3 edit:3 read:3')],
  [165, (w) => w.spawn('billing', 'review-yagni', 'YAGNI sweep: webhook retry layer', 'opus', 'read:4 search:3 read:4 think:5 edit:4 read:3')],
  [170, (w, n) => { if (n === 0) w.flags.mongo = w.now + 6000; }],   // once: the long-idle database wakes up (fresh paint)
  [172, (w) => w.commit('mono')],
  // Harbor strays: the slot's Storybook is left behind at 60 s and closed at 118 s; a mock API nobody started.
  [30, (w) => w.openPort('mockapi')],
  [100, (w) => w.closePort('mockapi')],
  [118, (w) => w.closePort('storybook')],
  [140, (w) => w.openPort('storybook')],
  // Git work trees (edits dirty them as they happen; commits stack crates that pushes carry off).
  [20, (w, n) => { if (n % 2) w.push('mono'); }],
  [45, (w) => w.stash('tiny', 1)],
  [80, (w) => w.stash('tiny', -1)],
  [96, (w) => w.mergeStart('blog', 2)],          // conflicts: the tree catches fire
  [110, (w) => w.resolve('blog')],
  [118, (w) => w.merge('blog', 'draft/v2.4-notes')],
  [132, (w) => w.push('blog')],
  [100, (w) => w.fetch('mono')],
  [108, (w) => w.rebaseStart('mono')],
  [114, (w) => w.conflictsAt('mono', 1)],
  [128, (w) => w.resolve('mono')],
  [138, (w) => w.rebaseDone('mono')],
  // Pull requests.
  [88, (w) => w.pr('checkout', 'created')],
  [120, (w, n) => { if (n % 3 === 1) w.pr('passkeys', 'merged'); }],
  [163, (w) => w.pr('billing', 'created')],
];

const MESSAGES = {
  shop: ['test(checkout): stop racing the payment iframe (it was winning)', 'fix: await the thing we were not awaiting',
    'fix(ci): the flaky test was flaky because of another flaky test', "perf: remove the sleep(2000) that 'fixed' things in 2021"],
  annex: ['refactor(billing): webhooks are idempotent now, like my coffee order', 'refactor(billing): one webhook handler to rule them all',
    'test(billing): replay every Stripe event twice, just to be sure'],
  blog: ['docs: release notes for v2.4 (now with 30% fewer typos)', 'docs: explain the export button to actual humans', 'style: two spaces. TWO.'],
  tiny: ['feat: --json flag, for the robots', 'fix: off-by-one in the off-by-one fix', 'chore: gofmt ate my alignment and I respect it'],
  mono: ['feat(auth): passkeys, because passwords were a mistake', 'feat(auth): recovery codes, for when your phone falls in a lake',
    'chore: delete 400 lines nobody called (checked twice)', 'revert: revert "revert: fix typo"'],
  pull: ['Merge pull request #4821 from acme/renovate/all-minor', "Merge branch 'main' into feat/passkeys", 'Merge pull request #4830 from acme/fix/ci-cache'],
};
const AUTHORS = ['Sam Rivera', 'Alex Kim', 'Jordan Lee', 'Priya Natarajan'];

// ---- the simulation --------------------------------------------------------------------------------------------------------

class World {
  constructor(epoch) {
    this.R = rng(SEED);
    this.epoch = epoch;                                  // sim time of loop 0, second 0 (the first snapshot)
    this.now = epoch;
    this.places = JSON.parse(JSON.stringify(PLACES));   // git stats grow per world
    this.sessions = [];
    this.ports = [];
    this.events = [];
    this.seq = 0;
    this.steps = 0;
    this.budget = 0;
    this.slots = 0;
    this.slot = null;
    this.cursor = {};                                    // per-list message cursors
    this.flags = {};                                     // short scripted flags (e.g. a one-off database burst)
    this.cpu = 0.24;
    this.mem = 0.64;
    this.G = rng(SEED ^ 0x5eed91);                       // git work-tree noise, on a stream of its own
    this.gitst = JSON.parse(JSON.stringify(GIT0));       // work-tree state per repo place (see GIT0)
    this.pushedRefs = new Set(['tiny:main', 'blog:main', 'mono:feat/passkeys', 'shop:fix/flaky-checkout']);
    this.unpushed = {};
    this.prNo = 4830;
  }

  // -- randomness (only ever consumed inside steps, so snapshots never perturb the world)
  rnd(a, b) { return a + (b - a) * this.R(); }
  int(a, b) { return a + Math.floor(this.R() * (b - a + 1)); }
  chance(p) { return this.R() < p; }
  pick(arr) { return arr[Math.floor(this.R() * arr.length)]; }
  hex(n) { let s = ''; while (s.length < n) s += Math.floor(this.R() * 16).toString(16); return s; }
  uuid() {
    const h = this.hex(32);
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${'89ab'[this.int(0, 3)]}${h.slice(17, 20)}-${h.slice(20)}`;
  }
  weighted(mix) {
    let r = this.R() * total(mix);
    for (const k in mix) if ((r -= mix[k]) < 0) return k;
    return Object.keys(mix)[0];
  }

  // -- clock
  loopSec(t = this.now) { return ((((t - this.epoch) % LOOP) + LOOP) % LOOP) / 1000; }
  loopIndex(t = this.now) { return Math.floor((t - this.epoch) / LOOP); }

  // Build the standing world a minute before the first snapshot and simulate that minute silently.
  start() {
    this.now = this.epoch - WARMUP;
    for (const d of CAST) this.addSession(d, this.now);
    const sec = this.loopSec();
    for (const d of HARBOR) if (!d.when || within(d.when, sec)) this.openPort(d.key, true, d.when ? (sec - d.when[0]) * 1000 : 0);
    this.advance(WARMUP);
    // Park the counters just under the module thresholds (see CAST) so loop one visibly builds.
    for (const s of this.sessions) {
      if (s.def.tools) { s.tools = { ...zeroTools(), ...s.def.tools }; s.toolTotal = total(s.tools); }
      s.opening = [...(s.def.opening || [])];
    }
    return this;
  }

  advance(ms) {
    this.budget += ms;
    while (this.budget >= STEP) { this.budget -= STEP; this.step(); }
  }

  step() {
    const prev = this.now;
    this.now += STEP;
    const n0 = this.loopIndex(prev), n1 = this.loopIndex();
    const a = this.loopSec(prev) * 1000, b = this.loopSec() * 1000;
    if (n0 === n1) this.fire(n1, a, b);
    else { this.fire(n0, a, LOOP); this.fire(n1, -1, b); }
    for (const s of this.sessions) this.tickSession(s, b / 1000, n1);
    for (const s of this.sessions) for (const ag of s.agents) this.tickAgent(ag);
    if (++this.steps % 4 === 0) this.tickSecond();
  }

  fire(n, from, to) {
    for (const [at, fn] of BEATS) if (at * 1000 > from && at * 1000 <= to) fn(this, n);
  }

  event(type, payload) {
    this.events.push({ id: ++this.seq, t: this.now, type, ...payload });
    if (this.events.length > 120) this.events.splice(0, this.events.length - 120);
  }

  seat(id) { return this.sessions.find((s) => s.id === id && !s.endedAt) || null; }

  // -- sessions

  addSession(def, at) {
    const model = MODEL[def.model];
    const startedAt = Math.round(at - (def.age || 0));
    const s = {
      def, id: def.id, place: def.place, work: def.annex ? 'annex' : def.place, annex: !!def.annex,
      key: def.entry === 'claude-desktop' ? `local_${this.uuid()}` : `pid:${def.pid}:${startedAt}`,
      sessionId: this.uuid(), pid: def.pid, name: def.name,
      cwd: def.annex ? ANNEX.root : this.places[def.place].root, entrypoint: def.entry, permissionMode: def.perm ?? null, model,
      state: null, stateSince: at, tool: null, lastTool: null, lastActivity: at, startedAt, endedAt: 0, lastPrompt: def.prompt || null,
      used: def.used ?? 21_000, compactions: def.compactions || 0, lastCompaction: null, clears: def.clears || 0,
      tools: { ...zeroTools(), ...def.tools }, toolTotal: 0,
      spent: { usd: def.cost || 0, added: def.added || 0, removed: def.removed || 0 },
      priced: !!PRICE[factionOf(model)], costShown: def.cost != null,
      agentsDone: def.agentsDone || 0, agents: [], procs: [],
      plan: def.plan, mix: def.mix, shell: def.shell || 'Bash', ctxRate: def.ctxRate || 700, sleepAge: def.sleepAge || 3 * HOUR,
      mode: null, busyUntil: 0, ctxAt: at, ctxWarned: false, callProc: null, opening: [],
    };
    s.toolTotal = total(s.tools);
    s.ctxWarned = s.used / contextMax(model, s.used) > 0.8;
    this.sessions.push(s);
    return s;
  }

  tickSession(s, sec, n) {
    if (s.endedAt) return;
    const seg = s.plan.find((p) => within(p, sec)) || [0, 0, 'idle'];
    if (seg[2] !== s.mode) {
      const fresh = s.mode == null;
      const start = fresh ? this.now - ((sec - seg[0] + 180) % 180) * 1000 : this.now;   // new seats look lived-in
      this.enter(s, seg, n, start);
      if (fresh) s.stateSince = start;
    }
    if (s.mode === 'work' && this.now >= s.busyUntil) this.act(s);
    else if (s.mode === 'wait' && s.state === 'working' && this.now - s.tool.since > WAITING_AFTER) this.setState(s, 'waiting');
  }

  enter(s, [, , mode, opt = {}], n, start) {
    const now = this.now;
    this.endCall(s);
    this.accrue(s);
    s.mode = mode;
    switch (mode) {
      case 'work': s.tool = null; this.act(s); break;
      case 'think': s.tool = null; s.lastActivity = now; this.setState(s, 'thinking', start); break;
      case 'wait':
        this.call(s, { name: opt.name || s.shell, cat: 'bash', detail: opt.detail, since: start }, opt.proc);
        s.lastActivity = start;
        this.setState(s, now - start > WAITING_AFTER ? 'waiting' : 'working', start);
        break;
      case 'ask': {   // alternate the two question tools between loops
        const [name, detail] = n % 2 ? ['ExitPlanMode', 'plan ready for review'] : ['AskUserQuestion', 'has a question for you'];
        this.call(s, { name, cat: 'plan', detail, since: start });
        s.lastActivity = start;
        this.setState(s, 'needs_input', start);
        break;
      }
      case 'idle': s.tool = null; this.setState(s, 'idle', start); break;
      case 'asleep': s.tool = null; s.lastActivity = now - s.sleepAge; this.setState(s, 'asleep', start); break;
    }
  }

  // State changes announce themselves exactly like the collector: needs_input, asleep, wake after asleep, and
  // turn_done when the main agent hands control back (busy -> idle after at least 4 s of work: "your move").
  setState(s, st, at = this.now) {
    if (s.state === st) return;
    const prev = s.state;
    const busy = (x) => x === 'working' || x === 'thinking' || x === 'waiting';
    if (busy(st) && !busy(prev)) s.busySince = at;
    s.state = st;
    s.stateSince = at;
    if (!prev) return;
    if (st === 'needs_input') this.event('needs_input', { key: s.key, name: s.name, detail: s.tool && s.tool.detail });
    else if (st === 'asleep') this.event('asleep', { key: s.key, name: s.name });
    else if (prev === 'asleep' && st !== 'ended') this.event('wake', { key: s.key, name: s.name });
    if (busy(prev) && st === 'idle' && s.busySince) {
      const secs = Math.round((at - s.busySince) / 1000);
      if (secs >= 4) this.event('turn_done', { key: s.key, name: s.name, secs, agentsRunning: s.agents.filter((a) => ACTIVE.has(a.state)).length });
    }
  }

  // One beat of work mode: the next tool call, or a short thinking pause between calls.
  act(s) {
    const now = this.now;
    this.endCall(s);
    this.accrue(s);
    s.lastActivity = now;
    if (s.tool && this.chance(0.22)) {
      s.tool = null;
      this.setState(s, 'thinking');
      s.busyUntil = now + this.rnd(2000, 5000);
      return;
    }
    const cat = s.opening.length ? s.opening.shift() : this.weighted(s.mix);
    const t = this.toolFor(cat, s.work, s.shell);
    this.call(s, { name: t.name, cat, detail: t.detail, since: now }, t.proc);
    this.setState(s, 'working');
    s.busyUntil = now + this.rnd(...DUR[cat]) * 1000;
  }

  toolFor(cat, work, shell) {
    const item = this.pick(WORK[work]?.[cat] || GENERIC[cat]);
    if (Array.isArray(item)) return { name: item[0], detail: item[1], proc: null };
    const detail = item.d ?? item;
    let name = 'Bash';
    switch (cat) {
      case 'edit': name = this.chance(0.2) ? 'Write' : 'Edit'; break;
      case 'bash': name = shell; break;
      case 'read': name = 'Read'; break;
      case 'search': name = detail.startsWith('/') ? 'Grep' : 'Glob'; break;
      case 'web': name = /\s/.test(detail) ? 'WebSearch' : 'WebFetch'; break;
      case 'skill': name = 'Skill'; break;
    }
    return { name, detail, proc: item.proc || null };
  }

  call(s, tool, proc) {
    s.tool = tool;
    s.tools[tool.cat]++;
    s.toolTotal++;
    s.lastTool = { name: tool.name, cat: tool.cat, detail: tool.detail, at: tool.since };
    if (tool.cat === 'edit') { s.spent.added += this.int(2, 40); s.spent.removed += this.int(0, 22); this.touch(s.work, tool.name === 'Write'); }
    if (s.priced && s.toolTotal >= 3) s.costShown = true;   // cost lines appear once a session gets going
    if (proc) s.callProc = this.addProc(s, proc, tool.since);
  }

  endCall(s) {
    if (s.callProc) { this.dropProc(s, s.callProc); s.callProc = null; }
  }

  // Context grows while a session is busy (capped per beat so a long wait does not dump a minute in at once).
  accrue(s) {
    const dt = Math.min(20, (this.now - s.ctxAt) / 1000);
    s.ctxAt = this.now;
    if (dt > 0 && BUSY_MODES.has(s.mode)) this.addContext(s, s.ctxRate * dt * this.rnd(0.6, 1.4));
  }

  addContext(s, inc) {
    s.used = Math.min(s.used + inc, contextMax(s.model, s.used) * 0.985);
    if (s.priced) s.spent.usd += inc * PRICE[factionOf(s.model)];
    const pct = s.used / contextMax(s.model, s.used);
    if (pct > 0.8 && !s.ctxWarned) {
      s.ctxWarned = true;
      this.event('context_high', { key: s.key, name: s.name, pct: Math.round(pct * 100) });
    } else if (pct < 0.6) s.ctxWarned = false;
    if (pct > 0.95) this.compact(s);   // auto-compact, as Claude Code does near the limit
  }

  compact(s, trigger = 'auto') {
    if (!s || s.used < contextMax(s.model, s.used) * 0.6) return;
    const pre = Math.round(s.used), post = Math.round(pre * this.rnd(0.09, 0.13));
    s.used = post;
    s.compactions++;
    s.lastCompaction = { at: this.now, pre, post, trigger };
    if (post / contextMax(s.model, post) < 0.6) s.ctxWarned = false;
    this.event('compaction', { key: s.key, name: s.name, pre, post, trigger });
  }

  // /clear: same building (key), new transcript (sessionId): counters and context start over; agents stay listed.
  clear(id) {
    const s = this.seat(id);
    if (!s) return;
    const from = s.sessionId;
    Object.assign(s, {
      sessionId: this.uuid(), used: this.rnd(16_000, 22_000), compactions: 0, lastCompaction: null, tools: zeroTools(), toolTotal: 0,
      lastTool: null, spent: { usd: 0, added: 0, removed: 0 }, costShown: false, ctxWarned: false,
      lastPrompt: CLEAR_PROMPTS[s.clears % CLEAR_PROMPTS.length],
    });
    s.clears++;
    this.event('clear', { key: s.key, name: s.name, from, to: s.sessionId });
  }

  addProc(s, [name, cmd, cpu], since = this.now) {
    const p = { pid: this.int(2000, 60000), name, cmd, base: cpu, cpu: cpu * this.rnd(0.7, 1.2), since };
    s.procs.push(p);
    return p;
  }

  dropProc(s, p) { s.procs = s.procs.filter((x) => x !== p); }

  // -- the rotating seat

  startSlot() {
    const i = this.slots++;
    const tpl = SLOTS[i % SLOTS.length];
    const def = { id: 'slot', place: 'shop', pid: 43000 + ((i * 7919) % 20000), ctxRate: 800, plan: SLOT_PLAN, mix: SLOT_MIX, ...tpl };
    const s = this.addSession(def, this.now);
    this.slot = s;
    this.event('session_start', { key: s.key, name: s.name, cwd: s.cwd });
  }

  slotSpawn(i) {
    const s = this.slot;
    if (s && !s.endedAt) this.spawn(s, ...s.def.agents[i]);
  }

  slotCommit() {
    const s = this.slot;
    if (s && !s.endedAt && s.mode === 'work') this.commit('shop', s.def.commit);
  }

  endSlot() {
    const s = this.slot;
    if (!s || s.endedAt) return;
    this.endCall(s);
    s.endedAt = this.now;
    s.tool = null;
    s.procs = [];
    this.setState(s, 'ended');
    this.event('session_end', { key: s.key, name: s.name });
    for (const a of s.agents) if (!a.endedAt) this.finish(a, 'lost');
  }

  // -- agents

  // The session issues an Agent call (the Barracks door flaps) and a worker walks out.
  spawn(id, role, desc, model, steps, opt) {
    const s = typeof id === 'string' ? this.seat(id) : id;
    if (!s || s.endedAt || s.mode !== 'work') return null;
    this.endCall(s);
    this.accrue(s);
    this.call(s, { name: 'Agent', cat: 'agent', detail: desc, since: this.now });
    this.setState(s, 'working');
    s.lastActivity = this.now;
    s.busyUntil = this.now + this.rnd(2000, 3200);
    return this.addAgent(s, role, desc, model, steps, opt);
  }

  makeAgent(s, role, desc, modelKey, parent = null) {
    const model = MODEL[modelKey] || s.model;
    const a = {
      id: `a${this.hex(16)}`, type: role, description: desc, model, state: null, stateSince: this.now, tool: null,
      startedAt: this.now, lastActivity: this.now, endedAt: 0, depth: parent ? 2 : 1, parent: parent ? parent.id : null,
      background: !parent, context: this.rnd(12_000, 22_000), tools: 0,
      session: s, steps: [], idx: -1, stepEnd: 0, fail: false, kids: [], proc: null, wait: null, apprentice: null,
    };
    s.agents.push(a);
    return a;
  }

  addAgent(s, role, desc, modelKey, steps, opt = {}) {
    const a = this.makeAgent(s, role, desc, modelKey, opt.parent);
    a.steps = steps.split(' ').map((x) => { const [kind, secs] = x.split(':'); return { kind, secs: +secs || 0 }; });
    a.fail = !!opt.fail;
    a.wait = opt.wait || null;
    a.apprentice = opt.apprentice || null;
    this.event('agent_spawn', { key: s.key, agent: a.id, agentType: role, description: desc });
    this.nextStep(a);
    return a;
  }

  agentState(a, st) {
    if (a.state !== st) { a.state = st; a.stateSince = this.now; }
  }

  tickAgent(a) {
    if (a.endedAt) return;
    const st = a.steps[a.idx];
    if (st && st.kind === 'helper' && a.kids.every((k) => k.endedAt)) a.stepEnd = this.now;
    while (!a.endedAt && this.now >= a.stepEnd) this.nextStep(a);
    if (!a.endedAt && a.steps[a.idx].kind === 'wait' && a.state === 'working' && this.now - a.tool.since > WAITING_AFTER) this.agentState(a, 'waiting');
  }

  nextStep(a) {
    const now = this.now, s = a.session;
    if (a.proc) { this.dropProc(s, a.proc); a.proc = null; }
    const st = a.steps[++a.idx];
    if (!st) return this.finish(a, a.fail ? 'failed' : 'done');
    // Long calls are never shortened below their script (a 'wait' must outlast 90 s to read as waiting).
    a.stepEnd = now + st.secs * 1000 * (st.kind === 'wait' ? this.rnd(1, 1.15) : this.rnd(0.8, 1.25));
    switch (st.kind) {
      case 'think':
        a.tool = null; a.lastActivity = now; a.context += this.rnd(800, 2500);
        this.agentState(a, 'thinking');
        break;
      case 'stall':   // no progress for ages: the collector calls that 'stalled' and keeps showing the last call
        a.lastActivity = now - 10.5 * MIN;
        this.agentState(a, 'stalled');
        break;
      case 'helper':
        a.stepEnd = Infinity;
        a.tool = { name: 'Agent', cat: 'agent', detail: `waiting on ${a.kids.length} helper${a.kids.length > 1 ? 's' : ''}`, since: now };
        this.agentState(a, 'waiting');
        break;
      case 'spawn': {
        const [role, desc, model, steps] = a.apprentice;
        a.tool = { name: 'Agent', cat: 'agent', detail: desc, since: now };
        a.tools++;
        a.lastActivity = now;
        this.agentState(a, 'working');
        a.kids.push(this.addAgent(s, role, desc, model, steps, { parent: a }));
        break;
      }
      default: {   // a tool call; 'wait' is one long bash call
        const cat = st.kind === 'wait' ? 'bash' : st.kind;
        const t = st.kind === 'wait' && a.wait ? { name: s.shell, detail: a.wait.detail, proc: a.wait.proc } : this.toolFor(cat, s.work, s.shell);
        a.tool = { name: t.name, cat, detail: t.detail, since: now };
        a.tools++;
        a.lastActivity = now;
        a.context += AGENT_CTX[cat] * this.rnd(0.5, 1.5);
        if (cat === 'edit') this.touch(s.work, t.name === 'Write');
        if (t.proc) a.proc = this.addProc(s, t.proc, now);
        this.agentState(a, 'working');
      }
    }
  }

  finish(a, state) {
    if (a.proc) { this.dropProc(a.session, a.proc); a.proc = null; }
    a.tool = null;
    this.agentState(a, state);
    a.endedAt = this.now;
    a.session.agentsDone++;
    this.event(state === 'done' ? 'agent_done' : 'agent_failed', { key: a.session.key, agent: a.id, agentType: a.type, description: a.description });
  }

  // -- git

  commit(place, msg) {
    const annex = place === 'annex';
    const p = this.places[annex ? 'shop' : place];
    p.git.commits++;
    this.grow(p, this.int(0, 2));
    this.event('commit', {
      island: p.id, annex: annex ? ANNEX.id : null, name: annex ? ANNEX.name : p.name, msg: msg || this.nextOf(place),
      author: this.pick(AUTHORS), hash: this.hex(7), branch: annex ? ANNEX.branch : p.git.branch,
    });
    this.unpushed[place] = (this.unpushed[place] || 0) + 1;
    this.committed(place);
  }

  // The remote-tracking ref catches up with HEAD, like the collector's push: everything committed since the last
  // push ships at once. A branch's first push is its maiden voyage (newBranch).
  push(place) {
    const annex = place === 'annex';
    const p = this.places[annex ? 'shop' : place];
    const branch = annex ? ANNEX.branch : p.git.branch;
    const ref = `${place}:${branch}`, newBranch = !this.pushedRefs.has(ref);
    this.pushedRefs.add(ref);
    const g = this.gitst[place];
    const count = Math.max(1, this.unpushed[place] || 0, g ? g.ahead : 0);
    this.unpushed[place] = 0;
    if (g) this.gitSet(place, { ahead: 0 });   // the crates leave with the push
    this.event('push', { island: p.id, annex: annex ? ANNEX.id : null, name: annex ? ANNEX.name : p.name, remote: 'origin', branch, hash: this.hex(7), count, newBranch });
  }

  // Concludes the merge begun by mergeStart (a merge commit).
  merge(place, from) {
    const p = this.places[place];
    p.git.commits++;
    this.event('merge', { island: p.id, annex: null, name: p.name, msg: `Merge branch '${from}' into ${p.git.branch}`, from, hash: this.hex(7), branch: p.git.branch });
    this.gitSet(place, { op: null, conflicts: 0 });
    this.committed(place);
  }

  pull(place) {
    const p = this.places[place];
    p.git.commits += this.int(3, 9);
    this.grow(p, this.int(0, 6));
    this.event('pull', { island: p.id, annex: null, name: p.name, msg: this.nextOf('pull'), hash: this.hex(7), branch: p.git.branch });
    if (this.gitst[place]) this.gitSet(place, { behind: 0 });
  }

  // -- git work trees (Island.git.status and annexes[].status)

  gitSet(place, patch) {
    const g = this.gitst[place];
    if (!g) return;
    Object.assign(g, patch);
    g.staged = clamp(g.staged, 0, g.tracked);
    g.changed = this.now;
  }

  // An edit in a work tree: another shirt on the line now and then (Write can add an untracked file).
  touch(place, write) {
    const g = this.gitst[place];
    if (!g || g.op) return;
    const r = this.G();
    if (write && r < 0.35 && g.untracked < 4) this.gitSet(place, { untracked: g.untracked + 1 });
    else if (r < 0.55 && g.tracked < 12) this.gitSet(place, { tracked: g.tracked + 1, staged: g.staged + (this.G() < 0.3 ? 1 : 0) });
  }

  // A commit takes the staged files (at least one) and leaves a crate for the next push.
  committed(place) {
    const g = this.gitst[place];
    if (!g) return;
    const n = Math.max(g.staged, Math.min(g.tracked, 2 + Math.floor(this.G() * 4)));
    this.gitSet(place, { tracked: g.tracked - n, staged: 0, untracked: g.untracked - (g.untracked && this.G() < 0.5 ? 1 : 0), ahead: g.ahead + 1 });
  }

  stash(place, d) {
    const g = this.gitst[place];
    if (!g) return;
    if (d > 0) this.gitSet(place, { stash: g.stash + 1, tracked: 0, staged: 0 });
    else if (g.stash > 0) this.gitSet(place, { stash: g.stash - 1, tracked: g.tracked + 2 + Math.floor(this.G() * 3) });
  }

  fetch(place) {
    const g = this.gitst[place];
    if (g) this.gitSet(place, { behind: g.behind + 2 + Math.floor(this.G() * 3) });
  }

  // Conflicted paths appear: the `conflict` event fires when they go from none to some, like the server's.
  conflictsAt(place, n) {
    const g = this.gitst[place];
    if (!g) return;
    const before = g.conflicts;
    this.gitSet(place, { conflicts: n });
    if (!before && n > 0) {
      const annex = place === 'annex';
      const p = this.places[annex ? 'shop' : place];
      this.event('conflict', { island: p.id, annex: annex ? ANNEX.id : null, name: annex ? ANNEX.name : p.name, count: n });
    }
  }

  mergeStart(place, conflicts) {
    const g = this.gitst[place];
    if (!g) return;
    const clean = 1 + Math.floor(this.G() * 3);   // files that merged cleanly are staged
    this.gitSet(place, { op: 'merge', tracked: g.tracked + clean, staged: g.staged + clean });
    this.conflictsAt(place, conflicts);
  }

  // Conflicts fixed and added: they become staged changes.
  resolve(place) {
    const g = this.gitst[place];
    if (g) this.gitSet(place, { tracked: g.tracked + g.conflicts, staged: g.staged + g.conflicts, conflicts: 0 });
  }

  rebaseStart(place) { this.gitSet(place, { op: 'rebase' }); }

  rebaseDone(place) {
    const g = this.gitst[place];
    if (g) this.gitSet(place, { op: null, conflicts: 0, tracked: g.tracked - g.staged, staged: 0, behind: 0 });
  }

  viewStatus(place) {
    const g = this.gitst[place];
    if (!g) return null;
    const branch = place === 'annex' ? ANNEX.branch : this.places[place].git.branch;
    const up = this.pushedRefs.has(`${place}:${branch}`);
    // Polled every 15 s (staggered per tree), and a change shows at once.
    const phase = (Object.keys(GIT0).indexOf(place) * 3100) % 15_000;
    const polled = this.now - (((this.now - this.epoch + phase) % 15_000) + 15_000) % 15_000;
    return {
      dirty: g.tracked + g.untracked + g.conflicts, staged: g.staged, untracked: g.untracked, conflicts: g.conflicts,
      ahead: up ? g.ahead : null, behind: up ? g.behind : null, stash: g.stash, op: g.op, at: Math.max(polled, g.changed || 0),
    };
  }

  // -- pull requests

  pr(id, action) {
    const s = this.seat(id);
    const repo = s && GITHUB[s.place];
    if (!repo) return;
    const number = ++this.prNo;
    this.event('pr', {
      key: s.key, island: this.places[s.place].id, annex: s.annex ? ANNEX.id : null, name: s.name,
      number, url: `https://github.com/${repo}/pull/${number}`, action, repo,
    });
  }

  checkout(place) {
    const p = this.places[place];
    const from = p.git.branch, to = from === 'main' ? 'feat/json-output' : 'main';
    p.git.branch = to;
    this.event('checkout', { island: p.id, annex: null, name: p.name, from, to, branch: to });
  }

  grow(p, files) {   // new files, but never enough to change the island's tier mid-demo
    const tier = tierOf(p);
    p.git.files += files;
    if (tierOf(p) !== tier) p.git.files -= files;
  }

  nextOf(list) {
    const i = (this.cursor[list] = (this.cursor[list] ?? -1) + 1);
    return MESSAGES[list][i % MESSAGES[list].length];
  }

  // -- ports

  openPort(key, quiet = false, ago = 0) {
    const d = DOCKS.get(key);
    const port = d.port ?? d.ports?.[0] ?? this.int(49200, 65000);
    const owner = d.owner ? this.seat(d.owner) : null;
    const since = this.now - (d.age ?? ago);
    const p = {
      key, def: d, id: d.container ? `ctr:${d.container.name}` : String(port), port, ports: d.ports ? [...d.ports] : [port],
      addrs: [...d.addrs], pid: d.pid || this.int(2000, 60000), proc: d.proc, kind: d.kind, label: d.label, cmd: d.cmd, cwd: d.cwd,
      owner: owner ? owner.key : null, container: d.container ? { ...d.container } : null,
      activity: 0, conns: 0, lastActive: this.now - (d.idle || 0), since, restarts: 0, cpu: 0,
      repo: d.repo || null, island: d.island ? this.places[d.island].id : null,
      lastOwner: owner ? { key: owner.key, name: owner.name, guess: false } : null, adrift: null, driftCand: null,
    };
    // A stray already there when the dashboard started: adrift since its first probe, and never announced.
    if (quiet && d.orphan) p.adrift = { since: this.epoch - 5 * MIN + 2500, reason: 'orphaned', lastOwner: leftBy(d) };
    this.ports.push(p);
    if (d.own && owner) owner.procs.push({ port: p, name: d.proc.replace(/\.exe$/i, ''), since });
    if (!quiet) this.event('port_open', { port, portId: p.id });
    return p;
  }

  closePort(key) {
    const p = this.ports.find((x) => x.key === key);
    if (!p) return;
    this.ports = this.ports.filter((x) => x !== p);
    for (const s of this.sessions) s.procs = s.procs.filter((x) => x.port !== p);
    this.event('port_close', { port: p.port, portId: p.id, label: p.label });
  }

  restartPort(key) {   // same port, new process: the boat refuels
    const p = this.ports.find((x) => x.key === key);
    if (!p) return;
    p.restarts++;
    p.pid = this.int(2000, 60000);
    for (const s of this.sessions) for (const x of s.procs) if (x.port === p) x.since = this.now;
  }

  // Activity helpers for HARBOR act() functions.
  busy(id, cat) { const s = this.seat(id); return !!s && (s.state === 'working' || s.state === 'waiting') && (!cat || s.tool?.cat === cat); }
  crewBusy(id, cat) { const s = this.seat(id); return !!s && s.agents.some((a) => !a.endedAt && a.state !== 'stalled' && a.tool?.cat === cat); }
  recent(id, cat, ms) { const s = this.seat(id); return !!s?.lastTool && s.lastTool.cat === cat && this.now - s.lastTool.at < ms; }
  modeOf(id) { return this.seat(id)?.mode; }
  present(key) { return this.ports.some((p) => p.key === key); }
  blip() { return this.chance(0.08) ? this.rnd(0.07, 0.2) : this.rnd(0, 0.03); }

  // Adrift, like the collector: a port remembers its last live owner; once that session has ended (owner-ended),
  // or for a stray an already ended session left behind (orphaned), it is flagged after two probes (~5 s). `since` is when
  // the owner ended, or when the stray was first seen.
  drift(p) {
    if (p.kind === 'lighthouse') return;
    const o = p.owner ? this.sessions.find((s) => s.key === p.owner) : null;
    if (o && !o.endedAt) { p.lastOwner = { key: o.key, name: o.name, guess: false }; p.adrift = null; p.driftCand = null; return; }
    const reason = p.lastOwner ? 'owner-ended' : p.def.orphan ? 'orphaned' : null;
    if (!reason) { p.adrift = null; p.driftCand = null; return; }
    if (p.adrift) return;
    if (!p.driftCand) p.driftCand = { at: reason === 'owner-ended' && o ? o.endedAt : this.now, seen: this.now };
    if (this.now - p.driftCand.seen < 5000) return;
    const lastOwner = reason === 'owner-ended' ? { ...p.lastOwner } : leftBy(p.def);
    p.adrift = { since: p.driftCand.at, reason, lastOwner };
    this.event('port_adrift', { port: p.port, portId: p.id, label: p.label, reason, lastOwner });
  }

  // Once a second: vessel activity, process load, machine weather, and tidying of the listings.
  tickSecond() {
    const now = this.now;
    for (const p of this.ports) this.drift(p);
    for (const p of this.ports) {
      const d = p.def;
      const a = clamp(d.act ? d.act(this) : 0, 0, 1);
      p.activity = a;
      if (d.kind === 'lighthouse') p.conns = this.chance(0.15) ? 2 : 1;   // this dashboard (and sometimes a second screen)
      else if (d.kind === 'browser') p.conns = 1;
      else p.conns = a > 0.06 ? this.int(1, Math.max(1, Math.round(a * 5))) : 0;
      if (a > 0.06) p.lastActive = now;
      p.cpu = d.kind === 'docker' ? a * 0.25 : 0.004 + a * (d.cpuScale || 0.35);
    }
    let cores = 0;
    for (const s of this.sessions) {
      for (const x of s.procs) {
        if (!x.port) x.cpu = x.base * this.rnd(0.6, 1.3);
        cores += x.port ? x.port.cpu : x.cpu;
      }
    }
    for (const p of this.ports) if (!p.owner) cores += p.cpu;
    const busy = this.sessions.filter((s) => s.state === 'working' || s.state === 'waiting').length;
    this.cpu = clamp(0.05 + (cores / 16) * 0.6 + busy * 0.025 + this.rnd(-0.02, 0.02), 0.02, 0.97);
    this.mem = clamp(0.63 + 0.06 * Math.sin((now - this.epoch) / 170_000) + this.rnd(-0.01, 0.01), 0.3, 0.95);
    this.sessions = this.sessions.filter((s) => !s.endedAt || now - s.endedAt < ENDED_LINGER);
    for (const s of this.sessions) s.agents = s.agents.filter((a) => !a.endedAt || now - a.endedAt < AGENT_LINGER);
  }

  // -- snapshot (reads the world, never changes it)

  snapshot(demo, events) {
    const live = new Map(this.sessions.map((s) => [s.key, s]));
    const islands = new Map();
    for (const s of this.sessions) {
      const p = this.places[s.place];
      let isl = islands.get(p.id);
      if (!isl) {
        isl = { id: p.id, name: p.name, kind: p.kind, root: p.root, tier: tierOf(p), git: p.git && { ...p.git, status: this.viewStatus(s.place) }, annexes: [], sessions: 0 };
        islands.set(p.id, isl);
      }
      isl.sessions++;
      if (s.annex && !isl.annexes.length) isl.annexes.push({ id: ANNEX.id, name: ANNEX.name, branch: ANNEX.branch, status: this.viewStatus('annex') });
    }
    const owned = new Map();
    for (const p of this.ports) if (live.has(p.owner) && !live.get(p.owner).endedAt) owned.set(p.owner, [...(owned.get(p.owner) || []), p.id]);
    return {
      v: 1, now: this.now, host: 'DEMO-BATTLESTATION',
      server: { port: 7420, pid: 13370, startedAt: this.epoch - 5 * MIN, platform: 'win32', cores: 16, registry: true, probe: true, docker: true },
      system: { cpu: round(this.cpu, 3), mem: round(this.mem, 2) },
      settings: { asleepAfterMin: 20, hideAfterHours: 4 },
      islands: [...islands.values()],
      sessions: this.sessions.map((s) => this.viewSession(s, owned.get(s.key) || [])),
      ports: this.ports.map((p) => this.viewPort(p, live, islands)),
      events: events || this.events.slice(-60),
      demo,
    };
  }

  viewSession(s, ports) {
    const p = this.places[s.place];
    let last = s.lastActivity;
    for (const a of s.agents) if (ACTIVE.has(a.state)) last = Math.max(last, a.lastActivity);
    return {
      key: s.key, sessionId: s.sessionId, pid: s.pid, name: s.name,
      island: p.id, annex: s.annex ? ANNEX.id : null, cwd: s.cwd,
      entrypoint: s.entrypoint, kind: 'interactive', permissionMode: s.permissionMode,
      model: s.model, modelLabel: modelLabel(s.model), faction: factionOf(s.model),
      state: s.state || 'idle', stateSince: s.stateSince,
      tool: s.tool, lastTool: s.lastTool,
      lastActivity: last, startedAt: s.startedAt, endedAt: s.endedAt,
      lastPrompt: s.lastPrompt,
      branch: s.annex ? ANNEX.branch : p.git ? p.git.branch : null,
      context: { used: Math.round(s.used), max: contextMax(s.model, s.used) },
      compactions: s.compactions, lastCompaction: s.lastCompaction, clears: s.clears,
      tools: s.tools, toolTotal: s.toolTotal,
      cost: s.costShown ? { usd: round(s.spent.usd, 4), added: s.spent.added, removed: s.spent.removed } : null,
      agentsDone: s.agentsDone,
      agents: s.agents.map((a) => this.viewAgent(a)),
      procs: s.endedAt ? [] : s.procs.map((x) => (x.port
        ? { pid: x.port.pid, name: x.name, cmd: x.port.cmd, cpu: round(x.port.cpu, 3), since: x.since }
        : { pid: x.pid, name: x.name, cmd: x.cmd, cpu: round(x.cpu, 3), since: x.since })),
      ports,
    };
  }

  viewAgent(a) {
    return {
      id: a.id, type: a.type, description: a.description,
      model: a.model, modelLabel: modelLabel(a.model), faction: factionOf(a.model),
      state: a.state, stateSince: a.stateSince, tool: a.tool,
      startedAt: a.startedAt, lastActivity: a.lastActivity, endedAt: a.endedAt,
      depth: a.depth, parent: a.parent, background: a.background,
      context: Math.round(a.context), tools: a.tools,
    };
  }

  viewPort(p, live, islands) {
    const o = live.get(p.owner);
    const owner = o && !o.endedAt ? o : null;   // like the server: only a live session owns a process tree
    let island = owner ? this.places[owner.place].id : null;
    if (!island && p.island && islands.has(p.island)) island = p.island;
    if (p.kind === 'lighthouse') island = null;   // always stands at Port Localhost
    const a = p.adrift;
    const v = {
      id: p.id, port: p.port, ports: p.ports, addrs: p.addrs, pid: p.pid, proc: p.proc, kind: p.kind, label: p.label, cmd: p.cmd, cwd: p.cwd,
      owner: owner ? owner.key : null, container: p.container, activity: round(p.activity, 2), conns: p.conns,
      lastActive: p.lastActive, since: p.since, restarts: p.restarts, cpu: round(p.cpu, 3),
      adrift: a ? { since: a.since, reason: a.reason, lastOwner: a.lastOwner ? { ...a.lastOwner } : null } : null,
    };
    if (p.repo && !island) v.repo = p.repo;   // like the server: name the repo only when it has no island to dock at
    v.island = island;
    return v;
  }

  // -- scene posing (static tableaux: exact states, no simulation)

  // o: { state, tool: [cat, name, detail, agoSec], ago (sec in state), asleepFor (ms), used, tools, compactions,
  //      lastCompaction, clears, agentsDone, cost, procs: [[name, cmd, cpu]] }
  pose(id, o) {
    const now = this.now;
    const s = this.addSession(CAST.find((d) => d.id === id), now);
    const ago = (o.ago ?? 180) * 1000;
    s.state = o.state;
    s.stateSince = now - ago;
    s.tool = o.tool ? { name: o.tool[1], cat: o.tool[0], detail: o.tool[2], since: now - (o.tool[3] ?? 5) * 1000 } : null;
    s.lastActivity = o.state === 'asleep' ? now - (o.asleepFor ?? 3 * HOUR) : o.state === 'idle' ? now - ago : now - 1500;
    s.lastTool = s.tool ? { name: s.tool.name, cat: s.tool.cat, detail: s.tool.detail, at: s.tool.since }
      : { name: 'Read', cat: 'read', detail: 'README.md', at: s.lastActivity };
    for (const k of ['used', 'compactions', 'lastCompaction', 'clears', 'agentsDone']) if (o[k] !== undefined) s[k] = o[k];
    if (o.tools) { s.tools = { ...zeroTools(), ...o.tools }; s.toolTotal = total(s.tools); }
    if (o.cost !== undefined) { s.spent.usd = o.cost; s.costShown = true; }
    for (const p of o.procs || []) this.addProc(s, p, now - this.int(30, 600) * 1000);
    return s;
  }

  // tool: [cat, name, detail, agoSec]; o.parent makes a depth-2 apprentice.
  posedAgent(s, role, desc, model, state, tool, o = {}) {
    const now = this.now;
    const a = this.makeAgent(s, role, desc, model, o.parent);
    a.state = state;
    a.tool = tool ? { name: tool[1], cat: tool[0], detail: tool[2], since: now - (tool[3] ?? this.int(2, 9)) * 1000 } : null;
    a.stateSince = a.tool && state === 'waiting' ? a.tool.since + WAITING_AFTER : now - this.int(5, 60) * 1000;
    a.startedAt = now - this.int(60, 400) * 1000;
    a.lastActivity = state === 'stalled' ? now - 12 * MIN : now - this.int(1, 6) * 1000;
    a.tools = this.int(3, 40);
    a.context = this.int(18, 140) * 1000;
    return a;
  }

  // o: { owner (seat id or null), island (place), activity, conns, cpu, idle (ms), age (ms), restarts,
  //      adrift: { reason, ago (ms), lastOwner } }
  dock(key, o = {}) {
    const p = this.openPort(key, true);
    const now = this.now;
    if (o.owner !== undefined) p.owner = o.owner ? this.seat(o.owner)?.key ?? null : null;
    if (o.adrift !== undefined) p.adrift = o.adrift && { since: now - (o.adrift.ago || 0), reason: o.adrift.reason, lastOwner: o.adrift.lastOwner || null };
    if (o.island) p.island = this.places[o.island].id;
    p.activity = o.activity ?? 0;
    p.conns = o.conns ?? (p.activity > 0.06 ? Math.max(1, Math.round(p.activity * 4)) : 0);
    p.cpu = o.cpu ?? (p.kind === 'docker' ? p.activity * 0.25 : 0.004 + p.activity * (p.def.cpuScale || 0.35));
    p.lastActive = now - (o.idle ?? 0);
    p.since = now - (o.age ?? Math.max(2 * HOUR, o.idle ?? 0));
    p.restarts = o.restarts ?? 0;
    return p;
  }
}

// ---- pinned scenes -----------------------------------------------------------------------------------------------------------

const SCENE = {
  // One base per faction (plus a sleeper): needs_input, a nearly full silo, many modules, summary bricks, chevrons.
  buildings(w) {
    const t = w.now;
    w.pose('checkout', { state: 'working', tool: ['edit', 'Edit', 'CheckoutForm.vue'], used: 872_000, compactions: 3, clears: 1, agentsDone: 17, cost: 48.6,
      lastCompaction: { at: t - 40 * MIN, pre: 912_000, post: 104_000, trigger: 'auto' },
      tools: { edit: 140, bash: 118, read: 90, search: 41, web: 30, agent: 27, mcp: 26, plan: 12, skill: 4, other: 2 },
      procs: [['node', 'node.exe node_modules/vitest/vitest.mjs run checkout', 2.3]] });
    w.pose('billing', { state: 'needs_input', tool: ['plan', 'AskUserQuestion', 'has a question for you', 25], used: 420_000, compactions: 1, agentsDone: 4,
      lastCompaction: { at: t - 18 * MIN, pre: 830_000, post: 91_000, trigger: 'auto' },
      tools: { edit: 48, bash: 30, read: 60, search: 20, web: 4, agent: 6, mcp: 3, plan: 5, skill: 0, other: 0 } });
    w.pose('notes', { state: 'thinking', used: 121_000, agentsDone: 2,
      tools: { edit: 12, bash: 9, read: 30, search: 3, web: 5, agent: 3, mcp: 0, plan: 3, skill: 2, other: 0 } });
    w.pose('passkeys', { state: 'waiting', tool: ['bash', 'Bash', 'cargo build --release', 150], used: 610_000, compactions: 2, clears: 2, agentsDone: 23,
      lastCompaction: { at: t - 75 * MIN, pre: 940_000, post: 120_000, trigger: 'auto' },
      tools: { edit: 64, bash: 101, read: 80, search: 50, web: 28, agent: 30, mcp: 102, plan: 12, skill: 6, other: 2 },
      procs: [['cargo', 'cargo.exe build --release', 3.8]] });
    w.pose('screens', { state: 'idle', ago: 420, used: 90_000,
      tools: { edit: 3, bash: 14, read: 6, search: 2, web: 0, agent: 0, mcp: 0, plan: 1, skill: 0, other: 0 } });
    w.pose('jsonflag', { state: 'asleep', ago: 2 * 3600, asleepFor: 3.5 * HOUR, used: 64_000,
      tools: { edit: 26, bash: 31, read: 40, search: 12, web: 3, agent: 3, mcp: 0, plan: 2, skill: 0, other: 0 } });
    w.dock('lighthouse', { activity: 0.05, conns: 1 });
    w.dock('vite', { activity: 0.3 });
    w.dock('uvicorn', { activity: 0.5 });
  },

  // One base with a worker of every role doing every tool category (plus a depth-2 apprentice), a base at lunch,
  // and one asleep.
  units(w) {
    const s = w.pose('checkout', { state: 'working', tool: ['agent', 'Agent', 'Dispatch the review squad'], used: 540_000, agentsDone: 31,
      tools: { edit: 60, bash: 44, read: 70, search: 33, web: 12, agent: 41, mcp: 5, plan: 8, skill: 2, other: 1 } });
    const crew = [
      ['general-purpose', 'Implement the cart reducer', 'opus', 'working', ['edit', 'Edit', 'useCart.ts']],
      ['Explore', 'Scout: every caller of useCart()', 'haiku', 'working', ['search', 'Grep', '/useCart\\(/']],
      ['Plan', 'Blueprint: checkout v2 in three phases', 'opus', 'working', ['plan', 'TodoWrite', '7 todos']],
      ['review-skeptical', 'Skeptic pass: payment retries', 'opus', 'working', ['read', 'Read', 'payment.ts']],
      ['review-yagni', 'YAGNI sweep: the config layer', 'sonnet', 'working', ['search', 'Glob', 'src/**/config*.ts']],
      ['review-runtime-wiring', 'Wiring review: cart → API', 'opus', 'working', ['bash', 'Bash', 'npm run typecheck']],
      ['review-house-conventions', 'Etiquette pass on the new components', 'sonnet', 'thinking', null],
      ['review-design-fidelity', 'Pixel-peep the checkout modal', 'fable', 'working', ['web', 'mcp__claude-in-chrome__computer', 'computer']],
      ['recon-capability', 'Recon: Payment Request API support', 'sonnet', 'working', ['web', 'WebSearch', 'payment request api browser support 2026']],
      ['claude-code-guide', 'How do hooks work again?', 'haiku', 'working', ['skill', 'Skill', 'claude-code-docs']],
      ['statusline-setup', 'Statusline: branch + context %', 'sonnet', 'working', ['edit', 'Write', 'statusline.ps1']],
      ['security-audit', 'Audit the webhook signature check', 'fable', 'working', ['mcp', 'mcp__semgrep__scan', 'scan']],
      ['test-runner', 'Run the checkout e2e suite 20 times', 'sonnet', 'waiting', ['bash', 'Bash', 'Run the checkout e2e suite 20 times', 130]],
      ['bug-fixer', 'Exterminate the flaky waitForSelector', 'merc', 'stalled', ['read', 'Read', 'checkout.spec.ts', 720]],
      ['kraken-wrangler', 'Untangle the legacy middleware kraken', 'fable', 'working', ['agent', 'Agent', 'Find every call to legacyLogin()']],
    ];
    let boss = null;
    for (const c of crew) boss = w.posedAgent(s, ...c);
    w.posedAgent(s, 'Explore', 'Find every call to legacyLogin()', 'haiku', 'working', ['bash', 'Bash', 'git grep -n legacyLogin'], { parent: boss });
    w.pose('jsonflag', { state: 'idle', ago: 300 });
    w.pose('dotfiles', { state: 'asleep', ago: 3600, asleepFor: 3.2 * HOUR });
    w.dock('lighthouse', { activity: 0.05, conns: 1 });
    w.dock('nuxt', { activity: 0.4, conns: 2 });
  },

  // Every vessel kind, busy to idle, fresh paint to "4 SALE", and a boat adrift for each reason: a Storybook
  // whose session has ended (owner-ended) and a Laravel server a long-gone session probably left behind (orphaned).
  harbor(w) {
    w.pose('checkout', { state: 'working', tool: ['bash', 'Bash', 'npx playwright test checkout'] });
    w.pose('passkeys', { state: 'working', tool: ['web', 'WebFetch', 'passkeys.dev'] });
    const gone = { key: `pid:43000:${w.now - 3 * HOUR}`, name: SLOTS[0].name, guess: false };
    const docks = [
      ['storybook', { owner: null, idle: 14 * MIN, age: 3 * HOUR, adrift: { reason: 'owner-ended', ago: 12 * MIN, lastOwner: gone } }],
      ['nuxt', { owner: 'checkout', activity: 0.85, conns: 4 }],
      ['vite', { owner: null, island: 'shop', idle: 20 * MIN, restarts: 2 }],
      ['browser-e2e', { activity: 1, conns: 1 }],
      ['bun', { activity: 0.4, conns: 2 }],
      ['deno', { activity: 0.15 }],
      ['uvicorn', { activity: 0.55, conns: 3 }],
      ['electron', { activity: 0.1 }],
      ['laravel', { idle: 12 * HOUR, age: 30 * HOUR, adrift: { reason: 'orphaned', ago: 47 * MIN, lastOwner: leftBy(DOCKS.get('laravel')) } }],
      ['rails', { idle: 6 * HOUR, age: 9 * HOUR }],
      ['java', { idle: 2 * HOUR, age: 5 * HOUR }],
      ['dotnet', { activity: 0.3, conns: 1 }],
      ['air', { activity: 0.05 }],
      ['nginx', { idle: 45 * MIN }],
      ['mongo', { idle: 3 * HOUR, age: 26 * HOUR }],
      ['laravel-ctr', { activity: 0.2 }],
      ['pgsql-ctr', { activity: 0.05 }],
      ['redis-ctr', { activity: 0.6, conns: 3 }],
      ['supa-db', { idle: 26 * HOUR, age: 50 * HOUR }],
      ['ollama', { activity: 0.9, conns: 1, cpu: 7.2 }],
      ['lighthouse', { activity: 0.08, conns: 2 }],
    ];
    for (const [key, o] of docks) w.dock(key, o);
  },

  // Every git work-tree state at once. storefront-nuxt: laundry (dirty, staged, untracked), crates (ahead), a buried
  // stash, a rebase stopped on conflicts; its worktree annex: dirty and ahead of its own upstream. monorepo: a merge
  // stopped on a conflict, behind its upstream, a stash.
  git(w) {
    w.pose('checkout', { state: 'working', tool: ['bash', 'Bash', 'git rebase --continue'], used: 420_000 });
    w.pose('billing', { state: 'working', tool: ['edit', 'Edit', 'BillingService.ts'], used: 260_000 });
    w.pose('passkeys', { state: 'needs_input', tool: ['plan', 'AskUserQuestion', 'has a question for you', 40], used: 380_000 });
    w.pushedRefs.add(`annex:${ANNEX.branch}`);
    Object.assign(w.gitst.shop, { tracked: 7, staged: 3, untracked: 2, conflicts: 2, ahead: 4, behind: 0, stash: 2, op: 'rebase' });
    Object.assign(w.gitst.annex, { tracked: 3, staged: 1, untracked: 1, conflicts: 0, ahead: 2, behind: 0, stash: 2, op: null });
    Object.assign(w.gitst.mono, { tracked: 4, staged: 2, untracked: 1, conflicts: 1, ahead: 2, behind: 3, stash: 1, op: 'merge' });
    for (const g of Object.values(w.gitst)) g.changed = w.now - 4000;
    w.dock('lighthouse', { activity: 0.05, conns: 1 });
    w.dock('nuxt', { owner: 'checkout', activity: 0.2, conns: 1 });
  },

  // Nobody home: just the lighthouse.
  empty(w) {
    w.dock('lighthouse', { activity: 0.03, conns: 1 });
  },
};

function sceneWorld(name, at) {
  if (name === 'night') {   // the default world, frozen at a busy moment
    const w = new World(at - NIGHT_AT).start();
    w.advance(NIGHT_AT);
    return w;
  }
  const w = new World(at);
  SCENE[name](w);
  return w;
}

// ---- entry point ----------------------------------------------------------------------------------------------------------------

export function startDemo({ onSnapshot, speed = 1, scene = null } = {}) {
  speed = Number.isFinite(+speed) && +speed > 0 ? clamp(+speed, 0.05, 100) : 1;
  scene = SCENES.includes(scene) ? scene : null;
  const t0 = Date.now();
  let world = null, frozen = null;
  if (scene) {
    const w = sceneWorld(scene, t0);
    const night = scene === 'night';
    frozen = JSON.stringify(w.snapshot({ scene, speed, loopT: night ? round(w.loopSec(), 1) : null, forceNight: night }, []));
  } else {
    world = new World(t0).start();
  }
  const every = scene ? 1000 : speed >= 40 ? 250 : speed >= 4 ? 500 : 1000;
  let last = t0, stopped = false;
  const emit = () => {
    if (stopped) return;
    try {
      let text = frozen;
      if (!text) {
        const t = Date.now();
        // At most 25 sim-seconds per snapshot (the world treats a 30 s gap as a reconnect), so a late timer or a
        // throttled background tab slows the sim down instead of fast-forwarding it.
        world.advance(Math.min(25_000, Math.max(0, t - last) * speed));
        last = t;
        text = JSON.stringify(world.snapshot({ scene: null, speed, loopT: round(world.loopSec(), 1), forceNight: false }));
      }
      onSnapshot?.(JSON.parse(text));   // a fresh object every time, exactly like a parsed SSE message
    } catch (e) {
      console.error('[demo]', e);
    }
  };
  const first = setTimeout(emit, 0);
  const timer = setInterval(emit, every);
  return { stop() { stopped = true; clearTimeout(first); clearInterval(timer); } };
}
