/* DROPs renderer — Monaco-powered editor pane: open/edit files, review diffs. */
'use strict';
const Editor = (() => {
  let monacoP = null, monaco = null, editor = null, diffEditor = null;
  const tabs = [];
  let active = null;
  let theme = document.documentElement.dataset.theme || 'dark';

  function load() {
    if (monacoP) return monacoP;
    monacoP = new Promise((resolve, reject) => {
      window.MonacoEnvironment = { getWorker: () => new Worker('monaco-worker.js') };
      window.require.config({ paths: { vs: '../../node_modules/monaco-editor/min/vs' } });
      window.require(['vs/editor/editor.main'], () => {
        monaco = window.monaco;
        monaco.editor.defineTheme('drops-dark', { base: 'vs-dark', inherit: true, rules: [], colors: { 'editor.background': '#111215', 'editorGutter.background': '#111215', 'diffEditor.insertedTextBackground': '#4ade8022', 'diffEditor.removedTextBackground': '#f8717122', 'editor.lineHighlightBackground': '#ffffff08' } });
        monaco.editor.defineTheme('drops-light', { base: 'vs', inherit: true, rules: [], colors: { 'editor.background': '#ffffff', 'editor.lineHighlightBackground': '#00000006' } });
        resolve(monaco);
      }, reject);
    });
    return monacoP;
  }

  const opts = () => ({
    automaticLayout: true, fontFamily: "'Cascadia Code', Consolas, monospace", fontSize: 13, lineHeight: 20, minimap: { enabled: false },
    scrollBeyondLastLine: false, renderLineHighlight: 'line', smoothScrolling: true, padding: { top: 8 }, theme: theme === 'dark' ? 'drops-dark' : 'drops-light',
    scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 }, stickyScroll: { enabled: true }, bracketPairColorization: { enabled: true },
  });

  async function show() {
    $('#editorPane').hidden = false;
    $('#body').classList.add('has-editor');
    await load();
  }
  function hide() { $('#editorPane').hidden = true; $('#body').classList.remove('has-editor'); }

  function renderTabs() {
    const bar = $('#edTabs'); bar.innerHTML = '';
    for (const t of tabs) {
      const el = h('div', 'ed-tab' + (t === active ? ' on' : ''));
      el.innerHTML = `${t.kind === 'diff' ? '<span class="kind">diff</span>' : ''}<span class="t"></span>${t.dirty ? '<span class="dirty"></span>' : ''}<button class="x" title="Close">${icon('x', 'xs')}</button>`;
      $('.t', el).textContent = baseName(t.rel);
      el.title = t.rel + (t.kind === 'diff' ? ` — ${t.label}` : '');
      el.onclick = (e) => { if (!e.target.closest('.x')) activate(t); };
      $('.x', el).onclick = (e) => { e.stopPropagation(); close(t); };
      bar.appendChild(el);
    }
  }

  function renderBar() {
    const t = active;
    $('#edPath').textContent = t ? `${t.rel}${t.kind === 'diff' ? `  ·  ${t.label}` : ''}` : '';
    const acts = $('#edActions'); acts.innerHTML = '';
    if (!t) return;
    if (t.kind === 'file') {
      const save = h('button', 'btn sm ghost'); save.innerHTML = icon('save', 'xs') + 'Save'; save.title = 'Save (Ctrl+S)'; save.disabled = !t.dirty; save.onclick = () => saveActive();
      const ask = h('button', 'btn sm ghost'); ask.innerHTML = icon('at', 'xs') + 'Mention'; ask.title = 'Mention this file (and selection) in chat'; ask.onclick = () => mentionActive();
      acts.append(ask, save);
    } else {
      const open = h('button', 'btn sm ghost'); open.innerHTML = icon('fileCode', 'xs') + 'Open file'; open.onclick = () => openFile(t.rel);
      acts.append(open);
    }
    const ext = h('button', 'btn sm ghost'); ext.innerHTML = icon('external', 'xs'); ext.title = 'Open in default app'; ext.onclick = () => api.openPath(S.project, t.rel);
    acts.append(ext);
  }

  function mountFor(t) {
    const host = $('#edHost');
    host.querySelector('.loading')?.remove();
    if (t.kind === 'file') {
      if (diffEditor) { diffEditor.getContainerDomNode().style.display = 'none'; }
      if (!editor) {
        const div = h('div'); div.style.cssText = 'position:absolute;inset:0'; host.appendChild(div);
        editor = monaco.editor.create(div, { ...opts(), model: null });
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveActive());
      }
      editor.getContainerDomNode().style.display = '';
      editor.setModel(t.model);
      if (t.viewState) editor.restoreViewState(t.viewState);
      editor.focus();
    } else {
      if (editor) editor.getContainerDomNode().style.display = 'none';
      if (!diffEditor) {
        const div = h('div'); div.style.cssText = 'position:absolute;inset:0'; host.appendChild(div);
        diffEditor = monaco.editor.createDiffEditor(div, { ...opts(), readOnly: true, originalEditable: false, renderSideBySide: host.clientWidth > 760, hideUnchangedRegions: { enabled: true }, renderOverviewRuler: false });
      }
      diffEditor.getContainerDomNode().style.display = '';
      diffEditor.updateOptions({ renderSideBySide: host.clientWidth > 760 });
      diffEditor.setModel({ original: t.original, modified: t.modified });
    }
  }

  function activate(t) {
    if (active?.kind === 'file' && editor) active.viewState = editor.saveViewState();
    active = t;
    renderTabs(); renderBar();
    if (t) mountFor(t); else hide();
  }
  function close(t) {
    if (t.dirty && !confirm(`Discard unsaved changes to ${baseName(t.rel)}?`)) return;
    const i = tabs.indexOf(t);
    tabs.splice(i, 1);
    t.model?.dispose(); t.original?.dispose(); t.modified?.dispose();
    if (active === t) { active = null; activate(tabs[Math.min(i, tabs.length - 1)] || null); }
    else renderTabs();
    if (!tabs.length) hide();
  }

  async function openFile(rel, line = 0) {
    if (!S.project) return;
    rel = rel.replace(/\\/g, '/').replace(/^\.\//, '');
    await show();
    let t = tabs.find((x) => x.kind === 'file' && x.rel === rel);
    if (!t) {
      const r = await api.readFile(S.project, rel).catch((e) => ({ error: e.message }));
      if (r.error) { toast(`${baseName(rel)}: ${r.error.replace(/^Error invoking remote method[^:]*: (Error: )?/, '')}`); if (!tabs.length) hide(); return; }
      const uri = monaco.Uri.file('/drops/' + rel);
      const model = monaco.editor.getModel(uri) || monaco.editor.createModel(r.content, undefined, uri);
      t = { kind: 'file', rel, model, dirty: false, saved: model.getAlternativeVersionId() };
      model.onDidChangeContent(() => { const d = model.getAlternativeVersionId() !== t.saved; if (d !== t.dirty) { t.dirty = d; renderTabs(); renderBar(); } });
      tabs.push(t);
    }
    activate(t);
    if (line) { editor.revealLineInCenter(line); editor.setPosition({ lineNumber: line, column: 1 }); }
  }

  async function openDiff(rel, original, modified, label) {
    await show();
    const key = `${label}:${rel}`;
    let t = tabs.find((x) => x.kind === 'diff' && x.key === key);
    const lang = monaco.languages.getLanguages().find((l) => (l.extensions || []).some((e) => rel.toLowerCase().endsWith(e)))?.id;
    if (t) { t.original.setValue(original); t.modified.setValue(modified); }
    else {
      t = { kind: 'diff', key, rel, label, original: monaco.editor.createModel(original, lang), modified: monaco.editor.createModel(modified, lang) };
      tabs.push(t);
    }
    activate(t);
  }
  async function openSessionDiff(rel) {
    const v = currentView();
    if (!v || !S.project) return;
    const b = await api.baseline(v.id, rel);
    const cur = await api.readFile(S.project, rel).catch(() => ({ content: '' }));
    if (!b.found) { const g = await api.gitVersions(S.project, rel); return openDiff(rel, g.original, cur.content || '', 'vs HEAD'); }
    return openDiff(rel, b.content ?? '', cur.content ?? '', 'session changes');
  }
  async function openGitDiff(rel) {
    if (!S.project) return;
    const g = await api.gitVersions(S.project, rel);
    return openDiff(rel, g.original, g.modified, 'vs HEAD');
  }

  async function saveActive() {
    const t = active;
    if (!t || t.kind !== 'file' || !t.dirty) return;
    await api.writeFile(S.project, t.rel, t.model.getValue());
    t.saved = t.model.getAlternativeVersionId(); t.dirty = false;
    renderTabs(); renderBar();
    toast(`Saved ${baseName(t.rel)}`);
    Panels.refreshGitSoon();
  }
  function mentionActive() {
    const t = active; if (!t) return;
    const sel = editor?.getSelection();
    let s = `@${t.rel}`;
    if (sel && !sel.isEmpty()) s += `:${sel.startLineNumber}-${sel.endLineNumber}`;
    insertAtCursor(s + ' ');
  }
  async function reloadFile(rel) {
    rel = rel.replace(/\\/g, '/');
    for (const t of tabs) {
      if (t.rel !== rel) continue;
      if (t.kind === 'file' && !t.dirty) {
        const r = await api.readFile(S.project, rel).catch(() => null);
        if (r?.content != null && r.content !== t.model.getValue()) { t.model.setValue(r.content); t.saved = t.model.getAlternativeVersionId(); t.dirty = false; }
      } else if (t.kind === 'diff') {
        const r = await api.readFile(S.project, rel).catch(() => null);
        if (r?.content != null) t.modified.setValue(r.content);
      }
    }
  }
  function setTheme(t) { theme = t; if (monaco) monaco.editor.setTheme(t === 'dark' ? 'drops-dark' : 'drops-light'); }
  function closeAll() { [...tabs].forEach((t) => { t.dirty = false; close(t); }); }

  $('#edClose').onclick = () => hide();
  return { openFile, openSessionDiff, openGitDiff, reloadFile, setTheme, hide, closeAll, isOpen: () => !$('#editorPane').hidden };
})();
