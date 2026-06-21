import { convertWithRate, type RatePoint } from './fx';
import { buildInvestmentJournalLines, type InvestmentEventInput } from './journal';
import type { EngineFigures, FundAccountRefs, JournalLine, SourceFigures } from './types';
import type { IntakeIntent, InvestmentEventIntent } from './intake-schema';

export interface ComposeOptions {
  rates: RatePoint[];
  refs: FundAccountRefs;
  /** Engine-owned carrying cost for DISPOSAL/WRITE_OFF (from the position roll-forward). Never from the intent. */
  carryingCostFunctional?: number;
}

export interface DraftComposition {
  eventInput: InvestmentEventInput;
  engineLines: JournalLine[];
  sourceFigures: SourceFigures;
  engineFigures: EngineFigures;
}

/** Turn a Claude EVENT intent into engine inputs + balanced lines. Figures the engine owns are computed here, never taken from the model. */
export function composeDraft(intent: IntakeIntent, opts: ComposeOptions): DraftComposition {
  if (intent.kind !== 'EVENT') {
    throw new Error(`composeDraft requires an EVENT intent, got ${intent.kind}`);
  }
  const ev: InvestmentEventIntent = intent;
  // A missing/garbled date must not crash the FX lookup — fall back to today so
  // the draft is still produced (and surfaced for review) rather than erroring.
  let txnDate = new Date(ev.txnDate);
  if (Number.isNaN(txnDate.getTime())) txnDate = new Date();
  const conversion = convertWithRate(
    ev.sourceFigures.amount,
    ev.currency,
    txnDate,
    opts.rates
  );
  const amountFunctional = conversion.amount;

  const eventInput: InvestmentEventInput = {
    type: ev.eventType,
    amountFunctional,
    carryingCostFunctional: opts.carryingCostFunctional,
    description: `${ev.eventType} ${ev.investeeName} — ${ev.citation}`,
  };
  const engineLines = buildInvestmentJournalLines(eventInput, opts.refs);

  return {
    eventInput,
    engineLines,
    sourceFigures: {
      amount: ev.sourceFigures.amount,
      quantity: ev.sourceFigures.quantity,
      fairValue: ev.sourceFigures.fairValue,
      currency: ev.currency,
    },
    engineFigures: {
      functionalAmount: amountFunctional,
      currency: 'EUR',
      lineCount: engineLines.length,
      fxRate: conversion.rate,
      fxRateDate: conversion.rateDate,
      originalCurrency: ev.currency,
      originalAmount: ev.sourceFigures.amount,
    },
  };
}
