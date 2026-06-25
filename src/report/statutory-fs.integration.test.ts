// End-to-end: a posted trial balance in THCP's statutory chart must land in the
// correct balance-sheet and P&L sections (not just resolve the right type). This
// guards the parity fix where 17 statutory accounts were previously misclassified
// — receivables shown as liabilities, revenues hidden in assets, costs shown as
// revenue — even though the trial balance tied.
//
// Self-isolating: point AUTOPILOT_DB at a fresh temp file BEFORE importing the store.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
process.env.AUTOPILOT_DB = path.join(os.tmpdir(), `thcp-statfs-${process.pid}-${Math.random().toString(36).slice(2)}.json`);

import { getDb, persist, insertDraft } from '../db/store';
import { profitAndLoss, balanceSheet } from './report';
import { accountName } from '../core/chart';

function postStatutoryTb(): void {
  const now = new Date('2024-12-31').toISOString();
  // Balanced statutory trial balance (Dr positive, Cr negative).
  const lines: { code: string; amt: number }[] = [
    { code: '130', amt: 100000 }, // cash at bank (asset)
    { code: '240-CL', amt: 5000 }, // receivable (asset, via family)
    { code: '500', amt: -3000 }, // short-term liabilities
    { code: '840', amt: -2000 }, // provisions
    { code: '64-AE', amt: -1000 }, // accrued expenses
    { code: '802', amt: -90000 }, // supplementary capital (equity)
    { code: '750-1', amt: -15000 }, // revenue from sales of shares
    { code: 'EXCH-P', amt: -5000 }, // FX gain (revenue)
    { code: '402', amt: 6000 }, // legal & professional (expense)
    { code: '751', amt: 5000 }, // cost of shares disposal (expense)
  ];
  insertDraft({
    id: 'stat-tb', documentId: null, investeeName: 'THCP', instrument: 'SHARES',
    eventType: 'JOURNAL', controlCode: '030', currency: 'EUR', txnDate: '2024-12-31',
    period: '2024-12', status: 'POSTED',
    sourceFigures: { amount: 0, quantity: null, fairValue: null, currency: 'EUR' },
    engineFigures: { functionalAmount: 0, currency: 'EUR', lineCount: lines.length, fxRate: null, fxRateDate: null, originalCurrency: 'EUR', originalAmount: 0 },
    lines: lines.map((l) => ({ accountCode: l.code, accountName: accountName(l.code), amount: l.amt, description: 'stat tb' })),
    confidence: 1, citation: null, rationale: null, docName: null, createdAt: now, postedAt: now,
  } as any);
}

test('statutory trial balance classifies into correct BS and P&L sections', () => {
  getDb().drafts.length = 0;
  if (getDb().settings) getDb().settings.lockedPeriods = [];
  persist();
  postStatutoryTb();

  const has = (rows: { accountCode: string }[], code: string) => rows.some((r) => r.accountCode === code);

  const bs = balanceSheet('2024-12');
  assert.ok(has(bs.assets, '240-CL'), '240 receivable must be in assets');
  assert.ok(!has(bs.liabilities, '240-CL'), '240 receivable must NOT be a liability');
  for (const c of ['500', '840', '64-AE']) {
    assert.ok(has(bs.liabilities, c), `${c} must be a liability`);
    assert.ok(!has(bs.assets, c), `${c} must NOT be an asset`);
  }
  assert.ok(has(bs.equity, '802'), '802 must be equity');
  assert.ok(bs.balanced, 'balance sheet must balance');

  const pl = profitAndLoss('2024-12');
  assert.ok(has(pl.revenue, '750-1'), '750-1 must be revenue');
  assert.ok(has(pl.revenue, 'EXCH-P'), 'EXCH-P must be revenue');
  assert.ok(has(pl.expenses, '402'), '402 must be an expense');
  assert.ok(has(pl.expenses, '751'), '751 must be an expense');
  assert.equal(pl.totalRevenue, 20000);
  assert.equal(pl.totalExpenses, 11000);
  assert.equal(pl.netProfit, 9000);
});
