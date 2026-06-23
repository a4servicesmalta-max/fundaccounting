// Regression: the Overview allocation percentages were internally inconsistent and
// summed to 101%, not 100%. The NAV denominator holds equity at valuation (revalued)
// but LOANS at carrying amount (loans are kept at carrying, not retranslated). The
// allocation numerator, however, used `revalued` for EVERY holding — including loans,
// whose revaluedValue is now populated for foreign-currency positions. So a GBP loan's
// slice was computed on a revalued basis against a carrying-basis NAV, overstating it
// and breaking the 100% sum. The numerator basis MUST match the NAV basis: equity at
// valuation, loans at carrying.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { navAllocation } from './report';

test('allocation numerator matches the NAV basis: equity revalued, loan at carrying', () => {
  // Mirrors the live mixed-currency book: EUR equity (par), USD equity (revalued up),
  // GBP loan (carrying 59,395; revalued 60,240.96 — must be IGNORED for allocation).
  const holdings = [
    { name: 'Ormco Industries plc', kind: 'LOAN', value: 59395, revalued: 60240.96 },
    { name: 'Borealis Ventures LLC', kind: 'EQUITY', value: 18441.6, revalued: 19047.62 },
    { name: 'Gamivo Holdings Ltd', kind: 'EQUITY', value: 5000, revalued: 5000 },
  ];
  // NAV the app reports = equityValuation (revalued) + loansValue (carrying).
  const nav = 19047.62 + 5000 + 59395; // 83,442.62

  const alloc = navAllocation(holdings, nav);

  // Loan uses CARRYING (not revalued); equity uses revalued.
  assert.equal(alloc.find((a) => a.name === 'Ormco Industries plc')!.value, 59395);
  assert.equal(alloc.find((a) => a.name === 'Borealis Ventures LLC')!.value, 19047.62);
  assert.equal(alloc.find((a) => a.name === 'Gamivo Holdings Ltd')!.value, 5000);

  // The numerators sum exactly to NAV, so percentages sum to ~100 (not 101).
  const valueSum = alloc.reduce((s, a) => s + a.value, 0);
  assert.ok(Math.abs(valueSum - nav) < 0.01, `numerators ${valueSum} should equal NAV ${nav}`);
  const pctSum = alloc.reduce((s, a) => s + a.pct, 0);
  assert.ok(Math.abs(pctSum - 100) <= 0.1, `pct sum ${pctSum} should be ~100`);
});

test('equity with no revaluation falls back to carrying; nav=0 yields 0%', () => {
  const holdings = [{ name: 'X', kind: 'EQUITY', value: 1000, revalued: null }];
  assert.equal(navAllocation(holdings, 1000)[0].value, 1000);
  assert.equal(navAllocation(holdings, 0)[0].pct, 0);
});
