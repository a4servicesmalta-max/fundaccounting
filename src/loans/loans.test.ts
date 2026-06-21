import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
// Self-isolate the store so running this file directly never touches real data.
process.env.AUTOPILOT_DB = path.join(os.tmpdir(), `thcp-loans-${process.pid}-${Math.random().toString(36).slice(2)}.json`);

import { initDb, resetAll, insertDraft, setDraftStatus, getDb, persist } from '../db/store';
import type { DraftRecord } from '../db/store';
import type { InvestmentEventType } from '../core/types';
import { loansReport } from './loans';

function makeLoanDraft(
  eventType: InvestmentEventType,
  investeeName: string,
  amount: number,
  txnDate: string,
): DraftRecord {
  return {
    id: '',
    documentId: null,
    investeeName,
    instrument: 'LOAN',
    eventType,
    controlCode: '032-x',
    currency: 'EUR',
    txnDate,
    period: txnDate.slice(0, 7),
    status: 'PENDING',
    sourceFigures: { amount, quantity: null, fairValue: null, currency: 'EUR' },
    engineFigures: {
      functionalAmount: amount,
      currency: 'EUR',
      lineCount: 2,
      fxRate: null,
      fxRateDate: null,
      originalCurrency: 'EUR',
      originalAmount: amount,
    },
    lines: [],
    confidence: null,
    citation: null,
    rationale: null,
    docName: null,
    createdAt: new Date().toISOString(),
    postedAt: null,
  };
}

test('loansReport groups POSTED LOAN_ADVANCE + LOAN_REPAYMENT for the same party', () => {
  initDb();
  resetAll();

  const advance = makeLoanDraft('LOAN_ADVANCE', 'Acme Holdings', 10000, '2025-04-10');
  const repayment = makeLoanDraft('LOAN_REPAYMENT', 'Acme Holdings', 2500, '2025-05-15');
  insertDraft(advance);
  insertDraft(repayment);
  setDraftStatus(advance.id, 'POSTED');
  setDraftStatus(repayment.id, 'POSTED');

  const report = loansReport();

  assert.equal(report.loans.length, 1, 'one grouped loan row');
  const row = report.loans[0];
  assert.equal(row.party, 'Acme Holdings');
  assert.equal(row.direction, 'GRANTED');
  assert.equal(row.currency, 'EUR');
  assert.equal(row.advanced, 10000);
  assert.equal(row.repaid, 2500);
  assert.equal(row.outstanding, 7500);
  assert.equal(row.lastEventDate, '2025-05-15');
  assert.equal(row.events.length, 2);
  assert.equal(row.events[0].type, 'ADVANCE');
  assert.equal(row.events[1].type, 'REPAYMENT');

  assert.equal(report.totals.granted, 7500);
  assert.equal(report.totals.borrowed, 0);
  assert.equal(report.totals.outstanding, 7500);
});

test('loansReport ignores non-POSTED loan drafts', () => {
  initDb();
  resetAll();

  const pending = makeLoanDraft('LOAN_ADVANCE', 'Pending Co', 5000, '2025-04-01');
  insertDraft(pending); // stays PENDING

  const report = loansReport();
  assert.equal(report.loans.length, 0);
  assert.equal(report.totals.granted, 0);
});

test('loansReport aggregates POSTED bank transactions for granted (032*) and borrowed (2300*)', () => {
  initDb();
  resetAll();

  // 032 (loans granted): money OUT = advance, money IN = repayment.
  getDb().bankTransactions.push(
    {
      id: 'bt1',
      status: 'POSTED',
      postToCode: '032-beta',
      description: 'Beta Ltd',
      currency: 'EUR',
      amount: -4000,
      date: '2025-04-05',
    },
    {
      id: 'bt2',
      status: 'POSTED',
      postToCode: '032-beta',
      description: 'Beta Ltd',
      currency: 'EUR',
      amount: 1000,
      date: '2025-06-05',
    },
    // 2300 (borrowings): money IN = drawdown/advance, money OUT = repayment.
    {
      id: 'bt3',
      status: 'POSTED',
      postToCode: '2300',
      description: 'BigBank Facility',
      currency: 'EUR',
      amount: 20000,
      date: '2025-04-20',
    },
    {
      id: 'bt4',
      status: 'POSTED',
      postToCode: '2300',
      description: 'BigBank Facility',
      currency: 'EUR',
      amount: -5000,
      date: '2025-05-20',
    },
    // Non-loan + non-POSTED rows must be ignored.
    {
      id: 'bt5',
      status: 'POSTED',
      postToCode: '6300',
      description: 'Bank charge',
      currency: 'EUR',
      amount: -10,
      date: '2025-04-01',
    },
    {
      id: 'bt6',
      status: 'REVIEW',
      postToCode: '032-beta',
      description: 'Beta Ltd',
      currency: 'EUR',
      amount: -999,
      date: '2025-04-02',
    },
  );
  persist();

  const report = loansReport();

  const beta = report.loans.find((l) => l.party === 'Beta Ltd');
  assert.ok(beta, 'Beta Ltd granted row exists');
  assert.equal(beta!.direction, 'GRANTED');
  assert.equal(beta!.advanced, 4000);
  assert.equal(beta!.repaid, 1000);
  assert.equal(beta!.outstanding, 3000);
  assert.equal(beta!.lastEventDate, '2025-06-05');

  const facility = report.loans.find((l) => l.party === 'BigBank Facility');
  assert.ok(facility, 'BigBank borrowed row exists');
  assert.equal(facility!.direction, 'BORROWED');
  assert.equal(facility!.advanced, 20000);
  assert.equal(facility!.repaid, 5000);
  assert.equal(facility!.outstanding, 15000);

  assert.equal(report.totals.granted, 3000);
  assert.equal(report.totals.borrowed, 15000);
  assert.equal(report.totals.outstanding, -12000);
});
