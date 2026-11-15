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
  const env = { ...process.env, APPDATA: appdata, LOCALAPPDATA: path.join(tmp, 'local'), USERPROFILE: home, HOME: home };
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
