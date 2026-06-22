// Regression for a real bug: the model echoes the document's wording for the
// instrument ("ordinary shares", "preferred stock", "loan note", "Umowa
// pożyczki"). normalizeIntakeObject passed it through as String(x).toUpperCase(),
// so "ordinary shares" -> "ORDINARY SHARES", which the schema enum
// z.enum(['SHARES','LOAN']) REJECTS — and the WHOLE document failed to read
// ("the AI reader couldn't make sense of this document"). The instrument must be
// coerced to the canonical SHARES|LOAN.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeIntakeObject, parseIntakeResponse } from './intake-parse';

const inst = (o: Record<string, unknown>) =>
  (normalizeIntakeObject(o) as { instrument?: string }).instrument;

test('share synonyms coerce to SHARES', () => {
  const base = { kind: 'EVENT', eventType: 'DISPOSAL', investee: 'Plum Research S.A.', amount: 600000, currency: 'EUR' };
  assert.equal(inst({ ...base, instrument: 'ORDINARY SHARES' }), 'SHARES');
  assert.equal(inst({ ...base, instrument: 'Series A registered shares' }), 'SHARES');
  assert.equal(inst({ ...base, instrument: 'preferred stock' }), 'SHARES');
  assert.equal(inst({ ...base, instrument: 'equity interest' }), 'SHARES');
  assert.equal(inst({ ...base, instrument: 'akcje' }), 'SHARES');
});

test('loan synonyms coerce to LOAN', () => {
  const base = { kind: 'EVENT', eventType: 'LOAN_ADVANCE', investee: 'Climax', amount: 250000, currency: 'PLN' };
  assert.equal(inst({ ...base, instrument: 'loan note' }), 'LOAN');
  assert.equal(inst({ ...base, instrument: 'promissory note' }), 'LOAN');
  assert.equal(inst({ ...base, instrument: 'Umowa pożyczki' }), 'LOAN');
});

test('an EVENT with a free-text instrument now PARSES (whole doc no longer fails)', () => {
  const json = JSON.stringify({
    kind: 'EVENT', eventType: 'DISPOSAL', investee: 'Plum Research S.A.',
    instrument: 'ordinary shares', quantity: 1000, amount: 600000, currency: 'EUR', date: '2025-05-15',
  });
  const r = parseIntakeResponse(json);
  assert.equal(r.ok, true, r.ok ? '' : `should parse, got: ${r.error}`);
  if (r.ok) {
    assert.equal(r.intent.kind, 'EVENT');
    assert.equal((r.intent as { instrument?: string }).instrument, 'SHARES');
  }
});
