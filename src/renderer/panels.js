/* DROPs renderer — sidebar views, inspector, status bar, settings and command palette. */
'use strict';
const Panels = (() => {
  // ---------- sidebar ----------
  function showSide(view) {
    const body = $('#body');
    const active = $(`.rail button[data-view="${view}"]`);
    if (active?.classList.contains('on') && !body.classList.contains('no-side') && view === showSide.last) { body.classList.add('no-side'); active.classList.remove('on'); return; }
    body.classList.remove('no-side');
    $$('.rail button[data-view]').forEach((b) => b.classList.toggle('on', b.dataset.view === view));
    $$('.side-view').forEach((s) => (s.hidden = s.dataset.side !== view));
    showSide.last = view;
    if (view === 'scm') refreshGit();
  }

  async function renderSessions(refetch = true) {
    if (refetch) S.sessions = await api.listSessions();
    const search = $('#sessionSearch');
    if (search && !search.dataset.bound) {
      search.dataset.bound = '1';
      search.oninput = () => renderSessions(false);
    }
    const q = (search?.value || '').trim().toLowerCase();
    const list = $('#sessionList');
    list.innerHTML = '';
    // Every project with its sessions, the open project first (like a workspace sidebar).
    const all = q ? S.sessions.filter((s) => (s.title || '').toLowerCase().includes(q)) : S.sessions;
    const byProject = new Map();
    for (const s of [...all].sort((a, b) => b.updated - a.updated)) {
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
        const it = h('div', 'row session' + (s.id === S.current ? ' on' : ''));
        it.dataset.id = s.id;
        it.dataset.failed = s.failed ? '1' : '';
        it.innerHTML = `<span class="dot"></span><span class="t"><span class="tt"></span><span class="t2">${timeAgo(s.updated)}${s.cost ? ' · ' + fmtCost(s.cost) : ''}</span></span><span class="acts"><button title="Rename">${icon('pencil', 'xs')}</button><button title="Delete">${icon('trash', 'xs')}</button></span>`;
        $('.tt', it).textContent = s.title;
        it.title = s.title;
        applyStatus(it, S.views.get(s.id), s);
        it.onclick = () => openSession(s.id);
        const [ren, del] = $$('.acts button', it);
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
  async function loadTree() {
    const ts = $('#treeSearch');
    if (ts && !ts.dataset.bound) {
      ts.dataset.bound = '1';
      ts.oninput = () => filterTree();
    }
    if (ts && ts.value.trim()) { await filterTree(); return; }
    treeSearchActive = false;
    const t = $('#tree'); t.innerHTML = '';
    $('#explorerTitle').textContent = S.project ? baseName(S.project) : 'Explorer';
    if (!S.project) { const e = h('div', 'empty', 'No folder open.'); const b = h('button', 'btn sm', 'Open folder'); b.onclick = pickProject; e.append(h('br'), b); t.appendChild(e); return; }
    await fillDir(t, '', 0);
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
    const br = h('div', 'scm-branch'); br.innerHTML = `${icon('branch', 'sm')}<b>${esc(g.branch)}</b><span class="meta">${g.ahead ? `↑${g.ahead} ` : ''}${g.behind ? `↓${g.behind}` : ''}</span>`;
    const ta = h('textarea', 'textarea'); ta.id = 'commitMsg'; ta.placeholder = 'Commit message'; ta.value = renderScm.draft || ''; ta.oninput = () => (renderScm.draft = ta.value);
    const row = h('div', 'btn-row');
    const gen = h('button', 'btn sm'); gen.innerHTML = icon('sparkles', 'xs') + 'Generate'; gen.title = 'Write the message with AI from the diff'; gen.onclick = generateCommitMessage;
    const commit = h('button', 'btn primary sm grow'); commit.innerHTML = icon('check', 'xs') + `Commit ${count} file${count === 1 ? '' : 's'}`;
    commit.disabled = !count;
    commit.onclick = async () => {
      const msg = ta.value.trim();
      if (!msg) { toast('Write or generate a commit message first'); ta.focus(); return; }
      commit.disabled = true;
      const r = await api.gitCommit(S.project, msg);
      if (r.error) toast(r.error); else { toast('Committed: ' + r.summary); renderScm.draft = ''; }
      refreshGit();
    };
    row.append(gen, commit);
    top.append(br, ta, row);
    box.appendChild(top);
    if (count) {
      box.appendChild(h('div', 'group-label', 'Changes'));
      for (const f of g.files) {
        const r = h('div', 'row');
        const letter = { modified: 'M', added: 'A', untracked: 'U', deleted: 'D', renamed: 'R' }[f.status];
        r.innerHTML = `${icon('file', 'ficon')}<span class="t"></span><span class="st-letter st-${f.status}">${letter}</span>`;
        $('.t', r).textContent = f.path; r.title = f.path + ' — click to view diff';
        r.onclick = () => Editor.openGitDiff(f.path);
        box.appendChild(r);
      }
    }
    const log = await api.gitLog(S.project);
    if (log.length) {
      box.appendChild(h('div', 'group-label', 'Recent commits'));
      for (const c of log.slice(0, 12)) { const r = h('div', 'commit-row'); r.innerHTML = `<span class="h">${esc(c.hash)}</span><span class="s"></span><span>${esc(c.when.replace(' ago', ''))}</span>`; $('.s', r).textContent = c.subject; r.title = `${c.subject}\n${c.author}, ${c.when}`; box.appendChild(r); }
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
  function switchTab(name) {
    $('#body').classList.remove('no-insp');
    $$('#inspTabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
    $$('.tab-body').forEach((b) => (b.hidden = b.dataset.body !== name));
    if (name === 'browser') { const bd = $('#browserBadge'); if (bd) bd.hidden = true; if (typeof renderBrowserPane === 'function') renderBrowserPane(currentView(), false); }
    if (name === 'tasks') renderTasks();
  }
  /** The right panel's overview: where this session runs, how full its context is, what it produced. */
  function overviewPanel() {
    const wrap = h('div', 'glance');
    const v = currentView();
    const o = currentOpts();
    const m = S.info?.models.find((x) => x.id === o.model);
    const modeLabel = { plan: 'Plan only', ask: 'Asks before changes', 'auto-edit': 'Edits on its own', yolo: 'Full auto' }[o.mode] || o.mode;
    const u = v?.data.usage;
    const section = (title) => { wrap.appendChild(h('div', 'glance-title', title)); const rows = h('div', 'glance-rows'); wrap.appendChild(rows); return rows; };
    const row = (rows, ic, label, value, onclick) => {
      const r = h(onclick ? 'button' : 'div', 'glance-row' + (onclick ? ' link' : ''));
      r.innerHTML = `${icon(ic, 'sm')}<span class="gl"></span><span class="gv"></span>`;
      $('.gl', r).textContent = label; $('.gv', r).textContent = value;
      if (onclick) r.onclick = onclick;
      rows.appendChild(r);
    };

    const env = section('Environment');
    row(env, S.settings?.sandbox ? 'box' : 'monitor', 'Runs on', S.settings?.sandbox ? 'Docker sandbox' : 'This computer');
    if (S.project) row(env, 'folder', 'Folder', baseName(S.project), () => showSide('explorer'));
    if (S.git?.isRepo) row(env, 'branch', 'Branch', `${S.git.branch}${S.git.files.length ? ` · ${S.git.files.length} changed` : ''}`, () => showSide('scm'));
    row(env, 'cpu', 'Model', m?.label || o.model || '—');
    row(env, 'shield', 'Mode', modeLabel);

    // Context: how much of the model's window this conversation uses.
    const pct = u ? Math.min(1, u.context / contextMax()) : 0;
    const ctx = h('div', 'ctx-line');
    ctx.innerHTML = `<div class="ctx-top"><span>Context</span><span class="gv"></span></div><div class="meter"><div></div></div>`;
    $('.gv', ctx).textContent = u?.context ? `${Math.max(1, Math.round(pct * 100))}% · ${fmtTok(u.context)} tokens` : 'empty';
    $('.meter div', ctx).style.width = `${Math.max(pct * 100, u?.context ? 1 : 0)}%`;
    if (u?.context && u.context > (S.settings?.compactAt || 180000) * 0.85) ctx.classList.add('warn');
    wrap.appendChild(ctx);
    const spend = section('Usage');
    row(spend, 'gauge', 'Spent', u && u.cost ? fmtCost(u.cost) : '$0.00', () => switchTab('usage'));

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

    // Outputs: the files this session changed, newest work first.
    const ch = v?.data.changes || {};
    const keys = Object.keys(ch);
    if (keys.length) {
      let A = 0, D = 0;
      for (const k of keys) { A += ch[k].added; D += ch[k].removed; }
      const t = h('div', 'glance-title out-title');
      t.innerHTML = `<span>Outputs</span><span class="mono"><span class="add-n">+${A}</span> <span class="del-n">−${D}</span></span>`;
      wrap.appendChild(t);
      const rows = h('div', 'glance-rows');
      for (const k of keys.slice(-6).reverse()) {
        const r = h('button', 'glance-row link out-row');
        r.innerHTML = `${icon('file', 'sm')}<span class="gl mono"></span><span class="gv mono"><span class="add-n">+${ch[k].added}</span> <span class="del-n">−${ch[k].removed}</span></span>`;
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

  /** For a fresh session: the steps DROPs will go through. */
  function howPanel() {
    const wrap = h('div', 'glance');
    wrap.appendChild(h('div', 'glance-title', 'How DROPs works'));
    const steps = h('ol', 'how');
    for (const [t, d] of [
      ['Plans', 'Breaks your request into a checklist you can follow here'],
      ['Writes the code', 'With a checkpoint before every change'],
      ['Runs it', 'Builds and tests until they pass'],
      ['Checks it like a user', 'Opens web apps in a real browser and clicks through'],
      ['Reports honestly', 'What changed, how it was verified, what is left'],
    ]) { const li = h('li'); li.innerHTML = '<span><b></b><span></span></span>'; $('b', li).textContent = t; $('span > span', li).textContent = d; steps.appendChild(li); }
    wrap.appendChild(steps);
    return wrap;
  }

  async function renderTasks() {
    const box = $('#tasksBody');
    if (!box) return;
    box.innerHTML = '';
    let tasks = [];
    try { tasks = await api.taskList(); } catch { tasks = []; }

    const activeTasks = tasks.filter((t) => t.status === 'running');
    const queuedTasks = tasks.filter((t) => t.status === 'queued');
    const pastTasks = tasks.filter((t) => ['completed', 'failed', 'cancelled'].includes(t.status)).slice(0, 20);

    const activeCount = activeTasks.length + queuedTasks.length;
    const badge = $('#tasksBadge');
    if (badge) {
      badge.hidden = activeCount === 0;
      badge.textContent = activeCount;
    }

    if (!tasks.length) {
      box.innerHTML = '<div class="empty">No tasks recorded yet.<br><small style="color:var(--dim)">Coding tasks run in the background independently from chat.</small></div>';
      return;
    }

    const wrap = h('div', 'tasks-list');

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
      wrap.appendChild(h('div', 'glance-title', 'Recent'));
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

    box.appendChild(wrap);
  }

  function renderPlan() {
    const box = $('#planBody'); box.innerHTML = '';
    const todos = currentView()?.data.todos || [];
    box.appendChild(overviewPanel());
    if (!todos.length) { if (!Object.keys(currentView()?.data.changes || {}).length) box.appendChild(howPanel()); return; }
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
    const head = h('div', 'todo-head'); head.innerHTML = `<span>${keys.length} file${keys.length > 1 ? 's' : ''} changed</span><span class="mono"><span style="color:var(--ok)">+${A}</span> <span style="color:var(--err)">−${D}</span></span>`;
    box.appendChild(head);
    for (const k of keys) {
      const c = ch[k];
      const r = h('div', 'row');
      r.innerHTML = `${icon('file', 'ficon')}<span class="t mono" style="font-size:12px"></span><span class="meta mono"><span style="color:var(--ok)">+${c.added}</span> <span style="color:var(--err)">−${c.removed}</span></span><span class="acts"><button title="Review diff">${icon('diff', 'xs')}</button><button title="Revert this file to before the session">${icon('undo', 'xs')}</button></span>`;
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
    const totalIn = u.input + u.cacheRead + u.cacheWrite;
    const hit = totalIn ? Math.round((u.cacheRead / totalIn) * 100) : 0;
    const limit = S.settings.compactAt || 180000;
    const ctxPct = Math.min(100, (u.context / limit) * 100);
    box.innerHTML = `<div class="stat-grid">
      <div class="stat wide"><div class="k">Session cost</div><div class="v">${u.costUnknown && !u.cost ? '—' : fmtCost(u.cost)}</div>${u.costUnknown ? '<div class="s">Gemini usage is billed by Google — see AI Studio.</div>' : ''}</div>
      <div class="stat"><div class="k">Input</div><div class="v">${fmtTok(totalIn)}</div></div>
      <div class="stat"><div class="k">Output</div><div class="v">${fmtTok(u.output)}</div></div>
      <div class="stat"><div class="k">Cache hits</div><div class="v">${hit}%</div></div>
      <div class="stat"><div class="k">Requests</div><div class="v">${u.requests || 0}</div></div>
      <div class="stat wide"><div class="k">Context</div><div class="v">${fmtTok(u.context)}</div><div class="s">Auto-compacts at ${fmtTok(limit)} tokens</div><div class="bar"><div style="width:${ctxPct}%"></div></div></div>
    </div>`;
    const b = h('button', 'btn sm block'); b.style.marginTop = '10px'; b.innerHTML = icon('layers', 'xs') + 'Compact context now'; b.onclick = compactNow;
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
    if (ev.started || ev.exited) { renderProcs(); renderStatus(); renderPlan(); return; }
    const pre = document.querySelector(`.proc[data-id="${ev.id}"] pre`);
    if (pre) { const stick = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40; pre.textContent = p.out.slice(-20000); if (stick) pre.scrollTop = pre.scrollHeight; }
  }
  function renderProcs() {
    const box = $('#termBody'); box.innerHTML = '';
    const v = currentView();
    const procs = v ? [...v.procs.values()] : [];
    const running = procs.filter((p) => p.running).length;
    $('#procBadge').hidden = !running; $('#procBadge').textContent = running;
    if (!procs.length) { box.appendChild(h('div', 'empty', 'Dev servers, watchers and other long-running processes the agent starts appear here with live output.')); return; }
    for (const p of procs.slice().reverse()) {
      const d = h('div', 'proc'); d.dataset.id = p.id;
      const head = h('div', 'proc-head');
      head.innerHTML = `<span class="state ${p.running ? 'on' : ''}"></span><b class="grow" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></b><span class="meta muted mono">${p.running ? 'running' : `exit ${p.code}`}</span>`;
      $('b', head).textContent = `${p.id} · ${p.name}`; head.title = p.command;
      if (p.running) { const s = h('button', 'btn sm'); s.innerHTML = icon('square', 'xs') + 'Stop'; s.onclick = () => api.procStop(v.id, p.id); head.appendChild(s); }
      const pre = h('pre'); pre.textContent = (p.out || '').slice(-20000);
      d.append(head, pre); box.appendChild(d);
      if (!p.out) api.procOutput(v.id, p.id).then((o) => { if (o) { p.out = o; pre.textContent = o.slice(-20000); pre.scrollTop = pre.scrollHeight; } });
      setTimeout(() => (pre.scrollTop = pre.scrollHeight));
    }
  }

  // ---------- status bar ----------
  function renderStatus() {
    const sb = $('#statusbar');
    const v = currentView();
    const o = currentOpts();
    const m = S.info?.models.find((x) => x.id === o.model);
    const u = v?.data.usage;
    const running = v ? [...v.procs.values()].filter((p) => p.running).length : 0;
    const modeLabel = { plan: 'Plan mode', ask: 'Ask mode', 'auto-edit': 'Auto-edit', yolo: 'Full auto' }[o.mode];
    sb.innerHTML = '';
    const item = (html, title, onclick, cls = '') => { const e = h(onclick ? 'button' : 'span', 'sb ' + cls); e.innerHTML = html; if (title) e.title = title; if (onclick) e.onclick = onclick; sb.appendChild(e); };
    if (v?.data.worktree) item(`${icon('merge')}${esc(v.data.worktree.branch)}`, 'This session works in its own git worktree — see the Changes tab to merge it', () => switchTab('changes'), 'warn');
    if (S.git?.isRepo) item(`${icon('branch')}${esc(S.git.branch)}${S.git.files.length ? ` · ${S.git.files.length} changed` : ''}`, 'Source control', () => showSide('scm'));
    else if (S.project) item(`${icon('folder')}${esc(baseName(S.project))}`, S.project, pickProject);
    if (running) item(`${icon('terminal')}${running} process${running > 1 ? 'es' : ''} running`, 'Background processes', () => switchTab('terminal'));
    if (v?.busy) item(`${waterOrbSVG(14)}Agent working`, 'DROPs agent active', null, 'sb-water');
    sb.appendChild(h('div', 'spacer'));
    item(`${icon('shield')}${modeLabel}`, 'Permission mode (Shift+Tab in the composer)', null, o.mode === 'yolo' ? 'warn' : '');
    const autoNow = o.model === 'auto' && v?.autoModel ? ` → ${v.autoModel}` : '';
    item(`${icon('cpu')}${esc(m?.label || o.model)}${esc(autoNow)} · ${esc(o.effort)}`, 'Model', () => $('#modelSel').showPicker?.());
    const mcpOn = (S.mcp || []).filter((x) => x.status === 'connected').length;
    if ((S.mcp || []).length) item(`${icon('plug')}MCP ${mcpOn}/${S.mcp.length}`, (S.mcp || []).map((x) => `${x.name}: ${x.status}`).join('\n'), () => openSettings('tools'), mcpOn < S.mcp.length ? 'warn' : '');
    if (S.settings?.sandbox) item(`${icon('box')}Sandbox`, 'Commands run inside Docker', () => openSettings('tools'));
    if (S.settings?.responseLanguage && !['en', 'auto'].includes(S.settings.responseLanguage)) item(`${icon('languages')}${esc(S.settings.responseLanguage.toUpperCase())}${S.settings.explainMode ? ' · teach' : ''}`, 'Explanation language', () => openSettings('general'));
    if (u) item(`${fmtTok(u.context)} ctx · ${u.costUnknown && !u.cost ? fmtTok(u.input + u.cacheRead + u.output) + ' tok' : fmtCost(u.cost)}`, 'Usage', () => switchTab('usage'));
    item(`${icon(S.theme === 'dark' ? 'moon' : 'sun')}`, 'Toggle theme', () => toggleTheme());
  }

  // ---------- hero (home) ----------
  // A welcome that is about the person's own work: their last session to pick up, their project at a
  // glance, a few quick starts, and what is new in DROPs. Generic suggestions come last.
  const greeting = () => { const hr = new Date().getHours(); return hr < 5 ? 'Working late' : hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening'; };
  function renderHero() {
    const el = $('#hero'); el.innerHTML = '';
    const name = S.project ? baseName(S.project) : '';
    const top = h('div', 'hero-top');
    top.insertAdjacentHTML('beforeend', `<svg class="hero-mark" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.6c-.3 0-.6.15-.8.4C9.4 5.3 5.6 10.2 5.6 14a6.4 6.4 0 0 0 12.8 0c0-3.8-3.8-8.7-5.6-11-.2-.25-.5-.4-.8-.4Z" fill="var(--accent)"/><path d="M9.2 14.6a2.9 2.9 0 0 0 2.6 2.8" stroke="var(--bg)" stroke-width="1.6" fill="none" stroke-linecap="round"/></svg>`);
    const titles = h('div', 'hero-titles');
    titles.appendChild(h('div', 'hero-hello', S.project ? greeting() : 'Welcome to DROPs'));
    titles.appendChild(h('h1', '', S.project ? `What should we build in ${name}?` : 'Your autonomous coding engineer'));
    titles.appendChild(h('p', '', S.project ? 'Describe it in plain words. DROPs plans, writes the code, runs it, checks it in a real browser, and saves a checkpoint before every change.' : 'Open a project folder and tell DROPs what you want. It plans, codes, tests and checks its own work.'));
    top.appendChild(titles);
    el.appendChild(top);

    const acts = h('div', 'hero-actions');
    if (!S.settings.hasKey) { const b = h('button', 'btn primary'); b.innerHTML = icon('key', 'sm') + 'Add an API key'; b.onclick = () => openSettings('providers'); acts.appendChild(b); }
    if (!S.project) { const b = h('button', S.settings.hasKey ? 'btn primary' : 'btn'); b.innerHTML = icon('folderOpen', 'sm') + 'Open project folder'; b.onclick = pickProject; acts.appendChild(b); }
    if (acts.childElementCount) el.appendChild(acts);

    if (S.project) {
      // Pick up where you left off.
      const mine = S.sessions.filter((s) => s.projectDir === S.project).sort((a, b) => b.updated - a.updated);
      if (mine.length) {
        const last = mine[0];
        const cont = h('button', 'continue-card');
        cont.innerHTML = `<span class="cc-icon">${icon('history')}</span><span class="cc-body"><span class="cc-label">Continue where you left off · <span class="cc-when"></span></span><span class="cc-title"></span><span class="cc-meta"></span></span><span class="cc-go">Open ${icon('chevronRight', 'xs')}</span>`;
        $('.cc-title', cont).textContent = last.title || 'Untitled session';
        $('.cc-when', cont).textContent = timeAgo(last.updated);
        cont.onclick = () => openSession(last.id);
        el.appendChild(cont);
        // The project at a glance.
        const week = mine.filter((s) => Date.now() - s.updated < 7 * 86400000).length;
        const spent = mine.reduce((sum, s) => sum + (s.cost || 0), 0);
        const meta = h('div', 'hero-meta');
        const part = (t) => meta.appendChild(h('span', '', t));
        part(`${mine.length} session${mine.length === 1 ? '' : 's'}`);
        if (week) part(`${week} this week`);
        if (spent) part(`${fmtCost(spent)} spent`);
        if (S.git?.isRepo) part(`${S.git.branch}${S.git.files.length ? ` · ${S.git.files.length} changed` : ''}`);
        el.appendChild(meta);
      }

      // Quick starts: short, one click.
      el.appendChild(h('div', 'group-label hero-label', 'Start with'));
      const chips = h('div', 'chips');
      const items = [
        ['globe', 'Build a web page and check it in the browser', 'Build a simple, good-looking landing page for this project, run it, open it in the browser tool, and fix anything that looks broken.'],
        ['bug', 'Find and fix bugs', 'Find the most likely bugs in this project (read the code, run the tests/build), fix them, and verify each fix.'],
        ['flask', 'Run tests and fix failures', '/test'],
        ['compass', 'Explain this codebase', '/explain'],
      ];
      for (const [ic, t, prompt] of items) {
        const c = h('button', 'chip'); c.innerHTML = `${icon(ic, 'sm')}<span></span>`; $('span', c).textContent = t;
        c.onclick = () => { if (prompt.startsWith('/')) sendText(prompt); else { $('#input').value = prompt; autosize(); updateComposer(); $('#input').focus(); } };
        chips.appendChild(c);
      }
      el.appendChild(chips);

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

  // ---------- settings ----------
  const LANGS = [['auto', 'Auto: the language you write in'], ['en', 'English'], ['bn', 'বাংলা (Bengali)'], ['hi', 'हिन्दी (Hindi)'], ['ur', 'اردو (Urdu)'], ['ar', 'العربية (Arabic)'], ['es', 'Español'], ['fr', 'Français'], ['de', 'Deutsch'], ['pt', 'Português'], ['zh', '中文'], ['ja', '日本語'], ['id', 'Bahasa Indonesia']];
  const MCP_EXAMPLE = `{
  "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:/data"] },
  "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"], "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "…" } },
  "docs": { "url": "https://example.com/mcp", "trust": true }
}`;
  const SHORTCUTS = [
    ['Command palette', 'Ctrl K'], ['New session', 'Ctrl N'], ['Open project', 'Ctrl O'], ['Settings', 'Ctrl ,'],
    ['Toggle sidebar', 'Ctrl B'], ['Toggle right panel', 'Ctrl J'], ['Focus the message box', 'Ctrl L'], ['Light / dark theme', 'Ctrl Shift L'],
    ['Cycle permission mode', 'Shift Tab'], ['New line in a message', 'Shift Enter'], ['Stop the agent', 'Esc'], ['While the agent works: queue a message for later (Enter sends now)', 'Ctrl Enter'],
  ];
  // One settings row: label + description on the left, control on the right.
  const setItem = (label, desc, ctrl, cls = '') => `<div class="set-item ${cls}"><div class="set-label">${label}${desc ? `<small>${desc}</small>` : ''}</div><div class="set-ctrl">${ctrl}</div></div>`;
  const tgl = (id) => `<button class="toggle" id="${id}" role="switch"></button>`;
  const selectOf = (id, opts) => `<select class="select" id="${id}">${opts.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>`;
  function openSettings(tab = 'general') {
    if ($('.settings-page')) { $(`[data-nav="${tab}"]`)?.click(); return; }
    const s = S.settings;
    const sections = [['general', 'General', 'sliders'], ['providers', 'API keys & providers', 'key'], ['models', 'Models & cost', 'cpu'], ['agent', 'Agent', 'bot'],
      ['tools', 'Tools & MCP', 'plug'], ['safety', 'Safety & sandbox', 'shield'], ['appearance', 'Appearance', 'palette'], ['shortcuts', 'Keyboard shortcuts', 'keyboard'], ['about', 'About', 'info']];
    const o = h('div', 'settings-page');
    o.setAttribute('role', 'dialog'); o.setAttribute('aria-label', 'Settings');
    const m = o;
    m.innerHTML = `
      <nav class="set-nav">
        <h1>${icon('settings')}Settings</h1>
        <input class="input sm" id="setSearch" placeholder="Search settings" autocomplete="off">
        ${sections.map(([k, l, ic]) => `<button class="nav" data-nav="${k}">${icon(ic)}${l}</button>`).join('')}
        <div class="ver">DROPs ${esc(S.info.version || '')}</div>
      </nav>
      <div class="set-main">
        <div class="set-scroll"><div class="set-inner">
        <section class="set-sec" data-sp="general"><h2>General</h2><p class="set-desc">Defaults for new sessions and how DROPs behaves on this computer.</p>
          <div class="set-card"><div class="set-sub">New sessions</div>
            ${setItem('Default model', 'Used for new sessions. "Auto" picks the cheapest model that fits each request.', '<select class="select" id="setModel"></select>')}
            ${setItem('Default reasoning effort', 'Higher effort thinks longer: better on hard problems, slower and more expensive.', selectOf('setEffort', S.info.efforts.map((e) => [e, e])))}
            ${setItem('Default permission mode', 'Plan: read only. Ask: approve every change. Auto-edit: edits apply, commands ask. Full auto: everything runs, destructive commands still ask.', selectOf('setMode', [['plan', 'Plan'], ['ask', 'Ask'], ['auto-edit', 'Auto-edit'], ['yolo', 'Full auto']]))}
          </div>
          <div class="set-card"><div class="set-sub">Behaviour</div>
            ${setItem('Open the last project on startup', 'Reopen the folder you worked in last time.', tgl('setRestore'))}
            ${setItem('Desktop notifications', 'Notify me when the agent needs approval or finishes a task while DROPs is in the background.', tgl('setNotify'))}
            ${setItem('Send messages with', 'The other key combination inserts a new line.', selectOf('setSendKey', [['enter', 'Enter'], ['ctrl-enter', 'Ctrl + Enter']]))}
          </div>
        </section>
        <section class="set-sec" data-sp="providers"><h2>API keys & providers</h2><p class="set-desc">Add a key for any provider you use; its models appear in the model menu. Keys are encrypted with the operating system's key store (DPAPI on Windows) and only sent to that provider. Environment variables such as OPENAI_API_KEY also work.</p>
          <div class="set-card"><div class="set-pad"><div class="prov-grid">
            <div class="prov-row"><div class="prov-name"><b>Anthropic</b><small>Claude models</small></div>
              <input class="input" type="password" id="setAnthropic" autocomplete="off" placeholder="${s.hasAnthropic ? (s.keyFromEnv ? 'Using ANTHROPIC_API_KEY' : '•••••••• saved — paste to replace') : 'sk-ant-…'}"><button class="btn sm" id="testAnthropic">Test</button><small class="prov-status" id="anthropicStatus"></small></div>
            <div class="prov-row"><div class="prov-name"><b>Google Gemini</b><small>aistudio.google.com</small></div>
              <input class="input" type="password" id="setGemini" autocomplete="off" placeholder="${s.hasGemini ? (s.geminiFromEnv ? 'Using GEMINI_API_KEY' : '•••••••• saved — paste to replace') : 'Paste your key'}"><button class="btn sm" id="testGemini">Test</button><small class="prov-status" id="geminiStatus"></small></div>
            <div id="oaiProviders" style="display:contents"></div>
          </div></div></div>
          <div class="set-card"><div class="set-sub">LM Studio (local)</div>
            ${setItem('Use LM Studio', "Models served by LM Studio's local server (Developer tab → Start server).", tgl('setLmStudio'))}
            ${setItem('Server URL', '<span id="lmStatus"></span>', '<input class="input" id="setLmUrl"><button class="btn sm" id="testLm">Test</button>')}
          </div>
          <div class="set-card"><div class="set-sub">Custom OpenAI-compatible endpoint</div>
            ${setItem('Name', 'Shown in the model menu. Works with vLLM, LiteLLM, Azure AI Foundry, a company gateway and other OpenAI-compatible servers.', '<input class="input" id="setCustomLabel" placeholder="My gateway">')}
            ${setItem('Base URL', 'For example https://host/v1', '<input class="input" id="setCustomUrl" placeholder="https://host/v1">')}
            ${setItem('API key', 'Optional, if the endpoint needs one. <span id="customStatus" class="status"></span>', `<input class="input" type="password" id="setCustomKey" autocomplete="off" placeholder="${s.providers?.custom?.hasKey ? '•••••••• saved' : 'if required'}"><button class="btn sm" id="testCustom">Test</button>`)}
          </div>
        </section>
        <section class="set-sec" data-sp="models"><h2>Models & cost</h2><p class="set-desc">With the Auto model, DROPs starts each request on the cheapest tier that fits and escalates when a check fails, it loops, or tools keep erroring.</p>
          <div class="set-card"><div class="set-sub">Auto routing</div>
            ${setItem('Auto uses', 'Which provider the Auto model routes through.', selectOf('setAutoProv', [['auto', 'Any available (Claude → Gemini → Ollama)'], ['anthropic', 'Claude (Haiku → Sonnet → Opus)'], ['gemini', 'Gemini (Flash Lite → Flash → Pro)'], ['ollama', 'Ollama (local models)']]))}
            ${setItem('Cheap sub-agents', 'Research sub-agents run on the cheapest model of the same provider.', tgl('setCheapSub'))}
          </div>
          <div class="set-card"><div class="set-sub">Budget per task</div>
            ${setItem('Maximum cost (USD)', '0 means no limit. The agent stops cleanly and you can type "continue".', '<input class="input num" type="number" id="setMaxCost" min="0" step="0.5">')}
            ${setItem('Maximum tokens', '0 means no limit. Works for every provider, including ones without known prices.', '<input class="input num" type="number" id="setMaxTok" min="0" step="50000">')}
          </div>
          <div class="set-card"><div class="set-sub">Local models (Ollama)</div>
            ${setItem('Use Ollama', 'Run models fully offline on this PC: private and free. Needs a model with tool support, such as qwen3 or llama3.1.', tgl('setOllama'))}
            ${setItem('Ollama URL', '<span id="ollamaStatus"></span>', '<input class="input" id="setOllamaUrl"><button class="btn sm" id="testOllama">Test</button>')}
            ${setItem('Context window (tokens)', '8192 is a good start for 27B–30B models with 16 GB RAM. Bigger needs more memory.', '<input class="input num" type="number" id="setOllamaCtx" min="4096" step="4096">')}
            <div class="set-pad" id="ollamaDl"></div>
          </div>
        </section>
        <section class="set-sec" data-sp="agent"><h2>Agent</h2><p class="set-desc">How the agent works, checks its own work and explains itself.</p>
          <div class="set-card"><div class="set-sub">Reliability</div>
            ${setItem('Verification guard', 'After editing, the agent cannot finish until a real test, build or type-check passes, or it proves the failure was already there.', tgl('setVerify'))}
            ${setItem('Independent QA agent', 'When a task names SPEC.md, a separate QA call writes browser or HTTP checks from the spec alone before coding starts.', tgl('setQaAgent'))}
            ${setItem('Auto-compact context at (tokens)', 'Older turns are summarised past this size. Lower is cheaper; higher keeps more detail.', '<input class="input num" type="number" id="setCompact" min="20000" step="10000">')}
            ${setItem('Maximum steps per request', 'Safety limit on agent iterations for one message.', '<input class="input num" type="number" id="setSteps" min="10" step="10">')}
            ${setItem('After-edit command', 'Runs after every file the agent changes, e.g. a formatter or linter. <code>{file}</code> is the changed file. Its output goes back to the agent. Leave empty to turn off.', '<input class="input" id="setAfterEdit" placeholder="npx prettier --write {file}" spellcheck="false">')}
          </div>
          <div class="set-card"><div class="set-sub">Language & learning</div>
            ${setItem('Explanations language', 'The agent explains its work in this language; code stays as it is.', selectOf('setLang', LANGS))}
            ${setItem('Teaching mode', 'Explains every change and the idea behind it. Useful when learning.', tgl('setExplain'))}
          </div>
          <div class="set-card"><div class="set-sub">Instructions</div>
            ${setItem('Instructions for every session', 'Project rules live in DROPs.md (or AGENTS.md / CLAUDE.md) and team rules in <code>.drops/rules/*.md</code>; commit them so the whole team shares them.', '<textarea class="textarea" id="setInstr" rows="4" placeholder="e.g. Prefer TypeScript strict mode. Use pnpm. Write tests with Vitest."></textarea>', 'stack')}
          </div>
        </section>
        <section class="set-sec" data-sp="tools"><h2>Tools & MCP</h2><p class="set-desc">Connect GitHub, databases, issue trackers, browsers and more through the Model Context Protocol. Tools appear to the agent as <code>mcp__server__tool</code> and ask for permission unless the server has <code>"trust": true</code>.</p>
          <div class="set-card">
            ${setItem('MCP servers (JSON)', '<span id="mcpErr">Same format as Claude Desktop and VS Code: stdio servers use "command" + "args" (+ "env"); remote servers use "url".</span>', '<div id="mcpStatus" class="mcp-list"></div><textarea class="textarea mono" id="setMcp" rows="9" spellcheck="false"></textarea>', 'stack')}
            ${setItem("Load the project's .mcp.json", 'Also connect servers listed in the open project. Only for repositories you trust: they can start programs.', tgl('setProjMcp'))}
          </div>
          <div class="set-card"><div class="set-sub">Custom slash commands</div>
            ${setItem('Your own /commands', 'Each Markdown file becomes a command named after the file: <code>.drops/commands/review-pr.md</code> → <code>/review-pr</code>. Write the prompt in the file; <code>$ARGUMENTS</code> is replaced by what you type after the command. An optional first block <code>---</code> <code>description: …</code> <code>---</code> sets the menu text. Project commands can be committed and shared with your team.', '<button class="btn sm" id="openUserCmds">Open my folder</button><button class="btn sm" id="openProjCmds">Open project folder</button>')}
          </div>
        </section>
        <section class="set-sec" data-sp="safety"><h2>Safety & sandbox</h2><p class="set-desc">Destructive commands, commands that write outside the project and network requests always ask first, in every mode. Secrets in tool output are masked before the model sees them.</p>
          <div class="set-card"><div class="set-sub">Command rules</div>
            ${setItem('Always allow these commands', 'One per line, <code>*</code> matches anything, e.g. <code>npm test*</code> or <code>git status</code>. They run without asking (dangerous commands still ask). A rule never approves a chained command like <code>npm test; curl …</code>.', '<textarea class="textarea mono" id="setAllowCmds" rows="4" spellcheck="false" placeholder="npm test*&#10;npm run lint*&#10;git diff*"></textarea>', 'stack')}
            ${setItem('Never run these commands', 'One per line. Matching commands are blocked in every mode, also inside a chained command.', '<textarea class="textarea mono" id="setDenyCmds" rows="4" spellcheck="false" placeholder="git push*&#10;npm publish*"></textarea>', 'stack')}
          </div>
          <div class="set-card"><div class="set-sub">Docker sandbox</div>
            ${setItem('Run commands in a Docker sandbox', 'Shell commands and background processes run in a container with only the project folder mounted. Needs Docker Desktop.', tgl('setSandbox'))}
            ${setItem('Container image', 'Any image with bash, e.g. node:22-bookworm, python:3.12, mcr.microsoft.com/dotnet/sdk:9.0', '<input class="input" id="setSandboxImg">')}
            ${setItem('Allow network in the sandbox', 'Turn off to isolate fully (package installs will fail).', tgl('setSandboxNet'))}
          </div>
        </section>
        <section class="set-sec" data-sp="appearance"><h2>Appearance</h2><p class="set-desc">Changes apply right away.</p>
          <div class="set-card">
            ${setItem('Theme', '', `<div class="theme-pick" id="themePick"><button data-t="system">${icon('monitor', 'sm')}System</button><button data-t="light">${icon('sun', 'sm')}Light</button><button data-t="dark">${icon('moon', 'sm')}Dark</button></div>`, 'stack')}
            ${setItem('Message text size', 'Size of chat messages and the message box.', selectOf('setChatSize', [['small', 'Small'], ['default', 'Default'], ['large', 'Large']]))}
            ${setItem('Conversation width', 'Wide uses more of large screens.', selectOf('setChatWidth', [['default', 'Standard'], ['wide', 'Wide']]))}
            ${setItem('Density', 'Compact fits more rows in lists and tool output.', selectOf('setDensity', [['default', 'Comfortable'], ['compact', 'Compact']]))}
          </div>
        </section>
        <section class="set-sec" data-sp="shortcuts"><h2>Keyboard shortcuts</h2><p class="set-desc">Available everywhere in DROPs.</p>
          <div class="set-card"><div class="kbd-list">${SHORTCUTS.map(([d, k]) => `<div>${d}</div><div>${k.split(' ').map((x) => `<kbd>${x}</kbd>`).join(' ')}</div>`).join('')}</div></div>
        </section>
        <section class="set-sec" data-sp="about"><h2>About</h2>
          <div class="set-card">
            ${setItem('DROPs', 'Autonomous coding agent for your desktop.', `<span class="muted">Version ${esc(S.info.version || '')}</span>`)}
            ${setItem('Platform', '', `<span class="muted">${esc(S.info.platform || '')}</span>`)}
            ${setItem('Your data', 'Settings, sessions and encrypted keys stay on this computer, in the DROPs folder of your app data.', '')}
          </div>
        </section>
        <div class="set-empty" id="setEmpty" hidden>No settings match your search.</div>
        </div></div>
        <div class="set-foot"><span class="dirty-note" id="setDirty"></span><div class="grow"></div><button class="btn" data-close>Cancel</button><button class="btn primary" id="saveSettings">Save changes</button></div>
      </div>`;
    document.body.appendChild(o);
    const scroller = $('.set-scroll', m);
    let offMcp = () => {}, offProg = () => {};
    const close = () => { offMcp(); offProg(); o.remove(); applyAppearance(S.settings); $('#input')?.focus(); };
    o.onkeydown = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    $$('[data-close]', m).forEach((b) => (b.onclick = close));
    // Navigation: jump to a section; highlight the section in view while scrolling.
    const navTo = (k, smooth = true) => {
      $$('[data-nav]', m).forEach((b) => b.classList.toggle('on', b.dataset.nav === k));
      const sec = $(`[data-sp="${k}"]`, m);
      if (sec) scroller.scrollTo({ top: sec.offsetTop - 8, behavior: smooth ? 'smooth' : 'auto' });
    };
    const showTab = (k) => navTo(k);
    $$('[data-nav]', m).forEach((b) => (b.onclick = () => { $('#setSearch', m).value = ''; filter(''); navTo(b.dataset.nav); }));
    scroller.addEventListener('scroll', () => {
      let cur = sections[0][0];
      for (const sec of $$('.set-sec', m)) if (!sec.classList.contains('set-hidden') && sec.offsetTop - 40 <= scroller.scrollTop) cur = sec.dataset.sp;
      if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4) cur = [...$$('.set-sec', m)].filter((x) => !x.classList.contains('set-hidden')).pop()?.dataset.sp || cur;
      $$('[data-nav]', m).forEach((b) => b.classList.toggle('on', b.dataset.nav === cur));
    });
    // Search: keep only matching rows (and the sections that still have one).
    const filter = (q) => {
      q = q.trim().toLowerCase();
      let any = false;
      for (const sec of $$('.set-sec', m)) {
        const title = $('h2', sec).textContent.toLowerCase();
        let hits = 0;
        for (const it of $$('.set-item, .set-pad, .kbd-list', sec)) {
          const ok = !q || title.includes(q) || it.textContent.toLowerCase().includes(q);
          it.classList.toggle('set-hidden', !ok); if (ok) hits++;
        }
        for (const card of $$('.set-card', sec)) card.classList.toggle('set-hidden', !!q && !$$('.set-item:not(.set-hidden), .set-pad:not(.set-hidden), .kbd-list:not(.set-hidden)', card).length);
        sec.classList.toggle('set-hidden', !hits); if (hits) any = true;
      }
      $('#setEmpty', m).hidden = any;
      scroller.scrollTop = 0;
    };
    $('#setSearch', m).addEventListener('input', (e) => filter(e.target.value));
    // Unsaved-changes hint.
    const markDirty = () => { $('#setDirty', m).textContent = 'You have unsaved changes'; };
    scroller.addEventListener('input', markDirty);
    scroller.addEventListener('click', (e) => { if (e.target.closest('.toggle')) markDirty(); });
    // Sections above can grow when provider lists load, so settle the first jump a few times
    // unless the user has scrolled by then.
    let userScrolled = false;
    scroller.addEventListener('wheel', () => { userScrolled = true; }, { passive: true });
    for (const ms of [0, 150, 400, 900]) setTimeout(() => { if (!userScrolled) navTo(tab, false); }, ms);
    // Appearance applies live (and is saved with the rest).
    const appear = () => applyAppearance({ chatSize: $('#setChatSize', m).value, chatWidth: $('#setChatWidth', m).value, density: $('#setDensity', m).value });
    ['#setChatSize', '#setChatWidth', '#setDensity'].forEach((id) => $(id, m).addEventListener('change', appear));

    const sel = $('#setModel', m);
    fillModelSelect(sel);
    sel.value = usableModel(s.defaultModel);
    const val = (id, v) => { $(id, m).value = v ?? ''; };
    val('#setEffort', s.effort); val('#setMode', s.mode); val('#setCompact', s.compactAt); val('#setSteps', s.maxSteps); val('#setInstr', s.customInstructions);
    val('#setLang', s.responseLanguage || 'auto'); val('#setAutoProv', s.autoProvider || 'auto'); val('#setMaxCost', s.maxCostPerTask || 0); val('#setMaxTok', s.maxTokensPerTask || 0);
    val('#setOllamaUrl', s.ollamaUrl || 'http://localhost:11434'); val('#setOllamaCtx', s.ollamaCtx || 16384); val('#setSandboxImg', s.sandboxImage || 'node:22-bookworm');
    val('#setAllowCmds', (s.allowCommands || '')); val('#setDenyCmds', (s.denyCommands || '')); val('#setAfterEdit', s.afterEditCommand || '');
    $('#openUserCmds', m).onclick = () => api.openCommandsFolder('user');
    $('#openProjCmds', m).onclick = () => (S.project ? api.openCommandsFolder('project') : toast('Open a project first'));
    $('#openProjCmds', m).disabled = !S.project;
    val('#setSendKey', s.sendKey || 'enter'); val('#setChatSize', s.chatSize || 'default'); val('#setChatWidth', s.chatWidth || 'default'); val('#setDensity', s.density || 'default');
    val('#setMcp', Object.keys(s.mcpServers || {}).length ? JSON.stringify(s.mcpServers, null, 2) : '');
    $('#setMcp', m).placeholder = MCP_EXAMPLE;
    const tog = (id, on) => { const t = $(id, m); t.classList.toggle('on', !!on); t.onclick = () => t.classList.toggle('on'); return t; };
    const T = {
      restore: tog('#setRestore', s.restoreLastProject !== false), notify: tog('#setNotify', s.notifyApproval !== false),
      verify: tog('#setVerify', s.autoVerify !== false), qa: tog('#setQaAgent', s.qaAgent !== false), explain: tog('#setExplain', s.explainMode), cheap: tog('#setCheapSub', s.cheapSubagents !== false),
      ollama: tog('#setOllama', s.ollamaEnabled !== false), projMcp: tog('#setProjMcp', s.allowProjectMcp), sandbox: tog('#setSandbox', s.sandbox), net: tog('#setSandboxNet', s.sandboxNetwork !== false),
    };
    let theme = s.theme || 'dark';
    const paintTheme = () => $$('#themePick button', m).forEach((b) => b.classList.toggle('on', b.dataset.t === theme));
    $$('#themePick button', m).forEach((b) => (b.onclick = async () => { theme = b.dataset.t; paintTheme(); await setTheme(theme); }));
    paintTheme();

    const test = async (provider, inputId, statusId) => {
      const k = $(inputId, m).value.trim();
      if (k) S.settings = await api.setSettings(provider === 'gemini' ? { geminiKey: k } : { apiKey: k });
      const st = $(statusId, m); st.className = ''; st.textContent = 'Testing…';
      const r = await api.testKey(provider);
      st.className = r.ok ? 'ok-text' : 'err-text';
      st.textContent = r.ok ? `Connected — ${r.detail}.` : r.error;
      if (r.ok) await reloadModels();
    };
    $('#testAnthropic', m).onclick = () => test('anthropic', '#setAnthropic', '#anthropicStatus');
    $('#testGemini', m).onclick = () => test('gemini', '#setGemini', '#geminiStatus');
    $('#testOllama', m).onclick = async () => {
      S.settings = await api.setSettings({ ollamaUrl: $('#setOllamaUrl', m).value.trim(), ollamaEnabled: true });
      T.ollama.classList.add('on');
      const st = $('#ollamaStatus', m); st.className = ''; st.textContent = 'Connecting…';
      const r = await api.ollamaTest();
      st.className = r.ok ? 'ok-text' : 'err-text'; st.textContent = r.ok ? r.detail : r.error;
      if (r.ok) await reloadModels();
    };
    const paintMcp = (list) => {
      const box = $('#mcpStatus', m); if (!box) return;
      box.innerHTML = '';
      for (const x of list || []) {
        const r = h('div', 'mcp-row');
        r.innerHTML = `<span class="state ${x.status === 'connected' ? 'on' : x.status === 'error' ? 'bad' : ''}"></span><b></b><span class="muted"></span>`;
        $('b', r).textContent = x.name;
        $('.muted', r).textContent = x.status === 'connected' ? `${x.tools.length} tools${x.trusted ? ' · trusted' : ''}` : x.status === 'error' ? x.error : x.status;
        r.title = x.untrusted ? x.command : x.tools.join(', ');
        if (x.untrusted) {
          const b = h('button', 'btn sm'); b.innerHTML = icon('shield', 'xs') + 'Review and trust';
          b.onclick = async () => {
            const cmds = (list || []).filter((y) => y.untrusted).map((y) => `${y.name}: ${y.command}`).join('\n');
            if (!(await confirmBox("Trust this project's MCP servers?", `These programs will start on your computer with your permissions:

${cmds}

Trust only projects you know. Any change to .mcp.json asks again.`, 'Trust and start'))) return;
            paintMcp(await api.mcpTrustProject());
          };
          r.appendChild(b);
        }
        box.appendChild(r);
      }
    };
    api.mcpStatus().then(paintMcp);
    offMcp = api.onMcp(paintMcp);

    // ----- providers tab -----
    const provInputs = {};
    const testProvider = async (pid, input, status, extra = {}) => {
      const k = input?.value.trim();
      const patch = { ...extra };
      if (k) patch.providerKeys = { [pid]: k };
      if (Object.keys(patch).length) S.settings = await api.setSettings(patch);
      status.className = 'prov-status'; status.textContent = 'Testing…';
      const r = await api.providerTest(pid);
      status.className = 'prov-status ' + (r.ok ? 'ok-text' : 'err-text');
      status.textContent = r.ok ? `Connected — ${r.detail}` : r.error;
      if (r.ok) { if (input) { input.value = ''; input.placeholder = '•••••••• saved — paste to replace'; } await reloadModels(); }
    };
    api.providerList().then((list) => {
      const box = $('#oaiProviders', m);
      for (const p of list.filter((x) => !x.custom && !x.local)) {
        const st = s.providers?.[p.id] || {};
        const row = h('div', 'prov-row');
        row.innerHTML = `<div class="prov-name"><b></b><small></small></div><input class="input" type="password" autocomplete="off"><button class="btn">Test</button><small class="prov-status"></small>`;
        $('b', row).textContent = p.label;
        const sm = $('.prov-name small', row);
        if (p.keyUrl) { const a = h('a', '', 'Get a key'); a.href = p.keyUrl; a.target = '_blank'; sm.appendChild(a); }
        const inp = $('input', row);
        inp.placeholder = st.hasKey ? (st.fromEnv ? `Using ${p.env}` : '•••••••• saved — paste to replace') : 'Paste API key';
        provInputs[p.id] = inp;
        const status = $('.prov-status', row);
        if (st.hasKey) { status.textContent = 'Key saved'; status.className = 'prov-status ok-text'; }
        $('button', row).onclick = () => testProvider(p.id, inp, status);
        box.appendChild(row);
      }
    });
    const lmTog = tog('#setLmStudio', s.lmstudioEnabled);
    val('#setLmUrl', s.lmstudioUrl || 'http://127.0.0.1:1234/v1');
    val('#setCustomLabel', s.customLabel === 'Custom' ? '' : s.customLabel); val('#setCustomUrl', s.customBaseUrl);
    $('#testLm', m).onclick = () => { lmTog.classList.add('on'); testProvider('lmstudio', null, $('#lmStatus', m), { lmstudioEnabled: true, lmstudioUrl: $('#setLmUrl', m).value.trim() }); };
    $('#testCustom', m).onclick = () => {
      const url = $('#setCustomUrl', m).value.trim();
      if (!url) { $('#customStatus', m).textContent = 'Enter the base URL first.'; return; }
      testProvider('custom', $('#setCustomKey', m), $('#customStatus', m), { customBaseUrl: url, customLabel: $('#setCustomLabel', m).value.trim() || 'Custom' });
    };

    // ----- Ollama downloads -----
    const dl = $('#ollamaDl', m);
    api.ollamaRecommended().then(({ models, ramGb }) => {
      dl.innerHTML = `<div class="section-title">Download a free local model</div><p class="hint-p">This PC has <b>${ramGb} GB</b> RAM. Models run 100% offline — no key, no cost. Cloud models (names ending in "-cloud") need paid Ollama credits.</p>`;
      const list = h('div', 'dl-list');
      for (const r of models) {
        const fits = ramGb >= r.ram;
        const row = h('div', 'dl-row');
        row.innerHTML = `<div class="grow"><b></b> <span class="muted"></span><div class="dl-note"></div><div class="dl-bar" hidden><div></div></div></div><button class="btn sm">${icon('download', 'xs')}Download</button>`;
        $('b', row).textContent = r.name; $('.muted', row).textContent = r.size; $('.dl-note', row).textContent = r.note + (fits ? (r === models.find((x) => ramGb >= x.ram) ? ' · recommended for this PC' : '') : ` · needs ~${r.ram} GB RAM`);
        if (!fits) row.classList.add('dim');
        $('button', row).onclick = () => startPull(r.name, row);
        list.appendChild(row);
      }
      const custom = h('div', 'dl-row');
      custom.innerHTML = `<input class="input grow" placeholder="Any model from ollama.com/library, e.g. llama3.2:3b"><button class="btn sm">${icon('download', 'xs')}Download</button><div class="dl-bar" hidden><div></div></div>`;
      $('button', custom).onclick = () => { const n = $('input', custom).value.trim(); if (n) startPull(n, custom); };
      list.appendChild(custom);
      dl.appendChild(list);
    });
    const startPull = async (name, row) => {
      const btn = $('button', row), bar = $('.dl-bar', row), fill = $('.dl-bar div', row);
      const note = $('.dl-note', row) || h('div', 'dl-note');
      if (!note.parentElement) row.appendChild(note);
      btn.disabled = true; bar.hidden = false; note.textContent = 'Starting…';
      offProg(); offProg = api.onOllamaProgress((p) => {
        if (p.name !== name) return;
        const pct = p.total ? Math.round((p.completed / p.total) * 100) : 0;
        fill.style.width = (p.total ? pct : 5) + '%';
        note.textContent = p.total ? `${p.status} — ${pct}% of ${(p.total / 1e9).toFixed(1)} GB` : p.status;
      });
      const r = await api.ollamaPull(name);
      btn.disabled = false;
      if (r.ok) { fill.style.width = '100%'; note.textContent = `Downloaded — pick "${name}" in the model menu.`; note.className = 'dl-note ok-text'; await reloadModels(); }
      else { note.textContent = r.error; note.className = 'dl-note err-text'; bar.hidden = true; }
    };

    $('#saveSettings', m).onclick = async () => {
      let mcpServers = {};
      const raw = $('#setMcp', m).value.trim();
      if (raw) {
        try { mcpServers = JSON.parse(raw); if (mcpServers.mcpServers) mcpServers = mcpServers.mcpServers; if (typeof mcpServers !== 'object' || Array.isArray(mcpServers)) throw new Error('must be an object of servers'); }
        catch (e) { showTab('tools'); $('#mcpErr', m).className = 'err-text'; $('#mcpErr', m).textContent = 'Invalid JSON: ' + e.message; return; }
      }
      const num = (id, d, min = 0) => Math.max(min, Number($(id, m).value) || d);
      const patch = {
        defaultModel: sel.value, effort: $('#setEffort', m).value, mode: $('#setMode', m).value,
        compactAt: num('#setCompact', 180000, 20000), maxSteps: num('#setSteps', 250, 10), customInstructions: $('#setInstr', m).value,
        autoVerify: T.verify.classList.contains('on'), qaAgent: T.qa.classList.contains('on'), explainMode: T.explain.classList.contains('on'), responseLanguage: $('#setLang', m).value, languageMigrated: true,
        autoProvider: $('#setAutoProv', m).value, cheapSubagents: T.cheap.classList.contains('on'),
        maxCostPerTask: Math.max(0, Number($('#setMaxCost', m).value) || 0), maxTokensPerTask: Math.max(0, Number($('#setMaxTok', m).value) || 0),
        ollamaEnabled: T.ollama.classList.contains('on'), ollamaUrl: $('#setOllamaUrl', m).value.trim() || 'http://localhost:11434', ollamaCtx: num('#setOllamaCtx', 16384, 4096),
        mcpServers, allowProjectMcp: T.projMcp.classList.contains('on'),
        allowCommands: $('#setAllowCmds', m).value.trim(), denyCommands: $('#setDenyCmds', m).value.trim(), afterEditCommand: $('#setAfterEdit', m).value.trim(),
        restoreLastProject: T.restore.classList.contains('on'), notifyApproval: T.notify.classList.contains('on'), sendKey: $('#setSendKey', m).value,
        chatSize: $('#setChatSize', m).value, chatWidth: $('#setChatWidth', m).value, density: $('#setDensity', m).value,
        sandbox: T.sandbox.classList.contains('on'), sandboxImage: $('#setSandboxImg', m).value.trim() || 'node:22-bookworm', sandboxNetwork: T.net.classList.contains('on'),
      };
      const provKeys = {};
      for (const [pid, inp] of Object.entries(provInputs)) { const k = inp.value.trim(); if (k) provKeys[pid] = k; }
      const ck = $('#setCustomKey', m).value.trim(); if (ck) provKeys.custom = ck;
      if (Object.keys(provKeys).length) patch.providerKeys = provKeys;
      patch.lmstudioEnabled = lmTog.classList.contains('on'); patch.lmstudioUrl = $('#setLmUrl', m).value.trim() || 'http://127.0.0.1:1234/v1';
      patch.customBaseUrl = $('#setCustomUrl', m).value.trim(); patch.customLabel = $('#setCustomLabel', m).value.trim() || 'Custom';
      const a = $('#setAnthropic', m).value.trim(); if (a) patch.apiKey = a;
      const g = $('#setGemini', m).value.trim(); if (g) patch.geminiKey = g;
      S.settings = await api.setSettings(patch);
      applyAppearance(S.settings); applySendKey(); loadCustomCommands();
      await reloadModels();
      if (!currentView()) { $('#modelSel').value = usableModel(S.settings.defaultModel); syncPills(); }
      if (!$('#hero').hidden) renderHero();
      updateCtx(); renderUsage(); renderStatus();
      close();
      toast('Settings saved');
    };
    setTimeout(() => (tab === 'providers' ? $('#setAnthropic', m) : $('#setSearch', m))?.focus({ preventScroll: true }), 60);
  }

  // ---------- command palette ----------
  function openPalette(initial = '') {
    if ($('.palette')) return;
    const o = h('div', 'overlay');
    const p = h('div', 'palette');
    const input = h('input'); input.placeholder = 'Type a command, file name or session…'; input.value = initial;
    const list = h('div', 'list');
    p.append(input, list); o.appendChild(p); document.body.appendChild(o);
    const close = () => o.remove();
    o.onclick = (e) => { if (e.target === o) close(); };
    const commands = [
      ['New session', 'Ctrl+N', () => newSession(), 'plus'],
      ['Open project folder…', 'Ctrl+O', () => pickProject(), 'folderOpen'],
      ['Toggle light / dark theme', 'Ctrl+Shift+L', () => toggleTheme(), 'sun'],
      ['Settings', 'Ctrl+,', () => openSettings(), 'settings'],
      ['Compact context now', '/compact', () => compactNow(), 'layers'],
      ['Export conversation to Markdown', '/export', () => exportSession('md'), 'download'],
      ['Export HTML review report (share with your team)', '', () => exportSession('html'), 'upload'],
      ['Export shareable session file (.drops.json)', '', () => exportSession('json'), 'upload'],
      ['Import a shared session…', '', () => importSession(), 'download'],
      ['New session in its own git worktree (parallel agent)', '', () => newWorktreeSession(), 'branch'],
      ['Settings: models, Auto routing & budget', '', () => openSettings('models'), 'cpu'],
      ['Settings: MCP servers & sandbox', '', () => openSettings('tools'), 'plug'],
      ['Lessons learned', '', () => lessonsBox(), 'brain'],
      ['Reconnect MCP servers', '', async () => { const st = await api.mcpReconnect(); toast(`MCP: ${st.filter((x) => x.status === 'connected').length}/${st.length} connected`); }, 'refresh'],
      ['Generate commit message', '/commit', () => generateCommitMessage(), 'sparkles'],
      ['Switch to Plan mode', '', () => { setMode('plan'); persistOpts(); }, 'list'],
      ['Switch to Full auto mode', '', () => { setMode('yolo'); persistOpts(); }, 'zap'],
      ['Split view: show another session beside this one', 'Ctrl+\\', () => (S.split ? setSplit(null) : openSplitPicker()), 'panelRight'],
      ['Toggle sidebar', 'Ctrl+B', () => $('#body').classList.toggle('no-side'), 'panelLeft'],
      ['Toggle right panel', 'Ctrl+J', () => toggleInspector(), 'panelRight'],
      ['Show source control', '', () => showSide('scm'), 'branch'],
      ['Show explorer', '', () => showSide('explorer'), 'files'],
      ['Initialize project memory (DROPs.md)', '/init', () => sendText('/init'), 'bookmark'],
      ['Review uncommitted changes', '/review', () => sendText('/review'), 'eye'],
    ];
    let items = [], idx = 0, seq = 0;
    const draw = async () => {
      const q = input.value.trim().toLowerCase();
      const my = ++seq;
      items = [];
      const cmds = commands.filter(([t]) => !q || t.toLowerCase().includes(q)).map(([t, k, run, ic]) => ({ sec: 'Commands', t, d: k, run, ic }));
      const sess = S.sessions.filter((s) => q && s.title.toLowerCase().includes(q)).slice(0, 6).map((s) => ({ sec: 'Sessions', t: s.title, d: timeAgo(s.updated), run: () => openSession(s.id), ic: 'chat' }));
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
        r.innerHTML = `${icon(it.ic, 'sm')}<span class="grow" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></span><span class="d"></span>`;
        $('.grow', r).textContent = it.t; $('.d', r).textContent = it.d;
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
    return new Promise((res) => {
      const o = h('div', 'overlay center');
      const m = h('div', 'modal'); m.style.width = 'min(440px, 92vw)';
      m.innerHTML = `<div class="modal-head"><h2>${esc(title)}</h2></div><div class="modal-body" style="padding-top:14px"><input class="input" style="width:100%"></div>`;
      const f = h('div', 'modal-foot'); const no = h('button', 'btn', 'Cancel'); const yes = h('button', 'btn primary', 'Save');
      f.append(no, yes); m.appendChild(f); o.appendChild(m); document.body.appendChild(o);
      const inp = $('input', m); inp.value = value || ''; inp.select(); inp.focus();
      const done = (r) => { o.remove(); res(r); };
      no.onclick = () => done(null); yes.onclick = () => done(inp.value.trim() || null);
      inp.onkeydown = (e) => { if (e.key === 'Enter') done(inp.value.trim() || null); if (e.key === 'Escape') done(null); };
    });
  }

  return { showSide, renderSessions, markSession, loadTree, refreshTreeMarks, refreshGit, refreshGitSoon, generateCommitMessage, switchTab, renderPlan, renderTasks, renderChanges, renderUsage, onProc, renderProcs, renderStatus, renderHero, openSettings, openPalette };
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
  if (window.innerWidth <= 1280) b.classList.toggle('force-insp'); else b.classList.toggle('no-insp');
  $('#inspToggle').classList.toggle('on', !b.classList.contains('no-insp'));
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
