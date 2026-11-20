const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const preview = require('../src/main/preview');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'drops-preview-test-'));
const proj = path.join(tmpRoot, 'proj');
fs.mkdirSync(path.join(proj, 'news'), { recursive: true });

after(async () => {
  await preview.closeAll();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function httpRaw(urlStr, rawPath) {
  const u = new URL(urlStr);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: u.hostname, port: u.port, path: rawPath, method: 'GET' },
      (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

test('ignores non-UI backend and ignored build directories', async () => {
  assert.equal(preview.isHtml('news/index.html'), true);
  assert.equal(preview.isStyleFile('news/styles.css'), true);
  assert.equal(preview.isAssetFile('news/app.js'), true);
  assert.equal(preview.isHtml('node_modules/pkg/index.html'), false);
  assert.equal(preview.isStyleFile('dist/out.css'), false);

  assert.equal(await preview.onFileChanged(proj, 'server/app.py'), null);
  assert.equal(await preview.onFileChanged(proj, 'node_modules/pkg/index.html'), null);
});

test('returns building state when CSS is written before any HTML page exists', async () => {
  fs.writeFileSync(path.join(proj, 'news', 'styles.css'), 'body { background: #0b0c0f; color: #fff; }\n');
  const res = await preview.onFileChanged(proj, 'news\\styles.css');
  assert.deepEqual(res, {
    state: 'building',
    reason: 'style',
    file: 'news/styles.css',
    activeHtml: null,
    url: null,
    pages: [],
  });
});

test('serves HTML & CSS with no-store headers, blocks path traversal, tracks multi-page navigation and reloads assets', async () => {
  fs.writeFileSync(
    path.join(proj, 'news', 'index.html'),
    '<!doctype html><html><head><link rel="stylesheet" href="styles.css"></head><body><h1>Home</h1></body></html>\n',
  );
  const p1 = await preview.onFileChanged(proj, 'news/index.html');
  assert.equal(p1.state, 'ready');
  assert.equal(p1.activeHtml, 'news/index.html');
  assert.match(p1.url, /^http:\/\/127\.0\.0\.1:\d+\/news\/index\.html$/);
  assert.equal(p1.pages.length, 1);
  assert.equal(p1.pages[0].label, 'index.html');

  const htmlRes = await httpRaw(p1.url, '/news/index.html');
  assert.equal(htmlRes.status, 200);
  assert.match(htmlRes.headers['content-type'], /text\/html/);
  assert.match(htmlRes.headers['cache-control'], /no-store/);
  assert.match(htmlRes.body, /<h1>Home<\/h1>/);

  const cssRes = await httpRaw(p1.url, '/news/styles.css');
  assert.equal(cssRes.status, 200);
  assert.match(cssRes.headers['content-type'], /text\/css/);

  const badReq = await httpRaw(p1.url, '/%E0%A4%A');
  assert.equal(badReq.status, 400);

  const traversal = await httpRaw(p1.url, '/..%2Foutside.txt');
  assert.equal(traversal.status, 403);

  fs.writeFileSync(path.join(proj, 'news', 'article.html'), '<!doctype html><html><body><h1>Article</h1></body></html>\n');
  const p2 = await preview.onFileChanged(proj, 'news/article.html');
  assert.equal(p2.state, 'ready');
  assert.equal(p2.activeHtml, 'news/article.html');
  assert.deepEqual(p2.pages.map((x) => x.label), ['index.html', 'article.html']);

  const reload = await preview.onFileChanged(proj, 'news/styles.css');
  assert.equal(reload.state, 'reload');
  assert.equal(reload.activeHtml, 'news/article.html');
  assert.equal(reload.url, p2.url);

  await preview.closeAll();
});
