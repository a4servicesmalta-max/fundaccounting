// Regression: partial disposal must remove only the PROPORTIONATE carrying
// amount of the units sold — not the whole position's carrying value.
//
// Self-isolating: point AUTOPILOT_DB at a fresh temp file BEFORE importing the
// store, so this test never touches the loop's working data. Asserts BEHAVIOUR
// (the carrying cost flowed out scales with units sold), not literal fixtures.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
// Self-isolate the store so running this file directly never touches real data.
process.env.AUTOPILOT_DB = path.join(os.tmpdir(), `thcp-partial-${process.pid}-${Math.random().toString(36).slice(2)}.json`);

import { getDb, persist, insertDraft, type DraftRecord } from '../db/store';
import { disposalCarryingCost, unitsHeldFor } from './positions';

function clearDrafts(): void {
  getDb().drafts.length = 0;
  persist();
}

function postedAcquisition(controlCode: string, units: number, costEur: number): void {
  const now = new Date().toISOString();
  const draft: DraftRecord = {
    id: `${controlCode}-${Math.random().toString(36).slice(2)}`,
    documentId: null,
    investeeName: 'Test Co',
    instrument: 'SHARES',
    eventType: 'ACQUISITION',
    controlCode,
    currency: 'EUR',
    txnDate: '2026-01-10',
    period: '2026-01',
    status: 'POSTED',
    sourceFigures: { amount: costEur, quantity: units, fairValue: null, currency: 'EUR' },
    engineFigures: {
      functionalAmount: costEur, currency: 'EUR', lineCount: 2, fxRate: null,
      fxRateDate: null, originalCurrency: 'EUR', originalAmount: costEur,
    },
    lines: [
      { accountCode: controlCode, accountName: 'inv', amount: costEur, description: '' },
      { accountCode: '1010', accountName: 'Bank', amount: -costEur, description: '' },
    ],
    confidence: 1, citation: null, rationale: null, docName: null, createdAt: now, postedAt: now,
  };
  insertDraft(draft);
}

test('partial disposal removes proportionate carrying (300 of 1000 @ 100,000 = 30,000)', () => {
  clearDrafts();
  const code = '030-partialco';
  postedAcquisition(code, 1000, 100000);
  assert.equal(unitsHeldFor(code), 1000);
  // Selling 300 of the 1000 held must release 30% of the carrying value.
  assert.equal(disposalCarryingCost(code, 300), 30000);
});

test('full disposal removes the whole carrying value', () => {
  clearDrafts();
  const code = '030-fullco';
  postedAcquisition(code, 500, 80000);
  assert.equal(disposalCarryingCost(code, 500), 80000);
});

test('unknown sold-quantity falls back to full carrying (conservative, flagged upstream)', () => {
  clearDrafts();
  const code = '030-noqty';
  postedAcquisition(code, 200, 40000);
  assert.equal(disposalCarryingCost(code, null), 40000);
});

test('selling more units than held never releases more than the carrying value', () => {
  clearDrafts();
  const code = '030-overco';
  postedAcquisition(code, 100, 10000);
  assert.equal(disposalCarryingCost(code, 250), 10000);
});
