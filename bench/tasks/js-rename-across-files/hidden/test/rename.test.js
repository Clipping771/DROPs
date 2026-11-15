const test = require('node:test');
const assert = require('node:assert');
const { getUser } = require('../src/users');
const { handle } = require('../src/api');
const { names } = require('../src/report');
test('getUser', () => assert.strictEqual(getUser(1).name, 'Ada'));
test('api', () => { assert.strictEqual(handle({ id: '2' }).body.name, 'Linus'); assert.strictEqual(handle({ id: '9' }).status, 404); });
test('report', () => assert.deepStrictEqual(names([1, 2, 3]), ['Ada', 'Linus']));
