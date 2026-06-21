import type { InvestmentEventType } from './types';

export interface RollForwardEvent {
  investmentId: string;
  type: InvestmentEventType;
  amountFunctional: number;
  carryingCostFunctional?: number;
}

export type PositionMap = Record<string, number>;

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Net carrying-value delta an event applies to its position. */
function delta(e: RollForwardEvent): number {
  switch (e.type) {
    case 'ACQUISITION':
    case 'LOAN_ADVANCE':
    case 'INTEREST_ACCRUAL':
    case 'FX_REVAL':
      return e.amountFunctional;
    case 'LOAN_REPAYMENT':
      return -e.amountFunctional;
    case 'DISPOSAL':
    case 'WRITE_OFF':
      return -(e.carryingCostFunctional ?? 0);
    case 'DISTRIBUTION':
      return 0;
    default: {
      const exhaustive: never = e.type;
      throw new Error(`unhandled event type: ${exhaustive}`);
    }
  }
}

/** Opening carrying values + events -> closing carrying values, per investmentId. */
export function rollForwardPositions(
  opening: PositionMap,
  events: RollForwardEvent[]
): PositionMap {
  const closing: PositionMap = { ...opening };
  for (const e of events) {
    closing[e.investmentId] = round2((closing[e.investmentId] ?? 0) + delta(e));
  }
  return closing;
}
