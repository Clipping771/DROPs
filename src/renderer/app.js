/* DROPs renderer — core state, chat rendering and live agent events. */
'use strict';
const api = window.drops;
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const h = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtTok = (n) => (n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n || 0));
const fmtCost = (c) => '$' + (c || 0).toFixed(c && c < 1 ? 3 : 2);
const baseName = (p) => (p || '').split(/[\\/]/).filter(Boolean).pop() || p;
const timeAgo = (t) => { const s = (Date.now() - t) / 1000; return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`; };

const S = { info: null, settings: null, theme: 'dark', project: null, sessions: [], current: null, views: new Map(), git: null, attachments: [] };
const INTERRUPTED = '[Request interrupted by user]';
const STOPPED_BY_ERROR = '[DROPs] Stopped by an error:';
const DROPS_NOTES = { plan: 'DROPs gave the agent the requirement checklist', 'evidence check': 'Evidence check: some requirements still need proof', 'completion guard': 'Completion guard: the task list still has open items', 'completion audit': 'Completion audit: a reviewer found missing work' };
const SUMMARY_PREFIX = '[Context summary of the earlier conversation';
const CONTEXT_MAX = 1_000_000; // fallback when a model's own window is unknown
/** The context window of the chosen model (each model has its own; 'auto' and unknown models fall back). */
function contextMax() { const id = $('#modelSel')?.value; return S.info?.models.find((x) => x.id === id)?.context || CONTEXT_MAX; }

// ---------- markdown ----------
marked.use({ gfm: true, breaks: false });
function renderMd(el, text, final) {
  el.innerHTML = DOMPurify.sanitize(marked.parse(text || ''));
  el.querySelectorAll('a').forEach((a) => a.setAttribute('target', '_blank'));
  if (!final) return;
  el.querySelectorAll('pre > code').forEach((c) => {
    const lang = (c.className.match(/language-(\S+)/) || [])[1] || '';
    try { if (lang && hljs.getLanguage(lang)) hljs.highlightElement(c); else hljs.highlightElement(c); } catch { /* ignore */ }
    const head = h('div', 'code-head');
    head.append(h('span', '', lang || 'code'));
    const b = h('button', 'btn ghost sm'); b.innerHTML = icon('copy', 'xs') + 'Copy';
    b.onclick = () => { navigator.clipboard.writeText(c.textContent); b.innerHTML = icon('check', 'xs') + 'Copied'; setTimeout(() => (b.innerHTML = icon('copy', 'xs') + 'Copy'), 1200); };
    head.append(b);
    c.parentElement.prepend(head);
  });
  // file:line references open in the editor
  el.querySelectorAll('code').forEach((c) => {
    if (c.closest('pre')) return;
    const m = c.textContent.match(/^([\w./\\-]+\.[\w]+)(?::(\d+))?/);
    if (m && S.project) { c.style.cursor = 'pointer'; c.title = 'Open in editor'; c.onclick = () => Editor.openFile(m[1], Number(m[2]) || 0); }
  });
}

// ---------- tools metadata ----------
const TOOL_INFO = {
  read_file: ['Read', 'fileCode'], browser: ['Browser', 'globe'], write_file: ['Write', 'filePlus'], edit_file: ['Edit', 'pencil'], multi_edit: ['Edit', 'pencil'],
  list_dir: ['List', 'folder'], glob: ['Find', 'search'], grep: ['Search', 'textSearch'], powershell: ['Run', 'terminal'], shell: ['Run', 'terminal'],
  todo_write: ['Plan', 'list'], check_requirement: ['Verify', 'shield'], web_search: ['Web search', 'globe'], web_fetch: ['Fetch', 'globe'], fetch_url: ['Fetch', 'globe'],
  start_process: ['Start process', 'play'], process_output: ['Process output', 'terminal'], stop_process: ['Stop process', 'square'],
  task: ['Sub-agent', 'bot'], impact: ['Impact', 'branch'], find_breaking_change: ['Find the breaking change', 'search'], audit: ['Audit', 'shield'], remember: ['Remember', 'bookmark'], ask_user: ['Question', 'info'],
};
const isShellTool = (n) => n === 'shell' || n === 'powershell';
const toolInfo = (name) => TOOL_INFO[name] || (name.startsWith('mcp__') ? ['MCP', 'plug'] : [name, 'file']);
function summarize(name, input = {}) {
  if (isShellTool(name)) return input.description || input.command;
  if (name.startsWith('mcp__')) return name.split('__').slice(1).join(' · ');
  if (name === 'grep') return `/${input.pattern}/${input.glob ? ' in ' + input.glob : ''}`;
  if (name === 'glob') return input.pattern;
  if (name === 'web_search') return input.query;
  if (name === 'ask_user') return input.question;
  if (name === 'web_fetch' || name === 'fetch_url') return input.url;
  if (name === 'start_process') return input.name || input.command;
  if (name === 'process_output' || name === 'stop_process') return input.id;
  if (name === 'task') return input.description;
  if (name === 'remember') return input.note;
  return input.path || '';
}

// ---------- views ----------
function makeView(data) {
  const el = h('div', 'thread');
  el.hidden = true;
  $('#threads').appendChild(el);
  const v = { id: data.id, data, el, busy: !!data.busy, blocks: new Map(), tools: new Map(), waiting: new Set(), working: null, lastWeb: null, turnStartCost: 0, procs: new Map() };
  for (const p of data.procs || []) v.procs.set(p.id, { ...p, out: '' });
  S.views.set(data.id, v);
  renderHistory(v);
  if (v.busy) setWorking(v, true);
  return v;
}
const currentView = () => S.views.get(S.current);

function place(v, el) {
  if (v.working && v.working.parentElement === v.el) v.el.insertBefore(el, v.working);
  else v.el.appendChild(el);
  autoScroll(v);
  return el;
}
function autoScroll(v, force) {
  if (S.current !== v.id) return;
  const w = $('#threadWrap');
  if (force || w.scrollHeight - w.scrollTop - w.clientHeight < 180) w.scrollTop = w.scrollHeight;
}
const countWords = (s) => { const t = (s || '').trim(); return t ? (t.match(/\S+/g) || []).length : 0; };
// A single falling water drop that lands in a small ripple.
function waterOrbSVG(size = 22) {
  return `<span class="water-drop" style="width:${size}px;height:${size}px" aria-hidden="true"><svg viewBox="0 0 24 24"><ellipse class="drop-ripple" cx="12" cy="20.5" rx="6" ry="1.6"/><path class="drop-body" d="M12 3.5C12 3.5 7.5 9.4 7.5 12.6a4.5 4.5 0 0 0 9 0C16.5 9.4 12 3.5 12 3.5Z"/></svg></span>`;
}
function setWorking(v, on, label = 'Working') {
  if (on) {
    // The drop, plus one quiet line: what it is doing · how long · tokens written this turn.
    if (!v.working) {
      v.working = h('div', 'working');
      v.working.setAttribute('role', 'status');
      v.working.innerHTML = waterOrbSVG(22) + '<span class="wl-label"></span><span class="wl-meta"></span>';
    }
    if (!v.started) v.started = Date.now();
    v.workLabel = label;
    v.working.title = label + '…';
    v.working.setAttribute('aria-label', label + '…');
    tickWorking(v);
    if (!v.workTimer) v.workTimer = setInterval(() => tickWorking(v), 1000);
    v.el.appendChild(v.working);
    autoScroll(v);
  } else {
    clearInterval(v.workTimer); v.workTimer = null;
    if (v.working) v.working.remove();
  }
}
function fmtElapsed(ms) { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`; }
function tickWorking(v) {
  if (!v.working) return;
  const out = Math.max(0, (v.data.usage?.output || 0) - (v.turnStartOut || 0));
  v.working.querySelector('.wl-label').textContent = (v.workLabel || 'Working') + '…';
  v.working.querySelector('.wl-meta').textContent = `${fmtElapsed(Date.now() - (v.started || Date.now()))}${out ? ` · ${fmtTok(out)} tokens` : ''}`;
}

function renderHistory(v) {
  v.el.innerHTML = '';
  v.tools.clear();
  const d = v.data;
  const turnAt = new Map(d.turns.map((t, i) => [t.msgIndex, i]));
  const renderMsgs = (msgs, live) => {
    let group = null;
    msgs.forEach((m, mi) => {
      if (m._summaryAck) return;
      if (m.role === 'user') {
        const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content;
        const texts = blocks.filter((b) => b.type === 'text');
        const imgs = blocks.filter((b) => b.type === 'image' && !b._toolImage);
        const shots = blocks.filter((b) => b.type === 'image' && b._toolImage);
        if (shots.length && v.lastCard) v.lastCard.setImages(shots);
        if (m._summary) { place(v, compactCard(texts[0]?.text || '')); group = null; return; }
        for (const t of texts) {
          if (t.text.startsWith('[DROPs verification guard]')) { place(v, noticeEl('shield', 'Verification guard asked the agent to check its work')); continue; }
          if (t.text.startsWith('[DROPs report]') || t.text.startsWith('[DROPs] The turn stopped early.')) continue;
          // Other notes DROPs added for the agent are not the user's words: show them as a quiet line.
          const note = /^\[DROPs (plan|evidence check|completion guard|completion audit)\]/.exec(t.text);
          if (note) { place(v, noticeEl('shield', DROPS_NOTES[note[1]])); continue; }
          const steer = t.text.startsWith('[User steering] ');
          if (!steer && v.histWrapUp) { place(v, wrapUpCard(v, v.histWrapUp, false)); v.histWrapUp = null; }
          appendUser(v, steer ? t.text.slice(16) : t.text, live && !steer ? turnAt.get(mi) : null, imgs, steer ? 'Steered mid-run' : null);
          group = null;
        }
        return;
      }
      if (!group) group = place(v, h('div', 'assistant'));
      for (const b of m.content || []) {
        if (b.type === 'text') {
          if (b.text === INTERRUPTED) { place(v, noticeEl('info', 'Stopped by you')); continue; }
          if (b.text.startsWith('[DROPs] The previous turn ended without an answer')) { place(v, noticeEl('info', 'The previous turn ended without an answer')); continue; }
          if (b.text.startsWith(STOPPED_BY_ERROR)) { place(v, noticeEl('alert', 'Stopped by an error: ' + b.text.slice(STOPPED_BY_ERROR.length).trim())); continue; }
          const md = h('div', 'md'); renderMd(md, b.text, true); group.appendChild(md);
        } else if (b.type === 'thinking' && b.thinking) stepsHost(group).appendChild(thinkingEl(b.thinking, false));
        else if (b.type === 'tool_use') {
          if (b.name === 'todo_write') continue;
          if (b.name === 'wrap_up') { v.histWrapUp = { recap: String(b.input?.recap || ''), ask: String(b.input?.ask || ''), options: b.input?.ask ? (b.input?.options || []).slice(0, 3) : [] }; continue; }
          const meta = d.toolMeta[b.id] || { status: 'done', input: b.input };
          const c = toolCard(v, b.id, b.name, group);
          v.lastCard = c;
          c.setSummary(meta.summary || summarize(b.name, b.input));
          if (isShellTool(b.name) || b.name === 'start_process') c.setCommand(b.input.command);
          if (b.name.startsWith('mcp__')) c.setCommand(JSON.stringify(b.input));
          if (meta.diff) c.setDiff(meta.diff);
          if (b.name === 'task') { (meta.steps || []).forEach((s) => c.addStep(s)); if (meta.output) c.setReport(meta.output); }
          else if (meta.output && !(meta.diff && meta.status === 'done')) c.setOutput(meta.output);
          if (meta.sources) c.setSources(meta.sources);
          c.setStatus(meta.status === 'running' || meta.status === 'waiting' ? 'error' : meta.status);
          c.collapse(true);
        } else if (b.type === 'server_tool_use') {
          const c = toolCard(v, b.id, b.name, group);
          c.setSummary(b.input?.query || b.input?.url || ''); c.setStatus('done'); c.collapse(true);
          v.lastWeb = c;
        } else if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) v.lastWeb?.setSources(b.content.slice(0, 8));
      }
    });
  };
  if (d.archive?.length) renderMsgs(d.archive, false);
  renderMsgs(d.messages, true);
  // The last turn's next-step box stays usable after a reload.
  if (v.histWrapUp) { place(v, wrapUpCard(v, v.histWrapUp, !v.busy)); v.histWrapUp = null; }
  if (d.messages.length) maybePlanCta(v);
}

function noticeEl(ic, text) { const n = h('div', 'notice'); n.innerHTML = icon(ic, 'xs') + esc(text); return n; }
function compactCard(text) {
  const d = h('details', 'compact-card');
  const s = h('summary'); s.innerHTML = `${icon('layers', 'xs')} Earlier context was compacted into a summary — click to view`;
  const body = h('div', 'md'); renderMd(body, text.replace(/^\[Context summary[^\]]*\]\s*/, ''), true);
  d.append(s, body);
  return d;
}

function appendUser(v, text, turnIndex, images = [], tag = null) {
  const wrap = h('div', 'msg-user');
  if (images.length) {
    const im = h('div', 'imgs');
    for (const b of images) { const i = h('img'); i.src = `data:${b.source.media_type};base64,${b.source.data}`; im.appendChild(i); }
    wrap.appendChild(im);
  }
  wrap.appendChild(h('div', 'bubble', text));
  if (tag) { const t = h('span', 'tag'); t.innerHTML = icon('zap', 'xs') + esc(tag); wrap.appendChild(t); }
  if (turnIndex != null) addRewind(v, wrap, turnIndex);
  return place(v, wrap);
}
function addRewind(v, wrap, turnIndex) {
  const tools = h('div', 'tools');
  const r = h('button', 'btn ghost sm'); r.innerHTML = icon('undo', 'xs') + 'Rewind'; r.title = 'Restore files and conversation to just before this message';
  r.onclick = () => rewind(v, turnIndex);
  const c = h('button', 'btn ghost sm'); c.innerHTML = icon('copy', 'xs'); c.title = 'Copy message';
  c.onclick = () => { navigator.clipboard.writeText($('.bubble', wrap).textContent); toast('Copied'); };
  tools.append(r, c);
  wrap.prepend(tools);
}

// ---------- step groups ----------
// Tool calls and thinking between two pieces of assistant text collapse into one line such as
// "Read 2 files, edited app.js, ran a command  +12 −3 ›". Click it to see each step. A group opens
// by itself while a step waits for the user (approval or a question) and closes again afterwards.
const STEP_KIND = (n) => (n === 'read_file' ? 'read' : ['list_dir', 'glob', 'grep'].includes(n) ? 'search'
  : ['edit_file', 'multi_edit', 'write_file'].includes(n) ? 'edit' : isShellTool(n) || n === 'start_process' ? 'run'
    : n === 'fetch_url' || n === 'web_fetch' ? 'fetch' : n === 'web_search' ? 'web' : n === 'task' ? 'agent'
      : n.startsWith('mcp__') ? 'mcp' : n === 'ask_user' ? 'ask' : n === 'remember' ? 'note'
        : n === 'process_output' || n === 'stop_process' ? 'proc' : 'other');
const plural = (n, one, many) => (n === 1 ? one : `${n} ${many}`);
function stepsPhrase(cards, thought) {
  const by = {};
  for (const c of cards) (by[STEP_KIND(c.dataset.name || '')] ||= []).push(c);
  const parts = [];
  if (thought) parts.push(thought);
  const files = (list) => [...new Set(list.map((c) => c.dataset.path || c.dataset.sum).filter(Boolean))];
  if (by.read) { const f = files(by.read); parts.push(f.length === 1 ? `read ${baseName(f[0])}` : `read ${f.length || by.read.length} files`); }
  if (by.search) parts.push(by.search.length === 1 ? 'searched the code' : `searched the code ${by.search.length} times`);
  if (by.edit) {
    const f = files(by.edit);
    const created = by.edit.every((c) => c.dataset.isNew === '1');
    parts.push(f.length === 1 ? `${created ? 'created' : 'edited'} ${baseName(f[0])}` : `${created ? 'created' : 'edited'} ${f.length || by.edit.length} files`);
  }
  if (by.run) parts.push(plural(by.run.length, 'ran a command', 'commands').replace(/^(\d+)/, 'ran $1'));
  if (by.fetch) parts.push(plural(by.fetch.length, 'fetched a page', 'pages').replace(/^(\d+)/, 'fetched $1'));
  if (by.web) parts.push('searched the web');
  if (by.agent) parts.push(plural(by.agent.length, 'ran a sub-agent', 'sub-agents').replace(/^(\d+)/, 'ran $1'));
  if (by.mcp) parts.push(plural(by.mcp.length, 'called an MCP tool', 'MCP tools').replace(/^(\d+)/, 'called $1'));
  if (by.ask) parts.push('asked you a question');
  if (by.note) parts.push('saved a note');
  if (by.proc) parts.push('checked a background process');
  if (by.other) parts.push(plural(by.other.length, 'used a tool', 'tools').replace(/^(\d+)/, 'used $1'));
  const s = parts.join(', ');
  return s ? s[0].toUpperCase() + s.slice(1) : '';
}
function stepsGroup(parent) {
  const el = h('div', 'step-group');
  const head = h('button', 'steps-head');
  head.innerHTML = `<span class="steps-st"></span><span class="steps-sum"></span><span class="steps-now"></span><span class="steps-diff"></span><span class="steps-err"></span>${icon('chevronRight', 'xs steps-chev')}`;
  const body = h('div', 'steps-body');
  el.append(head, body);
  parent.appendChild(el);
  const g = {
    el, body, userToggled: false, autoOpened: false,
    open(on) { el.classList.toggle('open', on); head.setAttribute('aria-expanded', on ? 'true' : 'false'); },
    update() {
      const cards = [...body.querySelectorAll(':scope > .tool')];
      const thinks = [...body.querySelectorAll(':scope > .thinking')];
      el.hidden = !cards.length && !thinks.length;
      const running = cards.find((c) => c.classList.contains('running')) || thinks.find((t) => t.classList.contains('is-live'));
      const waiting = cards.some((c) => c.classList.contains('waiting'));
      const lastThink = thinks[thinks.length - 1];
      const secs = thinks.reduce((n, t) => n + Number(t.dataset.secs || 0), 0);
      const thought = !thinks.length ? '' : lastThink.dataset.heading ? lastThink.dataset.heading.replace(/^./, (c) => c.toLowerCase()) : secs ? `thought for ${secs}s` : 'thought';
      $('.steps-sum', head).textContent = stepsPhrase(cards, thought) || 'Thinking';
      const now = running?.classList.contains('tool') ? `${toolInfo(running.dataset.name)[0]} ${running.dataset.sum || ''}`.trim() : '';
      $('.steps-now', head).textContent = now ? (now.length > 60 ? now.slice(0, 60) + '…' : now) + '…' : '';
      const add = cards.reduce((n, c) => n + Number(c.dataset.added || 0), 0), del = cards.reduce((n, c) => n + Number(c.dataset.removed || 0), 0);
      $('.steps-diff', head).innerHTML = add || del ? `<span class="a">+${add}</span><span class="d">−${del}</span>` : '';
      const failed = cards.filter((c) => c.classList.contains('error')).length;
      $('.steps-err', head).textContent = failed ? `${failed} failed` : '';
      $('.steps-st', head).className = 'steps-st' + (running ? ' running' : waiting ? ' waiting' : '');
      el.classList.toggle('waiting', waiting);
      if (waiting && !el.classList.contains('open')) { g.autoOpened = true; g.open(true); }
      else if (!waiting && g.autoOpened && !g.userToggled) { g.autoOpened = false; g.open(false); }
    },
  };
  head.onclick = () => { g.userToggled = true; g.autoOpened = false; g.open(!el.classList.contains('open')); };
  el._g = g;
  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; g.update(); });
  }).observe(body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'data-sum', 'data-added'] });
  g.open(false);
  return g;
}
// Where the next step goes: the step group at the end of `parent`, or a new one after its text.
function stepsHost(parent) {
  const last = parent.lastElementChild;
  return (last?.classList.contains('step-group') ? last._g : stepsGroup(parent)).body;
}

// Thinking models write headings like "**Verifying the syntax**". The newest one is the best
// one-line description of what the agent is doing, so the step line shows it.
function thinkingHeading(text) {
  const all = [...String(text || '').matchAll(/^\s*\*\*(.{3,80}?)\*\*\s*$/gm)];
  return all.length ? all[all.length - 1][1].trim() : '';
}
function setThinkInfo(el, text, secs) {
  const head = thinkingHeading(text);
  el.dataset.heading = head;
  if (secs != null) el.dataset.secs = String(secs);
  const t = $('.think-title', el);
  if (t) t.textContent = head || (el.classList.contains('is-live') ? 'Thinking…' : 'Thought');
  const meta = $('.think-meta', el);
  if (meta) meta.textContent = secs != null ? `${secs}s` : (() => { const w = countWords(text); return w ? `${w} words` : ''; })();
}
function thinkingEl(text, live) {
  const d = h('details', 'thinking' + (live ? ' is-live' : ''));
  const s = h('summary');
  s.innerHTML = `${icon('chevronRight', 'xs caret')}<span class="think-title"></span><span class="think-meta"></span>`;
  s.addEventListener('click', () => { d.dataset.userToggled = '1'; });
  const body = h('div', 'think-body', text);
  d.append(s, body);
  setThinkInfo(d, text, null);
  return d;
}

function toolCard(v, id, name, parent) {
  const [verb, ic] = toolInfo(name);
  const el = h('div', 'tool');
  const head = h('div', 'tool-head');
  head.innerHTML = `<span class="ti">${icon(ic, 'sm')}</span><span class="tool-verb">${esc(verb)}</span><span class="tool-sum"></span><span class="tool-meta"></span><span class="tool-acts"></span><span class="tool-time"></span><span class="st running"></span>`;
  const body = h('div', 'tool-body');
  el.append(head, body);
  head.onclick = (e) => { if (!e.target.closest('.tool-acts')) el.classList.toggle('collapsed'); };
  el.dataset.name = name;
  el.classList.add('collapsed');
  (parent ? stepsHost(parent) : v.el).appendChild(el);
  let out = null, raw = '', steps = null, file = null;
  // Elapsed time while a tool runs (shown from 2 s), kept after it ends when it took a while.
  let t0 = 0, timer = null;
  const timeEl = $('.tool-time', head);
  const fmt = (ms) => { const sec = Math.round(ms / 1000); return sec < 60 ? sec + 's' : Math.floor(sec / 60) + 'm ' + String(sec % 60).padStart(2, '0') + 's'; };
  const tickTime = (on) => {
    if (on && !timer) { t0 = t0 || Date.now(); timer = setInterval(() => { const ms = Date.now() - t0; if (ms >= 2000) timeEl.textContent = fmt(ms); }, 1000); }
    if (!on && timer) { clearInterval(timer); timer = null; const ms = Date.now() - t0; timeEl.textContent = ms >= 2000 ? fmt(ms) : ''; }
  };
  const meta = $('.tool-meta', head), acts = $('.tool-acts', head);
  const copyBtn = h('button'); copyBtn.innerHTML = icon('copy', 'xs'); copyBtn.title = 'Copy output';
  copyBtn.onclick = () => {
    const txt = (body.innerText || body.textContent || '').trim() || $('.tool-sum', head).textContent;
    if (!txt) return;
    navigator.clipboard.writeText(txt);
    toast('Copied tool output');
  };
  acts.appendChild(copyBtn);
  const c = {
    el, name, body,
    setSummary: (s) => { const t = $('.tool-sum', head); t.textContent = s || ''; t.title = s || ''; el.dataset.sum = s || ''; },
    setStatus: (s) => {
      tickTime(s === 'running' || s === 'composing');
      const st = $('.st', head);
      st.className = 'st ' + (s === 'composing' ? 'running' : s);
      st.innerHTML = s === 'done' ? icon('check', 'xs') : s === 'error' || s === 'denied' ? icon('x', 'xs') : s === 'waiting' ? icon('alert', 'xs') : '';
      el.classList.toggle('running', s === 'running' || s === 'composing');
      el.classList.toggle('done', s === 'done');
      el.classList.toggle('error', s === 'error' || s === 'denied');
      el.classList.toggle('waiting', s === 'waiting');
    },
    collapse: (on) => el.classList.toggle('collapsed', on),
    setImages: (imgs) => {
      el.querySelector('.tool-shots')?.remove();
      if (!imgs?.length) return;
      const box = h('div', 'tool-shots');
      for (const b of imgs.slice(-2)) {
        const i = h('img'); i.src = `data:${b.source.media_type};base64,${b.source.data}`; i.alt = 'Screenshot'; i.loading = 'lazy';
        i.title = 'Click to enlarge';
        i.onclick = (e) => { e.stopPropagation(); box.classList.toggle('zoom'); };
        box.appendChild(i);
      }
      head.after(box);
    },
    setCommand: (cmd) => { body.querySelector('.cmd')?.remove(); const p = h('pre', 'tool-out cmd', cmd); body.prepend(p); },
    liveInput: (chunk) => {
      raw += chunk;
      if (!out) { out = h('pre', 'tool-out live'); body.appendChild(out); }
      out.textContent = raw.length > 2400 ? '…' + raw.slice(-2400) : raw;
      meta.textContent = raw.length > 300 ? `${(raw.length / 1024).toFixed(1)} KB` : '';
      body.scrollTop = body.scrollHeight;
    },
    clearLive: () => { out?.remove(); out = null; raw = ''; meta.textContent = ''; },
    setOutput: (text) => { if (!out) { out = h('pre', 'tool-out'); body.appendChild(out); } out.className = 'tool-out'; out.textContent = text; },
    appendOutput: (chunk) => {
      if (!out) { out = h('pre', 'tool-out'); body.appendChild(out); }
      out.className = 'tool-out';
      out.textContent += chunk;
      if (out.textContent.length > 60000) out.textContent = out.textContent.slice(-50000);
      body.scrollTop = body.scrollHeight;
    },
    setDiff: (diff) => {
      body.querySelector('.diff')?.remove();
      body.prepend(renderDiff(diff));
      meta.innerHTML = `${diff.isNew ? '<span>new</span>' : ''}<span class="a">+${diff.added}</span><span class="d">−${diff.removed}</span>`;
      file = diff.path;
      Object.assign(el.dataset, { path: diff.path || '', isNew: diff.isNew ? '1' : '', added: String(diff.added || 0), removed: String(diff.removed || 0) });
      if (file && !acts.querySelector('[data-file-act]') && S.project) {
        const o = h('button'); o.dataset.fileAct = '1'; o.innerHTML = icon('external', 'xs'); o.title = 'Open file'; o.onclick = () => Editor.openFile(file);
        const r = h('button'); r.dataset.fileAct = '1'; r.innerHTML = icon('diff', 'xs'); r.title = 'Review all session changes to this file'; r.onclick = () => Editor.openSessionDiff(file);
        acts.prepend(r, o);
      }
    },
    setSources: (list) => {
      body.querySelector('.sources')?.remove();
      const s = h('div', 'sources');
      for (const r of list) { const a = h('a', '', r.title || r.url); a.href = r.url; a.target = '_blank'; a.title = r.url; s.appendChild(a); }
      body.appendChild(s);
    },
    addStep: (line) => {
      if (!steps) { steps = h('ul', 'steps'); body.prepend(steps); }
      steps.appendChild(h('li', '', line));
      meta.textContent = `${steps.childElementCount} steps`;
      body.scrollTop = body.scrollHeight;
    },
    setReport: (text) => { body.querySelector('.report')?.remove(); const r = h('div', 'report md'); renderMd(r, text, true); body.appendChild(r); },
  };
  v.tools.set(id, c);
  return c;
}

function renderDiff(diff) {
  const d = h('div', 'diff');
  for (const hk of diff.hunks) {
    d.appendChild(h('div', 'hh', hk.header));
    for (const l of hk.lines) {
      const row = h('div', 'ln' + (l.t === '+' ? ' a' : l.t === '-' ? ' d' : ''));
      row.innerHTML = `<span class="no">${l.o ?? ''}</span><span class="no">${l.n ?? ''}</span><span class="sg">${l.t === ' ' ? '' : l.t === '-' ? '−' : '+'}</span><span>${esc(l.s)}</span>`;
      d.appendChild(row);
    }
  }
  if (diff.truncated) d.appendChild(h('div', 'more', '… diff truncated — open the review to see everything'));
  if (!diff.hunks.length) d.appendChild(h('div', 'more', 'No changes'));
  return d;
}

// ---------- live events ----------
function onEvent(ev) {
  const v = S.views.get(ev.sessionId);
  if (!v) { if (ev.type === 'status' || ev.type === 'done') Panels.renderSessions(); return; }
  const cur = S.current === v.id;
  switch (ev.type) {
    case 'turn-start': {
      v.lastTurnIndex = ev.turnIndex;
      const u = v.el.querySelector('.msg-user.pending');
      if (u) { u.classList.remove('pending'); u.querySelector('.tag')?.remove(); addRewind(v, u, ev.turnIndex); }
      v.data.title = ev.title;
      if (cur) $('#sessionTitle').textContent = ev.title;
      v.el.querySelector('.plan-cta')?.remove();
      Panels.renderSessions();
      break;
    }
    case 'status':
      v.busy = ev.busy;
      setWorking(v, ev.busy);
      if (ev.busy) { v.turnStartCost = v.data.usage.cost; v.turnStartOut = v.data.usage.output || 0; }
      if (cur) { updateComposer(); Panels.renderStatus(); }
      Panels.markSession(v);
      Panels.renderTasks?.();
      break;
    case 'task-started':
    case 'task-queued':
    case 'task-ended':
    case 'task-cancelled':
    case 'task-event': {
      // A message that waited in the queue: when it starts, it moves below the previous answer;
      // if it is cancelled, it says so.
      const u = ev.task_id && v.el.querySelector(`.msg-user[data-task="${CSS.escape(ev.task_id)}"]`);
      if (u && (ev.type === 'task-started' || ev.type === 'task-cancelled')) u.querySelector('.send-now')?.remove();
      if (u && ev.type === 'task-started') {
        u.querySelector('.tag')?.remove();
        u.classList.add('pending'); // its turn-start adds the Rewind button
        v.group = null;
        place(v, u);
      } else if (u && ev.type === 'task-cancelled') {
        const t = u.querySelector('.tag');
        if (t) t.innerHTML = icon('x', 'xs') + 'Cancelled — not sent';
      }
      Panels.renderTasks?.();
      if (cur) renderQueue();
      break;
    }
    case 'iteration-start':
      v.group = place(v, h('div', 'assistant'));
      v.blocks.clear();
      setWorking(v, true, 'Thinking');
      break;
    case 'block-start': {
      const g = v.group || place(v, h('div', 'assistant'));
      const rec = { type: ev.blockType, text: '' };
      if (ev.blockType === 'text') { rec.el = h('div', 'md cursor'); g.appendChild(rec.el); setWorking(v, true, 'Writing'); }
      else if (ev.blockType === 'thinking') { rec.el = thinkingEl('', true); rec.started = Date.now(); stepsHost(g).appendChild(rec.el); setWorking(v, true, 'Thinking'); }
      else if (ev.blockType === 'tool_use') {
        if (ev.name !== 'todo_write' && ev.name !== 'wrap_up') {
          rec.card = toolCard(v, ev.id, ev.name, g);
          rec.card.setStatus('composing'); rec.card.setSummary('');
        }
        setWorking(v, true, toolInfo(ev.name)[0]);
      } else if (ev.blockType === 'server_tool_use') {
        rec.card = toolCard(v, ev.id, ev.name, g); rec.card.setStatus('running'); rec.card.collapse(true);
        v.lastWeb = rec.card;
        setWorking(v, true, ev.name === 'web_search' ? 'Searching the web' : 'Fetching');
      } else if (ev.blockType === 'web_search_tool_result') { if (v.lastWeb) { v.lastWeb.setStatus('done'); if (ev.results) v.lastWeb.setSources(ev.results); } }
      else if (ev.blockType === 'web_fetch_tool_result') v.lastWeb?.setStatus('done');
      v.blocks.set(ev.index, rec);
      autoScroll(v);
      break;
    }
    case 'text-delta': {
      const r = v.blocks.get(ev.index); if (!r) break;
      r.text += ev.text;
      if (!r.pending) { r.pending = true; requestAnimationFrame(() => { r.pending = false; if (r.el.classList.contains('cursor')) renderMd(r.el, r.text, false); autoScroll(v); }); }
      break;
    }
    case 'thinking-delta': {
      const r = v.blocks.get(ev.index); if (!r) break;
      r.text += ev.text;
      const body = $('.think-body', r.el);
      if (body) { body.textContent = r.text; body.scrollTop = body.scrollHeight; }
      setThinkInfo(r.el, r.text, Math.round((Date.now() - (r.started || Date.now())) / 1000));
      autoScroll(v);
      break;
    }
    case 'input-delta': { const r = v.blocks.get(ev.index); if (!r) break; r.text += ev.partial; if (r.card && r.type === 'tool_use') r.card.liveInput(ev.partial); break; }
    case 'block-stop': {
      const r = v.blocks.get(ev.index); if (!r) break;
      if (r.type === 'text') { r.el.classList.remove('cursor'); renderMd(r.el, r.text, true); }
      else if (r.type === 'thinking') {
        r.el.classList.remove('is-live');
        setThinkInfo(r.el, r.text, Math.round((Date.now() - (r.started || Date.now())) / 1000));
        if (!r.el.dataset.userToggled) r.el.open = false;
        if (!r.text.trim()) r.el.remove();
      }
      else if (r.type === 'server_tool_use' && r.card) { try { const inp = JSON.parse(r.text || '{}'); r.card.setSummary(inp.query || inp.url || ''); } catch { /* partial */ } }
      setWorking(v, true, 'Working');
      break;
    }
    case 'tool-start': {
      if (ev.name === 'todo_write' || ev.name === 'wrap_up') break;
      let c = v.tools.get(ev.id);
      if (!c) c = toolCard(v, ev.id, ev.name, v.group);
      c.clearLive();
      c.setSummary(ev.summary || summarize(ev.name, ev.input));
      c.setStatus('running');
      if (isShellTool(ev.name) || ev.name === 'start_process') c.setCommand(ev.input.command);
      if (ev.mcp) c.setCommand(JSON.stringify(ev.input));
      if (ev.diff) c.setDiff(ev.diff);
      {
        const what = String(ev.summary || '').replace(/\s+/g, ' ').slice(0, 60);
        setWorking(v, true, isShellTool(ev.name) ? (what ? `Running ${what}` : 'Running a command') : ev.mcp ? 'Calling MCP tool' : ev.name === 'task' ? (what ? `Sub-agent: ${what}` : 'Sub-agent working') : what ? `${toolInfo(ev.name)[0]} ${what}` : toolInfo(ev.name)[0]);
      }
      break;
    }
    case 'sub-step': v.tools.get(ev.id)?.addStep(ev.line); break;
    case 'tool-running': v.tools.get(ev.id)?.setStatus('running'); break;
    case 'tool-output': v.tools.get(ev.id)?.appendOutput(ev.chunk); autoScroll(v); break;
    case 'tool-end': {
      const c = v.tools.get(ev.id);
      v.waiting.delete(ev.id);
      if (!c) break;
      c.el.querySelector('.perm')?.remove();
      c.setStatus(ev.denied ? 'denied' : ev.ok ? 'done' : 'error');
      if (c.name === 'task') { if (ev.ok) c.setReport(ev.output); else c.setOutput(ev.output); }
      else if (ev.diff && ev.ok) { c.body.querySelectorAll('.tool-out:not(.cmd)').forEach((x) => x.remove()); const note = (ev.output.match(/Diagnostics:[\s\S]*/) || [])[0]; if (note) c.setOutput(note); }
      else c.setOutput(ev.output);
      if (ev.sources) c.setSources(ev.sources);
      if (ev.images) c.setImages(ev.images);
      if (ev.diff && ev.ok) Editor.reloadFile(ev.diff.path);
      c.collapse(ev.ok);
      Panels.markSession(v);
      break;
    }
    case 'permission': showPermission(v, ev); break;
    case 'question': showQuestion(v, ev); break;
    case 'todos': v.data.todos = ev.todos; renderTaskCard(v); if (cur) Panels.renderPlan(); break;
    case 'wrap-up': {
      v.el.querySelectorAll('.wrapup button').forEach((b) => { b.disabled = true; });
      v.pendingWrapUp = { recap: ev.recap, ask: ev.ask, options: ev.options };
      break;
    }
    case 'changes': v.data.changes = ev.changes; if (cur) { Panels.renderChanges(); Panels.refreshTreeMarks(); Panels.refreshGitSoon(); } break;
    case 'requirements': v.data.requirements = ev.requirements; if (cur) Panels.renderPlan(); break;
    case 'usage': v.data.usage = ev.usage; if (cur) { Panels.renderUsage(); updateCtx(); Panels.renderStatus(); } break;
    case 'notice': place(v, noticeEl('info', ev.message)); break;
    case 'auto-model': {
      v.autoModel = ev.model;
      place(v, noticeEl(ev.escalated ? 'zap' : 'cpu', ev.escalated ? `Auto escalated to ${ev.model} because ${ev.reason}` : `Auto picked ${ev.model} (${ev.reason})`));
      if (cur) Panels.renderStatus();
      break;
    }
    case 'model-switched': v.data.model = ev.model; if (cur) { $('#modelSel').value = ev.model; syncPills(); } toast(`Switched to ${ev.model}`); break;
    case 'steer-queued': break;
    case 'steer-delivered': $$('.msg-user .tag.steer:not(.done)', v.el).forEach((t) => { t.classList.add('done'); t.innerHTML = icon('check', 'xs') + 'Delivered to the agent'; }); break;
    case 'steer-returned': {
      // Stop came before the agent read these: put them back in the box instead of losing them.
      $$('.msg-user .tag.steer:not(.done)', v.el).forEach((t) => { t.innerHTML = icon('undo', 'xs') + 'Not delivered — back in the message box'; t.classList.add('done'); });
      if (cur) { const t = $('#input'); t.value = (t.value.trim() ? t.value.trim() + '\n\n' : '') + ev.text; autosize(); updateComposer(); t.focus(); }
      toast('Stopped before the agent read your message: it is back in the box');
      break;
    }
    case 'queue-updated': {
      // A queued message sent to the running agent now: its bubble says so, then Delivered.
      const u = ev.steeredTask && v.el.querySelector(`.msg-user[data-task="${CSS.escape(ev.steeredTask)}"]`);
      const t = u?.querySelector('.tag');
      if (t) { t.classList.add('steer'); t.innerHTML = icon('zap', 'xs') + 'Steering — delivered at next step'; }
      u?.querySelector('.send-now')?.remove();
      renderQueue();
      break;
    }
    case 'steer-resend': { const u = $$('.msg-user .tag:not(.done)', v.el).pop()?.closest('.msg-user'); if (u) u.classList.add('pending'); break; }
    case 'compact-start': setWorking(v, true, 'Compacting context'); place(v, noticeEl('layers', `Compacting ${ev.messages} messages to free up context…`)); break;
    case 'compacted': {
      v.data.usage = ev.usage || v.data.usage;
      place(v, compactCard(ev.summary));
      if (cur) { updateCtx(); Panels.renderUsage(); }
      break;
    }
    case 'proc': Panels.onProc(v, ev); break;
    case 'error': {
      const e = h('div', 'err-card');
      e.innerHTML = icon('alert');
      e.append(h('span', 'grow', ev.message));
      if (ev.action === 'ollama-download') { const b = h('button', 'btn sm primary'); b.innerHTML = icon('download', 'xs') + 'Download a free local model'; b.onclick = () => Panels.openSettings('models'); e.appendChild(b); }
      else if (ev.needsKey) { const b = h('button', 'btn sm', 'Open settings'); b.onclick = () => Panels.openSettings('providers'); e.appendChild(b); }
      place(v, e);
      break;
    }
    case 'done': {
      setWorking(v, false);
      // Finished while you were looking at another session: mark it unread in the sidebar.
      if (S.current !== v.id) (S.unread ||= new Set()).add(v.id);
      v.waiting.clear();
      if (!ev.quiet) {
        const spent = v.data.usage.cost - v.turnStartCost;
        const f = h('div', 'turn-footer');
        const secs = v.started ? Math.round((Date.now() - v.started) / 1000) : 0;
        const pills = [];
        if (secs) pills.push(`<span class="tf-pill">${secs}s</span>`);
        if (!(v.data.usage.costUnknown && !spent)) pills.push(`<span class="tf-pill">${fmtCost(spent)}</span>`);
        pills.push(`<span class="tf-pill">${fmtTok(v.data.usage.context)} context</span>`);
        f.innerHTML = pills.join('');
        const mdParts = [];
        let prev = v.el.lastElementChild;
        while (prev && !prev.classList.contains('msg-user')) {
          if (prev.classList.contains('assistant')) {
            const txt = [...prev.querySelectorAll(':scope > .md')].map((m) => (m.innerText || m.textContent || '').trim()).filter(Boolean).join('\n\n');
            if (txt) mdParts.unshift(txt);
          }
          prev = prev.previousElementSibling;
        }
        if (mdParts.length) {
          const copyResp = h('button', 'btn ghost sm');
          copyResp.innerHTML = icon('copy', 'xs') + 'Copy response';
          copyResp.onclick = () => {
            navigator.clipboard.writeText(mdParts.join('\n\n'));
            copyResp.innerHTML = icon('check', 'xs') + 'Copied';
            setTimeout(() => { copyResp.innerHTML = icon('copy', 'xs') + 'Copy response'; }, 1400);
          };
          f.appendChild(copyResp);
        }
        // Retry: undo this turn (messages and files) and send the same request again.
        const lastTurn = v.lastTurnIndex ?? v.data.turns.length - 1;
        if (lastTurn >= 0) {
          const retry = h('button', 'btn ghost sm'); retry.innerHTML = icon('refresh', 'xs') + 'Retry';
          retry.title = 'Undo this answer and its file changes, then ask again';
          retry.onclick = () => retryTurn(v, lastTurn);
          f.appendChild(retry);
        }
        const fork = h('button', 'btn ghost sm'); fork.innerHTML = icon('branch', 'xs') + 'Fork';
        fork.title = 'Start a new session with this conversation so far';
        fork.onclick = () => forkSession(v);
        f.appendChild(fork);
        place(v, f);
        // The next-step box goes last, after the answer and its footer.
        if (v.pendingWrapUp) { place(v, wrapUpCard(v, v.pendingWrapUp, true)); v.pendingWrapUp = null; }
        v.started = null;
        maybePlanCta(v);
        if (!document.hasFocus() && S.settings?.notifyApproval !== false) new Notification('DROPs', { body: `${v.data.title} — finished`, silent: true });
      }
      Panels.markSession(v);
      Panels.renderSessions();
      if (cur) { updateComposer(); Panels.refreshGitSoon(); }
      break;
    }
  }
}

/** The next-step box: recap, optional question, answer buttons (a click sends the answer). */
function wrapUpCard(v, box, live) {
  const card = h('div', 'wrapup');
  card.setAttribute('role', 'group'); card.setAttribute('aria-label', 'Next step');
  card.appendChild(h('div', 'wu-recap', box.recap));
  if (box.ask) {
    card.appendChild(h('div', 'wu-ask', box.ask));
    if (box.options?.length) {
      const row = h('div', 'wu-actions');
      box.options.forEach((o, i) => {
        const b = h('button', i === 0 ? 'btn primary sm' : 'btn sm', o);
        b.disabled = !live;
        b.onclick = () => { card.querySelectorAll('button').forEach((x) => { x.disabled = true; }); b.classList.add('chosen'); doSend(v, o, []); };
        row.appendChild(b);
      });
      card.appendChild(row);
    }
  }
  return card;
}

/** The task list under the latest message, updated live while the agent works. */
/** The task state mark: a dashed circle (to do), a spinning ring (now), a filled circle with a tick (done). */
function taskMark(status) {
  if (status === 'completed') return '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><circle cx="8" cy="8" r="7" class="tm-done"/><path d="M4.8 8.2l2.1 2.1 4.3-4.6" fill="none" class="tm-tick" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  if (status === 'in_progress') return '<span class="tm-spin" aria-hidden="true"></span>';
  return '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><circle cx="8" cy="8" r="6.5" fill="none" class="tm-todo" stroke-width="1.3" stroke-dasharray="2.6 2.4"/></svg>';
}
window.taskMark = taskMark;

function renderTaskCard(v) {
  const todos = v.data.todos || [];
  if (!todos.length) { v.taskCard?.remove(); v.taskCard = null; return; }
  if (!v.taskCard) v.taskCard = h('div', 'task-card-inline');
  const done = todos.filter((t) => t.status === 'completed').length;
  v.taskCard.innerHTML = '';
  v.taskCard.setAttribute('aria-label', `Tasks: ${done} of ${todos.length} done`);
  for (const t of todos) {
    const r = h('div', 'tci-row ' + t.status);
    r.innerHTML = `<span class="tci-ic">${taskMark(t.status)}</span>`;
    r.appendChild(h('span', 'tci-t', t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content));
    v.taskCard.appendChild(r);
  }
  place(v, v.taskCard); // moves it to the bottom of the thread, above the working indicator
}

function maybePlanCta(v) {
  v.el.querySelector('.plan-cta')?.remove();
  const last = v.data.messages[v.data.messages.length - 1];
  if (v.data.mode !== 'plan' || !last || last.role !== 'assistant' || v.busy) return;
  const box = h('div', 'plan-cta');
  box.innerHTML = `${icon('list', 'sm')}<span class="grow">Plan ready. Approve it to let DROPs implement and verify it.</span>`;
  const go = h('button', 'btn primary sm'); go.innerHTML = icon('play', 'xs') + 'Approve & execute';
  go.onclick = () => { setMode('auto-edit'); persistOpts(); box.remove(); doSend(v, 'The plan is approved. Implement it now step by step, keep the todo list updated, and verify everything at the end.', []); };
  box.appendChild(go);
  place(v, box);
}

// The agent asked the user a question (ask_user): option buttons plus a free-text answer.
function showQuestion(v, ev) {
  let c = v.tools.get(ev.toolId);
  if (!c) c = toolCard(v, ev.toolId, 'ask_user', v.group);
  c.setStatus('waiting'); c.collapse(false);
  v.waiting.add(ev.toolId);
  Panels.markSession(v);
  setWorking(v, false);
  const p = h('div', 'perm question');
  p.innerHTML = `<div class="q">${icon('info', 'sm')}<span></span></div>`;
  $('.q span', p).textContent = ev.question;
  const btns = h('div', 'btns');
  const answer = (text) => {
    api.permission(v.id, ev.reqId, text ? 'answer' : 'skip', text || '');
    p.remove(); v.waiting.delete(ev.toolId); Panels.markSession(v);
    c.setStatus('running'); setWorking(v, true, 'Working');
  };
  for (const o of ev.options || []) { const b = h('button', 'btn sm tonal'); b.textContent = o; b.onclick = () => answer(o); btns.appendChild(b); }
  const fb = h('input'); fb.placeholder = ev.options?.length ? 'Or type your own answer…' : 'Type your answer…';
  fb.onkeydown = (e) => { if (e.key === 'Enter' && fb.value.trim()) answer(fb.value.trim()); };
  const send = h('button', 'btn sm primary', 'Answer'); send.onclick = () => fb.value.trim() && answer(fb.value.trim());
  const skip = h('button', 'btn sm ghost', 'Skip'); skip.title = 'Let the agent decide'; skip.onclick = () => answer('');
  btns.append(fb, send, skip);
  p.appendChild(btns);
  c.el.appendChild(p);
  autoScroll(v, true);
  if (S.current === v.id) (ev.options?.length ? $('button', btns) : fb).focus();
  if (S.current !== v.id) toast(`“${v.data.title}” has a question for you`);
  if (!document.hasFocus() && S.settings?.notifyApproval !== false) new Notification('DROPs has a question', { body: `${v.data.title}: ${ev.question}`.slice(0, 140) });
}
function showPermission(v, ev) {
  let c = v.tools.get(ev.toolId);
  if (!c) c = toolCard(v, ev.toolId, ev.name, v.group);
  c.setStatus('waiting'); c.collapse(false);
  v.waiting.add(ev.toolId);
  Panels.markSession(v);
  setWorking(v, false);
  const p = h('div', 'perm');
  const what = ev.kind === 'shell' ? 'Run this command?' : ev.kind === 'mcp' ? `Call MCP tool <b>${esc(ev.summary)}</b>?` : ev.kind === 'fetch' ? `Fetch <b>${esc(ev.summary)}</b>?` : ev.kind === 'search' ? `Search the web for <b>${esc(ev.summary)}</b>?` : ev.diff?.isNew ? `Create <b>${esc(ev.summary)}</b>?` : `Apply this change to <b>${esc(ev.summary)}</b>?`;
  p.innerHTML = `<div class="q">${ev.dangerous ? `${icon('alert', 'sm')}<span class="danger">${esc(ev.reason || 'Potentially destructive.')}</span>` : icon('shield', 'sm')} <span>${what}</span></div>`;
  const btns = h('div', 'btns');
  const allow = h('button', 'btn primary sm', 'Allow');
  const always = h('button', 'btn sm', ev.kind === 'edit' ? 'Allow all edits' : ev.kind === 'mcp' ? 'Always allow this server' : ev.kind === 'fetch' ? 'Always allow this site' : ev.kind === 'search' ? 'Always allow web search' : 'Allow all commands');
  const fb = h('input'); fb.placeholder = 'Or tell DROPs what to do instead…';
  const deny = h('button', 'btn sm danger', 'Deny');
  const answer = (decision) => {
    api.permission(v.id, ev.reqId, decision, fb.value.trim());
    p.remove(); v.waiting.delete(ev.toolId); Panels.markSession(v);
    c.setStatus(decision === 'deny' ? 'denied' : 'running');
    if (decision !== 'deny') setWorking(v, true, 'Working');
  };
  allow.onclick = () => answer('allow');
  always.onclick = () => answer('always');
  deny.onclick = () => answer('deny');
  fb.onkeydown = (e) => { if (e.key === 'Enter') answer('deny'); };
  if (ev.dangerous) always.hidden = true;
  btns.append(allow, always, fb, deny);
  p.appendChild(btns);
  c.el.appendChild(p);
  autoScroll(v, true);
  if (S.current === v.id && !$('#input').value) allow.focus();
  if (S.current !== v.id) toast(`“${v.data.title}” is waiting for your approval`);
  if (!document.hasFocus() && S.settings?.notifyApproval !== false) new Notification('DROPs needs approval', { body: `${v.data.title}: ${ev.kind === 'shell' ? ev.input.command : ev.summary}`.slice(0, 140) });
}

// ---------- sessions ----------
async function openSession(id) {
  let v = S.views.get(id);
  if (!v) {
    const data = await api.loadSession(id);
    if (!data) return;
    if (data.projectDir !== S.project) await setProject(data.projectDir, true);
    v = makeView(data);
  } else if (v.data.projectDir !== S.project) await setProject(v.data.projectDir, true);
  S.current = id;
  S.unread?.delete(id);
  showCurrent();
  Panels.renderSessions(false);
}
async function newSession() {
  if (!S.project) { const p = await api.openProject(); if (!p) return; await setProject(p); }
  const o = currentOpts();
  const data = await api.newSession(S.project, { model: usableModel(o.model || S.settings.defaultModel), effort: o.effort, mode: o.mode });
  const v = makeView(data);
  S.current = v.id;
  showCurrent();
  Panels.renderSessions();
  $('#input').focus();
}
function showCurrent() {
  const v = currentView();
  for (const x of S.views.values()) x.el.hidden = x !== v;
  const empty = !v || (!v.data.messages.length && !v.data.archive?.length && !v.busy);
  $('#hero').hidden = !empty;
  if (empty) Panels.renderHero();
  $('#sessionTitle').textContent = v ? v.data.title : '';
  const d = v?.data || { model: S.settings.defaultModel, effort: S.settings.effort, mode: S.settings.mode };
  $('#modelSel').value = v ? d.model : usableModel(d.model);
  if (!$('#modelSel').value) $('#modelSel').value = usableModel(d.model);
  $('#effortSel').value = d.effort || 'high';
  setMode(d.mode || 'ask');
  syncPills(); updateComposer(); updateCtx();
  Panels.renderSessions(); Panels.renderPlan(); Panels.renderChanges(); Panels.renderUsage(); Panels.renderProcs(); Panels.renderStatus(); Panels.refreshTreeMarks();
  if (v) autoScroll(v, true);
}

async function setProject(p, keepSession) {
  const ok = await api.useProject(p);
  if (!ok) { toast('Folder not found: ' + p); return; }
  S.project = p;
  S.settings = await api.getSettings();
  $('#projectName').textContent = baseName(p);
  $('#projectBtn').title = p;
  if (!keepSession) { const cur = currentView(); if (!cur || cur.data.projectDir !== p) S.current = null; }
  await loadCustomCommands();
  await Panels.loadTree();
  await Panels.refreshGit();
  await Panels.renderSessions(true);
  showCurrent();
}
async function pickProject() { const p = await api.openProject(); if (p) await setProject(p); }

// ---------- composer ----------
function modelUsable(x) {
  if (x.id.startsWith('__')) return false;
  if (x.provider === 'Gemini') return S.settings.hasGemini;
  if (x.provider === 'Claude') return S.settings.hasAnthropic;
  if (x.provider === 'Auto') return S.settings.hasGemini || S.settings.hasAnthropic || S.settings.ollamaEnabled;
  return true; // local models
}
function usableModel(id) {
  const ok = modelUsable;
  const m = S.info.models.find((x) => x.id === id);
  if (m && ok(m)) return id;
  return (S.info.models.find(ok) || m || S.info.models[0]).id;
}
function syncPills() {
  const m = S.info.models.find((x) => x.id === $('#modelSel').value);
  $('#modelLabel').textContent = m ? m.label : $('#modelSel').value;
  $('#effortLabel').textContent = $('#effortSel').value;
  const mode = $('#modeSeg button.on')?.dataset.mode || 'ask';
  $('#optsLabel').textContent = `${MODES[mode]?.label || mode} · ${$('#effortSel').value}`;
  $('#optsBtn').classList.toggle('warn', mode === 'yolo');
}
const MODES = {
  plan: { label: 'Plan', icon: 'list', desc: 'Read only. Investigates and proposes a plan for you to approve.' },
  ask: { label: 'Ask', icon: 'shield', desc: 'Asks before every file change and command.' },
  'auto-edit': { label: 'Auto-edit', icon: 'pencil', desc: 'Edits files on its own, asks before commands.' },
  yolo: { label: 'Full auto', icon: 'zap', desc: 'Runs everything on its own. Destructive commands still ask.' },
};
function setMode(mode) { $$('#modeSeg button').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode)); if ($('#optsLabel')) syncPills(); }
// One small menu for the permission mode and the reasoning effort.
function openOptsMenu() {
  if ($('.opts-menu')) { closeOptsMenu(); return; }
  const btn = $('#optsBtn');
  const menu = h('div', 'opts-menu');
  menu.setAttribute('role', 'menu');
  const o = currentOpts();
  menu.innerHTML = `<div class="om-title">Permission mode</div>${Object.entries(MODES).map(([k, m]) => `<button class="om-row${k === o.mode ? ' on' : ''}" data-mode="${k}" role="menuitemradio" aria-checked="${k === o.mode}">${icon(m.icon, 'sm')}<span class="om-text"><b>${m.label}</b><small>${m.desc}</small></span>${k === o.mode ? icon('check', 'sm om-check') : ''}</button>`).join('')}
    <div class="om-title">Reasoning effort</div><div class="om-effort">${[...$('#effortSel').options].map((x) => `<button data-effort="${x.value}" class="${x.value === o.effort ? 'on' : ''}">${x.value}</button>`).join('')}</div>
    <div class="om-foot">Shift+Tab changes the mode</div>`;
  $$('[data-mode]', menu).forEach((b) => (b.onclick = () => { setMode(b.dataset.mode); persistOpts(); closeOptsMenu(); $('#input').focus(); }));
  $$('[data-effort]', menu).forEach((b) => (b.onclick = () => { $('#effortSel').value = b.dataset.effort; persistOpts(); closeOptsMenu(); $('#input').focus(); }));
  $('.composer-wrap').appendChild(menu);
  const r = btn.getBoundingClientRect(), w = $('.composer-wrap').getBoundingClientRect();
  menu.style.left = Math.max(8, r.left - w.left) + 'px';
  btn.setAttribute('aria-expanded', 'true');
  setTimeout(() => document.addEventListener('mousedown', outsideOpts), 0);
  document.addEventListener('keydown', escOpts, true);
}
function closeOptsMenu() {
  const m = $('.opts-menu'); if (m) m.parentNode.removeChild(m);
  $('#optsBtn')?.setAttribute('aria-expanded', 'false');
  document.removeEventListener('mousedown', outsideOpts);
  document.removeEventListener('keydown', escOpts, true);
}
function outsideOpts(e) { if (!e.target.closest('.opts-menu, #optsBtn')) closeOptsMenu(); }
function escOpts(e) { if (e.key === 'Escape') { e.stopPropagation(); closeOptsMenu(); } }
function currentOpts() { return { model: $('#modelSel').value, effort: $('#effortSel').value, mode: $('#modeSeg button.on')?.dataset.mode || 'ask' }; }
function persistOpts() {
  const v = currentView(); const o = currentOpts();
  syncPills();
  if (v) { Object.assign(v.data, o); api.setSessionOptions(v.id, o); }
  Panels.renderStatus();
}
function updateComposer() {
  const v = currentView();
  const busy = !!v?.busy;
  const hasText = !!$('#input').value.trim() || S.attachments.length > 0;
  $('#composer').classList.toggle('is-busy', busy);
  $('#stopBtn').hidden = !busy;
  $('#sendBtn').hidden = busy && !hasText;
  $('#sendBtn').disabled = !hasText;
  $('#sendBtn').title = busy ? 'Send now: the agent reads it at its next step (Enter) · Queue for after this task (Ctrl+Enter)' : 'Send (Enter)';
  $('#input').placeholder = busy ? 'Enter to send now, Ctrl+Enter to queue for later' : 'Ask DROPs to build, fix or explain something';
  renderQueue();
}

/** Messages waiting for this session, shown above the composer, each with Run/Tell now and Cancel. */
let queueSeq = 0;
async function renderQueue() {
  const bar = $('#queueBar'); const v = currentView();
  if (!bar) return;
  const my = ++queueSeq;
  const items = v && api.taskQueued ? await api.taskQueued(v.id).catch(() => []) : [];
  if (my !== queueSeq) return;
  bar.innerHTML = '';
  bar.hidden = !items.length;
  for (const it of items) {
    const row = h('div', 'queue-item');
    row.innerHTML = `<span class="q-ic">${icon(it.restored ? 'history' : 'list', 'xs')}</span><span class="q-text"></span><span class="q-note"></span><button class="btn ghost sm q-run"></button><button class="btn ghost sm q-cancel" title="Cancel this message">${icon('x', 'xs')}</button>`;
    $('.q-text', row).textContent = it.prompt.replace(/\s+/g, ' ').slice(0, 140);
    $('.q-note', row).textContent = it.restored ? 'waiting since the app restarted' : '';
    $('.q-run', row).textContent = v.busy ? 'Tell agent now' : 'Run now';
    $('.q-run', row).onclick = async () => { const r = await api.taskRunNow(it.task_id); if (r?.error) toast(r.error); else if (r?.steered) toast('Delivered to the agent at its next step'); renderQueue(); };
    $('.q-cancel', row).onclick = async () => {
      await api.taskCancel(it.task_id);
      const u = v.el.querySelector(`.msg-user[data-task="${CSS.escape(it.task_id)}"]`);
      const t = u?.querySelector('.tag'); if (t) { t.innerHTML = icon('x', 'xs') + 'Cancelled — not sent'; t.classList.add('done'); }
      renderQueue();
    };
    bar.appendChild(row);
  }
}
function autosize() { const t = $('#input'); t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 280) + 'px'; }
function insertAtCursor(s) {
  const t = $('#input'); const a = t.selectionStart, b = t.selectionEnd;
  t.value = t.value.slice(0, a) + s + t.value.slice(b);
  t.selectionStart = t.selectionEnd = a + s.length; t.focus(); autosize(); updateComposer();
}
function updateCtx() {
  const u = currentView()?.data.usage;
  const limit = S.settings?.compactAt || 180000;
  const pct = u ? Math.min(1, u.context / contextMax()) : 0;
  $('#ctxArc').style.strokeDashoffset = String(94.25 * (1 - pct));
  $('#ctxArc').style.stroke = u && u.context > limit * 0.85 ? 'var(--warn)' : 'var(--accent)';
  $('#ctxText').textContent = u ? fmtTok(u.context) : '0';
  $('#ctxRing').hidden = !u?.context;
  $('#ctxRing').title = u ? `${fmtTok(u.context)} tokens in context · auto-compacts at ${fmtTok(limit)}` : 'Context window used';
}

// attachments
async function addImageFile(file) {
  if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) { toast('Only PNG, JPEG, GIF or WebP images'); return; }
  if (file.size > 5 * 1024 * 1024) { toast('Image is larger than 5 MB'); return; }
  const data = await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(String(fr.result).split(',')[1]); fr.readAsDataURL(file); });
  S.attachments.push({ type: 'image', source: { type: 'base64', media_type: file.type, data } });
  renderAttachments();
}
function renderAttachments() {
  const box = $('#attachments');
  box.innerHTML = '';
  box.hidden = !S.attachments.length;
  S.attachments.forEach((a, i) => {
    const d = h('div', 'att'); const img = h('img'); img.src = `data:${a.source.media_type};base64,${a.source.data}`;
    const x = h('button', 'x'); x.innerHTML = icon('x', 'xs'); x.onclick = () => { S.attachments.splice(i, 1); renderAttachments(); updateComposer(); };
    d.append(img, x); box.appendChild(d);
  });
  updateComposer();
}

const SLASH = [
  { k: '/init', d: 'Analyze the project and write DROPs.md', run: () => sendText('Analyze this project thoroughly (structure, stack, build/test/lint commands, conventions, architecture, gotchas) and create or update H2O.md in the project root with a concise, high-signal guide for future AI sessions. Use sub-agents to explore in parallel if the project is large.') },
  { k: '/review', d: 'Review uncommitted changes for bugs', run: () => sendText('Review the current uncommitted changes (use `git diff` and read the touched files). Look for bugs, edge cases, security issues, performance problems and missing tests. Report findings ranked by severity with file:line references. Do not modify files.') },
  { k: '/test', d: 'Run the tests and fix failures', run: () => sendText('Run the project\'s test suite (find the right command first). If anything fails, diagnose the root cause and fix it, then re-run until green. Report what you changed.') },
  { k: '/fix', d: 'Build/type-check and fix all errors', run: () => sendText('Run the project\'s build and type-checker/linter, then fix every error and warning you find. Re-run until clean. Report what you changed.') },
  { k: '/explain', d: 'Explain how this codebase works', run: () => sendText('Explain how this codebase works: architecture, main modules and how they interact, data flow, entry points and where to start reading. Use sub-agents to explore in parallel. No changes.') },
  { k: '/plan', d: 'Switch to Plan mode', run: () => { setMode('plan'); persistOpts(); toast('Plan mode: read-only until you approve'); } },
  { k: '/compact', d: 'Summarize the conversation to free context', run: () => compactNow() },
  { k: '/pr', d: 'Open a pull request for this work', run: () => sendText('First check the GitHub CLI: run `gh --version` and `gh auth status`. If gh is missing, stop and tell me to install it (winget install GitHub.cli) and sign in (gh auth login) myself; never ask for or type a token. Then: if I am on the default branch, create a new branch named after the change. Commit the work with a clear message, push the branch, and open a pull request with gh pr create (a short title, and a body that says what changed, why, and how it was verified). Then run gh pr checks and report the PR link and the state of each check. Do not merge.') },
  { k: '/ci', d: 'Read failing CI checks and fix them', run: () => sendText('First check the GitHub CLI: run `gh --version` and `gh auth status`. If gh is missing, stop and tell me to install it (winget install GitHub.cli) and sign in (gh auth login) myself; never ask for or type a token. Then run gh pr checks for this branch. For each failing check, read its log (gh run view <run-id> --log-failed), find the real cause, fix it here, verify locally with the same command, commit and push. Repeat until the checks pass or the failure is clearly not caused by this change; report what you fixed and what is left.') },
  { k: '/commit', d: 'Write a commit message and commit', run: () => { Panels.showSide('scm'); Panels.generateCommitMessage(); } },
  { k: '/new', d: 'Start a new session', run: () => newSession() },
  { k: '/export', d: 'Export this conversation to Markdown', run: () => exportSession('md') },
  { k: '/report', d: 'Export an HTML review report to share', run: () => exportSession('html') },
  { k: '/share', d: 'Export a shareable session file', run: () => exportSession('json') },
  { k: '/worktree', d: 'New parallel session in its own git worktree', run: () => newWorktreeSession() },
  { k: '/mcp', d: 'Manage MCP servers', run: () => Panels.openSettings('tools') },
];
// Built-in commands plus custom ones from .drops/commands/*.md (project) and the user's commands folder.
function allSlash() {
  const builtin = new Set(SLASH.map((c) => c.k));
  const custom = (S.customCommands || []).filter((c) => !builtin.has('/' + c.name)).map((c) => ({
    k: '/' + c.name, d: c.description + (c.source === 'project' ? ' · project' : ' · yours'), needsArgs: c.prompt.includes('$ARGUMENTS'),
    run: (args) => sendText(c.prompt.replace(/\$ARGUMENTS/g, args || '').trim()),
  }));
  return [...SLASH, ...custom];
}
async function loadCustomCommands() { try { S.customCommands = await api.listCommands(S.project); } catch { S.customCommands = []; } }
function sendText(text) { $('#input').value = text; send(); }

async function send(action = 'queue') {
  const t = $('#input');
  const text = t.value.trim();
  if (!text && !S.attachments.length) return;
  const selModel = $('#modelSel').value || '';
  const isLocal = /^(ollama|lmstudio):/.test(selModel) || (selModel === 'auto' && S.settings.ollamaEnabled);
  if (!S.settings.hasKey && !isLocal) { Panels.openSettings(); return; }
  if (!S.project) { await pickProject(); if (!S.project) return; }
  const word = text.split(/\s/)[0];
  const cmd = word.startsWith('/') ? allSlash().find((c) => c.k === word) : null;
  if (cmd && !S.attachments.length) { t.value = ''; autosize(); updateComposer(); cmd.run(text.slice(word.length).trim()); return; }
  let v = currentView();
  if (!v) { await newSession(); v = currentView(); if (!v) return; }
  const images = S.attachments.splice(0);
  renderAttachments();
  t.value = ''; autosize();
  doSend(v, text || 'See the attached image.', images, action);
}
async function doSend(v, text, images, action = 'queue') {
  $('#hero').hidden = true; v.el.hidden = S.current !== v.id;
  const isRunning = v.busy;
  let tagText = null;
  if (isRunning) {
    tagText = action === 'steer' ? 'Steering — delivered at next step' : 'Queued — runs after current task';
  }
  const u = appendUser(v, text, null, images, tagText);
  if (isRunning && action === 'steer') u.querySelector('.tag')?.classList.add('steer');
  if (!isRunning) u.classList.add('pending');
  // Be honest once per session: a small local model is the main limit on how well the agent works.
  const pickedModel = v.id === S.current ? $('#modelSel').value : v.data.model;
  const mi = S.info?.models.find((x) => x.id === pickedModel);
  if (!isRunning && !v.smallWarned && mi?.params && mi.params < 14 && !mi.cloud) {
    v.smallWarned = true;
    place(v, noticeEl('info', `${mi.label.split(' — ')[0]} is a small local model: fine for simple edits, weaker on big or complex projects. For those, pick Auto, Claude or a Gemini Pro model.`));
  }
  autoScroll(v, true);
  if (!isRunning) { v.busy = true; v.started = Date.now(); setWorking(v, true, 'Thinking'); }
  updateComposer();
  const opts = v.id === S.current ? currentOpts() : { model: v.data.model, effort: v.data.effort, mode: v.data.mode };
  Object.assign(v.data, opts);
  if (!isRunning) v.data.messages.push({ role: 'user', content: text });
  const r = await api.send(v.id, text, opts, images, { action });
  if (r?.queued) {
    if (r.task?.task_id) {
      u.dataset.task = r.task.task_id;
      // Like Claude Code: a queued message can still be sent now, to the running agent.
      const now = h('button', 'btn ghost sm send-now'); now.innerHTML = icon('arrowUp', 'xs') + 'Send now';
      now.onclick = async () => { now.disabled = true; const x = await api.taskRunNow(r.task.task_id); if (x?.error) { toast(x.error); now.disabled = false; } else now.remove(); };
      u.appendChild(now);
    }
    toast(`Message queued (#${r.position})`);
    Panels.renderTasks?.();
  } else if (r?.steered) {
    toast('Steering instruction delivered');
    Panels.renderTasks?.();
  } else if (r?.error) {
    v.busy = false; setWorking(v, false); onEvent({ sessionId: v.id, type: 'error', message: r.error }); updateComposer();
  }
}

async function rewind(v, turnIndex) {
  if (v.busy) { toast('Stop the agent first (Esc)'); return; }
  const t = v.data.turns[turnIndex];
  const files = t ? v.data.turns.slice(turnIndex).reduce((n, x) => n + Object.keys(x.files || {}).length, 0) : 0;
  if (!(await confirmBox('Rewind to this message?', `Everything after this message is removed${files ? ` and ${files} file change${files > 1 ? 's' : ''} made since then ${files > 1 ? 'are' : 'is'} restored` : ''}. Your message goes back into the input box so you can edit and resend it.`, 'Rewind'))) return;
  const r = await api.rewind(v.id, turnIndex);
  if (r.error) { toast(r.error); return; }
  v.data = r.session;
  renderHistory(v);
  showCurrent();
  $('#input').value = r.text; autosize(); updateComposer(); $('#input').focus();
  toast((r.restored ? `Rewound · ${r.restored} file${r.restored > 1 ? 's' : ''} restored` : 'Rewound') + (r.kept?.length ? ` · kept your own changes to ${r.kept.join(', ')}` : ''));
  Panels.refreshGitSoon();
}
async function retryTurn(v, turnIndex) {
  if (v.busy) { toast('Wait for the agent to finish'); return; }
  if (turnIndex !== (v.lastTurnIndex ?? v.data.turns.length - 1)) { toast('Only the latest answer can be retried'); return; }
  const r = await api.rewind(v.id, turnIndex);
  if (r.error) { toast(r.error); return; }
  v.data = r.session;
  renderHistory(v);
  showCurrent();
  doSend(v, r.text, []);
}
async function forkSession(v) {
  const r = await api.forkSession(v.id);
  if (r?.error) { toast(r.error); return; }
  await openSession(r.id);
  Panels.renderSessions();
  toast('Forked: a new session with this conversation');
}
async function compactNow() {
  const v = currentView();
  if (!v || v.busy) { toast(v ? 'Wait for the agent to finish' : 'No session'); return; }
  setWorking(v, true, 'Compacting context');
  const r = await api.compact(v.id, currentOpts());
  setWorking(v, false);
  if (r.error) { toast(r.error); return; }
  v.data = r.session;
  renderHistory(v);
  showCurrent();
  toast('Context compacted');
}
async function exportSession(format = 'md') {
  const v = currentView(); if (!v) { toast('Open a session first'); return; }
  const p = await api.exportSession(v.id, format);
  if (p) toast('Exported to ' + baseName(p));
}
async function importSession() {
  const r = await api.importSession();
  if (!r) return;
  if (r.error) { toast(r.error); return; }
  await Panels.renderSessions();
  await openSession(r.id);
  toast('Shared session imported (read-only history; you can continue it)');
}
async function newWorktreeSession() {
  if (!S.project) { toast('Open a git project first'); return; }
  if (!S.git?.isRepo) { toast('Worktrees need a git repository — initialize one in Source control'); return; }
  const label = await promptText('New parallel session', 'Short name for the branch (e.g. add-login)');
  if (!label) return;
  const o = currentOpts();
  const data = await api.newSession(S.project, { model: usableModel(o.model || S.settings.defaultModel), effort: o.effort, mode: o.mode, worktree: true, worktreeLabel: label });
  if (data.error) { toast(data.error); return; }
  const v = makeView(data);
  S.current = v.id;
  await setProject(data.projectDir, true);
  S.current = v.id;
  showCurrent();
  toast(`Working in ${data.worktree.branch} — other sessions keep running on their own branches`);
}
function promptText(title, placeholder) {
  return new Promise((res) => {
    const o = h('div', 'overlay center');
    const m = h('div', 'modal'); m.style.width = 'min(440px, 92vw)';
    m.innerHTML = `<div class="modal-head"><h2>${esc(title)}</h2></div><div class="modal-body" style="padding-top:14px"><input class="input" style="width:100%"></div>`;
    const f = h('div', 'modal-foot'); const no = h('button', 'btn', 'Cancel'); const yes = h('button', 'btn primary', 'Create');
    f.append(no, yes); m.appendChild(f); o.appendChild(m); document.body.appendChild(o);
    const inp = $('input', m); inp.placeholder = placeholder; inp.focus();
    const done = (r) => { o.remove(); res(r); };
    no.onclick = () => done(null); yes.onclick = () => done(inp.value.trim() || null);
    inp.onkeydown = (e) => { if (e.key === 'Enter') done(inp.value.trim() || null); if (e.key === 'Escape') done(null); };
  });
}

// ---------- dialogs ----------
/** Lessons learned: what DROPs remembers from past mistakes. Pending ones are not used until confirmed. */
async function lessonsBox() {
  const o = h('div', 'overlay center');
  const m = h('div', 'modal'); m.style.width = 'min(620px, 94vw)';
  m.innerHTML = '<div class="modal-head"><h2>Lessons learned</h2></div><div class="modal-body lessons-body"></div>';
  const body = $('.lessons-body', m);
  const paint = (list) => {
    body.innerHTML = '';
    body.appendChild(h('p', 'muted', 'DROPs remembers these rules from its past mistakes and applies them in every project. A lesson it noticed by itself stays pending until the same mistake happens again. Remove any rule that is wrong.'));
    if (!list.length) { body.appendChild(h('div', 'empty', 'No lessons yet.')); return; }
    for (const l of list) {
      const r = h('div', 'lesson-row');
      r.innerHTML = `<span class="chip-st ${l.active ? 'on' : ''}"></span><span class="lt"></span><span class="lm"></span><button class="icon-btn" title="Remove">${icon('trash', 'xs')}</button>`;
      $('.chip-st', r).textContent = l.active ? 'Active' : 'Pending';
      $('.lt', r).textContent = l.text;
      $('.lm', r).textContent = `${l.source === 'agent' ? 'written by the agent' : 'noticed automatically'} · seen ${l.count || 1}×`;
      $('button', r).onclick = async () => paint(await api.lessonsRemove(l.text));
      body.appendChild(r);
    }
  };
  paint(await api.lessonsList());
  const f = h('div', 'modal-foot'); const close = h('button', 'btn primary', 'Done'); f.appendChild(close); m.appendChild(f);
  o.appendChild(m); document.body.appendChild(o);
  const done = () => o.remove();
  close.onclick = done; o.onclick = (e) => { if (e.target === o) done(); }; o.onkeydown = (e) => { if (e.key === 'Escape') done(); };
  close.focus();
}

function confirmBox(title, text, okLabel = 'Continue') {
  return new Promise((res) => {
    const o = h('div', 'overlay center');
    const m = h('div', 'modal'); m.style.width = 'min(460px, 92vw)';
    m.innerHTML = `<div class="modal-head"><h2>${esc(title)}</h2></div><div class="modal-body" style="padding-top:14px;color:var(--text-2);white-space:pre-line">${esc(text)}</div>`;
    const f = h('div', 'modal-foot'); const no = h('button', 'btn', 'Cancel'); const yes = h('button', 'btn primary', okLabel);
    f.append(no, yes); m.appendChild(f); o.appendChild(m); document.body.appendChild(o);
    const done = (r) => { o.remove(); res(r); };
    no.onclick = () => done(false); yes.onclick = () => done(true); o.onclick = (e) => { if (e.target === o) done(false); };
    o.onkeydown = (e) => { if (e.key === 'Escape') done(false); };
    yes.focus();
  });
}
let toastTimer;
function toast(msg) {
  let t = $('#toast');
  if (!t) { t = h('div', 'toast'); t.id = 'toast'; document.body.appendChild(t); }
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 2600);
}
