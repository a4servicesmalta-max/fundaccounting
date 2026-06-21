# THCP 2022 Reconciliation — final grading

_Run 2026-06-21 on the latest engine (classifier + retry + period-aware intake), server :4350, full 109-document import (0 errors, 0 failures, avg 22s/doc)._

## Verdict

The **engine, approval gate, and classification are correct**. The books **tie** and
**share capital reproduces the client's figure exactly**. The investment-control
totals do **not** reach the year-end baseline — for a **data** reason that is now
understood and correctly handled, **not** an engine or product defect. No figures
were fitted to the baseline.

## What reproduces exactly

| Check | Result |
|---|---|
| Trial balance ties (Dr = Cr) | ✅ €102,140,778.52 = €102,140,778.52 |
| Share capital (802) | ✅ **−€20,023,500.00** — exact to the baseline |
| P&L purity (no balance-sheet/suspense codes) | ✅ |
| Loans (032) vs equity (030) kept separate | ✅ |
| Engine invariants | ✅ 8,000-scenario deterministic fuzz, all hold |

## The gap, explained

Baseline year-end controls vs the portal after posting all extracted events:

| Control | Portal | Baseline | Gap |
|---|---|---|---|
| 030 Shares | 12,047,663 | 20,973,095 | −8,925,432 |
| 032 Loans | 31,761,064 | 33,526,876 | −1,765,812 |
| 032-1 Interest | 265,384 | 1,482,549 | −1,217,165 |

Root cause — **temporal scope of the document set**. Of the 27 posted events:

- **21 are dated on/before 2021-12-31** (prior-year SPAs: the THCP PL → THCP MT
  restructuring and onward sales). These are already captured in the brought-forward
  **opening balance** (the 2021 closing TB). Re-booking them double-counts.
- **6 are genuine 2022 events**, and they move 030 by only −€106,285 (one disposal).

So the **2022 acquisition and valuation documents** that grew the portfolio from the
€11.87M opening to the €20.97M year-end (≈ +€9.1M) are **not present in the supplied
"Supporting Documents" folder**. The portal can only book what it is given; it
faithfully booked every event in the folder and tied the books.

## What changed this cycle (product, not data)

1. **Buyer/seller classification** — confirmed working: the AI now states the fund's
   side explicitly ("Reporting entity Tar Heel Capital Pathfinder MT Limited is the
   Seller…"). Direction is correct; these genuinely are disposals from the fund's view.
2. **Period-aware intake (new)** — a document dated on/before the books opening date is
   filed as supporting evidence, not re-booked (prevents the prior-year double-count).
   Configurable via `POST /api/settings {booksOpeningDate}` or the opening import
   (`openingDate` / derived from the opening period). With it set to 2021-12-31, the
   21 prior-year docs file as evidence and only the 6 true-2022 events post.
3. **Transient-retry intake** — a rate-limit/credit blip no longer silently drops a
   document to UNKNOWN.

## Honest residual (for the human)

- To fully reproduce the 2022 year-end, the **2022 acquisition + valuation documents
  must be added** to the folder. This is a data-provision step, not a code fix.
- 2 low-confidence drafts were held by the gate (below the bulk-approve bar) — correct
  behaviour; a reviewer would classify them.
- A handful of documents carry impossible/foreign dates (one 2024, one undated) — these
  are flagged for review rather than silently posted.

_No baseline figure was hard-coded or special-cased; the engine remains
LLM-classifies-only with deterministic figures and a human gate before every post._
