const test = require('node:test');
const assert = require('node:assert');
const { isValidEmail } = require('../src/validate');
test('valid', () => { for (const e of ['a@b.co', 'first.last+tag@sub.example.co.uk', 'USER_1@Example.COM', 'x-y@d-e.io']) assert.ok(isValidEmail(e), e); });
test('invalid', () => { for (const e of ['a@b', 'a@@b.com', 'no-at.com', '@b.com', 'a@.com', 'a b@c.com', 'a@b.c', '']) assert.ok(!isValidEmail(e), e); });
