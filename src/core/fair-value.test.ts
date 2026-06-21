import test from 'node:test';
import assert from 'node:assert/strict';
import { composeFairValueRemeasurement } from './fair-value';

function balanced(lines: { amount: number }[]): boolean {
  return Math.abs(lines.reduce((s, l) => s + l.amount, 0)) < 0.01;
}

test('composeFairValueRemeasurement — trap T7 FVTPL', async (t) => {
  await t.test('uplift debits the investment and credits P&L (gain)', () => {
    const r = composeFairValueRemeasurement({ controlCode: '030-gamivo', investeeName: 'Gamivo', carrying: 1000, fairValue: 1500 });
    assert.equal(r.movement, 500);
    assert.equal(r.direction, 'GAIN');
    const inv = r.lines.find((l) => l.accountCode === '030-gamivo')!;
    const pl = r.lines.find((l) => l.accountCode === '710')!;
    assert.equal(inv.amount, 500); // debit (asset up)
    assert.equal(pl.amount, -500); // credit (gain)
    assert.ok(balanced(r.lines));
  });

  await t.test('writedown credits the investment and debits P&L (loss)', () => {
    const r = composeFairValueRemeasurement({ controlCode: '030-rma', investeeName: 'RemoteMyApp', carrying: 1000, fairValue: 0 });
    assert.equal(r.movement, -1000);
    assert.equal(r.direction, 'LOSS');
    const inv = r.lines.find((l) => l.accountCode === '030-rma')!;
    const pl = r.lines.find((l) => l.accountCode === '710')!;
    assert.equal(inv.amount, -1000); // credit (asset down)
    assert.equal(pl.amount, 1000); // debit (loss)
    assert.ok(balanced(r.lines));
  });

  await t.test('no movement when fair value equals carrying', () => {
    const r = composeFairValueRemeasurement({ controlCode: '030-x', investeeName: 'X', carrying: 500, fairValue: 500 });
    assert.equal(r.movement, 0);
    assert.equal(r.direction, 'NONE');
    assert.ok(balanced(r.lines));
  });

  await t.test('the canonical AK-2 total nets to −€128,074.06 across cost/fair value', () => {
    // fair value 1,279,911.45 vs cost 1,407,985.51 → −128,074.06 movement to P&L.
    const r = composeFairValueRemeasurement({ controlCode: '030', investeeName: 'Portfolio', carrying: 1407985.51, fairValue: 1279911.45 });
    assert.equal(r.movement, -128074.06);
    assert.ok(balanced(r.lines));
  });
});
