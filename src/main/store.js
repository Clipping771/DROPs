// Persistence: settings (API key encrypted with Windows DPAPI via safeStorage) and sessions.
const electron = require('electron');
const app = electron && typeof electron === 'object' ? electron.app : null;
const safeStorage = electron && typeof electron === 'object' ? electron.safeStorage : null;
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const dir = () => (app?.isReady?.() ? app.getPath('userData') : require('./brand').appDataDir());
const sessionsDir = () => path.join(dir(), 'sessions');
const settingsFile = () => path.join(dir(), 'settings.json');

const DEFAULTS = {
  defaultModel: 'claude-opus-5-5',
  effort: 'high',
  mode: 'ask',
  customInstructions: '',
  recentProjects: [],
  apiKeyEnc: null,
  theme: 'dark',
  autoVerify: true,
  qaAgent: true,
  computerUse: true,
  updateCheck: true,
  compactAt: 180000,
  maxSteps: 250,
  // models & routing
  autoProvider: 'auto',
  cheapSubagents: true,
  maxCostPerTask: 0,
  maxTokensPerTask: 0,
  ollamaEnabled: true,
  ollamaUrl: 'http://localhost:11434',
  ollamaCtx: 16384,
  // tools
  mcpServers: {},
  allowProjectMcp: false,
  sandbox: false,
  sandboxImage: 'node:22-bookworm',
  sandboxNetwork: true,
  // communication
  responseLanguage: 'auto',
  uiLanguage: 'en',
  explainMode: false,
  // OpenAI-compatible providers
  providerKeysEnc: {},
  customBaseUrl: '',
  customLabel: 'Custom',
  lmstudioEnabled: false,
  lmstudioUrl: 'http://127.0.0.1:1234/v1',
};

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

// Settings are read many times per agent step: keep the parsed file and re-read it only when it
// changed on disk (size or time), so edits by another process (the CLI, a test) are still seen.
let settingsCache = null; // { file, stamp, saved }
function readSettingsFile() {
  const file = settingsFile();
  let stamp = 'none';
  try { const st = fs.statSync(file); stamp = `${st.mtimeMs}:${st.size}`; } catch { /* no file yet */ }
  if (!settingsCache || settingsCache.file !== file || settingsCache.stamp !== stamp) {
    settingsCache = { file, stamp, saved: stamp === 'none' ? {} : readJson(file, {}) };
  }
  return structuredClone(settingsCache.saved);
}
function writeSettingsFile(data) { writeJson(settingsFile(), data); settingsCache = null; }

function getSettingsRaw() {
  const saved = readSettingsFile();
  // "en" was the old default, not a choice: it becomes "auto" once (an explicit choice made later stays).
  if (saved.responseLanguage === 'en' && !saved.languageMigrated) { saved.responseLanguage = 'auto'; saved.languageMigrated = true; }
  return { ...DEFAULTS, ...saved };
}
const geminiEnv = () => process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || null;
function getSettings() {
  const s = getSettingsRaw();
  const { apiKeyEnc, geminiKeyEnc, providerKeysEnc, ...pub } = s;
  const hasAnthropic = !!getApiKey();
  const hasGemini = !!getGeminiKey();
  const { PROVIDERS } = require('./oai');
  const providers = {};
  for (const [id, p] of Object.entries(PROVIDERS)) {
    const stored = !!(providerKeysEnc || {})[id];
    const env = !!(p.env && process.env[p.env]);
    const enabled = id === 'lmstudio' ? !!s.lmstudioEnabled : id === 'custom' ? !!s.customBaseUrl : stored || env;
    providers[id] = { enabled, hasKey: stored || env, fromEnv: !stored && env };
  }
  const anyOai = Object.entries(providers).some(([id, p]) => p.enabled && id !== 'lmstudio');
  // Without an OS key store (e.g. Linux with no keyring) keys are only base64-encoded on disk: say so.
  const stored = [apiKeyEnc, geminiKeyEnc, ...Object.values(providerKeysEnc || {})].filter(Boolean);
  const keyStoreAvailable = safeStorage ? asyncKeyStore !== false : true;
  return {
    ...pub, keyStoreAvailable, plainKeysSaved: stored.some((k) => String(k).startsWith('raw:')), plainKeyFile: plainKeyFile(), hasAnthropic, hasGemini, providers, hasKey: hasAnthropic || hasGemini || anyOai,
    keyFromEnv: !apiKeyEnc && !!process.env.ANTHROPIC_API_KEY,
    geminiFromEnv: !geminiKeyEnc && !!geminiEnv(),
  };
}
// Electron 45 deprecates safeStorage's synchronous calls. In the app, keys are decrypted once at start
// (init) and encrypted when saved (setSettingsAsync) with the asynchronous ones; the stored format is the
// same ("v10" on Windows), so older saved keys and the headless CLI keep working. The synchronous calls
// below are only a fallback for code that runs before init.
let asyncKeyStore = null; // true / false once init has asked the OS key store
const encrypt = (v) => (safeStorage && (asyncKeyStore ?? safeStorage.isEncryptionAvailable?.())
  ? 'enc:' + safeStorage.encryptString(v).toString('base64')
  : 'raw:' + Buffer.from(v).toString('base64'));
async function encryptAsync(v) {
  // Not asked at start (nothing was saved yet): ask now, when the user saves a key.
  if (asyncKeyStore === null && safeStorage?.isAsyncEncryptionAvailable) asyncKeyStore = !!(await safeStorage.isAsyncEncryptionAvailable());
  if (safeStorage?.encryptStringAsync && asyncKeyStore) {
    const enc = 'enc:' + (await safeStorage.encryptStringAsync(v)).toString('base64');
    decrypted.set(enc, v);
    return enc;
  }
  return encrypt(v);
}
/** Asks the OS key store once (after the app is ready) and decrypts every saved key into memory. */
async function init() {
  if (!safeStorage?.isAsyncEncryptionAvailable) return;
  // Asking the OS key store can wait on the user (the macOS keychain may ask for permission), so it is
  // asked at start only when there is a saved key to open or a plain-text key file to move in. Otherwise
  // it is asked the first time a key is saved.
  const pre = getSettingsRaw();
  const anySaved = [pre.apiKeyEnc, pre.geminiKeyEnc, ...Object.values(pre.providerKeysEnc || {})].some((k) => String(k || '').startsWith('enc:'));
  if (!anySaved && !plainKeyFile()) return;
  asyncKeyStore = !!(await safeStorage.isAsyncEncryptionAvailable());
  if (!asyncKeyStore) return;
  const s = getSettingsRaw();
  let changed = false;
  const open = async (enc) => {
    if (!enc || !enc.startsWith('enc:') || decrypted.has(enc)) return enc;
    try {
      const r = await safeStorage.decryptStringAsync(Buffer.from(enc.slice(4), 'base64'));
      decrypted.set(enc, r.result);
      // The OS rotated its key: store the value again under the new one.
      if (r.shouldReEncrypt) { changed = true; return encryptAsync(r.result); }
    } catch { /* unreadable here (another account or machine): treated as missing */ }
    return enc;
  };
  if (s.apiKeyEnc) s.apiKeyEnc = await open(s.apiKeyEnc);
  if (s.geminiKeyEnc) s.geminiKeyEnc = await open(s.geminiKeyEnc);
  for (const id of Object.keys(s.providerKeysEnc || {})) s.providerKeysEnc[id] = await open(s.providerKeysEnc[id]);
  // An OpenRouter key kept in a plain-text file (~/.h2o/openrouter.key, an older way to give the key) is
  // copied into the encrypted store, so the file can be deleted. Settings keeps warning while it exists.
  const legacy = plainKeyFile();
  if (legacy && !(s.providerKeysEnc || {}).openrouter) {
    try {
      const k = fs.readFileSync(legacy, 'utf8').trim();
      if (k) { s.providerKeysEnc = { ...(s.providerKeysEnc || {}), openrouter: await encryptAsync(k) }; changed = true; }
    } catch { /* unreadable: left alone */ }
  }
  if (changed) writeSettingsFile(s);
}
/** The plain-text OpenRouter key file, when it exists. */
function plainKeyFile() {
  const f = path.join(os.homedir(), '.h2o', 'openrouter.key');
  return fs.existsSync(f) ? f : null;
}
let cachedOsCryptKey;
function getOsCryptKey() {
  if (cachedOsCryptKey !== undefined) return cachedOsCryptKey;
  cachedOsCryptKey = null;
  try {
    if (process.platform !== 'win32') return null;
    const localState = JSON.parse(fs.readFileSync(path.join(dir(), 'Local State'), 'utf8'));
    const b64 = localState?.os_crypt?.encrypted_key;
    if (!b64) return null;
    const raw = Buffer.from(b64, 'base64');
    if (raw.subarray(0, 5).toString('ascii') !== 'DPAPI') return null;
    const dpapiB64 = raw.subarray(5).toString('base64');
    const ps = `Add-Type -AssemblyName System.Security; [Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String('${dpapiB64}'), $null, 'CurrentUser'))`;
    const keyB64 = execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, encoding: 'utf8' }).trim();
    if (keyB64) cachedOsCryptKey = Buffer.from(keyB64, 'base64');
  } catch { cachedOsCryptKey = null; }
  return cachedOsCryptKey;
}
// A key that can no longer be decrypted (e.g. data copied from another Windows account)
// is treated as missing, so the app keeps working and asks for it again.
// Decrypting goes through the OS key store; the same stored value always gives the same key.
const decrypted = new Map();
const decrypt = (enc) => {
  if (decrypted.has(enc)) return decrypted.get(enc);
  const v = decryptRaw(enc);
  if (v != null) decrypted.set(enc, v);
  return v;
};
const decryptRaw = (enc) => {
  try {
    const buf = Buffer.from(enc.slice(4), 'base64');
    if (!enc.startsWith('enc:')) return buf.toString();
    // In the app every saved key was decrypted by init; this is the fallback before init and in the CLI.
    if (safeStorage && !(process.platform === 'win32' && buf.subarray(0, 3).toString('ascii') === 'v10') && safeStorage.isEncryptionAvailable?.()) return safeStorage.decryptString(buf);
    if (buf.subarray(0, 3).toString('ascii') === 'v10') {
      const masterKey = getOsCryptKey();
      if (!masterKey) return null;
      const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey, buf.subarray(3, 15));
      decipher.setAuthTag(buf.subarray(buf.length - 16));
      return Buffer.concat([decipher.update(buf.subarray(15, buf.length - 16)), decipher.final()]).toString('utf8');
    }
    return null;
  } catch { return null; }
};
function setSettings(patch, enc = {}) {
  const s = getSettingsRaw();
  const { apiKey, geminiKey, providerKeys, ...rest } = patch;
  Object.assign(s, rest);
  if (providerKeys) {
    s.providerKeysEnc = { ...(s.providerKeysEnc || {}) };
    for (const [id, k] of Object.entries(providerKeys)) { if (k) s.providerKeysEnc[id] = enc.providerKeys?.[id] || encrypt(k); else delete s.providerKeysEnc[id]; }
  }
  if (apiKey !== undefined) s.apiKeyEnc = apiKey ? enc.apiKey || encrypt(apiKey) : null;
  if (geminiKey !== undefined) s.geminiKeyEnc = geminiKey ? enc.geminiKey || encrypt(geminiKey) : null;
  writeSettingsFile(s);
  return getSettings();
}
/** setSettings for the app: new keys are encrypted with the OS key store's asynchronous calls first. */
async function setSettingsAsync(patch) {
  const enc = {};
  if (patch.apiKey) enc.apiKey = await encryptAsync(patch.apiKey);
  if (patch.geminiKey) enc.geminiKey = await encryptAsync(patch.geminiKey);
  if (patch.providerKeys) {
    enc.providerKeys = {};
    for (const [id, k] of Object.entries(patch.providerKeys)) if (k) enc.providerKeys[id] = await encryptAsync(k);
  }
  return setSettings(patch, enc);
}
function getApiKey() {
  const enc = getSettingsRaw().apiKeyEnc;
  return enc ? decrypt(enc) : process.env.ANTHROPIC_API_KEY || null;
}
function getGeminiKey() {
  const enc = getSettingsRaw().geminiKeyEnc;
  return enc ? decrypt(enc) : geminiEnv();
}
function getProviderKey(id) {
  const enc = (getSettingsRaw().providerKeysEnc || {})[id];
  if (enc) return decrypt(enc);
  const { PROVIDERS } = require('./oai');
  const envKey = PROVIDERS[id]?.env ? process.env[PROVIDERS[id].env] || null : null;
  if (envKey) return envKey;
  if (id === 'openrouter') {
    const keyFile = path.join(os.homedir(), '.h2o', 'openrouter.key');
    if (fs.existsSync(keyFile)) {
      try {
        const k = fs.readFileSync(keyFile, 'utf8').trim();
        if (k) return k;
      } catch {}
    }
  }
  return null;
}
function addRecentProject(p) {
  const s = getSettingsRaw();
  s.recentProjects = [p, ...s.recentProjects.filter((x) => x !== p)].slice(0, 8);
  s.lastProject = p;
  writeSettingsFile(s);
}

function newSession(projectDir, opts = {}) {
  const s = getSettingsRaw();
  return {
    id: crypto.randomUUID(),
    title: 'New session',
    projectDir,
    created: Date.now(),
    updated: Date.now(),
    model: opts.model || s.defaultModel,
    effort: opts.effort || s.effort,
    mode: opts.mode || s.mode,
    messages: [],
    archive: [],
    compactions: [],
    turns: [],
    toolMeta: {},
    todos: [],
    changes: {},
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, context: 0, requests: 0 },
  };
}
const sessionFile = (id) => path.join(sessionsDir(), `${id.replace(/[^a-z0-9-]/gi, '')}.json`);
const indexFile = () => path.join(sessionsDir(), '_index.json');

// The sidebar's list of sessions comes from a small index instead of parsing every (possibly large)
// session file. Each entry remembers the file's size and time; a file changed by anything else is re-read.
function sessionSummary(d) {
  // The last turn stopped on an error (agent.js STOPPED_BY_ERROR), so the sidebar can say so.
  const last = (d.messages || [])[d.messages?.length - 1];
  const lastText = last && last.role === 'assistant' && Array.isArray(last.content) ? last.content.map((b) => b.text || '').join(' ') : '';
  return { id: d.id, title: d.title, projectDir: d.projectDir, updated: d.updated, cost: d.usage?.cost || 0, turns: d.turns?.length || 0, pinned: !!d.pinned, failed: lastText.startsWith('[DROPs] Stopped by an error:') };
}
const fileStamp = (file) => { try { const st = fs.statSync(file); return `${st.mtimeMs}:${st.size}`; } catch { return null; } };
let indexCache = null; // { file, entries: { [name]: { stamp, summary } } }
function readIndex() {
  const file = indexFile();
  if (!indexCache || indexCache.file !== file) indexCache = { file, entries: readJson(file, {}).entries || {} };
  return indexCache;
}
let indexTimer = null;
function writeIndexSoon() {
  clearTimeout(indexTimer);
  indexTimer = setTimeout(() => { try { if (indexCache) writeJson(indexCache.file, { entries: indexCache.entries }); } catch { /* rebuilt next time */ } }, 300);
  indexTimer.unref?.();
}

// File checkpoints (the content of each file before and after a turn changed it) are kept in a shared,
// content-addressed folder: the session file holds only { $blob: hash }. A long session used to rewrite
// every checkpointed file's full text on each step. In memory the contents stay plain strings.
const blobsDir = () => path.join(sessionsDir(), 'blobs');
const blobFile = (hash) => path.join(blobsDir(), `${hash.replace(/[^a-f0-9]/g, '')}.txt`);
const BLOB_MIN = 256; // short contents stay inline
const blobHashes = new Map(); // content -> hash, for contents already written (bounded)
function putBlob(text) {
  let hash = blobHashes.get(text);
  if (hash) return hash;
  hash = crypto.createHash('sha256').update(text).digest('hex');
  const f = blobFile(hash);
  if (!fs.existsSync(f)) { fs.mkdirSync(blobsDir(), { recursive: true }); const tmp = `${f}.${process.pid}.tmp`; fs.writeFileSync(tmp, text, 'utf8'); fs.renameSync(tmp, f); }
  if (blobHashes.size > 2000) blobHashes.clear();
  blobHashes.set(text, hash);
  return hash;
}
function getBlob(hash) { try { return fs.readFileSync(blobFile(hash), 'utf8'); } catch { return null; } }
const packFiles = (files) => {
  if (!files) return files;
  const out = {};
  for (const [k, v] of Object.entries(files)) out[k] = typeof v === 'string' && v.length >= BLOB_MIN ? { $blob: putBlob(v) } : v;
  return out;
};
const unpackFiles = (files) => {
  if (!files) return files;
  for (const [k, v] of Object.entries(files)) if (v && typeof v === 'object' && v.$blob) files[k] = getBlob(v.$blob);
  return files;
};
// Long tool output, base64 pictures and the window's copy of tool output go to the same blob store: a long
// session's file used to be megabytes of tool output, rewritten on every step. The model and the window
// still get plain strings: only the file on disk changes.
const BIG = 4096;
const blobRef = (s) => (typeof s === 'string' && s.length >= BIG ? { $blob: putBlob(s) } : s);
const isRef = (v) => v && typeof v === 'object' && typeof v.$blob === 'string';
const MISSING = '[This output is no longer stored.]';
const fromRef = (v) => (isRef(v) ? getBlob(v.$blob) ?? MISSING : v);
function packBlock(b) {
  if (!b || typeof b !== 'object') return b;
  if (b.type === 'tool_result' && typeof b.content === 'string' && b.content.length >= BIG) return { ...b, content: blobRef(b.content) };
  if (b.type === 'tool_result' && Array.isArray(b.content)) return { ...b, content: b.content.map(packBlock) };
  if (b.type === 'image' && b.source?.type === 'base64' && typeof b.source.data === 'string' && b.source.data.length >= BIG) return { ...b, source: { ...b.source, data: blobRef(b.source.data) } };
  return b;
}
function unpackBlock(b) {
  if (!b || typeof b !== 'object') return;
  if (b.type === 'tool_result') { if (isRef(b.content)) b.content = fromRef(b.content); else if (Array.isArray(b.content)) b.content.forEach(unpackBlock); }
  if (b.type === 'image' && isRef(b.source?.data)) b.source.data = fromRef(b.source.data);
}
const packMessages = (list) => (Array.isArray(list) ? list.map((m) => (Array.isArray(m?.content) ? { ...m, content: m.content.map(packBlock) } : m)) : list);
const unpackMessages = (list) => { for (const m of Array.isArray(list) ? list : []) if (Array.isArray(m?.content)) m.content.forEach(unpackBlock); };
function packMeta(meta) {
  if (!meta || typeof meta !== 'object') return meta;
  const out = {};
  for (const [id, m] of Object.entries(meta)) out[id] = m && typeof m.output === 'string' && m.output.length >= BIG ? { ...m, output: blobRef(m.output) } : m;
  return out;
}
function unpackMeta(meta) { for (const m of Object.values(meta || {})) if (m && isRef(m.output)) m.output = fromRef(m.output); }

const packSession = (data) => ({
  ...data,
  ...(data.turns?.length ? { turns: data.turns.map((t) => ({ ...t, files: packFiles(t.files), ...(t.after ? { after: packFiles(t.after) } : {}) })) } : {}),
  messages: packMessages(data.messages), archive: packMessages(data.archive), toolMeta: packMeta(data.toolMeta),
});
function unpackSession(d) {
  if (!d) return d;
  for (const t of d.turns || []) { unpackFiles(t.files); unpackFiles(t.after); }
  unpackMessages(d.messages); unpackMessages(d.archive); unpackMeta(d.toolMeta);
  return d;
}
/** Deletes checkpoint blobs that no session refers to any more (run now and then, not on every delete). */
function gcBlobs() {
  let names = [];
  try { names = fs.readdirSync(blobsDir()); } catch { return 0; }
  const used = new Set();
  let files = [];
  try { files = fs.readdirSync(sessionsDir()).filter((f) => f.endsWith('.json') && f !== '_index.json'); } catch { return 0; }
  for (const f of files) {
    let raw;
    try { raw = fs.readFileSync(path.join(sessionsDir(), f), 'utf8'); } catch { return 0; } // unsure: delete nothing
    for (const m of raw.matchAll(/"\$blob":"([a-f0-9]{64})"/g)) used.add(m[1]);
  }
  let removed = 0;
  const cutoff = Date.now() - 3600_000; // a blob written in the last hour may belong to a session not saved yet
  for (const n of names) {
    const hash = n.replace(/\.txt$/, '');
    if (used.has(hash) || !/^[a-f0-9]{64}\.txt$/.test(n)) continue;
    try { if (fs.statSync(path.join(blobsDir(), n)).mtimeMs < cutoff) { fs.rmSync(path.join(blobsDir(), n)); removed++; } } catch { /* in use */ }
  }
  return removed;
}

function saveSession(data) {
  const file = sessionFile(data.id);
  writeJson(file, packSession(data));
  const idx = readIndex();
  idx.entries[path.basename(file)] = { stamp: fileStamp(file), summary: sessionSummary(data) };
  writeIndexSoon();
}
function loadSession(id) { return unpackSession(readJson(sessionFile(id), null)); }
function deleteSession(id) {
  try { fs.rmSync(sessionFile(id)); } catch { /* gone */ }
  const idx = readIndex();
  if (idx.entries[path.basename(sessionFile(id))]) { delete idx.entries[path.basename(sessionFile(id))]; writeIndexSoon(); }
}
function listSessions() {
  let files = [];
  try { files = fs.readdirSync(sessionsDir()).filter((f) => f.endsWith('.json') && f !== '_index.json'); } catch { return []; }
  const idx = readIndex();
  let changed = false;
  const out = [];
  for (const f of files) {
    const stamp = fileStamp(path.join(sessionsDir(), f));
    let e = idx.entries[f];
    if (!e || e.stamp !== stamp) {
      const d = readJson(path.join(sessionsDir(), f), null);
      if (!d) continue;
      e = idx.entries[f] = { stamp, summary: sessionSummary(d) };
      changed = true;
    }
    out.push(e.summary);
  }
  for (const f of Object.keys(idx.entries)) if (!files.includes(f)) { delete idx.entries[f]; changed = true; }
  if (changed) writeIndexSoon();
  return out.sort((a, b) => b.updated - a.updated);
}

/** Searches all saved sessions by title and conversation text (without unpacking checkpoint blobs). */
/** Searches every saved session's title and conversation text. Reads files one at a time without
 *  blocking, so the window stays responsive however many and however large the sessions are. */
async function searchSessions(query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  let files = [];
  try { files = (await fs.promises.readdir(sessionsDir())).filter((f) => f.endsWith('.json') && f !== '_index.json'); } catch { return []; }
  const hits = [];
  const blockText = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => (b?.type === 'text' && b.text ? b.text : '')).filter(Boolean).join(' ') : '');
  for (const f of files) {
    let d = null;
    try { d = JSON.parse(await fs.promises.readFile(path.join(sessionsDir(), f), 'utf8')); } catch { continue; }
    if (!d?.id) continue;
    const titleHit = (d.title || '').toLowerCase().includes(q);
    let snippet = '';
    for (const m of [...(d.messages || []), ...(d.archive || [])]) {
      const t = blockText(m?.content);
      const idx = t.toLowerCase().indexOf(q);
      if (idx >= 0) {
        const start = Math.max(0, idx - 30);
        const end = Math.min(t.length, idx + q.length + 50);
        snippet = (start > 0 ? '…' : '') + t.slice(start, end).replace(/\s+/g, ' ').trim() + (end < t.length ? '…' : '');
        break;
      }
    }
    if (titleHit || snippet) hits.push({ id: d.id, updated: d.updated || 0, snippet });
  }
  return hits.sort((a, b) => b.updated - a.updated).slice(0, 50).map(({ id, snippet }) => ({ id, snippet }));
}

module.exports = { init, setSettingsAsync, gcBlobs, getSettings, setSettings, getApiKey, getGeminiKey, getProviderKey, addRecentProject, newSession, saveSession, loadSession, deleteSession, listSessions, searchSessions };
