// The `app` tool: launch an Electron app under test, use it like a user, screenshot it, and always
// close it at the end of the request. Text-only models get a description of screenshots instead.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.APPDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'drops-app-test-'));
const providers = require('../src/main/providers');
const browser = require('../src/main/browser');
const { AgentSession, modelSeesImages } = require('../src/main/agent');
const realCallModel = providers.callModel;
const APP = path.join(__dirname, 'fixtures', 'electron-app');

function session(script, model = 'claude-opus-5-5', gemini = 'x') {
  let i = 0; const geminiCalls = [];
  providers.callModel = async (o) => {
    if (o.model === 'gemini-3.6-flash' && !o.tools.length) { geminiCalls.push(o); return { content: [{ type: 'text', text: 'A window titled Counter with "Count: 1" and two buttons.' }], usage: {} }; }
    if (!o.tools.length) return { content: [{ type: 'text', text: '[]' }], usage: {} };
    const st = script[i++] || { text: 'done' };
    return { content: st.tool ? [{ type: 'tool_use', id: 't' + i, name: st.tool, input: st.input }] : [{ type: 'text', text: st.text }], model, stop_reason: st.tool ? 'tool_use' : 'end_turn', usage: {} };
  };
  const data = { id: 's', title: 'x', projectDir: APP, messages: [], archive: [], compactions: [], turns: [], toolMeta: {}, todos: [], changes: {}, usage: {} };
  const agent = new AgentSession(data, { send: () => {}, save: () => {}, getSettings: () => ({ autoVerify: false, completionAudit: false, uiCheck: false }), getApiKey: () => 'x', getGeminiKey: () => gemini });
  return { agent, data, geminiCalls };
}
const results = (data) => data.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b) => b.type === 'tool_result');

test('app: launch an Electron app, click, read, screenshot; a dead button is reported; the app is closed at the end', { timeout: 180_000 }, async (t) => {
  if (!browser.available()) return t.skip('playwright-core not installed');
  const { agent, data } = session([
    { tool: 'app', input: { action: 'launch' } },
    { tool: 'app', input: { action: 'click', target: 'Add' } },
    { tool: 'app', input: { action: 'click', target: 'testid=dead' } },
    { tool: 'app', input: { action: 'screenshot' } },
    { text: 'The counter works.' },
  ]);
  try {
    await agent.send('Test the counter app', { model: 'claude-opus-5-5', effort: 'low', mode: 'yolo' });
    const r = results(data).map((b) => (typeof b.content === 'string' ? b.content : JSON.stringify(b.content)));
    assert.match(r[0], /Title: Counter/, 'launched and read the window');
    assert.match(r[1], /Count: 1/, 'the click worked');
    assert.match(r[2], /nothing on the page changed/, 'a dead button is reported');
    const last = data.messages.find((m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'image'));
    assert.ok(last, 'the screenshot went to a model that can see images');
    await new Promise((res) => setTimeout(res, 1500));
    assert.equal(browser.isOpen(`app::${APP}`), false, 'the app was closed when the request ended');
  } finally { agent.dispose(); providers.callModel = realCallModel; await browser.closeAll(); }
});

test('app: refuses a folder outside the project, and steps before launch', async () => {
  const { agent, data } = session([
    { tool: 'app', input: { action: 'launch', path: '../../..' } },
    { tool: 'app', input: { action: 'click', target: 'Add' } },
    { text: 'ok' },
  ]);
  try {
    await agent.send('x', { model: 'claude-opus-5-5', effort: 'low', mode: 'yolo' });
    const r = results(data).map((b) => String(b.content));
    assert.match(r[0], /Only an app inside the project can be launched/);
    assert.match(r[1], /No app is running: call app with action "launch" first/);
  } finally { agent.dispose(); providers.callModel = realCallModel; }
});

test('a model that cannot see images gets a description of the screenshot instead', { timeout: 180_000 }, async (t) => {
  if (!browser.available()) return t.skip('playwright-core not installed');
  assert.equal(modelSeesImages('ollama:qwen3:4b'), false);
  assert.equal(modelSeesImages('openrouter:deepseek/deepseek-v4.1-flash'), false);
  assert.equal(modelSeesImages('gemini-3.6-flash'), true);
  const { agent, data, geminiCalls } = session([
    { tool: 'app', input: { action: 'launch' } },
    { tool: 'app', input: { action: 'screenshot' } },
    { text: 'ok' },
  ], 'ollama:qwen3:4b');
  try {
    await agent.send('look at it', { model: 'ollama:qwen3:4b', effort: false, mode: 'yolo' });
    const all = JSON.stringify(data.messages);
    assert.equal(geminiCalls.length, 1, 'a vision model described it');
    assert.ok(geminiCalls[0].messages[0].content.some((b) => b.type === 'image'));
    assert.match(all, /Screenshot described by a vision model/);
    assert.ok(!data.messages.some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'image')), 'no image goes to the text-only model');
  } finally { agent.dispose(); providers.callModel = realCallModel; await browser.closeAll(); }
});
