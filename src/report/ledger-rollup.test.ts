// Regression: the Ledger listed per-investee sub-accounts (030-gamivo, 032-ormco)
// while the Trial Balance rolled them up to the control accounts (030, 032) — so the
// two reports showed DIFFERENT account codes ("the accounts do not match"). The ledger
// now presents the same control account as the TB (the investee stays on each line),
// so the ledger's account set reconciles with the trial balance.
//
// Self-isolating: point AUTOPILOT_DB at a fresh temp file BEFORE importing the store.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
process.env.AUTOPILOT_DB = path.join(os.tmpdir(), `thcp-ledroll-${process.pid}-${Math.random().toString(36).slice(2)}.json`);

import { getDb, persist, insertDraft, type DraftRecord } from '../db/store';
import { ledger, trialBalance } from './report';

function post(id: string, code: string, investee: string, eventType: DraftRecord['eventType'], amt: number): void {
  insertDraft({
    id, documentId: null, investeeName: investee, instrument: code.startsWith('032') ? 'LOAN' : 'SHARES',
    eventType, controlCode: code, currency: 'EUR', txnDate: '2025-03-10', period: '2025-03', status: 'POSTED',
    sourceFigures: { amount: amt, quantity: null, fairValue: null, currency: 'EUR' },
    engineFigures: { functionalAmount: amt, currency: 'EUR', lineCount: 2, fxRate: null, fxRateDate: null, originalCurrency: 'EUR', originalAmount: amt },
    lines: [{ accountCode: code, accountName: investee, amount: amt, description: '' }, { accountCode: '1010', accountName: 'Bank', amount: -amt, description: '' }],
    confidence: 1, citation: null, rationale: null, docName: null, createdAt: 'x', postedAt: 'x',
  } as DraftRecord);
}

test('the ledger account set matches the trial balance (sub-accounts rolled to controls)', () => {
  getDb().drafts.length = 0; persist();
  post('a1', '030-gamivo', 'Gamivo Holdings Ltd', 'ACQUISITION', 5000);
  post('a2', '030-sentryc', 'Sentryc GmbH', 'ACQUISITION', 3000);
  post('a3', '032-ormco', 'Ormco Industries plc', 'LOAN_ADVANCE', 2000);

  const ledgerCodes = [...new Set(ledger().lines.map((l) => l.accountCode))].sort();
  const tbCodes = [...new Set(trialBalance().rows.map((r) => r.accountCode))].sort();
  assert.deepEqual(ledgerCodes, tbCodes); // same accounts in both reports

  // The control account is shown (not the per-investee sub-account)…
  assert.ok(ledgerCodes.includes('030') && ledgerCodes.includes('032'));
  assert.ok(!ledgerCodes.some((c) => c.includes('-'))); // no 030-gamivo etc.
  // …but the investee is still on each line for the Details column.
  const gamivoLine = ledger().lines.find((l) => l.investeeName === 'Gamivo Holdings Ltd');
  assert.equal(gamivoLine!.accountCode, '030');
  assert.equal(gamivoLine!.investeeName, 'Gamivo Holdings Ltd');
});
