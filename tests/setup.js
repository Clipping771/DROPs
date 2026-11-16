// Loaded before every test file (npm test: node --import ./tests/setup.js --test …).
// Tests never write into the real DROPs data: settings, sessions, tasks, progress notes and crash reports
// go to a throwaway app data folder, and lessons to a throwaway user folder. A test file that sets its own
// APPDATA keeps it. HOME stays real: git and Electron need it.
const fs = require('fs');
const os = require('os');
const path = require('path');

if (!process.env.DROPS_TEST_REAL_DATA) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drops-test-data-'));
  process.env.APPDATA = path.join(tmp, 'appdata');
  process.env.DROPS_USER_DIR = path.join(tmp, 'user');
  fs.mkdirSync(process.env.APPDATA, { recursive: true });
  fs.mkdirSync(process.env.DROPS_USER_DIR, { recursive: true });
}
