#!/usr/bin/env node
// DROPs headless CLI — run the agent from a terminal, a script or CI (GitHub Actions, etc.).
//   node src/cli.js [options] "task description"
// Keys come from the environment: ANTHROPIC_API_KEY, GEMINI_API_KEY (or GOOGLE_API_KEY); Ollama via OLLAMA_HOST.
const brand = require('./main/brand');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { AgentSession } = require('./main/agent');
const { McpManager } = require('./main/mcp');
const store = require('./main/store');

const HELP = `DROPs — autonomous coding agent (headless)

Usage: drops [options] "<task>"

Options:
  -p, --project <dir>     Project folder (default: current directory)
  -m, --model <id>        auto | claude-opus-5-5 | gemini-4-hydrogen | ollama:<name> … (default: auto)
  -e, --effort <level>    low | medium | high | xhigh | max (default: high)
      --mode <mode>       plan | architect | review | code | auto-edit | yolo | ask (default: yolo). Destructive commands are always refused
                          unless --allow-dangerous is given.
      --allow-dangerous   Allow commands DROPs classifies as destructive (use only in throwaway environments)
      --sandbox [image]   Run shell commands inside a Docker container (default image node:22-bookworm)
      --max-cost <usd>    Stop when this task has cost more than this
      --fallback <m1,m2>  Models to switch to, in order, when the model is out of quota or credit
                          (or DROPS_FALLBACK_MODELS), e.g. openrouter:google/gemma-4-31b-it:free,ollama:gemma4:12b
      --max-steps <n>     Stop after n agent steps (default 250)
      --timeout <sec>     Stop the run after <sec> seconds and clean up
      --mcp-config <file> JSON file with { "mcpServers": { ... } }
      --lang <code>       Language for explanations (e.g. bn for Bengali)
      --json              Print a JSON summary at the end (for scripts)
      --jsonl             Stream JSONL events to stdout as the agent runs
      --save <file>       Save the full session JSON
      --resume <file>     Resume a previously saved session JSON file
  -q, --quiet             Only print the final answer
  -h, --help              Show this help

Exit codes: 0 done · 1 error · 2 finished but the last verification failed · 3 stopped by a limit`;

function parseArgs(argv) {
  const o = { project: process.cwd(), model: 'auto', effort: 'high', mode: 'yolo', modeExplicit: false, maxSteps: 250, json: false, jsonl: false, quiet: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '-h' || a === '--help') o.help = true;
    else if (a === '-p' || a === '--project') o.project = path.resolve(next());
    else if (a === '-m' || a === '--model') o.model = next();
    else if (a === '-e' || a === '--effort') o.effort = next();
    else if (a === '--mode') { o.mode = next(); o.modeExplicit = true; }
    else if (a === '--allow-dangerous') o.allowDangerous = true;
    else if (a === '--sandbox') { o.sandbox = true; if (argv[i + 1] && /^[\w.-]+(\/[\w.-]+)*(:[\w.-]+)?$/.test(argv[i + 1]) && /[:/]/.test(argv[i + 1])) o.sandboxImage = next(); }
    else if (a === '--max-cost') o.maxCost = Number(next());
    else if (a === '--fallback') o.fallback = next();
    else if (a === '--max-steps') o.maxSteps = Number(next());
    else if (a === '--timeout') o.timeout = Number(next());
    else if (a === '--mcp-config') o.mcpConfig = path.resolve(next());
    else if (a === '--lang') o.lang = next();
    else if (a === '--json') o.json = true;
    else if (a === '--jsonl') o.jsonl = true;
    else if (a === '--save') o.save = path.resolve(next());
    else if (a === '--resume') o.resume = path.resolve(next());
    else if (a === '-q' || a === '--quiet') o.quiet = true;
    else rest.push(a);
  }
  o.task = rest.join(' ').trim();
  return o;
}

const tty = process.stdout.isTTY;
const c = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);

/** Loads a previously saved session JSON file for `--resume`, or creates a fresh session object. */
function initSessionData(o) {
  if (o.resume) {
    const raw = JSON.parse(fs.readFileSync(o.resume, 'utf8').replace(/^\uFEFF/, ''));
    if (!raw || !Array.isArray(raw.messages)) throw new Error(`Invalid session file: ${o.resume}`);
    return {
      ...raw,
      id: raw.id || crypto.randomUUID(),
      projectDir: raw.projectDir || o.project,
      updated: Date.now(),
      model: o.model || raw.model,
      effort: o.effort || raw.effort,
      mode: o.modeExplicit ? o.mode : (raw.mode || o.mode),
      archive: raw.archive || [],
      compactions: raw.compactions || [],
      turns: raw.turns || [],
      toolMeta: raw.toolMeta || {},
      todos: raw.todos || [],
      changes: raw.changes || {},
      usage: raw.usage || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, context: 0, requests: 0 },
    };
  }
  return {
    id: crypto.randomUUID(), title: 'New session', projectDir: o.project, created: Date.now(), updated: Date.now(),
    model: o.model, effort: o.effort, mode: o.mode, messages: [], archive: [], compactions: [], turns: [], toolMeta: {}, todos: [], changes: {},
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, context: 0, requests: 0 },
  };
}

// Runs one task to completion. Used by the CLI and by the benchmark runner.
async function runHeadless(o, { print = () => {}, onEvent = null, signal = null } = {}) {
  // Order: a key passed for this run (DROPS_*_API_KEY, or the older H2O_*_API_KEY) → the key saved in
  // DROPs Settings → the usual environment variable. The DROPS_ variables let scripts override a stale saved key or a stale
  // user-level GEMINI_API_KEY without touching either.
  const geminiKey = brand.env('GEMINI_API_KEY') || store.getGeminiKey() || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || null;
  const anthropicKey = brand.env('ANTHROPIC_API_KEY') || store.getApiKey() || process.env.ANTHROPIC_API_KEY || null;
  const settings = {
    hasAnthropic: !!anthropicKey, hasGemini: !!geminiKey, autoProvider: 'auto', cheapSubagents: true,
    autoVerify: true, compactAt: 180000, maxSteps: o.maxSteps || 250, maxCostPerTask: o.maxCost || 0, maxTokensPerTask: o.maxTokens || 0,
    ollamaEnabled: true,
    ollamaUrl: process.env.OLLAMA_HOST ? (/^https?:/.test(process.env.OLLAMA_HOST) ? process.env.OLLAMA_HOST : `http://${process.env.OLLAMA_HOST}`) : 'http://127.0.0.1:11434',
    ollamaCtx: Number(brand.env('OLLAMA_CTX')) || 16384, sandbox: !!o.sandbox, sandboxImage: o.sandboxImage || 'node:22-bookworm', sandboxNetwork: true,
    responseLanguage: o.lang || 'en', explainMode: false, customInstructions: '',
    // Models to try, in order, when the chosen one is out of quota or credit (e.g. free models elsewhere).
    fallbackModels: (o.fallback || brand.env('FALLBACK_MODELS') || '').split(',').map((m) => m.trim()).filter(Boolean),
    customBaseUrl: brand.env('CUSTOM_BASE_URL') || '', lmstudioUrl: process.env.LMSTUDIO_URL || 'http://127.0.0.1:1234/v1',
  };
  if (o.model === 'auto' && !anthropicKey && !geminiKey) {
    let localModels = [];
    try { localModels = await require('./main/ollama').listModels(settings.ollamaUrl); } catch { /* Ollama not running */ }
    if (localModels.length) {
      const preferred = localModels.find((m) => !m.cloud && m.tools !== false) || localModels[0];
      settings.ollamaDefaultModel = preferred.id;
    } else {
      throw new Error('No API key: set ANTHROPIC_API_KEY or GEMINI_API_KEY, start Ollama locally, or use --model ollama:<name>.');
    }
  }
  let mcp = null;
  if (o.mcpConfig) {
    mcp = new McpManager();
    const servers = JSON.parse(fs.readFileSync(o.mcpConfig, 'utf8').replace(/^\uFEFF/, '')).mcpServers || {};
    for (const st of await mcp.sync(servers)) print('notice', `MCP ${st.name}: ${st.status}${st.error ? ' — ' + st.error : ` (${st.tools.length} tools)`}`);
  }

  const data = initSessionData(o);
  const result = { errors: [], notices: [], tools: 0, toolErrors: 0, models: new Set(), stoppedByLimit: false };
  let agent;
  const deps = {
    getSettings: () => settings, getApiKey: () => anthropicKey, getGeminiKey: () => geminiKey, mcp,
    // In the headless CLI a key set in the environment wins over one saved in the app's Settings.
    getProviderKey: (id) => { const env = require('./main/oai').PROVIDERS[id]?.env; return (env && process.env[env]) || store.getProviderKey(id); },
    save: () => {},
    send: (_id, type, p) => {
      if (onEvent && ['text-delta', 'tool-start', 'tool-end', 'notice', 'auto-model', 'error'].includes(type)) {
        onEvent({ type, ...(p || {}), ts: Date.now() });
      }
      switch (type) {
        case 'text-delta': print('text', p.text); break;
        case 'tool-start': result.tools++; print('tool', `${p.name} ${p.summary || ''}`); break;
        case 'tool-end': if (!p.ok) { result.toolErrors++; print('toolerr', String(p.output || '').split('\n')[0].slice(0, 160)); } break;
        case 'notice': result.notices.push(p.message); print('notice', p.message); break;
        case 'auto-model': result.models.add(p.model); print('notice', `${p.escalated ? 'Escalated' : 'Auto'}: ${p.model} (${p.reason})`); break;
        case 'error': result.errors.push(p.message); if (/^(Budget limit|Token budget|Stopped after)/.test(p.message)) result.stoppedByLimit = true; print('error', p.message); break;
        case 'permission': {
          // Computer use needs a person watching: headless runs never get it.
          if (p.kind === 'computer') { print('notice', 'Computer use refused: nobody is here to approve it (headless).'); setImmediate(() => agent.respond(p.reqId, 'deny', 'Computer use needs a person to approve it; it is not available in headless runs.')); break; }
          const allow = !p.dangerous || o.allowDangerous;
          if (!allow) print('error', `Refused destructive command: ${p.input?.command} (${p.reason || 'dangerous'}). Use --allow-dangerous to permit.`);
          setImmediate(() => agent.respond(p.reqId, allow ? 'allow' : 'deny', allow ? '' : 'Destructive commands are not allowed in headless mode. Find a safer way.'));
          break;
        }
        case 'question': {
          // Nobody to ask in headless mode: the agent is told to assume and say so.
          result.notices.push(`Question skipped (headless): ${p.question}`);
          print('notice', `Question skipped (headless): ${p.question}`);
          setImmediate(() => agent.respond(p.reqId, 'skip', ''));
          break;
        }
        default: break;
      }
    },
  };
  agent = new AgentSession(data, deps);
  const t0 = Date.now();
  const timeoutMs = Number(o.timeoutMs) > 0 ? Number(o.timeoutMs) : (Number(o.timeout) > 0 ? Number(o.timeout) * 1000 : 0);
  let timedOut = false;
  const onAbort = () => agent.stop();
  signal?.addEventListener?.('abort', onAbort, { once: true });
  const timer = timeoutMs > 0 ? setTimeout(() => { timedOut = true; agent.stop(); }, timeoutMs) : null;
  try {
    if (!signal?.aborted) {
      // The guard state lives inside send(); read the outcome from the transcript afterwards.
      await agent.send(o.task, { model: o.model, effort: o.effort, mode: o.modeExplicit ? o.mode : 'yolo' });
    }
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener?.('abort', onAbort);
    agent.dispose();
    await mcp?.closeAll();
  }
  if (timedOut && !result.errors.some((e) => /timeout/i.test(e))) result.errors.push('timeout');
  const last = [...data.messages].reverse().find((m) => m.role === 'assistant');
  const answer = (last?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  const verifyFailed = data.messages.some((m) => m.role === 'user' && JSON.stringify(m.content).includes('verification command FAILED'))
    && !Object.values(data.toolMeta).slice(-3).some((t) => (t.name === 'shell' || t.name === 'powershell') && t.status === 'done');
  return {
    ok: !result.errors.length, answer, seconds: Math.round((Date.now() - t0) / 1000), usage: data.usage, tools: result.tools, toolErrors: result.toolErrors,
    changes: data.changes, errors: result.errors, notices: result.notices, models: [...result.models], verifyFailed, stoppedByLimit: result.stoppedByLimit, timedOut, session: data,
  };
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help || !o.task) { console.log(HELP); process.exit(o.help ? 0 : 1); }
  if (!fs.existsSync(o.project)) { console.error(`Project folder not found: ${o.project}`); process.exit(1); }
  const print = (kind, s) => {
    if (o.json || o.jsonl || (o.quiet && kind !== 'error')) return;
    if (kind === 'text') process.stdout.write(s);
    else if (kind === 'tool') process.stdout.write(`\n${c('36', '→')} ${c('2', s)}\n`);
    else if (kind === 'toolerr') process.stdout.write(`  ${c('31', '✗')} ${c('2', s)}\n`);
    else if (kind === 'notice') process.stdout.write(`${c('2', '· ' + s)}\n`);
    else if (kind === 'error') process.stderr.write(`${c('31', 'error:')} ${s}\n`);
  };
  const onEvent = o.jsonl ? (ev) => process.stdout.write(JSON.stringify(ev) + '\n') : null;
  try {
    const r = await runHeadless(o, { print, onEvent });
    if (o.save) fs.writeFileSync(o.save, JSON.stringify(r.session, null, 2));
    if (o.jsonl) {
      onEvent({ type: 'done', ok: r.ok, seconds: r.seconds, usage: r.usage, tools: r.tools, toolErrors: r.toolErrors, changes: Object.keys(r.changes || {}), verifyFailed: r.verifyFailed, stoppedByLimit: r.stoppedByLimit, ts: Date.now() });
    } else if (o.json) {
      const { session, ...rest } = r;
      console.log(JSON.stringify(rest, null, 2));
    } else if (o.quiet) console.log(r.answer);
    else {
      const u = r.usage;
      console.log(`\n\n${c('2', `— ${r.seconds}s · ${r.tools} tool calls · ${u.input + u.cacheRead} in / ${u.output} out tokens${u.cost ? ` · $${u.cost.toFixed(3)}` : ''} · ${Object.keys(r.changes).length} files changed`)}`);
    }
    process.exit(r.stoppedByLimit ? 3 : !r.ok ? 1 : r.verifyFailed ? 2 : 0);
  } catch (e) {
    console.error(c('31', 'error: ') + e.message);
    process.exit(1);
  }
}

if (require.main === module) main();
module.exports = { runHeadless, parseArgs, initSessionData };
