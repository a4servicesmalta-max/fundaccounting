// Regression: a fund-ISSUED invoice (a receivable) whose filename lacks the word
// "invoice" — e.g. "USD receivable.txt" — wasn't routed to the Debtors & Creditors
// ledger. looksLikeInvoice only checks the file name + the AI's documentType, so it
// fell to the suggested-journal path: it hit the GL (Dr 1100) but was invisible in
// the Aging/Debtors view and couldn't be settled. Detect an invoice from CONTENT.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeInvoiceContent } from './process';

test('a fund-issued invoice is detected from its content', () => {
  assert.equal(looksLikeInvoiceContent({
    kind: 'text',
    text: 'INVOICE No. THCP-RX-9\nFrom: the fund  To: Borealis Ventures LLC\nDue date: 07 March 2025\nAmount due to us: USD 10,000.00 for advisory services.',
  }), true);
});

test('a supplier bill is detected from its content', () => {
  assert.equal(looksLikeInvoiceContent({
    kind: 'text',
    text: 'Faktura / Invoice No. FV/2025/0231\nSupplier: Kancelaria\nGross total due: PLN 49,200. Payment due within 14 days.',
  }), true);
});

test('a share purchase agreement is NOT detected as an invoice', () => {
  assert.equal(looksLikeInvoiceContent({
    kind: 'text',
    text: 'SHARE PURCHASE AGREEMENT. The Buyer acquires 500 shares in Helvetia Tech AG for CHF 300,000.',
  }), false);
});

test('a bank statement is NOT detected as an invoice', () => {
  assert.equal(looksLikeInvoiceContent({
    kind: 'text',
    text: 'HSBC Account statement. Opening balance 500,000. 10.02 Legal fees -2,000. Closing balance 498,000.',
  }), false);
});

test('non-text content is not detected', () => {
  assert.equal(looksLikeInvoiceContent({ kind: 'pdf', base64: 'abc' }), false);
});
