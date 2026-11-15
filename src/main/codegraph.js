// Codebase intelligence: an import graph of the project and the impact of changing a file, a symbol,
// a database model or an API route. Static and fast (regex, no type checker), so it is a map, not
// proof: it can miss dynamic imports and cannot see runtime wiring.
'use strict';
const fs = require('fs');
const path = require('path');
const fg = require('fast-glob');

const SRC_EXT = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte', '.py'];
const IGNORE = ['**/node_modules/**', '**/.next/**', '**/.git/**', '**/dist/**', '**/build/**', '**/coverage/**', '**/test-results/**', '**/.drops/**', '**/.h2o/**', '**/.venv/**', '**/venv/**', '**/__pycache__/**', '**/*.min.js'];
const MAX_FILES = 5000;
const norm = (p) => p.replace(/\\/g, '/');
const read = (abs) => { try { return fs.readFileSync(abs, 'utf8'); } catch { return ''; } };

/** Import specifiers in one file's source. */
function importsOf(text, file) {
  const out = [];
  if (file.endsWith('.py')) {
    for (const m of text.matchAll(/^\s*from\s+(\.+[\w.]*|[\w.]+)\s+import\s+/gm)) out.push(m[1]);
    for (const m of text.matchAll(/^\s*import\s+([\w.]+)/gm)) out.push(m[1]);
    return out;
  }
  for (const m of text.matchAll(/\b(?:import|export)\s[^'"`;]*?\sfrom\s*['"]([^'"]+)['"]/g)) out.push(m[1]);
  for (const m of text.matchAll(/\bimport\s*['"]([^'"]+)['"]/g)) out.push(m[1]);
  for (const m of text.matchAll(/\b(?:require|import)\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1]);
  return out;
}

/** The project file an import points to, or null for a package. */
function resolveImport(spec, fromFile, files, root) {
  const tryPaths = (base) => {
    const cands = [base, ...SRC_EXT.map((e) => base + e), ...SRC_EXT.map((e) => base + '/index' + e)];
    // ESM in TS often imports "./x.js" for "./x.ts".
    if (/\.(m?js|cjs)$/.test(base)) cands.push(...['.ts', '.tsx', '.mts'].map((e) => base.replace(/\.(m?js|cjs)$/, e)));
    return cands.map(norm).find((c) => files.has(c)) || null;
  };
  if (fromFile.endsWith('.py')) {
    if (!spec.startsWith('.')) {
      const p = spec.replace(/\./g, '/');
      return tryPaths(p) || tryPaths('src/' + p);
    }
    const dots = spec.match(/^\.+/)[0].length;
    let dir = path.posix.dirname(fromFile);
    for (let i = 1; i < dots; i++) dir = path.posix.dirname(dir);
    const rest = spec.slice(dots).replace(/\./g, '/');
    return tryPaths(path.posix.join(dir, rest || '__init__'));
  }
  if (spec.startsWith('.')) return tryPaths(path.posix.join(path.posix.dirname(fromFile), spec));
  // Path aliases: "@/x" and "~/x" point at the project root or src/.
  const alias = /^[@~]\/(.*)$/.exec(spec);
  if (alias) return tryPaths(alias[1]) || tryPaths('src/' + alias[1]);
  if (spec.startsWith('/')) return tryPaths(spec.slice(1));
  return null;
}

/** Builds the graph: files, imports (file -> files) and importedBy (file -> files). */
function buildGraph(root) {
  const list = fg.sync(SRC_EXT.map((e) => `**/*${e}`), { cwd: root, ignore: IGNORE, onlyFiles: true, suppressErrors: true, deep: 14 }).map(norm).slice(0, MAX_FILES);
  const files = new Set(list);
  const imports = new Map(), importedBy = new Map(), text = new Map();
  for (const f of list) { importedBy.set(f, new Set()); }
  for (const f of list) {
    const t = read(path.join(root, f));
    text.set(f, t);
    const deps = new Set();
    for (const spec of importsOf(t, f)) {
      const r = resolveImport(spec, f, files, root);
      if (r && r !== f) deps.add(r);
    }
    imports.set(f, deps);
    for (const d of deps) importedBy.get(d)?.add(f);
  }
  return { root, files, imports, importedBy, text, truncated: list.length >= MAX_FILES };
}

/** Files that depend on `file`, level by level (1 = imports it directly). */
function dependents(g, file, depth = 3) {
  const seen = new Map([[file, 0]]);
  let frontier = [file];
  for (let d = 1; d <= depth && frontier.length; d++) {
    const next = [];
    for (const f of frontier) for (const by of g.importedBy.get(f) || []) if (!seen.has(by)) { seen.set(by, d); next.push(by); }
    frontier = next;
  }
  seen.delete(file);
  return [...seen.entries()].sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1));
}

/** Import cycles (each as a list of files), found with a depth-first search. */
function cycles(g, limit = 10) {
  const out = [], state = new Map(), stack = [];
  const seenKey = new Set();
  const visit = (f) => {
    state.set(f, 1); stack.push(f);
    for (const d of g.imports.get(f) || []) {
      if (out.length >= limit) break;
      if (state.get(d) === 1) {
        const cyc = stack.slice(stack.indexOf(d));
        const key = [...cyc].sort().join('|');
        if (!seenKey.has(key)) { seenKey.add(key); out.push(cyc); }
      } else if (!state.has(d)) visit(d);
    }
    stack.pop(); state.set(f, 2);
  };
  for (const f of g.files) if (!state.has(f) && out.length < limit) visit(f);
  return out;
}

const isTest = (f) => /(^|\/)(tests?|__tests__|spec|e2e)\/|\.(test|spec)\.[a-z]+$|_test\.py$|(^|\/)test_[^/]*\.py$/i.test(f);

/** Where a symbol (function, class, component, variable) is defined and used. */
function symbolUses(g, name) {
  const re = new RegExp(`(^|[^\\w$])${name.replace(/[$]/g, '\\$')}(?![\\w$])`);
  const defRe = new RegExp(`(function\\*?\\s+|class\\s+|(const|let|var)\\s+|def\\s+|interface\\s+|type\\s+|enum\\s+)${name.replace(/[$]/g, '\\$')}\\b|export\\s+\\{[^}]*\\b${name}\\b`);
  const defined = [], used = [];
  for (const [f, t] of g.text) {
    if (!re.test(t)) continue;
    if (defRe.test(t)) defined.push(f); else used.push(f);
  }
  return { defined, used };
}

/** Next.js-style API routes and the files that call them with fetch/axios. */
function apiCallers(g, file) {
  const m = /(?:^|\/)(?:app|pages)\/(api\/.+?)\/(?:route|index)\.[jt]sx?$|(?:^|\/)pages\/(api\/.+?)\.[jt]sx?$/.exec(file);
  if (!m) return null;
  const route = '/' + (m[1] || m[2]).replace(/\[[^\]]+\]/g, '[^/\'"`]+');
  const re = new RegExp(route.replace(/\//g, '\\/') + `(?:[/?'"\`]|$)`);
  return { route: '/' + (m[1] || m[2]), callers: [...g.text.entries()].filter(([f, t]) => f !== file && re.test(t)).map(([f]) => f) };
}

/** Prisma models (schema.prisma) and the files that use one. */
function modelUses(g, root, model) {
  const schemaFile = fg.sync(['**/schema.prisma'], { cwd: root, ignore: IGNORE, suppressErrors: true })[0];
  if (!schemaFile) return null;
  const schema = read(path.join(root, schemaFile));
  const found = new RegExp(`^model\\s+${model}\\s*\\{`, 'im').exec(schema);
  if (!found) return null;
  const name = found[0].replace(/^model\s+|\s*\{$/g, '').trim();
  const lower = name[0].toLowerCase() + name.slice(1);
  const re = new RegExp(`\\.${lower}\\.|\\b${name}\\b`);
  const relations = [...schema.matchAll(/^model\s+(\w+)\s*\{([^}]*)\}/gm)].filter((mm) => mm[1] !== name && new RegExp(`\\b${name}\\b`).test(mm[2])).map((mm) => mm[1]);
  return { model: name, schema: norm(schemaFile), files: [...g.text.entries()].filter(([, t]) => re.test(t)).map(([f]) => f), relations };
}

/**
 * A plain report of what a change to `target` touches. The target can be a file path, a symbol name,
 * a Prisma model name, or "cycles".
 */
function impactReport(root, target) {
  const g = buildGraph(root);
  const t = norm(String(target || '').trim()).replace(/^\.\//, '');
  if (!t) return 'Say what you plan to change: a file path, a function or component name, a database model, or "cycles".';
  const lines = [];
  const list = (title, arr, max = 25) => { if (arr.length) lines.push(`${title} (${arr.length}): ${arr.slice(0, max).join(', ')}${arr.length > max ? ', …' : ''}`); };
  if (t === 'cycles') {
    const cs = cycles(g);
    return cs.length ? `Import cycles (${cs.length}):\n${cs.map((c) => '- ' + [...c, c[0]].join(' → ')).join('\n')}` : 'No import cycles found.';
  }
  if (g.files.has(t)) {
    const deps = dependents(g, t);
    lines.push(`Change impact of ${t}: ${deps.length} file${deps.length === 1 ? '' : 's'} depend on it.`);
    list('Imports it directly', deps.filter(([, d]) => d === 1).map(([f]) => f));
    list('Depend on it through others', deps.filter(([, d]) => d > 1).map(([f, d]) => `${f} (${d})`));
    list('Tests to run', deps.map(([f]) => f).filter(isTest).concat(isTest(t) ? [t] : []));
    list('It imports', [...(g.imports.get(t) || [])]);
    const api = apiCallers(g, t);
    if (api) list(`Calls to its API route ${api.route}`, api.callers);
    const cyc = cycles(g).filter((c) => c.includes(t));
    if (cyc.length) lines.push(`In an import cycle: ${[...cyc[0], cyc[0][0]].join(' → ')}`);
  } else {
    const model = modelUses(g, root, t);
    if (model) {
      lines.push(`Change impact of the database model ${model.model} (${model.schema}): ${model.files.length} file${model.files.length === 1 ? '' : 's'} use it.`);
      list('Files that use it', model.files);
      list('Models related to it', model.relations);
      list('Tests to run', model.files.filter(isTest));
    }
    if (/^[A-Za-z_$][\w$]*$/.test(t)) {
      const s = symbolUses(g, t);
      if ((s.defined.length || s.used.length) && !(model && !s.defined.length)) {
        lines.push(`${model ? '\n' : ''}The name ${t}: defined in ${s.defined.join(', ') || 'no file (or not found)'}; used in ${s.used.length} other file${s.used.length === 1 ? '' : 's'}.`);
        list('Used in', s.used);
        list('Tests to run', s.used.filter(isTest));
      }
    }
    if (!lines.length) return `Nothing named "${t}" was found: give a file path relative to the project (e.g. src/lib/auth.ts), a function or component name, or a Prisma model name.`;
  }
  if (g.truncated) lines.push(`(Only the first ${MAX_FILES} source files were mapped.)`);
  lines.push('This is a static map (imports and names), not proof: run the listed tests after the change.');
  return lines.join('\n');
}

module.exports = { buildGraph, dependents, cycles, impactReport, importsOf, resolveImport, symbolUses };
