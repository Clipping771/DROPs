// True Language Server Protocol (LSP) client over JSON-RPC stdio.
// Connects to typescript-language-server, pyright-langserver, gopls, or rust-analyzer
// for compiler-exact definitions, references, hover types, and diagnostics.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { pathToFileURL, fileURLToPath } = require('url');

const SERVERS = {
  typescript: {
    exts: new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']),
    cmd: 'typescript-language-server',
    args: ['--stdio'],
    installHint: 'npm install -g typescript-language-server typescript',
    langId: (ext) => (ext === '.tsx' ? 'typescriptreact' : ext === '.jsx' ? 'javascriptreact' : ext.startsWith('.ts') ? 'typescript' : 'javascript'),
  },
  python: {
    exts: new Set(['.py']),
    cmd: 'pyright-langserver',
    args: ['--stdio'],
    installHint: 'npm install -g pyright (or pip install pyright)',
    langId: () => 'python',
  },
  go: {
    exts: new Set(['.go']),
    cmd: 'gopls',
    args: [],
    installHint: 'go install golang.org/x/tools/gopls@latest',
    langId: () => 'go',
  },
  rust: {
    exts: new Set(['.rs']),
    cmd: 'rust-analyzer',
    args: [],
    installHint: 'rustup component add rust-analyzer',
    langId: () => 'rust',
  },
};

function serverForFile(filePath) {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  for (const [id, spec] of Object.entries(SERVERS)) {
    if (spec.exts.has(ext)) return { id, ...spec, languageId: spec.langId(ext) };
  }
  return null;
}

class LspClient {
  constructor(root, spec, spawnOpts = {}) {
    this.root = path.resolve(root);
    this.spec = spec;
    this.spawnOpts = spawnOpts;
    this.proc = null;
    this.nextId = 1;
    this.pending = new Map();
    this.buf = Buffer.alloc(0);
    this.opened = new Map(); // uri -> version
    this.diags = new Map(); // uri -> Diagnostic[]
    this.initPromise = null;
  }

  /** Encodes and writes a JSON-RPC 2.0 frame with Content-Length header. */
  send(payload) {
    if (!this.proc?.stdin?.writable) throw new Error('LSP process is not running.');
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii');
    this.proc.stdin.write(Buffer.concat([header, body]));
  }

  request(method, params, timeoutMs = 8000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`LSP request "${method}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      try {
        this.send({ jsonrpc: '2.0', id, method, params });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  notify(method, params) {
    this.send({ jsonrpc: '2.0', method, params });
  }

  onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (true) {
      const sep = this.buf.indexOf('\r\n\r\n');
      if (sep < 0) break;
      const head = this.buf.slice(0, sep).toString('ascii');
      const m = head.match(/Content-Length:\s*(\d+)/i);
      if (!m) { this.buf = this.buf.slice(sep + 4); continue; }
      const len = Number(m[1]);
      const frameEnd = sep + 4 + len;
      if (this.buf.length < frameEnd) break;
      const raw = this.buf.slice(sep + 4, frameEnd).toString('utf8');
      this.buf = this.buf.slice(frameEnd);
      try { this.handleMessage(JSON.parse(raw)); } catch { /* ignore malformed frame */ }
    }
  }

  handleMessage(msg) {
    if (msg.id != null && (Object.prototype.hasOwnProperty.call(msg, 'result') || msg.error)) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || `LSP error ${msg.error.code}`));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method === 'textDocument/publishDiagnostics' && msg.params?.uri) {
      this.diags.set(msg.params.uri, msg.params.diagnostics || []);
    }
  }

  async ensureStarted() {
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      const cmd = this.spawnOpts.cmd || this.spec.cmd;
      const args = this.spawnOpts.args || this.spec.args || [];
      this.proc = spawn(cmd, args, {
        cwd: this.root,
        shell: process.platform === 'win32' && !this.spawnOpts.cmd,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      await new Promise((resolve, reject) => {
        const onErr = (e) => reject(e.code === 'ENOENT'
          ? new Error(`Language server "${cmd}" not found. Install it with: ${this.spec.installHint || cmd}`)
          : e);
        this.proc.once('error', onErr);
        this.proc.once('spawn', () => { this.proc.off('error', onErr); resolve(); });
      });
      this.proc.stdout.on('data', (d) => this.onData(d));
      this.proc.on('exit', () => {
        for (const p of this.pending.values()) p.reject(new Error('LSP server exited.'));
        this.pending.clear();
        this.proc = null;
        this.initPromise = null;
      });
      await this.request('initialize', {
        processId: process.pid,
        rootUri: pathToFileURL(this.root).href,
        capabilities: {
          textDocument: {
            definition: { linkSupport: false },
            references: {},
            hover: { contentFormat: ['markdown', 'plaintext'] },
            publishDiagnostics: { relatedInformation: true },
          },
        },
      }, 10000);
      this.notify('initialized', {});
    })();
    try {
      await this.initPromise;
    } catch (e) {
      this.initPromise = null;
      throw e;
    }
  }

  syncDocument(absPath, languageId) {
    const uri = pathToFileURL(absPath).href;
    const text = fs.readFileSync(absPath, 'utf8');
    const prev = this.opened.get(uri) || 0;
    if (!prev) {
      this.opened.set(uri, 1);
      this.notify('textDocument/didOpen', { textDocument: { uri, languageId, version: 1, text } });
    } else {
      const next = prev + 1;
      this.opened.set(uri, next);
      this.notify('textDocument/didChange', { textDocument: { uri, version: next }, contentChanges: [{ text }] });
    }
    return uri;
  }

  async query({ action, absPath, languageId, line = 1, character = 1 }) {
    await this.ensureStarted();
    const uri = this.syncDocument(absPath, languageId);
    const pos = { line: Math.max(0, Number(line) - 1), character: Math.max(0, Number(character) - 1) };
    if (action === 'diagnostics') {
      await new Promise((r) => setTimeout(r, 150));
      return this.diags.get(uri) || [];
    }
    if (action === 'hover') {
      return this.request('textDocument/hover', { textDocument: { uri }, position: pos });
    }
    if (action === 'definition') {
      return this.request('textDocument/definition', { textDocument: { uri }, position: pos });
    }
    if (action === 'references') {
      return this.request('textDocument/references', {
        textDocument: { uri },
        position: pos,
        context: { includeDeclaration: true },
      });
    }
    throw new Error(`Unknown LSP action: ${action}`);
  }

  async close() {
    const p = this.proc;
    if (!p) return;
    const exited = new Promise((r) => p.once('exit', r));
    try { await this.request('shutdown', null, 1500); this.notify('exit', null); } catch { /* ignore */ }
    try { p.kill(); } catch { /* ignore */ }
    await Promise.race([exited, new Promise((r) => setTimeout(r, 500))]);
    this.proc = null;
    this.initPromise = null;
  }
}

function formatLocations(root, res) {
  const list = Array.isArray(res) ? res : res ? [res] : [];
  if (!list.length) return 'No locations found.';
  return list.slice(0, 40).map((loc) => {
    const uri = loc.uri || loc.targetUri;
    const range = loc.range || loc.targetSelectionRange || loc.targetRange;
    const rel = uri?.startsWith('file://') ? path.relative(root, fileURLToPath(uri)).replace(/\\/g, '/') : uri;
    const ln = (range?.start?.line ?? 0) + 1;
    const col = (range?.start?.character ?? 0) + 1;
    return `${rel}:${ln}:${col}`;
  }).join('\n');
}

function formatHover(res) {
  if (!res?.contents) return 'No hover information.';
  const c = res.contents;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((x) => (typeof x === 'string' ? x : x.value || '')).filter(Boolean).join('\n');
  return c.value || JSON.stringify(c);
}

function formatDiagnostics(root, absPath, diags) {
  if (!diags.length) return `No LSP diagnostics for ${path.relative(root, absPath).replace(/\\/g, '/')}.`;
  const sev = { 1: 'Error', 2: 'Warning', 3: 'Info', 4: 'Hint' };
  return diags.slice(0, 30).map((d) => {
    const ln = (d.range?.start?.line ?? 0) + 1;
    const col = (d.range?.start?.character ?? 0) + 1;
    return `[${sev[d.severity] || 'Diag'}] ${ln}:${col} ${d.message}`;
  }).join('\n');
}

const pools = new Map(); // root -> Map<serverId, LspClient>

async function queryLsp(root, { action, file, line = 1, character = 1, spawnOpts } = {}) {
  const absRoot = path.resolve(root);
  if (action === 'status') {
    return `Supported LSP languages: ${Object.keys(SERVERS).join(', ')}.`;
  }
  if (!file) throw new Error('file is required for lsp_query.');
  const abs = path.resolve(absRoot, file);
  if (!abs.startsWith(absRoot + path.sep) && abs !== absRoot) throw new Error(`Path escapes project root: ${file}`);
  if (!fs.existsSync(abs)) throw new Error(`File not found: ${file}`);
  const spec = serverForFile(abs);
  if (!spec && !spawnOpts?.cmd) throw new Error(`No LSP server configured for extension "${path.extname(abs)}".`);
  let byServer = pools.get(absRoot);
  if (!byServer) { byServer = new Map(); pools.set(absRoot, byServer); }
  const key = spawnOpts?.cmd ? `custom:${spawnOpts.cmd}` : spec.id;
  let client = byServer.get(key);
  if (!client) {
    client = new LspClient(absRoot, spec || { cmd: spawnOpts.cmd, args: spawnOpts.args || [], languageId: 'plaintext' }, spawnOpts);
    byServer.set(key, client);
  }
  const res = await client.query({ action, absPath: abs, languageId: spec?.languageId || 'plaintext', line, character });
  if (action === 'definition' || action === 'references') return formatLocations(absRoot, res);
  if (action === 'hover') return formatHover(res);
  if (action === 'diagnostics') return formatDiagnostics(absRoot, abs, res);
  return String(res);
}

async function closeAll(root) {
  if (root) {
    const m = pools.get(path.resolve(root));
    if (!m) return;
    await Promise.all([...m.values()].map((c) => c.close()));
    pools.delete(path.resolve(root));
    return;
  }
  for (const m of pools.values()) await Promise.all([...m.values()].map((c) => c.close()));
  pools.clear();
}

module.exports = { LspClient, SERVERS, serverForFile, queryLsp, closeAll };
