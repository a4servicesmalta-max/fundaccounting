import test from 'node:test';
import assert from 'node:assert/strict';
import { extractJsonObject, parseIntakeResponse, normalizeIntakeObject } from './intake-parse';

// A real read of the Booste share-purchase agreement: the model returned its own
// natural field names/enums. The normaliser must turn it into a valid EVENT.
test('normalises the model’s natural share-disposal output into a valid EVENT', () => {
  const raw = {
    kind: 'EVENT', eventType: 'SHARE_DISPOSAL', investee: 'Booste Spółka Akcyjna',
    documentDate: '2021-07-15', currency: 'PLN', quantity: 4650, totalPrice: '624972',
    seller: 'Tar Heel Capital Pathfinder MT Limited', buyer: 'Mariusz Kozlowski',
  };
  const r = parseIntakeResponse(JSON.stringify(raw));
  assert.equal(r.ok, true);
  if (r.ok && r.intent.kind === 'EVENT') {
    assert.equal(r.intent.eventType, 'DISPOSAL');
    assert.equal(r.intent.instrument, 'SHARES');
    assert.equal(r.intent.investeeName, 'Booste Spółka Akcyjna');
    assert.equal(r.intent.currency, 'PLN');
    assert.equal(r.intent.txnDate, '2021-07-15');
    assert.equal(r.intent.sourceFigures.amount, 624972);
    assert.equal(r.intent.sourceFigures.quantity, 4650);
  }
});

test('normalises a loan agreement into LOAN_ADVANCE / LOAN', () => {
  const raw = { kind: 'EVENT', eventType: 'LOAN_GRANTED', company: 'J23 S.A.', loanAmount: 500000, currency: 'PLN', agreementDate: '2021-02-25' };
  const r = parseIntakeResponse(JSON.stringify(raw));
  assert.equal(r.ok, true);
  if (r.ok && r.intent.kind === 'EVENT') {
    assert.equal(r.intent.eventType, 'LOAN_ADVANCE');
    assert.equal(r.intent.instrument, 'LOAN');
    assert.equal(r.intent.sourceFigures.amount, 500000);
  }
});

test('normalizeIntakeObject leaves EVIDENCE/UNKNOWN untouched', () => {
  const ev = { kind: 'EVIDENCE', documentType: 'invoice' };
  assert.deepEqual(normalizeIntakeObject(ev), ev);
});

const eventJson = JSON.stringify({
  kind: 'EVENT',
  investeeName: 'Gamivo S.A.',
  instrument: 'SHARES',
  eventType: 'DISPOSAL',
  currency: 'EUR',
  txnDate: '2024-12-10',
  sourceFigures: { amount: 9000 },
  confidence: 0.9,
  citation: 'clause 3',
  rationale: 'disposal',
});

test('extractJsonObject reads a bare JSON object', () => {
  assert.deepEqual(extractJsonObject('{"a":1}'), { a: 1 });
});

test('a read is NOT rejected when the model omits rationale/citation', () => {
  // The Ormco-invoice / Santander-statement failure: model returned a valid
  // intent but left out the prose fields. These must default, not error.
  const evidence = parseIntakeResponse(JSON.stringify({ kind: 'EVIDENCE', documentType: 'invoice' }));
  assert.equal(evidence.ok, true);
  if (evidence.ok) assert.equal(evidence.intent.rationale, '');

  const event = parseIntakeResponse(JSON.stringify({
    kind: 'EVENT',
    investeeName: 'J23 S.A.',
    instrument: 'SHARES',
    eventType: 'ACQUISITION',
    currency: 'EUR',
    txnDate: '2021-06-01',
    sourceFigures: { amount: 5000 },
    // no confidence, citation or rationale
  }));
  assert.equal(event.ok, true);
  if (event.ok && event.intent.kind === 'EVENT') {
    assert.equal(event.intent.rationale, '');
    assert.equal(event.intent.citation, '');
    assert.equal(event.intent.confidence, 0.6);
  }
});

test('extractJsonObject strips ```json fences', () => {
  assert.deepEqual(extractJsonObject('```json\n{"a":2}\n```'), { a: 2 });
});

test('extractJsonObject recovers JSON embedded in prose', () => {
  assert.deepEqual(extractJsonObject('Here you go: {"a":3} thanks'), { a: 3 });
});

test('parseIntakeResponse returns ok for a valid EVENT', () => {
  const r = parseIntakeResponse(eventJson);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.intent.kind, 'EVENT');
});

test('parseIntakeResponse returns {ok:false} for non-JSON', () => {
  const r = parseIntakeResponse('I could not read the document.');
  assert.equal(r.ok, false);
});

test('parseIntakeResponse returns {ok:false} for schema-invalid JSON', () => {
  const r = parseIntakeResponse('{"kind":"EVENT","eventType":"BUY"}');
  assert.equal(r.ok, false);
});

// The model sometimes HEDGES a bilingual SPA to EVIDENCE/UNKNOWN even though it
// read the deal details. Strong investment signals must still produce a typed
// EVENT so the holding actually posts (the autonomy gap from the 2022 test).
test('rescues an SPA the model hedged to EVIDENCE into a typed ACQUISITION', () => {
  const raw = {
    kind: 'EVIDENCE', documentType: 'Share purchase agreement',
    investee: 'SkinWallet S.A.', shares: 1200, pricePerShare: 50, currency: 'PLN', signingDate: '2021-11-23',
  };
  const r = parseIntakeResponse(JSON.stringify(raw));
  assert.equal(r.ok, true);
  if (r.ok && r.intent.kind === 'EVENT') {
    assert.equal(r.intent.eventType, 'ACQUISITION');
    assert.equal(r.intent.instrument, 'SHARES');
    assert.equal(r.intent.investeeName, 'SkinWallet S.A.');
    assert.equal(r.intent.sourceFigures.amount, 60000); // 1200 × 50 derived
  } else { assert.fail('expected EVENT'); }
});

// A bare "share sale agreement" title (the heading of EVERY SPA, whether the fund
// buys or sells) does not decide direction: the deterministic fallback defaults to
// ACQUISITION (a fund's predominant action). The precise buyer-vs-seller call is the
// AI's, which is given the reporting entity. This is the fix for buyer-side SPAs that
// used to be mis-booked as disposals and understated the holdings.
test('a bare share-sale title is ambiguous → fallback defaults to ACQUISITION', () => {
  const raw = { kind: 'UNKNOWN', documentTitle: 'Umowa sprzedaży udziałów', investee: 'Woodpecker.co', quantity: 800, totalPrice: 596955, currency: 'PLN' };
  const r = parseIntakeResponse(JSON.stringify(raw));
  assert.equal(r.ok, true);
  if (r.ok && r.intent.kind === 'EVENT') assert.equal(r.intent.eventType, 'ACQUISITION');
  else assert.fail('expected EVENT');
});

test('an explicit seller/disposal signal still yields DISPOSAL', () => {
  const raw = { kind: 'UNKNOWN', documentTitle: 'Share sale — the Fund as Seller disposes its holding', investee: 'Woodpecker.co', quantity: 800, totalPrice: 596955, currency: 'PLN' };
  const r = parseIntakeResponse(JSON.stringify(raw));
  assert.equal(r.ok, true);
  if (r.ok && r.intent.kind === 'EVENT') assert.equal(r.intent.eventType, 'DISPOSAL');
  else assert.fail('expected EVENT');
});

test('rescues a hedged loan agreement into LOAN_ADVANCE', () => {
  const raw = { kind: 'EVIDENCE', documentType: 'Umowa pożyczki', borrower: 'Climax Investments', principal: 3015000, currency: 'EUR' };
  const r = parseIntakeResponse(JSON.stringify(raw));
  assert.equal(r.ok, true);
  if (r.ok && r.intent.kind === 'EVENT') { assert.equal(r.intent.eventType, 'LOAN_ADVANCE'); assert.equal(r.intent.instrument, 'LOAN'); }
  else assert.fail('expected EVENT');
});

test('a genuine non-investment evidence doc is NOT converted', () => {
  const raw = { kind: 'EVIDENCE', documentType: 'Malta Business Registry extract', company: 'Gamivo S.A.' };
  const r = parseIntakeResponse(JSON.stringify(raw));
  // No shares/loan + amount → stays EVIDENCE (not forced to an event).
  assert.equal(r.ok, true);
  if (r.ok) assert.notEqual(r.intent.kind, 'EVENT');
});
