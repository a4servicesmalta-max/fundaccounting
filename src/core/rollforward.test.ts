import test from 'node:test';
import assert from 'node:assert/strict';
import { rollForwardPositions, type RollForwardEvent } from './rollforward';

test('rolls forward a single position through mixed events', () => {
  const opening = { 'inv-1': 5000 };
  const events: RollForwardEvent[] = [
    { investmentId: 'inv-1', type: 'ACQUISITION', amountFunctional: 1000 },
    { investmentId: 'inv-1', type: 'FX_REVAL', amountFunctional: -200 },
    { investmentId: 'inv-1', type: 'DISPOSAL', amountFunctional: 0, carryingCostFunctional: 1500 },
  ];
  const closing = rollForwardPositions(opening, events);
  // 5000 + 1000 - 200 - 1500 = 4300
  assert.equal(closing['inv-1'], 4300);
});

test('creates a position not present in opening', () => {
  const closing = rollForwardPositions({}, [
    { investmentId: 'inv-2', type: 'LOAN_ADVANCE', amountFunctional: 2000 },
    { investmentId: 'inv-2', type: 'LOAN_REPAYMENT', amountFunctional: 500 },
  ]);
  assert.equal(closing['inv-2'], 1500);
});

test('distribution does not change carrying value', () => {
  const closing = rollForwardPositions({ 'inv-3': 100 }, [
    { investmentId: 'inv-3', type: 'DISTRIBUTION', amountFunctional: 70 },
  ]);
  assert.equal(closing['inv-3'], 100);
});

test('interest accrual capitalises into the position', () => {
  const closing = rollForwardPositions({ 'inv-4': 100 }, [
    { investmentId: 'inv-4', type: 'INTEREST_ACCRUAL', amountFunctional: 15 },
  ]);
  assert.equal(closing['inv-4'], 115);
});

test('write-off removes carrying cost', () => {
  const closing = rollForwardPositions({ 'inv-5': 5000 }, [
    { investmentId: 'inv-5', type: 'WRITE_OFF', amountFunctional: 0, carryingCostFunctional: 5000 },
  ]);
  assert.equal(closing['inv-5'], 0);
});
