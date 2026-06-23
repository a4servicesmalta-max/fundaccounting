// Regression: originalCostFor() builds the foreign-currency cost base used for the
// portfolio REVALUATION column. It used a crude `acquisitions add, disposals/write-
// offs subtract` over each draft's originalAmount — but originalAmount means different
// things per event: a DISPOSAL's is PROCEEDS (not cost), and a LOAN_REPAYMENT fell to
// the "else add" branch. So:
//   - a foreign PARTIAL disposal subtracted proceeds from cost (e.g. $20,000 acquired
//     − $13,000 proceeds = $7,000 base, when the remaining 1,000/2,000 units cost
//     $10,000) → the revalued column sat BELOW carrying, a fictitious loss.
//   - a foreign loan REPAYMENT was ADDED (£50,000 advance + £20,000 repaid = £70,000
//     base instead of the £30,000 principal still outstanding).
// Correct base: equity = average cost scaled by units still held; loan = advances net
// of repayments; write-off = 0.
//
// Self-isolating: point AUTOPILOT_DB at a fresh temp file BEFORE importing the store.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
process.env.AUTOPILOT_DB = path.join(os.tmpdir(), `thcp-origcost-${process.pid}-${Math.random().toString(36).slice(2)}.json`);

import { getDb, persist, insertDraft, type DraftRecord } from '../db/store';
import { originalCostFor } from './report';

function clearDrafts(): void {
  getDb().drafts.length = 0;
  persist();
}

function postedDraft(p: {
  controlCode: string;
  eventType: DraftRecord['eventType'];
  origAmount: number;
  origCurrency: string;
  quantity?: number | null;
}): void {
  const now = new Date().toISOString();
  insertDraft({
    id: `${p.controlCode}-${p.eventType}-${Math.random().toString(36).slice(2)}`,
    documentId: null,
    investeeName: 'Test Co',
    instrument: p.controlCode.startsWith('032') ? 'LOAN' : 'SHARES',
    eventType: p.eventType,
    controlCode: p.controlCode,
    currency: p.origCurrency,
    txnDate: '2025-03-10',
    period: '2025-03',
    status: 'POSTED',
    sourceFigures: { amount: p.origAmount, quantity: p.quantity ?? null, fairValue: null, currency: p.origCurrency },
    engineFigures: {
      functionalAmount: p.origAmount, currency: 'EUR', lineCount: 2, fxRate: null,
      fxRateDate: null, originalCurrency: p.origCurrency, originalAmount: p.origAmount,
    },
    lines: [],
    confidence: 1, citation: null, rationale: null, docName: null, createdAt: now, postedAt: now,
  } as DraftRecord);
}

test('foreign partial disposal: cost base is the proportionate ORIGINAL cost, not acquisition minus proceeds', () => {
  clearDrafts();
  const code = '030-helvetia';
  postedDraft({ controlCode: code, eventType: 'ACQUISITION', origAmount: 20000, origCurrency: 'USD', quantity: 2000 });
  postedDraft({ controlCode: code, eventType: 'DISPOSAL', origAmount: 13000, origCurrency: 'USD', quantity: 1000 }); // 13k = proceeds
  const c = originalCostFor(code);
  assert.equal(c.currency, 'USD');
  assert.equal(c.amount, 10000); // 20000 * (1000 held / 2000 acquired) — NOT 20000-13000=7000
});

test('foreign loan: cost base is advances NET OF repayments (not advance + repayment)', () => {
  clearDrafts();
  const code = '032-ormco';
  postedDraft({ controlCode: code, eventType: 'LOAN_ADVANCE', origAmount: 50000, origCurrency: 'GBP' });
  postedDraft({ controlCode: code, eventType: 'LOAN_REPAYMENT', origAmount: 20000, origCurrency: 'GBP' });
  const c = originalCostFor(code);
  assert.equal(c.currency, 'GBP');
  assert.equal(c.amount, 30000); // 50000 - 20000 — NOT 70000
});

test('write-off zeroes the cost base', () => {
  clearDrafts();
  const code = '030-deadco';
  postedDraft({ controlCode: code, eventType: 'ACQUISITION', origAmount: 5000, origCurrency: 'USD', quantity: 500 });
  postedDraft({ controlCode: code, eventType: 'WRITE_OFF', origAmount: 5000, origCurrency: 'USD', quantity: 500 });
  assert.equal(originalCostFor(code).amount, 0);
});

test('full holding with no disposal returns the full acquisition cost', () => {
  clearDrafts();
  const code = '030-wholeco';
  postedDraft({ controlCode: code, eventType: 'ACQUISITION', origAmount: 20000, origCurrency: 'USD', quantity: 2000 });
  assert.equal(originalCostFor(code).amount, 20000);
});
