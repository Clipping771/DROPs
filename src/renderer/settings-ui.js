/* DROPs Settings modal (extracted from panels.js for modularity). */
'use strict';

window.SettingsUI = (() => {
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
        <section class="set-sec" data-sp="providers"><h2>API keys & providers</h2><p class="set-desc">Add a key for any provider you use; its models appear in the model menu. Keys are encrypted with the operating system's key store (DPAPI on Windows) and only sent to that provider. Environment variables such as OPENAI_API_KEY also work.</p>${!s.keyStoreAvailable || s.plainKeysSaved ? `<p class="set-desc" style="color:var(--err)"><b>Warning:</b> ${s.plainKeysSaved ? 'some saved keys are not encrypted' : 'keys you save here will not be encrypted'}: this system has no key store (on Linux, install and unlock a keyring such as GNOME Keyring or KWallet). Until then, prefer environment variables, and re-save your keys once the key store works.</p>` : ''}${s.plainKeyFile ? `<p class="set-desc" style="color:var(--err)"><b>Plain-text key file:</b> ${esc(s.plainKeyFile)} holds an API key anyone with access to this computer can read. DROPs has copied it into its encrypted store${s.keyStoreAvailable ? '' : ' (once the key store works)'}: delete the file.</p>` : ''}
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
            ${setItem('Check for updates', 'Once a day DROPs asks GitHub whether a newer version has been released and tells you. It never downloads or installs anything by itself. Crash reports are kept on this computer only (Ctrl+K → Open crash reports folder).', tgl('setUpdateCheck'))}
            ${setItem('Keep running for scheduled tasks', 'With scheduled tasks, closing the window keeps DROPs in the tray so they still run. Quit from the tray icon.', tgl('setBackground'))}
            ${setItem('Computer use', 'Lets DROPs use apps on this computer with the mouse and keyboard when you ask. It asks before each app, never touches system programs or password fields, asks before delete/send/pay, and stops when you move the mouse.', tgl('setComputer'))}
            ${setItem('Independent QA agent', 'When a task names SPEC.md, a separate QA call writes browser or HTTP checks from the spec alone before coding starts.', tgl('setQaAgent'))}
            ${setItem('Auto-compact context at (tokens)', 'Older turns are summarised past this size. Lower is cheaper; higher keeps more detail.', '<input class="input num" type="number" id="setCompact" min="20000" step="10000">')}
            ${setItem('Maximum steps per request', 'Safety limit on agent iterations for one message.', '<input class="input num" type="number" id="setSteps" min="10" step="10">')}
            ${setItem('Hooks (JSON)', 'Your commands at fixed points of the work: <code>SessionStart</code>, <code>UserPromptSubmit</code>, <code>PreToolUse</code>, <code>PostToolUse</code>, <code>Stop</code>. Each gets the event as JSON on stdin; exit code 2 blocks (or, for Stop, sends the agent back) with stderr as the reason; stdout is added as context. A project can have its own in <code>.drops/hooks.json</code> (you approve it once per session).', '<textarea class="textarea mono" id="setHooks" rows="6" spellcheck="false" placeholder="{&quot;hooks&quot;: {&quot;PostToolUse&quot;: [{&quot;matcher&quot;: &quot;write_file|edit_file&quot;, &quot;command&quot;: &quot;npm run lint --silent&quot;}]}}"></textarea>', 'stack')}
            ${setItem('After-edit command', 'Runs after every file the agent changes, e.g. a formatter or linter. <code>{file}</code> is the changed file. Its output goes back to the agent. Leave empty to turn off.', '<input class="input" id="setAfterEdit" placeholder="npx prettier --write {file}" spellcheck="false">')}
          </div>
          <div class="set-card"><div class="set-sub">Language & learning</div>
            ${setItem('Interface language', 'Language of DROPs menus, tabs and buttons.', selectOf('setUiLang', [['en', 'English'], ['bn', 'বাংলা (Bengali)']]))}
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
    // Escape closes Settings wherever the focus is: in a narrow window the search box is hidden, focus
    // stayed in the chat box behind Settings, and Escape never reached it.
    const onEsc = (e) => { if (e.key === 'Escape' && document.body.contains(o) && !document.querySelector('.overlay')) { e.preventDefault(); e.stopPropagation(); close(); } };
    const close = () => { document.removeEventListener('keydown', onEsc, true); offMcp(); offProg(); o.remove(); applyAppearance(S.settings); $('#input')?.focus(); };
    document.addEventListener('keydown', onEsc, true);
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
    val('#setUiLang', s.uiLanguage || 'en'); val('#setLang', s.responseLanguage || 'auto'); val('#setAutoProv', s.autoProvider || 'auto'); val('#setMaxCost', s.maxCostPerTask || 0); val('#setMaxTok', s.maxTokensPerTask || 0);
    val('#setOllamaUrl', s.ollamaUrl || 'http://localhost:11434'); val('#setOllamaCtx', s.ollamaCtx || 16384); val('#setSandboxImg', s.sandboxImage || 'node:22-bookworm');
    val('#setAllowCmds', (s.allowCommands || '')); val('#setDenyCmds', (s.denyCommands || '')); val('#setAfterEdit', s.afterEditCommand || ''); val('#setHooks', typeof s.hooks === 'string' ? s.hooks : s.hooks ? JSON.stringify(s.hooks, null, 2) : '');
    $('#openUserCmds', m).onclick = () => api.openCommandsFolder('user');
    $('#openProjCmds', m).onclick = () => (S.project ? api.openCommandsFolder('project') : toast('Open a project first'));
    $('#openProjCmds', m).disabled = !S.project;
    val('#setSendKey', s.sendKey || 'enter'); val('#setChatSize', s.chatSize || 'default'); val('#setChatWidth', s.chatWidth || 'default'); val('#setDensity', s.density || 'default');
    val('#setMcp', Object.keys(s.mcpServers || {}).length ? JSON.stringify(s.mcpServers, null, 2) : '');
    $('#setMcp', m).placeholder = MCP_EXAMPLE;
    const tog = (id, on) => { const t = $(id, m); t.classList.toggle('on', !!on); t.onclick = () => t.classList.toggle('on'); return t; };
    const T = {
      restore: tog('#setRestore', s.restoreLastProject !== false), notify: tog('#setNotify', s.notifyApproval !== false),
      verify: tog('#setVerify', s.autoVerify !== false), qa: tog('#setQaAgent', s.qaAgent !== false), computer: tog('#setComputer', s.computerUse !== false), upd: tog('#setUpdateCheck', s.updateCheck !== false), bg: tog('#setBackground', s.runInBackground !== false), explain: tog('#setExplain', s.explainMode), cheap: tog('#setCheapSub', s.cheapSubagents !== false),
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
        autoVerify: T.verify.classList.contains('on'), qaAgent: T.qa.classList.contains('on'), computerUse: T.computer.classList.contains('on'), updateCheck: T.upd.classList.contains('on'), runInBackground: T.bg.classList.contains('on'), explainMode: T.explain.classList.contains('on'), uiLanguage: $('#setUiLang', m).value, responseLanguage: $('#setLang', m).value, languageMigrated: true,
        autoProvider: $('#setAutoProv', m).value, cheapSubagents: T.cheap.classList.contains('on'),
        maxCostPerTask: Math.max(0, Number($('#setMaxCost', m).value) || 0), maxTokensPerTask: Math.max(0, Number($('#setMaxTok', m).value) || 0),
        ollamaEnabled: T.ollama.classList.contains('on'), ollamaUrl: $('#setOllamaUrl', m).value.trim() || 'http://localhost:11434', ollamaCtx: num('#setOllamaCtx', 16384, 4096),
        mcpServers, allowProjectMcp: T.projMcp.classList.contains('on'),
        allowCommands: $('#setAllowCmds', m).value.trim(), denyCommands: $('#setDenyCmds', m).value.trim(), afterEditCommand: $('#setAfterEdit', m).value.trim(), hooks: $('#setHooks', m).value.trim(),
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
      applyAppearance(S.settings); applySendKey(); loadCustomCommands(); window.applyI18n?.(S.settings.uiLanguage || 'en');
      await reloadModels();
      if (!currentView()) { $('#modelSel').value = usableModel(S.settings.defaultModel); syncPills(); }
      if (!$('#hero').hidden) Panels.renderHero();
      updateCtx(); Panels.renderUsage(); Panels.renderStatus();
      close();
      toast('Settings saved');
    };
    setTimeout(() => {
      // Keyboard focus goes into Settings: the first field, or Settings itself when that field is hidden
      // (the search box is hidden in a narrow window).
      const f = tab === 'providers' ? $('#setAnthropic', m) : $('#setSearch', m);
      if (f && f.offsetParent) f.focus({ preventScroll: true });
      else { o.tabIndex = -1; o.focus({ preventScroll: true }); }
    }, 60);
  }
  return { openSettings };
})();
