// Regression for a real Mode-B bug: a Santander bank statement (dropped as text)
// was NOT routed to the Bank pipeline — `looksLikeBankStatement` only checks the
// file name + the AI's documentType, and "Santander statement" matches neither
// "bank statement" nor "account statement", while an UNKNOWN intent carries no
// documentType. So the statement fell through to the suggested-journal path and
// was booked as a nonsensical 5-line compound entry. Detect a statement from its
// CONTENT (IBAN + opening/closing balance + dated lines) so it can't be missed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeBankStatementContent } from './process';

const santander = {
  kind: 'text' as const,
  text: `SANTANDER BANK POLSKA — Account statement
Account holder: Tar Heel Capital Pathfinder MT Limited
Account: PL61 1090 0000 0000 0001 2345 6789  (currency: PLN)
Period: 01.02.2025 - 28.02.2025
Opening balance: 1,000,000.00 PLN
05.02.2025  Outgoing transfer - loan advance to Climax    -250,000.00
18.02.2025  Card payment - office supplies                   -1,250.00
22.02.2025  Incoming - interest received from J23 loan      +12,400.00
28.02.2025  Bank charges                                        -85.00
Closing balance: 760,065.00 PLN`,
};

test('a bank statement is detected from its content (IBAN + balances + dated lines)', () => {
  assert.equal(looksLikeBankStatementContent(santander), true);
});

test('a share purchase agreement is NOT detected as a bank statement', () => {
  assert.equal(
    looksLikeBankStatementContent({
      kind: 'text',
      text: `SHARE PURCHASE AGREEMENT dated 20 March 2025. The Seller sells 4,650 Series A
registered shares in BOOSTE S.A. to the Buyer for PLN 624,972. Closing on signing.`,
    }),
    false,
  );
});

test('a financial statement is NOT detected as a bank statement', () => {
  assert.equal(
    looksLikeBankStatementContent({
      kind: 'text',
      text: `Statement of financial position as at 31 December 2024. Total assets 5,000,000.
Total equity 4,200,000. Comparative period 31 December 2023.`,
    }),
    false,
  );
});

test('non-text content (no extractable text) is not falsely detected', () => {
  assert.equal(looksLikeBankStatementContent({ kind: 'pdf', base64: 'abc' }), false);
});
