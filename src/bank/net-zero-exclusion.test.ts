// Regression: net-zero charge/refund pairing must NOT sweep up a bank line that
// already has a definitive treatment — an AR/AP settlement (matchedDocumentId) or
// an investment cash leg (matchedInvestmentDraftId, NH-0). Re-pairing such a line
// would overwrite its control posting and break the books. A genuine fresh
// charge/refund pair must still net to zero.
//
// Self-isolating: point AUTOPILOT_DB at a fresh temp file BEFORE importing the store.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
process.env.AUTOPILOT_DB = path.join(
  os.tmpdir(),
  `thcp-nzx-${process.pid}-${Math.random().toString(36).slice(2)}.json`,
);

import { getDb, persist } from '../db/store';
import { findOrCreateAccount, insertTransaction, type BankTransaction } from './bank-store';
import { ingestStatement, type ExtractedBankStatement } from './ingest';

function reset(): void {
  const db = getDb();
  db.bankTransactions.length = 0;
  db.bankStatements.length = 0;
  db.bankAccounts.length = 0;
  db.drafts.length = 0;
  if (Array.isArray(db.arapItems)) db.arapItems.length = 0;
  persist();
}

test('a settled investment cash leg is not re-paired by net-zero detection', () => {
  reset();
  const acct = findOrCreateAccount('Test Bank', 'NZX-1', 'EUR');

  // A prior month's investment cash leg, already matched to its draft (NH-0).
  const settled = insertTransaction({
    id: '', bankAccountId: acct.id, statementId: 'prev', date: '2026-01-20', period: '2026-01',
    description: 'Capital call payment', amount: -250000, balance: null,
    postToCode: '030-x', postToName: 'Investment', postConfidence: 0.99, status: 'AUTO',
    matchedDocumentId: null, createdAt: new Date().toISOString(), matchedInvestmentDraftId: 'inv-1',
  } as BankTransaction);

  // A new statement that contains an equal-and-opposite "Refund" line (would pair
  // with the settled leg if it weren't excluded), plus a genuine fee/refund pair.
  const stmt: ExtractedBankStatement = {
    bankName: 'Test Bank', accountRef: 'NZX-1', currency: 'EUR',
    periodStart: '2026-02-01', periodEnd: '2026-02-28', openingBalance: 0, closingBalance: 0,
    transactions: [
      { date: '2026-02-10', description: 'Refund', amount: 250000 },
      { date: '2026-02-12', description: 'Account fee', amount: -500 },
      { date: '2026-02-15', description: 'Fee refund', amount: 500 },
    ],
  };
  ingestStatement(stmt);

  const after = getDb().bankTransactions as BankTransaction[];
  const settledNow = after.find((t) => t.id === settled.id)!;
  // The settled investment leg is untouched: still matched, never net-zero-paired,
  // control posting intact.
  assert.equal(settledNow.matchedInvestmentDraftId, 'inv-1');
  assert.equal(settledNow.netZeroPair == null, true, 'settled leg must not be paired');
  assert.equal(settledNow.postToCode, '030-x', 'control posting not clobbered');

  // The genuine fee + fee-refund pair still nets to zero (mechanism intact).
  const fee = after.find((t) => t.description === 'Account fee')!;
  const feeRefund = after.find((t) => t.description === 'Fee refund')!;
  assert.equal(fee.netZeroPair != null, true, 'real charge/refund pair still detected');
  assert.equal(feeRefund.netZeroPair != null, true);
  assert.equal(fee.postToCode, feeRefund.postToCode, 'paired legs share an account so they cancel');
});

test('a settled AR/AP bank line (matchedDocumentId) is likewise protected', () => {
  reset();
  const acct = findOrCreateAccount('Test Bank', 'NZX-2', 'EUR');
  const settled = insertTransaction({
    id: '', bankAccountId: acct.id, statementId: 'prev', date: '2026-01-18', period: '2026-01',
    description: 'Invoice settlement', amount: -12000, balance: null,
    postToCode: '2010', postToName: 'Creditors', postConfidence: 0.99, status: 'AUTO',
    matchedDocumentId: 'doc-9', createdAt: new Date().toISOString(),
  } as BankTransaction);

  const stmt: ExtractedBankStatement = {
    bankName: 'Test Bank', accountRef: 'NZX-2', currency: 'EUR',
    periodStart: '2026-02-01', periodEnd: '2026-02-28', openingBalance: 0, closingBalance: 0,
    transactions: [{ date: '2026-02-05', description: 'Refund received', amount: 12000 }],
  };
  ingestStatement(stmt);

  const settledNow = (getDb().bankTransactions as BankTransaction[]).find((t) => t.id === settled.id)!;
  assert.equal(settledNow.matchedDocumentId, 'doc-9');
  assert.equal(settledNow.netZeroPair == null, true, 'AR/AP-settled leg must not be paired');
  assert.equal(settledNow.postToCode, '2010', 'control posting not clobbered');
});
