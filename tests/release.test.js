// Release support: local crash reports and the update check.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { compare, check } = require('../src/main/update');

test('update: versions compare like releases (a pre-release is older)', () => {
  assert.equal(compare('2.1.0', '2.1.0'), 0);
  assert.equal(compare('v2.2.0', '2.1.9'), 1);
  assert.equal(compare('2.1.0', '2.10.0'), -1);
  assert.equal(compare('3.0.0-beta.1', '3.0.0'), -1);
  assert.equal(compare('3.0.0', '3.0.0-rc.2'), 1);
});

test('update: tells about a newer release only, never a draft or pre-release, and only links to GitHub', async () => {
  const rel = (o) => async () => ({ tag_name: 'v2.2.0', html_url: 'https://github.com/Clipping771/DROPs/releases/tag/v2.2.0', body: 'Skills, hooks\r\nand schedules', ...o });
  const r = await check('2.1.0', { fetchLatest: rel({}) });
  assert.deepEqual([r.available, r.version, r.url, r.notes], [true, '2.2.0', 'https://github.com/Clipping771/DROPs/releases/tag/v2.2.0', 'Skills, hooks\nand schedules']);
  assert.equal((await check('2.2.0', { fetchLatest: rel({}) })).available, false);
  assert.equal((await check('2.1.0', { fetchLatest: rel({ prerelease: true }) })).available, false);
  assert.equal((await check('2.1.0', { fetchLatest: rel({ draft: true }) })).available, false);
  assert.equal((await check('2.1.0', { fetchLatest: async () => null })).available, false, 'no releases yet');
  assert.equal((await check('2.1.0', { fetchLatest: rel({ html_url: 'https://evil.example/x' }) })).url, 'https://github.com/Clipping771/DROPs/releases/latest');
});

test('crash reports: an unclean exit is noticed at the next start, a clean quit is not; secrets and the home folder are removed', () => {
  const crash = require('../src/main/crash');
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'drops-crash-'));
  assert.equal(crash.init({ dataDir: data, appVersion: '2.1.0', hookProcess: false }), null, 'first start: nothing to report');
  // The process "dies" without a clean quit: the next start reports it.
  const prev = crash.init({ dataDir: data, appVersion: '2.1.0', hookProcess: false });
  assert.match(prev, /unclean-exit\.json$/);
  assert.equal(JSON.parse(fs.readFileSync(prev, 'utf8')).kind, 'unclean-exit');
  crash.cleanExit();
  assert.equal(crash.init({ dataDir: data, appVersion: '2.1.0', hookProcess: false }), null, 'after a clean quit: nothing');

  const key = 'sk-ant-api03-' + 'a'.repeat(90);
  const file = crash.record('main-error', { message: `boom with ${key}`, stack: `at ${path.join(os.homedir(), 'proj', 'x.js')}:1` });
  const rep = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.doesNotMatch(JSON.stringify(rep), /sk-ant-api03-aaaa/);
  assert.ok(!JSON.stringify(rep).includes(os.homedir().replace(/\\/g, '\\\\')), 'the home folder is shown as ~');
  assert.match(rep.stack, /~[\\/]proj[\\/]x\.js/);
  assert.equal(crash.record('main-error', { message: `boom with ${key}` }), null, 'the same error within a minute is written once');
  for (let i = 0; i < 40; i++) crash.record('main-error', { message: `error ${i}` });
  assert.ok(fs.readdirSync(path.join(data, 'crashes')).filter((f) => f.endsWith('.json')).length <= 30, 'only the newest reports are kept');
  assert.ok(crash.list(0).length >= 1);
  crash.cleanExit();
});

test('update: picks the Windows installer from this project\'s release only, with its checksum', () => {
  const { pickInstaller } = require('../src/main/update');
  const base = 'https://github.com/Clipping771/DROPs/releases/download/v2.3.0/';
  const assets = [
    { name: 'DROPs-Portable-2.3.0.exe', browser_download_url: base + 'DROPs-Portable-2.3.0.exe', size: 9 },
    { name: 'DROPs-2.3.0-win.zip', browser_download_url: base + 'DROPs-2.3.0-win.zip', size: 9 },
    { name: 'DROPs Setup 2.3.0.exe', browser_download_url: base + 'DROPs.Setup.2.3.0.exe', size: 1234, digest: 'sha256:' + 'ab'.repeat(32) },
  ];
  assert.deepEqual(pickInstaller(assets, '2.3.0'), { name: 'DROPs Setup 2.3.0.exe', url: base + 'DROPs.Setup.2.3.0.exe', size: 1234, sha256: 'ab'.repeat(32) });
  assert.equal(pickInstaller([{ name: 'DROPs Setup 2.3.0.exe', browser_download_url: 'https://evil.example/DROPs Setup 2.3.0.exe', size: 1 }], '2.3.0'), null);
  assert.equal(pickInstaller(undefined, '2.3.0'), null);
});

test('update: the installer download is checked (size, checksum, origin) before it is kept', async () => {
  const { downloadInstaller } = require('../src/main/update');
  const { Readable } = require('node:stream');
  const crypto = require('node:crypto');
  const body = Buffer.from('MZ fake installer bytes');
  const sha = crypto.createHash('sha256').update(body).digest('hex');
  const get = async () => Object.assign(Readable.from([body]), { headers: {} });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drops-upd-'));
  const url = 'https://github.com/Clipping771/DROPs/releases/download/v9/DROPs.Setup.9.0.0.exe';
  const progress = [];
  const ok = await downloadInstaller({ name: 'a.exe', url, size: body.length, sha256: sha }, path.join(dir, 'a.exe'), { get, onProgress: (p) => progress.push(p.percent) });
  assert.equal(ok.verified, true);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'a.exe')), body);
  assert.equal(progress[progress.length - 1], 100);

  await assert.rejects(downloadInstaller({ name: 'b.exe', url, size: body.length, sha256: 'f'.repeat(64) }, path.join(dir, 'b.exe'), { get }), /checksum/);
  assert.ok(!fs.existsSync(path.join(dir, 'b.exe')) && !fs.existsSync(path.join(dir, 'b.exe.part')), 'a bad download is deleted');
  await assert.rejects(downloadInstaller({ name: 'c.exe', url, size: body.length + 5 }, path.join(dir, 'c.exe'), { get }), /incomplete/);
  await assert.rejects(downloadInstaller({ name: 'd.exe', url: 'https://evil.example/x.exe', size: 1 }, path.join(dir, 'd.exe'), { get }), /releases page/);
});
