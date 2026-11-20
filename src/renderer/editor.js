/* DROPs renderer — Monaco-powered editor pane: open/edit files, review diffs, inline AI edit. */
'use strict';
const Editor = (() => {
  let monacoP = null, monaco = null, editor = null, diffEditor = null;
  const tabs = [];
  let active = null;
  let theme = document.documentElement.dataset.theme || 'dark';
  let diffSideBySide = null; // null = auto by width, true/false = user override
  let aiSeq = 0;

  const projSlug = () => String(S.project || 'default').replace(/[^a-zA-Z0-9_-]/g, '_').slice(-48);

  function load() {
    if (monacoP) return monacoP;
    monacoP = new Promise((resolve, reject) => {
      window.MonacoEnvironment = { getWorker: () => new Worker('monaco-worker.js') };
      window.require.config({ paths: { vs: '../../node_modules/monaco-editor/min/vs' } });
      window.require(['vs/editor/editor.main'], () => {
        monaco = window.monaco;
        monaco.editor.defineTheme('drops-dark', {
          base: 'vs-dark',
          inherit: true,
          rules: [],
          colors: {
            'editor.background': '#0b0c0f',
            'editorGutter.background': '#0b0c0f',
            'editorLineNumber.foreground': '#5b6372',
            'diffEditor.insertedTextBackground': '#3fb95020',
            'diffEditor.removedTextBackground': '#f8514920',
            'editor.lineHighlightBackground': '#ffffff07',
          },
        });
        monaco.editor.defineTheme('drops-light', {
          base: 'vs',
          inherit: true,
          rules: [],
          colors: {
            'editor.background': '#ffffff',
            'editorGutter.background': '#ffffff',
            'editorLineNumber.foreground': '#8c959f',
            'diffEditor.insertedTextBackground': '#1a7f371a',
            'diffEditor.removedTextBackground': '#cf222e18',
            'editor.lineHighlightBackground': '#0f172a08',
          },
        });
        resolve(monaco);
      }, reject);
    });
    return monacoP;
  }

  const opts = () => ({
    automaticLayout: true,
    fontFamily: "'Cascadia Mono', 'Cascadia Code', Consolas, monospace",
    fontLigatures: false,
    fontSize: 13,
    lineHeight: 20,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    renderLineHighlight: 'line',
    smoothScrolling: true,
    padding: { top: 8 },
    theme: theme === 'dark' ? 'drops-dark' : 'drops-light',
    scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
    stickyScroll: { enabled: true },
    bracketPairColorization: { enabled: true },
  });

  async function show() {
    $('#editorPane').hidden = false;
    $('#body').classList.add('has-editor');
    await load();
  }
  function hide() {
    aiSeq++;
    $('#edInlineAi')?.remove();
    $('#edAiReview')?.remove();
    $('#editorPane').hidden = true;
    $('#body').classList.remove('has-editor');
  }

  function renderTabs() {
    const bar = $('#edTabs'); bar.innerHTML = '';
    for (const t of tabs) {
      const el = h('div', 'ed-tab' + (t === active ? ' on' : ''));
      el.innerHTML = `${t.kind === 'diff' ? '<span class="kind">diff</span>' : ''}<span class="t"></span>${t.dirty ? '<span class="dirty"></span>' : ''}<button type="button" class="x" title="Close">${icon('x', 'xs')}</button>`;
      $('.t', el).textContent = baseName(t.rel);
      el.title = t.rel + (t.kind === 'diff' ? ` — ${t.label}` : '');
      el.onclick = (e) => { if (!e.target.closest('.x')) activate(t); };
      $('.x', el).onclick = (e) => { e.stopPropagation(); close(t); };
      bar.appendChild(el);
    }
  }

  function updateCursorPos() {
    const posEl = $('#edPos');
    if (!posEl) return;
    if (active?.kind === 'file' && editor) {
      const p = editor.getPosition();
      posEl.textContent = p ? `Ln ${p.lineNumber}, Col ${p.column}` : '';
    } else {
      posEl.textContent = '';
    }
  }

  function effectiveSideBySide() {
    if (diffSideBySide !== null) return diffSideBySide;
    const host = $('#edHost');
    return (host?.clientWidth || 0) > 740;
  }

  function renderBar() {
    const t = active;
    $('#edPath').textContent = t ? `${t.rel}${t.kind === 'diff' ? `  ·  ${t.label}` : ''}` : '';
    const acts = $('#edActions'); acts.innerHTML = '';
    if (!t) return;
    const pos = h('span', 'ed-pos'); pos.id = 'edPos';
    acts.appendChild(pos);
    if (t.kind === 'file') {
      const save = h('button', 'btn sm ghost'); save.innerHTML = icon('save', 'xs') + 'Save'; save.title = 'Save (Ctrl+S)'; save.disabled = !t.dirty; save.onclick = () => saveActive();
      const ai = h('button', 'btn sm ghost'); ai.innerHTML = icon('sparkles', 'xs') + 'AI Edit'; ai.title = 'Inline AI Edit (Ctrl+K)'; ai.onclick = () => openInlineAi();
      const ask = h('button', 'btn sm ghost'); ask.innerHTML = icon('at', 'xs') + 'Mention'; ask.title = 'Mention this file (and selection) in chat'; ask.onclick = () => mentionActive();
      acts.append(ai, ask, save);
    } else {
      const sbs = h('button', 'btn sm ghost');
      const isSbs = effectiveSideBySide();
      sbs.innerHTML = icon('columns', 'xs') + (isSbs ? 'Inline' : 'Split');
      sbs.title = 'Toggle side-by-side vs inline diff';
      sbs.onclick = () => {
        diffSideBySide = !effectiveSideBySide();
        diffEditor?.updateOptions({ renderSideBySide: diffSideBySide });
        renderBar();
      };
      const open = h('button', 'btn sm ghost'); open.innerHTML = icon('fileCode', 'xs') + 'Open file'; open.onclick = () => openFile(t.rel);
      acts.append(sbs, open);
    }
    const copyP = h('button', 'btn sm ghost'); copyP.innerHTML = icon('copy', 'xs'); copyP.title = 'Copy relative path';
    copyP.onclick = () => { navigator.clipboard.writeText(t.rel); toast(`Copied ${t.rel}`); };
    const ext = h('button', 'btn sm ghost'); ext.innerHTML = icon('external', 'xs'); ext.title = 'Open in default app'; ext.onclick = () => api.openPath(S.project, t.rel);
    acts.append(copyP, ext);
    updateCursorPos();
  }

  let resizeObsBound = false;
  function mountFor(t) {
    const host = $('#edHost');
    host.querySelector('.loading')?.remove();
    if (!resizeObsBound && typeof ResizeObserver !== 'undefined') {
      resizeObsBound = true;
      new ResizeObserver(() => {
        if (active?.kind === 'diff' && diffEditor && diffSideBySide === null) {
          diffEditor.updateOptions({ renderSideBySide: effectiveSideBySide() });
        }
      }).observe(host);
    }
    if (t.kind === 'file') {
      if (diffEditor) { diffEditor.getContainerDomNode().style.display = 'none'; }
      if (!editor) {
        const div = h('div'); div.style.cssText = 'position:absolute;inset:0'; host.appendChild(div);
        editor = monaco.editor.create(div, { ...opts(), model: null });
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveActive());
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyK, () => openInlineAi());
        editor.onDidChangeCursorPosition(() => updateCursorPos());
      }
      editor.getContainerDomNode().style.display = '';
      editor.setModel(t.model);
      if (t.viewState) editor.restoreViewState(t.viewState);
      updateCursorPos();
      editor.focus();
    } else {
      if (editor) editor.getContainerDomNode().style.display = 'none';
      if (!diffEditor) {
        const div = h('div'); div.style.cssText = 'position:absolute;inset:0'; host.appendChild(div);
        diffEditor = monaco.editor.createDiffEditor(div, { ...opts(), readOnly: true, originalEditable: false, renderSideBySide: effectiveSideBySide(), hideUnchangedRegions: { enabled: true }, renderOverviewRuler: false });
      }
      diffEditor.getContainerDomNode().style.display = '';
      diffEditor.updateOptions({ renderSideBySide: effectiveSideBySide() });
      diffEditor.setModel({ original: t.original, modified: t.modified });
    }
  }

  function activate(t) {
    aiSeq++;
    $('#edInlineAi')?.remove();
    $('#edAiReview')?.remove();
    if (active?.kind === 'file' && editor) active.viewState = editor.saveViewState();
    active = t;
    renderTabs(); renderBar();
    if (t) mountFor(t); else hide();
  }

  function detachAndDispose(t) {
    try {
      if (t.kind === 'diff' && diffEditor) {
        const cur = diffEditor.getModel?.();
        if (!cur || cur.original === t.original || cur.modified === t.modified) {
          diffEditor.setModel(null);
        }
      }
      if (t.kind === 'file' && editor && editor.getModel?.() === t.model) {
        editor.setModel(null);
      }
    } catch { /* ignore detach race */ }
    try { t.model?.dispose(); } catch { /* ignore */ }
    try { t.original?.dispose(); } catch { /* ignore */ }
    try { t.modified?.dispose(); } catch { /* ignore */ }
  }

  async function close(t, force = false) {
    if (!force && t.dirty) {
      const ok = typeof confirmBox === 'function'
        ? await confirmBox(`Discard changes to ${baseName(t.rel)}?`, 'Your unsaved edits in this tab will be lost.', 'Discard')
        : confirm(`Discard unsaved changes to ${baseName(t.rel)}?`);
      if (!ok) return;
    }
    const i = tabs.indexOf(t);
    if (i < 0) return;
    tabs.splice(i, 1);
    const wasActive = active === t;
    if (wasActive) active = null;
    detachAndDispose(t);
    if (wasActive) activate(tabs[Math.min(i, tabs.length - 1)] || null);
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
      const uri = monaco.Uri.file(`/drops/${projSlug()}/${rel}`);
      const existing = monaco.editor.getModel(uri);
      if (existing) existing.setValue(r.content);
      const model = existing || monaco.editor.createModel(r.content, undefined, uri);
      t = { kind: 'file', rel, model, dirty: false, saved: model.getAlternativeVersionId() };
      model.onDidChangeContent(() => { const d = model.getAlternativeVersionId() !== t.saved; if (d !== t.dirty) { t.dirty = d; renderTabs(); renderBar(); } });
      tabs.push(t);
    }
    activate(t);
    if (line && editor) { editor.revealLineInCenter(line); editor.setPosition({ lineNumber: line, column: 1 }); updateCursorPos(); }
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
    try {
      await api.writeFile(S.project, t.rel, t.model.getValue());
      t.saved = t.model.getAlternativeVersionId(); t.dirty = false;
      renderTabs(); renderBar();
      toast(`Saved ${baseName(t.rel)}`);
      Panels.refreshGitSoon();
    } catch (e) {
      toast(`Could not save ${baseName(t.rel)}: ${(e.message || e).replace(/^Error invoking remote method[^:]*: (Error: )?/, '')}`);
    }
  }
  function mentionActive() {
    const t = active; if (!t) return;
    const sel = editor?.getSelection();
    let s = `@${t.rel}`;
    if (sel && !sel.isEmpty()) s += `:${sel.startLineNumber}-${sel.endLineNumber}`;
    insertAtCursor(s + ' ');
  }
  async function reloadFile(rel) {
    if (!S.project) return;
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
  async function reloadAll() {
    for (const t of [...tabs]) await reloadFile(t.rel);
  }
  function setTheme(t) { theme = t; if (monaco) monaco.editor.setTheme(t === 'dark' ? 'drops-dark' : 'drops-light'); }
  function closeAll(force = true) { [...tabs].forEach((t) => { close(t, force); }); }

  function showAiReviewBar(prevFullText, deltaInfo) {
    $('#edAiReview')?.remove();
    const rev = h('div', 'ed-ai-review');
    rev.id = 'edAiReview';
    rev.innerHTML = `<span class="grow">Inline AI edit applied <span class="mono">(<span class="add-n">+${deltaInfo.added}</span> <span class="del-n">−${deltaInfo.removed}</span> lines)</span></span><button type="button" class="btn sm ghost ed-ai-reject">Reject (Esc)</button><button type="button" class="btn sm primary ed-ai-accept">Accept</button>`;
    const targetTab = active;
    const finish = (keep) => {
      document.removeEventListener('keydown', onKey, true);
      rev.remove();
      if (!keep && targetTab && targetTab.model && editor) {
        editor.executeEdits('inline-ai-revert', [{ range: targetTab.model.getFullModelRange(), text: prevFullText, forceMoveMarkers: true }]);
        toast('Inline AI edit reverted');
      }
      editor?.focus();
    };
    const onKey = (e) => {
      if (!document.body.contains(rev)) { document.removeEventListener('keydown', onKey, true); return; }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
    };
    document.addEventListener('keydown', onKey, true);
    $('.ed-ai-accept', rev).onclick = () => finish(true);
    $('.ed-ai-reject', rev).onclick = () => finish(false);
    $('#editorPane').insertBefore(rev, $('#edHost'));
  }

  async function openInlineAi() {
    if (!active || active.kind !== 'file' || !editor) return;
    $('#edInlineAi')?.remove();
    $('#edAiReview')?.remove();
    const mySeq = ++aiSeq;
    const bar = h('div', 'ed-inline-ai');
    bar.id = 'edInlineAi';
    bar.innerHTML = `<input class="input sm" placeholder="Describe inline edit for selection or file… (Enter to apply, Esc to cancel)" /><button type="button" class="btn primary sm">Apply</button><button type="button" class="icon-btn sm" title="Cancel">${icon('x', 'xs')}</button><div class="ed-ai-err" hidden></div>`;
    const inp = $('input', bar), applyBtn = $('.btn', bar), closeBtn = $('.icon-btn', bar), errBox = $('.ed-ai-err', bar);
    const close = () => { aiSeq++; bar.remove(); editor?.focus(); };
    closeBtn.onclick = close;
    const run = async () => {
      const instruction = inp.value.trim();
      if (!instruction) return;
      errBox.hidden = true; errBox.textContent = '';
      const sel = editor.getSelection();
      const hasSel = sel && !sel.isEmpty();
      const selection = hasSel ? active.model.getValueInRange(sel) : '';
      const range = hasSel ? sel : active.model.getFullModelRange();
      const prevFullText = active.model.getValue();
      const beforeLines = (hasSel ? selection : prevFullText).split('\n').length;
      applyBtn.disabled = true; inp.disabled = true; applyBtn.textContent = 'Editing…';
      try {
        const out = await api.editorInlineAi?.({
          rel: active.rel,
          code: prevFullText,
          selection,
          instruction,
          model: $('#modelSel')?.value,
        });
        if (mySeq !== aiSeq) return; // cancelled while in flight
        if (typeof out === 'string' && out.length) {
          const afterLines = out.split('\n').length;
          editor.executeEdits('inline-ai', [{ range, text: out, forceMoveMarkers: true }]);
          bar.remove();
          showAiReviewBar(prevFullText, {
            added: Math.max(1, afterLines),
            removed: Math.max(1, beforeLines),
          });
        } else {
          errBox.textContent = 'Model returned an empty edit.';
          errBox.hidden = false;
          applyBtn.disabled = false; inp.disabled = false; applyBtn.textContent = 'Apply';
        }
      } catch (e) {
        if (mySeq !== aiSeq) return;
        const msg = (e.message || 'Inline AI failed').replace(/^Error invoking remote method[^:]*: (Error: )?/, '');
        errBox.textContent = msg;
        errBox.hidden = false;
        applyBtn.disabled = false; inp.disabled = false; applyBtn.textContent = 'Apply';
        inp.focus();
      }
    };
    applyBtn.onclick = run;
    inp.onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); run(); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    };
    $('#editorPane').insertBefore(bar, $('#edHost'));
    inp.focus();
  }

  $('#edClose').onclick = () => hide();
  return { openFile, openSessionDiff, openGitDiff, reloadFile, reloadAll, setTheme, hide, closeAll, isOpen: () => !$('#editorPane').hidden };
})();
