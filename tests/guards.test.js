// Run: npm test
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { isVerificationCommand, failureKey, LoopGuard } = require('../src/main/guards');

test('real verification commands count', () => {
  for (const c of ['npm test', 'npm run build', 'pnpm run typecheck', 'npx tsc --noEmit', 'python -m pytest -q', 'cargo test', 'dotnet build', 'go test ./...', 'node --test', 'yarn lint']) {
    assert.ok(isVerificationCommand(c), c);
  }
});

test('unrelated commands do not count as verification', () => {
  for (const c of ['Get-ChildItem', 'ls', 'echo done', 'git status', 'Write-Output "tests pass"', 'cat package.json', 'npm install']) {
    assert.ok(!isVerificationCommand(c), c);
  }
});

test('project verify commands and running an edited file count', () => {
  assert.ok(isVerificationCommand('make smoke', ['make smoke']));
  assert.ok(isVerificationCommand('node src/app.js --dry-run', [], ['src/app.js']));
  assert.ok(isVerificationCommand('python scripts\\tool.py', [], ['scripts/tool.py']));
  assert.ok(!isVerificationCommand('node other.js', [], ['src/app.js']));
});

test('failure keys group variations of the same attempt', () => {
  assert.strictEqual(failureKey('edit_file', { path: 'src/a.js', old_string: 'x' }), failureKey('multi_edit', { path: 'src\\a.js', edits: [] }));
  assert.strictEqual(failureKey('powershell', { command: 'npm test -- --grep "cart"' }), failureKey('powershell', { command: 'npm test -- --grep total' }));
  assert.notStrictEqual(failureKey('powershell', { command: 'npm test' }), failureKey('powershell', { command: 'npm run build' }));
});

test('loop guard blocks identical repeats', () => {
  const g = new LoopGuard(3);
  const inp = { path: 'a.js' };
  assert.strictEqual(g.check('read_file', inp), null); g.record('read_file', inp, true);
  assert.strictEqual(g.check('read_file', inp), null); g.record('read_file', inp, true);
  assert.match(g.check('read_file', inp), /exact call 3 times/);
});

test('loop guard blocks repeated failures with varied arguments', () => {
  const g = new LoopGuard(3);
  for (const old of ['a', 'b', 'c']) {
    const inp = { path: 'src/cart.js', old_string: old, new_string: 'z' };
    assert.strictEqual(g.check('edit_file', inp), null);
    g.record('edit_file', inp, false);
  }
  assert.match(g.check('edit_file', { path: 'src/cart.js', old_string: 'd', new_string: 'z' }), /Re-read the file/);
  // re-reading the file is progress and unblocks editing
  g.record('read_file', { path: 'src/cart.js' }, true);
  assert.strictEqual(g.check('edit_file', { path: 'src/cart.js', old_string: 'e', new_string: 'z' }), null);
});

test('a code change resets command failure streaks', () => {
  const g = new LoopGuard(3);
  for (const v of ['1', '2', '3']) { const inp = { command: `npm test -- --seed ${v}` }; assert.strictEqual(g.check('powershell', inp), null); g.record('powershell', inp, false); }
  assert.match(g.check('powershell', { command: 'npm test -- --seed 4' }), /without any code change/);
  g.record('edit_file', { path: 'src/cart.js' }, true);
  assert.strictEqual(g.check('powershell', { command: 'npm test -- --seed 5' }), null);
});

// ---- agent loop with a scripted fake model: the guards must not be bypassable ----
function scriptedAgent(script) {
  const providers = require('../src/main/providers');
  const { AgentSession } = require('../src/main/agent');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'h2o-guard-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'node --test' } }));
  fs.writeFileSync(path.join(dir, 'a.js'), 'module.exports = 1;\n');
  const seen = [];
  let i = 0;
  providers.callModel = async ({ messages }) => {
    seen.push(JSON.stringify(messages[messages.length - 1]));
    const step = script[i++] || { text: 'done' };
    const content = step.tool ? [{ type: 'tool_use', id: 't' + i, name: step.tool, input: step.input }] : [{ type: 'text', text: step.text }];
    return { content, model: 'fake', stop_reason: step.tool ? 'tool_use' : 'end_turn', usage: {} };
  };
  const notices = [];
  const data = { id: 's', title: 'New session', projectDir: dir, messages: [], archive: [], compactions: [], turns: [], toolMeta: {}, todos: [], changes: {}, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, context: 0, requests: 0 } };
  const agent = new AgentSession(data, {
    send: (_id, type, p) => { if (type === 'notice') notices.push(p.message); },
    save: () => {}, getSettings: () => ({ autoVerify: true }), getApiKey: () => 'x', getGeminiKey: () => 'x',
  });
  return { agent, data, notices, seen, dir, calls: () => i };
}

test('agent: an unrelated command does not satisfy the verification guard', async () => {
  const t = scriptedAgent([
    { tool: 'read_file', input: { path: 'a.js' } },
    { tool: 'edit_file', input: { path: 'a.js', old_string: '1', new_string: '2' } },
    { tool: 'powershell', input: { command: 'Get-ChildItem' } },
    { text: 'All done!' }, // guard should push back here
    { tool: 'powershell', input: { command: 'npm test' } },
    { text: 'Verified.' },
  ]);
  await t.agent.send('change it', { model: 'claude-opus-5-5', effort: 'low', mode: 'yolo' });
  const guardMsgs = t.data.messages.filter((m) => m.role === 'user' && JSON.stringify(m.content).includes('verification guard'));
  assert.strictEqual(guardMsgs.length, 1, 'exactly one nudge');
  assert.match(JSON.stringify(guardMsgs[0].content), /not run a real verification/);
  assert.strictEqual(t.calls(), 6, 'agent continued after the nudge and ran the real test');
  t.agent.dispose();
});

test('agent: a failing verification must be fixed before finishing', async () => {
  const t = scriptedAgent([
    { tool: 'read_file', input: { path: 'a.js' } },
    { tool: 'edit_file', input: { path: 'a.js', old_string: '1', new_string: '2' } },
    { tool: 'powershell', input: { command: 'node --test; exit 1' } },
    { text: 'Done.' }, // last check failed -> nudge
    { text: 'It is pre-existing: also fails on the original code.' },
  ]);
  await t.agent.send('change it', { model: 'claude-opus-5-5', effort: 'low', mode: 'yolo' });
  const all = JSON.stringify(t.data.messages);
  assert.match(all, /last verification command FAILED/);
  assert.strictEqual(t.calls(), 5);
  t.agent.dispose();
});

test('agent: loop guard stops repeated failing edits with varied arguments', async () => {
  const t = scriptedAgent([
    { tool: 'edit_file', input: { path: 'a.js', old_string: 'nope1', new_string: 'x' } },
    { tool: 'edit_file', input: { path: 'a.js', old_string: 'nope2', new_string: 'x' } },
    { tool: 'edit_file', input: { path: 'a.js', old_string: 'nope3', new_string: 'x' } },
    { tool: 'edit_file', input: { path: 'a.js', old_string: 'nope4', new_string: 'x' } },
    { text: 'I give up.' },
  ]);
  await t.agent.send('edit', { model: 'claude-opus-5-5', effort: 'low', mode: 'yolo' });
  const results = t.data.messages.filter((m) => m.role === 'user').flatMap((m) => m.content).filter((b) => b.type === 'tool_result');
  assert.strictEqual(results.length, 4);
  assert.match(results[3].content, /Loop guard: editing a\.js failed 3 times/);
  t.agent.dispose();
});

test('loop guard catches ping-pong edit/test repeats and >=5 shell failures across edits', () => {
  const g = new LoopGuard(3);
  const edit = { path: 'a.js', old_string: '1', new_string: '2' };
  const cmd = { command: 'npm test' };
  assert.strictEqual(g.check('edit_file', edit), null); g.record('edit_file', edit, true);
  assert.strictEqual(g.check('shell', cmd), null); g.record('shell', cmd, false);
  // Trying the exact same edit again after a shell failure is blocked as a ping-pong loop
  assert.match(g.check('edit_file', edit), /already tried this exact edit/);

  // 5 total failures of the same shell command family across different edits are blocked
  const g2 = new LoopGuard(3);
  for (let i = 1; i <= 5; i++) {
    const e = { path: 'a.js', old_string: String(i), new_string: String(i + 1) };
    assert.strictEqual(g2.check('edit_file', e), null); g2.record('edit_file', e, true);
    assert.strictEqual(g2.check('shell', { command: `npm test -- --run=${i}` }), null);
    g2.record('shell', { command: `npm test -- --run=${i}` }, false);
  }
  assert.match(g2.check('shell', { command: 'npm test -- --run=6' }), /failed 5 times across multiple attempts/);
});

test('agent: verification guard blocks finishing when instant diagnostics leave syntax errors', async () => {
  const t = scriptedAgent([
    { tool: 'read_file', input: { path: 'a.js' } },
    { tool: 'edit_file', input: { path: 'a.js', old_string: 'module.exports = 1;', new_string: 'module.exports = {' } },
    { tool: 'powershell', input: { command: 'npm test' } },
    { text: 'Done!' }, // should be blocked because a.js has SYNTAX ERROR
    { tool: 'edit_file', input: { path: 'a.js', old_string: 'module.exports = {', new_string: 'module.exports = 2;' } },
    { tool: 'powershell', input: { command: 'npm test' } },
    { text: 'Fixed and verified.' },
  ]);
  await t.agent.send('update a.js', { model: 'claude-opus-5-5', effort: 'low', mode: 'yolo' });
  const all = JSON.stringify(t.data.messages);
  assert.match(all, /syntax or type errors in a\.js/);
  assert.strictEqual(t.calls(), 7);
  t.agent.dispose();
});

test('agent: verification guard nudges when todo_write items remain unfinished', async () => {
  const t = scriptedAgent([
    { tool: 'todo_write', input: { todos: [{ content: 'Step 1', status: 'completed' }, { content: 'Step 2', status: 'in_progress' }] } },
    { text: 'All done.' }, // should nudge for unfinished Step 2
    { tool: 'todo_write', input: { todos: [{ content: 'Step 1', status: 'completed' }, { content: 'Step 2', status: 'completed' }] } },
    { text: 'All steps finished.' },
  ]);
  await t.agent.send('do plan', { model: 'claude-opus-5-5', effort: 'low', mode: 'yolo' });
  const all = JSON.stringify(t.data.messages);
  assert.match(all, /still has unfinished items \(Step 2\)/);
  assert.strictEqual(t.calls(), 4);
  t.agent.dispose();
});

test('admitsUnfinished catches an agent admitting work is left, not finished reports', () => {
  const { admitsUnfinished } = require('../src/main/agent');
  // The real CRM benchmark reply that stopped after building only contacts.
  assert.ok(admitsUnfinished('The base infrastructure is ready for the remaining features (deals, pipeline, tasks, team).'));
  assert.ok(admitsUnfinished('Tasks and the team page still need to be implemented.'));
  assert.ok(admitsUnfinished('Reports will be added later.'));
  assert.ok(admitsUnfinished('I am now ready to proceed with implementing the specific application pages and business logic as defined in the SPEC.md.'));
  assert.ok(admitsUnfinished("Next, I'll implement the pipeline page."));
  assert.ok(admitsUnfinished('The build continues to pass. I am proceeding to implement the pipeline, tasks, and team management as planned.'));
  assert.ok(admitsUnfinished('Further feature implementation (contacts, pipeline, tasks) will follow the same pattern.'));
  assert.ok(admitsUnfinished('Further specific functional logic (forms, data fetching, etc.) can now be layered onto these existing routes.'));
  for (const ok of ['All features are implemented and the build passes.', 'The remaining features are done and verified.',
    'Fixed the bug in cart.js; npm test passes.', 'No remaining work.', 'Ready to use: run npm start and open the app.']) assert.strictEqual(admitsUnfinished(ok), null, ok);
});

test('agent: completion guard sends the agent back when it says features remain', async () => {
  const t = scriptedAgent([
    { tool: 'edit_file', input: { path: 'a.js', old_string: '1', new_string: '2' } },
    { tool: 'powershell', input: { command: 'npm test' } },
    { text: 'Contacts done. The app is ready for the remaining features (deals, tasks).' },
    { tool: 'edit_file', input: { path: 'a.js', old_string: '2', new_string: '3' } },
    { tool: 'powershell', input: { command: 'npm test' } },
    { text: 'Deals and tasks are implemented; npm test passes.' },
  ]);
  await t.agent.send('build the app', { model: 'claude-opus-5-5', effort: 'low', mode: 'yolo' });
  assert.match(JSON.stringify(t.data.messages), /completion guard/);
  assert.ok(t.notices.some((n) => /Completion guard/.test(n)));
  assert.strictEqual(t.calls(), 6, 'agent continued and finished the rest');
  t.agent.dispose();
});

test('agent: UI check sends the agent to open changed pages in the browser before finishing', { timeout: 120_000 }, async (tt) => {
  if (!require('../src/main/browser').available()) return tt.skip('no playwright-core');
  const http = require('node:http');
  const srv = http.createServer((_q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end('<title>Shop</title><h1>Shop</h1>'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}/`;
  const t = scriptedAgent([
    { tool: 'write_file', input: { path: 'index.html', content: '<h1>Shop</h1>\n' } },
    { tool: 'powershell', input: { command: 'npm test' } },
    { text: 'The page is done and tests pass.' }, // a web app page changed but was never opened: UI check
    { tool: 'browser', input: { action: 'open', url } },
    { text: 'Opened the page in the browser; it shows the shop heading with no errors.' },
  ]);
  fs.writeFileSync(path.join(t.dir, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'node --test' }, dependencies: { vite: '7.0.0' } }));
  try {
    await t.agent.send('make the shop page', { model: 'claude-opus-5-5', effort: 'low', mode: 'yolo' });
    const all = JSON.stringify(t.data.messages);
    assert.match(all, /DROPs UI check/);
    assert.match(all, /index\.html/);
    assert.ok(t.notices.some((n) => /UI check/.test(n)));
    assert.strictEqual(t.calls(), 5, 'checked in the browser, then finished without a second nudge');
  } finally {
    t.agent.dispose(); srv.close(); await require('../src/main/browser').closeAll();
  }
});

test('agent: UI check refuses a "verified" claim while the browser shows a dead login button', { timeout: 120_000 }, async (tt) => {
  if (!require('../src/main/browser').available()) return tt.skip('no playwright-core');
  const http = require('node:http');
  let fixed = false;
  const srv = http.createServer((req, r) => {
    r.writeHead(200, { 'content-type': 'text/html' });
    if (req.url === '/home') return r.end('<title>Home</title><h1>Welcome</h1>');
    // Broken until "fixed": the button does nothing. After the fix it goes to /home.
    r.end(`<title>Login</title><button onclick="${fixed ? "location.href='/home'" : ''}">Sign in</button>`);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}/login`;
  const t = scriptedAgent([
    { tool: 'browser', input: { action: 'open', url } },
    { tool: 'browser', input: { action: 'click', target: 'Sign in' } },
    { tool: 'browser', input: { action: 'open', url } }, // re-opening proves nothing
    { text: 'Everything is verified in the browser.' }, // must be refused
    { tool: 'browser', input: { action: 'open', url } }, // (the fix happens here)
    { tool: 'browser', input: { action: 'click', target: 'Sign in' } },
    { text: 'Fixed: Sign in now opens the home page.' },
  ]);
  fs.writeFileSync(path.join(t.dir, 'package.json'), JSON.stringify({ name: 'x', dependencies: { next: '15.0.0' } }));
  const origCall = require('../src/main/providers').callModel;
  require('../src/main/providers').callModel = async (a) => { if (JSON.stringify(a.messages).includes('DROPs UI check')) fixed = true; return origCall(a); };
  try {
    await t.agent.send('check the login', { model: 'claude-opus-5-5', effort: 'low', mode: 'yolo' });
    const all = JSON.stringify(t.data.messages);
    assert.match(all, /browser showed a problem that is not fixed: clicking \\"Sign in\\" changed nothing on \/login/);
    assert.strictEqual(t.calls(), 7, 'sent back once, then finished after the click worked');
  } finally {
    t.agent.dispose(); srv.close(); await require('../src/main/browser').closeAll();
  }
});

test('evidence: a spec task is not done until DROPs itself verified every requirement', async () => {
  const t = scriptedAgent([
    { tool: 'write_file', input: { path: 'b.js', content: 'module.exports = 2;\n' } },
    { tool: 'check_requirement', input: { id: 'FR-1', kind: 'command', command: 'echo it works' } }, // proves nothing: refused
    { tool: 'check_requirement', input: { id: 'FR-1', kind: 'command', command: 'npm test' } },
    { text: 'Everything is done.' }, // FR-2..FR-4 have no evidence: sent back
    { tool: 'check_requirement', input: { id: 'FR-2', kind: 'command', command: 'node -e "process.exit(1)"', expect: 'never' } }, // a failing check
    { tool: 'check_requirement', input: { id: 'FR-2', kind: 'command', command: 'npm test' } },
    { tool: 'check_requirement', input: { id: 'FR-3', kind: 'command', command: 'node -e "console.log(require(\'./b.js\'))"', expect: '2' } },
    { tool: 'check_requirement', input: { id: 'FR-4', kind: 'command', command: 'npm test' } },
    { text: 'All four requirements are verified.' },
  ]);
  fs.writeFileSync(path.join(t.dir, 'SPEC.md'), '| ID | Requirement |\n|---|---|\n| FR-1 | One |\n| FR-2 | Two |\n| FR-3 | Three |\n| FR-4 | Four |\n');
  await t.agent.send('Build the app in SPEC.md', { model: 'claude-opus-5-5', effort: 'low', mode: 'auto-edit' });
  const all = JSON.stringify(t.data.messages);
  assert.match(all, /does not exercise the requirement/, 'echo is not evidence');
  assert.match(all, /DROPs evidence check\] 3 of 4 requirements have no passing evidence: FR-2, FR-3, FR-4/);
  assert.match(all, /FR-2 NOT verified/);
  assert.deepEqual(t.data.requirements.map((r) => r.status), ['verified', 'verified', 'verified', 'verified']);
  assert.equal(t.data.requirements[2].evidence.kind, 'command');
  assert.strictEqual(t.calls(), 9, 'finished once every requirement had evidence');
  t.agent.dispose();
});

test('evidence: an HTTP check passes only on a 2xx response that contains the expected text', async () => {
  const http = require('node:http');
  const srv = http.createServer((_q, r) => { r.writeHead(200, { 'content-type': 'application/json' }); r.end('{"orders":3,"status":"Orders loaded"}'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}/api/orders`;
  const t = scriptedAgent([
    { tool: 'check_requirement', input: { id: 'FR-1', kind: 'http', url, expect: 'Orders loaded' } },
    { tool: 'check_requirement', input: { id: 'FR-2', kind: 'http', url, expect: 'Invoice sent' } },
    { tool: 'check_requirement', input: { id: 'FR-3', kind: 'http', url: 'https://example.com/', expect: 'x' } },
    { text: 'Checked.' },
  ]);
  fs.writeFileSync(path.join(t.dir, 'SPEC.md'), '| FR-1 | a |\n| FR-2 | b |\n| FR-3 | c |\n| FR-4 | d |\n');
  try {
    await t.agent.send('Check the app in SPEC.md', { model: 'claude-opus-5-5', effort: 'low', mode: 'auto-edit' });
    assert.deepEqual(t.data.requirements.map((r) => r.status), ['verified', 'failed', 'unverified', 'unverified']);
    assert.match(JSON.stringify(t.data.messages), /needs a local URL of the running app/, 'only the local app can be checked');
  } finally { t.agent.dispose(); srv.close(); }
});

test('QA agent: independent checks from the spec alone are the only ones that can verify a requirement', async () => {
  const http = require('node:http');
  const srv = http.createServer((q, r) => { r.writeHead(200, { 'content-type': 'text/plain' }); r.end(q.url === '/api/deals' ? 'deal list: Annual licence' : 'home'); });
  await new Promise((r) => srv.listen(0, r)); // all addresses: "localhost" may resolve to ::1
  const port = srv.address().port;
  const providers = require('../src/main/providers');
  const { AgentSession } = require('../src/main/agent');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drops-qa-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'node -e "0"' } }));
  fs.writeFileSync(path.join(dir, 'SPEC.md'), '| FR-1 | Deals list |\n| FR-2 | b |\n| FR-3 | c |\n| FR-4 | d |\n');
  const script = [
    { tool: 'write_file', input: { path: 'deals.js', content: 'module.exports = [];\n' } },
    { tool: 'check_requirement', input: { id: 'FR-1', kind: 'command', command: 'npm test' } }, // passes, but FR-1 has a QA check
    { tool: 'check_requirement', input: { id: 'FR-1', use_qa: true } },
    { text: 'Done.' },
  ];
  let i = 0, qaCalls = 0;
  const qaJson = JSON.stringify([
    { id: 'FR-1', kind: 'http', url: `http://localhost:${port}/api/deals`, expect: 'Annual licence' },
    { id: 'FR-2', kind: 'browser', steps: [], expect: 'x' }, // invalid: no steps, dropped
  ]);
  providers.callModel = async ({ tools, system }) => {
    if (!tools.length && /adversarial QA engineer/.test(system)) return { content: [{ type: 'text', text: '[]' }], usage: {} };
    if (!tools.length && /independent QA engineer/.test(system)) { qaCalls++; return { content: [{ type: 'text', text: 'Here you go:\n' + qaJson }], usage: {} }; }
    const st = script[i++] || { text: 'done' };
    return { content: st.tool ? [{ type: 'tool_use', id: 't' + i, name: st.tool, input: st.input }] : [{ type: 'text', text: st.text }], model: 'fake', stop_reason: st.tool ? 'tool_use' : 'end_turn', usage: {} };
  };
  const data = { id: 's', title: 'New session', projectDir: dir, messages: [], archive: [], compactions: [], turns: [], toolMeta: {}, todos: [], changes: {}, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, context: 0, requests: 0 } };
  const agent = new AgentSession(data, { send: () => {}, save: () => {}, getSettings: () => ({ autoVerify: true, qaAgent: true, completionAudit: false, evidenceCheck: true }), getApiKey: () => 'x', getGeminiKey: () => 'x' });
  try {
    await agent.send('Build the app in SPEC.md', { model: 'claude-opus-5-5', effort: 'low', mode: 'auto-edit' });
    assert.equal(qaCalls, 1, 'the QA agent wrote the checks once');
    assert.equal(data.requirements[0].qa.kind, 'http');
    assert.equal(data.requirements[1].qa, undefined, 'a malformed QA check is dropped');
    const all = JSON.stringify(data.messages);
    assert.match(all, /has an independent QA check: run check_requirement with use_qa: true/, "the developer's own check cannot verify it");
    assert.match(all, /FR-1 VERIFIED \(QA http\)/);
    assert.equal(data.requirements[0].status, 'verified');
    assert.equal(data.requirements[0].evidence.byQa, true);
  } finally { agent.dispose(); srv.close(); }
});

test('specPlanNote: a task on a requirements document gets the full checklist; other tasks do not', () => {
  const { specPlanNote } = require('../src/main/agent');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'h2o-spec-'));
  const rows = Array.from({ length: 6 }, (_, i) => `| FR-${i + 1} | Requirement number ${i + 1} |`).join('\n');
  fs.writeFileSync(path.join(dir, 'SPEC.md'), `# App\n| ID | Requirement |\n|---|---|\n${rows}\n| NFR-1 | Fast |\n\n## Journeys\n- **J1** Log in and add a contact.\n- **J2** Move a deal.\n`);
  fs.writeFileSync(path.join(dir, 'NOTES.md'), '| FR-1 | only one |');
  const note = specPlanNote(dir, 'Build the app described in SPEC.md');
  assert.match(note, /SPEC\.md lists 6 functional requirements and 2 key journeys/);
  for (const id of ['FR-1', 'FR-6', 'NFR-1', 'J1', 'J2']) assert.match(note, new RegExp(`- ${id}: `));
  assert.match(note, /todo_write plan that covers every requirement/);
  assert.strictEqual(specPlanNote(dir, 'Fix the typo in NOTES.md'), null, 'too few requirements to need a plan');
  assert.strictEqual(specPlanNote(dir, 'Rename the variable x'), null);
  assert.strictEqual(specPlanNote(dir, 'Read MISSING.md'), null);
});

test('isUiFile: pages, components and styles count; tests, config and build output do not', () => {
  const { isUiFile } = require('../src/main/guards');
  for (const f of ['app/page.tsx', 'src/components/Cart.jsx', 'src/App.vue', 'app/globals.css', 'index.html']) assert.ok(isUiFile(f), f);
  for (const f of ['lib/db.ts', 'app/page.test.tsx', 'next.config.mjs', '.next/server/app/page.html', 'node_modules/x/a.css']) assert.ok(!isUiFile(f), f);
});

test('agent: completion audit sends the agent back when a reviewer finds the task unfinished', async () => {
  const providers = require('../src/main/providers');
  const { AgentSession } = require('../src/main/agent');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'h2o-audit-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'node -e 0' } }));
  fs.writeFileSync(path.join(dir, 'SPEC.md'), '# Spec\n- Contacts page\n- Pipeline page\n');
  fs.writeFileSync(path.join(dir, 'a.js'), 'module.exports = 1;\n');
  const edits = (n) => Array.from({ length: n }, (_, k) => ({ tool: 'write_file', input: { path: `p${n}_${k}.js`, content: '1;\n' } }));
  const script = [...edits(5), { tool: 'shell', input: { command: 'npm test' } }, { text: 'Contacts page built and tested.' },
    // the reviewer call (tool-less) comes next
    { review: '{"done": false, "remaining": ["Pipeline page from SPEC.md is missing"]}' },
    { tool: 'write_file', input: { path: 'pipeline.js', content: '1;\n' } }, { tool: 'shell', input: { command: 'npm test' } },
    { text: 'Contacts and pipeline pages built; npm test passes.' },
    { review: '{"done": true, "remaining": []}' }];
  let i = 0; const prompts = [];
  providers.callModel = async ({ messages, tools: defs }) => {
    const step = script[i++] || { text: 'done' };
    if (!defs || !defs.length) { prompts.push(JSON.stringify(messages)); return { content: [{ type: 'text', text: step.review || '{"done":true,"remaining":[]}' }], model: 'fake', stop_reason: 'end_turn', usage: {} }; }
    const content = step.tool ? [{ type: 'tool_use', id: 't' + i, name: step.tool, input: step.input }] : [{ type: 'text', text: step.text }];
    return { content, model: 'fake', stop_reason: step.tool ? 'tool_use' : 'end_turn', usage: {} };
  };
  const notices = [];
  const a = new AgentSession({ id: 's', title: 'x', projectDir: dir, messages: [], archive: [], compactions: [], turns: [], toolMeta: {}, todos: [], changes: {}, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, context: 0, requests: 0 } },
    { send: (_id, type, p) => { if (type === 'notice') notices.push(p.message); }, save: () => {}, getSettings: () => ({ autoVerify: true }), getApiKey: () => 'x', getGeminiKey: () => 'x' });
  await a.send('Build the app in SPEC.md', { model: 'claude-opus-5-5', effort: 'low', mode: 'yolo' });
  a.dispose();
  assert.ok(notices.some((n) => /Completion audit: 1 part/.test(n)), notices.join(' | '));
  assert.match(JSON.stringify(a.data.messages), /Pipeline page from SPEC\.md is missing/);
  assert.ok(fs.existsSync(path.join(dir, 'pipeline.js')), 'agent went back and did the rest');
  assert.match(prompts[0], /Contacts page[\s\S]*Pipeline page/, 'reviewer saw the spec the task named');
  assert.match(prompts[0], /a\.js \(\d+ lines\)/, 'reviewer saw the file map');
});

test('project frames: a project opened through a link or short path still matches the real path in a stack', () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { projectFrames } = require('../src/main/guards');
  const real = fs.mkdtempSync(path.join(os.tmpdir(), 'drops-frames-'));
  const link = real + '-link';
  fs.symlinkSync(real, link, 'junction');
  try {
    const stack = `TypeError: x\n    at f (${path.join(fs.realpathSync.native(real), 'lib.js')}:3:9)\n    at node:internal/main:1:1`;
    assert.deepEqual(projectFrames(stack, link), ['lib.js:3']);
    assert.deepEqual(projectFrames(stack, real), ['lib.js:3']);
  } finally { fs.rmSync(link, { force: true, recursive: false }); }
});

test('project profile: an unreadable folder in the project does not crash the request', { skip: process.platform === 'win32' && 'needs POSIX permissions' }, () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drops-noread-'));
  fs.mkdirSync(path.join(dir, 'locked'));
  fs.writeFileSync(path.join(dir, 'app.csproj'), '<Project />');
  fs.chmodSync(path.join(dir, 'locked'), 0o000);
  try {
    const p = require('../src/main/context').projectProfile(dir);
    assert.ok(typeof p.text === 'string');
  } finally { fs.chmodSync(path.join(dir, 'locked'), 0o755); }
});
