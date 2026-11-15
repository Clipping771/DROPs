// Static audit: each rule finds its problem with file:line, hides secret values, skips packages, and
// does not flag safe code.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scan, auditReport } = require('../src/main/audit');

function project(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drops-audit-'));
  for (const [rel, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); }
  return root;
}
const ids = (r) => r.findings.map((f) => `${f.id}@${f.where}`);

test('security rules: injection, eval, raw HTML, shell input, CORS, cookies, plain passwords, TLS', () => {
  const r = scan(project({
    'app/api/users/route.ts': [
      "const rows = await db.query(`SELECT * FROM users WHERE id = ${req.query.id}`);", // 1 sql + select-star
      'eval(body.code);', // 2
      "exec(`convert ${req.body.file} out.png`);", // 3
      "app.use(cors());", // 4
      "res.cookie('sid', token);", // 5 (no httpOnly anywhere in the file)
      'await prisma.user.create({ data: { email, password: body.password } });', // 6
      'const agent = new https.Agent({ rejectUnauthorized: false });', // 7
    ].join('\n'),
    'app/page.tsx': 'export default function P({ data }) { return <div dangerouslySetInnerHTML={{ __html: data }} />; }\n',
    'node_modules/bad/index.js': 'eval(x);\n',
  }), { area: 'security' });
  const got = ids(r);
  for (const want of ['sql-concat@app/api/users/route.ts:1', 'eval@app/api/users/route.ts:2', 'shell-input@app/api/users/route.ts:3', 'cors-any@app/api/users/route.ts:4', 'cookie-flags@app/api/users/route.ts:5', 'plain-password@app/api/users/route.ts:6', 'tls-off@app/api/users/route.ts:7', 'raw-html@app/page.tsx:1']) {
    assert.ok(got.includes(want), `${want} in ${got.join(', ')}`);
  }
  assert.ok(!got.some((x) => x.includes('node_modules')), 'packages are not audited');
  assert.ok(!got.some((x) => x.startsWith('select-star')), 'area "security" leaves out performance rules');
});

test('secrets are found but their values are never printed', () => {
  const key = 'sk-proj-' + 'A'.repeat(30);
  const root = project({ 'lib/ai.ts': `const k = "${key}";\n`, '.env': 'DATABASE_URL="postgresql://u:verysecret@h/db"\n', '.env.example': 'DATABASE_URL="..."\n' });
  const report = auditReport(root, 'security');
  assert.match(report, /\[high\] lib\/ai\.ts:1 secret-key: \(value hidden\)/);
  assert.match(report, /\.env:1 env-file/);
  assert.doesNotMatch(report, /AAAAAAAAAA|verysecret/, 'no secret value in the report');
  assert.doesNotMatch(report, /\.env\.example/);
});

test('performance: a query inside a loop is found; the same query outside a loop or in a one-line map is not', () => {
  const r = scan(project({
    'app/api/checkout/route.ts': [
      'for (const item of items) {', // 1
      '  const p = await prisma.product.findUnique({ where: { id: item.id } });', // 2: N+1
      '}', // 3
      'const all = await prisma.product.findMany({ where: { id: { in: ids } } });', // 4: fine
      'const names = all.map((p) => p.name);', // 5: one-line map, no query
      'const rows = await prisma.order.findMany();', // 6: unpaginated
    ].join('\n'),
  }), { area: 'performance' });
  const got = ids(r);
  assert.ok(got.includes('query-in-loop@app/api/checkout/route.ts:2'));
  assert.ok(!got.includes('query-in-loop@app/api/checkout/route.ts:4'), 'outside the loop');
  assert.ok(got.includes('no-pagination@app/api/checkout/route.ts:6'));
});

test('a clean project says so, and says that is not proof', () => {
  assert.match(auditReport(project({ 'lib/sum.ts': 'export const sum = (a: number, b: number) => a + b;\n' })), /no findings from the rules\. That is not proof/);
});
