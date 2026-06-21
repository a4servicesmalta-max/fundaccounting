import test from 'node:test';
import assert from 'node:assert/strict';
import { assertControlInvariant, sumPositions } from './invariant';

test('sumPositions totals a position map', () => {
  assert.equal(sumPositions({ a: 1000.5, b: 2000.25 }), 3000.75);
});

test('assertControlInvariant passes when GL equals sum of positions', () => {
  assert.doesNotThrow(() => assertControlInvariant(3000.75, { a: 1000.5, b: 2000.25 }));
});

test('assertControlInvariant tolerates sub-cent rounding', () => {
  assert.doesNotThrow(() => assertControlInvariant(3000.75, { a: 1000.5, b: 2000.2499 }));
});

test('assertControlInvariant throws when GL drifts from positions', () => {
  assert.throws(
    () => assertControlInvariant(3000.75, { a: 1000.5, b: 1900.25 }),
    /control-account invariant/i
  );
});
