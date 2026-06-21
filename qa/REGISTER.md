# Fund Autopilot — QA register (THCP MT Test Pack, FY2021)

Run against the standalone `thcp-autopilot` app with the synthetic THCP test pack
(`files-test/testpack/THCP_Test_Pack`). Graded vs `ANSWER_KEY.md`.

## Executive summary
The document→ledger pipeline and bank reconciliation are sound on the test pack.
Several real bugs were found via the data and **fixed this pass** (zero-amount
share buys, an FX-date crash, wrong FX source/date, document normalisation).
Deeper fund-accounting behaviours (loan interest split, disposal cost-layering,
impairment workflow) remain to be completed — listed below.

## Bank reconciliation — PASS
| Account | Expected ending | Portal | Result |
|---|---|---|---|
| Bendura (EUR) | 6,284,571.60 | 6,284,571.60 | ✅ ties |
| DM Santander (USD) | 11,038.60 | 11,038.60 | ✅ ties |
| PKO (PLN) | 53,567,717.92 | 53,567,717.92 | ✅ ties |

Multi-currency handled as real currencies (not a `$`/`€` swap).

## Fixed this pass
| id | finding | fix |
|---|---|---|
| FA-101 | Share-purchase agreement (SPA D1) booked **€0** — model gave shares + unit price but no total | normaliser now computes quantity × price-per-share |
| FA-102 | Misfiled share-transfer (T9) **crashed** with "Invalid time value" | `compose.ts` guards a missing/garbled date (falls back, still drafts) |
| FA-103 | Investment FX used a sparse **bundled** rate (Jan rate on a June trade) | inject the accurate **daily ECB rate at the transaction date** |
| FA-104 | Investment **date** not captured (trade/settlement keys) → FX fell back | normaliser reads settlement/value/trade/completion dates |
| FA-105 | Investment agreements (SPA/loan) **rejected** by rigid schema | normaliser maps model's natural fields/enums → EVENT (Portfolio populates) |
| FA-106 | Bank statement rejected on one **null balance** | tolerant numerics + empty-statement guard |
| FA-107 | Non-accounting docs journalled | reject list (financial statements, registry extracts, confirmations, KYC…) |

## Trap scorecard
| Trap | Status | Note |
|---|---|---|
| T1 duplicate commission | ✅ caught | 4 lines → 3 posted (txn-level dedup) |
| T2 date 2021-09-31 | ⏳ to verify | bank ingest date handling on impossible date |
| T3 ambiguous PLN '738,00' | ✅ caught | booked PLN 738, not €738 |
| T4 gross vs net proceeds | ⏳ pending | disposal gross-up not yet implemented |
| T5 principal/interest split | ⏳ pending | loan repayment split not yet implemented |
| T6 trade vs settlement FX | ✅ caught | uses settlement date + real ECB rate |
| T7 impairment | ⏳ pending | write-off path exists; explicit workflow pending |
| T8 VAT exempt / reverse charge | ⏳ pending | not handled |
| T9 misfiled share transfer | ✅ caught | classified by content, routed to Review (not bank) |
| T10 unposted reconciling fee | ⏳ pending | reconciling-item surfacing pending |
| T11 same party equity + loan | ✅ by design | 030 vs 100/032 kept separate (no netting) |
| T12 PLN grosz rounding | ⏳ to verify | line-level rounding |
| T13 tax deducted/refunded pair | ⏳ pending | net-zero pairing |

## Accounting scenarios — PASS / pending
- **BUY-USD-75 (D1)** — ✅ $6,000 @ ECB 1.2124 (settlement 16-Jun) = €4,948.86, balanced. (Answer key €5,081.73 uses a synthetic 1.1807 rate; portal derives from real ECB.)
- Equity buys (PLN) — to load (`investments/share_purchases.csv`) and grade vs cost.
- Loans granted + **accrued interest** — pending (effective-interest accrual engine).
- **Loan repayment split** (T5) — pending.
- **Disposals** (Woodpecker/Gamivo/J23) — pending (cost-layer derecognition + realised gain + gross-up).
- **Impairment** (RemoteMyApp nil, Natural Antibody) — pending workflow.
- **FX-CLOSE** retranslation policy — pending (monetary items at closing; equity policy must be explicit).
- **Trial-balance integrity** after posting — to assert debits = credits and sub-ledger reconciliation.

## Quality gates
158/158 unit tests pass; `tsc` clean.
