/* DROPs renderer — startup, composer popups and keyboard shortcuts. */
'use strict';

// ---------- composer popup: slash commands + @ mentions ----------
const Pop = { open: false, items: [], idx: 0, kind: null, start: 0, seq: 0 };
function closePop() { Pop.open = false; $('#popup').hidden = true; }
const SPECIAL_MENTIONS = [
  { k: 'git', d: 'Current git status & recent commits', ic: 'branch' },
  { k: 'diff', d: 'Uncommitted git diff changes', ic: 'diff' },
  { k: 'errors', d: 'Project TypeScript/JS errors', ic: 'alert' },
  { k: 'terminal', d: 'Background process output logs', ic: 'terminal' },
  { k: 'codebase', d: 'Relevant files for your prompt', ic: 'search' },
  { k: 'folder:', d: 'List files in a folder (e.g. @folder:src)', ic: 'folder', keepOpen: true },
  { k: 'url:', d: 'Fetch a web page or docs URL', ic: 'globe', keepOpen: true },
];
function drawPop() {
  const p = $('#popup');
  p.hidden = !Pop.open; p.innerHTML = '';
  Pop.items.forEach((it, i) => {
    const d = h('div', 'opt' + (i === Pop.idx ? ' on' : ''));
    if (Pop.kind === 'slash') {
      d.innerHTML = `${icon('slash', 'xs')}<span class="k"></span><span class="d"></span>`;
      $('.k', d).textContent = it.k;
      $('.d', d).textContent = it.d;
    } else if (typeof it === 'object' && it.k) {
      d.innerHTML = `${icon(it.ic || 'sparkle', 'xs')}<span class="k"></span><span class="d"></span>`;
      $('.k', d).textContent = '@' + it.k;
      $('.d', d).textContent = it.d;
    } else {
      d.innerHTML = `${icon('file', 'xs')}<span class="k"></span><span class="d"></span>`;
      $('.k', d).textContent = baseName(it);
      $('.d', d).textContent = it;
    }
    d.onmousedown = (e) => { e.preventDefault(); pickPop(i); };
    p.appendChild(d);
  });
}
function pickPop(i) {
  const t = $('#input');
  if (Pop.kind === 'slash') {
    const c = Pop.items[i];
    // Commands that take arguments ($ARGUMENTS) wait for the user to type them.
    if (c.needsArgs) { t.value = c.k + ' '; closePop(); autosize(); updateComposer(); t.focus(); return; }
    t.value = ''; closePop(); autosize(); updateComposer(); c.run('');
    return;
  }
  const item = Pop.items[i];
  const f = typeof item === 'object' && item.k ? item.k : item;
  const suffix = typeof item === 'object' && item.keepOpen ? '' : ' ';
  t.value = t.value.slice(0, Pop.start) + '@' + f + suffix + t.value.slice(t.selectionStart);
  t.selectionStart = t.selectionEnd = Pop.start + f.length + 1 + suffix.length;
  closePop(); autosize(); updateComposer();
  if (typeof item === 'object' && item.keepOpen) t.focus();
}
function checkPop() {
  const t = $('#input');
  const before = t.value.slice(0, t.selectionStart);
  if (/^\/\S*$/.test(t.value) && t.selectionStart === t.value.length) {
    const q = t.value.toLowerCase();
    Pop.kind = 'slash'; Pop.items = allSlash().filter((c) => c.k.startsWith(q)); Pop.idx = 0; Pop.open = Pop.items.length > 0; drawPop();
    return;
  }
  const m = before.match(/(?:^|\s)@([^\s@]*)$/);
  if (!m || !S.project) return closePop();
  Pop.kind = 'file'; Pop.start = t.selectionStart - m[1].length - 1;
  const q = m[1].toLowerCase();
  const specials = SPECIAL_MENTIONS.filter((s) => s.k.startsWith(q));
  const my = ++Pop.seq;
  setTimeout(async () => {
    if (my !== Pop.seq) return;
    const res = await api.searchFiles(S.project, m[1]);
    if (my !== Pop.seq) return;
    Pop.items = [...specials, ...res].slice(0, 12); Pop.idx = 0; Pop.open = Pop.items.length > 0; drawPop();
  }, 80);
}

// ---------- notices at the top (crash after the last run, a new version) ----------
function showBanner(id, html, actions) {
  document.getElementById(id)?.remove();
  const b = h('div', 'top-banner'); b.id = id; b.setAttribute('role', 'status');
  b.innerHTML = `<span class="tb-text">${html}</span><span class="tb-acts"></span>`;
  for (const [label, run, primary] of actions) {
    const btn = h('button', 'btn sm' + (primary ? ' primary' : ' ghost'), label);
    btn.onclick = async () => { if ((await run()) !== false) b.remove(); };
    $('.tb-acts', b).appendChild(btn);
  }
  document.body.appendChild(b);
}
// Errors in this window go to the local crash reports (nothing is uploaded).
window.addEventListener('error', (e) => { api.crashRenderer?.({ message: e.message, stack: e.error?.stack || `${e.filename}:${e.lineno}` }); });
window.addEventListener('unhandledrejection', (e) => { api.crashRenderer?.({ message: String(e.reason?.message || e.reason), stack: e.reason?.stack || '' }); });
async function startupNotices() {
  const c = await api.crashLast?.().catch(() => null);
  if (c) {
    const what = c.kind === 'unclean-exit' ? 'DROPs did not close normally last time.' : `DROPs recorded ${c.count > 1 ? `${c.count} errors` : 'an error'} since you last looked.`;
    showBanner('crashBanner', `${icon('alert', 'sm')}${esc(what)} Your sessions are saved. A report is kept on this computer only.`, [
      ['Open reports', async () => { await api.crashOpenFolder(); await api.crashSeen(); }],
      ['Dismiss', () => api.crashSeen(), true],
    ]);
  }
  api.onUpdate?.((r) => showUpdate(r));
}
function showUpdate(r) {
  const canInstall = !!r.installer && S.info?.platform === 'win32';
  showBanner('updateBanner', `${icon('download', 'sm')}DROPs ${esc(r.version)} is available (you have ${esc(r.current)}).`, [
    ['Later', () => api.updateDismiss(r.version)],
    canInstall ? ['Release notes', () => { api.updateOpen(r.url); return false; }] : null,
    canInstall ? ['Install and restart', installUpdate, true] : ['Download', () => api.updateOpen(r.url), true],
  ].filter(Boolean));
}
// Downloads the installer, checks it, starts it and closes DROPs; on any problem, offers the releases page.
async function installUpdate() {
  toast('Downloading the update…');
  const off = api.onUpdateProgress?.((p) => { if (p.percent >= 0) toast(`Downloading the update… ${p.percent}%`); });
  const r = await api.updateInstall().catch((e) => ({ error: e.message }));
  off?.();
  if (r?.ok) { toast('Starting the installer. DROPs will close.'); return true; }
  toast(`Could not install the update: ${r?.error || 'unknown error'}`);
  if (r?.url) api.updateOpen(r.url);
  return true;
}
async function checkForUpdatesNow() {
  toast('Checking for updates…');
  const r = await api.updateCheck();
  if (r?.error) toast(`Could not check for updates: ${r.error}`);
  else if (r?.available) showUpdate(r);
  else toast(`DROPs is up to date (${S.info?.version || r?.current || ''}).`);
}

// ---------- init ----------
async function init() {
  hydrateIcons();
  S.settings = await api.getSettings();
  S.info = await api.info();
  applyThemeAttr(S.info.theme || 'dark');
  applyAppearance(S.settings);
  applySendKey();
  await reloadModels();
  const eff = $('#effortSel');
  for (const e of S.info.efforts) { const o = h('option', '', e); o.value = e; eff.appendChild(o); }
  eff.value = S.settings.effort || 'high';
  setMode(S.settings.mode || 'ask');
  syncPills();

  api.onEvent(onEvent);
  // Screen readers: a button that shows only an icon gets its tooltip as its name, including buttons
  // added later (the UI is built on the fly).
  const nameIconButtons = (root) => {
    for (const b of root.querySelectorAll?.('button[title]:not([aria-label]), [role="button"][title]:not([aria-label])') || []) {
      if (!b.textContent.trim()) b.setAttribute('aria-label', b.getAttribute('title'));
    }
  };
  nameIconButtons(document);
  new MutationObserver((muts) => { for (const m of muts) for (const n of m.addedNodes) if (n.nodeType === 1) nameIconButtons(n.parentElement || n); })
    .observe(document.body, { childList: true, subtree: true });
  api.onSchedule?.((ev) => { toast(`Scheduled task started: ${ev.name}`); Panels.renderSessions(); Panels.renderTasks(); });
  api.onTheme((t) => applyThemeAttr(t));
  document.documentElement.dataset.platform = S.info.platform || 'win32';
  S.mcp = await api.mcpStatus();
  api.onMcp((st) => { S.mcp = st; Panels.renderStatus(); });

  const t = $('#input');
  t.addEventListener('input', () => { autosize(); updateComposer(); checkPop(); });
  t.addEventListener('keydown', (e) => {
    if (Pop.open) {
      if (e.key === 'ArrowDown') { Pop.idx = (Pop.idx + 1) % Pop.items.length; drawPop(); e.preventDefault(); return; }
      if (e.key === 'ArrowUp') { Pop.idx = (Pop.idx - 1 + Pop.items.length) % Pop.items.length; drawPop(); e.preventDefault(); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { pickPop(Pop.idx); e.preventDefault(); return; }
      if (e.key === 'Escape') { closePop(); e.preventDefault(); e.stopPropagation(); return; }
    }
    // While the agent works (like Claude Code): the send key delivers the message now, at the agent's
    // next step; Ctrl+Enter (or Alt+Enter) queues it for after the current task.
    if (e.key === 'Enter' && !e.shiftKey && currentView()?.busy) {
      const queue = sendWithCtrl() ? e.altKey : (e.ctrlKey || e.altKey);
      const sendKey = sendWithCtrl() ? e.ctrlKey : !e.ctrlKey && !e.altKey;
      if (queue || sendKey) { e.preventDefault(); send(queue ? 'queue' : 'steer'); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey && (sendWithCtrl() ? e.ctrlKey : !e.ctrlKey)) { e.preventDefault(); send(); }
    if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault();
      const modes = ['plan', 'ask', 'auto-edit', 'yolo'];
      setMode(modes[(modes.indexOf(currentOpts().mode) + 1) % modes.length]); persistOpts();
    }
  });
  t.addEventListener('blur', () => setTimeout(closePop, 150));
  t.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
    if (files.length) { e.preventDefault(); files.forEach(addImageFile); }
  });
  const comp = $('#composer');
  comp.addEventListener('dragover', (e) => { e.preventDefault(); comp.classList.add('drag'); });
  comp.addEventListener('dragleave', () => comp.classList.remove('drag'));
  comp.addEventListener('drop', (e) => { e.preventDefault(); comp.classList.remove('drag'); [...e.dataTransfer.files].forEach(addImageFile); });
  $('#attachBtn').onclick = () => $('#fileInput').click();
  $('#fileInput').onchange = (e) => { [...e.target.files].forEach(addImageFile); e.target.value = ''; };

  $('#sendBtn').onclick = send;
  $('#stopBtn').onclick = () => { const v = currentView(); if (v) api.stop(v.id); };
  $('#newSessionBtn').onclick = newSession;
  $('#newWorktreeBtn').onclick = newWorktreeSession;
  $('#projectBtn').onclick = pickProject;
  $('#branchBtn').onclick = () => Panels.showSide('scm');
  $('#paletteBtn').onclick = () => Panels.openPalette();
  $('#themeBtn').onclick = toggleTheme;
  // Quick buttons in the title bar: open the right place in one click (the inspector opens if hidden).
  const openInsp = (tab) => { const b = $('#body'); const hidden = window.innerWidth <= 1280 ? !b.classList.contains('force-insp') : b.classList.contains('no-insp'); if (hidden) toggleInspector(); Panels.switchTab(tab); };
  $('#qbFiles').onclick = () => Panels.showSide('explorer');
  $('#qbChanges').onclick = () => openInsp('changes');
  $('#qbProcs').onclick = () => openInsp('terminal');
  $('#inspToggle').onclick = toggleInspector;
  $('#inspToggle').classList.add('on');
  $('#railSettings').onclick = () => Panels.openSettings();
  $('#refreshTree').onclick = () => Panels.loadTree();
  $('#refreshGit').onclick = () => Panels.refreshGit();
  $$('.rail button[data-view]').forEach((b) => (b.onclick = () => Panels.showSide(b.dataset.view)));
  // Right-panel tabs: an icon each, and the name only on the open tab (all six fit any panel width).
  const TAB_ICONS = { plan: 'layers', tasks: 'list', changes: 'diff', terminal: 'terminal', browser: 'globe', usage: 'gauge' };
  $$('#inspTabs button').forEach((b) => {
    const badge = b.querySelector('.badge');
    const label = [...b.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim();
    b.title = label; b.setAttribute('aria-label', label);
    b.innerHTML = `${icon(TAB_ICONS[b.dataset.tab] || 'list', 'sm')}<span class="lbl"></span>`;
    b.querySelector('.lbl').textContent = label;
    if (badge) b.appendChild(badge);
    b.onclick = () => Panels.switchTab(b.dataset.tab);
  });
  let lastModel = $('#modelSel').value, lastRefresh = 0;
  $('#modelSel').onchange = async () => {
    const sel = $('#modelSel');
    if (sel.value === '__ollama:stopped') {
      sel.value = lastModel; syncPills();
      toast('Starting Ollama…');
      const r = await api.ollamaStart();
      await reloadModels();
      toast(r.ok ? (r.models ? `Ollama started — ${r.models} local model${r.models > 1 ? 's' : ''} available` : 'Ollama started, but no models yet — run: ollama pull qwen3') : r.error);
      return;
    }
    if (sel.value.startsWith('__')) { sel.value = lastModel; syncPills(); return; }
    lastModel = sel.value;
    persistOpts();
  };
  // Refresh the list when the window regains focus, so models from a just-started Ollama show up.
  window.addEventListener('focus', () => { if (Date.now() - lastRefresh > 4000) { lastRefresh = Date.now(); reloadModels(); } });
  $('#effortSel').onchange = persistOpts;
  $$('#modeSeg button').forEach((b) => (b.onclick = () => { setMode(b.dataset.mode); persistOpts(); }));
  $('#optsBtn').onclick = openOptsMenu;

  document.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if (e.ctrlKey && !e.shiftKey && k === 'k') { e.preventDefault(); Panels.openPalette(); }
    else if (e.ctrlKey && e.shiftKey && k === 'p') { e.preventDefault(); Panels.openPalette(); }
    else if (e.ctrlKey && !e.shiftKey && k === 'n') { e.preventDefault(); newSession(); }
    else if (e.ctrlKey && k === ',') { e.preventDefault(); Panels.openSettings(); }
    else if (e.ctrlKey && !e.shiftKey && k === 'o') { e.preventDefault(); pickProject(); }
    else if (e.ctrlKey && !e.shiftKey && k === '\\') { e.preventDefault(); if (S.split) setSplit(null); else openSplitPicker(); }
    else if (e.ctrlKey && !e.shiftKey && k === 'b') { e.preventDefault(); $('#body').classList.toggle('no-side'); }
    else if (e.ctrlKey && !e.shiftKey && k === 'j') { e.preventDefault(); toggleInspector(); }
    else if (e.ctrlKey && e.shiftKey && k === 'l') { e.preventDefault(); toggleTheme(); }
    else if (e.ctrlKey && !e.shiftKey && k === 'l') { e.preventDefault(); $('#input').focus(); }
    else if (e.key === 'Escape' && !document.querySelector('.overlay, .settings-page')) { const v = currentView(); if (v?.busy) api.stop(v.id); }
  });

  if (S.settings.lastProject && S.settings.restoreLastProject !== false) await setProject(S.settings.lastProject);
  else { await Panels.loadTree(); await Panels.renderSessions(); showCurrent(); }
  window.applyI18n?.(S.settings.uiLanguage || 'en');
  if (!S.settings.hasKey) setTimeout(() => Panels.openSettings(), 300);
  startupNotices();
  t.focus();
}
init();
