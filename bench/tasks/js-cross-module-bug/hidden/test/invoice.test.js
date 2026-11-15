const test = require('node:test');
const assert = require('node:assert');
const { invoiceTotal } = require('../src/invoice');
const { applyTax } = require('../src/money');
test('invoice total includes tax', () => assert.strictEqual(invoiceTotal([{ qty: 2, price: 10 }], 15), 23));
test('applyTax uses percent', () => { assert.strictEqual(applyTax(100, 7.5), 7.5); assert.strictEqual(applyTax(19.99, 15), 3); });
