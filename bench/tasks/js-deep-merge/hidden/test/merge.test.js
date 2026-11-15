const test = require('node:test');
const assert = require('node:assert');
const { deepMerge } = require('../src/merge');
test('recursive', () => assert.deepStrictEqual(deepMerge({ a: { x: 1, y: 2 }, b: 1 }, { a: { y: 3 } }), { a: { x: 1, y: 3 }, b: 1 }));
test('arrays replace', () => assert.deepStrictEqual(deepMerge({ list: [1, 2] }, { list: [3] }), { list: [3] }));
test('undefined ignored, null kept', () => assert.deepStrictEqual(deepMerge({ a: 1, b: 2 }, { a: undefined, b: null }), { a: 1, b: null }));
test('no mutation', () => { const b = { a: { x: 1 } }; const o = { a: { y: 2 } }; deepMerge(b, o); assert.deepStrictEqual(b, { a: { x: 1 } }); assert.deepStrictEqual(o, { a: { y: 2 } }); });
