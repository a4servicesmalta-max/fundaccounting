// Unit tests for the pure closing-journal builder.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildClosingJournal, financialYearMonths, financialYearEnd } from './year-close';

function balanced(lines: { amount: number }[]): boolean {
  return Math.abs(lines.reduce((s, l) => s + l.amount, 0)) < 0.005;
}

test('financial-year helpers cover Jan–Dec and close on 31 Dec', () => {
  const months = financialYearMonths(2024);
  assert.equal(months.length, 12);
  assert.equal(months[0], '2024-01');
  assert.equal(months[11], '2024-12');
  assert.deepEqual(financialYearEnd(2024), { date: '2024-12-31', period: '2024-12' });
});

test('a profit closes each P&L account to zero and credits retained earnings', () => {
  // Revenue carries a credit (negative) balance; expense a debit (positive) one.
  const pl = new Map<string, number>([
    ['4000', -100000], // income
    ['6100', 30000], // legal & professional
  ]);
  const j = buildClosingJournal(pl);
  assert.equal(j.netResult, 70000); // profit
  assert.ok(balanced(j.lines), 'closing journal balances');
  // P&L accounts zeroed by the opposite of their balance.
  assert.equal(j.lines.find((l) => l.accountCode === '4000')!.amount, 100000); // Dr revenue
  assert.equal(j.lines.find((l) => l.accountCode === '6100')!.amount, -30000); // Cr expense
  // Net profit credited to retained earnings (negative = credit).
  assert.equal(j.lines.find((l) => l.accountCode === '3100')!.amount, -70000);
});

test('a loss debits retained earnings and still balances', () => {
  const pl = new Map<string, number>([
    ['4000', -20000], // income 20,000
    ['6100', 50000], // expense 50,000 -> loss 30,000
  ]);
  const j = buildClosingJournal(pl);
  assert.equal(j.netResult, -30000); // loss
  assert.ok(balanced(j.lines));
  assert.equal(j.lines.find((l) => l.accountCode === '3100')!.amount, 30000); // Dr retained earnings
});

test('no P&L activity yields an empty journal', () => {
  const j = buildClosingJournal(new Map());
  assert.equal(j.lines.length, 0);
  assert.equal(j.netResult, 0);
});

test('a fully offsetting break-even year posts no retained-earnings line', () => {
  const pl = new Map<string, number>([
    ['4000', -40000],
    ['6100', 40000],
  ]);
  const j = buildClosingJournal(pl);
  assert.equal(j.netResult, 0);
  // Both P&L accounts still get zeroed, but no retained-earnings offset is needed.
  assert.ok(balanced(j.lines));
  assert.equal(j.lines.find((l) => l.accountCode === '3100'), undefined);
});
