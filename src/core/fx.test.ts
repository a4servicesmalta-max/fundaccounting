import test from 'node:test';
import assert from 'node:assert/strict';
import { findRateForDate, convertToFunctional, convertWithRate, type RatePoint } from './fx';

const rates: RatePoint[] = [
  { currency: 'PLN', rateDate: new Date('2024-12-01'), rate: 4.3 },
  { currency: 'PLN', rateDate: new Date('2024-12-15'), rate: 4.25 },
  { currency: 'USD', rateDate: new Date('2024-12-10'), rate: 1.05 },
];

test('EUR converts 1:1 and rounds to cents', () => {
  assert.equal(convertToFunctional(1000, 'EUR', new Date('2024-12-20'), rates), 1000);
});

test('findRateForDate picks the most recent rate on or before the date', () => {
  const r = findRateForDate(rates, 'PLN', new Date('2024-12-20'));
  assert.equal(r, 4.25);
});

test('findRateForDate ignores rates after the date', () => {
  const r = findRateForDate(rates, 'PLN', new Date('2024-12-10'));
  assert.equal(r, 4.3);
});

test('convertToFunctional divides foreign by rate and rounds to 2dp', () => {
  // 8600 PLN / 4.25 = 2023.529... -> 2023.53
  assert.equal(convertToFunctional(8600, 'PLN', new Date('2024-12-20'), rates), 2023.53);
});

test('convertToFunctional throws when no rate is available', () => {
  assert.throws(
    () => convertToFunctional(100, 'GBP', new Date('2024-12-20'), rates),
    /no FX rate/i
  );
});

test('convertWithRate: EUR returns null rate and rateDate', () => {
  const r = convertWithRate(1000, 'EUR', new Date('2024-12-20'), rates);
  assert.deepEqual(r, { amount: 1000, rate: null, rateDate: null });
});

test('convertWithRate: PLN returns converted amount plus the selected rate/rateDate', () => {
  // selected point: 2024-12-15 @ 4.25; 8600/4.25 = 2023.529... -> 2023.53
  const r = convertWithRate(8600, 'PLN', new Date('2024-12-20'), rates);
  assert.equal(r.amount, 2023.53);
  assert.equal(r.rate, 4.25);
  assert.equal(r.rateDate, '2024-12-15');
});

test('convertWithRate: USD returns the matching rate point', () => {
  const r = convertWithRate(1050, 'USD', new Date('2024-12-20'), rates);
  assert.equal(r.amount, 1000);
  assert.equal(r.rate, 1.05);
  assert.equal(r.rateDate, '2024-12-10');
});

test('convertWithRate: selects the earlier rate point when later ones are after the date', () => {
  // on 2024-12-10 the only eligible PLN point is 2024-12-01 @ 4.3
  const r = convertWithRate(4300, 'PLN', new Date('2024-12-10'), rates);
  assert.equal(r.rate, 4.3);
  assert.equal(r.rateDate, '2024-12-01');
});

test('convertWithRate throws when no rate is available', () => {
  assert.throws(
    () => convertWithRate(100, 'GBP', new Date('2024-12-20'), rates),
    /no FX rate/i
  );
});
