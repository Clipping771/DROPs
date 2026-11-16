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
  const keyStoreAvailable = safeStorage ? !!safeStorage.isEncryptionAvailable?.() : true;
  return {
    ...pub, keyStoreAvailable, plainKeysSaved: stored.some((k) => String(k).startsWith('raw:')), hasAnthropic, hasGemini, providers, hasKey: hasAnthropic || hasGemini || anyOai,
    keyFromEnv: !apiKeyEnc && !!process.env.ANTHROPIC_API_KEY,
    geminiFromEnv: !geminiKeyEnc && !!geminiEnv(),
  };
}
const encrypt = (v) => (safeStorage?.isEncryptionAvailable?.()
  ? 'enc:' + safeStorage.encryptString(v).toString('base64')
  : 'raw:' + Buffer.from(v).toString('base64'));
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
    if (safeStorage?.isEncryptionAvailable?.()) return safeStorage.decryptString(buf);
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
function setSettings(patch) {
  const s = getSettingsRaw();
  const { apiKey, geminiKey, providerKeys, ...rest } = patch;
  Object.assign(s, rest);
  if (providerKeys) {
    s.providerKeysEnc = { ...(s.providerKeysEnc || {}) };
    for (const [id, k] of Object.entries(providerKeys)) { if (k) s.providerKeysEnc[id] = encrypt(k); else delete s.providerKeysEnc[id]; }
  }
  if (apiKey !== undefined) s.apiKeyEnc = apiKey ? encrypt(apiKey) : null;
  if (geminiKey !== undefined) s.geminiKeyEnc = geminiKey ? encrypt(geminiKey) : null;
  writeSettingsFile(s);
  return getSettings();
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
const packSession = (data) => (data.turns?.length ? { ...data, turns: data.turns.map((t) => ({ ...t, files: packFiles(t.files), ...(t.after ? { after: packFiles(t.after) } : {}) })) } : data);
function unpackSession(d) {
  for (const t of d?.turns || []) { unpackFiles(t.files); unpackFiles(t.after); }
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

module.exports = { gcBlobs, getSettings, setSettings, getApiKey, getGeminiKey, getProviderKey, addRecentProject, newSession, saveSession, loadSession, deleteSession, listSessions };
