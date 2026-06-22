# Journal-entry accuracy audit (accountant-expert)

_2026-06-22. Audit of the double-entry the engine produces per event type, the
accuracy of figure extraction, and FX-to-date correctness. Sign convention on
engine lines: positive = debit, negative = credit._

## A. Debits & credits per event type (`src/core/journal.ts`)

| Event | Entry | Verdict |
|---|---|---|
| ACQUISITION / LOAN_ADVANCE | Dr investment control (030/032) · Cr Bank (1010) | ✅ correct |
| LOAN_REPAYMENT | Dr Bank · Cr loan control (032) | ✅ correct |
| DISPOSAL | Dr Bank (proceeds) · Cr control (carrying cost) · Cr/Dr gain-or-loss (500) | ✅ correct — realised gain credits 500, loss debits it; proportionate carrying on partials |
| DISTRIBUTION (dividend received) | Dr Bank · Cr investment income (4000) | ✅ correct |
| FX_REVAL | Dr/Cr control · Cr/Dr FX gain-loss (6800) | ✅ correct |
| WRITE_OFF / impairment | Dr impairment loss (610) · Cr control | ✅ correct |
| INTEREST_ACCRUAL | **Dr investment control (030/032)** · Cr interest income | ⚠️ **accuracy gap** — accrued interest debits the **principal control**, inflating the holding, instead of a separate **accrued-interest receivable (105 / 032-1)**. Balances, but mis-states the holding vs interest. (= NH-4; a policy/mapping decision.) |

Every branch **balances** (debits = credits) by construction — verified across an
8,000-scenario deterministic fuzz. The only double-entry concern is the
INTEREST_ACCRUAL debit account.

## B. Figure extraction accuracy

The deterministic engine never invents figures — it books exactly what the reader
extracted. Extraction gaps found and fixed in this audit cycle:

- **Figures returned as an ARRAY** `[{label, value, currency}]` (a receivables
  purchase listing purchase-price + claim components; invoice line items) booked
  **€0** — the normaliser only scanned flat/nested fields. **Fixed**: take the
  headline value (purchase price / total / consideration / principal / amount due,
  else the largest) + its currency.
- Earlier in the session: loan principal under `principalAmount` / nested
  `amounts.principal`; foreign-currency dividend amount+currency; non-ISO dates;
  continental number formats — all fixed with regression tests.
- **New safety net**: a value-bearing event whose amount still can't be read is
  now **flagged** ("we couldn't read the amount — enter it before posting") and
  held below the bulk-approve bar, instead of posting a meaningless €0 entry.

## C. FX accurate to the transaction date — ✅ confirmed

For a non-EUR event the engine fetches the **real ECB rate for the exact
transaction date** (`getDailyRateToEur`, ECB via frankfurter, cached), and converts
`amount / rate`. Verified live and date-sensitive:

| Date | ECB EUR/PLN | PLN 191,000 → EUR |
|---|---|---|
| 2021-07-30 | 0.21913 | **€41,853.83** (rate as-at 2021-07-30) |
| 2022-06-30 | 0.21320 | €40,721.20 (rate as-at 2022-06-30) |

The functional amount, the rate used, and the rate date are all stored on the draft
and shown in the review screen, so the conversion is auditable.

## Known accuracy gaps (open)

1. **Receivables / debt purchase mis-booked** — a purchase of a *receivable/claim*
   (e.g. the Jupi Park claim bought from PLM Fund) is typed as a share ACQUISITION,
   so the debit goes to a **030 investment control** instead of an **Other
   receivables (240) account**, and the "investee" is set to the debtor rather than
   recognised as a receivable. It is also classified inconsistently (sometimes EVENT,
   sometimes EVIDENCE). **Right entry**: Dr `240-<debtor>` · Cr Bank/Payable at the
   purchase price (PLN 191,000 → €41,853.83 @ 2021-07-30). To fix: route a
   receivable/claim purchase to a 240 control (not 030), and classify it consistently.
2. **INTEREST_ACCRUAL debit account** (see table A) — accrued interest should debit a
   receivable, not the principal control.

Both are flagged for the next cycle; neither breaks the books (entries still
balance), but both affect which account carries the figure.
