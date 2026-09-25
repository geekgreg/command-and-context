// Selection card (bottom-center): everything about the selected base, unit, vessel or island. Rendered as keyed
// sections that are only rewritten when their HTML changes, so it can refresh every second without flicker.
import {
  el, esc, trunc, fmtTokens, fmtDur, fmtAgo, fmtUsd, fmtPct, fmtInt, stateChip, ctxColor, clamp, ftext, fname, funit, fhq,
  roleName, roleOf, ROLE_PROPS, doingText, flavorText, mapAction, STATE_LONG, TERMINAL, entryName, permName, islandTitle, islandBlurb, vesselName,
  hullColor, wearOf, portText, shortPath, plural, TOOL_CAT_NAME,
} from './util.js';
import { ICON, BRANCH, factionCrest, islandCrest, vesselCrest } from './icons.js';

const STATE_DOT = {
  working: '#2fcf78', thinking: '#8f63ff', waiting: '#9aa4bb', needs_input: '#ffd23f', idle: '#ff9f5a', asleep: '#6b7bd6',
  ended: '#555a6a', stalled: '#e0a13a', done: '#3ddc84', failed: '#ff4d4d', lost: '#707689',
};
const dotFor = (st) => `<i class="sdot" style="--c:${STATE_DOT[st] || '#9aa4bb'}"></i>`;

const stat = (label, value, tip, cls = '') =>
  `<div class="stat ${cls}"${tip ? ` data-tip="${esc(tip)}"` : ''}><small>${esc(label)}</small><b>${value}</b></div>`;
const secH = (title, extra = '') => `<div class="sec-h"><span>${esc(title)}</span>${extra}</div>`;
const link = (sel, html, tip) => `<button type="button" class="lnk" data-sel="${esc(sel)}"${tip ? ` data-tip="${esc(tip)}"` : ''}>${html}</button>`;

function ctxMaxFor(model, used) {
  const m = String(model || '');
  return /\[1m\]/i.test(m) || /(opus|sonnet|fable)-([5-9]|\d\d)/i.test(m) || used > 200000 ? 1000000 : 200000;
}

function ctxBig(used, max, extra = '') {
  const p = max ? clamp(used / max, 0, 1) : 0;
  return `<div class="cbar${p > 0.8 ? ' hot' : ''}" style="--p:${(p * 100).toFixed(1)}%;--cc:${ctxColor(p)}"><i></i><em></em></div>` +
    `<div class="cnum"><span><b>${fmtTokens(used || 0)}</b> / ${fmtTokens(max || 0)}</span><span class="pct" style="--cc:${ctxColor(p)}">${Math.round(p * 100)}%</span>${extra}</div>`;
}

const OP_NAME = { merge: 'Merge', rebase: 'Rebase', 'cherry-pick': 'Cherry-pick', revert: 'Revert', bisect: 'Bisect' };
// A worktree's status in a few words, for its chip on the island card.
function workLine(s) {
  const n = (v) => Math.max(0, Math.round(Number(v) || 0));
  return [s.op ? `${OP_NAME[s.op] || s.op} in progress` : '', n(s.conflicts) ? plural(n(s.conflicts), 'conflict') : '',
    n(s.dirty) ? `${n(s.dirty)} uncommitted` : '', n(s.ahead) ? `↑${n(s.ahead)}` : '', n(s.behind) ? `↓${n(s.behind)}` : ''].filter(Boolean).join(' · ') || 'clean';
}

const LEVEL = (n) => (n >= 100 ? 3 : n >= 25 ? 2 : n >= 3 ? 1 : 0);
const ROMAN = ['', 'I', 'II', 'III'];

function arsenal(tools = {}, current) {
  const mods = [
    ['edit', tools.edit || 0], ['bash', tools.bash || 0], ['read', (tools.read || 0) + (tools.search || 0)],
    ['web', tools.web || 0], ['agent', tools.agent || 0], ['mcp', tools.mcp || 0],
  ];
  const chips = mods.filter(([, n]) => LEVEL(n) > 0).map(([cat, n]) => {
    const live = current === cat || (cat === 'read' && current === 'search');
    return `<span class="mod${live ? ' live' : ''}" data-tip="${esc(`${TOOL_CAT_NAME[cat]}: ${n} uses (levels at 3 / 25 / 100)`)}">${esc(TOOL_CAT_NAME[cat])} <b>${ROMAN[LEVEL(n)]}</b></span>`;
  });
  return chips.length ? chips.join('') : '<span class="muted">No add-ons yet — use more tools!</span>';
}

export class SelectionCard {
  constructor(hud) {
    this.hud = hud;
    this.target = null;
    this.parts = new Map();
    this.kind = '';
    this.root = el('div.card.panel', { hidden: true, role: 'dialog', 'aria-label': 'Selection' });
    this.root.addEventListener('click', (e) => {
      const x = e.target.closest('[data-act="close"]');
      if (x) { this.hud.engine.pick.select(null); this.close(); return; }
      const c = e.target.closest('[data-act="copy"]');
      if (c) { this.copy(c); return; }
      const s = e.target.closest('[data-sel]');
      if (s) this.hud.selectRef(s.getAttribute('data-sel'), { focus: true });
    });
  }

  // Copy a command line to the clipboard (it is only ever shown and copied, never run). Without clipboard access the
  // text is selected instead, for Ctrl+C. The button label changes in place: the section's HTML stays the same, so the
  // once-a-second re-render leaves the selection alone.
  copy(btn) {
    const text = btn.getAttribute('data-copy') || '';
    const code = btn.parentNode?.querySelector('code');
    const done = (ok) => {
      btn.textContent = ok ? 'Copied' : 'Press Ctrl+C';
      btn.classList.toggle('ok', ok);
      clearTimeout(btn.__t);
      btn.__t = setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('ok'); }, ok ? 1600 : 4000);
    };
    const fallback = () => {
      let ok = false;
      try {
        const r = document.createRange();
        r.selectNodeContents(code);
        const sel = getSelection();
        sel.removeAllRanges();
        sel.addRange(r);
        ok = document.execCommand('copy');
      } catch { /* leave it selected */ }
      done(ok);
    };
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(() => done(true), fallback);
    else fallback();
  }

  get open() { return !!this.target; }

  show(target) {
    const same = this.target && target && this.target.type === target.type && this.target.id === target.id && this.target.unit === target.unit;
    this.target = target;
    if (!same) { this.parts.clear(); this.kind = ''; }
    this.render();
    if (this.root.hidden || !same) {
      this.root.hidden = false;
      this.root.classList.remove('in');
      void this.root.offsetWidth;
      this.root.classList.add('in');
    }
  }

  close() {
    this.target = null;
    this.root.hidden = true;
    this.parts.clear();
    this.kind = '';
  }

  // sections: [[key, html, className]]; the layout (keys) only changes with the kind of card.
  patch(kind, head, left, right) {
    if (kind !== this.kind) {
      this.kind = kind;
      this.parts.clear();
      this.root.className = `card panel k-${kind}`;
      this.root.innerHTML = '<div class="card-head"></div><div class="card-body"><div class="col l"></div><div class="col r"></div></div>';
      this.headEl = this.root.querySelector('.card-head');
      this.lEl = this.root.querySelector('.col.l');
      this.rEl = this.root.querySelector('.col.r');
      this.root.classList.add('in');
    }
    const put = (host, key, html) => {
      let node = this.parts.get(key);
      if (!node || node.parentNode !== host) {
        node = el('div.sec', { 'data-k': key });
        host.appendChild(node);
        this.parts.set(key, node);
      }
      if (node.__html !== html) { node.__html = html; node.innerHTML = html; }
      node.hidden = !html;
    };
    if (this.headEl.__html !== head) { this.headEl.__html = head; this.headEl.innerHTML = head; }
    for (const [k, h] of left) put(this.lEl, k, h);
    for (const [k, h] of right) put(this.rEl, k, h);
    this.rEl.hidden = !right.some(([, h]) => h);
    // a soft fade at the bottom edge while there is more to scroll
    const body = this.root.querySelector('.card-body');
    if (body) {
      const more = body.scrollHeight - body.scrollTop - body.clientHeight > 4;
      body.classList.toggle('more', more);
      if (!body.__scrollHooked) { body.__scrollHooked = true; body.addEventListener('scroll', () => body.classList.toggle('more', body.scrollHeight - body.scrollTop - body.clientHeight > 4), { passive: true }); }
    }
  }

  render() {
    const t = this.target;
    if (!t) return;
    const idx = this.hud.idx;
    try {
      if (t.type === 'session') this.renderSession(idx.sessions.get(t.id), t);
      else if (t.type === 'agent') this.renderAgent(t);
      else if (t.type === 'port') {
        const live = idx.ports.get(t.id);
        this.renderPort(live || this.hud.portCache.get(t.id), !live);
      }
      else if (t.type === 'island') this.renderIsland(idx.islands.get(t.id));
      else this.renderUnknown(t);
    } catch (e) {
      console.error('[hud] card render failed', e);
    }
  }

  head(crest, title, sub, chip, extra = '') {
    return `<div class="crest-wrap">${crest}</div><div class="ttl"><div class="nm" title="${esc(title)}">${esc(trunc(title, 60))}</div>` +
      `<div class="sub">${sub}</div></div><div class="hchip">${chip}</div>${extra}` +
      `<button type="button" class="x" data-act="close" data-tip="Deselect (Esc)" aria-label="Close">${ICON.close}</button>`;
  }

  renderUnknown(t) {
    this.patch('unknown', this.head(ICON.help, `${t.type} ${t.id}`, 'Something mysterious', ''), [['m', '<p class="muted">No intel on this one yet.</p>']], []);
  }

  // ---- session -------------------------------------------------------------------------------------------------

  renderSession(s, t) {
    if (!s) { this.renderGone('Base', 'This base has been decommissioned.'); return; }
    const now = this.hud.now();
    const f = s.faction || 'merc';
    const commander = !!t.unit;
    const sub = `<span class="fac" style="--c:${ftext(f)}">${esc(fname(f))}</span> · ${esc(s.modelLabel || s.model || '?')} · ${esc(commander ? funit(f) + ' Commander' : fhq(f))}`;
    const since = s.stateSince ? `<small class="since">for ${fmtDur(now - s.stateSince)}</small>` : '';
    const head = this.head(factionCrest(f), s.name || 'Unnamed session', sub, stateChip(s.state || 'idle', STATE_LONG[s.state]) + since,
      commander ? '<span class="ribbon">Commander</span>' : '');

    const tool = s.tool;
    const busy = tool && ['working', 'waiting', 'needs_input'].includes(s.state);
    const doingHtml = `<div class="doing ds-${esc(s.state)}">${dotFor(s.state)}<span>${esc(trunc(flavorText(s, f, now), 90))}</span>` +
      (busy && tool.since ? `<small>${fmtDur(now - tool.since)}</small>` : '') + '</div>';

    const ctx = s.context || {};
    const lc = s.lastCompaction;
    const bricks = s.compactions ? `<span class="bricks" data-tip="${esc(`${plural(s.compactions, 'summary brick')}${lc ? ` · last: ${fmtTokens(lc.pre)} → ${fmtTokens(lc.post)}, ${fmtDur(now - lc.at)} ago` : ''}`)}">${'<i></i>'.repeat(Math.min(6, s.compactions))}${s.compactions > 6 ? `<b>×${s.compactions}</b>` : ''}</span>` : '';
    const ctxHtml = secH('Context silo', bricks) + ctxBig(ctx.used || 0, ctx.max || 0);

    const cost = s.cost && Number.isFinite(s.cost.usd) ? stat('Cost', fmtUsd(s.cost.usd), `+${fmtInt(s.cost.added)} / −${fmtInt(s.cost.removed)} lines`) : '';
    const toolsTip = Object.entries(s.tools || {}).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(' · ');
    const stats = `<div class="stats">` +
      stat('Uptime', fmtDur(now - (s.startedAt || now))) +
      stat('Compactions', String(s.compactions || 0), lc ? `last ${fmtTokens(lc.pre)} → ${fmtTokens(lc.post)} (${lc.trigger || 'auto'})` : 'The hydraulic press is bored') +
      stat('Clears', String(s.clears || 0), 'Controlled demolitions (/clear)') +
      stat('Tool calls', fmtInt(s.toolTotal || 0), toolsTip) +
      stat('Branch', s.branch ? `${BRANCH}${esc(trunc(s.branch, 30))}` : '<span class="muted">no git</span>', s.branch || 'Not a git repo', 'w2') +
      stat('Veterancy', `${'★'.repeat(Math.min(5, s.agentsDone || 0)) || '<span class="muted">—</span>'}${(s.agentsDone || 0) > 5 ? ` <small>×${s.agentsDone}</small>` : ''}`, `${plural(s.agentsDone || 0, 'sub-agent')} finished`) +
      (cost || stat('Last active', fmtAgo(now - (s.lastActivity || now)) + ' ago')) + '</div>';
    const mods = `<div class="mods">${arsenal(s.tools, tool?.cat)}</div>`;
    const prompt = s.lastPrompt ? `<blockquote class="prompt" data-tip="${esc(trunc(s.lastPrompt, 400))}">${esc(trunc(s.lastPrompt, 220))}</blockquote>` : '';

    // right column: squad, generators, docks
    const sorted = [...(s.agents || [])].sort((a, b) => (TERMINAL.has(a.state) - TERMINAL.has(b.state)) || (b.startedAt || 0) - (a.startedAt || 0));
    // apprentices go right under their mentor
    const ids = new Set(sorted.map((a) => a.id)), kidsOf = new Map();
    for (const a of sorted) if (a.parent && ids.has(a.parent)) kidsOf.set(a.parent, [...(kidsOf.get(a.parent) || []), a]);
    const agents = [], placed = new Set();
    const add = (a) => { if (placed.has(a.id)) return; placed.add(a.id); agents.push(a); for (const k of kidsOf.get(a.id) || []) add(k); };
    for (const a of sorted) if (!a.parent || !ids.has(a.parent)) add(a);
    for (const a of sorted) add(a);   // anything left over (odd parent chains)
    const active = agents.filter((a) => !TERMINAL.has(a.state)).length;
    const squad = agents.length
      ? secH('Squad', `<em>${active} active · ${agents.length} listed</em>`) + `<ul class="list agents">${agents.slice(0, 14).map((a) => this.agentRow(a, now)).join('')}</ul>` +
        (agents.length > 14 ? `<div class="muted more">+${agents.length - 14} more</div>` : '')
      : secH('Squad') + `<div class="muted">No sub-agents deployed.${s.agentsDone ? ` ${plural(s.agentsDone, 'veteran')} retired.` : ''}</div>`;
    const procs = (s.procs || []).length
      ? secH('Generators', `<em>${plural(s.procs.length, 'process', 'processes')}</em>`) + `<ul class="list procs">${s.procs.slice(0, 8).map((p) => {
        const cpu = Number(p.cpu) || 0;
        return `<li data-tip="${esc(`${p.cmd || p.name} · pid ${p.pid} · up ${fmtDur(now - (p.since || now))}`)}"><b>${esc(p.name || 'proc')}</b>` +
          `<span class="meter" style="--p:${clamp(cpu / 4, 0, 1) * 100}%"><i></i></span><small>${cpu.toFixed(cpu < 1 ? 2 : 1)} cores</small>` +
          `<code>${esc(trunc(p.cmd || '', 60))}</code></li>`;
      }).join('')}</ul>`
      : '';
    const ports = (s.ports || []).map((id) => this.hud.idx.ports.get(id)).filter(Boolean);
    const docks = ports.length
      ? secH('Docks') + `<div class="chips">${ports.map((p) => link('port:' + p.id, `<b>${esc(portText(p))}</b> ${esc(trunc(p.label || p.proc || '', 18))}`, `${vesselName(p.kind)} · ${fmtPct(p.activity || 0)} busy`)).join('')}</div>`
      : '';
    const isl = this.hud.idx.islands.get(s.island);
    const where = (isl ? `<div class="where">${link('island:' + isl.id, `${esc(isl.name)}`, `${islandTitle(isl)}: ${isl.root || ''}`)}<code title="${esc(s.cwd || '')}">${esc(shortPath(s.cwd, 46))}</code></div>` : '') +
      `<div class="meta"><span data-tip="${esc(s.entrypoint || '')}">${esc(entryName(s.entrypoint))}</span><span data-tip="Permission mode: ${esc(s.permissionMode || 'default')}">${esc(permName(s.permissionMode))}</span>` +
      (s.pid ? `<span>pid ${esc(s.pid)}</span>` : '') + `</div>`;

    // pull requests this base touched since the page loaded; links as text only (no clock in here, so a selection of a
    // link survives the once-a-second refresh)
    const prs = this.hud.prs?.get(s.key) || [];
    const prList = prs.length ? secH('Pull requests') + `<ul class="list prs">${prs.map((p) => `<li><b>#${esc(p.number)}</b>` +
      `<small>${esc(p.action || 'linked')}${p.repo ? ' · ' + esc(trunc(p.repo, 34)) : ''}</small>` +
      (p.url ? `<code title="${esc(p.url)}">${esc(p.url)}</code>` : '') + '</li>').join('')}</ul>` : '';
    this.patch('session', head,
      [['doing', doingHtml], ['ctx', ctxHtml], ['stats', stats], ['mods', mods], ['prompt', prompt]],
      [['squad', squad], ['procs', procs], ['docks', docks], ['prs', prList], ['where', where]]);
  }

  agentRow(a, now) {
    const role = roleName(a.type);
    const done = TERMINAL.has(a.state);
    const exists = !!this.hud.world.unitOf(a.id);
    const what = done ? STATE_LONG[a.state] : doingText(a);
    return `<li class="${done ? 'fin' : ''}${a.depth > 1 ? ' appr' : ''}"><button type="button" class="row" data-sel="agent:${esc(a.id)}"` +
      ` data-tip="${esc(`${funit(a.faction)} ${role} · ${a.type || 'agent'} · ${a.modelLabel || ''}${exists ? '' : ' (back at base)'}`)}">` +
      `${dotFor(a.state)}<span class="rn" style="--c:${ftext(a.faction)}">${a.depth > 1 ? '↳ ' : ''}${esc(role)}</span>` +
      `<span class="rd">${esc(trunc(a.description || a.type || '', 42))}</span>` +
      `<small class="rw">${esc(trunc(what || '', 34))}</small>` +
      `<small class="rt">${fmtDur((a.endedAt || now) - (a.startedAt || now))}</small></button></li>`;
  }

  // ---- agent ---------------------------------------------------------------------------------------------------

  renderAgent(t) {
    const hit = this.hud.idx.agents.get(t.id);
    const a = hit?.agent || this.hud.agentCache.get(t.id);
    const s = hit?.session || this.hud.idx.sessions.get(t.session || a?.sessionKey);
    if (!a) { this.renderGone('Unit', 'This unit has returned to base.'); return; }
    const now = this.hud.now();
    // No longer in any snapshot: show the last known state as finished / gone, with every timer stopped then.
    const gone = !hit;
    const end = gone ? Math.min(now, a.endedAt || a.lastSeen || now) : now;
    const fin = TERMINAL.has(a.state);
    const f = a.faction || s?.faction || 'merc';
    const role = roleOf(a.type);
    const title = roleName(a.type);
    const sub = `<span class="fac" style="--c:${ftext(f)}">${esc(funit(f))}</span> · ${esc(fname(f))} · ${esc(a.modelLabel || a.model || '?')}` +
      (gone ? ` · back at base ${esc(fmtAgo(now - end))} ago` : '');
    const since = a.stateSince && !gone ? `<small class="since">for ${fmtDur(now - a.stateSince)}</small>` : '';
    const chip = gone && !fin ? '<b class="st st-ended">Gone</b>' : stateChip(a.state || 'working', STATE_LONG[a.state]);
    const head = this.head(factionCrest(f), title, sub, chip + since, a.depth > 1 ? '<span class="ribbon">Apprentice</span>' : '');

    const desc = `<div class="brief"><small>Orders</small><p>${esc(a.description || a.type || 'Classified')}</p></div>`;
    const doingLine = gone && !fin ? 'Out of radio range. Last seen back at base.' : flavorText(a, f, end);
    const doing = `<div class="doing ds-${esc(gone && !fin ? 'ended' : a.state)}">${dotFor(gone && !fin ? 'ended' : a.state)}<span>${esc(trunc(doingLine, 90))}</span>` +
      (a.tool?.since && !fin && !gone ? `<small>${fmtDur(now - a.tool.since)}</small>` : '') + '</div>';
    const used = Number(a.context) || 0;
    const ctx = secH('Context') + ctxBig(used, ctxMaxFor(a.model, used));
    const stats = `<div class="stats">` +
      stat('Runtime', fmtDur((a.endedAt || end) - (a.startedAt || end))) +
      stat('Tool calls', fmtInt(a.tools || 0)) +
      stat('Mode', a.background ? 'Background' : 'Foreground', a.background ? 'Runs alongside the main agent' : 'The main agent waits for it') +
      stat('Rank', a.depth > 1 ? 'Apprentice' : 'Field unit', a.depth > 1 ? 'Spawned by another agent' : 'Spawned by the commander') +
      stat('Type', esc(trunc(a.type || 'agent', 34)), a.type || '', 'w2') +
      stat('Kit', esc(ROLE_PROPS[role] || 'wrench'), 'What this role carries on the map', 'w2') +
      '</div>';
    const parent = a.parent ? this.hud.idx.agents.get(a.parent)?.agent || this.hud.agentCache.get(a.parent) : null;
    const kids = (s?.agents || []).filter((x) => x.parent === a.id);
    const chain = secH('Chain of command') + `<div class="chips">` +
      (s ? link('session:' + s.key, `${dotFor(s.state)}<b>${esc(trunc(s.name, 30))}</b>`, 'The base this unit reports to') : '') +
      (parent ? link('agent:' + parent.id, `↑ ${esc(roleName(parent.type))}: ${esc(trunc(parent.description || '', 24))}`, 'Mentor') : '') +
      kids.map((k) => link('agent:' + k.id, `↳ ${esc(roleName(k.type))}: ${esc(trunc(k.description || '', 24))}`, 'Apprentice')).join('') + '</div>';
    const act = gone ? 'Off the map: back at base' : mapAction(a);
    const tool = a.tool && !fin && !gone
      ? `<div class="chips"><span class="chip-s"><b>${esc(a.tool.name || '?')}</b></span><span class="chip-s">${esc(TOOL_CAT_NAME[a.tool.cat] || a.tool.cat || 'tool')} work</span></div>` : '';
    const onMap = act ? secH('On the map') + `<p class="onmap">${esc(act)}.</p>${tool}` : '';
    this.patch('agent', head, [['desc', desc], ['doing', doing], ['ctx', ctx], ['stats', stats]], [['chain', chain], ['onmap', onMap]]);
  }

  // ---- port ------------------------------------------------------------------------------------------------------

  // gone: the vessel left the harbor (p is its last known record): shown as departed, every timer stopped then.
  renderPort(p, gone = false) {
    if (!p) { this.renderGone('Vessel', 'This vessel has sailed away.'); return; }
    const now = this.hud.now();
    const end = gone ? Math.min(now, p.lastSeen || now) : now;
    const lh = p.kind === 'lighthouse';
    const title = lh ? `${p.label || 'Command & Context'} :${p.port}` : `${p.label || p.proc || 'Vessel'} ${portText(p)}`;
    const sub = (lh ? esc('The lighthouse at Port Localhost · this dashboard')
      : `${esc(vesselName(p.kind))} · ${esc(p.kind || 'app')} · ${esc(p.proc || '')}${p.pid ? ' · pid ' + p.pid : ''}`) +
      (gone ? ` · sailed ${esc(fmtAgo(now - end))} ago` : '');
    const act = gone ? 0 : clamp(p.activity || 0, 0, 1);
    const drift = !gone && !lh ? p.adrift : null;
    const chip = gone ? '<b class="st st-ended">Sailed away</b>' : lh ? '<b class="st st-port">Beacon</b>' : drift ? '<b class="st st-adrift">Adrift</b>'
      : act > 0.15 ? '<b class="st st-working">Busy</b>' : act > 0.02 ? '<b class="st st-thinking">Ticking</b>' : '<b class="st st-idle">Idle</b>';
    const head = this.head(vesselCrest(p.kind, hullColor(p.kind)), title, sub, chip);
    const idle = end - (p.lastActive || end);
    const wear = wearOf(idle);
    const meter = secH('Activity', `<em>${gone ? 'departed' : Math.round(act * 100) + '%'}</em>`) +
      `<div class="act" style="--p:${(act * 100).toFixed(0)}%"><i></i></div>`;
    const stats = `<div class="stats c3">` +
      stat(lh ? 'Viewers' : 'Connections', gone ? '–' : fmtInt(p.conns || 0), lh ? 'Browsers watching this dashboard (the beam brightens)' : 'Established client connections') +
      stat('Idle for', !gone && idle < 5000 ? 'active now' : fmtDur(idle), gone ? 'Idle time when it sailed' : '') +
      stat('Afloat', fmtDur(end - (p.since || end)), gone ? 'How long it was docked, until it sailed' : 'Time since the port opened') +
      stat('Restarts', String(p.restarts || 0), 'Refuel puffs') +
      stat('CPU', gone ? '–' : `${(Number(p.cpu) || 0).toFixed(2)} cores`) +
      (lh ? '' : stat('Hull', esc(wear.text), 'Paint wears with time since last activity')) +
      '</div>';
    const cmd = (p.cmd ? `<div class="kv"><small>Command</small><code class="block" title="${esc(p.cmd)}">${esc(trunc(p.cmd, 160))}</code></div>` : '') +
      (p.cwd ? `<div class="kv"><small>Directory</small><code class="block" title="${esc(p.cwd)}">${esc(shortPath(p.cwd, 70))}</code></div>` : '');
    const owner = p.owner ? this.hud.idx.sessions.get(p.owner) : null;
    const isl = p.island ? this.hud.idx.islands.get(p.island) : null;
    const who = secH('Harbor papers') + `<div class="chips">` +
      (owner ? link('session:' + owner.key, `${dotFor(owner.state)}<b>${esc(trunc(owner.name, 30))}</b>`, 'Owning session (process tree)') : `<span class="muted">${lh ? 'Owned by you, Commander.' : 'No owner: a free agent.'}</span>`) +
      (isl ? link('island:' + isl.id, `⚓ ${esc(isl.name)}`, 'Docked at this island') : `<span class="chip-s">⚓ ${p.repo ? esc(p.repo) + ' · ' : ''}Port Localhost</span>`) +
      `</div>` + (p.addrs?.length ? `<div class="muted addrs">listening on ${esc(p.addrs.join(', '))}</div>` : '');
    const c = p.container;
    const ctr = c ? secH('Cargo manifest') + `<div class="stats one">` +
      stat('Container', esc(trunc(c.name || '', 34)), c.name) + stat('Image', esc(trunc(c.image || '', 34)), c.image) +
      stat('Project', esc(c.project || '—')) + stat('Status', esc(c.status || '—')) + '</div>' : '';
    const [adrift, stop] = drift ? this.adriftParts(p, drift, now) : ['', ''];
    this.patch('port', head, [['adrift', adrift], ['stop', stop], ['meter', meter], ['stats', stats], ['cmd', cmd]], [['who', who], ['ctr', ctr]]);
  }

  // Adrift (nobody is tending the server): why, for how long, the pid, and a copyable stop command. The command is
  // only shown and copied; nothing in the dashboard runs it. `stop` stays byte-identical between renders (no clock in
  // it), so a text selection in it survives the once-a-second refresh.
  adriftParts(p, a, now) {
    const since = Number(a.since) || now;
    const o = a.lastOwner, s = o?.key ? this.hud.idx.sessions.get(o.key) : null;
    let why;
    if (a.reason === 'orphaned') {
      // A guess: a session that has since ended was at work in its folder when it was started.
      const who = !o?.name ? '' : s ? link('session:' + s.key, `<b>${esc(trunc(o.name, 40))}</b>`, 'The session that probably started it')
        : `<b>${esc(trunc(o.name, 40))}</b>`;
      why = who ? `Probably left behind by ${who}, which has ended. Its launcher is gone.` : 'Its launcher is gone and no session claims it.';
    } else {
      const who = !o?.name ? '' : s ? link('session:' + s.key, `<b>${esc(trunc(o.name, 40))}</b>`, 'The session that started it')
        : `<b>${esc(trunc(o.name, 40))}</b>`;
      why = `Its session ended ${esc(fmtAgo(now - since))} ago${who ? `: ${o.guess ? 'probably ' : ''}${who}` : '.'}`;
    }
    const head = secH('Adrift', `<em>for ${esc(fmtDur(now - since))}</em>`) + `<p class="adrift-why">${why}</p>` +
      `<div class="meta">${p.pid ? `<span>pid ${esc(p.pid)}</span>` : ''}${p.proc ? `<span>${esc(p.proc)}</span>` : ''}` +
      `<span>${a.reason === 'orphaned' ? 'orphaned' : 'owner ended'}</span></div>`;
    const pid = Number(p.pid);
    if (!Number.isInteger(pid) || pid <= 0) return [head, ''];
    const win = (this.hud.snap?.server?.platform || 'win32') === 'win32';
    const cmd = win ? `Stop-Process -Id ${pid}` : `kill ${pid}`;
    const stop = `<div class="kv"><small>To stop it (shown here, never run)</small><div class="copyline">` +
      `<code class="block cmdline">${esc(cmd)}</code><button type="button" class="copy" data-act="copy" data-copy="${esc(cmd)}"` +
      ` data-tip="Copy to the clipboard, then run it yourself in ${win ? 'PowerShell' : 'a terminal'}">Copy</button></div></div>`;
    return [head, stop];
  }

  // ---- island ------------------------------------------------------------------------------------------------------

  renderIsland(d) {
    if (!d) { this.renderGone('Island', 'This island has sunk beneath the waves.'); return; }
    const g = d.git || null;
    const sub = `${esc(islandTitle(d))}${d.kind === 'repo' ? ` · tier ${d.tier}` : ''}${g?.langs?.length ? ' · ' + esc(g.langs.slice(0, 3).join(', ')) : ''}`;
    const branch = g?.branch ? `<b class="st st-port br">${BRANCH}${esc(trunc(g.branch, 26))}</b>` : '';
    const head = this.head(islandCrest(d), d.name || 'Island', sub, branch);
    const blurb = `<p class="blurb">${esc(islandBlurb(d))}</p>`;
    const stats = g && g.files != null ? `<div class="stats">` +
      stat('Files', fmtInt(g.files)) + stat('Commits', fmtInt(g.commits)) + stat('Branches', fmtInt(g.branches), 'Big branches on the Git Tree') +
      stat('Bases', fmtInt(d.sessions || 0)) + '</div>' : `<div class="stats">${stat('Bases', fmtInt(d.sessions || 0))}${stat('Version control', d.kind === 'repo' ? 'git' : '<span class="muted">none</span>')}</div>`;
    const work = g?.status ? this.workTree(g.status) : '';
    const langs = g?.langs?.length ? `<div class="chips">${g.langs.map((l) => `<span class="chip-s">${esc(l)}</span>`).join('')}</div>` : '';
    const root = d.root ? `<div class="kv"><small>Root</small><code class="block" title="${esc(d.root)}">${esc(shortPath(d.root, 70))}</code></div>` : '';
    const sessions = [...this.hud.idx.sessions.values()].filter((s) => s.island === d.id && s.state !== 'ended');
    const bases = secH('Bases', `<em>${sessions.length}</em>`) + (sessions.length
      ? `<ul class="list bases">${sessions.map((s) => `<li><button type="button" class="row" data-sel="session:${esc(s.key)}">${dotFor(s.state)}` +
        `<span class="rn" style="--c:${ftext(s.faction)}">${esc(trunc(s.name, 34))}</span><small class="rw">${esc(STATE_LONG[s.state] || s.state)}${s.annex ? ' · worktree' : ''}</small></button></li>`).join('')}</ul>`
      : '<div class="muted">Nobody home.</div>');
    const annex = d.annexes?.length ? secH('Worktrees') + `<div class="chips">${d.annexes.map((a) => {
      const w = a.status ? workLine(a.status) : '', hot = a.status?.conflicts > 0 ? ' hot' : '';
      return `<div class="wt"><span class="chip-s${hot}">${BRANCH}${esc(a.name)}${a.branch ? ' · ' + esc(trunc(a.branch, 26)) : ''}</span>` +
        (w ? `<small class="wt-st${hot}" data-tip="${esc(`Its own work tree: ${w}`)}">${esc(w)}</small>` : '') + '</div>';
    }).join('')}</div>` : '';
    const ports = [...this.hud.idx.ports.values()].filter((p) => p.island === d.id);
    const docks = ports.length ? secH('Docked vessels') + `<div class="chips">${ports.map((p) => link('port:' + p.id, `<b>${esc(portText(p))}</b> ${esc(trunc(p.label || '', 16))}`)).join('')}</div>` : '';
    this.patch('island', head, [['blurb', blurb], ['stats', stats], ['work', work], ['langs', langs], ['root', root]], [['bases', bases], ['annex', annex], ['docks', docks]]);
  }

  // The work tree's git status (polled by the server about every 15 s), as the island shows it: laundry, crates, the
  // buried stash, the plaster cast (an operation stopped half-way) and the fire (conflicts).
  workTree(s) {
    const n = (v) => Math.max(0, Math.round(Number(v) || 0));
    const dirty = n(s.dirty), conf = n(s.conflicts);
    const op = s.op ? `<b class="st st-adrift" data-tip="${esc(`git ${s.op} stopped half-way: the Git Tree wears a plaster cast`)}">${esc(OP_NAME[s.op] || s.op)} in progress</b>` : '';
    const when = s.at ? `<em data-tip="The server checks about every 15 s">checked ${esc(fmtAgo(Math.max(0, this.hud.now() - s.at)))} ago</em>` : '';
    const up = s.ahead != null;
    return secH('Work tree', op + when) + '<div class="stats c3">' +
      stat('Uncommitted', dirty ? fmtInt(dirty) : '<span class="muted">clean</span>', 'Changed files, staged or not, plus untracked ones: laundry on the line') +
      stat('Staged', fmtInt(n(s.staged)), 'Files with changes in the index') +
      stat('Untracked', s.untracked == null ? '<span class="muted">not counted</span>' : fmtInt(n(s.untracked)), s.untracked == null ? 'Too slow to scan in this repo' : 'New files git does not track yet') +
      stat('Ahead / behind', up ? `↑${fmtInt(n(s.ahead))} <small>↓${fmtInt(n(s.behind))}</small>` : '<span class="muted">no upstream</span>',
        up ? 'Commits not pushed yet (crates by the launch pad) / commits to pull' : 'This branch has no upstream yet') +
      stat('Stashes', fmtInt(n(s.stash)), 'git stash entries: the buried treasure chest') +
      stat('Conflicts', fmtInt(conf), conf ? 'Conflicted files: the Git Tree is on fire' : 'No conflicted files', conf ? 'hot' : '') +
      '</div>';
  }

  renderGone(what, text) {
    this.patch('gone', this.head(ICON.help, what, 'Signal lost', ''), [['m', `<p class="muted">${esc(text)}</p>`]], []);
  }
}
