// Regression: foreign AR/AP was reported in EUR at the BUNDLED static FX table, not
// the exact-date ECB rate the investment/EVENT path fetches (getDailyRateToEur). A USD
// receivable issued 10 Jan 2025 should translate at that day's ECB spot (IAS 21), the
// same source the bank-settlement leg uses. The rate is now captured at intake and
// stored on the item; arapItemToEur prefers it, falling back to the bundled table only
// for legacy items that predate rate capture.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { arapItemToEur, toEur } from './report';

test('AR/AP conversion prefers the exact-date ECB rate captured at intake', () => {
  // fxRate = EUR per 1 unit of currency (what getDailyRateToEur returns).
  const item = { amount: 10000, currency: 'USD', issueDate: '2025-01-10', dueDate: null, fxRate: 0.97 };
  assert.equal(arapItemToEur(item), 9700);
});

test('a EUR item converts 1:1', () => {
  const item = { amount: 500, currency: 'EUR', issueDate: '2025-01-10', dueDate: null, fxRate: 1 };
  assert.equal(arapItemToEur(item), 500);
});

test('a payable uses its captured rate (sign preserved)', () => {
  const item = { amount: 8000, currency: 'CHF', issueDate: '2025-02-15', dueDate: '2025-03-15', fxRate: 1.06 };
  assert.equal(arapItemToEur(item), 8480);
});

test('a legacy item with no captured rate falls back to the bundled-table conversion', () => {
  const item = { amount: 10000, currency: 'USD', issueDate: '2025-01-10', dueDate: null };
  assert.equal(arapItemToEur(item), toEur(10000, 'USD', '2025-01-10'));
});

test('a non-positive / non-finite captured rate is ignored (falls back to bundled)', () => {
  const z = { amount: 10000, currency: 'USD', issueDate: '2025-01-10', dueDate: null, fxRate: 0 };
  assert.equal(arapItemToEur(z), toEur(10000, 'USD', '2025-01-10'));
});
