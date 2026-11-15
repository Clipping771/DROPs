const test = require('node:test');
const assert = require('node:assert');
const { slugify } = require('../src/slugify');
test('basic', () => assert.strictEqual(slugify('Hello World'), 'hello-world'));
test('accents', () => assert.strictEqual(slugify('Crème Brûlée à la mode'), 'creme-brulee-a-la-mode'));
test('runs and edges', () => assert.strictEqual(slugify('  --Rock & Roll!!  '), 'rock-roll'));
test('numbers kept', () => assert.strictEqual(slugify('Top 10 Tips (2026)'), 'top-10-tips-2026'));
test('empty', () => assert.strictEqual(slugify('!!!'), ''));
