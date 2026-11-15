const test = require('node:test');
const assert = require('node:assert');
const { parseArgs } = require('../src/args');
test('long forms', () => assert.deepStrictEqual(parseArgs(['--a=1', '--b', 'x', '--c', '--no-d']), { flags: { a: '1', b: 'x', c: true, d: false }, positional: [] }));
test('short forms', () => assert.deepStrictEqual(parseArgs(['-xy', '-o', 'out.txt', 'file']), { flags: { x: true, y: true, o: 'out.txt' }, positional: ['file'] }));
test('double dash', () => assert.deepStrictEqual(parseArgs(['--v', '--', '--not-a-flag', '-z']), { flags: { v: true }, positional: ['--not-a-flag', '-z'] }));
