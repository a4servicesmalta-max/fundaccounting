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

test('foreign-language invoices are detected (Italian Fattura, French Facture, German Rechnung)', () => {
  assert.equal(looksLikeInvoiceContent({ kind: 'text', text: 'FATTURA n. IT-2025-44 Fornitore: Studio Legale. Scadenza: 04 aprile 2025 Importo dovuto: EUR 3.500,00' }), true);
  assert.equal(looksLikeInvoiceContent({ kind: 'text', text: 'FACTURE n. FR-9 Fournisseur: Cabinet. Échéance: 04 avril 2025 Montant dû: EUR 2.000' }), true);
  assert.equal(looksLikeInvoiceContent({ kind: 'text', text: 'RECHNUNG Nr. CH-90 Lieferant: Helvetia. Fälligkeit: 18 März 2025 Betrag fällig: CHF 2.000' }), true);
});

test('a fund-issued fee note / statement of fees is detected (no "invoice" word)', () => {
  assert.equal(looksLikeInvoiceContent({
    kind: 'text',
    text: 'STATEMENT OF FEES No. THCP-FEE-7 (issued by the fund)\nTo: Borealis Ventures LLC\nDue date: 06 March 2025\nAmount due to us: USD 8,000.00 for advisory services rendered.',
  }), true);
  // a "debit note" is also an invoice-equivalent
  assert.equal(looksLikeInvoiceContent({
    kind: 'text', text: 'DEBIT NOTE DN-12. Amount due: EUR 1,200. Payment due within 30 days.',
  }), true);
});

test('a financial statement / bank statement is NOT detected (no false positive on "statement")', () => {
  assert.equal(looksLikeInvoiceContent({ kind: 'text', text: 'Statement of financial position as at 31 December 2024. Total assets 5,000,000. Amount: balance.' }), false);
  assert.equal(looksLikeInvoiceContent({ kind: 'text', text: 'SANTANDER account statement. Opening balance 800,000. Closing balance 803,050 as at due period.' }), false);
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
