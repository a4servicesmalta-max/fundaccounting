// A foreign AR/AP item is booked in EUR at its issue-date ECB rate, but settled via a
// bank line at the payment-date ECB rate. The difference is a REALISED FX gain/loss
// that must clear the debtor/creditor control to nil and hit 6800 (FX gain/loss) in
// the P&L — not sit unresolved in 1100/2010.
//
// Self-isolating: point AUTOPILOT_DB at a fresh temp file BEFORE importing the store.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
process.env.AUTOPILOT_DB = path.join(os.tmpdir(), `thcp-arapfx-${process.pid}-${Math.random().toString(36).slice(2)}.json`);

import { getDb, persist, setFxRate } from '../db/store';
import { insertItem } from '../arap/arap-store';
import { insertTransaction, type BankTransaction, type BankAccount } from '../bank/bank-store';
import { trialBalance, balanceSheet, profitAndLoss } from './report';

function reset(): void {
  const db = getDb();
  db.arapItems.length = 0;
  (db.bankTransactions as BankTransaction[]).length = 0;
  (db.bankAccounts as BankAccount[]).length = 0;
  persist();
}

function bal(rows: { accountCode: string; debit: number; credit: number }[], code: string): number {
  const r = rows.find((x) => x.accountCode === code);
  return r ? r.debit - r.credit : 0;
}

test('realised FX on a settled USD receivable clears the debtor and hits 6800', () => {
  reset();
  // USD 10,000 receivable booked at the 10 Jan ECB rate 0.97 -> EUR 9,700.
  const item = insertItem({
    documentId: null, kind: 'RECEIVABLE', counterparty: 'Borealis', amount: 10000, currency: 'USD',
    issueDate: '2025-01-10', dueDate: '2025-02-10', status: 'OPEN', fxRate: 0.97, fxRateDate: '2025-01-10',
  });
  // Settled from a USD bank account on 10 Mar; that day's ECB rate is 0.95 -> EUR 9,500.
  const acct: BankAccount = { id: 'acct-usd', bankName: 'Citi', accountRef: 'USD-1', currency: 'USD', createdAt: '2025-03-10T00:00:00Z' } as BankAccount;
  getDb().bankAccounts.push(acct);
  setFxRate('USD:2025-03-10', 0.95);
  const txn = insertTransaction({
    id: 'txn-1', bankAccountId: 'acct-usd', statementId: 'st-1', date: '2025-03-10', period: '2025-03',
    description: 'Receipt — Borealis', amount: 10000, balance: null, postToCode: '1100', postToName: 'Accounts receivable',
    postConfidence: 0.99, status: 'AUTO', matchedDocumentId: null, createdAt: '2025-03-10T00:00:00Z',
  } as BankTransaction);
  // Link the settlement (as applySettlement would).
  const it = getDb().arapItems.find((i) => i.id === item.id)!;
  it.status = 'PAID';
  it.paidByTxnId = txn.id;
  persist();

  const tb = trialBalance();
  // Debtor 1100 cleared to nil (9,700 invoice − 9,500 settlement − 200 FX = 0).
  assert.ok(Math.abs(bal(tb.rows, '1100')) < 0.01, `1100 should be nil, got ${bal(tb.rows, '1100')}`);
  // Received fewer EUR than booked -> a 200 FX LOSS to 6800 (a debit / expense).
  assert.equal(bal(tb.rows, '6800'), 200);
  // Trial balance still ties.
  assert.ok(Math.abs(tb.totals.debit - tb.totals.credit) < 0.01, 'TB ties');

  // It shows in the P&L as an expense and the debtor is gone from the balance sheet.
  assert.equal(profitAndLoss().totalExpenses >= 200, true);
  assert.equal(balanceSheet().assets.find((a) => a.accountCode === '1100'), undefined);
});

test('a EUR receivable settled at par produces no FX line', () => {
  reset();
  const item = insertItem({
    documentId: null, kind: 'RECEIVABLE', counterparty: 'EuroCo', amount: 5000, currency: 'EUR',
    issueDate: '2025-01-10', dueDate: '2025-02-10', status: 'OPEN', fxRate: 1, fxRateDate: '2025-01-10',
  });
  const acct: BankAccount = { id: 'acct-eur', bankName: 'SEPA', accountRef: 'EUR-1', currency: 'EUR', createdAt: '2025-03-10T00:00:00Z' } as BankAccount;
  getDb().bankAccounts.push(acct);
  const txn = insertTransaction({
    id: 'txn-2', bankAccountId: 'acct-eur', statementId: 'st-2', date: '2025-03-10', period: '2025-03',
    description: 'Receipt — EuroCo', amount: 5000, balance: null, postToCode: '1100', postToName: 'Accounts receivable',
    postConfidence: 0.99, status: 'AUTO', matchedDocumentId: null, createdAt: '2025-03-10T00:00:00Z',
  } as BankTransaction);
  const it = getDb().arapItems.find((i) => i.id === item.id)!;
  it.status = 'PAID'; it.paidByTxnId = txn.id; persist();

  const tb = trialBalance();
  assert.equal(bal(tb.rows, '6800'), 0); // no FX on a EUR item
  assert.ok(Math.abs(bal(tb.rows, '1100')) < 0.01);
  assert.ok(Math.abs(tb.totals.debit - tb.totals.credit) < 0.01);
});
