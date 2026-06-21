// Regression: amounts that arrive as continental- or anglo-formatted strings must
// parse to the correct number. The old strip-non-digits approach corrupted EU
// formats ("1.234,56" → 1.234; "1.234.567,00" → NaN), which would silently book
// figures off by orders of magnitude. Pure function — no store, no isolation needed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeIntakeObject } from './intake-parse';

function amountOf(raw: unknown): unknown {
  const o = normalizeIntakeObject({
    kind: 'EVENT', eventType: 'ACQUISITION', investeeName: 'Test Co',
    sourceFigures: { amount: raw },
  }) as { sourceFigures?: { amount?: unknown } };
  return o.sourceFigures?.amount;
}

test('parses anglo and continental number formats correctly', () => {
  const cases: [unknown, number][] = [
    [1234.56, 1234.56],          // already a number
    ['1234.56', 1234.56],        // plain decimal
    ['1,234.56', 1234.56],       // anglo thousands
    ['1.234,56', 1234.56],       // continental (the headline bug)
    ['1.234.567,00', 1234567],   // continental, multiple thousands groups
    ['1,234,567.89', 1234567.89],// anglo, multiple thousands groups
    ['12,50', 12.5],             // continental decimal, no thousands
    ['1,234', 1234],             // anglo thousands, no decimal
    ['2500000', 2500000],        // bare integer
    ['€3.500.000,00', 3500000],  // currency symbol + continental
    ['-1.234,56', -1234.56],     // negative continental
  ];
  for (const [input, expected] of cases) {
    assert.equal(amountOf(input), expected, `parse ${JSON.stringify(input)} → ${expected}`);
  }
});

test('the partial-disposal share-purchase example parses to the full figure', () => {
  // A bilingual SPA might state the total as "2.500.000,00".
  assert.equal(amountOf('2.500.000,00'), 2500000);
});
