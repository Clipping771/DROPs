// Hooks: the user's own commands that run at fixed points of the agent's work.
//
// Where they come from:
//   - the project: .drops/hooks.json (or .h2o/hooks.json). It is code from the repository, so outside
//     full auto the user approves it once per session (and again whenever the file changes);
//   - the user: Settings → Hooks (the `hooks` setting), always trusted.
// Format (Claude Code's nested form is accepted too):
//   { "hooks": { "PreToolUse": [ { "matcher": "write_file|edit_file", "command": "node check.js", "timeout": 60 } ] } }
// Events:
//   SessionStart      first request of a session; stdout is added as context
//   UserPromptSubmit  each request; stdout is added as context; exit 2 blocks the request (stderr = reason)
//   PreToolUse        before a tool; exit 2 (or stdout {"decision":"block","reason":...}) blocks it
//   PostToolUse       after a tool; stdout is added to the result; exit 2 sends stderr back to the agent
//   Stop              when the agent wants to finish; exit 2 sends stderr back and the agent goes on
// Each command gets the event as JSON on stdin, and DROPS_EVENT / DROPS_PROJECT_DIR in its environment.
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'];

/** Normalizes one config object into [{event, matcher, command, timeout, source}]. */
function parseHooks(cfg, source) {
  const out = [];
  const root = cfg && typeof cfg === 'object' ? (cfg.hooks && typeof cfg.hooks === 'object' ? cfg.hooks : cfg) : {};
  for (const event of EVENTS) {
    for (const h of Array.isArray(root[event]) ? root[event] : []) {
      if (!h || typeof h !== 'object') continue;
      const inner = Array.isArray(h.hooks) ? h.hooks : [h];
      for (const x of inner) {
        const command = typeof x.command === 'string' ? x.command.trim() : '';
        if (!command) continue;
        out.push({ event, matcher: typeof h.matcher === 'string' ? h.matcher : '', command, timeout: Math.min(600, Math.max(1, +x.timeout || +h.timeout || 60)), source });
      }
    }
  }
  return out;
}

function projectHookFile(projectDir) {
  if (!projectDir) return null;
  for (const d of require('./brand').PROJECT_DIRS) {
    const f = path.join(projectDir, d, 'hooks.json');
    if (fs.existsSync(f)) return f;
  }
  return null;
}

/** All hooks for a project: { hooks, projectHash, projectFile, error }. */
function loadHooks(projectDir, settings = {}) {
  let hooks = [], error = null, projectHash = null;
  let user = settings.hooks;
  if (typeof user === 'string' && user.trim()) { try { user = JSON.parse(user); } catch (e) { error = `Settings → Hooks is not valid JSON: ${e.message}`; user = null; } }
  hooks = hooks.concat(parseHooks(user, 'user'));
  const projectFile = projectHookFile(projectDir);
  if (projectFile) {
    try {
      const text = fs.readFileSync(projectFile, 'utf8');
      projectHash = crypto.createHash('sha1').update(text).digest('hex').slice(0, 16);
      hooks = hooks.concat(parseHooks(JSON.parse(text), 'project'));
    } catch (e) { error = `${path.relative(projectDir, projectFile)} is not valid JSON: ${e.message}`; }
  }
  return { hooks, projectHash, projectFile, error };
}

function matches(h, toolName) {
  if (!h.matcher || h.matcher === '*') return true;
  if (!toolName) return false;
  try { return new RegExp(`^(?:${h.matcher})$`).test(toolName); } catch { return h.matcher === toolName; }
}

/** Runs one command with the payload on stdin. Resolves {code, stdout, stderr, timedOut}. */
function runCommand(h, payload, { cwd, signal }) {
  return new Promise((resolve) => {
    let out = '', err = '', done = false;
    const env = { ...process.env, DROPS_EVENT: payload.event, DROPS_PROJECT_DIR: cwd || '' };
    for (const k of Object.keys(env)) if (/_API_KEY$/.test(k)) delete env[k]; // hooks never see the model keys
    let p;
    try { p = spawn(h.command, { cwd: cwd || process.cwd(), env, shell: true, windowsHide: true }); } catch (e) { resolve({ code: -1, stdout: '', stderr: e.message }); return; }
    const finish = (r) => { if (done) return; done = true; clearTimeout(t); signal?.removeEventListener?.('abort', onAbort); resolve(r); };
    const kill = () => { try { if (process.platform === 'win32') require('child_process').execSync(`taskkill /PID ${p.pid} /T /F`, { stdio: 'ignore' }); else p.kill('SIGKILL'); } catch { /* gone */ } };
    const t = setTimeout(() => { kill(); finish({ code: -1, stdout: out, stderr: err, timedOut: true }); }, h.timeout * 1000);
    const onAbort = () => { kill(); finish({ code: -1, stdout: out, stderr: 'stopped', timedOut: false }); };
    signal?.addEventListener?.('abort', onAbort, { once: true });
    p.stdout.on('data', (d) => { if (out.length < 20000) out += d; });
    p.stderr.on('data', (d) => { if (err.length < 20000) err += d; });
    p.on('error', (e) => finish({ code: -1, stdout: out, stderr: e.message }));
    p.on('close', (code) => finish({ code, stdout: out, stderr: err }));
    try { p.stdin.end(JSON.stringify(payload)); } catch { /* closed */ }
  });
}

/**
 * Runs every hook for an event (in order). Returns { blocked, reason, context, notes }.
 * `context` collects stdout for events that add context; `reason` is the first block's message.
 */
async function runHooks(list, event, payload, { cwd, signal, toolName } = {}) {
  const res = { blocked: false, reason: '', context: [], notes: [] };
  for (const h of list.filter((x) => x.event === event && matches(x, toolName))) {
    const r = await runCommand(h, { event, ...payload }, { cwd, signal });
    const stdout = String(r.stdout || '').trim(), stderr = String(r.stderr || '').trim();
    let json = null;
    if (stdout.startsWith('{')) { try { json = JSON.parse(stdout); } catch { /* plain text */ } }
    if (r.code === 2 || json?.decision === 'block') {
      res.blocked = true;
      res.reason = (json?.reason || stderr || stdout || `blocked by hook: ${h.command}`).slice(0, 4000);
      break;
    }
    if (r.timedOut) res.notes.push(`Hook "${h.command}" timed out after ${h.timeout}s.`);
    else if (r.code !== 0) res.notes.push(`Hook "${h.command}" exited ${r.code}${stderr ? `: ${stderr.slice(0, 300)}` : ''}`);
    const ctx = json ? (json.additionalContext || json.context || '') : stdout;
    if (ctx) res.context.push(String(ctx).slice(0, 8000));
  }
  return res;
}

module.exports = { EVENTS, parseHooks, loadHooks, runHooks, matches, projectHookFile };
