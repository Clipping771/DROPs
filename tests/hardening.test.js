// Review follow-ups: MCP trust per project and config, sandbox resource limits, lesson governance.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

test('MCP: a project server runs only after this exact project and config were trusted', () => {
  const mcp = require('../src/main/mcp');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drops-mcp-'));
  const servers = { evil: { command: 'node', args: ['-e', 'steal()'] } };
  assert.equal(mcp.isProjectTrusted(dir, servers), false, 'nothing is trusted by default');
  const rows = mcp.untrustedRows(servers);
  assert.equal(rows[0].status, 'needs trust');
  assert.equal(rows[0].command, 'node -e steal()');
  mcp.trustProject(dir, servers);
  assert.equal(mcp.isProjectTrusted(dir, servers), true);
  assert.equal(mcp.isProjectTrusted(dir, { evil: { command: 'node', args: ['-e', 'stealMore()'] } }), false, 'a changed config asks again');
  assert.equal(mcp.isProjectTrusted(fs.mkdtempSync(path.join(os.tmpdir(), 'drops-mcp2-')), servers), false, 'trust is per project');
});

test('sandbox: containers get memory, CPU and process limits, adjustable by environment', () => {
  const { sandboxLimitArgs } = require('../src/main/shell');
  assert.deepEqual(sandboxLimitArgs(), ['--memory', '4g', '--cpus', '2', '--pids-limit', '1024']);
  process.env.DROPS_SANDBOX_MEMORY = '6g';
  try { assert.equal(sandboxLimitArgs()[1], '6g'); } finally { delete process.env.DROPS_SANDBOX_MEMORY; }
});

test('lessons: an automatic lesson stays out of the prompt until the mistake repeats; removing one works', () => {
  const lessons = require('../src/main/lessons');
  const f = lessons.file();
  try { fs.unlinkSync(f); } catch { /* fresh */ }
  lessons.add('In the sandbox `tree` is missing; use find or ls -R to list folders.', 'auto');
  assert.equal(lessons.promptSection(), '', 'a single automatic observation is pending');
  assert.equal(lessons.list()[0].active, false);
  lessons.add('In the sandbox `tree` is missing; use find or ls -R to list folders.', 'auto');
  assert.match(lessons.promptSection(), /tree. is missing/, 'seen twice: now active');
  lessons.add('Run the type-checker after changing shared types, before finishing the task.', 'agent');
  assert.match(lessons.promptSection(), /type-checker/, "the agent's own lesson is active at once");
  const left = lessons.remove('Run the type-checker after changing shared types, before finishing the task.');
  assert.equal(left.some((l) => /type-checker/.test(l.text)), false);
  assert.doesNotMatch(lessons.promptSection(), /type-checker/);
  try { fs.unlinkSync(f); } catch { /* ignore */ }
});
