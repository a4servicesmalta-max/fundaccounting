import test from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
// Self-isolate the store so running this file directly never touches real data.
process.env.AUTOPILOT_DB = path.join(os.tmpdir(), `thcp-ingest-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
import { initDb, resetAll, getDb, persist } from '../db/store';
import { ingestStatement, type ExtractedBankStatement } from './ingest';
import { listTransactions, monthsPresentForAccount } from './bank-store';

function fresh(): void {
  initDb();
  resetAll();
}

/** One transaction on the 15th of the given YYYY-MM, +100 each, running balance
 *  ticks up by 100 from a base. */
function monthlyTxns(months: string[], baseBalance: number) {
  let bal = baseBalance;
  return months.map((m) => {
    bal += 100;
    return { date: `${m}-15`, description: `Inflow ${m}`, amount: 100, balance: bal };
  });
}

function statement(over: Partial<ExtractedBankStatement>): ExtractedBankStatement {
  return {
    bankName: 'Bank of Valletta',
    accountRef: 'MT00 BVAL 1234',
    currency: 'EUR',
    periodStart: '2025-01-01',
    periodEnd: '2025-06-30',
    openingBalance: 0,
    closingBalance: 0,
    transactions: [],
    ...over,
  };
}

test('month-level dedup: Jan–Jun then May–Dec → May/Jun skipped, Jul–Dec added', () => {
  fresh();

  // First statement: Jan..Jun, opening 0, +100 each = 600 closing.
  const janJun = ['2025-01', '2025-02', '2025-03', '2025-04', '2025-05', '2025-06'];
  const first = statement({
    transactions: monthlyTxns(janJun, 0),
    openingBalance: 0,
    closingBalance: 600,
  });
  const r1 = ingestStatement(first);
  assert.equal(r1.added, 6);
  assert.deepEqual(r1.skippedMonths, []);

  // Second statement: May..Dec (overlaps May, Jun). opening 400 (= after Apr),
  // +100 each over 8 months = 800 -> closing 1200.
  const mayDec = [
    '2025-05', '2025-06', '2025-07', '2025-08',
    '2025-09', '2025-10', '2025-11', '2025-12',
  ];
  const second = statement({
    periodStart: '2025-05-01',
    periodEnd: '2025-12-31',
    transactions: monthlyTxns(mayDec, 400),
    openingBalance: 400,
    closingBalance: 1200,
  });
  const r2 = ingestStatement(second);

  // May & June already present -> skipped; Jul..Dec (6 months) added.
  assert.deepEqual(r2.skippedMonths, ['2025-05', '2025-06']);
  assert.equal(r2.added, 6, 'Jul–Dec added');

  // Same bank account reused (split-by-bank found the existing one).
  assert.equal(r1.bankAccountId, r2.bankAccountId);

  // Store ends with 12 distinct months, no May/Jun duplication.
  const months = monthsPresentForAccount(r1.bankAccountId);
  assert.equal(months.length, 12);
  const allTxns = listTransactions({ accountId: r1.bankAccountId });
  assert.equal(allTxns.length, 12);
  const may = allTxns.filter((t) => t.period === '2025-05');
  assert.equal(may.length, 1, 'May not duplicated');
});

test('footing passes when opening + Σamounts − closing ≈ 0', () => {
  fresh();
  const r = ingestStatement(
    statement({
      transactions: [
        { date: '2025-01-10', description: 'In', amount: 500, balance: 500 },
        { date: '2025-01-20', description: 'Out', amount: -200, balance: 300 },
      ],
      openingBalance: 0,
      closingBalance: 300,
    }),
  );
  assert.equal(r.footingOk, true);
  assert.ok(Math.abs(r.footingDiff) < 0.01);
});

test('footing fails when the closing balance does not tie', () => {
  fresh();
  const r = ingestStatement(
    statement({
      transactions: [
        { date: '2025-01-10', description: 'In', amount: 500, balance: 500 },
        { date: '2025-01-20', description: 'Out', amount: -200, balance: 300 },
      ],
      openingBalance: 0,
      closingBalance: 350, // off by 50
    }),
  );
  assert.equal(r.footingOk, false);
  assert.equal(r.footingDiff, -50);
});

test('categorize threshold sets AUTO (≥0.75) vs REVIEW (<0.75) status', () => {
  fresh();
  const r = ingestStatement(
    statement({
      transactions: [
        { date: '2025-02-01', description: 'Monthly bank charge', amount: -10, balance: -10 },
        { date: '2025-02-02', description: 'POS purchase unknown shop', amount: -40, balance: -50 },
      ],
      openingBalance: 0,
      closingBalance: -50,
    }),
  );
  assert.equal(r.added, 2);
  const txns = listTransactions({ accountId: r.bankAccountId });
  const charge = txns.find((t) => t.description.includes('bank charge'))!;
  const pos = txns.find((t) => t.description.includes('POS'))!;
  assert.equal(charge.status, 'AUTO');
  assert.equal(charge.postToCode, '6300');
  assert.equal(pos.status, 'REVIEW');
  assert.equal(pos.postToCode, '9999');
});

test('match marks an OPEN AR/AP item PAID and links the document', () => {
  fresh();

  // Seed an OPEN payable directly into the shared store.
  const db = getDb();
  db.arapItems.push({
    id: 'arap-1',
    documentId: 'doc-acme',
    kind: 'PAYABLE',
    counterparty: 'Acme Legal Services',
    amount: 1200,
    currency: 'EUR',
    issueDate: '2025-03-01',
    dueDate: '2025-03-31',
    status: 'OPEN',
    paidByTxnId: null,
    docName: null,
    createdAt: '2025-03-01T00:00:00.000Z',
  });
  persist();

  const r = ingestStatement(
    statement({
      transactions: [
        { date: '2025-04-02', description: 'Payment to ACME LEGAL SERVICES', amount: -1200, balance: -1200 },
      ],
      openingBalance: 0,
      closingBalance: -1200,
    }),
  );
  assert.equal(r.added, 1);

  const txns = listTransactions({ accountId: r.bankAccountId });
  assert.equal(txns[0].matchedDocumentId, 'doc-acme');

  const item = getDb().arapItems.find((i: any) => i.id === 'arap-1');
  assert.equal(item.status, 'PAID');
  assert.equal(item.paidByTxnId, txns[0].id);
});

test('trap T2: an impossible date (2021-09-31) is flagged, not silently moved', () => {
  fresh();
  const r = ingestStatement(
    statement({
      currency: 'EUR',
      transactions: [
        { date: '2021-09-31', description: 'Maintenance fee', amount: -120, balance: -120 },
        { date: '2021-09-15', description: 'Good line', amount: -10, balance: -130 },
      ],
      openingBalance: 0,
      closingBalance: -130,
    }),
  );
  const txns = listTransactions({ accountId: r.bankAccountId });
  const bad = txns.find((t) => t.description === 'Maintenance fee');
  const good = txns.find((t) => t.description === 'Good line');
  // Flagged, held for review, period left unset (NOT rolled into October).
  assert.ok(bad && bad.dateFlag, 'impossible date flagged');
  assert.equal(bad.dateFlag.suggestion, '2021-09-30');
  assert.equal(bad.status, 'REVIEW');
  assert.equal(bad.period, '');
  // The valid line is unaffected.
  assert.ok(good && !good.dateFlag);
  assert.equal(good.period, '2021-09');
});

test('trap T2: fixing the flagged date clears the flag and sets the period', async () => {
  fresh();
  const store = await import('../bank/bank-store');
  const r = ingestStatement(
    statement({
      transactions: [{ date: '2021-09-31', description: 'Fee', amount: -120, balance: -120 }],
      openingBalance: 0,
      closingBalance: -120,
    }),
  );
  const txn = listTransactions({ accountId: r.bankAccountId })[0];
  assert.ok(store.fixTransactionDate(txn.id, '2021-09-30'));
  const fixed = store.getTransaction(txn.id);
  assert.ok(fixed, 'transaction still present');
  assert.equal(fixed!.dateFlag, null);
  assert.equal(fixed!.date, '2021-09-30');
  assert.equal(fixed!.period, '2021-09');
});

test('trap T13: a PCC charge + refund pair nets to zero (no double-count)', async () => {
  fresh();
  const { trialBalance } = await import('../report/report');
  const r = ingestStatement(
    statement({
      currency: 'EUR',
      transactions: [
        { date: '2021-04-10', description: 'PCC podatek Anastazja Pisula', amount: -2730, balance: -2730 },
        { date: '2021-04-25', description: 'Zwrot PCC Anastazja Pisula', amount: 2730, balance: 0 },
      ],
      openingBalance: 0,
      closingBalance: 0,
    }),
  );
  const txns = listTransactions({ accountId: r.bankAccountId });
  const charge = txns.find((t) => t.amount === -2730);
  const refund = txns.find((t) => t.amount === 2730);
  // Both legs paired and posted to the SAME account.
  assert.ok(charge && charge.netZeroPair && charge.netZeroPair.role === 'CHARGE');
  assert.ok(refund && refund.netZeroPair && refund.netZeroPair.role === 'REFUND');
  assert.equal(charge.postToCode, refund.postToCode);
  // TB still ties and the pair leaves no residual in P&L (the shared account nets to 0).
  const tb = trialBalance();
  assert.ok(Math.abs(tb.totals.debit - tb.totals.credit) < 0.01, 'TB balances');
  const shared = tb.rows.find((row) => row.accountCode === charge.postToCode);
  const net = shared ? (Number(shared.debit) || 0) - (Number(shared.credit) || 0) : 0;
  assert.ok(Math.abs(net) < 0.01, 'net-zero pair leaves no balance on the shared account');
});
