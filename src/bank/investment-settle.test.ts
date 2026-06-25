// NH-0 regression: an investment's cash leg must be counted ONCE. When a share
// purchase is posted (Dr 030 / Cr 1010) AND the same payment also appears on an
// imported bank statement, the statement line must be matched + excluded from the
// GL — otherwise both the cash (1010) and the asset would double-count.
//
// Self-isolating: point AUTOPILOT_DB at a fresh temp file BEFORE importing the
// store, so this never touches the loop's working data.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
process.env.AUTOPILOT_DB = path.join(
  os.tmpdir(),
  `thcp-invsettle-${process.pid}-${Math.random().toString(36).slice(2)}.json`,
);

import { getDb, persist, insertDraft, type DraftRecord } from '../db/store';
import { findOrCreateAccount, insertStatement, insertTransaction, type BankTransaction } from './bank-store';
import { rematchInvestments } from './investment-settle';
import { ledger } from '../report/report';

function reset(): void {
  const db = getDb();
  db.drafts.length = 0;
  db.bankTransactions.length = 0;
  db.bankStatements.length = 0;
  db.bankAccounts.length = 0;
  persist();
}

function postedAcquisition(controlCode: string, amount: number, ccy: string, date: string): DraftRecord {
  const now = new Date().toISOString();
  const d: DraftRecord = {
    id: `${controlCode}-${Math.random().toString(36).slice(2)}`,
    documentId: null,
    investeeName: 'Settle Test Co',
    instrument: 'SHARES',
    eventType: 'ACQUISITION',
    controlCode,
    currency: ccy,
    txnDate: date,
    period: date.slice(0, 7),
    status: 'POSTED',
    sourceFigures: { amount, quantity: 100, fairValue: null, currency: ccy },
    engineFigures: {
      functionalAmount: amount, currency: 'EUR', lineCount: 2, fxRate: null,
      fxRateDate: null, originalCurrency: ccy, originalAmount: amount,
    },
    lines: [
      { accountCode: controlCode, accountName: 'inv', amount, description: '' },
      { accountCode: '1010', accountName: 'Bank', amount: -amount, description: '' },
    ],
    confidence: 1, citation: null, rationale: null, docName: null, createdAt: now, postedAt: now,
  };
  insertDraft(d);
  return d;
}

function addBankLine(accountId: string, statementId: string, amount: number, date: string, desc: string): BankTransaction {
  return insertTransaction({
    id: '', bankAccountId: accountId, statementId, date, period: date.slice(0, 7),
    description: desc, amount, balance: null, postToCode: '9999', postToName: 'Suspense',
    postConfidence: 0.2, status: 'REVIEW', matchedDocumentId: null, createdAt: new Date().toISOString(),
  } as BankTransaction);
}

function balanceOf(code: string): number {
  return ledger('all').lines
    .filter((l) => l.accountCode === code)
    .reduce((s, l) => s + (Number(l.amount) || 0), 0);
}

test('matched investment cash leg is excluded from the GL — no double-count', () => {
  reset();
  const acct = findOrCreateAccount('Test Bank', 'PL-001', 'EUR');
  const stmt = insertStatement({
    id: '', bankAccountId: acct.id, fileName: 's.pdf', storedPath: null,
    periodStart: '2026-01-01', periodEnd: '2026-01-31', openingBalance: 0, closingBalance: 0,
    footingOk: true, footingDiff: 0, monthsCovered: ['2026-01'], createdAt: new Date().toISOString(),
  });
  postedAcquisition('030-settleco', 100000, 'EUR', '2026-01-10');
  const bank = addBankLine(acct.id, stmt.id, -100000, '2026-01-10', 'Wire to Settle Test Co');

  // Before matching: the bank line independently moves 1010 → cash double-counted.
  assert.equal(balanceOf('1010'), -200000, 'precondition: without exclusion 1010 doubles');

  const r = rematchInvestments();
  assert.equal(r.matched, 1, 'the bank line is matched to the investment');

  const matched = getDb().bankTransactions.find((t: BankTransaction) => t.id === bank.id) as BankTransaction;
  assert.equal(matched.matchedInvestmentDraftId != null, true, 'bank line flagged as settled');

  // After matching: cash and asset each counted once.
  assert.equal(balanceOf('1010'), -100000, '1010 moved once (investment Cr only)');
  // The ledger presents the control account (030), matching the trial balance; the
  // per-investee sub-account (030-settleco) rolls up into it.
  assert.equal(balanceOf('030'), 100000, '030 holding up once');
});

test('a non-matching bank line (different amount) is left alone', () => {
  reset();
  const acct = findOrCreateAccount('Test Bank', 'PL-002', 'EUR');
  const stmt = insertStatement({
    id: '', bankAccountId: acct.id, fileName: 's.pdf', storedPath: null,
    periodStart: '2026-01-01', periodEnd: '2026-01-31', openingBalance: 0, closingBalance: 0,
    footingOk: true, footingDiff: 0, monthsCovered: ['2026-01'], createdAt: new Date().toISOString(),
  });
  postedAcquisition('030-otherco', 100000, 'EUR', '2026-01-10');
  addBankLine(acct.id, stmt.id, -50000, '2026-01-10', 'Unrelated payment');

  const r = rematchInvestments();
  assert.equal(r.matched, 0, 'amount mismatch → no match');
});

test('a wrong-direction bank line (cash IN against a purchase) is not matched', () => {
  reset();
  const acct = findOrCreateAccount('Test Bank', 'PL-003', 'EUR');
  const stmt = insertStatement({
    id: '', bankAccountId: acct.id, fileName: 's.pdf', storedPath: null,
    periodStart: '2026-01-01', periodEnd: '2026-01-31', openingBalance: 0, closingBalance: 0,
    footingOk: true, footingDiff: 0, monthsCovered: ['2026-01'], createdAt: new Date().toISOString(),
  });
  postedAcquisition('030-dirco', 100000, 'EUR', '2026-01-10');
  addBankLine(acct.id, stmt.id, 100000, '2026-01-10', 'Cash in, not a purchase');

  const r = rematchInvestments();
  assert.equal(r.matched, 0, 'a purchase needs a cash OUTflow; an inflow is not its leg');
});

test('matching is idempotent — running twice matches the same single line once', () => {
  reset();
  const acct = findOrCreateAccount('Test Bank', 'PL-004', 'EUR');
  const stmt = insertStatement({
    id: '', bankAccountId: acct.id, fileName: 's.pdf', storedPath: null,
    periodStart: '2026-01-01', periodEnd: '2026-01-31', openingBalance: 0, closingBalance: 0,
    footingOk: true, footingDiff: 0, monthsCovered: ['2026-01'], createdAt: new Date().toISOString(),
  });
  postedAcquisition('030-idemco', 250000, 'EUR', '2026-02-03');
  addBankLine(acct.id, stmt.id, -250000, '2026-02-04', 'Subscription');

  assert.equal(rematchInvestments().matched, 1);
  assert.equal(rematchInvestments().matched, 0, 'second sweep finds nothing new');
  assert.equal(balanceOf('1010'), -250000, 'still counted once after re-run');
});
