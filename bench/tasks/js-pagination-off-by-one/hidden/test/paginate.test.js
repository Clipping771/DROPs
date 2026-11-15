const test = require('node:test');
const assert = require('node:assert');
const { paginate, pageCount } = require('../src/paginate');
test('first page', () => assert.deepStrictEqual(paginate([1, 2, 3, 4, 5], 1, 2), [1, 2]));
test('last partial page', () => assert.deepStrictEqual(paginate([1, 2, 3, 4, 5], 3, 2), [5]));
test('page count rounds up', () => { assert.strictEqual(pageCount(5, 2), 3); assert.strictEqual(pageCount(4, 2), 2); assert.strictEqual(pageCount(0, 2), 0); });
