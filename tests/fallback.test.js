// The cross-provider fallback chain: when a model is out of quota or credit, the next model in
// settings.fallbackModels answers, and the exhausted one is skipped on later turns.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const providers = require('../src/main/providers');

test('isCapacityError: quota, credit, rate limits and unreachable servers fall back; real errors do not', () => {
  for (const e of [{ status: 429, message: 'x' }, { status: 402, message: 'x' }, { status: 0, message: 'Cannot reach Ollama' },
    { message: 'Every Gemini model is busy or over quota right now' }, { message: 'insufficient credits' }]) assert.ok(providers.isCapacityError(e), e.message);
  for (const e of [{ status: 400, message: 'invalid tool schema' }, { status: 401, message: 'bad key' }, { message: 'Malformed tool call JSON' }]) assert.ok(!providers.isCapacityError(e), e.message);
});

test('callModel: out-of-quota model falls back to the next one, then is skipped on the next turn', async () => {
  // Two fake OpenAI-compatible servers through the "custom" provider: the first says 429 (daily quota),
  // the second answers.
  const hits = { a: 0, b: 0 };
  const mk = (name, fn) => http.createServer((req, res) => { hits[name]++; req.resume(); req.on('end', () => fn(res)); });
  const a = mk('a', (res) => { res.writeHead(429, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'free-models-per-day quota exceeded' } })); });
  const b = mk('b', (res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ id: '1', choices: [{ index: 0, delta: { role: 'assistant', content: 'hello from B' } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ id: '1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 3 } })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  await Promise.all([a, b].map((s) => new Promise((r) => s.listen(0, '127.0.0.1', r))));
  const notices = [];
  const settingsFor = (url) => ({ customBaseUrl: url, fallbackModels: ['lmstudio:model-b'], lmstudioUrl: `http://127.0.0.1:${b.address().port}/v1` });
  const settings = settingsFor(`http://127.0.0.1:${a.address().port}/v1`);
  const deps = { getSettings: () => settings, getProviderKey: () => 'k' };
  const call = () => providers.callModel({
    model: 'custom:model-a', system: 's', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], tools: [],
    signal: new AbortController().signal, emit: (t, p) => { if (t === 'notice') notices.push(p.message); }, deps, state: {},
  });
  try {
    const r1 = await call();
    assert.match(r1.content.map((c) => c.text).join(''), /hello from B/);
    assert.ok(notices.some((n) => /custom:model-a: .*falling back to lmstudio:model-b/.test(n)), notices.join(' | '));
    const aHits = hits.a;
    const r2 = await call();
    assert.match(r2.content.map((c) => c.text).join(''), /hello from B/);
    assert.equal(hits.a, aHits, 'the exhausted model is skipped on the next turn');
  } finally {
    a.close(); b.close(); providers.exhaustedUntil.clear();
  }
});
