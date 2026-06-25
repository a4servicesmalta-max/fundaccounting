// Bank-statement-backed ledger lines carry the statementId so the UI can link the
// entry to its evidence (the bank statement), even when there's no matched invoice.
//
// Self-isolating: point AUTOPILOT_DB at a fresh temp file BEFORE importing the store.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
process.env.AUTOPILOT_DB = path.join(os.tmpdir(), `thcp-ledstmt-${process.pid}-${Math.random().toString(36).slice(2)}.json`);

import { getDb, persist } from '../db/store';
import { getStatement } from '../bank/bank-store';
import { ledger } from './report';

function reset(): void {
  const db = getDb();
  db.drafts.length = 0;
  (db.bankStatements as unknown[]).length = 0;
  (db.bankTransactions as unknown[]).length = 0;
  persist();
}

test('a posted bank line carries its statementId; getStatement resolves it', () => {
  reset();
  getDb().bankStatements.push({ id: 'stmt1', bankAccountId: 'a', fileName: 'march.pdf', storedPath: 'data/uploads/stmt1.pdf', periodStart: '2025-03-01', periodEnd: '2025-03-31', openingBalance: 0, closingBalance: 0, footingOk: true, footingDiff: 0, monthsCovered: ['2025-03'], createdAt: 'x' });
  getDb().bankTransactions.push({ id: 'bt1', bankAccountId: 'a', statementId: 'stmt1', date: '2025-03-20', period: '2025-03', description: 'Legal fees', amount: -2000, balance: null, postToCode: '6100', postToName: 'Legal', postConfidence: 1, status: 'POSTED', matchedDocumentId: null, createdAt: 'x', currency: 'EUR' });
  persist();

  const lines = ledger().lines.filter((l) => l.txnId === 'bt1');
  assert.ok(lines.length >= 2, 'bank entry produced ledger lines');
  for (const l of lines) assert.equal(l.statementId, 'stmt1'); // every leg links the statement

  const s = getStatement('stmt1');
  assert.equal(s!.storedPath, 'data/uploads/stmt1.pdf');
  assert.equal(getStatement('nope'), null);
});
