// The product name and where its files live. The app was called H2O; the old names keep working so
// nobody loses settings, sessions, lessons or project memory:
//   - environment variables DROPS_* (new) or H2O_* (old)
//   - the app data folder (%APPDATA%\DROPs, or the existing %APPDATA%\H2O)
//   - the home folder ~/.drops (or the existing ~/.h2o)
//   - project files DROPs.md / .drops/ (or the existing H2O.md / .h2o/)
const fs = require('fs');
const os = require('os');
const path = require('path');

const NAME = 'DROPs';
const REPO_URL = 'https://github.com/Clipping771/DROPs';

/** An environment setting by its short name, e.g. env('GEMINI_API_KEY') reads DROPS_GEMINI_API_KEY or H2O_GEMINI_API_KEY. */
const env = (name) => process.env[`DROPS_${name}`] ?? process.env[`H2O_${name}`];

/** The new location unless only the old one exists. */
const pick = (fresh, old) => (!fs.existsSync(fresh) && fs.existsSync(old) ? old : fresh);

/** The desktop app's data folder (settings, saved keys, sessions). */
function appDataDir() {
  const base = process.env.APPDATA || path.join(os.homedir(), '.config');
  return pick(path.join(base, NAME), path.join(base, 'H2O'));
}

/** The per-user folder for lessons and other cross-project files. */
const homeDir = () => pick(path.join(os.homedir(), '.drops'), path.join(os.homedir(), '.h2o'));

/** Project folder names for commands, rules and instructions: new name first. */
const PROJECT_DIRS = ['.drops', '.h2o'];

/** The project memory file: an existing DROPs.md or H2O.md, else DROPs.md. */
function memoryFile(root) {
  for (const f of ['DROPs.md', 'H2O.md']) if (root && fs.existsSync(path.join(root, f))) return f;
  return 'DROPs.md';
}

module.exports = { NAME, REPO_URL, env, appDataDir, homeDir, PROJECT_DIRS, memoryFile };
