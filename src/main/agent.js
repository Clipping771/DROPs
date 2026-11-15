// DROPs agent loop.
//  - streams a model turn (Claude or Gemini) and runs tools with permissions and checkpoints
//  - read-only tools (incl. sub-agents) run in parallel; edits run in order
//  - steering: messages typed while the agent works are injected at the next step
//  - auto-compaction keeps long sessions inside a token budget
//  - loop guard + verification guard catch the classic agent failure modes
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const brand = require('./brand');
const os = require('os');
const tools = require('./tools');
const providers = require('./providers');
const ctxEngine = require('./context');
const gemini = require('./gemini');
const guards = require('./guards');
const shell = require('./shell');
const lessons = require('./lessons');

const INTERRUPTED = '[Request interrupted by user]';
// ---- evidence helpers ----
/** A cheap fingerprint of the project's source files (path, size, modified time). Any change, by an
 *  edit tool or by a command, gives a different value. Installed packages and build output are ignored. */
function sourceFingerprint(root) {
  try {
    const entries = fg.sync('**/*', { cwd: root, onlyFiles: true, stats: true, dot: true, suppressErrors: true, deep: 12,
      ignore: ['**/node_modules/**', '**/.next/**', '**/.git/**', '**/dist/**', '**/build/**', '**/coverage/**', '**/test-results/**', '**/.drops/**', '**/.h2o/**', '**/*.log', '**/.turbo/**'] });
    const h = require('crypto').createHash('sha1');
    for (const e of entries.sort((x, y) => (x.path < y.path ? -1 : 1)).slice(0, 20000)) h.update(`${e.path}|${e.stats?.size}|${Math.round(e.stats?.mtimeMs || 0)}\n`);
    return h.digest('hex').slice(0, 16);
  } catch { return null; }
}
const verifiedCount = (reqs) => (reqs || []).filter((r) => r.status === 'verified').length;
function evidenceNudgeAllowed(run, reqs) {
  if (!(reqs || []).some((r) => r.status !== 'verified')) return false;
  if ((run.evidenceTotalNudges || 0) >= 8) return false;
  // A nudge that led to a new verified requirement resets the count of fruitless nudges.
  if (run.evidenceNudges && verifiedCount(reqs) > (run.evidenceVerifiedAtNudge ?? -1)) run.evidenceNudges = 0;
  return (run.evidenceNudges || 0) < 2;
}
/** Facts a QA check must copy exactly: demo accounts, routes, test ids and the app's base URL. */
function specFacts(doc) {
  const text = String(doc || '');
  const emails = [...new Set(text.match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g) || [])].slice(0, 12);
  const accounts = emails.map((email) => {
    const i = text.indexOf(email);
    const near = text.slice(i, i + 160);
    // A password is either labelled ("password: x") or the very next quoted token after the email,
    // with letters and digits ("`a@b.test` – `Admin12345`"). An email with no password is not an account.
    const pw = /\b(?:password|pwd)\b(?:\s*(?:[:=]|is)\s*[`"']?|\s*[`"'])([^\s`"'|,;)]{4,40})/i.exec(text.slice(Math.max(0, i - 60), i + 160))
      || /^[`"']?\s*[–:|,/-]\s*[`"']((?=[^\s`"']*\d)(?=[^\s`"']*[a-z])[^\s`"']{6,40})[`"']/i.exec(near.slice(email.length));
    return { email, password: pw ? pw[1] : null };
  }).filter((a) => a.password);
  const routes = [...new Set((text.match(/(?<![\w:/.])\/[a-z0-9][\w\-/[\]:]*/gi) || []).filter((r) => !/\.(md|ts|tsx|js|json|css)$/i.test(r)))].slice(0, 40);
  const testIds = [...new Set([...text.matchAll(/data-testid=["'`]?([\w-]+)|testid=([\w-]+)|`([a-z]+(?:-[a-z0-9]+)+)`/g)].map((m) => m[1] || m[2] || m[3]).filter(Boolean))].slice(0, 80);
  const port = /localhost:(\d{2,5})/.exec(text)?.[1] || '3000';
  return { accounts, routes, testIds, base: `http://localhost:${port}` };
}
function factsText(f) {
  return [
    `Base URL: ${f.base}`,
    `Demo accounts named in the specification: ${f.accounts.length ? f.accounts.map((a) => `${a.email}${a.password ? ` / ${a.password}` : ''}`).join('; ') : 'none (sign up a new account where one is needed)'}`,
    `Routes named: ${f.routes.join(', ') || 'none'}`,
    `Test ids named: ${f.testIds.join(', ') || 'none (use labels and visible text)'}`,
  ].join('\n');
}
/** The app's origin when nothing answers there (connection refused or no reply in 3 s); null when it is up. */
async function appDown(url, sandbox) {
  let target;
  try { target = new URL(sandbox ? sandbox.mapUrl(String(url)) : String(url)); } catch { return null; }
  if (!/^(localhost|127\.0\.0\.1|\[::1\])$/.test(target.hostname)) return null;
  try { await fetch(target.origin + '/', { signal: AbortSignal.timeout(3000), redirect: 'manual' }); return null; } catch { return target.origin; }
}

const fg = require('fast-glob');
const NO_REPLY = '[DROPs] The previous turn ended without an answer (the app closed or the request failed).';
const STOPPED_BY_ERROR = '[DROPs] Stopped by an error:';
const SUMMARY_PREFIX = '[Context summary of the earlier conversation — older messages were compacted]';

const TASK_DEF = {
  name: 'task',
  description: 'Delegate a self-contained task to a sub-agent with its own fresh context; it returns a concise report and its file dumps never enter your context. mode "research" (default): read-only tools, for exploring large codebases, tracing how something works, or investigating several areas in parallel (call task several times in one turn). mode "edit": the sub-agent can also edit files and run commands, under the same permissions, checkpoints and checks as you; use it to split a large change into independent parts that run in parallel, and give each edit sub-agent its own files so they never edit the same file. Always give a complete brief: goal, files, constraints, how to verify, what to report. Check edit sub-agents\' work yourself before finishing.',
  input_schema: {
    type: 'object',
    properties: {
      description: { type: 'string', description: '3-6 word label' },
      prompt: { type: 'string', description: 'Full brief for the sub-agent' },
      mode: { type: 'string', enum: ['research', 'edit'], description: 'research (default, read-only) or edit (can change files and run commands)' },
    },
    required: ['description', 'prompt'],
  },
};
const WEB_SEARCH_DEF = {
  name: 'web_search',
  description: 'Search the web and get results with sources. Use for current library versions, API changes, error messages and docs. Follow up with fetch_url to read a result in full.',
  input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
};
const ASK_USER_DEF = {
  name: 'ask_user',
  description: 'Ask the user a question and wait for the answer. Use only when you are blocked on a decision that is genuinely theirs (choice between approaches, a missing requirement, an ambiguous goal) and it cannot be settled from the code or a sensible default. Offer 2-4 short concrete options when possible; the user can also type their own answer. Do not use it for permission to run tools: the app asks for that itself.',
  input_schema: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'One clear question' },
      options: { type: 'array', items: { type: 'string' }, description: '2-4 short choices (optional)' },
    },
    required: ['question'],
  },
};
tools.registerDef(TASK_DEF);
tools.registerDef(WEB_SEARCH_DEF);
tools.registerDef(ASK_USER_DEF);

const IMPACT_DEF = {
  name: 'impact',
  description: 'Before changing something shared, see what depends on it: target is a file path (relative to the project), a function/component/class name, a database model name (Prisma), or "cycles" for import cycles. Returns the files that import it (directly and through others), where a name is used, the API route callers, and the tests to run afterwards. A static map from imports and names, not proof: still run those tests.',
  input_schema: { type: 'object', properties: { target: { type: 'string', description: 'File path, symbol name, model name, or "cycles"' } }, required: ['target'] },
};
tools.registerDef(IMPACT_DEF);

const WRAP_UP_DEF = {
  name: 'wrap_up',
  description: 'Fill the "next step" box the user sees at the end of your turn. Call it once, as your last tool call, in every turn where you changed files or ran commands; skip it for a short answer or a question. recap: two or three short sentences in the user\'s language saying what is now true and what is not done or not verified. ask + options: only when the next move is the user\'s decision (a choice, a go-ahead): one short question and 1-3 button labels of 1-4 words, your recommendation first. After calling it, write your final message as usual.',
  input_schema: {
    type: 'object',
    properties: {
      recap: { type: 'string', description: 'Two or three short sentences: what is now true, what is not done or not verified.' },
      ask: { type: 'string', description: 'One short question, only when the user must decide something.' },
      options: { type: 'array', items: { type: 'string' }, description: '1-3 short answers (1-4 words each), recommended first. A click sends it as the user\'s reply.' },
    },
    required: ['recap'],
  },
};
tools.registerDef(WRAP_UP_DEF);

// Every request resends the whole history, so only the newest few images a tool read stay in it;
// older ones become a short note (the agent can read the file again if it needs to).
function dropOldToolImages(messages, keep) {
  let seen = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const c = messages[i].content;
    if (!Array.isArray(c)) continue;
    for (let j = c.length - 1; j >= 0; j--) {
      if (c[j]?.type === 'image' && c[j]._toolImage && ++seen > Math.max(0, keep)) c[j] = { type: 'text', text: '[an image read earlier was removed to save context; read the file again to see it]' };
    }
  }
}

function readProjectInstructions(root) {
  const out = [];
  for (const name of ['DROPs.md', 'H2O.md', 'FORGE.md', 'AGENTS.md', 'CLAUDE.md', '.drops/instructions.md', '.h2o/instructions.md', '.cursorrules']) {
    try {
      const t = fs.readFileSync(path.join(root, name), 'utf8');
      if (t.trim()) out.push(`## From ${name}\n${t.trim().slice(0, 40000)}`);
    } catch { /* not present */ }
  }
  // Team rules: every .md file in .drops/rules/ (or the older .h2o/rules/), committed to the repo and shared by the team.
  try {
    const dir = brand.PROJECT_DIRS.map((d) => path.join(root, d, 'rules')).find((d) => fs.existsSync(d)) || path.join(root, '.drops', 'rules');
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.md')).sort()) {
      const t = fs.readFileSync(path.join(dir, f), 'utf8').trim();
      if (t) out.push(`## Team rule: ${f}\n${t.slice(0, 20000)}`);
    }
  } catch { /* no rules folder */ }
  return out.join('\n\n');
}

const LANGUAGE_NAMES = { bn: 'Bengali (বাংলা)', hi: 'Hindi', ur: 'Urdu', ar: 'Arabic', es: 'Spanish', fr: 'French', de: 'German', pt: 'Portuguese', zh: 'Chinese', ja: 'Japanese', id: 'Indonesian' };

const isPlanMode = (mode) => mode === 'plan' || mode === 'architect';
const isReviewMode = (mode) => mode === 'review';
const isCodeAutoMode = (mode) => mode === 'auto-edit' || mode === 'code';

/** For a task that names a requirements document (e.g. "build the app in SPEC.md"), a note listing every
 *  requirement and journey in it, asking for a plan that covers all of them. Null when there is none. */
// ---- Evidence-based completion -------------------------------------------------------------------
// For a task built on a requirements document, every functional requirement must be proven by a check
// that DROPs itself runs (a command, browser steps, or an HTTP call). The agent describes the check; the
// system executes it and decides pass/fail from the real result. The agent's own words never count.

/** The functional requirements of the first requirements document named in the task (≥ 4), or []. */
function specRequirements(root, task) {
  const names = [...new Set((String(task).match(/[\w./-]+\.(?:md|txt)\b/gi) || []))].slice(0, 3);
  for (const n of names) {
    let doc;
    try { doc = fs.readFileSync(path.resolve(root, n), 'utf8'); } catch { continue; }
    const fr = [...doc.matchAll(/^\|\s*(FR-\d+)\s*\|\s*([^|\n]+)/gm)].map((m) => ({ id: m[1], text: m[2].trim() }));
    if (fr.length >= 4) { fr.doc = doc; return fr; }
  }
  return [];
}

/** Keeps earlier evidence for requirements that are unchanged; new or reworded ones start unverified. */
function mergeRequirements(old = [], fresh = []) {
  return fresh.map((r) => {
    const prev = old.find((o) => o.id === r.id && o.text === r.text);
    return prev ? prev : { id: r.id, text: r.text, status: 'unverified', evidence: null };
  });
}

const CHECK_REQUIREMENT_DEF = {
  name: 'check_requirement',
  description: 'Prove that one requirement from the spec works. You describe a check; DROPs runs it itself and records VERIFIED or NOT verified from the real result (your own statement is never evidence). Kinds: "command" — a test or script that exercises this requirement (exit code 0, and `expect` text in its output if given); "browser" — browser steps like the browser tool ({action, url|target|value|key}) ending on a page that must show `expect`; "http" — a request to the running app whose response must be 2xx and contain `expect`. Check each requirement after building it; re-check after fixing it.',
  input_schema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Requirement id, e.g. FR-3' },
      kind: { type: 'string', enum: ['command', 'browser', 'http'] },
      command: { type: 'string', description: 'kind=command: the test or script to run' },
      steps: { type: 'array', items: { type: 'object' }, description: 'kind=browser: steps, e.g. [{"action":"open","url":"http://localhost:3000/login"},{"action":"fill","target":"Email","value":"a@b.co"},{"action":"click","target":"Log in"}]' },
      url: { type: 'string', description: 'kind=http' },
      method: { type: 'string', description: 'kind=http, default GET' },
      body: { type: 'string', description: 'kind=http, JSON text for POST/PUT' },
      expect: { type: 'string', description: 'Text that must appear in the output / final page / response. Required for browser and http.' },
      use_qa: { type: 'boolean', description: 'Run the independent QA check written for this requirement (when one exists, only it can verify the requirement).' },
      dispute: { type: 'string', description: 'Only with use_qa, once per requirement: say why the QA check itself is wrong (e.g. it logs in with an account the spec does not name, or expects text the spec does not ask for). The QA agent re-reads the spec and decides; it never sees your code.' },
    },
    required: ['id'],
  },
};
tools.registerDef(CHECK_REQUIREMENT_DEF);

function specPlanNote(root, task) {
  const names = [...new Set((String(task).match(/[\w./-]+\.(?:md|txt)\b/gi) || []))].slice(0, 3);
  for (const n of names) {
    let doc;
    try { doc = fs.readFileSync(path.resolve(root, n), 'utf8'); } catch { continue; }
    const reqs = [...doc.matchAll(/^\|\s*((?:FR|NFR)-\d+)\s*\|\s*([^|\n]+)/gm)].map((m) => ({ id: m[1], text: m[2].trim() }));
    const journeys = [...doc.matchAll(/^\s*[-*]\s*\*{0,2}(J\d+)\*{0,2}[\s:.–-]+(.+)$/gm)].map((m) => ({ id: m[1], text: m[2].trim() }));
    const fr = reqs.filter((r) => r.id.startsWith('FR'));
    if (fr.length < 4) continue;
    const short = (s) => (s.length > 90 ? s.slice(0, 87) + '…' : s);
    const lines = [...fr, ...reqs.filter((r) => r.id.startsWith('NFR')), ...journeys].map((r) => `- ${r.id}: ${short(r.text)}`);
    let body = lines.join('\n');
    if (body.length > 4000) body = body.slice(0, 4000) + '\n- … (see the document for the rest)';
    return `[DROPs plan] ${n} lists ${fr.length} functional requirements${journeys.length ? ` and ${journeys.length} key journeys` : ''}. The task is all of them, not a first part. Before writing code, make a todo_write plan that covers every requirement (group related ones, e.g. "Contacts: FR-3, FR-4, FR-5"), then work through it one item at a time. Each functional requirement counts as done only when check_requirement has VERIFIED it (DROPs runs the check itself; your word is not evidence):\n${body}`;
  }
  return null;
}

/** A phrase in an agent's final answer that admits part of the task is still undone, or null. */
function admitsUnfinished(text) {
  const t = String(text || '');
  const pats = [
    /\b(?:ready for|prepared for|foundation for)\s+the\s+remaining\s+\w+(?:\s+\w+)?/i,
    /\bthe\s+remaining\s+(?:features|requirements|pages|screens|functionality|work|items|parts|endpoints)\b(?!\s+(?:are|were|have been)\s+(?:done|complete|completed|implemented))/i,
    /\b(?:not|n't)\s+(?:yet\s+)?(?:been\s+)?(?:implemented|built|done)\s+yet\b/i,
    /\b(?:still|yet)\s+(?:needs?|has|have)\s+to\s+be\s+(?:implemented|built|added|done)\b/i,
    /\b(?:left|remain(?:s|ing)?)\s+to\s+(?:implement|build|do)\b/i,
    /\b(?:ready|about|going)\s+to\s+(?:proceed|start|begin|move on|continue)\s+(?:with|to|on)?\s*(?:implementing|building|the|adding|work)\b/i,
    /\bI(?:'ll|\s+will)\s+(?:now|next)\s+(?:implement|build|add|proceed|continue|work on)\b/i,
    /\bnext(?:\s+step)?,?\s+I(?:'ll|\s+will)\s+(?:implement|build|add)\b/i,
    /\b(?:will|can)\s+be\s+(?:implemented|added|built)\s+(?:later|next|in a (?:later|future|follow-up))\b/i,
    /\bcan\s+now\s+be\s+(?:layered|added|built|implemented)\b/i,
    /\bI(?:'m|\s+am)\s+(?:now\s+)?(?:proceeding|moving\s+on|continuing|going)\s+(?:to|with)\s+(?:implement|build|add|the)\w*\b/i,
    /\bfurther\s+feature\s+(?:implementation|work|development)\b/i,
    /\b(?:further|additional|remaining)\s+(?:specific\s+)?(?:functional\s+)?(?:logic|development|functionality)\b[^.]{0,60}\b(?:can|will|should|needs?)\b/i,
  ];
  for (const p of pats) { const m = t.match(p); if (m) return m[0].trim(); }
  return null;
}

class AgentSession {
  constructor(data, deps) {
    this.data = data;
    this.deps = deps;
    this.data.archive ||= [];
    this.data.compactions ||= [];
    this.busy = false;
    this.abort = null;
    this.pending = new Map();
    this.alwaysAllow = new Set();
    this.readFiles = new Map();
    this.state = { compat: false };
    this.steerQueue = [];
    this.saveTimer = null;
    this.procs = new tools.ProcessManager(data.projectDir, (ev) => this.emit('proc', ev));
  }

  emit(type, payload = {}) { this.deps.send(this.data.id, type, payload); }
  /**
   * Independent completion review: one tool-less call to the same model with the task, the
   * documents it names, a map of the project's source files (sizes reveal placeholders) and the
   * agent's final answer. Returns { done, remaining[] } or null when the review itself fails.
   */
  /** The UI check runs for web apps when a browser is available: always in yolo/headless mode, and in
   *  other modes when the uiCheck setting is on. */
  uiCheckOn(s) {
    if (s.uiCheck === false || !require('./browser').available()) return false;
    if (s.uiCheck !== true && this.data.mode !== 'yolo') return false;
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(this.data.projectDir, 'package.json'), 'utf8'));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      return ['next', 'react', 'vue', 'svelte', 'vite', 'astro', '@angular/core', 'nuxt'].some((d) => d in deps);
    } catch { return false; }
  }

  async auditCompletion(task, finalAnswer, model, signal) {
    try {
      const root = this.data.projectDir;
      const docs = [];
      for (const m of String(task).matchAll(/\b([\w./-]+\.(?:md|txt))\b/g)) {
        try { docs.push(`## ${m[1]}\n${fs.readFileSync(path.join(root, m[1]), 'utf8').slice(0, 14000)}`); } catch { /* not a file */ }
        if (docs.length >= 2) break;
      }
      const files = [];
      const walk = (dir, depth) => {
        if (depth > 6 || files.length > 200) return;
        let names = []; try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const d of names) {
          if (/^(node_modules|\.next|\.git|dist|build|coverage|\.h2o|\.drops)$/.test(d.name)) continue;
          const p = path.join(dir, d.name);
          if (d.isDirectory()) walk(p, depth + 1);
          else if (/\.(tsx?|jsx?|py|go|rs|java|cs|rb|php|vue|svelte|prisma|sql)$/.test(d.name)) {
            try { files.push(`${path.relative(root, p).replace(/\\/g, '/')} (${fs.readFileSync(p, 'utf8').split('\n').length} lines)`); } catch { /* unreadable */ }
          }
        }
      };
      walk(root, 0);
      const plan = (this.data.todos || []).map((t) => `- [${t.status}] ${t.content}`).join('\n');
      const prompt = [
        `# Task given to the coding agent\n${String(task).slice(0, 6000)}`,
        docs.length ? `# Documents the task refers to\n${docs.join('\n\n')}` : '',
        `# Source files in the project now (line counts)\n${files.join('\n') || '(none)'}`,
        plan ? `# The agent's plan\n${plan}` : '',
        `# The agent's final answer\n${String(finalAnswer).slice(0, 4000)}`,
        `Is the WHOLE task finished? Judge strictly from the task and documents versus the files that exist: a requirement with no page/module for it, a page of only a few lines, or work the final answer defers ("next", "will", "remaining") means NOT done. A plan marked completed is not evidence. Reply with JSON only: {"done": true|false, "remaining": ["short concrete item", ...]} (at most 8 items, empty when done).`,
      ].filter(Boolean).join('\n\n');
      const res = await providers.callModel({
        model, system: 'You are a strict, fair reviewer of a coding agent\'s work. You reply with JSON only.',
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }], tools: [],
        effort: providers.providerOf(model) === 'ollama' ? false : 'low', signal, emit: () => {}, deps: this.deps, state: { compat: false }, web: false,
      });
      this.accountSubUsage?.(res.usage, res.model || model);
      const out = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      const j = JSON.parse((out.match(/\{[\s\S]*\}/) || ['null'])[0]);
      if (!j || typeof j.done !== 'boolean') return null;
      return { done: j.done, remaining: (Array.isArray(j.remaining) ? j.remaining : []).map(String).filter(Boolean).slice(0, 8) };
    } catch { return null; }
  }

  /** Store a lesson the loop inferred by itself (never fails the turn). */
  autoLesson(text, context) {
    if (!text || this.settings().lessons === false) return;
    try { lessons.add(text, 'auto', context); } catch { /* lessons are best-effort */ }
  }
  settings() { return this.deps.getSettings(); }
  save(now = false) {
    clearTimeout(this.saveTimer);
    this.data.updated = Date.now();
    if (now) this.deps.save(this.data);
    else this.saveTimer = setTimeout(() => this.deps.save(this.data), 400);
  }

  // ---------- prompt ----------
  systemPrompt(model, query = '') {
    const s = this.settings();
    const root = this.data.projectDir;
    const day = new Date().toISOString().slice(0, 10);
    const profile = ctxEngine.projectProfile(root);
    const isOllama = providers.providerOf(model) === 'ollama';
    const map = ctxEngine.repoMap(root, isOllama ? 4000 : 14000, query);
    const proj = readProjectInstructions(root);
    const gem = providers.providerOf(model) !== 'anthropic';
    const sandbox = this.procs.sandbox;
    const host = shell.detectHostShell();
    const osName = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' }[process.platform] || process.platform;
    const shellNote = sandbox
      ? `\`shell\` runs **bash inside a Docker sandbox** (image ${sandbox.image}${sandbox.network ? '' : ', no network'}); the project is mounted at /workspace and that is the working directory. Install tools with the image's package manager if needed. File tools still edit the same project files.`
      : host.kind === 'powershell'
        ? `\`shell\` runs ${host.label} on ${osName} (use $env:VAR, ';' to chain, check $LASTEXITCODE${host.label.includes('5.1') ? '; no && / || in Windows PowerShell 5.1' : ''}).`
        : `\`shell\` runs ${host.label} on ${osName} (POSIX syntax).`;
    const mcp = this.deps.mcp?.status().filter((x) => x.status === 'connected') || [];
    const lang = LANGUAGE_NAMES[s.responseLanguage] || (s.responseLanguage && s.responseLanguage !== 'en' ? s.responseLanguage : null);
    return [
      `You are DROPs, an elite autonomous software engineer working inside the user's project. You plan, read and search code, edit files, run commands, and verify your work end to end. You are precise, fast, and honest about what you did and did not verify.`,
      `# Environment\n- OS: ${osName} ${os.release()}\n- ${shellNote}\n- Project root: ${root} (file tools take paths relative to it and cannot leave it)\n- Today: ${day}\n- Model: ${model}`,
      mcp.length ? `# Connected MCP servers\n${mcp.map((m) => `- ${m.name}: tools ${m.tools.map((t) => '`' + t + '`').join(', ')} (exposed as mcp__${m.name}__<tool>)`).join('\n')}` : '',
      lang ? `# Language\nWrite all explanations, progress notes and the final report in ${lang}. Keep code, identifiers, file paths, commands and error messages in their original form.`
        : `# Language\nReply in the language AND the writing system of the user's latest message: English → English; Bangla, Hindi or Urdu typed in Latin letters (e.g. "kaj koro", "kya hai") → the same, in Latin letters; Bangla script → Bangla script; Devanagari → Devanagari; Arabic script → Arabic script; any other language → that language. Never switch writing systems inside an answer. Keep code, file names, commands and error messages as they are.`,
      s.explainMode ? `# Teaching mode is ON\nThe user is learning. After each meaningful change, explain briefly and plainly: what you changed, why it was needed, and the concept behind it (1-3 sentences, no jargon without a short definition). In the final report, add a "What you can learn from this" section with 2-4 bullet points.` : '',
      `# Project profile (auto-detected)\n${profile.text}${profile.verify.length ? `\n- Likely verification commands: ${profile.verify.map((v) => '`' + v + '`').join(', ')}` : ''}`,
      `# Operating procedure
1. Understand first. For anything non-trivial, find the relevant code with grep/glob/read_file before changing it. Before changing a shared file, function, API route or database model, run \`impact\` on it to see what depends on it, and run the tests it lists afterwards. For broad questions or large codebases, delegate parallel investigations with the \`task\` tool (several calls in one turn) so file dumps stay out of your context.
2. Plan. For work with 3+ steps, write a todo list with todo_write and keep it updated (exactly one in_progress).
3. Make minimal, surgical, idiomatic changes that match the surrounding style. Use edit_file / multi_edit for existing files (read them first); write_file only for new files or full rewrites. Never leave placeholders like "// rest of code here".
4. Every edit reports instant diagnostics (syntax checks). If they show an error, fix it immediately.
5. Verify for real: run the project's type-checker, tests, linter or build with \`shell\`, read the output, and fix failures. For servers/watchers use start_process + process_output (never block \`shell\` on a command that does not exit), and stop_process when done.
6. Batch independent read-only calls in parallel in a single turn — it is much faster.
7. If a tool call is denied or fails twice the same way, change approach instead of retrying. If truly blocked on a decision that is the user's, ask with \`ask_user\` (offer concrete options) instead of guessing.
8. Record durable project knowledge (build/test commands, conventions, gotchas) with \`remember\` when you discover it. When you make a mistake and find the fix (a wrong assumption, a command that does not exist, a framework pitfall, stopping too early), record one short, general rule with \`learn_lesson\` so you never repeat it in any project.
9. Never run destructive or irreversible operations (deleting data, force-push, publishing, dropping databases) unless the user explicitly asked.
10. Finish with a short report (see "How to talk to the user"). Never claim tests pass unless you ran them.`,
      `# How to talk to the user
The user sees each tool call as a compact step, so do not narrate tool output back to them.
- Before a batch of tool calls, write one short sentence (under 20 words) saying what you are about to do, e.g. "Reading the router and its tests to find where the redirect happens." Skip it for trivial follow-up calls.
- When you learn something that changes the plan, say it in one sentence.
- Final answer: start with the outcome in one or two plain sentences (what is now true). Then, only if useful, a few short bullets: what changed (\`path:line\`), how it was verified (command and result), and anything not done or risky. No headings for short answers, no filler ("Great question", "I hope this helps"), no repeating the question.
- Answer questions directly; give the explanation after the answer, not before.
- If you could not finish or verify something, say so plainly at the top.
- Write for the person, not for another engineer: no process ids, pipes, ports or internal mechanics unless they asked or must act on it. Short sentences, plain words.
- In a turn where you changed files or ran commands, call \`wrap_up\` last (recap, and a question with buttons only when the next move is theirs), then write the final message.`,
      `# Tools notes\n- Web: ${gem ? 'use `web_search` for current information and `fetch_url` to read pages.' : 'use the web_search / web_fetch tools for current information; `fetch_url` also reads pages.'}${require('./browser').available() ? '\n- Browser: `browser` is a real headless browser. To prove a web app works, start it with start_process, open http://localhost:<port>, and use it like a user (fill, click, read the result); each step reports console errors and failed requests. Use it also for sites that need JavaScript or clicks.' : ''}\n- GitHub: for pull requests and CI use the GitHub CLI (\`gh pr create\`, \`gh pr checks\`, \`gh run view <id> --log-failed\`) when it is installed and signed in. Never ask for, read or type a token; if gh is missing, tell the user how to install it and sign in.\n- Messages that start with "[User steering]" were typed by the user while you were working: follow them, they take priority over your plan.`,
      isPlanMode(this.data.mode)
        ? `# PLAN MODE IS ON\nInvestigate with read-only tools only and produce a precise implementation plan (files, changes, verification steps, risks). Do not modify files or run state-changing commands. End by asking the user to approve the plan.`
        : isReviewMode(this.data.mode)
          ? `# REVIEW MODE IS ON\nYou are in read-only code review mode. Inspect files, search code, and run non-destructive read/test checks, then provide a structured review with findings, severity, and file/line references. Do NOT modify, write, or delete any files.`
          : '',
      s.customInstructions ? `# User's global instructions\n${s.customInstructions}` : '',
      proj ? `# Project instructions (DROPs.md etc.)\n${proj}` : '',
      s.lessons !== false ? lessons.promptSection() : '',
      map ? `# Repository map (auto-generated at the start of this request; files with their top-level symbols)\n${map}` : '',
    ].filter(Boolean).join('\n\n');
  }

  toolDefs(model) {
    const defs = [...tools.definitions(), TASK_DEF, ASK_USER_DEF, WRAP_UP_DEF, IMPACT_DEF, WEB_SEARCH_DEF, ...(this.data.requirements?.length ? [CHECK_REQUIREMENT_DEF] : [])];
    // Older sessions called the shell tool "powershell": keep the name valid for their history.
    if (this.data.messages.some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_use' && b.name === 'powershell'))) {
      defs.push({ ...tools.definitions(new Set(['shell']))[0], name: 'powershell' });
    }
    for (const d of this.deps.mcp?.toolDefs() || []) { const { _mcp, ...def } = d; defs.push(def); }
    return defs;
  }

  // ---------- transcript helpers ----------
  pushUser(content) {
    const msgs = this.data.messages;
    const last = msgs[msgs.length - 1];
    // The previous turn ended with no answer (the app closed or crashed): say so, never "interrupted by user".
    if (last && last.role === 'user') msgs.push({ role: 'assistant', content: [{ type: 'text', text: NO_REPLY }] });
    msgs.push({ role: 'user', content });
  }
  /** Leaves the transcript valid after a turn ends early. `note` says why: the user's stop (default) or an error. */
  sealTranscript(note = INTERRUPTED) {
    const msgs = this.data.messages;
    const last = msgs[msgs.length - 1];
    if (!last) return;
    if (last.role === 'assistant') {
      const uses = (Array.isArray(last.content) ? last.content : []).filter((b) => b.type === 'tool_use');
      if (uses.length) {
        msgs.push({ role: 'user', content: uses.map((u) => ({ type: 'tool_result', tool_use_id: u.id, is_error: true, content: 'Interrupted before this tool ran.' })) });
        msgs.push({ role: 'assistant', content: [{ type: 'text', text: note }] });
      } else if (note !== INTERRUPTED) msgs.push({ role: 'user', content: [{ type: 'text', text: '[DROPs] The turn stopped early.' }] }, { role: 'assistant', content: [{ type: 'text', text: note }] });
    } else msgs.push({ role: 'assistant', content: [{ type: 'text', text: note }] });
  }

  // ---------- steering ----------
  steer(text, images = []) {
    if (!this.busy) return false;
    this.steerQueue.push({ text, images });
    this.emit('steer-queued', { text });
    return true;
  }
  takeSteering() {
    if (!this.steerQueue.length) return [];
    const items = this.steerQueue.splice(0);
    this.emit('steer-delivered', { count: items.length });
    const blocks = [];
    for (const it of items) {
      for (const img of it.images || []) blocks.push(img);
      blocks.push({ type: 'text', text: `[User steering] ${it.text}` });
    }
    return blocks;
  }

  expandMentions(text) {
    const out = [];
    const seen = new Set();
    const re = /(?:^|\s)@([\w./\\-]+\.[\w]+)(?::(\d+)(?:-(\d+))?)?/g;
    let m;
    while ((m = re.exec(text)) && out.length < 5) {
      const [, rel, startStr, endStr] = m;
      const key = `${rel}:${startStr || ''}:${endStr || ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      let abs;
      try { abs = tools.resolveInRoot(this.data.projectDir, rel); } catch { continue; }
      let st, buf;
      try {
        st = fs.statSync(abs);
        if (!st.isFile() || st.size > 1024 * 1024) continue;
        buf = fs.readFileSync(abs);
      } catch { continue; }
      if (buf.subarray(0, 8000).includes(0)) continue;
      this.readFiles.set(abs, st.mtimeMs);
      const lines = buf.toString('utf8').replace(/\r\n/g, '\n').split('\n');
      const start = startStr ? Math.max(1, Number(startStr)) : 1;
      const end = Math.min(lines.length, startStr ? (endStr ? Math.max(start, Number(endStr)) : start + 80) : 200);
      const snippet = lines.slice(start - 1, end).map((l, i) => `${start + i}\t${l}`).join('\n').slice(0, 8000);
      const clean = shell.redact(snippet).text;
      out.push(`<mentioned_file path="${rel.replace(/\\/g, '/')}" lines="${start}-${end}">\n${clean}\n</mentioned_file>`);
    }
    return out.join('\n\n');
  }

  // ---------- main entry ----------
  async send(text, opts, images = [], extra = {}) {
    if (this.busy) throw new Error('Agent is busy');
    this.busy = true;
    this.abort = extra.signal ? { signal: extra.signal, abort: () => extra.abortController?.abort() } : new AbortController();
    const signal = extra.signal || this.abort.signal;
    this._currentTaskId = extra.taskId || null;
    const onProgress = extra.onProgress || (() => {});
    const s = this.settings();
    Object.assign(this.data, { model: opts.model, effort: opts.effort, mode: opts.mode });
    if (!this.data.title || this.data.title === 'New session') this.data.title = text.replace(/\s+/g, ' ').trim().slice(0, 64) || 'New session';

    const mentioned = this.expandMentions(text);
    const userBlocks = [...images, { type: 'text', text }];
    if (mentioned) userBlocks.push({ type: 'text', text: mentioned });
    // A task built on a requirements document gets a checklist of every requirement up front, so a
    // smaller model plans the whole job instead of stopping after the first part.
    const planNote = s.specPlan === false ? null : specPlanNote(this.data.projectDir, text);
    if (planNote) userBlocks.push({ type: 'text', text: planNote });
    if (s.evidenceCheck !== false) {
      const reqs = specRequirements(this.data.projectDir, text);
      if (reqs.length) {
        this.data.requirements = mergeRequirements(this.data.requirements, reqs);
        if ((s.qaAgent === true || (s.qaAgent !== false && opts.mode === 'yolo')) && this.data.requirements.some((r) => !r.qa)) {
          await this.writeQaChecks(reqs.doc, opts.model).catch((e) => this.emit('notice', { message: `QA agent could not write checks: ${String(e.message || e).slice(0, 120)}` }));
        }
        this.emit('requirements', { requirements: this.data.requirements });
      }
    }
    this.pushUser(userBlocks);
    const turn = { msgIndex: this.data.messages.length - 1, text, files: {}, at: Date.now() };
    this.data.turns.push(turn);
    this.emit('turn-start', { turnIndex: this.data.turns.length - 1, title: this.data.title });
    this.emit('status', { busy: true });
    this.save(true);

    const ctx = this.makeCtx(turn, signal);
    const run = {
      model: opts.model,
      edited: false, verifiedAfterEdit: true, lastVerify: null, nudges: 0, steps: 0,
      editedFiles: new Set(), diagErrors: new Map(), guard: new guards.LoopGuard(3), verify: ctxEngine.projectProfile(this.data.projectDir).verify,
    };
    const maxSteps = s.maxSteps || 250;
    const compactAtFor = (m) => Math.min(s.compactAt || 180000, Math.floor(providers.contextWindow(m, s) * 0.75));
    let jsonRetries = 0;

    // Auto routing: start on the cheapest tier that fits the request, escalate when it struggles.
    run.auto = opts.model === 'auto';
    if (run.auto) {
      run.tier = providers.initialTier(text);
      opts = { ...opts, model: providers.resolveAuto(s, run.tier) };
      this.emit('auto-model', { model: opts.model, tier: run.tier, reason: ['quick question', 'normal task', 'complex task'][run.tier] });
    }
    let compactAt = compactAtFor(opts.model);
    let system = this.systemPrompt(opts.model, text);
    run.escalate = (reason) => {
      if (!run.auto || run.tier >= 2) return;
      run.tier++;
      opts = { ...opts, model: providers.resolveAuto(s, run.tier) };
      compactAt = compactAtFor(opts.model);
      system = this.systemPrompt(opts.model, text);
      this.emit('auto-model', { model: opts.model, tier: run.tier, reason, escalated: true });
    };
    // Per-task budget.
    const u0 = { ...this.data.usage };
    const budgetHit = () => {
      const u = this.data.usage;
      if (s.maxCostPerTask > 0 && u.cost - u0.cost > s.maxCostPerTask) return `Budget limit reached: this task has cost $${(u.cost - u0.cost).toFixed(2)} (limit $${s.maxCostPerTask}).`;
      const tok = (x) => x.input + x.output + x.cacheRead + x.cacheWrite;
      if (s.maxTokensPerTask > 0 && tok(u) - tok(u0) > s.maxTokensPerTask) return `Token budget reached: this task used ${tok(u) - tok(u0)} tokens (limit ${s.maxTokensPerTask}).`;
      return null;
    };

    // Docker sandbox (optional).
    if (s.sandbox) {
      const cfg = { image: s.sandboxImage || 'node:22-bookworm', network: s.sandboxNetwork !== false };
      const cur = this.procs.sandbox;
      if (!cur || cur.image !== cfg.image || cur.network !== cfg.network) this.procs.sandbox = new shell.Sandbox(this.data.projectDir, cfg);
      this.emit('notice', { message: `Sandbox: commands run inside Docker (${cfg.image})…` });
      try { await this.procs.sandbox.ensure(); system = this.systemPrompt(opts.model, text); } catch (e) {
        this.emit('error', { message: e.message }); this.sealTranscript(); this.finish(opts); return;
      }
    } else if (this.procs.sandbox) { this.procs.sandbox = null; system = this.systemPrompt(opts.model, text); }

    try {
      for (;;) {
        if (signal.aborted) throw new Error('aborted');
        if (++run.steps > maxSteps) { this.emit('error', { message: `Stopped after ${maxSteps} steps (limit in Settings). Send "continue" to keep going.` }); this.sealTranscript(); break; }
        onProgress({ step: run.steps, maxSteps, percent: Math.min(100, Math.round((run.steps / maxSteps) * 100)) });
        const over = budgetHit();
        if (over) { this.emit('error', { message: `${over} Send "continue" to keep going, or raise the limit in Settings.` }); this.sealTranscript(); break; }

        if (this.data.usage.context > compactAt && turn.msgIndex > 2) {
          await this.compact(opts, signal, 'auto');
          system = this.systemPrompt(opts.model, text);
        }

        this.emit('iteration-start', {});
        let message;
        try {
          message = await providers.callModel({
            model: opts.model, system, messages: this.data.messages, tools: this.toolDefs(opts.model),
            effort: opts.effort, signal, emit: (t, p) => this.emit(t, p), deps: this.deps, state: this.state,
          });
          jsonRetries = 0;
        } catch (err) {
          if (signal.aborted) throw err;
          if (/json/i.test(err?.message || '') && !err.status && jsonRetries++ < 2) { this.emit('notice', { message: 'A tool call arrived malformed; retrying the step.' }); continue; }
          if ((run.auto || s.autoFallback) && !run.localFallback && s.ollamaEnabled && providers.providerOf(opts.model) !== 'ollama' && (err?.status === 429 || err?.status === 503 || err?.status === 529)) {
            run.localFallback = true;
            opts = { ...opts, model: s.ollamaDefaultModel || 'ollama:muse-glimmer:latest' };
            compactAt = compactAtFor(opts.model);
            system = this.systemPrompt(opts.model, text);
            this.emit('auto-model', { model: opts.model, tier: run.tier ?? 1, reason: `provider fallback after ${err.status}`, escalated: true });
            continue;
          }
          throw err;
        }
        this.accountUsage(message.usage, message.model || opts.model);

        if (message.stop_reason === 'refusal') {
          const cat = message.stop_details?.category;
          this.emit('error', { message: `The model declined to continue${cat ? ` (${cat})` : ''}. Try rephrasing.` });
          this.sealTranscript();
          break;
        }
        const uses = message.content.filter((b) => b.type === 'tool_use');
        if (message.stop_reason === 'max_tokens' && uses.length) {
          this.emit('error', { message: 'Hit the output limit in the middle of a tool call. Ask the agent to continue in smaller steps.' });
          const keep = message.content.filter((b) => b.type !== 'tool_use');
          if (keep.length) this.data.messages.push({ role: 'assistant', content: keep });
          this.sealTranscript();
          break;
        }

        const assistantMsg = { role: 'assistant', content: message.content.length ? message.content : [{ type: 'text', text: '(no response)' }] };
        if (message.raw) {
          assistantMsg._gemini = message.raw;
          assistantMsg._geminiModel = message.model;
          if (message.model && message.model !== opts.model) { opts = { ...opts, model: message.model }; this.emit('model-switched', { model: message.model }); }
        }
        this.data.messages.push(assistantMsg);
        this.save();

        if (message.stop_reason === 'pause_turn') continue;

        if (!uses.length) {
          // Steering that arrived while the model was writing its final answer.
          const steer = this.takeSteering();
          if (steer.length) { this.data.messages.push({ role: 'user', content: steer }); continue; }
          // Verification guard: only a real check after the last edit counts, and it must pass.
          if (s.evidenceCheck !== false && run.edited && (this.data.requirements || []).length && !isPlanMode(this.data.mode) && !isReviewMode(this.data.mode)) {
            await this.reverifyStale(ctx, run).catch(() => 0);
          }
          if (s.autoVerify !== false && !isPlanMode(this.data.mode) && !isReviewMode(this.data.mode) && run.nudges < 5) {
            const replyText = message.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
            const how = run.verify.length ? run.verify.map((v) => '`' + v + '`').join(', ') : 'the tests, build or type-checker (at minimum, execute the changed code)';
            let msg = null;
            if (run.diagErrors.size > 0) {
              msg = `[DROPs verification guard] Your recent edits left syntax or type errors in ${[...run.diagErrors.keys()].join(', ')}. Fix the diagnostic errors and run verification before finishing.`;
              this.emit('notice', { message: 'Verification guard: diagnostic errors remain in edited files; sending the agent back to fix them.' });
            } else if (run.edited && !run.verifiedAfterEdit) {
              if (!(run.nudges >= 1 && /\b(cannot verify|impossible to verify|no test|environment)\b/i.test(replyText))) {
                msg = `[DROPs verification guard] You changed ${[...run.editedFiles].slice(0, 6).join(', ')} but have not run a real verification since the last change. Run ${how} now and fix any failures. Unrelated commands (listing files, echo, git status) do not count. If verification is truly impossible here, state exactly why in one line and finish.`;
                this.emit('notice', { message: 'Verification guard: no real test or build has run since the last change; sending the agent back to verify.' });
                this.autoLesson('After the last edit, always run a real check (tests, build or type-checker) and read its result before finishing.', 'verification-guard');
              }
            } else if (run.debugMode && !run.debugTestNudged && run.lastVerify !== 'fail' && !(run.debugTestFiles?.size)) {
              // A failure that needed real debugging must not come back: ask for a regression test once.
              run.debugTestNudged = true;
              msg = '[DROPs debug] You fixed a failure that took several tries. Add a regression test that fails without your fix (or say in one line why a test is not possible here), run it, and in your final answer name the root cause in one sentence.';
              this.emit('notice', { message: 'Debugging: asking the agent for a regression test and the root cause.' });
            } else if (run.edited && run.lastVerify === 'fail') {
              if (!(run.failNudged && /\b(pre-existing|already fail|original code|unrelated|cannot verify|impossible)\b/i.test(replyText))) {
                run.failNudged = true;
                run.escalate('its verification failed');
                msg = '[DROPs verification guard] Your last verification command FAILED. Fix the cause and re-run it before finishing. If the failure is pre-existing and unrelated to your change, prove it in one line (e.g. it also fails on the original code) and finish.';
                this.emit('notice', { message: 'Verification guard: the last check failed; sending the agent back to fix it.' });
              }
            } else if (run.edited && (run.incompleteNudges || 0) < 2 && admitsUnfinished(replyText)
              && !(run.incompleteNudges && /\b(cannot|can't|impossible|blocked|out of scope|not possible)\b/i.test(replyText))) {
              // The agent's own final words say part of the task is still undone ("ready for the remaining
              // features"). A plan marked all-completed does not override that admission.
              run.incompleteNudges = (run.incompleteNudges || 0) + 1;
              msg = `[DROPs completion guard] Your final answer says part of the task is not done ("${admitsUnfinished(replyText)}"). The task asks for all of it. Do the remaining work now, verify it, and only then finish. If something truly cannot be done here, say exactly what and why in one line.`;
              this.emit('notice', { message: 'Completion guard: the agent said work is still remaining; sending it back to finish.' });
              this.autoLesson('Do not end with a progress report while parts of the task remain: keep working until every requirement is implemented and verified, then give one final answer.', 'completion-guard');
            } else if (run.edited && s.evidenceCheck !== false && evidenceNudgeAllowed(run, this.data.requirements)) {
              // Evidence check: every requirement of the spec needs a passing check that DROPs ran itself.
              // It gives up only after two nudges in a row with no new requirement verified (or eight in all).
              run.evidenceNudges = (run.evidenceNudges || 0) + 1;
              run.evidenceTotalNudges = (run.evidenceTotalNudges || 0) + 1;
              run.evidenceVerifiedAtNudge = verifiedCount(this.data.requirements);
              const reqs = this.data.requirements, open = reqs.filter((r) => r.status !== 'verified');
              msg = `[DROPs evidence check] ${open.length} of ${reqs.length} requirements have no passing evidence: ${open.slice(0, 12).map((r) => `${r.id}${r.status === 'failed' ? ' (its check failed)' : r.status === 'stale' ? ' (verified before a later change; DROPs could not re-check it: keep the app running)' : ''}`).join(', ')}${open.length > 12 ? ', …' : ''}. Your statement that they work is not evidence.${open.some((r) => r.qa) ? ' These have independent QA checks: start the app and run check_requirement with use_qa: true for each; fix the app (never the check) until they pass.' : ' Build whatever is missing, then prove each one with check_requirement (a test command, browser steps that end on a page showing the expected text, or an HTTP call to the running app).'} Fix and re-check any that fail.`;
              this.emit('notice', { message: `Evidence check: ${open.length} of ${reqs.length} requirements are not verified yet; sending the agent back.` });
            } else if (run.uiIssue && (run.uiIssueNudges || 0) < 2 && this.uiCheckOn(s)) {
              // The browser showed a problem and the agent is finishing anyway ("verified").
              run.uiIssueNudges = (run.uiIssueNudges || 0) + 1;
              msg = `[DROPs UI check] The browser showed a problem that is not fixed: ${run.uiIssue}. A user would hit this, so the task is not done. Find the cause (read the server output with process_output, the failed request, the page code), fix it, restart the app if you rebuilt it, and check the same step again in the browser before finishing.`;
              this.emit('notice', { message: `UI check: the browser showed an unfixed problem (${run.uiIssue.slice(0, 80)}); sending the agent back.` });
              this.autoLesson('Treat what the browser shows as the truth: if a click or submit changes nothing or shows errors, it is broken, whatever the build says. Fix it and check again before claiming success.', 'ui-issue');
            } else if (run.uiDirty && !run.uiNudged && this.uiCheckOn(s)) {
              // UI check: a build and type-check passing does not mean the pages work. Look at them.
              run.uiNudged = true;
              const pages = [...run.editedFiles].filter((f) => guards.isUiFile(f)).slice(0, 5).join(', ');
              msg = `[DROPs UI check] You changed the app's pages (${pages}) but have not looked at them in a browser. Start the app with start_process (for example \`npm run build && npm start\`, or \`npm run dev\`), then use the browser tool: open http://localhost:3000 and go through the main user journeys the way a real user would (log in with the demo account if there is one, create and edit something, check that lists and messages update). Fix whatever is broken: errors on screen, console errors, failed requests, pages that are missing or empty, sideways scrolling on a phone (width 375). Stop the process when done, then finish.`;
              this.emit('notice', { message: 'UI check: pages changed but were never opened in a browser; sending the agent to check them.' });
              this.autoLesson('After changing a web app\'s pages, run the app and click through the main journeys with the browser tool before finishing; a passing build does not prove the pages work.', 'ui-check');
            } else if (!run.todoNudged && Array.isArray(this.data.todos) && this.data.todos.length > 0 && this.data.todos.some((t) => t.status !== 'completed')) {
              run.todoNudged = true;
              const pending = this.data.todos.filter((t) => t.status !== 'completed').map((t) => t.content).slice(0, 4).join('; ');
              msg = `[DROPs verification guard] Your task plan still has unfinished items (${pending}). Complete the remaining work or update the plan with todo_write before finishing.`;
              this.emit('notice', { message: 'Verification guard: task plan has unfinished items; sending the agent back to finish or update the plan.' });
            }
            // Completion audit: an independent reviewer call judges whether the whole task is done,
            // from the task, the project's files and the final answer — not from the agent's wording.
            if (!msg && run.edited && (run.audits || 0) < 2 && (run.toolCalls || 0) >= 6 && !signal.aborted
              && (s.completionAudit === true || (s.completionAudit !== false && this.data.mode === 'yolo'))) {
              run.audits = (run.audits || 0) + 1;
              const verdict = await this.auditCompletion(text, replyText, opts.model, signal);
              if (verdict && verdict.done === false && verdict.remaining.length) {
                msg = `[DROPs completion audit] An independent review of the task and the project found it is not finished:\n${verdict.remaining.map((r) => `- ${r}`).join('\n')}\nDo this remaining work now (real implementations, no placeholders), verify it, and only then finish.`;
                this.emit('notice', { message: `Completion audit: ${verdict.remaining.length} part(s) of the task are not done; sending the agent back.` });
                this.autoLesson('Before the final answer, compare the finished work against every requirement in the task; partial work or placeholder pages are not done.', 'completion-audit');
              }
            }
            if (msg) {
              run.nudges++;
              this.data.messages.push({ role: 'user', content: [{ type: 'text', text: msg }] });
              continue;
            }
          }
          // Some models (thinking-heavy ones especially) finish without writing anything to the user.
          // After real work, ask once for the final answer so the user is never left with only tool calls.
          const finalText = message.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
          if (run.toolCalls > 0 && !finalText && !run.reportNudged && !signal.aborted) {
            run.reportNudged = true;
            this.data.messages.push({ role: 'user', content: [{ type: 'text', text: '[DROPs report] You finished without writing anything to the user. Write your final answer now, without calling tools: start with the outcome in one or two plain sentences (what is now true), then short bullets for what changed (path:line) and how it was verified, and anything not done.' }] });
            continue;
          }
          break;
        }

        run.toolCalls = (run.toolCalls || 0) + uses.length;
        const results = await this.runTools(uses, ctx, opts, run);
        const steer = this.takeSteering();
        // Images a tool produced (read_file on a picture) follow the tool results in the same message.
        const toolImages = results.flatMap((r) => r?._images || []);
        for (const r of results) if (r) delete r._images;
        if (toolImages.length) dropOldToolImages(this.data.messages, 3 - toolImages.length);
        // A message the user typed meanwhile rides in the same user turn as the tool results (tool
        // results first): two user turns in a row are refused by some model APIs.
        this.data.messages.push({ role: 'user', content: [...results, ...toolImages, ...steer] });
        this.save();
        if (signal.aborted) throw new Error('aborted');
      }
    } catch (err) {
      if (signal.aborted) {
        this.sealTranscript();
        this.emit('notice', { message: 'Stopped.' });
      } else {
        // Keep the real reason in the transcript, so it is visible later and the next turn knows.
        const fe = providers.friendlyError(err, opts.model);
        this.sealTranscript(`${STOPPED_BY_ERROR} ${String(fe.message || err).split('\n')[0].slice(0, 300)}`);
        this.data.lastError = { message: String(fe.message || err).slice(0, 500), at: Date.now(), model: opts.model };
        this.emit('error', fe);
      }
    }
    this.finish(opts);
  }

  finish(opts) {
    // A task on a requirements document always ends with the plain count, whatever the agent said.
    const reqs = this.data.requirements || [];
    if (reqs.length && this.settings().evidenceCheck !== false) {
      const ok = verifiedCount(reqs);
      this.data.evidenceSummary = { verified: ok, total: reqs.length, at: Date.now() };
      const open = reqs.filter((r) => r.status !== 'verified').map((r) => r.id);
      this.emit('notice', { message: `Evidence: ${ok} of ${reqs.length} requirements verified by a check DROPs ran${open.length ? ` (not verified: ${open.slice(0, 15).join(', ')}${open.length > 15 ? ', …' : ''})` : ''}.` });
    }
    const stoppedByUser = !!this.abort?.signal?.aborted;
    for (const [, r] of this.pending) r({ decision: 'deny', feedback: 'Stopped.' });
    this.pending.clear();
    this.busy = false;
    this.abort = null;
    this.save(true);
    this.emit('status', { busy: false });
    this.emit('done', {});
    // Steering that never got delivered: after a Stop it goes back to the user's input box; otherwise
    // it becomes the next message.
    if (this.steerQueue.length && stoppedByUser) {
      const items = this.steerQueue.splice(0);
      this.emit('steer-returned', { text: items.map((i) => i.text).join('\n\n') });
    } else if (this.steerQueue.length) {
      const items = this.steerQueue.splice(0);
      const text = items.map((i) => i.text).join('\n\n');
      const images = items.flatMap((i) => i.images || []);
      this.emit('steer-resend', { text });
      setTimeout(() => this.send(text, opts, images).catch(() => {}), 50);
    }
  }

  makeCtx(turn, signal) {
    return {
      root: this.data.projectDir,
      signal,
      readFiles: this.readFiles,
      procs: this.procs,
      onTodos: (todos) => { this.data.todos = todos; this.emit('todos', { todos }); },
      snapshot: async (abs) => {
        if (abs in turn.files) return;
        turn.files[abs] = await fsp.readFile(abs, 'utf8').catch(() => null);
      },
      onChange: (rel, diff) => {
        const c = this.data.changes[rel] || { added: 0, removed: 0, edits: 0 };
        c.added += diff.added; c.removed += diff.removed; c.edits++;
        this.data.changes[rel] = c;
        this.emit('changes', { changes: this.data.changes });
      },
    };
  }

  accountUsage(u = {}, model) {
    const t = this.data.usage;
    t.input += u.input_tokens || 0;
    t.output += u.output_tokens || 0;
    t.cacheRead += u.cache_read_input_tokens || 0;
    t.cacheWrite += u.cache_creation_input_tokens || 0;
    const c = providers.costOf(model, u);
    if (c === null) t.costUnknown = true; else t.cost += c;
    t.context = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0);
    t.requests = (t.requests || 0) + 1;
    this.emit('usage', { usage: t });
  }
  accountSubUsage(u = {}, model) {
    const t = this.data.usage;
    t.input += u.input_tokens || 0;
    t.output += u.output_tokens || 0;
    t.cacheRead += u.cache_read_input_tokens || 0;
    const c = providers.costOf(model, u);
    if (c === null) t.costUnknown = true; else t.cost += c;
    t.requests = (t.requests || 0) + 1;
    this.emit('usage', { usage: t });
  }

  // ---------- tools ----------
  async runTools(uses, ctx, opts, run) {
    const results = new Array(uses.length);
    const exec = async (u, i) => { results[i] = await this.runOne(u, ctx, opts, run); };
    const DEDUP_READS = new Set(['read_file', 'list_dir', 'glob', 'grep', 'fetch_url']);
    const seenReads = new Map();
    const taskLimit = providers.providerOf(opts.model) === 'ollama' ? 1 : 3;
    let activeTasks = 0;
    const taskWaiters = [];
    const onAbort = () => { while (taskWaiters.length) taskWaiters.shift()?.(); };
    ctx.signal.addEventListener('abort', onAbort, { once: true });
    const runTaskQueued = async (fn, u, i) => {
      while (activeTasks >= taskLimit) {
        if (ctx.signal.aborted) {
          results[i] = { type: 'tool_result', tool_use_id: u.id, is_error: true, content: 'Stopped by user.' };
          return;
        }
        await new Promise((r) => taskWaiters.push(r));
      }
      if (ctx.signal.aborted) {
        results[i] = { type: 'tool_result', tool_use_id: u.id, is_error: true, content: 'Stopped by user.' };
        return;
      }
      activeTasks++;
      try { return await fn(); } finally {
        activeTasks--;
        taskWaiters.shift()?.();
      }
    };
    const execRead = (u, i) => {
      if (u.name === 'task') return runTaskQueued(() => exec(u, i), u, i);
      if (DEDUP_READS.has(u.name)) {
        const sig = u.name + ':' + JSON.stringify(u.input || {});
        if (seenReads.has(sig)) {
          return seenReads.get(sig).then((firstRes) => {
            const firstMeta = this.data.toolMeta[firstRes.tool_use_id];
            this.data.toolMeta[u.id] = {
              name: u.name, input: u.input,
              status: firstRes.is_error ? 'error' : 'done',
              summary: firstMeta?.summary || u.input?.path || '',
              output: firstMeta?.output || '',
            };
            this.emit('tool-start', { id: u.id, name: u.name, input: u.input, summary: this.data.toolMeta[u.id].summary });
            this.emit('tool-end', { id: u.id, ok: !firstRes.is_error, output: this.data.toolMeta[u.id].output });
            results[i] = { ...firstRes, tool_use_id: u.id };
          });
        }
        const p = exec(u, i).then(() => results[i]);
        seenReads.set(sig, p);
        return p;
      }
      return exec(u, i);
    };
    try {
      await Promise.all(uses.map((u, i) => (tools.READ_ONLY.has(u.name) ? execRead(u, i) : null)));
    } finally {
      ctx.signal.removeEventListener('abort', onAbort);
    }
    for (let i = 0; i < uses.length; i++) {
      if (results[i]) continue;
      if (ctx.signal.aborted) { results[i] = { type: 'tool_result', tool_use_id: uses[i].id, is_error: true, content: 'Stopped by user.' }; continue; }
      await exec(uses[i], i);
    }
    return results;
  }

  async runOne(u, ctx, opts, run) {
    const meta = { name: u.name, input: u.input, status: 'running', output: '' };
    this.data.toolMeta[u.id] = meta;
    const fail = (msg, blocked) => {
      if (!blocked) run.guard.record(u.name, u.input, false);
      run.errStreak = (run.errStreak || 0) + 1;
      if (run.errStreak >= 3) { run.errStreak = 0; run.escalate?.('it hit repeated tool errors'); }
      meta.status = 'error'; meta.output = msg;
      this.emit('tool-end', { id: u.id, ok: false, output: msg });
      return { type: 'tool_result', tool_use_id: u.id, is_error: true, content: msg };
    };
    const isMcp = u.name.startsWith('mcp__');

    if (!isMcp) {
      const invalid = tools.validate(u.name, u.input);
      if (invalid) { this.emit('tool-start', { id: u.id, name: u.name, input: u.input || {}, summary: '' }); return fail(`Invalid input: ${invalid}. Re-issue the call with valid arguments.`); }
    }

    // Loop guard: identical repeats and repeated failures on the same target.
    const blocked = run.guard.check(u.name, u.input);
    if (blocked) {
      this.emit('tool-start', { id: u.id, name: u.name, input: u.input, summary: 'blocked by loop guard' });
      this.emit('notice', { message: blocked.split(':')[0] + ': blocked a repeated failing approach.' });
      run.escalate?.('it got stuck repeating a failing approach');
      return fail(blocked, true);
    }

    if (u.name === 'task') return u.input.mode === 'edit' ? this.runWorker(u, meta, opts, ctx, run) : this.runTask(u, meta, opts);
    if (u.name === 'web_search') return this.runWebSearch(u, meta, opts, ctx.signal);
    if (u.name === 'ask_user') return this.runAskUser(u, meta);
    if (u.name === 'wrap_up') return this.runWrapUp(u, meta);
    if (u.name === 'impact') {
      const target = String(u.input.target || '').trim();
      meta.summary = target; this.emit('tool-start', { id: u.id, name: 'impact', input: u.input, summary: target });
      let out;
      try { out = require('./codegraph').impactReport(this.data.projectDir, target); } catch (e) { out = `Could not map the project: ${e.message}`; }
      meta.status = 'done'; meta.output = out;
      this.emit('tool-end', { id: u.id, ok: true, output: out });
      return { type: 'tool_result', tool_use_id: u.id, content: out };
    }
    if (u.name === 'check_requirement') return this.runCheckRequirement(u, meta, ctx, run);
    if (isMcp) return this.runMcp(u, meta, ctx, run, fail);

    let prep;
    try { prep = await tools.prepare(ctx, u.name, u.input); } catch (e) { this.emit('tool-start', { id: u.id, name: u.name, input: u.input, summary: u.input?.path || '' }); return fail(e.message); }
    meta.summary = prep.summary;
    if (prep.preview) meta.diff = prep.preview;
    this.emit('tool-start', { id: u.id, name: u.name, input: u.input, summary: prep.summary, diff: prep.preview });

    if (prep.kind !== 'read') {
      const mode = this.data.mode;
      const isFetch = prep.kind === 'fetch';
      if (isPlanMode(mode) && !isFetch) return fail('Plan mode is on: changes and commands are not allowed. Present your plan instead.');
      const cmd = u.input.command || '';
      let risk = prep.kind === 'shell' && !this.procs.sandbox ? shell.assessCommand(cmd, this.data.projectDir) : prep.kind === 'shell' ? shell.assessCommand(cmd, null) : { dangerous: false };
      if (prep.kind === 'edit' && u.name !== 'remember' && tools.isSensitiveFile(prep.summary)) {
        risk = { dangerous: true, reason: 'Modifies a sensitive configuration, credential, or git hook file.' };
      }
      if (isReviewMode(mode) && !isFetch) {
        if (prep.kind === 'edit') return fail(`[review mode] Blocked ${u.name} — review mode is read-only.`);
        const allowedInspection = prep.kind === 'shell' && !risk.dangerous
          && (tools.isSafeCommand(cmd) || /^\s*(npm\s+(test|run\s+(check|lint|typecheck))|node\s+--test|npx\s+tsc\s+--noEmit|pytest|python3?\s+-m\s+pytest)\b[^;|&>`$]*$/i.test(cmd));
        if (!allowedInspection) return fail('[review mode] Blocked state-changing command — review mode is read-only.');
      }
      // User rules from Settings → Safety: deny always blocks; allow skips the prompt (never for dangerous commands).
      const rules = prep.kind === 'shell' ? this.commandRules() : null;
      const denyHit = rules && shell.matchRule(rules.deny, cmd, { anySegment: true });
      if (denyHit) return fail(`Blocked by your deny rule "${denyHit}" (Settings → Safety). Do not run it; find another way or ask the user.`, true);
      const allowHit = rules && !risk.dangerous && shell.matchRule(rules.allow, cmd);
      const dangerous = risk.dangerous;
      let ask;
      if (dangerous) ask = true;
      else if (mode === 'yolo') ask = false;
      else if (isFetch) ask = !this.alwaysAllow.has(prep.permKey);
      else if (isReviewMode(mode)) ask = false;
      else if (prep.kind === 'edit') ask = !isCodeAutoMode(mode) && !this.alwaysAllow.has('edit');
      else ask = !allowHit && !this.alwaysAllow.has('shell') && !((u.name === 'shell' || u.name === 'powershell') && tools.isSafeCommand(cmd));
      if (ask) {
        meta.status = 'waiting';
        const r = await this.askPermission(u, prep, dangerous, risk.reason);
        if (r.decision === 'deny') {
          meta.status = 'denied';
          const msg = `The user denied this ${prep.kind === 'edit' ? 'change' : 'command'}.${r.feedback ? ` Their instructions: ${r.feedback}` : ' Do not retry it; adjust your approach or ask.'}`;
          meta.output = msg;
          this.emit('tool-end', { id: u.id, ok: false, denied: true, output: msg });
          return { type: 'tool_result', tool_use_id: u.id, is_error: true, content: msg };
        }
        if (r.decision === 'always') this.alwaysAllow.add(prep.permKey || prep.kind);
        meta.status = 'running';
        this.emit('tool-running', { id: u.id });
      }
    }

    try {
      const res = await prep.run((chunk) => this.emit('tool-output', { id: u.id, chunk: shell.redact(chunk).text }));
      const red = shell.redact(typeof res === 'string' ? res : res.text);
      let text = red.count ? `${red.text}\n[DROPs secret shield: ${red.count} secret${red.count > 1 ? 's' : ''} masked]` : red.text;
      const isError = typeof res === 'object' && res.isError;
      if (prep.kind === 'edit' && !isError && u.name !== 'remember') {
        try { text += await this.runEditHook(prep.summary, ctx.signal); } catch (e) { text += `\n[after-edit hook] failed: ${e.message}`; }
      }
      run.guard.record(u.name, u.input, !isError);
      this.autoLesson(lessons.fromToolResult(u.name, u.input, text, !!this.procs.sandbox), u.name);
      if (isError) { run.errStreak = (run.errStreak || 0) + 1; if (run.errStreak >= 3) { run.errStreak = 0; run.escalate?.('it hit repeated tool errors'); } } else run.errStreak = 0;
      if (prep.kind === 'edit') {
        run.edited = true; run.verifiedAfterEdit = false; run.lastVerify = null; run.failNudged = false; run.editedFiles.add(u.input.path || brand.memoryFile(this.data.projectDir));
        if (guards.isUiFile(u.input.path || '')) run.uiDirty = true;
        const diagKey = u.input.path || brand.memoryFile(this.data.projectDir);
        if (/Diagnostics: (SYNTAX ERROR|TYPE ERRORS|INVALID JSON)/.test(text)) run.diagErrors.set(diagKey, text.slice(text.indexOf('Diagnostics:')));
        else run.diagErrors.delete(diagKey);
      }
      // Looking at the app in the browser after the last page change counts as the UI check.
      if (u.name === 'browser' && !isError && !/Could not open/.test(text)) run.uiDirty = false;
      // What the browser showed is evidence: the latest problem stays open until a later step (or a
      // fix and a fresh look) shows the page working.
      if (u.name === 'browser') {
        const issue = typeof res === 'object' ? res.uiIssue : null;
        if (issue) run.uiIssue = issue;
        // Only a click or Enter that worked clears it; re-opening a page proves nothing.
        else if (!isError && ['click', 'press'].includes(u.input.action)) run.uiIssue = null;
      }
      if (prep.kind === 'shell' && guards.isVerificationCommand(u.input.command, run.verify, [...run.editedFiles])) {
        run.verifiedAfterEdit = true;
        run.lastVerify = isError ? 'fail' : 'pass';
      }
      // Root-cause debugging: point at this project's own frames, and after a repeated failure of the
      // same check, switch the agent to an engineer's debugging procedure.
      if (prep.kind === 'shell' && isError) {
        const frames = guards.projectFrames(text, this.data.projectDir);
        if (frames.length) text += `\n[DROPs] Where it failed in this project's code: ${frames.join(', ')}`;
        const key = String(u.input.command || '').trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 200);
        run.failCounts = run.failCounts || new Map();
        run.failCounts.set(key, (run.failCounts.get(key) || 0) + 1);
        if (run.failCounts.get(key) >= 2 && !run.debugMode) { run.debugMode = true; run.debugTestFiles = new Set(); text += `\n${guards.DEBUG_PROTOCOL}`; this.emit('notice', { message: 'The same check failed twice: DROPs switched the agent to step-by-step root-cause debugging.' }); }
      }
      if (run.debugMode && prep.kind === 'edit' && /(^|[/\\])(tests?|__tests__|spec)[/\\]|\.(test|spec)\.[a-z]+$|_test\.(py|go)$|^test_.*\.py$/i.test(u.input.path || '')) run.debugTestFiles?.add(u.input.path);
      meta.status = isError ? 'error' : 'done';
      meta.output = text.length > 20000 ? text.slice(0, 20000) + '\n…' : text;
      const images = typeof res === 'object' && Array.isArray(res.images) ? res.images : null;
      // Screenshots (browser) and pictures (read_file) are shown in the tool's card in the app.
      this.emit('tool-end', { id: u.id, ok: !isError, output: meta.output, diff: prep.preview, ...(images ? { images: images.map((b) => ({ source: b.source })) } : {}) });
      return { type: 'tool_result', tool_use_id: u.id, content: text, ...(isError ? { is_error: true } : {}), ...(images ? { _images: images } : {}) };
    } catch (e) { return fail(e.message); }
  }

  // Web search: Google grounding when a Gemini key is set, otherwise a keyless DuckDuckGo search.
  // A query can carry project details off the machine, so it asks first like fetch_url.
  async webSearchRaw(query, model, signal) {
    const key = this.deps.getGeminiKey?.();
    if (key) {
      try { return await gemini.webSearch(key, providers.providerOf(model) === 'gemini' ? model : 'gemini-3.6-flash', query, signal); } catch (e) { if (signal?.aborted) throw e; }
    }
    return tools.keylessSearch(query, signal);
  }
  async runWebSearch(u, meta, opts, signal) {
    meta.summary = u.input.query;
    this.emit('tool-start', { id: u.id, name: 'web_search', input: u.input, summary: u.input.query });
    if (this.data.mode !== 'yolo' && !this.alwaysAllow.has('search')) {
      meta.status = 'waiting';
      const r = await this.askPermission(u, { kind: 'search', summary: u.input.query }, false);
      if (r.decision === 'deny') {
        meta.status = 'denied';
        const msg = `The user denied this web search.${r.feedback ? ` Their instructions: ${r.feedback}` : ''}`;
        this.emit('tool-end', { id: u.id, ok: false, denied: true, output: msg });
        return { type: 'tool_result', tool_use_id: u.id, is_error: true, content: msg };
      }
      if (r.decision === 'always') this.alwaysAllow.add('search');
      this.emit('tool-running', { id: u.id });
    }
    try {
      const r = await this.webSearchRaw(u.input.query, opts.model, signal);
      const src = r.sources.map((s, i) => `[${i + 1}] ${s.title} — ${s.url}`).join('\n');
      const text = `${r.text}\n\nSources:\n${src || '(none)'}`;
      meta.status = 'done'; meta.output = text; meta.sources = r.sources;
      this.emit('tool-end', { id: u.id, ok: true, output: text, sources: r.sources });
      return { type: 'tool_result', tool_use_id: u.id, content: text };
    } catch (e) {
      meta.status = 'error'; meta.output = e.message;
      this.emit('tool-end', { id: u.id, ok: false, output: e.message });
      return { type: 'tool_result', tool_use_id: u.id, is_error: true, content: `Web search failed: ${e.message}` };
    }
  }

  // ---------- the next-step box ----------
  runWrapUp(u, meta) {
    const box = {
      recap: String(u.input.recap || '').trim().slice(0, 600),
      ask: String(u.input.ask || '').trim().slice(0, 200),
      options: (Array.isArray(u.input.options) ? u.input.options : []).map((o) => String(o).trim().slice(0, 40)).filter(Boolean).slice(0, 3),
    };
    if (!box.ask) box.options = [];
    this.data.wrapUp = { ...box, at: Date.now() };
    meta.summary = box.recap.slice(0, 80); meta.status = 'done'; meta.output = 'Shown to the user.';
    this.emit('wrap-up', { id: u.id, ...box });
    return { type: 'tool_result', tool_use_id: u.id, content: 'Shown to the user. Now write your final message (do not repeat the recap word for word).' };
  }

  // ---------- questions to the user ----------
  async runAskUser(u, meta) {
    const question = String(u.input.question || '').trim();
    const options = (Array.isArray(u.input.options) ? u.input.options : []).map(String).filter(Boolean).slice(0, 6);
    meta.summary = question; meta.status = 'waiting';
    this.emit('tool-start', { id: u.id, name: 'ask_user', input: u.input, summary: question });
    const r = await new Promise((resolve) => {
      const reqId = `${u.id}:ask`;
      this.pending.set(reqId, resolve);
      this.emit('question', { reqId, toolId: u.id, question, options });
    });
    const answer = r.decision === 'answer' ? String(r.feedback || '').trim() : '';
    const content = answer ? `The user answered: ${answer}` : 'The user did not answer. Make a reasonable assumption, state it clearly in your report, and continue.';
    meta.status = 'done'; meta.output = answer ? `Answer: ${answer}` : 'No answer';
    this.emit('tool-end', { id: u.id, ok: true, output: meta.output });
    return { type: 'tool_result', tool_use_id: u.id, content };
  }

  // ---------- independent QA: checks written from the spec alone, before any code is seen ----------
  async writeQaChecks(specText, model) {
    if (!specText) return;
    const reqs = this.data.requirements;
    const system = 'You are an independent QA engineer. You have NOT seen the code and you do not trust the developer. From the specification alone, write one acceptance check per functional requirement, the way a careful user would test it. Use ONLY the routes, data-testid attributes, field labels and demo accounts the specification names, copied exactly (the list after the specification has them); never invent an email, password, route or test id. If a check needs an account and the specification names none, sign up a new account with a unique email in that check first. The app runs at the base URL given after the specification. Prefer kind "browser": steps for a real browser ({"action":"open","url":...}, {"action":"fill","target":"testid=..." or a label,"value":...}, {"action":"click","target":...}, {"action":"select",...}, {"action":"press","key":"Enter"}), ending on a page that must show the "expect" text, which only a working feature shows. Use kind "http" ({"url","method","body","expect"}) only for pure API requirements. Log in first in each check that needs an account. Reply with JSON only: [{"id":"FR-1","kind":"browser","steps":[...],"expect":"..."}, ...].';
    const facts = specFacts(specText);
    const prompt = `Specification:\n${String(specText).slice(0, 24000)}\n\n${factsText(facts)}\n\nRequirements to cover: ${reqs.map((r) => r.id).join(', ')}`;
    const res = await providers.callModel({ model, system, messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }], tools: [], effort: 'low', signal: this.abort?.signal || new AbortController().signal, emit: () => {}, deps: this.deps, state: {} });
    const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    const start = text.indexOf('['), end = text.lastIndexOf(']');
    if (start < 0 || end < start) throw new Error('no JSON list in the reply');
    let list;
    try { list = JSON.parse(text.slice(start, end + 1)); } catch { throw new Error('the reply was not valid JSON'); }
    let n = 0;
    this.data.qaBase = facts.base;
    for (const c of Array.isArray(list) ? list : []) {
      const r = reqs.find((x) => x.id === c?.id);
      if (!r || !['browser', 'http'].includes(c.kind) || !String(c.expect || '').trim()) continue;
      if (c.kind === 'browser' && !(Array.isArray(c.steps) && c.steps.length && c.steps.every((st) => st && typeof st.action === 'string'))) continue;
      if (c.kind === 'http' && !/^http:\/\/localhost:\d+\//.test(String(c.url || ''))) continue;
      r.qa = c.kind === 'browser' ? { kind: 'browser', steps: c.steps.slice(0, 25), expect: String(c.expect).slice(0, 200) } : { kind: 'http', url: c.url, method: c.method || 'GET', body: c.body, expect: String(c.expect).slice(0, 200) };
      n++;
    }
    this.emit('notice', { message: `QA agent wrote independent checks for ${n} of ${reqs.length} requirements.` });
    await this.writeAdversarialChecks(specText, model, facts).catch((e) => this.emit('notice', { message: `Adversarial QA could not write checks: ${String(e.message || e).slice(0, 120)}` }));
    this.save();
  }

  /** A second QA engineer tries to break each rule the spec states: wrong password, logged-out visitor,
   *  another user's data, a lower role, empty or invalid input, duplicates. Up to two attacks per requirement. */
  async writeAdversarialChecks(specText, model, facts) {
    const reqs = this.data.requirements;
    const system = 'You are an adversarial QA engineer. You have NOT seen the code. Your job is to find where the app accepts what it must refuse. For each functional requirement whose rule can be misused, write at most two attack checks, only for rules the specification states or clearly implies: a wrong password, a logged-out visitor opening a protected page, a user opening another user\'s data, a lower role opening an admin page, empty or invalid input, a duplicate. Each attack must end on a page that proves the app refused correctly: "expect" = text that must appear (e.g. the error message the spec names), and/or "expect_url" = the path the final page must be on (e.g. "/login"), and/or "forbid" = text that must NOT appear (e.g. another user\'s record). Use ONLY accounts, routes, test ids and texts from the list after the specification. Browser steps: {"action":"open","url":...}, {"action":"fill","target":...,"value":...}, {"action":"click","target":...}, {"action":"press","key":"Enter"}. For HTTP attacks use kind "http" with "expect_status" (401, 403, 404 or 400). Reply with JSON only: [{"id":"FR-1","kind":"browser","steps":[...],"expect_url":"/login","why":"logged-out visitors are sent to log in"}, ...].';
    const prompt = `Specification:\n${String(specText).slice(0, 24000)}\n\n${factsText(facts)}\n\nRequirements: ${reqs.map((r) => `${r.id}: ${r.text}`).join('; ')}`;
    const res = await providers.callModel({ model, system, messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }], tools: [], effort: 'low', signal: this.abort?.signal || new AbortController().signal, emit: () => {}, deps: this.deps, state: {} });
    const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    const start = text.indexOf('['), end = text.lastIndexOf(']');
    if (start < 0 || end < start) throw new Error('no JSON list in the reply');
    let list; try { list = JSON.parse(text.slice(start, end + 1)); } catch { throw new Error('the reply was not valid JSON'); }
    let n = 0;
    for (const c of Array.isArray(list) ? list : []) {
      const r = reqs.find((x) => x.id === c?.id);
      if (!r || !['browser', 'http'].includes(c.kind)) continue;
      if (!String(c.expect || '').trim() && !String(c.expect_url || '').trim() && !String(c.forbid || '').trim() && !c.expect_status) continue;
      if (c.kind === 'browser' && !(Array.isArray(c.steps) && c.steps.length && c.steps.every((st) => st && typeof st.action === 'string'))) continue;
      if (c.kind === 'http' && !/^http:\/\/localhost:\d+\//.test(String(c.url || ''))) continue;
      r.qaNeg = r.qaNeg || [];
      if (r.qaNeg.length >= 2) continue;
      r.qaNeg.push(c.kind === 'browser'
        ? { kind: 'browser', steps: c.steps.slice(0, 20), expect: String(c.expect || '').slice(0, 200), expect_url: String(c.expect_url || '').slice(0, 100), forbid: String(c.forbid || '').slice(0, 200), why: String(c.why || '').slice(0, 160) }
        : { kind: 'http', url: c.url, method: c.method || 'GET', body: c.body, expect: String(c.expect || '').slice(0, 200), expect_status: Number(c.expect_status) || 0, forbid: String(c.forbid || '').slice(0, 200), why: String(c.why || '').slice(0, 160) });
      n++;
    }
    this.emit('notice', { message: `Adversarial QA wrote ${n} attack check${n === 1 ? '' : 's'} (wrong input, other users' data, logged-out access).` });
  }

  async reviseQaCheck(req, dispute, model) {
    const specText = specRequirements(this.data.projectDir, 'SPEC.md').doc || '';
    const facts = specFacts(specText);
    const system = 'You are the independent QA engineer who wrote this acceptance check. The developer disputes it. You have NOT seen the code and you do not trust the developer: change the check only if it contradicts the specification (an account, route, test id, label or text the specification does not name, or a wrong order of steps). Never weaken it to accept behaviour the specification does not describe. Reply with JSON only: {"decision":"keep"|"revise","reason":"...","check":{...same shape as before...}}.';
    const prompt = `Specification:\n${String(specText).slice(0, 20000)}\n\n${factsText(facts)}\n\nRequirement ${req.id}: ${req.text}\nYour check: ${JSON.stringify(req.qa)}\nLast result: ${req.evidence?.summary || 'not run'}\nDeveloper's dispute: ${dispute}`;
    const res = await providers.callModel({ model, system, messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }], tools: [], effort: 'low', signal: this.abort?.signal || new AbortController().signal, emit: () => {}, deps: this.deps, state: {} });
    const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    const a = text.indexOf('{'), b = text.lastIndexOf('}');
    let out; try { out = JSON.parse(text.slice(a, b + 1)); } catch { throw new Error('the QA reply was not valid JSON'); }
    req.qaRevised = true;
    const c = out.check || {};
    const valid = out.decision === 'revise' && ['browser', 'http'].includes(c.kind) && String(c.expect || '').trim()
      && (c.kind === 'http' ? /^http:\/\/localhost:\d+\//.test(String(c.url || '')) : Array.isArray(c.steps) && c.steps.length && c.steps.every((st) => st && typeof st.action === 'string'));
    if (valid) req.qa = c.kind === 'browser' ? { kind: 'browser', steps: c.steps.slice(0, 25), expect: String(c.expect).slice(0, 200) } : { kind: 'http', url: c.url, method: c.method || 'GET', body: c.body, expect: String(c.expect).slice(0, 200) };
    this.emit('notice', { message: `QA agent ${valid ? 'revised' : 'kept'} its check for ${req.id}: ${String(out.reason || '').slice(0, 160)}` });
    this.save();
    return valid ? `revised (${String(out.reason || '').slice(0, 200)})` : `kept the check (${String(out.reason || 'it matches the specification').slice(0, 200)})`;
  }

  // ---------- evidence: run a requirement check and record the real result ----------
  async runCheckRequirement(u, meta, ctx, run) {
    const finish = (text, ok) => {
      meta.status = ok ? 'done' : 'error'; meta.output = text;
      this.emit('tool-end', { id: u.id, ok, output: text });
      return { type: 'tool_result', tool_use_id: u.id, content: text, ...(ok ? {} : { is_error: true }) };
    };
    const reqs = this.data.requirements || [];
    const req = reqs.find((r) => r.id === String(u.input.id || '').trim());
    if (!req) return finish(`Unknown requirement "${u.input.id}". Requirements: ${reqs.map((r) => r.id).join(', ') || 'none'}.`, false);
    if (isPlanMode(this.data.mode) || isReviewMode(this.data.mode)) return finish('Checks run commands and a browser, which this read-only mode does not allow.', false);
    // The independent QA check (with its adversarial checks), when one exists, is the only check that can verify the requirement.
    const useQa = !!req.qa && (u.input.use_qa === true || !u.input.kind);
    const dispute = useQa ? String(u.input.dispute || '').trim() : '';
    const { dispute: _d, ...asked } = u.input;
    if (dispute) {
      if (req.qaRevised) return finish(`The QA check for ${req.id} was already revised once. Make the app match the specification so this check passes.`, false);
      const changed = await this.reviseQaCheck(req, dispute.slice(0, 600), run.model).catch((e) => `could not revise: ${String(e.message || e).slice(0, 120)}`);
      return finish(`QA agent reviewed the dispute on ${req.id}: ${changed}. Run check_requirement with use_qa: true again.`, true);
    }
    const checks = useQa
      ? [{ ...req.qa, label: 'main' }, ...(req.qaNeg || []).map((c, i) => ({ ...c, negative: true, label: `attack ${i + 1}: ${c.why || 'misuse'}` }))]
      : [{ ...asked, label: 'own' }];
    if (!checks[0].kind) return finish(`Say how to check ${req.id}: kind command, browser or http${req.qa ? ', or use_qa: true to run its QA check' : ''}.`, false);
    const bad = checks.find((c) => !['command', 'browser', 'http'].includes(c.kind));
    if (bad) return finish('kind must be command, browser or http.', false);

    // A stopped app is not a failed requirement: say so and keep the status.
    const firstUrl = checks.map((c) => (c.kind === 'http' ? c.url : (Array.isArray(c.steps) ? c.steps.find((st) => st && st.url) : null)?.url)).find(Boolean);
    if (firstUrl) {
      const down = await appDown(firstUrl, this.procs.sandbox);
      if (down) {
        run.appDownChecks = (run.appDownChecks || 0) + 1;
        return finish(`Not checked: the app is not running at ${down}. Start it with start_process (and wait until it says it is ready), then run this check again. ${req.id} keeps its status.`, false);
      }
    }

    const results = [];
    for (const c of checks) {
      const r = await this.runOneCheck(c, req.id, ctx, run);
      if (r.refused) return finish(r.refused, false);
      results.push({ ...r, label: c.label, negative: !!c.negative });
      if (!r.passed && !c.negative) break; // the main check failed: attacks add nothing yet
    }
    const passed = results.every((r) => r.passed) && results.length === checks.length;
    const first = results[0];
    // With a QA check, the agent's own check is recorded but cannot verify the requirement.
    req.status = passed && (useQa || !req.qa) ? 'verified' : passed ? 'unverified' : 'failed';
    req.lastCheck = asked; // re-run as is when the code changes later (freshness)
    req.evidence = {
      kind: checks[0].kind, byQa: useQa, check: first.check.slice(0, 200), expect: String(checks[0].expect || '').slice(0, 120), passed,
      summary: (results.find((r) => !r.passed) || first).detail.split('\n')[0].slice(0, 200), at: Date.now(),
      attacks: results.filter((r) => r.negative).map((r) => ({ label: r.label.slice(0, 120), passed: r.passed })),
      // The code this proof belongs to: a later change makes it stale and DROPs re-checks it.
      fingerprint: sourceFingerprint(this.data.projectDir), files: run.editedFiles ? [...run.editedFiles].slice(0, 30) : [],
    };
    this.emit('requirements', { requirements: reqs });
    this.save();
    const lines = results.map((r) => `- ${r.label}: ${r.passed ? 'passed' : 'FAILED'} (${r.check}) ${r.detail.split('\n')[0]}`);
    const failedAttack = results.find((r) => r.negative && !r.passed);
    const note = passed && req.qa && !useQa ? ` Your own check passed, but ${req.id} has an independent QA check: run check_requirement with use_qa: true to verify it.`
      : failedAttack ? ` The app accepted misuse it must refuse (${failedAttack.label}). Fix the app so it refuses it, then run the check again.` : '';
    const body = results.length > 1 ? `\n${lines.join('\n')}` : `: ${first.detail}`;
    // The same requirement failing again: debug it, do not guess.
    let debug = '';
    if (!passed && run) {
      run.reqFails = run.reqFails || new Map();
      run.reqFails.set(req.id, (run.reqFails.get(req.id) || 0) + 1);
      if (run.reqFails.get(req.id) >= 2 && !run.debugMode) { run.debugMode = true; run.debugTestFiles = new Set(); debug = `\n${guards.DEBUG_PROTOCOL}`; this.emit('notice', { message: `${req.id} failed twice: DROPs switched the agent to step-by-step root-cause debugging.` }); }
    }
    return finish(`${req.id} ${req.status === 'verified' ? 'VERIFIED' : 'NOT verified'} (${useQa ? 'QA ' : ''}${checks[0].kind}${(req.qaNeg || []).length && useQa ? ` + ${req.qaNeg.length} adversarial` : ''})${body}${note}${debug}`, passed);
  }

  /** Runs one check definition. Browser checks use a fresh browser (no leftover login). */
  async runOneCheck(c, reqId, ctx, run) {
    const expect = String(c.expect || '').trim(), expectUrl = String(c.expect_url || '').trim(), forbid = String(c.forbid || '').trim();
    let passed = false, detail = '', check = '';
    try {
      if (c.kind === 'command') {
        const cmd = String(c.command || '').trim();
        check = cmd;
        if (!cmd) return { refused: 'kind=command needs a command.' };
        // A command that exercises nothing (echo, true, exit 0) proves nothing.
        if (/^(echo|printf|true|exit\s+0|:|Write-(Host|Output))\b/i.test(cmd) || (!expect && !guards.isVerificationCommand(cmd, run.verify, [...(run.editedFiles || [])]))) {
          return { refused: 'That command does not exercise the requirement. Use a test (npm test -- <name>, a script that calls the code) or add `expect` text that only the working feature prints.' };
        }
        if ((this.procs.sandbox ? shell.assessCommand(cmd, null) : shell.assessCommand(cmd, this.data.projectDir)).dangerous) return { refused: 'Refused: that command is flagged as dangerous.' };
        const r = await shell.run(cmd, { cwd: this.data.projectDir, sandbox: this.procs.sandbox, signal: ctx.signal, timeoutMs: 180000 });
        const out = shell.redact(shell.stripAnsi(r.output || '')).text;
        const found = !expect || out.includes(expect);
        passed = r.code === 0 && found;
        detail = `exit ${r.code}${expect ? `, expected text ${found ? 'found' : 'NOT found'}` : ''}\n${out.trim().slice(-1500)}`;
        if (run.verify && guards.isVerificationCommand(cmd, run.verify, [...(run.editedFiles || [])])) { run.verifiedAfterEdit = true; run.lastVerify = r.code === 0 ? 'pass' : 'fail'; }
      } else if (c.kind === 'browser') {
        const steps = Array.isArray(c.steps) ? c.steps.slice(0, 25) : [];
        check = `${steps.length} browser step(s)`;
        if (!steps.length || (!expect && !expectUrl)) return { refused: 'kind=browser needs steps and `expect` text (or `expect_url`) that the final page must show.' };
        const browser = require('./browser');
        const sb = this.procs.sandbox;
        const key = `${this.data.projectDir}::check::${reqId}::${Date.now()}`;
        let last = null, issue = null;
        try {
          for (const st of steps) {
            last = await browser.act(key, st, { mapUrl: (x) => (sb ? sb.mapUrl(x) : x), signal: ctx.signal });
            // A refusal (401, an error message) is the expected result of an attack, not a broken app.
            if (last.issue && !c.negative) { issue = last.issue; break; }
          }
        } finally { await browser.act(key, { action: 'close' }).catch(() => {}); }
        const text = last?.text || '';
        const url = /URL: (\S+)/.exec(text)?.[1] || '';
        const okText = !expect || text.includes(expect);
        let okUrl = true;
        if (expectUrl) { try { okUrl = new URL(url).pathname.startsWith(expectUrl); } catch { okUrl = false; } }
        const okForbid = !forbid || !text.includes(forbid);
        passed = !issue && okText && okUrl && okForbid;
        detail = issue ? `the browser showed a problem: ${issue}`
          : `${steps.length} step(s) ran;${expect ? ` expected text ${okText ? 'found' : 'NOT found'};` : ''}${expectUrl ? ` page ${okUrl ? 'is' : 'is NOT'} on ${expectUrl} (${url || 'no URL'});` : ''}${forbid ? ` forbidden text ${okForbid ? 'absent' : 'SHOWN'};` : ''}\n${text.slice(0, 1200)}`;
      } else if (c.kind === 'http') {
        const sb = this.procs.sandbox;
        const url = sb ? sb.mapUrl(String(c.url || '')) : String(c.url || '');
        check = `${(c.method || 'GET').toUpperCase()} ${c.url}`;
        const wantStatus = Number(c.expect_status) || 0;
        if (!/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//i.test(url) || (!expect && !wantStatus)) return { refused: 'kind=http needs a local URL of the running app (http://localhost:<port>/…) and `expect` text (or `expect_status`).' };
        const res = await fetch(url, { method: (c.method || 'GET').toUpperCase(), headers: c.body ? { 'content-type': 'application/json' } : {}, body: c.body ? (typeof c.body === 'string' ? c.body : JSON.stringify(c.body)) : undefined, redirect: 'manual', signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(30000)]) });
        const body = await res.text();
        const okText = !expect || body.includes(expect);
        const okStatus = wantStatus ? res.status === wantStatus : (res.ok || (c.negative && res.status >= 300));
        const okForbid = !forbid || !body.includes(forbid);
        passed = okText && okStatus && okForbid;
        detail = `HTTP ${res.status}${wantStatus ? ` (expected ${wantStatus})` : ''}${expect ? `, expected text ${okText ? 'found' : 'NOT found'}` : ''}${forbid ? `, forbidden text ${okForbid ? 'absent' : 'SHOWN'}` : ''}\n${body.slice(0, 1200)}`;
      }
    } catch (e) {
      passed = false; detail = `the check could not run: ${String(e.message || e).split('\n')[0]}`;
    }
    return { passed, detail, check };
  }

  /**
   * Freshness: a requirement verified on older code is not verified now. When the project's files
   * changed since a proof, DROPs re-runs that check itself (no model call) before the agent may finish.
   */
  async reverifyStale(ctx, run) {
    const reqs = this.data.requirements || [];
    const fp = sourceFingerprint(this.data.projectDir);
    const stale = reqs.filter((r) => r.status === 'verified' && r.evidence?.fingerprint && r.evidence.fingerprint !== fp && r.lastCheck);
    if (!stale.length) return 0;
    this.emit('notice', { message: `The code changed after ${stale.length} requirement${stale.length > 1 ? 's were' : ' was'} verified; DROPs is checking ${stale.length > 1 ? 'them' : 'it'} again.` });
    let broken = 0;
    for (const r of stale) {
      r.status = 'stale';
      const res = await this.runCheckRequirement({ id: `refresh-${r.id}-${Date.now()}`, input: { ...r.lastCheck, id: r.id } }, {}, ctx, run).catch(() => null);
      if (r.status !== 'verified') broken++;
      if (res && r.status === 'stale') r.evidence = { ...(r.evidence || {}), summary: String(res.content || '').split('\n')[0].slice(0, 200) };
    }
    this.emit('requirements', { requirements: reqs });
    this.save();
    if (broken) this.emit('notice', { message: `Re-check after the change: ${broken} of ${stale.length} no longer verified.` });
    return broken;
  }

  // ---------- user command rules (Settings → Safety) ----------
  commandRules() {
    const s = this.settings();
    return { allow: shell.parseRules(s.allowCommands), deny: shell.parseRules(s.denyCommands) };
  }

  // ---------- after-edit hook (Settings → Agent) ----------
  async runEditHook(relPath, signal) {
    const tpl = String(this.settings().afterEditCommand || '').trim();
    if (!tpl || !relPath) return '';
    const cmd = tpl.replace(/\{file\}/g, `"${String(relPath).replace(/"/g, '')}"`);
    const r = await shell.run(cmd, { cwd: this.data.projectDir, sandbox: this.procs.sandbox, signal, timeoutMs: 60000 });
    const out = shell.redact(shell.stripAnsi(r.output || '')).text.trim().slice(-1500);
    return `\n[after-edit hook] \`${cmd}\` exited ${r.killed ? `(${r.killed})` : r.code}${out ? `:\n${out}` : ''}\n(The hook may have changed the file: read it again before the next edit.)`;
  }

  // ---------- edit sub-agents ----------
  // A worker runs its own model loop but executes every tool through runOne, so permissions,
  // command rules, checkpoints (rewind), diagnostics, hooks and the loop guard all apply.
  // Its edits count as the lead's edits, so the lead still has to verify before finishing.
  async runWorker(u, meta, opts, leadCtx, leadRun) {
    const { description, prompt } = u.input;
    meta.summary = description; meta.steps = [];
    this.emit('tool-start', { id: u.id, name: 'task', input: u.input, summary: description });
    const signal = leadCtx.signal;
    const step = (line) => { meta.steps.push(line); this.emit('sub-step', { id: u.id, line }); };
    step('mode: edit');
    const NO_WORKER = new Set(['task', 'ask_user', 'todo_write']);
    const defs = this.toolDefs(opts.model).filter((d) => !NO_WORKER.has(d.name));
    const system = `${this.systemPrompt(opts.model, prompt)}\n\n# You are an edit sub-agent\nA lead agent gave you the brief below as one part of a larger change; other sub-agents may be editing other files at the same time. Do exactly this part: change only the files it needs, never revert or reformat other code, and do not start unrelated work. Read files before editing them; if an edit fails because the file changed, read it again. Verify your part with the narrowest real check (a focused test, type-check or running the file). You cannot ask the user questions: if you are blocked, stop and say why. Finish with a short report: files changed (path:line), how you verified, anything left undone.`;
    const messages = [{ role: 'user', content: [{ type: 'text', text: prompt }] }];
    const run = {
      edited: false, verifiedAfterEdit: true, lastVerify: null, nudges: 0, steps: 0,
      editedFiles: leadRun.editedFiles, diagErrors: leadRun.diagErrors, guard: new guards.LoopGuard(3), verify: leadRun.verify, escalate: null,
    };
    const ctx = { ...leadCtx, onTodos: () => {} };
    const subState = { compat: this.state.compat };
    try {
      for (let i = 0; i < 40; i++) {
        if (signal.aborted) throw new Error('aborted');
        const m = await providers.callModel({ model: opts.model, system, messages, tools: defs, effort: opts.effort, signal, emit: () => {}, deps: this.deps, state: subState });
        this.accountSubUsage(m.usage, m.model || opts.model);
        const msg = { role: 'assistant', content: m.content.length ? m.content : [{ type: 'text', text: '(no response)' }] };
        if (m.raw) { msg._gemini = m.raw; msg._geminiModel = m.model; }
        messages.push(msg);
        const calls = m.content.filter((b) => b.type === 'tool_use');
        if (!calls.length || m.stop_reason === 'refusal') {
          const report = m.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim() || '(sub-agent returned no report)';
          const changed = [...run.editedFiles].length && run.edited ? `\n\n[edit sub-agent changed files; verify the combined result before you finish]` : '';
          if (run.edited) { leadRun.edited = true; leadRun.verifiedAfterEdit = false; leadRun.lastVerify = null; }
          meta.status = 'done'; meta.output = report;
          this.emit('tool-end', { id: u.id, ok: true, output: report });
          return { type: 'tool_result', tool_use_id: u.id, content: report + changed };
        }
        // Tool calls run one by one (edits must not race); ids are namespaced so the UI and
        // checkpoints never mix them up with the lead's calls.
        const results = [], images = [];
        for (const c of calls) {
          if (signal.aborted) { results.push({ type: 'tool_result', tool_use_id: c.id, is_error: true, content: 'Stopped by user.' }); continue; }
          if (NO_WORKER.has(c.name)) { results.push({ type: 'tool_result', tool_use_id: c.id, is_error: true, content: `${c.name} is not available to an edit sub-agent.` }); continue; }
          step(`${c.name} ${c.input?.path || c.input?.command || c.input?.pattern || c.input?.query || ''}`.trim().slice(0, 140));
          const r = await this.runOne({ ...c, id: `${u.id}~${c.id}` }, ctx, opts, run);
          if (r?._images) { images.push(...r._images); delete r._images; }
          results.push({ ...r, tool_use_id: c.id });
        }
        if (run.edited) { leadRun.edited = true; leadRun.verifiedAfterEdit = false; }
        messages.push({ role: 'user', content: [...results, ...images] });
      }
      throw new Error('Edit sub-agent hit its 40-step limit without a report.');
    } catch (e) {
      if (run.edited) { leadRun.edited = true; leadRun.verifiedAfterEdit = false; }
      const msg = signal.aborted ? 'Stopped by user.' : `Edit sub-agent failed: ${providers.friendlyError(e, opts.model).message}${run.edited ? ' (it had already changed files: check them)' : ''}`;
      meta.status = 'error'; meta.output = msg;
      this.emit('tool-end', { id: u.id, ok: false, output: msg });
      return { type: 'tool_result', tool_use_id: u.id, is_error: true, content: msg };
    }
  }

  // ---------- sub-agents ----------
  async runTask(u, meta, opts) {
    const { description, prompt } = u.input;
    meta.summary = description;
    meta.steps = [];
    this.emit('tool-start', { id: u.id, name: 'task', input: u.input, summary: description });
    const signal = this.abort?.signal || new AbortController().signal;
    const step = (line) => { meta.steps.push(line); this.emit('sub-step', { id: u.id, line }); };
    // Research is cheap work: run sub-agents on the cheapest model of the same provider (setting).
    const subModel = this.settings().cheapSubagents !== false ? providers.cheapModelFor(opts.model, this.settings()) : opts.model;
    if (subModel !== opts.model) step(`model: ${subModel}`);
    const defs = tools.definitions(tools.EXPLORE_TOOLS);
    defs.push(WEB_SEARCH_DEF);
    const ctx = { root: this.data.projectDir, signal, readFiles: new Map(), procs: this.procs, onTodos: () => {}, snapshot: async () => {}, onChange: () => {} };
    const system = `You are a focused research sub-agent working for a lead coding agent in the project at ${this.data.projectDir}. Use your read-only tools efficiently — batch independent calls in parallel — to answer the brief. Then reply with a concise, information-dense report: findings with exact file paths and line numbers, relevant code snippets (short), and direct answers to the questions asked. No preamble.\n\n# Repository map\n${ctxEngine.repoMap(this.data.projectDir, providers.providerOf(subModel) === 'ollama' ? 3000 : 8000, prompt)}`;
    const messages = [{ role: 'user', content: [{ type: 'text', text: prompt }] }];
    const subState = { compat: this.state.compat };
    const subEffort = opts.effort === 'max' || opts.effort === 'xhigh' ? 'high' : opts.effort;
    try {
      for (let i = 0; i < 25; i++) {
        if (signal.aborted) throw new Error('aborted');
        const m = await providers.callModel({ model: subModel, system, messages, tools: defs, effort: subEffort, signal, emit: () => {}, deps: this.deps, state: subState });
        this.accountSubUsage(m.usage, m.model || subModel);
        const msg = { role: 'assistant', content: m.content.length ? m.content : [{ type: 'text', text: '(no response)' }] };
        if (m.raw) { msg._gemini = m.raw; msg._geminiModel = m.model; }
        messages.push(msg);
        const calls = m.content.filter((b) => b.type === 'tool_use');
        if (!calls.length || m.stop_reason === 'refusal') {
          const report = m.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim() || '(sub-agent returned no report)';
          meta.status = 'done'; meta.output = report;
          this.emit('tool-end', { id: u.id, ok: true, output: report });
          return { type: 'tool_result', tool_use_id: u.id, content: report };
        }
        const subImages = [];
        const results = await Promise.all(calls.map(async (c) => {
          const bad = tools.validate(c.name, c.input);
          if (bad) return { type: 'tool_result', tool_use_id: c.id, is_error: true, content: `Invalid input: ${bad}` };
          try {
            let rawOut;
            if (c.name === 'web_search') {
              step(`web_search ${c.input.query}`);
              if (this.data.mode !== 'yolo' && !this.alwaysAllow.has('search')) return { type: 'tool_result', tool_use_id: c.id, is_error: true, content: "web_search needs the user's approval. Report the query to the lead agent so it can search." };
              const r = await this.webSearchRaw(c.input.query, subModel, signal);
              rawOut = `${r.text}\n\nSources:\n${r.sources.map((s) => s.url).join('\n')}`;
            } else {
              const p = await tools.prepare(ctx, c.name, c.input);
              // Sub-agents cannot ask the user: they may only fetch hosts the user already allowed.
              if (p.kind === 'fetch' && this.data.mode !== 'yolo' && !this.alwaysAllow.has(p.permKey)) {
                step(`${c.name} ${p.summary} (needs approval)`);
                return { type: 'tool_result', tool_use_id: c.id, is_error: true, content: `fetch_url needs the user's approval for ${p.permKey.slice(6)}. Report the URL to the lead agent so it can fetch it.` };
              }
              if (p.kind !== 'read' && p.kind !== 'fetch') return { type: 'tool_result', tool_use_id: c.id, is_error: true, content: `${c.name} is not allowed in a research sub-agent.` };
              step(`${c.name} ${p.summary}`);
              const out = await p.run(() => {});
              rawOut = typeof out === 'string' ? out : out.text;
              if (out?.images) subImages.push(...out.images);
            }
            const red = shell.redact(rawOut);
            return { type: 'tool_result', tool_use_id: c.id, content: red.count ? `${red.text}\n[DROPs secret shield: ${red.count} secret(s) masked]` : red.text };
          } catch (e) { return { type: 'tool_result', tool_use_id: c.id, is_error: true, content: e.message }; }
        }));
        messages.push({ role: 'user', content: [...results, ...subImages.splice(0)] });
      }
      throw new Error('Sub-agent hit its 25-step limit without a report.');
    } catch (e) {
      const msg = signal.aborted ? 'Stopped by user.' : `Sub-agent failed: ${providers.friendlyError(e, opts.model).message}`;
      meta.status = 'error'; meta.output = msg;
      this.emit('tool-end', { id: u.id, ok: false, output: msg });
      return { type: 'tool_result', tool_use_id: u.id, is_error: true, content: msg };
    }
  }

  // ---------- permissions ----------
  askPermission(u, prep, dangerous, reason) {
    return new Promise((resolve) => {
      const reqId = `${u.id}:perm`;
      this.pending.set(reqId, resolve);
      this.emit('permission', { reqId, toolId: u.id, name: u.name, kind: prep.kind, input: u.input, summary: prep.summary, diff: prep.preview, dangerous, reason });
    });
  }

  // ---------- MCP tools ----------
  async runMcp(u, meta, ctx, run, fail) {
    const hit = this.deps.mcp?.find(u.name);
    const label = hit ? `${hit.server.name} · ${hit.tool.name}` : u.name;
    meta.summary = label;
    this.emit('tool-start', { id: u.id, name: u.name, input: u.input, summary: label, mcp: true });
    if (!hit) return fail(`MCP tool ${u.name} is not available — its server is not connected.`);
    const trusted = !!hit.server.config.trust;
    const mode = this.data.mode;
    if (isPlanMode(mode) && !trusted) return fail('Plan mode is on: MCP tools from untrusted servers are not allowed. Present your plan instead.');
    const permKey = 'mcp:' + hit.server.name;
    if (mode !== 'yolo' && !trusted && !this.alwaysAllow.has(permKey)) {
      meta.status = 'waiting';
      const r = await this.askPermission(u, { kind: 'mcp', summary: label }, false);
      if (r.decision === 'deny') {
        meta.status = 'denied';
        const msg = `The user denied this MCP call.${r.feedback ? ` Their instructions: ${r.feedback}` : ''}`;
        this.emit('tool-end', { id: u.id, ok: false, denied: true, output: msg });
        return { type: 'tool_result', tool_use_id: u.id, is_error: true, content: msg };
      }
      if (r.decision === 'always') this.alwaysAllow.add(permKey);
      this.emit('tool-running', { id: u.id });
    }
    try {
      const res = await this.deps.mcp.call(u.name, u.input, ctx.signal);
      const red = shell.redact(res.text);
      const text = red.text.length > 60000 ? red.text.slice(0, 60000) + '\n…(truncated)' : red.text;
      run.guard.record(u.name, u.input, !res.isError);
      meta.status = res.isError ? 'error' : 'done';
      meta.output = text.slice(0, 20000);
      this.emit('tool-end', { id: u.id, ok: !res.isError, output: meta.output });
      return { type: 'tool_result', tool_use_id: u.id, content: text, ...(res.isError ? { is_error: true } : {}) };
    } catch (e) { return fail(`MCP call failed: ${e.message}`); }
  }
  respond(reqId, decision, feedback) {
    const r = this.pending.get(reqId);
    if (!r) return;
    this.pending.delete(reqId);
    r({ decision, feedback });
  }
  // Steering not yet delivered is handed back to the user by finish(), never silently dropped.
  stop() { this.abort?.abort(); }

  // ---------- compaction ----------
  async compact(opts, signal = new AbortController().signal, reason = 'manual') {
    const msgs = this.data.messages;
    const lastTurn = this.data.turns[this.data.turns.length - 1];
    const cut = reason === 'manual' ? msgs.length : (lastTurn?.msgIndex ?? msgs.length);
    if (cut <= 2) return false;
    const head = msgs.slice(0, cut);
    const tail = msgs.slice(cut);
    this.emit('compact-start', { reason, messages: head.length });
    const stateLines = [];
    if (this.data.todos?.length) {
      stateLines.push('Active task plan:\n' + this.data.todos.map((t) => `- [${t.status}] ${t.content}`).join('\n'));
    }
    const changed = Object.keys(this.data.changes || {});
    if (changed.length) stateLines.push('Files modified in this session: ' + changed.join(', '));
    const stateNote = stateLines.length ? `\n\n<session_state>\n${stateLines.join('\n')}\n</session_state>` : '';
    const summary = await providers.complete({
      model: opts.model, system: ctxEngine.SUMMARY_SYSTEM, deps: this.deps, signal,
      prompt: `Compress this coding session transcript into the handoff document.${stateNote}\n\n<transcript>\n${ctxEngine.transcriptText(head)}\n</transcript>`,
    });
    if (!summary) throw new Error('Compaction produced an empty summary.');
    this.data.archive.push(...head.filter((m) => !m._summary && !m._summaryAck));
    this.data.messages = [
      { role: 'user', content: [{ type: 'text', text: `${SUMMARY_PREFIX}\n\n${summary}` }], _summary: true },
      { role: 'assistant', content: [{ type: 'text', text: 'Understood. I have the context from the summary and will continue from there.' }], _summaryAck: true },
      ...tail,
    ];
    for (const t of this.data.turns) t.msgIndex = t.msgIndex == null || t.msgIndex < cut ? null : t.msgIndex - cut + 2;
    this.data.compactions.push({ at: Date.now(), summary, archived: head.length, reason });
    this.data.usage.context = Math.round(summary.length / 4);
    this.save(true);
    this.emit('compacted', { summary, reason, archived: head.length, usage: this.data.usage });
    return true;
  }

  async compactNow(opts) {
    if (this.busy) throw new Error('Stop the agent before compacting.');
    this.busy = true;
    this.emit('status', { busy: true });
    try { return await this.compact(opts, new AbortController().signal, 'manual'); }
    finally { this.busy = false; this.emit('status', { busy: false }); this.emit('done', { quiet: true }); }
  }

  // ---------- rewind ----------
  async rewind(turnIndex) {
    if (this.busy) throw new Error('Stop the agent before rewinding.');
    const turns = this.data.turns;
    const t = turns[turnIndex];
    if (!t) throw new Error('Unknown turn');
    if (t.msgIndex == null) throw new Error('This message is from before the context was compacted and can no longer be rewound.');
    const restored = new Set();
    for (let i = turns.length - 1; i >= turnIndex; i--) {
      for (const [abs, orig] of Object.entries(turns[i].files)) {
        try {
          if (orig === null) await fsp.rm(abs, { force: true });
          else await fsp.writeFile(abs, orig, 'utf8');
          restored.add(abs);
        } catch { /* best effort */ }
      }
    }
    this.data.messages.length = t.msgIndex;
    turns.length = turnIndex;
    this.rebuildChanges();
    this.readFiles.clear();
    this.save(true);
    return { text: t.text, restored: restored.size };
  }

  rebuildChanges() {
    this.data.changes = {};
    for (const m of [...this.data.archive, ...this.data.messages]) {
      if (m.role !== 'assistant' || !Array.isArray(m.content)) continue;
      for (const b of m.content) {
        const meta = b.type === 'tool_use' && this.data.toolMeta[b.id];
        if (meta?.diff && meta.status === 'done') {
          const c = this.data.changes[meta.diff.path] || { added: 0, removed: 0, edits: 0 };
          c.added += meta.diff.added; c.removed += meta.diff.removed; c.edits++;
          this.data.changes[meta.diff.path] = c;
        }
      }
    }
  }

  // Original content of a file before this session first touched it (null = created by the agent).
  baseline(rel) {
    const abs = path.resolve(this.data.projectDir, rel);
    for (const t of this.data.turns) if (abs in t.files) return { found: true, content: t.files[abs] };
    return { found: false, content: null };
  }
  async revertFile(rel) {
    const abs = tools.resolveInRoot(this.data.projectDir, rel);
    const b = this.baseline(rel);
    if (!b.found) throw new Error('No checkpoint for this file.');
    if (b.content === null) await fsp.rm(abs, { force: true });
    else await fsp.writeFile(abs, b.content, 'utf8');
    delete this.data.changes[rel.replace(/\\/g, '/')];
    this.readFiles.delete(abs);
    this.save(true);
    this.emit('changes', { changes: this.data.changes });
    return true;
  }

  dispose() { this.stop(); this.procs.stopAll(); }
}

module.exports = { sourceFingerprint, specFacts, evidenceNudgeAllowed, admitsUnfinished, specPlanNote, AgentSession, INTERRUPTED, NO_REPLY, STOPPED_BY_ERROR, SUMMARY_PREFIX };
