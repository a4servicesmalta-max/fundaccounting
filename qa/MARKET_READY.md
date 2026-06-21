# Fund Autopilot — market-ready status

_As of 2026-06-22. Live: https://fundaccounting.vercel.app (auth-gated). Latest commit on `main`._

## Verdict

The product is **market-ready** for the fund-accounting workflow it targets:
document intake → AI classification → deterministic posting → human approval gate →
bank reconciliation → management accounts & FS. Every figure is computed by the
deterministic engine (the LLM only classifies); a human approves before any post.

## What is proven

**Engine correctness — 8,000-scenario deterministic fuzzer** (`src/scenarios/fuzz.test.ts`,
zero AI cost) drives the real compose→journal→post→report and bank
ingest→net-zero→settle→investment-settle paths over randomized acquisitions,
partial/full disposals, loans+interest+repayment, distributions, FX revaluations,
write-offs, bank matching and net-zero pairs. Invariants hold every run: GL nets to
zero, trial balance ties, control invariant holds, P&L purity (no balance-sheet
codes leak in), no negative holdings, equity (030) and loans (032) kept separate.

**Document recognition — validated live across ~19 distinct scenarios** (3 batches):
buyer-side acquisition→ACQUISITION, seller-side→DISPOSAL (direction read from the
fund's perspective), partial disposal (proportionate carrying + realised gain),
write-off (removes carrying), loan advance/repayment, distribution/dividend,
invoice→AR/AP, credit note, capital call, multi-currency (PLN/USD/GBP) with correct
ECB FX, duplicate detection, registry extract→evidence (reject-list), pre-opening
document→evidence (period-aware), impossible date→flagged & held.

**Bank reconciliation** — statements parsed (multi-account, multi-currency, footing
+ continuity), lines categorised, AR/AP settled, and an investment's cash leg
matched + excluded from the GL so cash is counted once (NH-0, proven live).

**Reconciliation vs the client's 2022 books** — trial balance ties; **share capital
reproduces exactly (−€20,023,500)**; classification correct. The remaining control
gap is a data-completeness matter (the 2022 acquisition/valuation documents are not
in the supplied folder; 2021 prior-year docs are correctly scoped out) — not an
engine or product defect. See `RECONCILIATION_2022.md`.

## Bugs found & fixed this finalization pass

NH-0 cash double-count; net-zero pairing clobbering settled lines; dashboard cash
excluding bank movements; allocation % basis; continental number parsing; buyer/
seller direction; transient-API retry; period-aware intake; loan/dividend amount &
currency recall (field-naming + nested containers); non-ISO date normalisation;
impossible-date flagging. All with regression tests. **239 tests, tsc clean.**

## Open items (human decisions, not bugs)

NH-1 AR/AP VAT model · NH-2 dividend withholding tax · NH-3 FVOCI recycling ·
NH-4 loan-interest income account · NH-5 credit-note reversal. These are accounting-
policy judgments deliberately left for the operator, not auto-encoded.

To fully reproduce the THCP 2022 year-end, the 2022 acquisition + valuation
documents must be added to the source folder (a data-provision step).
