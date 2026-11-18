// Shell execution for every platform, an optional Docker sandbox, and command/secret security.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

const IS_WIN = process.platform === 'win32';
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '');

// ---------- host shell ----------
let hostShell = null;
function detectHostShell() {
  if (hostShell) return hostShell;
  if (IS_WIN) {
    const pwsh = (process.env.ProgramFiles || 'C:\\Program Files') + '\\PowerShell\\7\\pwsh.exe';
    hostShell = { kind: 'powershell', file: fs.existsSync(pwsh) ? pwsh : 'powershell.exe', label: fs.existsSync(pwsh) ? 'PowerShell 7' : 'Windows PowerShell 5.1' };
  } else {
    const sh = process.env.SHELL && /bash|zsh/.test(process.env.SHELL) ? process.env.SHELL : (fs.existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh');
    hostShell = { kind: 'bash', file: sh, label: path.basename(sh) };
  }
  return hostShell;
}
function hostArgs(cmd) {
  const s = detectHostShell();
  if (s.kind === 'powershell') {
    const prelude = "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $ProgressPreference='SilentlyContinue'; ";
    return [s.file, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', prelude + cmd]];
  }
  return [s.file, ['-lc', cmd]];
}

// ---------- Docker sandbox ----------
const SANDBOX_PORTS = [3000, 3001, 4173, 4321, 5000, 5173, 8000, 8080];
function sandboxLimitArgs() {
  const env = require('./brand').env;
  return ['--memory', env('SANDBOX_MEMORY') || '4g', '--cpus', env('SANDBOX_CPUS') || '2', '--pids-limit', env('SANDBOX_PIDS') || '1024'];
}
// One long-lived container per project; the project folder is mounted at /workspace.
function docker(args, timeout = 120000) {
  return new Promise((resolve) => {
    execFile('docker', args, { windowsHide: true, timeout, maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => resolve({ ok: !err, out: (stdout || '') + (stderr || ''), err }));
  });
}
class Sandbox {
  constructor(root, { image = 'node:22-bookworm', network = true } = {}) {
    this.root = root; this.image = image; this.network = network;
    this.name = 'drops-' + crypto.createHash('sha1').update(root.toLowerCase()).digest('hex').slice(0, 12);
    this.ready = null;
  }
  ensure() {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      const v = await docker(['version', '--format', '{{.Server.Version}}'], 15000);
      if (!v.ok) throw new Error('Docker sandbox is enabled but Docker is not running. Start Docker Desktop, or turn the sandbox off in Settings.');
      const st = await docker(['inspect', '-f', '{{.State.Running}}', this.name], 15000);
      const seedGolden = () => docker(['exec', this.name, 'bash', '-c',
        'if [ -d /golden/node_modules ] && [ ! -d /workspace/node_modules/.bin ]; then cp -a /golden/node_modules/. /workspace/node_modules/; fi'], 60000);
      // A container from before ports were published cannot get them later: recreate it (the project
      // folder is a mount, so nothing in it is lost).
      // Containers from before ports and resource limits existed cannot get them later: recreate them.
      const labels = (await docker(['inspect', '-f', '{{index .Config.Labels "drops.ports"}}/{{index .Config.Labels "drops.limits"}}', this.name], 15000)).out.trim();
      const hasPorts = (!this.network || labels.startsWith('1/')) && labels.endsWith('/1');
      if (st.ok && !hasPorts) { await docker(['rm', '-f', this.name], 60000); }
      else if (st.ok && st.out.trim() === 'true') { await seedGolden(); await this.readPorts(); return true; }
      else if (st.ok) { const s = await docker(['start', this.name]); if (s.ok) { await seedGolden(); await this.readPorts(); return true; } await docker(['rm', '-f', this.name]); }
      const args = ['run', '-d', '--name', this.name, '-v', `${this.root}:/workspace`, '-w', '/workspace', '--label', 'drops.sandbox=1',
        // Resource limits so runaway code cannot freeze the machine (DROPS_SANDBOX_MEMORY / _CPUS / _PIDS).
        '--label', 'drops.limits=1', ...sandboxLimitArgs()];
      if (fs.existsSync(path.join(this.root, 'package.json')) && !fs.existsSync(path.join(this.root, 'node_modules'))) args.push('-v', '/workspace/node_modules', '-v', '/workspace/.next');
      if (!this.network) args.push('--network', 'none');
      // Common dev-server ports, published on random free ports of this machine (localhost only), so
      // the agent's browser can open an app that runs inside the sandbox.
      else { args.push('--label', 'drops.ports=1'); for (const p of SANDBOX_PORTS) args.push('-p', `127.0.0.1::${p}`); }
      args.push(this.image, 'sleep', 'infinity');
      const r = await docker(args, 600000);
      if (!r.ok) { this.ready = null; throw new Error(`Could not start the sandbox container (${this.image}): ${r.out.trim().slice(0, 400)}`); }
      await seedGolden();
      await this.readPorts();
      return true;
    })();
    this.ready.catch(() => { this.ready = null; });
    return this.ready;
  }
  /** Reads which machine port each published sandbox port landed on. */
  async readPorts() {
    this.ports = {};
    if (!this.network) return;
    const r = await docker(['port', this.name], 15000);
    for (const m of r.out.matchAll(/^(\d+)\/tcp -> (?:127\.0\.0\.1|0\.0\.0\.0|\[::\]):(\d+)/gm)) this.ports[m[1]] = Number(m[2]);
  }
  /** Rewrites localhost:<sandbox port> to the port published on this machine (other URLs unchanged). */
  mapUrl(url) {
    try {
      const u = new URL(url);
      const port = u.port || (u.protocol === 'https:' ? '443' : '80');
      if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])$/i.test(u.hostname) && this.ports?.[port]) { u.hostname = '127.0.0.1'; u.port = String(this.ports[port]); return u.toString(); }
    } catch { /* not a URL */ }
    return url;
  }
  args(cmd) { return ['docker', ['exec', '-i', '-w', '/workspace', this.name, 'bash', '-lc', cmd]]; }
  async destroy() { await docker(['rm', '-f', this.name], 30000); this.ready = null; }
}

// ---------- spawning ----------
async function spawnShell(cmd, { cwd, sandbox, env = {} }) {
  let file, args;
  if (sandbox) { await sandbox.ensure(); [file, args] = sandbox.args(cmd); } else [file, args] = hostArgs(cmd);
  return spawn(file, args, {
    cwd, windowsHide: true, detached: !IS_WIN,
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', GIT_PAGER: 'cat', PAGER: 'cat', ...env },
  });
}
function killTree(child) {
  if (!child?.pid) return;
  try {
    if (IS_WIN) spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
    else process.kill(-child.pid, 'SIGKILL');
  } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
}

// Runs a command to completion with timeout/abort, streaming output.
async function run(cmd, { cwd, sandbox, signal, timeoutMs = 120000, onChunk, env }) {
  let child;
  try { child = await spawnShell(cmd, { cwd, sandbox, env }); } catch (e) { return { code: -1, output: e.message, killed: null }; }
  return new Promise((resolve) => {
    let output = '', killed = null;
    const add = (d) => { const s = d.toString('utf8'); output += s; if (output.length > 2_000_000) output = output.slice(-1_000_000); onChunk?.(stripAnsi(s)); };
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    child.stdin.end();
    const timer = setTimeout(() => { killed = 'timeout'; killTree(child); }, timeoutMs);
    const onAbort = () => { killed = 'aborted'; killTree(child); };
    signal?.addEventListener('abort', onAbort, { once: true });
    const done = (code) => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); resolve({ code, output, killed }); };
    child.on('close', (code) => done(code ?? -1));
    child.on('error', (e) => { output += String(e); done(-1); });
  });
}

// ---------- security ----------
// Always ask, in every permission mode.
const DANGEROUS = [
  // destructive file operations
  /\brm\s+(-\w*r\w*f|-\w*f\w*r|-r\b|--recursive)/i, /\b(Remove-Item|ri|rmdir|rd)\b[^\n]*-r(e(c(u(r(s(e)?)?)?)?)?)?\b/i, /\b(del|erase)\s+[^\n]*\/[sq]\b/i, /\b(rd|rmdir)\s+\/s\b/i,
  /\bRemove-Item\b[^\n]*\s[A-Za-z]:\\?\s*($|[;|])/i, /\bformat(\.com)?\s+[a-z]:/i, /\bdiskpart\b/i, /\bcipher\s+\/w/i, /\bmkfs(\.\w+)?\b/i, /\bdd\s+if=/i, /\bshred\b/i,
  // system state
  /\b(Stop-Computer|Restart-Computer|shutdown|reboot|halt)\b/i, /\bSet-ExecutionPolicy\b/i, /\breg(\.exe)?\s+(delete|add|import)\b/i, /\b(Set|New|Remove)-ItemProperty\b[^\n]*HK(LM|CU)/i,
  /\bbcdedit\b/i, /\bvssadmin\b[^\n]*delete/i, /\bwmic\b[^\n]*delete/i, /\bnetsh\b[^\n]*(set|add|delete)/i, /\b(sc|sc\.exe)\s+(delete|config)\b/i, /\bschtasks\b[^\n]*\/create/i,
  /\b(chmod|chown)\s+-R\s+[^\n]*\s\/(\s|$)/i, /\bsudo\b/i, /\b(Add-MpPreference|Set-MpPreference)\b/i, /\bDisable-WindowsOptionalFeature\b/i,
  // remote code execution / exfiltration
  /\b(Invoke-Expression|iex)\b/i, /\b(curl|wget|iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^\n]*\|\s*(sh|bash|iex|pwsh|powershell|python)\b/i,
  /\b(curl|wget|iwr|irm|Invoke-WebRequest|Invoke-RestMethod|nc|ncat)\b[^\n]*(\$env:|\$\{?[A-Z_]*(KEY|TOKEN|SECRET|PASSWORD)|\.env\b|id_rsa|\.ssh|credentials)/i,
  // irreversible project / infra operations
  /\bgit\s+push\b[^\n]*(--force|-f\b|--mirror|--delete|:\S)/i, /\bgit\s+reset\s+--hard\b/i, /\bgit\s+clean\s+-\w*f/i, /\bgit\s+branch\s+-D\b/i, /\bgit\s+(filter-branch|filter-repo)\b/i, /\bgit\s+checkout\s+--\s+\./i,
  /\b(npm|pnpm|yarn)\s+publish\b/i, /\bcargo\s+publish\b/i, /\btwine\s+upload\b/i, /\bdotnet\s+nuget\s+push\b/i,
  /\bdocker\s+(system|volume|image)\s+prune\b/i, /\bdocker\s+rm\s+-f\b/i, /\bkubectl\s+delete\b/i, /\bterraform\s+(destroy|apply)\b/i, /\bhelm\s+(uninstall|delete)\b/i,
  /\b(drop|truncate)\s+(table|database|schema)\b/i, /\bdelete\s+from\s+\w+\s*(;|$)/i,
  /\b(powershell|pwsh)(\.exe)?\b[^\n]*\s-(e|enc|encodedcommand)\s+[A-Za-z0-9+/=]{16,}/i,
  /\bStart-Process\b[^\n]*-Verb\s+RunAs/i,
  /\.git[\\/]hooks[\\/]/i,
  // Inline code that deletes files or trees (node -e, python -c, perl/ruby -e) has no shell verb to see.
  /\b(node|deno|bun)(\.exe)?\b[^\n]*\s(-e|-p|--eval|--print)\b[^\n]*\b(rmSync|rmdirSync|unlinkSync|rm|rmdir|unlink)\s*\(/i,
  /\bpy(thon[\d.]*)?(\.exe)?\b[^\n]*\s-c\b[^\n]*(shutil\.rmtree|os\.(remove|unlink|rmdir|removedirs)\b|\.unlink\(|\.rmdir\(|send2trash)/i,
  /\b(perl|ruby)\b[^\n]*\s-e\b[^\n]*\b(unlink|rmtree|rm_rf|rm_r)\b/i,
];
const WRITE_VERB = /(\bRemove-Item\b|\brm\b|\bdel\b|\berase\b|\brd\b|\brmdir\b|\bMove-Item\b|\bmv\b|\bmove\b|\bCopy-Item\b|\bcp\b|\bcopy\b|\bSet-Content\b|\bAdd-Content\b|\bOut-File\b|\bNew-Item\b|\bRename-Item\b|\b(?:curl|wget)\b[^\n]*\s(?:-o|-O|--output)\b|\b(?:iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^\n]*\s-OutFile\b|>)/i;

// A write-type command that names an absolute path outside the project (and outside temp).
function writesOutsideRoot(cmd, root) {
  if (!WRITE_VERB.test(cmd)) return false;
  if (/(?:^|[\s"'=(>])(?:\.[\\/])?\.\.[\\/]|(?:^|[\s"'=(>])(?:~[\\/]|\$HOME[\\/]|%USERPROFILE%[\\/])/i.test(cmd)) return true;
  const norm = (p) => p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
  const rootN = norm(root);
  const tmp = [process.env.TEMP, process.env.TMP, '/tmp'].filter(Boolean).map(norm);
  const paths = [...cmd.matchAll(/(?:^|[\s"'=(])((?:[A-Za-z]:[\\/]|\\\\|\/(?!\/))[^\s"';|&<>()]*)/g)].map((m) => m[1]);
  return paths.some((p) => {
    if (/^\/(dev\/null|workspace)/.test(p)) return false;
    const n = norm(p);
    return !n.startsWith(rootN) && !tmp.some((t) => n.startsWith(t));
  });
}

function assessCommand(cmd, root) {
  for (const r of DANGEROUS) if (r.test(cmd)) return { dangerous: true, reason: 'Potentially destructive or irreversible command.' };
  if (root && writesOutsideRoot(cmd, root)) return { dangerous: true, reason: 'This command writes or deletes files outside the project folder.' };
  return { dangerous: false };
}

// Read-only commands that may run without asking in "ask" mode.
const SAFE = /^\s*(git\s+(status|diff|log|show|branch|remote -v|rev-parse)|Get-ChildItem|Get-Content|Get-Location|Select-String|ls|dir|pwd|cat|type|head|tail|wc|where(\.exe)?|which|Test-Path|node\s+(-v|--version)|npm\s+(-v|--version|ls|list)|python3?\s+--version|dotnet\s+--(info|version)|go\s+version|cargo\s+--version)\b[^;|&>`$]*$/i;
// `git diff/log --output=<file>` writes a file; `git branch -d/-D/-m/...` changes branches.
const SAFE_EXCEPT = /--output\b|\bgit\s+branch\b[^\n]*\s(-[dDmMcCfu]\b|--(delete|move|copy|force|set-upstream-to|unset-upstream)\b)/;
const isSafeCommand = (cmd) => SAFE.test(cmd) && !cmd.includes('\n') && !SAFE_EXCEPT.test(cmd);

// ---------- user command rules ----------
// One pattern per line (or comma-separated in a list); `*` matches anything. Lines starting with # are ignored.
function parseRules(text) {
  if (Array.isArray(text)) text = text.join('\n');
  return String(text || '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
}
const ruleRe = (p) => new RegExp('^' + p.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i');
const CHAIN = /[;&|`\n]|\$\(/;
// Returns the first matching pattern, or null.
// allow rules only match a single plain command, so "npm test*" never approves "npm test; curl …".
// deny rules (anySegment) also match any part of a chained command.
function matchRule(patterns, cmd, { anySegment = false } = {}) {
  const c = String(cmd || '').trim().replace(/\s+/g, ' ');
  if (!c || !patterns?.length) return null;
  const parts = anySegment ? [c, ...c.split(/\s*(?:&&|\|\||[;|&\n])\s*/).map((x) => x.trim()).filter(Boolean)] : [c];
  for (const p of patterns) {
    if (!anySegment && CHAIN.test(c) && !CHAIN.test(p)) continue;
    const re = ruleRe(p.replace(/\s+/g, ' '));
    if (parts.some((x) => re.test(x))) return p;
  }
  return null;
}

// ---------- secret shield ----------
// Secrets found in tool output are masked before they reach the model or the UI.
const SECRET_PATTERNS = [
  [/sk-ant-[A-Za-z0-9_-]{20,}/g, 'anthropic-key'], [/sk-(proj-)?[A-Za-z0-9_-]{32,}/g, 'openai-key'], [/AIza[0-9A-Za-z_-]{35}/g, 'google-key'],
  [/\bAQ\.[A-Za-z0-9_-]{30,}/g, 'google-key'], [/\bgh[pousr]_[A-Za-z0-9]{30,}/g, 'github-token'], [/\bgithub_pat_[A-Za-z0-9_]{40,}/g, 'github-token'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, 'slack-token'], [/\bAKIA[0-9A-Z]{16}\b/g, 'aws-key'], [/\bsk_live_[0-9a-zA-Z]{20,}/g, 'stripe-key'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, 'private-key'],
  [/\b(eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/g, 'jwt'],
  [/\bhf_[A-Za-z0-9]{30,}/g, 'huggingface-token'], [/\bgsk_[A-Za-z0-9]{40,}/g, 'groq-key'], [/\bnpm_[A-Za-z0-9]{36}\b/g, 'npm-token'],
  [/\bglpat-[A-Za-z0-9_-]{20,}/g, 'gitlab-token'], [/\b[rs]k_(live|test)_[0-9a-zA-Z]{20,}/g, 'stripe-key'], [/\bSG\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g, 'sendgrid-key'],
];
// Secrets that are only recognisable by their context: the value is masked and the name kept.
const SECRET_CONTEXT = [
  // user:password@ in a connection URL (postgres://, mysql://, mongodb+srv://, redis://, amqp://, https://…)
  [/\b([a-z][a-z0-9+.-]{1,20}:\/\/[^\s:/@'"]+:)([^\s@/'"]{3,})(@)/gi, 'password'],
  // aws_secret_access_key = …
  [/\b(aws_secret_access_key\s*[=:]\s*["']?)([A-Za-z0-9/+=]{40})\b/gi, 'aws-secret'],
  // Authorization: Bearer <opaque-token> & Basic <base64>
  [/\b(Bearer\s+)([A-Za-z0-9._~+/=-]{16,})\b/gi, 'bearer-token'],
  [/\b(Basic\s+)([A-Za-z0-9+/=]{12,})/gi, 'basic-auth'],
  // KEY=value lines (.env files, `env` / `set` output, HTTP headers like x-api-key: ...) whose name says it is a secret.
  [/^(\s*(?:export\s+|\$env:)?[A-Za-z0-9_-]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API[-_]?KEY|PRIVATE[-_]?KEY|ACCESS[-_]?KEY)[A-Za-z0-9_-]*\s*[=:]\s*["']?)(?!(?:process|os|env|config|settings|self|this|import)\b|\$|None\b|null\b|undefined\b|true\b|false\b|[\d.]+["']?\s*(?:#.*)?$)([^\s"'#()[\]{},;]{6,})(?=["']?\s*(?:#.*)?$)/gim, 'secret'],
];
function redact(text) {
  if (!text || typeof text !== 'string') return { text, count: 0 };
  let count = 0;
  for (const [re, label] of SECRET_PATTERNS) text = text.replace(re, () => { count++; return `[REDACTED ${label}]`; });
  for (const [re, label] of SECRET_CONTEXT) {
    // With two groups the callback's 4th argument is the match offset, not a third group.
    text = text.replace(re, (m, pre, val, post) => { if (val.startsWith('[REDACTED')) return m; count++; return `${pre}[REDACTED ${label}]${typeof post === 'string' ? post : ''}`; });
  }
  return { text, count };
}

module.exports = { sandboxLimitArgs, IS_WIN, detectHostShell, spawnShell, run, killTree, Sandbox, docker, assessCommand, isSafeCommand, writesOutsideRoot, redact, stripAnsi, parseRules, matchRule };
