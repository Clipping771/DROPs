// Client-side tools the agent can call. Every tool validates its input and
// confines file paths to the project root.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const fg = require('fast-glob');
const Diff = require('diff');
const { spawn } = require('child_process');
const dns = require('dns').promises;
const net = require('net');
const shell = require('./shell');
const media = require('./media');

const MAX_OUT = 40000;
const IGNORE = ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**', '**/.next/**', '**/out/**',
  '**/__pycache__/**', '**/.venv/**', '**/venv/**', '**/target/**', '**/bin/Debug/**', '**/obj/**', '**/.cache/**'];

const TOOL_DEFS = [
  {
    name: 'read_file',
    description: 'Read a file. Text files return numbered lines (use offset/limit, 1-based, for large files). Images (png, jpg, gif, webp) are shown to you so you can look at screenshots, diagrams and UI mockups. PDFs return their text page by page (use pages, e.g. "1-5"). Always read a file before editing it.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path, relative to the project root' },
        offset: { type: 'integer', description: 'First line to read (1-based)' },
        limit: { type: 'integer', description: 'Max number of lines (default 2000)' },
        pages: { type: 'string', description: 'PDF only: pages to read, e.g. "3", "1-5" or "2,4,7-9" (default: first 20)' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Create a new file or completely overwrite an existing one. Parent folders are created. Prefer edit_file/multi_edit for changes to existing files.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'File path relative to the project root, e.g. src/app.js (required)' }, content: { type: 'string', description: 'The complete new file content' } },
      required: ['path', 'content'],
    },
  },
  {
    name: 'edit_file',
    description: 'Replace text in a file. Always pass path. old_string should be copied exactly from read_file output (without the line numbers) and be unique unless replace_all is true; small indentation or spacing differences are tolerated when the match is unique. Line endings (CRLF/LF) are handled automatically.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the project root, e.g. src/app.js (required)' },
        old_string: { type: 'string', description: 'Existing text to replace; include 1-3 surrounding lines so it is unique' },
        new_string: { type: 'string', description: 'Replacement text (must differ from old_string)' },
        replace_all: { type: 'boolean' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'multi_edit',
    description: 'Apply several edits to ONE file atomically, in order (same matching rules as edit_file). Either all succeed or none are applied.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the project root, e.g. src/app.js (required)' },
        edits: {
          type: 'array',
          items: {
            type: 'object',
            properties: { old_string: { type: 'string' }, new_string: { type: 'string' }, replace_all: { type: 'boolean' } },
            required: ['old_string', 'new_string'],
          },
        },
      },
      required: ['path', 'edits'],
    },
  },
  {
    name: 'notebook_edit',
    description: 'Edit a Jupyter notebook (.ipynb) cell cleanly without breaking JSON structure. Read the notebook first. action: "replace" (default), "insert" (inserts before cell_index, or appends if omitted), or "delete".',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Notebook path relative to the project root, e.g. analysis.ipynb' },
        cell_index: { type: 'integer', description: '0-based cell index' },
        action: { type: 'string', enum: ['replace', 'insert', 'delete'] },
        cell_type: { type: 'string', enum: ['code', 'markdown', 'raw'], description: 'Required for insert; optional for replace' },
        source: { type: 'string', description: 'New cell source text (for replace/insert)' },
      },
      required: ['path'],
    },
  },
  {
    name: 'list_dir',
    description: 'List files and folders in a directory (non-recursive). Common build/dependency folders are marked.',
    input_schema: { type: 'object', properties: { path: { type: 'string', description: 'Directory, default project root' } } },
  },
  {
    name: 'glob',
    description: 'Find files by glob pattern, e.g. "src/**/*.ts". Ignores node_modules, .git, build output. Results sorted by most recently modified.',
    input_schema: {
      type: 'object',
      properties: { pattern: { type: 'string' }, path: { type: 'string', description: 'Base directory, default project root' } },
      required: ['pattern'],
    },
  },
  {
    name: 'grep',
    description: 'Search file contents with a JavaScript regular expression. output_mode "content" (default) shows matching lines with line numbers; "files" lists matching files only.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        path: { type: 'string', description: 'Directory or file, default project root' },
        glob: { type: 'string', description: 'Filter files, e.g. "**/*.py"' },
        case_insensitive: { type: 'boolean' },
        output_mode: { type: 'string', enum: ['content', 'files'] },
        context: { type: 'integer', description: 'Lines of context around each match' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'shell',
    description: 'Run a shell command in the project root (builds, tests, git, package managers, scripts). The shell type (PowerShell on Windows, bash on macOS/Linux or inside the Docker sandbox) is stated in the system prompt — use its syntax. Non-interactive: never run commands that wait for input or never exit (use start_process for servers). Output (stdout+stderr) and the exit code are returned.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        description: { type: 'string', description: 'Short (5-10 word) description of what this does' },
        timeout_seconds: { type: 'integer', description: 'Default 120, max 600' },
      },
      required: ['command'],
    },
  },
  {
    name: 'start_process',
    description: 'Start a long-running background process (dev server, watcher, database) in the project root. Returns a process id immediately; output is buffered. Use process_output to read logs and stop_process when finished. Never use powershell for commands that do not exit.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        name: { type: 'string', description: 'Short label, e.g. "dev server"' },
        wait_seconds: { type: 'integer', description: 'Seconds to wait before returning initial output (default 5, max 60)' },
      },
      required: ['command'],
    },
  },
  {
    name: 'process_output',
    description: 'Read recent output of a background process started with start_process, and whether it is still running.',
    input_schema: { type: 'object', properties: { id: { type: 'string' }, lines: { type: 'integer', description: 'Last N lines (default 80)' } }, required: ['id'] },
  },
  {
    name: 'stop_process',
    description: 'Stop a background process started with start_process.',
    input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'fetch_url',
    description: 'Fetch a web page or raw file over HTTP(S) and return it as readable text (HTML is converted to text). Use for docs, changelogs, API references, raw GitHub files.',
    input_schema: { type: 'object', properties: { url: { type: 'string' }, max_chars: { type: 'integer', description: 'Default 30000' } }, required: ['url'] },
  },
  {
    name: 'browser',
    description: 'A real web browser (headless Chrome). Use it to check a web app you built the way a user would, and to work with sites that need clicks or JavaScript. One page that stays open between calls (logins and form state carry over). Every result shows the URL, any messages on screen, console errors and failed requests since the last step, the API calls the page made with their status (what a click really did on the server), the clickable/typable elements (with data-testid where present) and the visible text.\nActions: open {url}; click {target}; fill {target, value}; select {target, value}; check {target}; press {key, target?}; wait {target? | seconds}; back; reload (does saved data survive a fresh load?); read {full?}; screenshot {full?}; close. Optional width/height on any action (e.g. width 375 for a phone).\ntarget = visible text or label ("Save", "Email"), "testid=<id>", or a CSS selector. An app running inside the sandbox is reached at http://localhost:<port> (start it first with start_process).',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['open', 'click', 'fill', 'select', 'check', 'press', 'wait', 'back', 'reload', 'read', 'screenshot', 'close'] },
        url: { type: 'string' }, target: { type: 'string' }, value: { type: 'string' }, key: { type: 'string', description: 'e.g. Enter, Tab, Escape' },
        seconds: { type: 'number' }, full: { type: 'boolean' }, width: { type: 'integer' }, height: { type: 'integer' },
      },
      required: ['action'],
    },
  },
  {
    name: 'remember',
    description: 'Save durable project knowledge to DROPs.md (loaded into every future session). kind "fact" (default): build/test commands, conventions, architecture notes, user preferences. kind "decision": a design decision and why it was made (e.g. "Prices are stored in cents" because "floats lost money in rounding"), so later work does not undo it. Keep notes short and specific.',
    input_schema: { type: 'object', properties: { note: { type: 'string' }, kind: { type: 'string', enum: ['fact', 'decision'] }, why: { type: 'string', description: 'For a decision: the reason' } }, required: ['note'] },
  },
  {
    name: 'learn_lesson',
    description: 'Record a lesson from a mistake you made and fixed, so you never repeat it in any later session or project. One short, general rule: what to do or avoid, and when (e.g. "In the Docker sandbox `fuser` is missing; free a port with `pkill -f next`"). Not for project facts (use remember).',
    input_schema: { type: 'object', properties: { lesson: { type: 'string' } }, required: ['lesson'] },
  },
  {
    name: 'todo_write',
    description: 'Create or update the task plan shown to the user. Send the WHOLE list every time. Exactly one item should be in_progress while working. Use for any task with 3+ steps.',
    input_schema: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
            },
            required: ['content', 'status'],
          },
        },
      },
      required: ['todos'],
    },
  },
];

const READ_ONLY = new Set(['read_file', 'list_dir', 'glob', 'grep', 'todo_write', 'save_plan', 'process_output', 'stop_process', 'fetch_url', 'web_search', 'task', 'wrap_up', 'impact', 'code_search', 'audit', 'mark_chapter']);
const EDIT_TOOLS = new Set(['write_file', 'edit_file', 'multi_edit', 'notebook_edit', 'remember']);
const EXPLORE_TOOLS = new Set(['read_file', 'list_dir', 'glob', 'grep', 'fetch_url', 'code_search']);

function definitions(filter) {
  return TOOL_DEFS.filter((t) => !filter || filter.has(t.name)).map((t) => ({ ...t }));
}

// --- input validation (eager input streaming means the server no longer validates) ---
function typeOk(v, schema) {
  if (v === undefined) return true;
  switch (schema.type) {
    case 'string': return typeof v === 'string';
    case 'integer': return Number.isInteger(v);
    case 'boolean': return typeof v === 'boolean';
    case 'array': return Array.isArray(v) && (!schema.items || v.every((x) => typeOk(x, schema.items)));
    case 'object': return validateObj(v, schema) === null;
    default: return true;
  }
}
function validateObj(obj, schema) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return 'expected an object';
  for (const r of schema.required || []) if (obj[r] === undefined) return `missing required field "${r}"${schema.properties?.[r]?.description ? ` (${schema.properties[r].description})` : ''}`;
  for (const [k, s] of Object.entries(schema.properties || {})) {
    if (!typeOk(obj[k], s)) return `field "${k}" has the wrong type (expected ${s.type})`;
    if (s.enum && obj[k] !== undefined && !s.enum.includes(obj[k])) return `field "${k}" must be one of ${s.enum.join(', ')}`;
  }
  return null;
}
function coerceObj(obj, schema) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj) || !schema?.properties) return;
  for (const [k, s] of Object.entries(schema.properties)) {
    if (obj[k] === undefined) continue;
    if (s.type === 'integer' && typeof obj[k] === 'string' && /^-?\d+$/.test(obj[k].trim())) {
      obj[k] = parseInt(obj[k].trim(), 10);
    } else if (s.type === 'boolean' && typeof obj[k] === 'string' && /^(true|false)$/i.test(obj[k].trim())) {
      obj[k] = obj[k].trim().toLowerCase() === 'true';
    } else if (s.type === 'array' && typeof obj[k] === 'string' && /^\s*\[/.test(obj[k])) {
      try { const a = JSON.parse(obj[k]); if (Array.isArray(a)) obj[k] = a; } catch { /* leave it; validation reports it */ }
    } else if (s.type === 'array' && Array.isArray(obj[k]) && s.items) {
      obj[k].forEach((x) => coerceObj(x, s.items));
    } else if (s.type === 'object') {
      coerceObj(obj[k], s);
    }
  }
}
const EXTRA_DEFS = [];
function registerDef(def) { EXTRA_DEFS.push(def); }
function validate(name, input) {
  const n = name === 'powershell' ? 'shell' : name;
  const def = TOOL_DEFS.find((t) => t.name === n) || EXTRA_DEFS.find((t) => t.name === n);
  if (!def) return `unknown tool "${name}"`;
  coerceObj(input, def.input_schema);
  return validateObj(input, def.input_schema);
}

// --- helpers ---
const isInside = (root, target) => {
  const rel = path.relative(root, target);
  return !(rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel));
};
// Real path of `p`, or of its nearest existing ancestor joined with the missing tail
// (so files that are about to be created are checked too).
function realish(p) {
  const tail = [];
  let cur = p;
  for (;;) {
    try { return path.join(fs.realpathSync.native(cur), ...tail); } catch (e) {
      if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e;
      const up = path.dirname(cur);
      if (up === cur) return p;
      tail.unshift(path.basename(cur));
      cur = up;
    }
  }
}
function resolveInRoot(root, p) {
  const target = path.resolve(root, p || '.');
  if (!isInside(root, target)) throw new Error(`Path "${p}" is outside the project root (${root}).`);
  // A symlink or junction inside the project must not lead outside it.
  if (!isInside(realish(path.resolve(root)), realish(target))) {
    throw new Error(`Path "${p}" resolves (through a link) to a location outside the project root (${root}).`);
  }
  return target;
}
// ---- network: fetch_url may only reach public addresses (no localhost, LAN or cloud metadata) ----
const BLOCKED_NETS = new net.BlockList();
for (const [a, n] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]]) BLOCKED_NETS.addSubnet(a, n, 'ipv4');
for (const [a, n] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]]) BLOCKED_NETS.addSubnet(a, n, 'ipv6');
function isPrivateAddress(ip) {
  const v = net.isIP(ip);
  if (!v) return true;
  if (v === 6) {
    const mapped = ip.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    return BLOCKED_NETS.check(ip, 'ipv6');
  }
  return BLOCKED_NETS.check(ip, 'ipv4');
}
async function assertPublicUrl(url) {
  const u = new URL(url);
  if (!/^https?:$/.test(u.protocol)) throw new Error('Only http(s) URLs are supported.');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true, verbatim: true });
  if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) {
    throw new Error(`fetch_url blocked: ${u.hostname} points to a local or private network address. To check a local dev server, run a command (for example curl) with the shell tool instead.`);
  }
}
// fetch() that re-checks the address of every redirect hop.
async function safeFetch(url, opts, maxHops = 5) {
  for (let hop = 0; hop <= maxHops; hop++) {
    await assertPublicUrl(url);
    const r = await fetch(url, { ...opts, redirect: 'manual' });
    const loc = r.status >= 300 && r.status < 400 && r.headers.get('location');
    if (!loc) return r;
    url = new URL(loc, url).href;
  }
  throw new Error(`fetch_url: more than ${maxHops} redirects.`);
}

// Keyless web search (DuckDuckGo's HTML endpoint), used when no Gemini key is set.
const decodeEntities = (s) => s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
function parseDuckResults(html) {
  const out = [];
  // One chunk per result link; the snippet, if any, sits in the same chunk.
  const chunks = String(html).split(/(?=<a[^>]+class="result__a")/).slice(1);
  for (const chunk of chunks) {
    if (out.length >= 8) break;
    const a = chunk.match(/^<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!a) continue;
    const sn = chunk.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|div|td)>/);
    const m = [null, a[1], a[2], sn ? sn[1] : ''];
    let url = m[1].replace(/&amp;/g, '&');
    const u = url.match(/[?&]uddg=([^&]+)/);
    if (u) url = decodeURIComponent(u[1]);
    if (url.startsWith('//')) url = 'https:' + url;
    if (!/^https?:\/\//.test(url) || /duckduckgo\.com\/y\.js/.test(url)) continue;
    out.push({ title: decodeEntities(m[2]), url, snippet: decodeEntities(m[3] || '') });
  }
  return out;
}
async function keylessSearch(query, signal) {
  const url = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query);
  const r = await safeFetch(url, { signal: AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(20000)]), headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) DROPs-Agent/2', accept: 'text/html' } });
  const results = parseDuckResults(await r.text());
  if (!results.length) throw new Error('The web search returned no results (the search service may be unavailable). Try other words, or fetch_url a known documentation URL. Adding a Gemini key in Settings enables Google search.');
  return { text: results.map((x, i) => `[${i + 1}] ${x.title}\n${x.url}${x.snippet ? `\n${x.snippet}` : ''}`).join('\n\n'), sources: results.map(({ title, url }) => ({ title, url })) };
}

const relOf = (root, abs) => path.relative(root, abs).replace(/\\/g, '/') || '.';
function trunc(s, n = MAX_OUT) {
  if (s.length <= n) return s;
  return s.slice(0, n / 2) + `\n\n... [${s.length - n} characters truncated] ...\n\n` + s.slice(-n / 2);
}
const stripAnsi = (s) => shell.stripAnsi(s);

function makeDiff(rel, a, b) {
  const A = (a ?? '').replace(/\r\n/g, '\n');
  const B = b.replace(/\r\n/g, '\n');
  const patch = Diff.structuredPatch(rel, rel, A, B, '', '', { context: 3 });
  let added = 0, removed = 0, budget = 600;
  const hunks = [];
  for (const h of patch.hunks) {
    const lines = [];
    let oldNo = h.oldStart, newNo = h.newStart;
    for (const l of h.lines) {
      const t = l[0];
      if (t === '\\') continue;
      if (t === '+') added++; else if (t === '-') removed++;
      if (budget-- > 0) lines.push({ t, s: l.slice(1), o: t === '+' ? null : oldNo, n: t === '-' ? null : newNo });
      if (t !== '+') oldNo++;
      if (t !== '-') newNo++;
    }
    hunks.push({ header: `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`, lines });
  }
  return { path: rel, added, removed, hunks, isNew: a === null, truncated: budget < 0 };
}

async function applyEdits(abs, rel, edits) {
  let orig;
  try { orig = await fsp.readFile(abs, 'utf8'); } catch {
    throw new Error(`File not found: ${rel}. Use write_file to create a new file.`);
  }
  const crlf = orig.includes('\r\n');
  let content = orig;
  const notes = [];
  edits.forEach((e, i) => {
    let oldS = e.old_string, newS = e.new_string;
    const tag = edits.length > 1 ? `edit ${i + 1}: ` : '';
    if (!oldS) throw new Error(`${tag}old_string is empty. Use write_file to create or overwrite a file.`);
    if (oldS === newS) throw new Error(`${tag}old_string and new_string are identical.`);
    if (!content.includes(oldS) && crlf) {
      const o2 = oldS.replace(/\r?\n/g, '\r\n');
      if (content.includes(o2)) { oldS = o2; newS = newS.replace(/\r?\n/g, '\r\n'); }
    } else if (crlf && content.includes(oldS) && oldS.includes('\r\n')) {
      newS = newS.replace(/\r?\n/g, '\r\n');
    }
    const count = content.split(oldS).length - 1;
    if (count === 0) {
      // Models often get indentation or spacing slightly wrong. Accept a match that differs only in
      // whitespace when it is unique, re-indenting new_string to the file's indentation.
      const fz = fuzzyReplace(content, oldS, newS, crlf);
      if (fz.content !== undefined) { content = fz.content; notes.push(`${tag}matched ${rel}:${fz.line} ignoring whitespace differences`); return; }
      throw new Error(`${tag}old_string not found in ${rel}.${fz.hint || ' Re-read the file and copy the exact text, including indentation.'}`);
    }
    if (count > 1 && !e.replace_all) {
      const lines = []; let at = -1;
      while ((at = content.indexOf(oldS, at + 1)) >= 0 && lines.length < 6) lines.push(content.slice(0, at).split('\n').length);
      throw new Error(`${tag}old_string appears ${count} times in ${rel} (lines ${lines.join(', ')}${count > lines.length ? ', …' : ''}). Add surrounding lines to make it unique, or set replace_all.`);
    }
    content = e.replace_all ? content.split(oldS).join(newS) : content.replace(oldS, () => newS);
  });
  return { orig, content, notes };
}

// Whitespace-tolerant replacement: lines are compared with leading/trailing spaces trimmed and inner
// runs of spaces collapsed. Applied only when exactly one place matches; otherwise returns a hint that
// shows the closest lines in the file so the model can retry with the exact text.
const normLine = (l) => l.trim().replace(/\s+/g, ' ');
const indentOf = (l) => l.match(/^[ \t]*/)[0];
function fuzzyReplace(content, oldS, newS, crlf) {
  const eol = crlf ? '\r\n' : '\n';
  const lines = content.split(/\r?\n/);
  const want = oldS.replace(/\r\n/g, '\n').split('\n');
  while (want.length && !want[want.length - 1].trim()) want.pop();
  while (want.length && !want[0].trim()) want.shift();
  if (!want.length) return {};
  const target = want.map(normLine);
  const hits = [];
  for (let i = 0; i + target.length <= lines.length && hits.length < 2; i++) {
    let ok = true;
    for (let j = 0; j < target.length && ok; j++) ok = normLine(lines[i + j]) === target[j];
    if (ok) hits.push(i);
  }
  if (hits.length === 1) {
    const i = hits[0];
    const fileIndent = indentOf(lines[i]), oldIndent = indentOf(want[0]);
    const repl = newS.replace(/\r\n/g, '\n').split('\n').map((l) => (l.startsWith(oldIndent) ? fileIndent + l.slice(oldIndent.length) : l));
    // Keep a trailing newline in new_string from producing an extra blank line.
    if (repl.length > 1 && repl[repl.length - 1] === '' && /\n$/.test(newS)) repl.pop();
    const out = [...lines.slice(0, i), ...repl, ...lines.slice(i + target.length)];
    return { content: out.join(eol), line: i + 1 };
  }
  if (hits.length > 1) return { hint: ' A whitespace-insensitive match exists in more than one place; add surrounding lines to make it unique.' };
  // Closest candidates for the first meaningful line of old_string.
  const first = target.find((t) => t.length > 3) || target[0];
  const words = new Set(first.toLowerCase().split(/\W+/).filter((w) => w.length > 2));
  const scored = lines.map((l, i) => {
    const n = normLine(l).toLowerCase();
    let s = 0; for (const w of words) if (n.includes(w)) s++;
    return { i, s };
  }).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 2);
  if (!scored.length || scored[0].s < Math.max(1, Math.ceil(words.size / 3))) return {};
  const show = scored.map(({ i }) => {
    const from = Math.max(0, i - 2), to = Math.min(lines.length, i + Math.max(3, target.length + 1));
    return lines.slice(from, to).map((l, k) => `${String(from + k + 1).padStart(6)}\t${l}`).join('\n');
  }).join('\n   …\n');
  return { hint: ` The closest text in the file is:\n${show}\nCopy old_string exactly from these lines (the numbers and tab are not part of the file).` };
}

// --- read-before-write and staleness protection ---
function checkFresh(ctx, abs, rel, mustHaveRead) {
  const seen = ctx.readFiles.get(abs);
  if (seen === undefined) {
    if (mustHaveRead) throw new Error(`${rel} already exists and you have not read it in this session. Read it first (or use edit_file) so you don't overwrite content you haven't seen.`);
    try { ctx.readFiles.set(abs, fs.statSync(abs).mtimeMs); } catch { /* ignore */ }
    return;
  }
  let now;
  try { now = fs.statSync(abs).mtimeMs; } catch { return; }
  if (Math.abs(now - seen) > 1) throw new Error(`${rel} was modified outside the agent since you last read it. Read it again before editing.`);
}
async function markWritten(ctx, abs) {
  try { ctx.readFiles.set(abs, (await fsp.stat(abs)).mtimeMs); } catch { /* ignore */ }
  try { require('./codegraph').invalidateGraph(ctx.root); } catch { /* ignore */ }
}
async function atomicWrite(abs, content) {
  const tmp = `${abs}.drops-${process.pid}-${Date.now().toString(36)}.tmp`;
  try {
    await fsp.writeFile(tmp, content, 'utf8');
    await fsp.rename(tmp, abs);
  } catch {
    try { await fsp.rm(tmp, { force: true }); } catch { /* ignore */ }
    await fsp.writeFile(abs, content, 'utf8');
  }
}
const SENSITIVE_FILE = /(^|\/)(\.env(\.[^/]+)?|\.mcp\.json|\.git\/(config|hooks\/.*)|id_rsa|id_ed25519|.*\.(pem|key|pfx|p12))$/i;
const isSensitiveFile = (rel) => SENSITIVE_FILE.test(String(rel || '').replace(/\\/g, '/'));

// --- instant diagnostics after every edit ---
function runCheck(cmd, args, env, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let out = '';
    let child;
    try { child = spawn(cmd, args, { windowsHide: true, env: { ...process.env, ...env } }); } catch { return resolve(null); }
    const t = setTimeout(() => { try { child.kill(); } catch { /* */ } resolve(null); }, timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', () => { clearTimeout(t); resolve(null); });
    child.on('close', (code) => { clearTimeout(t); resolve({ code, out }); });
  });
}
async function diagnose(abs, content, root) {
  const ext = path.extname(abs).toLowerCase();
  const base = path.basename(abs).toLowerCase();
  try {
    if (ext === '.json' && !/^(ts|js)config|\.code-workspace$|devcontainer/.test(base) && !abs.includes('.vscode')) {
      try { JSON.parse(content.replace(/^\uFEFF/, '')); return '\nDiagnostics: valid JSON.'; } catch (e) { return `\nDiagnostics: INVALID JSON — ${e.message}. Fix this.`; }
    }
    if (['.js', '.cjs', '.mjs'].includes(ext)) {
      const r = await runCheck(process.execPath, ['--check', abs], { ELECTRON_RUN_AS_NODE: '1' });
      if (!r) return '';
      return r.code === 0 ? '\nDiagnostics: syntax OK.' : `\nDiagnostics: SYNTAX ERROR —\n${stripAnsi(r.out).trim().slice(0, 1500)}\nFix this before moving on.`;
    }
    if (ext === '.py') {
      const r = await runCheck('python', ['-m', 'py_compile', abs]);
      if (!r) return '';
      if (r.code !== 0) return `\nDiagnostics: SYNTAX ERROR —\n${r.out.trim().slice(0, 1500)}\nFix this before moving on.`;
      const lint = await runCheck('ruff', ['check', '--output-format', 'concise', '--select', 'F,E9', abs]);
      if (lint && lint.code === 1 && lint.out.trim()) return `\nDiagnostics: syntax OK; ruff found problems —\n${lint.out.trim().slice(0, 1500)}`;
      return '\nDiagnostics: syntax OK.';
    }
    if (['.ts', '.tsx', '.mts', '.cts'].includes(ext) && root) return await typecheckTs(abs, root);
    if (ext === '.php') {
      const r = await runCheck('php', ['-l', abs]);
      if (r) return r.code === 0 ? '\nDiagnostics: syntax OK.' : `\nDiagnostics: SYNTAX ERROR —\n${r.out.trim().slice(0, 1500)}`;
    }
    if (ext === '.go') {
      const r = await runCheck('gofmt', ['-e', '-l', abs]);
      if (r) return r.code === 0 ? '\nDiagnostics: syntax OK.' : `\nDiagnostics: SYNTAX ERROR —\n${r.out.trim().slice(0, 1500)}`;
    }
  } catch { /* diagnostics are best-effort */ }
  return '';
}

// Project-aware TypeScript type check (incremental). Reports errors in the edited file first.
const tsRunning = new Map();
async function typecheckTs(abs, root) {
  const tscJs = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
  if (!fs.existsSync(tscJs) || !fs.existsSync(path.join(root, 'tsconfig.json'))) return '';
  const cacheDir = path.join(root, 'node_modules', '.cache', 'drops');
  try { fs.mkdirSync(cacheDir, { recursive: true }); } catch { /* ignore */ }
  if (!tsRunning.has(root)) {
    tsRunning.set(root, runCheck(process.execPath, [tscJs, '--noEmit', '--pretty', 'false', '-p', root, '--incremental', '--tsBuildInfoFile', path.join(cacheDir, 'tsbuildinfo')], { ELECTRON_RUN_AS_NODE: '1' }, 90000)
      .finally(() => setTimeout(() => tsRunning.delete(root), 0)));
  }
  const r = await tsRunning.get(root);
  if (!r) return '\nDiagnostics: type check timed out (skipped).';
  if (r.code === 0) return '\nDiagnostics: type check passed (tsc).';
  const rel = path.relative(root, abs).replace(/\\/g, '/');
  const lines = r.out.split(/\r?\n/).filter((l) => /error TS\d+/.test(l));
  const mine = lines.filter((l) => l.replace(/\\/g, '/').includes(rel));
  const shown = (mine.length ? mine : lines).slice(0, 25).join('\n');
  return `\nDiagnostics: TYPE ERRORS (tsc) — ${mine.length} in this file, ${lines.length} in the project:\n${shown}${mine.length ? '\nFix the errors in this file before moving on.' : ''}`;
}

function htmlToText(html) {
  return html
    .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/pre)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<h([1-6])[^>]*>/gi, (_, n) => '\n' + '#'.repeat(Number(n)) + ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// The site each project's browser page is on, for per-site approval of later clicks.
const browserHosts = new Map();

// --- background processes (dev servers, watchers) ---
class ProcessManager {
  constructor(root, onEvent) { this.root = root; this.onEvent = onEvent || (() => {}); this.procs = new Map(); this.n = 0; this.sandbox = null; }
  async start(command, name) {
    const id = `p${++this.n}`;
    const child = await shell.spawnShell(command, { cwd: this.root, sandbox: this.sandbox, env: { BROWSER: 'none' } });
    const p = { id, name: name || command.slice(0, 40), command, output: '', running: true, code: null, child, started: Date.now(), onExit: null };
    const add = (d) => {
      const s = stripAnsi(d.toString('utf8'));
      p.output += s;
      if (p.output.length > 1_000_000) p.output = p.output.slice(-500_000);
      this.onEvent({ id, chunk: s });
    };
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    child.stdin.end();
    const exit = (code) => { if (!p.running) return; p.running = false; p.code = code; this.onEvent({ id, exited: true, code }); p.onExit?.(); };
    child.on('close', (code) => exit(code ?? -1));
    child.on('error', (e) => { add(String(e)); exit(-1); });
    this.procs.set(id, p);
    this.onEvent({ id, started: true, name: p.name, command });
    return p;
  }
  get(id) { return this.procs.get(id); }
  list() { return [...this.procs.values()].map(({ id, name, command, running, code, started }) => ({ id, name, command, running, code, started })); }
  stop(id) {
    const p = this.procs.get(id);
    if (!p || !p.running) return false;
    shell.killTree(p.child);
    return true;
  }
  stopAll() { for (const id of this.procs.keys()) this.stop(id); }
}

function formatNotebook(raw) {
  let nb;
  try { nb = JSON.parse(raw); } catch (e) { throw new Error(`Invalid .ipynb JSON: ${e.message}`); }
  const cells = Array.isArray(nb?.cells) ? nb.cells : [];
  if (!cells.length) return '[empty notebook: 0 cells]';
  const toText = (v) => (Array.isArray(v) ? v.join('') : String(v || ''));
  return cells.map((c, idx) => {
    const kind = c?.cell_type || 'code';
    const exec = kind === 'code' && c?.execution_count != null ? `, exec=${c.execution_count}` : '';
    const head = `--- [cell ${idx}] (${kind}${exec}) ---`;
    const body = toText(c?.source);
    const outs = (Array.isArray(c?.outputs) ? c.outputs : []).slice(0, 5).map((o) => {
      if (o.output_type === 'stream') return toText(o.text).trim();
      if (o.output_type === 'error') return `Error: ${o.ename || ''}: ${o.evalue || ''}`;
      if (o.data?.['text/plain']) return toText(o.data['text/plain']).trim();
      if (o.data?.['image/png'] || o.data?.['image/jpeg']) return '[image output]';
      return '';
    }).filter(Boolean);
    const outStr = outs.length ? `\n[outputs]\n${outs.join('\n').slice(0, 1200)}` : '';
    return `${head}\n${body}${outStr}`;
  }).join('\n\n');
}

// --- prepare: returns { kind, summary, preview, run } ---
// kind: 'read' | 'edit' | 'shell' | 'fetch'. `run` performs the action.
async function prepare(ctx, name, input) {
  const root = ctx.root;
  switch (name) {
    case 'read_file': {
      const abs = resolveInRoot(root, input.path);
      return {
        kind: 'read', summary: relOf(root, abs),
        run: async () => {
          const st = await fsp.stat(abs).catch(() => null);
          if (!st) throw new Error(`File not found: ${input.path}`);
          if (st.isDirectory()) throw new Error(`${input.path} is a directory; use list_dir.`);
          if (st.size > 20 * 1024 * 1024) throw new Error('File is larger than 20 MB.');
          if (media.imageType(abs)) {
            const { bytes, ...block } = await media.readImage(abs);
            ctx.readFiles.set(abs, st.mtimeMs);
            return { text: `[image ${relOf(root, abs)}, ${(bytes / 1024).toFixed(0)} KB: shown below]`, images: [{ ...block, _toolImage: true }] };
          }
          if (media.isPdf(abs)) { ctx.readFiles.set(abs, st.mtimeMs); return trunc(await media.readPdf(abs, input.pages), 120000); }
          const buf = await fsp.readFile(abs);
          if (buf.subarray(0, 8000).includes(0)) return `[binary file, ${st.size} bytes]`;
          if (abs.toLowerCase().endsWith('.ipynb') && !input.raw) {
            ctx.readFiles.set(abs, st.mtimeMs);
            return trunc(formatNotebook(buf.toString('utf8')), 120000);
          }
          const lines = buf.toString('utf8').replace(/\r\n/g, '\n').split('\n');
          const start = Math.max(1, input.offset || 1);
          const lim = Math.min(input.limit || 2000, 5000);
          const slice = lines.slice(start - 1, start - 1 + lim);
          ctx.readFiles.set(abs, st.mtimeMs);
          let out = slice.map((l, i) => `${String(start + i).padStart(6)}\t${l.length > 2000 ? l.slice(0, 2000) + '…' : l}`).join('\n');
          if (start - 1 + lim < lines.length) out += `\n\n[showing lines ${start}-${start - 1 + slice.length} of ${lines.length}; use offset to read more]`;
          if (!out.trim()) out = '[empty file]';
          return trunc(out, 120000);
        },
      };
    }
    case 'list_dir': {
      const abs = resolveInRoot(root, input.path);
      return {
        kind: 'read', summary: relOf(root, abs),
        run: async () => {
          const ents = await fsp.readdir(abs, { withFileTypes: true });
          ents.sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name));
          const heavy = new Set(['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', '.venv', 'target', 'obj']);
          const out = ents.slice(0, 1000).map((e) => e.isDirectory() ? `${e.name}/${heavy.has(e.name) ? '  (skipped by search)' : ''}` : e.name);
          return out.join('\n') || '[empty directory]';
        },
      };
    }
    case 'glob': {
      const base = resolveInRoot(root, input.path);
      return {
        kind: 'read', summary: input.pattern,
        run: async () => {
          const files = await fg(input.pattern, { cwd: base, ignore: IGNORE, dot: true, onlyFiles: true, stats: true, suppressErrors: true, followSymbolicLinks: false });
          files.sort((a, b) => b.stats.mtimeMs - a.stats.mtimeMs);
          const list = files.slice(0, 500).map((f) => relOf(root, path.join(base, f.path)));
          if (!list.length) return 'No files matched.';
          return list.join('\n') + (files.length > 500 ? `\n[${files.length - 500} more not shown]` : '');
        },
      };
    }
    case 'grep': {
      const base = resolveInRoot(root, input.path);
      let re;
      try { re = new RegExp(input.pattern, input.case_insensitive ? 'i' : ''); } catch (e) { throw new Error(`Invalid regex: ${e.message}`); }
      return {
        kind: 'read', summary: `/${input.pattern}/`,
        run: async () => {
          const st = await fsp.stat(base).catch(() => null);
          if (!st) throw new Error(`Not found: ${input.path}`);
          const files = st.isFile() ? [base] : (await fg(input.glob || '**/*', { cwd: base, ignore: IGNORE, dot: true, onlyFiles: true, absolute: true, suppressErrors: true })).map((f) => path.normalize(f));
          const mode = input.output_mode || 'content';
          const ctxN = Math.min(input.context || 0, 10);
          const out = []; let matches = 0; const hitFiles = [];
          // Files are read 32 at a time (one by one was slow on large repos); results keep file order.
          const readText = async (f) => {
            try {
              const s = await fsp.stat(f);
              if (s.size > 2 * 1024 * 1024) return null;
              const buf = await fsp.readFile(f);
              if (buf.subarray(0, 8000).includes(0)) return null;
              return buf.toString('utf8');
            } catch { return null; }
          };
          const BATCH = 32;
          let batch = [], batchAt = -1;
          for (let fi = 0; fi < files.length; fi++) {
            const f = files[fi];
            if (ctx.signal?.aborted) break;
            if (fi >= batchAt + batch.length) { batchAt = fi; batch = await Promise.all(files.slice(fi, fi + BATCH).map(readText)); }
            const text = batch[fi - batchAt];
            if (text == null || !re.test(text)) continue;
            hitFiles.push(relOf(root, f));
            if (mode === 'files') { if (hitFiles.length >= 500) break; continue; }
            const lines = text.replace(/\r\n/g, '\n').split('\n');
            const shown = new Set();
            for (let i = 0; i < lines.length && matches < 300; i++) {
              if (!re.test(lines[i])) continue;
              matches++;
              for (let j = Math.max(0, i - ctxN); j <= Math.min(lines.length - 1, i + ctxN); j++) {
                if (shown.has(j)) continue;
                shown.add(j);
                const l = lines[j].length > 400 ? lines[j].slice(0, 400) + '…' : lines[j];
                out.push(`${relOf(root, f)}:${j + 1}${j === i ? ':' : '-'} ${l}`);
              }
            }
            if (matches >= 300) { out.push('[match limit reached — narrow the search]'); break; }
          }
          if (mode === 'files') return hitFiles.length ? hitFiles.join('\n') : 'No matches.';
          return out.length ? trunc(out.join('\n')) : 'No matches.';
        },
      };
    }
    case 'learn_lesson':
      return { kind: 'read', summary: String(input.lesson || '').slice(0, 80), run: async () => { const l = require('./lessons').add(input.lesson, 'agent'); return l.count > 1 ? `Lesson already known (now seen ${l.count}×).` : 'Lesson saved; it will be in every future session.'; } };

    case 'todo_write':
      return { kind: 'read', summary: `${input.todos.length} tasks`, run: async () => { ctx.onTodos(input.todos); return 'Plan updated.'; } };

    case 'write_file': {
      const abs = resolveInRoot(root, input.path);
      const rel = relOf(root, abs);
      const orig = await fsp.readFile(abs, 'utf8').catch(() => null);
      if (orig !== null) checkFresh(ctx, abs, rel, true);
      let content = input.content;
      if (orig && orig.includes('\r\n') && !content.includes('\r\n')) content = content.replace(/\n/g, '\r\n');
      const preview = makeDiff(rel, orig, content);
      return {
        kind: 'edit', summary: rel, preview, abs,
        run: async () => {
          await ctx.snapshot(abs);
          await fsp.mkdir(path.dirname(abs), { recursive: true });
          await atomicWrite(abs, content);
          await markWritten(ctx, abs);
          ctx.onChange(rel, preview);
          const diag = await diagnose(abs, content, ctx.root);
          return `${orig === null ? 'Created' : 'Overwrote'} ${rel} (${content.split('\n').length} lines, +${preview.added} -${preview.removed}).${diag}`;
        },
      };
    }
    case 'edit_file':
    case 'multi_edit': {
      const abs = resolveInRoot(root, input.path);
      const rel = relOf(root, abs);
      const edits = name === 'edit_file' ? [input] : input.edits;
      if (!edits.length) throw new Error('edits is empty.');
      checkFresh(ctx, abs, rel, false);
      const { orig, content, notes } = await applyEdits(abs, rel, edits);
      const preview = makeDiff(rel, orig, content);
      return {
        kind: 'edit', summary: rel, preview, abs,
        run: async () => {
          const now = await fsp.readFile(abs, 'utf8');
          if (now !== orig) throw new Error(`${rel} changed on disk while waiting for approval. Re-read it and try again.`);
          await ctx.snapshot(abs);
          await atomicWrite(abs, content);
          await markWritten(ctx, abs);
          ctx.onChange(rel, preview);
          const diag = await diagnose(abs, content, ctx.root);
          return `Edited ${rel} (+${preview.added} -${preview.removed}).${notes.length ? ` Note: ${notes.join('; ')}.` : ''}${diag}`;
        },
      };
    }
    case 'notebook_edit': {
      const abs = resolveInRoot(root, input.path);
      const rel = relOf(root, abs);
      if (!abs.toLowerCase().endsWith('.ipynb')) throw new Error('notebook_edit only works on .ipynb files.');
      checkFresh(ctx, abs, rel, false);
      const orig = await fsp.readFile(abs, 'utf8');
      let nb;
      try { nb = JSON.parse(orig); } catch (e) { throw new Error(`${rel} is not valid JSON: ${e.message}`); }
      if (!Array.isArray(nb.cells)) nb.cells = [];
      const action = input.action || 'replace';
      const toLines = (s) => {
        const text = String(s ?? '').replace(/\r\n/g, '\n');
        if (!text) return [];
        const parts = text.split('\n');
        return parts.map((l, i) => (i < parts.length - 1 ? l + '\n' : l)).filter((l, i, arr) => !(i === arr.length - 1 && l === ''));
      };
      const idx = input.cell_index;
      if (action === 'delete') {
        if (!Number.isInteger(idx) || idx < 0 || idx >= nb.cells.length) throw new Error(`Invalid cell_index ${idx} (0..${nb.cells.length - 1}).`);
        nb.cells.splice(idx, 1);
      } else if (action === 'insert') {
        if (typeof input.source !== 'string') throw new Error('source is required for insert.');
        const pos = Number.isInteger(idx) ? Math.max(0, Math.min(nb.cells.length, idx)) : nb.cells.length;
        const ctype = input.cell_type || 'code';
        const cell = { cell_type: ctype, metadata: {}, source: toLines(input.source) };
        // nbformat 4.5+ requires a unique id on every cell (Jupyter warns or rewrites the file without it).
        if (nb.nbformat > 4 || (nb.nbformat === 4 && nb.nbformat_minor >= 5) || nb.cells.some((c) => c?.id)) {
          const used = new Set(nb.cells.map((c) => c?.id));
          let id;
          do { id = require('crypto').randomBytes(4).toString('hex'); } while (used.has(id));
          cell.id = id;
        }
        if (ctype === 'code') { cell.execution_count = null; cell.outputs = []; }
        nb.cells.splice(pos, 0, cell);
      } else {
        if (!Number.isInteger(idx) || idx < 0 || idx >= nb.cells.length) throw new Error(`Invalid cell_index ${idx} (0..${nb.cells.length - 1}).`);
        if (typeof input.source !== 'string') throw new Error('source is required for replace.');
        const prev = nb.cells[idx];
        const ctype = input.cell_type || prev.cell_type || 'code';
        const updated = { ...prev, cell_type: ctype, source: toLines(input.source) };
        if (ctype === 'code') { updated.execution_count = null; updated.outputs = []; } else { delete updated.execution_count; delete updated.outputs; }
        nb.cells[idx] = updated;
      }
      const content = JSON.stringify(nb, null, 1) + '\n';
      const preview = makeDiff(rel, orig, content);
      return {
        kind: 'edit', summary: `${rel} (${action})`, preview, abs,
        run: async () => {
          const now = await fsp.readFile(abs, 'utf8');
          if (now !== orig) throw new Error(`${rel} changed on disk while waiting for approval. Re-read it and try again.`);
          await ctx.snapshot(abs);
          await atomicWrite(abs, content);
          await markWritten(ctx, abs);
          ctx.onChange(rel, preview);
          return `Notebook ${rel} updated (${action}, ${nb.cells.length} cells, +${preview.added} -${preview.removed}).`;
        },
      };
    }
    case 'remember': {
      const mem = require('./brand').memoryFile(root);
      const abs = path.join(root, mem);
      const orig = await fsp.readFile(abs, 'utf8').catch(() => null);
      const base = orig ?? '# Project notes for DROPs\n';
      const decision = input.kind === 'decision';
      const section = decision ? '## Decisions' : '## Memory';
      const line = decision ? `- ${new Date().toISOString().slice(0, 10)}: ${input.note.trim()}${input.why ? ` (why: ${String(input.why).trim()})` : ''}` : `- ${input.note.trim()}`;
      // Add to the end of its own section (creating it at the end of the file if needed).
      const at = base.indexOf(section);
      let content;
      if (at < 0) content = base.replace(/\s*$/, '') + `\n\n${section}\n${line}\n`;
      else {
        const next = base.indexOf('\n## ', at + section.length);
        const end = next < 0 ? base.length : next;
        content = base.slice(0, end).replace(/\s*$/, '') + `\n${line}\n` + (next < 0 ? '' : '\n' + base.slice(next + 1));
      }
      const preview = makeDiff(mem, orig, content);
      return {
        kind: 'edit', summary: input.note.slice(0, 80), preview, abs,
        run: async () => { await ctx.snapshot(abs); await atomicWrite(abs, content); await markWritten(ctx, abs); ctx.onChange(mem, preview); return `Saved to ${mem}${decision ? ' (decisions)' : ''}.`; },
      };
    }
    case 'start_process': {
      return {
        kind: 'shell', summary: input.name || input.command.slice(0, 100),
        run: async () => {
          const p = await ctx.procs.start(input.command, input.name);
          const wait = Math.min(Math.max(input.wait_seconds ?? 5, 0), 60) * 1000;
          await new Promise((r) => { const t = setTimeout(r, wait); p.onExit = () => { clearTimeout(t); r(); }; });
          const tail = stripAnsi(p.output.slice(-6000)).trim();
          return `Started process ${p.id} (${p.running ? 'running' : `exited with code ${p.code}`}).\n${tail ? `Output so far:\n${tail}` : '(no output yet)'}`;
        },
      };
    }
    case 'process_output': {
      return {
        kind: 'read', summary: input.id,
        run: async () => {
          const p = ctx.procs.get(input.id);
          if (!p) throw new Error(`No process ${input.id}. Known: ${ctx.procs.list().map((x) => x.id).join(', ') || 'none'}`);
          const lines = stripAnsi(p.output).split('\n');
          const n = Math.min(input.lines || 80, 1000);
          return `[${p.running ? 'running' : `exited, code ${p.code}`}] ${p.command}\n` + trunc(lines.slice(-n).join('\n'));
        },
      };
    }
    case 'stop_process': {
      return { kind: 'read', summary: input.id, run: async () => (ctx.procs.stop(input.id) ? `Stopped ${input.id}.` : `No running process ${input.id}.`) };
    }
    case 'browser': {
      const browser = require('./browser');
      if (!browser.available()) throw new Error('The browser tool is not available on this machine (playwright-core is missing).');
      // Approval per site, like fetch_url (the yolo/headless mode skips it).
      let host = browserHosts.get(root) || 'page';
      if (input.action === 'open') {
        try { const u = new URL(input.url); if (!/^https?:$/.test(u.protocol)) throw new Error(); host = u.host.toLowerCase(); } catch { throw new Error('open needs a valid http(s) url.'); }
      }
      return {
        kind: 'fetch', summary: `${input.action}${input.url ? ' ' + input.url : input.target ? ' ' + input.target : ''}`.slice(0, 120), permKey: 'browser:' + host,
        run: async () => {
          const sandbox = ctx.procs?.sandbox;
          const r = await browser.act(root, input, { mapUrl: (u) => (sandbox ? sandbox.mapUrl(u) : u), signal: ctx.signal });
          if (input.action === 'open') browserHosts.set(root, host);
          return { text: r.text, uiIssue: r.issue || null, ...(r.images ? { images: r.images.map((b) => ({ ...b, _toolImage: true })) } : {}) };
        },
      };
    }
    case 'fetch_url': {
      let host;
      try { const u = new URL(input.url); if (!/^https?:$/.test(u.protocol)) throw new Error(); host = u.host.toLowerCase(); } catch { throw new Error('Only valid http(s) URLs are supported.'); }
      // Network access needs approval (per host): a URL can carry project data out of the machine.
      return {
        kind: 'fetch', summary: input.url, permKey: 'fetch:' + host,
        run: async () => {
          const r = await safeFetch(input.url, { signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(30000)]), headers: { 'user-agent': 'DROPs-Agent/2 (+desktop coding agent)', accept: 'text/html,text/plain,application/json,*/*' } });
          const type = r.headers.get('content-type') || '';
          let text = await r.text();
          if (/html/i.test(type)) text = htmlToText(text);
          const max = Math.min(input.max_chars || 30000, 100000);
          return `HTTP ${r.status} ${type}\n\n` + (text.length > max ? text.slice(0, max) + `\n\n[truncated, ${text.length} chars total]` : text);
        },
      };
    }
    case 'shell':
    case 'powershell': {
      return {
        kind: 'shell', summary: input.description || input.command.split('\n')[0].slice(0, 120),
        run: async (onChunk) => {
          const defaultTimeout = ctx.procs?.sandbox ? 300 : 120;
          const timeoutMs = Math.min(Math.max(input.timeout_seconds || defaultTimeout, 1), 600) * 1000;
          const r = await shell.run(input.command, { cwd: ctx.root, sandbox: ctx.procs?.sandbox, signal: ctx.signal, timeoutMs, onChunk, env: { CI: '1' } });
          let out = stripAnsi(r.output).trim();
          let head = '';
          if (r.killed === 'timeout') head = `[command timed out and was stopped]\n`;
          if (r.killed === 'aborted') head = `[command stopped by user]\n`;
          return { text: trunc(head + (out || '(no output)') + `\n[exit code ${r.code}]`), isError: r.code !== 0 };
        },
      };
    }
    default:
      throw new Error(`Unknown tool ${name}`);
  }
}

const isDangerous = (cmd, root) => shell.assessCommand(cmd, root).dangerous;
const isSafeCommand = shell.isSafeCommand;

module.exports = { definitions, validate, registerDef, prepare, READ_ONLY, EDIT_TOOLS, EXPLORE_TOOLS, ProcessManager, isDangerous, isSafeCommand, isSensitiveFile, makeDiff, resolveInRoot, isPrivateAddress, assertPublicUrl, keylessSearch, parseDuckResults, IGNORE, stripAnsi };
