// The financial-statements pack must reproduce THCP's workbook line groupings
// (source: BS-2024 / P&L_2024 sheets) — not a flat type-grouped list. Accounts are
// bucketed into named statement lines: Investments / Loans granted / Accrued
// interest / Trade & other receivables / Cash; Share capital / Supplementary
// capital / Deferred income / Accumulated P&L; Short-term liabilities / Accruals.
// Each line also absorbs the equivalent app-chart code so a mixed book still maps.
//
// Self-isolating: point AUTOPILOT_DB at a fresh temp file BEFORE importing the store.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
process.env.AUTOPILOT_DB = path.join(os.tmpdir(), `thcp-fslines-${process.pid}-${Math.random().toString(36).slice(2)}.json`);

import { getDb, persist, insertDraft } from '../db/store';
import { financialPositionRows, incomeStatementRows } from './fs-lines';
import { accountName } from '../core/chart';

function post(lines: { code: string; amt: number }[]): void {
  const now = new Date('2024-12-31').toISOString();
  insertDraft({
    id: 'fsl-tb', documentId: null, investeeName: 'THCP', instrument: 'SHARES',
    eventType: 'JOURNAL', controlCode: '030', currency: 'EUR', txnDate: '2024-12-31',
    period: '2024-12', status: 'POSTED',
    sourceFigures: { amount: 0, quantity: null, fairValue: null, currency: 'EUR' },
    engineFigures: { functionalAmount: 0, currency: 'EUR', lineCount: lines.length, fxRate: null, fxRateDate: null, originalCurrency: 'EUR', originalAmount: 0 },
    lines: lines.map((l) => ({ accountCode: l.code, accountName: accountName(l.code), amount: l.amt, description: 'fsl' })),
    confidence: 1, citation: null, rationale: null, docName: null, createdAt: now, postedAt: now,
  } as any);
}

const amt = (rows: { id: string; amount: number | null }[], id: string) => rows.find((r) => r.id === id)?.amount ?? null;

test('balance sheet rows reproduce the workbook groupings and tie', () => {
  getDb().drafts.length = 0;
  if (getDb().settings) getDb().settings.lockedPeriods = [];
  persist();
  // Balanced mixed statutory+app book.
  post([
    { code: '030-gamivo', amt: 50000 }, // investments (rolls to 030)
    { code: '032-ci', amt: 40000 }, // loans granted (rolls to 032)
    { code: '032-1-ci', amt: 2000 }, // accrued interest
    { code: '240-CL', amt: 3000 }, // trade & other receivables
    { code: '1010', amt: 10000 }, // cash (app)
    { code: '130', amt: 5000 }, // cash (statutory)
    { code: '801', amt: -5000 }, // share capital
    { code: '802', amt: -81000 }, // supplementary capital
    { code: '840', amt: -2000 }, // deferred income (presented in equity block)
    { code: '500', amt: -3000 }, // short-term liabilities
    { code: '501', amt: -1000 }, // accruals
    { code: '64-AE', amt: -500 }, // accruals (accrued expenses)
    // P&L so the books balance: revenue 750-1 -20000, expense 402 +1500, 751 +1000 → net +17500 → accumulated
    { code: '750-1', amt: -20000 },
    { code: '402', amt: 1500 },
    { code: '751', amt: 1000 },
  ]);

  const rows = financialPositionRows('2024-12');
  assert.equal(amt(rows, 'investments'), 50000);
  assert.equal(amt(rows, 'loans'), 40000);
  assert.equal(amt(rows, 'accrued-interest'), 2000);
  assert.equal(amt(rows, 'trade-receivables'), 3000);
  assert.equal(amt(rows, 'cash'), 15000); // 1010 + 130
  assert.equal(amt(rows, 'share-capital'), 5000);
  assert.equal(amt(rows, 'supplementary-capital'), 81000);
  assert.equal(amt(rows, 'deferred-income'), 2000); // in equity block
  assert.equal(amt(rows, 'short-term-liabilities'), 3000);
  assert.equal(amt(rows, 'accruals'), 1500); // 501 + 64-AE
  // Totals tie: total assets == total equity & liabilities.
  assert.equal(amt(rows, 'total-assets'), 110000);
  assert.equal(amt(rows, 'total-eq-liab'), amt(rows, 'total-assets'));
});

test('income statement rows reproduce the workbook groupings', () => {
  getDb().drafts.length = 0;
  if (getDb().settings) getDb().settings.lockedPeriods = [];
  persist();
  post([
    { code: '750-1', amt: -20000 }, // gain on disposal of shares (revenue)
    { code: '751', amt: 4000 }, // loss/cost on disposal (expense)
    { code: '402', amt: 1500 }, // legal & professional (operating)
    { code: '403', amt: 500 }, // taxes (operating)
    { code: '409', amt: 300 }, // other costs (operating)
    { code: '750-2', amt: -2000 }, // dividends (financial income)
    { code: '4000', amt: -1000 }, // distributions (app → financial income)
    { code: 'EXCH-P', amt: -800 }, // FX gain (financial income)
    { code: '750-3', amt: -600 }, // interest income (financial income)
    { code: 'W-O', amt: 700 }, // write-off (financial expense)
    { code: 'EXCH-L', amt: 900 }, // FX loss (financial expense)
    // balance the journal with an equity plug
    { code: '802', amt: 16000 },
  ]);

  const rows = incomeStatementRows('2024-12');
  assert.equal(amt(rows, 'gain-on-disposal'), 20000);
  assert.equal(amt(rows, 'loss-on-disposal'), 4000);
  assert.equal(amt(rows, 'operating-expenses'), 2300); // 402+403+409
  assert.equal(amt(rows, 'dividends'), 3000); // 750-2 + 4000
  assert.equal(amt(rows, 'fx-gain'), 800);
  assert.equal(amt(rows, 'interest-income'), 600);
  assert.equal(amt(rows, 'write-off'), 700);
  assert.equal(amt(rows, 'fx-loss'), 900);
  // Net profit ties to revenue − expenses.
  // revenue: 20000+3000+800+600 = 24400 ; expenses: 4000+2300+700+900 = 7900 → 16500
  assert.equal(amt(rows, 'net-profit'), 16500);
});
