import test from 'node:test';
import assert from 'node:assert/strict';
import { findNetZeroPairs } from './net-zero';

test('findNetZeroPairs — trap T13 PCC deducted then refunded', async (t) => {
  await t.test('matches a −2,730 PCC charge with its +2,730 refund (PKO scenario)', () => {
    const pairs = findNetZeroPairs([
      { id: 'a', date: '2021-04-10', amount: -2730, description: 'PCC podatek Anastazja Pisula' },
      { id: 'b', date: '2021-04-25', amount: 2730, description: 'Zwrot PCC Anastazja Pisula' },
      { id: 'c', date: '2021-04-12', amount: -100, description: 'Oplata' },
    ]);
    assert.equal(pairs.length, 1);
    assert.equal(pairs[0].chargeId, 'a');
    assert.equal(pairs[0].refundId, 'b');
    assert.equal(pairs[0].amount, 2730);
  });

  await t.test('does NOT pair two same-sign charges (no double-credit)', () => {
    const pairs = findNetZeroPairs([
      { id: 'a', date: '2021-04-10', amount: -2730, description: 'PCC tax' },
      { id: 'b', date: '2021-04-11', amount: -2730, description: 'PCC tax' },
    ]);
    assert.equal(pairs.length, 0);
  });

  await t.test('does NOT pair opposite amounts with no refund/tax signal', () => {
    const pairs = findNetZeroPairs([
      { id: 'a', date: '2021-04-10', amount: -500, description: 'Payment to supplier' },
      { id: 'b', date: '2021-04-11', amount: 500, description: 'Customer receipt' },
    ]);
    assert.equal(pairs.length, 0);
  });

  await t.test('respects the time window (refund 90 days later is not auto-paired)', () => {
    const pairs = findNetZeroPairs([
      { id: 'a', date: '2021-01-10', amount: -2730, description: 'PCC tax' },
      { id: 'b', date: '2021-06-10', amount: 2730, description: 'PCC refund' },
    ]);
    assert.equal(pairs.length, 0);
  });

  await t.test('each transaction is used at most once', () => {
    const pairs = findNetZeroPairs([
      { id: 'a', date: '2021-04-10', amount: -2730, description: 'PCC tax' },
      { id: 'b', date: '2021-04-12', amount: 2730, description: 'PCC refund' },
      { id: 'c', date: '2021-04-13', amount: 2730, description: 'PCC refund again' },
    ]);
    assert.equal(pairs.length, 1);
  });
});
