// Regression: an eventType the model emits that isn't in the alias map (and can't
// be inferred from share/loan signals) used to keep its raw value and hit the
// strict z.enum(INVESTMENT_EVENT_TYPES), so the WHOLE document failed to read —
// the same failure class as the instrument-enum bug. Two safeguards:
//  1. common unambiguous labels are aliased (redemption/buyback/repurchase -> DISPOSAL);
//  2. any still-unrecognised event label degrades to UNKNOWN (sent to review),
//     never a hard read-failure and never a wrong booking.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeIntakeObject, parseIntakeResponse } from './intake-parse';

const ev = (o: Record<string, unknown>) => (normalizeIntakeObject(o) as { kind?: string; eventType?: string });

test('a share redemption / buyback is aliased to DISPOSAL and parses', () => {
  const base = { kind: 'EVENT', investee: 'Acme S.A.', quantity: 100, amount: 50000, currency: 'EUR' };
  assert.equal(ev({ ...base, eventType: 'REDEMPTION' }).eventType, 'DISPOSAL');
  assert.equal(ev({ ...base, eventType: 'SHARE_BUYBACK' }).eventType, 'DISPOSAL');
  assert.equal(ev({ ...base, eventType: 'REPURCHASE' }).eventType, 'DISPOSAL');
  const r = parseIntakeResponse(JSON.stringify({ ...base, eventType: 'REDEMPTION' }));
  assert.equal(r.ok, true, r.ok ? '' : `should parse, got ${r.error}`);
});

test('an unrecognised event label degrades to UNKNOWN (review), not a read failure', () => {
  for (const eventType of ['CAPITAL_CALL', 'RETURN_OF_CAPITAL', 'CONVERSION', 'SOMETHING_NEW']) {
    const o = { kind: 'EVENT', eventType, investee: 'Acme S.A.', amount: 50000, currency: 'EUR' };
    assert.equal(ev(o).kind, 'UNKNOWN', `${eventType} should degrade to UNKNOWN`);
    const r = parseIntakeResponse(JSON.stringify(o));
    assert.equal(r.ok, true, `${eventType} must still parse (as UNKNOWN), got ${r.ok ? '' : r.error}`);
  }
});

test('valid event types are unaffected', () => {
  assert.equal(ev({ kind: 'EVENT', eventType: 'ACQUISITION', investee: 'X', quantity: 1, amount: 1, currency: 'EUR' }).eventType, 'ACQUISITION');
  assert.equal(ev({ kind: 'EVENT', eventType: 'DIVIDEND', investee: 'X', amount: 1, currency: 'EUR' }).eventType, 'DISTRIBUTION');
});
