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

test('Stop hands undelivered steering back to the user instead of losing or resending it', async () => {
  const { agent, data, events } = session();
  providers.callModel = async ({ signal }) => {
    agent.steer('actually use blue');
    setTimeout(() => agent.stop(), 10);
    await new Promise((r, j) => { const t = setTimeout(r, 2000); signal.addEventListener('abort', () => { clearTimeout(t); j(new Error('aborted')); }); });
    return { content: [{ type: 'text', text: 'never' }], model: 'fake', stop_reason: 'end_turn', usage: {} };
  };
  try {
    await agent.send('paint it', opts);
    const back = events.find((e) => e.type === 'steer-returned');
    assert.equal(back?.text, 'actually use blue');
    assert.ok(!events.some((e) => e.type === 'steer-resend'), 'not resent after a Stop');
    assert.ok(!JSON.stringify(data.messages).includes('actually use blue'), 'never sent to the model');
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(agent.busy, false, 'no new turn started');
  } finally { agent.dispose(); providers.callModel = realCallModel; }
});

test('a short outage is retried; a quota error is not', { timeout: 30_000 }, async () => {
  let chats = 0, mode = 'outage';
  const srv = http.createServer((req, res) => {
    req.resume(); // the mock answers without reading the request
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

test('steering that misses the final answer runs next, ahead of a queued message, and is never dropped', async () => {
  const { TaskManager } = require('../src/main/tasks');
  const { agent, data } = session();
  const tm = new TaskManager({ getAgent: () => agent, sendEvent: () => {}, store: null });
  const lost = [];
  agent.deps.send = (id, type, p) => { if (type === 'steer-returned') lost.push(p); };
  agent.deps.resend = (sid, text, o, images) => tm.submitTask({ session_id: sid, workspace_id: data.projectDir, prompt: text, images, opts: o }, { action: 'queue', front: true });
  const seen = [];
  providers.callModel = async ({ messages }) => {
    seen.push(textOf(messages[messages.length - 1]));
    return { content: [{ type: 'text', text: 'Done.' }], model: 'fake', stop_reason: 'end_turn', usage: {} };
  };
  // Typed after the model's final answer but before the turn ended (during the last checks): too late for it.
  const finish = agent.finish.bind(agent);
  let once = true;
  agent.finish = (o) => { if (once) { once = false; agent.steer('also update the docs'); } return finish(o); };
  try {
    await tm.submitTask({ session_id: 's', workspace_id: data.projectDir, prompt: 'first task', opts }, { action: 'queue' });
    // A message queued (Ctrl+Enter) while the first task runs.
    await tm.submitTask({ session_id: 's', workspace_id: data.projectDir, prompt: 'queued task', opts }, { action: 'queue' });
    for (let i = 0; i < 100 && (seen.length < 3 || agent.busy); i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(seen.length, 3, `three turns ran: ${JSON.stringify(seen)}`);
    assert.match(seen[0], /first task/);
    assert.match(seen[1], /also update the docs/, 'the steering runs right after the turn it missed');
    assert.match(seen[2], /queued task/);
    assert.deepEqual(lost, [], 'nothing handed back');
  } finally { agent.dispose(); providers.callModel = realCallModel; }
});

test('rewind also undoes what shell commands changed, but keeps files the user edited afterwards', { timeout: 60_000 }, async () => {
  const cp = require('node:child_process');
  const { agent, data } = session();
  const dir = data.projectDir;
  cp.execSync('git init -q && git config user.email t@t && git config user.name t && git add -A && git commit -qm init', { cwd: dir });
  fs.writeFileSync(path.join(dir, 'user.txt'), 'mine\n');
  const write = (f, t) => `node -e "require('fs').writeFileSync('${f}','${t}')"`;
  let call = 0;
  providers.callModel = async () => {
    call++;
    if (call === 1) return { content: [{ type: 'tool_use', id: 'c1', name: 'shell', input: { command: `${write('a.txt', 'by shell')} ; ${write('gen.txt', 'generated')} ; ${write('user.txt', 'shell too')}` } }], model: 'fake', stop_reason: 'tool_use', usage: {} };
    return { content: [{ type: 'text', text: 'Done.' }], model: 'fake', stop_reason: 'end_turn', usage: {} };
  };
  try {
    await agent.send('run the generator', opts);
    assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'by shell', 'the command ran');
    assert.ok(data.turns[0].snap, 'a snapshot was taken before the turn');
    await agent.endSnap;
    fs.writeFileSync(path.join(dir, 'user.txt'), 'the user changed it again\n'); // after the turn
    const r = await agent.rewind(0);
    assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8').replace(/\r\n/g, '\n'), 'hello\n', 'shell edit undone');
    assert.ok(!fs.existsSync(path.join(dir, 'gen.txt')), 'file the shell created is removed');
    assert.equal(fs.readFileSync(path.join(dir, 'user.txt'), 'utf8'), 'the user changed it again\n', 'the user\'s later edit is kept');
    assert.deepEqual(r.kept, ['user.txt']);
  } finally { agent.dispose(); providers.callModel = realCallModel; }
});

test('a scheduled run is not held forever by a question nobody answers', { timeout: 30_000 }, async () => {
  const { agent, data, events } = session({ scheduleAnswerMinutes: 0.002 }); // about 0.1 s
  data.scheduleId = 'nightly';
  let call = 0;
  providers.callModel = async () => {
    call++;
    if (call === 1) return { content: [{ type: 'tool_use', id: 'c1', name: 'shell', input: { command: 'npm publish' } }], model: 'fake', stop_reason: 'tool_use', usage: {} };
    return { content: [{ type: 'text', text: 'Skipped publishing: it needs you.' }], model: 'fake', stop_reason: 'end_turn', usage: {} };
  };
  try {
    await agent.send('release it', { model: 'claude-opus-5-5', effort: 'low', mode: 'auto-edit' });
    assert.ok(events.some((e) => e.type === 'permission'), 'it asked');
    assert.ok(events.some((e) => e.type === 'notice' && /Nobody answered within/.test(e.message)));
    const result = data.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).find((b) => b.type === 'tool_result');
    assert.match(String(result.content), /scheduled run and the user is away/);
    assert.equal(agent.busy, false, 'the run finished');
  } finally { agent.dispose(); providers.callModel = realCallModel; }
});

test('withFileLocks serializes same-file edits and allows different files in parallel', async () => {
  const { agent } = session();
  try {
    const order = [];
    let sameActive = 0;
    let maxSameActive = 0;
    const lockA1 = agent.withFileLocks(agent.editLockKeys('edit_file', { path: 'a.txt' }), null, async () => {
      sameActive++; maxSameActive = Math.max(maxSameActive, sameActive);
      order.push('a1-start');
      await new Promise((r) => setTimeout(r, 35));
      order.push('a1-end');
      sameActive--;
    });
    const lockA2 = agent.withFileLocks(agent.editLockKeys('write_file', { path: './a.txt' }), null, async () => {
      sameActive++; maxSameActive = Math.max(maxSameActive, sameActive);
      order.push('a2-start');
      await new Promise((r) => setTimeout(r, 10));
      order.push('a2-end');
      sameActive--;
    });
    let bRanWhileAHeld = false;
    const lockB = agent.withFileLocks(agent.editLockKeys('edit_file', { path: 'b.txt' }), null, async () => {
      if (sameActive > 0) bRanWhileAHeld = true;
      order.push('b');
    });
    await Promise.all([lockA1, lockA2, lockB]);
    assert.equal(maxSameActive, 1, 'same-file locks never overlap');
    assert.equal(bRanWhileAHeld, true, 'unrelated file proceeds without waiting');
    assert.ok(order.indexOf('a1-end') < order.indexOf('a2-start'), `serialized order: ${order.join(',')}`);
  } finally { agent.dispose(); }
});

test('parallel edit subagents isolate readFiles so one worker cannot silently overwrite another', async () => {
  const { agent, data } = session();
  const file = path.join(data.projectDir, 'shared.txt');
  fs.writeFileSync(file, 'line1\nline2\n');
  let worker1Step = 0;
  let worker2Step = 0;
  let worker2EditError = '';
  providers.callModel = async ({ system, messages }) => {
    const last = messages[messages.length - 1];
    const promptText = Array.isArray(last?.content) ? last.content.map((b) => b.text || b.content || '').join(' ') : String(last?.content || '');
    if (!system.includes('You are an edit sub-agent')) {
      if (messages.length === 1) {
        return {
          content: [
            { type: 'tool_use', id: 'w1', name: 'task', input: { description: 'edit 1', mode: 'edit', prompt: 'WORKER_ONE' } },
            { type: 'tool_use', id: 'w2', name: 'task', input: { description: 'edit 2', mode: 'edit', prompt: 'WORKER_TWO' } },
          ],
          model: 'fake', stop_reason: 'tool_use', usage: {},
        };
      }
      return { content: [{ type: 'text', text: 'All done.' }], model: 'fake', stop_reason: 'end_turn', usage: {} };
    }
    const firstUser = messages[0]?.content?.[0]?.text || '';
    if (firstUser.includes('WORKER_ONE')) {
      worker1Step++;
      if (worker1Step === 1) return { content: [{ type: 'tool_use', id: 'r1', name: 'read_file', input: { path: 'shared.txt' } }], model: 'fake', stop_reason: 'tool_use', usage: {} };
      if (worker1Step === 2) {
        await new Promise((r) => setTimeout(r, 25)); // let worker 2 read before worker 1 writes
        return { content: [{ type: 'tool_use', id: 'e1', name: 'write_file', input: { path: 'shared.txt', content: 'worker1\nline2\n' } }], model: 'fake', stop_reason: 'tool_use', usage: {} };
      }
      return { content: [{ type: 'text', text: 'worker1 done' }], model: 'fake', stop_reason: 'end_turn', usage: {} };
    }
    if (firstUser.includes('WORKER_TWO')) {
      worker2Step++;
      if (worker2Step === 1) return { content: [{ type: 'tool_use', id: 'r2', name: 'read_file', input: { path: 'shared.txt' } }], model: 'fake', stop_reason: 'tool_use', usage: {} };
      if (worker2Step === 2) {
        await new Promise((r) => setTimeout(r, 60)); // attempt write after worker 1 wrote
        return { content: [{ type: 'tool_use', id: 'e2', name: 'write_file', input: { path: 'shared.txt', content: 'worker2\nline2\n' } }], model: 'fake', stop_reason: 'tool_use', usage: {} };
      }
      if (worker2Step === 3) {
        worker2EditError = promptText;
        return { content: [{ type: 'text', text: 'worker2 saw conflict' }], model: 'fake', stop_reason: 'end_turn', usage: {} };
      }
    }
    return { content: [{ type: 'text', text: 'done' }], model: 'fake', stop_reason: 'end_turn', usage: {} };
  };
  try {
    await agent.send('run two edit workers', opts);
    assert.match(worker2EditError, /changed since you read it|Read.*before/i, `worker 2 should be blocked from stale overwrite, got: ${worker2EditError}`);
    assert.equal(fs.readFileSync(file, 'utf8'), 'worker1\nline2\n', 'worker 1 edit was preserved');
  } finally { agent.dispose(); providers.callModel = realCallModel; }
});
