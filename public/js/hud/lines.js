// EVA announcer: C&C-style lines for every event type. A template is only eligible when every {var} it uses is
// known for that event, so there is always something that reads well. Values are highlighted in the log and read
// plainly by the voice.
import { esc, trunc, fmtTokens, ftext, roleName, funit, vesselName } from './util.js';
import { EV_ICON } from './icons.js';

const T = {
  session_start: [
    'Construction complete.',
    'Construction complete: {name}.',
    'New base established: {name}.',
    'Reinforcements have arrived: {name}.',
    'Scaffolding up, coffee on. {name} is online.',
    'A new challenger appears: {name}.',
    'Base online. The paint is still wet.',
    '{A_unit} commander enters the theatre: {name}.',
    'Breaking ground on {island}. Mind the crane.',
    'New construction on {island}: {name}.',
    'Building… building… done. {name} is open for business.',
  ],
  session_end: [
    'Structure decommissioned.',
    '{name} has been decommissioned.',
    '{name} has left the building. Literally.',
    'Lights out at {name}. Thank you for your service.',
    'Base sold. Please exit through the gift shop.',
    '{name}: mission over. The CLOSED sign is up.',
    'Structure lost… on purpose, this time.',
    '{name} sinks gracefully into the island. Goodnight.',
  ],
  clear: [
    'Base demolished. Rebuilding… Memory is overrated.',
    'Controlled demolition at {name}. Nobody panic.',
    '{name} wiped the slate. What slate?',
    '/clear executed at {name}. Who are you people?',
    "Fresh start for {name}. The old context has been 'retired'.",
    'KABOOM. {name} is rebuilding from level zero.',
    'Demolition complete. {name} remembers nothing and feels great.',
    'Context cleared at {name}. The past is a different transcript.',
  ],
  compaction: [
    'Compaction complete. {pre} → {post}.',
    'KA-CHUNK! {name} squeezed {pre} into {post}.',
    'Summary brick forged: {pre} → {post}.',
    'The press has spoken. {pre} became {post}.',
    'Context compressed at {name}. Some memories were harmed.',
    '{name} compacted {pre} of vibes into {post} of facts.',
    '{name} compacted. It remembers the gist. Mostly.',
    'Hydraulic press engaged: {pre} → {post}. Brick stacked.',
    'Compaction complete.',
  ],
  context_high: [
    'Warning: context silo at {pct}%.',
    "{name}: context silo at {pct}%. She's gonna blow!",
    'Context critical at {name}: {pct}%. Recommend compaction.',
    'Silo pressure {pct}%. Hydraulic press on standby.',
    'Warning: {name} is running out of room to think. {pct}%.',
    'Steam venting at {name}. Silo at {pct}%.',
    '{pct}% full. {name} is one README away from a compaction.',
  ],
  agent_spawn: [
    'Unit ready: {type}.',
    'Unit ready: {role}.',
    '{role} reporting for duty.',
    'Deploying {role}: {desc}.',
    'The barracks door flaps. {A_role} emerges.',
    'New recruit: {role}. They look nervous.',
    '{role} dispatched from {name}: {desc}.',
    '{role} en route. Objective: {desc}.',
    'Another {unit} joins the fray.',
    '{name} has trained {a_role}.',
  ],
  agent_done: [
    'Mission accomplished: {desc}.',
    '{role} returns victorious.',
    'Objective complete: {desc}.',
    'Report delivered. The {role} would like a medal.',
    '{role} heading home. {desc}: done.',
    'Task complete. Stamped, filed, approved.',
    '{desc}. Done and dusted.',
    'The {role} completed its mission. Veterancy increased.',
    'Mission accomplished.',
  ],
  agent_failed: [
    'Unit lost.',
    '{role} down: {desc}.',
    "Mission failed. We'll get 'em next time.",
    '{role} failed. Tiny rain cloud deployed.',
    'Objective failed: {desc}.',
    'Our {role} is walking home in the rain.',
    'Unit lost. It was a good {role}. Mostly.',
    '{desc}: failed. Nobody saw anything.',
  ],
  needs_input: [
    'Commander, your input is required.',
    '{name} needs you.',
    '{name} awaits your orders.',
    'Attention: {name} has a question.',
    'Your move, Commander. {name} is waiting.',
    "{name}: 'Hello? Is anyone there?'",
    'Incoming transmission from {name}: {detail}.',
    'Big yellow exclamation mark deployed over {name}.',
    'Commander, {name} would like a word.',
  ],
  turn_done: [
    'Objective complete. Your move, Commander.',
    '{name} awaits orders.',
    '{name} reports: mission complete. Awaiting orders.',
    'Your move, Commander. {name} finished in {secs}.',
    '{name} is done. It is now staring at you expectantly.',
    'Job done at {name}. The ball is in your court.',
    '{name} dropped the mic after {secs}. Your move.',
    'Turn complete at {name}. It would like a treat.',
    "{name}: 'Done! What next, boss?'",
    'Work complete. {name} is idling politely.',
    '{A_unit} commander at {name} requests new orders.',
    'Mission accomplished at {name}. Reply at your leisure. Now would be nice.',
    '{secs} of hard labor at {name}. Your turn.',
    'Objective secured on {island}. Awaiting your command.',
    '{name} has finished and is definitely not waiting for you. (It is.)',
    'Your move. {name} is holding the door open.',
    'Ready for orders: {name}.',
  ],
  // turn_done while sub-agents are still out in the field
  turn_done_agents: [
    'Your move, Commander. {agents} still in the field.',
    '{name} handed back control. {agents} still in the field.',
    'Your move at {name}. Still out there: {agents}.',
    '{name} paused for you. Still working in the background: {agents}.',
    '{name} is waiting on {agents}. Feel free to weigh in.',
    'Commander, {name} yields the floor. {agents} still on patrol.',
    'Turn over at {name}, but nobody told its {agents}.',
  ],
  asleep: [
    '{name} has gone to sleep.',
    '{name} is taking a nap. Do not disturb.',
    'Lights out at {name}. Zzz.',
    '{name} powered down to save the planet.',
    '{name} has entered hibernation. Cobwebs pending.',
    'Night shift is over at {name}.',
  ],
  wake: [
    '{name} is back on duty.',
    '{name} woke up. Coffee acquired.',
    'Rise and grind, {name}.',
    '{name} reactivated. Who moved my cheese?',
    '{name} is awake and pretending it never slept.',
  ],
  port_open: [
    'New vessel docked at :{port}.',
    'Ship ahoy! {label} :{port} has docked.',
    'Harbor traffic: a {vessel} arrived at :{port}.',
    ':{port} is now listening. Loose lips sink ships.',
    'A {vessel} ties up at :{port}. The seagulls approve.',
    'Now arriving at pier :{port}: {label}.',
    'Port :{port} is open for business.',
  ],
  port_close: [
    'Vessel :{port} has departed.',
    '{label} :{port} sailed off into the sunset.',
    ':{port} cast off. Bon voyage.',
    'Port :{port} closed. The seagulls are disappointed.',
    '{label} :{port} has left the harbor. No refunds.',
    'Vessel :{port} departed. Nobody waved.',
  ],
  // port_adrift, reason 'owner-ended' (name = the session that owned it, when known for sure)
  port_adrift: [
    'Vessel :{port} is adrift. Its session has ended.',
    '{label} :{port} is adrift. Its session has ended.',
    ':{port} slipped its moorings. {name} has ended.',
    '{label} :{port} is adrift. {name} left, the server stayed.',
    'Nobody at the helm of :{port}. {name} has ended.',
    'Adrift: {label} :{port}. Its captain went home.',
  ],
  // port_adrift, reason 'orphaned' (name = the ended session that probably left it behind: a guess, so "probably")
  port_adrift_orphaned: [
    'Vessel :{port} is adrift. Probably left behind by {name}, which has ended.',
    '{label} :{port} is adrift. {name} probably left it behind.',
    'Ghost ship at :{port}. {name} has ended and probably left it running.',
    '{label} :{port} is drifting. Probably left behind by {name}.',
    // without a name (never sent by the current server)
    'Vessel :{port} is adrift. Nobody is at the helm.',
    '{label} :{port} is adrift. Its launcher is gone.',
  ],
  commit: [
    'Launch detected! {name}: {msg}',
    'Rocket away from {name}: {msg}',
    'Commit {hash} lifts off: {msg}',
    '{author} launched {hash} from {name}.',
    'Liftoff on {branch}: {msg}',
    'We have a launch! {name} committed {msg}',
    'Commit detected on {name}. Houston, we have a diff.',
    'Launch detected!',
  ],
  pull: [
    'Supply drop received.',
    'Supply drop received at {name}.',
    'Supply crates inbound at {name}: {msg}',
    'Fresh commits parachuted into {name}.',
    'Pulled {hash} into {name}. Crates everywhere.',
    'Reinforcements from origin have landed on {branch}.',
  ],
  merge: [
    'Branches united. {from} → {branch}.',
    'Branches united on {name}.',
    '{from} has been absorbed into {branch}. Resistance was futile.',
    'Merge complete at {name}: {from} → {branch}. The Git Tree grew a knot.',
    'Two timelines became one on {name}.',
    'Merge detected on {name}: {msg}',
    '{from} and {branch} are now legally the same branch.',
    'Fusion achieved at {name}. Conflicts: hopefully zero.',
  ],
  push: [
    'Cargo away! {commits} shipped to {remote}/{branch}.',
    '{name} pushed {commits} to {remote}.',
    'Airship departing {name}: {commits} bound for {remote}/{branch}.',
    'Special delivery from {name} to {remote}/{branch}.',
    '{commits} left the island. Origin has been notified.',
    'Push detected on {branch}. The CI gremlins stir.',
    'Supply run to {remote}: {commits} from {name}.',
  ],
  // push that created the branch on the remote
  push_new: [
    'Maiden voyage! {branch} sets sail for {remote}.',
    'New branch launched: {branch} now exists on {remote}. Christened with {commits}.',
    '{name} christened {remote}/{branch}. Smash the champagne.',
    'First flight of {branch}: {commits} delivered to {remote}.',
  ],
  // conflicted paths appeared (count > 1; conflict_one for a single file)
  conflict: [
    'Merge conflict on {island}! {count} files are fighting.',
    'The Git Tree on {island} is on fire: {count} conflicted files.',
    '{count} files in open conflict on {island}. Fetch the fire brigade.',
    '{island}: merge conflict. {count} files refuse to agree.',
    'Merge conflict!',
  ],
  conflict_one: [
    'Merge conflict on {island}! One file is fighting itself.',
    'The Git Tree on {island} caught fire: one conflicted file.',
    '{island}: merge conflict in one file. Bring a bucket.',
    'Merge conflict!',
  ],
  // a session (or one of its sub-agents) touched a pull request: pr_created / pr_merged / pr (any other action)
  pr_created: [
    'Pull request {pr} dispatched from {name}.',
    'Pull request {pr} on {repo} dispatched from {name}.',
    'Carrier pigeon away! {name} opened {pr} on {repo}.',
    'New pull request {pr} for {repo}. The pigeon knows the way.',
    'Pull request {pr} dispatched.',
  ],
  pr_merged: [
    'Pull request {pr} merged!',
    'Pull request {pr} on {repo} merged!',
    'Merged! {pr} has landed on {repo}.',
    '{repo} {pr} merged. The pigeon brings good news.',
  ],
  pr: [
    'Pull request {pr} {action}.',
    'Pull request {pr} on {repo} {action}.',
    '{name}: pull request {pr} on {repo} {action}.',
  ],
  checkout: [
    'Now flying the {to} flag.',
    '{name} switched to {to}.',
    'Flag swap at {name}: {from} → {to}.',
    'Branch change: all hands to {to}.',
    '{name} lowered {from} and raised {to}.',
    'New colors over {name}: {to}.',
  ],
};

// type -> [tone, what to select]
const META = {
  session_start: 'good', session_end: 'dim', clear: 'bad', compaction: 'info', context_high: 'warn',
  agent_spawn: 'info', agent_done: 'good', agent_failed: 'bad', needs_input: 'alert', turn_done: 'good', asleep: 'dim', wake: 'good',
  port_open: 'port', port_close: 'port', port_adrift: 'warn', commit: 'git', pull: 'git', checkout: 'git', merge: 'git', push: 'git',
  conflict: 'bad', pr: 'git',
};

const last = new Map();
const dur = (x) => { const s = Math.max(0, Math.round(x)); return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor(s / 60) % 60}m`; };
// "4m 12s" reads as "4 meters" to a speech engine: spell durations out for the voice.
const spoken = (x) => {
  const s = Math.max(0, Math.round(x)), m = Math.floor(s / 60) % 60, h = Math.floor(s / 3600);
  const u = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  return h ? `${u(h, 'hour')} ${u(m, 'minute')}` : m ? `${u(m, 'minute')}${s % 60 ? ' ' + u(s % 60, 'second') : ''}` : u(s, 'second');
};
const art = (w) => (/^(yagni|one|uni)/i.test(w) ? 'a' : /^[aeiou]/i.test(w) ? 'an' : 'a');

// Where clicking the line should take you.
export function targetOf(ev) {
  if (!ev) return null;
  if (ev.type?.startsWith('agent_')) return ev.agent ? { type: 'agent', id: ev.agent, session: ev.key } : ev.key ? { type: 'session', id: ev.key } : null;
  if (/^port_(open|close|adrift)$/.test(ev.type)) return { type: 'port', id: ev.portId ?? String(ev.port) };
  if (/^(commit|pull|checkout|merge|push|conflict)$/.test(ev.type)) return ev.island ? { type: 'island', id: ev.island } : null;
  return ev.key ? { type: 'session', id: ev.key } : null;
}

// ctx: { sessions: Map, agents: Map(id -> {agent, session}), ports: Map, islands: Map, agentCache: Map(id -> agent) }
export function announce(ev, ctx = {}) {
  // port_adrift names the session that owned the port (lastOwner). A guessed owner is left out of an owner-ended
  // line; an orphaned one is always a guess, and its lines say "probably".
  const lo = ev.type === 'port_adrift' && ev.lastOwner && (!ev.lastOwner.guess || ev.reason === 'orphaned') ? ev.lastOwner : null;
  const s = ev.key ? ctx.sessions?.get(ev.key) : lo?.key ? ctx.sessions?.get(lo.key) : null;
  const a = ev.agent ? ctx.agents?.get(ev.agent)?.agent || ctx.agentCache?.get(ev.agent) : null;
  const port = ev.portId != null ? ctx.ports?.get(ev.portId) || ctx.portCache?.get(ev.portId) : null;
  const isl = ev.island ? ctx.islands?.get(ev.island) : s ? ctx.islands?.get(s.island) : null;
  const faction = a?.faction || s?.faction || 'merc';
  const agentType = ev.agentType || a?.type || '';
  const v = {
    name: ev.name || lo?.name || s?.name || '',
    island: (ev.type === 'conflict' && ev.name) || isl?.name || '',   // a conflict names its work tree (island or worktree)
    unit: ev.type?.startsWith('agent_') ? funit(faction) : s ? funit(s.faction) : '',
    role: agentType ? roleName(agentType) : '',
    type: agentType,
    desc: ev.description || a?.description || '',
    detail: ev.detail || '',
    pre: ev.pre ? fmtTokens(ev.pre) : '',
    post: ev.post ? fmtTokens(ev.post) : '',
    pct: ev.pct != null ? String(ev.pct) : '',
    port: ev.port != null ? String(ev.port) : port?.port != null ? String(port.port) : '',
    label: ev.label || port?.label || '',
    vessel: port ? vesselName(port.kind).toLowerCase() : '',
    msg: ev.msg || '',
    hash: ev.hash || '',
    author: ev.author || '',
    branch: ev.branch || '',
    from: ev.from && (ev.type === 'checkout' || ev.type === 'merge') ? ev.from : '',
    remote: ev.remote || '',
    commits: ev.type === 'push' && ev.count > 0 ? `${ev.count} commit${ev.count === 1 ? '' : 's'}` : '',
    to: ev.to || (ev.type === 'checkout' ? ev.branch : '') || '',
    secs: ev.type === 'turn_done' && ev.secs > 0 ? dur(ev.secs) : '',
    agents: ev.agentsRunning > 0 ? `${ev.agentsRunning} sub-agent${ev.agentsRunning === 1 ? '' : 's'}` : '',
    count: ev.type === 'conflict' && ev.count > 0 ? String(ev.count) : '',
    pr: ev.type === 'pr' ? `#${ev.number ?? '?'}` : '',
    repo: ev.type === 'pr' && ev.repo ? String(ev.repo) : '',
    action: ev.type === 'pr' ? String(ev.action || 'linked') : '',
  };
  v.a_role = v.role ? `${art(v.role)} ${v.role}` : '';
  v.A_role = v.a_role ? v.a_role[0].toUpperCase() + v.a_role.slice(1) : '';
  v.A_unit = v.unit ? `${art(v.unit) === 'an' ? 'An' : 'A'} ${v.unit}` : '';
  const kind = ev.type === 'turn_done' && ev.agentsRunning > 0 ? 'turn_done_agents' : ev.type === 'push' && ev.newBranch ? 'push_new'
    : ev.type === 'port_adrift' && ev.reason === 'orphaned' ? 'port_adrift_orphaned'
    : ev.type === 'conflict' && ev.count === 1 ? 'conflict_one'
    : ev.type === 'pr' && (ev.action === 'created' || ev.action === 'merged') ? 'pr_' + ev.action : ev.type;
  const list = T[kind];
  let tpl;
  if (!list) tpl = `Unknown transmission: ${esc(ev.type || '?')}.`;
  else {
    let ok = list.map((t, i) => [t, i]).filter(([t]) => [...t.matchAll(/\{(\w+)\}/g)].every((m) => v[m[1]]));
    if (v.repo && ok.some(([t]) => t.includes('{repo}'))) ok = ok.filter(([t]) => t.includes('{repo}'));   // name the repo when known
    if (kind === 'port_adrift_orphaned' && v.name) ok = ok.filter(([t]) => t.includes('{name}'));   // and who left it behind
    const pool = ok.length > 1 ? ok.filter(([, i]) => i !== last.get(kind)) : ok;
    const [t, i] = pool.length ? pool[Math.floor(Math.random() * pool.length)] : [list[0], 0];
    last.set(kind, i);
    tpl = t;
  }
  const color = ftext(faction);
  const nameColor = ftext(s?.faction || faction);
  const H = {
    name: (x) => `<b class="e-name" style="--c:${nameColor}">${esc(trunc(x, 34))}</b>`,
    island: (x) => `<b class="e-isl">${esc(trunc(x, 30))}</b>`,
    unit: (x) => `<b class="e-role" style="--c:${color}">${esc(x)}</b>`,
    role: (x) => `<b class="e-role" style="--c:${color}">${esc(x)}</b>`,
    a_role: (x) => { const [a, ...r] = x.split(' '); return `${esc(a)} <b class="e-role" style="--c:${color}">${esc(r.join(' '))}</b>`; },
    A_role: (x) => { const [a, ...r] = x.split(' '); return `${esc(a)} <b class="e-role" style="--c:${color}">${esc(r.join(' '))}</b>`; },
    A_unit: (x) => { const [a, ...r] = x.split(' '); return `${esc(a)} <b class="e-role" style="--c:${color}">${esc(r.join(' '))}</b>`; },
    type: (x) => `<b class="e-role" style="--c:${color}">${esc(trunc(x, 28))}</b>`,
    desc: (x) => `<span class="e-q">${esc(trunc(x, 60))}</span>`,
    detail: (x) => `<span class="e-q">${esc(trunc(x, 50))}</span>`,
    msg: (x) => `<span class="e-q">“${esc(trunc(x, 64))}”</span>`,
    pre: (x) => `<b class="e-num">${esc(x)}</b>`,
    post: (x) => `<b class="e-num">${esc(x)}</b>`,
    pct: (x) => `<b class="e-num">${esc(x)}</b>`,
    port: (x) => `<b class="e-port">${esc(x)}</b>`,
    label: (x) => `<b class="e-port">${esc(trunc(x, 24))}</b>`,
    vessel: (x) => `<b class="e-port">${esc(x)}</b>`,
    hash: (x) => `<code class="e-hash">${esc(x)}</code>`,
    author: (x) => `<b class="e-author">${esc(trunc(x, 22))}</b>`,
    branch: (x) => `<b class="e-branch">${esc(trunc(x, 28))}</b>`,
    from: (x) => `<b class="e-branch">${esc(trunc(x, 24))}</b>`,
    to: (x) => `<b class="e-branch">${esc(trunc(x, 28))}</b>`,
    secs: (x) => `<b class="e-num">${esc(x)}</b>`,
    commits: (x) => `<b class="e-num">${esc(x)}</b>`,
    remote: (x) => `<b class="e-branch">${esc(trunc(x, 20))}</b>`,
    agents: (x) => `<b class="e-num">${esc(x)}</b>`,
    count: (x) => `<b class="e-num">${esc(x)}</b>`,
    pr: (x) => `<b class="e-num">${esc(x)}</b>`,
    repo: (x) => `<b class="e-branch">${esc(trunc(x, 32))}</b>`,
    action: (x) => esc(x),
  };
  // The template text itself is trusted; only the substituted values are escaped.
  const html = tpl.split(/(\{\w+\})/g).map((part) => {
    const m = part.match(/^\{(\w+)\}$/);
    if (!m) return esc(part);
    return (H[m[1]] || ((x) => esc(x)))(v[m[1]] || '');
  }).join('');
  const text = tpl.replace(/\{(\w+)\}/g, (_, k) => {
    const x = v[k] || '';
    if (k === 'msg' || k === 'desc' || k === 'detail') return trunc(x, 80);
    if (k === 'hash') return '';
    if (k === 'secs') return spoken(ev.secs);
    return x;
  }).replace(/:(\d{2,5})/g, 'port $1').replace(/#(\d+)/g, 'number $1').replace(/→/g, 'to').replace(/\s+/g, ' ').trim();
  return {
    html,
    text,
    icon: EV_ICON[ev.type] || EV_ICON.needs_input,
    tone: kind === 'turn_done_agents' ? 'info' : META[ev.type] || 'info',
    target: targetOf(ev),
    tip: ev.type === 'pr' && /^https?:\/\//i.test(ev.url || '') ? String(ev.url) : undefined,   // the link, as text (never opened)
    priority: ev.type === 'needs_input' ? 3 : /session_|clear|compaction|context_high|agent_failed|turn_done|conflict/.test(ev.type) ? 2 : 1,
  };
}
