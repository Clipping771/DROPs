// UI tests: launch the real DROPs Electron app and drive its window.
// The app runs with its own empty data and home folders, so the user's settings, keys,
// sessions and lessons are never read or changed. Run with: npm run test:ui
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright-core');

const root = path.join(__dirname, '..');
let app, win, tmp;
const errors = [];

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drops-ui-'));
  const home = path.join(tmp, 'home'), appdata = path.join(tmp, 'appdata');
  fs.mkdirSync(home); fs.mkdirSync(appdata);
  // DROPs data and home go to throwaway folders; LOCALAPPDATA stays real, because the installed Chrome/Edge needs it to start.
  const env = { ...process.env, APPDATA: appdata, USERPROFILE: home, HOME: home };
  for (const k of Object.keys(env)) if (/^(DROPS|H2O)_|_API_KEY$/.test(k)) delete env[k]; // no keys: nothing can call a model
  app = await _electron.launch({ executablePath: require('electron'), args: [root], cwd: root, env, timeout: 60000 });
  win = await app.firstWindow();
  win.on('pageerror', (e) => errors.push(String(e.message || e)));
  win.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await win.waitForSelector('#hero', { state: 'visible', timeout: 30000 });
  // Boot is done when the home screen and the Overview panel have their content.
  await win.waitForFunction(() => /DROPs/.test(document.querySelector('#hero')?.textContent || '') && (document.querySelector('#planBody')?.textContent || '').length > 20, null, { timeout: 30000 });
  // With no API key, the first run opens Settings so the user can add one.
  await win.waitForSelector('.settings-page', { state: 'visible', timeout: 10000 });
  firstRunSettings = true;
  await win.keyboard.press('Escape');
  await win.waitForSelector('.settings-page', { state: 'detached', timeout: 5000 });
});
let firstRunSettings = false;

test('a first run with no API key opens Settings, and Escape closes it', () => {
  assert.ok(firstRunSettings);
});

after(async () => {
  await app?.close().catch(() => {});
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

test('the window opens with the DROPs title and the home screen', async () => {
  assert.match(await win.title(), /DROPs/);
  const hero = await win.textContent('#hero');
  assert.ok(hero.trim().length > 20, 'the home screen has content');
  assert.ok(await win.isVisible('#composer'), 'the composer is shown');
  assert.ok(await win.isVisible('#input'), 'the prompt box is shown');
});

test('the sidebar is shown and Ctrl+B hides and shows it', async () => {
  assert.ok(await win.isVisible('#sidebar'));
  await win.keyboard.press('Control+b');
  assert.ok(await win.$eval('#body', (b) => b.classList.contains('no-side')), 'Ctrl+B hides the sidebar');
  await win.keyboard.press('Control+b');
  assert.ok(!(await win.$eval('#body', (b) => b.classList.contains('no-side'))), 'Ctrl+B shows it again');
});

test('the right panel opens on the Overview tab and every tab switches', async () => {
  if (!(await win.isVisible('#inspTabs'))) await win.click('#inspToggle');
  await win.waitForSelector('#inspTabs', { state: 'visible' });
  assert.equal((await win.textContent('#inspTabs button.on')).trim(), 'Overview');
  for (const tab of ['changes', 'terminal', 'usage', 'plan']) {
    await win.click(`#inspTabs button[data-tab="${tab}"]`);
    assert.ok(await win.$eval(`#inspTabs button[data-tab="${tab}"]`, (b) => b.classList.contains('on')), `${tab} tab is selected`);
  }
});

test('Ctrl+K opens the command palette, filters it, and Escape closes it', async () => {
  await win.click('#input');
  await win.keyboard.press('Control+k');
  await win.waitForSelector('.palette', { state: 'visible' });
  await win.fill('.palette input', 'lessons');
  await win.waitForFunction(() => /Lessons learned/.test(document.querySelector('.palette .list')?.textContent || ''));
  const items = await win.$$eval('.palette .list .item, .palette .list > div:not(.sec)', (els) => els.length);
  assert.ok(items >= 1, 'the filter leaves the lessons command');
  await win.keyboard.press('Escape');
  await win.waitForSelector('.palette', { state: 'detached', timeout: 5000 });
});

test('the palette opens the Lessons window, which shows an empty list on a fresh install', async () => {
  await win.keyboard.press('Control+k');
  await win.waitForSelector('.palette', { state: 'visible' });
  await win.fill('.palette input', 'lessons');
  await win.waitForFunction(() => /Lessons learned/.test(document.querySelector('.palette .list')?.textContent || ''));
  await win.keyboard.press('Enter');
  await win.waitForSelector('.modal', { state: 'visible' });
  assert.match(await win.textContent('.modal'), /lesson/i);
  await win.click('.modal .modal-foot .btn.primary');
  await win.waitForSelector('.modal', { state: 'detached', timeout: 5000 });
});

test('Ctrl+, opens Settings, each section can be shown, and the Independent QA agent switch saves', async () => {
  await win.keyboard.press('Control+,');
  await win.waitForSelector('.settings-page', { state: 'visible' });
  for (const sec of ['general', 'providers', 'models', 'agent', 'tools', 'safety', 'appearance', 'shortcuts', 'about']) {
    await win.click(`.settings-page [data-nav="${sec}"]`);
    assert.ok(await win.isVisible(`.settings-page [data-sp="${sec}"]`), `${sec} section is shown`);
  }
  assert.match(await win.textContent('.settings-page .ver'), /DROPs/);
  await win.click('.settings-page [data-nav="agent"]');
  assert.ok(await win.$eval('#setQaAgent', (el) => el.classList.contains('on')), 'Independent QA agent is on by default');
  await win.click('#setQaAgent');
  await win.click('#saveSettings');
  await win.waitForSelector('.settings-page', { state: 'detached', timeout: 5000 });
  assert.equal((await win.evaluate(() => window.drops.getSettings())).qaAgent, false, 'saving turns qaAgent off');
  await win. evaluate(() => window.drops.setSettings({ qaAgent: true }));
});

test('a full chat turn with a fake model runs a tool and renders the reply in the window', async () => {
  const http = require('node:http');
  let chatCalls = 0, secondBody = '';
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'fake:latest', details: { parameter_size: '4B' } }] }));
      if (req.url === '/api/show') return res.end(JSON.stringify({ capabilities: ['tools'] }));
      if (req.url === '/api/chat') {
        chatCalls++;
        if (chatCalls === 1) {
          return res.end(JSON.stringify({
            message: { role: 'assistant', tool_calls: [{ function: { name: 'read_file', arguments: { path: 'hello.txt' } } }] },
            done: true, prompt_eval_count: 12, eval_count: 6,
          }) + '\n');
        }
        secondBody = body;
        return res.end(JSON.stringify({
          message: { role: 'assistant', content: 'I read hello.txt: **Hello from the fake project!**' },
          done: true, prompt_eval_count: 24, eval_count: 10,
        }) + '\n');
      }
      res.end('{}');
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const proj = path.join(tmp, 'proj');
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, 'hello.txt'), 'Hello from the fake project!\n');
  try {
    await win.evaluate(async ({ url, projDir }) => {
      await window.drops.setSettings({ ollamaUrl: url, ollamaEnabled: true, defaultModel: 'ollama:fake:latest', recentProjects: [projDir] });
      await setProject(projDir);
      await reloadModels();
      document.querySelector('#modelSel').value = 'ollama:fake:latest';
      syncPills();
    }, { url: `http://127.0.0.1:${srv.address().port}`, projDir: proj });
    await win.fill('#input', 'What is in hello.txt?');
    await win.keyboard.press('Enter');
    await win.waitForFunction(() => /Hello from the fake project!/.test(document.querySelector('#threads')?.textContent || ''), null, { timeout: 15000 });
    await win.waitForFunction(() => !document.querySelector('#composer')?.classList.contains('is-busy'), null, { timeout: 10000 });
    const threadText = await win.textContent('#threads');
    assert.match(threadText, /What is in hello\.txt\?/);
    assert.match(threadText, /hello\.txt/);
    assert.match(threadText, /I read hello\.txt: Hello from the fake project!/);
    assert.equal(chatCalls, 2, 'one tool call round-trip, then the final answer');
    assert.match(secondBody, /Hello from the fake project!/, 'the tool output was sent to the model');
  } finally {
    srv.close();
  }
});

test('while the agent works: Ctrl+Enter queues (Send now, Cancel), Enter tells it now; the sidebar and a live line show it working', async () => {
  const http = require('node:http');
  let calls = 0; const bodies = [];
  const srv = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'fake:latest', details: { parameter_size: '4B' } }] }));
      if (req.url === '/api/show') return res.end(JSON.stringify({ capabilities: ['tools'] }));
      if (req.url !== '/api/chat') return res.end('{}');
      const n = ++calls; bodies.push(body);
      // Three slow tool steps, then an answer: time to type while it works.
      setTimeout(() => res.end(JSON.stringify(n < 4
        ? { message: { role: 'assistant', tool_calls: [{ function: { name: 'list_dir', arguments: { path: '.' } } }] }, done: true, prompt_eval_count: 5, eval_count: 5 }
        : { message: { role: 'assistant', content: `Answer ${n}.` }, done: true, prompt_eval_count: 5, eval_count: 5 }) + '\n'), 1500);
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const proj = path.join(tmp, 'proj-queue');
  fs.mkdirSync(proj, { recursive: true });
  try {
    await win.evaluate(async ({ url, projDir }) => {
      await window.drops.setSettings({ ollamaUrl: url, ollamaEnabled: true, defaultModel: 'ollama:fake:latest', recentProjects: [projDir], autoVerify: false, completionAudit: false });
      await setProject(projDir); await reloadModels(); await newSession();
      document.querySelector('#modelSel').value = 'ollama:fake:latest'; syncPills();
    }, { url: `http://127.0.0.1:${srv.address().port}`, projDir: proj });
    await win.fill('#input', 'Look around the project');
    await win.keyboard.press('Enter');
    await win.waitForFunction(() => document.querySelector('#composer').classList.contains('is-busy'));
    assert.match(await win.getAttribute('#input', 'placeholder'), /Enter to send now, Ctrl\+Enter to queue for later/);
    // The sidebar shows the session working, and a live line says what, how long, how many tokens.
    await win.waitForSelector('#sessionList .row.session.on.busy .dot', { timeout: 10000 });
    await win.waitForFunction(() => /…\s*\d+s/.test(document.querySelector('.working')?.textContent || ''), null, { timeout: 10000 }); // the "·" is drawn by CSS

    // Ctrl+Enter: queued above the composer, with Send now on the bubble; cancel it.
    await win.fill('#input', 'Queued then cancelled');
    await win.keyboard.press('Control+Enter');
    await win.waitForSelector('#queueBar .queue-item', { state: 'visible' });
    assert.match(await win.textContent('#queueBar'), /Queued then cancelled/);
    assert.equal(await win.locator('.msg-user .send-now').count(), 1, 'the queued bubble offers Send now');
    await win.click('#queueBar .q-cancel');
    await win.waitForSelector('#queueBar', { state: 'hidden' });
    await win.waitForFunction(() => !document.querySelector('.msg-user .send-now'), null, { timeout: 5000 });

    // Enter: delivered to the running agent at its next step (like Claude Code).
    await win.fill('#input', 'Steer: also check README');
    await win.keyboard.press('Enter');
    await win.waitForFunction(() => /Delivered to the agent/.test(document.querySelector('#threads')?.textContent || ''), null, { timeout: 15000 });
    await win.waitForFunction(() => !document.querySelector('#composer').classList.contains('is-busy'), null, { timeout: 20000 });
    assert.ok(bodies.some((b) => b.includes('[User steering] Steer: also check README')), 'the model got the steering');
    assert.ok(!bodies.some((b) => b.includes('Queued then cancelled')), 'the cancelled message never reached the model');
    assert.match(await win.textContent('#threads'), /Cancelled — not sent/);
    await win.waitForFunction(() => !document.querySelector('#sessionList .row.session.on.busy'), null, { timeout: 5000 });
    assert.equal(await win.locator('.working').count(), 0, 'the live line goes away when the turn ends');
  } finally { srv.close(); }
});

test('a turn shows a live task list, ends with a next-step box whose button replies, and offers Retry and Fork', async () => {
  const http = require('node:http');
  let calls = 0; const bodies = [];
  const reply = (n) => {
    if (n === 1) return { message: { role: 'assistant', tool_calls: [{ function: { name: 'todo_write', arguments: { todos: [{ content: 'Read the file', status: 'completed' }, { content: 'Explain it', status: 'in_progress' }] } } }] } };
    if (n === 2) return { message: { role: 'assistant', tool_calls: [{ function: { name: 'wrap_up', arguments: { recap: 'Ami file ta porechi. مرحبا بالعالم — the file says hello.', ask: 'Commit korbo?', options: ['Yes, commit', 'Not yet'] } } }] } };
    return { message: { role: 'assistant', content: n === 3 ? 'File ta te **hello** lekha ache.' : `Reply ${n}.` } };
  };
  const srv = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'fake:latest', details: { parameter_size: '4B' } }] }));
      if (req.url === '/api/show') return res.end(JSON.stringify({ capabilities: ['tools'] }));
      if (req.url !== '/api/chat') return res.end('{}');
      const n = ++calls; bodies.push(body);
      setTimeout(() => res.end(JSON.stringify({ ...reply(n), done: true, prompt_eval_count: 5, eval_count: 5 }) + '\n'), 400);
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const proj = path.join(tmp, 'proj-wrap');
  fs.mkdirSync(proj, { recursive: true });
  try {
    await win.evaluate(async ({ url, projDir }) => {
      await window.drops.setSettings({ ollamaUrl: url, ollamaEnabled: true, defaultModel: 'ollama:fake:latest', recentProjects: [projDir], autoVerify: false, completionAudit: false });
      await setProject(projDir); await reloadModels(); await newSession();
      document.querySelector('#modelSel').value = 'ollama:fake:latest'; syncPills();
    }, { url: `http://127.0.0.1:${srv.address().port}`, projDir: proj });
    await win.fill('#input', 'file ta ki bole?');
    await win.keyboard.press('Enter');
    await win.waitForSelector('.task-card-inline', { state: 'visible', timeout: 15000 });
    assert.match(await win.textContent('.task-card-inline'), /Read the file.*Explain it/s);
    assert.equal(await win.getAttribute('.task-card-inline', 'aria-label'), 'Tasks: 1 of 2 done');
    assert.equal(await win.locator('.task-card-inline .tci-row.completed .tm-done').count(), 1, 'done: a filled circle with a tick');
    assert.equal(await win.locator('.task-card-inline .tci-row.in_progress .tm-spin').count(), 1, 'now: a spinning ring');
    await win.waitForSelector('.wrapup', { state: 'visible', timeout: 15000 });
    const box = await win.textContent('.wrapup');
    assert.match(box, /Ami file ta porechi/);
    assert.match(box, /Commit korbo\?/);
    assert.equal(await win.locator('.wrapup .wu-actions button').count(), 2);
    assert.equal(await win.locator('.tool[data-name="wrap_up"]').count(), 0, 'no tool card for the box');
    // The recap paragraph with Arabic text gets its own direction; nothing overflows.
    assert.equal(await win.evaluate(() => getComputedStyle(document.querySelector('.wu-recap')).unicodeBidi), 'plaintext');
    await win.screenshot({ path: path.join(tmp, 'wrapup.png') });

    // A button sends its label as the user's reply.
    await win.click('.wrapup .wu-actions button:first-child');
    await win.waitForFunction(() => !document.querySelector('#composer').classList.contains('is-busy') && /Reply 4\./.test(document.querySelector('#threads').textContent), null, { timeout: 15000 });
    assert.ok(bodies[3].includes('Yes, commit'), 'the click was sent to the model');

    // Retry undoes the last answer and asks again; Fork opens a new session with the conversation.
    const before = calls;
    await win.locator('.turn-footer').last().getByRole('button', { name: 'Retry' }).click();
    await win.waitForFunction((n) => !document.querySelector('#composer').classList.contains('is-busy') && /Reply 5\./.test(document.querySelector('#threads').textContent), before, { timeout: 15000 });
    assert.ok(!/Reply 4\./.test(await win.textContent('#threads')), 'the retried answer is gone');
    const sessionsBefore = (await win.evaluate(() => window.drops.listSessions())).length;
    await win.locator('.turn-footer').last().getByRole('button', { name: 'Fork' }).click();
    await win.waitForFunction((n) => document.querySelector('#sessionTitle')?.textContent.startsWith('Fork:'), sessionsBefore, { timeout: 10000 });
    assert.equal((await win.evaluate(() => window.drops.listSessions())).length, sessionsBefore + 1);
    assert.match(await win.textContent('#threads'), /file ta ki bole\?/, 'the fork has the conversation');
  } finally { srv.close(); }
});

test('typing / lists the GitHub commands /pr and /ci', async () => {
  await win.fill('#input', '/');
  await win.waitForSelector('#popup:not([hidden])', { timeout: 5000 });
  const text = await win.textContent('#popup');
  assert.match(text, /\/pr.*Open a pull request/s);
  assert.match(text, /\/ci.*failing CI checks/s);
  await win.keyboard.press('Escape');
  await win.fill('#input', '');
});

test('chapters with a table of contents, the live browser pane, and split view', async () => {
  const http = require('node:http');
  const site = http.createServer((q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end('<title>Shop</title><h1>Coupon page</h1>'); });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  let n = 0;
  const step = (k) => [
    { message: { role: 'assistant', tool_calls: [{ function: { name: 'mark_chapter', arguments: { title: 'Investigate' } } }] } },
    { message: { role: 'assistant', tool_calls: [{ function: { name: 'browser', arguments: { action: 'open', url: `http://127.0.0.1:${site.address().port}/` } } }] } },
    { message: { role: 'assistant', tool_calls: [{ function: { name: 'mark_chapter', arguments: { title: 'Verify' } } }] } },
    { message: { role: 'assistant', content: 'Checked the coupon page.' } },
  ][k - 1] || { message: { role: 'assistant', content: 'done' } };
  const srv = http.createServer((req, res) => {
    req.on('data', () => {}); req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'fake:latest', details: { parameter_size: '4B' } }] }));
      if (req.url === '/api/show') return res.end(JSON.stringify({ capabilities: ['tools'] }));
      if (req.url !== '/api/chat') return res.end('{}');
      res.end(JSON.stringify({ ...step(++n), done: true, prompt_eval_count: 5, eval_count: 5 }) + '\n');
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const proj = path.join(tmp, 'proj-chapters');
  fs.mkdirSync(proj, { recursive: true });
  try {
    await win.evaluate(async ({ url, projDir }) => {
      await window.drops.setSettings({ ollamaUrl: url, ollamaEnabled: true, defaultModel: 'ollama:fake:latest', recentProjects: [projDir], autoVerify: false, completionAudit: false, uiCheck: false });
      await setProject(projDir); await reloadModels(); await newSession();
      document.querySelector('#modelSel').value = 'ollama:fake:latest'; syncPills(); setMode('yolo');
    }, { url: `http://127.0.0.1:${srv.address().port}`, projDir: proj });
    await win.fill('#input', 'check the coupon page');
    await win.keyboard.press('Enter');
    await win.waitForFunction(() => /Checked the coupon page/.test(document.querySelector('#threads').textContent) && !document.querySelector('#composer').classList.contains('is-busy'), null, { timeout: 30000 });

    // Chapters: two dividers, no tool cards for them, and a table of contents that jumps.
    const current = win.locator('#threads > :not([hidden])').first();
    assert.deepEqual(await current.locator('.chapter-div .ch-title').allTextContents(), ['Investigate', 'Verify']);
    assert.equal(await win.locator('.tool[data-name="mark_chapter"]').count(), 0);
    await win.waitForSelector('#toc:not([hidden]) .toc-btn');
    assert.match(await win.textContent('#toc .toc-btn'), /2 chapters/);
    await win.click('#toc .toc-btn');
    assert.deepEqual(await win.locator('#toc .toc-item .toc-t').allTextContents(), ['Investigate', 'Verify']);
    await win.click('#toc .toc-item >> nth=1');

    // Live browser pane: the page the agent saw, with its address and step.
    await win.click('#inspTabs button[data-tab="browser"]');
    await win.waitForSelector('#browserBody img.bp-shot', { timeout: 10000 });
    assert.match(await win.textContent('#browserBody .bp-url'), /127\.0\.0\.1:\d+\//);
    assert.ok((await win.getAttribute('#browserBody img.bp-shot', 'src')).startsWith('data:image/jpeg;base64,'));

    // Split view: Ctrl+\ shows another session beside this one; clicking it switches; Ctrl+\ closes.
    const firstId = await win.evaluate(() => S.current);
    await win.evaluate(async () => { await newSession(); });
    await win.keyboard.press('Control+\\');
    await win.waitForSelector('.split-item');
    await win.click('.split-item >> nth=0');
    await win.waitForSelector('#threads.split > .split-side');
    assert.equal(await win.locator('#threads.split > :not([hidden])').count(), 2, 'two sessions side by side');
    await win.click('#threads.split > .split-side');
    assert.equal(await win.evaluate(() => S.current), firstId, 'clicking the side session makes it the one you work in');
    assert.ok(await win.evaluate(() => !!S.split && S.split !== S.current), 'the other session moves to the side');
    await win.keyboard.press('Control+\\');
    await win.waitForFunction(() => !document.querySelector('#threads.split'));
    await win.click('#inspTabs button[data-tab="plan"]');
  } finally { srv.close(); site.close(); }
});

test('skills show up as / commands, a scheduled task can be made, paused and deleted, and a session can be pinned', async () => {
  const proj = path.join(tmp, 'proj-skills');
  fs.mkdirSync(path.join(proj, '.drops', 'skills', 'release-notes'), { recursive: true });
  fs.writeFileSync(path.join(proj, '.drops', 'skills', 'release-notes', 'SKILL.md'), '---\nname: release-notes\ndescription: Release notes in our style\n---\nAdded, Fixed, Changed.');
  await win.evaluate(async (projDir) => { await window.drops.setSettings({ recentProjects: [projDir] }); await setProject(projDir); await newSession(); }, proj);
  await win.fill('#input', '/rel');
  await win.waitForSelector('#popup .opt');
  assert.match(await win.textContent('#popup'), /release-notes[\s\S]*Skill: Release notes in our style/);
  await win.fill('#input', '');
  await win.keyboard.press('Escape');

  await win.evaluate(() => { const b = document.querySelector('#body'); if (b.classList.contains('no-insp') || (window.innerWidth <= 1280 && !b.classList.contains('force-insp'))) toggleInspector(); Panels.switchTab('tasks'); });
  await win.waitForSelector('.sched-head button');
  await win.click('.sched-head button');
  await win.fill('#schName', 'Morning tests');
  await win.fill('#schPrompt', 'Run the tests and tell me what failed');
  await win.selectOption('#schRepeat', 'weekdays');
  await win.click('.sched-modal .btn.primary');
  await win.waitForSelector('.task-row.sched');
  assert.match(await win.textContent('.task-row.sched'), /Morning tests[\s\S]*weekdays at 09:00/);
  await win.click('.task-row.sched [data-a="toggle"]');
  await win.waitForSelector('.task-row.sched.off');
  const list = await win.evaluate(() => window.drops.scheduleList());
  assert.equal(list.length, 1); assert.equal(list[0].enabled, false); assert.equal(path.resolve(list[0].projectDir).toLowerCase(), path.resolve(proj).toLowerCase());
  await win.evaluate(async (id) => { await window.drops.scheduleDelete(id); await Panels.renderTasks(); }, list[0].id);
  await win.waitForSelector('.sched-empty');

  await win.evaluate(async () => { await newSession(); await Panels.renderSessions(); });
  const target = await win.evaluate(() => document.querySelectorAll('.row.session')[1]?.dataset.id);
  await win.evaluate((id) => document.querySelector(`.row.session[data-id="${id}"] .pin-btn`).click(), target);
  await win.waitForFunction((id) => { const first = document.querySelector('.row.session'); return first?.dataset.id === id && first.classList.contains('pinned'); }, target);
});

test('Ctrl+Shift+L switches between light and dark themes', async () => {
  const theme = () => win.evaluate(() => document.documentElement.dataset.theme || document.body.dataset.theme || document.documentElement.className);
  const first = await theme();
  await win.keyboard.press('Control+Shift+L');
  await win.waitForFunction((t) => (document.documentElement.dataset.theme || document.body.dataset.theme || document.documentElement.className) !== t, first);
  await win.keyboard.press('Control+Shift+L');
  assert.equal(await theme(), first);
});

test('the user data stays in the test folder, and the page logged no errors', async () => {
  assert.ok(!fs.existsSync(path.join(os.homedir(), '.drops', 'ui-test-marker')));
  const dataDir = await app.evaluate(({ app: a }) => a.getPath('userData'));
  assert.ok(dataDir.startsWith(tmp), `userData is inside the test folder (${dataDir})`);
  assert.deepEqual(errors.filter((e) => !/Autofill|DevTools|favicon/i.test(e)), []);
});
