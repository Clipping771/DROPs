// Evidence checks: QA facts from the spec, a stopped app, a disputed QA check, and the final count.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

process.env.APPDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'drops-evidence-test-'));
const providers = require('../src/main/providers');
const { AgentSession, specFacts, evidenceNudgeAllowed } = require('../src/main/agent');
const realCallModel = providers.callModel;

const SPEC = [
  '# Shop', 'The app runs at http://localhost:3000.',
  '- Users: `Ada Admin` – `admin@shop.test` – `Admin12345`',
  '- Customer contact: `Nancy`, email `nancy@north.test`, company `Northwind`.',
  'Pages: `/login`, `/products`. Test ids: `login-email`, `login-password`, `login-submit`, `product-row`.',
  '| FR-1 | Admin logs in |', '| FR-2 | Products list |', '| FR-3 | c |', '| FR-4 | d |',
].join('\n');

test('spec facts: real accounts only, routes, test ids and the base URL', () => {
  const f = specFacts(SPEC);
  assert.deepEqual(f.accounts, [{ email: 'admin@shop.test', password: 'Admin12345' }], 'a contact email is not an account');
  assert.ok(f.routes.includes('/login') && f.routes.includes('/products'));
  assert.ok(f.testIds.includes('login-submit'));
  assert.equal(f.base, 'http://localhost:3000');
  assert.deepEqual(specFacts('password: hunter22 for bob@x.test on localhost:5173').accounts, [{ email: 'bob@x.test', password: 'hunter22' }]);
  assert.equal(specFacts('localhost:5173').base, 'http://localhost:5173');
});

test('evidence guard: gives up after two fruitless nudges, but keeps going while checks make progress', () => {
  const reqs = [{ status: 'failed' }, { status: 'failed' }];
  const run = { checkCalls: 1 }; // checks were run, they just did not pass
  const nudge = () => { const ok = evidenceNudgeAllowed(run, reqs); if (ok) { run.evidenceNudges = (run.evidenceNudges || 0) + 1; run.evidenceTotalNudges = (run.evidenceTotalNudges || 0) + 1; run.evidenceVerifiedAtNudge = reqs.filter((r) => r.status === 'verified').length; } return ok; };
  assert.equal(nudge(), true);
  assert.equal(nudge(), true);
  assert.equal(nudge(), false, 'two nudges with no progress: stop');
  reqs[0].status = 'verified';
  assert.equal(nudge(), true, 'a new verified requirement earns more nudges');
  reqs[1].status = 'verified';
  assert.equal(nudge(), false, 'everything verified: nothing to nudge');
});

function agentFor(dir, script, qa, extra = {}) {
  let i = 0;
  const notices = [];
  providers.callModel = async ({ tools, system, messages }) => {
    if (!tools.length && /adversarial QA engineer/.test(system)) return { content: [{ type: 'text', text: JSON.stringify(qa.attacks || []) }], usage: {} };
    if (!tools.length && /independent QA engineer/.test(system)) {
      if (/disputes it/.test(system)) return { content: [{ type: 'text', text: JSON.stringify(qa.revision) }], usage: {} };
      qa.seenPrompt = messages[0].content[0].text;
      return { content: [{ type: 'text', text: JSON.stringify(qa.checks) }], usage: {} };
    }
    const st = script[i++] || { text: 'Done.' };
    return { content: st.tool ? [{ type: 'tool_use', id: 't' + i, name: st.tool, input: st.input }] : [{ type: 'text', text: st.text }], model: 'fake', stop_reason: st.tool ? 'tool_use' : 'end_turn', usage: {} };
  };
  const data = { id: 's', title: 'New session', projectDir: dir, messages: [], archive: [], compactions: [], turns: [], toolMeta: {}, todos: [], changes: {}, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, context: 0, requests: 0 } };
  const agent = new AgentSession(data, {
    send: (id, type, p) => { if (type === 'notice') notices.push(p.message); }, save: () => {},
    getSettings: () => ({ autoVerify: false, qaAgent: true, completionAudit: false, evidenceCheck: true, ...extra }), getApiKey: () => 'x', getGeminiKey: () => 'x',
  });
  return { agent, data, notices };
}
const resultsText = (data) => JSON.stringify(data.messages);

test('QA gets the spec facts; a stopped app is "not checked", not a failed requirement', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drops-ev-'));
  fs.writeFileSync(path.join(dir, 'SPEC.md'), SPEC.replace('localhost:3000', 'localhost:19')); // nothing listens on port 19
  const qa = { checks: [{ id: 'FR-2', kind: 'http', url: 'http://localhost:19/api/products', expect: 'Pen' }] };
  const { agent, data, notices } = agentFor(dir, [
    { tool: 'write_file', input: { path: 'a.js', content: '1;\n' } },
    { tool: 'check_requirement', input: { id: 'FR-2', use_qa: true } },
    { text: 'Done.' },
  ], qa);
  try {
    await agent.send('Build the app in SPEC.md', { model: 'claude-opus-5-5', effort: 'low', mode: 'yolo' });
    assert.match(qa.seenPrompt, /Demo accounts named in the specification: admin@shop\.test \/ Admin12345/);
    assert.match(qa.seenPrompt, /Base URL: http:\/\/localhost:19\b/);
    assert.match(resultsText(data), /Not checked: the app is not running at http:\/\/localhost:19\b/);
    assert.notEqual(data.requirements.find((r) => r.id === 'FR-2').status, 'failed', 'a stopped app does not fail the requirement');
    assert.ok(notices.some((n) => /^Evidence: 0 of 4 requirements verified/.test(n)), notices.join('\n'));
    assert.deepEqual({ verified: data.evidenceSummary.verified, total: data.evidenceSummary.total }, { verified: 0, total: 4 });
  } finally { agent.dispose(); providers.callModel = realCallModel; }
});

test('a disputed QA check is re-read by the QA agent once; the revised check can verify', async () => {
  const srv = http.createServer((q, r) => { r.writeHead(200, { 'content-type': 'text/plain' }); r.end(q.url === '/api/items' ? 'Pen, Pencil' : 'home'); });
  await new Promise((r) => srv.listen(0, r));
  const port = srv.address().port;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drops-ev-'));
  fs.writeFileSync(path.join(dir, 'SPEC.md'), SPEC.replace('localhost:3000', `localhost:${port}`));
  const qa = {
    checks: [{ id: 'FR-2', kind: 'http', url: `http://localhost:${port}/api/products`, expect: 'Pen' }],
    revision: { decision: 'revise', reason: 'the spec lists items at /api/items', check: { kind: 'http', url: `http://localhost:${port}/api/items`, expect: 'Pen' } },
  };
  const { agent, data } = agentFor(dir, [
    { tool: 'write_file', input: { path: 'a.js', content: '1;\n' } },
    { tool: 'check_requirement', input: { id: 'FR-2', use_qa: true } },
    { tool: 'check_requirement', input: { id: 'FR-2', use_qa: true, dispute: 'The spec serves the list at /api/items, not /api/products.' } },
    { tool: 'check_requirement', input: { id: 'FR-2', use_qa: true, dispute: 'again' } },
    { tool: 'check_requirement', input: { id: 'FR-2', use_qa: true } },
    { text: 'Done.' },
  ], qa);
  try {
    await agent.send('Build the app in SPEC.md', { model: 'claude-opus-5-5', effort: 'low', mode: 'yolo' });
    const all = resultsText(data);
    assert.match(all, /FR-2 NOT verified \(QA http\): HTTP 200, expected text NOT found/);
    assert.match(all, /QA agent reviewed the dispute on FR-2: revised/);
    assert.match(all, /already revised once/);
    assert.match(all, /FR-2 VERIFIED \(QA http\)/);
    assert.equal(data.requirements.find((r) => r.id === 'FR-2').status, 'verified');
  } finally { agent.dispose(); srv.close(); providers.callModel = realCallModel; }
});

test('freshness: a requirement verified before a later change is re-checked by DROPs; if the app broke, it is no longer verified', async () => {
  let healthy = true;
  const srv = http.createServer((q, r) => { r.writeHead(200, { 'content-type': 'text/plain' }); r.end(q.url === '/api/items' && healthy ? 'Pen, Pencil' : 'oops'); });
  await new Promise((r) => srv.listen(0, r));
  const port = srv.address().port;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drops-ev-'));
  fs.writeFileSync(path.join(dir, 'SPEC.md'), SPEC.replace('localhost:3000', `localhost:${port}`));
  const qa = { checks: [{ id: 'FR-2', kind: 'http', url: `http://localhost:${port}/api/items`, expect: 'Pen' }] };
  const { agent, data, notices } = agentFor(dir, [
    { tool: 'write_file', input: { path: 'a.js', content: '1;\n' } },
    { tool: 'check_requirement', input: { id: 'FR-2', use_qa: true } },
    { tool: 'write_file', input: { path: 'b.js', content: '2;\n' } }, // a later change (it "breaks" the app)
    { text: 'Done.' },
    { text: 'Done again.' },
  ], qa);
  const realWrite = agent.runOne?.bind(agent);
  try {
    // The second edit breaks the app.
    const origEmit = agent.emit.bind(agent);
    agent.emit = (type, p) => { if (type === 'tool-end' && /Created b\.js/.test(p?.output || '')) healthy = false; return origEmit(type, p); };
    await agent.send('Build the app in SPEC.md', { model: 'claude-opus-5-5', effort: 'low', mode: 'yolo' });
    const fr2 = data.requirements.find((r) => r.id === 'FR-2');
    assert.ok(notices.some((n) => /code changed after 1 requirement was verified/.test(n)), notices.join('\n'));
    assert.equal(fr2.status, 'failed', 'the stale proof was re-run against the changed code and failed');
    assert.ok(notices.some((n) => /no longer verified/.test(n)));
    assert.ok(fr2.evidence.fingerprint, 'the proof records which code it belongs to');
  } finally { agent.dispose(); srv.close(); providers.callModel = realCallModel; void realWrite; }
});

test('adversarial QA: an app that accepts misuse is not verified; once it refuses, the requirement is verified', async () => {
  let refuses = false;
  const srv = http.createServer((q, r) => {
    if (q.url === '/api/admin') { r.writeHead(refuses ? 403 : 200, { 'content-type': 'text/plain' }); return r.end(refuses ? 'forbidden' : 'all users: ada, rita'); }
    r.writeHead(200, { 'content-type': 'text/plain' }); r.end('Pen, Pencil');
  });
  await new Promise((r) => srv.listen(0, r));
  const port = srv.address().port;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drops-ev-'));
  fs.writeFileSync(path.join(dir, 'SPEC.md'), SPEC.replace('localhost:3000', `localhost:${port}`));
  const qa = {
    checks: [{ id: 'FR-2', kind: 'http', url: `http://localhost:${port}/api/items`, expect: 'Pen' }],
    attacks: [
      { id: 'FR-2', kind: 'http', url: `http://localhost:${port}/api/admin`, expect_status: 403, forbid: 'rita', why: 'a visitor must not list users' },
      { id: 'FR-2', kind: 'http', url: 'http://evil.example/x', expect_status: 403 }, // not the local app: dropped
      { id: 'FR-9', kind: 'http', url: `http://localhost:${port}/x`, expect_status: 401 }, // unknown requirement: dropped
    ],
  };
  const { agent, data, notices } = agentFor(dir, [
    { tool: 'write_file', input: { path: 'a.js', content: '1;\n' } },
    { tool: 'check_requirement', input: { id: 'FR-2', use_qa: true } },
    { tool: 'check_requirement', input: { id: 'FR-2', use_qa: true } },
    { text: 'Done.' },
  ], qa);
  const origEmit = agent.emit.bind(agent);
  let checksRun = 0;
  agent.emit = (type, p) => { if (type === 'tool-end' && /FR-2 (NOT verified|VERIFIED)/.test(p?.output || '') && ++checksRun === 1) refuses = true; return origEmit(type, p); };
  try {
    await agent.send('Build the app in SPEC.md', { model: 'claude-opus-5-5', effort: 'low', mode: 'yolo' });
    const fr2 = data.requirements.find((r) => r.id === 'FR-2');
    assert.equal(fr2.qaNeg.length, 1, 'only the valid attack is kept');
    assert.ok(notices.some((n) => /Adversarial QA wrote 1 attack check/.test(n)));
    const all = JSON.stringify(data.messages);
    assert.match(all, /attack 1: a visitor must not list users: FAILED/);
    assert.match(all, /The app accepted misuse it must refuse/);
    assert.match(all, /FR-2 VERIFIED \(QA http \+ 1 adversarial\)/);
    assert.equal(fr2.status, 'verified');
    assert.deepEqual(fr2.evidence.attacks.map((a) => a.passed), [true]);
  } finally { agent.dispose(); srv.close(); providers.callModel = realCallModel; }
});

test('an agent that never runs a check is nudged up to four times, each naming the first requirement to check', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drops-ev-'));
  fs.writeFileSync(path.join(dir, 'SPEC.md'), SPEC);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'node -e 0' } }));
  const qa = { checks: [{ id: 'FR-1', kind: 'http', url: 'http://localhost:3000/', expect: 'x' }] };
  const { agent, data } = agentFor(dir, [
    { tool: 'write_file', input: { path: 'a.js', content: '1;\n' } },
    { tool: 'shell', input: { command: 'npm test' } }, // a real test run, so only the evidence guard is left
    { text: 'All requirements are met.' }, { text: 'Done.' }, { text: 'Done.' }, { text: 'Done.' }, { text: 'Done.' }, { text: 'Done.' },
  ], qa, { autoVerify: true, uiCheck: false });
  try {
    await agent.send('Build the app in SPEC.md', { model: 'claude-opus-5-5', effort: 'low', mode: 'yolo' });
    const nudges = JSON.stringify(data.messages).match(/You have not run a single check yet/g) || [];
    assert.equal(nudges.length, 4, 'four nudges, not two');
    assert.match(JSON.stringify(data.messages), /call check_requirement with \{\\"id\\": \\"FR-1\\", \\"use_qa\\": true\}/);
  } finally { agent.dispose(); providers.callModel = realCallModel; }
});
