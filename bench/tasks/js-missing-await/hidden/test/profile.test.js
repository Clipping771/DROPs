const test = require('node:test');
const assert = require('node:assert');
const { loadProfile } = require('../src/profile');
test('returns display name', async () => assert.strictEqual(await loadProfile(1), 'Ada Lovelace'));
test('propagates errors', async () => assert.rejects(loadProfile(99), /not found/));
