// Memory: decisions in DROPs.md, and unfinished work carried from one session to the next.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.APPDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'drops-memory-test-'));
const providers = require('../src/main/providers');
const { AgentSession } = require('../src/main/agent');
const realCallModel = providers.callModel;

function run(dir, id, script, title) {
  let i = 0;
  let lastSystem = '';
  providers.callModel = async ({ tools, system }) => {
    lastSystem = system;
    if (!tools.length) return { content: [{ type: 'text', text: '[]' }], usage: {} };
    const st = script[i++] || { text: 'done' };
    return { content: st.tool ? [{ type: 'tool_use', id: 't' + i, name: st.tool, input: st.input }] : [{ type: 'text', text: st.text }], model: 'fake', stop_reason: st.tool ? 'tool_use' : 'end_turn', usage: {} };
  };
  const data = { id, title, projectDir: dir, messages: [], archive: [], compactions: [], turns: [], toolMeta: {}, todos: [], changes: {}, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, context: 0, requests: 0 } };
  const agent = new AgentSession(data, { send: () => {}, save: () => {}, getSettings: () => ({ completionAudit: false, autoVerify: false, uiCheck: false }), getApiKey: () => 'x', getGeminiKey: () => 'x' });
  return { agent, data, system: () => lastSystem };
}

test('remember: a decision goes under "Decisions" with its date and reason; facts stay under "Memory"', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drops-mem-'));
  const { agent } = run(dir, 's1', [
    { tool: 'remember', input: { note: 'Tests run with npm test' } },
    { tool: 'remember', input: { note: 'Prices are stored in cents', kind: 'decision', why: 'floats lost money in rounding' } },
    { tool: 'remember', input: { note: 'Use pnpm, not npm' } },
    { text: 'Saved.' },
  ], 'Notes');
  try {
    await agent.send('remember things', { model: 'claude-opus-5-5', effort: 'low', mode: 'yolo' });
    const md = fs.readFileSync(path.join(dir, 'DROPs.md'), 'utf8');
    assert.match(md, /## Memory\n- Tests run with npm test\n- Use pnpm, not npm\n/);
    assert.match(md, /## Decisions\n- \d{4}-\d{2}-\d{2}: Prices are stored in cents \(why: floats lost money in rounding\)/);
    assert.ok(!JSON.stringify(agent.data.messages).includes('H2O.md'), 'the reply names the real file');
  } finally { agent.dispose(); providers.callModel = realCallModel; }
});

test('unfinished work: what one session leaves open is in the next session\'s prompt, and disappears once done', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drops-mem-'));
  const first = run(dir, 'sess-A', [
    { tool: 'todo_write', input: { todos: [{ content: 'Build the cart', status: 'completed' }, { content: 'Add the coupon field', status: 'in_progress' }, { content: 'Write checkout tests', status: 'pending' }] } },
    { text: 'Stopping here for today.' },
  ], 'Shop: cart and coupons');
  try { await first.agent.send('build the shop', { model: 'claude-opus-5-5', effort: 'low', mode: 'yolo' }); } finally { first.agent.dispose(); }
  assert.ok(!fs.readdirSync(dir).some((f) => f.startsWith('.drops')), 'nothing is written into the user\'s project');

  const second = run(dir, 'sess-B', [{ text: 'ok' }], 'Next day');
  try {
    await second.agent.send('continue', { model: 'claude-opus-5-5', effort: 'low', mode: 'yolo' });
    const sys = second.system();
    assert.match(sys, /# Unfinished work from earlier sessions in this project/);
    assert.match(sys, /"Shop: cart and coupons".*open tasks: Add the coupon field; Write checkout tests/);
    assert.match(sys, /check it against the current code/);
    assert.doesNotMatch(sys, /Build the cart/, 'finished work is not carried over');
  } finally { second.agent.dispose(); }

  // Session A finishes its list: nothing is left open, so it no longer appears.
  const again = run(dir, 'sess-A', [
    { tool: 'todo_write', input: { todos: [{ content: 'Add the coupon field', status: 'completed' }, { content: 'Write checkout tests', status: 'completed' }] } },
    { text: 'All done.' },
  ], 'Shop: cart and coupons');
  try { await again.agent.send('finish', { model: 'claude-opus-5-5', effort: 'low', mode: 'yolo' }); } finally { again.agent.dispose(); }
  const third = run(dir, 'sess-C', [{ text: 'ok' }], 'Later');
  try {
    await third.agent.send('hi', { model: 'claude-opus-5-5', effort: 'low', mode: 'yolo' });
    assert.doesNotMatch(third.system(), /Unfinished work/);
  } finally { third.agent.dispose(); providers.callModel = realCallModel; }
});

test('searchSessions: finds matches inside saved conversation messages as well as titles', () => {
  const store = require('../src/main/store');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drops-search-'));
  const s1 = store.newSession(dir);
  s1.title = 'Unrelated title';
  s1.messages = [{ role: 'user', content: [{ type: 'text', text: 'Please configure PostgreSQL connection pooling' }] }];
  store.saveSession(s1);

  const s2 = store.newSession(dir);
  s2.title = 'Redis cache setup';
  s2.messages = [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }];
  store.saveSession(s2);

  const byMsg = store.searchSessions('postgresql');
  assert.equal(byMsg.length, 1);
  assert.equal(byMsg[0].id, s1.id);
  assert.match(byMsg[0].snippet, /PostgreSQL/i);

  const byTitle = store.searchSessions('redis');
  assert.equal(byTitle.length, 1);
  assert.equal(byTitle[0].id, s2.id);
});

test('save_plan: persists structured implementation plan in session and injects it into system prompt', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drops-plan-'));
  const { agent, data, system } = run(dir, 's-plan', [
    { tool: 'save_plan', input: { goal: 'Add rate limiting', files: ['src/auth.ts', 'tests/auth.test.ts'], steps: ['Add limiter', 'Wire middleware', 'Run tests'], verification: 'npm test' } },
    { text: 'Plan saved and ready.' },
  ], 'Rate limit');
  try {
    await agent.send('plan this', { model: 'claude-opus-5-5', effort: 'low', mode: 'yolo' });
    assert.equal(data.plan.goal, 'Add rate limiting');
    assert.deepEqual(data.plan.files, ['src/auth.ts', 'tests/auth.test.ts']);
    await agent.send('execute', { model: 'claude-opus-5-5', effort: 'low', mode: 'yolo' });
    assert.match(system(), /# Active Implementation Plan\nGoal: Add rate limiting\nFiles: src\/auth\.ts, tests\/auth\.test\.ts/);
    assert.match(system(), /Verification: npm test/);
  } finally { agent.dispose(); providers.callModel = realCallModel; }
});

test('save_plan: a plan carried out (files changed, task finished) is not pinned into the next request', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drops-plan-done-'));
  const { agent, data, system } = run(dir, 's-plan-done', [
    { tool: 'save_plan', input: { goal: 'Add a greeting', files: ['hello.txt'], steps: ['Write hello.txt'], verification: 'type hello.txt' } },
    { tool: 'write_file', input: { path: 'hello.txt', content: 'hello\n' } },
    { text: 'Done: hello.txt now says hello.' },
    { text: 'The answer is 4.' },
  ], 'Greeting');
  try {
    await agent.send('add a greeting file', { model: 'claude-opus-5-5', effort: 'low', mode: 'yolo' });
    assert.equal(fs.readFileSync(path.join(dir, 'hello.txt'), 'utf8'), 'hello\n');
    assert.equal(data.plan, null, 'the finished plan is cleared');
    await agent.send('what is 2 + 2?', { model: 'claude-opus-5-5', effort: 'low', mode: 'yolo' });
    assert.doesNotMatch(system(), /Active Implementation Plan/);
  } finally { agent.dispose(); providers.callModel = realCallModel; }
});
