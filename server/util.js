// Small shared helpers: path normalization, tool classification, text trimming.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const IS_WIN = process.platform === 'win32';

// The Claude desktop app is an MSIX package, so processes it launches can report their working
// directory through the package's virtualized AppData. Map those back to the real location.
const MSIX_VIRTUAL = /[\\/]AppData[\\/]Local[\\/]Packages[\\/][^\\/]+[\\/]LocalCache[\\/](Roaming|Local)[\\/]/i;

export function cleanPath(p) {
  if (!p || typeof p !== 'string') return null;
  let s = p.replace(/^\\\\\?\\/, '');
  s = s.replace(MSIX_VIRTUAL, (_m, which) => `${path.sep}AppData${path.sep}${which}${path.sep}`);
  if (s.length > 3) s = s.replace(/[\\/]+$/, '');
  return s;
}

// Stable comparison key for a path: lowercase on Windows, forward slashes, no trailing slash.
export function pathKey(p) {
  const s = cleanPath(p);
  if (!s) return null;
  let k = s.replace(/\\/g, '/');
  if (IS_WIN) k = k.toLowerCase();
  if (k.length > 3) k = k.replace(/\/+$/, '');
  return k;
}

export function isInside(childKey, parentKey) {
  if (!childKey || !parentKey) return false;
  return childKey === parentKey || childKey.startsWith(parentKey.endsWith('/') ? parentKey : parentKey + '/');
}

export function basename(p) {
  if (!p) return '';
  return String(p).split(/[\\/]/).filter(Boolean).pop() || String(p);
}

export function trunc(s, n) {
  if (s == null) return '';
  s = String(s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

export function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

export function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch { return null; }
}

export function statSafe(file) {
  try { return fs.statSync(file); } catch { return null; }
}

export function homeDir() { return os.homedir(); }

// One command of a command line: from `start` up to the next ; & | or newline.
function eachCommand(s, start, fn) {
  return s.replace(new RegExp(`${start.source}[^;&|\\r\\n]*`, 'gi'), fn);
}

// Strip anything that looks like a credential out of a command line (or a search pattern / query)
// before it leaves the server.
export function redactCmd(cmd) {
  if (!cmd) return '';
  let s = String(cmd);
  // mysql -pSECRET: only after a mysql-family command, so `mkdir -p dir` stays intact. `-p` on its own
  // (password prompt) is followed by a space and the database name, which is left alone.
  s = eachCommand(s, /\b(?:mysql\w*|mariadb[\w-]*)/, (m) => m.replace(/(\s-p)(?:"[^"]*"|'[^']*'|[^\s"']+)/g, '$1***'));
  // curl -u user:pass / --user user:pass: keep the user, drop the password.
  s = eachCommand(s, /\bcurl(?:\.exe)?\b/, (m) => m.replace(/(\s(?:-u|-U|--user|--proxy-user)(?:\s+|=)?["']?[^\s:"']*:)[^\s"']+/g, '$1***'));
  // ConvertTo-SecureString 'pw' / -String 'pw' / 'pw' | ConvertTo-SecureString
  s = eachCommand(s, /\bConvertTo-SecureString\b/, (m) => m
    .replace(/^(ConvertTo-SecureString\s+)("[^"]*"|'[^']*'|[^\s"'-]\S*)/i, '$1***')
    .replace(/(\s-String\s+)("[^"]*"|'[^']*'|\S+)/gi, '$1***'));
  s = s.replace(/("[^"]*"|'[^']*')(\s*\|\s*ConvertTo-SecureString\b)/gi, '***$2');
  return s
    .replace(/((?:--?|\/)(?:[\w-]*(?:token|secret|password|passwd|pwd|apikey|api-key|api_key|auth|credential|key))[=\s:]+)("[^"]*"|'[^']*'|[^\s"']+)/gi, '$1***')
    .replace(/\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|APIKEY)[A-Z0-9_]*=)\S+/g, '$1***')
    // password=x, passwd: x, Pwd=x; (connection strings), "password":"x", in any case and without dashes.
    // Not after `$` (`-v $PWD:/app`). Bounded quantifiers: long dotted or dashed runs must not make this
    // quadratic.
    .replace(/((?<!\$)(?:password|passwd|passphrase|pwd|secret)[\w.-]{0,40}["']?\s{0,4}[=:]\s*)("[^"]*"|'[^']*'|[^\s"',;&|]+)/gi, '$1***')
    .replace(/\b((?:authorization|proxy-authorization|x-api-key|api-key|cookie)\s*:\s*)[^"'\r\n]+/gi, '$1***')
    .replace(/\b(bearer|basic)\s+[\w.~+/=-]{8,}/gi, '$1 ***')
    .replace(/([?&][\w-]*(?:token|key|secret|password|sig|signature|auth)[\w-]*=)[^&\s"']+/gi, '$1***')
    .replace(/\b(sk|pk|ghp|gho|ghs|ghu|xox[abp]|AKIA)[-_A-Za-z0-9]{12,}/g, '***')
    .replace(/\b(?:github_pat_|glpat-|npm_|AIza)[A-Za-z0-9_-]{20,}/g, '***')
    .replace(/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]+/g, '***')
    .replace(/(\/\/[^:/\s]+:)[^@/\s]+@/g, '$1***@');
}

// Human-sized version of a command line: drop the executable's directory and quotes.
export function shortCmd(cmd, n = 160) {
  if (!cmd) return '';
  let s = redactCmd(cmd).trim();
  s = s.replace(/^"([^"]+)"/, (_m, exe) => basename(exe)).replace(/^(\S*[\\/])([^\\/\s]+)/, '$2');
  return trunc(s, n);
}

// ---- tool taxonomy -------------------------------------------------------------------------

export function toolCategory(name) {
  if (!name) return 'other';
  if (/^mcp__/.test(name)) {
    if (/browser|chrome|playwright|puppeteer/i.test(name)) return 'web';
    return 'mcp';
  }
  switch (name) {
    case 'Edit': case 'Write': case 'MultiEdit': case 'NotebookEdit': return 'edit';
    case 'Bash': case 'PowerShell': case 'BashOutput': case 'KillShell': case 'KillBash': case 'Monitor': return 'bash';
    case 'Read': case 'NotebookRead': return 'read';
    case 'Grep': case 'Glob': case 'LS': case 'ToolSearch': case 'LSP': return 'search';
    case 'WebFetch': case 'WebSearch': return 'web';
    case 'Agent': case 'Task': case 'SendMessage': case 'Workflow': case 'TaskStop': case 'TaskOutput': return 'agent';
    case 'TodoWrite': case 'TaskCreate': case 'TaskUpdate': case 'TaskList': case 'TaskGet':
    case 'EnterPlanMode': case 'ExitPlanMode': case 'AskUserQuestion': return 'plan';
    case 'Skill': case 'SlashCommand': return 'skill';
    default: return 'other';
  }
}

// Tools that never take long on their own, so a long wait on one usually means a permission prompt.
const QUICK_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'WebFetch', 'Read', 'Glob', 'Grep']);
export function isQuickTool(name) { return QUICK_TOOLS.has(name) || /^mcp__/.test(name || ''); }
export function isQuestionTool(name) { return name === 'AskUserQuestion' || name === 'ExitPlanMode'; }

export function toolDetail(name, input) {
  if (!input || typeof input !== 'object') return '';
  try {
    if (input.file_path || input.notebook_path) return basename(input.file_path || input.notebook_path);
    switch (name) {
      case 'Bash': case 'PowerShell': return trunc(input.description || redactCmd(input.command), 70);
      case 'Grep': return trunc('/' + redactCmd(input.pattern) + '/', 60);
      case 'Glob': return trunc(redactCmd(input.pattern), 60);
      case 'WebFetch': try { return new URL(input.url).hostname; } catch { return trunc(redactCmd(input.url), 50); }
      case 'WebSearch': return trunc(redactCmd(input.query), 60);
      case 'Agent': case 'Task': return trunc(input.description || input.subagent_type, 60);
      case 'Skill': return trunc(input.skill || input.command, 40);
      case 'TodoWrite': return Array.isArray(input.todos) ? `${input.todos.length} todos` : '';
      case 'AskUserQuestion': return 'has a question for you';
      case 'ExitPlanMode': return 'plan ready for review';
      case 'Monitor': return trunc(input.description || redactCmd(input.command), 60);
    }
    if (/^mcp__/.test(name)) {
      const parts = name.split('__');
      return trunc(parts.slice(2).join(' ').replace(/_/g, ' ') || parts[1], 50);
    }
    if (input.description) return trunc(input.description, 60);
    if (input.url) return trunc(redactCmd(input.url), 60);
    if (input.path) return basename(input.path);
  } catch { /* fall through */ }
  return '';
}

// ---- models ----------------------------------------------------------------------------------

export function factionOf(model) {
  const m = String(model || '').toLowerCase();
  if (m.includes('opus')) return 'opus';
  if (m.includes('sonnet')) return 'sonnet';
  if (m.includes('haiku')) return 'haiku';
  if (m.includes('fable')) return 'fable';
  return 'merc';
}

export function modelLabel(model) {
  if (!model) return null;
  const m = String(model).replace(/\[1m\]/i, '').toLowerCase();
  const fam = factionOf(m);
  if (fam === 'merc') return model;
  const ver = (m.match(new RegExp(`${fam}-(\\d{1,2}(?:-\\d{1,2})?)(?!\\d)`)) || m.match(/claude-(\d(?:-\d)?)-/) || [])[1];
  const name = fam[0].toUpperCase() + fam.slice(1);
  return ver ? `${name} ${ver.replace('-', '.')}` : name;
}

export function contextMax(model, used, overrides = {}) {
  const m = String(model || '');
  for (const [pat, max] of Object.entries(overrides)) if (m.includes(pat)) return max;
  if (/\[1m\]/i.test(m)) return 1_000_000;
  if (/(opus|sonnet|fable)-([5-9]|\d\d)/i.test(m) || /fable/i.test(m)) return 1_000_000;
  if (used > 200_000) return 1_000_000;
  return 200_000;
}
