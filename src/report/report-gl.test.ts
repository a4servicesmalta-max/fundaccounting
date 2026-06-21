import test from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';

process.env.AUTOPILOT_DB = path.join(
  os.tmpdir(),
  `thcp-report-gl-${process.pid}-${Math.random().toString(36).slice(2)}.json`,
);

test('trial balance reflects bank + AR/AP and still balances', { concurrency: false }, async (t) => {
  const store = await import('../db/store');
  const { trialBalance, ledger } = await import('./report');
  const { findDuplicate } = await import('../arap/arap-store');

  store.initDb();
  const db = store.getDb();

  // An EUR bank account with a charge categorised to 6300.
  db.bankAccounts.push({ id: 'acc1', bankName: 'BOV', accountRef: 'MT-EUR', currency: 'EUR', createdAt: 'x' } as any);
  db.bankTransactions.push({
    id: 'bt1', bankAccountId: 'acc1', statementId: 's1', date: '2025-04-10', period: '2025-04',
    description: 'Bank charge', amount: -30, balance: null, postToCode: '6300', postToName: 'Bank charges',
    postConfidence: 0.9, status: 'AUTO', matchedDocumentId: null, createdAt: 'x',
  } as any);
  // A EUR payable bill for 420.
  db.arapItems.push({
    id: 'i1', documentId: 'd1', kind: 'PAYABLE', counterparty: 'Ormco', amount: 420, currency: 'EUR',
    issueDate: '2025-04-01', dueDate: '2025-04-15', status: 'OPEN', paidByTxnId: null, docName: 'inv', createdAt: 'x',
  } as any);

  await t.test('trial balance shows the bank + creditor accounts and ties', () => {
    const tb = trialBalance(); // all periods
    const codes = tb.rows.map((r) => r.accountCode);
    assert.ok(codes.includes('1010'), 'bank 1010 present');
    assert.ok(codes.includes('6300'), 'bank charge expense present');
    assert.ok(codes.includes('2010'), 'creditors present');
    assert.ok(codes.includes('6200'), 'default expense present');
    // Debits == credits (within a cent).
    assert.ok(Math.abs(tb.totals.debit - tb.totals.credit) < 0.01, 'TB balances');
    // Creditor 2010 carries the 420 bill as a credit.
    const cr = tb.rows.find((r) => r.accountCode === '2010');
    assert.equal(cr?.credit, 420);
  });

  await t.test('ledger includes the bank + AR/AP lines', () => {
    const l = ledger();
    assert.ok(l.lines.some((x) => x.accountCode === '1010' && x.eventType === 'BANK'));
    assert.ok(l.lines.some((x) => x.accountCode === '2010' && x.eventType === 'ARAP'));
  });

  await t.test('findDuplicate catches the same bill again', () => {
    const dup = findDuplicate({ kind: 'PAYABLE', counterparty: 'ormco', amount: 420, currency: 'eur', issueDate: '2025-04-01', dueDate: null });
    assert.ok(dup);
    const notDup = findDuplicate({ kind: 'PAYABLE', counterparty: 'Ormco', amount: 999, currency: 'EUR', issueDate: '2025-04-01', dueDate: null });
    assert.equal(notDup, null);
  });
});
