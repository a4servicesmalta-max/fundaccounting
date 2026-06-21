import test from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';

// Isolate the DB before the store module loads (it binds its file path at eval).
process.env.AUTOPILOT_DB = path.join(
  os.tmpdir(),
  `thcp-settle-test-${process.pid}-${Math.random().toString(36).slice(2)}.json`,
);

test('settlement against AR/AP', { concurrency: false }, async (t) => {
  const { settleCodeFor, applySettlement, rematchAll } = await import('./settle');
  const store = await import('../db/store');

  await t.test('settleCodeFor maps direction to the control account', () => {
    assert.equal(settleCodeFor('RECEIVABLE'), '1100');
    assert.equal(settleCodeFor('PAYABLE'), '2010');
  });

  await t.test('a receivable receipt posts to 1100 and marks the item PAID', () => {
    const txn: any = { id: 't1', amount: 9000, date: '2021-05-10', description: 'Przelew od Gamivo', postToCode: '9999', status: 'REVIEW', matchedDocumentId: null };
    const item: any = { id: 'i1', documentId: 'doc1', kind: 'RECEIVABLE', counterparty: 'Gamivo', amount: 9000, status: 'OPEN', paidByTxnId: null };
    applySettlement(txn, item);
    assert.equal(txn.postToCode, '1100');
    assert.equal(txn.status, 'AUTO');
    assert.equal(txn.matchedDocumentId, 'doc1');
    assert.equal(item.status, 'PAID');
    assert.equal(item.paidByTxnId, 't1');
  });

  await t.test('a payable payment posts to 2010', () => {
    const txn: any = { id: 't2', amount: -420, date: '2021-07-14', description: 'Ormco', postToCode: '9999', status: 'REVIEW', matchedDocumentId: null };
    const item: any = { id: 'i2', documentId: 'doc2', kind: 'PAYABLE', counterparty: 'Ormco', amount: 420, status: 'OPEN', paidByTxnId: null };
    applySettlement(txn, item);
    assert.equal(txn.postToCode, '2010');
    assert.equal(item.status, 'PAID');
  });

  await t.test('rematchAll settles an unmatched bank line against a later-filed invoice', () => {
    store.initDb();
    const db = store.getDb();
    db.bankTransactions.push({
      id: 'b1', bankAccountId: 'a1', statementId: 's1', date: '2021-07-14',
      period: '2021-07', description: 'Payment to Ormco Accounts Limited', amount: -420,
      balance: null, postToCode: '9999', postToName: 'Suspense', postConfidence: 0.2,
      status: 'REVIEW', matchedDocumentId: null, createdAt: '2026-01-01T00:00:00Z',
    } as any);
    db.arapItems.push({
      id: 'i9', documentId: 'docX', kind: 'PAYABLE', counterparty: 'Ormco Accounts Limited',
      amount: 420, currency: 'GBP', issueDate: '2021-07-01', dueDate: '2021-07-15',
      status: 'OPEN', paidByTxnId: null, docName: 'inv.pdf', createdAt: '2026-01-01T00:00:00Z',
    } as any);
    const r = rematchAll();
    assert.equal(r.matched, 1);
    assert.equal((db.bankTransactions[0] as any).postToCode, '2010');
    assert.equal((db.bankTransactions[0] as any).matchedDocumentId, 'docX');
    assert.equal((db.arapItems[0] as any).status, 'PAID');
  });
});
