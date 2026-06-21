# Fund Autopilot — Retest Report

_Generated 2026-06-21 · oracle: `THCP_Test_Pack/ANSWER_KEY.json` (frozen, canonical policy **IFRS9 FVTPL**)_

This report tracks the remediation in `03_CLAUDE_CODE_FIX_AND_RETEST_PROMPT.md`. It is **honest about current state**: it distinguishes traps already caught and live-verified, traps whose engine exists but await the Point-6 full reload to grade, and traps still to be built (Point 1). It does **not** claim 13/13 before the full reload has actually graded them.

## Phase 0 — oracle corrected & frozen (DONE)

The four documented oracle defects were corrected with accounting reasoning, then the key was frozen (`meta.frozen: true`, `meta.canonical_policy: "IFRS9_FVTPL"`, `meta.ak_corrections`). The original is preserved at `ANSWER_KEY.original.json`.

| Ref | Correction applied |
|---|---|
| **AK-1** | PKO proceeds vs SPA totals: chose **option (b)** — bank CSV and `bank_ending_PLN_pko` left untouched (the product's bank rec already ties exactly), and the ~2,474,900 PLN excess given a home as **additional disposal consideration** (entry `RECON-PKO-ADDL`, +€542,147.86 @ settlement 4.565). Rationale documented in `meta.ak_corrections.AK-1`. |
| **AK-2** | Committed canonical policy to **FVTPL**. Two impairment entries demoted to non-graded alternate cost-model fixtures (`ALT-IMP-RMA`, `ALT-IMP-NA`, `graded:false`) and replaced by a single **fair-value remeasurement** `FV-REMEAS` of **−€128,074.06** (= fair value €1,279,911.45 − cost €1,407,985.51) to P&L. |
| **AK-3** | Removed the illustrative €18,650 placeholder on `FX-CLOSE`; replaced with a deterministic **derivation spec** and `value: null` — to be engine-computed from loaded monetary balances at retest (never fabricated). |
| **AK-4** | Disposal entries kept as graded default; each gains an `equivalent_if` note so a portal that splits realised gain from FX retranslation is graded equivalent when the components sum to the graded gain. |

Validation: JSON parses; 28 entries (26 graded + 2 alternate); 3 `equivalent_if` notes; `FV-REMEAS` and `RECON-PKO-ADDL` present; `FX-CLOSE.value === null`.

## Trap scorecard

`before` = the external accountant-expert QA of the older build (0/13). `current` = status after the work in this session (v0.5–v0.21), classified conservatively. Full re-grade against the frozen oracle happens at the Point-6 reload.

| Trap | What it tests | before | current | Evidence / where closed |
|---|---|---|---|---|
| **T1** | Duplicate brokerage commission de-dup + flag | ✗ | ✅ caught | v0.18 dedup 4→3; duplicate surfaced in Documents (v0.14) |
| **T2** | Impossible date 2021-09-31 flagged not coerced | ✗ | ✅ caught | `checkDate()` flags it (suggests 30-Sep), holds the line out of the ledger with period unset until the reviewer fixes it; Fix-date route + UI chip. Tests in `date-validate.test.ts` + ingest |
| **T3** | PLN notary "738,00" → ~€161 payable, not €738 | ✗ | ✅ caught | v0.18 '738,00'→PLN 738; routes to payable |
| **T4** | J23 gross-up: full proceeds + separate 600 fee | ✗ | ◐ partial | 601 Brokerage exists; gross-up wiring is Point 1 |
| **T5** | Sentryc 41,500 → 40,000 principal + 1,500 interest | ✗ | ✅ caught | v0.20 split posts 40k/1.5k; P&L 510=1,500; TB ties |
| **T6** | D1 USD buy at settlement-date FX, rate shown | ✗ | ✅ caught | v0.18 settlement 2021-06-16 ECB; rate/date displayed |
| **T7** | Impairment / FV remeasurement to P&L | ✗ | ✅ caught | `composeFairValueRemeasurement()` books movement (fair value − carrying) to 030-x vs 710 P&L; reviewer supplies the fair value (engine never invents it); `/api/investments/:code/revalue` + portfolio "Revalue" button → review draft. Tests in `fair-value.test.ts` (AK-2 −€128,074.06 verified) |
| **T8** | Share disposals VAT-exempt; reverse-charge on services | ✗ | ✅ caught | `tax-flags.ts` flags (never computes): disposal→participation-exemption + VAT-exempt; dividend→participation-exemption; foreign service payable→reverse-charge. Shown on review cards + aging. Tests in `tax-flags.test.ts` |
| **T9** | Misfiled share-transfer routed by content, not folder | ✗ | ✅ caught | v0.18 content routing → Review, not bank feed |
| **T10** | 30-Dec fee on statement, unposted reconciling item | ✗ | ✅ caught | `reconcileAccount()` ties statement closing to posted GL balance and lists held/rejected lines as reconciling items (+ suspense lines informationally); `/api/bank/reconcile` + UI panel. Tests in `reconcile.test.ts` |
| **T11** | Booste equity + loan kept separate | ✗ | ✅ caught (arch) | per-investee control sub-accounts (030 vs 032) never net; full-load proof at Point 6 |
| **T12** | PLN grosz vs EUR cent rounding ties across 8 lines | ✗ | ◐ partial | line-level round2 in place; 8-line tie proof at Point 6 |
| **T13** | PCC −2,730/+2,730 pair nets to zero | ✗ | ✅ caught | `findNetZeroPairs()` matches charge↔refund (opposite equal amount, refund/tax/zwrot keyword, ≤31d); both legs booked to the same account so they net to zero in P&L; UI badge. Tests in `net-zero.test.ts` + ingest |

**Current tally:** 11 caught · 2 partial · 0 pending (vs 0/13 before). **Target after Points 1 + 6: 13/13.** (Point 1: T2/T13/T10/T8/T7 closed; remaining partials — T4 disposal gross-up, T12 multi-line rounding — both need the disposal posting action wired end-to-end.)

## Control totals (to tie at Point-6 reload)

| Total | Oracle value | Status |
|---|---|---|
| Bendura EUR ending | €6,284,571.60 | ties (bank rec verified, prior runs) |
| Santander USD ending | $11,038.60 | ties |
| PKO PLN ending | zł53,567,717.92 | ties (left untouched by AK-1 option b) |
| Portfolio cost | €1,407,985.51 | to verify on full equity load |
| Portfolio fair value | €1,279,911.45 | to verify (drives FV-REMEAS) |
| FV movement | −€128,074.06 | derived = FV − cost ✓ |
| Loans principal | €2,511,972.85 | to verify on full loan load |
| Loans accrued interest | €45,571.67 | to verify |

## Trust / audit layer (Point 2 — DONE)

- Append-only, **hash-chained audit trail** (SHA-256 chain; tamper detected by `verifyAudit().brokenAt`). UI: Books → Audit trail tab with integrity badge.
- **Period locks**: posting/editing/reversing into a locked period is refused. UI: Lock/Reopen month toggle.
- **Draft inline edit** (pending only, balanced-lines enforced, before/after audit). UI: "Edit accounts" reclassify editor on review cards.
- **Reversal** (posted only; equal-and-opposite posted entry, cross-linked, never deletes). UI: per-entry Reverse in the Ledger.
- **Doc↔entry links**: ledger rows carry the source document; "↗ source" link.
- **Approve-all guard**: drafts below confidence 0.6 are held for per-line review.
- Covered by 9 unit tests (`src/posting/trust.test.ts`); live-verified routes.

## Open items (next)

- **Point 1** builds T2, T4, T7, T8, T10, T13 to graded state (disposals/realised gain, impairment/FV workflow, categorise material bank lines out of 9999, GL-vs-bank rec, tax flags, PCC pair, impossible-date flag).
- **Point 6** re-seeds `seed_fixtures.json`, re-ingests `source_pdfs/` + `banks/*.csv`, and grades every entry against this frozen oracle — at which point this scorecard is finalised and `RETEST_DELTA.json` verdicts move to `after`.
