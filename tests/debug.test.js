// Root-cause debugging: project frames from stack traces, the debugging procedure after a repeated
// failure, and a regression test before finishing.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.APPDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'drops-debug-test-'));
const guards = require('../src/main/guards');
const providers = require('../src/main/providers');
const { AgentSession } = require('../src/main/agent');
const realCallModel = providers.callModel;

test('project frames: own code only, innermost first, from Node, tsc and Python output', () => {
  const root = 'C:\\proj';
  assert.deepEqual(guards.projectFrames('TypeError: x\n    at total (C:\\proj\\lib\\cart.js:12:18)\n    at Object.<anonymous> (C:\\proj\\test\\cart.test.js:5:1)\n    at Module._compile (node:internal/modules/cjs/loader:1565:14)\n    at x (C:\\proj\\node_modules\\jest\\a.js:1:1)', root), ['lib/cart.js:12', 'test/cart.test.js:5']);
  assert.deepEqual(guards.projectFrames('src/app/page.tsx(14,7): error TS2339', root), ['src/app/page.tsx:14']);
  assert.deepEqual(guards.projectFrames('  File "app/main.py", line 40, in run\n  File "/usr/lib/python3/site-packages/x.py", line 2', root), ['app/main.py:40']);
  assert.deepEqual(guards.projectFrames('./app/api/route.ts:22:5\nGET http://localhost:3000/x.js:1:1', root), ['app/api/route.ts:22']);
  assert.deepEqual(guards.projectFrames('at D:\\other\\thing.js:3:1', root), [], 'a file outside the project is not ours');
});

test('a check that fails twice switches to root-cause debugging; finishing needs a regression test', { timeout: 120_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drops-debug-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'd', scripts: { test: 'node check.js' } }));
  fs.writeFileSync(path.join(dir, 'check.js'), "const f = require('./lib.js');\nif (f() !== 2) throw new Error('wrong total');\nconsole.log('ok');\n");
  const script = [
    { tool: 'write_file', input: { path: 'lib.js', content: 'module.exports = () => undefined.total;\n' } },
    { tool: 'shell', input: { command: 'npm test' } },
    { tool: 'shell', input: { command: 'npm test' } },
    { tool: 'write_file', input: { path: 'lib.js', content: 'module.exports = () => 2;\n' } },
    { tool: 'shell', input: { command: 'npm test' } },
    { text: 'Fixed.' },
    { tool: 'write_file', input: { path: 'test/lib.test.js', content: "require('assert').equal(require('../lib.js')(), 2);\n" } },
    { tool: 'shell', input: { command: 'npm test' } },
    { text: 'Fixed. Root cause: lib.js read a property of undefined.' },
  ];
  let i = 0;
  providers.callModel = async ({ tools }) => {
    if (!tools.length) return { content: [{ type: 'text', text: '[]' }], usage: {} };
    const st = script[i++] || { text: 'done' };
    return { content: st.tool ? [{ type: 'tool_use', id: 't' + i, name: st.tool, input: st.input }] : [{ type: 'text', text: st.text }], model: 'fake', stop_reason: st.tool ? 'tool_use' : 'end_turn', usage: {} };
  };
  const notices = [];
  const data = { id: 's', title: 'New session', projectDir: dir, messages: [], archive: [], compactions: [], turns: [], toolMeta: {}, todos: [], changes: {}, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, context: 0, requests: 0 } };
  const agent = new AgentSession(data, { send: (id, type, p) => { if (type === 'notice') notices.push(p.message); }, save: () => {}, getSettings: () => ({ completionAudit: false, uiCheck: false }), getApiKey: () => 'x', getGeminiKey: () => 'x' });
  try {
    await agent.send('Make the total work', { model: 'claude-opus-5-5', effort: 'low', mode: 'yolo' });
    const results = data.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b) => b.type === 'tool_result').map((b) => String(b.content));
    assert.match(results[1], /Where it failed in this project's code: lib\.js:1/, 'the first failure points at the project frame');
    assert.doesNotMatch(results[1], /\[DROPs debug\]/, 'one failure is not yet a debugging case');
    assert.match(results[2], /\[DROPs debug\] This has failed more than once/, 'the second failure starts the procedure');
    assert.ok(notices.some((n) => /switched the agent to step-by-step root-cause debugging/.test(n)));
    const all = JSON.stringify(data.messages);
    assert.match(all, /Add a regression test that fails without your fix/, 'finishing without a test is sent back');
    assert.equal((all.match(/Add a regression test that fails without your fix/g) || []).length, 1, 'only once');
    assert.equal(i, script.length, 'the agent finished after adding the test');
  } finally { agent.dispose(); providers.callModel = realCallModel; }
});
