// THCP's documents are EN / Polish / German (and sometimes IT/FR). The model can
// echo the source wording in the eventType label. An unmapped foreign label with a
// share/loan signal used to fall to the signal inference and default to ACQUISITION
// — so an Italian "cessione di azioni" (disposal) or a German "rückzahlung"
// (repayment) was booked as an acquisition (WRONG direction). The eventType LABEL
// is the model's explicit direction call, so it is mapped by multilingual keyword.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeIntakeObject } from './intake-parse';

const et = (eventType: string, extra: Record<string, unknown> = {}) =>
  (normalizeIntakeObject({ kind: 'EVENT', eventType, investee: 'X', quantity: 10, amount: 10000, currency: 'EUR', ...extra }) as { eventType?: string }).eventType;

test('Italian labels map by meaning', () => {
  assert.equal(et('cessione di azioni'), 'DISPOSAL');
  assert.equal(et('vendita azioni'), 'DISPOSAL');
  assert.equal(et('aumento di capitale'), 'ACQUISITION');
  assert.equal(et('dividendo'), 'DISTRIBUTION');
});

test('German labels map by meaning', () => {
  assert.equal(et('darlehensrückzahlung', { principal: 10000 }), 'LOAN_REPAYMENT');
  assert.equal(et('kapitalerhöhung'), 'ACQUISITION');
  assert.equal(et('dividende'), 'DISTRIBUTION');
});

test('French labels map by meaning', () => {
  assert.equal(et('remboursement', { principal: 10000 }), 'LOAN_REPAYMENT');
  assert.equal(et('cession actions'), 'DISPOSAL');
  assert.equal(et('dividende'), 'DISTRIBUTION');
});

test('Polish labels map by meaning', () => {
  assert.equal(et('spłata pożyczki', { principal: 10000 }), 'LOAN_REPAYMENT');
  assert.equal(et('umorzenie udziałów'), 'DISPOSAL');
  assert.equal(et('dywidenda'), 'DISTRIBUTION');
});

test('an English purchase label is NOT flipped to disposal by a stray word', () => {
  assert.equal(et('share purchase agreement'), 'ACQUISITION');
  assert.equal(et('ACQUISITION'), 'ACQUISITION');
});
