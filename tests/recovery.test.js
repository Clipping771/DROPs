// Recovery: find which of this request's changes breaks a check; rewind keeps the user's own edits.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.APPDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'drops-recovery-test-'));
const providers = require('../src/main/providers');
const { AgentSession } = require('../src/main/agent');
const realCallModel = providers.callModel;

function session(dir, script) {
  let i = 0;
  providers.callModel = async ({ tools }) => {
    if (!tools.length) return { content: [{ type: 'text', text: '[]' }], usage: {} };
    const st = script[i++] || { text: 'done' };
    return { content: st.tool ? [{ type: 'tool_use', id: 't' + i, name: st.tool, input: st.input }] : [{ type: 'text', text: st.text }], model: 'fake', stop_reason: st.tool ? 'tool_use' : 'end_turn', usage: {} };
  };
  const data = { id: 's', title: 'New session', projectDir: dir, messages: [], archive: [], compactions: [], turns: [], toolMeta: {}, todos: [], changes: {}, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, context: 0, requests: 0 } };
  const agent = new AgentSession(data, { send: () => {}, save: () => {}, getSettings: () => ({ completionAudit: false, autoVerify: false, uiCheck: false }), getApiKey: () => 'x', getGeminiKey: () => 'x' });
  return { agent, data };
}
const resultsOf = (data) => data.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b) => b.type === 'tool_result').map((b) => String(b.content));

test('find_breaking_change names the one changed file that breaks the check and leaves every file as it was', { timeout: 120_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drops-recover-'));
  fs.writeFileSync(path.join(dir, 'check.js'), "if (require('./price.js')() !== 10) { console.error('bad price'); process.exit(1); }\n");
  fs.writeFileSync(path.join(dir, 'price.js'), 'module.exports = () => 10;\n');
  fs.writeFileSync(path.join(dir, 'label.js'), "module.exports = 'old';\n");
  const { agent, data } = session(dir, [
    { tool: 'read_file', input: { path: 'label.js' } }, // DROPs never overwrites a file it has not read
    { tool: 'read_file', input: { path: 'price.js' } },
    { tool: 'write_file', input: { path: 'label.js', content: "module.exports = 'new';\n" } },
    { tool: 'write_file', input: { path: 'price.js', content: 'module.exports = () => 12;\n' } },
    { tool: 'write_file', input: { path: 'notes.js', content: '// new file\n' } },
    { tool: 'find_breaking_change', input: { command: 'node check.js' } },
    { text: 'Found it.' },
  ]);
  try {
    await agent.send('Change the label', { model: 'claude-opus-5-5', effort: 'low', mode: 'yolo' });
    const out = resultsOf(data).pop();
    assert.match(out, /Found it: node check\.js passes again when this change is undone: price\.js\./);
    assert.match(out, /Every file is back exactly as it was/);
    assert.equal(fs.readFileSync(path.join(dir, 'price.js'), 'utf8'), 'module.exports = () => 12;\n', 'nothing was left reverted');
    assert.equal(fs.readFileSync(path.join(dir, 'label.js'), 'utf8'), "module.exports = 'new';\n");
    assert.ok(fs.existsSync(path.join(dir, 'notes.js')), 'a new file is back too');
  } finally { agent.dispose(); providers.callModel = realCallModel; }
});

test('find_breaking_change says so when the failure was already there before the changes', { timeout: 120_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drops-recover-'));
  fs.writeFileSync(path.join(dir, 'check.js'), 'process.exit(1);\n');
  fs.writeFileSync(path.join(dir, 'a.js'), '1;\n');
  const { agent, data } = session(dir, [
    { tool: 'read_file', input: { path: 'a.js' } },
    { tool: 'write_file', input: { path: 'a.js', content: '2;\n' } },
    { tool: 'find_breaking_change', input: { command: 'node check.js' } },
    { text: 'ok' },
  ]);
  try {
    await agent.send('x', { model: 'claude-opus-5-5', effort: 'low', mode: 'yolo' });
    assert.match(resultsOf(data).pop(), /not caused by these changes/);
    assert.equal(fs.readFileSync(path.join(dir, 'a.js'), 'utf8'), '2;\n');
  } finally { agent.dispose(); providers.callModel = realCallModel; }
});

test('rewind restores what DROPs changed but keeps a file the user edited afterwards', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drops-recover-'));
  fs.writeFileSync(path.join(dir, 'a.js'), 'a1;\n');
  fs.writeFileSync(path.join(dir, 'b.js'), 'b1;\n');
  const { agent, data } = session(dir, [
    { tool: 'read_file', input: { path: 'a.js' } },
    { tool: 'read_file', input: { path: 'b.js' } },
    { tool: 'write_file', input: { path: 'a.js', content: 'a2;\n' } },
    { tool: 'write_file', input: { path: 'b.js', content: 'b2;\n' } },
    { text: 'done' },
  ]);
  try {
    await agent.send('edit both', { model: 'claude-opus-5-5', effort: 'low', mode: 'yolo' });
    fs.writeFileSync(path.join(dir, 'b.js'), 'b-mine;\n'); // the user's own edit after DROPs
    const r = await agent.rewind(0);
    assert.equal(fs.readFileSync(path.join(dir, 'a.js'), 'utf8'), 'a1;\n', 'DROPs\' change is undone');
    assert.equal(fs.readFileSync(path.join(dir, 'b.js'), 'utf8'), 'b-mine;\n', 'the user\'s later edit is kept');
    assert.deepEqual(r.kept, ['b.js']);
    assert.equal(r.restored, 1);
    assert.equal(data.messages.length, 0);
  } finally { agent.dispose(); providers.callModel = realCallModel; }
});
