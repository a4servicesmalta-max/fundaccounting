// The portfolio revaluation column marks foreign holdings to the ECB CLOSING rate at
// the reporting period-end (IAS 21). eurRate already reads the FX cache before the
// bundled table, so once the period-end ECB rate is cached (warmed by the report
// routes via getDailyRateToEur), the revaluation must use it — not the bundled table.
//
// Self-isolating: point AUTOPILOT_DB at a fresh temp file BEFORE importing the store.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
process.env.AUTOPILOT_DB = path.join(os.tmpdir(), `thcp-reval-${process.pid}-${Math.random().toString(36).slice(2)}.json`);

import { getDb, persist, insertDraft, setFxRate, type DraftRecord } from '../db/store';
import { portfolio } from './report';

function clearDrafts(): void {
  getDb().drafts.length = 0;
  persist();
}

function postUsdAcquisition(code: string, units: number, eur: number, usd: number): void {
  const now = new Date().toISOString();
  insertDraft({
    id: `${code}-${Math.random().toString(36).slice(2)}`,
    documentId: null,
    investeeName: 'USD Co',
    instrument: 'SHARES',
    eventType: 'ACQUISITION',
    controlCode: code,
    currency: 'USD',
    txnDate: '2025-03-10',
    period: '2025-03',
    status: 'POSTED',
    sourceFigures: { amount: usd, quantity: units, fairValue: null, currency: 'USD' },
    engineFigures: {
      functionalAmount: eur, currency: 'EUR', lineCount: 2, fxRate: null,
      fxRateDate: null, originalCurrency: 'USD', originalAmount: usd,
    },
    lines: [
      { accountCode: code, accountName: 'inv', amount: eur, description: '' },
      { accountCode: '1010', accountName: 'Bank', amount: -eur, description: '' },
    ],
    confidence: 1, citation: null, rationale: null, docName: null, createdAt: now, postedAt: now,
  } as DraftRecord);
}

test('revaluation marks to the period-end ECB rate from the cache, not the bundled table', () => {
  clearDrafts();
  postUsdAcquisition('030-usdco', 1000, 9000, 10000); // cost base USD 10,000
  // Simulate the period-end ECB rate (EUR per USD) the report route would have warmed.
  setFxRate('USD:2025-03-31', 0.92);
  const pf = portfolio('2025-03');
  const row = pf.rows.find((r) => r.controlCode === '030-usdco');
  assert.ok(row, 'holding present');
  assert.equal(row!.revalDate, '2025-03-31'); // closing date of the reporting period
  assert.equal(row!.revalFxRate, 0.92); // the cached ECB closing rate
  assert.equal(row!.revaluedValue, 9200); // 10,000 USD × 0.92
});
