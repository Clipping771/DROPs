// Run: npm test — fetch_url network gating, private-address blocking and symlink escapes.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const tools = require('../src/main/tools');

test('fetch_url: private, loopback and metadata addresses are recognized', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.10', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', '::', 'fe80::1', 'fd00::5', '::ffff:127.0.0.1', '::ffff:10.0.0.1']) {
    assert.ok(tools.isPrivateAddress(ip), `${ip} should be private`);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '140.82.112.3', '2606:4700:4700::1111', '::ffff:8.8.8.8']) {
    assert.ok(!tools.isPrivateAddress(ip), `${ip} should be public`);
  }
});

test('fetch_url: local URLs are refused before any request', async () => {
  for (const url of ['http://127.0.0.1:9/', 'http://localhost:3000/x', 'http://[::1]/', 'http://169.254.169.254/latest/meta-data/', 'http://0x7f000001/']) {
    await assert.rejects(tools.assertPublicUrl(url), /blocked/, url);
  }
  await assert.rejects(tools.assertPublicUrl('file:///etc/passwd'), /http/);
});

test('fetch_url: prepared as a gated "fetch" call with a per-host permission key', async () => {
  const p = await tools.prepare({ root: os.tmpdir() }, 'fetch_url', { url: 'https://Example.com/docs?q=1' });
  assert.strictEqual(p.kind, 'fetch');
  assert.strictEqual(p.permKey, 'fetch:example.com');
  await assert.rejects(tools.prepare({ root: os.tmpdir() }, 'fetch_url', { url: 'ftp://example.com/' }), /http/);
});

test('paths: a symlink/junction inside the project cannot lead outside it', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'h2o-link-'));
  const root = path.join(base, 'proj'), outside = path.join(base, 'outside');
  fs.mkdirSync(root); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.txt'), 's');
  fs.mkdirSync(path.join(root, 'src'));
  try {
    fs.symlinkSync(outside, path.join(root, 'escape'), 'junction');
    assert.throws(() => tools.resolveInRoot(root, 'escape/secret.txt'), /through a link/);
    assert.throws(() => tools.resolveInRoot(root, 'escape/new-file.txt'), /through a link/);
    assert.throws(() => tools.resolveInRoot(root, 'escape'), /through a link/);
    assert.throws(() => tools.resolveInRoot(root, '../outside/secret.txt'), /outside the project root/);
    assert.strictEqual(tools.resolveInRoot(root, 'src/new/deep.txt'), path.join(root, 'src', 'new', 'deep.txt'));
    assert.strictEqual(tools.resolveInRoot(root, '.'), root);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('agent: fetch_url asks permission (per host) and still blocks local addresses', async () => {
  const providers = require('../src/main/providers');
  const { AgentSession } = require('../src/main/agent');
  const origCall = providers.callModel;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'h2o-fetch-'));
  const script = [
    { url: 'http://127.0.0.1:9/a' }, // denied by the user
    { url: 'http://127.0.0.1:9/b' }, // allowed "always" -> still blocked as a private address
    { url: 'http://127.0.0.1:9/c' }, // same host, already allowed: no prompt
  ];
  let i = 0;
  providers.callModel = async () => {
    const s = script[i++];
    const content = s ? [{ type: 'tool_use', id: 't' + i, name: 'fetch_url', input: { url: s.url } }] : [{ type: 'text', text: 'done' }];
    return { content, model: 'fake', stop_reason: s ? 'tool_use' : 'end_turn', usage: {} };
  };
  const prompts = [];
  const answers = ['deny', 'always'];
  const data = { id: 'f', title: 'New session', projectDir: dir, messages: [], archive: [], compactions: [], turns: [], toolMeta: {}, todos: [], changes: {}, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, context: 0, requests: 0 } };
  let agent;
  agent = new AgentSession(data, {
    send: (_id, type, p) => { if (type === 'permission') { prompts.push(p); setImmediate(() => agent.respond(p.reqId, answers.shift() || 'deny')); } },
    save: () => {}, getSettings: () => ({ autoVerify: false }), getApiKey: () => 'x', getGeminiKey: () => null,
  });
  try {
    await agent.send('read the docs', { model: 'claude-opus-5-5', effort: 'low', mode: 'auto-edit' });
    assert.strictEqual(prompts.length, 2, 'asked twice, then remembered the host');
    assert.ok(prompts.every((p) => p.kind === 'fetch'));
    const results = data.messages.filter((m) => m.role === 'user').flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b) => b.type === 'tool_result');
    assert.match(String(results[0].content), /denied/);
    assert.match(String(results[1].content), /blocked/);
    assert.match(String(results[2].content), /blocked/);
  } finally {
    providers.callModel = origCall;
    agent.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('shell: abbreviated PowerShell flags and inline delete code always ask', () => {
  const { assessCommand } = require('../src/main/shell');
  for (const c of ['Remove-Item -Recu build', 'Remove-Item -r build', 'ri -Rec x',
    `node -e "require('fs').rmSync('src',{recursive:true})"`, `node --eval "fs.unlinkSync('a')"`,
    `python -c "import shutil; shutil.rmtree('src')"`, `python3 -c "import os; os.remove('a')"`, `perl -e "unlink 'x'"`]) {
    assert.ok(assessCommand(c, 'C:\proj').dangerous, c);
  }
  for (const c of ['Remove-Item build.log', `node -e "console.log(1)"`, `python -c "print(1)"`, 'node scripts/clean.js', 'npm run remove-unused']) {
    assert.ok(!assessCommand(c, 'C:\proj').dangerous, c);
  }
});

test('shell: read-only list excludes git commands that write files or change branches', () => {
  const { isSafeCommand } = require('../src/main/shell');
  for (const c of ['git diff', 'git branch', 'git branch -a', 'git branch --list', 'git log --oneline']) assert.ok(isSafeCommand(c), c);
  for (const c of ['git diff --output=C:/x.patch', 'git log --output=out.txt', 'git branch -D main', 'git branch -m old new', 'git branch --delete x']) assert.ok(!isSafeCommand(c), c);
});

test('secret shield: more token kinds, connection-string passwords and .env secrets are masked; code is not', () => {
  const { redact } = require('../src/main/shell');
  const masked = [
    ['hf_' + 'a'.repeat(34), 'hf_'], ['gsk_' + 'b'.repeat(52), 'gsk_'], ['npm_' + 'c'.repeat(36), 'npm_'], ['glpat-' + 'd'.repeat(20), 'glpat-'],
    ['DATABASE_URL=postgres://admin:hunter2pass@db.example.com/app', 'hunter2pass'], ['mongodb+srv://u:S3cretPw@c0.mongodb.net', 'S3cretPw'],
    ['aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', 'wJalrXUtnFEMI'], ['DB_PASSWORD=supersecret # local', 'supersecret'],
    ['export GITHUB_TOKEN="zzzzzzzzzzzz"', 'zzzzzzzzzzzz'], ['$env:OPENAI_API_KEY = "abcdefghijkl"', 'abcdefghijkl'],
  ];
  for (const [text, secret] of masked) {
    const r = redact(text);
    assert.ok(!r.text.includes(secret) && r.count > 0, `${text} -> ${r.text}`);
  }
  for (const text of ['API_KEY = os.getenv("X")', 'SECRET_KEY = process.env.SECRET_KEY;', 'TOKEN = get_token()', 'MAX_TOKENS=100000',
    'password: ${{ secrets.PW }}', 'http://localhost:3000/a@b', 'git@github.com:o/r.git', 'const passwordField = form.password;']) {
    assert.equal(redact(text).text, text, text);
  }
});
