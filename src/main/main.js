const { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme, crashReporter } = require('electron');
const path = require('path');
const fs = require('fs');
const brand = require('./brand');
// Settings, saved keys and sessions: keep using the existing H2O folder after the rename to DROPs.
app.setPath('userData', brand.appDataDir());
// Crash reports stay on this computer (see crash.js).
const crash = require('./crash');
const previousCrash = crash.init({ dataDir: app.getPath('userData'), appVersion: app.getVersion(), app, crashReporter });

// The portable .exe unpacks the app into %TEMP% on every start. If that folder's ACL lists an
// AppContainer package (left there by some other app) but not ALL APPLICATION PACKAGES,
// Chromium's sandboxed processes cannot read the app files and Electron aborts at startup.
// Give that group read access to our own unpacked folder, as Electron's error message advises.
// Must run before the app is ready.
if (process.platform === 'win32' && process.env.PORTABLE_EXECUTABLE_DIR && app.isPackaged) {
  try {
    require('child_process').spawnSync('icacls', [path.dirname(process.execPath), '/grant', '*S-1-15-2-1:(OI)(CI)(RX)', '/Q'], { windowsHide: true, timeout: 15000 });
  } catch (e) { console.error('Could not grant sandbox read access to the app folder:', e); }
}

const store = require('./store');
const { AgentSession } = require('./agent');
const { getTaskManager } = require('./tasks');
const providers = require('./providers');
const gemini = require('./gemini');
const git = require('./git');
const ollama = require('./ollama');
const oai = require('./oai');
const report = require('./report');
const { McpManager, projectServers, isProjectTrusted, trustProject, untrustedRows } = require('./mcp');
const { IGNORE, resolveInRoot } = require('./tools');
const { listCommands } = require('./commands');

let win = null;
const agents = new Map();
const mcp = new McpManager();
let currentProject = null;

// Connects the MCP servers from Settings, plus the project's .mcp.json when the user allowed it.
async function syncMcp() {
  const s = store.getSettings();
  // A project's own servers run only when project MCP is allowed AND this exact config was trusted.
  const proj = s.allowProjectMcp && currentProject ? projectServers(currentProject) : {};
  const trusted = Object.keys(proj).length > 0 && isProjectTrusted(currentProject, proj);
  const configs = { ...(trusted ? proj : {}), ...(s.mcpServers || {}) };
  const status = [...await mcp.sync(configs), ...(Object.keys(proj).length && !trusted ? untrustedRows(proj) : [])];
  if (win && !win.isDestroyed()) win.webContents.send('mcp:status', status);
  return status;
}

// The app was previously called "Forge". Its data folder is moved as a whole (before the app is
// ready, so Chromium hasn't opened it yet): saved keys are encrypted with a secret kept in that
// folder's "Local State", so settings alone would not be readable elsewhere.
function migrateFromForge() {
  try {
    const oldDir = path.join(app.getPath('appData'), 'Forge');
    const newDir = app.getPath('userData');
    if (oldDir === newDir || !fs.existsSync(path.join(oldDir, 'settings.json')) || fs.existsSync(path.join(newDir, 'settings.json'))) return;
    // Electron may already have created an empty data folder; copy everything over it.
    for (const name of ['Local State', 'settings.json', 'sessions']) {
      const src = path.join(oldDir, name);
      if (fs.existsSync(src)) fs.cpSync(src, path.join(newDir, name), { recursive: true, force: true });
    }
  } catch (e) { console.error('Migration from Forge failed:', e); }
}
migrateFromForge();

const deps = {
  send: (sessionId, type, payload) => { if (win && !win.isDestroyed()) win.webContents.send('agent:event', { sessionId, type, ...payload }); },
  save: (data) => store.saveSession(data),
  getSettings: () => store.getSettings(),
  getApiKey: () => store.getApiKey(),
  getGeminiKey: () => store.getGeminiKey(),
  getProviderKey: (id) => store.getProviderKey(id),
  mcp,
  // The agent's `schedule` tool (it asks the user before saving or deleting).
  schedules: {
    list: () => scheduleList(),
    save: (input) => saveSchedule(input),
    remove: (id) => deleteSchedule(id),
  },
};

// ---------- scheduled tasks ----------
const schedule = require('./schedule');
const scheduleList = () => (store.getSettings().schedules || []).map((s) => ({ ...s, when: schedule.describe(s) }));
const writeSchedules = (list) => store.setSettings({ schedules: list.map(({ when, ...s }) => s) });
function saveSchedule(input) {
  const list = store.getSettings().schedules || [];
  const old = input.id ? list.find((x) => x.id === input.id) : null;
  const s = schedule.normalize(input, old || {});
  writeSchedules(old ? list.map((x) => (x.id === s.id ? s : x)) : [...list, s]);
  return { ...s, when: schedule.describe(s) };
}
function deleteSchedule(id) {
  const list = store.getSettings().schedules || [];
  if (!list.some((x) => x.id === id)) return false;
  writeSchedules(list.filter((x) => x.id !== id));
  return true;
}
/** Starts one scheduled task in a new session of its project. */
async function runSchedule(s) {
  if (!s.projectDir || !fs.existsSync(s.projectDir)) throw new Error('The project folder no longer exists.');
  const data = store.newSession(s.projectDir, {});
  data.title = `Scheduled: ${s.name}`; data.scheduleId = s.id;
  store.saveSession(data);
  agents.set(data.id, new AgentSession(data, deps));
  if (win && !win.isDestroyed()) win.webContents.send('schedule:ran', { id: s.id, sessionId: data.id, name: s.name });
  const st = store.getSettings();
  await taskManager.submitTask({
    session_id: data.id, workspace_id: s.projectDir, prompt: s.prompt, images: [],
    opts: { model: s.model || st.defaultModel || 'auto', effort: s.effort || st.effort || 'high', mode: s.mode || 'auto-edit' },
  }, { action: 'queue' });
}
const scheduler = new schedule.Scheduler({ list: () => store.getSettings().schedules || [], save: writeSchedules, run: runSchedule });

function getAgent(id) {
  if (!agents.has(id)) {
    const data = store.loadSession(id);
    if (!data) return null;
    agents.set(id, new AgentSession(data, deps));
  }
  return agents.get(id);
}

const taskManager = getTaskManager({
  getAgent,
  sendEvent: (id, type, p) => deps.send(id, type, p),
  store,
});

// ---------- theme ----------
const OVERLAY = { dark: { color: '#131314', symbolColor: '#c4c7c5' }, light: { color: '#ffffff', symbolColor: '#444746' } };
function effectiveTheme() { return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'; }
function applyTheme(mode) {
  nativeTheme.themeSource = ['light', 'dark'].includes(mode) ? mode : 'system';
  const t = effectiveTheme();
  if (win && !win.isDestroyed()) {
    if (process.platform !== 'darwin') { try { win.setTitleBarOverlay({ ...OVERLAY[t], height: 44 }); } catch { /* not supported */ } }
    win.setBackgroundColor(OVERLAY[t].color);
  }
  return t;
}

function createWindow() {
  const mode = brand.env('THEME') || store.getSettings().theme || 'dark';
  nativeTheme.themeSource = ['light', 'dark'].includes(mode) ? mode : 'system';
  const t = effectiveTheme();
  win = new BrowserWindow({
    width: 1560, height: 960, minWidth: 1040, minHeight: 640,
    backgroundColor: OVERLAY[t].color,
    title: 'DROPs',
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    // macOS keeps its native traffic lights; Windows/Linux draw caption buttons over our title bar.
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 13 } } : { titleBarStyle: 'hidden', titleBarOverlay: { ...OVERLAY[t], height: 44 } }),
    show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
  });
  win.removeMenu();
  win.once('ready-to-show', () => win.show());
  if (brand.env('CONSOLE')) {
    win.webContents.on('console-message', (e) => fs.appendFileSync(brand.env('CONSOLE'), `[${e.level}] ${e.message} (${(e.sourceId || '').split('/').pop()}:${e.lineNumber})\n`));
  }
  if (brand.env('SCREENSHOT')) {
    win.webContents.once('did-finish-load', () => setTimeout(async () => {
      if (brand.env('DEMO')) { await win.webContents.executeJavaScript(fs.readFileSync(brand.env('DEMO'), 'utf8')); await new Promise((r) => setTimeout(r, 2500)); }
      if (brand.env('CONSOLE')) fs.appendFileSync(brand.env('CONSOLE'), `[title] ${win.webContents.getTitle()}\n`);
      const img = await win.webContents.capturePage();
      fs.writeFileSync(brand.env('SCREENSHOT'), img.toPNG());
      app.quit();
    }, 2500));
  }
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('file:')) { e.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url); } });
  win.webContents.on('before-input-event', (_e, input) => { if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools(); });
  nativeTheme.on('updated', () => { const th = applyTheme(store.getSettings().theme || 'dark'); win?.webContents.send('theme:changed', th); });
}

// ---------- models ----------
let geminiModels = null;
async function getGeminiModels(force) {
  const key = store.getGeminiKey();
  if (!key) return [];
  if (!geminiModels || force) {
    try { geminiModels = await gemini.listModels(key); } catch { geminiModels = gemini.FALLBACKS.map((id) => ({ id, label: id })); }
  }
  return geminiModels;
}

const handle = (ch, fn) => ipcMain.handle(ch, async (_e, ...args) => fn(...args));

// Ollama state: 'off' (setting disabled), 'missing' (not installed), 'stopped' (installed, not running),
// 'empty' (running, no models), 'ready'.
let ollamaModels = null, ollamaAt = 0, ollamaState = 'stopped', ollamaSeq = 0;
function findOllamaExe() {
  const candidates = process.platform === 'win32'
    ? [path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Ollama', 'ollama.exe'), path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Ollama', 'ollama.exe')]
    : ['/usr/local/bin/ollama', '/opt/homebrew/bin/ollama', '/usr/bin/ollama', '/Applications/Ollama.app/Contents/Resources/ollama'];
  const hit = candidates.find((p) => p && fs.existsSync(p));
  if (hit) return hit;
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    const p = path.join(dir, process.platform === 'win32' ? 'ollama.exe' : 'ollama');
    if (dir && fs.existsSync(p)) return p;
  }
  return null;
}
async function getOllamaModels(force) {
  const s = store.getSettings();
  if (s.ollamaEnabled === false) { ollamaState = 'off'; return []; }
  if (!force && ollamaModels && Date.now() - ollamaAt < (ollamaModels.length ? 30000 : 5000)) return ollamaModels;
  const seq = ++ollamaSeq;
  try {
    const list = await ollama.listModels(s.ollamaUrl);
    if (seq !== ollamaSeq) return ollamaModels || list;
    ollamaModels = list;
    ollamaState = ollamaModels.length ? 'ready' : 'empty';
  } catch {
    if (seq !== ollamaSeq) return ollamaModels || [];
    ollamaModels = [];
    ollamaState = findOllamaExe() ? 'stopped' : 'missing';
  }
  ollamaAt = Date.now();
  return ollamaModels;
}
// Starts `ollama serve` in the background and waits for the API.
async function startOllama() {
  const exe = findOllamaExe();
  if (!exe) return { ok: false, error: 'Ollama is not installed. Get it from ollama.com, then try again.' };
  const { spawn } = require('child_process');
  spawn(exe, ['serve'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const list = await getOllamaModels(true);
    if (ollamaState !== 'stopped') return { ok: true, state: ollamaState, models: list.length };
  }
  return { ok: false, error: 'Ollama did not start within 30 seconds — try opening the Ollama app manually.' };
}
const OLLAMA_HINT = {
  stopped: 'Ollama is installed but not running — click to start it',
  missing: 'Ollama not installed — get it at ollama.com',
  empty: 'Ollama is running but has no models — run: ollama pull qwen3',
};

handle('app:info', async () => {
  const s = store.getSettings();
  const auto = (s.hasAnthropic || s.hasGemini) ? [{ id: 'auto', label: 'Auto (cost-optimized)', provider: 'Auto' }] : [];
  const claude = Object.entries(providers.CLAUDE).map(([id, m]) => ({ id, label: m.label, provider: 'Claude' }));
  const gem = (await getGeminiModels()).map((m) => ({ ...m, provider: 'Gemini' }));
  const local = (await getOllamaModels()).map((m) => ({ ...m, provider: 'Local (Ollama)' }));
  // Keep the Local group visible with a status line, so users know why it's empty and how to fix it.
  if (!local.length && OLLAMA_HINT[ollamaState]) local.push({ id: '__ollama:' + ollamaState, label: OLLAMA_HINT[ollamaState], provider: 'Local (Ollama)', disabled: ollamaState !== 'stopped', action: ollamaState === 'stopped' ? 'start-ollama' : null });
  else if (local.length && local.every((m) => m.cloud)) local.push({ id: '__ollama:onlycloud', label: 'Only cloud models installed — download a free local model in Settings', provider: 'Local (Ollama)', disabled: true });
  const other = await getOaiModels(s);
  const withCtx = (m) => (m.id && !m.id.startsWith('__') && m.id !== 'auto' ? { ...m, context: providers.contextWindow(m.id, s) } : m);
  return { models: [...auto, ...claude, ...gem, ...other, ...local].map(withCtx), efforts: providers.EFFORTS, version: app.getVersion(), theme: effectiveTheme(), platform: process.platform };
});

// OpenAI-compatible providers: live model lists for every provider that has a key.
const oaiCache = new Map(); // pid -> { at, models, error }
async function oaiModelsFor(pid, s, force) {
  const hit = oaiCache.get(pid);
  if (!force && hit && Date.now() - hit.at < (hit.error ? 15000 : 300000)) return hit;
  let entry;
  try { entry = { at: Date.now(), models: await oai.listModels(pid, s, (id) => store.getProviderKey(id)), error: null }; }
  catch (e) { const f = oai.friendly(e, pid + ':?'); entry = { at: Date.now(), models: [], error: f?.message || e.message }; }
  oaiCache.set(pid, entry);
  return entry;
}
async function getOaiModels(s) {
  const lists = await Promise.all(Object.entries(oai.PROVIDERS).filter(([pid]) => s.providers?.[pid]?.enabled).map(async ([pid, p]) => {
    const label = pid === 'custom' ? (s.customLabel || 'Custom') : p.label;
    const r = await oaiModelsFor(pid, s);
    if (r.error) return [{ id: `__${pid}:error`, label: r.error.slice(0, 110), provider: label, disabled: true }];
    return r.models.map((m) => ({ ...m, provider: label }));
  }));
  return lists.flat();
}
handle('provider:test', async (pid) => {
  const r = await oaiModelsFor(pid, store.getSettings(), true);
  return r.error ? { ok: false, error: r.error } : { ok: true, detail: `${r.models.length} models available` };
});
handle('provider:list', () => Object.entries(oai.PROVIDERS).map(([id, p]) => ({ id, label: p.label, keyUrl: p.keyUrl || null, noKey: !!p.noKey, custom: !!p.custom, local: !!p.local, env: p.env || null })));

// Ollama model downloads with progress events.
handle('ollama:recommended', () => ({ models: ollama.RECOMMENDED, ramGb: Math.round(require('os').totalmem() / 1024 ** 3) }));
let pulling = null;
handle('ollama:pull', async (name) => {
  if (pulling) return { ok: false, error: `Already downloading ${pulling}.` };
  const s = store.getSettings();
  if (ollamaState === 'stopped' || ollamaState === 'missing') { const st = await startOllama(); if (!st.ok) return st; }
  pulling = name;
  let lastSent = 0;
  try {
    await ollama.pull(s.ollamaUrl, name, (p) => {
      if (Date.now() - lastSent < 250 && p.status !== 'success') return;
      lastSent = Date.now();
      if (win && !win.isDestroyed()) win.webContents.send('ollama:progress', { name, ...p });
    });
    ollamaModels = null;
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; } finally { pulling = null; }
});
handle('settings:get', () => store.getSettings());
handle('settings:set', async (patch) => {
  patch = { ...patch };
  if (Array.isArray(patch.recentProjects)) for (const p of patch.recentProjects) if (p && typeof p === 'string' && fs.existsSync(p)) store.addRecentProject(p);
  delete patch.recentProjects; delete patch.lastProject; // only changed by opening a project
  if (patch.geminiKey !== undefined) geminiModels = null;
  if (patch.ollamaUrl !== undefined || patch.ollamaEnabled !== undefined) { ollamaModels = null; ollamaSeq++; }
  if (patch.providerKeys) for (const pid of Object.keys(patch.providerKeys)) oaiCache.delete(pid);
  if (patch.customBaseUrl !== undefined) oaiCache.delete('custom');
  if (patch.lmstudioUrl !== undefined || patch.lmstudioEnabled !== undefined) oaiCache.delete('lmstudio');
  const s = store.setSettings(patch);
  if (patch.theme !== undefined) applyTheme(patch.theme);
  if (patch.mcpServers !== undefined || patch.allowProjectMcp !== undefined) syncMcp().catch(() => {});
  return s;
});
handle('ollama:test', async () => {
  let list = await getOllamaModels(true);
  if (ollamaState === 'stopped') { const r = await startOllama(); if (!r.ok) return r; list = await getOllamaModels(true); }
  if (list.length) return { ok: true, detail: `${list.length} local model${list.length > 1 ? 's' : ''}: ${list.map((m) => m.id.slice(7)).join(', ')}` };
  return { ok: false, error: OLLAMA_HINT[ollamaState] || 'No response from Ollama.' };
});
handle('ollama:start', () => startOllama());
handle('mcp:status', () => mcp.status());
handle('mcp:reconnect', async () => { await mcp.closeAll(); return syncMcp(); });
handle('lessons:list', () => require('./lessons').list());
handle('lessons:remove', (text) => require('./lessons').remove(String(text || '')));
handle('mcp:trustProject', async () => { if (!currentProject) return { error: 'No project open.' }; trustProject(currentProject, projectServers(currentProject)); return syncMcp(); });
handle('theme:set', (mode) => { store.setSettings({ theme: mode }); return applyTheme(mode); });
handle('settings:testKey', async (provider) => {
  try {
    if (provider === 'gemini') {
      if (!store.getGeminiKey()) throw new Error('No Gemini key saved.');
      const list = await getGeminiModels(true);
      return { ok: true, detail: `${list.length} chat models available` };
    }
    const Anthropic = require('@anthropic-ai/sdk');
    const key = store.getApiKey();
    if (!key) throw new Error('No Anthropic key saved.');
    await new Anthropic({ apiKey: key }).models.list({ limit: 1 });
    return { ok: true, detail: 'connected' };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ---------- project & files ----------
// The renderer passes a project root with every file call, but it is never trusted: only a folder
// the user picked in the dialog (now or earlier: recent projects, saved sessions, their worktrees)
// can become the project, and file calls only work inside the current project.
const pathKey = (p) => { const r = path.resolve(String(p)); return process.platform === 'win32' ? r.toLowerCase() : r; };
function isKnownProject(p) {
  const k = pathKey(p);
  const s = store.getSettings();
  return [...(s.recentProjects || []), s.lastProject, ...store.listSessions().map((x) => x.projectDir)]
    .some((x) => x && pathKey(x) === k);
}
function projectRoot(root) {
  if (!currentProject || !root || pathKey(root) !== pathKey(currentProject)) throw new Error('File access is limited to the open project.');
  return currentProject;
}
handle('project:open', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], title: 'Open project folder' });
  if (r.canceled || !r.filePaths[0]) return null;
  store.addRecentProject(r.filePaths[0]);
  return r.filePaths[0];
});
handle('project:use', (p) => {
  if (!p || typeof p !== 'string' || !fs.existsSync(p) || !isKnownProject(p)) return null;
  store.addRecentProject(p);
  if (p !== currentProject) { currentProject = p; if (store.getSettings().allowProjectMcp) syncMcp().catch(() => {}); }
  return p;
});

const HIDDEN = new Set(['node_modules', '.git', '__pycache__', '.venv', '.next', 'obj', '.cache']);
handle('fs:list', async (root, rel) => {
  try {
    const abs = resolveInRoot(projectRoot(root), rel || '.');
    const ents = await fs.promises.readdir(abs, { withFileTypes: true });
    return ents.filter((e) => !(e.isDirectory() && HIDDEN.has(e.name)))
      .map((e) => ({ name: e.name, dir: e.isDirectory(), rel: path.join(rel || '', e.name).replace(/\\/g, '/') }))
      .sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name));
  } catch { return []; }
});
handle('fs:read', async (root, rel) => {
  const abs = resolveInRoot(projectRoot(root), rel);
  const st = await fs.promises.stat(abs);
  if (st.size > 5 * 1024 * 1024) return { error: 'File is larger than 5 MB.' };
  const buf = await fs.promises.readFile(abs);
  if (buf.subarray(0, 8000).includes(0)) return { error: 'Binary file.' };
  return { content: buf.toString('utf8') };
});
handle('fs:write', async (root, rel, content) => { await fs.promises.writeFile(resolveInRoot(projectRoot(root), rel), String(content), 'utf8'); return true; });
handle('fs:openPath', (root, rel) => shell.openPath(resolveInRoot(projectRoot(root), rel || '.')));
handle('fs:reveal', (root, rel) => shell.showItemInFolder(resolveInRoot(projectRoot(root), rel || '.')));
handle('fs:search', async (root, q) => {
  const fg = require('fast-glob');
  const files = await fg('**/*', { cwd: projectRoot(root), ignore: IGNORE, onlyFiles: true, suppressErrors: true, deep: 12 });
  const needle = q.toLowerCase();
  const score = (f) => { const l = f.toLowerCase(); const b = l.split('/').pop(); return (b.startsWith(needle) ? 0 : b.includes(needle) ? 1 : 2) * 1000 + f.length; };
  return files.filter((f) => f.toLowerCase().includes(needle)).sort((a, b) => score(a) - score(b)).slice(0, 40);
});

// ---------- custom slash commands ----------
// Markdown files in <project>/.drops/commands/ (or the older .h2o/commands/) and in the user's DROPs data folder (commands/) become
// "/name" commands. Optional front matter: `description: …`. `$ARGUMENTS` is replaced by the text
// typed after the command.
handle('commands:list', (root) => {
  let project = null;
  try { project = projectRoot(root); } catch { /* no project open */ }
  const cmds = listCommands(project, path.join(app.getPath('userData'), 'commands'));
  // Skills can be called by name too: /release-notes runs the request with that skill.
  const have = new Set(cmds.map((c) => c.name));
  const skills = require('./commands').listSkills(project, path.join(app.getPath('userData'), 'skills'))
    .filter((k) => !have.has(k.name))
    .map((k) => ({ name: k.name, description: `Skill: ${k.description}`, prompt: `Use the "${k.name}" skill (load it with the skill tool) for this: $ARGUMENTS`, source: k.source }));
  return [...cmds, ...skills];
});
handle('commands:openFolder', async (where) => {
  const dir = where === 'project' && currentProject ? path.join(currentProject, '.drops', 'commands') : path.join(app.getPath('userData'), 'commands');
  await fs.promises.mkdir(dir, { recursive: true });
  return shell.openPath(dir);
});

// ---------- sessions ----------
handle('session:list', () => store.listSessions());
handle('session:new', async (projectDir, opts = {}) => {
  try { projectDir = projectRoot(projectDir); } catch (e) { return { error: e.message }; }
  let dir = projectDir, worktree = null;
  if (opts.worktree) {
    try { worktree = await git.worktreeAdd(projectDir, opts.worktreeLabel || 'task'); dir = worktree.dir; } catch (e) { return { error: e.stderr?.trim() || e.message }; }
  }
  const data = store.newSession(dir, opts);
  if (worktree) { data.worktree = worktree; data.title = `[${worktree.branch}] New session`; }
  store.saveSession(data);
  agents.set(data.id, new AgentSession(data, deps));
  return data;
});
handle('worktree:merge', async (id) => {
  const a = getAgent(id);
  if (!a?.data.worktree) return { error: 'This session is not in a worktree.' };
  if (a.busy) return { error: 'Stop the agent first.' };
  try { return { ok: true, message: await git.worktreeMerge(a.data.worktree, `DROPs: ${a.data.title}`) }; } catch (e) { return { error: e.stderr?.trim() || e.message }; }
});
handle('worktree:remove', async (id) => {
  const a = getAgent(id);
  if (!a?.data.worktree) return { error: 'This session is not in a worktree.' };
  a.dispose();
  try { await git.worktreeRemove(a.data.worktree); } catch (e) { return { error: e.stderr?.trim() || e.message }; }
  agents.delete(id); store.deleteSession(id);
  return { ok: true };
});
handle('session:import', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Import shared session', filters: [{ name: 'DROPs session', extensions: ['json'] }], properties: ['openFile'] });
  if (r.canceled || !r.filePaths[0]) return null;
  try {
    const j = JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8'));
    if (!j.h2oSession || !Array.isArray(j.messages)) return { error: 'Not a DROPs session file.' };
    if (!currentProject) return { error: 'Open a project first; the imported session is attached to it.' };
    const data = store.newSession(currentProject, { model: j.model });
    Object.assign(data, { title: `[shared] ${j.title}`, archive: j.messages, messages: [], toolMeta: j.toolMeta || {}, todos: j.todos || [], changes: {}, imported: true });
    store.saveSession(data);
    agents.set(data.id, new AgentSession(data, deps));
    return { id: data.id };
  } catch (e) { return { error: e.message }; }
});
// Fork: a new session that starts with this conversation so far (same project folder; files are shared).
handle('session:fork', (id) => {
  const a = getAgent(id);
  if (!a) return { error: 'Session not found' };
  if (a.busy) return { error: 'Wait for the agent to finish, then fork.' };
  const src = JSON.parse(JSON.stringify(a.data));
  const data = store.newSession(src.projectDir, { model: src.model, effort: src.effort, mode: src.mode });
  Object.assign(data, {
    title: `Fork: ${src.title}`.slice(0, 80), messages: src.messages, archive: src.archive || [], compactions: src.compactions || [],
    toolMeta: src.toolMeta || {}, todos: src.todos || [], requirements: src.requirements, forkedFrom: id,
    turns: (src.turns || []).map((t) => ({ ...t, files: {} })), // the original keeps the file checkpoints
  });
  if (src.worktree) data.worktree = src.worktree;
  store.saveSession(data);
  agents.set(data.id, new AgentSession(data, deps));
  return { id: data.id };
});
handle('session:load', (id) => { const a = getAgent(id); return a ? { ...a.data, busy: a.busy, procs: a.procs.list() } : null; });
handle('session:delete', (id) => { agents.get(id)?.dispose(); agents.delete(id); store.deleteSession(id); return true; });
handle('session:pin', (id, on) => { const a = getAgent(id); if (!a) return false; a.data.pinned = !!on; a.save(true); return true; });
handle('session:rename', (id, title) => { const a = getAgent(id); if (!a) return false; a.data.title = title; a.save(true); return true; });
handle('session:setOptions', (id, opts) => {
  const a = getAgent(id);
  if (!a) return false;
  for (const k of ['model', 'effort', 'mode']) if (opts[k]) a.data[k] = opts[k];
  a.save();
  return true;
});
handle('session:baseline', (id, rel) => getAgent(id)?.baseline(rel) || { found: false });
handle('session:revert', async (id, rel) => { try { return { ok: await getAgent(id).revertFile(rel) }; } catch (e) { return { error: e.message }; } });
handle('session:compact', async (id, opts) => {
  const a = getAgent(id);
  try { const ok = await a.compactNow(opts); return ok ? { ok, session: { ...a.data } } : { error: 'Nothing to compact yet.' }; } catch (e) { return { error: e.message }; }
});
handle('session:export', async (id, format = 'md') => {
  const a = getAgent(id);
  if (!a) return null;
  const name = a.data.title.replace(/[^\w\- ]+/g, '').trim().slice(0, 50) || 'session';
  const kinds = { md: ['Markdown', 'md', report.toMarkdown], html: ['HTML review report', 'html', report.toHtml], json: ['DROPs session (shareable)', 'json', report.toShareJson] };
  const [label, ext, fn] = kinds[format] || kinds.md;
  const r = await dialog.showSaveDialog(win, { title: `Export — ${label}`, defaultPath: `${name}${format === 'json' ? '.drops' : ''}.${ext}`, filters: [{ name: label, extensions: [ext] }] });
  if (r.canceled) return null;
  fs.writeFileSync(r.filePath, fn(a.data));
  if (format === 'html') shell.openExternal('file:///' + r.filePath.replace(/\\/g, '/'));
  return r.filePath;
});

// ---------- agent & tasks ----------
handle('agent:send', async (id, text, opts, images, extra = {}) => {
  const a = getAgent(id);
  if (!a) return { error: 'Session not found' };
  try {
    return await taskManager.submitTask({
      session_id: id,
      workspace_id: a.data.projectDir,
      prompt: text,
      images: images || [],
      opts: opts || {},
    }, { action: extra?.action || 'queue' });
  } catch (err) {
    deps.send(id, 'error', { message: err.message });
    return { error: err.message };
  }
});
handle('agent:stop', (id) => {
  const activeTask = taskManager.getActiveTaskForSession(id);
  if (activeTask) {
    taskManager.cancelTask(activeTask.task_id);
    return true;
  }
  getAgent(id)?.stop();
  return true;
});
handle('task:list', (filter) => taskManager.listTasks(filter));
handle('task:get', (taskId) => taskManager.getTask(taskId));
handle('task:cancel', (taskId) => taskManager.cancelTask(taskId));
handle('task:reorder', (sessionId, fromIdx, toIdx) => taskManager.reorderQueue(sessionId, fromIdx, toIdx));
handle('task:remove', (sessionId, taskId) => taskManager.removeFromQueue(sessionId, taskId));
handle('task:queue', (sessionId) => taskManager.queues.get(sessionId) || []);
handle('task:queued', (sessionId) => taskManager.queuedFor(sessionId));
handle('task:runNow', (taskId) => taskManager.runQueuedNow(taskId));
handle('agent:permission', (id, reqId, decision, feedback) => { getAgent(id)?.respond(reqId, decision, feedback); return true; });
handle('agent:rewind', async (id, turnIndex) => {
  const a = getAgent(id);
  try { const r = await a.rewind(turnIndex); return { ...r, session: { ...a.data, busy: false } }; } catch (e) { return { error: e.message }; }
});
handle('proc:list', (id) => getAgent(id)?.procs.list() || []);
handle('proc:stop', (id, pid) => getAgent(id)?.procs.stop(pid));
handle('proc:output', (id, pid) => getAgent(id)?.procs.get(pid)?.output.slice(-200000) || '');

// ---------- git ----------
handle('git:status', (root) => git.status(root));
handle('git:versions', (root, rel) => git.fileVersions(root, rel));
handle('git:log', (root) => git.log(root));
handle('git:init', (root) => git.init(root));
handle('git:commit', async (root, message) => { try { return { ok: true, summary: await git.commit(root, message) }; } catch (e) { return { error: (e.stderr || e.message).trim().slice(0, 500) }; } });
handle('git:message', async (root, model) => {
  try {
    const diff = await git.diffText(root);
    if (!diff.trim()) return { error: 'No changes to describe.' };
    const text = await providers.complete({
      model, deps,
      system: 'You write git commit messages. Output ONLY the message: a concise imperative subject line (max 72 chars), a blank line, then 1-5 short bullet points explaining what changed and why. No code fences.',
      prompt: `Write a commit message for this diff:\n\n${diff}`,
    });
    return { message: text.replace(/^```\w*\n?|```$/g, '').trim() };
  } catch (e) { return { error: providers.friendlyError(e, model).message }; }
});

app.whenReady().then(() => {
  app.setAppUserModelId('dev.drops.agent');
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { for (const a of agents.values()) a.dispose(); mcp.closeAll().finally(() => app.quit()); });
app.whenReady().then(() => syncMcp().catch(() => {}));
app.whenReady().then(() => setTimeout(() => scheduler.start(), 5000));

// ---------- crash reports ----------
handle('crash:last', () => {
  // Reports since the user last looked, for the notice at start (the unclean-exit one first).
  const seen = store.getSettings().crashSeenAt || 0;
  const recent = crash.list(seen);
  if (!recent.length) return null;
  const main = recent.find((r) => r.kind === 'unclean-exit') || recent[0];
  return { count: recent.length, kind: main.kind, message: main.message, at: main.at, previous: !!previousCrash };
});
handle('crash:seen', () => { store.setSettings({ crashSeenAt: Date.now() }); return true; });
handle('crash:openFolder', () => shell.openPath(crash.dir()));
handle('crash:renderer', (info) => { crash.record('window-error', { message: String(info?.message || '').slice(0, 2000), stack: String(info?.stack || '').slice(0, 8000) }); return true; });

// ---------- update check (reads GitHub releases; installing stays the user's choice) ----------
const update = require('./update');
let lastUpdate = null;
async function checkUpdate(manual = false) {
  try {
    const r = await update.check(app.getVersion());
    lastUpdate = r;
    const st = store.getSettings();
    if (r.available && (manual || st.updateDismissed !== r.version) && win && !win.isDestroyed()) win.webContents.send('update:available', r);
    return r;
  } catch (e) { return { available: false, error: e.message }; }
}
app.whenReady().then(() => {
  const auto = () => { if (store.getSettings().updateCheck !== false) checkUpdate(false); };
  setTimeout(auto, 20_000);
  setInterval(auto, 24 * 3600_000).unref?.();
});
handle('update:check', () => checkUpdate(true));
handle('update:open', (url) => { const u = String(url || lastUpdate?.url || ''); if (/^https:\/\/github\.com\/Clipping771\/DROPs\//.test(u)) shell.openExternal(u); return true; });
handle('update:dismiss', (version) => { store.setSettings({ updateDismissed: String(version || '') }); return true; });
handle('schedule:list', () => scheduleList());
handle('schedule:save', (input) => { try { return saveSchedule(input || {}); } catch (e) { return { error: e.message }; } });
handle('schedule:delete', (id) => deleteSchedule(id));
handle('schedule:runNow', async (id) => {
  const list = store.getSettings().schedules || [];
  const s = list.find((x) => x.id === id);
  if (!s) return { error: 'No such scheduled task.' };
  try { await runSchedule(s); s.lastRun = Date.now(); writeSchedules(list); return { ok: true }; } catch (e) { return { error: e.message }; }
});
