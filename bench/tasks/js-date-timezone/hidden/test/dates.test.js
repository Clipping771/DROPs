const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const run = (tz, iso) => execFileSync(process.execPath, ['-e', 'console.log(require(' + JSON.stringify(path.join(__dirname, '../src/dates')) + ').formatDue(' + JSON.stringify(iso) + '))'], { env: { ...process.env, TZ: tz } }).toString().trim();
for (const tz of ['America/Los_Angeles', 'UTC', 'Asia/Dhaka', 'Pacific/Kiritimati']) {
  test('same day in ' + tz, () => { assert.strictEqual(run(tz, '2026-03-01'), 'Mar 1, 2026'); assert.strictEqual(run(tz, '2026-12-31'), 'Dec 31, 2026'); });
}
