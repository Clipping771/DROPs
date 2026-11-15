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
  const run = {};
  const nudge = () => { const ok = evidenceNudgeAllowed(run, reqs); if (ok) { run.evidenceNudges = (run.evidenceNudges || 0) + 1; run.evidenceTotalNudges = (run.evidenceTotalNudges || 0) + 1; run.evidenceVerifiedAtNudge = reqs.filter((r) => r.status === 'verified').length; } return ok; };
  assert.equal(nudge(), true);
  assert.equal(nudge(), true);
  assert.equal(nudge(), false, 'two nudges with no progress: stop');
  reqs[0].status = 'verified';
  assert.equal(nudge(), true, 'a new verified requirement earns more nudges');
  reqs[1].status = 'verified';
  assert.equal(nudge(), false, 'everything verified: nothing to nudge');
});

function agentFor(dir, script, qa) {
  let i = 0;
  const notices = [];
  providers.callModel = async ({ tools, system, messages }) => {
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
    getSettings: () => ({ autoVerify: false, qaAgent: true, completionAudit: false, evidenceCheck: true }), getApiKey: () => 'x', getGeminiKey: () => 'x',
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
