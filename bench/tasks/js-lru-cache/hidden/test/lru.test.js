const test = require('node:test');
const assert = require('node:assert');
const { LRUCache } = require('../src/lru');
test('evicts least recently used', () => {
  const c = new LRUCache(2);
  c.set('a', 1); c.set('b', 2); assert.strictEqual(c.get('a'), 1);
  c.set('c', 3);
  assert.strictEqual(c.get('b'), undefined); assert.strictEqual(c.get('a'), 1); assert.strictEqual(c.get('c'), 3); assert.strictEqual(c.size, 2);
});
test('updating a key refreshes it', () => {
  const c = new LRUCache(2);
  c.set('a', 1); c.set('b', 2); c.set('a', 10); c.set('c', 3);
  assert.strictEqual(c.get('a'), 10); assert.strictEqual(c.get('b'), undefined);
});
test('falsy values are stored', () => { const c = new LRUCache(1); c.set('z', 0); assert.strictEqual(c.get('z'), 0); });
