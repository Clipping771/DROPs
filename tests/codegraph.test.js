// Codebase intelligence: the import graph, impact of a change, symbols, models, API callers, cycles.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cg = require('../src/main/codegraph');

function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drops-graph-'));
  const w = (rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
  w('lib/db.ts', "export const prisma = {};\n");
  w('lib/auth.ts', "import { prisma } from './db';\nexport function verifyLogin() { return prisma.user.findUnique(); }\n");
  w('app/login/page.tsx', "import { verifyLogin } from '@/lib/auth';\nexport default function Login() { verifyLogin(); return null; }\n");
  w('app/api/users/[id]/route.ts', "import { prisma } from '../../../../lib/db';\nexport async function GET() { return prisma.user.findMany(); }\n");
  w('app/profile/Profile.tsx', "export function Profile() { return fetch(`/api/users/${1}`); }\n");
  w('tests/auth.test.ts', "import { verifyLogin } from '../lib/auth';\nverifyLogin();\n");
  w('src/a.js', "const b = require('./b');\nmodule.exports = 1;\n");
  w('src/b.js', "const a = require('./a.js');\nmodule.exports = 2;\n");
  w('py/app/main.py', "from .models import User\n");
  w('py/app/models.py', "class User: pass\n");
  w('prisma/schema.prisma', 'model User {\n  id String @id\n  posts Post[]\n}\nmodel Post {\n  id String @id\n  author User @relation(fields: [authorId], references: [id])\n  authorId String\n}\n');
  w('node_modules/x/index.js', "require('../../lib/db');\n");
  return root;
}

test('graph: relative, alias, require and Python imports resolve to project files; packages are ignored', () => {
  const g = cg.buildGraph(project());
  assert.deepEqual([...g.imports.get('app/login/page.tsx')], ['lib/auth.ts'], '@/ alias');
  assert.deepEqual([...g.imports.get('app/api/users/[id]/route.ts')], ['lib/db.ts']);
  assert.deepEqual([...g.imports.get('py/app/main.py')], ['py/app/models.py']);
  assert.ok(!g.files.has('node_modules/x/index.js'), 'packages are not mapped');
  assert.deepEqual(cg.importsOf("import a from 'x'; export { b } from './b'; const c = require(\"./c\"); await import('./d');", 'f.ts'), ['x', './b', './c', './d']);
});

test('impact of a file: direct and indirect dependents, tests to run', () => {
  const root = project();
  const r = cg.impactReport(root, 'lib/db.ts');
  assert.match(r, /Change impact of lib\/db\.ts: 4 files depend on it/);
  assert.match(r, /Imports it directly \(2\): app\/api\/users\/\[id\]\/route\.ts, lib\/auth\.ts/);
  assert.match(r, /Depend on it through others \(2\): app\/login\/page\.tsx \(2\), tests\/auth\.test\.ts \(2\)/);
  assert.match(r, /Tests to run \(1\): tests\/auth\.test\.ts/);
  assert.match(r, /not proof/);
});

test('impact of an API route lists the frontend files that call it', () => {
  const r = cg.impactReport(project(), 'app/api/users/[id]/route.ts');
  assert.match(r, /Calls to its API route \/api\/users\/\[id\] \(1\): app\/profile\/Profile\.tsx/);
});

test('impact of a database model, a symbol, and cycles', () => {
  const root = project();
  const m = cg.impactReport(root, 'User');
  assert.match(m, /database model User \(prisma\/schema\.prisma\)/);
  assert.match(m, /Models related to it \(1\): Post/);
  assert.match(m, /lib\/auth\.ts/);
  const s = cg.impactReport(root, 'verifyLogin');
  assert.match(s, /defined in lib\/auth\.ts; used in 2 other files/);
  assert.match(s, /Tests to run \(1\): tests\/auth\.test\.ts/);
  assert.match(cg.impactReport(root, 'cycles'), /src\/a\.js → src\/b\.js → src\/a\.js|src\/b\.js → src\/a\.js → src\/b\.js/);
  assert.match(cg.impactReport(root, 'lib/nothing.ts'), /Nothing named/);
});

test('context: the repository map ranks files connected to the task, not only files named like it', () => {
  const root = project();
  const map = require('../src/main/context').repoMap(root, 4000, 'fix the login page').split('\n');
  const pos = (f) => map.findIndex((l) => l.startsWith(f));
  assert.equal(pos('app/login/page.tsx'), 0, 'the named file first');
  assert.ok(pos('lib/auth.ts') > 0 && pos('lib/auth.ts') < pos('src/a.js'), 'what the login page imports comes before unrelated files');
});

test('searchCode: ranks files by concept across paths and symbol names', () => {
  const root = project();
  const res = cg.searchCode(root, 'verify user login');
  assert.match(res, /lib\/auth\.ts/);
  assert.match(res, /verifyLogin/);
});

test('codegraph: buildGraph caches results and invalidateGraph clears the cache', () => {
  const root = project();
  const g1 = cg.buildGraph(root, { cache: true });
  const g2 = cg.buildGraph(root, { cache: true });
  assert.strictEqual(g1, g2);
  cg.invalidateGraph(root);
  const g3 = cg.buildGraph(root, { cache: true });
  assert.notStrictEqual(g1, g3);
});

test('tsSymbolReferences: resolves AST-level definitions and usages when TypeScript is available', () => {
  const root = project();
  const g = cg.buildGraph(root);
  const refs = cg.tsSymbolReferences(g, 'verifyLogin');
  if (refs) {
    assert.ok(refs.defined.includes('lib/auth.ts'));
    assert.ok(refs.used.includes('app/login/page.tsx'));
  }
});

test('code_search and impact by name still work right after the repository map (they share the cached graph)', () => {
  const ctxEngine = require('../src/main/context');
  const cg = require('../src/main/codegraph');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drops-shared-graph-'));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'auth.js'), 'function verifyLogin() { return true; }\nmodule.exports = { verifyLogin };\n');
  fs.writeFileSync(path.join(dir, 'src', 'app.js'), "const { verifyLogin } = require('./auth');\nverifyLogin();\n");
  ctxEngine.repoMap(dir, 14000, 'fix the login check'); // runs at the start of every request
  assert.match(cg.searchCode(dir, 'verify login'), /src\/auth\.js/);
  assert.match(cg.impactReport(dir, 'verifyLogin'), /defined in src\/auth\.js/);
});
