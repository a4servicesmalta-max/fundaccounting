import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
// Self-isolate the store so running this file directly never touches real data.
process.env.AUTOPILOT_DB = path.join(os.tmpdir(), `thcp-aging-${process.pid}-${Math.random().toString(36).slice(2)}.json`);

import { getDb, persist } from '../db/store';
import { insertItem, listItems, getItem, markPaid, type ArApItem } from './arap-store';
import { agingReport } from './aging';

// Reset the arapItems collection between scenarios so tests are independent.
function clearItems(): void {
  getDb().arapItems.length = 0;
  persist();
}

// As-of date used throughout: 2025-06-30.
const ASOF = '2025-06-30';

test('agingReport: buckets items by dueDate vs asOf', () => {
  clearItems();
  // RECEIVABLES with various due dates relative to 2025-06-30.
  insertItem({ kind: 'RECEIVABLE', counterparty: 'Alpha', amount: 100, currency: 'EUR', dueDate: '2025-07-15' }); // not yet due -> current
  insertItem({ kind: 'RECEIVABLE', counterparty: 'Beta', amount: 200, currency: 'EUR', dueDate: '2025-06-30' });  // due today -> current
  insertItem({ kind: 'RECEIVABLE', counterparty: 'Gamma', amount: 300, currency: 'EUR', dueDate: '2025-06-10' }); // 20 days -> d1_30
  insertItem({ kind: 'RECEIVABLE', counterparty: 'Delta', amount: 400, currency: 'EUR', dueDate: '2025-05-15' }); // 46 days -> d31_60
  insertItem({ kind: 'RECEIVABLE', counterparty: 'Epsilon', amount: 500, currency: 'EUR', dueDate: '2025-04-15' }); // 76 days -> d61_90
  insertItem({ kind: 'RECEIVABLE', counterparty: 'Zeta', amount: 600, currency: 'EUR', dueDate: '2025-01-01' }); // 180 days -> d90_plus

  const { receivables } = agingReport(ASOF);

  assert.equal(receivables.buckets.current, 300); // 100 + 200
  assert.equal(receivables.buckets.d1_30, 300);
  assert.equal(receivables.buckets.d31_60, 400);
  assert.equal(receivables.buckets.d61_90, 500);
  assert.equal(receivables.buckets.d90_plus, 600);
  assert.equal(receivables.total, 2100);
});

test('agingReport: no due date is treated as current', () => {
  clearItems();
  insertItem({ kind: 'RECEIVABLE', counterparty: 'NoDue', amount: 150, currency: 'EUR', dueDate: null });

  const { receivables } = agingReport(ASOF);
  assert.equal(receivables.buckets.current, 150);
  assert.equal(receivables.total, 150);
});

test('agingReport: groups per counterparty and sums their buckets', () => {
  clearItems();
  // Two invoices for the same counterparty, in different buckets.
  insertItem({ kind: 'RECEIVABLE', counterparty: 'Acme', amount: 100, currency: 'EUR', dueDate: '2025-07-15' }); // current
  insertItem({ kind: 'RECEIVABLE', counterparty: 'Acme', amount: 250, currency: 'EUR', dueDate: '2025-06-10' }); // d1_30
  insertItem({ kind: 'RECEIVABLE', counterparty: 'Other', amount: 90, currency: 'EUR', dueDate: '2025-04-15' });  // d61_90

  const { receivables } = agingReport(ASOF);

  assert.equal(receivables.byCounterparty.length, 2);
  const acme = receivables.byCounterparty.find((c) => c.counterparty === 'Acme');
  assert.ok(acme);
  assert.equal(acme!.total, 350);
  assert.equal(acme!.buckets.current, 100);
  assert.equal(acme!.buckets.d1_30, 250);

  const other = receivables.byCounterparty.find((c) => c.counterparty === 'Other');
  assert.ok(other);
  assert.equal(other!.total, 90);
  assert.equal(other!.buckets.d61_90, 90);

  // byCounterparty is sorted by name.
  assert.deepEqual(
    receivables.byCounterparty.map((c) => c.counterparty),
    ['Acme', 'Other'],
  );
});

test('agingReport: PAID items are excluded', () => {
  clearItems();
  const open = insertItem({ kind: 'RECEIVABLE', counterparty: 'Open Co', amount: 100, currency: 'EUR', dueDate: '2025-06-10' });
  const paid = insertItem({ kind: 'RECEIVABLE', counterparty: 'Paid Co', amount: 999, currency: 'EUR', dueDate: '2025-06-10' });
  markPaid(paid.id, 'txn-123');

  const { receivables } = agingReport(ASOF);
  assert.equal(receivables.total, 100);
  assert.equal(receivables.buckets.d1_30, 100);
  assert.equal(receivables.byCounterparty.length, 1);
  assert.equal(receivables.byCounterparty[0].counterparty, 'Open Co');

  // markPaid persisted the status change.
  assert.equal(getItem(paid.id)!.status, 'PAID');
  assert.equal(getItem(paid.id)!.paidByTxnId, 'txn-123');
  assert.equal(getItem(open.id)!.status, 'OPEN');
});

test('agingReport: receivables and payables are split', () => {
  clearItems();
  insertItem({ kind: 'RECEIVABLE', counterparty: 'Customer A', amount: 500, currency: 'EUR', dueDate: '2025-06-10' }); // d1_30
  insertItem({ kind: 'PAYABLE', counterparty: 'Supplier X', amount: 700, currency: 'EUR', dueDate: '2025-04-15' });   // d61_90
  insertItem({ kind: 'PAYABLE', counterparty: 'Supplier Y', amount: 300, currency: 'EUR', dueDate: '2025-07-15' });   // current

  const { receivables, payables } = agingReport(ASOF);

  assert.equal(receivables.total, 500);
  assert.equal(receivables.buckets.d1_30, 500);
  assert.equal(receivables.byCounterparty.length, 1);

  assert.equal(payables.total, 1000);
  assert.equal(payables.buckets.d61_90, 700);
  assert.equal(payables.buckets.current, 300);
  assert.equal(payables.byCounterparty.length, 2);
});

test('arap-store: listItems filters by kind', () => {
  clearItems();
  insertItem({ kind: 'RECEIVABLE', counterparty: 'R1', amount: 10, currency: 'EUR' });
  insertItem({ kind: 'PAYABLE', counterparty: 'P1', amount: 20, currency: 'EUR' });
  insertItem({ kind: 'PAYABLE', counterparty: 'P2', amount: 30, currency: 'EUR' });

  assert.equal(listItems().length, 3);
  assert.equal(listItems('RECEIVABLE').length, 1);
  assert.equal(listItems('PAYABLE').length, 2);

  // clean up so the test file leaves the store empty.
  clearItems();
});
