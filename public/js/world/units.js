// Units (docs/DESIGN.md §8): one worker per sub-agent plus one "commander" hero per session.
//
// Every unit is a tiny procedural rig (group hierarchy: mover > torso > head / arms, legs) built from kit.js
// primitives and animated in code: faction gaits (waddle / walk / hop / float / servo-stomp), role props,
// tool-category actions performed at the right island station, lunch breaks, a spawn -> finish lifecycle, click
// quotes and simple circle-obstacle steering on the island plateau. Commanders don't run errands: while their
// session works / thinks / waits they cast spells at their HQ's modules from a fixed command post. Geometry and materials are shared through
// kit.js caches; the per-frame path reuses module-level temporaries and does not allocate.
//
// Everything outside this file (engine, world, islands, buildings) is optional: every hook is guarded and falls
// back to something reasonable near the unit's building.
import * as THREE from 'three';
import {
  PAL, factionPal, tint, mat, glow, box, cyl, cone, ico, sphere, torus, meshOf, at, jitter, disposeTree,
  rng, hashHue, ease, clamp, lerp, damp, freeze,
} from './kit.js';

const TAU = Math.PI * 2;
const HALF_PI = Math.PI / 2;
const FACTIONS = ['opus', 'sonnet', 'haiku', 'fable', 'merc'];
const SMALL = { cast: false, receive: false };
const CAST = { cast: true, receive: false };
const SKIN = [0xffd6b8, 0xf1bd92, 0xc68b60, 0x8a5a3b];
const PAINTS = [0xff4d6d, 0x3d8bff, 0xffd23d, 0x3ddc84, 0xb86bff];
const MALLOW = [0xfdfbf4, 0xe8b25e, 0x5a3a22];
const OV_NAMES = ['thought', 'hourglass', 'rain', 'check', 'bang', 'zees'];
const SEA_Y = 0.03;

// Faction locomotion: speed in m/s, stride = ground covered per step.
const GAIT = {
  opus:   { speed: 0.95, stride: 0.2 },
  sonnet: { speed: 1.35, stride: 0.3 },
  haiku:  { speed: 1.9,  stride: 0.42 },
  fable:  { speed: 1.2,  stride: 0.5 },
  merc:   { speed: 1.2,  stride: 0.26 },
};

// Tool categories this module can act out.
const ACT_OK = new Set(['bash', 'edit', 'read', 'search', 'web', 'agent', 'mcp', 'plan', 'skill', 'other']);

// Which props an act uses and which hands it keeps busy (role items in a busy hand are stowed or hidden).
// onSite: props appear only once the unit arrives; otherwise the unit carries them while walking there.
const ACTS = {
  bash:   { hands: 'RL', props: [['pickaxe', 'R']], carry: -2.4 },
  edit:   { hands: 'RL', props: [['hammer', 'R']], carry: -0.5 },
  read:   { hands: 'RL', props: [['scroll', 'front']], onSite: true },
  search: { hands: 'R', props: [['detector', 'R'], ['headphones', 'head']], carry: -0.7 },
  web:    { hands: 'RL', props: [['rod', 'R']], carry: -0.9 },
  agent:  { hands: 'RL', props: [['megaphone', 'mouth']], onSite: true },
  mcp:    { hands: 'R', props: [['phone', 'ear']], onSite: true },
  plan:   { hands: 'RL', props: [['clipboard', 'front'], ['pencil', 'R']], onSite: true },
  write:  { hands: 'RL', props: [['clipboard', 'front'], ['pencil', 'R']], onSite: true },
  skill:  { hands: 'RL', props: [['manual', 'front']], onSite: true },
  other:  { hands: 'R', props: [['wrench', 'R']], carry: -0.5 },
  think:  { hands: 'R', props: [] },
  wait:   { hands: 'RL', props: [['watch', 'L']] },
  stall:  { hands: 'RL', props: [['watch', 'L']] },
  lunch:  { hands: 'RL', props: [], onSite: true },
  sleep:  { hands: 'RL', props: [] },
  alert:  { hands: 'RL', props: [['flag', 'R']], onSite: true },
  cast:   { hands: 'RL', props: [], onSite: true },
  idle:   { hands: '', props: [] },
};

const TOOL_VERB = {
  edit: 'editing', bash: 'running', read: 'reading', search: 'searching', web: 'browsing', agent: 'briefing',
  mcp: 'calling', plan: 'planning', skill: 'using skill', other: 'using',
};
const ACT_TEXT = {
  think: 'thinking…', wait: 'waiting…', stall: 'stalled', lunch: 'on lunch break', sleep: 'asleep',
  alert: 'needs your input!', write: 'writing', idle: 'standing by',
};

// Faction lunches (food is per eater; the set piece belongs to the commander's faction).
const FOOD = { opus: 'teacup', sonnet: 'sandwich', haiku: 'onigiri', fable: 'mallow', merc: 'oilcan' };

// ---- roles ------------------------------------------------------------------------------------------------

const ROLE_RULES = [
  [/explore|scout|recon|search|find/i, 'scout'],
  [/plan|architect/i, 'architect'],
  [/review-yagni|yagni/i, 'yagni'],
  [/wiring|runtime/i, 'electrician'],
  [/convention|style|lint/i, 'etiquette'],
  [/fidelity|design|(^|[^a-z])ui([^a-z]|$)|frontend/i, 'painter'],   // "ui" as a word, so "guide" stays a Librarian
  [/security|guard/i, 'guard'],                     // before Inspector: a 'security-audit' carries a shield
  [/skeptic|review|audit|inspect|verify|qa/i, 'inspector'],
  [/test/i, 'tester'],
  [/guide|doc|librar|writer/i, 'librarian'],
  [/debug|fix|bug/i, 'exterminator'],
  [/statusline|paint/i, 'painter'],
];

export const ROLE_NAMES = {
  engineer: 'Engineer', scout: 'Scout', architect: 'Architect', yagni: 'YAGNI Inspector', electrician: 'Electrician',
  etiquette: 'Etiquette Officer', painter: 'Painter', inspector: 'Inspector', tester: 'Tester', librarian: 'Librarian',
  guard: 'Guard', exterminator: 'Exterminator', commander: 'Commander',
};

const GENERIC_TYPES = new Set(['', 'general-purpose', 'general', 'claude', 'agent', 'task', 'default', 'subagent', 'worker']);

export function roleOf(type) {
  const t = String(type || '');
  for (const [re, role] of ROLE_RULES) if (re.test(t)) return role;
  return 'engineer';
}

// Role kit: where each role's identifying props live. R/L = hands; other keys are body slots.
// stow: where a hand item goes while that hand is busy with an action (null = hidden).
const ROLE_KIT = {
  engineer:     [['wrench', 'R', 'belt']],
  scout:        [['binoculars', 'chest']],
  architect:    [['blueprint', 'side']],
  yagni:        [['axe', 'R', 'back']],
  electrician:  [['coil', 'core'], ['multimeter', 'R', 'belt']],
  etiquette:    [['monocle', 'eye'], ['bowtie', 'neck'], ['rulebook', 'L', null]],
  painter:      [['splotches', 'chest'], ['palette', 'L', null], ['brush', 'R', 'belt']],
  inspector:    [['clipboard', 'L', null], ['magnifier', 'R', 'belt']],
  tester:       [['goggles', 'brow'], ['testtube', 'R', 'belt']],
  librarian:    [['books', 'top']],
  guard:        [['shield', 'L', 'back']],
  exterminator: [['spraytank', 'back'], ['flitgun', 'R', 'belt']],
  commander:    [],
};

// Stamp / flourish on finish('done') by role. Reviewers physically stamp it.
const DONE_WORD = {
  inspector: 'APPROVED', yagni: 'CHOPPED!', etiquette: 'ACCEPTABLE.', tester: 'ALL GREEN', exterminator: 'SQUASHED!',
  guard: 'ALL CLEAR', painter: 'PIXEL PERFECT', architect: 'AS PLANNED', scout: 'FOUND IT!', electrician: 'WIRED UP',
  librarian: 'DOCUMENTED', engineer: 'SHIPPED', commander: 'VICTORY!',
};
const STAMPERS = new Set(['inspector', 'yagni', 'etiquette']);

// ---- lines ------------------------------------------------------------------------------------------------

const LINES = {
  role: {
    engineer: [
      "Job's a good'un.", 'It works on my machine. I am the machine.', 'Measure twice, `git reset` once.',
      'Have you tried turning it off and on again?', "That's not a bug. That's load-bearing.", "I fixed it. Don't ask how.",
      'Duct tape is a design pattern.', 'Compiles? Ship it.', "I'll add tests later. Pinky promise.",
      'Why is there a regex here? Who hurt you?', "I've seen things. Nested ternaries.",
      "It's a one-line fix. The line is 400 characters.", 'Off by one? Off by one.',
      'Somebody left a TODO from 2019 in here.', 'One more dependency never hurt anybody.', 'Refactoring. Please hold.',
      'Wrench? Wrench.', 'It builds. I have no idea why. Moving on.',
    ],
    scout: [
      'Scouting ahead!', 'Found 47 files named utils.ts.', 'Grep and ye shall find.',
      "I've seen node_modules. It goes all the way down.", 'Target acquired: a 3,000-line file.',
      "Mapping the terrain. It's mostly config.", "There's a folder called old_old_final2. I'm scared.",
      "Land ho! It's a monorepo.", 'Nothing to report. Suspiciously nothing.', 'Recon complete: the tests are decorative.',
      'Following the imports. Send snacks.', "Where's the entry point? Where's ANY point?", 'Glob pattern engaged.',
    ],
    architect: [
      'The plan is flawless. The plan is 400 lines.', 'Load-bearing TODO detected.', 'Phase one: plan. Phase two: re-plan.',
      "Let's add an abstraction layer. For the abstraction layer.", "I've drawn a diagram. It has arrows. So many arrows.",
      'Step 1: understand. Step 2: ???. Step 3: ship.', 'This needs a factory. A factory factory, ideally.',
      'Microservices? For a todo app? ...Yes.', "Don't worry, I've planned for the unplanned.",
      "Blueprints don't have merge conflicts.", "Let's circle back to the big picture.",
    ],
    yagni: [
      "You ain't gonna need it.", 'Delete it. Delete all of it.', 'A config option for the config options? Chop.',
      'The best code is no code.', 'That abstraction? Firewood.', 'Future-proofing? The future called. It said no.',
      'Timber!', 'Minus 400 lines. Now we are talking.', 'A plugin architecture for one plugin. Chop chop.',
      'Speculative generality detected. Sharpening axe.',
    ],
    electrician: [
      'Is it plugged in? Is it though?', "Don't touch the red wire.", "It's always the environment variables.",
      "Tracing the call graph. It's spaghetti. Live spaghetti.", 'Reading five volts of pure undefined.',
      'Who wired the event bus to itself?', "Circuit's closed. Promise resolved.",
      "Something's drawing current. Probably a setInterval.", "I'm grounded. The code isn't.",
    ],
    etiquette: [
      "We don't do that here.", 'Two spaces. TWO.', 'One does not simply `var`.', 'Trailing whitespace. How uncouth.',
      'Pardon me, your imports are unsorted.', 'camelCase, if you please.', 'A semicolon? At this hour?',
      'Double quotes. How... provincial.', 'I shall be filing a lint report. In triplicate.', 'Pinky out when you commit.',
    ],
    painter: [
      'Can we make it pop?', 'Needs more padding. Everything needs more padding.', "That's not teal. That's cyan's evil twin.",
      'One pixel to the left. No, the OTHER left.', 'Border-radius: yes.', 'z-index: 9999. Trust me.',
      "It's pixel-perfect on my monitor.", 'Is this centered? Nothing is ever centered.', "Let's try it in dark mode.",
      'Painting happy little divs.', 'Flexbox is my love language.',
    ],
    inspector: [
      'Hmm.', 'Hmmmmmm.', 'I have concerns.', 'Nit: this entire file.', 'Looks good to me. Just kidding.',
      'Have you considered... not?', 'Request changes. Emotionally.', "I'll allow it. This time.",
      'Where are the tests? WHERE are the tests?', 'That variable name is a cry for help.',
      'Trust, but verify. Mostly verify.', 'Approved, pending my disapproval.', "I've found 12 issues. Also 3 feelings.",
    ],
    tester: [
      'It passed! ...once.', "Flaky? I prefer 'mood-dependent'.", 'Red. Green. Refactor. Nap.',
      '100% coverage of the happy path.', 'Mocking everything. Including you.', "The tests pass if you don't run them.",
      'Expected: true. Received: vibes.', "This test is load-bearing. Don't look at it.", 'Snapshot updated. Problem solved?',
      'I break things professionally.',
    ],
    librarian: [
      "Shh. I'm documenting.", "It's in the README. Nobody reads the README.", "Filed under 'M' for 'misc'.",
      'The docs are the truth. The code is a rumor.', 'Please return your context by its due date.',
      'Overdue: one JSDoc comment, since 2021.', 'I have a book about that. Several.', 'Quiet in the stacks, please.',
    ],
    guard: [
      'Halt! Who goes there? Oh. A dependency.', 'None shall pass. Especially unsanitized input.', 'Your secrets are showing.',
      "I don't trust that regex.", 'An API key? In the repo? Bold.', 'CORS: my job, my passion.',
      "Password123? Not on my watch.", 'Access denied. Kidding. Unless...?',
    ],
    exterminator: [
      "Who you gonna call? Me.", 'I smell a null pointer.', 'Found the bug. It had babies.',
      "console.log('here'). console.log('here2').", 'Spraying for race conditions.',
      "Heisenbug detected. Don't look directly at it.", '99 bugs in the code... take one down...',
      'Pest control! Nobody panic.', 'This bug has been here since the Bronze Age.',
    ],
  },
  faction: {
    opus: [
      'I shall ponder this at length.', 'Verily, a semicolon.', 'Allow me to elaborate. At length.',
      'Hmm, yes. Quite. Indubitably.', "I've read the entire codebase. Twice. For pleasure.",
      'One does not rush brilliance. One bills for it.', 'Consulting the tome.',
      'My context window is vast. My patience, less so.', 'I have prepared a brief summary. It is forty pages.',
      'Ah, a trivial matter. Let me write a treatise.',
    ],
    sonnet: [
      'Clock in, crank out.', 'Hard hat zone. Mind the stack traces.', 'Another day, another diff.',
      'Blue collar, green checks.', 'Union rules: lunch at noon, tests before merge.', 'Yes, boss.', 'On it.',
      'Reliable as a Tuesday.', 'Safety first. Then the deploy.', 'I bring my own lunch and my own linter.',
    ],
    fable: [
      'Once upon a stack trace...', 'And then the tests passed. The end.', 'It was a dark and stormy deploy.',
      'Chapter three: In Which the Build Fails.', 'Plot twist: it was a caching issue.',
      'And they refactored happily ever after.', 'Our hero ventured into node_modules, never to return.',
      'Legends speak of a green CI.', 'The prophecy foretold of a missing semicolon.',
      "Every function tells a story. This one's a tragedy.",
    ],
    merc: [
      'Contract accepted.', 'Payment received. Executing.', 'Beep. Boop. Billable.', 'Rental unit #4471 reporting.',
      'No questions. Just commits.', 'Warranty void if clicked.', 'Hourly rate applies.',
      'I do not have feelings. I have invoices.', 'Terms and conditions apply.', 'Freelance protocol engaged.',
    ],
  },
  act: {
    bash: ["Tokens don't mine themselves.", 'Strike the earth!', 'Exit code 0, baby!', 'npm install. npm install again.',
      'Mining for exit codes.', 'Is it supposed to smell like burning?', 'Diggy diggy build.'],
    edit: ['Hammer time.', 'Just a small edit. Forty-seven files.', 'Nailed it.', 'Surgical precision. With a hammer.',
      'Find, replace, pray.'],
    read: ['Reading... reading... huh.', 'Who wrote this? Oh. Me.', 'Line 1 of 9,000.', 'Fascinating. Horrifying, but fascinating.',
      "This comment says 'temporary'. It's from 2017."],
    search: ['Beep... beep... BEEP!', "Something's buried here. Probably a TODO.", 'Grepping the soil.',
      "Metal detected. It's a hardcoded URL.", 'X marks the regex.'],
    web: ['Fishing for answers.', "Something's biting! Oh, it's a cookie banner.", 'The internet is vast and full of fish.',
      'Caught a 404 again.', 'Reeling in some documentation.', 'Patience. The page is loading.'],
    agent: ['Troops! Assemble!', 'Delegation is a leadership skill.', 'You! Go grep that!',
      'I need three volunteers. You, you, and you.', 'Report back in ten tool calls!'],
    mcp: ['Hello? Is this the server?', "Yes, I'll hold.", 'Can you hear me now?', '*modem noises*',
      'Please press 1 for JSON.', 'They put me on hold music again.'],
    plan: ['Step one: make a plan. Done!', 'Checkbox. Checkbox. Checkbox.', 'Todo: write todo list.',
      'This plan has a sub-plan.'],
    write: ['Typing. Typing. Backspace. Typing.', 'Words, words, words.', 'Drafting a masterpiece. Or a diff.'],
    skill: ['Says here to read the manual.', 'Ooh, a skill!', "Page one: Don't panic.", 'Chapter 7: Advanced Clicking.'],
    other: ['Tinker, tinker.', 'Just tightening a bolt.', 'Righty-tighty...'],
    think: ['Thinking...', 'Deep thoughts. Shallow copies.', 'Hmm. Hmmmm.', 'What if... no.',
      'Let me think about that. Expensively.', 'Gears are turning.'],
    wait: ['Any minute now...', 'Waiting on I/O. As one does.', 'Still compiling.', 'Is it done? Is it done now?',
      'I could have written this in Assembly by now.'],
    stall: ['This is fine.', "I've been waiting so long I grew a beard.", 'Hello? Anyone?', 'Is this thing on?'],
    lunch: ['Save me a seat!', 'Is this a working lunch?', "Don't tell the user.", 'Snack break is a tool call, right?'],
    idle: ['Standing by.', 'Ready when you are.'],
  },
  commander: {
    working: ['Yes, Commander?', 'Orders received.', 'Leading from the front!', 'Troops, to your stations!',
      "I've got this. Mostly.", 'We ship at dawn!', 'For the codebase!', "I'm the main thread around here."],
    lunch: ['Lunch is a mandatory tool call.', 'Awaiting orders. And a sandwich.', 'Do not disturb: eating.',
      'Context window full. Of snacks.', 'The build can wait. The sandwich cannot.', "Tell the user I'm in a meeting.",
      "Idle? I prefer 'strategically fed'."],
    alert: ['Commander! Your input is required!', 'Hello? Anyone? Orders?', 'Yoo-hoo! Up here!',
      'Yes or no? Please? PLEASE?', "I'm just gonna wave until you notice.", 'Permission to proceed? Permission to proceed??',
      'The user has gone for coffee. Classic.'],
    sleep: ['Zzz... five more minutes...', 'Zzz... refactor... zzz...', 'Mmm... green builds...',
      "Wake me when there's a prompt.", 'Zzz... no... not the monorepo...'],
    think: ['Thinking... thinking...', "Give me a second, I'm having a thought.", 'What would a senior engineer do?',
      'Consulting my inner rubber duck.'],
    wait: ['Waiting on a tool. Tools are slow.', 'Any second now.', 'Hurry up and wait. Classic.'],
  },
  lunchFaction: {
    opus: ["More tea? It's single-origin.", 'The cake is not a lie.', 'Pinkies out, gentlemen.'],
    sonnet: ['Best seat in the city.', "Don't look down. Do look at this sandwich.", 'Same beam, same sandwich, every day.'],
    fable: ['Toasting marshmallows is an art. I am an artist.', "Once upon a s'more...", 'And the marshmallow caught fire. Again.'],
    merc: ['Premium synthetic. Mmm.', "Oil change. Don't judge.", 'Lunch break: 00:30:00. Billing paused.'],
  },
  annoyed: [
    'Stop poking me!', "I'm WORKING here.", "Do you mind? I'm grepping.", 'Keep clicking. See what happens.',
    'Is this a DDoS?', '429: Too Many Clicks.', 'I will file a ticket. About you.', "Clicking harder won't make it compile.",
    'This is going in my logs.', 'My context window is not for this.', 'Please stop. I have a family. Of sub-agents.',
    "You're just testing me now, aren't you?", 'Poke me one more time. I dare you.', "I'm telling the linter.",
    'Okay. Okay! WHAT?!',
  ],
  annoyedFaction: {
    opus: ['I am an expensive model and this is beneath me.', 'Each click costs tokens. Just so you know.'],
    sonnet: ["I'm calling my union rep.", 'Hands off the hard hat.'],
    fable: ['And then the user clicked... AGAIN.', "This chapter is called 'The Poking'."],
    merc: ['Additional clicks will be invoiced.', 'Unauthorized contact. Billing department notified.'],
  },
  annoyedCommander: ["I'm the COMMANDER. Show some respect.", 'Do you poke all your generals like this?'],
  done: ['Mission accomplished!', 'Nailed it!', 'Ship it!', 'Report delivered.', 'Another one for the veterancy banner.'],
  failed: ['It was like that when I got here.', 'I tried.', 'Blame the flaky test.', 'Works on my machine, though.',
    "I'll be in my bunk.", 'Exit code 1. Emotionally.'],
  found: ['a TODO', 'console.log', 'utils.ts (again)', 'a hardcoded API key', '// HACK', '3 unused imports', 'a semicolon',
    'lorem ipsum', 'an old git stash', 'debugger;', 'a FIXME from 2016'],
};

// The Haiku Swarm speaks only in 5-7-5.
const HAIKU = {
  generic: [
    'Tests pass in silence / the linter sleeps, unaware / main is red again',
    'Small green sprite hops by / one semicolon missing / it finds it, happy',
    'Hop, hop, hop, hop, hop / I am very fast and small / did I mention fast',
    'Cheapest in the swarm / yet I finished before you / such efficiency',
    'Deep in node_modules / ten thousand folders whisper / left-pad, left-pad, left',
    'Merge conflict at dawn / two branches, one stubborn line / the crow picks neither',
    'I am but a sprite / small model, enormous heart / please do not click me',
    'Old pond, new commit / a frog leaps into the diff / plop, conflict resolved',
    'Tiny sprite, big dreams / someday I will be Opus / until then, I hop',
    'Bright spring deploy day / nobody wrote the rollback / cherry blossoms fall',
    "Friday afternoon / someone says 'just a quick push' / silence, then pager",
    "The mountain of logs / and each line says 'undefined' / I climb it alone",
    'Small context window / I fill it with cherry blooms / and a stack trace, too',
    'Refactor the world / one tiny hop at a time / the backlog grows back',
  ],
  annoyed: [
    'Stop poking me, please / my context window is full / of your fingerprints',
    'Five clicks, six, seven / the small sprite begins to fume / four twenty-nine, friend',
    'Why do you click me / I have no answers, only / tiny legs that hop',
    'Stop. I am busy. / Even haiku has limits. / This is the last one.',
    'Poke, poke, poke, poke, poke / my patience is a small thing / like me. It is gone.',
    'Click me once, a smile / click me twice, a gentle frown / click thrice: haiku war',
    'I am small, not dumb / I am counting all your clicks / that was fifteen. Stop.',
  ],
  act: {
    bash: ['Crystal in the rock / my tiny pickaxe goes tink / tokens tumble out',
      'Terminal glows green / I type a command, and then / sudo, please, please, please',
      'Tink, tink, the crystal / gives up its tokens slowly / like my old repo'],
    edit: ['Hammer on the plank / one small edit, forty files / tink tink tink tink tink'],
    read: ['Scroll unrolls slowly / the code is older than me / I weep, then I read'],
    search: ['Beep beep goes the wand / something shiny in the dirt / a hardcoded key'],
    web: ['Fishing for answers / the internet bites my hook / reeled in: 404',
      'Line in the water / I wait for a response code / two hundred, okay'],
    agent: ['Megaphone in paw / little helpers, hear me now / go and grep the world'],
    mcp: ["Ring ring, says the phone / the far server says 'please hold' / I hold. Still holding."],
    plan: ['Checklist in my hand / step one is: write down step one / step one: complete. Yay.'],
    write: ['Checklist in my hand / step one is: write down step one / step one: complete. Yay.'],
    skill: ['The manual glows / chapter one: do not panic / chapter two: panic'],
    think: ['Thinking, thinking, hmm / gears turn inside my round head / the answer: maybe',
      'Hmm, says the small sprite / what if the bug is in me? / no. It is in you.'],
    wait: ['Waiting on the build / a single leaf drifts downward / still compiling, sigh',
      'Tap, tap, goes my foot / the hourglass holds much more sand / than the whole beach does'],
    stall: ['Waiting on the build / a single leaf drifts downward / still compiling, sigh'],
    lunch: ['Lunch beneath blossoms / the rice ball is triangle / onigiri, yum',
      'Lunch break in the sun / the bento box has four rooms / all of them are rice',
      'Rice ball in one hand / the build can wait, says my heart / my manager: no'],
    sleep: ['Sleeping little sprite / dreams of green checkmarks, and then / one more flaky test',
      'Zzz, says the small sprite / the cursor blinks in the dark / nobody prompts me'],
    alert: ['The user is gone / the cursor blinks, and blinks, and / I wave antennae',
      'Hello? Up here, please / a question waits for your yes / or perhaps your no'],
  },
  role: {
    scout: 'Grep across the field / a thousand files, one answer / it was the README',
    yagni: 'Chop the config out / you will never need that flag / timber, says the sprite',
    exterminator: 'The bug hides at night / I shine my small lantern eyes / squish. Now it is day',
    guard: 'Halt at the gate, friend / your token is in plain text / none shall pass today',
    painter: 'Paint the button blue / no, the other blue, the one / from the old mockup',
    librarian: 'Quiet in the stacks / the README gathers its dust / like good intentions',
    etiquette: 'Two spaces, not four / a gentle sprite insists, and / tabs are right out, sir',
    architect: 'A plan in nine parts / part one: write a longer plan / part nine: maybe ship',
    electrician: 'Red wire, blue wire, hmm / the multimeter hums low / do not touch the red',
    engineer: 'Wrench in my small paw / I tighten the loose config / it leaks anyway',
    inspector: 'Code review at noon / the senior sighs, then approves / nobody read it',
    tester: "Autumn build server / one flaky test falls like leaves / retry, and it's green",
    commander: 'Leader of the swarm / I hop first, and they follow / mostly to the snacks',
  },
  done: ['Job done, tiny spin / confetti falls like petals / report: delivered'],
  failed: ['The test fell over / I tried my very best, and / my best was a crash'],
};

// ---- shared geometry ----------------------------------------------------------------------------------------

const geoCache = new Map();
function sharedGeo(key, make) {
  let g = geoCache.get(key);
  if (!g) { g = make(); g.userData.shared = true; geoCache.set(key, g); }
  return g;
}
function hemi(r, color, opts = SMALL) {
  return meshOf(sharedGeo(`hemi${r}`, () => new THREE.SphereGeometry(r, 10, 4, 0, TAU, 0, HALF_PI)), color, opts);
}
function disc(r, color, opts = SMALL) {
  return meshOf(sharedGeo(`disc${r}`, () => new THREE.CircleGeometry(r, 16).rotateX(-HALF_PI)), color, opts);
}
function cloak(r, h, color) {
  const g = sharedGeo(`cloak${r}|${h}`, () => {
    const c = jitter(new THREE.ConeGeometry(r, h, 7, 2), 0.04, 11);
    c.translate(0, h / 2, 0);
    return c;
  });
  return meshOf(g, color, CAST);
}
function gear(color) {
  const g = sharedGeo('gear', () => {
    const s = new THREE.Shape();
    const teeth = 8, rO = 0.1, rI = 0.074;
    for (let i = 0; i < teeth * 2; i++) {
      const a0 = (i / (teeth * 2)) * TAU, a1 = ((i + 1) / (teeth * 2)) * TAU, r = i % 2 ? rI : rO;
      if (i === 0) s.moveTo(Math.cos(a0) * r, Math.sin(a0) * r); else s.lineTo(Math.cos(a0) * r, Math.sin(a0) * r);
      s.lineTo(Math.cos(a1) * r, Math.sin(a1) * r);
    }
    const hole = new THREE.Path(); hole.absarc(0, 0, 0.032, 0, TAU, true); s.holes.push(hole);
    const e = new THREE.ExtrudeGeometry(s, { depth: 0.035, bevelEnabled: false, curveSegments: 6 });
    e.translate(0, 0, -0.0175);
    return e;
  });
  return meshOf(g, color, SMALL);
}

// ---- baking ---------------------------------------------------------------------------------------------------
// Rigs are built from many tiny primitives. Before use, the static meshes directly under each rigid node are merged:
// all plain Lambert parts into one vertex-coloured mesh, other materials (glow, glass) into one mesh per material.
// Merged geometry is cached by content, so identical units share it. Animated meshes carry userData.keep.

const VC_MAT = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
VC_MAT.userData.shared = true;
const BAKED = new Map();
const _mtx = new THREE.Matrix4();

function isPlain(m) {
  return !!m && m.isMeshLambertMaterial && !m.transparent && !m.map && !m.vertexColors && m.emissive.r + m.emissive.g + m.emissive.b === 0;
}

function mergeMeshes(list, colors) {
  const parts = [];
  let total = 0;
  for (const m of list) {
    const g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
    g.applyMatrix4(_mtx.compose(m.position, m.quaternion, m.scale));
    parts.push([g, m.material.color]);
    total += g.attributes.position.count;
  }
  const pos = new Float32Array(total * 3), nor = new Float32Array(total * 3), col = colors ? new Float32Array(total * 3) : null;
  let o = 0;
  for (const [g, c] of parts) {
    const p = g.attributes.position, n = g.attributes.normal;
    pos.set(p.array, o * 3);
    if (n) nor.set(n.array, o * 3);
    if (col) for (let i = 0; i < p.count; i++) { const k = (o + i) * 3; col[k] = c.r; col[k + 1] = c.g; col[k + 2] = c.b; }
    o += p.count;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  if (col) out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.computeBoundingSphere();
  out.userData.shared = true;
  return out;
}

function bakeNode(node) {
  const classes = new Map();
  for (const c of node.children) {
    if (!c.isMesh || c.userData.keep || !c.geometry?.attributes?.position) continue;
    const k = isPlain(c.material) ? 'plain' : c.material.uuid;
    if (!classes.has(k)) classes.set(k, []);
    classes.get(k).push(c);
  }
  for (const [k, list] of classes) {
    if (list.length < 2) continue;
    let key = k;
    for (const m of list) {
      const p = m.position, q = m.quaternion, s = m.scale;
      key += `|${m.geometry.uuid}:${k === 'plain' ? m.material.uuid : ''}:${p.x.toFixed(4)},${p.y.toFixed(4)},${p.z.toFixed(4)},${q.x.toFixed(4)},${q.y.toFixed(4)},${q.z.toFixed(4)},${q.w.toFixed(4)},${s.x.toFixed(4)},${s.y.toFixed(4)},${s.z.toFixed(4)}`;
    }
    let geo = BAKED.get(key);
    if (!geo) { geo = mergeMeshes(list, k === 'plain'); BAKED.set(key, geo); }
    const mesh = new THREE.Mesh(geo, k === 'plain' ? VC_MAT : list[0].material);
    mesh.castShadow = list.some((m) => m.castShadow);
    mesh.receiveShadow = false;
    for (const m of list) node.remove(m);
    node.add(freeze(mesh));        // baked into the node's space: never moves on its own
  }
}

function bakeTree(root) {
  const nodes = [];
  root.traverse((o) => { if (!o.isMesh && o.children.length > 1 && !o.userData.nobake) nodes.push(o); });
  for (const n of nodes) bakeNode(n);
  return root;
}

const BLOB_MAT = mat(0x000000, { opacity: 0.22, depthWrite: false });
const MALLOW_MATS = MALLOW.map((c) => mat(c));
const LINE_MAT = mat(0x2b2b38);
const GLASS = () => mat(0xe8fbff, { opacity: 0.55 });

// ---- props ----------------------------------------------------------------------------------------------------
// Hand props are modelled with the grip at the origin and "forward" along +Z (like a torch held at the hip).

function G(...kids) { const g = new THREE.Group(); for (const k of kids) if (k) g.add(k); return g; }
function withTip(g, x, y, z) { const o = new THREE.Object3D(); o.position.set(x, y, z); g.add(o); g.userData.tip = o; return g; }

const PROPS = {
  wrench: () => G(
    at(box(0.034, 0.026, 0.2, PAL.metal, SMALL), 0, -0.013, 0.06),
    at(box(0.1, 0.026, 0.035, PAL.metal, SMALL), 0, -0.013, 0.17),
    at(box(0.028, 0.026, 0.07, PAL.metal, SMALL), 0.036, -0.013, 0.21),
    at(box(0.028, 0.026, 0.07, PAL.metal, SMALL), -0.036, -0.013, 0.21),
  ),
  binoculars: () => G(
    at(cyl(0.034, 0.034, 0.09, 6, PAL.black, SMALL), 0.038, 0, -0.045, { rx: HALF_PI }),
    at(cyl(0.034, 0.034, 0.09, 6, PAL.black, SMALL), -0.038, 0, -0.045, { rx: HALF_PI }),
    at(box(0.05, 0.03, 0.04, PAL.metalDark, SMALL), 0, -0.015, 0),
    at(cyl(0.036, 0.036, 0.012, 6, 0x9fe8ff, SMALL), 0.038, 0, 0.045, { rx: HALF_PI }),
    at(cyl(0.036, 0.036, 0.012, 6, 0x9fe8ff, SMALL), -0.038, 0, 0.045, { rx: HALF_PI }),
  ),
  blueprint: () => G(
    at(cyl(0.036, 0.036, 0.34, 6, 0x3d7fe0, SMALL), 0, 0, -0.17, { rx: HALF_PI }),
    at(cyl(0.038, 0.038, 0.035, 6, 0xeaf2ff, SMALL), 0, 0, 0.1, { rx: HALF_PI }),
  ),
  axe: () => G(
    at(cyl(0.02, 0.024, 0.54, 5, PAL.wood, SMALL), 0, -0.12, 0),
    at(box(0.15, 0.13, 0.034, PAL.metal, { ...SMALL, center: true }), -0.075, 0.33, 0),
    at(box(0.035, 0.17, 0.038, 0xf2f6fb, { ...SMALL, center: true }), -0.16, 0.33, 0),
    at(box(0.05, 0.07, 0.04, PAL.metalDark, { ...SMALL, center: true }), 0.03, 0.33, 0),
  ),
  coil: (u) => {
    const r = (u.R?.coreR ?? 0.16) + 0.035;
    const g = G(at(torus(r, 0.024, 4, 14, 0xd9822b, SMALL), 0, 0, 0, { rx: HALF_PI }));
    g.rotation.z = 0.62;
    return g;
  },
  multimeter: () => G(
    at(box(0.085, 0.12, 0.04, 0xffd23d, SMALL), 0, -0.02, 0.05),
    at(box(0.06, 0.04, 0.008, glow(0x7dffb0, 0.7), SMALL), 0, 0.05, 0.07),
    at(cyl(0.007, 0.007, 0.1, 3, PAL.danger, SMALL), 0.022, -0.12, 0.05),
    at(cyl(0.007, 0.007, 0.1, 3, PAL.black, SMALL), -0.022, -0.12, 0.05),
  ),
  monocle: () => G(
    at(torus(0.042, 0.01, 4, 12, PAL.hazard, SMALL), 0, 0, 0),
    at(cyl(0.004, 0.004, 0.12, 3, PAL.hazard, SMALL), -0.03, -0.14, -0.01, { rz: 0.35 }),
  ),
  bowtie: () => G(
    at(cone(0.045, 0.065, 4, PAL.danger, { ...SMALL, center: true }), 0.04, 0, 0, { rz: HALF_PI }),
    at(cone(0.045, 0.065, 4, PAL.danger, { ...SMALL, center: true }), -0.04, 0, 0, { rz: -HALF_PI }),
    at(box(0.03, 0.035, 0.03, tint(PAL.danger, -0.25), { ...SMALL, center: true }), 0, 0, 0.004),
  ),
  rulebook: () => withLevel(G(
    at(box(0.12, 0.16, 0.045, 0x26263a, SMALL), 0, -0.04, 0.05),
    at(box(0.1, 0.022, 0.047, PAL.hazard, SMALL), 0, 0.05, 0.05),
  ), 0),
  palette: () => withLevel(G(
    at(cyl(0.1, 0.1, 0.014, 9, 0xe3b27a, SMALL), 0, 0, 0.08),
    at(sphere(0.024, 0xff4d6d, SMALL), 0.045, 0.016, 0.1, { s: [1, 0.45, 1] }),
    at(sphere(0.024, 0x3d8bff, SMALL), -0.03, 0.016, 0.13, { s: [1, 0.45, 1] }),
    at(sphere(0.024, 0xffd23d, SMALL), 0.0, 0.016, 0.04, { s: [1, 0.45, 1] }),
    at(sphere(0.024, 0x3ddc84, SMALL), 0.055, 0.016, 0.05, { s: [1, 0.45, 1] }),
  ), 0),
  brush: (u) => G(
    at(cyl(0.012, 0.014, 0.22, 5, PAL.woodDark, SMALL), 0, 0, -0.04, { rx: HALF_PI }),
    at(cone(0.024, 0.06, 5, u.paint, SMALL), 0, 0, 0.24, { rx: -HALF_PI }),
  ),
  splotches: () => G(
    at(sphere(0.034, 0xff4d6d, SMALL), 0.05, 0.03, 0, { s: [1, 1, 0.35] }),
    at(sphere(0.028, 0x3d8bff, SMALL), -0.045, -0.02, 0, { s: [1, 1, 0.35] }),
    at(sphere(0.024, 0xffd23d, SMALL), 0.02, -0.07, 0, { s: [1, 1, 0.35] }),
  ),
  clipboard: () => withLevel(G(
    at(box(0.14, 0.18, 0.016, 0x9a6433, SMALL), 0, -0.07, 0.06),
    at(box(0.115, 0.14, 0.006, 0xfbfbf4, SMALL), 0, -0.08, 0.07),
    at(box(0.055, 0.024, 0.024, PAL.metal, SMALL), 0, 0.1, 0.066),
    at(box(0.08, 0.01, 0.003, 0x9aa3b5, SMALL), 0, 0.03, 0.074),
    at(box(0.08, 0.01, 0.003, 0x9aa3b5, SMALL), 0, 0.0, 0.074),
    at(box(0.06, 0.01, 0.003, 0x9aa3b5, SMALL), -0.01, -0.03, 0.074),
  ), 0),
  magnifier: () => withLevel(G(
    at(cyl(0.013, 0.015, 0.1, 5, PAL.woodDark, SMALL), 0, -0.03, 0.03),
    at(torus(0.055, 0.012, 4, 12, PAL.hazard, SMALL), 0, 0.13, 0.03),
    at(cyl(0.05, 0.05, 0.008, 12, glow(0xbff3ff, 0.3), { ...SMALL, center: true }), 0, 0.13, 0.03, { rx: HALF_PI }),
  ), 0),
  testtube: () => withLevel(G(
    at(cyl(0.026, 0.026, 0.17, 6, GLASS(), SMALL), 0, -0.02, 0.04),
    at(cyl(0.022, 0.022, 0.085, 6, glow(0x6dff7a, 0.9), SMALL), 0, -0.015, 0.04),
    at(cyl(0.028, 0.024, 0.032, 6, 0xc49a6c, SMALL), 0, 0.15, 0.04),
  ), 0),
  goggles: (u) => {
    const R = u.R, hr = (R?.gogR ?? 0.17);
    return G(
      at(torus(hr + 0.006, 0.014, 3, 16, PAL.black, SMALL), 0, 0, 0, { rx: HALF_PI }),
      at(cyl(0.042, 0.042, 0.035, 8, 0x2ed3c5, { ...SMALL, center: true }), 0.058, 0, hr - 0.005, { rx: HALF_PI }),
      at(cyl(0.042, 0.042, 0.035, 8, 0x2ed3c5, { ...SMALL, center: true }), -0.058, 0, hr - 0.005, { rx: HALF_PI }),
    );
  },
  books: () => G(
    at(box(0.19, 0.045, 0.14, 0xd9443a, SMALL), 0, 0, 0, { ry: 0.12 }),
    at(box(0.17, 0.045, 0.13, 0x3d7fe0, SMALL), 0.012, 0.045, 0, { ry: -0.18 }),
    at(box(0.18, 0.045, 0.13, 0x3ddc84, SMALL), -0.01, 0.09, 0, { ry: 0.3 }),
    at(box(0.15, 0.04, 0.12, 0xffd23d, SMALL), 0.005, 0.135, 0, { ry: -0.05 }),
  ),
  shield: (u) => G(
    at(cyl(0.17, 0.17, 0.035, 6, u.pal.dark, { ...SMALL, center: true }), 0, 0, 0, { rx: HALF_PI }),
    at(cyl(0.14, 0.14, 0.04, 6, u.pal.main, { ...SMALL, center: true }), 0, 0, 0.006, { rx: HALF_PI }),
    at(box(0.05, 0.16, 0.03, u.pal.trim, { ...SMALL, center: true }), 0, 0, 0.026),
    at(box(0.16, 0.05, 0.03, u.pal.trim, { ...SMALL, center: true }), 0, 0.02, 0.026),
  ),
  flitgun: () => G(
    at(cyl(0.028, 0.028, 0.26, 7, PAL.metal, SMALL), 0, 0.05, -0.08, { rx: HALF_PI }),
    at(cyl(0.055, 0.055, 0.1, 8, 0x7ed957, { ...SMALL, center: true }), 0, -0.01, 0.13),
    at(cyl(0.057, 0.057, 0.025, 8, PAL.black, { ...SMALL, center: true }), 0, -0.01, 0.13),
    at(cone(0.022, 0.05, 6, PAL.metalDark, SMALL), 0, 0.05, 0.18, { rx: HALF_PI }),
    at(box(0.1, 0.025, 0.025, PAL.danger, { ...SMALL, center: true }), 0, 0.05, -0.1),
  ),
  spraytank: () => G(
    at(cyl(0.07, 0.07, 0.22, 8, 0x7ed957, SMALL), 0, -0.13, -0.07),
    at(cyl(0.072, 0.072, 0.045, 8, PAL.black, SMALL), 0, -0.04, -0.07),
    at(sphere(0.07, 0x7ed957, SMALL), 0, 0.09, -0.07, { s: [1, 0.5, 1] }),
    at(cyl(0.016, 0.016, 0.05, 5, PAL.metalDark, SMALL), 0, 0.1, -0.07),
  ),
  spraywand: () => G(
    at(cyl(0.013, 0.013, 0.26, 5, PAL.metalDark, SMALL), 0, 0, -0.04, { rx: HALF_PI }),
    at(cone(0.03, 0.05, 6, PAL.hazard, SMALL), 0, 0, 0.26, { rx: -HALF_PI }),
  ),
  // action props
  pickaxe: () => withTip(G(
    at(cyl(0.018, 0.018, 0.44, 5, PAL.wood, SMALL), 0, 0, -0.07, { rx: HALF_PI }),
    at(cone(0.032, 0.15, 4, PAL.metal, SMALL), 0, 0, 0.35),
    at(cone(0.032, 0.15, 4, PAL.metal, SMALL), 0, 0, 0.35, { rx: Math.PI }),
    at(box(0.05, 0.05, 0.05, PAL.metalDark, { ...SMALL, center: true }), 0, 0, 0.35),
  ), 0, -0.1, 0.35),
  hammer: () => withTip(G(
    at(cyl(0.016, 0.016, 0.27, 5, PAL.wood, SMALL), 0, 0, -0.05, { rx: HALF_PI }),
    at(box(0.065, 0.13, 0.065, PAL.metalDark, SMALL), 0, -0.065, 0.2),
  ), 0, -0.065, 0.2),
  detector: () => {
    const head = G(
      at(cyl(0.08, 0.08, 0.018, 10, 0x2f3542, { ...SMALL, center: true }), 0, 0, 0),
      at(torus(0.07, 0.01, 3, 12, PAL.hazard, SMALL), 0, 0.01, 0, { rx: HALF_PI }),
    );
    head.position.set(0, 0, 0.5); head.rotation.x = -0.42;
    const g = G(
      at(cyl(0.012, 0.012, 0.52, 4, PAL.metal, SMALL), 0, 0, -0.03, { rx: HALF_PI }),
      at(box(0.055, 0.05, 0.08, 0x2d6cdf, SMALL), 0, 0.012, 0.06),
      at(box(0.02, 0.014, 0.02, glow(PAL.ok, 1), SMALL), 0, 0.062, 0.06),
      head,
    );
    return withTip(g, 0, 0, 0.5);
  },
  headphones: (u) => {
    const R = u.R, hr = (R?.gogR ?? 0.17) + 0.01;
    return G(
      at(torus(hr, 0.016, 3, 12, PAL.black, { ...SMALL, arc: Math.PI }), 0, 0, 0),
      at(cyl(0.055, 0.055, 0.045, 8, u.pal.trim, { ...SMALL, center: true }), hr, 0, 0, { rz: HALF_PI }),
      at(cyl(0.055, 0.055, 0.045, 8, u.pal.trim, { ...SMALL, center: true }), -hr, 0, 0, { rz: HALF_PI }),
    );
  },
  rod: () => withTip(G(
    at(cyl(0.013, 0.024, 0.84, 5, 0x5a3a22, SMALL), 0, 0, -0.06, { rx: HALF_PI }),
    at(cyl(0.02, 0.02, 0.05, 5, PAL.danger, SMALL), 0, 0, 0.3, { rx: HALF_PI }),
    at(cyl(0.032, 0.032, 0.028, 8, PAL.metal, { ...SMALL, center: true }), 0.03, 0, 0.05, { rz: HALF_PI }),
  ), 0, 0, 0.78),
  megaphone: () => withTip(G(
    at(cone(0.09, 0.22, 9, 0xf4f4f4, SMALL), 0, 0, 0.24, { rx: -HALF_PI }),
    at(cyl(0.092, 0.092, 0.035, 9, PAL.danger, SMALL), 0, 0, 0.21, { rx: HALF_PI }),
    at(box(0.03, 0.08, 0.035, PAL.metalDark, SMALL), 0, -0.1, 0.08),
  ), 0, 0, 0.26),
  phone: () => G(
    at(box(0.085, 0.24, 0.065, 0x2c2f38, SMALL), 0, -0.1, 0),
    at(box(0.06, 0.045, 0.008, glow(0x7dff9a, 0.9), SMALL), 0, 0.06, 0.033),
    at(box(0.06, 0.08, 0.008, 0xd8dde6, SMALL), 0, -0.05, 0.033),
    at(cyl(0.011, 0.011, 0.13, 4, PAL.black, SMALL), 0.026, 0.14, 0),
    at(sphere(0.02, PAL.danger, SMALL), 0.026, 0.28, 0),
  ),
  pencil: () => G(
    at(cyl(0.009, 0.009, 0.12, 5, 0xffd23d, SMALL), 0, 0, -0.03, { rx: HALF_PI }),
    at(cone(0.009, 0.028, 5, 0xe3b27a, SMALL), 0, 0, 0.09, { rx: HALF_PI }),
  ),
  manual: () => G(
    at(box(0.28, 0.018, 0.19, 0x2448c8, SMALL), 0, -0.01, 0),
    at(box(0.26, 0.024, 0.17, glow(0xfff2b0, 0.8), SMALL), 0, 0, 0),
    at(box(0.014, 0.032, 0.18, 0x1a2f80, SMALL), 0, 0, 0),
  ),
  scroll: () => {
    const paper = at(box(1, 0.15, 0.008, 0xf3e3b5, SMALL), 0, -0.075, 0);
    const l1 = at(box(1, 0.01, 0.003, 0x9a7b55, SMALL), 0, 0.02, 0.006);
    const l2 = at(box(1, 0.01, 0.003, 0x9a7b55, SMALL), 0, -0.01, 0.006);
    const l3 = at(box(1, 0.01, 0.003, 0x9a7b55, SMALL), 0, -0.04, 0.006);
    const rl = at(cyl(0.018, 0.018, 0.19, 5, PAL.woodDark, SMALL), 0, -0.095, 0);
    const rr = at(cyl(0.018, 0.018, 0.19, 5, PAL.woodDark, SMALL), 0, -0.095, 0);
    const g = G(paper, l1, l2, l3, rl, rr);
    g.userData.nobake = true;
    g.userData.setW = (w) => {
      paper.scale.x = w; l1.scale.x = w * 0.7; l2.scale.x = w * 0.75; l3.scale.x = w * 0.5;
      l3.position.x = -w * 0.1; rl.position.x = -w / 2; rr.position.x = w / 2;
      l1.visible = l2.visible = l3.visible = w > 0.1;
    };
    g.userData.setW(0.03);
    return g;
  },
  watch: () => G(
    at(cyl(0.034, 0.034, 0.02, 8, PAL.hazard, { ...SMALL, center: true }), 0.03, 0.03, 0, { rz: HALF_PI }),
    at(cyl(0.026, 0.026, 0.022, 8, 0xffffff, { ...SMALL, center: true }), 0.032, 0.03, 0, { rz: HALF_PI }),
  ),
  flag: (u) => {
    const cloth = G(
      at(box(0.42, 0.28, 0.016, u.pal.main, { ...SMALL, center: true }), 0.21, -0.14, 0),
      at(box(0.06, 0.13, 0.03, PAL.hazard, { ...SMALL, center: true }), 0.21, -0.11, 0),
      at(box(0.06, 0.05, 0.03, PAL.hazard, { ...SMALL, center: true }), 0.21, -0.225, 0),
    );
    cloth.position.y = 0.86;
    const g = G(at(cyl(0.016, 0.016, 0.98, 4, PAL.woodDark, SMALL), 0, -0.1, 0), cloth,
      at(sphere(0.03, PAL.hazard, SMALL), 0, 0.89, 0));
    g.userData.cloth = cloth;
    g.userData.level = 0;
    return g;
  },
  stamp: () => withTip(G(
    at(sphere(0.04, PAL.woodDark, SMALL), 0, 0.11, 0.0),
    at(cyl(0.02, 0.026, 0.09, 6, PAL.wood, SMALL), 0, 0.02, 0),
    at(box(0.11, 0.035, 0.08, PAL.danger, SMALL), 0, -0.02, 0),
  ), 0, -0.03, 0),
  // food (kept level in the hand)
  teacup: () => withLevel(G(
    at(cyl(0.045, 0.034, 0.055, 8, 0xffffff, SMALL), 0, 0, 0.05),
    at(cyl(0.038, 0.038, 0.006, 8, 0x9b5a2a, SMALL), 0, 0.05, 0.05),
    at(torus(0.02, 0.007, 3, 8, 0xffffff, SMALL), 0.05, 0.028, 0.05, { ry: HALF_PI }),
    at(cyl(0.065, 0.065, 0.008, 10, 0xffffff, SMALL), 0, -0.008, 0.05),
  ), 0),
  sandwich: () => withLevel(G(
    at(box(0.11, 0.024, 0.09, 0xe8b86b, SMALL), 0, 0, 0.05),
    at(box(0.12, 0.014, 0.1, 0x6cbf3e, SMALL), 0, 0.024, 0.05),
    at(box(0.11, 0.014, 0.09, 0xff6b6b, SMALL), 0, 0.034, 0.05),
    at(box(0.11, 0.024, 0.09, 0xe8b86b, SMALL), 0, 0.048, 0.05),
  ), 0),
  onigiri: () => withLevel(G(
    at(cyl(0.075, 0.075, 0.05, 3, 0xfdfdf8, { ...SMALL, center: true }), 0, 0.03, 0.06, { rx: -HALF_PI }),
    at(box(0.05, 0.05, 0.054, 0x1f2a1c, SMALL), 0, -0.012, 0.06),
  ), 0),
  mallow: () => {
    const m = at(cyl(0.032, 0.032, 0.055, 7, MALLOW[0], { ...SMALL, center: true }), 0, 0, 0.38, { rx: HALF_PI });
    const flame = at(cone(0.034, 0.1, 5, glow(0xff9d2e, 1), SMALL), 0, 0.025, 0.38);
    flame.visible = false;
    const g = G(at(cyl(0.007, 0.007, 0.42, 3, PAL.woodDark, SMALL), 0, 0, -0.03, { rx: HALF_PI }), m, flame);
    g.userData.mallow = m; g.userData.flame = flame; g.userData.nobake = true;
    return g;
  },
  oilcan: () => withLevel(G(
    at(cyl(0.048, 0.054, 0.1, 8, PAL.danger, SMALL), 0, -0.02, 0.05),
    at(cone(0.048, 0.05, 8, PAL.danger, SMALL), 0, 0.08, 0.05),
    at(cyl(0.007, 0.009, 0.16, 4, PAL.metalDark, SMALL), 0, 0.11, 0.08, { rx: 0.9 }),
    at(torus(0.03, 0.008, 3, 8, PAL.metalDark, { ...SMALL, arc: Math.PI }), 0, 0.03, 0.0, { ry: HALF_PI }),
  ), 0),
};
function withLevel(g, pitch) { g.userData.level = pitch; return g; }

// World-space props (stay put while the unit walks away).
const XPROPS = {
  crate: () => G(
    box(0.46, 0.3, 0.46, PAL.wood, CAST),
    at(box(0.472, 0.05, 0.472, PAL.woodDark, SMALL), 0, 0.125, 0),
    at(box(0.472, 0.302, 0.05, PAL.woodDark, SMALL), 0, 0, 0),
  ),
  scaffold: () => G(
    at(box(0.05, 0.62, 0.05, PAL.woodDark, SMALL), 0.24, 0, 0),
    at(box(0.05, 0.62, 0.05, PAL.woodDark, SMALL), -0.24, 0, 0),
    at(box(0.56, 0.04, 0.05, PAL.woodDark, SMALL), 0, 0.58, 0),
    at(box(0.12, 0.08, 0.1, PAL.hazard, SMALL), 0.14, 0.31, 0.02),
    at(box(0.6, 0.05, 0.16, PAL.wood, CAST), 0, 0.26, 0),
    at(box(0.04, 0.44, 0.04, PAL.wood, { ...SMALL, center: true }), 0, 0.14, -0.05, { rz: 1.05 }),
    at(box(0.02, 0.05, 0.02, PAL.metal, SMALL), 0.05, 0.3, 0.02),
    at(box(0.02, 0.05, 0.02, PAL.metal, SMALL), -0.09, 0.3, -0.03),
  ),
  gizmo: () => G(
    box(0.28, 0.2, 0.22, PAL.metalDark, CAST),
    at(cyl(0.04, 0.04, 0.12, 6, PAL.metal, SMALL), 0.07, 0.2, 0),
    at(torus(0.055, 0.013, 4, 10, PAL.danger, SMALL), 0.07, 0.32, 0, { rx: HALF_PI }),
    at(box(0.07, 0.045, 0.01, glow(PAL.ok, 0.8), SMALL), -0.06, 0.1, 0.112),
  ),
  bobber: () => G(
    at(sphere(0.045, 0xffffff, { ...SMALL, segments: 8, rings: 6 }), 0, 0, 0),
    at(hemi(0.047, PAL.danger), 0, 0, 0),
    at(cyl(0.006, 0.006, 0.05, 3, PAL.black, SMALL), 0, 0.04, 0),
  ),
  catch: () => {
    const fish = G(
      at(sphere(0.06, 0xff9a3d, { ...SMALL, segments: 7, rings: 5 }), 0, 0, 0, { s: [0.7, 1, 2.1] }),
      at(cone(0.06, 0.09, 4, 0xff7a1a, { ...SMALL, center: true }), 0, 0, -0.16, { rx: HALF_PI, s: [0.4, 1, 1] }),
      at(sphere(0.012, PAL.black, SMALL), 0.035, 0.02, 0.07),
      at(sphere(0.012, PAL.black, SMALL), -0.035, 0.02, 0.07),
    );
    const boot = G(
      at(box(0.09, 0.15, 0.09, 0x6b4a2e, SMALL), 0, -0.05, -0.03),
      at(box(0.09, 0.06, 0.12, 0x6b4a2e, SMALL), 0, -0.05, 0.06),
      at(box(0.1, 0.02, 0.2, 0x3d2a1a, SMALL), 0, -0.07, 0.02),
    );
    const pot = G(
      at(sphere(0.075, 0xffffff, SMALL), 0, 0, 0, { s: [1, 0.8, 1] }),
      at(cone(0.022, 0.1, 5, 0xffffff, SMALL), 0, -0.01, 0.07, { rx: 1.1 }),
      at(sphere(0.02, PAL.hazard, SMALL), 0, 0.07, 0),
    );
    const g = G(fish, boot, pot);
    g.userData.kinds = [fish, boot, pot];
    return g;
  },
};

// Lunch set pieces.
function makeTeaSet(pal) {
  const cake = G(
    at(cyl(0.085, 0.085, 0.06, 10, 0xffb3d1, SMALL), 0, 0, 0),
    at(cyl(0.062, 0.062, 0.05, 10, 0xfff5f5, SMALL), 0, 0.06, 0),
    at(sphere(0.024, 0xff3355, SMALL), 0, 0.13, 0),
    at(cyl(0.006, 0.006, 0.045, 3, 0xffffff, SMALL), 0.025, 0.11, 0),
  );
  cake.position.set(-0.13, 0, 0.02);
  const pot = G(
    at(sphere(0.06, 0xffffff, SMALL), 0, 0.05, 0, { s: [1, 0.85, 1] }),
    at(cone(0.017, 0.08, 5, 0xffffff, SMALL), 0.06, 0.04, 0, { rz: -1.0 }),
    at(sphere(0.016, pal.trim, SMALL), 0, 0.105, 0),
  );
  pot.position.set(0.13, 0, -0.03);
  const cup = G(at(cyl(0.028, 0.022, 0.035, 7, 0xffffff, SMALL), 0, 0.006, 0), at(cyl(0.045, 0.045, 0.006, 8, 0xffffff, SMALL), 0, 0, 0));
  cup.position.set(0.02, 0, 0.12);
  return G(cake, pot, cup);
}
function makeTeaCart(pal) {
  const legs = [];
  for (const [x, z] of [[0.22, 0.14], [-0.22, 0.14], [0.22, -0.14], [-0.22, -0.14]]) legs.push(at(cyl(0.013, 0.013, 0.38, 4, pal.trim, SMALL), x, 0, z));
  const cake = G(
    at(cyl(0.1, 0.1, 0.07, 10, 0xffb3d1, SMALL), 0, 0, 0),
    at(cyl(0.075, 0.075, 0.06, 10, 0xfff5f5, SMALL), 0, 0.07, 0),
    at(sphere(0.026, 0xff3355, SMALL), 0, 0.15, 0),
    at(cyl(0.006, 0.006, 0.05, 3, 0xffffff, SMALL), 0.03, 0.13, 0),
  );
  cake.position.set(-0.11, 0.4, 0);
  const pot = G(
    at(sphere(0.07, 0xffffff, SMALL), 0, 0.06, 0, { s: [1, 0.85, 1] }),
    at(cone(0.02, 0.09, 5, 0xffffff, SMALL), 0.07, 0.05, 0, { rz: -1.0 }),
    at(sphere(0.018, pal.trim, SMALL), 0, 0.125, 0),
    at(torus(0.035, 0.009, 3, 8, 0xffffff, { ...SMALL, arc: Math.PI }), -0.07, 0.06, 0, { rz: HALF_PI }),
  );
  pot.position.set(0.12, 0.4, 0.02);
  return G(
    at(box(0.52, 0.03, 0.34, pal.trim, CAST), 0, 0.37, 0),
    at(box(0.48, 0.025, 0.3, tint(pal.trim, -0.15), SMALL), 0, 0.12, 0),
    ...legs, cake, pot,
  );
}
function makeBeam(len) {
  const red = 0xc0472e, blocks = 0x9aa0ad;
  return G(
    at(box(len, 0.035, 0.18, red, CAST), 0, 0.325, 0),
    at(box(len, 0.1, 0.035, red, SMALL), 0, 0.225, 0),
    at(box(len, 0.035, 0.18, red, SMALL), 0, 0.19, 0),
    at(box(0.24, 0.19, 0.26, blocks, CAST), len / 2 - 0.18, 0, 0),
    at(box(0.24, 0.19, 0.26, blocks, CAST), -len / 2 + 0.18, 0, 0),
    at(box(0.2, 0.1, 0.2, tint(blocks, -0.2), SMALL), len / 2 - 0.12, 0, 0.3, { ry: 0.3 }),
  );
}
function makePail() {
  return G(
    at(box(0.2, 0.12, 0.13, 0x6f7f95, SMALL), 0, 0, 0),
    at(box(0.21, 0.025, 0.14, 0x55647a, SMALL), 0, 0.12, 0),
    at(torus(0.07, 0.009, 3, 10, PAL.metalDark, { ...SMALL, arc: Math.PI }), 0, 0.14, 0),
  );
}
function makePicnic() {
  const bento = G(
    box(0.32, 0.07, 0.24, 0x3a1f1f, SMALL),
    at(box(0.14, 0.02, 0.1, 0xfdfdf8, SMALL), -0.075, 0.07, -0.055),
    at(box(0.14, 0.02, 0.1, 0xff8a65, SMALL), 0.075, 0.07, -0.055),
    at(box(0.14, 0.02, 0.1, 0x7ed957, SMALL), -0.075, 0.07, 0.055),
    at(box(0.14, 0.02, 0.1, 0xffd54f, SMALL), 0.075, 0.07, 0.055),
  );
  bento.position.y = 0.014;
  const oni = G(
    at(cyl(0.06, 0.06, 0.04, 3, 0xfdfdf8, { ...SMALL, center: true }), 0, 0.05, 0, { rx: -HALF_PI }),
    at(box(0.04, 0.04, 0.044, 0x1f2a1c, SMALL), 0, 0.0, 0),
  );
  oni.position.set(0.3, 0.014, 0.22);
  return G(
    at(box(1.3, 0.012, 1.3, 0xff8fbd, SMALL), 0, 0, 0),
    at(box(0.64, 0.014, 0.64, 0xffd0e4, SMALL), 0.33, 0, 0.33),
    at(box(0.64, 0.014, 0.64, 0xffd0e4, SMALL), -0.33, 0, -0.33),
    bento, oni,
  );
}
function makeCampfire() {
  const flames = G(
    at(cone(0.14, 0.34, 6, glow(0xff7a1a, 1), SMALL), 0, 0.03, 0),
    at(cone(0.085, 0.24, 6, glow(0xffe45c, 1), SMALL), 0.01, 0.03, 0.02),
  );
  const stones = [];
  for (let i = 0; i < 7; i++) { const a = (i / 7) * TAU; stones.push(at(ico(0.055, 0, PAL.rock, SMALL), Math.sin(a) * 0.24, 0.03, Math.cos(a) * 0.24)); }
  const g = G(
    at(cyl(0.035, 0.035, 0.38, 5, PAL.woodDark, { ...SMALL, center: true }), 0, 0.04, 0, { rz: HALF_PI, ry: 0.4 }),
    at(cyl(0.035, 0.035, 0.38, 5, PAL.woodDark, { ...SMALL, center: true }), 0, 0.07, 0, { rz: HALF_PI, ry: -0.8 }),
    at(cyl(0.035, 0.035, 0.38, 5, PAL.wood, { ...SMALL, center: true }), 0, 0.1, 0, { rz: HALF_PI, ry: 1.9 }),
    ...stones, flames,
  );
  g.userData.flames = flames;
  return g;
}
function makeLog(len = 0.62) {
  return G(
    at(cyl(0.085, 0.085, len, 6, PAL.wood, { ...CAST, center: true }), 0, 0.085, 0, { rz: HALF_PI }),
    at(cyl(0.07, 0.07, len + 0.012, 6, 0xe8c08a, { ...SMALL, center: true }), 0, 0.085, 0, { rz: HALF_PI }),
  );
}
function makeDrum() {
  return G(
    cyl(0.15, 0.15, 0.42, 9, 0x3e7cb1, CAST),
    at(cyl(0.155, 0.155, 0.03, 9, 0x2b5a85, SMALL), 0, 0.12, 0),
    at(cyl(0.155, 0.155, 0.03, 9, 0x2b5a85, SMALL), 0, 0.3, 0),
    at(cyl(0.03, 0.03, 0.02, 6, PAL.metalDark, SMALL), 0.07, 0.42, 0.04),
  );
}

// Overlay items (above the head, billboarded).
const OVERLAYS = {
  thought: () => {
    const w = 0xffffff;
    const g1 = gear(PAL.metalDark), g2 = gear(PAL.hazard);
    g1.position.set(-0.055, 0.215, 0.14); g2.position.set(0.075, 0.25, 0.13); g2.scale.setScalar(0.72);
    const g = G(
      at(sphere(0.17, w, SMALL), 0, 0.22, 0),
      at(sphere(0.12, w, SMALL), -0.16, 0.16, -0.02),
      at(sphere(0.12, w, SMALL), 0.16, 0.18, -0.02),
      at(sphere(0.1, w, SMALL), 0.03, 0.1, -0.03),
      at(sphere(0.045, w, SMALL), -0.14, -0.03, 0),
      at(sphere(0.028, w, SMALL), -0.19, -0.1, 0),
      g1, g2,
    );
    g.userData.gears = [g1, g2];
    g1.userData.keep = g2.userData.keep = true;
    return g;
  },
  hourglass: () => {
    const glass = mat(0xdff6ff, { opacity: 0.8 });
    const hg = G(
      at(cone(0.085, 0.12, 6, glass, { ...SMALL, center: true }), 0, 0.06, 0, { rx: Math.PI }),
      at(cone(0.085, 0.12, 6, glass, { ...SMALL, center: true }), 0, -0.06, 0),
      at(cone(0.06, 0.06, 6, 0xffb13d, { ...SMALL, center: true }), 0, -0.09, 0),
      at(cone(0.035, 0.035, 6, 0xffb13d, { ...SMALL, center: true }), 0, 0.03, 0, { rx: Math.PI }),
      at(cyl(0.004, 0.004, 0.1, 3, 0xffb13d, { ...SMALL, center: true }), 0, -0.02, 0),
      at(cyl(0.095, 0.095, 0.016, 6, PAL.woodDark, { ...SMALL, center: true }), 0, 0.125, 0),
      at(cyl(0.095, 0.095, 0.016, 6, PAL.woodDark, { ...SMALL, center: true }), 0, -0.125, 0),
    );
    hg.position.set(0, 0.2, 0.13);
    const g = G(
      at(sphere(0.15, 0xffffff, SMALL), 0, 0.2, 0),
      at(sphere(0.1, 0xffffff, SMALL), -0.13, 0.14, -0.02),
      at(sphere(0.1, 0xffffff, SMALL), 0.13, 0.15, -0.02),
      at(sphere(0.04, 0xffffff, SMALL), -0.12, -0.02, 0),
      hg,
    );
    g.userData.glass = hg;
    return g;
  },
  rain: () => {
    const c = 0x8c93a8;
    const drops = [];
    for (let i = 0; i < 5; i++) { const d = at(box(0.016, 0.06, 0.016, 0x6fb7ff, { ...SMALL, center: true }), (i - 2) * 0.05, 0, (i % 2) * 0.03); d.userData.keep = true; drops.push(d); }
    const g = G(
      at(sphere(0.12, c, SMALL), 0, 0.12, 0),
      at(sphere(0.09, c, SMALL), -0.12, 0.08, 0),
      at(sphere(0.09, c, SMALL), 0.12, 0.09, 0),
      at(sphere(0.08, tint(c, -0.15), SMALL), 0.02, 0.04, 0.04),
      ...drops,
    );
    g.userData.drops = drops;
    return g;
  },
  check: () => G(
    at(box(0.07, 0.17, 0.06, glow(PAL.ok, 0.9), { ...SMALL, center: true }), -0.075, 0.0, 0, { rz: 0.68 }),
    at(box(0.07, 0.34, 0.06, glow(PAL.ok, 0.9), { ...SMALL, center: true }), 0.06, 0.07, 0, { rz: -0.66 }),
  ),
  bang: () => G(
    at(box(0.075, 0.22, 0.06, glow(PAL.hazard, 0.9), { ...SMALL, center: true }), 0, 0.15, 0),
    at(box(0.075, 0.075, 0.06, glow(PAL.hazard, 0.9), { ...SMALL, center: true }), 0, -0.04, 0),
  ),
  zees: () => {
    const zs = [];
    for (let i = 0; i < 3; i++) {
      const zc = 0xdff3ff;
      const z = G(
        at(box(0.13, 0.03, 0.03, zc, { ...SMALL, center: true }), 0, 0.065, 0),
        at(box(0.13, 0.03, 0.03, zc, { ...SMALL, center: true }), 0, -0.065, 0),
        at(box(0.03, 0.18, 0.03, zc, { ...SMALL, center: true }), 0, 0, 0, { rz: -0.86 }),
      );
      zs.push(z);
    }
    const g = G(...zs);
    g.userData.zs = zs;
    return g;
  },
  snot: () => at(sphere(0.06, mat(0xbfefff, { opacity: 0.6 }), { ...SMALL, segments: 8, rings: 6 }), 0, 0, 0),
};

// ---- spellcasting (commanders) --------------------------------------------------------------------------------
// While their session works / thinks / waits, commanders stay at a fixed command post just in front of their HQ and
// cast at the add-on module of the current tool category: a rune circle tinted by category, rising sparkles and a
// bolt every ~1.5-3 s with a small impact flash, plus a faction flourish. Materials are unlit and shared per colour,
// geometry is shared, and bolts come from a two-slot pool per commander.

const CAST_COLOR = {
  edit: 0xff8a1f, bash: 0x39e5ff, read: 0xa77bff, search: 0xa77bff, web: 0x2ee6c8, agent: 0xffc53d,
  mcp: 0xff4fd8, plan: 0xffffff, write: 0xffffff, skill: 0x5ee65a, other: 0xd6e6ff,
};
const THINK_COLOR = { opus: 0xffd447, sonnet: 0x6fdcff, haiku: 0xff8fc4, fable: 0x3ee0d2, merc: 0xff6b6b };
const WAIT_COLOR = 0xffb13d;
const HOURGLASS_COLOR = 0xffd27a;
const PETAL_COLOR = 0xffa9cf;
const ARC_COLOR = 0xdff4ff;
// Acts that send a unit to a particular place; re-targeting these on every tool hop is what whipped units around.
const STATION_ACTS = new Set(['bash', 'read', 'web', 'edit', 'agent', 'mcp', 'lunch', 'sleep']);
// Command post candidates as (side, forward) offsets from the door point, in lot units (side = lot-local +X):
// just left of the door path first (the module yard is on the right), clear of the door, table and lot edge.
const POST_CANDS = [[-0.58, 1.0], [-0.5, 1.25], [-0.8, 0.7], [-0.45, 0.62], [0.72, 0.9], [0, 1.3]];

const CAST_MATS = new Map();
function castMat(color, kind = 'solid') {
  const key = `${kind}:${color}`;
  let m = CAST_MATS.get(key);
  if (m) return m;
  const o = { color, toneMapped: false, side: THREE.DoubleSide };
  if (kind === 'fill') Object.assign(o, { transparent: true, opacity: 0.24, depthWrite: false });
  else if (kind === 'line') Object.assign(o, { transparent: true, opacity: 0.95, depthWrite: false });
  else if (kind === 'aura') Object.assign(o, { transparent: true, depthWrite: false, vertexColors: true });
  else if (kind === 'halo') Object.assign(o, { transparent: true, opacity: 0.35, depthWrite: false });
  else if (kind === 'holo') Object.assign(o, { transparent: true, opacity: 0.45, depthWrite: false });
  m = new THREE.MeshBasicMaterial(o);
  m.userData.shared = true;
  CAST_MATS.set(key, m);
  return m;
}

// Merge flat parts into one position-only geometry (the unlit materials need no normals).
function flatMerge(parts) {
  const flat = parts.map((g) => (g.index ? g.toNonIndexed() : g));
  let n = 0;
  for (const f of flat) n += f.attributes.position.array.length;
  const pos = new Float32Array(n);
  let o = 0;
  for (const f of flat) { pos.set(f.attributes.position.array, o); o += f.attributes.position.array.length; }
  for (const g of parts) g.dispose();
  for (const f of flat) f.dispose();
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.computeBoundingSphere();
  return out;
}
// A thin quad from (x0, y0) to (x1, y1) in the XY plane.
function strip(x0, y0, x1, y1, w) {
  return new THREE.PlaneGeometry(w, Math.hypot(x1 - x0, y1 - y0)).rotateZ(Math.atan2(y1 - y0, x1 - x0) - HALF_PI).translate((x0 + x1) / 2, (y0 + y1) / 2, 0);
}
// Rune tiles (three alternating shapes) standing on a ring of radius r, facing outward and tilted up by `tilt`
// (so the iso camera sees them face-on rather than edge-on).
function glyphRingGeo(n, r, s, tilt = 0) {
  const parts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU, v = i % 3;
    const tile = v === 0 ? [new THREE.CircleGeometry(s, 4), strip(0, s, 0, s * 2.1, s * 0.32)]
      : v === 1 ? [new THREE.RingGeometry(s * 0.5, s, 4), strip(-s, -s * 1.35, s, -s * 1.35, s * 0.32)]
        : [new THREE.CircleGeometry(s * 0.95, 3).rotateZ(HALF_PI), new THREE.CircleGeometry(s * 0.32, 6).translate(0, s * 1.55, 0)];
    for (const g of tile) parts.push(g.rotateX(-tilt).rotateY(a).translate(Math.sin(a) * r, 0, Math.cos(a) * r));
  }
  return flatMerge(parts);
}

const CAST_GEO = {
  outer: () => sharedGeo('cast:outer', () => {
    const parts = [new THREE.RingGeometry(0.535, 0.615, 56)];
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * TAU, r1 = i % 2 ? 0.49 : 0.52, b = a + TAU / 24;
      parts.push(strip(Math.cos(a) * 0.43, Math.sin(a) * 0.43, Math.cos(a) * r1, Math.sin(a) * r1, 0.03));
      parts.push(new THREE.CircleGeometry(0.026, 4).translate(Math.cos(b) * 0.485, Math.sin(b) * 0.485, 0));
    }
    return flatMerge(parts).rotateX(-HALF_PI);
  }),
  inner: () => sharedGeo('cast:inner', () => {
    const parts = [new THREE.RingGeometry(0.32, 0.365, 44), new THREE.RingGeometry(0.07, 0.105, 20)];
    for (let t = 0; t < 2; t++) {
      for (let i = 0; i < 3; i++) {   // hexagram
        const a0 = (t ? -HALF_PI : HALF_PI) + (i * TAU) / 3, a1 = a0 + TAU / 3;
        parts.push(strip(Math.cos(a0) * 0.335, Math.sin(a0) * 0.335, Math.cos(a1) * 0.335, Math.sin(a1) * 0.335, 0.022));
      }
    }
    return flatMerge(parts).rotateX(-HALF_PI);
  }),
  fill: () => sharedGeo('cast:fill', () => new THREE.CircleGeometry(0.61, 40).rotateX(-HALF_PI)),
  // a soft column of light over the circle (vertex alpha fades it out upward)
  aura: () => sharedGeo('cast:aura', () => {
    const g = new THREE.CylinderGeometry(0.5, 0.58, 1.2, 28, 1, true);
    const p = g.attributes.position, col = new Float32Array(p.count * 4);
    for (let i = 0; i < p.count; i++) { col[i * 4] = col[i * 4 + 1] = col[i * 4 + 2] = 1; col[i * 4 + 3] = p.getY(i) < 0 ? 0.3 : 0; }
    g.setAttribute('color', new THREE.BufferAttribute(col, 4));
    return g.translate(0, 0.6, 0);
  }),
  orb: () => sharedGeo('cast:orb', () => new THREE.IcosahedronGeometry(0.1, 1)),
  halo: () => sharedGeo('cast:halo', () => new THREE.IcosahedronGeometry(0.19, 1)),
  ring6: () => sharedGeo('cast:ring6', () => glyphRingGeo(6, 0.62, 0.085, 0.6)),
  crown: () => sharedGeo('cast:crown', () => glyphRingGeo(8, 0.3, 0.036)),
  hourglass: () => sharedGeo('cast:hourglass', () => flatMerge([
    new THREE.CircleGeometry(0.075, 3).rotateZ(-HALF_PI).translate(0, 0.065, 0),
    new THREE.CircleGeometry(0.075, 3).rotateZ(HALF_PI).translate(0, -0.065, 0),
    new THREE.PlaneGeometry(0.16, 0.024).translate(0, 0.135, 0),
    new THREE.PlaneGeometry(0.16, 0.024).translate(0, -0.135, 0),
  ])),
  petal: () => sharedGeo('cast:petal', () => new THREE.CircleGeometry(0.06, 6).scale(1, 0.55, 1)),
  seg: () => sharedGeo('cast:seg', () => new THREE.BoxGeometry(1, 1, 1)),
  pane: () => sharedGeo('cast:pane', () => new THREE.PlaneGeometry(0.26, 0.17)),
  paneUi: () => sharedGeo('cast:paneUi', () => flatMerge([
    new THREE.PlaneGeometry(0.15, 0.014).translate(-0.035, 0.05, 0.003),
    new THREE.PlaneGeometry(0.2, 0.014).translate(-0.01, 0.018, 0.003),
    new THREE.PlaneGeometry(0.11, 0.014).translate(-0.055, -0.014, 0.003),
    new THREE.RingGeometry(0.018, 0.03, 12).translate(0.08, -0.045, 0.003),
    new THREE.PlaneGeometry(0.26, 0.01).translate(0, 0.08, 0.003),
    new THREE.PlaneGeometry(0.26, 0.01).translate(0, -0.08, 0.003),
  ])),
};

// Opus: an open tome that floats in front of the Magister (one leaf flips over the spine now and then).
function makeOpenTome(pal) {
  const page = 0xfff6dc;
  const leaf = G(at(box(0.15, 0.006, 0.2, page, { ...SMALL, center: true }), 0.075, 0, 0));
  leaf.position.set(0, 0.042, 0);
  const g = G(
    at(box(0.36, 0.02, 0.25, pal.dark, { ...SMALL, center: true }), 0, 0, 0),
    at(box(0.16, 0.034, 0.22, page, { ...SMALL, center: true }), -0.083, 0.022, 0, { rz: 0.14 }),
    at(box(0.16, 0.034, 0.22, page, { ...SMALL, center: true }), 0.083, 0.022, 0, { rz: -0.14 }),
    at(box(0.02, 0.03, 0.25, pal.trim, { ...SMALL, center: true }), 0, 0.012, 0),
    at(box(0.07, 0.006, 0.07, glow(pal.trim, 1), { ...SMALL, center: true }), -0.085, 0.043, 0, { rz: 0.14, ry: 0.78 }),
    at(box(0.07, 0.006, 0.07, glow(pal.trim, 1), { ...SMALL, center: true }), 0.085, 0.043, 0, { rz: -0.14, ry: 0.78 }),
    leaf,
  );
  g.userData.leaf = leaf;
  return bakeTree(g);
}
// Sonnet: a holographic tablet (a glowing pane with UI lines) held in the left hand.
function makeTablet() {
  const pane = meshOf(CAST_GEO.pane(), castMat(0x7fe9ff, 'holo'), SMALL);
  const ui = meshOf(CAST_GEO.paneUi(), castMat(0xe8feff, 'line'), SMALL);
  pane.renderOrder = ui.renderOrder = 4;
  return G(pane, ui);
}
// Sonnet: a long wrench with an arc crackling between its jaws.
function makeTechWrench() {
  return withTip(G(
    at(box(0.032, 0.032, 0.34, PAL.metal, { ...SMALL, center: true }), 0, 0, 0.11),
    at(box(0.042, 0.042, 0.08, PAL.hazard, { ...SMALL, center: true }), 0, 0, -0.02),
    at(box(0.13, 0.034, 0.04, PAL.metal, { ...SMALL, center: true }), 0, 0, 0.29),
    at(box(0.032, 0.034, 0.085, PAL.metal, { ...SMALL, center: true }), 0.05, 0, 0.335),
    at(box(0.032, 0.034, 0.085, PAL.metal, { ...SMALL, center: true }), -0.05, 0, 0.335),
    at(ico(0.03, 0, glow(0x7fe9ff, 1), SMALL), 0, 0, 0.335),
  ), 0, 0, 0.34);
}
// Fable: a wand with a star on the tip.
function makeWand(pal) {
  return withTip(G(
    at(cyl(0.011, 0.016, 0.32, 5, PAL.woodDark, SMALL), 0, 0, -0.04, { rx: HALF_PI }),
    at(ico(0.036, 0, glow(pal.glow, 1), SMALL), 0, 0, 0.3),
    at(box(0.11, 0.014, 0.014, glow(pal.glow, 1), { ...SMALL, center: true }), 0, 0, 0.3),
    at(box(0.014, 0.11, 0.014, glow(pal.glow, 1), { ...SMALL, center: true }), 0, 0, 0.3),
  ), 0, 0, 0.3);
}

const _k1 = new THREE.Vector3(), _k2 = new THREE.Vector3(), _k3 = new THREE.Vector3(), _k4 = new THREE.Vector3();
const _kq = new THREE.Quaternion(), _ke = new THREE.Euler(), _km = new THREE.Matrix4(), _ks = new THREE.Vector3();
const _kz = new THREE.Vector3(0, 0, 1), _kc = new THREE.Color();
const _jag = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];

// ---- bodies ---------------------------------------------------------------------------------------------------

function makeLeg(R, x, hip, len, color, boot) {
  const g = new THREE.Group();
  g.position.set(x, hip, 0);
  g.add(at(box(0.09, len, 0.1, color, SMALL), 0, -len, 0));
  g.add(at(box(0.105, 0.06, 0.155, boot, SMALL), 0, -hip, 0.02));
  R.mover.add(g);
  return g;
}
function makeFoot(R, x, y, z, r, color) {
  const g = new THREE.Group();
  g.position.set(x, y, 0);
  g.add(at(sphere(r, color, SMALL), 0, -y + r * 0.62, z, { s: [1, 0.65, 1.35] }));
  R.mover.add(g);
  return g;
}
function makeArms(R, x, y, len, build) {
  R.armL.position.set(x, y, 0); build(R.armL, 1); R.handL.position.set(0, -len, 0);
  R.armR.position.set(-x, y, 0); build(R.armR, -1); R.handR.position.set(0, -len, 0);
  R.armLen = len; R.shoulderX = x; R.shoulderY = y;
}
// Both eyes live in one group at eye height so a blink is a single y-squash (and they bake into one mesh).
function addEyes(R, x, y, z, r, material, boxy = false) {
  const g = new THREE.Group();
  g.position.set(0, y, 0);
  for (const s of [1, -1]) {
    const e = boxy
      ? at(box(r * 2.2, r * 1.8, 0.012, material, { ...SMALL, center: true }), x * s, 0, z)
      : at(sphere(r, material, { ...SMALL, segments: 6, rings: 4 }), x * s, 0, z);
    g.add(e); R.eyes.push(e);
  }
  R.head.add(g);
  R.eyeGroup = g;
}

const BODY = {
  sonnet(R, pal, u) {
    const pants = tint(pal.main, -0.3);
    R.hipH = 0.2; R.torso.position.y = 0.2;
    R.legL = makeLeg(R, 0.07, 0.2, 0.15, pants, 0x4a3426);
    R.legR = makeLeg(R, -0.07, 0.2, 0.15, pants, 0x4a3426);
    R.torso.add(box(0.27, 0.235, 0.19, pal.main, CAST));
    R.torso.add(at(box(0.282, 0.048, 0.2, 0x5b3a22, SMALL), 0, 0.012, 0));
    R.torso.add(at(box(0.055, 0.055, 0.04, PAL.hazard, SMALL), 0.09, 0.0, 0.1));
    R.torso.add(at(box(0.1, 0.075, 0.012, tint(pal.main, -0.18), SMALL), 0, 0.12, 0.098));
    R.head.position.set(0, 0.235, 0);
    R.head.add(at(sphere(0.17, u.skin, { ...CAST, segments: 10, rings: 8 }), 0, 0.15, 0));
    addEyes(R, 0.062, 0.125, 0.155, 0.028, PAL.black);
    if (u.r() < 0.33) R.head.add(at(box(0.11, 0.028, 0.03, 0x5b3a22, SMALL), 0, 0.07, 0.158));
    else R.head.add(at(box(0.05, 0.014, 0.02, 0x8a3b2b, SMALL), 0, 0.075, 0.162));
    const hat = at(hemi(0.182, pal.trim, CAST), 0, 0.215, 0, { s: [1, 0.92, 1] });
    const brim = at(cyl(0.2, 0.205, 0.022, 12, pal.trim, SMALL), 0, 0.205, 0.03);
    const band = at(cyl(0.184, 0.184, 0.028, 12, tint(pal.trim, -0.18), SMALL), 0, 0.222, 0);
    const badge = at(box(0.06, 0.045, 0.02, 0xffffff, SMALL), 0, 0.28, 0.165, { rx: -0.45 });
    R.head.add(hat, brim, band, badge); R.hat.push(hat, brim);
    makeArms(R, 0.16, 0.205, 0.205, (arm) => {
      arm.add(at(box(0.075, 0.17, 0.075, 0xeef3f7, SMALL), 0, -0.17, 0));
      arm.add(at(sphere(0.05, 0xf5c542, SMALL), 0, -0.2, 0));
    });
    Object.assign(R, { headCY: 0.15, headR: 0.17, gogR: 0.188, eyeY: 0.125, faceZ: 0.155, frontZ: 0.095, backZ: 0.095, coreY: 0.12, coreR: 0.16, holdY: 0.17, topY: 0.38 });
    R.height = 0.2 + 0.235 + 0.385;
  },
  opus(R, pal, u) {
    R.hipH = 0; R.torso.position.y = 0.03;
    R.legL = makeFoot(R, 0.085, 0.06, 0.21, 0.058, pal.dark);
    R.legR = makeFoot(R, -0.085, 0.06, 0.21, 0.058, pal.dark);
    R.footScale = 0.35;
    R.torso.add(cyl(0.13, 0.275, 0.42, 8, pal.main, CAST));
    R.torso.add(cyl(0.28, 0.29, 0.055, 8, pal.trim, SMALL));
    R.torso.add(at(box(0.055, 0.4, 0.016, pal.trim, SMALL), 0, 0.02, 0.265, { rx: -0.32 }));
    R.torso.add(at(cyl(0.155, 0.165, 0.055, 8, pal.trim, SMALL), 0, 0.39, 0));
    R.head.position.set(0, 0.43, 0);
    R.head.add(at(sphere(0.17, u.skin, { ...CAST, segments: 10, rings: 8 }), 0, 0.14, 0));
    addEyes(R, 0.058, 0.17, 0.148, 0.025, PAL.black);
    R.head.add(at(box(0.07, 0.024, 0.026, 0xf4f4f4, SMALL), 0.062, 0.212, 0.142, { rz: -0.28 }));
    R.head.add(at(box(0.07, 0.024, 0.026, 0xf4f4f4, SMALL), -0.062, 0.212, 0.142, { rz: 0.28 }));
    R.head.add(at(cone(0.125, 0.24, 7, 0xf7f7fb, SMALL), 0, 0.105, 0.1, { rx: Math.PI }));
    const halo = at(torus(0.12, 0.022, 5, 18, glow(pal.trim, 0.85), SMALL), 0, 0.42, 0, { rx: HALF_PI });
    halo.userData.keep = true;
    R.head.add(halo); R.extra.halo = halo; R.extra.haloY = 0.42;
    const tome = G(
      at(box(0.17, 0.22, 0.016, pal.dark, { ...SMALL, center: true }), 0, 0, 0.034),
      at(box(0.17, 0.22, 0.016, pal.dark, { ...SMALL, center: true }), 0, 0, -0.034),
      at(box(0.15, 0.2, 0.054, 0xfff6dc, { ...SMALL, center: true }), 0.006, 0, 0),
      at(box(0.024, 0.224, 0.086, pal.trim, { ...SMALL, center: true }), -0.082, 0, 0),
      at(box(0.04, 0.04, 0.09, pal.trim, { ...SMALL, center: true }), 0.07, 0.0, 0),
      at(ico(0.03, 0, glow(pal.glow, 0.9), SMALL), 0.0, 0.03, 0.046),
    );
    tome.position.set(0.33, 0.48, 0.02); tome.rotation.set(0.15, 0, 0.12);
    R.mover.add(tome); R.extra.tome = tome;
    makeArms(R, 0.145, 0.33, 0.25, (arm) => {
      arm.add(at(cyl(0.045, 0.075, 0.22, 6, pal.main, SMALL), 0, -0.22, 0));
      arm.add(at(cyl(0.079, 0.079, 0.03, 6, pal.trim, SMALL), 0, -0.225, 0));
      arm.add(at(sphere(0.043, u.skin, SMALL), 0, -0.25, 0));
    });
    Object.assign(R, { headCY: 0.14, headR: 0.17, gogR: 0.17, eyeY: 0.17, faceZ: 0.15, frontZ: 0.16, backZ: 0.15, coreY: 0.25, coreR: 0.19, holdY: 0.3, topY: 0.3, beltAt: [-0.215, 0.2, 0.05] });
    R.height = 0.03 + 0.43 + 0.31;
  },
  haiku(R, pal, u) {
    R.hipH = 0.03; R.torso.position.y = 0;
    R.legL = makeFoot(R, 0.1, 0.06, 0.04, 0.058, pal.dark);
    R.legR = makeFoot(R, -0.1, 0.06, 0.04, 0.058, pal.dark);
    R.torso.add(at(sphere(0.25, pal.main, { ...CAST, segments: 10, rings: 8 }), 0, 0.28, 0, { s: [1, 0.94, 1] }));
    R.torso.add(at(sphere(0.16, tint(pal.main, 0.4), { ...SMALL, segments: 8, rings: 6 }), 0, 0.22, 0.19, { s: [1, 1, 0.45] }));
    R.head.position.set(0, 0.28, 0);
    addEyes(R, 0.088, 0.045, 0.214, 0.044, PAL.black);
    for (const s of [1, -1]) {
      R.head.add(at(sphere(0.014, 0xffffff, SMALL), 0.078 * s, 0.062, 0.252));
      R.head.add(at(sphere(0.045, pal.trim, SMALL), 0.158 * s, -0.02, 0.18, { s: [1, 0.7, 0.45] }));
      const a = new THREE.Group();
      a.position.set(0.075 * s, 0.2, -0.02); a.rotation.z = -0.38 * s; a.userData.side = s;
      a.add(cyl(0.012, 0.015, 0.18, 4, pal.dark, SMALL));
      a.add(at(sphere(0.048, glow(pal.trim, 0.35), SMALL), 0, 0.2, 0));
      R.head.add(a); (R.extra.ant ||= []).push(a);
    }
    makeArms(R, 0.235, 0.27, 0.06, (arm) => arm.add(at(sphere(0.058, pal.main, SMALL), 0, -0.035, 0)));
    Object.assign(R, { headCY: 0, headR: 0.25, gogR: 0.222, eyeY: 0.045, faceZ: 0.23, frontZ: 0.245, backZ: 0.23, coreY: 0.28, coreR: 0.26, holdY: 0.24, topY: 0.225, beltAt: [-0.25, 0.26, 0.04] });
    R.height = 0.53;
  },
  fable(R, pal, u) {
    R.hipH = 0; R.torso.position.y = 0; R.float = 0.09;
    R.torso.add(cloak(0.25, 0.44, pal.main));
    R.torso.add(at(cyl(0.125, 0.142, 0.036, 7, pal.trim, SMALL), 0, 0.2, 0));
    for (let i = 0; i < 3; i++) {
      const a = 0.7 + i * 1.9;
      R.torso.add(at(ico(0.02, 0, glow(pal.glow, 0.8), SMALL), Math.sin(a) * 0.2, 0.08 + i * 0.03, Math.cos(a) * 0.2));
    }
    R.head.position.set(0, 0.38, 0);
    R.head.add(at(sphere(0.165, tint(pal.main, -0.12), { ...CAST, segments: 9, rings: 7 }), 0, 0.1, 0));
    R.head.add(at(sphere(0.12, 0x2a0f2e, SMALL), 0, 0.085, 0.127, { s: [1, 0.95, 0.42] }));
    addEyes(R, 0.046, 0.1, 0.172, 0.025, glow(pal.glow, 1));
    const brim = at(cyl(0.2, 0.2, 0.022, 9, pal.trim, SMALL), 0, 0.225, 0);
    const band = at(cyl(0.132, 0.14, 0.036, 8, pal.glow, SMALL), 0, 0.232, 0);
    const hat = G(
      at(cone(0.135, 0.31, 8, pal.trim, CAST), 0, 0, 0),
      at(ico(0.026, 0, glow(pal.glow, 1), SMALL), 0.07, 0.1, 0.06),
      at(ico(0.02, 0, glow(pal.glow, 1), SMALL), -0.05, 0.17, 0.035),
      at(ico(0.018, 0, glow(pal.glow, 1), SMALL), 0.01, 0.06, -0.11),
    );
    hat.position.set(0, 0.23, 0); hat.rotation.x = -0.14;
    R.head.add(brim, band, hat); R.hat.push(hat.children[0], brim); R.extra.hat = hat;
    makeArms(R, 0.12, 0.3, 0.19, (arm) => {
      arm.add(at(cyl(0.035, 0.062, 0.17, 6, pal.main, SMALL), 0, -0.17, 0));
      arm.add(at(sphere(0.037, 0xe9d8ff, SMALL), 0, -0.19, 0));
    });
    Object.assign(R, { headCY: 0.1, headR: 0.165, gogR: 0.165, eyeY: 0.1, faceZ: 0.17, frontZ: 0.1, backZ: 0.075, coreY: 0.22, coreR: 0.15, holdY: 0.27, topY: 0.33, beltAt: [-0.16, 0.2, 0.04] });
    R.height = 0.38 + 0.23 + 0.31;
  },
  merc(R, pal, u) {
    const light = tint(pal.main, 0.22);
    R.hipH = 0.14; R.torso.position.y = 0.14;
    for (const s of [1, -1]) {
      const g = new THREE.Group(); g.position.set(0.08 * s, 0.14, 0);
      g.add(at(box(0.08, 0.1, 0.09, PAL.metalDark, SMALL), 0, -0.11, 0));
      g.add(at(box(0.1, 0.035, 0.14, 0x3e4452, SMALL), 0, -0.14, 0.015));
      R.mover.add(g); if (s > 0) R.legL = g; else R.legR = g;
    }
    R.torso.add(box(0.3, 0.24, 0.24, pal.main, CAST));
    R.torso.add(at(box(0.306, 0.042, 0.246, pal.trim, SMALL), 0, 0.15, 0));
    R.torso.add(at(box(0.07, 0.04, 0.01, PAL.hazard, SMALL), -0.07, 0.06, 0.121));
    R.torso.add(at(box(0.036, 0.036, 0.01, glow(PAL.ok, 0.9), SMALL), 0.08, 0.062, 0.121));
    R.torso.add(at(cyl(0.045, 0.045, 0.05, 6, PAL.metalDark, SMALL), 0, 0.235, 0));
    R.head.position.set(0, 0.27, 0);
    R.head.add(box(0.3, 0.22, 0.26, light, CAST));
    R.head.add(at(box(0.25, 0.095, 0.02, PAL.black, SMALL), 0, 0.075, 0.125));
    addEyes(R, 0.06, 0.122, 0.138, 0.024, glow(pal.trim, 1), true);
    for (const s of [1, -1]) R.head.add(at(cyl(0.045, 0.045, 0.03, 8, PAL.metalDark, { ...SMALL, center: true }), 0.155 * s, 0.1, 0, { rz: HALF_PI }));
    R.head.add(at(cyl(0.01, 0.01, 0.17, 4, PAL.metalDark, SMALL), 0.08, 0.22, 0));
    const tipOn = glow(pal.trim, 1), tipOff = mat(tint(pal.trim, -0.5));
    const tip = at(sphere(0.032, tipOn, SMALL), 0.08, 0.4, 0);
    tip.userData.keep = true;
    R.head.add(tip); R.extra.antTip = tip; R.extra.antOn = tipOn; R.extra.antOff = tipOff;
    makeArms(R, 0.19, 0.2, 0.21, (arm) => {
      arm.add(at(box(0.065, 0.16, 0.065, PAL.metalDark, SMALL), 0, -0.16, 0));
      arm.add(at(box(0.08, 0.06, 0.08, 0x3e4452, SMALL), 0, -0.215, 0));
    });
    Object.assign(R, { headCY: 0.11, headR: 0.15, gogR: 0.17, eyeY: 0.122, faceZ: 0.14, frontZ: 0.12, backZ: 0.12, coreY: 0.12, coreR: 0.2, holdY: 0.18, topY: 0.22 });
    R.height = 0.14 + 0.27 + 0.22;
  },
};

// Cape per faction: [shoulder y (torso space), back z, width, length, base tilt].
const CAPE = {
  sonnet: [0.225, 0.1, 0.25, 0.3, 0.12],
  opus: [0.385, 0.15, 0.27, 0.37, 0.36],
  haiku: [0.44, 0.17, 0.22, 0.22, 0.8],
  fable: [0.33, 0.075, 0.21, 0.32, 0.52],
  merc: [0.23, 0.125, 0.26, 0.3, 0.1],
};

function buildRig(u, faction) {
  const pal = factionPal(faction);
  const R = {
    faction, pal,
    mover: new THREE.Group(), torso: new THREE.Group(), head: new THREE.Group(),
    armL: new THREE.Group(), armR: new THREE.Group(), handL: new THREE.Group(), handR: new THREE.Group(),
    legL: null, legR: null, eyes: [], hat: [], extra: {}, slots: {},
    hipH: 0.2, float: 0, footScale: 1, armLen: 0.2, shoulderX: 0.15, shoulderY: 0.2, height: 0.8,
  };
  R.mover.add(R.torso);
  R.torso.add(R.head, R.armL, R.armR);
  R.armL.add(R.handL); R.armR.add(R.handR);
  u.R = R;
  BODY[faction](R, pal, u);
  const S = R.slots;
  const node = (parent, x, y, z) => { const o = new THREE.Group(); o.position.set(x, y, z); parent.add(o); return o; };
  S.top = node(R.head, 0, R.topY, 0);
  S.face = node(R.head, 0, R.eyeY, R.faceZ + 0.01);
  S.eye = node(R.head, -(R.eyes[1]?.position.x ?? -0.06), R.eyeY, R.faceZ + 0.02);
  S.brow = node(R.head, 0, R.headCY + R.headR * 0.45, 0);
  S.head = node(R.head, 0, R.headCY, 0);
  S.ear = node(R.head, -(R.headR + 0.015), R.headCY + 0.01, 0.02);
  S.mouth = node(R.head, 0, R.eyeY - 0.06, R.faceZ + 0.02);
  S.back = node(R.torso, 0, R.coreY, -R.backZ);
  S.chest = node(R.torso, 0, R.holdY - 0.02, R.frontZ + 0.005);
  S.neck = node(R.torso, 0, R.shoulderY + 0.02, R.frontZ * 0.85);
  S.core = node(R.torso, 0, R.coreY, 0);
  S.side = node(R.torso, R.shoulderX + 0.035, R.coreY + 0.02, 0);
  S.belt = R.beltAt ? node(R.torso, ...R.beltAt) : node(R.torso, -(R.shoulderX - 0.02), 0.04, 0.07);
  S.front = node(R.torso, 0, R.holdY + 0.03, R.frontZ + 0.14);
  S.R = R.handR; S.L = R.handL;
  if (u.isCommander) {
    const [cy, cz, cw, ch, crx] = CAPE[faction];
    const cape = new THREE.Group();
    cape.position.set(0, cy, -cz); cape.rotation.x = crx;
    cape.add(at(box(cw, ch, 0.024, pal.trim, CAST), 0, -ch, 0));
    cape.add(at(box(cw + 0.03, 0.04, 0.03, tint(pal.trim, -0.2), SMALL), 0, -0.02, 0.005));
    R.torso.add(cape); R.extra.cape = cape; R.extra.capeRx = crx;
    const flag = G(
      at(box(0.2, 0.14, 0.012, pal.main, SMALL), 0.1, -0.14, 0),
      at(ico(0.034, 0, glow(pal.glow, 0.9), SMALL), 0.1, -0.07, 0.012),
    );
    flag.position.y = 0.6;
    const banner = G(at(cyl(0.013, 0.013, 0.62, 4, PAL.woodDark, SMALL), 0, 0, 0), flag, at(sphere(0.026, pal.trim, SMALL), 0, 0.62, 0));
    banner.position.set(0.05, -0.05, -0.03); banner.rotation.set(-0.12, 0, -0.1);
    S.back.add(banner); R.extra.flag = flag;
  }
  return R;
}

// ---- module state -------------------------------------------------------------------------------------------

const LIVE = [];                 // every live unit (separation, apprentices, lunch)
const COMMANDERS = new Map();    // building key -> commander Unit
const SLOTS = new Map();         // station key -> [unit id | null]
const AMBIENT = { last: -1e9 };
const FRAME = { t: NaN, world: null, camYaw: Math.PI / 4, obsT: -1e9, obs: [], nObs: 0, boost: 1 };
const FX_WARNED = new Set();
const TRY_TURNS = [0.55, -0.55, 1.1, -1.1, 1.65, -1.65];

const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _v4 = new THREE.Vector3();
const _v5 = new THREE.Vector3();

function isVec(v) { return !!v && Number.isFinite(v.x) && Number.isFinite(v.z); }
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function trunc(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
function crossed(prev, u, mark) { return prev <= u ? prev < mark && u >= mark : prev < mark || u >= mark; }
function wrapAngle(a) { return ((a + Math.PI) % TAU + TAU) % TAU - Math.PI; }

function claimSlot(key, id) {
  let arr = SLOTS.get(key);
  if (!arr) SLOTS.set(key, (arr = []));
  let i = arr.indexOf(id);
  if (i >= 0) return i;
  i = arr.indexOf(null);
  if (i < 0) { i = arr.length; arr.push(id); } else arr[i] = id;
  return i;
}
function releaseSlot(key, id) {
  const arr = SLOTS.get(key);
  if (!arr) return;
  const i = arr.indexOf(id);
  if (i >= 0) arr[i] = null;
  while (arr.length && arr[arr.length - 1] == null) arr.pop();
  if (!arr.length) SLOTS.delete(key);
}
function slotOffset(i) { return i === 0 ? 0 : (i % 2 ? 1 : -1) * Math.ceil(i / 2); }
function vkey(v) { return `${v.x.toFixed(1)},${v.z.toFixed(1)}`; }

// Building footprints as circles: around building.center (the HQ core) when buildings.js provides it, else around
// the group position with the ~2.2 m lot radius.
function refreshObstacles(world) {
  let n = 0;
  const bs = world?.buildings;
  if (bs && typeof bs.values === 'function') {
    for (const b of bs.values()) {
      const g = b?.group;
      if (!g || b.disposed || b._disposed) continue;
      let o = FRAME.obs[n];
      if (!o) o = FRAME.obs[n] = { x: 0, z: 0, r: 2.2 };
      if (isVec(b.center)) {
        o.x = b.center.x; o.z = b.center.z;
        o.r = (Number.isFinite(b.obstacleRadius) ? b.obstacleRadius : 1.7) * (g.scale?.x || 1);
      } else {
        try { g.getWorldPosition(_v5); } catch { continue; }
        o.x = _v5.x; o.z = _v5.z; o.r = Number.isFinite(b.obstacleRadius) ? b.obstacleRadius : 2.2;
      }
      n++;
    }
  }
  FRAME.nObs = n;
}

// Circle-obstacle steering (shared by buildings and island obstacles). Writes into the STEER scratch object:
// sx/sz = detour direction around the nearest blocking circle, px/pz = push-out when standing inside one.
const STEER = { sx: 0, sz: 0, best: Infinity, px: 0, pz: 0 };
function steerAround(list, n, p, dx, dz, d, tx, tz, S) {
  for (let i = 0; i < n; i++) {
    const o = list[i];
    if (!o) continue;
    let r = o.r;
    const dT = Math.hypot(tx - o.x, tz - o.z);
    if (dT < r + 0.35) r = dT - 0.35;              // the target sits at/inside the circle: shrink it
    if (!(r >= 0.3)) continue;
    const px = p.x - o.x, pz = p.z - o.z, dP = Math.hypot(px, pz);
    if (dP < r) { if (dP > 1e-4) { const k = (r - dP) / r; S.px += (px / dP) * k * 2; S.pz += (pz / dP) * k * 2; } continue; }
    const proj = -(px * dx + pz * dz);
    if (proj < 0 || proj > d) continue;
    const cx = px + dx * proj, cz = pz + dz * proj, cd = Math.hypot(cx, cz);
    if (cd >= r + 0.15 || proj >= S.best) continue;
    S.best = proj;
    let nx, nz;
    if (cd > 1e-3) { nx = cx / cd; nz = cz / cd; } else { nx = -dz; nz = dx; }
    const wx = o.x + nx * (r + 0.5) - p.x, wz = o.z + nz * (r + 0.5) - p.z, wl = Math.hypot(wx, wz) || 1;
    S.sx = wx / wl; S.sz = wz / wl;
  }
}

function frameShared(u, t) {
  if (FRAME.t === t && FRAME.world === u.world) return;
  FRAME.t = t; FRAME.world = u.world;
  const cam = u.engine?.camera;
  if (cam?.matrixWorld) { const e = cam.matrixWorld.elements; FRAME.camYaw = Math.atan2(e[8], e[10]); }
  // zoomed far out, spell circles and bolts grow (up to 2.6x, aiming at ~34 px across) so a casting commander
  // still reads as one
  let ppu = NaN;
  try { ppu = u.engine?.view?.ppu?.(); } catch { ppu = NaN; }
  FRAME.boost = Number.isFinite(ppu) && ppu > 0 ? clamp(34 / (ppu * 1.22), 1, 2.6) : 1;
  if (t - FRAME.obsT > 1 || t < FRAME.obsT) { FRAME.obsT = t; refreshObstacles(u.world); }
}

function newPose() {
  return { my: 0, mrx: 0, mrz: 0, mry: 0, sq: 1, lift: 0, bx: 0, bz: 0, by: 0, hx: 0, hy: 0, hz: 0,
    aLx: 0, aLz: 0.12, aLy: 0, aRx: 0, aRz: 0.12, aRy: 0, gL: 0, gR: 0 };
}
function resetPose(P) {
  P.my = 0; P.mrx = 0; P.mrz = 0; P.mry = 0; P.sq = 1; P.lift = 0; P.bx = 0; P.bz = 0; P.by = 0;
  P.hx = 0; P.hy = 0; P.hz = 0; P.aLx = 0; P.aLz = 0.12; P.aLy = 0; P.aRx = 0; P.aRz = 0.12; P.aRy = 0; P.gL = 0; P.gR = 0;
}

let cssDone = false;
const LABEL_CSS = `
.lbl-unit { font-size: 0.9em; }
.lbl-unit .lbl-card { gap: 0.2em; padding: 0.26em 0.55em 0.3em; }
.lbl-unit .name { font-size: 1em; }
.lbl-unit .who { font-size: 0.78em; font-weight: 600; opacity: 0.7; }
.lbl-unit .detail { max-width: 17em; overflow: hidden; text-overflow: ellipsis; }
.lbl-unit .detail.act { color: #39e5ff; }`;
const STATE_WORD = {
  working: 'Working', thinking: 'Thinking', waiting: 'Waiting', stalled: 'Stalled', needs_input: 'Needs you', idle: 'Lunch',
  asleep: 'Asleep', done: 'Done', failed: 'Failed', lost: 'Lost',
};

// ---- Unit -----------------------------------------------------------------------------------------------------

export class Unit {
  constructor(world, opts = {}) {
    const { kind = 'agent', data = {}, building = null, island = null, instant = false, parent: parentOpt = null, spawn = null } = opts || {};
    this.world = world || {};
    this.engine = this.world.engine || null;
    this.kind = kind === 'commander' ? 'commander' : 'agent';
    this.isCommander = this.kind === 'commander';
    this.data = data || {};
    this.building = building || null;
    this.island = island || null;
    const d = this.data;
    this.id = this.isCommander ? (d.key ?? d.sessionId ?? 'commander') : (d.id ?? 'agent');
    this.cmdId = this.isCommander ? `cmd:${this.id}` : null;   // world.js keys commanders (and their picks) like this
    this.key = this.isCommander ? (d.key ?? building?.key ?? null) : (building?.key ?? d.session ?? null);
    this.r = rng(`${this.kind}:${this.id}`);
    this.seed = this.r();
    this.depth = this.isCommander ? 0 : Math.max(1, d.depth || 1);
    this.apprentice = this.depth >= 2;
    this.faction = FACTIONS.includes(d.faction) ? d.faction : FACTIONS.includes(building?.faction) ? building.faction : 'merc';
    this.role = this.isCommander ? 'commander' : roleOf(d.type);
    this.skin = SKIN[Math.floor(this.r() * SKIN.length) % SKIN.length];
    this.paint = PAINTS[Math.floor(this.r() * PAINTS.length) % PAINTS.length];
    this.baseScale = this.isCommander ? 1.22 : this.apprentice ? 0.7 : 1;
    this.popScale = 1;
    this.scaleNow = this.baseScale;
    this.disposed = false;
    this.t = Number.isFinite(this.engine?.time) ? this.engine.time : 0;
    this.dt = 1 / 60;

    this.group = new THREE.Group();
    this.group.name = `${this.kind}:${this.id}`;
    this.group.userData.unit = this;
    this.sizer = new THREE.Group();
    this.group.add(this.sizer);
    this.extras = new THREE.Group();
    this.extras.name = `${this.group.name}:props`;
    this.blob = disc(0.25, BLOB_MAT);
    this.blob.position.y = 0.014; this.blob.renderOrder = 1;
    this.group.add(this.blob);
    this.overlay = new THREE.Group();
    this.overlay.rotation.order = 'YXZ';
    this.overlay.rotation.x = -0.5;
    this.talk = new THREE.Object3D();
    this.P = newPose();
    this.props = new Map();      // name -> Object3D (cached, re-parented as needed)
    this.xprops = new Map();     // world-space props
    this.ovs = new Map();        // overlay items
    this.parts = [];             // transient particles { mesh, life, max, vx, vy, vz, kind }
    this.roleItems = [];
    this.buildBody();

    // behaviour state
    this.act = null; this.phase = 'idle'; this.actT = 0; this.pu = 0;
    this.pendingAct = null; this.pendingT = 0;
    this.spot = { x: 0, y: 0, z: 0, yaw: NaN, key: null, lift: 0, sit: -1 };
    this.nav = { tx: NaN, tz: NaN, y0: 0, d0: 1, best: Infinity, stuck: 0 };
    this.yaw = 0; this.moving = false; this.walkPhase = this.r() * 10; this.speedNow = 0;
    this.liftNow = 0; this.onRoof = false; this.lunchSeat = -1; this.lunchHost = null; this.lunchSet = null;
    this.blinkT = 1 + this.r() * 3; this.lookT = 0; this.lookYaw = 0;
    this.nextAmbient = this.t + 25 + this.r() * 120;
    this.clicks = []; this.reactT = 0; this.duckT = 0; this.checkT = 0; this.bangT = 0; this.lastFx = -1;
    this.selected = false; this.hovered = false; this.label = null; this.labelHtmlLast = '';
    this.finishing = null; this.status = null; this.seq = null; this.snap = false;

    // placement
    const p = this.group.position;
    this.groundY = Number.isFinite(building?.door?.y) ? building.door.y : Number.isFinite(island?.top) ? island.top : 1.5;
    const parent = this.apprentice ? (parentOpt?.group && !parentOpt.disposed ? parentOpt : this.findParent()) : null;
    if (parent) p.copy(parent.group.position);
    else if (isVec(spawn)) p.set(spawn.x, Number.isFinite(spawn.y) ? spawn.y : this.groundY, spawn.z);
    else if (isVec(building?.door)) p.set(building.door.x, this.groundY, building.door.z);
    else { this.homeCenter(p); p.y = this.groundY; }
    this.yaw = Math.atan2(...this.doorOutXZ());
    this.group.rotation.y = this.yaw;

    LIVE.push(this);
    if (this.isCommander && this.key != null) COMMANDERS.set(this.key, this);
    this.listen();
    if (instant) this.materialize();
    else this.seq = this.seqSpawn(parent);
    this.applyScale();
  }

  // ---- public API --------------------------------------------------------------------------------------------

  update(data) {
    if (!data || this.disposed) return;
    this.data = data;
    if (FACTIONS.includes(data.faction) && data.faction !== this.faction) {
      this.faction = data.faction;
      this.buildBody();
      this.fx('puff', this.headWorld(new THREE.Vector3()), { color: this.pal.glow, count: 8, size: 0.35, spread: 0.4, rise: 0.5 });
    }
    if (!this.isCommander) {
      const role = roleOf(data.type);
      if (role !== this.role) { this.role = role; this.buildBody(); }
    }
    this.refreshLabel();
  }

  tick(dt, t) {
    if (this.disposed) return;
    dt = Math.min(Number.isFinite(dt) && dt > 0 ? dt : 1 / 60, 0.1);
    this.dt = dt;
    this.t = Number.isFinite(t) ? t : this.t + dt;
    this.attach();
    frameShared(this, this.t);
    resetPose(this.P);
    this.snap = false;
    this.moving = false;
    try {
      if (this.seq) this.runSeq();
      else this.behave(dt);
      this.layers(dt);
      this.applyPose(dt);
      this.applyScale();
      this.animateParts(dt);
      this.overlayTick(dt);
      this.xpropsTick(dt);
      this.particlesTick(dt);
      if (this.caster) this.castTick(dt);
      if (!this.finishing) this.ambient();
    } catch (e) {
      if (!this._warned) { this._warned = true; console.warn('units: tick failed for', this.id, e); }
    }
  }

  finish(status = 'done') {
    if (this.finishing) return this.finishing;
    this.status = status === 'failed' || status === 'lost' ? status : 'done';
    this.finishing = new Promise((resolve) => { this._resolveFinish = resolve; });
    this.finishT0 = this.t;
    this.stopZzz();
    this.releaseEverything();
    this.clearAct();
    this.act = null;
    this.seq = this.status === 'lost' ? this.seqLost() : this.status === 'failed' ? this.seqFailed() : this.seqDone();
    this._finishTimer = setTimeout(() => this.resolveFinish(), 40000);
    this.refreshLabel();
    return this.finishing;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.releaseEverything();
    const i = LIVE.indexOf(this);
    if (i >= 0) LIVE.splice(i, 1);
    if (this.isCommander && COMMANDERS.get(this.key) === this) COMMANDERS.delete(this.key);
    this.unlisten();
    this.stopZzz();
    this.stopTrail();
    try { this.label?.remove?.(); } catch { /* ignore */ }
    this.label = null;
    if (this.lunchSet) { disposeTree(this.lunchSet.group); this.lunchSet = null; }
    this.castDispose();
    disposeTree(this.extras);
    disposeTree(this.group);
    this.resolveFinish();
  }

  // Extras for world/HUD.
  get roleName() { return ROLE_NAMES[this.role] || 'Engineer'; }
  get pal() { return factionPal(this.faction); }
  get position() { return this.group.position; }

  tooltip() {
    const d = this.data || {};
    const who = this.isCommander ? `${this.pal.unit} Commander` : `${this.pal.unit} ${this.roleName}${this.apprentice ? ' (apprentice)' : ''}`;
    const what = this.isCommander ? d.name : d.description || d.type;
    return [who, what && trunc(what, 44), this.activityText()].filter(Boolean).join(' · ');
  }

  say(text, secs = 3.2) {
    if (!text || this.disposed) return;
    this.lastLine = text;
    const fx = this.engine?.fx;
    try {
      if (typeof fx?.bubble === 'function') fx.bubble(this.talk, text, { secs, offset: new THREE.Vector3(0, 0.12, 0) });
      else if (typeof fx?.text === 'function') fx.text(this.headWorld(new THREE.Vector3(), 0.3), text, { color: '#ffffff', rise: 0.5 });
    } catch (e) { if (!FX_WARNED.has('bubble')) { FX_WARNED.add('bubble'); console.warn('units: fx.bubble failed', e); } }
  }

  poke() {
    const now = this.t;
    const recent = this.clicks.filter((c) => now - c < 6);
    recent.push(now);
    this.clicks = recent;
    const annoyed = recent.length >= 5;
    this.say(this.pickLine(annoyed ? 'annoyed' : 'poke'), annoyed ? 3.4 : 3);
    this.reactT = annoyed ? 1.1 : 0.9;
    this.reactAnnoyed = annoyed;
    if (annoyed) this.fx('puff', this.headWorld(new THREE.Vector3(), 0.1), { color: 0xff6b6b, count: 4, size: 0.2, spread: 0.3, rise: 0.9, life: 0.6 });
  }

  // Duck and cover for a moment (e.g. the building next door is being demolished).
  duck(secs = 1.3) { if (!this.finishing && !this.disposed) this.duckT = Math.max(this.duckT, secs); }

  // ---- scene plumbing ----------------------------------------------------------------------------------------

  attach() {
    if (!this.group.parent) {
      const root = this.engine?.root || this.engine?.scene;
      if (root) root.add(this.group);
    }
    const par = this.group.parent;
    if (par && this.extras.parent !== par) par.add(this.extras);
    if (this.lunchSet && par && this.lunchSet.group.parent !== par) par.add(this.lunchSet.group);
    this.extras.visible = this.group.visible;
  }

  buildBody() {
    if (this.R) {
      if (this.caster) this.castDropRig();
      this.sizer.remove(this.R.mover);
      this.R.mover.remove(this.overlay, this.talk);
      for (const o of this.props.values()) o.parent?.remove(o);
      for (const it of this.roleItems) it.obj.parent?.remove(it.obj);
      disposeTree(this.R.mover);
      this.props.clear(); this.roleItems = []; this.mounted = []; this.snot = null;
    }
    buildRig(this, this.faction);
    this.applyHatColor();
    bakeTree(this.R.mover);
    this.sizer.add(this.R.mover);
    this.R.mover.add(this.overlay);
    this.overlay.position.set(0, this.R.height + 0.2, 0);
    this.R.mover.add(this.talk);
    this.talk.position.set(0, this.R.height + 0.08, 0);
    this.height = this.R.height;
    this.label?.offset?.setY?.(this.labelLift());   // the label's offset is live (labels.js reads it by reference)
    this.buildRoleItems();
    if (this.act) this.mountActProps(this.act, this.phase === 'do');
  }

  buildRoleItems() {
    for (const it of this.roleItems) it.obj.parent?.remove(it.obj);
    this.roleItems = [];
    const kit = ROLE_KIT[this.role] || [];
    for (const [name, home, stow] of kit) {
      const obj = this.makeProp(name);
      this.roleItems.push({ name, obj, home, stow, at: null });
    }
    this.placeRoleItems(ACTS[this.act]?.hands || '');
    this.bino = this.roleItems.find((it) => it.name === 'binoculars') || null;
  }

  // Custom agent types get a hat colour hashed from the type; Librarians' halos float above their book pile.
  applyHatColor() {
    const R = this.R;
    if (R.extra.halo) R.extra.haloY = this.role === 'librarian' ? 0.58 : 0.42;
    const type = String(this.data?.type || '').toLowerCase();
    if (this.isCommander || this.role !== 'engineer' || GENERIC_TYPES.has(type)) return;
    const c = new THREE.Color().setHSL(hashHue(type), 0.72, 0.55).getHex();
    if (R.hat.length) { for (const m of R.hat) m.material = mat(c); return; }
    const cap = G(at(hemi(0.13, c, SMALL), 0, -0.02, 0), at(sphere(0.035, tint(c, 0.4), SMALL), 0, 0.105, 0));
    if (this.faction === 'merc') { cap.children[0].scale.set(1.1, 0.5, 1.1); cap.children[1].position.y = 0.05; }
    R.slots.top.add(cap);
  }

  makeProp(name) {
    const f = PROPS[name];
    const g = f ? f(this) : new THREE.Group();
    g.name = name;
    return bakeTree(g);
  }

  prop(name) {
    let p = this.props.get(name);
    if (!p) { p = this.makeProp(name); this.props.set(name, p); }
    return p;
  }

  // Put role items in their homes, or stow them if the act keeps that hand busy.
  placeRoleItems(busy) {
    for (const it of this.roleItems) {
      const handBusy = (it.home === 'R' && busy.includes('R')) || (it.home === 'L' && busy.includes('L'));
      const want = handBusy ? it.stow : it.home;
      if (want === it.at) continue;
      it.at = want;
      if (!want) { it.obj.visible = false; continue; }
      const slot = this.R.slots[want];
      if (!slot) { it.obj.visible = false; continue; }
      slot.add(it.obj);
      it.obj.visible = true;
      it.obj.position.set(0, 0, 0);
      it.obj.rotation.set(0, 0, 0);
      it.obj.scale.setScalar(1);
      if (want === 'back') {
        it.obj.position.set(0, 0.02, -0.04); it.obj.rotation.set(0, 0, 0.75);
        if (it.name === 'shield') { it.obj.position.set(0, 0, -0.03); it.obj.rotation.set(0, Math.PI, 0); }
      } else if (want === 'belt') { it.obj.rotation.set(1.35, 0, 0); it.obj.scale.setScalar(0.8); }
      else if (want === 'L' && it.name === 'shield') { it.obj.position.set(0.05, 0.07, 0.07); it.obj.rotation.set(0, 0.45, 0); }
      else if (it.name === 'coil' && want === 'core') it.obj.rotation.z = 0.62;
      else if (it.name === 'axe' && want === 'R') it.obj.rotation.set(-0.25, 0, 0);
    }
  }

  applyScale() {
    const s = this.baseScale * this.popScale;
    this.scaleNow = s;
    this.sizer.scale.setScalar(Math.max(0.0001, s));
    this.blob.scale.setScalar(Math.max(0.0001, s * (1 - Math.min(0.5, this.R.mover.position.y * 0.8))));
  }

  // ---- data -> act ---------------------------------------------------------------------------------------------

  toolAct() {
    const tool = this.data?.tool;
    return tool?.cat && ACT_OK.has(tool.cat) ? tool.cat : tool ? 'other' : 'write';
  }

  desiredAct() {
    const d = this.data || {};
    if (this.isCommander) {
      switch (d.state) {
        case 'working': case 'thinking': case 'waiting': return 'cast';   // spellcasting at the command post
        case 'needs_input': return 'alert';
        case 'idle': return 'lunch';
        case 'asleep': return 'sleep';
        default: return 'idle';
      }
    }
    switch (d.state) {
      case 'working': return this.toolAct();
      case 'thinking': return 'think';
      case 'waiting': case 'stalled': return this.wantsLunch() ? 'lunch' : d.state === 'stalled' ? 'stall' : 'wait';
      default: return 'idle';
    }
  }

  wantsLunch() {
    if (this.isCommander || this.finishing) return false;
    const c = COMMANDERS.get(this.key);
    if (!c || c.disposed || c.act !== 'lunch' || c.phase !== 'do' || !c.lunchSet) return false;
    if (this.act === 'lunch' && this.lunchSeat >= 0) return true;
    return this.seed < 0.7 && c.lunchSet.taken.indexOf(null) >= 0;
  }

  updateIntent(dt) {
    const want = this.desiredAct();
    if (this.act == null) { this.setAct(want); return; }
    if (want !== this.pendingAct) { this.pendingAct = want; this.pendingT = 0; } else this.pendingT += dt;
    if (want === this.act) return;
    if (want === 'alert') { if (this.pendingT >= 0.15) this.setAct(want); return; }
    // Commit to the current errand. Sessions hop between tool categories every few seconds; re-targeting on every
    // hop sent units back and forth across the island (which read as spinning in circles). Acts done on the spot
    // switch after a short settle; a trip to a station (crystals, archive, shore, modules, lunch) is walked for up
    // to 3.5 s before it can be re-targeted, and once there a unit works at least a couple of seconds.
    const station = STATION_ACTS.has(want);
    if (this.pendingT < (station ? 0.9 : 0.5)) return;
    let ok = true;
    if (this.phase === 'do') ok = this.actT >= (this.act === 'lunch' || this.act === 'sleep' ? 1 : station ? 2.4 : 1.5);
    else if (this.phase === 'go') ok = this.sinceSet >= (station ? 3.5 : 0.6);
    if (ok) this.setAct(want);
  }

  setAct(act, instant = false) {
    this.clearAct();
    this.act = act;
    this.actT = 0; this.pu = 0; this.pendingAct = act; this.pendingT = 0; this.sinceSet = 0;
    this.pickSpot(act);
    if (act === 'lunch' && this.lunchSeat < 0 && !this.isCommander) { this.act = 'wait'; this.pickSpot('wait'); }
    const def = ACTS[this.act] || ACTS.idle;
    this.placeRoleItems(def.hands);
    const sp = this.spot, p = this.group.position;
    if (instant) {
      p.set(sp.x, sp.y, sp.z);
      if (!Number.isNaN(sp.yaw)) { this.yaw = sp.yaw; this.group.rotation.y = sp.yaw; }
      this.liftNow = sp.lift;
      if (this.act === 'alert' && this.hasRoof()) { const rf = this.building.roof; p.set(rf.x, rf.y, rf.z); this.onRoof = true; }
      this.arrive(true);
    } else {
      this.phase = Math.hypot(sp.x - p.x, sp.z - p.z) < 0.12 && Math.abs(sp.y - p.y) < 0.3 ? 'do' : 'go';
      if (this.phase === 'do') this.arrive(false); else this.mountActProps(this.act, false);
    }
    this.refreshLabel();
  }

  clearAct() {
    if (!this.act) return;
    const prev = this.act;
    this.unmountActProps();
    this.releaseSpot();
    if (prev === 'lunch' || prev === 'sleep') this.leaveLunch();
    if (prev === 'sleep') this.stopZzz();
    if (prev === 'agent') this.hideX('crate');
    if (prev === 'edit') this.hideX('scaffold');
    if (prev === 'other') this.hideX('gizmo');
    if (prev === 'cast') this.castEnd();
    if (prev === 'web') { this.hideX('bobber'); this.hideX('catch'); if (this.line) this.line.visible = false; this.fishing = null; }
    this.search = null;
    this.phase = 'idle';
  }

  materialize() {
    this.popScale = 1;
    this.setAct(this.desiredAct(), true);
  }

  arrive(instant) {
    this.phase = 'do';
    this.actT = 0; this.pu = 0;
    const sp = this.spot;
    this.mountActProps(this.act, true);
    switch (this.act) {
      case 'alert':
        if (!this.onRoof && this.hasRoof()) this.seq = this.seqClimbUp();
        break;
      case 'agent': if (sp.lift > 0) this.showX('crate', sp.x, sp.y, sp.z, sp.yaw, 1); break;
      case 'edit': {
        const s = this.shoulderWorld() / 0.42;
        this.showX('scaffold', sp.x + Math.sin(sp.yaw) * 0.46 * s, sp.y, sp.z + Math.cos(sp.yaw) * 0.46 * s, sp.yaw, s);
        break;
      }
      case 'other': this.showX('gizmo', sp.x + Math.sin(sp.yaw) * 0.42, sp.y, sp.z + Math.cos(sp.yaw) * 0.42, sp.yaw, 1); break;
      case 'web': this.fishing = { ph: instant ? 'wait' : 'cast', t: 0, next: 3 + this.r() * 6, flying: false, ft: 0, kind: 0, sx: 0, sy: 0, sz: 0 }; break;
      case 'search': this.newSearchArea(true); break;
      case 'cast': this.castBegin(); break;
      case 'lunch': case 'sleep': if (this.isCommander) this.lunchSet && (this.lunchSet.on = true); break;
      default: break;
    }
    if (this.act === 'web' && instant) this.placeBobber(true);
  }

  // ---- spots ---------------------------------------------------------------------------------------------------

  pickSpot(act) {
    const s = this.spot, p = this.group.position;
    this.releaseSpot();
    s.yaw = NaN; s.lift = 0; s.sit = -1; s.key = null;
    s.x = p.x; s.y = this.onRoof ? this.groundY : p.y; s.z = p.z;
    switch (act) {
      case 'bash': this.crystalSpot(); break;
      case 'read': this.archiveSpot(); break;
      case 'web': this.shoreSpot(); break;
      case 'edit': this.homeSpot('edit', true); break;
      case 'agent': this.homeSpot('agent', false); if (this.isCommander) s.lift = 0.3; break;
      case 'mcp': this.homeSpot('mcp', false); break;
      case 'search': this.searchStart(); break;
      case 'lunch': case 'sleep': this.lunchSpot(); break;
      case 'alert': this.alertSpot(); break;
      case 'cast': this.postSpot(); break;
      default: this.hereSpot(act); break;
    }
    if (!Number.isFinite(s.y)) s.y = this.groundY;
    if (act !== 'lunch' && act !== 'sleep' && act !== 'alert' && act !== 'cast') this.declutterSpot();
  }

  // Nudge the spot sideways (alternating, growing) while another unit already claims a spot within ~0.5 m.
  declutterSpot() {
    const s = this.spot, x0 = s.x, z0 = s.z;
    const yaw = Number.isNaN(s.yaw) ? this.seed * TAU : s.yaw;
    const px = Math.cos(yaw), pz = -Math.sin(yaw);
    for (let tries = 0; tries < 7; tries++) {
      if (tries) {
        const k = (tries % 2 ? 1 : -1) * (0.3 + 0.3 * Math.ceil(tries / 2));
        const x = x0 + px * k, z = z0 + pz * k;
        if (!this.canStand(x, z) && this.canStand(x0, z0)) continue;
        s.x = x; s.z = z;
      }
      let clash = false;
      for (let i = 0; i < LIVE.length && !clash; i++) {
        const o = LIVE[i];
        if (o === this || o.disposed || o.finishing || o.island !== this.island || (o.phase !== 'go' && o.phase !== 'do')) continue;
        if (Math.abs(o.spot.x - s.x) < 0.5 && Math.abs(o.spot.z - s.z) < 0.5 && Math.hypot(o.spot.x - s.x, o.spot.z - s.z) < 0.48) clash = true;
      }
      if (!clash) return;
    }
    s.x = x0; s.z = z0;
  }

  releaseSpot() {
    if (this.spot.key) releaseSlot(this.spot.key, this.id);
    this.spot.key = null;
  }

  stationList(name) {
    const v = this.island?.stations?.[name];
    if (Array.isArray(v)) return v.filter(isVec);
    return isVec(v) ? [v] : [];
  }

  // The best station point nobody else is using (score: distance from the unit, weighted toward home).
  freePoint(list, prefix) {
    const p = this.group.position, h = this.homeCenter(_v3);
    const wh = this.isCommander ? 0.8 : this.apprentice ? 0 : 0.35;
    const ref = this.apprentice ? this.findParent()?.group.position || p : p;
    let best = null, bd = Infinity, free = null, fd = Infinity;
    for (const c of list) {
      const dd = Math.hypot(c.x - ref.x, c.z - ref.z) * (1 - wh) + Math.hypot(c.x - h.x, c.z - h.z) * wh;
      if (dd < bd) { bd = dd; best = c; }
      const arr = SLOTS.get(`${prefix}:${vkey(c)}`);
      if ((!arr || arr.every((id) => id == null || id === this.id)) && dd < fd) { fd = dd; free = c; }
    }
    return free && fd < bd + 6 ? free : best;   // a free spot is worth a short detour
  }

  // Mining: islands.js lists standing points (stations.crystals) beside each cluster (stations.crystalClusters).
  crystalSpot() {
    const st = this.island?.stations;
    const stands = this.stationList('crystals');
    if (!stands.length) { this.homeSpot('bash', true); return; }
    const c = this.freePoint(stands, 'cs');
    const clusters = Array.isArray(st?.crystalClusters) ? st.crystalClusters.filter(isVec) : [];
    if (!clusters.length) { this.ringSpot(`cs:${vkey(c)}`, c, 0.66, 0.72, true); return; }
    let cc = clusters[0], cd = Infinity;
    for (const k of clusters) { const d = Math.hypot(k.x - c.x, k.z - c.z); if (d < cd) { cd = d; cc = k; } }
    this.ringSpot(`cs:${vkey(c)}`, cc, cd, cd + 0.1, true, Math.atan2(c.x - cc.x, c.z - cc.z));
  }

  // Reading: stations.archive is a standing point in front of the archive (stations.archiveCenter).
  archiveSpot() {
    const st = this.island?.stations, a = st?.archive, ac = st?.archiveCenter;
    if (!isVec(a)) { this.homeSpot('read', false); return; }
    if (isVec(ac)) {
      const r = Math.max(0.4, Math.hypot(a.x - ac.x, a.z - ac.z));
      this.ringSpot(`ar:${vkey(ac)}`, ac, r, r + 0.15, true, Math.atan2(a.x - ac.x, a.z - ac.z));
    } else this.ringSpot(`ar:${vkey(a)}`, a, 1.45, 1.45, true);
  }

  // Stand on a ring around a station, spreading additional units around it. Face the station.
  ringSpot(key, c, r0, r, faceIn, baseAngle) {
    const s = this.spot;
    const i = claimSlot(key, this.id);
    s.key = key;
    const ic = this.islandCenter(_v2);
    let base = Number.isFinite(baseAngle) ? baseAngle : Math.atan2(ic.x - c.x, ic.z - c.z);
    if (!Number.isFinite(base) || (!Number.isFinite(baseAngle) && Math.abs(ic.x - c.x) < 0.01 && Math.abs(ic.z - c.z) < 0.01)) base = Math.atan2(this.group.position.x - c.x, this.group.position.z - c.z);
    const rr = i === 0 ? r0 : r;
    const a = base + slotOffset(i) * (0.95 / Math.max(0.5, rr));
    s.x = c.x + Math.sin(a) * rr; s.z = c.z + Math.cos(a) * rr;
    s.y = this.groundOf(c);
    s.yaw = faceIn ? Math.atan2(c.x - s.x, c.z - s.z) : a;
    if (rr === 0) s.yaw = Math.atan2(c.x - ic.x, c.z - ic.z);
  }

  // A spot beside the unit's own building for a tool category (building.workSpot or a fallback ring).
  homeSpot(cat, faceBuilding) {
    const s = this.spot;
    let w = null;
    try { w = this.building?.workSpot?.(cat); } catch { w = null; }
    const base = isVec(w) ? _v1.copy(w) : this.fallbackSpot(cat, _v1);
    if (!Number.isFinite(base.y)) base.y = this.groundY;
    const key = `ws:${this.key}:${cat}`;
    const i = claimSlot(key, this.id);
    s.key = key;
    const h = this.homeCenter(_v2);
    const out = Math.atan2(base.x - h.x, base.z - h.z);
    const k = slotOffset(i);
    // extra units spread sideways (perpendicular to the building direction)
    s.x = base.x + Math.cos(out) * k * 0.62;
    s.z = base.z - Math.sin(out) * k * 0.62;
    s.y = base.y;
    s.yaw = faceBuilding ? Math.atan2(h.x - s.x, h.z - s.z) : out;
    if (this.apprentice && this.findParent()) { this.releaseSpot(); this.nearParent(s); }
  }

  // In-place acts: stay put unless blocking the door / on a roof; apprentices stay near the parent.
  hereSpot(act) {
    const s = this.spot, p = this.group.position;
    if (this.apprentice && this.findParent()) { this.nearParent(s); return; }
    const door = this.doorPos(_v1);
    const nearDoor = Math.hypot(p.x - door.x, p.z - door.z) < 1.5;
    if (this.onRoof || nearDoor || !this.canStand(p.x, p.z)) {
      const out = this.doorOutXZ();
      const key = `lo:${this.key}`;
      const i = claimSlot(key, this.id);
      s.key = key;
      const k = slotOffset(i);
      // in front of the door, swinging around it until clear of trees, crystals and other buildings
      const base = Math.atan2(out[0], out[1]);
      for (let tries = 0; tries < 9; tries++) {
        const a = base + (tries ? (tries % 2 ? 1 : -1) * Math.ceil(tries / 2) * 0.42 : 0);
        const fx = Math.sin(a), fz = Math.cos(a);
        s.x = door.x + fx * 1.45 + fz * k * 0.62;
        s.z = door.z + fz * 1.45 - fx * k * 0.62;
        if (this.canStand(s.x, s.z) && !this.insideObstacle(s.x, s.z, 0.35)) break;
      }
      s.y = this.groundY;
      s.yaw = Math.atan2(out[0], out[1]) + (this.r() - 0.5) * 0.8;
    } else {
      s.x = p.x; s.z = p.z; s.y = this.onRoof ? this.groundY : p.y;
      s.yaw = NaN;
    }
  }

  nearParent(s) {
    const par = this.findParent();
    if (!par) return;
    const pp = par.group.position, p = this.group.position;
    let a = Math.atan2(p.x - pp.x, p.z - pp.z);
    if (!Number.isFinite(a) || Math.hypot(p.x - pp.x, p.z - pp.z) < 0.1) a = this.seed * TAU;
    s.x = pp.x + Math.sin(a) * 0.75; s.z = pp.z + Math.cos(a) * 0.75; s.y = par.onRoof ? par.groundY : pp.y;
    s.yaw = NaN;
    this.followOf = par;
  }

  shoreSpot() {
    const s = this.spot;
    const list = this.stationList('shore');
    const ic = this.islandCenter(_v2);
    let c = list.length ? this.freePoint(list, 'sh') : null;
    if (!c) {
      const p = this.group.position;
      let dx = p.x - ic.x, dz = p.z - ic.z;
      const dl = Math.hypot(dx, dz) || 1; dx /= dl; dz /= dl;
      const r = Math.max(2, this.islandRadius() - 0.9);
      c = _v4.set(ic.x + dx * r, this.groundY, ic.z + dz * r);
    }
    let ox = c.x - ic.x, oz = c.z - ic.z;
    const ol = Math.hypot(ox, oz) || 1; ox /= ol; oz /= ol;
    const key = `sh:${vkey(c)}`;
    const i = claimSlot(key, this.id);
    s.key = key;
    const k = slotOffset(i);
    // islands.js builds a little fishing deck jutting out over the cliff: the first angler stands on it
    const deck = typeof this.island?.prof?.shore === 'function' ? 0.45 : -0.05;
    if (i === 0) { s.x = c.x + ox * deck; s.z = c.z + oz * deck; }
    else { s.x = c.x + oz * k * 0.62 - ox * 0.15; s.z = c.z - ox * k * 0.62 - oz * 0.15; }
    s.y = this.groundOf(c);
    s.yaw = Math.atan2(ox, oz);
  }

  searchStart() {
    const s = this.spot, p = this.group.position;
    const par = this.apprentice ? this.findParent() : null;
    const h = par ? par.group.position : this.homeCenter(_v2);
    // start right here when that is open ground within reach of home (no trek across the island first)
    if (Math.hypot(p.x - h.x, p.z - h.z) < 6.5 && this.canStand(p.x, p.z) && !this.insideObstacle(p.x, p.z, 0.2)) {
      s.x = p.x; s.z = p.z; s.y = this.onRoof ? this.groundY : p.y;
      return;
    }
    const a0 = Math.atan2(p.x - h.x, p.z - h.z);
    for (let tries = 0; tries < 10; tries++) {
      const a = a0 + (this.r() - 0.5) * 1.4, d = 2.4 + this.r() * 1.6;
      const x = h.x + Math.sin(a) * d, z = h.z + Math.cos(a) * d;
      if (this.canStand(x, z) && !this.insideObstacle(x, z, 0.3)) { s.x = x; s.z = z; s.y = this.groundY; return; }
    }
    s.x = p.x; s.z = p.z; s.y = p.y;
  }

  newSearchArea(first) {
    const p = this.group.position;
    const S = this.search || (this.search = { pts: [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()], i: 0, n: 0, dir: this.yaw, ping: 0, beep: 4 + this.r() * 5, stop: 0 });
    const h = this.homeCenter(_v2);
    if (first) S.dir = this.yaw;   // sweep the way we already face: no about-turn to start
    else {
      // drift across the island but stay within ~6 m of home, bending back gradually instead of turning around
      S.dir += (this.r() - 0.5) * 0.9;
      if (Math.hypot(p.x - h.x, p.z - h.z) > 5) S.dir += clamp(wrapAngle(Math.atan2(h.x - p.x, h.z - p.z) - S.dir), -0.9, 0.9);
    }
    // the first heading (straight on, then bending both ways) whose sweep stays on open ground
    for (let k = 0; k < 9; k++) {
      const a = S.dir + (k ? (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 0.45 : 0);
      if (this.sweepOk(p, a)) { S.dir = a; break; }
    }
    const dx = Math.sin(S.dir), dz = Math.cos(S.dir);
    let n = 0;
    for (let i = 0; i < S.pts.length; i++) {
      // a straight sweep (the torso swings the detector side to side; weaving the whole body read as spinning)
      const along = 0.5 + i * 0.5, x = p.x + dx * along, z = p.z + dz * along;
      if (!this.canStand(x, z) || this.insideObstacle(x, z, 0.2)) break;   // the sweep ends at the first bad point
      S.pts[n++].set(x, this.groundY, z);
    }
    S.i = 0; S.n = n;
    // boxed in: pause and listen for a moment (then try again) rather than re-bending every frame
    if (!n) { S.stop = Math.max(S.stop, 1.4); S.dir += 1.3; }
  }

  sweepOk(p, a) {
    const dx = Math.sin(a), dz = Math.cos(a);
    for (let d = 0.8; d < 2.5; d += 0.8) if (!this.canStand(p.x + dx * d, p.z + dz * d) || this.insideObstacle(p.x + dx * d, p.z + dz * d, 0.2)) return false;
    return true;
  }

  alertSpot() {
    const s = this.spot;
    const door = this.doorPos(_v1);
    const [ox, oz] = this.doorOutXZ();
    // beside the door (so the door stays clear); the climb starts here
    s.x = door.x + oz * 0.7 + ox * 0.12;
    s.z = door.z - ox * 0.7 + oz * 0.12;
    s.y = this.groundY;
    const h = this.homeCenter(_v2);
    s.yaw = this.hasRoof() ? Math.atan2(h.x - s.x, h.z - s.z) : Math.atan2(ox, oz);
  }

  lunchSpot() {
    const s = this.spot;
    let host = this.isCommander ? this : COMMANDERS.get(this.key);
    if (!host || host.disposed) host = null;
    if (host && !host.lunchSet) host.buildLunchSet();
    const set = host?.lunchSet;
    if (!set) { this.hereSpot('lunch'); return; }
    let i = set.taken.indexOf(this.id);
    if (i < 0) {
      i = this.isCommander ? set.prefer : set.taken.indexOf(null);
      if (this.isCommander && set.taken[i] != null && set.taken[i] !== this.id) {
        // an agent took the commander's seat: bump it
        const other = LIVE.find((u) => u.id === set.taken[i]);
        set.taken[i] = null;
        if (other) { other.lunchSeat = -1; other.pendingAct = null; }
      }
      if (i >= 0) set.taken[i] = this.id;
    }
    if (i < 0) { this.lunchSeat = -1; this.hereSpot('lunch'); return; }
    this.lunchSeat = i; this.lunchHost = host;
    const seat = set.seats[i];
    s.x = seat.x; s.y = seat.y; s.z = seat.z; s.yaw = seat.yaw; s.sit = seat.h;
  }

  leaveLunch() {
    const host = this.lunchHost;
    if (host?.lunchSet && this.lunchSeat >= 0 && host.lunchSet.taken[this.lunchSeat] === this.id) host.lunchSet.taken[this.lunchSeat] = null;
    this.lunchSeat = -1; this.lunchHost = null;
    if (this.isCommander && this.lunchSet) {
      this.lunchSet.on = false;
      // evict guests
      for (let i = 0; i < this.lunchSet.taken.length; i++) this.lunchSet.taken[i] = null;
    }
  }

  // Build the commander's faction lunch set piece next to the building's picnic table.
  buildLunchSet() {
    const L = this.building?.lunch;
    const home = this.homeCenter(new THREE.Vector3());
    const table = isVec(L?.table) ? new THREE.Vector3(L.table.x, Number.isFinite(L.table.y) ? L.table.y : this.groundY, L.table.z) : this.fallbackSpot('lunch', new THREE.Vector3());
    const gy = table.y;
    let fx = table.x - home.x, fz = table.z - home.z;
    const fl = Math.hypot(fx, fz) || 1; fx /= fl; fz /= fl;
    const set = { group: new THREE.Group(), seats: [], taken: [], prefer: 0, on: false, fire: null, kind: this.faction };
    // where the set piece goes (sonnet beam / haiku blanket / fable campfire): first clear spot around the table
    const px = -fz, pz = fx;
    const spotFor = (dist, pad) => {
      const cands = [[fx, fz, dist], [px, pz, dist], [-px, -pz, dist], [fx + px, fz + pz, dist * 1.1], [fx - px, fz - pz, dist * 1.1], [-fx, -fz, dist]];
      for (const [dx, dz, d] of cands) {
        const l = Math.hypot(dx, dz) || 1, x = table.x + (dx / l) * d, z = table.z + (dz / l) * d;
        if (this.canStand(x, z) && !this.insideObstacle(x, z, pad)) return [x, z];
      }
      return [table.x + fx * dist, table.z + fz * dist];
    };
    const pal = this.pal, camYaw = FRAME.camYaw;
    const add = (x, y, z, yaw, h) => { set.seats.push({ x, y, z, yaw, h }); set.taken.push(null); };
    const center = (x, z) => set.group.position.set(x, gy, z);
    const tableSeats = (count, cart) => {
      const seats = Array.isArray(L?.seats) ? L.seats.filter(isVec) : [];
      if (seats.length) {
        for (const st of seats) {
          const h = Number.isFinite(st.y) && st.y - gy > 0.05 ? st.y - gy : 0.25;
          add(st.x, gy, st.z, Math.atan2(table.x - st.x, table.z - st.z), h);
        }
      } else {
        for (let i = 0; i < count; i++) {
          const a = Math.atan2(fx, fz) + HALF_PI + (i % 2 ? Math.PI : 0) + (i >> 1) * 0.5 - 0.25;
          const x = table.x + Math.sin(a) * 0.72, z = table.z + Math.cos(a) * 0.72;
          add(x, gy, z, Math.atan2(table.x - x, table.z - z), 0);
        }
      }
      // commander takes the seat whose facing is closest to the camera
      let best = 0, bd = Infinity;
      set.seats.forEach((st, i) => { const dd = Math.abs(wrapAngle(st.yaw - camYaw)); if (dd < bd) { bd = dd; best = i; } });
      set.prefer = best;
      if (cart) {
        const px = -fz, pz = fx;
        const c = set.seats[best];
        const obj = cart();
        obj.position.set(c.x - table.x + px * 0.55 + fx * 0.15, 0, c.z - table.z + pz * 0.55 + fz * 0.15);
        obj.rotation.y = Math.atan2(fx, fz);
        set.group.add(obj);
      }
    };
    switch (this.faction) {
      case 'sonnet': {
        const [cx, cz] = spotFor(1.45, 0.9);
        center(cx, cz);
        const beam = makeBeam(1.8);
        beam.rotation.y = camYaw;
        set.group.add(beam);
        const rx = Math.cos(camYaw), rz = -Math.sin(camYaw);
        for (const o of [-0.52, -0.18, 0.18, 0.52]) add(cx + rx * o, gy, cz + rz * o, camYaw, 0.36);
        set.prefer = 1;
        const pail = makePail();
        pail.position.set(rx * 0.78, 0.36, rz * 0.78); pail.rotation.y = camYaw;
        set.group.add(pail);
        break;
      }
      case 'haiku': {
        const [cx, cz] = spotFor(1.4, 0.75);
        center(cx, cz);
        const pic = makePicnic(); pic.rotation.y = camYaw; set.group.add(pic);
        for (let i = 0; i < 6; i++) {
          const a = camYaw + (i / 6) * TAU;
          const x = cx + Math.sin(a) * 0.62, z = cz + Math.cos(a) * 0.62;
          add(x, gy, z, Math.atan2(cx - x, cz - z), 0.013);
        }
        set.prefer = 3; // the seat on the far side faces the camera
        break;
      }
      case 'fable': {
        const [cx, cz] = spotFor(1.55, 0.95);
        center(cx, cz);
        const fire = makeCampfire(); set.group.add(fire); set.fire = fire;
        for (let i = 0; i < 3; i++) {
          const a = camYaw + Math.PI + (i - 1) * 2.0;
          const lx = Math.sin(a) * 0.72, lz = Math.cos(a) * 0.72;
          const log = makeLog(); log.position.set(lx, 0, lz); log.rotation.y = a; set.group.add(log);
          for (const off of [-0.16, 0.16]) {
            const x = cx + lx + Math.cos(a) * off, z = cz + lz - Math.sin(a) * off;
            add(x, gy, z, Math.atan2(cx - x, cz - z), 0.17);
          }
        }
        set.prefer = 0;
        break;
      }
      case 'opus':
        center(table.x, table.z);
        if (isVec(L?.top)) {
          tableSeats(4, null);
          const ts = makeTeaSet(pal);
          ts.position.set(L.top.x - table.x, (Number.isFinite(L.top.y) ? L.top.y : gy + 0.47) - gy, L.top.z - table.z);
          ts.rotation.y = Math.atan2(fx, fz);
          set.group.add(ts);
        } else tableSeats(4, () => makeTeaCart(pal));
        break;
      default:
        center(table.x, table.z);
        tableSeats(4, () => makeDrum());
        break;
    }
    bakeTree(set.group);
    set.group.scale.setScalar(0.0001);
    set.group.visible = false;
    set.group.userData.s = 0; set.group.userData.v = 0;
    this.lunchSet = set;
    this.group.parent?.add(set.group);
  }

  // ---- behaviour ---------------------------------------------------------------------------------------------

  behave(dt) {
    this.sinceSet = (this.sinceSet || 0) + dt;
    this.updateIntent(dt);
    if (this.seq) { this.runSeq(); return; }
    if (this.onRoof && this.act !== 'alert') { this.seq = this.seqClimbDown(); this.runSeq(); return; }
    // apprentices loosely follow their parent for location-free acts
    if (this.followOf && (this.act === 'think' || this.act === 'wait' || this.act === 'stall' || this.act === 'write' || this.act === 'plan' || this.act === 'skill' || this.act === 'idle' || this.act === 'mcp' || this.act === 'agent')) {
      const par = this.findParent();
      if (!par) this.followOf = null;
      else {
        const pp = par.group.position, s = this.spot;
        if (Math.hypot(pp.x - s.x, pp.z - s.z) > 1.35) { this.nearParent(s); this.phase = 'go'; }
      }
    }
    if (this.phase === 'go') {
      const s = this.spot;
      const arrived = this.walkTo(s.x, s.y, s.z, this.speed(), dt, 0.07);
      this.carryPose();
      if (!arrived) return;
      this.arrive(false);
      if (this.seq) return;
    }
    if (this.phase === 'do') {
      this.actT += dt;
      if (!Number.isNaN(this.spot.yaw) && this.act !== 'search' && this.act !== 'cast') this.turnTo(this.spot.yaw, dt, 7);
      this.perform(dt);
    }
  }

  speed() {
    const g = GAIT[this.faction] || GAIT.merc;
    return g.speed * (this.isCommander ? 1.05 : 1) * (this.apprentice ? 1.15 : 1);
  }

  // Walk toward (tx, tz) with circle-obstacle steering, separation and island bounds. Returns true on arrival.
  walkTo(tx, ty, tz, speed, dt, arriveR = 0.08) {
    const p = this.group.position, N = this.nav;
    if (N.tx !== tx || N.tz !== tz) {
      const nd = Math.hypot(tx - p.x, tz - p.z);
      if (!(Math.abs(N.tx - tx) < 0.3 && Math.abs(N.tz - tz) < 0.3)) { N.y0 = p.y; N.d0 = Math.max(nd, 0.001); N.best = Infinity; N.stuck = 0; N.tsign = 0; }
      N.tx = tx; N.tz = tz;
    }
    let dx = tx - p.x, dz = tz - p.z;
    const d = Math.hypot(dx, dz);
    if (d <= arriveR) { p.y = ty; this.speedNow = 0; return true; }
    dx /= d; dz /= d;
    // steer around the nearest building / island obstacle circle that blocks the straight line
    const S = STEER;
    S.sx = dx; S.sz = dz; S.best = Infinity; S.px = 0; S.pz = 0;
    steerAround(FRAME.obs, FRAME.nObs, p, dx, dz, d, tx, tz, S);
    const io = this.island?.obstacles;
    if (Array.isArray(io)) steerAround(io, io.length, p, dx, dz, d, tx, tz, S);
    let sx = S.sx + S.px, sz = S.sz + S.pz;
    // separation from other units on the same island (fades out near the target so neighbours can settle
    // instead of shoving each other round and round the spot)
    const sepK = clamp((d - 0.1) / 0.6, 0, 1) * 0.9;
    for (let i = 0; i < LIVE.length; i++) {
      const o = LIVE[i];
      if (o === this || o.island !== this.island || o.onRoof) continue;
      const q = o.group.position, ox = p.x - q.x, oz = p.z - q.z, dd = ox * ox + oz * oz;
      if (dd < 0.12 && dd > 1e-6) { const dl = Math.sqrt(dd), k = (0.35 - dl) / 0.35; sx += (ox / dl) * k * sepK; sz += (oz / dl) * k * sepK; }
    }
    let sl = Math.hypot(sx, sz) || 1; sx /= sl; sz /= sl;
    const step = Math.min(d, speed * dt);
    let nx = p.x + sx * step, nz = p.z + sz * step;
    // stay on the island while in the open field (targets near buildings may sit on "unwalkable" lots)
    if (d > 2.2 && !this.canStand(nx, nz) && this.canStand(p.x, p.z)) {
      // try detours on the side that worked last time first (no left/right flip-flopping along a coast)
      let ok = false;
      const sg = N.tsign || 1;
      for (let k = 0; k < TRY_TURNS.length && !ok; k++) {
        const ang = TRY_TURNS[k] * sg, c = Math.cos(ang), s = Math.sin(ang);
        const rx = sx * c - sz * s, rz = sx * s + sz * c;
        if (this.canStand(p.x + rx * step, p.z + rz * step)) { sx = rx; sz = rz; nx = p.x + rx * step; nz = p.z + rz * step; ok = true; N.tsign = ang > 0 ? 1 : -1; }
      }
      if (!ok) { nx = p.x; nz = p.z; }
    }
    const moved = Math.hypot(nx - p.x, nz - p.z);
    p.x = nx; p.z = nz;
    p.y = ty + (N.y0 - ty) * clamp((d - step) / N.d0, 0, 1);
    // head along the steering direction, but at the goal itself face the goal (pushes there must not whip the heading)
    if (moved > 1e-4 && d > 0.1) this.turnTo(d < 0.45 ? Math.atan2(dx, dz) : Math.atan2(sx, sz), dt, 11, 6.5);
    this.speedNow = moved / Math.max(dt, 1e-4);
    this.moving = moved > 1e-4;
    const g = GAIT[this.faction] || GAIT.merc;
    this.walkPhase += (moved / (g.stride * this.scaleNow)) * Math.PI;
    if (this.moving) this.gait();
    // stuck detection: give up and treat as arrived
    if (d < N.best - 0.04) { N.best = d; N.stuck = 0; } else if ((N.stuck += dt) > (d < 0.8 ? 1.2 : 2.5)) { N.stuck = 0; N.best = Infinity; p.y = ty; return true; }
    return false;
  }

  canStand(x, z) {
    const isl = this.island;
    if (typeof isl?.walkable === 'function') {
      try { return !!isl.walkable(_v4.set(x, this.groundY, z)); } catch { return true; }
    }
    return this.insideIsland(x, z);
  }

  insideIsland(x, z) {
    const r = this.islandRadius();
    if (!(r > 0)) return true;
    const c = this.islandCenter(_v5);
    return Math.hypot(x - c.x, z - c.z) < r * 0.9;
  }

  insideObstacle(x, z, pad) {
    for (let i = 0; i < FRAME.nObs; i++) { const o = FRAME.obs[i]; if (Math.hypot(x - o.x, z - o.z) < o.r + pad) return true; }
    const io = this.island?.obstacles;
    if (Array.isArray(io)) for (const o of io) if (Number.isFinite(o?.r) && Math.hypot(x - o.x, z - o.z) < o.r + pad) return true;
    return false;
  }

  // Shortest-arc turn, eased, with a maximum turn rate (rad/s) so no heading change ever reads as a spin.
  turnTo(target, dt, rate = 10, maxRate = 7) {
    const d = wrapAngle(target - this.yaw);
    let step = d * (1 - Math.exp(-rate * dt));
    const lim = maxRate * dt;
    if (step > lim) step = lim; else if (step < -lim) step = -lim;
    this.yaw = wrapAngle(this.yaw + step);
    this.group.rotation.y = this.yaw;
  }

  // Walk-cycle pose per faction gait.
  gait() {
    const P = this.P, ph = this.walkPhase, s = Math.sin(ph), c = Math.cos(ph);
    switch (this.faction) {
      case 'opus':
        P.gL = s * 0.5; P.gR = -s * 0.5; P.mrz = s * 0.12; P.my = Math.abs(c) * 0.022;
        P.aLx = -s * 0.25; P.aRx = s * 0.25; P.aLz = 0.2; P.aRz = 0.2;
        break;
      case 'haiku': {
        const hp = (ph / Math.PI) % 1;
        P.my = Math.sin(hp * Math.PI) * 0.17;
        P.sq = 1 + 0.12 * Math.sin(hp * Math.PI) - 0.2 * Math.max(0, 1 - hp / 0.14);
        P.mrx = 0.14; P.gL = P.gR = hp < 0.5 ? -0.5 : 0.35;
        P.aLz = P.aRz = 0.5 + Math.sin(hp * Math.PI) * 0.7;
        break;
      }
      case 'fable':
        P.mrx = 0.2; P.aLx = 0.35 + s * 0.08; P.aRx = 0.35 - s * 0.08; P.aLz = P.aRz = 0.25;
        break;
      case 'merc': {
        const q = Math.tanh(s * 3);
        P.gL = q * 0.42; P.gR = -q * 0.42; P.aLx = -q * 0.3; P.aRx = q * 0.3;
        P.my = Math.abs(Math.tanh(c * 3)) * 0.018; P.hy = Math.sin(ph * 0.5) * 0.12;
        break;
      }
      default:
        P.gL = s * 0.7; P.gR = -s * 0.7; P.aLx = -s * 0.6; P.aRx = s * 0.6;
        P.my = Math.abs(c) * 0.035; P.bx = 0.06;
        break;
    }
  }

  // While walking toward an act, carry its tool.
  carryPose() {
    if (!this.moving) return;
    const def = ACTS[this.act];
    if (def?.carry != null) { this.P.aRx = def.carry; this.P.aRz = 0.08; }
  }

  perform(dt) {
    const P = this.P, t = this.actT;
    switch (this.act) {
      case 'bash': return this.actMine(P, t);
      case 'edit': return this.actHammer(P, t);
      case 'read': return this.actRead(P, t);
      case 'search': return this.actSearch(P, dt);
      case 'web': return this.actFish(P, dt);
      case 'agent': return this.actShout(P, t);
      case 'mcp': return this.actPhone(P, t, dt);
      case 'plan': case 'write': return this.actWrite(P, t);
      case 'skill': return this.actManual(P, t);
      case 'other': return this.actTinker(P, t);
      case 'cast': return this.actCast(P, t, dt);
      case 'think': return this.actThink(P, t, dt);
      case 'wait': return this.actWait(P, t);
      case 'stall': return this.actStall(P, t);
      case 'lunch': return this.actLunch(P, t, dt);
      case 'sleep': return this.actSleep(P, t);
      case 'alert': return this.actAlert(P, t);
      default: return this.actIdle(P, t);
    }
  }

  // ---- acts --------------------------------------------------------------------------------------------------

  actMine(P, t) {
    const per = 1.15, u = (t % per) / per;
    let a, bx;
    if (u < 0.55) { const k = ease.inOut(u / 0.55); a = lerp(-0.45, -2.8, k); bx = lerp(0.06, -0.2, k); }
    else if (u < 0.68) { const k = (u - 0.55) / 0.13; a = lerp(-2.8, -0.42, k * k); bx = lerp(-0.2, 0.36, k); }
    else { const k = (u - 0.68) / 0.32; a = -0.42 + Math.sin(k * Math.PI) * 0.12 - k * 0.03; bx = lerp(0.36, 0.06, ease.inOut(k)); }
    P.aRx = a; P.aLx = a + 0.12; P.aLz = -0.1; P.aRz = -0.02; P.bx = bx; P.hx = 0.12; P.gL = -0.28; P.gR = 0.22;
    if (crossed(this.pu, u, 0.68)) { P.sq = 0.95; this.impact('pickaxe', PAL.crystal); }
    this.pu = u;
    this.snap = u > 0.5 && u < 0.72;
  }

  actHammer(P, t) {
    const per = 0.62, u = (t % per) / per;
    let a;
    if (u < 0.58) a = lerp(-0.9, -2.45, ease.outCubic(u / 0.58));
    else if (u < 0.72) { const k = (u - 0.58) / 0.14; a = lerp(-2.45, -0.95, k * k); }
    else a = -0.95 - Math.sin(((u - 0.72) / 0.28) * Math.PI) * 0.12;
    P.aRx = a; P.aRz = 0.04; P.aLx = -1.0; P.aLz = -0.18; P.bx = 0.14; P.hx = 0.3; P.gL = -0.18; P.gR = 0.12;
    if (crossed(this.pu, u, 0.72)) { this.hits = (this.hits || 0) + 1; if (this.hits % 2 === 0) this.impact('hammer', 0xffd66b); }
    this.pu = u;
    this.snap = u > 0.55 && u < 0.76;
  }

  actRead(P, t) {
    const cyc = t % 7.5;
    const w = cyc < 0.9 ? 0.03 + 0.27 * ease.outBack(cyc / 0.9) : cyc > 6.8 ? 0.03 + 0.27 * (1 - ease.inCubic((cyc - 6.8) / 0.7)) : 0.3;
    this.props.get('scroll')?.userData.setW?.(Math.max(0.03, w));
    P.aLx = P.aRx = -1.25; P.aLz = P.aRz = -0.18;
    const line = (t % 1.8) / 1.8, open = clamp((w - 0.03) / 0.27, 0, 1);
    P.hy = lerp(0.25, -0.25, line) * open; P.hx = 0.12 + (line > 0.9 ? 0.1 : 0) + Math.sin(t * 0.7) * 0.03;
    P.bx = 0.04;
  }

  actSearch(P, dt) {
    const S = this.search;
    if (!S) { this.newSearchArea(true); return; }
    if (S.stop > 0) {
      S.stop -= dt;
      const k = 1 - S.stop / 1.4;
      P.my = Math.sin(clamp(k * 2, 0, 1) * Math.PI) * 0.14;
      P.aLz = 1.1; P.aLx = -0.4; P.aRx = -0.6; P.hx = -0.1;
    } else if (S.i >= S.n) this.newSearchArea(false);
    else {
      const pt = S.pts[S.i];
      const arrived = this.walkTo(pt.x, pt.y, pt.z, this.speed() * 0.4, dt, 0.08);
      if (arrived && ++S.i >= S.n) this.newSearchArea(false);
      P.aRx = -0.72; P.aRz = -0.04; P.aLx = -0.3; P.aLz = 0.2;
      P.by = Math.sin(this.actT * 3.1) * 0.42; P.hx = 0.32; P.hy = -P.by * 0.4;
      if (this.actT > S.ping) { S.ping = this.actT + 1.25; this.ping(); }
      if (this.actT > S.beep) {
        S.beep = this.actT + 6 + this.r() * 7; S.stop = 1.4; this.bangT = 1.3;
        if (this.r() < 0.45) this.fx('text', this.headWorld(new THREE.Vector3(), 0.55), `Found: ${LINES.found[Math.floor(this.r() * LINES.found.length)]}`, { color: '#ffe38a', size: 0.7, rise: 0.9, secs: 1.8 });
      }
    }
  }

  ping() {
    if (this.lowFx()) return;
    const tip = this.props.get('detector')?.userData.tip;
    if (!tip) return;
    const v = tip.getWorldPosition(new THREE.Vector3());
    v.y = this.group.position.y + 0.03;
    this.fx('ring', v, PAL.crystal, { radius: 0.55, secs: 0.7 });
  }

  actFish(P, dt) {
    const F = this.fishing;
    if (!F) return;
    F.t += dt;
    P.aRx = -0.9; P.aLx = -0.8; P.aRz = -0.12; P.aLz = -0.32; P.bx = 0.04; P.gL = -0.15; P.gR = 0.1;
    const s = this.spot;
    const cast = F.cast || (F.cast = this.castDist());
    const wx = s.x + Math.sin(s.yaw) * cast, wz = s.z + Math.cos(s.yaw) * cast;
    const sy = this.seaY(wx, wz);
    const bob = this.xprop('bobber');
    switch (F.ph) {
      case 'cast': {
        const k = F.t / 1.0;
        if (k < 0.4) P.aRx = P.aLx = lerp(-0.9, -2.5, ease.outCubic(k / 0.4));
        else if (k < 0.6) P.aRx = P.aLx = lerp(-2.5, -0.7, (k - 0.4) / 0.2);
        else P.aRx = P.aLx = lerp(-0.7, -0.9, (k - 0.6) / 0.4);
        this.snap = k > 0.35 && k < 0.65;
        if (!F.flying && k >= 0.55) {
          F.flying = true; F.ft = 0;
          const tip = this.props.get('rod')?.userData.tip;
          const v = tip ? tip.getWorldPosition(_v1) : this.headWorld(_v1, 0.3);
          F.sx = v.x; F.sy = v.y; F.sz = v.z;
          this.showX('bobber', v.x, v.y, v.z, 0, 1);
        }
        if (F.flying) {
          F.ft += dt;
          const q = Math.min(1, F.ft / 0.55);
          bob.position.set(lerp(F.sx, wx, q), lerp(F.sy, sy, q) + Math.sin(q * Math.PI) * 0.6, lerp(F.sz, wz, q));
          if (q >= 1) { this.fx('ring', new THREE.Vector3(wx, sy, wz), 0xe9fffb, { radius: 0.4, secs: 0.6 }); F.ph = 'wait'; F.t = 0; F.next = 5 + this.r() * 8; F.flying = false; }
        }
        break;
      }
      case 'wait':
        bob.position.set(wx, sy + Math.sin(this.t * 2.2 + this.seed * 9) * 0.015, wz);
        if (this.actT % 9 > 7.5) { P.hx = 0.2; P.aLz = 0.1; }  // peer at the bobber
        if (F.t > F.next) { F.ph = 'bite'; F.t = 0; }
        break;
      case 'bite':
        bob.position.set(wx, sy - Math.abs(Math.sin(F.t * 11)) * 0.06, wz);
        P.bx = 0.2; P.hx = 0.3;
        if (F.t > 0.9) {
          F.ph = 'reel'; F.t = 0;
          const roll = this.r();
          F.kind = roll < 0.78 ? 0 : roll < 0.95 ? 1 : 2;
          const c = this.xprop('catch');
          c.userData.kinds.forEach((k, i) => { k.visible = i === F.kind; });
          this.showX('catch', wx, sy, wz, 0, 1);
          this.fx('puff', new THREE.Vector3(wx, sy + 0.05, wz), { color: 0xe9fffb, count: 5, size: 0.2, spread: 0.3, rise: 0.6, life: 0.5 });
        }
        break;
      case 'reel': {
        const k = Math.min(1, F.t / 0.75);
        P.aRx = P.aLx = lerp(-0.9, -2.35, ease.outCubic(Math.min(1, F.t / 0.25)));
        P.bx = -0.12; this.snap = F.t < 0.3;
        const head = this.headWorld(_v2, 0.42);
        const c = this.xprop('catch');
        c.position.set(lerp(wx, head.x, k), lerp(sy, head.y, k) + Math.sin(k * Math.PI) * 0.9, lerp(wz, head.z, k));
        c.rotation.set(0, this.yaw + Math.PI, Math.sin(this.t * 22) * 0.5);
        bob.position.copy(c.position);
        if (k >= 1) {
          F.ph = 'show'; F.t = 0;
          const [txt, col] = F.kind === 0 ? [this.r() < 0.8 ? '200 OK' : 'JSON!', '#3ddc84'] : F.kind === 1 ? ['404', '#ff6b6b'] : ["418 I'm a teapot", '#ffc53d'];
          this.fx('text', this.headWorld(new THREE.Vector3(), 0.75), txt, { color: col, size: 0.8, rise: 1.0 });
          this.fx('sparks', c.position.clone(), F.kind === 1 ? 0x9c95b5 : 0xffe38a, { count: 8, speed: 2.2, size: 0.1 });
        }
        break;
      }
      case 'show': {
        const c = this.xprop('catch');
        const head = this.headWorld(_v2, 0.42);
        c.position.copy(head); c.rotation.set(0, this.yaw + HALF_PI, Math.sin(this.t * 18) * 0.7);
        bob.position.copy(head);
        P.aRx = -2.4; P.aLx = -2.5; P.aLz = 0.5; P.aRz = 0.3; P.hx = -0.25; P.my = Math.abs(Math.sin(F.t * 8)) * 0.05;
        if (F.t > 1.4) { this.hideX('catch'); F.ph = 'cast'; F.t = 0; F.flying = false; this.hideX('bobber'); }
        break;
      }
      default: break;
    }
    this.updateLine(F.ph !== 'cast' || F.flying);
  }

  placeBobber() {
    const s = this.spot, cast = this.castDist();
    const wx = s.x + Math.sin(s.yaw) * cast, wz = s.z + Math.cos(s.yaw) * cast;
    this.showX('bobber', wx, this.seaY(wx, wz), wz, 0, 1);
  }

  // How far to cast so the bobber lands in the sea: past the island's beach when the radius is known.
  castDist() {
    const s = this.spot, isl = this.island;
    const c = this.islandCenter(_v5);
    const dx = s.x - c.x, dz = s.z - c.z, d = Math.hypot(dx, dz);
    let water = NaN;
    if (typeof isl?.prof?.shore === 'function') { try { water = isl.prof.shore(Math.atan2(dz, dx)); } catch { water = NaN; } }
    if (!Number.isFinite(water) && this.islandRadius() > 0) water = this.islandRadius() + 1.2;
    if (Number.isFinite(water)) return clamp(water - d + 1.9, 2.4, 5.5) + this.seed * 0.5;   // well past the cliff foot
    return 2.1 + this.seed * 0.6;
  }

  // Sea surface height: a CPU copy of the engine's sea wave (engine.js SEA_VERT) so bobbers ride the swell.
  seaY(x, z) {
    const e = this.engine;
    if (!e || !Number.isFinite(e.wind)) return SEA_Y;
    const amp = (0.2 + 0.22 * e.wind + 0.14 * (e.storm || 0)) * (e.settings?.reduceMotion ? 0.5 : 1);
    const t = Number.isFinite(e.time) ? e.time : this.t;
    const h = Math.sin(x * 0.23 + z * 0.11 + t * 0.9) * 0.5 + Math.sin(-x * 0.13 + z * 0.27 + t * 1.25) * 0.35 + Math.sin(x * 0.41 - z * 0.33 + t * 1.8) * 0.2;
    return h * amp + 0.06;
  }

  // Fishing line: a thin stretched box (GL lines are 1 px at any zoom and vanish on the sea).
  updateLine(on) {
    if (!on) { if (this.line) this.line.visible = false; return; }
    if (!this.line) {
      this.line = meshOf(sharedGeo('unitbox', () => new THREE.BoxGeometry(1, 1, 1)), LINE_MAT, SMALL);
      this.line.frustumCulled = false;
      this.extras.add(this.line);
    }
    const tip = this.props.get('rod')?.userData.tip;
    const bob = this.xprops.get('bobber');
    if (!tip || !bob) { this.line.visible = false; return; }
    tip.getWorldPosition(_v1);
    _v2.set(bob.position.x, bob.position.y + 0.04, bob.position.z);
    const len = _v1.distanceTo(_v2);
    this.line.position.copy(_v1).add(_v2).multiplyScalar(0.5);
    this.line.lookAt(_v2);
    this.line.scale.set(0.018, 0.018, Math.max(0.01, len));
    this.line.visible = true;
  }

  actShout(P, t) {
    const cyc = t % 2.6, shouting = cyc < 1.4;
    P.aRx = -1.45; P.aRz = -0.32; P.aRy = 0.2;
    P.aLx = -1.55 + Math.sin(t * 1.3) * 0.25; P.aLz = 0.35 + Math.sin(t * 0.9) * 0.35;
    P.by = Math.sin(t * 0.8) * 0.35; P.hy = P.by * 0.4;
    if (shouting) {
      P.my = Math.abs(Math.sin(t * 13)) * 0.025; P.bx = -0.1; P.hx = -0.1;
      if (t - (this.waveT || 0) > 0.3) { this.waveT = t; this.spawnWave(); }
    }
    if (this.liftNow > 0.01 && cyc > 2.2) { P.aLx = -2.6; P.aLz = 0.6; }  // commander points the way
  }

  actPhone(P, t, dt) {
    this.pace(dt, 0.3, 3.4, 0.3);
    P.aRx = -2.65; P.aRz = 0.16; P.hz = 0.2; P.hx = 0.05;
    P.aLx = -0.7 + Math.sin(t * 2.3) * 0.4; P.aLz = 0.35 + Math.sin(t * 1.7) * 0.3;
    if (t % 5 > 4.3) { P.hx = -0.2; P.aLz = 0.9; }  // exasperated "hello??"
  }

  actWrite(P, t) {
    P.aLx = -1.05; P.aLz = -0.42;
    P.aRx = -1.15 + Math.sin(t * 11) * 0.08; P.aRz = -0.34 + Math.cos(t * 11) * 0.06;
    if (t % 4.2 > 3.85) P.aRx = -1.75;  // big tick flourish
    P.hx = 0.38; P.bx = 0.07;
  }

  actManual(P, t) {
    P.aLx = P.aRx = -1.1; P.aLz = P.aRz = -0.25; P.hx = 0.42; P.bx = 0.05;
    if (t % 3.2 < 0.3) P.aRz = 0.1;  // page flip
    if (t - (this.sparkT || 0) > 0.3 && !this.lowFx()) {
      this.sparkT = t;
      const book = this.props.get('manual');
      if (book) this.spawnSparkle(book.getWorldPosition(_v1), 0.35, 0xfff2b0);
    }
  }

  actTinker(P, t) {
    P.my = -0.06; P.bx = 0.35; P.hx = 0.35; P.gL = -0.9; P.gR = 0.4;
    P.aRx = -0.85 + Math.sin(t * 5) * 0.08; P.aRy = Math.sin(t * 5) * 0.6; P.aLx = -0.7; P.aLz = -0.1;
    if (t % 3 < 0.02 && !this.lowFx()) this.impact('wrench', 0xffd66b);
  }

  actThink(P, t, dt) {
    P.aRx = -2.05; P.aRz = -0.55; P.aLx = -0.55; P.aLz = -0.55;
    P.hx = -0.18; P.hz = 0.12 + Math.sin(t * 0.8) * 0.05; P.bz = Math.sin(t * 0.6) * 0.03;
  }

  actWait(P, t) {
    const watch = t % 5.5 > 4.0;
    P.mrz = 0.06; P.bz = 0.04;
    if (watch) { P.aLx = -1.45; P.aLz = -0.55; P.hx = 0.35; P.hy = 0.25; P.aRx = -0.5; P.aRz = -0.4; }
    else { P.aLx = P.aRx = -0.95; P.aLz = P.aRz = -0.75; P.hy = Math.sin(t * 0.5) * 0.3; }
    const tap = Math.max(0, Math.sin(t * 9));
    P.gR = -0.25 * tap;
    if (!this.R.legL) P.my = tap * 0.012;
  }

  actStall(P, t) {
    this.sitPose(P, 0);
    P.bx = 0.12; P.hx = 0.28 + Math.sin(t * 0.5) * 0.05;
    P.aLx = P.aRx = -0.5; P.aLz = P.aRz = 0.05;
    if (t % 9 > 7.6) { P.hx = -0.45; P.aLx = P.aRx = -2.9; P.aLz = P.aRz = 0.3; P.sq = 1.06; }  // yaaawn
  }

  sitPose(P, h) {
    const R = this.R;
    P.my = h / this.scaleNow - R.hipH + (R.float ? -R.float * 0.6 : 0) + (this.faction === 'haiku' ? -0.02 : 0);
    if (R.legL) { P.gL = P.gR = this.faction === 'opus' ? -0.9 : -1.45; }
  }

  actLunch(P, t, dt) {
    const s = this.spot, food = FOOD[this.faction];
    this.sitPose(P, Math.max(0, s.sit));
    const per = 3.4 + this.seed, u = (t % per) / per;
    if (this.faction === 'sonnet' && s.sit > 0.3) { P.gL = -0.35 + Math.sin(t * 2.1) * 0.25; P.gR = -0.35 - Math.sin(t * 2.1) * 0.25; }
    if (food === 'mallow') {
      // hold the stick over the fire, eat now and then
      const m = this.props.get('mallow');
      const T = (this.mallowT = (this.mallowT || 0) + dt);
      P.aRx = -1.25; P.aRz = -0.15; P.aLx = -0.4;
      if (m) {
        const toast = T < 4 ? 0 : T < 8 ? 1 : 2;
        m.userData.mallow.material = MALLOW_MATS[toast];
        const lit = T > 8.5 && T < 9.8 && this.seed > 0.4;
        m.userData.flame.visible = lit;
        if (lit) m.userData.flame.scale.set(1, 1 + Math.sin(t * 20) * 0.2, 1);
        if (T > 9.8 && T < 10.6) { P.aRx = -2.1; P.aRz = -0.45; P.hx = 0.08; if (!this.blown) { this.blown = true; if (lit) this.fx('puff', m.userData.mallow.getWorldPosition(new THREE.Vector3()), { color: 0x888888, count: 3, size: 0.18, spread: 0.2, rise: 0.6 }); } }
        if (T > 10.6) { this.mallowT = 0; this.blown = false; }
      }
    } else {
      let a = -0.75;
      if (u < 0.18) a = lerp(-0.75, -2.15, ease.inOut(u / 0.18));
      else if (u < 0.34) { a = -2.15; P.hx = food === 'teacup' || food === 'oilcan' ? -0.35 : 0.08; }
      else if (u < 0.5) a = lerp(-2.15, -0.75, ease.inOut((u - 0.34) / 0.16));
      else P.hx = Math.sin(t * 12) * 0.035;  // chew
      P.aRx = a; P.aRz = u < 0.5 ? -0.42 : -0.15;
      P.aLx = food === 'teacup' ? -1.0 : -0.5; P.aLz = food === 'teacup' ? -0.25 : 0.05;
      if (food === 'oilcan' && u > 0.2 && u < 0.34 && t - (this.dripT || 0) > 1.2) {
        this.dripT = t;
        const hand = this.R.handR.getWorldPosition(new THREE.Vector3());
        this.spawnDrop(hand);
      }
    }
    if (u > 0.6 && u < 0.62 && this.r() < 0.3) this.lookT = 1.4;
  }

  actSleep(P, t) {
    this.sitPose(P, Math.max(0, this.spot.sit));
    const br = Math.sin(t * 1.25);
    P.bx = 0.45; P.hx = 0.5 + br * 0.03; P.hz = 0.15; P.aLx = P.aRx = 0.12; P.aLz = P.aRz = 0.22;
    P.sq = 1 + br * 0.025;
    if (this.faction === 'merc') { P.hx = 0.35; }
    const R = this.R;
    if (R.extra.hat) R.extra.hat.rotation.x = -0.14 + 0.5;  // droopy wizard hat
    if (!this.zzzH && !this.zFallback) {
      const fx = this.engine?.fx;
      if (typeof fx?.zzz === 'function') {
        try { this.zzzH = fx.zzz(this.talk, { offset: new THREE.Vector3(0.2, 0.02, 0) }) || null; } catch { this.zzzH = null; }
        if (!this.zzzH) this.zFallback = true;
      } else this.zFallback = true;
    }
  }

  actAlert(P, t) {
    // face the viewer and wave both arms (and a big flag) like a castaway
    if (this.onRoof || !this.hasRoof()) this.spot.yaw = FRAME.camYaw;
    const w = Math.sin(t * 6.5);
    P.aLz = 1.75 + w * 0.6; P.aLx = -0.35;
    P.aRz = 0.55 - w * 0.35; P.aRx = -2.75;
    P.bz = -w * 0.08; P.hx = -0.25; P.hz = w * 0.1;
    const hop = (t % 1.2) / 1.2;
    if (hop < 0.32) { const k = Math.sin((hop / 0.32) * Math.PI); P.my = k * 0.16; P.sq = 1 + k * 0.06; }
    else if (hop < 0.4) P.sq = 0.9;
    const flag = this.props.get('flag');
    if (flag) {
      flag.rotation.z = -w * 0.35;
      if (flag.userData.cloth) flag.userData.cloth.rotation.y = Math.sin(t * 11) * 0.45;
    }
  }

  actIdle(P, t) {
    P.hy = Math.sin(t * 0.4 + this.seed * 5) * 0.35;
  }

  // Side-step back and forth beside the spot (phone calls) while keeping the same heading: no turning around.
  pace(dt, amp, period, speedMul) {
    const s = this.spot, p = this.group.position;
    const yaw = Number.isNaN(s.yaw) ? this.yaw : s.yaw;
    const side = Math.floor(this.actT / period) % 2 ? 1 : -1;
    const tx = s.x + Math.cos(yaw) * amp * side, tz = s.z - Math.sin(yaw) * amp * side;
    const dx = tx - p.x, dz = tz - p.z, d = Math.hypot(dx, dz);
    if (d < 0.03) return;
    const step = Math.min(d, this.speed() * speedMul * this.dt);
    const nx = p.x + (dx / d) * step, nz = p.z + (dz / d) * step;
    if (!this.canStand(nx, nz)) return;
    p.x = nx; p.z = nz;
    this.moving = true;
    const g = GAIT[this.faction] || GAIT.merc;
    this.walkPhase += (step / (g.stride * this.scaleNow)) * Math.PI;
    this.gait();
  }

  // Head turns, blinks, props that animate on their own, reactions, duck-and-cover.
  layers(dt) {
    const P = this.P, R = this.R, t = this.t;
    // look around now and then when idle-ish
    if (this.lookT > 0) { this.lookT -= dt; P.hy += Math.sin(this.lookT * 3) * 0.5; }
    // Scouts raise their binoculars, Inspectors peer through the magnifier
    const idleish = !this.moving && (this.act === 'wait' || this.act === 'think' || this.act === 'idle' || this.act === 'stall');
    if (idleish && !this.finishing && (this.role === 'scout' || this.role === 'inspector')) {
      const cyc = (t + this.seed * 7) % 7;
      if (cyc > 5.4) {
        if (this.role === 'scout') { P.aLx = P.aRx = -2.2; P.aLz = P.aRz = -0.55; P.hx = -0.05; P.hy = Math.sin(t * 1.2) * 0.5; this.binoUp = true; }
        else { P.aRx = -2.1; P.aRz = -0.5; P.hx = 0.1; }
      } else this.binoUp = false;
    } else this.binoUp = false;
    this.placeBinoculars();
    // poke reaction: look at the camera, hop (or stomp if annoyed)
    if (this.reactT > 0) {
      this.reactT -= dt;
      const k = this.reactT;
      P.hy = clamp(wrapAngle(FRAME.camYaw - this.yaw), -1.2, 1.2);
      if (this.reactAnnoyed) { P.sq *= 1 - Math.max(0, Math.sin(k * 16)) * 0.08; P.aLz = P.aRz = -0.1; P.aLx = P.aRx = 0.1; P.hx = 0.15; }
      else if (k > 0.5) { P.my += Math.sin((1 - (k - 0.5) / 0.5) * Math.PI) * 0.1; P.aLz = 1.4; }
    }
    if (this.duckT > 0) {
      this.duckT -= dt;
      P.my -= 0.06; P.bx = 0.55; P.hx = 0.3; P.aLx = P.aRx = -2.7; P.aLz = P.aRz = -0.45; P.gL = -0.6; P.gR = 0.3;
    }
    // idle breathing
    if (!this.moving) P.sq *= 1 + Math.sin(t * 2.1 + this.seed * 10) * 0.012;
    if (R.float) P.my += R.float + Math.sin(t * 2.2 + this.seed * 6) * 0.03;
    P.lift = this.liftNow;
    const targetLift = this.phase === 'do' && !this.finishing ? this.spot.lift : 0;
    this.liftNow = damp(this.liftNow, targetLift, 9, dt);
  }

  placeBinoculars() {
    const b = this.bino;
    if (!b) return;
    const want = this.binoUp ? 'face' : 'chest';
    if (b.at !== want) {
      b.at = want;
      this.R.slots[want].add(b.obj);
      b.obj.position.set(0, want === 'face' ? 0 : -0.02, want === 'face' ? 0.05 : 0.02);
    }
  }

  applyPose(dt) {
    const P = this.P, R = this.R;
    const k = this.snap ? 1 : 1 - Math.exp(-16 * dt);
    const m = R.mover;
    const my = P.my + P.lift / Math.max(0.05, this.scaleNow);
    m.position.y += (my - m.position.y) * k;
    m.rotation.x += (P.mrx - m.rotation.x) * k;
    m.rotation.z += (P.mrz - m.rotation.z) * k;
    m.rotation.y += (P.mry - m.rotation.y) * k;
    const sq0 = m.userData.sq ?? 1, sq = sq0 + (P.sq - sq0) * k;
    m.userData.sq = sq;
    const inv = 1 / Math.sqrt(Math.max(0.2, sq));
    m.scale.set(inv, sq, inv);
    const T = R.torso, H = R.head;
    T.rotation.x += (P.bx - T.rotation.x) * k; T.rotation.z += (P.bz - T.rotation.z) * k; T.rotation.y += (P.by - T.rotation.y) * k;
    H.rotation.x += (P.hx - H.rotation.x) * k; H.rotation.y += (P.hy - H.rotation.y) * k; H.rotation.z += (P.hz - H.rotation.z) * k;
    const aL = R.armL, aR = R.armR;
    aL.rotation.x += (P.aLx - aL.rotation.x) * k; aL.rotation.z += (P.aLz - aL.rotation.z) * k; aL.rotation.y += (P.aLy - aL.rotation.y) * k;
    aR.rotation.x += (P.aRx - aR.rotation.x) * k; aR.rotation.z += (-P.aRz - aR.rotation.z) * k; aR.rotation.y += (-P.aRy - aR.rotation.y) * k;
    const fs = R.footScale;
    if (R.legL) R.legL.rotation.x += (P.gL * fs - R.legL.rotation.x) * k;
    if (R.legR) R.legR.rotation.x += (P.gR * fs - R.legR.rotation.x) * k;
    // level-held props (food, clipboards, testtubes) stay upright regardless of the arm swing
    for (let h = 0; h < 2; h++) {
      const hand = h ? R.handR : R.handL;
      for (let i = 0; i < hand.children.length; i++) {
        const c = hand.children[i];
        const lv = c.userData.level;
        if (lv == null || !c.visible) continue;
        c.rotation.x = lv - hand.parent.rotation.x - T.rotation.x;
      }
    }
  }

  // Self-animating bits: halo, tome, antennae, cape, banner, blinking, antenna light.
  animateParts(dt) {
    const R = this.R, t = this.t, X = R.extra;
    if (X.halo) { X.halo.position.y = X.haloY + Math.sin(t * 2.1 + this.seed) * 0.015; X.halo.rotation.x = HALF_PI + Math.sin(t * 1.3) * 0.18; X.halo.rotation.y = Math.sin(t * 0.9) * 0.15; }
    if (X.tome) { X.tome.position.y = 0.48 + Math.sin(t * 1.7 + 1) * 0.03; X.tome.rotation.y = t * 0.9 + this.seed * 6; X.tome.visible = this.act !== 'lunch' && this.act !== 'sleep' && !this.caster?.rig?.tome?.visible; }
    if (X.ant) {
      const bounce = this.moving ? Math.sin(this.walkPhase) * 0.25 : 0;
      for (const a of X.ant) { const s = a.userData.side; a.rotation.z = -s * (0.38 + Math.sin(t * 3 + s) * 0.06) + bounce * s; a.rotation.x = -bounce * 0.3; }
    }
    if (X.cape) X.cape.rotation.x = X.capeRx + Math.min(0.6, this.speedNow * 0.35) + Math.sin(t * 3.1) * 0.04 + (this.moving ? Math.sin(this.walkPhase * 2) * 0.05 : 0);
    if (X.flag) X.flag.rotation.y = Math.sin(t * 2.6 + this.seed * 4) * 0.35 + (this.moving ? 0.4 : 0);
    if (X.antTip) X.antTip.material = (t + this.seed) % 1.4 < 0.18 || this.act === 'sleep' ? X.antOff : X.antOn;
    if (X.hat && this.act !== 'sleep') X.hat.rotation.x = -0.14 - Math.min(0.3, this.speedNow * 0.15);
    // blink
    this.blinkT -= dt;
    const closed = this.act === 'sleep' || (this.act === 'cast' && this.castMode === 'think' && this.phase === 'do') || (this.blinkT < 0.12 && this.blinkT > 0);
    if (this.blinkT <= 0) this.blinkT = 2 + this.r() * 3.5;
    if (R.eyeGroup) R.eyeGroup.scale.y = closed ? 0.15 : 1;
  }

  // ---- props ---------------------------------------------------------------------------------------------------

  mountActProps(act, arrived) {
    const def = ACTS[act];
    if (!def) return;
    this.unmountActProps();
    if (def.onSite && !arrived) return;
    const list = act === 'lunch' ? [[FOOD[this.faction], 'R']] : def.props;
    for (const [name, slot] of list) {
      const obj = this.prop(name);
      const node = this.R.slots[slot] || this.R.slots.R;
      node.add(obj);
      obj.visible = true;
      obj.position.set(0, 0, 0); obj.rotation.set(0, 0, 0); obj.scale.setScalar(1);
      this.mountXf(name, obj, slot);
      this.mounted = this.mounted || [];
      this.mounted.push(obj);
    }
  }

  mountXf(name, o, slot) {
    switch (name) {
      case 'pickaxe': o.rotation.x = 0.95; break;
      case 'hammer': o.rotation.x = 1.15; break;
      case 'detector': o.rotation.x = 1.12; break;
      case 'rod': o.rotation.x = 0.1; break;
      case 'pencil': o.rotation.x = 1.9; break;
      case 'wrench': o.rotation.x = 0.7; break;
      case 'flag': o.position.set(0, 0, 0.02); break;
      case 'megaphone': o.position.set(0, -0.01, 0.0); break;
      case 'phone': o.position.set(-0.03, 0.0, 0.02); o.rotation.set(0.15, 0, 0.18); break;
      case 'scroll': o.position.set(0, 0.02, 0); break;
      case 'clipboard': o.userData.level = null; o.position.set(0.02, -0.02, -0.04); o.rotation.set(-0.95, 0, 0); break;
      case 'manual': o.position.set(0, -0.02, -0.03); o.rotation.set(-0.75, 0, 0); break;
      case 'headphones': o.position.set(0, 0.02, 0); break;
      case 'mallow': o.rotation.x = -0.15; break;
      default: break;
    }
    if (slot === 'front' && this.faction === 'haiku') o.position.z += 0.02;
  }

  unmountActProps() {
    if (!this.mounted) return;
    for (const o of this.mounted) {
      o.visible = false;
      if (o.name === 'clipboard') o.userData.level = 0;
      if (o.name === 'mallow') { o.userData.flame.visible = false; }
    }
    this.mounted.length = 0;
    if (this.R.extra.hat) this.R.extra.hat.rotation.x = -0.14;
  }

  xprop(name) {
    let o = this.xprops.get(name);
    if (!o) {
      o = bakeTree((XPROPS[name] || (() => new THREE.Group()))());
      o.name = name;
      o.userData.s = 0; o.userData.v = 0; o.userData.on = false; o.userData.s1 = 1;
      o.visible = false; o.scale.setScalar(0.0001);
      this.xprops.set(name, o);
      (this.xlist ||= []).push(o);
      this.extras.add(o);
    }
    return o;
  }

  showX(name, x, y, z, yaw, s1 = 1) {
    const o = this.xprop(name);
    o.position.set(x, y, z);
    o.rotation.set(0, yaw || 0, 0);
    o.userData.on = true; o.userData.s1 = s1;
    o.visible = true;
    return o;
  }

  hideX(name) { const o = this.xprops.get(name); if (o) o.userData.on = false; }

  xpropsTick(dt) {
    const xl = this.xlist;
    if (xl) for (let i = 0; i < xl.length; i++) springPop(xl[i], dt);
    const set = this.lunchSet;
    if (set) {
      const on = set.on && (this.act === 'lunch' || this.act === 'sleep');
      set.group.userData.on = on;
      springPop(set.group, dt);
      if (set.fire && set.group.visible) {
        const fl = set.fire.userData.flames, ember = this.act === 'sleep' ? 0.4 : 1, t = this.t;
        fl.scale.set(ember * (1 + Math.sin(t * 9) * 0.06), ember * (1 + Math.sin(t * 13) * 0.14 + Math.sin(t * 7.3) * 0.08), ember);
        fl.rotation.y = t * 0.8;
      }
    }
  }

  // ---- overlay (bubbles above the head) ----------------------------------------------------------------------

  ov(name) {
    let o = this.ovs.get(name);
    if (!o) {
      o = bakeTree(OVERLAYS[name]());
      o.userData.s = 0; o.userData.v = 0; o.userData.on = false;
      o.visible = false; o.scale.setScalar(0.0001);
      this.overlay.add(o);
      this.ovs.set(name, o);
    }
    return o;
  }

  overlayTick(dt) {
    const t = this.t;
    this.overlay.rotation.y = FRAME.camYaw - this.yaw - this.R.mover.rotation.y;
    // undo the mover's squash so bubbles keep their shape
    const m = this.R.mover.scale;
    this.overlay.scale.set(1 / m.x, 1 / m.y, 1 / m.z);
    const doing = this.phase === 'do' && !this.finishing;
    for (let n = 0; n < OV_NAMES.length; n++) {
      const name = OV_NAMES[n];
      let on;
      switch (name) {
        case 'thought': on = doing && this.act === 'think'; break;
        case 'hourglass': on = doing && (this.act === 'wait' || this.act === 'stall'); break;
        case 'rain': on = !!this.finishing && this.status === 'failed'; break;
        case 'check': on = this.checkT > 0; break;
        case 'bang': on = this.bangT > 0; break;
        default: on = doing && this.act === 'sleep' && !!this.zFallback; break;
      }
      let o = this.ovs.get(name);
      if (!o && !on) continue;
      o = o || this.ov(name);
      o.userData.on = on;
      springPop(o, dt);
      if (!o.visible) continue;
      switch (name) {
        case 'thought': { const gs = o.userData.gears; gs[0].rotation.z = t * 2.2; gs[1].rotation.z = -t * 3.1 + 0.3; o.position.set(0.16, 0.05 + Math.sin(t * 1.8) * 0.02, 0); break; }
        case 'hourglass': { const k = (t % 3) / 3; o.userData.glass.rotation.z = k > 0.85 ? ((k - 0.85) / 0.15) * Math.PI : 0; o.position.set(0.14, Math.sin(t * 1.6) * 0.02, 0); break; }
        case 'rain': {
          o.position.set(0, 0.12 + Math.sin(t * 2) * 0.02, 0);
          const drops = o.userData.drops;
          for (let i = 0; i < drops.length; i++) { const k = (t * 1.6 + i * 0.37) % 1; drops[i].position.y = -0.02 - k * 0.32; drops[i].scale.y = 1 - k * 0.5; }
          break;
        }
        case 'check': { this.checkT -= dt; o.position.y = 0.12 + (1.8 - this.checkT) * 0.12; o.rotation.y = Math.sin(t * 5) * 0.4; break; }
        case 'bang': { this.bangT -= dt; o.position.y = 0.05 + Math.sin(t * 12) * 0.02; break; }
        case 'zees': {
          o.position.set(0.12, 0, 0);
          const zs = o.userData.zs;
          for (let i = 0; i < zs.length; i++) { const k = (t * 0.45 + i / 3) % 1; zs[i].position.set(Math.sin(k * 5 + i) * 0.08 + k * 0.18, k * 0.55, 0); zs[i].scale.setScalar((0.5 + k * 0.7) * Math.min(1, (1 - k) * 4)); }
          break;
        }
        default: break;
      }
    }
    if (this.checkT < 0) this.checkT = 0;
    if (this.bangT < 0) this.bangT = 0;
    // sleepy snot bubble
    if (this.act === 'sleep' && doing) {
      const sn = this.snot || (this.snot = (() => { const o = OVERLAYS.snot(); this.R.slots.mouth.add(o); return o; })());
      const cyc = (t + this.seed * 20) % 16;
      sn.visible = cyc < 15;
      const s = 0.25 + 0.75 * (0.5 + 0.5 * Math.sin(t * 1.25));
      sn.scale.setScalar(cyc > 14.2 ? s * (1 + (cyc - 14.2) * 1.2) : s);
      sn.position.set(0.03, 0.01, 0.04 + s * 0.04);
      if (cyc > 15 && cyc < 15.05) this.reactT = 0.3;
    } else if (this.snot) this.snot.visible = false;
  }

  // ---- particles (own tiny pools; engine.fx handles the big stuff) -------------------------------------------

  spawnPart(kind, mesh, x, y, z, vx, vy, vz, life) {
    let slot = null;
    for (const p of this.parts) if (p.life <= 0 && p.kind === kind) { slot = p; break; }
    if (!slot) {
      if (this.parts.length > 24) return;
      slot = { kind, mesh: mesh(), life: 0, max: 1, vx: 0, vy: 0, vz: 0, s: 1 };
      this.extras.add(slot.mesh);
      this.parts.push(slot);
    }
    slot.mesh.position.set(x, y, z);
    slot.vx = vx; slot.vy = vy; slot.vz = vz; slot.life = slot.max = life;
    slot.mesh.visible = true;
    return slot;
  }

  // Pooled sparks keep their mesh; the (shared, cached) glow material is swapped so a reused one takes this colour.
  spawnSpark(color, x, y, z, vx, vy, vz, life) {
    const m = glow(color, 1);
    const p = this.spawnPart('spark', () => ico(0.03, 0, m, SMALL), x, y, z, vx, vy, vz, life);
    if (p) p.mesh.material = m;
    return p;
  }

  spawnSparkle(pos, rise, color) {
    this.spawnSpark(color, pos.x + (this.r() - 0.5) * 0.2, pos.y, pos.z + (this.r() - 0.5) * 0.2, 0, rise, 0, 0.9);
  }

  spawnDrop(pos) {
    this.spawnPart('drop', () => sphere(0.018, PAL.black, SMALL), pos.x, pos.y, pos.z, 0, -0.2, 0, 0.6);
  }

  spawnWave() {
    if (this.lowFx()) return;
    const tip = this.props.get('megaphone')?.userData.tip;
    if (!tip) return;
    const v = tip.getWorldPosition(_v1);
    const f = Math.sin(this.yaw), c = Math.cos(this.yaw);
    const p = this.spawnPart('wave', () => torus(0.07, 0.012, 3, 10, 0xffffff, { ...SMALL, arc: Math.PI * 0.7 }), v.x, v.y, v.z, f * 1.1, 0.05, c * 1.1, 0.7);
    if (p) { p.mesh.rotation.set(0, this.yaw, HALF_PI + Math.PI * 0.15 + Math.PI); }
  }

  // Fable scribes leave a sparkle trail while they float about.
  fableTrail(dt) {
    const fx = this.engine?.fx;
    const want = this.moving && !this.lowFx() && !this.finishing;
    if (typeof fx?.trail === 'function') {
      if (want) {
        this.trailIdle = 0;
        if (!this.trailH) {
          try { this.trailH = fx.trail(this.group, { color: this.pal.glow, rate: 9, size: 0.1, kind: 'sparkle', offset: new THREE.Vector3(0, 0.22 * this.baseScale, 0) }) || null; } catch { this.trailH = null; }
        }
      } else if (this.trailH && (this.trailIdle = (this.trailIdle || 0) + dt) > 0.3) this.stopTrail();
      if (this.trailH || !want) return;
    }
    if (want && this.t - (this.trailT || 0) > 0.12) {
      this.trailT = this.t;
      const p = this.group.position;
      this.spawnSparkle(_v1.set(p.x - Math.sin(this.yaw) * 0.15, p.y + 0.12 * this.scaleNow, p.z - Math.cos(this.yaw) * 0.15), 0.25, this.pal.glow);
    }
  }

  stopTrail() { try { this.trailH?.stop?.(); } catch { /* ignore */ } this.trailH = null; }
  stopZzz() { try { this.zzzH?.stop?.(); } catch { /* ignore */ } this.zzzH = null; }

  particlesTick(dt) {
    if (this.faction === 'fable') this.fableTrail(dt);
    for (const p of this.parts) {
      if (p.life <= 0) continue;
      p.life -= dt;
      const m = p.mesh;
      if (p.life <= 0) { m.visible = false; continue; }
      const k = p.life / p.max;
      m.position.x += p.vx * dt; m.position.y += p.vy * dt; m.position.z += p.vz * dt;
      if (p.kind === 'drop') p.vy -= 6 * dt;
      if (p.kind === 'wave') m.scale.setScalar(0.6 + (1 - k) * 1.8);
      else m.scale.setScalar(Math.min(1, k * 2.5) * (p.kind === 'spark' ? 0.6 + 0.4 * Math.sin(k * 20) : 1));
      if (p.kind === 'spark') m.rotation.y += dt * 4;
    }
  }

  // ---- sequences (generators ticked by the unit; each yield = one frame) --------------------------------------

  runSeq() {
    const r = this.seq.next();
    if (r.done) this.seq = null;
  }

  *wait(secs) { for (let t = 0; t < secs; t += this.dt) yield; }

  *seqSpawn(parent) {
    const p = this.group.position;
    const from = p.clone();
    let dir;
    if (parent) dir = new THREE.Vector3(Math.sin(this.seed * TAU), 0, Math.cos(this.seed * TAU));
    else { const [ox, oz] = this.doorOutXZ(); dir = new THREE.Vector3(ox, 0, oz); }
    const lat = new THREE.Vector3(dir.z, 0, -dir.x).multiplyScalar((this.r() - 0.5) * 0.9);
    const to = from.clone().addScaledVector(dir, parent ? 0.6 : 1.0).add(lat);
    to.y = parent ? from.y : this.groundY;
    this.yaw = Math.atan2(dir.x, dir.z); this.group.rotation.y = this.yaw;
    this.popScale = 0.05;
    this.doorHook('exit');
    this.fx('sparks', from.clone().setY(from.y + 0.35), this.pal.glow, { count: 10, speed: 2.4, size: 0.12 });
    this.fx('flash', from.clone().setY(from.y + 0.45), { color: this.pal.glow, size: 0.9, secs: 0.3 });
    const T = 0.55;
    for (let t = 0; t < T; t += this.dt) {
      const k = t / T;
      p.lerpVectors(from, to, ease.outQuad(k));
      this.popScale = 0.05 + 0.95 * ease.outBack(Math.min(1, k * 1.4));
      this.P.my = (Math.sin(k * Math.PI) * 0.45) / this.baseScale;
      this.P.aLz = this.P.aRz = 1.3 * Math.sin(k * Math.PI) + 0.12;
      this.P.gL = -0.5; this.P.gR = 0.3; this.P.mrx = -0.2 * Math.sin(k * Math.PI);
      this.snap = true;
      yield;
    }
    p.copy(to); this.popScale = 1;
    for (let t = 0; t < 0.2; t += this.dt) { this.P.sq = 1 - 0.24 * Math.sin((t / 0.2) * Math.PI); this.snap = true; yield; }
    if (!this.lowFx()) this.fx('puff', to.clone().setY(to.y + 0.05), { color: 0xf1e3c8, count: 5, size: 0.28, spread: 0.35, rise: 0.25, life: 0.6 });
  }

  *seqDone() {
    const p = this.group.position;
    this.popScale = 1;
    yield* this.faceCamera(0.25);
    if (STAMPERS.has(this.role)) yield* this.stampIt();
    else if (DONE_WORD[this.role]) this.fx('text', this.headWorld(new THREE.Vector3(), 0.6), DONE_WORD[this.role], { color: '#ffe38a', size: 0.72, rise: 1.0 });
    // jump + spin + confetti + check
    const T = 0.75, y0 = p.y;
    for (let t = 0; t < T; t += this.dt) {
      const k = t / T;
      this.P.my = (Math.sin(k * Math.PI) * 0.55) / this.scaleNow;
      this.P.mry = ease.inOut(k) * TAU;
      this.P.aLz = this.P.aRz = 2.6; this.P.aLx = this.P.aRx = -0.2; this.P.gL = -0.4; this.P.gR = 0.4;
      this.snap = true;
      if (k > 0.45 && !this._conf) { this._conf = true; this.fx('confetti', this.headWorld(new THREE.Vector3(), 0.3), { count: 28, power: 0.55 }); this.checkT = 1.8; }
      yield;
    }
    this.R.mover.rotation.y = 0; p.y = y0;
    for (let t = 0; t < 0.18; t += this.dt) { this.P.sq = 1 - 0.2 * Math.sin((t / 0.18) * Math.PI); this.snap = true; yield; }
    if (this.r() < 0.35) this.say(this.pickLine('done'), 2.4);
    yield* this.wait(0.35);
    const par = yield* this.goHome(1.0, false);
    yield* this.enter(par);
    this.resolveFinish();
  }

  *seqFailed() {
    if (this.r() < 0.6) this.say(this.pickLine('failed'), 2.6);
    for (let t = 0; t < 0.9; t += this.dt) { this.slumpPose(); this.P.sq = 1 - Math.min(1, t * 3) * 0.05; yield; }
    const par = yield* this.goHome(0.5, true);
    yield* this.enter(par);
    this.resolveFinish();
  }

  *seqLost() {
    const v = this.headWorld(new THREE.Vector3(), -0.2);
    this.fx('puff', v, { color: 0x9aa0ad, count: 12, size: 0.45, spread: 0.5, rise: 0.8 });
    this.fx('smoke', v.clone(), { count: 5, size: 0.4, rise: 0.9 });
    const T = 0.3;
    for (let t = 0; t < T; t += this.dt) { this.popScale = 1 - ease.inCubic(t / T); this.P.my = (t / T) * 0.2; yield; }
    this.popScale = 0.0001;
    yield* this.wait(0.3);
    this.resolveFinish();
  }

  slumpPose() {
    const P = this.P;
    P.bx = 0.38; P.hx = 0.45; P.aLx = P.aRx = 0.15; P.aLz = P.aRz = 0.06;
  }

  *faceCamera(secs) {
    for (let t = 0; t < secs; t += this.dt) { this.turnTo(FRAME.camYaw, this.dt, 12, 14); yield; }
  }

  *stampIt() {
    const st = this.prop('stamp');
    this.R.handR.add(st); st.visible = true; st.position.set(0, 0, 0.02); st.rotation.set(0, 0, 0);
    const board = this.prop('clipboard');
    this.R.slots.front.add(board); board.visible = true; board.userData.level = null; board.position.set(0.02, -0.08, -0.04); board.rotation.set(-1.35, 0, 0);
    const T = 0.9;
    let hit = false;
    for (let t = 0; t < T; t += this.dt) {
      const k = t / T;
      const a = k < 0.55 ? lerp(-0.9, -2.5, ease.outCubic(k / 0.55)) : k < 0.68 ? lerp(-2.5, -1.05, ((k - 0.55) / 0.13) ** 2) : -1.05;
      this.P.aRx = a; this.P.aRz = -0.3; this.P.aLx = -1.0; this.P.aLz = -0.35; this.P.hx = 0.35; this.P.bx = 0.08;
      st.rotation.x = -a - 0.1;
      this.snap = k > 0.5 && k < 0.72;
      if (k >= 0.68 && !hit) {
        hit = true;
        this.P.sq = 0.92;
        this.fx('text', this.headWorld(new THREE.Vector3(), 0.55), DONE_WORD[this.role] || 'APPROVED', { color: '#ff5a4d', size: 1.15, rise: 0.9 });
        this.fx('ring', st.userData.tip.getWorldPosition(new THREE.Vector3()), PAL.danger, { radius: 0.7, secs: 0.6 });
      }
      yield;
    }
    yield* this.wait(0.25);
    st.visible = false;
    board.visible = false; board.userData.level = 0;
  }

  // Walk back to the building door (apprentices: to the parent). Returns the parent unit if heading there.
  // world.js disposes a unit ~16 s after finish(), so far-away units hurry and, if still out of time, beam home.
  *goHome(speedMul, slump) {
    const p = this.group.position;
    for (;;) {
      const par = this.apprentice ? this.findParent() : null;
      const live = par && !par.finishing && !par.disposed ? par : null;
      let tx, ty, tz, r;
      if (live) { const pp = live.group.position; tx = pp.x; ty = pp.y; tz = pp.z; r = 0.38; }
      else { const d = this.doorPos(_v3); tx = d.x; ty = d.y; tz = d.z; r = 0.12; }
      const left = this.finishBudget() - 1.2;
      const need = Math.hypot(tx - p.x, tz - p.z) / Math.max(0.5, left);
      const base = this.speed() * speedMul;
      const sp = Math.max(base, Math.min(need * 1.2, this.speed() * 2.6));
      const arrived = this.walkTo(tx, ty, tz, sp, this.dt, r);
      if (slump) { this.slumpPose(); this.P.my *= 0.5; }
      if (arrived) return live;
      if (left < 0) { this.beam = true; return live; }
      yield;
    }
  }

  finishBudget() { return 14.5 - (this.t - (this.finishT0 ?? this.t)); }

  // Shrink into the building door (or into the parent unit) with a sparkle; the door flashes.
  *enter(par) {
    const p = this.group.position;
    const target = par ? par.group.position : this.homeCenter(new THREE.Vector3());
    const face = Math.atan2(target.x - p.x, target.z - p.z);
    const T = 0.38;
    const from = p.clone();
    for (let t = 0; t < T; t += this.dt) {
      const k = t / T;
      this.turnTo(face, this.dt, 14, 14);
      this.popScale = 1 - ease.inCubic(k);
      if (!par) p.set(from.x + Math.sin(face) * 0.25 * k, from.y, from.z + Math.cos(face) * 0.25 * k);
      else p.lerpVectors(from, par.group.position, k * 0.8);
      this.P.my = Math.sin(k * Math.PI) * 0.12;
      yield;
    }
    this.popScale = 0.0001;
    const at = par ? par.headWorld(new THREE.Vector3(), 0) : this.beam ? this.headWorld(new THREE.Vector3(), 0) : this.doorPos(new THREE.Vector3()).setY(p.y + 0.4);
    this.fx('sparks', at, this.pal.glow, { count: 9, speed: 2.2, size: 0.1 });
    this.fx('flash', at.clone(), { color: this.pal.glow, size: 0.8, secs: 0.3 });
    if (par) par.reactT = Math.max(par.reactT, 0.5);
    else this.doorHook('enter');
  }

  *seqClimbUp() {
    const rf = this.building?.roof;
    if (!isVec(rf)) return;
    const p = this.group.position;
    const h = this.homeCenter(new THREE.Vector3());
    const face = Math.atan2(h.x - p.x, h.z - p.z);
    const y0 = p.y, y1 = rf.y;
    const T = Math.max(0.6, (y1 - y0) / 1.15);
    this.phase = 'climb';
    for (let t = 0; t < T; t += this.dt) {
      this.turnTo(face, this.dt, 12);
      p.y = lerp(y0, y1, t / T);
      const c = Math.sin(t * 9);
      Object.assign(this.P, { aLx: -2.8 + c * 0.35, aRx: -2.8 - c * 0.35, aLz: 0.2, aRz: 0.2, gL: -0.7 - c * 0.4, gR: -0.7 + c * 0.4, bx: -0.05 });
      yield;
    }
    // hop onto the roof
    const from = p.clone(), to = new THREE.Vector3(rf.x, rf.y, rf.z);
    for (let t = 0; t < 0.45; t += this.dt) {
      const k = t / 0.45;
      p.lerpVectors(from, to, k); p.y += Math.sin(k * Math.PI) * 0.35;
      this.P.aLz = this.P.aRz = 1.2; this.snap = true;
      yield;
    }
    p.copy(to);
    this.onRoof = true;
    this.phase = 'do'; this.actT = 0;
    this.fx('puff', to.clone().setY(to.y + 0.05), { color: 0xf1e3c8, count: 5, size: 0.28, spread: 0.3, rise: 0.25, life: 0.6 });
  }

  *seqClimbDown() {
    const p = this.group.position;
    this.alertSpot();
    const s = this.spot;
    const from = p.clone(), edge = new THREE.Vector3(s.x, p.y, s.z);
    for (let t = 0; t < 0.4; t += this.dt) {
      const k = t / 0.4;
      p.lerpVectors(from, edge, k); p.y += Math.sin(k * Math.PI) * 0.25;
      this.P.aLz = this.P.aRz = 1.0; this.snap = true;
      yield;
    }
    const y0 = p.y, y1 = this.groundY;
    const T = Math.max(0.3, (y0 - y1) / 2.4);
    for (let t = 0; t < T; t += this.dt) {
      p.y = lerp(y0, y1, ease.inQuad(t / T));
      this.P.aLx = this.P.aRx = -2.9; this.P.aLz = this.P.aRz = 0.3; this.P.gL = -0.3; this.P.gR = -0.3;
      yield;
    }
    p.y = y1;
    this.onRoof = false;
    this.fx('puff', p.clone().setY(y1 + 0.05), { color: 0xf1e3c8, count: 6, size: 0.3, spread: 0.35, rise: 0.25, life: 0.6 });
    for (let t = 0; t < 0.18; t += this.dt) { this.P.sq = 1 - 0.22 * Math.sin((t / 0.18) * Math.PI); this.snap = true; yield; }
    const act = this.act;
    this.act = null;
    this.setAct(act || this.desiredAct());
  }

  resolveFinish() {
    clearTimeout(this._finishTimer);
    const r = this._resolveFinish;
    this._resolveFinish = null;
    if (r) r(this.status || 'done');
  }

  releaseEverything() {
    this.releaseSpot();
    if (this.act === 'lunch' || this.act === 'sleep' || this.lunchSeat >= 0) this.leaveLunch();
  }

  // ---- lines, labels, events ----------------------------------------------------------------------------------

  pickLine(kind) {
    const f = this.faction, role = this.role;
    const act = this.act === 'cast' ? (this.castMode === 'think' ? 'think' : this.castMode === 'wait' ? 'wait' : this.caster?.cat || 'write') : this.act || 'idle';
    const ck = act === 'lunch' ? 'lunch' : act === 'sleep' ? 'sleep' : act === 'alert' ? 'alert' : act === 'think' ? 'think' : act === 'wait' || act === 'stall' ? 'wait' : 'working';
    let pool;
    if (f === 'haiku') {
      if (kind === 'annoyed') pool = HAIKU.annoyed;
      else if (kind === 'done') pool = HAIKU.done;
      else if (kind === 'failed') pool = HAIKU.failed;
      else {
        pool = HAIKU.generic.slice();
        const a = HAIKU.act[act]; if (a) pool.push(...a, ...a, ...a);
        const rl = HAIKU.role[role]; if (rl) pool.push(rl, rl);
      }
    } else if (kind === 'annoyed') {
      pool = [...LINES.annoyed, ...(LINES.annoyedFaction[f] || []), ...(this.isCommander ? LINES.annoyedCommander : [])];
    } else if (kind === 'done') pool = LINES.done;
    else if (kind === 'failed') pool = LINES.failed;
    else if (kind === 'ambient') {
      pool = [...(LINES.act[act] || []), ...(LINES.act[act] || []), ...(LINES.faction[f] || [])];
      if (this.isCommander) pool.push(...(LINES.commander[ck] || []));
      if (this.isCommander && (act === 'lunch' || act === 'sleep')) pool.push(...(LINES.lunchFaction[f] || []));
    } else {
      pool = [];
      if (this.isCommander) {
        const c = LINES.commander[ck] || LINES.commander.working;
        pool.push(...c, ...c);
        if (act === 'lunch' || act === 'sleep') pool.push(...(LINES.lunchFaction[f] || []), ...(LINES.lunchFaction[f] || []));
      } else {
        const rl = LINES.role[role] || LINES.role.engineer;
        pool.push(...rl, ...rl);
      }
      pool.push(...(LINES.faction[f] || []), ...(LINES.act[act] || []));
    }
    if (!pool?.length) return null;
    let line = pool[Math.floor(this.r() * pool.length) % pool.length];
    if (line === this.lastLine && pool.length > 1) line = pool[(pool.indexOf(line) + 1 + Math.floor(this.r() * (pool.length - 1))) % pool.length];
    if (line === this.lastLine) line = pool.find((l) => l !== this.lastLine) || line;
    return line;
  }

  ambient() {
    if (this.t < this.nextAmbient) return;
    this.nextAmbient = this.t + 50 + this.r() * 120;
    const st = this.engine?.settings;
    if (st?.reduceMotion || this.t - AMBIENT.last < 18 || this.seq) return;   // at most one ambient line every 18 s map-wide
    AMBIENT.last = this.t;
    this.say(this.pickLine('ambient'), 3.4);
  }

  activityText() {
    const d = this.data || {}, tool = d.tool;
    if (this.finishing) return this.status === 'done' ? 'mission accomplished' : this.status === 'failed' ? 'heading home…' : 'lost';
    if (tool && (d.state === 'working' || d.state === 'waiting' || d.state === 'needs_input')) {
      return `${TOOL_VERB[tool.cat] || 'using'} ${tool.detail || tool.name || ''}`.trim();
    }
    if (d.state === 'stalled') return 'stalled';
    if (this.act === 'cast') return d.state === 'thinking' ? 'thinking…' : d.state === 'waiting' ? 'waiting…' : 'casting';
    return ACT_TEXT[this.act] || d.state || '';
  }

  labelHtml() {
    const d = this.data || {}, pal = this.pal;
    const name = this.isCommander ? 'Commander' : this.roleName + (this.apprentice ? ' jr.' : '');
    const st = this.finishing ? this.status : d.state;
    const chip = st ? `<b class="st st-${esc(st)}">${esc(STATE_WORD[st] || st)}</b>` : '';
    const desc = this.isCommander ? d.name || '' : d.description || d.type || '';
    const act = this.activityText();
    return `<div class="lbl-card"><div class="l1"><i class="fchip f-${esc(this.faction)}"></i><span class="name">${esc(name)}</span><span class="who">${esc(pal.unit)}</span>${chip}</div>` +
      (desc ? `<div class="l2 detail">${esc(trunc(desc, 44))}</div>` : '') +
      (act && act !== desc ? `<div class="l2 detail act">${esc(trunc(act, 48))}</div>` : '') + '</div>';
  }

  labelLift() { return (this.R.height + (this.R.float || 0)) * this.baseScale + 0.3; }

  refreshLabel() {
    const st = this.engine?.settings;
    const mode = st?.labels ?? st?.get?.('labels');
    const want = (this.selected || this.hovered) && !this.disposed && mode !== 'off';
    if (!want) { if (this.label) try { this.label.setVisible?.(false); } catch { /* ignore */ } return; }
    const labels = this.engine?.labels;
    if (!this.label && typeof labels?.add === 'function') {
      try {
        if (!cssDone && typeof labels.css === 'function') { labels.css('cnc-units', LABEL_CSS); cssDone = true; }
        this.labelHtmlLast = this.labelHtml();
        this.label = labels.add({
          object: this.group, offset: new THREE.Vector3(0, this.labelLift(), 0),
          html: this.labelHtmlLast, className: 'lbl-unit', kind: 'agent',
          target: this.isCommander ? undefined : { type: 'agent', id: this.id },
        });
      } catch (e) { this.label = null; if (!FX_WARNED.has('label')) { FX_WARNED.add('label'); console.warn('units: labels.add failed', e); } }
    }
    if (!this.label) return;
    const html = this.labelHtml();
    try {
      if (html !== this.labelHtmlLast) { this.labelHtmlLast = html; this.label.set?.(html); }
      this.label.setVisible?.(true);
    } catch { /* ignore */ }
  }

  // Is this pick target *this* unit? world.js registers commanders as { type: 'session', id, unit: 'cmd:<key>' }
  // (the building shares type/id but has no unit), agents as { type: 'agent', id }.
  isDirect(tg) {
    if (!tg) return false;
    if (this.isCommander) {
      if (tg.type === 'commander') return tg.id === this.key || tg.id === this.cmdId;
      return tg.type === 'session' && tg.id === this.key && tg.unit === this.cmdId;
    }
    return (tg.type === 'agent' || tg.type === 'unit') && tg.id === this.id;
  }

  listen() {
    const bus = this.engine?.bus;
    if (typeof bus?.on !== 'function') return;
    this._subs = [];
    const sub = (name, fn) => {
      try { const off = bus.on(name, fn); this._subs.push([name, fn, typeof off === 'function' ? off : null]); } catch { /* ignore */ }
    };
    sub('select', (tg) => {
      const me = this.isDirect(tg);
      if (me) this.poke();
      if (me !== this.selected) { this.selected = me; this.refreshLabel(); }
    });
    sub('hover', (tg) => { const me = this.isDirect(tg); if (me !== this.hovered) { this.hovered = me; this.refreshLabel(); } });
    sub('event', (ev) => {
      if (ev?.type === 'clear' && ev.key === this.key && !this.finishing) {
        const h = this.homeCenter(_v1);
        if (Math.hypot(this.group.position.x - h.x, this.group.position.z - h.z) < 7) this.duck(1.2 + this.r() * 0.6);
      }
    });
  }

  unlisten() {
    const bus = this.engine?.bus;
    for (const [name, fn, off] of this._subs || []) {
      try { if (off) off(); else bus?.off?.(name, fn); } catch { /* ignore */ }
    }
    this._subs = [];
  }

  // ---- spellcasting (commanders) --------------------------------------------------------------------------------
  // working / thinking / waiting sessions: the commander stays at its command post (no walking to stations) and
  // casts at the module for the current tool category. A category change re-aims (rate-limited pivot, at most one
  // every 1.5 s) and recolours; it never sends the commander anywhere.

  // The command post (cached until the building moves).
  postSpot() {
    const s = this.spot, b = this.building;
    const c = isVec(b?.center) ? b.center : isVec(b?.door) ? b.door : null;
    const P = this.post || (this.post = new THREE.Vector3(NaN, 0, NaN));
    const pc = this.postC || (this.postC = { x: NaN, z: NaN });
    if (!Number.isFinite(P.x) || (c && (Math.abs(c.x - pc.x) > 0.25 || Math.abs(c.z - pc.z) > 0.25))) {
      this.commandPost(P);
      if (c) { pc.x = c.x; pc.z = c.z; }
    }
    s.x = P.x; s.y = P.y; s.z = P.z;
    const C = this.caster;
    s.yaw = C && Number.isFinite(C.aimYaw) ? C.aimYaw : NaN;
  }

  // Just in front of the HQ, left of the door path: clear of the door, the picnic table, the modules, island
  // obstacles, the lot edge (walkable ground) and other commanders' posts.
  commandPost(out) {
    const b = this.building;
    const door = this.doorPos(_k1);
    const [fx, fz] = this.doorOutXZ();
    const sx = fz, sz = -fx;
    const s = clamp(Number.isFinite(b?.group?.scale?.x) ? b.group.scale.x : 1, 0.5, 1.2);
    const table = b?.lunch?.table;
    let bx = NaN, bz = NaN;
    for (let i = 0; i < POST_CANDS.length; i++) {
      const side = POST_CANDS[i][0], fwd = POST_CANDS[i][1];
      const x = door.x + (sx * side + fx * fwd) * s, z = door.z + (sz * side + fz * fwd) * s;
      if (i === 0) { bx = x; bz = z; }
      if (!this.canStand(x, z) || this.insideObstacle(x, z, 0.2)) continue;
      if (isVec(table) && Math.hypot(x - table.x, z - table.z) < 0.78 * s) continue;
      if (this.moduleNear(x, z, 0.85 * s) || this.postTaken(x, z)) continue;
      return out.set(x, this.groundY, z);
    }
    return out.set(bx, this.groundY, bz);
  }

  moduleNear(x, z, r) {
    const mods = this.building?.modules;
    if (!mods || typeof mods.values !== 'function') return false;
    for (const m of mods.values()) {
      const g = m?.group;
      if (!g?.getWorldPosition) continue;
      try { g.updateWorldMatrix(true, false); g.getWorldPosition(_k4); } catch { continue; }
      if (Math.hypot(_k4.x - x, _k4.z - z) < r) return true;
    }
    return false;
  }

  postTaken(x, z) {
    for (const c of COMMANDERS.values()) if (c !== this && !c.disposed && c.post && Math.hypot(c.post.x - x, c.post.z - z) < 1.4) return true;
    return false;
  }

  // Aim point for a tool category: its add-on module (search uses the Observatory), else the category's work spot
  // when that is not right under the commander's feet, else the HQ core.
  castModule(cat) {
    try { return this.building?.modules?.get?.(cat === 'search' ? 'read' : cat) || null; } catch { return null; }
  }

  castAim(cat, out) {
    const b = this.building, p = this.group.position;
    const s = clamp(Number.isFinite(b?.group?.scale?.x) ? b.group.scale.x : 1, 0.5, 1.2);
    const m = this.castModule(cat);
    if (m?.group?.getWorldPosition) {
      try { m.group.updateWorldMatrix(true, false); m.group.getWorldPosition(out); out.y += 0.6 * s; return out; } catch { /* fall through */ }
    }
    let w = null;
    try { w = b?.workSpot?.(cat); } catch { w = null; }
    if (isVec(w) && Math.hypot(w.x - p.x, w.z - p.z) > 1.6) return out.set(w.x, (Number.isFinite(w.y) ? w.y : this.groundY) + 0.5, w.z);
    this.homeCenter(out);
    const h = Number.isFinite(b?.height) ? b.height : 2.4;
    out.y += clamp(h * 0.42, 0.8, 1.6) * s;
    return out;
  }

  castSetup() {
    if (this.caster) return this.caster;
    const C = {
      root: new THREE.Group(), fill: null, outer: null, inner: null, aura: null,
      mode: 'work', cat: null, pendCat: null, pendT: 0, color: -1, aim: new THREE.Vector3(), aimYaw: NaN, aimT: -1e9,
      aimMod: null, reaimT: -1e9,
      next: 0, push: 0, flare: 0, sparkAcc: 0, fxAcc: 0, flipT: 9, chkT: 0, orbs: [], bolt: null, arcs: null, arcT: 0, rig: null,
      neutral: NaN, twist: 0,
    };
    C.root.name = `${this.group.name}:cast`;
    Object.assign(C.root.userData, { s: 0, v: 0, on: false, s1: 1 });
    C.root.visible = false; C.root.scale.setScalar(0.0001);
    const mk = (geo, kind, order, y) => {
      const m = new THREE.Mesh(geo, castMat(0xffffff, kind));
      m.castShadow = m.receiveShadow = false; m.renderOrder = order; m.position.y = y; m.userData.noPick = true;
      C.root.add(m);
      return m;
    };
    C.fill = mk(CAST_GEO.fill(), 'fill', 2, 0.012);
    C.outer = mk(CAST_GEO.outer(), 'line', 3, 0.02);
    C.inner = mk(CAST_GEO.inner(), 'line', 3, 0.022);
    C.aura = mk(CAST_GEO.aura(), 'aura', 4, 0);
    this.extras.add(C.root);
    this.caster = C;
    return C;
  }

  castBegin() {
    const C = this.castSetup();
    C.cat = null; C.pendCat = null; C.aimT = -1e9; C.push = 0; C.twist = 0;
    const h = this.homeCenter(_k3), p = this.group.position;
    C.neutral = Math.hypot(h.x - p.x, h.z - p.z) > 0.3 ? Math.atan2(h.x - p.x, h.z - p.z) : this.yaw;
    C.next = this.t + 0.7 + this.r() * 0.6;
    C.root.position.copy(this.group.position);
  }

  castEnd() {
    this.castMode = '';
    this.spot.lift = 0;
    if (this.caster) this.caster.pendCat = null;
  }

  castRecolor(color) {
    const C = this.caster;
    if (C.color === color) return;
    C.color = color;
    C.fill.material = castMat(color, 'fill');
    C.outer.material = C.inner.material = castMat(color, 'line');
    C.aura.material = castMat(color, 'aura');
  }

  castRetarget(cat, pulse) {
    const C = this.caster;
    C.cat = cat; C.aimT = this.t; C.pendCat = null;
    this.castReaim();
    const p = this.group.position;
    if (pulse) {
      C.flare = 0.14;
      if (!this.lowFx()) this.fx('ring', _k2.set(p.x, p.y, p.z), CAST_COLOR[cat] || 0xffffff, { radius: 1.0, secs: 0.45 });
    }
  }

  // Point at the current target of the current category. Quiet: no pulse, and the feet and torso follow through
  // their usual damping.
  castReaim() {
    const C = this.caster;
    C.reaimT = this.t;
    C.aimMod = this.castModule(C.cat);
    this.castAim(C.cat, C.aim);
    const p = this.group.position, dx = C.aim.x - p.x, dz = C.aim.z - p.z;
    if (dx * dx + dz * dz > 0.09) C.aimYaw = Math.atan2(dx, dz);
  }

  // The casting act (phase 'do' at the post): mode, category, facing, bolt schedule and pose.
  actCast(P, t, dt) {
    const C = this.castSetup(), d = this.data || {};
    const mode = d.state === 'thinking' ? 'think' : d.state === 'waiting' ? 'wait' : 'work';
    if (mode !== C.mode) { C.mode = mode; if (mode !== 'think') C.next = Math.max(C.next, this.t + 0.6); }
    this.castMode = mode;
    // the building moved (new lot): walk to the new post
    if (this.t - C.chkT > 2) {
      C.chkT = this.t;
      const c = this.building?.center;
      if (isVec(c) && this.postC && (Math.abs(c.x - this.postC.x) > 0.25 || Math.abs(c.z - this.postC.z) > 0.25)) { this.setAct('cast'); return; }
    }
    const waitCat = d.tool?.cat && ACT_OK.has(d.tool.cat) ? d.tool.cat : null;
    const cat = mode === 'think' ? null : mode === 'wait' ? waitCat || C.cat || 'write' : this.toolAct();
    if (cat && cat !== C.cat) {
      if (cat !== C.pendCat) { C.pendCat = cat; C.pendT = 0; } else C.pendT += dt;
      if (C.cat == null || (C.pendT >= 0.35 && this.t - C.aimT >= 1.5)) this.castRetarget(cat, C.cat != null);
    } else C.pendCat = null;
    // The target can move under a steady category: its module unlocks mid-command (the Drill Rig on the 3rd shell
    // command) or a /clear demolishes it. Re-aim when the module comes or goes, and every 2 s for anything else.
    if (C.cat && (this.castModule(C.cat) !== C.aimMod || this.t - C.reaimT >= 2)) this.castReaim();
    const color = mode === 'think' ? THINK_COLOR[this.faction] || 0xffffff
      : mode === 'wait' && !waitCat ? WAIT_COLOR : CAST_COLOR[C.cat] || 0xffffff;
    this.castRecolor(color);
    this.spot.lift = mode === 'think' ? 0.24 : 0;
    if (mode === 'think') { C.twist = 0; this.poseMeditate(P, t); return; }
    // face the target: the feet pivot part of the way from the HQ-facing stance (slowly, never a spin) and the
    // torso twists the rest, so switching between modules on either side reads as aiming, not turning around
    if (Number.isFinite(C.aimYaw)) {
      const n = Number.isFinite(C.neutral) ? C.neutral : C.aimYaw;
      const body = n + 0.55 * wrapAngle(C.aimYaw - n);
      this.spot.yaw = body;
      this.turnTo(body, dt, 5, 3.2);
      C.twist = clamp(wrapAngle(C.aimYaw - this.yaw), -0.75, 0.75);
    } else C.twist = 0;
    const slow = mode === 'wait';
    if (this.t >= C.next && C.cat) {
      this.castLaunch();
      C.next = this.t + (slow ? 3.4 + this.r() * 2.2 : 1.5 + this.r() * 1.5);
      C.push = 0.32;
    }
    this.poseCast(P, t, C.next - this.t, C.push, slow);
    P.by = C.twist * 0.85; P.hy = C.twist * 0.2;
    C.push = Math.max(0, C.push - dt);
  }

  // Arms raised channelling toward the target; wind up before each release, thrust on it.
  poseCast(P, t, lead, push, slow) {
    const sp = slow ? 0.55 : 1;
    const wind = lead < 0.45 ? clamp(1 - lead / 0.45, 0, 1) : 0;
    const thr = push > 0 ? push / 0.32 : 0;
    let ax = -2.2 + Math.sin(t * 2.3 * sp) * 0.12, az = 0.38 + Math.sin(t * 1.7 * sp + 1) * 0.08;
    ax = lerp(lerp(ax, -2.8, wind), -1.45, thr); az = lerp(lerp(az, 0.55, wind), 0.14, thr);
    P.aLx = ax + Math.sin(t * 2.3 * sp + 1.4) * 0.08; P.aRx = ax; P.aLz = az; P.aRz = az;
    P.bx = -0.05 - wind * 0.08 + thr * 0.2; P.hx = -0.14 + thr * 0.1;
    P.gL = -0.2; P.gR = 0.24; P.mrz = Math.sin(t * 1.1 * sp) * 0.03;
    switch (this.faction) {
      case 'opus':   // palms over the floating tome
        P.aLx += 0.3; P.aRx += 0.3; P.aLz += 0.08; P.aRz += 0.08;
        break;
      case 'sonnet':   // wrench-staff up in the right hand, holo-tablet in the left
        P.aRx = lerp(lerp(-2.55 + Math.sin(t * 3 * sp) * 0.1, -2.9, wind), -1.4, thr); P.aRz = 0.1;
        P.aLx = -1.2; P.aLz = -0.12 + Math.sin(t * 1.3) * 0.04; P.aLy = 0.3;
        break;
      case 'haiku':   // stubby arms up, a hop on the release
        P.aLz = P.aRz = 1.45 + Math.sin(t * 7 * sp) * 0.18 + wind * 0.3; P.aLx = P.aRx = -0.4 - thr * 0.9;
        P.sq = 1 - wind * 0.1 + thr * 0.06; P.my += thr * 0.1;
        break;
      case 'fable':   // the wand hand draws little circles, the free hand held open
        P.aRx = lerp(-2.3 + Math.sin(t * 6 * sp) * 0.2, -1.35, thr); P.aRy = Math.cos(t * 6 * sp) * 0.35; P.aRz = 0.12;
        P.aLx = -1.9; P.aLz = 0.62;
        break;
      case 'merc': {   // fists forward, servo jitter, recoil on the strike
        const j = Math.sin(t * 41) * 0.035;
        P.aLx = P.aRx = lerp(-1.6 + j, -1.25, wind) - thr * 0.25; P.aLz = P.aRz = 0.05 + wind * 0.1;
        P.bx = -0.04 - thr * 0.15; P.gL = -0.25; P.gR = 0.25;
        break;
      }
      default: break;
    }
  }

  // Thinking: hover cross-legged, palms open, eyes closed (the glyph ring orbits; see castFlavor).
  poseMeditate(P, t) {
    P.aLx = P.aRx = -0.55; P.aLz = P.aRz = 0.6; P.hx = 0.18; P.bx = 0.03;
    if (this.R.legL) P.gL = P.gR = this.faction === 'opus' || this.faction === 'haiku' ? -0.9 : -1.35;
    P.my += Math.sin(t * 1.4 + this.seed * 5) * 0.025;
    if (this.faction === 'haiku') { P.aLz = P.aRz = 0.95; P.aLx = P.aRx = -0.2; }
    else if (this.faction === 'merc') { P.aLx = P.aRx = -0.9; P.aLz = P.aRz = 0.25; }
  }

  // World position of a hand (0 = left, 1 = right) held forward at shoulder height (analytic: no matrix reads).
  handPoint(h, out) {
    const R = this.R, s = this.scaleNow, p = this.group.position;
    const yaw = this.yaw + (this.act === 'cast' && this.caster ? this.caster.twist || 0 : 0);
    const fx = Math.sin(yaw), fz = Math.cos(yaw);
    const side = (h ? -1 : 1) * R.shoulderX * s;
    const up = (R.torso.position.y + R.shoulderY + (R.float || 0)) * s + this.liftNow;
    const fwd = (R.frontZ + R.armLen) * s;
    return out.set(p.x + fz * side + fx * fwd, p.y + up, p.z - fx * side + fz * fwd);
  }

  castLaunch() {
    const C = this.caster;
    const from = this.handPoint(0, _k1).add(this.handPoint(1, _k2)).multiplyScalar(0.5);
    from.y += 0.1 * this.scaleNow;
    const ay = this.yaw + (C.twist || 0);
    if (this.faction === 'sonnet' || this.faction === 'fable') { from.x += Math.sin(ay) * 0.2; from.z += Math.cos(ay) * 0.2; from.y += 0.1; }
    const to = _k2.copy(C.aim);
    to.x += (Math.random() - 0.5) * 0.3; to.y += (Math.random() - 0.5) * 0.2; to.z += (Math.random() - 0.5) * 0.3;
    const color = C.color;
    C.flare = Math.max(C.flare, 0.1);
    if (this.faction === 'opus') C.flipT = 0;
    if (this.faction === 'merc') { this.castLightning(from, to, color); return; }
    let o = null;
    for (let i = 0; i < C.orbs.length; i++) if (!C.orbs[i].on) { o = C.orbs[i]; break; }
    if (!o) o = C.orbs.length < 2 ? this.makeOrb() : C.orbs[0];
    o.on = true; o.t = 0; o.color = color; o.acc = 0;
    o.a.copy(from); o.b.copy(to);
    const dist = from.distanceTo(to);
    o.dur = clamp(dist / 5.2, 0.35, 0.95);
    o.c.addVectors(from, to).multiplyScalar(0.5); o.c.y += 0.3 + dist * 0.2;
    o.mesh.material = castMat(color); o.halo.material = castMat(color, 'halo');
    o.mesh.position.copy(from); o.halo.position.copy(from);
    o.mesh.visible = o.halo.visible = true;
    if (this.lowFx()) return;
    this.fx('flash', from, { color, size: 0.4 * FRAME.boost, secs: 0.16 });
    if (this.faction === 'sonnet') this.fx('sparks', from, 0xffd66b, { count: 5, speed: 2, size: 0.08 });
  }

  makeOrb() {
    const mesh = new THREE.Mesh(CAST_GEO.orb(), castMat(0xffffff));
    const halo = new THREE.Mesh(CAST_GEO.halo(), castMat(0xffffff, 'halo'));
    for (const m of [mesh, halo]) { m.castShadow = m.receiveShadow = false; m.visible = false; m.renderOrder = 5; m.userData.noPick = true; }
    this.extras.add(mesh, halo);
    const o = { mesh, halo, on: false, t: 0, dur: 0.5, acc: 0, color: 0xffffff, a: new THREE.Vector3(), b: new THREE.Vector3(), c: new THREE.Vector3() };
    this.caster.orbs.push(o);
    return o;
  }

  // Orb along a quadratic arc with a sparkle trail; a small flash + sparks on the module when it lands.
  orbTick(o, dt) {
    o.t += dt;
    const k = Math.min(1, o.t / o.dur), u = 1 - k, a = o.a, b = o.b, c = o.c;
    const x = u * u * a.x + 2 * u * k * c.x + k * k * b.x;
    const y = u * u * a.y + 2 * u * k * c.y + k * k * b.y;
    const z = u * u * a.z + 2 * u * k * c.z + k * k * b.z;
    o.mesh.position.set(x, y, z); o.halo.position.set(x, y, z);
    const B = FRAME.boost;
    o.mesh.scale.setScalar((0.85 + Math.sin(this.t * 31) * 0.15) * B);
    o.halo.scale.setScalar((0.8 + Math.sin(this.t * 23 + 1) * 0.2) * B);
    if (!this.lowFx()) {
      o.acc += dt * 30;
      while (o.acc >= 1) {
        o.acc -= 1;
        this.emitGlow(x + (Math.random() - 0.5) * 0.08, y + (Math.random() - 0.5) * 0.08, z + (Math.random() - 0.5) * 0.08,
          (Math.random() - 0.5) * 0.3, 0.15 + Math.random() * 0.3, (Math.random() - 0.5) * 0.3, 0.075, 0.4, o.color);
      }
    }
    if (k < 1) return;
    o.on = false; o.mesh.visible = o.halo.visible = false;
    this.fx('flash', b, { color: o.color, size: 0.62 * FRAME.boost, secs: 0.24 });
    if (!this.lowFx()) this.fx('sparks', b, o.color, { count: 6, speed: 1.8, size: 0.09 });
  }

  // Merc: a crackling lightning strike instead of an orb.
  castLightning(from, to, color) {
    const C = this.caster;
    const L = C.bolt || (C.bolt = { on: false, t: 0, a: new THREE.Vector3(), b: new THREE.Vector3() });
    L.on = true; L.t = 0; L.a.copy(from); L.b.copy(to);
    C.arcT = 0;
    this.fx('flash', to, { color, size: 0.72 * FRAME.boost, secs: 0.24 });
    if (this.lowFx()) return;
    this.fx('flash', from, { color, size: 0.4 * FRAME.boost, secs: 0.14 });
    this.fx('sparks', to, color, { count: 8, speed: 2.4, size: 0.1 });
  }

  // Per frame for any unit that ever cast: circle, orbs in flight, faction flourishes (also while popping out).
  castTick(dt) {
    const C = this.caster, p = this.group.position, t = this.t, mode = C.mode;
    const casting = this.act === 'cast' && this.phase === 'do' && !this.finishing;
    if (casting) C.root.position.set(p.x, p.y + 0.005, p.z);
    C.root.userData.on = casting;
    C.root.userData.s1 = FRAME.boost;
    springPop(C.root, dt);
    if (C.root.visible) {
      const k = mode === 'think' ? 0.3 : mode === 'wait' ? 0.45 : 1;
      C.outer.rotation.y += dt * 0.75 * k; C.inner.rotation.y -= dt * 1.25 * k;
      const pulse = 1 + Math.sin(t * 3.1 + this.seed * 7) * 0.025 + C.flare;
      C.outer.scale.setScalar(pulse); C.inner.scale.setScalar(pulse + C.flare);
      C.aura.scale.set(1 + C.flare, (mode === 'think' ? 0.75 : 1) * (0.94 + Math.sin(t * 5.3) * 0.05) + C.flare * 2.2, 1 + C.flare);
      C.flare = Math.max(0, C.flare - dt * 0.7);
      if (casting) {   // sparkles rising off the circle
        C.sparkAcc += dt * (mode === 'think' ? 3 : mode === 'wait' ? 5 : 9) * (this.lowFx() ? 0.3 : 1);
        while (C.sparkAcc >= 1) {
          C.sparkAcc -= 1;
          const a = Math.random() * TAU, r = 0.3 + Math.random() * 0.3;
          this.emitGlow(p.x + Math.cos(a) * r, p.y + 0.06, p.z + Math.sin(a) * r, 0, 0.6 + Math.random() * 0.6, 0,
            0.07 + Math.random() * 0.05, 0.7 + Math.random() * 0.5, C.color);
        }
      }
    }
    for (let i = 0; i < C.orbs.length; i++) if (C.orbs[i].on) this.orbTick(C.orbs[i], dt);
    this.castFlavor(dt, casting);
  }

  // Faction flourishes + the think glyph ring / wait hourglass. Rig-mounted pieces are rebuilt with the body.
  castFlavor(dt, casting) {
    const C = this.caster, R = this.R, t = this.t, mode = C.mode;
    if (casting && (!C.rig || C.rig.faction !== this.faction)) this.castRig();
    if (this.faction === 'merc' || C.arcs) this.mercArcs(dt, casting && this.faction === 'merc');
    const rig = C.rig;
    if (!rig) return;
    for (let i = 0; i < rig.pops.length; i++) {
      const o = rig.pops[i], w = o.userData.when;
      o.userData.on = casting && (w === 'all' || (w === 'think' ? mode === 'think' : w === 'wait' ? mode === 'wait' : mode !== 'think'));
      springPop(o, dt);
    }
    const low = this.lowFx();
    if (rig.ring.visible) {
      rig.ring.rotation.y += dt * 0.55;
      rig.ring.position.y = (R.height * 0.52 + (R.float || 0)) * this.scaleNow + this.liftNow + Math.sin(t * 1.3) * 0.03;
    }
    if (rig.glass.visible) {
      const k = (t % 3) / 3;
      rig.glass.rotation.z = k > 0.82 ? ((k - 0.82) / 0.18) * Math.PI : 0;
      rig.glass.position.set(0, -0.04 + Math.sin(t * 1.6) * 0.02, 0);
    }
    if (rig.crown?.visible) rig.crown.rotation.y += dt * (mode === 'think' ? 0.6 : 1.3);
    if (rig.tome?.visible) {
      const tm = rig.tome;
      tm.position.set(0, R.torso.position.y + R.holdY + 0.12 + Math.sin(t * 1.7) * 0.025 + (mode === 'think' ? 0.1 : 0), R.frontZ + 0.3);
      tm.rotation.set(-0.45, 0, Math.sin(t * 1.3) * 0.06);
      C.flipT += dt;
      if (mode === 'think' && C.flipT > 3.2) C.flipT = 0;
      const lf = tm.userData.leaf;
      if (lf) lf.rotation.z = C.flipT < 0.55 ? ease.inOut(C.flipT / 0.55) * Math.PI : 0;
      if (casting && !low && (C.fxAcc += dt * 2.2) >= 1) {
        C.fxAcc = 0;
        this.headWorld(_k3, -0.15);
        this.emitGlow(_k3.x + Math.sin(this.yaw) * 0.3, _k3.y, _k3.z + Math.cos(this.yaw) * 0.3, 0, 0.5, 0, 0.1, 0.8, 0xffd447);
      }
    }
    if (rig.tablet?.visible && Math.random() < 0.05) rig.tablet.scale.y *= 0.7;   // hologram flicker
    if (rig.wrench?.visible && casting && !low && (C.fxAcc += dt * 2) >= 1) {
      C.fxAcc = 0;
      const tip = rig.wrench.userData.tip;
      if (tip) this.fx('sparks', tip.getWorldPosition(_k3), 0xffd66b, { count: 2, speed: 1.4, size: 0.06 });
    }
    if (rig.wand?.visible && casting && !low) {
      C.fxAcc += dt * 16;
      const tip = rig.wand.userData.tip;
      if (tip && C.fxAcc >= 1) tip.getWorldPosition(_k3);
      while (C.fxAcc >= 1) {   // star sparkles off the wand tip, and now and then around the scribe
        C.fxAcc -= 1;
        if (tip) this.emitGlow(_k3.x, _k3.y, _k3.z, (Math.random() - 0.5) * 0.3, 0.2 + Math.random() * 0.2, (Math.random() - 0.5) * 0.3, 0.09, 0.5, this.pal.glow);
        if (Math.random() < 0.2) {
          const a = Math.random() * TAU, r = 0.3 + Math.random() * 0.3;
          this.emitGlow(this.group.position.x + Math.cos(a) * r, this.group.position.y + 0.25 + Math.random() * 0.9, this.group.position.z + Math.sin(a) * r, 0, 0.12, 0, 0.13, 0.7, 0xfff3a0);
        }
      }
    }
    if (rig.petals) {   // Haiku: cherry petals spiralling up around the sprite
      const Pm = rig.petals;
      if (casting) {
        const n = low ? 6 : 12, sp = mode === 'think' ? 0.1 : mode === 'wait' ? 0.14 : 0.24, s = this.scaleNow;
        for (let i = 0; i < n; i++) {
          const k = (t * sp + i / n) % 1;
          const a = i * 2.39996 + k * TAU * 1.2 + t * 0.5, r = 0.66 - 0.36 * k;
          _k1.set(Math.sin(a) * r, 0.08 + k * 1.3 * s, Math.cos(a) * r);
          _kq.setFromEuler(_ke.set(k * 9 + i, t * 2.2 + i * 1.3, k * 4));
          const sc = Math.sin(k * Math.PI) * 1.1 + 0.001;
          _km.compose(_k1, _kq, _ks.set(sc, sc, sc));
          Pm.setMatrixAt(i, _km);
        }
        Pm.count = n; Pm.visible = true;
        Pm.instanceMatrix.needsUpdate = true;
      } else if (Pm.visible) { Pm.visible = false; Pm.count = 0; }
    }
  }

  // Build this faction's rig-mounted casting pieces.
  castRig() {
    const C = this.caster;
    this.castDropRig();
    const R = this.R, pal = this.pal, f = this.faction;
    const rig = { faction: f, pops: [], ring: null, glass: null, crown: null, tome: null, tablet: null, wrench: null, wand: null, petals: null };
    const pop = (o, when, parent) => {
      Object.assign(o.userData, { when, s: 0, v: 0, on: false, s1: 1 });
      o.visible = false; o.scale.setScalar(0.0001);
      o.traverse((m) => { if (m.isMesh) { m.castShadow = m.receiveShadow = false; m.userData.noPick = true; } });
      parent.add(o);
      rig.pops.push(o);
      return o;
    };
    rig.ring = pop(new THREE.Mesh(CAST_GEO.ring6(), castMat(THINK_COLOR[f] || 0xffffff)), 'think', this.group);
    rig.glass = pop(new THREE.Mesh(CAST_GEO.hourglass(), castMat(HOURGLASS_COLOR)), 'wait', this.overlay);
    if (f === 'opus') {
      rig.crown = pop(new THREE.Mesh(CAST_GEO.crown(), castMat(0xffd447)), 'all', R.head);
      rig.crown.position.set(0, R.headCY + 0.06, 0);
      rig.tome = pop(makeOpenTome(pal), 'all', R.mover);
    } else if (f === 'sonnet') {
      rig.tablet = pop(makeTablet(), 'cast', R.handL);
      rig.tablet.position.set(0.02, 0.0, 0.1); rig.tablet.rotation.y = 0.35; rig.tablet.userData.level = -0.35;
      rig.wrench = pop(makeTechWrench(), 'cast', R.handR);
      rig.wrench.rotation.x = 1.2;
    } else if (f === 'fable') {
      rig.wand = pop(makeWand(pal), 'cast', R.handR);
      rig.wand.rotation.x = 1.2;
    } else if (f === 'haiku') {
      const Pm = new THREE.InstancedMesh(CAST_GEO.petal(), castMat(PETAL_COLOR), 12);
      Pm.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      Pm.count = 0; Pm.visible = false; Pm.frustumCulled = false; Pm.castShadow = Pm.receiveShadow = false; Pm.userData.noPick = true;
      this.group.add(Pm);
      rig.petals = Pm;
    }
    C.rig = rig;
  }

  castDropRig() {
    const C = this.caster, rig = C?.rig;
    if (!rig) return;
    for (const o of rig.pops) { o.parent?.remove(o); disposeTree(o); }
    if (rig.petals) { rig.petals.parent?.remove(rig.petals); rig.petals.dispose?.(); }
    C.rig = null;
  }

  castDispose() {
    const C = this.caster;
    if (!C) return;
    this.castDropRig();
    C.arcs?.dispose?.();
    this.caster = null;
  }

  // Merc: crackling arcs from the fists to the circle while casting, plus the lightning strike (one instanced mesh).
  mercArcs(dt, on) {
    const C = this.caster;
    const L = C.bolt;
    if (L?.on && (L.t += dt) > 0.24) L.on = false;
    const ambient = on && C.mode !== 'think' && !this.lowFx();
    if (!ambient && !L?.on) { if (C.arcs) { C.arcs.visible = false; C.arcs.count = 0; } return; }
    const A = C.arcs || (C.arcs = this.makeArcs());
    A.visible = true;
    if ((C.arcT -= dt) > 0) return;   // hold each jag for a few frames
    C.arcT = 0.055;
    let n = 0;
    if (ambient) {
      const p = this.group.position;
      for (let h = 0; h < 2; h++) {
        if (Math.random() < 0.3) continue;   // flicker
        this.handPoint(h, _k1);
        const a = Math.random() * TAU;
        _k2.set(p.x + Math.cos(a) * 0.58, p.y + 0.03, p.z + Math.sin(a) * 0.58);
        n = this.jagged(A, n, _k1, _k2, 5, 0.09, 0.022, ARC_COLOR);
      }
    }
    if (L?.on) n = this.jagged(A, n, L.a, L.b, 9, 0.2, 0.04, C.color);
    A.count = n;
    A.instanceMatrix.needsUpdate = true;
    if (A.instanceColor) A.instanceColor.needsUpdate = true;
  }

  makeArcs() {
    const A = new THREE.InstancedMesh(CAST_GEO.seg(), castMat(0xffffff), 24);
    A.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    A.setColorAt(0, _kc.set(ARC_COLOR));
    A.count = 0; A.frustumCulled = false; A.castShadow = A.receiveShadow = false; A.renderOrder = 5; A.userData.noPick = true;
    this.extras.add(A);
    return A;
  }

  // Write a jagged polyline from a to b as `segs` box segments into the instanced mesh, starting at instance n.
  jagged(A, n, a, b, segs, amp, w, color) {
    const [prev, cur, dir, e1, e2] = _jag;
    dir.subVectors(b, a);
    const len = dir.length();
    if (len < 1e-3) return n;
    dir.multiplyScalar(1 / len);
    e1.set(0, 1, 0).cross(dir);
    if (e1.lengthSq() < 1e-4) e1.set(1, 0, 0);
    e1.normalize(); e2.crossVectors(dir, e1);
    _kc.set(color);
    prev.copy(a);
    for (let i = 1; i <= segs && n < 24; i++) {
      const k = i / segs, j = i === segs ? 0 : Math.sin(k * Math.PI) * amp;
      cur.copy(a).addScaledVector(dir, len * k).addScaledVector(e1, (Math.random() - 0.5) * 2 * j).addScaledVector(e2, (Math.random() - 0.5) * 2 * j);
      _k3.subVectors(cur, prev);
      const l = _k3.length();
      if (l > 1e-4) {
        _kq.setFromUnitVectors(_kz, _k3.multiplyScalar(1 / l));
        _k4.addVectors(prev, cur).multiplyScalar(0.5);
        _km.compose(_k4, _kq, _ks.set(w, w, l));
        A.setMatrixAt(n, _km);
        A.setColorAt(n, _kc);
        n++;
      }
      prev.copy(cur);
    }
    return n;
  }

  // Glowing particle through the engine's pooled fx (falls back to the unit's own tiny sparkle pool).
  emitGlow(x, y, z, vx, vy, vz, size, life, color) {
    const fx = this.engine?.fx;
    if (fx?.glow && typeof fx.emit === 'function') {
      try { fx.emit(fx.glow, x, y, z, vx, vy, vz, size, life, color, 1, 0, 1.1, 5); return; } catch { /* fall back */ }
    }
    if (this.t - (this.glowT || 0) < 0.08) return;
    this.glowT = this.t;
    this.spawnSpark(color, x, y, z, vx, vy, vz, life);
  }

  // ---- helpers -------------------------------------------------------------------------------------------------

  fx(name, ...args) {
    const fx = this.engine?.fx;
    const f = fx?.[name];
    if (typeof f !== 'function') return false;
    try { f.apply(fx, args); return true; } catch (e) {
      if (!FX_WARNED.has(name)) { FX_WARNED.add(name); console.warn(`units: fx.${name} failed`, e); }
      return false;
    }
  }

  lowFx() {
    const st = this.engine?.settings;
    return !!(st && (st.quality === 'low' || st.reduceMotion));
  }

  impact(propName, color) {
    if (this.lowFx() || this.t - this.lastFx < 0.3) return;
    this.lastFx = this.t;
    const tip = this.props.get(propName)?.userData.tip;
    const v = tip ? tip.getWorldPosition(new THREE.Vector3()) : this.headWorld(new THREE.Vector3(), -0.3);
    this.fx('sparks', v, color, { count: 7, speed: 2.4, size: 0.1 });
  }

  // Optional building hooks: onUnitExit(unit) / onUnitEnter(unit) win; else buildings.js openDoor(secs) / flashDoor().
  doorHook(which) {
    const b = this.building;
    if (!b) return;
    try {
      if (which === 'exit') {
        if (typeof b.onUnitExit === 'function') b.onUnitExit(this);
        else if (typeof b.openDoor === 'function') b.openDoor(1.1);
      } else if (typeof b.onUnitEnter === 'function') b.onUnitEnter(this);
      else if (typeof b.flashDoor === 'function') b.flashDoor();
    } catch { /* ignore */ }
  }

  findParent() {
    const pid = this.data?.parent;
    if (pid == null) return null;
    let par = null;
    try { par = this.world.unitOf?.(pid) || null; } catch { par = null; }
    if (!par) for (let i = 0; i < LIVE.length; i++) if (LIVE[i].id === pid && !LIVE[i].isCommander) { par = LIVE[i]; break; }
    return par && !par.disposed && par !== this ? par : null;
  }

  hasRoof() { return isVec(this.building?.roof) && this.building.roof.y - this.groundY > 0.4; }

  homeCenter(v) {
    const c = this.building?.center;
    if (isVec(c)) return v.set(c.x, Number.isFinite(c.y) ? c.y : this.groundY, c.z);
    const g = this.building?.group;
    if (g) { try { return g.getWorldPosition(v); } catch { /* fall through */ } }
    if (isVec(this.building?.door)) return v.copy(this.building.door);
    return this.islandCenter(v);
  }

  islandCenter(v) {
    const isl = this.island;
    if (isVec(isl?.center)) return v.set(isl.center.x, 0, isl.center.z);
    if (isl?.group) { try { return isl.group.getWorldPosition(v); } catch { /* ignore */ } }
    if (isVec(isl?.position)) return v.set(isl.position.x, 0, isl.position.z);
    const g = this.building?.group;
    if (g) { try { return g.getWorldPosition(v); } catch { /* ignore */ } }
    return v.set(0, 0, 0);
  }

  islandRadius() { return Number.isFinite(this.island?.radius) ? this.island.radius : 0; }

  // Unit vector from the building centre to its door (xz).
  doorOutXZ() {
    const b = this.building;
    if (isVec(b?.door) && b.group) {
      const h = this.homeCenter(_v5);
      const dx = b.door.x - h.x, dz = b.door.z - h.z, l = Math.hypot(dx, dz);
      if (l > 0.05) return [dx / l, dz / l];
    }
    const ry = b?.group?.rotation?.y ?? 0;
    return [Math.sin(ry), Math.cos(ry)];
  }

  doorPos(v) {
    const b = this.building;
    if (isVec(b?.door)) return v.set(b.door.x, Number.isFinite(b.door.y) ? b.door.y : this.groundY, b.door.z);
    const h = this.homeCenter(v);
    const [ox, oz] = this.doorOutXZ();
    return v.set(h.x + ox * 1.8, this.groundY, h.z + oz * 1.8);
  }

  // Fallback spots around the building when buildings.js has no workSpot / lunch.
  fallbackSpot(cat, v) {
    const ANG = { edit: 0.95, bash: -0.95, read: 1.7, search: 2.4, web: -1.7, agent: 0.5, mcp: -0.5, plan: 1.3, skill: -1.3, other: 2.9, lunch: -2.3 };
    const h = this.homeCenter(v);
    const [ox, oz] = this.doorOutXZ();
    const a = Math.atan2(ox, oz) + (ANG[cat] ?? 0);
    return v.set(h.x + Math.sin(a) * 2.9, this.groundY, h.z + Math.cos(a) * 2.9);
  }

  groundOf(p) {
    if (typeof this.island?.heightAt === 'function') { try { const y = this.island.heightAt(p.x, p.z); if (Number.isFinite(y)) return y; } catch { /* ignore */ } }
    return Number.isFinite(p?.y) ? p.y : this.groundY;
  }

  shoulderWorld() { return (this.R.torso.position.y + this.R.shoulderY) * this.scaleNow; }

  headWorld(v, above = 0) {
    const p = this.group.position;
    return v.set(p.x, p.y + (this.R.height + (this.R.float || 0)) * this.scaleNow + this.liftNow + above, p.z);
  }
}

// Spring-driven pop in/out (overshoots a little, then settles). Uses userData { on, s, v, s1 }.
function springPop(o, dt) {
  const ud = o.userData;
  const target = ud.on ? ud.s1 ?? 1 : 0;
  if (ud.s === target && !ud.v) { o.visible = target > 0; return; }
  const steps = dt > 0.034 ? 3 : 1, h = dt / steps;
  for (let i = 0; i < steps; i++) {
    ud.v += ((target - ud.s) * 240 - ud.v * 17) * h;
    ud.s += ud.v * h;
  }
  if (Math.abs(ud.s - target) < 0.002 && Math.abs(ud.v) < 0.01) { ud.s = target; ud.v = 0; }
  if (target === 0 && ud.s < 0.02) { ud.s = 0; ud.v = 0; }
  o.visible = ud.s > 0.001;
  o.scale.setScalar(Math.max(0.0001, ud.s));
}

// Debug / harness access.
Unit.roleOf = roleOf;
Unit.ROLE_NAMES = ROLE_NAMES;
Unit._debug = { LIVE, COMMANDERS, SLOTS, LINES, HAIKU };
export default Unit;
