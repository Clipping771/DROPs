/* DROPs renderer — startup, composer popups and keyboard shortcuts. */
'use strict';

// ---------- composer popup: slash commands + @ mentions ----------
const Pop = { open: false, items: [], idx: 0, kind: null, start: 0, seq: 0 };
function closePop() { Pop.open = false; $('#popup').hidden = true; }
function drawPop() {
  const p = $('#popup');
  p.hidden = !Pop.open; p.innerHTML = '';
  Pop.items.forEach((it, i) => {
    const d = h('div', 'opt' + (i === Pop.idx ? ' on' : ''));
    if (Pop.kind === 'slash') d.innerHTML = `${icon('slash', 'xs')}<span class="k"></span><span class="d"></span>`;
    else d.innerHTML = `${icon('file', 'xs')}<span class="k"></span><span class="d"></span>`;
    $('.k', d).textContent = Pop.kind === 'slash' ? it.k : baseName(it);
    $('.d', d).textContent = Pop.kind === 'slash' ? it.d : it;
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
  const f = Pop.items[i];
  t.value = t.value.slice(0, Pop.start) + '@' + f + ' ' + t.value.slice(t.selectionStart);
  t.selectionStart = t.selectionEnd = Pop.start + f.length + 2;
  closePop(); autosize(); updateComposer();
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
  const my = ++Pop.seq;
  setTimeout(async () => {
    if (my !== Pop.seq) return;
    const res = await api.searchFiles(S.project, m[1]);
    if (my !== Pop.seq) return;
    Pop.items = res.slice(0, 12); Pop.idx = 0; Pop.open = Pop.items.length > 0; drawPop();
  }, 80);
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
    // Alt+Enter while the agent works: tell it now (steer). Enter: queue the message for after the task.
    if (e.key === 'Enter' && e.altKey && currentView()?.busy) { e.preventDefault(); send('steer'); return; }
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
  $$('#inspTabs button').forEach((b) => (b.onclick = () => Panels.switchTab(b.dataset.tab)));
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
    else if (e.ctrlKey && !e.shiftKey && k === 'b') { e.preventDefault(); $('#body').classList.toggle('no-side'); }
    else if (e.ctrlKey && !e.shiftKey && k === 'j') { e.preventDefault(); toggleInspector(); }
    else if (e.ctrlKey && e.shiftKey && k === 'l') { e.preventDefault(); toggleTheme(); }
    else if (e.ctrlKey && !e.shiftKey && k === 'l') { e.preventDefault(); $('#input').focus(); }
    else if (e.key === 'Escape' && !document.querySelector('.overlay, .settings-page')) { const v = currentView(); if (v?.busy) api.stop(v.id); }
  });

  if (S.settings.lastProject && S.settings.restoreLastProject !== false) await setProject(S.settings.lastProject);
  else { await Panels.loadTree(); await Panels.renderSessions(); showCurrent(); }
  if (!S.settings.hasKey) setTimeout(() => Panels.openSettings(), 300);
  t.focus();
}
init();
