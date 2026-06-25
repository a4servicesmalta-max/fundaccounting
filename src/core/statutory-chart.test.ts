// THCP's books use the Polish/continental statutory chart (the source workbook
// "THCP MT 'acc. books_2024_12"). Its digit convention differs from the app's
// internal chart: 4xx = costs (expense), 75x = revenue, 240 = receivables (asset),
// 64x/840 = accrued expenses/provisions (liabilities), 5xx = liabilities, 8xx =
// equity. A leading-digit heuristic tuned to the app chart misclassifies these,
// so the balance sheet and P&L come out wrong even though the trial balance ties.
//
// resolveAccountType is the single resolver the reports use: built-in registry
// first, then the statutory overlay, then the digit fallback. These tests pin the
// correct classification for both charts so neither breaks the other.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveAccountType } from './chart-store';

test('THCP receivables (240 family) are assets, not liabilities', () => {
  assert.equal(resolveAccountType('240'), 'ASSET');
  assert.equal(resolveAccountType('240-OD'), 'ASSET');
  assert.equal(resolveAccountType('240-GCM'), 'ASSET');
  assert.equal(resolveAccountType('240-WP2'), 'ASSET');
});

test('THCP accrued expenses / provisions / short-term liabilities are liabilities', () => {
  assert.equal(resolveAccountType('64-AE'), 'LIABILITY'); // Accrued expenses THCP
  assert.equal(resolveAccountType('64-AE-O'), 'LIABILITY'); // Accrued expenses other
  assert.equal(resolveAccountType('840'), 'LIABILITY'); // Provisions and deferred income
  assert.equal(resolveAccountType('500'), 'LIABILITY'); // Short-term liabilities
  assert.equal(resolveAccountType('501'), 'LIABILITY'); // Accruals
});

test('THCP capital accounts are equity', () => {
  assert.equal(resolveAccountType('801'), 'EQUITY');
  assert.equal(resolveAccountType('802'), 'EQUITY');
  assert.equal(resolveAccountType('860'), 'EQUITY');
});

test('THCP revenue lines (75x, EXCH-P) classify as revenue', () => {
  assert.equal(resolveAccountType('750-1'), 'REVENUE'); // Revenues from sales of shares
  assert.equal(resolveAccountType('750-2'), 'REVENUE'); // Dividends
  assert.equal(resolveAccountType('750-3'), 'REVENUE'); // Interests
  assert.equal(resolveAccountType('EXCH-P'), 'REVENUE'); // Other financial profit
});

test('THCP cost lines (4xx, 751, EXCH-L, W-O) classify as expense', () => {
  assert.equal(resolveAccountType('751'), 'EXPENSE'); // Cost of shares disposal
  assert.equal(resolveAccountType('EXCH-L'), 'EXPENSE'); // Exchange loss
  assert.equal(resolveAccountType('W-O'), 'EXPENSE'); // Write-off
  assert.equal(resolveAccountType('402'), 'EXPENSE'); // Legal & professional fees
  assert.equal(resolveAccountType('402-THCP'), 'EXPENSE');
  assert.equal(resolveAccountType('403'), 'EXPENSE'); // Taxes
  assert.equal(resolveAccountType('409'), 'EXPENSE'); // Other costs
});

test('investment controls and cash remain assets', () => {
  assert.equal(resolveAccountType('030'), 'ASSET');
  assert.equal(resolveAccountType('032'), 'ASSET');
  assert.equal(resolveAccountType('032-1'), 'ASSET');
  assert.equal(resolveAccountType('130'), 'ASSET');
  assert.equal(resolveAccountType('101'), 'ASSET');
});

test('app internal chart still classifies by its own convention', () => {
  // App codes resolve via the built-in registry and must not be broken by the overlay.
  assert.equal(resolveAccountType('1010'), 'ASSET'); // Bank
  assert.equal(resolveAccountType('4000'), 'REVENUE'); // Investment income (app)
  assert.equal(resolveAccountType('510'), 'REVENUE'); // Loan interest income (app)
  assert.equal(resolveAccountType('6100'), 'EXPENSE'); // Legal & professional (app)
  assert.equal(resolveAccountType('6800'), 'EXPENSE'); // FX (app)
  assert.equal(resolveAccountType('2010'), 'LIABILITY'); // Accounts payable (app)
});

test('realised disposal gain no longer collides with statutory short-term liabilities (500)', () => {
  // The engine posts realised gains to 750-1 (statutory revenue), not 500 — so an
  // imported 500 short-term-liability balance is never mixed with disposal gains.
  assert.equal(resolveAccountType('750-1'), 'REVENUE');
  assert.equal(resolveAccountType('500'), 'LIABILITY');
});
