// Computer use: the safety rules, and a real Windows app driven through UI Automation.
// The mouse/keyboard test moves the real pointer, so it runs only with DROPS_DESKTOP_INPUT=1.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Desktop, sensitiveText, blockedKeys } = require('../src/main/desktop');

const WIN = process.platform === 'win32';

test('computer use: never types card numbers or keys; Windows-key and app-switching combos are blocked', () => {
  assert.equal(sensitiveText('4111 1111 1111 1111'), 'a card number');
  assert.equal(sensitiveText('Order 1234 5678 to Dhaka'), null);
  assert.equal(sensitiveText('hello world'), null);
  assert.ok(blockedKeys('win+r'));
  assert.ok(blockedKeys('alt+tab'));
  assert.ok(blockedKeys('ctrl+shift+esc'));
  assert.equal(blockedKeys('ctrl+s'), null);
  assert.equal(blockedKeys('enter'), null);
});

function buildApp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drops-desk-app-'));
  const exe = path.join(dir, 'dropsdesktest.exe');
  const src = path.join(__dirname, 'fixtures', 'desk-app.cs');
  execFileSync('powershell.exe', ['-NoProfile', '-Command', `Add-Type -Path '${src}' -OutputAssembly '${exe}' -OutputType WindowsApplication -ReferencedAssemblies System.Windows.Forms,System.Drawing`], { stdio: 'ignore', timeout: 120_000 });
  return exe;
}

function desk(answers = {}) {
  const asked = { apps: [], actions: [], resumes: [] }; const frames = [];
  const d = new Desktop({
    gate: {
      approveApp: async (p, note) => { asked.apps.push([p, note]); return answers.app !== false; },
      approveAction: async (t) => { asked.actions.push(t); return !!answers.action; },
      resume: async (r) => { asked.resumes.push(r); return !!answers.resume; },
    },
    onFrame: (f) => frames.push(f),
  });
  return { d, asked, frames };
}
const kill = (pid) => { try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ } };

test('computer use: open an approved app, read it, click and fill by name, refuse passwords and blocked apps, ask before Delete', { skip: !WIN, timeout: 240_000 }, async () => {
  const exe = buildApp();
  const { d, asked, frames } = desk({ action: false });
  let pid;
  try {
    const opened = await d.act({ action: 'open', app: exe });
    pid = d.target.pid;
    assert.match(opened.text, /Opened dropsdesktest: "DROPs Desk Test"/);
    assert.deepEqual(asked.apps.map((a) => a[0]), ['dropsdesktest'], 'the user approved the app');
    const read = await d.act({ action: 'read' });
    assert.match(read.text, /Button "Add"/);
    assert.match(read.text, /password field: DROPs never types here/);
    assert.match(read.text, /Count: 0/);

    const c1 = await d.act({ action: 'click', target: 'Add' });
    assert.match(c1.text, /Clicked Button "Add" \(invoke, without moving the mouse\)\. The window changed\./);
    await d.act({ action: 'type', target: 'Note', text: 'hello' });
    await d.act({ action: 'click', target: 'Add' });
    assert.match((await d.act({ action: 'read' })).text, /Count: 2 · hello/);

    await assert.rejects(d.act({ action: 'type', target: 'Password', text: 'secret' }), /password field/);
    await assert.rejects(d.act({ action: 'type', target: 'Note', text: 'card 4111 1111 1111 1111' }), /never types a card number/);

    await assert.rejects(d.act({ action: 'click', target: 'Delete all' }), /did not allow clicking "Delete all"/);
    assert.match(asked.actions[0], /Click "Delete all"/);
    assert.doesNotMatch((await d.act({ action: 'read' })).text, /Deleted/, 'not clicked without the OK');

    await assert.rejects(d.act({ action: 'focus', app: 'explorer' }), /system or security program|No open window/);
    await assert.rejects(d.act({ action: 'open', app: 'regedit' }), /system or security program/);
    await assert.rejects(d.act({ action: 'key', keys: 'win+r' }), /Windows key/);

    const shot = await d.act({ action: 'screenshot' });
    assert.equal(shot.images.length, 1);
    assert.match(shot.text, /Screenshot of dropsdesktest/);
    const list = await d.act({ action: 'windows' });
    assert.match(list.text, /dropsdesktest: "DROPs Desk Test"/);
    assert.doesNotMatch(list.text.replace(/dropsdesktest.*\n?/g, ''), /"/, 'titles of apps the user did not approve stay hidden');
    assert.ok(frames.length >= 3, 'the live pane got frames');
  } finally { if (pid) kill(pid); d.close(); }
});

test('computer use: the user can say no to an app', { skip: !WIN, timeout: 120_000 }, async () => {
  const exe = buildApp();
  const { d } = desk({ app: false });
  try {
    await assert.rejects(d.act({ action: 'open', app: exe }), /did not allow DROPs to open/);
    assert.equal(d.target, null);
  } finally { d.close(); }
});

test('computer use: real mouse and keyboard (moves the pointer; DROPS_DESKTOP_INPUT=1)', { skip: !WIN || process.env.DROPS_DESKTOP_INPUT !== '1', timeout: 180_000 }, async () => {
  const exe = buildApp();
  const { d } = desk({ action: true });
  let pid;
  try {
    await d.act({ action: 'open', app: exe }); pid = d.target.pid;
    await d.act({ action: 'screenshot' });
    const add = (await d.h.call('find', { hwnd: d.target.hwnd, name: 'Add' })).matches[0];
    const note = (await d.h.call('find', { hwnd: d.target.hwnd, name: 'Note' })).matches[0];
    const toImg = (r) => [((r[0] + r[2]) / 2 - d.target.rect[0]) * d.lastShot.scale, ((r[1] + r[3]) / 2 - d.target.rect[1]) * d.lastShot.scale];
    const [nx, ny] = toImg(note.rect);
    await d.act({ action: 'click', x: nx, y: ny });
    await d.act({ action: 'type', text: 'typed' });
    await d.act({ action: 'key', keys: 'end' });
    const [ax, ay] = toImg(add.rect);
    const r = await d.act({ action: 'click', x: ax, y: ay });
    assert.match(r.text, /Clicked Button "Add"\. The window changed\./);
    assert.match((await d.act({ action: 'read' })).text, /Count: 1 · typed/);
  } finally { if (pid) kill(pid); d.close(); }
});

// ---------- through the agent ----------
const providers = require('../src/main/providers');
const { AgentSession } = require('../src/main/agent');
const realCallModel = providers.callModel;
function agentWith(script, settings = {}, onEvent = () => {}) {
  let i = 0;
  providers.callModel = async (o) => {
    if (!o.tools.length) return { content: [{ type: 'text', text: '[]' }], usage: {} };
    const st = script[i++] || { text: 'done' };
    return { content: st.tool ? [{ type: 'tool_use', id: 't' + i, name: st.tool, input: st.input }] : [{ type: 'text', text: st.text }], stop_reason: st.tool ? 'tool_use' : 'end_turn', usage: {} };
  };
  const data = { id: 's', title: 'x', projectDir: os.tmpdir(), messages: [], archive: [], compactions: [], turns: [], toolMeta: {}, todos: [], changes: {}, usage: {} };
  const agent = new AgentSession(data, { send: (_id, type, p) => onEvent(agent, type, p), save: () => {}, getSettings: () => ({ autoVerify: false, completionAudit: false, uiCheck: false, ...settings }), getApiKey: () => 'x', getGeminiKey: () => '' });
  return { agent, data };
}
const results = (data) => data.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b) => b.type === 'tool_result').map((b) => String(b.content));

test('computer tool: asks for each app even in full auto, then reads and clicks; off in Settings means off', { skip: !WIN, timeout: 240_000 }, async () => {
  const exe = buildApp();
  const perms = []; let pid;
  const { agent, data } = agentWith([
    { tool: 'computer', input: { action: 'open', app: exe } },
    { tool: 'computer', input: { action: 'click', target: 'Add' } },
    { tool: 'computer', input: { action: 'read' } },
    { text: 'Done' },
  ], {}, (a, type, p) => { if (type === 'permission') { perms.push(p); setImmediate(() => a.respond(p.reqId, 'allow')); } });
  try {
    await agent.send('Open the test app and press Add', { model: 'claude-opus-5-5', effort: 'low', mode: 'yolo' });
    pid = agent.desktop?.target?.pid;
    assert.equal(perms.length, 1, 'one question, in full auto too');
    assert.equal(perms[0].kind, 'computer');
    assert.match(perms[0].summary, /Let DROPs use dropsdesktest/);
    const r = results(data);
    assert.match(r[1], /Clicked Button "Add"/);
    assert.match(r[2], /Count: 1/);
  } finally { if (pid) kill(pid); agent.dispose(); providers.callModel = realCallModel; }

  const off = agentWith([{ tool: 'computer', input: { action: 'windows' } }, { text: 'ok' }], { computerUse: false });
  try {
    await off.agent.send('x', { model: 'claude-opus-5-5', effort: 'low', mode: 'yolo' });
    assert.match(results(off.data)[0], /turned off in Settings/);
  } finally { off.agent.dispose(); providers.callModel = realCallModel; }
});
