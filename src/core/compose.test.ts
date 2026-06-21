import test from 'node:test';
import assert from 'node:assert/strict';
import { composeDraft } from './compose';
import type { FundAccountRefs } from './types';
import type { RatePoint } from './fx';

const refs: FundAccountRefs = {
  controlCode: '030-gamivo',
  bankCode: '1010',
  gainLossCode: '6800',
  incomeCode: '4000',
  fxCode: '6800',
  writeOffCode: '6850',
};
const rates: RatePoint[] = [{ currency: 'PLN', rateDate: new Date('2024-12-01'), rate: 4.25 }];

const eurAcq = {
  kind: 'EVENT' as const,
  investeeName: 'Gamivo',
  instrument: 'SHARES' as const,
  eventType: 'ACQUISITION' as const,
  currency: 'EUR',
  txnDate: '2024-12-10',
  sourceFigures: { amount: 5000, quantity: 100, fairValue: null },
  confidence: 0.9,
  citation: 'c',
  rationale: 'r',
  needsReview: false,
};

test('EUR acquisition: functional == read amount, balanced engine lines', () => {
  const d = composeDraft(eurAcq, { rates, refs });
  assert.equal(d.eventInput.amountFunctional, 5000);
  assert.equal(
    d.engineLines.reduce((s, l) => s + l.amount, 0),
    0
  );
  assert.equal(d.sourceFigures.amount, 5000);
  assert.equal(d.engineFigures.functionalAmount, 5000);
  assert.equal(d.engineFigures.currency, 'EUR');
});

test('EUR acquisition: engineFigures FX fields null, original currency/amount preserved', () => {
  const d = composeDraft(eurAcq, { rates, refs });
  assert.equal(d.engineFigures.fxRate, null);
  assert.equal(d.engineFigures.fxRateDate, null);
  assert.equal(d.engineFigures.originalCurrency, 'EUR');
  assert.equal(d.engineFigures.originalAmount, 5000);
});

test('engine lines carry accountCode + accountName', () => {
  const d = composeDraft(eurAcq, { rates, refs });
  const bank = d.engineLines.find((l) => l.accountCode === '1010')!;
  assert.equal(bank.accountName, 'Bank');
  const ctrl = d.engineLines.find((l) => l.accountCode === '030-gamivo')!;
  assert.equal(ctrl.accountName, 'Investments in shares (control)');
});

test('PLN acquisition: engine converts to functional EUR (8500/4.25=2000)', () => {
  const d = composeDraft(
    {
      ...eurAcq,
      currency: 'PLN',
      sourceFigures: { amount: 8500, quantity: null, fairValue: null },
    },
    { rates, refs }
  );
  assert.equal(d.eventInput.amountFunctional, 2000);
  assert.equal(d.engineFigures.functionalAmount, 2000);
  assert.equal(d.sourceFigures.amount, 8500); // read amount preserved, in doc currency
});

test('PLN acquisition: engineFigures captures the fx rate, rate date, and original figures', () => {
  const d = composeDraft(
    {
      ...eurAcq,
      currency: 'PLN',
      sourceFigures: { amount: 8500, quantity: null, fairValue: null },
    },
    { rates, refs }
  );
  assert.equal(d.engineFigures.fxRate, 4.25);
  assert.equal(d.engineFigures.fxRateDate, '2024-12-01');
  assert.equal(d.engineFigures.originalCurrency, 'PLN');
  assert.equal(d.engineFigures.originalAmount, 8500);
});

test('disposal carrying cost comes from caller (engine-owned), not the intent', () => {
  const d = composeDraft(
    {
      ...eurAcq,
      eventType: 'DISPOSAL',
      sourceFigures: { amount: 9000, quantity: null, fairValue: null },
    },
    { rates, refs, carryingCostFunctional: 5000 }
  );
  assert.equal(d.eventInput.carryingCostFunctional, 5000);
  // gain = 9000 - 5000 = 4000 credited
  assert.equal(d.engineLines.find((l) => l.accountCode === '6800')!.amount, -4000);
  assert.equal(
    d.engineLines.reduce((s, l) => s + l.amount, 0),
    0
  );
});

test('throws for a non-EVENT intent', () => {
  assert.throws(
    () =>
      composeDraft(
        { kind: 'EVIDENCE', documentType: 'x', investeeName: null, rationale: 'r' } as any,
        { rates, refs }
      ),
    /EVENT/i
  );
});
