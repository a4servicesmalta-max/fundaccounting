import test from 'node:test';
import assert from 'node:assert/strict';
import { buildInvestmentJournalLines } from './journal';
import { accountName } from './chart';
import type { FundAccountRefs, JournalLine } from './types';

const refs: FundAccountRefs = {
  controlCode: '030-gamivo',
  bankCode: '1010',
  gainLossCode: '6800',
  incomeCode: '4000',
  interestIncomeCode: '510',
  fxCode: '6800',
  writeOffCode: '6850',
};

function sum(lines: JournalLine[]): number {
  return lines.reduce((s, l) => s + l.amount, 0);
}

test('ACQUISITION debits control, credits bank, balances', () => {
  const lines = buildInvestmentJournalLines(
    { type: 'ACQUISITION', amountFunctional: 5000, description: 'buy' },
    refs
  );
  assert.equal(sum(lines), 0);
  assert.equal(lines.find((l) => l.accountCode === '030-gamivo')!.amount, 5000);
  assert.equal(lines.find((l) => l.accountCode === '1010')!.amount, -5000);
});

test('journal lines carry an accountName resolved from the chart', () => {
  const lines = buildInvestmentJournalLines(
    { type: 'ACQUISITION', amountFunctional: 5000, description: 'buy' },
    refs
  );
  // sub-account rolls up to its parent control name
  assert.equal(
    lines.find((l) => l.accountCode === '030-gamivo')!.accountName,
    accountName('030')
  );
  assert.equal(lines.find((l) => l.accountCode === '1010')!.accountName, 'Bank');
});

test('LOAN_ADVANCE debits control, credits bank', () => {
  const lines = buildInvestmentJournalLines(
    { type: 'LOAN_ADVANCE', amountFunctional: 1200, description: 'advance' },
    refs
  );
  assert.equal(sum(lines), 0);
  assert.equal(lines.find((l) => l.accountCode === '030-gamivo')!.amount, 1200);
});

test('LOAN_REPAYMENT debits bank, credits control', () => {
  const lines = buildInvestmentJournalLines(
    { type: 'LOAN_REPAYMENT', amountFunctional: 800, description: 'repay' },
    refs
  );
  assert.equal(sum(lines), 0);
  assert.equal(lines.find((l) => l.accountCode === '1010')!.amount, 800);
  assert.equal(lines.find((l) => l.accountCode === '030-gamivo')!.amount, -800);
});

test('DISPOSAL at a gain: bank=proceeds, control=-cost, gain credited', () => {
  const lines = buildInvestmentJournalLines(
    { type: 'DISPOSAL', amountFunctional: 9000, carryingCostFunctional: 5000, description: 'sell' },
    refs
  );
  assert.equal(sum(lines), 0);
  assert.equal(lines.find((l) => l.accountCode === '1010')!.amount, 9000);
  assert.equal(lines.find((l) => l.accountCode === '030-gamivo')!.amount, -5000);
  assert.equal(lines.find((l) => l.accountCode === '6800')!.amount, -4000); // credit = gain
});

test('DISPOSAL at a loss: gain/loss line is a debit', () => {
  const lines = buildInvestmentJournalLines(
    {
      type: 'DISPOSAL',
      amountFunctional: 3000,
      carryingCostFunctional: 5000,
      description: 'sell low',
    },
    refs
  );
  assert.equal(sum(lines), 0);
  assert.equal(lines.find((l) => l.accountCode === '6800')!.amount, 2000); // debit = loss
});

test('DISTRIBUTION debits bank, credits income', () => {
  const lines = buildInvestmentJournalLines(
    { type: 'DISTRIBUTION', amountFunctional: 700, description: 'dividend' },
    refs
  );
  assert.equal(sum(lines), 0);
  assert.equal(lines.find((l) => l.accountCode === '4000')!.amount, -700);
});

test('INTEREST_ACCRUAL credits loan interest income (510), not investment income (4000)', () => {
  const lines = buildInvestmentJournalLines(
    { type: 'INTEREST_ACCRUAL', amountFunctional: 150, description: 'interest' },
    refs
  );
  assert.equal(sum(lines), 0);
  assert.equal(lines.find((l) => l.accountCode === '030-gamivo')!.amount, 150);
  assert.equal(lines.find((l) => l.accountCode === '510')!.amount, -150); // loan interest income
  assert.equal(lines.find((l) => l.accountCode === '4000'), undefined); // not lumped with dividends
});

test('INTEREST_ACCRUAL falls back to incomeCode when interestIncomeCode is unset', () => {
  const legacy: FundAccountRefs = { ...refs, interestIncomeCode: undefined };
  const lines = buildInvestmentJournalLines(
    { type: 'INTEREST_ACCRUAL', amountFunctional: 150, description: 'interest' },
    legacy
  );
  assert.equal(lines.find((l) => l.accountCode === '4000')!.amount, -150);
});

test('FX_REVAL gain debits control, credits FX', () => {
  const lines = buildInvestmentJournalLines(
    { type: 'FX_REVAL', amountFunctional: 250, description: 'reval up' },
    refs
  );
  assert.equal(sum(lines), 0);
  assert.equal(lines.find((l) => l.accountCode === '030-gamivo')!.amount, 250);
  assert.equal(lines.find((l) => l.accountCode === '6800')!.amount, -250);
});

test('FX_REVAL loss (negative delta) credits control, debits FX', () => {
  const lines = buildInvestmentJournalLines(
    { type: 'FX_REVAL', amountFunctional: -250, description: 'reval down' },
    refs
  );
  assert.equal(sum(lines), 0);
  assert.equal(lines.find((l) => l.accountCode === '030-gamivo')!.amount, -250);
  assert.equal(lines.find((l) => l.accountCode === '6800')!.amount, 250);
});

test('WRITE_OFF debits write-off, credits control', () => {
  const lines = buildInvestmentJournalLines(
    { type: 'WRITE_OFF', amountFunctional: 0, carryingCostFunctional: 5000, description: 'impair' },
    refs
  );
  assert.equal(sum(lines), 0);
  assert.equal(lines.find((l) => l.accountCode === '6850')!.amount, 5000);
  assert.equal(lines.find((l) => l.accountCode === '030-gamivo')!.amount, -5000);
});

test('DISPOSAL without carrying cost throws', () => {
  assert.throws(
    () =>
      buildInvestmentJournalLines(
        { type: 'DISPOSAL', amountFunctional: 9000, description: 'x' },
        refs
      ),
    /carrying cost/i
  );
});

test('WRITE_OFF without carrying cost throws', () => {
  assert.throws(
    () =>
      buildInvestmentJournalLines(
        { type: 'WRITE_OFF', amountFunctional: 0, description: 'x' },
        refs
      ),
    /carrying cost/i
  );
});
