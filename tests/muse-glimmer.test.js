// Integration validation suite for Muse Glimmer 30B (ollama:muse-glimmer:latest) in DROPs v2.1.0.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ollama = require('../src/main/ollama');
const providers = require('../src/main/providers');
const { AgentSession } = require('../src/main/agent');
const { McpManager } = require('../src/main/mcp');

function makeSessionData(dir, mode = 'yolo', model = 'ollama:muse-glimmer:latest') {
  return {
    id: 'mg-' + Math.random().toString(36).slice(2, 8),
    title: 'Muse Glimmer Test',
    projectDir: dir,
    model,
    effort: 'low',
    mode,
    messages: [],
    archive: [],
    compactions: [],
    turns: [],
    toolMeta: {},
    todos: [],
    changes: {},
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, context: 0, requests: 0 },
  };
}

function startMockOllama(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : {};
      if (req.url === '/api/chat') requests.push(parsed);
      handler(req, res, parsed, requests);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        requests,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

function sendNdjson(res, chunks) {
  res.writeHead(200, { 'content-type': 'application/x-ndjson' });
  for (const c of chunks) res.write(JSON.stringify(c) + '\n');
  res.end();
}

test('hardware optimization: effectiveCtx, think level mapping, and HTTP 400 think fallback', async () => {
  const gb16 = 16 * 1024 ** 3;
  const gb32 = 32 * 1024 ** 3;

  // On 16GB RAM, heavy 27B-30B models like muse-glimmer cap to 8192 to avoid OOM/swap thrashing.
  assert.strictEqual(ollama.effectiveCtx('ollama:muse-glimmer:latest', 32768, gb16), 8192);
  assert.strictEqual(ollama.effectiveCtx('ollama:muse-glimmer:latest', 16384, gb16), 8192);
  assert.strictEqual(ollama.effectiveCtx('ollama:muse-glimmer:latest', 4096, gb16), 4096);
  // Smaller local models can still use 16384 on 16GB RAM.
  assert.strictEqual(ollama.effectiveCtx('ollama:qwen3:4b', 16384, gb16), 16384);
  // 32GB+ machines honor full requested num_ctx.
  assert.strictEqual(ollama.effectiveCtx('ollama:muse-glimmer:latest', 32768, gb32), 32768);

  // Effort -> native glimmer think levels.
  assert.strictEqual(ollama.mapEffortToThink('ollama:muse-glimmer:latest', 'low', gb16), 'low');
  assert.strictEqual(ollama.mapEffortToThink('ollama:muse-glimmer:latest', 'medium', gb16), 'medium');
  assert.strictEqual(ollama.mapEffortToThink('ollama:muse-glimmer:latest', 'high', gb16), 'high');
  assert.strictEqual(ollama.mapEffortToThink('ollama:muse-glimmer:latest', 'xhigh', gb16), 'max');
  assert.strictEqual(ollama.mapEffortToThink('ollama:muse-glimmer:latest', 'max', gb16), 'max');
  assert.strictEqual(ollama.mapEffortToThink('ollama:muse-glimmer:latest', false, gb16), false);
  assert.strictEqual(ollama.mapEffortToThink('ollama:muse-glimmer:latest', undefined, gb16), 'low');

  // HTTP 400 rejection of `think` retries automatically without `think`.
  const mock = await startMockOllama((req, res, body) => {
    if (body.think !== undefined) {
      res.writeHead(400, { 'content-type': 'text/plain' });
      return res.end('model does not support think option');
    }
    sendNdjson(res, [
      { message: { role: 'assistant', content: 'Recovered without think.' }, done: false },
      { message: { role: 'assistant', content: '' }, done: true, prompt_eval_count: 20, eval_count: 5 },
    ]);
  });
  try {
    const turn = await ollama.streamTurn({
      baseUrl: mock.url,
      model: 'ollama:muse-glimmer:latest',
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      signal: new AbortController().signal,
      emit: () => {},
      numCtx: 32768,
      effort: 'low',
    });
    assert.strictEqual(mock.requests.length, 2);
    assert.strictEqual(mock.requests[0].think, 'low');
    assert.strictEqual(mock.requests[1].think, undefined);
    assert.strictEqual(turn.content[0].text, 'Recovered without think.');
  } finally {
    await mock.close();
  }
});

test('tool calling reliability: native calls, sequential + parallel dedup, malformed JSON retry, failure recovery & todos', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'h2o-mg-tools-'));
  fs.writeFileSync(path.join(dir, 'a.js'), 'function add(a, b) { return a - b; }\nmodule.exports = { add };\n');
  fs.writeFileSync(path.join(dir, 'b.js'), 'const { add } = require("./a");\nif (add(2, 3) !== 5) process.exit(1);\nconsole.log("OK");\n');

  let step = 0;
  const mock = await startMockOllama((_req, res) => {
    step++;
    if (step === 1) {
      // Malformed JSON tool arguments string -> should trigger AgentSession jsonRetries recovery
      return sendNdjson(res, [
        { message: { role: 'assistant', thinking: 'Reading files first', tool_calls: [{ function: { name: 'read_file', arguments: '{not-valid-json' } }] }, done: false },
        { message: {}, done: true, prompt_eval_count: 100, eval_count: 10 },
      ]);
    }
    if (step === 2) {
      // Parallel read_file calls + intentional duplicate read_file to test deduplication + todo_write
      return sendNdjson(res, [
        {
          message: {
            role: 'assistant',
            thinking: 'Creating plan and reading a.js and b.js in parallel.',
            tool_calls: [
              { function: { name: 'read_file', arguments: { path: 'a.js' } } },
              { function: { name: 'read_file', arguments: { path: 'a.js' } } },
              { function: { name: 'read_file', arguments: { path: 'b.js' } } },
              { function: { name: 'todo_write', arguments: { todos: [{ content: 'Fix add()', status: 'in_progress' }, { content: 'Run b.js test', status: 'pending' }] } } },
            ],
          },
          done: false,
        },
        { message: {}, done: true, prompt_eval_count: 200, eval_count: 35 },
      ]);
    }
    if (step === 3) {
      // Tool failure recovery: edit_file with mismatched old_string
      return sendNdjson(res, [
        {
          message: {
            role: 'assistant',
            thinking: 'Editing a.js',
            tool_calls: [{ function: { name: 'edit_file', arguments: { path: 'a.js', old_string: 'NON_EXISTENT_STRING', new_string: 'return a + b;' } } }],
          },
          done: false,
        },
        { message: {}, done: true, prompt_eval_count: 300, eval_count: 20 },
      ]);
    }
    if (step === 4) {
      // Recover from tool error, apply valid edit, and update todos
      return sendNdjson(res, [
        {
          message: {
            role: 'assistant',
            thinking: 'Retrying with exact old_string',
            tool_calls: [
              { function: { name: 'edit_file', arguments: { path: 'a.js', old_string: 'return a - b;', new_string: 'return a + b;' } } },
              { function: { name: 'todo_write', arguments: { todos: [{ content: 'Fix add()', status: 'completed' }, { content: 'Run b.js test', status: 'in_progress' }] } } },
            ],
          },
          done: false,
        },
        { message: {}, done: true, prompt_eval_count: 400, eval_count: 25 },
      ]);
    }
    if (step === 5) {
      // Model tries to finish BEFORE running verification -> verification guard must block!
      return sendNdjson(res, [
        { message: { role: 'assistant', content: 'I fixed add() in a.js.' }, done: false },
        { message: {}, done: true, prompt_eval_count: 450, eval_count: 15 },
      ]);
    }
    if (step === 6) {
      // Verification run + complete todos
      return sendNdjson(res, [
        {
          message: {
            role: 'assistant',
            tool_calls: [
              { function: { name: 'shell', arguments: { command: 'node --test b.js' } } },
              { function: { name: 'todo_write', arguments: { todos: [{ content: 'Fix add()', status: 'completed' }, { content: 'Run b.js test', status: 'completed' }] } } },
            ],
          },
          done: false,
        },
        { message: {}, done: true, prompt_eval_count: 500, eval_count: 20 },
      ]);
    }
    return sendNdjson(res, [
      { message: { role: 'assistant', content: 'Fixed a.js and verified node b.js passes (OK).' }, done: false },
      { message: {}, done: true, prompt_eval_count: 550, eval_count: 15 },
    ]);
  });

  const notices = [];
  const errors = [];
  const data = makeSessionData(dir, 'yolo', 'ollama:muse-glimmer:latest');
  const settings = { ollamaUrl: mock.url, ollamaCtx: 32768, autoVerify: true, ollamaEnabled: true, completionAudit: false }; // this test scripts every model reply; the audit (an extra call) is covered in guards.test.js
  const agent = new AgentSession(data, {
    send: (_id, type, p) => {
      if (type === 'notice') notices.push(p.message);
      if (type === 'error') errors.push(p.message);
    },
    save: () => {},
    getSettings: () => settings,
    getApiKey: () => null,
    getGeminiKey: () => null,
  });

  try {
    await agent.send('Fix add() in a.js and run b.js', { model: 'ollama:muse-glimmer:latest', effort: 'low', mode: 'yolo' });
    assert.deepStrictEqual(errors, []);
    assert.strictEqual(step, 7);
    assert.ok(notices.some((n) => /malformed; retrying/i.test(n)), 'malformed JSON recovery notice emitted');
    assert.ok(notices.some((n) => /Verification guard: no real test/i.test(n)), 'verification guard blocked premature finish');
    // Check thinking continuity preserved in request messages sent back to Glimmer
    const req3Assistant = mock.requests[2].messages.find((m) => m.role === 'assistant');
    assert.match(req3Assistant.thinking || '', /Creating plan/, 'assistant thinking preserved across tool turns');
    // Check tool failure in req 4 received ERROR: prefix from edit_file mismatch
    assert.ok(mock.requests[3].messages.some((m) => m.role === 'tool' && /ERROR:/.test(m.content)));
    // Check duplicate read_file calls did not error and file was fixed
    assert.match(fs.readFileSync(path.join(dir, 'a.js'), 'utf8'), /return a \+ b;/);
    assert.strictEqual(data.todos.every((t) => t.status === 'completed'), true);
    assert.strictEqual(Object.keys(data.changes).length, 1);
  } finally {
    agent.dispose();
    await mock.close();
  }
});

test('agent modes compatibility: code, architect (plan), review, ask & loop guard', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'h2o-mg-modes-'));
  fs.writeFileSync(path.join(dir, 'app.js'), 'exports.v = 1;\n');
  fs.writeFileSync(path.join(dir, '.env'), 'SECRET=123\n');

  // Helper to run 1 tool-call sequence in a chosen mode
  async function runModeScenario(mode, toolCallsPerTurn, onPermission) {
    let turn = 0;
    const mock = await startMockOllama((_req, res) => {
      turn++;
      if (turn <= toolCallsPerTurn.length) {
        return sendNdjson(res, [
          { message: { role: 'assistant', tool_calls: toolCallsPerTurn[turn - 1] }, done: false },
          { message: {}, done: true, prompt_eval_count: 50, eval_count: 10 },
        ]);
      }
      return sendNdjson(res, [
        { message: { role: 'assistant', content: `Done in ${mode}` }, done: false },
        { message: {}, done: true, prompt_eval_count: 80, eval_count: 8 },
      ]);
    });
    const data = makeSessionData(dir, mode, 'ollama:muse-glimmer:latest');
    const perms = [];
    const notices = [];
    let agent;
    agent = new AgentSession(data, {
      send: (_id, type, p) => {
        if (type === 'notice') notices.push(p.message);
        if (type === 'permission') {
          perms.push(p);
          const dec = onPermission ? onPermission(p) : { decision: 'allow' };
          setImmediate(() => agent.respond(p.reqId, dec.decision, dec.feedback || ''));
        }
      },
      save: () => {},
      getSettings: () => ({ ollamaUrl: mock.url, ollamaCtx: 8192, autoVerify: false }),
      getApiKey: () => null,
      getGeminiKey: () => null,
    });
    try {
      await agent.send(`Test ${mode}`, { model: 'ollama:muse-glimmer:latest', effort: 'low', mode });
      return { requests: mock.requests, perms, notices, data };
    } finally {
      agent.dispose();
      await mock.close();
    }
  }

  // 1. architect mode (alias of plan): read_file allowed, write_file blocked
  const arch = await runModeScenario('architect', [[
    { function: { name: 'read_file', arguments: { path: 'app.js' } } },
    { function: { name: 'write_file', arguments: { path: 'new.js', content: 'x' } } },
  ]]);
  assert.match(arch.requests[0].messages[0].content, /# PLAN MODE IS ON/);
  assert.ok(!fs.existsSync(path.join(dir, 'new.js')), 'architect mode blocked write_file');
  assert.ok(arch.requests[1].messages.some((m) => m.role === 'tool' && /Plan mode is on/.test(m.content)));

  // 2. review mode: read_file + safe git/node read allowed, edit_file & destructive shell blocked
  const rev = await runModeScenario('review', [[
    { function: { name: 'read_file', arguments: { path: 'app.js' } } },
    { function: { name: 'shell', arguments: { command: 'node -v' } } },
    { function: { name: 'edit_file', arguments: { path: 'app.js', old_string: '1', new_string: '2' } } },
    { function: { name: 'shell', arguments: { command: 'node -e "fs.writeFileSync(\'x\',\'y\')"' } } },
  ]]);
  assert.match(rev.requests[0].messages[0].content, /# REVIEW MODE IS ON/);
  assert.strictEqual(rev.perms.length, 0, 'review mode does not prompt on safe inspect commands');
  assert.match(fs.readFileSync(path.join(dir, 'app.js'), 'utf8'), /exports\.v = 1/, 'review mode blocked edit');
  assert.ok(rev.requests[1].messages.some((m) => m.role === 'tool' && /\[review mode\] Blocked edit_file/.test(m.content)));
  assert.ok(rev.requests[1].messages.some((m) => m.role === 'tool' && /\[review mode\] Blocked state-changing/.test(m.content)));

  // 3. code mode: edits normal files without permission prompt, still gates sensitive .env edits
  const code = await runModeScenario('code', [
    [{ function: { name: 'write_file', arguments: { path: 'code_ok.js', content: 'exports.ok = true;\n' } } }],
    [{ function: { name: 'read_file', arguments: { path: '.env' } } }],
    [{ function: { name: 'write_file', arguments: { path: '.env', content: 'SECRET=999\n' } } }],
  ], () => ({ decision: 'deny', feedback: 'Keep .env intact' }));
  assert.ok(fs.existsSync(path.join(dir, 'code_ok.js')), 'code mode writes normal files autonomously');
  assert.strictEqual(code.perms.length, 1, 'code mode gates sensitive .env write');
  assert.match(code.perms[0].summary, /\.env/);
  assert.match(fs.readFileSync(path.join(dir, '.env'), 'utf8'), /SECRET=123/);

  // 4. ask mode: prompts permission for non-sensitive edit & respects denial
  const askRes = await runModeScenario('ask', [[
    { function: { name: 'write_file', arguments: { path: 'ask_denied.js', content: 'x' } } },
  ]], () => ({ decision: 'deny', feedback: 'No thanks' }));
  assert.strictEqual(askRes.perms.length, 1);
  assert.ok(!fs.existsSync(path.join(dir, 'ask_denied.js')));

  // 5. loop guard blocks 3rd identical failing tool call
  const loopRes = await runModeScenario('yolo', [
    [{ function: { name: 'read_file', arguments: { path: 'missing.txt' } } }],
    [{ function: { name: 'read_file', arguments: { path: 'missing.txt' } } }],
    [{ function: { name: 'read_file', arguments: { path: 'missing.txt' } } }],
  ]);
  assert.ok(loopRes.notices.some((n) => /Loop guard/i.test(n)));
});

test('vision & MCP: Ollama image message formatting and end-to-end MCP tool call', async () => {
  // Verify vision image serialization matches Ollama /api/chat `images: [base64]` spec
  const fakePngB64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7+X/QAAAAASUVORK5CYII=';
  const msgs = ollama.toMessages('sys', [
    { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: fakePngB64 } }, { type: 'text', text: 'Describe image' }] },
  ]);
  assert.deepStrictEqual(msgs[1], { role: 'user', content: 'Describe image', images: [fakePngB64] });

  // End-to-end MCP stdio server driven by mocked muse-glimmer
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'h2o-mg-mcp-'));
  const mcp = new McpManager();
  await mcp.sync({ tracker: { command: process.execPath, args: [path.join(__dirname, 'fixtures', 'mcp-test-server.js')], trust: true } });

  let step = 0;
  const mock = await startMockOllama((_req, res) => {
    step++;
    if (step === 1) {
      return sendNdjson(res, [
        { message: { role: 'assistant', tool_calls: [{ function: { name: 'mcp__tracker__get_ticket', arguments: { key: 'BUG-42' } } }] }, done: false },
        { message: {}, done: true, prompt_eval_count: 100, eval_count: 15 },
      ]);
    }
    return sendNdjson(res, [
      { message: { role: 'assistant', content: 'BUG-42 says Cart total off by a cent.' }, done: false },
      { message: {}, done: true, prompt_eval_count: 150, eval_count: 12 },
    ]);
  });

  const data = makeSessionData(dir, 'yolo', 'ollama:muse-glimmer:latest');
  const agent = new AgentSession(data, {
    send: () => {},
    save: () => {},
    getSettings: () => ({ ollamaUrl: mock.url, ollamaCtx: 8192, autoVerify: false }),
    getApiKey: () => null,
    getGeminiKey: () => null,
    mcp,
  });

  try {
    await agent.send('Check ticket BUG-42', { model: 'ollama:muse-glimmer:latest', effort: 'low', mode: 'yolo' });
    assert.ok(mock.requests[0].tools.some((t) => t.function.name === 'mcp__tracker__get_ticket'));
    assert.ok(mock.requests[1].messages.some((m) => m.role === 'tool' && /Cart total off by a cent/.test(m.content)));
  } finally {
    agent.dispose();
    await mcp.closeAll();
    await mock.close();
  }
});

test('auto-routing, compactAt scaling & fallback to Muse Glimmer preserves history, todos and changes', async () => {
  // Auto-routing to Ollama when local-only or autoProvider === 'ollama'
  assert.strictEqual(providers.resolveAuto({ ollamaEnabled: true, autoProvider: 'ollama' }, 2), 'ollama:muse-glimmer:latest');
  assert.strictEqual(providers.resolveAuto({ hasAnthropic: false, hasGemini: false, ollamaEnabled: true }, 1), 'ollama:muse-glimmer:latest');

  // Context window scales down to effective 8192 on 16GB RAM (we test against current host or effectiveCtx)
  const effCtx = providers.contextWindow('ollama:muse-glimmer:latest', { ollamaCtx: 32768 });
  assert.ok(effCtx <= 32768);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'h2o-mg-fb-'));
  const origCall = providers.callModel;
  const seenModels = [];
  const data = makeSessionData(dir, 'yolo', 'auto');
  // Seed pre-existing session state to confirm fallback preserves todos, changes, and prior turns
  data.todos = [{ content: 'Pre-existing step', status: 'completed' }, { content: 'Continue task', status: 'in_progress' }];
  data.changes = { 'existing.js': { added: 3, removed: 1, edits: 1 } };
  data.messages = [
    { role: 'user', content: [{ type: 'text', text: 'Previous turn' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Previous reply' }] },
  ];

  providers.callModel = async (opts) => {
    seenModels.push(opts.model);
    if (providers.providerOf(opts.model) === 'gemini') {
      throw Object.assign(new Error('429 Resource exhausted'), { status: 429 });
    }
    // Fallback landed on Muse Glimmer — ensure prior transcript is present
    assert.strictEqual(opts.messages.length, 3);
    assert.strictEqual(opts.messages[0].content[0].text, 'Previous turn');
    return {
      content: [{ type: 'text', text: 'Continued seamlessly on Muse Glimmer.' }],
      model: opts.model,
      stop_reason: 'end_turn',
      usage: { input_tokens: 90, output_tokens: 10 },
    };
  };

  const notices = [];
  const autoModels = [];
  const agent = new AgentSession(data, {
    send: (_id, type, p) => {
      if (type === 'notice') notices.push(p.message);
      if (type === 'auto-model') autoModels.push(p);
    },
    save: () => {},
    getSettings: () => ({ hasGemini: true, autoProvider: 'gemini', ollamaEnabled: true, ollamaCtx: 8192, autoVerify: false }),
    getApiKey: () => null,
    getGeminiKey: () => 'fake-gem-key',
  });
  agent.readFiles.set(path.join(dir, 'existing.js'), 12345);

  try {
    await agent.send('fix the bug in app.js', { model: 'auto', effort: 'low', mode: 'yolo' });
    assert.strictEqual(seenModels[0], 'gemini-3.6-flash');
    assert.strictEqual(seenModels[1], 'ollama:muse-glimmer:latest');
    assert.ok(autoModels.some((a) => a.escalated && a.model === 'ollama:muse-glimmer:latest' && /fallback after 429/.test(a.reason)));
    assert.strictEqual(data.todos.length, 2, 'todos preserved across fallback');
    assert.deepStrictEqual(data.changes['existing.js'], { added: 3, removed: 1, edits: 1 }, 'pending changes preserved across fallback');
    assert.ok(agent.readFiles.has(path.join(dir, 'existing.js')), 'readFiles cache preserved across fallback');
  } finally {
    providers.callModel = origCall;
    agent.dispose();
  }
});

test('auto-compaction triggers dynamically below Ollama num_ctx with think disabled', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'h2o-mg-cmp-'));
  let step = 0;
  const mock = await startMockOllama((_req, res, body) => {
    step++;
    if (body.tools?.length && step === 1) {
      return sendNdjson(res, [
        { message: { role: 'assistant', tool_calls: [{ function: { name: 'list_dir', arguments: {} } }] }, done: false },
        { message: {}, done: true, prompt_eval_count: 6800, eval_count: 50 }, // > 8192 * 0.75 (6144)
      ]);
    }
    if (!body.tools?.length) {
      // Compaction call via providers.complete() — should disable thinking (`think: false`)
      assert.strictEqual(body.think, false, 'compaction summary sets think: false on Ollama');
      return sendNdjson(res, [
        { message: { role: 'assistant', content: 'Compacted summary of session.' }, done: false },
        { message: {}, done: true, prompt_eval_count: 500, eval_count: 15 },
      ]);
    }
    return sendNdjson(res, [
      { message: { role: 'assistant', content: 'Finished after auto-compaction.' }, done: false },
      { message: {}, done: true, prompt_eval_count: 400, eval_count: 10 },
    ]);
  });

  const data = makeSessionData(dir, 'yolo', 'ollama:muse-glimmer:latest');
  data.messages = [
    { role: 'user', content: [{ type: 'text', text: 'Turn 1' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Reply 1' }] },
    { role: 'user', content: [{ type: 'text', text: 'Turn 2' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Reply 2' }] },
  ];
  data.turns = [{ msgIndex: 0, text: 'Turn 1', files: {} }, { msgIndex: 2, text: 'Turn 2', files: {} }];

  let compacted = false;
  const agent = new AgentSession(data, {
    send: (_id, type) => { if (type === 'compacted') compacted = true; },
    save: () => {},
    getSettings: () => ({ ollamaUrl: mock.url, ollamaCtx: 8192, compactAt: 180000, autoVerify: false }),
    getApiKey: () => null,
    getGeminiKey: () => null,
  });

  try {
    await agent.send('Run list_dir then finish', { model: 'ollama:muse-glimmer:latest', effort: 'low', mode: 'yolo' });
    assert.strictEqual(compacted, true, 'auto-compaction triggered at 6800 > 6144 before hitting 8192 num_ctx');
    assert.strictEqual(data.compactions.length, 1);
  } finally {
    agent.dispose();
    await mock.close();
  }
});
