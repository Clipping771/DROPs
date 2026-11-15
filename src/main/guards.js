// Reliability guards. Kept separate so they can be unit-tested without a model.
//
// Verification guard: only commands that really verify the work count (the project's own
// test/build/type-check/lint commands, known test runners, or running a file that was edited).
// Running `ls` or `echo done` no longer satisfies it, and a failing check must be fixed.
//
// Loop guard: besides identical repeats, it tracks *failure patterns* — the same tool failing on
// the same target (same file, same command family) with different arguments. Progress resets it:
// a successful edit clears command-failure streaks (re-running tests after a fix is legitimate),
// and re-reading a file clears that file's edit-failure streak.

const VERIFY_RE = new RegExp([
  String.raw`\b(npm|pnpm|yarn|bun)\s+(run\s+)?(test|tests|build|lint|typecheck|type-check|check|verify|ci|e2e)\b`,
  String.raw`\bnpx\s+(tsc|vitest|jest|mocha|eslint|playwright|ava|tap)\b`,
  String.raw`\b(tsc|vitest|jest|mocha|eslint|pytest|mypy|pyright|ruff|flake8|tox|nox|rspec|phpunit|pest)\b`,
  String.raw`\bnode\s+--test\b`, String.raw`\bpython3?\s+-m\s+(pytest|unittest|mypy|py_compile|compileall)\b`,
  String.raw`\bcargo\s+(test|check|build|clippy)\b`, String.raw`\bgo\s+(test|build|vet)\b`,
  String.raw`\bdotnet\s+(build|test)\b`, String.raw`\b(mvn|mvnw|gradle|gradlew)\b.*\b(test|build|verify|check|compile)\b`,
  String.raw`\bmake\s+(test|check|build|all)?\b`, String.raw`\bphp\s+artisan\s+test\b`, String.raw`\bflutter\s+(test|analyze)\b`,
  String.raw`\bdeno\s+(test|check|lint)\b`, String.raw`\bswift\s+(build|test)\b`,
].join('|'), 'i');

const norm = (s) => s.toLowerCase().replace(/\\/g, '/').replace(/\s+/g, ' ').trim();

function isVerificationCommand(cmd, verifyList = [], editedFiles = []) {
  if (!cmd) return false;
  const c = norm(cmd);
  if (verifyList.some((v) => c.includes(norm(v)))) return true;
  if (VERIFY_RE.test(c)) return true;
  // Running a file that was just edited (node app.js, python script.py, ./tool.ps1 …)
  return editedFiles.some((f) => {
    const n = norm(f);
    const base = n.split('/').pop();
    return /\b(node|python3?|py|deno|bun|ruby|php|go run|dotnet run|pwsh|powershell)\b/.test(c) && (c.includes(n) || c.includes(base));
  });
}

// What "the same thing" means for failure-pattern detection.
function failureKey(name, input = {}) {
  switch (name) {
    case 'edit_file': case 'multi_edit': case 'write_file': case 'read_file':
      return `${name === 'read_file' ? 'read' : 'edit'}:${norm(input.path || '')}`;
    case 'shell': case 'powershell': case 'start_process': {
      // Command family: first two meaningful words, ignoring quotes, flags, numbers and paths.
      const words = norm(input.command || '').replace(/["'`]/g, ' ').split(/[\s;|&]+/)
        .filter((w) => w && !w.startsWith('-') && !/^\d+$/.test(w) && !w.includes('/') && !w.includes('.'));
      return `shell:${words.slice(0, 2).join(' ')}`;
    }
    case 'fetch_url': try { const u = new URL(input.url); return `fetch:${u.host}${u.pathname}`; } catch { return `fetch:${input.url}`; }
    case 'grep': return `grep:${norm(input.pattern || '')}`;
    case 'glob': return `glob:${norm(input.pattern || '')}`;
    default: return `${name}`;
  }
}

const EDIT_CALLS = new Set(['edit_file', 'multi_edit', 'write_file']);

class LoopGuard {
  constructor(limit = 3) {
    this.limit = limit;
    this.calls = [];
    this.fails = new Map();
    this.editHistory = new Map();
    this.totalShellFails = new Map();
    this.shellFailsSinceEdit = false;
  }
  // Returns a reason string when the call must be blocked, else null.
  check(name, input) {
    if (['process_output', 'todo_write'].includes(name)) return null;
    const sig = name + ':' + JSON.stringify(input);
    this.calls.push(sig);
    let n = 0;
    for (let i = this.calls.length - 1; i >= 0 && this.calls[i] === sig; i--) n++;
    if (n >= this.limit) return `Loop guard: you made this exact call ${n} times in a row with no progress. Stop repeating it — re-read the relevant code, try a different approach, or ask the user.`;
    if (EDIT_CALLS.has(name) && (this.editHistory.get(sig) || 0) >= 1 && this.shellFailsSinceEdit) {
      return 'Loop guard: you already tried this exact edit earlier and verification still failed. Try a different approach instead of repeating the same change.';
    }
    const key = failureKey(name, input);
    if (key.startsWith('shell:') && (this.totalShellFails.get(key) || 0) >= this.limit + 2) {
      return `Loop guard: \`${key.slice(6)}\` has failed ${this.totalShellFails.get(key)} times across multiple attempts. Re-read the relevant code and error output carefully, or ask the user.`;
    }
    const f = this.fails.get(key) || 0;
    if (f >= this.limit) {
      const what = key.startsWith('edit:') ? `editing ${input.path} failed ${f} times in a row. Re-read the file with read_file to see its exact current content before editing again`
        : key.startsWith('shell:') ? `\`${key.slice(6)}\` commands failed ${f} times in a row without any code change in between. Read the error output carefully, fix the cause in the code, then run it again — or explain the blocker to the user`
          : `this kind of call failed ${f} times in a row. Change approach`;
      return `Loop guard: ${what}.`;
    }
    return null;
  }
  record(name, input, ok) {
    if (['process_output', 'todo_write'].includes(name)) return;
    const key = failureKey(name, input);
    if (ok) {
      this.fails.delete(key);
      // Progress resets related streaks.
      if (key.startsWith('read:')) this.fails.delete('edit:' + key.slice(5));
      if (key.startsWith('edit:')) for (const k of [...this.fails.keys()]) if (k.startsWith('shell:')) this.fails.delete(k);
      if (EDIT_CALLS.has(name)) {
        const sig = name + ':' + JSON.stringify(input);
        this.editHistory.set(sig, (this.editHistory.get(sig) || 0) + 1);
        this.shellFailsSinceEdit = false;
      }
      if (key.startsWith('shell:')) {
        this.totalShellFails.delete(key);
        this.shellFailsSinceEdit = false;
      }
    } else {
      this.fails.set(key, (this.fails.get(key) || 0) + 1);
      if (key.startsWith('shell:')) {
        this.totalShellFails.set(key, (this.totalShellFails.get(key) || 0) + 1);
        this.shellFailsSinceEdit = true;
      }
    }
  }
}

/** A file a user sees in a web app: pages, components, styles, templates (not tests or config). */
function isUiFile(p) {
  const f = String(p).replace(/\\/g, '/');
  if (/(^|\/)(node_modules|\.next|dist|build)\//.test(f) || /\.(test|spec)\.[jt]sx?$/.test(f)) return false;
  return /\.(tsx|jsx|vue|svelte|astro|html|css|scss)$/.test(f);
}

// ---- Root-cause debugging ----
/**
 * The places in this project's own code where a failure happened, from a stack trace or compiler
 * output (Node/TS stacks, tsc "file(line,col)", Python 'File "x", line n'). Library and runtime frames
 * are skipped. Returns up to five "path:line" strings, innermost first, relative to the project.
 */
function projectFrames(output, root) {
  const text = String(output || '');
  const norm = (p) => String(p).replace(/\\/g, '/');
  const rootN = norm(root || '').replace(/\/+$/, '').toLowerCase();
  const out = [];
  const add = (file, line) => {
    let p = norm(file).replace(/^file:\/\/\/?/, '').replace(/^\.\//, '');
    if (/node_modules|^node:|internal\/|webpack-internal|<anonymous>|\.next\/|site-packages|\/lib\/python/i.test(p)) return;
    if (/^[^/]*:\d/.test(p)) return; // part of a URL (host:port/...), not a file
    if (rootN && p.toLowerCase().startsWith(rootN + '/')) p = p.slice(rootN.length + 1);
    if (/^[a-z]:\//i.test(p) || p.startsWith('/')) return; // outside the project
    const key = `${p}:${line}`;
    if (!out.includes(key)) out.push(key);
  };
  for (const m of text.matchAll(/((?:[a-zA-Z]:)?[\w.@/\\-]+\.(?:m?[jt]sx?|cjs|vue|svelte)):(\d+)(?::\d+)?/g)) add(m[1], m[2]);
  for (const m of text.matchAll(/([\w./\\-]+\.tsx?)\((\d+),\d+\)/g)) add(m[1], m[2]);
  for (const m of text.matchAll(/File "([^"]+)", line (\d+)/g)) add(m[1], m[2]);
  return out.slice(0, 5);
}

/** The engineer's debugging procedure, given when the same check keeps failing. */
const DEBUG_PROTOCOL = "[DROPs debug] This has failed more than once. Stop changing code by guesswork and debug it like an engineer: 1) Reproduce it with the smallest command and read the whole error and stack trace. 2) Open the first frame in this project's code and trace the bad value back to where it is created. 3) Write two or three possible root causes. 4) Test each one with evidence (read the code, print the value, run a focused test) before editing. 5) Fix the root cause, not the line where it surfaced. 6) Add a regression test that fails without the fix. 7) Run the original failing check again.";

module.exports = { isVerificationCommand, failureKey, LoopGuard, isUiFile, projectFrames, DEBUG_PROTOCOL };
