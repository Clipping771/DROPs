const test = require('node:test');
const assert = require('node:assert');
const { paginate } = require('../src/paginate');
test('first page starts at the first item', () => assert.deepStrictEqual(paginate([1, 2, 3, 4, 5], 1, 2), [1, 2]));
