// Integration: closing a calendar financial year posts an audited closing journal that
// zeroes the year's P&L into retained earnings and locks the year; the next year builds
// on the closing balance, FY P&L is reported per year, and the balance sheet splits
// brought-forward (3100) from the current-year result. Reopening unwinds it.
//
// Self-isolating: point AUTOPILOT_DB at a fresh temp file BEFORE importing the store.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
process.env.AUTOPILOT_DB = path.join(os.tmpdir(), `thcp-yci-${process.pid}-${Math.random().toString(36).slice(2)}.json`);

import { getDb, persist, insertDraft, type DraftRecord } from '../db/store';
import { profitAndLoss, balanceSheet, trialBalance } from '../report/report';
import { closeYear, reopenYear, isYearClosed } from './post';

function reset(): void {
  getDb().drafts.length = 0;
  if (getDb().settings) getDb().settings.lockedPeriods = [];
  persist();
}

let seq = 0;
function postPair(period: string, txnDate: string, lines: { accountCode: string; amount: number }[]): void {
  insertDraft({
    id: `seed-${seq++}`, documentId: null, investeeName: '-', instrument: 'SHARES',
    eventType: 'JOURNAL', controlCode: lines[0].accountCode, currency: 'EUR', txnDate, period,
    status: 'POSTED',
    sourceFigures: { amount: 0, quantity: null, fairValue: null, currency: 'EUR' },
    engineFigures: { functionalAmount: 0, currency: 'EUR', lineCount: lines.length, fxRate: null, fxRateDate: null, originalCurrency: 'EUR', originalAmount: 0 },
    lines: lines.map((l) => ({ accountCode: l.accountCode, accountName: l.accountCode, amount: l.amount, description: '' })),
    confidence: 1, citation: null, rationale: null, docName: null, createdAt: new Date().toISOString(), postedAt: new Date().toISOString(),
  } as DraftRecord);
}

function seedTwoYears(): void {
  reset();
  // FY2024: income 100,000 (Jun) and expense 30,000 (Sep) -> profit 70,000
  postPair('2024-06', '2024-06-15', [{ accountCode: '1010', amount: 100000 }, { accountCode: '4000', amount: -100000 }]);
  postPair('2024-09', '2024-09-10', [{ accountCode: '6100', amount: 30000 }, { accountCode: '1010', amount: -30000 }]);
  // FY2025: income 50,000 (Mar) -> profit 50,000
  postPair('2025-03', '2025-03-20', [{ accountCode: '1010', amount: 50000 }, { accountCode: '4000', amount: -50000 }]);
}

function reLine(bs: ReturnType<typeof balanceSheet>, re: RegExp) {
  return bs.equity.find((e) => re.test(e.accountName))?.amount ?? 0;
}

test('closing FY2024 posts the closing journal, locks the year, and splits retained earnings', () => {
  seedTwoYears();
  const r = closeYear(2024, 'cfo');
  assert.equal(r.netResult, 70000);
  assert.ok(r.closingDraftId, 'a closing journal was posted');
  assert.equal(isYearClosed(2024), true);

  // FY P&L still shows each year's real result (closing entry excluded).
  assert.equal(profitAndLoss('2024').netProfit, 70000);
  assert.equal(profitAndLoss('2025').netProfit, 50000);

  // Balance sheet at the next year-end: 3100 brought forward 70,000 + current-year 50,000.
  const bs = balanceSheet('2025-12');
  assert.equal(reLine(bs, /3100|retained/i), 70000); // brought forward (closed FY2024)
  assert.equal(reLine(bs, /current year/i), 50000); // FY2025 to date
  assert.equal(bs.totalEquity, 120000);
  assert.equal(bs.balanced, true);

  // Trial balance still ties after the closing entry.
  const tb = trialBalance('2025-12');
  assert.ok(Math.abs(tb.totals.debit - tb.totals.credit) < 0.01, 'TB ties');
});

test('a closed year cannot be closed again', () => {
  seedTwoYears();
  closeYear(2024);
  assert.throws(() => closeYear(2024), /already closed/i);
});

test('reopening FY2024 unwinds the close and unlocks the year', () => {
  seedTwoYears();
  closeYear(2024);
  const r = reopenYear(2024, 'admin');
  assert.equal(r.reversedIds.length, 1);
  assert.equal(isYearClosed(2024), false);

  // Retained-earnings split is gone; all P&L is back in the current-year line.
  const bs = balanceSheet('2025-12');
  assert.equal(reLine(bs, /3100|retained/i), 0);
  assert.equal(reLine(bs, /current year/i), 120000);
  assert.equal(bs.balanced, true);
  // The year's real result is still reportable.
  assert.equal(profitAndLoss('2024').netProfit, 70000);
});

test('re-closing after a reopen produces the same closing result', () => {
  seedTwoYears();
  closeYear(2024);
  reopenYear(2024);
  const r2 = closeYear(2024);
  assert.equal(r2.netResult, 70000);
  assert.equal(balanceSheet('2025-12').totalEquity, 120000);
});
