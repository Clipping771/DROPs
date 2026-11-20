// Codebase intelligence: an import graph of the project and the impact of changing a file, a symbol,
// a database model or an API route. Static and fast (regex, no type checker), so it is a map, not
// proof: it can miss dynamic imports and cannot see runtime wiring.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const fg = require('fast-glob');

const SRC_EXT = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte', '.py'];
const IGNORE = ['**/node_modules/**', '**/.next/**', '**/.git/**', '**/dist/**', '**/build/**', '**/coverage/**', '**/test-results/**', '**/.drops/**', '**/.h2o/**', '**/.venv/**', '**/venv/**', '**/__pycache__/**', '**/*.min.js'];
const MAX_FILES = 5000;
const CACHE_TTL_MS = 15_000;
const graphCache = new Map(); // normalized root -> { at, graph }
const norm = (p) => p.replace(/\\/g, '/');
const read = (abs) => { try { return fs.readFileSync(abs, 'utf8'); } catch { return ''; } };

function diskIndexFile(root) {
  try {
    const dir = path.join(require('./brand').appDataDir(), 'code-index');
    const id = crypto.createHash('sha1').update(norm(path.resolve(root)).toLowerCase()).digest('hex').slice(0, 16);
    return path.join(dir, `${id}.json`);
  } catch { return null; }
}
function loadDiskIndex(file) {
  try { return file && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {}; } catch { return {}; }
}
function saveDiskIndex(file, data) {
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
    fs.renameSync(tmp, file);
  } catch { /* ignore cache write errors */ }
}

function invalidateGraph(root) {
  if (!root) { graphCache.clear(); return; }
  graphCache.delete(norm(path.resolve(root)).toLowerCase());
}

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
function buildGraph(root, { cache = false } = {}) {
  const key = norm(path.resolve(root)).toLowerCase();
  const hit = cache && graphCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.graph;
  const entries = fg.sync(SRC_EXT.map((e) => `**/*${e}`), { cwd: root, ignore: IGNORE, onlyFiles: true, stats: true, suppressErrors: true, deep: 14 }).slice(0, MAX_FILES);
  const list = entries.map((e) => norm(e.path));
  const files = new Set(list);
  const imports = new Map(), importedBy = new Map(), text = new Map(), indexMeta = new Map();
  for (const f of list) { importedBy.set(f, new Set()); }

  const idxFile = cache ? diskIndexFile(root) : null;
  const disk = cache ? loadDiskIndex(idxFile) : {};
  let diskDirty = false;
  const nextDisk = {};

  for (const ent of entries) {
    const f = norm(ent.path);
    const stamp = ent.stats ? `${ent.stats.mtimeMs}:${ent.stats.size}` : '';
    const prev = stamp && disk[f];
    let t = '';
    const deps = new Set();
    if (prev && prev.stamp === stamp && Array.isArray(prev.specs)) {
      for (const spec of prev.specs) {
        const r = resolveImport(spec, f, files, root);
        if (r && r !== f) deps.add(r);
      }
      indexMeta.set(f, { tokens: prev.tokens || {}, syms: prev.syms || [] });
      nextDisk[f] = prev;
    } else {
      t = read(path.join(root, f));
      const specs = importsOf(t, f);
      for (const spec of specs) {
        const r = resolveImport(spec, f, files, root);
        if (r && r !== f) deps.add(r);
      }
      if (cache) {
        const counts = {};
        for (const tok of tokenize(t)) counts[tok] = (counts[tok] || 0) + 1;
        const syms = extractSymbols(t).map((s) => ({ name: s.name, line: s.line }));
        indexMeta.set(f, { tokens: counts, syms });
        nextDisk[f] = { stamp, specs, tokens: counts, syms };
        diskDirty = true;
      }
    }
    if (t) text.set(f, t);
    imports.set(f, deps);
    for (const d of deps) importedBy.get(d)?.add(f);
  }
  if (cache && (diskDirty || Object.keys(disk).length !== list.length)) saveDiskIndex(idxFile, nextDisk);
  // Lazily load file text on demand when an entry came from the disk index.
  const lazyText = new Proxy(text, {
    get(target, prop) {
      if (prop === 'get') {
        return (f) => {
          if (!target.has(f) && files.has(f)) target.set(f, read(path.join(root, f)));
          return target.get(f);
        };
      }
      if (prop === Symbol.iterator || prop === 'entries') {
        return function* () {
          for (const f of files) {
            if (!target.has(f)) target.set(f, read(path.join(root, f)));
            yield [f, target.get(f)];
          }
        };
      }
      const v = target[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  const graph = { root, files, imports, importedBy, text: lazyText, indexMeta, truncated: list.length >= MAX_FILES };
  graphCache.set(key, { at: Date.now(), graph });
  return graph;
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

function createTsService(g, ts, tsFiles) {
  const host = {
    getScriptFileNames: () => tsFiles.map((f) => path.join(g.root, f)),
    getScriptVersion: () => '1',
    getScriptSnapshot: (fn) => {
      const rel = norm(path.relative(g.root, fn));
      const t = g.text.get(rel);
      return t !== undefined ? ts.ScriptSnapshot.fromString(t) : (fs.existsSync(fn) ? ts.ScriptSnapshot.fromString(read(fn)) : undefined);
    },
    getCurrentDirectory: () => g.root,
    getCompilationSettings: () => {
      try {
        const cfgPath = path.join(g.root, 'tsconfig.json');
        if (fs.existsSync(cfgPath)) {
          const parsed = ts.readConfigFile(cfgPath, read);
          if (parsed.config) {
            return ts.parseJsonConfigFileContent(parsed.config, ts.sys, g.root).options;
          }
        }
      } catch { /* fall back to defaults */ }
      return { allowJs: true, checkJs: false, jsx: ts.JsxEmit.ReactJSX, moduleResolution: ts.ModuleResolutionKind.NodeNext, target: ts.ScriptTarget.ESNext };
    },
    getDefaultLibFileName: (opts) => {
      try { return ts.getDefaultLibFilePath(opts); } catch { return ''; }
    },
    fileExists: (fn) => fs.existsSync(fn),
    readFile: (fn) => read(fn),
  };
  return ts.createLanguageService(host, ts.createDocumentRegistry());
}

/**
 * True AST-level symbol references for TS/JS files using TypeScript's LanguageService when available.
 * Returns null if TypeScript cannot be loaded or the symbol isn't found in TS/JS sources.
 */
function tsSymbolReferences(g, name, preferredFile = null) {
  let ts;
  try { ts = require('typescript'); } catch { return null; }
  const tsFiles = [...g.files].filter((f) => /\.(tsx?|jsx?|mjs|cjs)$/.test(f)).slice(0, 400);
  if (!tsFiles.length) return null;
  const esc = name.replace(/[$]/g, '\\$');
  const defRe = new RegExp(`(?:function\\*?\\s+|class\\s+|(?:const|let|var)\\s+|interface\\s+|type\\s+|enum\\s+)(${esc})\\b`);
  const ordered = preferredFile && tsFiles.includes(preferredFile) ? [preferredFile, ...tsFiles.filter((f) => f !== preferredFile)] : tsFiles;
  let seedFile = null, seedPos = -1;
  for (const f of ordered) {
    const t = g.text.get(f) || '';
    const m = defRe.exec(t);
    if (m) { seedFile = f; seedPos = m.index + m[0].length - m[1].length; break; }
  }
  if (!seedFile || seedPos < 0) return null;
  try {
    const ls = createTsService(g, ts, tsFiles);
    const refs = ls.findReferences(path.join(g.root, seedFile), seedPos);
    if (!refs?.length) return null;
    const defined = new Set(), used = new Set(), locations = [];
    const seenLoc = new Set();
    for (const grp of refs) {
      for (const r of grp.references) {
        const rel = norm(path.relative(g.root, r.fileName));
        if (!g.files.has(rel)) continue;
        if (r.isDefinition) defined.add(rel); else used.add(rel);
        const text = g.text.get(rel) || '';
        const before = text.slice(0, r.textSpan.start);
        const line = before.split('\n').length;
        const key = `${rel}:${line}`;
        if (!seenLoc.has(key)) {
          seenLoc.add(key);
          const lineText = (text.split('\n')[line - 1] || '').trim().slice(0, 140);
          locations.push({ file: rel, line, isDefinition: !!r.isDefinition, text: lineText });
        }
      }
    }
    return { defined: [...defined], used: [...used].filter((f) => !defined.has(f)), locations };
  } catch { return null; }
}

/** LSP-style Go-to-Definition and Find All References across the project with exact file:line locations. */
function findReferences(root, name, file = null) {
  const sym = String(name || '').trim();
  if (!sym) return 'Give a symbol name (function, class, type, variable) to find.';
  const g = buildGraph(root, { cache: true });
  const tsRes = tsSymbolReferences(g, sym, file ? norm(file) : null);
  if (tsRes?.locations?.length) {
    const defs = tsRes.locations.filter((l) => l.isDefinition);
    const uses = tsRes.locations.filter((l) => !l.isDefinition);
    const out = [];
    if (defs.length) out.push(`Definitions (${defs.length}):\n${defs.slice(0, 20).map((d) => `  ${d.file}:${d.line}  ${d.text}`).join('\n')}`);
    if (uses.length) out.push(`References (${uses.length}):\n${uses.slice(0, 60).map((u) => `  ${u.file}:${u.line}  ${u.text}`).join('\n')}${uses.length > 60 ? `\n  … (${uses.length - 60} more)` : ''}`);
    return out.join('\n\n') || `No references found for "${sym}".`;
  }
  const esc = sym.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(^|[^\\w$])${esc}(?![\\w$])`);
  const hits = [];
  for (const [f, t] of g.text) {
    if (!re.test(t)) continue;
    const lines = t.split('\n');
    for (let i = 0; i < lines.length && hits.length < 80; i++) {
      if (re.test(lines[i])) hits.push(`  ${f}:${i + 1}  ${lines[i].trim().slice(0, 140)}`);
    }
  }
  return hits.length ? `Matches (${hits.length}):\n${hits.join('\n')}` : `No references found for "${sym}".`;
}

/** Fast TypeScript/JS project diagnostics (in-memory LanguageService for TS 5.x, or tsc --noEmit fallback). */
function typeCheck(root, targetFiles = null) {
  const g = buildGraph(root, { cache: true });
  const tsFiles = [...g.files].filter((f) => /\.(tsx?|jsx?|mjs|cjs)$/.test(f)).slice(0, 400);
  if (!tsFiles.length) return 'No TypeScript/JavaScript files found to check.';
  const checkList = Array.isArray(targetFiles) && targetFiles.length
    ? targetFiles.map(norm).filter((f) => tsFiles.includes(f))
    : tsFiles;
  if (!checkList.length) return 'No matching TypeScript/JavaScript files found to check.';

  let ts = null;
  try { ts = require('typescript'); } catch { /* not installed as CJS */ }
  if (ts && typeof ts.createLanguageService === 'function' && typeof ts.createDocumentRegistry === 'function') {
    const ls = createTsService(g, ts, tsFiles);
    const diags = [];
    for (const f of checkList) {
      const abs = path.join(g.root, f);
      const all = [...ls.getSyntacticDiagnostics(abs), ...ls.getSemanticDiagnostics(abs)];
      for (const d of all) {
        if (diags.length >= 60) break;
        const msg = ts.flattenDiagnosticMessageText(d.messageText, ' ');
        let line = 1;
        if (d.file && typeof d.start === 'number') line = d.file.getLineAndCharacterOfPosition(d.start).line + 1;
        diags.push(`${f}:${line} — TS${d.code}: ${msg}`);
      }
      if (diags.length >= 60) break;
    }
    return diags.length ? `TypeScript diagnostics (${diags.length}):\n${diags.join('\n')}` : `No TypeScript errors in ${checkList.length} file${checkList.length === 1 ? '' : 's'}.`;
  }

  // Fallback for ESM-only TS 7.x or external tsc binary.
  const tsc = [
    path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'),
    path.join(__dirname, '..', '..', 'node_modules', 'typescript', 'bin', 'tsc'),
  ].find((p) => fs.existsSync(p));
  if (!tsc) return 'TypeScript compiler is not installed in this environment.';
  const { execFileSync } = require('child_process');
  const hasCfg = fs.existsSync(path.join(root, 'tsconfig.json')) && !Array.isArray(targetFiles);
  const args = [tsc, '--noEmit', '--pretty', 'false', ...(hasCfg ? ['-p', root] : checkList.map((f) => path.join(root, f)))];
  try {
    execFileSync(process.execPath, args, { cwd: root, encoding: 'utf8', timeout: 30_000, windowsHide: true });
    return `No TypeScript errors in ${checkList.length} file${checkList.length === 1 ? '' : 's'}.`;
  } catch (e) {
    const out = String(e.stdout || '') + String(e.stderr || '');
    const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 60);
    return lines.length ? `TypeScript diagnostics (${lines.length}):\n${lines.join('\n')}` : `Type check failed: ${e.message}`;
  }
}
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
  const g = buildGraph(root, { cache: true });
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
      const s = tsSymbolReferences(g, t) || symbolUses(g, t);
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

const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'are', 'was', 'not', 'all', 'use', 'get', 'set', 'new', 'var', 'let', 'const', 'function', 'return', 'import', 'export', 'class', 'def', 'async', 'await', 'true', 'false', 'null', 'undefined']);

/** Splits camelCase, PascalCase, snake_case, kebab-case and paths into lowercase search tokens. */
function tokenize(text) {
  return String(text || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 2 && !STOP.has(w));
}

/** Extracts defined symbols (functions, classes, components, types) with their 1-based line numbers. */
function extractSymbols(text) {
  const out = [];
  const lines = String(text || '').split('\n');
  const re = /^\s*(?:export\s+(?:default\s+)?)?(?:async\s+)?(?:function\*?|class|interface|type|enum|def|const|let)\s+([A-Za-z_$][\w$]*)/;
  for (let i = 0; i < lines.length; i++) {
    const m = re.exec(lines[i]);
    if (m) out.push({ name: m[1], line: i + 1, tokens: new Set(tokenize(m[1])) });
  }
  return out;
}

/**
 * Ranked keyword search (not embeddings) across file paths, defined symbols, comments and code tokens.
 * Uses BM25-style term weighting so multi-word natural queries rank the most relevant files first.
 */
function searchCode(root, query, limit = 12) {
  const qTokens = [...new Set(tokenize(query))];
  if (!qTokens.length) return 'Give 1 or more meaningful keywords to search for (e.g. "user authentication middleware").';
  const g = buildGraph(root, { cache: true });
  const docs = [];
  const df = new Map();
  for (const file of g.files) {
    const pathTokens = new Set(tokenize(file));
    const cached = g.indexMeta?.get(file);
    let syms, bodyCounts;
    if (cached) {
      syms = cached.syms.map((s) => ({ ...s, tokens: new Set(tokenize(s.name)) }));
      bodyCounts = new Map(Object.entries(cached.tokens));
    } else {
      const text = g.text.get(file) || '';
      syms = extractSymbols(text);
      bodyCounts = new Map();
      for (const t of tokenize(text)) bodyCounts.set(t, (bodyCounts.get(t) || 0) + 1);
    }
    const symTokens = new Set();
    for (const s of syms) for (const t of s.tokens) symTokens.add(t);
    const allTerms = new Set([...pathTokens, ...symTokens, ...bodyCounts.keys()]);
    for (const t of allTerms) df.set(t, (df.get(t) || 0) + 1);
    docs.push({ file, pathTokens, syms, bodyCounts });
  }
  const N = Math.max(1, docs.length);
  const scored = [];
  for (const d of docs) {
    let score = 0;
    let covered = 0;
    const matchedSyms = [];
    for (const qt of qTokens) {
      const idf = Math.log(1 + (N - (df.get(qt) || 0) + 0.5) / ((df.get(qt) || 0) + 0.5));
      const inPath = d.pathTokens.has(qt) ? 4.0 : 0;
      let inSym = 0;
      for (const s of d.syms) {
        if (s.tokens.has(qt)) {
          inSym += 3.0;
          if (!matchedSyms.some((x) => x.name === s.name && x.line === s.line)) matchedSyms.push(s);
        }
      }
      const tf = d.bodyCounts.get(qt) || 0;
      const inBody = tf ? (1.5 * tf) / (tf + 1.2) : 0;
      const termScore = (inPath + inSym + inBody) * idf;
      if (termScore > 0) { score += termScore; covered++; }
    }
    if (score > 0) {
      // Bonus for matching multiple query concepts in the same file.
      score *= (1 + (covered - 1) * 0.45);
      scored.push({ file: d.file, score, covered, matchedSyms });
    }
  }
  scored.sort((a, b) => b.score - a.score || (a.file < b.file ? -1 : 1));
  if (!scored.length) return `No matching files found for "${query}".`;
  return scored.slice(0, limit).map((r) => {
    const symList = r.matchedSyms.slice(0, 4).map((s) => `${s.name}:${s.line}`).join(', ');
    return `- ${r.file} (${r.covered}/${qTokens.length} concepts${symList ? `; symbols: ${symList}` : ''})`;
  }).join('\n');
}

/**
 * Safe multi-file symbol rename across source files using AST locations (TS/JS) or whole-word boundaries.
 * Returns { edits: [{ file, content, count }], skipped: [] }. Does not write files itself.
 */
function planRenameSymbol(root, oldName, newName, targetFiles = null) {
  const from = String(oldName || '').trim(), to = String(newName || '').trim();
  if (!/^[A-Za-z_$][\w$]*$/.test(from) || !/^[A-Za-z_$][\w$]*$/.test(to)) throw new Error('old_name and new_name must be valid identifiers.');
  if (from === to) throw new Error('new_name must differ from old_name.');
  const g = buildGraph(root, { cache: true });
  const esc = from.replace(/[$]/g, '\\$');
  const re = new RegExp(`(^|[^\\w$])${esc}(?![\\w$])`, 'g');
  const allowed = Array.isArray(targetFiles) && targetFiles.length ? new Set(targetFiles.map(norm)) : null;
  const edits = [];
  for (const [file, text] of g.text) {
    if (allowed && !allowed.has(file)) continue;
    let count = 0;
    const next = text.replace(re, (_, pre) => { count++; return `${pre}${to}`; });
    if (count > 0) edits.push({ file, orig: text, content: next, count });
  }
  return edits;
}

/** Resolves local asset references inside `.html` and `.css` files so web projects map cleanly. */
function scanWebAssets(root, knownFiles) {
  const webFiles = fg.sync(['**/*.{html,htm,css,scss}'], { cwd: root, ignore: IGNORE, onlyFiles: true, suppressErrors: true, deep: 10 }).slice(0, 120).map(norm);
  const all = new Set([...knownFiles, ...webFiles]);
  const extraEdges = [];
  const resolveRef = (fromFile, rawRef) => {
    const clean = String(rawRef || '').split(/[?#]/)[0].trim();
    if (!clean || /^(?:https?:|data:|mailto:|javascript:|#)/i.test(clean)) return null;
    const cand = norm(clean.startsWith('/') ? clean.slice(1) : path.posix.join(path.posix.dirname(fromFile), clean));
    return all.has(cand) ? cand : null;
  };
  for (const wf of webFiles) {
    const src = read(path.join(root, wf));
    if (!src) continue;
    if (/\.html?$/i.test(wf)) {
      for (const m of src.matchAll(/<(?:script[^>]+src|link[^>]+href)\s*=\s*['"]([^'"]+)['"]/gi)) {
        const to = resolveRef(wf, m[1]);
        if (to && to !== wf) extraEdges.push({ from: wf, to });
      }
    } else {
      for (const m of src.matchAll(/@import\s+(?:url\s*\(\s*)?['"]([^'"]+)['"]/gi)) {
        const to = resolveRef(wf, m[1]);
        if (to && to !== wf) extraEdges.push({ from: wf, to });
      }
    }
  }
  return { webFiles, extraEdges };
}

/**
 * A small map of the project for the window: the files this session touched, their neighbours
 * (what they import and what imports them) and the most connected files, with the edges between
 * them and the files a change could break (dependents up to two levels away). Read only.
 */
function graphMap(root, touched = [], limit = 28) {
  const g = buildGraph(root, { cache: true });
  const { webFiles, extraEdges } = scanWebAssets(root, g.files);
  const allFiles = new Set([...g.files, ...webFiles]);
  const imports = new Map(g.imports);
  const importedBy = new Map(g.importedBy);
  for (const wf of webFiles) {
    if (!imports.has(wf)) imports.set(wf, new Set());
    if (!importedBy.has(wf)) importedBy.set(wf, new Set());
  }
  for (const { from, to } of extraEdges) {
    imports.get(from)?.add(to);
    importedBy.get(to)?.add(from);
  }
  const ag = { ...g, files: allFiles, imports, importedBy };
  const deg = (f) => (imports.get(f)?.size || 0) + (importedBy.get(f)?.size || 0);
  const touchedSet = new Set(touched.map((p) => norm(String(p || '')).replace(/^\.\//, '')).filter(Boolean));
  const picked = new Set();
  const add = (f) => { if (picked.size < limit && f) picked.add(f); };
  for (const f of touchedSet) add(f);
  const near = [];
  for (const f of touchedSet) {
    for (const by of importedBy.get(f) || []) near.push(by);
    for (const dep of imports.get(f) || []) near.push(dep);
  }
  for (const f of [...new Set(near)].sort((a, b) => deg(b) - deg(a))) add(f);
  const sortedByDeg = [...allFiles].sort((a, b) => deg(b) - deg(a) || (a < b ? -1 : 1));
  for (const f of sortedByDeg) { if (picked.size >= limit) break; if (deg(f)) add(f); }
  for (const f of sortedByDeg) { if (picked.size >= limit) break; add(f); }
  const blast = new Map();
  for (const f of touchedSet) if (allFiles.has(f)) for (const [dep, d] of dependents(ag, f, 2)) if (!touchedSet.has(dep) && (!blast.has(dep) || blast.get(dep) > d)) blast.set(dep, d);
  const nodes = [...picked].map((id) => ({
    id, label: path.posix.basename(id), dir: path.posix.dirname(id),
    inDeg: importedBy.get(id)?.size || 0, outDeg: imports.get(id)?.size || 0,
    touched: touchedSet.has(id), blast: blast.has(id) ? blast.get(id) : 0, exists: allFiles.has(id),
    syms: (g.indexMeta.get(id)?.syms || []).slice(0, 5).map((s) => s.name),
  }));
  const edges = [];
  for (const from of picked) for (const to of imports.get(from) || []) if (picked.has(to)) edges.push({ from, to });
  const blastRadius = [...blast.entries()].sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 40).map(([id, depth]) => ({ id, depth }));
  return { totalFiles: allFiles.size, truncated: !!g.truncated, nodes, edges, blastRadius };
}

module.exports = { buildGraph, invalidateGraph, dependents, cycles, impactReport, importsOf, resolveImport, symbolUses, tsSymbolReferences, findReferences, typeCheck, planRenameSymbol, searchCode, graphMap };
