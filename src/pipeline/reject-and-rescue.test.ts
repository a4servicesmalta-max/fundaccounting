// Regression for two real bugs found uploading client documents:
//  1. A client lead-schedule Excel ("R - Revenue.xlsx") posted an €11.5m phantom
//     entry — it must be rejected as a working paper (supporting), never booked.
//  2. A share SPA whose figures were returned as an `amounts:[…]` array wasn't
//     recognised as having money, so it fell to the free-form suggested-journal
//     path (mis-booked Dr 1100 / Cr 030) instead of a typed ACQUISITION.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isNonPostable } from './process';
import { normalizeIntakeObject } from '../core/intake-parse';

test('client lead-schedule / working-paper Excels are not postable', () => {
  const reject = [
    'R - Revenue.xlsx',
    'R - Expenses.xlsx',
    'F - Financial Asset 2021.xlsx',
    'J - Other receivables.xlsx',
    'K - Cash & Bank.xlsx',
    'L- Trade & other payables.xlsx',
  ];
  for (const f of reject) assert.equal(isNonPostable('', f), true, `${f} should be supporting, not posted`);
});

test('genuine transactional documents are STILL postable', () => {
  assert.equal(isNonPostable('invoice', 'J2C6 - Invoice INV-2471 Ormco.pdf'), false);
  assert.equal(isNonPostable('', 'J2C2 - 20210423_SPA_Booste share purchase.pdf'), false);
  assert.equal(isNonPostable('loan agreement', 'Umowa pozyczki.pdf'), false);
  assert.equal(isNonPostable('', '112021 Santander Banking statement.pdf'), false);
});

test('a share SPA with figures in an amounts[] array is rescued to a typed event', () => {
  const o = normalizeIntakeObject({
    kind: 'UNKNOWN', investee: 'BOOSTEE S.A.', quantity: 4650,
    amounts: [{ label: 'purchase price', value: '624972.00', currency: 'PLN' }],
  }) as { kind?: string; eventType?: string; sourceFigures?: { amount?: unknown }; currency?: unknown };
  assert.equal(o.kind, 'EVENT');
  assert.equal(o.eventType, 'ACQUISITION');
  assert.equal(o.sourceFigures?.amount, 624972);
  assert.equal(o.currency, 'PLN');
});

test('a hedged share SPA (no explicit quantity) is still rescued to a typed event', () => {
  // The share count was only implied by the instrument / share-number range — the
  // model hedged the kind. It must NOT fall to the free-form journal path.
  const o = normalizeIntakeObject({
    kind: 'EVIDENCE', documentType: 'Share Purchase Agreement', investee: 'BOOSTEE S.A.',
    instrument: 'Series A registered shares', shareSeries: 'A', amount: 624972, currency: 'PLN',
  }) as { kind?: string; eventType?: string; sourceFigures?: { amount?: unknown } };
  assert.equal(o.kind, 'EVENT');
  assert.equal(o.sourceFigures?.amount, 624972);
});

test('a registry extract (no money) is NOT over-rescued into an event', () => {
  const o = normalizeIntakeObject({
    kind: 'EVIDENCE', documentType: 'Malta Business Registry extract', investee: 'Gamivo S.A.',
  }) as { kind?: string };
  assert.equal(o.kind, 'EVIDENCE');
});
