import { accountName } from './chart';
import type { FundAccountRefs, InvestmentEventType, JournalLine } from './types';

/**
 * An investment event with all amounts ALREADY converted to functional EUR.
 * FX conversion happens upstream (fx.ts) before this is built.
 */
export interface InvestmentEventInput {
  type: InvestmentEventType;
  /** Functional-EUR amount: cost / proceeds / advance / repayment / distribution / interest / fx-delta / write-off. */
  amountFunctional: number;
  /** Functional-EUR carrying cost removed from the position (DISPOSAL, WRITE_OFF). */
  carryingCostFunctional?: number;
  description: string;
}

function line(accountCode: string, amount: number, description: string): JournalLine {
  return { accountCode, accountName: accountName(accountCode), amount, description };
}

function requireCarryingCost(e: InvestmentEventInput): number {
  if (e.carryingCostFunctional === undefined) {
    throw new Error(`${e.type} requires a carrying cost`);
  }
  return e.carryingCostFunctional;
}

/**
 * Build balanced double-entry lines for an investment event.
 * Sign convention: positive = debit, negative = credit.
 * Every branch balances to zero by construction.
 */
export function buildInvestmentJournalLines(
  event: InvestmentEventInput,
  refs: FundAccountRefs
): JournalLine[] {
  const amt = event.amountFunctional;
  const d = event.description;
  switch (event.type) {
    case 'ACQUISITION':
    case 'LOAN_ADVANCE':
      return [line(refs.controlCode, amt, d), line(refs.bankCode, -amt, d)];
    case 'LOAN_REPAYMENT':
      return [line(refs.bankCode, amt, d), line(refs.controlCode, -amt, d)];
    case 'DISPOSAL': {
      const cost = requireCarryingCost(event);
      const gainLoss = amt - cost; // positive = gain
      return [
        line(refs.bankCode, amt, d),
        line(refs.controlCode, -cost, d),
        line(refs.gainLossCode, -gainLoss, d), // gain -> credit, loss -> debit
      ];
    }
    case 'DISTRIBUTION':
      return [line(refs.bankCode, amt, d), line(refs.incomeCode, -amt, d)];
    case 'INTEREST_ACCRUAL':
      // Loan interest income to its own line (510) — the same account the bank/cash
      // path uses — not lumped into investment income (4000) with dividends.
      return [line(refs.controlCode, amt, d), line(refs.interestIncomeCode ?? refs.incomeCode, -amt, d)];
    case 'FX_REVAL':
      return [line(refs.controlCode, amt, d), line(refs.fxCode, -amt, d)];
    case 'WRITE_OFF': {
      const cost = requireCarryingCost(event);
      return [line(refs.writeOffCode, cost, d), line(refs.controlCode, -cost, d)];
    }
    default: {
      const exhaustive: never = event.type;
      throw new Error(`unhandled investment event type: ${exhaustive}`);
    }
  }
}
