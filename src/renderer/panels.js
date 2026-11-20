/* DROPs renderer — sidebar views, inspector, status bar, settings and command palette. */
'use strict';
const Panels = (() => {
  // ---------- sidebar ----------
  function isSideVisible() {
    const sb = $('#sidebar');
    return !!sb && getComputedStyle(sb).display !== 'none' && sb.getBoundingClientRect().width > 20;
  }
  function showSide(view) {
    const body = $('#body');
    const active = $(`.rail button[data-view="${view}"]`);
    const wasVisible = isSideVisible();
    if (active?.classList.contains('on') && wasVisible && view === showSide.last) {
      body.classList.remove('force-side');
      body.classList.add('no-side');
      active.classList.remove('on');
      return;
    }
    body.classList.remove('no-side');
    if (!isSideVisible()) body.classList.add('force-side');
    $$('.rail button[data-view]').forEach((b) => b.classList.toggle('on', b.dataset.view === view));
    $$('.side-view').forEach((s) => (s.hidden = s.dataset.side !== view));
    showSide.last = view;
    if (view === 'explorer') loadTree();
    else if (view === 'scm') refreshGit();
    else if (view === 'sessions') renderSessions(false);
  }
  function toggleSide() {
    const body = $('#body');
    if (isSideVisible()) {
      body.classList.remove('force-side');
      body.classList.add('no-side');
    } else {
      body.classList.remove('no-side');
      if (!isSideVisible()) body.classList.add('force-side');
    }
  }

  let searchTimer = null, searchSeq = 0, searchHits = new Map();
  async function renderSessions(refetch = true) {
    if (refetch) S.sessions = await api.listSessions();
    const search = $('#sessionSearch');
    if (search && !search.dataset.bound) {
      search.dataset.bound = '1';
      search.oninput = () => {
        const val = search.value.trim();
        renderSessions(false);
        clearTimeout(searchTimer);
        if (!val) { searchHits.clear(); return; }
        const seq = ++searchSeq;
        searchTimer = setTimeout(async () => {
          const hits = await api.searchSessions?.(val).catch(() => []);
          if (seq !== searchSeq) return;
          searchHits = new Map((hits || []).map((x) => [x.id, x.snippet || '']));
          renderSessions(false);
        }, 160);
      };
    }
    const q = (search?.value || '').trim().toLowerCase();
    const list = $('#sessionList');
    list.innerHTML = '';
    // Every project with its sessions, the open project first (like a workspace sidebar).
    // Merge live in-memory title/cost/updated from S.views so active sessions never display stale "New session".
    const mergedSessions = S.sessions.map((s) => {
      const live = S.views.get(s.id)?.data;
      return live ? { ...s, title: live.title || s.title, updated: Math.max(s.updated || 0, live.updated || 0), cost: live.usage?.cost ?? s.cost, pinned: live.pinned ?? s.pinned } : s;
    });
    const all = q ? mergedSessions.filter((s) => (s.title || '').toLowerCase().includes(q) || searchHits.has(s.id)) : mergedSessions;
    const byProject = new Map();
    // Pinned sessions first, then the most recent.
    for (const s of [...all].sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.updated - a.updated)) {
      if (!byProject.has(s.projectDir)) byProject.set(s.projectDir, []);
      byProject.get(s.projectDir).push(s);
    }
    if (S.project && !byProject.has(S.project) && !q) byProject.set(S.project, []);
    const projects = [...byProject.keys()].sort((a, b) => (a === S.project ? -1 : b === S.project ? 1 : 0));
    if (!projects.length) { list.appendChild(h('div', 'empty', q ? 'No matching sessions.' : 'No sessions yet.')); return; }
    let open = new Set();
    try { open = new Set(JSON.parse(localStorage.getItem('drops.sidebar.open') || '[]')); } catch { /* storage blocked */ }
    const saveOpen = () => { try { localStorage.setItem('drops.sidebar.open', JSON.stringify([...open])); } catch { /* ignore */ } };
    for (const p of projects) {
      const items = byProject.get(p);
      const isOpen = !!q || p === S.project || open.has(p);
      const head = h('div', 'proj-head' + (p === S.project ? ' current' : ''));
      head.innerHTML = `<span class="ph-chev">${icon(isOpen ? 'chevronDown' : 'chevronRight', 'xs')}</span>${icon('folder', 'sm')}<span class="ph-name"></span><span class="ph-count"></span><button class="icon-btn ph-new" title="New session in this project">${icon('plus', 'xs')}</button>`;
      $('.ph-name', head).textContent = baseName(p || 'No project');
      $('.ph-count', head).textContent = items.length ? String(items.length) : '';
      head.title = p;
      head.onclick = () => { if (p === S.project) return; if (open.has(p)) open.delete(p); else open.add(p); saveOpen(); renderSessions(false); };
      $('.ph-new', head).onclick = async (e) => { e.stopPropagation(); if (p !== S.project) await setProject(p); newSession(); };
      list.appendChild(head);
      if (!isOpen) continue;
      if (!items.length) { const e = h('div', 'proj-empty', 'No sessions yet'); list.appendChild(e); continue; }
      const limit = p === S.project || q ? items.length : 8;
      for (const s of items.slice(0, limit)) {
        const it = h('div', 'row session' + (s.id === S.current ? ' on' : '') + (s.pinned ? ' pinned' : ''));
        it.dataset.id = s.id;
        it.dataset.failed = s.failed ? '1' : '';
        const snippet = q ? searchHits.get(s.id) : '';
        it.innerHTML = `<span class="dot"></span><span class="t"><span class="tt"></span><span class="t2">${snippet ? '' : timeAgo(s.updated) + (s.cost ? ' · ' + fmtCost(s.cost) : '')}</span></span><span class="acts"><button class="pin-btn" title="${s.pinned ? 'Unpin' : 'Pin to the top'}">${icon('pin', 'xs')}</button><button title="Rename">${icon('pencil', 'xs')}</button><button title="Delete">${icon('trash', 'xs')}</button></span>`;
        $('.tt', it).textContent = s.title;
        if (snippet) $('.t2', it).textContent = snippet;
        it.title = snippet ? `${s.title}\n${snippet}` : s.title;
        applyStatus(it, S.views.get(s.id), s);
        it.onclick = () => openSession(s.id);
        const [pin, ren, del] = $$('.acts button', it);
        pin.onclick = async (e) => { e.stopPropagation(); await api.pinSession(s.id, !s.pinned); s.pinned = !s.pinned; const v = S.views.get(s.id); if (v) v.data.pinned = s.pinned; renderSessions(); };
        ren.onclick = async (e) => {
          e.stopPropagation();
          const name = await promptBox('Rename session', s.title);
          if (name) { await api.renameSession(s.id, name); const v = S.views.get(s.id); if (v) v.data.title = name; if (S.current === s.id) $('#sessionTitle').textContent = name; renderSessions(); }
        };
        del.onclick = async (e) => {
          e.stopPropagation();
          if (!(await confirmBox('Delete this session?', 'The conversation and its checkpoints are removed. Files in your project are not touched.', 'Delete'))) return;
          await api.deleteSession(s.id);
          const v = S.views.get(s.id); v?.el.remove(); S.views.delete(s.id);
          if (S.current === s.id) { S.current = null; showCurrent(); }
          renderSessions();
        };
        list.appendChild(it);
        const v = S.views.get(s.id); if (v) markSession(v);
      }
      if (items.length > limit) { const more = h('button', 'proj-more', `Show ${items.length - limit} more`); more.onclick = async () => { await setProject(p); }; list.appendChild(more); }
    }
  }
  function markSession(v) {
    const it = document.querySelector(`.row.session[data-id="${v.id}"]`);
    if (it) applyStatus(it, v, null);
  }
  /** One status per session row: working, needs you, stopped by an error, or finished while you were elsewhere. */
  function applyStatus(it, v, summary) {
    const busy = !!v?.busy && !(v.waiting?.size);
    const waiting = !!(v?.waiting?.size);
    const lastText = (() => { const m = v?.data?.messages?.[v.data.messages.length - 1]; return m && m.role === 'assistant' && Array.isArray(m.content) ? m.content.map((b) => b.text || '').join(' ') : ''; })();
    const failed = !busy && !waiting && (v ? lastText.startsWith('[DROPs] Stopped by an error:') : (summary?.failed || it.dataset.failed === '1'));
    const unread = !busy && !waiting && !failed && S.unread?.has(it.dataset.id);
    it.classList.toggle('busy', busy);
    it.classList.toggle('waiting', waiting);
    it.classList.toggle('failed', !!failed);
    it.classList.toggle('unread', !!unread);
    const dot = it.querySelector('.dot');
    if (dot) {
      dot.innerHTML = failed ? icon('alert', 'xs') : '';
      dot.title = busy ? 'Working' : waiting ? 'Needs your answer' : failed ? 'Stopped by an error' : unread ? 'Finished: not seen yet' : '';
    }
  }

  // ---------- explorer ----------
  let treeSeq = 0, treeSearchActive = false;
  async function restoreOpenDirs(container, openDirs) {
    if (!openDirs.size) return;
    for (const row of container.querySelectorAll('.tree-row')) {
      const rel = row.dataset.rel;
      if (!rel || !openDirs.has(rel) || row.classList.contains('open')) continue;
      const kids = row.nextElementSibling;
      if (!kids) continue;
      row.classList.add('open');
      kids.hidden = false;
      if (!kids.dataset.loaded) {
        kids.dataset.loaded = '1';
        await fillDir(kids, rel, rel.split('/').length);
      }
      await restoreOpenDirs(kids, openDirs);
    }
  }
  async function loadTree() {
    const ts = $('#treeSearch');
    if (ts && !ts.dataset.bound) {
      ts.dataset.bound = '1';
      ts.oninput = () => filterTree();
    }
    if (ts && ts.value.trim()) { await filterTree(); return; }
    treeSearchActive = false;
    const t = $('#tree');
    const openDirs = new Set([...$$('#tree .tree-row.open')].map((r) => r.dataset.rel).filter(Boolean));
    t.innerHTML = '';
    $('#explorerTitle').textContent = S.project ? baseName(S.project) : 'Explorer';
    if (!S.project) { const e = h('div', 'empty', 'No folder open.'); const b = h('button', 'btn sm', 'Open folder'); b.onclick = pickProject; e.append(h('br'), b); t.appendChild(e); return; }
    await fillDir(t, '', 0);
    await restoreOpenDirs(t, openDirs);
    refreshTreeMarks();
  }
  async function filterTree() {
    const q = ($('#treeSearch')?.value || '').trim();
    if (!q) { if (treeSearchActive) await loadTree(); return; }
    if (!S.project) return;
    treeSearchActive = true;
    const seq = ++treeSeq;
    const res = await api.searchFiles(S.project, q);
    if (seq !== treeSeq) return;
    const t = $('#tree'); t.innerHTML = '';
    if (!res.length) { t.appendChild(h('div', 'empty', 'No matching files.')); return; }
    for (const rel of res.slice(0, 100)) {
      const row = h('div', 'row tree-row');
      row.dataset.rel = rel;
      row.innerHTML = `<span class="caret"></span>${icon('file', 'ficon')}<span class="t"></span>`;
      $('.t', row).textContent = baseName(rel);
      const meta = h('span', 'meta', rel.includes('/') || rel.includes('\\') ? rel.slice(0, rel.length - baseName(rel).length - 1) : '');
      const acts = h('span', 'acts');
      const m = h('button'); m.innerHTML = icon('at', 'xs'); m.title = 'Mention in chat';
      m.onclick = (e) => { e.stopPropagation(); insertAtCursor(`@${rel} `); };
      acts.appendChild(m);
      row.append(meta, acts);
      row.title = rel;
      row.onclick = () => Editor.openFile(rel);
      t.appendChild(row);
    }
    refreshTreeMarks();
  }
  async function fillDir(container, rel, depth) {
    const items = await api.listDir(S.project, rel);
    if (depth === 0 && !items.length) {
      container.appendChild(h('div', 'empty', 'This folder is empty.'));
      return;
    }
    for (const it of items) {
      const row = h('div', 'row tree-row');
      row.style.setProperty('--depth', depth);
      row.dataset.rel = it.rel;
      row.innerHTML = `<span class="caret">${it.dir ? icon('chevronRight', 'xs') : ''}</span>${icon(it.dir ? 'folder' : 'file', 'ficon')}<span class="t"></span>`;
      $('.t', row).textContent = it.name;
      container.appendChild(row);
      if (it.dir) {
        const kids = h('div'); kids.hidden = true; container.appendChild(kids);
        row.onclick = async () => {
          row.classList.toggle('open');
          kids.hidden = !row.classList.contains('open');
          if (!kids.hidden && !kids.dataset.loaded) { kids.dataset.loaded = '1'; await fillDir(kids, it.rel, depth + 1); refreshTreeMarks(); }
        };
      } else {
        const acts = h('span', 'acts');
        const m = h('button'); m.innerHTML = icon('at', 'xs'); m.title = 'Mention in chat';
        m.onclick = (e) => { e.stopPropagation(); insertAtCursor(`@${it.rel} `); };
        acts.appendChild(m); row.appendChild(acts);
        row.title = it.rel;
        row.onclick = () => Editor.openFile(it.rel);
      }
    }
  }
  function refreshTreeMarks() {
    const ch = currentView()?.data.changes || {};
    $$('.tree-row').forEach((r) => r.classList.toggle('changed', !!ch[r.dataset.rel]));
  }
  let treeRefreshTimer = null;
  function refreshTreeSoon() {
    if ($('[data-side="explorer"]')?.hidden) return;
    clearTimeout(treeRefreshTimer);
    treeRefreshTimer = setTimeout(() => { loadTree().catch(() => {}); }, 350);
  }

  // ---------- source control ----------
  let gitTimer = null;
  function refreshGitSoon() { clearTimeout(gitTimer); gitTimer = setTimeout(refreshGit, 700); }
  async function refreshGit() {
    if (!S.project) { S.git = null; renderScm(); renderStatus(); return; }
    S.git = await api.gitStatus(S.project);
    renderScm(); renderStatus();
  }
  async function renderScm() {
    const box = $('#scm');
    const g = S.git;
    const count = g?.isRepo ? g.files.length : 0;
    $('#scmCount').hidden = !count; $('#scmCount').textContent = count > 99 ? '99+' : count;
    $('#branchBtn').hidden = !g?.isRepo; $('#branchName').textContent = g?.branch || '';
    if (!$('[data-side="scm"]').offsetParent && box.childElementCount) return;
    box.innerHTML = '';
    if (!S.project) { box.appendChild(h('div', 'empty', 'Open a folder to use source control.')); return; }
    if (!g?.isRepo) {
      const e = h('div', 'empty', 'This folder is not a git repository.');
      const b = h('button', 'btn sm', 'Initialize repository'); b.onclick = async () => { await api.gitInit(S.project); refreshGit(); };
      e.append(h('br'), b); box.appendChild(e); return;
    }
    const top = h('div', 'scm-box');
    const brWrap = h('div', 'scm-branch-wrap');
    const br = h('button', 'scm-branch');
    br.type = 'button';
    br.title = 'Switch or create git branch';
    br.innerHTML = `${icon('branch', 'sm')}<b>${esc(g.branch)}</b><span class="meta">${g.ahead ? `↑${g.ahead} ` : ''}${g.behind ? `↓${g.behind}` : ''}</span>${icon('chevronDown', 'xs')}`;
    br.onclick = async (e) => {
      e.stopPropagation();
      const existing = $('.scm-branch-pop', brWrap);
      if (existing) { existing.remove(); return; }
      const info = await api.gitBranches?.(S.project).catch(() => ({ current: g.branch, local: [g.branch] }));
      const pop = h('div', 'scm-branch-pop');
      for (const bName of info?.local || [g.branch]) {
        const item = h('button', 'scm-br-item' + (bName === g.branch ? ' on' : ''));
        item.type = 'button';
        item.innerHTML = `${icon('branch', 'xs')}<span class="grow"></span>${bName === g.branch ? icon('check', 'xs') : ''}`;
        $('.grow', item).textContent = bName;
        item.onclick = async () => {
          pop.remove();
          if (bName === g.branch) return;
          const r = await api.gitCheckout?.(S.project, bName, false);
          if (r?.error) toast(r.error); else { toast(`Switched to ${bName}`); Editor.reloadAll?.(); refreshGit(); loadTree(); }
        };
        pop.appendChild(item);
      }
      const createBtn = h('button', 'scm-br-item');
      createBtn.type = 'button';
      createBtn.innerHTML = `${icon('plus', 'xs')}<span class="grow">Create new branch…</span>`;
      createBtn.onclick = async () => {
        pop.remove();
        const name = await promptBox('New git branch', '');
        if (!name) return;
        const r = await api.gitCheckout?.(S.project, name, true);
        if (r?.error) toast(r.error); else { toast(`Created and switched to ${name}`); refreshGit(); }
      };
      pop.appendChild(createBtn);
      brWrap.appendChild(pop);
      const closePop = (ev) => { if (!pop.contains(ev.target) && ev.target !== br) { pop.remove(); document.removeEventListener('mousedown', closePop); } };
      setTimeout(() => document.addEventListener('mousedown', closePop), 0);
    };
    brWrap.appendChild(br);

    const stagedFiles = (g.files || []).filter((f) => f.staged);
    const unstagedFiles = (g.files || []).filter((f) => !f.staged);
    const ta = h('textarea', 'textarea'); ta.id = 'commitMsg'; ta.placeholder = 'Commit message'; ta.value = renderScm.draft || ''; ta.oninput = () => (renderScm.draft = ta.value);
    const row = h('div', 'btn-row');
    const gen = h('button', 'btn sm'); gen.type = 'button'; gen.innerHTML = icon('sparkles', 'xs') + 'Generate'; gen.title = 'Write the message with AI from the diff'; gen.disabled = !count; gen.onclick = generateCommitMessage;
    const commitTargetCount = stagedFiles.length || count;
    const commitLbl = stagedFiles.length ? `Commit staged (${stagedFiles.length})` : `Commit ${count} file${count === 1 ? '' : 's'}`;
    const commit = h('button', 'btn primary sm grow'); commit.type = 'button'; commit.innerHTML = icon('check', 'xs') + commitLbl;
    commit.disabled = !commitTargetCount;
    commit.onclick = async () => {
      const msg = ta.value.trim();
      if (!msg) { toast('Write or generate a commit message first'); ta.focus(); return; }
      commit.disabled = true;
      const r = await api.gitCommit(S.project, msg);
      if (r.error) toast(r.error); else { toast('Committed: ' + r.summary); renderScm.draft = ''; }
      refreshGit();
    };
    row.append(gen, commit);
    top.append(brWrap, ta, row);
    box.appendChild(top);

    const makeFileRow = (f, isStaged) => {
      const r = h('div', 'row');
      const letter = { modified: 'M', added: 'A', untracked: 'U', deleted: 'D', renamed: 'R' }[f.status] || 'M';
      r.innerHTML = `${icon('file', 'ficon')}<span class="t"></span><span class="scm-file-acts"></span><span class="st-letter st-${f.status}">${letter}</span>`;
      $('.t', r).textContent = f.path; r.title = f.path + ' — click to view diff';
      r.onclick = () => Editor.openGitDiff(f.path);
      const acts = $('.scm-file-acts', r);
      if (isStaged) {
        const un = h('button'); un.type = 'button'; un.title = 'Unstage file'; un.innerHTML = icon('undo', 'xs');
        un.onclick = async (e) => { e.stopPropagation(); const res = await api.gitUnstage?.(S.project, f.path); if (res?.error) toast(res.error); refreshGit(); };
        acts.appendChild(un);
      } else {
        const disc = h('button', 'disc'); disc.type = 'button'; disc.title = f.status === 'untracked' ? 'Delete untracked file' : 'Discard changes'; disc.innerHTML = icon('undo', 'xs');
        disc.onclick = async (e) => {
          e.stopPropagation();
          if (!(await confirmBox(`Discard changes to ${baseName(f.path)}?`, f.status === 'untracked' ? 'This untracked file will be permanently deleted.' : 'All uncommitted changes to this file will be lost.', 'Discard'))) return;
          const res = await api.gitDiscard?.(S.project, f.path);
          if (res?.error) toast(res.error); else { toast(`Discarded ${baseName(f.path)}`); Editor.reloadFile(f.path); refreshGit(); loadTree(); }
        };
        const stg = h('button'); stg.type = 'button'; stg.title = 'Stage file'; stg.innerHTML = icon('plus', 'xs');
        stg.onclick = async (e) => { e.stopPropagation(); const res = await api.gitStage?.(S.project, f.path); if (res?.error) toast(res.error); refreshGit(); };
        acts.append(disc, stg);
      }
      return r;
    };

    if (stagedFiles.length) {
      const gh = h('div', 'scm-group-head');
      gh.innerHTML = `<span class="group-label">Staged (${stagedFiles.length})</span><span class="scm-group-acts"><button type="button" class="icon-btn" title="Unstage all">${icon('undo', 'xs')}</button></span>`;
      $('button', gh).onclick = async () => { await api.gitUnstage?.(S.project, ''); refreshGit(); };
      box.appendChild(gh);
      for (const f of stagedFiles) box.appendChild(makeFileRow(f, true));
    }
    if (unstagedFiles.length) {
      const gh = h('div', 'scm-group-head');
      gh.innerHTML = `<span class="group-label">Changes (${unstagedFiles.length})</span><span class="scm-group-acts"><button type="button" class="icon-btn" title="Stage all">${icon('plus', 'xs')}</button></span>`;
      $('button', gh).onclick = async () => { await api.gitStage?.(S.project, ''); refreshGit(); };
      box.appendChild(gh);
      for (const f of unstagedFiles) box.appendChild(makeFileRow(f, false));
    }
    const log = await api.gitLog(S.project);
    if (log.length) {
      box.appendChild(h('div', 'group-label', 'Recent commits'));
      for (const c of log.slice(0, 12)) {
        const r = h('div', 'commit-row');
        r.style.cursor = 'pointer';
        r.innerHTML = `<span class="h">${esc(c.hash)}</span><span class="s"></span><span>${esc(c.when.replace(' ago', ''))}</span>`;
        $('.s', r).textContent = c.subject;
        r.title = `${c.subject}\n${c.author}, ${c.when} (click to copy hash)`;
        r.onclick = () => { navigator.clipboard.writeText(c.hash); toast(`Copied commit ${c.hash}`); };
        box.appendChild(r);
      }
    }
  }
  async function generateCommitMessage() {
    if (!S.project) return;
    showSide('scm');
    const ta = $('#commitMsg');
    if (ta) { ta.value = 'Writing commit message…'; ta.disabled = true; }
    const r = await api.gitMessage(S.project, currentOpts().model);
    const t2 = $('#commitMsg');
    if (t2) { t2.disabled = false; t2.value = r.message || ''; renderScm.draft = t2.value; }
    if (r.error) toast(r.error);
  }

  // ---------- inspector ----------
  function switchTab(name, opts = {}) {
    if (!opts.auto) {
      S.userInspLock = true;
      S.userClosedInsp = false;
      if (S.lens === 'focus' || S.lens === 'mission') setLens('default');
    } else if (S.lens === 'focus' || S.lens === 'mission') {
      return;
    }
    const body = $('#body');
    body.classList.remove('no-insp');
    body.classList.toggle('browser-stage', name === 'browser');
    if (name !== 'browser') {
      body.classList.remove('browser-wide');
      const wb = $('.bp-wide-btn');
      if (wb) { wb.classList.remove('on'); wb.innerHTML = icon('maximize', 'xs'); wb.title = 'Expand browser stage'; wb.setAttribute('aria-label', wb.title); }
    }
    if (window.innerWidth <= 1280) body.classList.add('force-insp');
    $('#inspToggle')?.classList.add('on');
    $$('#inspTabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
    $$('.tab-body').forEach((b) => (b.hidden = b.dataset.body !== name));
    const bKey = currentView()?.data?.projectDir || S.project || 'default';
    if (name === 'browser') {
      const bd = $('#browserBadge'); if (bd) bd.hidden = true;
      if (typeof renderBrowserPane === 'function') renderBrowserPane(currentView(), false);
      api.browserStream?.(bKey, 'start').then((r) => {
        const cv = currentView();
        if (r?.frame && cv && !cv.browserFrame) { cv.browserFrame = { ...r.frame, step: 'live' }; renderBrowserPane(cv, false); }
      }).catch(() => {});
    } else {
      api.browserStream?.(bKey, 'stop').catch(() => {});
    }
    if (name === 'tasks') renderTasks();
    if (name === 'map') renderMap();
  }
  /** The right panel's overview: live session cockpit, quick workbench actions, and outputs. */
  function overviewPanel() {
    const wrap = h('div', 'ov-wrap');
    const v = currentView();
    const u = v?.data.usage;
    const ch = v?.data.changes || {};
    const keys = Object.keys(ch);
    const turns = v?.lastTurnIndex != null ? v.lastTurnIndex + 1 : (v?.data.turns?.length || 0);
    const waiting = !!(v?.waiting?.size);
    const busy = !!v?.busy && !waiting;

    // 1. Live Session Telemetry Strip (flat hairline cells, zero boxed cards)
    const secSession = h('section', 'ov-sec ov-session');
    const stCls = busy ? 'busy' : waiting ? 'waiting' : 'ready';
    const stLabel = busy ? (v.workLabel || 'Working') : waiting ? 'Needs input' : v ? 'Ready' : 'Idle';
    const pct = u?.context ? Math.min(1, u.context / contextMax()) : 0;
    const pctLabel = u?.context ? `${Math.max(1, Math.round(pct * 100))}%` : 'Idle';
    const costText = u?.costUnknown && !u.cost ? (fmtTok((u.input || 0) + (u.output || 0)) + ' tok') : fmtCost(u?.cost || 0);

    secSession.innerHTML = `
      <div class="ov-sec-head">
        <span class="ov-sec-t">Session</span>
        <span class="ov-st ${stCls}"><i class="ov-st-dot"></i><span></span></span>
      </div>
      <div class="ov-metrics">
        <button type="button" class="ov-metric" data-go="changes" title="Inspect changed files">
          <span class="ov-m-v">${keys.length}</span>
          <span class="ov-m-l">Changes</span>
        </button>
        <button type="button" class="ov-metric" data-go="plan" title="Checkpoints saved before edits">
          <span class="ov-m-v">${turns}</span>
          <span class="ov-m-l">Turns</span>
        </button>
        <button type="button" class="ov-metric" data-go="usage" title="Inspect token usage and cost">
          <span class="ov-m-v">${esc(costText)}</span>
          <span class="ov-m-l">Cost</span>
        </button>
      </div>
      <button type="button" class="ov-ctx-row" title="Context window usage — click for Usage details">
        <span class="ov-ctx-k">Context</span>
        <span class="ov-ctx-track"><i style="width:${Math.round(pct * 100)}%"></i></span>
        <span class="ov-ctx-v mono">${esc(pctLabel)}</span>
      </button>
    `;
    $('.ov-st span:last-child', secSession).textContent = stLabel;
    $('.ov-ctx-row', secSession).onclick = () => switchTab('usage');
    $$('.ov-metric', secSession).forEach((b) => (b.onclick = () => { if (b.dataset.go !== 'plan') switchTab(b.dataset.go); }));
    wrap.appendChild(secSession);

    // 2. Flat Workbench Action List (monochrome precision rows)
    const secTools = h('section', 'ov-sec ov-tools');
    secTools.innerHTML = `<div class="ov-sec-head"><span class="ov-sec-t">Workbench</span></div>`;
    const list = h('div', 'ov-list');
    const actions = [
      ['network', 'Code Map', S.project ? 'Graph' : 'No project', () => switchTab('map')],
      ['globe', 'Live Browser', v?.browserFrame ? 'Live' : 'Inspect', () => switchTab('browser')],
      ['terminal', 'Terminal', [...(v?.procs?.values() || [])].some((p) => p.running) ? 'Active' : 'Shell', () => switchTab('terminal')],
      ['merge', 'Git Worktree', 'Branch', () => newWorktreeSession()],
    ];
    for (const [ic, label, meta, fn] of actions) {
      const b = h('button', 'ov-act');
      b.type = 'button';
      b.innerHTML = `${icon(ic, 'sm')}<span class="ov-a-l"></span><span class="ov-a-m"></span>`;
      $('.ov-a-l', b).textContent = label;
      $('.ov-a-m', b).textContent = meta;
      b.onclick = fn;
      list.appendChild(b);
    }
    secTools.appendChild(list);
    wrap.appendChild(secTools);

    const section = (title) => { wrap.appendChild(h('div', 'glance-title', title)); const rows = h('div', 'glance-rows'); wrap.appendChild(rows); return rows; };

    // Background tasks: dev servers and other processes the agent left running, with a live timer and Stop.
    const procs = v ? [...v.procs.values()] : [];
    if (procs.length) {
      const live = procs.filter((p) => p.running), done = procs.length - live.length;
      const bg = section('Background tasks');
      for (const p of live) {
        const r = h('div', 'glance-row bg-row');
        r.innerHTML = `${icon('terminal', 'sm')}<span class="gl"></span><span class="gv bg-time mono" data-start="${p.startedAt || ''}"></span><button class="icon-btn bg-stop" title="Stop this process">${icon('square', 'xs')}</button>`;
        $('.gl', r).textContent = p.name || p.command || p.id; r.title = p.command || '';
        $('.gl', r).onclick = () => switchTab('terminal');
        $('.bg-stop', r).onclick = async () => { await api.procStop(v.id, p.id); toast(`Stopped ${p.name || p.id}`); };
        bg.appendChild(r);
      }
      if (done) {
        const r = h('button', 'glance-row link bg-done');
        r.innerHTML = `${icon('check', 'sm')}<span class="gl">${done} finished</span>`;
        r.onclick = () => switchTab('terminal');
        bg.appendChild(r);
      }
      tickBackground();
    }

    // Requirements: verified only by checks DROPs ran itself.
    const reqs = v?.data.requirements || [];
    if (reqs.length) {
      const ok = reqs.filter((r) => r.status === 'verified').length;
      const t = h('div', 'glance-title out-title');
      t.innerHTML = `<span>Requirements</span><span class="${ok === reqs.length ? 'add-n' : ''}">${ok}/${reqs.length} verified</span>`;
      wrap.appendChild(t);
      const bar = h('div', 'meter'); const fill = h('div'); fill.style.width = `${(ok / reqs.length) * 100}%`; bar.appendChild(fill); wrap.appendChild(bar);
      const rows = h('div', 'glance-rows req-rows');
      for (const r of reqs) {
        const row = h('div', 'req-row ' + r.status);
        row.innerHTML = `<span class="rq-dot"></span><span class="rq-id mono"></span><span class="rq-t"></span>`;
        $('.rq-id', row).textContent = r.id; $('.rq-t', row).textContent = r.text;
        const state = r.status === 'verified' ? 'Verified on the current code' : r.status === 'stale' ? 'Verified before a later change; waiting for a re-check' : r.evidence?.passed ? 'Own check passed (QA check still needed)' : 'Check failed';
        const attacks = (r.evidence?.attacks || []).map((a) => `${a.passed ? '✓' : '✗'} ${a.label}`).join('\n');
        row.title = r.evidence ? `${state} by ${r.evidence.byQa ? 'independent QA ' : ''}${r.evidence.kind}: ${r.evidence.check}${r.evidence.expect ? ` (expects "${r.evidence.expect}")` : ''}
${r.evidence.summary}${attacks ? `\nAttacks the app must refuse:\n${attacks}` : ''}${r.evidence.at ? `\nChecked ${new Date(r.evidence.at).toLocaleString()}` : ''}` : 'No evidence yet';
        rows.appendChild(row);
      }
      wrap.appendChild(rows);
    }

    // Outputs: the files this session changed, with proportional visual diff bars.
    if (keys.length) {
      let A = 0, D = 0;
      for (const k of keys) { A += ch[k].added; D += ch[k].removed; }
      const t = h('div', 'glance-title out-title');
      t.innerHTML = `<span>Outputs</span><span class="mono"><span class="add-n">+${A}</span> <span class="del-n">−${D}</span></span>`;
      wrap.appendChild(t);
      const rows = h('div', 'glance-rows');
      for (const k of keys.slice(-6).reverse()) {
        const tot = Math.max(1, ch[k].added + ch[k].removed);
        const aPct = Math.round((ch[k].added / tot) * 100);
        const r = h('button', 'glance-row link out-row');
        r.innerHTML = `${icon('fileCode', 'sm')}<span class="gl mono"></span><span class="ov-diff-bar" aria-hidden="true"><i class="ov-d-a" style="width:${aPct}%"></i><i class="ov-d-d" style="width:${100 - aPct}%"></i></span><span class="gv mono"><span class="add-n">+${ch[k].added}</span> <span class="del-n">−${ch[k].removed}</span></span>`;
        $('.gl', r).textContent = baseName(k); r.title = k;
        r.onclick = () => Editor.openSessionDiff(k);
        rows.appendChild(r);
      }
      wrap.appendChild(rows);
      const all = h('button', 'btn sm ghost-btn'); all.innerHTML = `${icon('diff', 'xs')} Review all ${keys.length} change${keys.length === 1 ? '' : 's'}`;
      all.onclick = () => switchTab('changes');
      wrap.appendChild(all);
    }
    return wrap;
  }

  /** Workspace environment status rows shown when a fresh session has no tasks or outputs yet. */
  function howPanel() {
    const sec = h('section', 'ov-sec ov-env');
    sec.innerHTML = `<div class="ov-sec-head"><span class="ov-sec-t">Environment</span></div>`;
    const list = h('div', 'ov-spec');
    const addRow = (state, label, value, onclick) => {
      const b = h('button', 'ov-spec-row');
      b.type = 'button';
      b.innerHTML = `<span class="ov-sk"></span><span class="ov-sv ${state} mono"></span>`;
      $('.ov-sk', b).textContent = label;
      $('.ov-sv', b).textContent = value;
      b.onclick = onclick;
      list.appendChild(b);
    };
    const hasModel = !!S.settings?.hasKey || !!(S.info?.models || []).some((m) => !m.id.startsWith('__') && m.id !== 'auto' && !m.disabled && modelUsable(m));
    addRow(hasModel ? 'ok' : 'warn', 'Providers', hasModel ? 'Ready' : 'Configure', () => openSettings('providers'));
    if (S.project) {
      const chN = S.git?.isRepo ? S.git.files.length : 0;
      addRow(chN ? 'warn' : 'ok', 'Repository', S.git?.isRepo ? `${S.git.branch}${chN ? ` · ${chN}` : ''}` : baseName(S.project), () => showSide(S.git?.isRepo ? 'scm' : 'explorer'));
    } else {
      addRow('muted', 'Project', 'Open folder', pickProject);
    }
    const guardText = S.settings?.sandbox ? 'Docker + QA' : (S.settings?.autoVerify !== false ? 'Verify + QA' : 'Basic');
    addRow('muted', 'Guardrails', guardText, () => openSettings('agent'));
    const mcps = S.mcp || [];
    if (mcps.length) {
      const up = mcps.filter((x) => x.status === 'connected').length;
      addRow(up === mcps.length ? 'ok' : 'warn', 'MCP', `${up}/${mcps.length} active`, () => openSettings('tools'));
    }
    sec.appendChild(list);
    return sec;
  }

  async function renderTasks() {
    const box = $('#tasksBody');
    if (!box) return;
    box.innerHTML = '';
    let tasks = [];
    try { tasks = await api.taskList(); } catch { tasks = []; }

    const activeTasks = tasks.filter((t) => t.status === 'running');
    const queuedTasks = tasks.filter((t) => t.status === 'queued');
    const sessionTasks = S.current ? tasks.filter((t) => t.session_id === S.current) : tasks;
    const pastTasks = sessionTasks.filter((t) => ['completed', 'failed', 'cancelled'].includes(t.status)).slice(0, 6);

    const activeCount = activeTasks.length + queuedTasks.length;
    const badge = $('#tasksBadge');
    if (badge) {
      badge.hidden = activeCount === 0;
      badge.textContent = activeCount;
    }

    const wrap = h('div', 'tasks-list');
    if (!tasks.length) {
      await renderSchedules(wrap);
      wrap.appendChild(h('div', 'sched-empty', 'Background runs for the active session appear here.'));
      box.appendChild(wrap);
      return;
    }

    if (activeTasks.length) {
      wrap.appendChild(h('div', 'glance-title', `Active (${activeTasks.length})`));
      for (const t of activeTasks) {
        const card = h('div', 'task-card running');
        const dur = Math.round((Date.now() - (t.started_at || t.created_at)) / 1000);
        card.innerHTML = `
          <div class="task-head">
            <span class="task-status-pill running">Running</span>
            <span class="task-time">${dur}s</span>
          </div>
          <div class="task-title"></div>
          <div class="task-progress-bar"><div style="width:${Math.max(5, t.progress?.percent || 0)}%"></div></div>
          <div class="task-meta"><small></small></div>
          <div class="task-actions">
            <button class="btn sm btn-cancel-task">Stop</button>
          </div>
        `;
        $('.task-title', card).textContent = t.title || t.prompt?.slice(0, 60);
        $('small', card).textContent = `Step ${t.progress?.step || 0}/${t.progress?.maxSteps || 250} · ${t.progress?.currentAction || 'Running'}`;
        $('.btn-cancel-task', card).onclick = async () => {
          if (!(await confirmBox('Cancel this running task?', 'This will stop the agent and any active processes for this task. The task will be marked cancelled.', 'Cancel Task'))) return;
          await api.taskCancel(t.task_id);
          toast('Task cancelled');
          renderTasks();
        };
        wrap.appendChild(card);
      }
    }

    if (queuedTasks.length) {
      wrap.appendChild(h('div', 'glance-title', `Queued (${queuedTasks.length})`));
      queuedTasks.forEach((t, idx) => {
        const card = h('div', 'task-card queued');
        card.innerHTML = `
          <div class="task-head">
            <span class="task-status-pill queued">Queued · ${idx + 1}</span>
          </div>
          <div class="task-title"></div>
          <div class="task-actions">
            <button class="btn sm btn-steer-task">Send now</button>
            <button class="btn sm btn-remove-task">Remove</button>
          </div>
        `;
        $('.task-title', card).textContent = t.title || t.prompt?.slice(0, 60);
        $('.btn-remove-task', card).onclick = async () => {
          await api.taskCancel(t.task_id);
          toast('Removed from queue');
          renderTasks();
        };
        $('.btn-steer-task', card).onclick = async () => {
          await api.send(t.session_id, t.prompt, t.opts, t.images, { action: 'steer' });
          await api.taskCancel(t.task_id);
          toast('Task injected as steering instruction');
          renderTasks();
        };
        wrap.appendChild(card);
      });
    }

    if (pastTasks.length) {
      const head = h('div', 'glance-title recent-head');
      head.style.cssText = 'display:flex;align-items:center;justify-content:space-between;';
      head.innerHTML = '<span>Recent</span>';
      const clr = h('button', 'btn ghost sm', 'Clear');
      clr.onclick = async () => {
        await api.taskClear?.(S.current || null);
        toast('Recent tasks cleared');
        renderTasks();
      };
      head.appendChild(clr);
      wrap.appendChild(head);
      for (const t of pastTasks) {
        // One quiet row per finished task: a mark, the title, how long it took.
        const card = h('div', `task-row ${t.status}`);
        const dur = t.completed_at && t.started_at ? Math.round((t.completed_at - t.started_at) / 1000) : 0;
        const time = !dur ? '' : dur < 60 ? `${dur}s` : `${Math.round(dur / 60)}m`;
        const mark = t.status === 'completed' ? taskMark('completed') : `<span class="tr-x" aria-hidden="true">${icon(t.status === 'failed' ? 'alert' : 'x', 'xs')}</span>`;
        card.innerHTML = `<span class="tr-mark">${mark}</span><div class="tr-main"><div class="task-title"></div>${t.error_info ? '<div class="task-error"></div>' : ''}</div><span class="task-time">${t.status === 'completed' ? '' : t.status + (time ? ' · ' : '')}${time}</span>`;
        card.title = t.status;
        $('.task-title', card).textContent = t.title || t.prompt?.slice(0, 60);
        if (t.error_info) $('.task-error', card).textContent = t.error_info;
        wrap.appendChild(card);
      }
    }

    await renderSchedules(wrap);
    box.appendChild(wrap);
  }

  // ---------- scheduled tasks ----------
  async function renderSchedules(wrap) {
    let list = [];
    try { list = await api.scheduleList(); } catch { list = []; }
    const head = h('div', 'glance-title sched-head');
    head.innerHTML = '<span>Scheduled</span>';
    const add = h('button', 'btn ghost sm', 'New'); add.onclick = () => editSchedule(null);
    head.appendChild(add); wrap.appendChild(head);
    if (!list.length) { wrap.appendChild(h('div', 'sched-empty', 'No scheduled tasks.')); return; }
    for (const s of list) {
      const row = h('div', 'task-row sched' + (s.enabled === false ? ' off' : ''));
      const next = s.enabled !== false && s.nextRun ? `next ${new Date(s.nextRun).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}` : 'off';
      row.innerHTML = `<span class="tr-mark">${icon('clock', 'sm')}</span><div class="tr-main"><div class="task-title"></div><div class="sched-when"></div>${s.lastError ? '<div class="task-error"></div>' : ''}</div><span class="sched-acts"><button class="btn ghost sm" data-a="run">Run now</button><button class="btn ghost sm" data-a="edit">Edit</button><button class="btn ghost sm" data-a="toggle">${s.enabled === false ? 'Turn on' : 'Pause'}</button><button class="btn ghost sm" data-a="del">Delete</button></span>`;
      $('.task-title', row).textContent = s.name;
      $('.sched-when', row).textContent = `${s.when} · ${next} · ${baseName(s.projectDir)}`;
      if (s.lastError) $('.task-error', row).textContent = `Last run failed: ${s.lastError}`;
      row.querySelectorAll('[data-a]').forEach((b) => (b.onclick = async () => {
        const a = b.dataset.a;
        if (a === 'run') { const r = await api.scheduleRunNow(s.id); if (r?.error) toast(r.error); }
        else if (a === 'edit') return editSchedule(s);
        else if (a === 'toggle') { const r = await api.scheduleSave({ ...s, enabled: s.enabled === false }); if (r?.error) toast(r.error); }
        else if (a === 'del') { if (!(await confirmBox('Delete this scheduled task?', s.name, 'Delete'))) return; await api.scheduleDelete(s.id); }
        renderTasks();
      }));
      wrap.appendChild(row);
    }
  }
  function editSchedule(s) {
    if (!S.project && !s) { toast('Open a project first.'); return; }
    const o = h('div', 'overlay center');
    const m = h('div', 'modal sched-modal'); m.style.width = 'min(520px, 94vw)';
    m.setAttribute('role', 'dialog'); m.setAttribute('aria-modal', 'true');
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    m.innerHTML = `<div class="modal-head"><h2>${s ? 'Edit scheduled task' : 'New scheduled task'}</h2><button type="button" class="icon-btn modal-close" title="Close">${icon('x', 'xs')}</button></div>
      <div class="modal-body sched-form">
        <label>Name<input class="input" id="schName" placeholder="Morning test run"></label>
        <label>What DROPs should do<textarea class="textarea" id="schPrompt" rows="4" placeholder="Run the tests. If any fail, find the cause and tell me in a short report."></textarea></label>
        <div class="sched-grid">
          <label>Repeat<select class="input" id="schRepeat"><option value="daily">Every day</option><option value="weekdays">Weekdays</option><option value="weekly">Every week</option><option value="hourly">Every hour</option><option value="once">Once</option></select></label>
          <label id="schTimeL"><span id="schTimeLbl">Time</span><input class="input" id="schTime" type="time" value="09:00"></label>
          <label id="schDayL">Day<select class="input" id="schDay">${days.map((d, i) => `<option value="${i}">${d}</option>`).join('')}</select></label>
          <label id="schAtL">Date and time<input class="input" id="schAt" type="datetime-local"></label>
          <label>Permissions<select class="input" id="schMode"><option value="ask">Ask before changes</option><option value="auto-edit">Edits on its own</option><option value="yolo">Full auto</option></select></label>
        </div>
        <div class="sched-note">Runs in a new session of <b></b> with the model ${esc(s?.model || $('#modelSel').value || 'auto')}. Questions it asks wait for you in that session.</div>
      </div>`;
    const f = h('div', 'modal-foot'); const no = h('button', 'btn', 'Cancel'); const yes = h('button', 'btn primary', s ? 'Save' : 'Schedule');
    f.append(no, yes); m.appendChild(f); o.appendChild(m); document.body.appendChild(o);
    $('.sched-note b', m).textContent = baseName(s?.projectDir || S.project);
    const v = (id) => $(id, m);
    v('#schName').value = s?.name || ''; v('#schPrompt').value = s?.prompt || '';
    v('#schRepeat').value = s?.repeat || 'daily'; v('#schTime').value = s?.time || '09:00'; v('#schDay').value = String(s?.weekday ?? 1);
    v('#schMode').value = s?.mode || (currentOpts().mode === 'plan' ? 'ask' : currentOpts().mode) || 'auto-edit';
    if (s?.at) { const d = new Date(s.at); v('#schAt').value = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); }
    const sync = () => {
      const r = v('#schRepeat').value;
      v('#schTimeL').hidden = r === 'once';
      v('#schTimeLbl').textContent = r === 'hourly' ? 'Time (runs at :MM)' : 'Time';
      v('#schDayL').hidden = r !== 'weekly';
      v('#schAtL').hidden = r !== 'once';
    };
    v('#schRepeat').onchange = sync; sync();
    const close = () => { document.removeEventListener('keydown', onEsc, true); o.remove(); };
    const onEsc = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } };
    document.addEventListener('keydown', onEsc, true);
    no.onclick = close;
    $('.modal-close', m).onclick = close;
    o.onclick = (e) => { if (e.target === o) close(); };
    yes.onclick = async () => {
      const r = await api.scheduleSave({
        ...(s || {}), name: v('#schName').value, prompt: v('#schPrompt').value, repeat: v('#schRepeat').value, time: v('#schTime').value,
        weekday: +v('#schDay').value, at: v('#schAt').value ? new Date(v('#schAt').value).getTime() : undefined, mode: v('#schMode').value,
        projectDir: s?.projectDir || S.project, model: s?.model || $('#modelSel').value, effort: s?.effort || $('#effortSel').value,
      });
      if (r?.error) { toast(r.error); return; }
      close(); toast(`Scheduled: ${r.name} (${r.when})`); renderTasks();
    };
    v('#schPrompt').focus();
  }

  function renderPlan() {
    const box = $('#planBody'); box.innerHTML = '';
    const v = currentView();
    const todos = v?.data.todos || [];
    box.appendChild(overviewPanel());
    if (v?.data.plan?.goal) {
      const p = v.data.plan;
      const card = h('div', 'plan-artifact-card');
      card.innerHTML = `<div class="pa-head"><span class="pa-badge">${icon('list', 'xs')} Active Plan</span><button class="btn primary sm pa-proceed">Proceed</button></div><div class="pa-goal"></div>`;
      $('.pa-goal', card).textContent = p.goal;
      $('.pa-proceed', card).onclick = () => {
        if (typeof setMode === 'function' && currentOpts().mode === 'plan') { setMode('auto-edit'); persistOpts?.(); }
        sendText('Proceed with the implementation plan.');
      };
      box.appendChild(card);
    }
    if (!todos.length) { if (!Object.keys(v?.data.changes || {}).length && !v?.data.plan?.goal) box.appendChild(howPanel()); return; }
    const done = todos.filter((t) => t.status === 'completed').length;
    const head = h('div', 'todo-head'); head.innerHTML = `<span>Task plan</span><span>${done}/${todos.length}</span>`;
    const pr = h('div', 'progress'); const bar = h('div'); bar.style.width = `${(done / todos.length) * 100}%`; pr.appendChild(bar);
    box.append(head, pr);
    for (const t of todos) { const r = h('div', 'todo ' + t.status); r.innerHTML = `<span class="box">${window.taskMark ? window.taskMark(t.status) : ''}</span>`; r.appendChild(h('span', 't', t.content)); box.appendChild(r); }
  }
  function renderChanges() {
    if (!$('#planBody').hidden) renderPlan();
    const box = $('#changesBody'); box.innerHTML = '';
    const v = currentView();
    const ch = v?.data.changes || {};
    const keys = Object.keys(ch).sort();
    $('#changesBadge').hidden = !keys.length; $('#changesBadge').textContent = keys.length;
    if (v?.data.worktree) {
      const wt = v.data.worktree;
      const card = h('div', 'wt-card');
      card.innerHTML = `<div>${icon('merge', 'sm')} <b></b></div><small>Isolated worktree based on <code></code>. Merge it back when you're happy, or discard it.</small>`;
      $('b', card).textContent = wt.branch; $('code', card).textContent = wt.base;
      const row = h('div', 'btn-row');
      const merge = h('button', 'btn primary sm'); merge.innerHTML = icon('merge', 'xs') + `Merge into ${wt.base}`;
      merge.onclick = async () => {
        if (!(await confirmBox(`Merge ${wt.branch}?`, `All changes in this worktree are committed and merged into ${wt.base} in your main checkout.`, 'Merge'))) return;
        const r = await api.worktreeMerge(v.id); toast(r.error || r.message);
      };
      const del = h('button', 'btn sm danger'); del.innerHTML = icon('trash', 'xs') + 'Discard worktree';
      del.onclick = async () => {
        if (!(await confirmBox('Discard this worktree?', `The folder and branch ${wt.branch} are deleted, including any unmerged changes. This cannot be undone.`, 'Discard'))) return;
        const r = await api.worktreeRemove(v.id);
        if (r.error) { toast(r.error); return; }
        v.el.remove(); S.views.delete(v.id); S.current = null; await setProject(wt.repo); toast('Worktree discarded');
      };
      row.append(merge, del); card.appendChild(row); box.appendChild(card);
    }
    if (!keys.length) { box.appendChild(h('div', 'empty', 'Files the agent changes in this session appear here. Review each change or revert a file with one click.')); return; }
    let A = 0, D = 0;
    for (const k of keys) { A += ch[k].added; D += ch[k].removed; }
    const head = h('div', 'changes-head');
    head.innerHTML = `<span class="ov-sec-t">${keys.length} file${keys.length > 1 ? 's' : ''} · <span class="mono"><span class="add-n">+${A}</span> <span class="del-n">−${D}</span></span></span><span class="changes-acts"><button type="button" class="btn ghost sm ch-review" title="Ask DROPs to review changes">${icon('eye', 'xs')}Review</button>${keys.length > 1 ? `<button type="button" class="btn ghost sm ch-revert-all" title="Revert all session file changes">${icon('undo', 'xs')}Revert all</button>` : ''}</span>`;
    $('.ch-review', head).onclick = () => sendText('/review');
    const revAll = $('.ch-revert-all', head);
    if (revAll) {
      revAll.onclick = async () => {
        if (!(await confirmBox(`Revert all ${keys.length} changed files?`, 'Every file changed in this session will be restored to its pre-session state.', 'Revert all'))) return;
        for (const k of keys) await api.revertFile(v.id, k);
        Editor.reloadAll?.();
        refreshGitSoon();
        toast(`Reverted ${keys.length} files`);
      };
    }
    box.appendChild(head);
    for (const k of keys) {
      const c = ch[k];
      const r = h('div', 'row');
      r.innerHTML = `${icon('fileCode', 'ficon')}<span class="t mono" style="font-size:12px"></span><span class="meta mono"><span class="add-n">+${c.added}</span> <span class="del-n">−${c.removed}</span></span><span class="acts"><button type="button" title="Review diff">${icon('diff', 'xs')}</button><button type="button" title="Revert this file to before the session">${icon('undo', 'xs')}</button></span>`;
      $('.t', r).textContent = k; r.title = k;
      r.onclick = () => Editor.openSessionDiff(k);
      const [rev, undo] = $$('.acts button', r);
      rev.onclick = (e) => { e.stopPropagation(); Editor.openSessionDiff(k); };
      undo.onclick = async (e) => {
        e.stopPropagation();
        if (!(await confirmBox(`Revert ${baseName(k)}?`, 'The file is restored to how it was before this session changed it (a file the agent created is deleted). Tell the agent afterwards so it does not rely on the reverted code.', 'Revert'))) return;
        const res = await api.revertFile(v.id, k);
        if (res.error) toast(res.error); else { toast(`Reverted ${baseName(k)}`); Editor.reloadFile(k); refreshGitSoon(); }
      };
      box.appendChild(r);
    }
  }
  function renderUsage() {
    if (!$('#planBody').hidden) renderPlan();
    const box = $('#usageBody');
    const u = currentView()?.data.usage;
    if (!u) { box.innerHTML = '<div class="empty">Token usage and cost for the session appear here.</div>'; return; }
    const totalIn = (u.input || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0);
    const hit = totalIn ? Math.round(((u.cacheRead || 0) / totalIn) * 100) : 0;
    const compactLimit = S.settings?.compactAt || 180000;
    const maxWin = contextMax();
    const ctxPct = Math.min(100, Math.round(((u.context || 0) / maxWin) * 100));
    const curModelId = currentOpts().model || '';
    const isGem = /gemini/i.test(curModelId);
    const costNote = u.costUnknown && !u.cost
      ? (isGem ? 'Billed by Google AI Studio' : 'Local or unpriced model · token usage tracked below')
      : `${u.requests || 0} API request${(u.requests || 0) === 1 ? '' : 's'} this session`;
    const maxCost = Number(S.settings?.maxCostPerTask) || 0;
    const maxTok = Number(S.settings?.maxTokensPerTask) || 0;

    box.innerHTML = `<div class="usage-wrap">
      <section class="ov-sec">
        <div class="ov-sec-head"><span class="ov-sec-t">Telemetry</span><span class="ov-st">${esc(costNote)}</span></div>
        <div class="ov-metrics">
          <div class="ov-metric"><span class="ov-m-v">${u.costUnknown && !u.cost ? '$0.00' : fmtCost(u.cost)}</span><span class="ov-m-l">Session cost</span></div>
          <div class="ov-metric"><span class="ov-m-v">${fmtTok(totalIn)}</span><span class="ov-m-l">Input tokens</span></div>
          <div class="ov-metric"><span class="ov-m-v">${fmtTok(u.output)}</span><span class="ov-m-l">Output tokens</span></div>
        </div>
        <div class="ov-spec">
          <div class="ov-spec-row"><span class="ov-sk">Prompt cache hit rate</span><span class="ov-sv mono">${hit}% (${fmtTok(u.cacheRead || 0)} read)</span></div>
          <div class="ov-spec-row"><span class="ov-sk">API round-trips</span><span class="ov-sv mono">${u.requests || 0}</span></div>
          ${maxCost > 0 ? `<div class="ov-spec-row"><span class="ov-sk">Task cost ceiling</span><span class="ov-sv mono">${fmtCost(u.cost || 0)} / ${fmtCost(maxCost)}</span></div>` : ''}
          ${maxTok > 0 ? `<div class="ov-spec-row"><span class="ov-sk">Task token ceiling</span><span class="ov-sv mono">${fmtTok(totalIn + (u.output || 0))} / ${fmtTok(maxTok)}</span></div>` : ''}
        </div>
      </section>
      <section class="ov-sec">
        <div class="ov-sec-head"><span class="ov-sec-t">Context window</span><span class="ov-st mono">${fmtTok(u.context)} / ${fmtTok(maxWin)} (${ctxPct}%)</span></div>
        <div class="ov-ctx-row" style="padding:4px 2px">
          <span class="ov-ctx-track"><i style="width:${ctxPct}%"></i></span>
        </div>
        <div class="ov-spec">
          <div class="ov-spec-row"><span class="ov-sk">Auto-compact threshold</span><span class="ov-sv mono">${fmtTok(compactLimit)} tokens</span></div>
        </div>
      </section>
    </div>`;
    const b = h('button', 'btn sm block'); b.style.marginTop = '12px'; b.innerHTML = icon('layers', 'xs') + 'Compact context now'; b.onclick = compactNow;
    box.appendChild(b);
  }

  // Live timers of the background tasks shown in the Overview panel.
  let bgTimer = null;
  function tickBackground() {
    const update = () => {
      const els = document.querySelectorAll('#planBody .bg-time');
      if (!els.length) { clearInterval(bgTimer); bgTimer = null; return; }
      for (const el of els) {
        const t0 = Number(el.dataset.start);
        if (!t0) { el.textContent = 'running'; continue; }
        const s = Math.round((Date.now() - t0) / 1000);
        el.textContent = s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
      }
    };
    update();
    if (!bgTimer) bgTimer = setInterval(update, 1000);
  }

  // processes
  function onProc(v, ev) {
    let p = v.procs.get(ev.id);
    if (ev.started) { p = { id: ev.id, name: ev.name, command: ev.command, running: true, code: null, out: '', startedAt: Date.now() }; v.procs.set(ev.id, p); }
    if (!p) return;
    if (ev.chunk) { p.out += ev.chunk; if (p.out.length > 200000) p.out = p.out.slice(-150000); }
    if (ev.exited) { p.running = false; p.code = ev.code; }
    if (S.current !== v.id) return;
    // Like Claude Code: a process starting does not pull you away; it shows under Background tasks.
    if (ev.started || ev.exited) { renderBgProcs(); renderStatus(); renderPlan(); return; }
    const pre = document.querySelector(`.proc[data-id="${ev.id}"] pre`);
    if (pre) { const stick = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40; pre.textContent = p.out.slice(-20000); if (stick) pre.scrollTop = pre.scrollHeight; }
  }
  let termLog = '', termRunning = false, termShellLabel = 'Shell', termCwd = '', termHistory = [], termHistIdx = -1, termHooked = false;
  function ensureTermHook() {
    if (termHooked) return;
    termHooked = true;
    api.onTermData?.((chunk) => {
      termLog += chunk;
      if (termLog.length > 100000) termLog = termLog.slice(-80000);
      if (/\[terminal exited:/.test(chunk)) { termRunning = false; syncTermHeadUi(); }
      const pre = $('#termLiveOut');
      if (pre) { pre.textContent = termLog.slice(-20000); pre.scrollTop = pre.scrollHeight; }
    });
  }
  function syncTermHeadUi() {
    const card = $('#termLiveCard');
    if (!card) return;
    $('.state', card)?.classList.toggle('on', termRunning);
    const startBtn = $('.term-start', card);
    if (startBtn) startBtn.textContent = termRunning ? 'Stop' : 'Start shell';
    const meta = $('.term-meta', card);
    if (meta) meta.textContent = `${termShellLabel}${S.project ? ' · ' + baseName(S.project) : ''}`;
  }
  function renderBgProcs() {
    let listBox = $('#bgProcList');
    if (!listBox) { renderProcs(); return; }
    listBox.innerHTML = '';
    const v = currentView();
    const procs = v ? [...v.procs.values()] : [];
    const running = procs.filter((p) => p.running).length;
    $('#procBadge').hidden = !running; $('#procBadge').textContent = running;
    for (const p of procs.slice().reverse()) {
      const d = h('div', 'proc'); d.dataset.id = p.id;
      const head = h('div', 'proc-head');
      head.innerHTML = `<span class="state ${p.running ? 'on' : ''}"></span><b class="grow" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></b><span class="meta muted mono">${p.running ? 'running' : `exit ${p.code}`}</span>`;
      $('b', head).textContent = `${p.id} · ${p.name}`; head.title = p.command;
      const cp = h('button', 'btn ghost sm'); cp.type = 'button'; cp.innerHTML = icon('copy', 'xs'); cp.title = 'Copy process output';
      cp.onclick = () => { navigator.clipboard.writeText(p.out || ''); toast('Copied process output'); };
      head.appendChild(cp);
      if (p.running) { const s = h('button', 'btn sm'); s.type = 'button'; s.innerHTML = icon('square', 'xs') + 'Stop'; s.onclick = () => api.procStop(v.id, p.id); head.appendChild(s); }
      const pre = h('pre'); pre.textContent = (p.out || '').slice(-20000);
      d.append(head, pre); listBox.appendChild(d);
      if (!p.out) api.procOutput(v.id, p.id).then((o) => { if (o) { p.out = o; pre.textContent = o.slice(-20000); pre.scrollTop = pre.scrollHeight; } });
      setTimeout(() => (pre.scrollTop = pre.scrollHeight));
    }
  }

  function renderProcs() {
    ensureTermHook();
    if (termRunning && termCwd && S.project && termCwd.toLowerCase() !== S.project.toLowerCase()) {
      termRunning = false;
      termCwd = '';
    }
    const box = $('#termBody'); box.innerHTML = '';
    const termCard = h('div', 'term-card');
    termCard.id = 'termLiveCard';
    termCard.innerHTML = `
      <div class="proc-head">
        <span class="state ${termRunning ? 'on' : ''}"></span>
        <b>Terminal</b>
        <span class="term-meta grow"></span>
        <button type="button" class="btn ghost sm term-int" title="Send Ctrl+C interrupt">Ctrl+C</button>
        <button type="button" class="btn ghost sm term-copy" title="Copy terminal output">${icon('copy', 'xs')}</button>
        <button type="button" class="btn ghost sm term-clear">Clear</button>
        <button type="button" class="btn sm term-start">${termRunning ? 'Stop' : 'Start shell'}</button>
      </div>
      <pre class="term-live" id="termLiveOut"></pre>
      <div class="term-in-row"><span class="mono muted">$</span><input class="input sm term-in mono" placeholder="Run shell command in project folder (Enter to run, ↑/↓ history)…" /></div>
    `;
    const preLive = $('.term-live', termCard);
    preLive.textContent = termLog.slice(-20000) || `Interactive project shell (${S.project ? baseName(S.project) : 'no project open'}).\nType any command below and press Enter.`;
    $('.term-clear', termCard).onclick = () => { termLog = ''; preLive.textContent = ''; };
    $('.term-copy', termCard).onclick = () => { navigator.clipboard.writeText(termLog || ''); toast('Copied terminal output'); };
    $('.term-int', termCard).onclick = async () => {
      if (!termRunning) return;
      await api.termInterrupt?.();
      termLog += '^C\n';
      preLive.textContent = termLog.slice(-20000);
      preLive.scrollTop = preLive.scrollHeight;
    };
    const startShell = async () => {
      if (!S.project) { toast('Open a project folder first'); return false; }
      const r = await api.termStart?.(S.project);
      termRunning = !!r?.running;
      if (r?.label) termShellLabel = r.label;
      if (r?.cwd) termCwd = r.cwd;
      syncTermHeadUi();
      return termRunning;
    };
    $('.term-start', termCard).onclick = async () => {
      if (termRunning) { await api.termStop?.(); termRunning = false; syncTermHeadUi(); return; }
      try { if (await startShell()) $('.term-in', termCard)?.focus(); } catch (e) { toast(e.message || 'Could not start shell'); }
    };
    const inp = $('.term-in', termCard);
    inp.onkeydown = async (e) => {
      if (e.ctrlKey && e.key.toLowerCase() === 'l') {
        e.preventDefault(); termLog = ''; preLive.textContent = ''; return;
      }
      if (e.ctrlKey && e.key.toLowerCase() === 'c' && !inp.value) {
        e.preventDefault(); $('.term-int', termCard)?.click(); return;
      }
      if (e.key === 'ArrowUp' && termHistory.length) {
        e.preventDefault();
        termHistIdx = termHistIdx < 0 ? termHistory.length - 1 : Math.max(0, termHistIdx - 1);
        inp.value = termHistory[termHistIdx] || '';
      } else if (e.key === 'ArrowDown' && termHistIdx >= 0) {
        e.preventDefault();
        termHistIdx = termHistIdx + 1 >= termHistory.length ? -1 : termHistIdx + 1;
        inp.value = termHistIdx < 0 ? '' : termHistory[termHistIdx];
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const cmd = inp.value;
        if (!cmd.trim()) return;
        termHistory.push(cmd); termHistIdx = -1; inp.value = '';
        if (!termRunning) { try { if (!(await startShell())) return; } catch (err) { toast(err.message); return; } }
        termLog += `${termLog && !termLog.endsWith('\n') ? '\n' : ''}$ ${cmd}\n`;
        preLive.textContent = termLog.slice(-20000);
        preLive.scrollTop = preLive.scrollHeight;
        await api.termInput?.(cmd);
      }
    };
    box.appendChild(termCard);
    syncTermHeadUi();
    const listBox = h('div', 'bg-proc-list');
    listBox.id = 'bgProcList';
    box.appendChild(listBox);
    renderBgProcs();
  }

  // ---------- status bar ----------
  function renderStatus() {
    const sb = $('#statusbar');
    const v = currentView();
    const o = currentOpts();
    const u = v?.data.usage;
    const running = v ? [...v.procs.values()].filter((p) => p.running).length : 0;
    S.sbYolo = o.mode === 'yolo';
    sb.innerHTML = '';
    const item = (html, title, onclick, cls = '') => { const e = h(onclick ? 'button' : 'span', 'sb ' + cls); e.innerHTML = html; if (title) e.title = title; if (onclick) e.onclick = onclick; sb.appendChild(e); };
    if (v?.data.worktree) item(`${icon('merge')}${esc(v.data.worktree.branch)}`, 'This session works in its own git worktree — see the Changes tab to merge it', () => switchTab('changes'), 'warn');
    if (S.git?.isRepo) item(`${icon('branch')}${esc(S.git.branch)}${S.git.files.length ? ` · ${S.git.files.length} changed` : ''}`, 'Source control', () => showSide('scm'));
    else if (S.project) item(`${icon('folder')}${esc(baseName(S.project))}`, S.project, pickProject);
    if (running) item(`${icon('terminal')}${running} process${running > 1 ? 'es' : ''} running`, 'Background processes', () => switchTab('terminal'));
    if (v?.busy) item(`${waterOrbSVG(14)}Agent working`, 'DROPs agent active', null, 'sb-water');
    if (o.model === 'auto' && v?.autoModel) item(`${icon('zap')}${esc(v.autoModel)}`, 'Auto-selected model', null);
    sb.appendChild(h('div', 'spacer'));
    const mcpOn = (S.mcp || []).filter((x) => x.status === 'connected').length;
    if ((S.mcp || []).length) item(`${icon('plug')}MCP ${mcpOn}/${S.mcp.length}`, (S.mcp || []).map((x) => `${x.name}: ${x.status}`).join('\n'), () => openSettings('tools'), mcpOn < S.mcp.length ? 'warn' : '');
    if (S.settings?.sandbox) item(`${icon('box')}Sandbox`, 'Commands run inside Docker', () => openSettings('safety'));
    if (S.settings?.responseLanguage && !['en', 'auto'].includes(S.settings.responseLanguage)) item(`${icon('languages')}${esc(S.settings.responseLanguage.toUpperCase())}${S.settings.explainMode ? ' · teach' : ''}`, 'Explanation language', () => openSettings('agent'));
    if (u) item(`${fmtTok(u.context)} ctx · ${u.costUnknown && !u.cost ? fmtTok(u.input + u.cacheRead + u.output) + ' tok' : fmtCost(u.cost)}`, 'Usage', () => switchTab('usage'));
    const LENS_NAMES = { default: 'IDE', focus: 'Focus', studio: 'Studio', mission: 'Mission' };
    item(`${icon('grid')}${LENS_NAMES[S.lens] || 'IDE'}`, 'Switch workspace layout lens (Ctrl+Shift+F / S / M)', () => {
      const order = ['default', 'focus', 'studio', 'mission'];
      setLens(order[(order.indexOf(S.lens || 'default') + 1) % order.length]);
    });
  }

  // ---------- codebase impact map ----------
  let mapSeq = 0, mapSelectedId = null, mapFilter = '';
  function sessionTouchedFiles(v) {
    const out = new Set();
    const normRel = (p) => {
      if (!p || typeof p !== 'string') return '';
      let s = p.replace(/\\/g, '/').replace(/^\.\//, '');
      if (S.project) {
        const root = S.project.replace(/\\/g, '/').replace(/\/+$/, '') + '/';
        if (s.toLowerCase().startsWith(root.toLowerCase())) s = s.slice(root.length);
      }
      return s;
    };
    for (const k of Object.keys(v?.data?.changes || {})) out.add(normRel(k));
    for (const m of Object.values(v?.data?.toolMeta || {})) {
      const p = normRel(m?.input?.path);
      if (p) out.add(p);
    }
    for (const f of S.git?.files || []) { const p = normRel(f.path); if (p) out.add(p); }
    return [...out].filter(Boolean);
  }
  async function renderMap() {
    const box = $('#mapBody');
    if (!box) return;
    const seq = ++mapSeq;
    box.innerHTML = '';
    if (!S.project) {
      const emp = h('div', 'empty', 'Open a project folder to see its live import graph and change blast radius.');
      const b = h('button', 'btn sm', 'Open project folder'); b.onclick = pickProject; emp.append(h('br'), b);
      box.appendChild(emp);
      return;
    }
    const load = h('div', 'empty', 'Mapping module imports and dependents…');
    box.appendChild(load);
    const v = currentView();
    const touched = sessionTouchedFiles(v);
    const res = await api.codeMap?.(S.project, touched).catch(() => null);
    if (seq !== mapSeq) return;
    box.innerHTML = '';
    if (!res || !res.nodes?.length) {
      box.appendChild(h('div', 'empty', 'No source modules indexed yet in this folder.'));
      return;
    }
    const ch = v?.data?.changes || {};
    const wrap = h('div', 'map-wrap');
    const head = h('div', 'map-head');
    const actCount = res.nodes.filter((n) => n.touched).length;
    head.innerHTML = `<div class="map-stats"><span class="map-stat"><b>${res.totalFiles}</b> files</span><span class="map-stat"><b>${actCount}</b> active</span><span class="map-stat ${res.blastRadius.length ? 'warn' : ''}"><b>${res.blastRadius.length}</b> blast radius</span></div>
      <div class="map-acts"><button type="button" class="btn sm ghost map-studio" title="Expand inspector to wide Studio view">${S.lens === 'studio' ? 'Standard' : 'Wide view'}</button><button type="button" class="icon-btn map-ref" title="Refresh map">${icon('refresh', 'xs')}</button></div>`;
    $('.map-studio', head).onclick = () => setLens(S.lens === 'studio' ? 'default' : 'studio');
    $('.map-ref', head).onclick = () => renderMap();
    wrap.appendChild(head);

    const searchRow = h('div', 'map-search-row');
    searchRow.innerHTML = `<input class="input sm map-filter" placeholder="Filter modules or symbols…" />`;
    const filterInp = $('.map-filter', searchRow);
    filterInp.value = mapFilter;
    wrap.appendChild(searchRow);

    const detailHost = h('div');
    const svgHost = h('div');
    const paintDetail = (node) => {
      detailHost.innerHTML = '';
      if (!node) return;
      const d = h('div', 'map-detail');
      d.innerHTML = `
        <div class="map-detail-top"><span class="map-detail-path" title="${esc(node.id)}">${esc(node.id)}</span><span class="map-detail-meta mono">${node.inDeg} in · ${node.outDeg} out</span></div>
        ${node.syms?.length ? `<div class="map-detail-syms">exports: ${esc(node.syms.join(', '))}</div>` : ''}
        <div class="map-detail-acts">
          <button type="button" class="btn sm primary md-open">${icon('fileCode', 'xs')}Open file</button>
          <button type="button" class="btn sm ghost md-at">${icon('at', 'xs')}Mention</button>
          ${ch[node.id] ? `<button type="button" class="btn sm ghost md-diff">${icon('diff', 'xs')}Diff</button>` : ''}
        </div>
      `;
      $('.md-open', d).onclick = () => Editor.openFile(node.id);
      $('.md-at', d).onclick = () => insertAtCursor(`@${node.id} `);
      const df = $('.md-diff', d); if (df) df.onclick = () => Editor.openSessionDiff(node.id);
      detailHost.appendChild(d);
    };

    const drawSvg = () => {
      svgHost.innerHTML = '';
      const q = mapFilter.trim().toLowerCase();
      const filtered = q
        ? res.nodes.filter((n) => n.id.toLowerCase().includes(q) || (n.syms || []).some((s) => s.toLowerCase().includes(q)))
        : res.nodes;
      const shown = (filtered.length ? filtered : res.nodes).slice(0, 18);
      const hasFocus = shown.some((n) => n.touched || n.blast > 0);
      const pos = new Map();
      const W = 540;
      const NW = 148, NH = 32;
      if (hasFocus) {
        const left = shown.filter((n) => !n.touched && n.blast > 0).slice(0, 6);
        const mid = shown.filter((n) => n.touched).slice(0, 7);
        const right = shown.filter((n) => !n.touched && n.blast === 0).slice(0, 7);
        const cols = [[left, 90], [mid, 270], [right, 450]].filter(([arr]) => arr.length);
        if (cols.length === 1) cols[0][1] = 270;
        else if (cols.length === 2) { cols[0][1] = 155; cols[1][1] = 385; }
        const maxRows = Math.max(...cols.map(([arr]) => arr.length), 1);
        const H = Math.max(210, maxRows * 48 + 32);
        for (const [arr, cx] of cols) {
          const gap = (H - 24) / Math.max(arr.length, 1);
          arr.forEach((n, i) => pos.set(n.id, { x: cx, y: 12 + gap * (i + 0.5) }));
        }
        svgHost.appendChild(buildMapSvg(W, H, NW, NH, shown, res.edges, pos, ch, paintDetail));
      } else {
        const colsN = shown.length <= 6 ? 2 : 3;
        const rowsN = Math.ceil(shown.length / colsN);
        const H = Math.max(190, rowsN * 50 + 28);
        const xs = colsN === 2 ? [155, 385] : [92, 270, 448];
        shown.forEach((n, i) => {
          const c = i % colsN, r = Math.floor(i / colsN);
          const gap = (H - 20) / rowsN;
          pos.set(n.id, { x: xs[c], y: 10 + gap * (r + 0.5) });
        });
        svgHost.appendChild(buildMapSvg(W, H, NW, NH, shown, res.edges, pos, ch, paintDetail));
      }
      const selNode = shown.find((n) => n.id === mapSelectedId) || shown.find((n) => n.touched) || shown[0];
      if (selNode) { mapSelectedId = selNode.id; paintDetail(selNode); }
    };

    filterInp.oninput = () => { mapFilter = filterInp.value; drawSvg(); };
    drawSvg();
    wrap.append(svgHost, detailHost);

    const leg = h('div', 'map-legend');
    leg.innerHTML = '<span><i class="lg-dot mod"></i>Edited</span><span><i class="lg-dot tch"></i>Read</span><span><i class="lg-dot bls"></i>Blast radius</span><span><i class="lg-dot hub"></i>Module</span>';
    wrap.appendChild(leg);

    if (res.blastRadius.length) {
      wrap.appendChild(h('div', 'glance-title', `Potential impact (${res.blastRadius.length} dependent${res.blastRadius.length === 1 ? '' : 's'})`));
      const list = h('div', 'map-blast');
      for (const b of res.blastRadius.slice(0, 12)) {
        const r = h('button', 'row map-b-row');
        r.innerHTML = `${icon('fileCode', 'ficon')}<span class="t mono"></span><span class="meta">depth ${b.depth}</span>`;
        $('.t', r).textContent = b.id; r.title = `Open ${b.id}`;
        r.onclick = () => Editor.openFile(b.id);
        list.appendChild(r);
      }
      wrap.appendChild(list);
    } else {
      wrap.appendChild(h('div', 'glance-title', 'Key connected modules'));
      const list = h('div', 'map-blast');
      for (const n of res.nodes.slice(0, 8)) {
        const r = h('button', 'row map-b-row');
        r.innerHTML = `${icon('fileCode', 'ficon')}<span class="t mono"></span><span class="meta mono">${n.inDeg} in · ${n.outDeg} out</span>`;
        $('.t', r).textContent = n.id; r.title = n.syms?.length ? `Symbols: ${n.syms.join(', ')}` : n.id;
        r.onclick = () => Editor.openFile(n.id);
        list.appendChild(r);
      }
      wrap.appendChild(list);
    }
    box.appendChild(wrap);
  }
  function buildMapSvg(W, H, NW, NH, nodes, edges, pos, ch, onSelect) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'map-svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const edgeEls = [];
    const nodeEls = new Map();
    for (const e of edges) {
      const a = pos.get(e.from), b = pos.get(e.to);
      if (!a || !b) continue;
      const fn = byId.get(e.from), tn = byId.get(e.to);
      const isBlast = fn?.blast > 0 && tn?.touched;
      const isAct = fn?.touched || tn?.touched;
      const pathEl = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      let d;
      if (Math.abs(a.x - b.x) < 10) {
        const curve = a.x < 270 ? -44 : 44;
        d = `M${a.x} ${a.y} C${a.x + curve} ${a.y}, ${b.x + curve} ${b.y}, ${b.x} ${b.y}`;
      } else if (Math.abs(a.x - b.x) > 250) {
        const midX = (a.x + b.x) / 2;
        const bow = a.y <= H / 2 ? -58 : 58;
        d = `M${a.x} ${a.y} Q${midX} ${(a.y + b.y) / 2 + bow} ${b.x} ${b.y}`;
      } else {
        const mx = (a.x + b.x) / 2;
        d = `M${a.x} ${a.y} C${mx} ${a.y}, ${mx} ${b.y}, ${b.x} ${b.y}`;
      }
      pathEl.setAttribute('d', d);
      pathEl.setAttribute('class', 'map-edge' + (isBlast ? ' blast' : isAct ? ' active' : ''));
      svg.appendChild(pathEl);
      edgeEls.push({ el: pathEl, from: e.from, to: e.to });
    }
    for (const n of nodes) {
      const p = pos.get(n.id);
      if (!p) continue;
      const isMod = !!ch[n.id];
      const cls = isMod ? 'modified' : n.touched ? 'touched' : n.blast > 0 ? 'blast' : 'hub';
      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      g.setAttribute('class', `map-node ${cls}` + (n.id === mapSelectedId ? ' selected' : ''));
      g.setAttribute('transform', `translate(${p.x - NW / 2}, ${p.y - NH / 2})`);
      const tip = document.createElementNS('http://www.w3.org/2000/svg', 'title');
      tip.textContent = `${n.id}${n.syms?.length ? `\nSymbols: ${n.syms.join(', ')}` : ''}\n${n.inDeg} dependents · ${n.outDeg} imports`;
      g.appendChild(tip);
      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('width', String(NW));
      rect.setAttribute('height', String(NH));
      rect.setAttribute('rx', '6');
      const txt = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      txt.setAttribute('x', '10');
      txt.setAttribute('y', '20');
      txt.textContent = n.label.length > 16 ? n.label.slice(0, 15) + '…' : n.label;
      const badge = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      badge.setAttribute('x', String(NW - 8));
      badge.setAttribute('y', '20');
      badge.setAttribute('text-anchor', 'end');
      badge.setAttribute('class', 'map-node-meta');
      badge.textContent = isMod ? `+${ch[n.id].added}` : n.inDeg ? `↓${n.inDeg}` : '';
      g.append(rect, txt, badge);
      g.onmouseenter = () => {
        svg.classList.add('has-hover');
        const neighbors = new Set([n.id]);
        for (const ed of edgeEls) {
          const hit = ed.from === n.id || ed.to === n.id;
          ed.el.classList.toggle('hl', hit);
          if (hit) { neighbors.add(ed.from); neighbors.add(ed.to); }
        }
        for (const [id, ng] of nodeEls) ng.classList.toggle('hl', neighbors.has(id));
      };
      g.onmouseleave = () => {
        svg.classList.remove('has-hover');
        for (const ed of edgeEls) ed.el.classList.remove('hl');
        for (const [, ng] of nodeEls) ng.classList.remove('hl');
      };
      g.onclick = () => {
        mapSelectedId = n.id;
        for (const [id, ng] of nodeEls) ng.classList.toggle('selected', id === n.id);
        onSelect?.(n);
        Editor.openFile(n.id);
      };
      svg.appendChild(g);
      nodeEls.set(n.id, g);
    }
    const wrap = h('div', 'map-svg-wrap');
    wrap.appendChild(svg);
    return wrap;
  }

  // ---------- mission control fleet deck ----------
  let mcFilter = 'all', mcQuery = '';
  function renderMissionDeck() {
    const deck = $('#missionDeck');
    if (!deck) return;
    deck.innerHTML = '';
    const head = h('div', 'mc-head');
    // Merge live view state so titles/costs/changes are always up to date
    const allMerged = S.sessions.map((s) => {
      const live = S.views.get(s.id)?.data;
      return live ? { ...s, title: live.title || s.title, updated: Math.max(s.updated || 0, live.updated || 0), cost: live.usage?.cost ?? s.cost, model: live.model || s.model, worktree: live.worktree || s.worktree } : s;
    });
    const mine = S.project && mcFilter !== 'all-projects' ? allMerged.filter((s) => s.projectDir === S.project) : allMerged;
    const basePool = (mine.length ? mine : allMerged).slice().sort((a, b) => {
      const ab = S.views.get(a.id)?.busy ? 1 : 0, bb = S.views.get(b.id)?.busy ? 1 : 0;
      if (ab !== bb) return bb - ab;
      const aw = S.views.get(a.id)?.waiting?.size ? 1 : 0, bw = S.views.get(b.id)?.waiting?.size ? 1 : 0;
      if (aw !== bw) return bw - aw;
      return b.updated - a.updated;
    });
    const activeN = basePool.filter((s) => S.views.get(s.id)?.busy).length;
    const waitN = basePool.filter((s) => S.views.get(s.id)?.waiting?.size).length;
    const spent = basePool.reduce((sum, s) => sum + (s.cost || 0), 0);
    head.innerHTML = `<div class="mc-title-group"><h1>Mission Control</h1><p class="muted">${esc(S.project && mcFilter !== 'all-projects' ? baseName(S.project) : 'All projects')} · ${basePool.length} session${basePool.length === 1 ? '' : 's'}${activeN ? ` · ${activeN} running` : ''}${waitN ? ` · ${waitN} waiting` : ''}${spent ? ` · ${fmtCost(spent)} spent` : ''}</p></div>
      <div class="mc-actions"><button type="button" class="btn sm" id="mcNew">${icon('plus', 'xs')}New session</button><button type="button" class="btn sm" id="mcWorktree">${icon('merge', 'xs')}Parallel worktree</button><button type="button" class="btn sm primary" id="mcExit">Back to IDE</button></div>`;
    $('#mcNew', head).onclick = async () => { await newSession(); setLens('default'); };
    $('#mcWorktree', head).onclick = () => { newWorktreeSession(); };
    $('#mcExit', head).onclick = () => setLens('default');
    deck.appendChild(head);

    // Filter toolbar + quick task dispatch bar
    const toolbar = h('div', 'mc-toolbar');
    const filters = h('div', 'mc-filters');
    for (const [k, lbl] of [['all', 'Project'], ['active', 'Active'], ['worktrees', 'Worktrees'], ['all-projects', 'All projects']]) {
      const fb = h('button', 'mc-filter' + (mcFilter === k ? ' on' : ''), lbl);
      fb.type = 'button';
      fb.onclick = () => { mcFilter = k; renderMissionDeck(); };
      filters.appendChild(fb);
    }
    const searchInp = h('input', 'input sm mc-search');
    searchInp.placeholder = 'Filter sessions…';
    searchInp.value = mcQuery;
    searchInp.oninput = () => { mcQuery = searchInp.value; renderMissionDeck(); if ($('.mc-search', deck)) { const el = $('.mc-search', deck); el.focus(); el.selectionStart = el.selectionEnd = el.value.length; } };
    toolbar.append(filters, searchInp);
    deck.appendChild(toolbar);

    if (S.project) {
      const disp = h('div', 'mc-dispatch');
      disp.innerHTML = `${icon('zap', 'sm')}<input placeholder="Dispatch a new session in ${esc(baseName(S.project))}… (Enter to launch)" /><button type="button" class="btn sm primary">Dispatch</button>`;
      const dInp = $('input', disp), dBtn = $('button', disp);
      const launch = async () => {
        const prompt = dInp.value.trim();
        if (!prompt) return;
        await newSession();
        setLens('default');
        sendText(prompt);
      };
      dBtn.onclick = launch;
      dInp.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); launch(); } };
      deck.appendChild(disp);
    }

    const q = mcQuery.trim().toLowerCase();
    const pool = basePool.filter((s) => {
      const v = S.views.get(s.id);
      if (mcFilter === 'active' && !v?.busy && !(v?.waiting?.size)) return false;
      if (mcFilter === 'worktrees' && !(v?.data?.worktree || s.worktree)) return false;
      if (q && !(s.title || '').toLowerCase().includes(q) && !baseName(s.projectDir || '').toLowerCase().includes(q)) return false;
      return true;
    });

    if (!pool.length) {
      const empty = h('div', 'empty', basePool.length ? 'No sessions match the current filter.' : 'No sessions in this project yet. Start a session or launch a parallel worktree agent.');
      deck.appendChild(empty);
      return;
    }

    const modelLabelOf = (id) => S.info?.models?.find((m) => m.id === id)?.label || id || 'Auto';
    const grid = h('div', 'mc-grid');
    for (const s of pool.slice(0, 16)) {
      const v = S.views.get(s.id);
      const busy = !!v?.busy && !(v.waiting?.size);
      const wait = !!(v?.waiting?.size);
      const ch = v?.data?.changes || {};
      const chKeys = Object.keys(ch);
      let add = 0, del = 0;
      for (const k of chKeys) { add += ch[k].added; del += ch[k].removed; }
      const wt = v?.data?.worktree || s.worktree;
      const statusText = busy ? (v.workLabel || 'Working') : wait ? 'Needs you' : s.failed ? 'Error' : 'Idle';
      const statusCls = busy ? 'busy' : wait ? 'waiting' : s.failed ? 'failed' : 'idle';
      const card = h('div', `mc-card ${statusCls}` + (s.id === S.current ? ' current' : ''));
      const mId = v?.data?.model || s.model || S.settings?.defaultModel || 'auto';
      card.innerHTML = `
        <div class="mc-card-top"><span class="mc-state ${statusCls}"><i class="mc-dot"></i><span></span></span><span class="mc-when">${esc(timeAgo(s.updated))}</span></div>
        <div class="mc-name"></div>
        <div class="mc-meta mono"><span>${esc(modelLabelOf(mId))}</span>${wt ? `<span class="mc-wt">${icon('branch', 'xs')}${esc(wt.branch)}</span>` : ''}${s.cost ? `<span>${fmtCost(s.cost)}</span>` : ''}</div>
        ${chKeys.length ? `<div class="mc-diff mono">${chKeys.length} file${chKeys.length === 1 ? '' : 's'} · <span class="add-n">+${add}</span> <span class="del-n">−${del}</span></div>` : '<div class="mc-diff muted">No uncommitted session changes</div>'}
        <div class="mc-card-acts"><button type="button" class="btn sm mc-open">${s.id === S.current ? 'Focus' : 'Open'}</button>${S.current && s.id !== S.current ? '<button type="button" class="btn sm ghost mc-split">Split view</button>' : ''}${busy ? '<button type="button" class="btn sm danger mc-stop">Stop</button>' : ''}</div>
      `;
      $('.mc-state span:last-child', card).textContent = statusText;
      $('.mc-name', card).textContent = s.title || 'Untitled session';
      $('.mc-open', card).onclick = async () => { if (s.id !== S.current) await openSession(s.id); setLens('default'); };
      const sp = $('.mc-split', card);
      if (sp) {
        sp.onclick = async () => {
          if (!S.views.get(s.id)) {
            const data = await api.loadSession(s.id);
            if (data) makeView(data);
          }
          setLens('default');
          setSplit(s.id);
        };
      }
      const st = $('.mc-stop', card);
      if (st) st.onclick = () => api.stop(s.id);
      grid.appendChild(card);
    }
    deck.appendChild(grid);
  }

  // ---------- hero (home) ----------
  const greeting = () => { const hr = new Date().getHours(); return hr < 5 ? 'Working late' : hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening'; };
  function renderHero() {
    const el = $('#hero'); el.innerHTML = '';
    const name = S.project ? baseName(S.project) : '';
    const top = h('div', 'hero-top');
    top.insertAdjacentHTML('beforeend', `<div class="hero-emblem" aria-hidden="true"><svg class="hero-mark" viewBox="0 0 24 24"><path d="M12 2.6c-.3 0-.6.15-.8.4C9.4 5.3 5.6 10.2 5.6 14a6.4 6.4 0 0 0 12.8 0c0-3.8-3.8-8.7-5.6-11-.2-.25-.5-.4-.8-.4Z" fill="var(--accent)"/><path d="M9.2 14.6a2.9 2.9 0 0 0 2.6 2.8" stroke="var(--bg)" stroke-width="1.6" fill="none" stroke-linecap="round"/></svg></div>`);
    const titles = h('div', 'hero-titles');
    titles.appendChild(h('div', 'hero-hello', S.project ? greeting() : 'Welcome to DROPs'));
    titles.appendChild(h('h1', '', S.project ? `What should we build in ${name}?` : 'Your autonomous coding engineer'));
    titles.appendChild(h('p', '', S.project ? 'Describe it in plain words. DROPs plans, writes the code, runs it, checks it in a real browser, and saves a checkpoint before every change.' : 'Open a project folder and tell DROPs what you want. It plans, codes, tests and checks its own work.'));
    top.appendChild(titles);
    el.appendChild(top);

    const hasUsableModel = !!S.settings?.hasKey || !!(S.info?.models || []).some((m) => !m.id.startsWith('__') && m.id !== 'auto' && !m.disabled && modelUsable(m));
    const acts = h('div', 'hero-actions');
    if (!hasUsableModel) { const b = h('button', 'btn primary'); b.innerHTML = icon('key', 'sm') + 'Configure AI provider'; b.onclick = () => openSettings('providers'); acts.appendChild(b); }
    if (!S.project) { const b = h('button', hasUsableModel ? 'btn primary' : 'btn'); b.innerHTML = icon('folderOpen', 'sm') + 'Open project folder'; b.onclick = pickProject; acts.appendChild(b); }
    if (acts.childElementCount) el.appendChild(acts);

    if (S.project) {
      // Pick up where you left off.
      const mine = S.sessions
        .filter((s) => s.projectDir === S.project)
        .map((s) => { const live = S.views.get(s.id)?.data; return live ? { ...s, title: live.title || s.title, updated: Math.max(s.updated || 0, live.updated || 0), cost: live.usage?.cost ?? s.cost } : s; })
        .sort((a, b) => b.updated - a.updated);
      if (mine.length) {
        const last = mine[0];
        const cont = h('button', 'continue-card');
        cont.innerHTML = `<span class="cc-icon">${icon('history')}</span><span class="cc-body"><span class="cc-label">Continue where you left off · <span class="cc-when"></span></span><span class="cc-title"></span></span><span class="cc-go">Open ${icon('chevronRight', 'xs')}</span>`;
        $('.cc-title', cont).textContent = last.title || 'Untitled session';
        $('.cc-when', cont).textContent = timeAgo(last.updated);
        cont.onclick = () => openSession(last.id);
        el.appendChild(cont);
        const week = mine.filter((s) => Date.now() - s.updated < 7 * 86400000).length;
        const spent = mine.reduce((sum, s) => sum + (s.cost || 0), 0);
        const meta = h('div', 'hero-meta');
        const part = (t) => meta.appendChild(h('span', '', t));
        part(`${mine.length} session${mine.length === 1 ? '' : 's'}`);
        if (week) part(`${week} this week`);
        if (spent) part(`${fmtCost(spent)} spent`);
        el.appendChild(meta);
      }

      // Quick starts: short, one click.
      el.appendChild(h('div', 'group-label hero-label', 'Start with'));
      const chips = h('div', 'chips');
      const items = [
        ...(S.git?.files?.length ? [['diff', `Review ${S.git.files.length} uncommitted change${S.git.files.length > 1 ? 's' : ''}`, '/review']] : []),
        ['globe', 'Build a web page and check it in the browser', 'Build a simple, good-looking landing page for this project, run it, open it in the browser tool, and fix anything that looks broken.'],
        ['bug', 'Find and fix bugs', 'Find the most likely bugs in this project (read the code, run the tests/build), fix them, and verify each fix.'],
        ['flask', 'Run tests and fix failures', '/test'],
        ['compass', 'Explain this codebase', '/explain'],
      ];
      for (const [ic, t, prompt] of items.slice(0, 4)) {
        const c = h('button', 'chip'); c.innerHTML = `${icon(ic, 'sm')}<span></span>`; $('span', c).textContent = t;
        c.onclick = () => { if (prompt.startsWith('/')) sendText(prompt); else { $('#input').value = prompt; autosize(); updateComposer(); $('#input').focus(); } };
        chips.appendChild(c);
      }
      el.appendChild(chips);
    } else {
      const sc = h('div', 'hero-showcase');
      for (const [ic, title, desc] of [
        ['shield', 'Checkpointed edits', 'Every turn snapshots touched files so you can rewind anytime.'],
        ['globe', 'Live Browser & QA', 'Runs your app, inspects real screens, and verifies fixes.'],
        ['network', 'Code Map & Worktrees', 'See module blast radius live or spawn parallel branches.'],
      ]) {
        const c = h('div', 'hs-card');
        c.innerHTML = `${icon(ic, 'sm')}<div><b></b><span></span></div>`;
        $('b', c).textContent = title;
        $('span', c).textContent = desc;
        sc.appendChild(c);
      }
      el.appendChild(sc);
      const keys = h('div', 'hero-keys');
      keys.innerHTML = '<span><kbd>Ctrl O</kbd> Open folder</span><span><kbd>Ctrl K</kbd> Command palette</span><span><kbd>Ctrl ,</kbd> Settings</span>';
      el.appendChild(keys);
    }

    const recent = (S.settings.recentProjects || []).filter((p) => p !== S.project).slice(0, 4);
    if (recent.length) {
      const r = h('div', 'recent'); r.appendChild(h('div', 'group-label hero-label', 'Other projects'));
      const grid = h('div', 'project-tiles');
      for (const p of recent) {
        const tile = h('button', 'project-tile'); tile.innerHTML = `<span class="pt-ic">${icon('folder')}</span><span class="pt-t"></span><span class="pt-p"></span>`;
        $('.pt-t', tile).textContent = baseName(p); $('.pt-p', tile).textContent = p; tile.title = p; tile.onclick = () => setProject(p);
        grid.appendChild(tile);
      }
      r.appendChild(grid);
      el.appendChild(r);
    }
  }

  const openSettings = (...a) => window.SettingsUI.openSettings(...a);

  // ---------- command palette ----------
  function openPalette(initial = '') {
    if ($('.palette')) return;
    const o = h('div', 'overlay');
    const p = h('div', 'palette');
    p.setAttribute('role', 'dialog'); p.setAttribute('aria-modal', 'true'); p.setAttribute('aria-label', 'Command palette');
    const head = h('div', 'pal-head');
    head.innerHTML = icon('search', 'sm');
    const input = h('input'); input.placeholder = 'Type a command, file name or session…'; input.value = initial;
    head.appendChild(input);
    const list = h('div', 'list');
    const foot = h('div', 'pal-foot');
    foot.innerHTML = '<span><kbd>↑</kbd><kbd>↓</kbd> Navigate</span><span><kbd>↵</kbd> Run</span><span><kbd>Esc</kbd> Close</span>';
    p.append(head, list, foot); o.appendChild(p); document.body.appendChild(o);
    const close = () => o.remove();
    o.onclick = (e) => { if (e.target === o) close(); };
    const commands = [
      ['New session', 'Ctrl N', () => newSession(), 'plus'],
      ['Open project folder…', 'Ctrl O', () => pickProject(), 'folderOpen'],
      ['Toggle light / dark theme', 'Ctrl Shift L', () => toggleTheme(), 'sun'],
      ['Settings', 'Ctrl ,', () => openSettings(), 'settings'],
      ['Settings: API keys & providers', '', () => openSettings('providers'), 'key'],
      ['Settings: models, Auto routing & budget', '', () => openSettings('models'), 'cpu'],
      ['Settings: MCP servers & sandbox', '', () => openSettings('tools'), 'plug'],
      ['Compact context now', '/compact', () => compactNow(), 'layers'],
      ['Export conversation to Markdown', '/export', () => exportSession('md'), 'download'],
      ['Export HTML review report (share with your team)', '', () => exportSession('html'), 'upload'],
      ['Export shareable session file (.drops.json)', '', () => exportSession('json'), 'upload'],
      ['Import a shared session…', '', () => importSession(), 'download'],
      ['New session in its own git worktree (parallel agent)', '', () => newWorktreeSession(), 'branch'],
      ['Lessons learned', '', () => lessonsBox(), 'brain'],
      ['Reconnect MCP servers', '', async () => { const st = await api.mcpReconnect(); toast(`MCP: ${st.filter((x) => x.status === 'connected').length}/${st.length} connected`); }, 'refresh'],
      ['Generate commit message', '/commit', () => generateCommitMessage(), 'sparkles'],
      ['Switch to Plan mode', '', () => { setMode('plan'); persistOpts(); }, 'list'],
      ['Switch to Full auto mode', '', () => { setMode('yolo'); persistOpts(); }, 'zap'],
      ['Check for updates', '', () => checkForUpdatesNow(), 'download'],
      ['Open crash reports folder', '', () => api.crashOpenFolder(), 'alert'],
      ['Split view: show another session beside this one', 'Ctrl \\', () => (S.split ? setSplit(null) : openSplitPicker()), 'panelRight'],
      ['Toggle sidebar', 'Ctrl B', () => toggleSide(), 'panelLeft'],
      ['Toggle right panel', 'Ctrl J', () => toggleInspector(), 'panelRight'],
      ['Show source control', '', () => showSide('scm'), 'branch'],
      ['Show explorer', '', () => showSide('explorer'), 'files'],
      ['Open Live Browser', '', () => switchTab('browser'), 'globe'],
      ['Open Interactive Terminal', '', () => switchTab('terminal'), 'terminal'],
      ['Open Tasks & Schedules', '', () => switchTab('tasks'), 'list'],
      ['Open Session Changes', '', () => switchTab('changes'), 'diff'],
      ['Open Codebase Impact Map', '', () => switchTab('map'), 'network'],
      ['Open Session Usage & Telemetry', '', () => switchTab('usage'), 'gauge'],
      ['Workspace: Focus mode (zen chat)', 'Ctrl Shift F', () => setLens(S.lens === 'focus' ? 'default' : 'focus'), 'minimize'],
      ['Workspace: Studio wide workbench', 'Ctrl Shift S', () => setLens(S.lens === 'studio' ? 'default' : 'studio'), 'panelRight'],
      ['Workspace: Mission Control fleet deck', 'Ctrl Shift M', () => setLens(S.lens === 'mission' ? 'default' : 'mission'), 'grid'],
      ['Initialize project memory (DROPs.md)', '/init', () => sendText('/init'), 'bookmark'],
      ['Review uncommitted changes', '/review', () => sendText('/review'), 'eye'],
    ];
    let items = [], idx = 0, seq = 0;
    const renderKeyHint = (d) => {
      if (!d) return '';
      if (d.startsWith('/')) return `<kbd>${esc(d)}</kbd>`;
      return d.split(' ').map((k) => `<kbd>${esc(k)}</kbd>`).join(' ');
    };
    const draw = async () => {
      const q = input.value.trim().toLowerCase();
      const my = ++seq;
      items = [];
      const cmds = commands.filter(([t]) => !q || t.toLowerCase().includes(q)).map(([t, k, run, ic]) => ({ sec: 'Commands', t, d: k, isKey: true, run, ic }));
      const sess = S.sessions.filter((s) => q && (s.title || '').toLowerCase().includes(q)).slice(0, 6).map((s) => ({ sec: 'Sessions', t: S.views.get(s.id)?.data?.title || s.title, d: timeAgo(s.updated), run: () => openSession(s.id), ic: 'chat' }));
      let files = [];
      if (q && S.project) files = (await api.searchFiles(S.project, q)).slice(0, 12).map((f) => ({ sec: 'Files', t: f, d: '', run: () => Editor.openFile(f), ic: 'file' }));
      if (my !== seq) return;
      items = [...cmds, ...sess, ...files];
      idx = Math.min(idx, Math.max(0, items.length - 1));
      list.innerHTML = '';
      let sec = '';
      items.forEach((it, i) => {
        if (it.sec !== sec) { sec = it.sec; list.appendChild(h('div', 'sec', sec)); }
        const r = h('div', 'opt' + (i === idx ? ' on' : ''));
        r.innerHTML = `${icon(it.ic, 'sm')}<span class="grow" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></span><span class="d">${it.isKey ? renderKeyHint(it.d) : esc(it.d)}</span>`;
        $('.grow', r).textContent = it.t;
        r.onmousemove = () => { if (idx !== i) { idx = i; $$('.opt', list).forEach((x, j) => x.classList.toggle('on', j === i)); } };
        r.onclick = () => { close(); it.run(); };
        list.appendChild(r);
      });
      if (!items.length) list.appendChild(h('div', 'empty', 'No matches'));
    };
    input.oninput = () => { idx = 0; draw(); };
    input.onkeydown = (e) => {
      if (e.key === 'Escape') close();
      else if (e.key === 'ArrowDown') { idx = Math.min(items.length - 1, idx + 1); e.preventDefault(); $$('.opt', list).forEach((x, j) => x.classList.toggle('on', j === idx)); $$('.opt', list)[idx]?.scrollIntoView({ block: 'nearest' }); }
      else if (e.key === 'ArrowUp') { idx = Math.max(0, idx - 1); e.preventDefault(); $$('.opt', list).forEach((x, j) => x.classList.toggle('on', j === idx)); $$('.opt', list)[idx]?.scrollIntoView({ block: 'nearest' }); }
      else if (e.key === 'Enter') { const it = items[idx]; if (it) { close(); it.run(); } }
    };
    draw(); input.focus();
  }

  function promptBox(title, value) {
    if (typeof window.promptText === 'function') return window.promptText(title, '', value || '', 'Save');
    return Promise.resolve(null);
  }

  return { showSide, toggleSide, renderSessions, markSession, loadTree, refreshTreeMarks, refreshTreeSoon, refreshGit, refreshGitSoon, generateCommitMessage, switchTab, renderPlan, renderTasks, renderChanges, renderMap, renderMissionDeck, renderUsage, onProc, renderProcs, renderStatus, renderHero, openSettings, openPalette };
})();

// ---------- theme ----------
function applyThemeAttr(t) {
  S.theme = t;
  document.documentElement.dataset.theme = t;
  $('#themeBtn').innerHTML = icon(t === 'dark' ? 'moon' : 'sun');
  Editor.setTheme(t);
  Panels.renderStatus();
}
async function setTheme(mode) { const t = await api.setTheme(mode); S.settings.theme = mode; applyThemeAttr(t); }
function toggleTheme() { setTheme(S.theme === 'dark' ? 'light' : 'dark'); }
// Appearance settings live as data attributes on <html>; styles.css reads them.
function applyAppearance(s = {}) {
  const d = document.documentElement.dataset;
  d.chatSize = s.chatSize || 'default';
  d.chatWidth = s.chatWidth || 'default';
  d.density = s.density || 'default';
}
const sendWithCtrl = () => S.settings?.sendKey === 'ctrl-enter';
function applySendKey() {
  const hint = $('#hint');
  if (hint) hint.textContent = sendWithCtrl()
    ? 'Ctrl+Enter to send · Enter for a new line · messages sent while the agent works steer it live'
    : 'Enter to send · Shift+Enter for a new line · messages sent while the agent works steer it live';
}
function toggleInspector() {
  const b = $('#body');
  if (S.lens === 'focus' || S.lens === 'mission') { setLens('default'); b.classList.remove('no-insp'); }
  else if (window.innerWidth <= 1280) b.classList.toggle('force-insp');
  else b.classList.toggle('no-insp');
  const open = (window.innerWidth <= 1280 ? b.classList.contains('force-insp') : !b.classList.contains('no-insp')) && S.lens !== 'focus' && S.lens !== 'mission';
  S.userClosedInsp = !open;
  S.userInspLock = true;
  $('#inspToggle').classList.toggle('on', open);
  const bOpen = open && $('#browserBody') && !$('#browserBody').hidden;
  b.classList.toggle('browser-stage', !!bOpen);
  if (!bOpen) {
    b.classList.remove('browser-wide');
    const wb = $('.bp-wide-btn');
    if (wb) { wb.classList.remove('on'); wb.innerHTML = icon('maximize', 'xs'); wb.title = 'Expand browser stage'; wb.setAttribute('aria-label', wb.title); }
    api.browserStream?.(currentView()?.data?.projectDir || S.project || 'default', 'stop').catch(() => {});
  }
}
function fillModelSelect(sel) {
  sel.innerHTML = '';
  const provs = [...new Set(S.info.models.map((x) => x.provider))];
  for (const prov of provs) {
    const items = S.info.models.filter((x) => x.provider === prov);
    const usable = items.some(modelUsable);
    const g = h('optgroup'); g.label = prov + (usable ? '' : ' (add key in Settings)');
    for (const m of items) { const o = h('option', '', m.label); o.value = m.id; if (m.disabled) o.disabled = true; if (m.id.startsWith('__')) o.className = 'status-opt'; g.appendChild(o); }
    sel.appendChild(g);
  }
}
async function reloadModels() {
  S.info = await api.info();
  const sel = $('#modelSel');
  const keep = sel.value;
  fillModelSelect(sel);
  if (keep) sel.value = keep;
  if (!sel.value) sel.value = usableModel(S.settings.defaultModel);
  syncPills();
}
