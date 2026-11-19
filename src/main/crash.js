// @ts-check
// Crash reports, kept on this computer only (nothing is uploaded).
// - errors in the main process and the window, and a window or helper that died, become a JSON
//   report in <DROPs data>/crashes (secret values removed, the home folder shown as ~);
// - Electron's native crash dumps stay in its own folder (uploadToServer: false);
// - a run that ended without quitting normally is noticed at the next start, and the window says so.
const fs = require('fs');
const os = require('os');
const path = require('path');

const KEEP = 30;
let dir = null, version = '?', lastKey = '', lastAt = 0;

function clean(text) {
  let t = String(text ?? '');
  try { t = require('./shell').redact(t).text; } catch { /* no redaction module */ }
  const home = os.homedir();
  if (home) t = t.split(home).join('~');
  return t.slice(0, 20000);
}

/** Writes one report. Repeats of the same error within a minute are skipped. */
function record(kind, info = {}) {
  if (!dir) return null;
  const message = clean(info.message || info.reason || kind);
  const key = `${kind}:${message.slice(0, 200)}`;
  if (key === lastKey && Date.now() - lastAt < 60_000) return null;
  lastKey = key; lastAt = Date.now();
  const report = {
    at: new Date().toISOString(), kind, message, stack: info.stack ? clean(info.stack) : undefined,
    details: info.details ? JSON.parse(clean(JSON.stringify(info.details))) : undefined,
    version, electron: process.versions.electron, node: process.versions.node, platform: `${process.platform} ${os.release()} ${process.arch}`,
  };
  try {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${report.at.replace(/[:.]/g, '-')}-${kind}.json`);
    fs.writeFileSync(file, JSON.stringify(report, null, 2));
    // Keep the newest reports only.
    const all = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
    for (const f of all.slice(0, Math.max(0, all.length - KEEP))) fs.rmSync(path.join(dir, f), { force: true });
    return file;
  } catch { return null; }
}

/** Reports newer than `since` (ms), newest first. */
function list(since = 0) {
  if (!dir) return [];
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().reverse(); } catch { return []; }
  return files.map((f) => { try { return { file: path.join(dir, f), ...JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) }; } catch { return null; } })
    .filter((r) => r && Date.parse(r.at) > since);
}

const flagFile = () => path.join(dir, 'running.flag');

/**
 * Starts crash reporting. `app` is Electron's app (or null in tests). Returns the report about an
 * unclean end of the previous run, if there was one.
 */
function init({ dataDir, appVersion, app = null, crashReporter = null, hookProcess = true }) {
  dir = path.join(dataDir, 'crashes'); version = appVersion || '?';
  fs.mkdirSync(dir, { recursive: true });
  let previous = null;
  if (fs.existsSync(flagFile())) {
    let since = 0; try { since = +fs.readFileSync(flagFile(), 'utf8') || 0; } catch { /* unreadable */ }
    previous = record('unclean-exit', { message: 'DROPs did not close normally last time (it crashed, was killed, or the computer shut down).', details: { startedAt: since ? new Date(since).toISOString() : undefined } });
  }
  fs.writeFileSync(flagFile(), String(Date.now()));
  try { crashReporter?.start({ uploadToServer: false, compress: true }); } catch { /* not available */ }
  if (hookProcess) {
    process.on('uncaughtException', (e) => { record('main-error', { message: e?.message || String(e), stack: e?.stack }); });
    process.on('unhandledRejection', (e) => { const err = /** @type {any} */ (e); record('main-rejection', { message: err?.message || String(e), stack: err?.stack }); });
  }
  if (app) {
    app.on('render-process-gone', (_e, _wc, d) => record('window-gone', { message: `The window's process ended: ${d.reason}`, details: d }));
    app.on('child-process-gone', (_e, d) => { if (d.reason !== 'clean-exit' && d.reason !== 'killed') record('helper-gone', { message: `A ${d.type} process ended: ${d.reason}`, details: d }); });
    app.on('will-quit', cleanExit);
  }
  return previous;
}

/** A normal quit: the next start must not report a crash. */
function cleanExit() { try { if (dir) fs.rmSync(flagFile(), { force: true }); } catch { /* gone */ } }

module.exports = { init, record, list, cleanExit, clean, dir: () => dir };
