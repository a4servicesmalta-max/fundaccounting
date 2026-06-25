// Regression: a "Carry forward" / "balance brought forward" line is the opening
// balance restated, not a transaction. It was ingested as a money-in line, posted to
// 9999 suspense, double-counted the cash and broke the footing. It must be dropped.
//
// Self-isolating: point AUTOPILOT_DB at a fresh temp file BEFORE importing the store.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
process.env.AUTOPILOT_DB = path.join(os.tmpdir(), `thcp-bf-${process.pid}-${Math.random().toString(36).slice(2)}.json`);

import { getDb, persist } from '../db/store';
import { ingestStatement, isBroughtForwardLine, type ExtractedBankStatement } from './ingest';

test('brought-forward / opening-balance lines are recognised (EN + PL/DE/FR)', () => {
  for (const d of ['Carry forward', 'Balance brought forward', 'Balance b/f', 'B/F', 'Opening balance',
    'Saldo początkowe', 'Saldovortrag', 'Übertrag', 'Solde reporté']) {
    assert.equal(isBroughtForwardLine(d), true, `should match: ${d}`);
  }
  for (const d of ['Hold Mail Fee', 'PRZELEW ELIXIR', 'Bank charges', 'Dividend received', 'Forward contract settlement']) {
    assert.equal(isBroughtForwardLine(d), false, `should NOT match: ${d}`);
  }
});

test('ingest drops the carry-forward line: only real movements become transactions, footing ties', () => {
  getDb().bankTransactions.length = 0;
  getDb().bankStatements.length = 0;
  getDb().bankAccounts.length = 0;
  persist();

  const extracted: ExtractedBankStatement = {
    bankName: 'Bendura', accountRef: 'EUR-1', currency: 'EUR',
    openingBalance: 1616.82, closingBalance: 1524.75,
    transactions: [
      { date: '2021-01-01', description: 'Carry forward', amount: 1616.82, balance: 1616.82 },
      { date: '2021-03-31', description: 'Hold Mail Fee', amount: -92.07, balance: 1524.75 },
    ],
  } as ExtractedBankStatement;

  const r = ingestStatement(extracted);
  const txns = getDb().bankTransactions;
  assert.equal(txns.length, 1, 'only the real movement is a transaction');
  assert.equal(txns[0].description, 'Hold Mail Fee');
  // No suspense line for a phantom carry-forward.
  assert.equal(txns.some((t: any) => t.description === 'Carry forward'), false);
  // Footing now ties: opening 1,616.82 − 92.07 = closing 1,524.75.
  assert.equal(r.footingOk, true);
});
