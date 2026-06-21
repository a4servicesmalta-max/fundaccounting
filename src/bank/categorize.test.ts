import test from 'node:test';
import assert from 'node:assert/strict';
import { categorizeTransaction } from './categorize';
import { accountName } from '../core/chart';

test('bank charge -> 6300 at high confidence', () => {
  const r = categorizeTransaction({ description: 'Monthly bank charge', amount: -12 });
  assert.equal(r.code, '6300');
  assert.equal(r.name, accountName('6300'));
  assert.ok(r.confidence >= 0.75);
});

test('fee / commission -> 6300', () => {
  assert.equal(categorizeTransaction({ description: 'Wire transfer FEE', amount: -5 }).code, '6300');
  assert.equal(categorizeTransaction({ description: 'FX commission', amount: -3 }).code, '6300');
});

test('interest -> 6400', () => {
  const r = categorizeTransaction({ description: 'Loan interest payment', amount: -100 });
  assert.equal(r.code, '6400');
  assert.ok(r.confidence >= 0.75);
});

test('interest is interest even when the word "charged" appears (not a bank charge)', () => {
  // Regression: "Interest charged" contains the substring "charge", which used
  // to route it to 6300 (Bank charges). Interest is interest expense (6400).
  assert.equal(categorizeTransaction({ description: 'Interest charged', amount: -120 }).code, '6400');
  assert.equal(categorizeTransaction({ description: 'Overdraft interest charged this month', amount: -45 }).code, '6400');
  // A genuine bank charge with no interest word still routes to 6300.
  assert.equal(categorizeTransaction({ description: 'Account service charge', amount: -10 }).code, '6300');
});

test('rent -> 6000', () => {
  assert.equal(categorizeTransaction({ description: 'Office RENT March', amount: -2000 }).code, '6000');
});

test('salary / payroll / wages -> 6500', () => {
  assert.equal(categorizeTransaction({ description: 'Salary run', amount: -5000 }).code, '6500');
  assert.equal(categorizeTransaction({ description: 'PAYROLL', amount: -5000 }).code, '6500');
  assert.equal(categorizeTransaction({ description: 'staff wages', amount: -5000 }).code, '6500');
});

test('legal / notary / audit / accounting -> 6100', () => {
  assert.equal(categorizeTransaction({ description: 'Legal advice', amount: -800 }).code, '6100');
  assert.equal(categorizeTransaction({ description: 'Notary deed', amount: -300 }).code, '6100');
  assert.equal(categorizeTransaction({ description: 'Annual audit fee', amount: -1500 }).code, '6100');
});

test('dividend / distribution received (amount>0) -> 4000', () => {
  assert.equal(categorizeTransaction({ description: 'Dividend received', amount: 1000 }).code, '4000');
  assert.equal(categorizeTransaction({ description: 'Distribution', amount: 500 }).code, '4000');
});

test('unknown description -> 9999 suspense at low confidence (0.2)', () => {
  const r = categorizeTransaction({ description: 'POS purchase XYZ', amount: -42 });
  assert.equal(r.code, '9999');
  assert.equal(r.confidence, 0.2);
  assert.ok(r.confidence < 0.75); // -> REVIEW in ingest
});

test('confidence drives the AUTO vs REVIEW boundary (>=0.75 AUTO)', () => {
  // High-confidence rules clear the 0.75 AUTO threshold; suspense does not.
  assert.ok(categorizeTransaction({ description: 'bank charge', amount: -1 }).confidence >= 0.75);
  assert.ok(categorizeTransaction({ description: 'mystery', amount: -1 }).confidence < 0.75);
});

// --- Polish (Santander) + other EU-language coverage ------------------------

test('PL: account maintenance / transfer fees -> 6300', () => {
  // Opłata za prowadzenie rachunku (account maintenance fee)
  const r = categorizeTransaction({ description: 'Opłata za prowadzenie rachunku', amount: -25 });
  assert.equal(r.code, '6300');
  assert.ok(r.confidence >= 0.75); // -> AUTO
  // Opłata za Przelew ELIXIR / Opłata za przelew (transfer fee)
  assert.equal(categorizeTransaction({ description: 'Opłata za Przelew ELIXIR', amount: -1 }).code, '6300');
  assert.equal(categorizeTransaction({ description: 'Opłata za przelew', amount: -1 }).code, '6300');
});

test('PL: prowizja (commission) -> 6300', () => {
  assert.equal(categorizeTransaction({ description: 'Prowizja', amount: -3 }).code, '6300');
});

test('PL: odsetki (interest) -> 6400', () => {
  const r = categorizeTransaction({ description: 'Odsetki', amount: -10 });
  assert.equal(r.code, '6400');
  assert.ok(r.confidence >= 0.75);
});

test('PL: czynsz / najem (rent) -> 6000', () => {
  assert.equal(categorizeTransaction({ description: 'Czynsz za biuro', amount: -2000 }).code, '6000');
  assert.equal(categorizeTransaction({ description: 'Najem lokalu', amount: -2000 }).code, '6000');
});

test('PL: wynagrodzenie / pensja / płaca (salary) -> 6500', () => {
  assert.equal(categorizeTransaction({ description: 'Wynagrodzenie', amount: -5000 }).code, '6500');
  assert.equal(categorizeTransaction({ description: 'Pensja', amount: -5000 }).code, '6500');
  assert.equal(categorizeTransaction({ description: 'Płaca', amount: -5000 }).code, '6500');
});

test('PL: dywidenda (dividend, amount>0) -> 4000', () => {
  assert.equal(categorizeTransaction({ description: 'Dywidenda', amount: 1000 }).code, '4000');
  // Outflow must NOT be income.
  assert.equal(categorizeTransaction({ description: 'Dywidenda', amount: -1000 }).code, '9999');
});

test('PL: podatek / VAT stay 9999 (ambiguous, do not force a wrong account)', () => {
  assert.equal(categorizeTransaction({ description: 'Podatek dochodowy', amount: -800 }).code, '9999');
  assert.equal(categorizeTransaction({ description: 'Przelew VAT', amount: -800 }).code, '9999');
});

test('bare Przelew / Transfer with no other keyword stays 9999', () => {
  assert.equal(categorizeTransaction({ description: 'Przelew', amount: -100 }).code, '9999');
  assert.equal(categorizeTransaction({ description: 'Transfer', amount: -100 }).code, '9999');
});

test('DE / FR fee + interest keywords', () => {
  assert.equal(categorizeTransaction({ description: 'Gebühr', amount: -2 }).code, '6300');
  assert.equal(categorizeTransaction({ description: 'Zinsen', amount: -2 }).code, '6400');
  assert.equal(categorizeTransaction({ description: 'frais de virement', amount: -2 }).code, '6300');
  assert.equal(categorizeTransaction({ description: 'intérêts', amount: -2 }).code, '6400');
});

test('materiality guard: a material "fee" is NOT booked as a bank charge', () => {
  // A genuine small fee → 6300.
  const small = categorizeTransaction({ description: 'Wire transfer fee', amount: -25 });
  assert.equal(small.code, '6300');
  // A €5.88m "Wire transfer fee" is a payment, not a fee → suspense for review.
  const huge = categorizeTransaction({ description: 'Credit Traffic Payment Wire transfer fee USD', amount: -5878037.14 });
  assert.equal(huge.code, '9999');
  assert.ok(huge.confidence <= 0.3);
});
