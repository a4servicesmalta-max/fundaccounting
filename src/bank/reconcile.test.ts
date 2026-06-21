import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileAccount, type ReconTxn, type ReconStatement } from './reconcile';

const stmt = (opening: number, closing: number, periodEnd = '2021-12-31'): ReconStatement => ({
  openingBalance: opening,
  closingBalance: closing,
  periodEnd,
});

function tx(over: Partial<ReconTxn>): ReconTxn {
  return {
    id: Math.random().toString(36).slice(2),
    date: '2021-12-10',
    description: 'x',
    amount: 0,
    status: 'AUTO',
    postToCode: '6300',
    dateFlag: null,
    ...over,
  };
}

test('reconcileAccount — trap T10 GL vs bank', async (t) => {
  await t.test('ties when every line is posted', () => {
    const r = reconcileAccount(
      [tx({ amount: 500 }), tx({ amount: -200 })],
      [stmt(0, 300)],
    );
    assert.equal(r.glBalance, 300);
    assert.equal(r.difference, 0);
    assert.equal(r.reconciled, true);
    assert.equal(r.reconcilingItems.length, 0);
  });

  await t.test('a held (impossible-date) line is a reconciling item explaining the gap', () => {
    // Statement closes at -120 (includes the held fee); the books only reflect 0.
    const r = reconcileAccount(
      [tx({ amount: -120, description: '30-Dec maintenance fee', dateFlag: { raw: '2021-12-32' } })],
      [stmt(0, -120)],
    );
    assert.equal(r.glBalance, 0, 'held line not in GL');
    assert.equal(r.difference, -120);
    assert.equal(r.reconciled, false);
    assert.equal(r.reconcilingItems.length, 1);
    assert.equal(r.reconcilingItems[0].reason, 'HELD_IMPOSSIBLE_DATE');
  });

  await t.test('a rejected line is surfaced and explains the difference', () => {
    const r = reconcileAccount(
      [tx({ amount: 1000 }), tx({ amount: -50, status: 'REJECTED' })],
      [stmt(0, 950)],
    );
    assert.equal(r.glBalance, 1000);
    assert.equal(r.difference, -50);
    assert.equal(r.reconcilingItems[0].reason, 'REJECTED');
  });

  await t.test('uncategorised (suspense / review) lines are flagged informationally', () => {
    const r = reconcileAccount(
      [tx({ amount: -300, status: 'REVIEW', postToCode: '9999', description: 'Unknown transfer' })],
      [stmt(0, -300)],
    );
    assert.equal(r.reconciled, true, 'still ties — the line is in the GL');
    assert.equal(r.uncategorised.length, 1);
    assert.equal(r.uncategorised[0].reason, 'UNCATEGORISED');
  });
});
