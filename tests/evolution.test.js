// Tests for Phases 2-6: benchmarking metrics, execution ledger, self-recovery, intelligent routing, and evaluation dashboard.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { summarizeResults, formatScorecard } = require('../bench/run');
const { generateDashboard, computeRegressions } = require('../bench/dashboard');
const { buildExecutionLedger } = require('../src/main/agent-evidence');
const { LoopGuard } = require('../src/main/guards');
const { scoreModelCandidate, selectOptimalModel, isCapacityError, inferTaskCategory } = require('../src/main/providers');
const providers = require('../src/main/providers');
const store = require('../src/main/store');
const { AgentSession } = require('../src/main/agent');
const cli = require('../src/cli');

test('Phase 2: summarizeResults & formatScorecard compute cost/success, escalations, and unverified claims', () => {
  const rows = [
    { task: 't1', category: 'bug', pass: true, seconds: 10, tokensIn: 1000, tokensOut: 200, cost: 0.02, costKnown: true, models: ['m1'] },
    { task: 't2', category: 'bug', pass: false, seconds: 20, tokensIn: 2000, tokensOut: 400, cost: 0.04, costKnown: true, models: ['m1', 'm2'], verifyFailed: false, stoppedByLimit: false, error: null, failureBucket: 'patch_or_test_failed' },
  ];
  const s = summarizeResults(rows, { model: 'auto', effort: 'medium', runs: 1 });
  assert.equal(s.passed, 1);
  assert.equal(s.attempts, 2);
  assert.equal(s.costPerSuccess, 0.06);
  assert.equal(s.avgAttemptsPerSuccess, 2);
  assert.equal(s.escalations, 1);
  assert.equal(s.escalationRate, 50);
  assert.equal(s.claimedButFailed, 1);
  const md = formatScorecard(s);
  assert.match(md, /Cost\/Success:\*\* \$0\.06/);
  assert.match(md, /Escalations:\*\* 1 \(50%\)/);
});

test('Phase 3: buildExecutionLedger preserves completed, pending, blocked subtasks and decisions', () => {
  const lines = buildExecutionLedger({
    todos: [
      { status: 'completed', content: 'Audit auth module' },
      { status: 'in_progress', content: 'Fix token refresh' },
      { status: 'blocked', content: 'Deploy preview', blocker: 'Missing staging env' },
    ],
    changes: { 'src/auth.js': { added: 5, removed: 2 } },
    requirements: [{ id: 'FR-1', status: 'verified' }, { id: 'FR-2', status: 'unverified' }],
    decisions: ['Use constant-time comparison for HMAC verification'],
  });
  const text = lines.join('\n');
  assert.match(text, /completed=1, in_progress=1, pending=0, blocked=1/);
  assert.match(text, /blocked: Missing staging env/);
  assert.match(text, /src\/auth\.js/);
  assert.match(text, /FR-2/);
  assert.match(text, /constant-time comparison/);
});

test('Phase 4: LoopGuard signals escalation, safe stop, and structured recovery advice with project frames', () => {
  const g = new LoopGuard(3);
  assert.equal(g.shouldEscalate(), false);
  assert.equal(g.shouldStopSafely(), false);
  g.record('shell', { command: 'npm test' }, false);
  g.record('shell', { command: 'npm test' }, false);
  assert.equal(g.shouldEscalate(), true);
  assert.equal(g.shouldStopSafely(), false);
  const advice = g.recoveryAdvice('shell:npm test', 'Error: boom\n    at foo (src/app.js:42:5)', process.cwd());
  assert.match(advice, /\[DROPs recovery\]/);
  assert.match(advice, /src\/app\.js:42/);
  g.record('shell', { command: 'npm test' }, false);
  g.record('shell', { command: 'npm test' }, false);
  assert.equal(g.shouldStopSafely(), true);
});

test('Phase 5: selectOptimalModel prefers cheapest reliable model over expensive model', () => {
  const settings = { hasGemini: true };
  assert.equal(scoreModelCandidate({ total: 2, passed: 2, totalCost: 0.01 }), null);
  const stats = {
    'gemini-3.5-flash-lite': { total: 5, passed: 5, totalCost: 0.01 },
    'gemini-3.6-flash': { total: 5, passed: 5, totalCost: 0.05 },
    'gemini-4-hydrogen': { total: 5, passed: 5, totalCost: 0.50 },
  };
  const chosen = selectOptimalModel({ prompt: 'fix a normal bug in utils.js', settings, stats });
  assert.equal(chosen, 'gemini-3.5-flash-lite');
});

test('Phase 6: evaluation dashboard computes regressions and generates HTML from real JSON runs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drops-dash-'));
  try {
    fs.writeFileSync(path.join(dir, '2026-11-18-01-a.json'), JSON.stringify({
      date: '2026-11-18T01:00:00Z', model: 'm1', effort: 'medium',
      results: [{ task: 't1', category: 'bug', pass: true, seconds: 5, tokensIn: 100, tokensOut: 50, cost: 0.01, costKnown: true }],
    }));
    fs.writeFileSync(path.join(dir, '2026-11-19-01-a.json'), JSON.stringify({
      date: '2026-11-19T01:00:00Z', model: 'm1', effort: 'medium',
      results: [{ task: 't1', category: 'bug', pass: false, seconds: 7, tokensIn: 120, tokensOut: 60, cost: 0.02, costKnown: true, failureBucket: 'verify_failed' }],
    }));
    const out = path.join(dir, 'dashboard.html');
    const res = generateDashboard(dir, out);
    assert.equal(res.runs, 2);
    const html = fs.readFileSync(out, 'utf8');
    assert.match(html, /DROPs Independent Evaluation Dashboard/);
    assert.match(html, /Regressed/);
    assert.match(html, /t1/);
    const regs = computeRegressions([
      { file: '1.json', date: 'd1', model: 'm1', results: [{ task: 't1', pass: true }] },
      { file: '2.json', date: 'd2', model: 'm1', results: [{ task: 't1', pass: false }] },
    ]);
    assert.deepEqual(regs[0].regressed, ['t1']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Phase 7 fix: stream-stall timeout error triggers capacity fallback', () => {
  assert.equal(isCapacityError(new Error('Provider timed out (no response for 45s).')), true);
});

test('Step 2: store.recordModelOutcome persists global & category stats and ignores auto/fake', () => {
  store.recordModelOutcome({ model: 'auto', category: 'bugfix', passed: true, cost: 0.01, seconds: 2 });
  store.recordModelOutcome({ model: 'fake', category: 'bugfix', passed: true, cost: 0.01, seconds: 2 });
  assert.equal(store.getModelStats().auto, undefined);
  assert.equal(store.getModelStats().fake, undefined);
  store.recordModelOutcome({ model: 'test-model-x', category: 'bugfix', passed: true, cost: 0.012345, seconds: 5 });
  store.recordModelOutcome({ model: 'test-model-x', category: 'bugfix', passed: false, cost: 0.02, seconds: 7 });
  const stats = store.getModelStats();
  assert.equal(stats['test-model-x'].total, 2);
  assert.equal(stats['test-model-x'].passed, 1);
  assert.equal(stats['test-model-x'].totalCost, 0.032345);
  assert.equal(stats['test-model-x::bugfix'].total, 2);
  assert.equal(stats['test-model-x::bugfix'].passed, 1);
});

test('Step 2: inferTaskCategory + AgentSession auto-routing uses historical stats and records outcome', async () => {
  assert.equal(inferTaskCategory('Fix broken login crash'), 'bugfix');
  assert.equal(inferTaskCategory('Refactor auth module into helpers'), 'refactor');
  assert.equal(inferTaskCategory('Add dark mode feature'), 'feature');
  assert.equal(inferTaskCategory('What does main.js do?'), 'question');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drops-autoroute-'));
  const origCall = providers.callModel;
  const recorded = [];
  const emittedModels = [];
  providers.callModel = async ({ model }) => ({
    content: [{ type: 'text', text: 'Done.' }],
    model, stop_reason: 'end_turn',
    usage: { input_tokens: 100, output_tokens: 20 },
  });
  const data = {
    id: 'ar-' + Date.now(), title: 'Auto route', projectDir: dir, mode: 'yolo',
    messages: [], archive: [], compactions: [], turns: [], toolMeta: {}, todos: [], changes: {},
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, context: 0, requests: 0 },
  };
  const agent = new AgentSession(data, {
    send: (_id, type, p) => { if (type === 'auto-model') emittedModels.push(p.model); },
    save: () => {},
    getSettings: () => ({ hasGemini: true, autoVerify: false, completionAudit: false, evidenceCheck: false }),
    getApiKey: () => null,
    getGeminiKey: () => 'x',
    getModelStats: () => ({
      'gemini-3.5-flash-lite::bugfix': { total: 4, passed: 4, totalCost: 0.01 },
      'gemini-3.6-flash::bugfix': { total: 4, passed: 4, totalCost: 0.08 },
    }),
    recordModelOutcome: (o) => recorded.push(o),
  });
  try {
    await agent.send('fix the bug in app.js', { model: 'auto', effort: 'low', mode: 'yolo' });
    assert.equal(emittedModels[0], 'gemini-3.5-flash-lite');
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].model, 'gemini-3.5-flash-lite');
    assert.equal(recorded[0].category, 'bugfix');
    assert.equal(recorded[0].passed, true);
  } finally {
    providers.callModel = origCall;
    agent.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Step 1: cli.runHeadless aborts cleanly on timeoutMs and external AbortSignal', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drops-cli-to-'));
  const origCall = providers.callModel;
  providers.callModel = ({ signal }) => new Promise((_, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'));
    signal?.addEventListener?.('abort', () => reject(new Error('aborted')), { once: true });
  });
  try {
    const r = await cli.runHeadless({
      project: dir, task: 'hang forever', model: 'claude-haiku-5-5', effort: 'low', mode: 'yolo', timeoutMs: 80,
    });
    assert.equal(r.timedOut, true);
    assert.equal(r.ok, false);
    assert.ok(r.errors.includes('timeout'));

    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    const r2 = await cli.runHeadless(
      { project: dir, task: 'abort externally', model: 'claude-haiku-5-5', effort: 'low', mode: 'yolo' },
      { signal: ac.signal },
    );
    assert.equal(r2.timedOut, false);
  } finally {
    providers.callModel = origCall;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Step 3: AgentSession preserves QA delegation methods after agent-qa.js extraction', () => {
  for (const fn of ['writeQaChecks', 'writeAdversarialChecks', 'reviseQaCheck', 'runCheckRequirement', 'runOneCheck', 'reverifyStale']) {
    assert.equal(typeof AgentSession.prototype[fn], 'function', `AgentSession.${fn} missing`);
  }
});
