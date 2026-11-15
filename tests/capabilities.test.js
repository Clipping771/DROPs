// Run: npm test — ask_user, command rules, after-edit hook, web search gating, custom commands.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const shell = require('../src/main/shell');
const tools = require('../src/main/tools');
const { parseCommandFile, listCommands } = require('../src/main/commands');

test('command rules: allow matches one plain command, deny matches any part of a chain', () => {
  const allow = shell.parseRules('npm test*\n# comment\n\ngit status');
  assert.deepStrictEqual(allow, ['npm test*', 'git status']);
  assert.strictEqual(shell.matchRule(allow, 'npm test -- --watch=false'), 'npm test*');
  assert.strictEqual(shell.matchRule(allow, 'GIT   status'), 'git status');
  assert.strictEqual(shell.matchRule(allow, 'npm test; curl http://x'), null, 'allow never approves a chain');
  assert.strictEqual(shell.matchRule(allow, 'npm test && rm -rf src'), null);
  assert.strictEqual(shell.matchRule(allow, 'npm run build'), null);
  const deny = shell.parseRules('git push*');
  assert.strictEqual(shell.matchRule(deny, 'npm test && git push origin main', { anySegment: true }), 'git push*');
  assert.strictEqual(shell.matchRule(deny, 'git status', { anySegment: true }), null);
  assert.strictEqual(shell.matchRule([], 'anything'), null);
});

test('web search: DuckDuckGo result pages are parsed into titles, urls and snippets', () => {
  const html = `<div class="result"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnodejs.org%2Fapi%2Ffs.html&amp;rut=x">File system | <b>Node.js</b></a>
    <a class="result__snippet" href="#">The <b>fs</b> module &amp; friends</a></div>
    <div class="result"><a class="result__a" href="https://example.com/b">Second</a></div>`;
  const r = tools.parseDuckResults(html);
  assert.strictEqual(r.length, 2);
  assert.deepStrictEqual(r[0], { title: 'File system | Node.js', url: 'https://nodejs.org/api/fs.html', snippet: 'The fs module & friends' });
  assert.strictEqual(r[1].url, 'https://example.com/b');
});

test('custom commands: file name, front matter, project wins over user', () => {
  assert.deepStrictEqual(parseCommandFile('Review PR.md', '---\ndescription: Review a PR\n---\nReview $ARGUMENTS carefully.'),
    { name: 'review-pr', description: 'Review a PR', prompt: 'Review $ARGUMENTS carefully.' });
  assert.strictEqual(parseCommandFile('x.md', '# Explain the build\nDetails').description, 'Explain the build');
  assert.strictEqual(parseCommandFile('empty.md', '---\ndescription: d\n---\n   '), null);
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'h2o-cmd-'));
  try {
    const proj = path.join(base, 'proj'), user = path.join(base, 'user');
    fs.mkdirSync(path.join(proj, '.h2o', 'commands'), { recursive: true }); fs.mkdirSync(user);
    fs.writeFileSync(path.join(proj, '.h2o', 'commands', 'ship.md'), 'Project ship');
    fs.writeFileSync(path.join(user, 'ship.md'), 'User ship');
    fs.writeFileSync(path.join(user, 'notes.md'), 'User notes');
    fs.writeFileSync(path.join(user, 'skip.txt'), 'not a command');
    const list = listCommands(proj, user);
    assert.deepStrictEqual(list.map((c) => [c.name, c.source, c.prompt]), [['ship', 'project', 'Project ship'], ['notes', 'user', 'User notes']]);
    assert.deepStrictEqual(listCommands(null, path.join(base, 'missing')), []);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

// ---- agent loop with a scripted model ----
function scripted(script, settings = {}, onEvent = () => {}) {
  const providers = require('../src/main/providers');
  const { AgentSession } = require('../src/main/agent');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'h2o-cap-'));
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  let i = 0;
  const orig = providers.callModel;
  providers.callModel = async () => {
    const s = script[i++];
    const content = s ? [{ type: 'tool_use', id: 't' + i, name: s.tool, input: s.input }] : [{ type: 'text', text: 'done' }];
    return { content, model: 'fake', stop_reason: s ? 'tool_use' : 'end_turn', usage: {} };
  };
  const data = { id: 'c', title: 'New session', projectDir: dir, messages: [], archive: [], compactions: [], turns: [], toolMeta: {}, todos: [], changes: {}, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, context: 0, requests: 0 } };
  const events = [];
  let agent;
  agent = new AgentSession(data, {
    send: (_id, type, p) => { events.push({ type, ...p }); onEvent(agent, type, p); },
    save: () => {}, getSettings: () => ({ autoVerify: false, ...settings }), getApiKey: () => 'x', getGeminiKey: () => null,
  });
  const results = () => data.messages.filter((m) => m.role === 'user' && Array.isArray(m.content)).flatMap((m) => m.content).filter((b) => b.type === 'tool_result');
  const done = () => { providers.callModel = orig; agent.dispose(); fs.rmSync(dir, { recursive: true, force: true }); };
  return { agent, data, dir, events, results, done };
}

test('agent: ask_user shows the question and returns the answer (or lets the agent assume)', async () => {
  const answers = [['answer', 'Use PostgreSQL'], ['skip', '']];
  const t = scripted([
    { tool: 'ask_user', input: { question: 'Which database?', options: ['PostgreSQL', 'SQLite'] } },
    { tool: 'ask_user', input: { question: 'Add tests?' } },
  ], {}, (agent, type, p) => { if (type === 'question') { const [d, f] = answers.shift(); setImmediate(() => agent.respond(p.reqId, d, f)); } });
  try {
    await t.agent.send('set up storage', { model: 'claude-opus-5-5', effort: 'low', mode: 'yolo' });
    const qs = t.events.filter((e) => e.type === 'question');
    assert.strictEqual(qs.length, 2, 'asked even in Full auto: the user is the one deciding');
    assert.deepStrictEqual(qs[0].options, ['PostgreSQL', 'SQLite']);
    const r = t.results();
    assert.match(r[0].content, /The user answered: Use PostgreSQL/);
    assert.match(r[1].content, /did not answer.*assumption/);
  } finally { t.done(); }
});

test('agent: deny rules block, allow rules skip the prompt, dangerous commands still ask', async () => {
  const perms = [];
  const t = scripted([
    { tool: 'shell', input: { command: 'node -e "process.stdout.write(\'ALLOWED-RAN\')"' } },
    { tool: 'shell', input: { command: 'node --version && git push origin main' } },
    { tool: 'shell', input: { command: 'node -e "1" ; node -e "2"' } },
  ], { allowCommands: 'node -e*', denyCommands: 'git push*' }, (agent, type, p) => { if (type === 'permission') { perms.push(p.input.command); setImmediate(() => agent.respond(p.reqId, 'deny')); } });
  try {
    await t.agent.send('run things', { model: 'claude-opus-5-5', effort: 'low', mode: 'ask' });
    const r = t.results();
    assert.match(String(r[0].content), /ALLOWED-RAN/, 'allowed command ran without a prompt');
    assert.match(String(r[1].content), /Blocked by your deny rule "git push\*"/);
    assert.deepStrictEqual(perms, ['node -e "1" ; node -e "2"'], 'a chained command is not covered by the allow rule');
  } finally { t.done(); }
});

test('agent: after-edit hook runs with the changed file and reports back', async () => {
  const t = scripted([
    { tool: 'read_file', input: { path: 'a.txt' } },
    { tool: 'edit_file', input: { path: 'a.txt', old_string: 'one', new_string: 'two' } },
  ], { afterEditCommand: 'node -e "process.stdout.write(\'HOOK:\' + process.argv[1])" {file}' });
  try {
    await t.agent.send('edit it', { model: 'claude-opus-5-5', effort: 'low', mode: 'yolo' });
    const edit = String(t.results()[1].content);
    assert.match(edit, /\[after-edit hook\].*exited 0/);
    assert.match(edit, /HOOK:a\.txt/);
    assert.strictEqual(fs.readFileSync(path.join(t.dir, 'a.txt'), 'utf8'), 'two\n');
  } finally { t.done(); }
});

test('agent: web_search asks before sending a query', async () => {
  const t = scripted([{ tool: 'web_search', input: { query: 'secret project details' } }], {},
    (agent, type, p) => { if (type === 'permission') setImmediate(() => agent.respond(p.reqId, 'deny')); });
  try {
    await t.agent.send('look it up', { model: 'claude-opus-5-5', effort: 'low', mode: 'auto-edit' });
    const perm = t.events.find((e) => e.type === 'permission');
    assert.strictEqual(perm?.kind, 'search');
    assert.match(String(t.results()[0].content), /denied this web search/);
  } finally { t.done(); }
});

test('edit_file: tolerates indentation/spacing slips, and points to the closest lines when it cannot match', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'h2o-fz-'));
  try {
    const file = path.join(dir, 'app.js');
    fs.writeFileSync(file, 'function total(items) {\n    let sum = 0;\n    for (const i of items) {\n        sum += i.price;\n    }\n    return sum;\n}\n');
    const ctx = { root: dir, readFiles: new Map(), snapshot: async () => {}, onChange: () => {} };
    await (await tools.prepare(ctx, 'read_file', { path: 'app.js' })).run();
    // Model used 2-space indentation instead of 4.
    const p = await tools.prepare(ctx, 'edit_file', { path: 'app.js', old_string: '  for (const i of items) {\n      sum += i.price;\n  }', new_string: '  for (const i of items) {\n      sum += i.price * i.qty;\n  }' });
    const out = await p.run();
    assert.match(out, /matched app\.js:3 ignoring whitespace differences/);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), 'function total(items) {\n    let sum = 0;\n    for (const i of items) {\n        sum += i.price * i.qty;\n    }\n    return sum;\n}\n');
    // Wrong text: the error shows the nearest lines with numbers.
    await assert.rejects(tools.prepare(ctx, 'edit_file', { path: 'app.js', old_string: 'return total;', new_string: 'return sum + 1;' }),
      (e) => /not found in app\.js\. The closest text in the file is:[\s\S]*\d+\t\s*return sum;/.test(e.message) || assert.fail(e.message));
    // Exact duplicates name their lines.
    fs.writeFileSync(file, 'a = 1;\nb = 2;\na = 1;\n');
    await (await tools.prepare(ctx, 'read_file', { path: 'app.js' })).run();
    await assert.rejects(tools.prepare(ctx, 'edit_file', { path: 'app.js', old_string: 'a = 1;', new_string: 'a = 3;' }), /appears 2 times in app\.js \(lines 1, 3\)/);
    // Missing path explains itself.
    assert.match(tools.validate('edit_file', { old_string: 'x', new_string: 'y' }), /missing required field "path" \(File path relative to the project root/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('agent: after doing work without saying anything, the agent is asked once for a final answer', async () => {
  const t = scripted([{ tool: 'read_file', input: { path: 'a.txt' } }]);
  const providers = require('../src/main/providers');
  const prev = providers.callModel;
  let calls = 0;
  providers.callModel = async (args) => {
    calls++;
    if (calls === 1) return prev(args);                                   // read_file
    if (calls === 2) return { content: [], model: 'fake', stop_reason: 'end_turn', usage: {} }; // silent finish
    return { content: [{ type: 'text', text: 'a.txt contains one line: "one". Nothing was changed.' }], model: 'fake', stop_reason: 'end_turn', usage: {} };
  };
  try {
    await t.agent.send('what is in a.txt?', { model: 'claude-opus-5-5', effort: 'low', mode: 'yolo' });
    assert.strictEqual(calls, 3, 'one extra turn for the report, no more');
    const nudges = t.data.messages.filter((m) => JSON.stringify(m.content).includes('[DROPs report]'));
    assert.strictEqual(nudges.length, 1);
    const last = t.data.messages[t.data.messages.length - 1];
    assert.match(JSON.stringify(last.content), /a\.txt contains one line/);
  } finally { t.done(); }
});

test('gemini: when every model is rate-limited, wait and try again; give up after the last wait; stop on abort', async () => {
  const gemini = require('../src/main/gemini');
  const notices = [];
  const base = { model: 'gemini-3.6-flash', emit: (_t, p) => notices.push(p.message) };
  // Fails every model in round 1, succeeds in round 2.
  let calls = 0;
  const n = gemini.FALLBACKS.length;
  const once = async ({ model }) => { calls++; if (calls <= n) throw new gemini.Unavailable('quota/rate limit reached'); return { content: [], model }; };
  const ok = await gemini.streamTurn({ ...base, signal: new AbortController().signal }, { waits: [0.01, 0.01], once });
  assert.ok(ok.model);
  assert.ok(notices.some((m) => /waiting 0\.01s before trying again \(1\/2\)/.test(m)));
  // Always failing: gives up after the waits are used.
  const fail = async () => { throw new gemini.Unavailable('quota/rate limit reached'); };
  await assert.rejects(gemini.streamTurn({ ...base, signal: new AbortController().signal }, { waits: [0.01], once: fail }), /busy or over quota/);
  // A model missing for this key is dropped from later rounds.
  const seen = [];
  const missing = async ({ model }) => { seen.push(model); throw new gemini.Unavailable(model === 'gemini-3.6-flash' ? 'not available for this key' : 'overloaded'); };
  await assert.rejects(gemini.streamTurn({ ...base, signal: new AbortController().signal }, { waits: [0.01], once: missing }));
  assert.strictEqual(seen.filter((m) => m === 'gemini-3.6-flash').length, 1);
  // Stop during the wait ends at once.
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 30);
  const t0 = Date.now();
  await assert.rejects(gemini.streamTurn({ ...base, signal: ac.signal }, { waits: [30], once: fail }), /aborted/);
  assert.ok(Date.now() - t0 < 5000);
});

test('openai-compatible providers: wait and retry on 429/503 before output; no retry after output or on a daily cap', async () => {
  const oai = require('../src/main/oai');
  const base = { model: 'openrouter:vendor/model:free', emit: () => {}, signal: new AbortController().signal };
  const err = (status, message = 'x') => Object.assign(new Error(message), { status });
  // Two rate limits, then success.
  let n = 0;
  const notices = [];
  const r = await oai.streamTurn({ ...base, emit: (t, p) => t === 'notice' && notices.push(p.message) }, { waits: [0.01, 0.01, 0.01], once: async () => { if (++n <= 2) throw err(429); return { content: [], model: 'm' }; } });
  assert.strictEqual(r.model, 'm');
  assert.strictEqual(n, 3);
  assert.match(notices[0], /rate limit reached; waiting 0\.01s before trying again \(1\/3\)/);
  // Gives up after the last wait.
  await assert.rejects(oai.streamTurn(base, { waits: [0.01], once: async () => { throw err(503); } }), (e) => e.status === 503);
  // Never retries once text has been streamed.
  let m = 0;
  await assert.rejects(oai.streamTurn(base, { waits: [0.01, 0.01], once: async ({ emit }) => { m++; emit('text-delta', { text: 'hi' }); throw err(503); } }));
  assert.strictEqual(m, 1);
  // A daily cap is reported clearly instead of waited for.
  let d = 0;
  await assert.rejects(oai.streamTurn(base, { waits: [0.01, 0.01], once: async () => { d++; throw err(429, 'Rate limit exceeded: free-models-per-day'); } }), /daily limit for this model reached/);
  assert.strictEqual(d, 1);
  // Other errors pass straight through.
  await assert.rejects(oai.streamTurn(base, { waits: [0.01], once: async () => { throw err(401); } }), (e) => e.status === 401);
});
