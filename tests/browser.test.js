// The browser tool drives a real headless browser: open, fill, click, read, screenshot, and it reports
// console errors, failed requests and sideways scrolling. Skips when no browser can be started.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const browser = require('../src/main/browser');

const LOGIN = `<!doctype html><html lang="en"><head><title>Shop login</title></head><body>
<h1>Log in</h1>
<form id="f"><label for="email">Email</label><input id="email" data-testid="login-email">
<label for="pw">Password</label><input id="pw" type="password">
<button data-testid="login-submit">Log in</button></form>
<p role="alert" id="err" hidden></p>
<script>
document.getElementById('f').onsubmit = (e) => { e.preventDefault();
  if (document.getElementById('pw').value === 'secret1') location.href = '/dashboard';
  else { const p = document.getElementById('err'); p.hidden = false; p.textContent = 'Wrong password'; } };
</script></body></html>`;
const DASH = `<!doctype html><html><head><title>Dashboard</title></head><body><h1>Welcome back</h1>
<a href="/missing">Reports</a><div style="width:900px">wide table</div>
<script>console.error('chart failed to load'); fetch('/api/broken');</script></body></html>`;

let srv, base;
const key = 'test-' + process.pid;

async function start() {
  srv = http.createServer((req, res) => {
    if (req.url === '/' || req.url === '/login') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(LOGIN); }
    if (req.url === '/dashboard') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(DASH); }
    res.writeHead(500, { 'content-type': 'text/plain' }); res.end('boom');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.address().port}`;
}

after(async () => { await browser.closeAll(); srv?.close(); });

test('browser: a user journey with errors, layout and a screenshot', { timeout: 120_000 }, async (t) => {
  if (!browser.available()) return t.skip('playwright-core not installed');
  await start();
  let r;
  try { r = await browser.act(key, { action: 'open', url: base + '/login' }); }
  catch (e) { if (/No browser could be started/.test(e.message)) return t.skip(e.message); throw e; }
  assert.match(r.text, /Title: Shop login/);
  assert.match(r.text, /testid=login-email/);
  assert.match(r.text, /label="Password"/);

  // Wrong password: the on-screen message is reported.
  await browser.act(key, { action: 'fill', target: 'testid=login-email', value: 'a@b.co' });
  await browser.act(key, { action: 'fill', target: 'Password', value: 'nope' });
  r = await browser.act(key, { action: 'click', target: 'Log in' });
  assert.match(r.text, /Messages shown: Wrong password/);

  // Right password: the page changes, and its console error, failed request and overflow are caught.
  await browser.act(key, { action: 'fill', target: 'Password', value: 'secret1' });
  r = await browser.act(key, { action: 'press', target: 'Password', key: 'Enter' });
  assert.match(r.text, /URL: .*\/dashboard/);
  assert.match(r.text, /Welcome back/);
  assert.match(r.text, /console error: chart failed to load/);
  assert.match(r.text, /HTTP 500 GET .*\/api\/broken/);

  r = await browser.act(key, { action: 'read', width: 375 });
  assert.match(r.text, /scrolls sideways/);

  r = await browser.act(key, { action: 'click', target: 'Reports' });
  assert.match(r.text, /HTTP 500/);

  const shot = await browser.act(key, { action: 'screenshot' });
  assert.equal(shot.images[0].source.media_type, 'image/png');
  assert.ok(shot.images[0].source.data.length > 1000);

  await assert.rejects(browser.act(key, { action: 'open', url: 'file:///etc/passwd' }), /http/);
  await assert.rejects(browser.act(key, { action: 'fly' }), /Unknown browser action/);
});

test('browser: a dead button and missing page code are reported as issues', { timeout: 120_000 }, async (t) => {
  if (!browser.available()) return t.skip('playwright-core not installed');
  const dead = http.createServer((req, res) => {
    if (req.url.startsWith('/_next/')) { res.writeHead(404); return res.end('gone'); }
    res.writeHead(200, { 'content-type': 'text/html' });
    // Like run 3 of the CRM benchmark: the page's script is missing, so the form never submits.
    res.end('<title>Login</title><script src="/_next/static/chunks/app.js"></script><form onsubmit="return false"><input aria-label="Email"><button type="submit">Sign in</button></form>');
  });
  await new Promise((r) => dead.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${dead.address().port}/login`;
  try {
    let r;
    try { r = await browser.act('dead-' + process.pid, { action: 'open', url }); } catch (e) { if (/No browser/.test(e.message)) return t.skip(e.message); throw e; }
    assert.match(r.text, /page's JavaScript .* did not load/);
    assert.match(r.issue, /HTTP 404/);
    r = await browser.act('dead-' + process.pid, { action: 'click', target: 'Sign in' });
    assert.match(r.text, /nothing on the page changed/);
    assert.match(r.issue, /clicking "Sign in" changed nothing on \/login/);
  } finally { dead.close(); }
});

test('browser: a request the page cancelled itself (a Next.js prefetch) is not reported as a problem', { timeout: 120_000 }, async (t) => {
  if (!browser.available()) return t.skip('playwright-core not installed');
  const s = http.createServer((req, res) => {
    if (req.url.startsWith('/slow')) return setTimeout(() => { try { res.end('late'); } catch {} }, 5000); // still pending when the page leaves
    res.writeHead(200, { 'content-type': 'text/html' });
    if (req.url === '/b') return res.end('<title>B</title><h1>Contacts page</h1>');
    res.end('<title>A</title><a href="/b">Contacts</a><script>const c=new AbortController();fetch("/slow?_rsc=abc",{signal:c.signal}).catch(()=>{});setTimeout(()=>c.abort(),150)</script>');
  });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const k = 'abort-' + process.pid;
  try {
    let r;
    try { r = await browser.act(k, { action: 'open', url: `http://127.0.0.1:${s.address().port}/` }); } catch (e) { if (/No browser/.test(e.message)) return t.skip(e.message); throw e; }
    assert.doesNotMatch(r.text, /request failed/, 'the cancelled prefetch is not a problem');
    assert.ok(!r.issue, `no issue expected on open, got: ${r.issue}`);
    r = await browser.act(k, { action: 'click', target: 'Contacts' });
    assert.match(r.text, /Contacts page/);
    assert.doesNotMatch(r.text, /request failed/);
    assert.ok(!r.issue, `no issue expected, got: ${r.issue}`);
  } finally { s.close(); }
});

test('browser: an async fetch login followed by client navigation waits and is not flagged as unchanged', { timeout: 120_000 }, async (t) => {
  if (!browser.available()) return t.skip('playwright-core not installed');
  const s = http.createServer((req, res) => {
    if (req.url === '/api/auth/login') {
      return setTimeout(() => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); }, 220);
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    if (req.url === '/deals') return res.end('<title>Deals</title><h1>Pipeline</h1>');
    res.end(`<title>Sign in</title><form id="f"><input data-testid="login-email"><button data-testid="login-submit" type="submit">Sign in</button></form>
      <script>document.getElementById('f').onsubmit = async (e) => {
        e.preventDefault();
        const r = await fetch('/api/auth/login', { method: 'POST' });
        if (r.ok) location.href = '/deals';
      };</script>`);
  });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const k = 'async-login-' + process.pid;
  try {
    try { await browser.act(k, { action: 'open', url: `http://127.0.0.1:${s.address().port}/login` }); } catch (e) { if (/No browser/.test(e.message)) return t.skip(e.message); throw e; }
    await browser.act(k, { action: 'fill', target: 'testid=login-email', value: 'maya@example.com' });
    const r = await browser.act(k, { action: 'click', target: 'testid=login-submit' });
    assert.ok(!r.issue, `async login click should not report an issue, got: ${r.issue}`);
    assert.match(r.text, /URL: .*\/deals/);
    assert.match(r.text, /Pipeline/);
  } finally { s.close(); }
});

test('sandbox URL mapping: localhost ports go to the published ports, other URLs are untouched', () => {
  const { Sandbox } = require('../src/main/shell');
  const s = new Sandbox(process.cwd());
  s.ports = { 3000: 49152 };
  assert.equal(s.mapUrl('http://localhost:3000/login?x=1'), 'http://127.0.0.1:49152/login?x=1');
  assert.equal(s.mapUrl('http://127.0.0.1:3000/'), 'http://127.0.0.1:49152/');
  assert.equal(s.mapUrl('http://localhost:9999/'), 'http://localhost:9999/');
  assert.equal(s.mapUrl('https://example.com/'), 'https://example.com/');
});
