import test from 'node:test';
import assert from 'node:assert/strict';
import { intakeIntentSchema } from './intake-schema';

const validEvent = {
  kind: 'EVENT',
  investeeName: 'Gamivo S.A.',
  instrument: 'SHARES',
  eventType: 'DISPOSAL',
  currency: 'EUR',
  txnDate: '2024-12-10',
  sourceFigures: { amount: 9000, quantity: 100, fairValue: null },
  confidence: 0.92,
  citation: 'SPA clause 3.1, page 2',
  rationale: 'Folder SHARES/DISPOSAL/GAMIVO and SPA sale of 100 shares for EUR 9000',
};

test('valid EVENT intent parses', () => {
  const r = intakeIntentSchema.safeParse(validEvent);
  assert.equal(r.success, true);
});

test('EVENT defaults needsReview to false and nullable figures to null', () => {
  const r = intakeIntentSchema.safeParse({
    ...validEvent,
    sourceFigures: { amount: 1200 },
  });
  assert.equal(r.success, true);
  if (r.success && r.data.kind === 'EVENT') {
    assert.equal(r.data.needsReview, false);
    assert.equal(r.data.sourceFigures.quantity, null);
    assert.equal(r.data.sourceFigures.fairValue, null);
  }
});

test('valid EVIDENCE intent parses', () => {
  const r = intakeIntentSchema.safeParse({
    kind: 'EVIDENCE',
    documentType: 'registry extract',
    investeeName: 'Booste S.A.',
    rationale: 'KRS registry extract — not a bookable event',
  });
  assert.equal(r.success, true);
});

test('UNKNOWN intent forces needsReview true', () => {
  const r = intakeIntentSchema.safeParse({ kind: 'UNKNOWN', rationale: 'illegible scan' });
  assert.equal(r.success, true);
  if (r.success && r.data.kind === 'UNKNOWN') assert.equal(r.data.needsReview, true);
});

test('bad eventType is rejected', () => {
  const r = intakeIntentSchema.safeParse({ ...validEvent, eventType: 'BUY' });
  assert.equal(r.success, false);
});

test('confidence out of range is rejected', () => {
  const r = intakeIntentSchema.safeParse({ ...validEvent, confidence: 1.5 });
  assert.equal(r.success, false);
});
