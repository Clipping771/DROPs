// Context engine: project profile, repository map, and conversation compaction.
const fs = require('fs');
const path = require('path');
const fg = require('fast-glob');
const { execFileSync } = require('child_process');
const { IGNORE } = require('./tools');

const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
const exists = (p) => fs.existsSync(p);

// ---------- project profile ----------
function projectProfile(root) {
  const lines = [];
  const verify = [];
  const pkg = read(path.join(root, 'package.json'));
  if (pkg) {
    try {
      const j = JSON.parse(pkg);
      const pm = exists(path.join(root, 'pnpm-lock.yaml')) ? 'pnpm' : exists(path.join(root, 'yarn.lock')) ? 'yarn' : exists(path.join(root, 'bun.lockb')) || exists(path.join(root, 'bun.lock')) ? 'bun' : 'npm';
      const deps = Object.keys({ ...j.dependencies, ...j.devDependencies });
      const fw = ['next', 'react', 'vue', 'svelte', '@angular/core', 'electron', 'express', 'fastify', 'nestjs', 'vite', 'typescript', 'jest', 'vitest', 'mocha', 'playwright', 'tailwindcss', 'prisma'].filter((d) => deps.includes(d) || deps.includes('@nestjs/core') && d === 'nestjs');
      lines.push(`- Node.js project "${j.name || ''}" (package manager: ${pm})${fw.length ? `; uses ${fw.join(', ')}` : ''}`);
      const scripts = j.scripts || {};
      const names = Object.keys(scripts);
      if (names.length) lines.push(`- package.json scripts: ${names.map((n) => `${n} = \`${String(scripts[n]).slice(0, 80)}\``).join('; ')}`);
      for (const s of ['typecheck', 'lint', 'test', 'build']) if (scripts[s]) verify.push(`${pm} run ${s}`);
      if (!scripts.typecheck && deps.includes('typescript') && exists(path.join(root, 'tsconfig.json'))) verify.push('npx tsc --noEmit');
    } catch { /* bad json */ }
  }
  if (exists(path.join(root, 'pyproject.toml')) || exists(path.join(root, 'requirements.txt')) || exists(path.join(root, 'setup.py'))) {
    lines.push('- Python project' + (exists(path.join(root, 'pyproject.toml')) ? ' (pyproject.toml)' : ''));
    if (exists(path.join(root, 'tests')) || exists(path.join(root, 'pytest.ini'))) verify.push('python -m pytest -q');
  }
  if (exists(path.join(root, 'Cargo.toml'))) { lines.push('- Rust project (Cargo)'); verify.push('cargo check', 'cargo test'); }
  if (exists(path.join(root, 'go.mod'))) { lines.push('- Go module'); verify.push('go build ./...', 'go test ./...'); }
  const sln = fg.sync(['*.sln', '*.csproj', '*/*.csproj'], { cwd: root, deep: 2 });
  if (sln.length) { lines.push(`- .NET project (${sln.slice(0, 3).join(', ')})`); verify.push('dotnet build', 'dotnet test'); }
  if (exists(path.join(root, 'Makefile'))) lines.push('- Has a Makefile');
  if (exists(path.join(root, 'Dockerfile'))) lines.push('- Has a Dockerfile');
  let git = '';
  try {
    git = execFileSync('git', ['-C', root, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8', windowsHide: true, timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    lines.push(`- Git repository, branch \`${git}\``);
  } catch { lines.push('- Not a git repository (DROPs checkpoints still protect your files)'); }
  return { text: lines.join('\n'), verify: [...new Set(verify)], branch: git };
}

// ---------- repository map ----------
const SYMBOL_RES = {
  js: [/^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|class|const|let|interface|type|enum)\s+([A-Za-z_$][\w$]*)/, /^\s*(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)\s*\(/, /^\s*class\s+([A-Za-z_$][\w$]*)/, /^(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=/],
  py: [/^(?:async\s+)?def\s+([A-Za-z_]\w*)/, /^class\s+([A-Za-z_]\w*)/],
  go: [/^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, /^type\s+([A-Za-z_]\w*)/],
  rs: [/^\s*pub\s+(?:async\s+)?fn\s+([A-Za-z_]\w*)/, /^\s*(?:pub\s+)?(?:struct|enum|trait)\s+([A-Za-z_]\w*)/],
  cs: [/^\s*(?:public|internal)\s+(?:static\s+|sealed\s+|abstract\s+|partial\s+)*(?:class|interface|record|struct|enum)\s+([A-Za-z_]\w*)/],
  java: [/^\s*public\s+(?:final\s+|abstract\s+)*(?:class|interface|enum|record)\s+([A-Za-z_]\w*)/],
};
const EXT = { '.js': 'js', '.jsx': 'js', '.ts': 'js', '.tsx': 'js', '.mjs': 'js', '.cjs': 'js', '.vue': 'js', '.svelte': 'js', '.py': 'py', '.go': 'go', '.rs': 'rs', '.cs': 'cs', '.java': 'java', '.kt': 'java' };

function repoMap(root, budget = 14000, query = '') {
  let entries = [];
  try {
    entries = fg.sync('**/*', { cwd: root, ignore: [...IGNORE, '**/*.min.*', '**/*.lock', '**/package-lock.json', '**/*.map', '**/coverage/**'], onlyFiles: true, dot: false, stats: true, suppressErrors: true, deep: 10 });
  } catch { return ''; }
  const total = entries.length;
  const kw = [...new Set(String(query || '').toLowerCase().match(/[a-z0-9_]{3,}/g) || [])];
  const scoreEntry = (e) => {
    const low = e.path.toLowerCase();
    let score = 0;
    for (const w of kw) if (low.includes(w)) score += 100;
    if (/^(src|lib|app)\//i.test(low) || !low.includes('/')) score += 20;
    if (/^(tests?|__tests__|bench|docs|examples)\//i.test(low)) score -= 15;
    return score;
  };
  // Dependency-aware: files that import or are imported by a keyword match are relevant too
  // ("fix the auth problem" brings in what auth.ts uses and what uses it).
  const related = new Map();
  if (kw.length && total < 4000) {
    try {
      const g = require('./codegraph').buildGraph(root);
      for (const e of entries) {
        const p = e.path.replace(/\\/g, '/');
        if (!kw.some((w) => p.toLowerCase().includes(w))) continue;
        for (const d of g.imports.get(p) || []) related.set(d, (related.get(d) || 0) + 40);
        for (const d of g.importedBy.get(p) || []) related.set(d, (related.get(d) || 0) + 30);
      }
    } catch { /* the map still works without the graph */ }
  }
  const score = new Map(entries.map((e) => [e, scoreEntry(e) + Math.min(80, related.get(e.path.replace(/\\/g, '/')) || 0)]));
  entries.sort((a, b) => score.get(b) - score.get(a) || (b.stats?.mtimeMs || 0) - (a.stats?.mtimeMs || 0) || a.path.localeCompare(b.path));
  const out = [];
  let used = 0;
  for (const e of entries) {
    const f = e.path;
    if (used > budget) { out.push(`… (${total} files total; map truncated — use glob/grep)`); break; }
    const lang = EXT[path.extname(f).toLowerCase()];
    let syms = [];
    if (lang) {
      const abs = path.join(root, f);
      try {
        if ((e.stats?.size ?? fs.statSync(abs).size) < 300_000) {
          const text = fs.readFileSync(abs, 'utf8');
          const seen = new Set();
          for (const line of text.split('\n')) {
            for (const re of SYMBOL_RES[lang]) {
              const m = line.match(re);
              if (m && !seen.has(m[1])) { seen.add(m[1]); syms.push(m[1]); break; }
            }
            if (syms.length >= 14) { syms.push('…'); break; }
          }
        }
      } catch { /* unreadable */ }
    }
    const line = syms.length ? `${f}: ${syms.join(', ')}` : f;
    out.push(line);
    used += line.length + 1;
  }
  return out.join('\n');
}

// ---------- compaction ----------
// Renders messages as plain text for the summarizer (avoids tool pairing rules).
function transcriptText(messages, limit = 400_000) {
  const parts = [];
  for (const m of messages) {
    const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content || [];
    for (const b of blocks) {
      if (b.type === 'text') parts.push(`${m.role.toUpperCase()}: ${b.text}`);
      else if (b.type === 'tool_use') parts.push(`ASSISTANT called ${b.name}(${JSON.stringify(b.input).slice(0, 600)})`);
      else if (b.type === 'tool_result') {
        const t = typeof b.content === 'string' ? b.content : (b.content || []).map((c) => c.text || '').join('\n');
        parts.push(`TOOL RESULT${b.is_error ? ' (error)' : ''}: ${t.slice(0, 1500)}`);
      } else if (b.type === 'image') parts.push(`${m.role.toUpperCase()}: [image]`);
    }
  }
  let s = parts.join('\n');
  if (s.length > limit) s = '…(earliest part omitted)…\n' + s.slice(-limit);
  return s;
}

const SUMMARY_SYSTEM = `You compress a coding session so the agent can continue seamlessly with a much shorter context. Write a dense, factual handoff in Markdown with these sections:
## Goal — what the user wants overall, including constraints and preferences they stated.
## Done so far — concrete changes made (files, functions), commands run and their results.
## Current state — what works, what is broken, failing tests/errors verbatim if relevant.
## Key facts — architecture notes, file paths, APIs, decisions and their reasons the agent must remember.
## Next steps — the remaining plan.
Be specific (paths, names, numbers). No pleasantries.`;

module.exports = { projectProfile, repoMap, transcriptText, SUMMARY_SYSTEM };
