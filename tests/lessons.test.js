// Run: npm test
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'h2o-lessons-')), 'lessons.json');
process.env.H2O_LESSONS_FILE = tmp;
const lessons = require('../src/main/lessons');

test('lessons: saved, merged when similar, and shown in the prompt', () => {
  fs.rmSync(tmp, { force: true });
  assert.strictEqual(lessons.promptSection(), '');
  lessons.add('In the Docker sandbox `fuser` is missing; free a port with pkill -f next.', 'agent');
  const again = lessons.add('In the docker sandbox fuser is missing - free the port with pkill -f next', 'agent');
  assert.strictEqual(again.count, 2, 'near-duplicate merged');
  lessons.add('Prisma: run npx prisma generate after editing schema.prisma, before building.', 'agent');
  assert.strictEqual(lessons.load().length, 2);
  const p = lessons.promptSection();
  assert.match(p, /Lessons from your past runs/);
  assert.match(p, /fuser.*seen 2×/);
  assert.match(p, /prisma generate/);
  assert.throws(() => lessons.add('short'), /short, specific/);
});

test('lessons: missing sandbox commands become lessons automatically', () => {
  assert.match(lessons.fromToolResult('shell', {}, 'bash: line 1: fuser: command not found\n[exit code 127]', true), /`fuser` is not installed in the Docker sandbox/);
  assert.strictEqual(lessons.fromToolResult('shell', {}, 'all good', true), null);
  assert.strictEqual(lessons.fromToolResult('read_file', {}, 'x: command not found', true), null);
});

test('agent: a guard firing records a lesson, and the next session sees it', async () => {
  fs.rmSync(tmp, { force: true });
  const providers = require('../src/main/providers');
  const { AgentSession } = require('../src/main/agent');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'h2o-lesson-agent-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'node -e 0' } }));
  fs.writeFileSync(path.join(dir, 'a.js'), 'module.exports = 1;\n');
  const script = [
    { tool: 'edit_file', input: { path: 'a.js', old_string: '1', new_string: '2' } },
    { tool: 'shell', input: { command: 'npm test' } },
    { text: 'Login done. Next, I will implement the dashboard.' },
    { tool: 'learn_lesson', input: { lesson: 'Finish every page the spec lists before the final answer; a passing build alone is not done.' } },
    { text: 'Dashboard implemented too; npm test passes.' },
  ];
  let i = 0; const systems = [];
  providers.callModel = async ({ system }) => {
    systems.push(typeof system === 'string' ? system : JSON.stringify(system));
    const step = script[i++] || { text: 'done' };
    const content = step.tool ? [{ type: 'tool_use', id: 't' + i, name: step.tool, input: step.input }] : [{ type: 'text', text: step.text }];
    return { content, model: 'fake', stop_reason: step.tool ? 'tool_use' : 'end_turn', usage: {} };
  };
  const mk = () => new AgentSession({ id: 's', title: 'x', projectDir: dir, messages: [], archive: [], compactions: [], turns: [], toolMeta: {}, todos: [], changes: {}, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, context: 0, requests: 0 } },
    { send: () => {}, save: () => {}, getSettings: () => ({ autoVerify: true }), getApiKey: () => 'x', getGeminiKey: () => 'x' });
  const a = mk();
  await a.send('build it', { model: 'claude-opus-5-5', effort: 'low', mode: 'yolo' });
  a.dispose();
  const saved = lessons.load().map((l) => l.text).join('\n');
  assert.match(saved, /Do not end with a progress report/, 'completion guard left a lesson');
  assert.match(saved, /Finish every page the spec lists/, 'the agent recorded its own lesson');
  // A brand-new session in another project starts with those lessons in its prompt.
  i = 99; systems.length = 0;
  const b = mk();
  await b.send('hello', { model: 'claude-opus-5-5', effort: 'low', mode: 'yolo' });
  b.dispose();
  assert.match(systems[0], /Lessons from your past runs[\s\S]*Finish every page the spec lists/);
});
