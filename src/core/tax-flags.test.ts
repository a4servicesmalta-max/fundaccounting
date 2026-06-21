import test from 'node:test';
import assert from 'node:assert/strict';
import { taxFlagsForDraft, taxFlagsForArap } from './tax-flags';

test('taxFlagsForDraft — trap T8 disposals & dividends', async (t) => {
  await t.test('share disposal → participation exemption + VAT-exempt', () => {
    const f = taxFlagsForDraft({ eventType: 'DISPOSAL', instrument: 'SHARES' });
    const codes = f.map((x) => x.code);
    assert.ok(codes.includes('PARTICIPATION_EXEMPTION'));
    assert.ok(codes.includes('VAT_EXEMPT_SHARE_DEALING'));
  });

  await t.test('distribution/dividend → participation exemption', () => {
    const codes = taxFlagsForDraft({ eventType: 'DISTRIBUTION' }).map((x) => x.code);
    assert.deepEqual(codes, ['PARTICIPATION_EXEMPTION']);
  });

  await t.test('a plain acquisition carries no tax flag', () => {
    assert.equal(taxFlagsForDraft({ eventType: 'ACQUISITION', instrument: 'SHARES' }).length, 0);
  });

  await t.test('flags never compute an amount (advisory only)', () => {
    const f = taxFlagsForDraft({ eventType: 'DISPOSAL', instrument: 'SHARES' });
    for (const flag of f) assert.equal(typeof flag.note, 'string');
  });
});

test('taxFlagsForArap — trap T8 reverse charge', async (t) => {
  await t.test('foreign-currency brokerage bill → reverse charge', () => {
    const f = taxFlagsForArap({ kind: 'PAYABLE', counterparty: 'Dom Maklerski BOŚ S.A.', currency: 'PLN' });
    assert.equal(f[0].code, 'REVERSE_CHARGE');
  });

  await t.test('foreign legal/advisory service bill → reverse charge', () => {
    const f = taxFlagsForArap({ kind: 'PAYABLE', counterparty: 'Cheran Advisory Ltd', currency: 'USD' });
    assert.equal(f[0].code, 'REVERSE_CHARGE');
  });

  await t.test('a domestic EUR goods bill is NOT reverse-charge', () => {
    assert.equal(taxFlagsForArap({ kind: 'PAYABLE', counterparty: 'Office Supplies Malta', currency: 'EUR' }).length, 0);
  });

  await t.test('a receivable is never reverse-charge', () => {
    assert.equal(taxFlagsForArap({ kind: 'RECEIVABLE', counterparty: 'Broker', currency: 'USD' }).length, 0);
  });
});
