import test from 'node:test';
import assert from 'node:assert/strict';
import { matchTransaction } from './match';

// Inline ArApItem-shaped fixtures. The ArApItem type import in match.ts is a
// type-only import (erased at runtime), so these run even before the ARAP
// module exists. Cast to any to satisfy the structural type during tests.
function item(over: Partial<any>): any {
  return {
    id: 'i1',
    documentId: 'doc1',
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
    ...over,
  };
}

test('matches on amount magnitude + date window + name overlap', () => {
  const m = matchTransaction(
    { amount: -1200, date: '2025-04-05', description: 'Payment to ACME Legal' },
    [item({})],
  );
  assert.ok(m);
  assert.equal(m!.id, 'i1');
});

test('no match when amount differs by more than a cent', () => {
  const m = matchTransaction(
    { amount: -1200.5, date: '2025-04-05', description: 'Payment to Acme Legal' },
    [item({})],
  );
  assert.equal(m, null);
});

test('matches within a cent of tolerance', () => {
  const m = matchTransaction(
    { amount: -1200.009, date: '2025-04-01', description: 'Acme Legal' },
    [item({})],
  );
  assert.ok(m);
});

test('no match when dates are more than 30 days apart', () => {
  // due 2025-03-31, txn 2025-05-15 -> 45 days
  const m = matchTransaction(
    { amount: -1200, date: '2025-05-15', description: 'Acme Legal' },
    [item({})],
  );
  assert.equal(m, null);
});

test('no match when counterparty does not appear in description', () => {
  const m = matchTransaction(
    { amount: -1200, date: '2025-04-01', description: 'Unrelated supermarket purchase' },
    [item({})],
  );
  assert.equal(m, null);
});

test('ignores items that are not OPEN', () => {
  const m = matchTransaction(
    { amount: -1200, date: '2025-04-01', description: 'Acme Legal' },
    [item({ status: 'PAID' })],
  );
  assert.equal(m, null);
});

test('falls back to issueDate when dueDate is null', () => {
  const m = matchTransaction(
    { amount: -1200, date: '2025-03-10', description: 'Acme Legal' },
    [item({ dueDate: null })], // issueDate 2025-03-01 -> 9 days
  );
  assert.ok(m);
});

test('picks the best item by token overlap among several candidates', () => {
  const a = item({ id: 'a', counterparty: 'Acme', amount: 1200 });
  const b = item({ id: 'b', counterparty: 'Acme Legal Services Malta', amount: 1200 });
  const m = matchTransaction(
    { amount: -1200, date: '2025-04-01', description: 'ACME LEGAL SERVICES MALTA payment' },
    [a, b],
  );
  assert.ok(m);
  assert.equal(m!.id, 'b');
});
