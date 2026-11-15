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

function getSettingsRaw() {
  const saved = readJson(settingsFile(), {});
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
  return {
    ...pub, hasAnthropic, hasGemini, providers, hasKey: hasAnthropic || hasGemini || anyOai,
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
const decrypt = (enc) => {
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
  writeJson(settingsFile(), s);
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
  writeJson(settingsFile(), s);
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
function saveSession(data) { writeJson(sessionFile(data.id), data); }
function loadSession(id) { return readJson(sessionFile(id), null); }
function deleteSession(id) { try { fs.rmSync(sessionFile(id)); } catch { /* gone */ } }
function listSessions() {
  let files = [];
  try { files = fs.readdirSync(sessionsDir()).filter((f) => f.endsWith('.json')); } catch { return []; }
  return files.map((f) => {
    const d = readJson(path.join(sessionsDir(), f), null);
    if (!d) return null;
    return { id: d.id, title: d.title, projectDir: d.projectDir, updated: d.updated, cost: d.usage?.cost || 0, turns: d.turns?.length || 0 };
  }).filter(Boolean).sort((a, b) => b.updated - a.updated);
}

module.exports = { getSettings, setSettings, getApiKey, getGeminiKey, getProviderKey, addRecentProject, newSession, saveSession, loadSession, deleteSession, listSessions };
