// Regression for a real Mode-B finding: the suggested-journal path stored
// engineFigures.fxRate as EUR-per-foreign-unit (PLN ~0.24095, "multiply") while
// the typed-event path (composeDraft) stores foreign-per-EUR (PLN ~4.15, "divide").
// Same currency + date, opposite conventions — a reader of fxRate can't trust it.
// The canonical convention (ECB table + composeDraft) is foreign-per-EUR, where
//   functionalAmount === originalAmount / fxRate.
// functionalFromEurPerUnit must produce a stored rate that honours that invariant.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { functionalFromEurPerUnit } from './functional';

test('converts a foreign amount to EUR using EUR-per-unit', () => {
  const r = functionalFromEurPerUnit(250000, 0.24095);
  assert.equal(r.functionalAmount, 60237.5);
});

test('stores fxRate in the canonical foreign-per-EUR convention (matches composeDraft)', () => {
  const r = functionalFromEurPerUnit(250000, 0.24095);
  // foreign-per-EUR ~ 4.15, NOT the raw 0.24095
  assert.ok(r.fxRate > 4 && r.fxRate < 4.3, `expected ~4.15 foreign-per-EUR, got ${r.fxRate}`);
  // The defining invariant: original / fxRate === functionalAmount.
  assert.ok(Math.abs(250000 / r.fxRate - r.functionalAmount) < 0.01);
});

test('a zero/invalid rate yields no conversion and a zero stored rate (no divide-by-zero)', () => {
  const r = functionalFromEurPerUnit(1000, 0);
  assert.equal(r.fxRate, 0);
  assert.equal(r.functionalAmount, 0);
});
