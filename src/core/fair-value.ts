// Fair-value remeasurement (CONTRACT: trap T7 / AK-2 canonical IFRS9 FVTPL).
// The reviewer supplies the fair value (an external, sourced input — the engine
// never invents it); the engine computes the balanced remeasurement journal:
//   movement = fairValue − currentCarryingValue
//   Dr/Cr investment control (030-x)     movement   (debit when value rises)
//   Cr/Dr fair-value movement P&L (710)  −movement
// A rise credits P&L (gain), a fall debits P&L (loss). Sign convention on lines:
// positive = debit, negative = credit.

import type { JournalLine } from './types';

export const FAIR_VALUE_PL_CODE = '710';
export const FAIR_VALUE_PL_NAME = 'Fair-value movement on investments';

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export interface FairValueRemeasurement {
  movement: number; // fairValue − carrying (rounded)
  fairValue: number;
  carrying: number;
  lines: JournalLine[];
  direction: 'GAIN' | 'LOSS' | 'NONE';
}

/** Compose the balanced fair-value remeasurement entry for one holding. */
export function composeFairValueRemeasurement(input: {
  controlCode: string;
  investeeName: string;
  carrying: number;
  fairValue: number;
}): FairValueRemeasurement {
  const carrying = round2(Number(input.carrying) || 0);
  const fairValue = round2(Number(input.fairValue) || 0);
  const movement = round2(fairValue - carrying);
  const investee = input.investeeName || input.controlCode;
  const lines: JournalLine[] = [
    {
      accountCode: input.controlCode,
      accountName: `Investment — ${investee}`,
      amount: movement, // debit when value rises, credit when it falls
      description: `Fair-value remeasurement to ${fairValue.toFixed(2)} — ${investee}`,
    },
    {
      accountCode: FAIR_VALUE_PL_CODE,
      accountName: FAIR_VALUE_PL_NAME,
      amount: round2(-movement),
      description: `Fair-value movement (${movement >= 0 ? 'gain' : 'loss'}) — ${investee}`,
    },
  ];
  return {
    movement,
    fairValue,
    carrying,
    lines,
    direction: movement > 0 ? 'GAIN' : movement < 0 ? 'LOSS' : 'NONE',
  };
}
