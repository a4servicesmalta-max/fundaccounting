// Deterministic scenario fuzzer — drives the REAL engine (compose → journal →
// post → report) and the REAL bank pipeline (ingest → net-zero → settle →
// investment-settle) over hundreds of randomized-but-VALID scenarios, asserting
// accounting invariants after each. Zero AI cost: only document *intake* needs the
// model; everything the figures depend on is deterministic and exercised here.
//
// Invariants checked every scenario:
//   I1  every GL line nets to zero (double-entry holds across drafts+bank+AR/AP)
//   I2  trial balance ties (sum debits == sum credits)
//   I3  control invariant holds (portfolio carrying == GL balance) → no warnings
//   I4  P&L is pure (no balance-sheet / control / suspense codes leak in)
//   I5  no holding carries a materially negative value (disposal never over-releases)
//   I6  equity (030) and loans (032) stay SEPARATE in the portfolio totals
//
// Reproducible: a seeded PRNG; on failure the seed + iteration are printed so the
// exact scenario can be replayed. Tune with FUZZ_ITERS / FUZZ_SEED env vars.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
process.env.AUTOPILOT_DB = path.join(
  os.tmpdir(),
  `thcp-fuzz-${process.pid}-${Math.random().toString(36).slice(2)}.json`,
);

import { getDb, persist, insertDraft, type DraftRecord } from '../db/store';
import { composeDraft } from '../core/compose';
import { controlCodeFor } from '../core/chart';
import { ensureAccount } from '../core/chart-store';
import type { RatePoint } from '../core/fx';
import type { FundAccountRefs, InvestmentEventType, Instrument } from '../core/types';
import { carryingValueFor, disposalCarryingCost, unitsHeldFor } from '../report/positions';
import { trialBalance, portfolio, profitAndLoss, ledger } from '../report/report';
import { findOrCreateAccount, insertStatement, type BankTransaction } from '../bank/bank-store';
import { ingestStatement, type ExtractedBankStatement } from '../bank/ingest';

// --- seeded PRNG (mulberry32) ------------------------------------------------
function makeRng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Offline FX table (rate = foreign units per 1 EUR), dated before any scenario.
const RATES: RatePoint[] = [
  { currency: 'PLN', rateDate: new Date('2019-01-01'), rate: 4.3 },
  { currency: 'USD', rateDate: new Date('2019-01-01'), rate: 1.08 },
  { currency: 'GBP', rateDate: new Date('2019-01-01'), rate: 0.85 },
];
const CCYS = ['EUR', 'EUR', 'EUR', 'PLN', 'USD', 'GBP']; // EUR-weighted

const REFS = (controlCode: string): FundAccountRefs => ({
  controlCode, bankCode: '1010', gainLossCode: '750-1', incomeCode: '4000', fxCode: '6800', writeOffCode: '610',
});

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'x';
}

const BS_PREFIX = /^(030|032|1010|1011|101|130|2010|802|9999|240|100)/; // balance-sheet / control / suspense

interface Investee {
  name: string; instrument: Instrument; currency: string;
  controlCode: string; units: number; costOrig: number;
}

function reset(): void {
  const db = getDb();
  db.drafts.length = 0;
  db.bankTransactions.length = 0;
  db.bankStatements.length = 0;
  db.bankAccounts.length = 0;
  if (Array.isArray(db.arapItems)) db.arapItems.length = 0;
  persist();
}

function isoDate(rng: () => number, monthSeq: number): string {
  // Spread across 2022, monotonically-ish increasing by monthSeq.
  const m = Math.min(12, 1 + (monthSeq % 12));
  const day = 1 + Math.floor(rng() * 27);
  return `2022-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Post an investment event through the REAL compose→journal path (status POSTED). */
function postEvent(
  inv: Investee, eventType: InvestmentEventType, amountOrig: number, qty: number | null, date: string,
): void {
  ensureAccount(inv.controlCode, inv.name, 'ASSET');
  let carrying: number | undefined;
  if (eventType === 'DISPOSAL') carrying = disposalCarryingCost(inv.controlCode, qty);
  else if (eventType === 'WRITE_OFF') carrying = carryingValueFor(inv.controlCode);

  const comp = composeDraft(
    {
      kind: 'EVENT', investeeName: inv.name, instrument: inv.instrument, eventType,
      currency: inv.currency, txnDate: date,
      sourceFigures: { amount: amountOrig, quantity: qty, fairValue: null },
      confidence: 1, citation: '', rationale: '', needsReview: false,
    },
    { rates: RATES, refs: REFS(inv.controlCode), carryingCostFunctional: carrying },
  );
  const now = new Date('2022-01-01').toISOString();
  insertDraft({
    id: crypto.randomUUID(), documentId: null, investeeName: inv.name, instrument: inv.instrument,
    eventType, controlCode: inv.controlCode, currency: inv.currency, txnDate: date,
    period: date.slice(0, 7), status: 'POSTED',
    sourceFigures: comp.sourceFigures, engineFigures: comp.engineFigures, lines: comp.engineLines,
    confidence: 1, citation: null, rationale: null, docName: null, createdAt: now, postedAt: now,
  } as DraftRecord);
}

function buildScenario(seed: number): void {
  reset();
  const rng = makeRng(seed);
  const investees: Investee[] = [];
  const nInv = 2 + Math.floor(rng() * 4);
  for (let i = 0; i < nInv; i++) {
    const instrument: Instrument = rng() < 0.6 ? 'SHARES' : 'LOAN';
    const name = `Co${seed % 1000}_${i}`;
    investees.push({
      name, instrument, currency: CCYS[Math.floor(rng() * CCYS.length)],
      controlCode: `${controlCodeFor(instrument)}-${slug(name)}`, units: 0, costOrig: 0,
    });
  }

  const bankLines: { date: string; description: string; amount: number }[] = [];
  const nEvents = 4 + Math.floor(rng() * 10);
  for (let e = 0; e < nEvents; e++) {
    const inv = investees[Math.floor(rng() * investees.length)];
    const date = isoDate(rng, e);
    const roll = rng();
    if (inv.instrument === 'SHARES') {
      if (inv.units === 0 || roll < 0.5) {
        // ACQUISITION
        const qty = 100 + Math.floor(rng() * 900);
        const amt = Math.round((1000 + rng() * 500000) * 100) / 100;
        postEvent(inv, 'ACQUISITION', amt, qty, date);
        inv.units += qty; inv.costOrig += amt;
        if (rng() < 0.5) bankLines.push({ date, description: `Buy ${inv.name}`, amount: -amt }); // NH-0 candidate (EUR only matches)
      } else if (roll < 0.75 && inv.units > 0) {
        // DISPOSAL (partial or full)
        const qtySold = Math.max(1, Math.floor(inv.units * (0.2 + rng() * 0.8)));
        const proceeds = Math.round((1000 + rng() * 400000) * 100) / 100;
        postEvent(inv, 'DISPOSAL', proceeds, qtySold, date);
        const ratio = Math.min(1, qtySold / inv.units);
        inv.costOrig = Math.round(inv.costOrig * (1 - ratio) * 100) / 100;
        inv.units -= qtySold;
      } else if (roll < 0.88) {
        // DISTRIBUTION (income)
        postEvent(inv, 'DISTRIBUTION', Math.round((100 + rng() * 50000) * 100) / 100, null, date);
      } else if (inv.currency !== 'EUR' && inv.units > 0) {
        // FX_REVAL — realistic: a revaluation is PROPORTIONAL to the holding and
        // cannot exceed it (real FV/FX deltas are bounded; new carrying ≥ 0). Bound
        // to ±40% of current carrying so the scenario stays valid.
        const carry = carryingValueFor(inv.controlCode);
        const delta = Math.round((rng() < 0.5 ? -1 : 1) * rng() * 0.4 * Math.abs(carry) * 100) / 100;
        postEvent(inv, 'FX_REVAL', delta, null, date);
      } else if (inv.units > 0 && rng() < 0.2) {
        // WRITE_OFF whole position
        postEvent(inv, 'WRITE_OFF', 0, null, date);
        inv.units = 0; inv.costOrig = 0;
      }
    } else {
      // LOAN
      if (inv.costOrig === 0 || roll < 0.5) {
        const amt = Math.round((5000 + rng() * 1000000) * 100) / 100;
        postEvent(inv, 'LOAN_ADVANCE', amt, null, date);
        inv.costOrig += amt;
      } else if (roll < 0.75) {
        const amt = Math.round(Math.min(inv.costOrig, (1000 + rng() * 200000)) * 100) / 100;
        postEvent(inv, 'LOAN_REPAYMENT', amt, null, date);
        inv.costOrig = Math.round((inv.costOrig - amt) * 100) / 100;
      } else {
        postEvent(inv, 'INTEREST_ACCRUAL', Math.round((100 + rng() * 30000) * 100) / 100, null, date);
      }
    }
  }

  // Bank statement (EUR account): generic lines + a net-zero charge/refund pair +
  // the investment-cash-leg candidates collected above (NH-0 exclusion path).
  const acct = findOrCreateAccount('Fuzz Bank', `FZ-${seed}`, 'EUR');
  const stmt = insertStatement({
    id: '', bankAccountId: acct.id, fileName: 's.pdf', storedPath: null,
    periodStart: '2022-01-01', periodEnd: '2022-12-31', openingBalance: 0, closingBalance: 0,
    footingOk: true, footingDiff: 0, monthsCovered: ['2022-01'], createdAt: new Date('2022-01-01').toISOString(),
  });
  const txns = [...bankLines];
  if (rng() < 0.7) {
    const tax = Math.round((10 + rng() * 2000) * 100) / 100;
    txns.push({ date: '2022-06-10', description: 'PCC tax', amount: -tax });
    txns.push({ date: '2022-06-12', description: 'PCC tax refund', amount: tax });
  }
  txns.push({ date: '2022-07-01', description: 'Bank charge', amount: -Math.round(rng() * 200 * 100) / 100 });
  // Stable, valid dates only.
  const valid = txns.filter((t) => /^2022-\d\d-\d\d$/.test(t.date) && Number.isFinite(t.amount));
  const stmtIn: ExtractedBankStatement = {
    bankName: 'Fuzz Bank', accountRef: `FZ-${seed}`, currency: 'EUR',
    periodStart: '2022-01-01', periodEnd: '2022-12-31', openingBalance: 0, closingBalance: 0,
    transactions: valid.sort((a, b) => a.date.localeCompare(b.date)),
  };
  void stmt;
  if (valid.length) ingestStatement(stmtIn);
}

function checkInvariants(seed: number): void {
  // I1: every GL line nets to zero.
  const lines = ledger('all').lines;
  const net = lines.reduce((s, l) => s + (Number(l.amount) || 0), 0);
  assert.ok(Math.abs(net) < 0.05, `[seed ${seed}] GL does not net to zero: ${net.toFixed(4)}`);

  // I2: trial balance ties.
  const tb = trialBalance('all');
  assert.ok(
    Math.abs(tb.totals.debit - tb.totals.credit) < 0.05,
    `[seed ${seed}] TB does not tie: Dr ${tb.totals.debit} Cr ${tb.totals.credit}`,
  );

  // I3: control invariant (portfolio carrying == GL balance) → no warnings.
  const pf = portfolio('all');
  assert.ok(!pf.warnings || pf.warnings.length === 0, `[seed ${seed}] portfolio control warnings: ${JSON.stringify(pf.warnings)}`);

  // I4: P&L purity — no balance-sheet / control / suspense codes leak in.
  const pnl = profitAndLoss('all');
  for (const r of [...pnl.revenue, ...pnl.expenses]) {
    assert.ok(!BS_PREFIX.test(r.accountCode), `[seed ${seed}] balance-sheet code ${r.accountCode} leaked into P&L`);
  }

  // I5: no materially-negative holding (disposal never over-releases carrying).
  for (const r of pf.rows) {
    if (r.carryingValue <= -0.5 && process.env.FUZZ_DEBUG) {
      const db = getDb();
      const evs = (db.drafts as DraftRecord[])
        .filter((d) => d.controlCode === r.controlCode)
        .map((d) => `${d.eventType}:${d.engineFigures?.functionalAmount}(q${d.sourceFigures?.quantity})`);
      // eslint-disable-next-line no-console
      console.log(`DEBUG ${r.controlCode} carry=${r.carryingValue} events=[${evs.join(', ')}]`);
    }
    assert.ok(r.carryingValue > -0.5, `[seed ${seed}] negative holding ${r.controlCode}: ${r.carryingValue}`);
  }

  // I6: equity (030) and loans (032) kept separate in the totals.
  const parents = pf.totals.map((t) => t.controlCode);
  assert.ok(new Set(parents).size === parents.length, `[seed ${seed}] duplicate parent control in totals`);
  for (const t of pf.totals) assert.ok(t.controlCode === '030' || t.controlCode === '032', `[seed ${seed}] unexpected parent ${t.controlCode}`);
}

const ITERS = Number(process.env.FUZZ_ITERS || 80);
const BASE_SEED = Number(process.env.FUZZ_SEED || 1234567);

test(`scenario fuzz — ${ITERS} randomized scenarios hold all invariants`, () => {
  for (let i = 0; i < ITERS; i++) {
    const seed = BASE_SEED + i * 7919;
    try {
      buildScenario(seed);
      checkInvariants(seed);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`fuzz iteration ${i} (seed ${seed}) failed: ${msg}`);
    }
  }
});
