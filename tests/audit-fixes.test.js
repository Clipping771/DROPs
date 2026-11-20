// Comprehensive verification tests for v3.0 audit fixes:
// - providers.resolveConcreteModel ('auto' routing across Anthropic, Gemini, OpenAI-compat, and Ollama)
// - git.stage, git.unstage, git.discard, git.branches, git.checkout, and selective git.commit
// - codegraph.graphMap web-asset indexing (.html/.css <script src>, <link href>, @import) & standalone files
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const providers = require('../src/main/providers');
const git = require('../src/main/git');
const cg = require('../src/main/codegraph');

test('providers.resolveConcreteModel resolves auto/unset models to configured providers cleanly', () => {
  // Pass-through when concrete model is explicitly supplied
  assert.equal(providers.resolveConcreteModel('claude-sonnet-5-5', {}), 'claude-sonnet-5-5');
  assert.equal(providers.resolveConcreteModel('gemini-3.6-flash', {}), 'gemini-3.6-flash');
  assert.equal(providers.resolveConcreteModel('ollama:qwen3-coder:latest', {}), 'ollama:qwen3-coder:latest');

  // Auto with Anthropic configured
  assert.equal(providers.resolveConcreteModel('auto', { hasAnthropic: true }), 'claude-sonnet-5-5');

  // Auto with Gemini configured only
  assert.equal(providers.resolveConcreteModel('auto', { hasGemini: true }), 'gemini-3.6-flash');

  // Auto with OpenAI-compatible provider configured
  assert.equal(
    providers.resolveConcreteModel('auto', {
      providers: { deepseek: { enabled: true } },
      oaiDefaultModel: 'deepseek:deepseek-chat',
    }),
    'deepseek:deepseek-chat',
  );

  // Auto with local Ollama model configured
  assert.equal(
    providers.resolveConcreteModel('auto', {
      ollamaEnabled: true,
      ollamaDefaultModel: 'ollama:qwen2.5-coder:7b',
    }),
    'ollama:qwen2.5-coder:7b',
  );
});

test('git: stage, unstage, selective commit, discard, branches, and checkout work end-to-end', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drops-git-audit-'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'audit@drops.local'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'DROPs Audit'], { cwd: root });

  fs.writeFileSync(path.join(root, 'a.txt'), 'initial a\n');
  fs.writeFileSync(path.join(root, 'b.txt'), 'initial b\n');
  const first = await git.commit(root, 'initial commit');
  assert.match(first, /initial commit/);

  // Modify both a.txt and b.txt, stage only a.txt
  fs.writeFileSync(path.join(root, 'a.txt'), 'updated a\n');
  fs.writeFileSync(path.join(root, 'b.txt'), 'updated b\n');

  await git.stage(root, 'a.txt');

  let status = await git.status(root);
  const aEntry = status.files.find((f) => f.path === 'a.txt');
  const bEntry = status.files.find((f) => f.path === 'b.txt');
  assert.equal(aEntry?.staged, true);
  assert.equal(bEntry?.staged, false);

  // Selective commit should commit ONLY a.txt and leave b.txt modified
  const second = await git.commit(root, 'commit only staged a.txt');
  assert.match(second, /commit only staged a\.txt/);
  status = await git.status(root);
  assert.equal(status.files.length, 1);
  assert.equal(status.files[0].path, 'b.txt');

  // Test stage + unstage on b.txt
  await git.stage(root, 'b.txt');
  status = await git.status(root);
  assert.equal(status.files[0].staged, true);
  await git.unstage(root, 'b.txt');
  status = await git.status(root);
  assert.equal(status.files[0].staged, false);

  // Test discard on tracked file b.txt
  const discTracked = await git.discard(root, 'b.txt');
  assert.equal(discTracked, true);
  assert.equal(fs.readFileSync(path.join(root, 'b.txt'), 'utf8').replace(/\r\n/g, '\n'), 'initial b\n');

  // Test discard on untracked file c.txt
  fs.writeFileSync(path.join(root, 'c.txt'), 'temp untracked\n');
  const discUntracked = await git.discard(root, 'c.txt');
  assert.equal(discUntracked, true);
  assert.equal(fs.existsSync(path.join(root, 'c.txt')), false);

  // Test branches and checkout (create new branch + switch back)
  const coNew = await git.checkout(root, 'feat/audit-branch', true);
  assert.equal(coNew.isRepo, true);
  assert.equal(coNew.branch, 'feat/audit-branch');
  let br = await git.branches(root);
  assert.equal(br.current, 'feat/audit-branch');
  assert.ok(br.local.includes('main'));
  assert.ok(br.local.includes('feat/audit-branch'));

  const coMain = await git.checkout(root, 'main', false);
  assert.equal(coMain.branch, 'main');
  br = await git.branches(root);
  assert.equal(br.current, 'main');
});

test('codegraph.graphMap indexes HTML/CSS web assets and standalone files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drops-webgraph-'));
  fs.writeFileSync(
    path.join(root, 'index.html'),
    '<!doctype html><html><head><link rel="stylesheet" href="./styles.css"></head><body><script src="./app.js"></script></body></html>\n',
  );
  fs.writeFileSync(path.join(root, 'styles.css'), '@import "./theme.css";\nbody { margin: 0; }\n');
  fs.writeFileSync(path.join(root, 'theme.css'), ':root { --bg: #000; }\n');
  fs.writeFileSync(path.join(root, 'app.js'), 'console.log("hello");\n');
  fs.writeFileSync(path.join(root, 'standalone.py'), 'print("standalone")\n');

  const map = cg.graphMap(root, []);
  const ids = map.nodes.map((n) => n.id);
  assert.ok(ids.includes('index.html'), 'index.html indexed');
  assert.ok(ids.includes('styles.css'), 'styles.css indexed');
  assert.ok(ids.includes('theme.css'), 'theme.css indexed');
  assert.ok(ids.includes('app.js'), 'app.js indexed');
  assert.ok(ids.includes('standalone.py'), 'standalone deg=0 file included when under limit');

  assert.ok(map.edges.some((e) => e.from === 'index.html' && e.to === 'styles.css'), 'HTML -> CSS link edge');
  assert.ok(map.edges.some((e) => e.from === 'index.html' && e.to === 'app.js'), 'HTML -> JS script edge');
  assert.ok(map.edges.some((e) => e.from === 'styles.css' && e.to === 'theme.css'), 'CSS -> CSS @import edge');
});
