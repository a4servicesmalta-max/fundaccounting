// Regression: the dashboard "cash" KPI matched cash accounts by the name /bank|cash/,
// which also matched 6300 "Bank charges" (an EXPENSE) — so a bank charge's expense leg
// was counted as cash, cancelling its real cash outflow and overstating cash.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isCashLine } from './report';

test('standard bank/cash codes are cash', () => {
  assert.equal(isCashLine('1010', 'Bank'), true);
  assert.equal(isCashLine('1011', 'Bank EUR account'), true);
});

test('an expense named "Bank charges" (6300) is NOT cash', () => {
  assert.equal(isCashLine('6300', 'Bank charges'), false);
  assert.equal(isCashLine('6400', 'Interest expense'), false);
  assert.equal(isCashLine('4000', 'Investment income'), false);
});

test('a custom cash/bank account in the 1xxx asset range IS cash', () => {
  assert.equal(isCashLine('1050', 'Cash float'), true);
  assert.equal(isCashLine('130', 'Petty cash'), true);
  // …but only when the name actually says bank/cash.
  assert.equal(isCashLine('1100', 'Accounts receivable'), false);
});
