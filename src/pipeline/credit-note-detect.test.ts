// Regression: a supplier CREDIT NOTE (which reduces what the fund owes) was filed
// as another positive PAYABLE — so a €4,000 bill + a €1,000 credit note netted to
// €5,000 payables instead of €3,000. A credit note's amount must be negated so it
// offsets the related invoice. Detected from file name / content, multilingual.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeCreditNote } from './process';

test('credit notes are detected (EN/IT/DE/FR/PL)', () => {
  assert.equal(looksLikeCreditNote('Credit note Orange.txt', { kind: 'text', text: 'CREDIT NOTE No. CN-12 credit amount EUR 1,000' }), true);
  assert.equal(looksLikeCreditNote('x.txt', { kind: 'text', text: 'NOTA DI CREDITO n. 5 importo EUR 500' }), true);
  assert.equal(looksLikeCreditNote('x.txt', { kind: 'text', text: 'GUTSCHRIFT Nr. 9 Betrag EUR 500' }), true);
  assert.equal(looksLikeCreditNote('x.txt', { kind: 'text', text: 'NOTE DE CRÉDIT n. 3 montant EUR 500' }), true);
  // filename alone is enough (PDF content not text)
  assert.equal(looksLikeCreditNote('CN-2025 credit note.pdf', { kind: 'pdf', base64: 'abc' }), true);
});

test('an ordinary invoice/bill is NOT a credit note', () => {
  assert.equal(looksLikeCreditNote('Invoice OR-100.txt', { kind: 'text', text: 'INVOICE No. OR-100 total amount due EUR 4,000' }), false);
  assert.equal(looksLikeCreditNote('Fattura.txt', { kind: 'text', text: 'FATTURA n. 44 Importo dovuto EUR 3.500' }), false);
});
