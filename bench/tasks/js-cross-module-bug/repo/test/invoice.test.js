const test = require('node:test');
const assert = require('node:assert');
const { invoiceTotal } = require('../src/invoice');
test('invoice total includes tax', () => assert.strictEqual(invoiceTotal([{ qty: 2, price: 10 }], 15), 23));
