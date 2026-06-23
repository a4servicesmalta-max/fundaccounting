// Regression: a PARTIAL disposal of a holding whose unit count isn't on the books
// (e.g. an imported opening balance, which carries EUR carrying but no share count)
// silently released the FULL carrying cost — disposalCarryingCost can't proportion
// when unitsHeld is 0, so it falls back to the whole position — and produced NO review
// flag. A stated "sold 300 units" against an unknown holding size is ambiguous (could
// be partial), so the draft must be held for review, not bulk-approved.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessDisposalCarrying } from './positions';

test('disposal of a holding with no recorded unit count FORCES review', () => {
  const a = assessDisposalCarrying('DISPOSAL', 300, 0, 100000, 100000);
  assert.equal(a.forceReview, true);
  assert.match(a.note ?? '', /unit count isn't recorded|opening balance/i);
});

test('partial disposal with known units is informational only (no forced review)', () => {
  const a = assessDisposalCarrying('DISPOSAL', 300, 1000, 100000, 30000);
  assert.equal(a.forceReview, false);
  assert.match(a.note ?? '', /Partial disposal/);
});

test('full disposal with known units: no note, no forced review', () => {
  const a = assessDisposalCarrying('DISPOSAL', 500, 500, 80000, 80000);
  assert.equal(a.note, null);
  assert.equal(a.forceReview, false);
});

test('full disposal with no stated quantity is the normal path: no flag', () => {
  const a = assessDisposalCarrying('DISPOSAL', null, 0, 90000, 90000);
  assert.equal(a.note, null);
  assert.equal(a.forceReview, false);
});

test('nil carrying is flagged for review but not forced (already handled upstream)', () => {
  const a = assessDisposalCarrying('DISPOSAL', 100, 0, 0, 0);
  assert.equal(a.forceReview, false);
  assert.match(a.note ?? '', /0\/unknown|review/i);
});

test('a WRITE_OFF removes the whole position and is never flagged as ambiguous', () => {
  const a = assessDisposalCarrying('WRITE_OFF', null, 0, 50000, 50000);
  assert.equal(a.note, null);
  assert.equal(a.forceReview, false);
});
