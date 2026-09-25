// Configuration: defaults < config.json (project root, for a git clone) < the user's config file < --config <file>
// < environment < command-line flags. The user's file is %APPDATA%\command-and-context\config.json on Windows and
// $XDG_CONFIG_HOME (or ~/.config)/command-and-context/config.json elsewhere: an npm/npx install lives in npm's cache.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const DEFAULTS = {
  port: 7420,
  host: '127.0.0.1',
  claudeDir: process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'),
  tickMs: 1000,
  registryMs: 1500,
  systemMs: 2500,
  asleepAfterMin: 20,       // idle this long -> the base goes to sleep
  hideAfterHours: 4,        // asleep this long (with nothing running) -> the base leaves the map
  endedLingerSec: 90,       // how long a closed session stays around for its decommission animation
  agentLingerMin: 20,       // finished sub-agents stay in the data (not on the map) this long
  fallbackActiveMin: 30,    // no session registry? transcripts written this recently count as live
  showAllPorts: false,      // also show ports of ordinary desktop apps (Zoom, Adobe, ...)
  ignorePorts: [],
  showPrompts: true,        // include each session's last prompt in the info card
  contextWindows: {},       // e.g. { "claude-haiku-4-5": 200000 }
};
export const DEFAULT_PORT = DEFAULTS.port;

const FLAGS = {
  '--port': ['port', Number],
  '--host': ['host', String],
  '--claude-dir': ['claudeDir', String],
  '--asleep-after': ['asleepAfterMin', Number],
  '--hide-after': ['hideAfterHours', Number],
  '--all-ports': ['showAllPorts', () => true],
  '--no-prompts': ['showPrompts', () => false],
  '--open': ['open', () => true],
  '--app': ['app', () => true],
  '--demo': ['demo', () => true],
  '--dump': ['dump', () => true],
  '--no-open': ['noOpen', () => true],
};

export function userConfigFile() {
  const base = process.platform === 'win32'
    ? process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
    : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'command-and-context', 'config.json');
}

export function loadConfig(argv) {
  const cfg = { ...DEFAULTS, open: false, app: false, demo: false, dump: false };
  const i = argv.findIndex((a) => a === '--config' || a.startsWith('--config='));
  const explicit = i < 0 ? null : argv[i].includes('=') ? argv[i].slice('--config='.length) : argv[i + 1];
  if (i >= 0) argv = argv.filter((_, k) => k !== i && !(k === i + 1 && !argv[i].includes('=')));
  const explicitFile = explicit ? path.resolve(explicit) : null;
  for (const file of [path.join(ROOT, 'config.json'), userConfigFile(), explicitFile]) {
    if (!file) continue;
    if (!fs.existsSync(file)) { if (file === explicitFile) console.warn(`config file not found: ${file}`); continue; }
    try { Object.assign(cfg, JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''))); }
    catch (e) { console.warn(`${file} ignored: ${e.message}`); }
  }
  if (process.env.CNC_PORT) cfg.port = Number(process.env.CNC_PORT);
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split('=');
    const spec = FLAGS[flag];
    if (!spec) {
      if (flag === '--help' || flag === '-h') cfg.help = true;
      else console.warn(`unknown flag ${flag}`);
      continue;
    }
    const [key, conv] = spec;
    if (conv === Number || conv === String) cfg[key] = conv(inline !== undefined ? inline : argv[++i]);
    else cfg[key] = conv();
  }
  if (!Array.isArray(cfg.ignorePorts)) cfg.ignorePorts = [];
  if (cfg.noOpen) cfg.open = cfg.app = false;
  return cfg;
}

export const HELP = `
Command & Context: an RTS diorama of your Claude Code sessions.

  npx command-and-context [flags]     (opens the dashboard: an app window on Windows, your browser elsewhere)
  node server/index.js [flags]        (from a clone: only opens it with --open or --app)

  --port <n>          HTTP port (default 7420)
  --open              open the dashboard in your browser
  --app               open it as a chromeless Edge/Chrome app window (good for a spare monitor)
  --no-open           just run the server
  --demo              open in demo mode (simulated world, no real data needed)
  --asleep-after <m>  minutes idle before a base goes to sleep (default 20)
  --hide-after <h>    hours asleep before a base leaves the map (default 4)
  --all-ports         show every listening port, not just dev servers
  --no-prompts        never send prompt text to the browser
  --dump              print one world snapshot as JSON and exit
  --config <file>     read settings from this JSON file (see the README for the keys)
  --claude-dir <dir>  Claude Code's config folder (default: $CLAUDE_CONFIG_DIR or ~/.claude)

Settings file: ${userConfigFile()}
`;
