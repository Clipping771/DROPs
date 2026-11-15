'use strict';

const assert = require('node:assert/strict');

/**
 * Calculates the factorial of a non-negative integer iteratively.
 * @param {number} n - Non-negative integer up to 170.
 * @returns {number} n!
 */
function factorial(n) {
  if (typeof n !== 'number' || !Number.isFinite(n) || !Number.isInteger(n)) {
    throw new TypeError('Input must be a finite integer');
  }
  if (n < 0) {
    throw new RangeError('Input must be a non-negative integer');
  }
  if (n > 170) {
    throw new RangeError('Input exceeds maximum safe factorial (170)');
  }

  let result = 1;
  for (let i = 2; i <= n; i++) {
    result *= i;
  }
  return result;
}

if (require.main === module) {
  assert.equal(factorial(0), 1);
  assert.equal(factorial(1), 1);
  assert.equal(factorial(5), 120);

  assert.throws(() => factorial(-1), RangeError);
  assert.throws(() => factorial(171), RangeError);
  assert.throws(() => factorial(3.5), TypeError);
  assert.throws(() => factorial('5'), TypeError);
  assert.throws(() => factorial(NaN), TypeError);

  console.log(`factorial(5) = ${factorial(5)}`);
  console.log('All factorial calculation and validation assertions passed.');
}

module.exports = { factorial };
