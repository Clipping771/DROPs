// A turn that meets a model error, a short outage, or a message typed while it runs.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

process.env.APPDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'drops-turns-test-'));
const providers = require('../src/main/providers');
const { AgentSession, INTERRUPTED, NO_REPLY, STOPPED_BY_ERROR } = require('../src/main/agent');
const realCallModel = providers.callModel;

function session(settings = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drops-turns-'));
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello\n');
  const data = { id: 's', title: 'New session', projectDir: dir, messages: [], archive: [], compactions: [], turns: [], toolMeta: {}, todos: [], changes: {}, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, context: 0, requests: 0 } };
  const events = [];
  const agent = new AgentSession(data, {
    send: (id, type, p) => events.push({ type, ...p }), save: () => {},
    getSettings: () => ({ autoVerify: false, completionAudit: false, evidenceCheck: false, ...settings }),
    getApiKey: () => 'x', getGeminiKey: () => 'x',
  });
  return { agent, data, events };
}
const opts = { model: 'claude-opus-5-5', effort: 'low', mode: 'yolo' };
const textOf = (m) => (typeof m.content === 'string' ? m.content : m.content.filter((b) => b.type === 'text').map((b) => b.text).join(' '));

test('a model error is saved in the transcript as an error, never as "interrupted by user"', async () => {
  const { agent, data, events } = session();
  providers.callModel = async () => { throw Object.assign(new Error('400 messages: text content blocks must be non-empty'), { status: 400 }); };
  try {
    await agent.send('build it', opts);
    const last = data.messages[data.messages.length - 1];
    assert.equal(last.role, 'assistant');
    assert.ok(textOf(last).startsWith(STOPPED_BY_ERROR), textOf(last));
    assert.match(textOf(last), /non-empty/);
    assert.ok(!JSON.stringify(data.messages).includes(INTERRUPTED));
    assert.match(data.lastError.message, /non-empty/);
    assert.ok(events.some((e) => e.type === 'error'));

    // The next message starts a normal turn: no extra "interrupted" or "no reply" marker.
    providers.callModel = async () => ({ content: [{ type: 'text', text: 'ok' }], model: 'fake', stop_reason: 'end_turn', usage: {} });
    await agent.send('continue', opts);
    assert.ok(!JSON.stringify(data.messages).includes(NO_REPLY));
    for (let i = 1; i < data.messages.length; i++) assert.notEqual(data.messages[i].role === data.messages[i - 1].role && data.messages[i].role, 'user', `two user turns in a row at ${i}`);
  } finally { agent.dispose(); providers.callModel = realCallModel; }
});

test('a message typed while a tool runs joins the same user turn as the tool results', async () => {
  const { agent, data } = session();
  let calls = 0;
  providers.callModel = async () => {
    calls++;
    if (calls === 1) {
      setTimeout(() => agent.steer('also add a README'), 0); // arrives while the tool runs
      await new Promise((r) => setTimeout(r, 30));
      return { content: [{ type: 'tool_use', id: 't1', name: 'list_dir', input: { path: '.' } }], model: 'fake', stop_reason: 'tool_use', usage: {} };
    }
    return { content: [{ type: 'text', text: 'Done.' }], model: 'fake', stop_reason: 'end_turn', usage: {} };
  };
  try {
    await agent.send('look around', opts);
    const withResult = data.messages.find((m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result'));
    assert.equal(withResult.content[0].type, 'tool_result', 'tool results come first');
    assert.match(textOf(withResult), /\[User steering\] also add a README/);
    for (let i = 1; i < data.messages.length; i++) assert.ok(!(data.messages[i].role === 'user' && data.messages[i - 1].role === 'user'), `two user turns in a row at ${i}`);
  } finally { agent.dispose(); providers.callModel = realCallModel; }
});

test('a short outage is retried; a quota error is not', { timeout: 30_000 }, async () => {
  let chats = 0, mode = 'outage';
  const srv = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.url === '/api/chat') {
        chats++;
        if (mode === 'outage' && chats === 1) { res.writeHead(503, { 'content-type': 'application/json' }); return res.end('{"error":"model is overloaded, try again"}'); }
        if (mode === 'quota') { res.writeHead(429, { 'content-type': 'application/json' }); return res.end('{"error":"daily quota exceeded"}'); }
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ message: { role: 'assistant', content: 'Back online.' }, done: true, prompt_eval_count: 1, eval_count: 1 }) + '\n');
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(req.url === '/api/show' ? '{"capabilities":["tools"]}' : '{}');
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const deps = { getSettings: () => ({ ollamaUrl: `http://127.0.0.1:${srv.address().port}` }) };
  const notices = [];
  const call = () => providers.callModel({ model: 'ollama:fake', system: 's', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], tools: [], effort: false, signal: new AbortController().signal, emit: (t, p) => { if (t === 'notice') notices.push(p.message); }, deps, state: {} });
  try {
    const res = await call();
    assert.equal(res.content.find((b) => b.type === 'text').text, 'Back online.');
    assert.equal(chats, 2, 'one failed attempt, one retry');
    assert.match(notices.join('\n'), /Trying again in 2s/);
    assert.equal(providers.isTransientError(Object.assign(new Error('daily quota exceeded'), { status: 429 })), false);
    assert.equal(providers.isTransientError(Object.assign(new Error('rate limit, try again in 20s'), { status: 429 })), true);
    assert.equal(providers.isTransientError(Object.assign(new Error('bad request'), { status: 400 })), false);
    mode = 'quota'; chats = 0;
    await assert.rejects(call());
    assert.equal(chats, 1, 'a quota error is not retried');
  } finally { srv.close(); }
});
