// Run: npm test — the store's caches and the slimmer session files.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.APPDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'drops-perf-test-'));
const store = require('../src/main/store');
const brand = require('../src/main/brand');
const dataDir = brand.appDataDir();

test('settings: cached, but a change written by another process is still seen', () => {
  store.setSettings({ customInstructions: 'one' });
  assert.equal(store.getSettings().customInstructions, 'one');
  const file = path.join(dataDir, 'settings.json');
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  j.customInstructions = 'changed elsewhere, longer text';
  fs.writeFileSync(file, JSON.stringify(j));
  assert.equal(store.getSettings().customInstructions, 'changed elsewhere, longer text');
  // Callers may change what they get back without changing the cache.
  const s = store.getSettings(); s.customInstructions = 'mutated';
  assert.equal(store.getSettings().customInstructions, 'changed elsewhere, longer text');
});

test('sessions: the list comes from an index, and a file changed outside is re-read', async () => {
  const a = store.newSession('C:\\proj'); a.title = 'First'; store.saveSession(a);
  const b = store.newSession('C:\\proj'); b.title = 'Second'; b.updated = Date.now() + 10; store.saveSession(b);
  assert.deepEqual(store.listSessions().map((x) => x.title), ['Second', 'First']);
  // Edited by something else (an older DROPs, a restore from backup).
  const file = path.join(dataDir, 'sessions', `${a.id}.json`);
  const j = JSON.parse(fs.readFileSync(file, 'utf8')); j.title = 'Renamed outside'; j.updated = Date.now() + 100;
  fs.writeFileSync(file, JSON.stringify(j));
  assert.equal(store.listSessions()[0].title, 'Renamed outside');
  store.deleteSession(b.id);
  assert.deepEqual(store.listSessions().map((x) => x.title), ['Renamed outside']);
  await new Promise((r) => setTimeout(r, 400));
  assert.ok(fs.existsSync(path.join(dataDir, 'sessions', '_index.json')), 'index written');
  assert.ok(!store.listSessions().some((x) => x.id === '_index'), 'the index is not a session');
});

test('sessions: checkpoint contents live in shared blobs, not in the session file', () => {
  const big = 'x'.repeat(50_000);
  const d = store.newSession('C:\\proj');
  d.turns = [{ msgIndex: 0, text: 't', files: { 'C:\\proj\\a.js': big, 'C:\\proj\\new.js': null, 'C:\\proj\\s.js': 'short' }, after: { 'C:\\proj\\a.js': big + 'y' } }];
  store.saveSession(d);
  const raw = fs.readFileSync(path.join(dataDir, 'sessions', `${d.id}.json`), 'utf8');
  assert.ok(raw.length < 5000, `session file stays small (${raw.length} bytes)`);
  assert.equal(d.turns[0].files['C:\\proj\\a.js'], big, 'the in-memory session is unchanged');
  const back = store.loadSession(d.id);
  assert.equal(back.turns[0].files['C:\\proj\\a.js'], big);
  assert.equal(back.turns[0].files['C:\\proj\\new.js'], null);
  assert.equal(back.turns[0].files['C:\\proj\\s.js'], 'short');
  assert.equal(back.turns[0].after['C:\\proj\\a.js'], big + 'y');

  // Blobs no session uses are cleaned up (only once they are older than an hour).
  const blobs = path.join(dataDir, 'sessions', 'blobs');
  const orphan = path.join(blobs, 'f'.repeat(64) + '.txt');
  fs.writeFileSync(orphan, 'old');
  const old = new Date(Date.now() - 2 * 3600_000); fs.utimesSync(orphan, old, old);
  for (const f of fs.readdirSync(blobs)) if (f !== path.basename(orphan)) fs.utimesSync(path.join(blobs, f), old, old);
  assert.equal(store.gcBlobs(), 1);
  assert.ok(!fs.existsSync(orphan));
  assert.equal(store.loadSession(d.id).turns[0].files['C:\\proj\\a.js'], big, 'blobs in use are kept');
});

test('repo map: a second build reuses the cached file list, symbols and graph', () => {
  const ctx = require('../src/main/context');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drops-map-'));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'auth.js'), 'function login() {}\nmodule.exports = { login };\n');
  fs.writeFileSync(path.join(dir, 'src', 'app.js'), "const { login } = require('./auth');\nfunction start() {}\n");
  const a = ctx.repoMap(dir, 14000, 'fix auth');
  assert.match(a, /src\/auth\.js: login/);
  assert.equal(ctx.repoMap(dir, 14000, 'fix auth'), a);
});

test('sessions: long tool output and pictures are stored as blobs, and come back unchanged', () => {
  const big = 'line of output\n'.repeat(2000);
  const pic = 'iVBORw0KGgo' + 'A'.repeat(8000);
  const d = store.newSession('C:\proj');
  d.messages = [
    { role: 'user', content: [{ type: 'text', text: 'run it' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'shell', input: { command: 'x' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: big }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: pic } }, { type: 'tool_result', tool_use_id: 't2', content: 'short' }] },
  ];
  d.toolMeta = { t1: { name: 'shell', output: big, status: 'done' } };
  store.saveSession(d);
  const raw = fs.readFileSync(path.join(dataDir, 'sessions', `${d.id}.json`), 'utf8');
  assert.ok(raw.length < 3000, `session file stays small (${raw.length} bytes)`);
  assert.equal(d.messages[2].content[0].content, big, 'the in-memory session is unchanged');
  const back = store.loadSession(d.id);
  assert.equal(back.messages[2].content[0].content, big);
  assert.equal(back.messages[2].content[1].source.data, pic);
  assert.equal(back.messages[2].content[2].content, 'short');
  assert.equal(back.toolMeta.t1.output, big);
  assert.equal(store.listSessions().find((x) => x.id === d.id).title, 'New session');
});
