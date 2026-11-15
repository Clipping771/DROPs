// The rename from H2O to DROPs keeps old settings, data and project files working.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const brand = require('../src/main/brand');

test('environment: DROPS_* wins, H2O_* still works', () => {
  delete process.env.DROPS_TEST_X; delete process.env.H2O_TEST_X;
  assert.equal(brand.env('TEST_X'), undefined);
  process.env.H2O_TEST_X = 'old';
  assert.equal(brand.env('TEST_X'), 'old');
  process.env.DROPS_TEST_X = 'new';
  assert.equal(brand.env('TEST_X'), 'new');
  delete process.env.DROPS_TEST_X; delete process.env.H2O_TEST_X;
});

test('project memory: an existing H2O.md keeps being used; new projects get DROPs.md', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drops-brand-'));
  assert.equal(brand.memoryFile(dir), 'DROPs.md');
  fs.writeFileSync(path.join(dir, 'H2O.md'), 'old notes');
  assert.equal(brand.memoryFile(dir), 'H2O.md');
  fs.writeFileSync(path.join(dir, 'DROPs.md'), 'new notes');
  assert.equal(brand.memoryFile(dir), 'DROPs.md');
});

test('data folders: the old H2O folder is used until a DROPs one exists', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'drops-appdata-'));
  const saved = process.env.APPDATA;
  process.env.APPDATA = base;
  try {
    assert.equal(brand.appDataDir(), path.join(base, 'DROPs'));
    fs.mkdirSync(path.join(base, 'H2O'));
    assert.equal(brand.appDataDir(), path.join(base, 'H2O'), 'existing settings are kept');
    fs.mkdirSync(path.join(base, 'DROPs'));
    assert.equal(brand.appDataDir(), path.join(base, 'DROPs'));
  } finally { process.env.APPDATA = saved; }
  assert.deepEqual(brand.PROJECT_DIRS, ['.drops', '.h2o']);
});

test('the agent reads project instructions from DROPs.md and the older H2O.md', () => {
  const { AgentSession } = require('../src/main/agent');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drops-instr-'));
  fs.writeFileSync(path.join(dir, 'H2O.md'), 'Use tabs.');
  fs.mkdirSync(path.join(dir, '.drops', 'rules'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.drops', 'rules', 'style.md'), 'No semicolons.');
  const data = { id: 's', title: 'x', projectDir: dir, messages: [], archive: [], compactions: [], turns: [], toolMeta: {}, todos: [], changes: {}, usage: {} };
  const agent = new AgentSession(data, { send: () => {}, save: () => {}, getSettings: () => ({}), getApiKey: () => 'x', getGeminiKey: () => 'x' });
  const sys = JSON.stringify(agent.systemPrompt('claude-opus-5-5', 'hi'));
  assert.match(sys, /Use tabs\./);
  assert.match(sys, /No semicolons\./);
  agent.dispose();
});
