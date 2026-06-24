export type Instrument = 'SHARES' | 'LOAN';

export type InvestmentEventType =
  | 'ACQUISITION'
  | 'DISPOSAL'
  | 'LOAN_ADVANCE'
  | 'LOAN_REPAYMENT'
  | 'DISTRIBUTION'
  | 'INTEREST_ACCRUAL'
  | 'FX_REVAL'
  | 'WRITE_OFF';

/** Sign convention on journal lines: positive = debit, negative = credit. */
export interface JournalLine {
  accountCode: string;
  accountName: string;
  amount: number;
  description: string;
}

/** Account codes the engine posts against for one event. */
export interface FundAccountRefs {
  controlCode: string; // e.g. '030-gamivo'
  bankCode: string; // '1010'
  gainLossCode: string; // '6800'
  incomeCode: string; // '4000' — investment income (distributions / dividends)
  /** Loan interest income — its own line ('510'), kept separate from dividend/
   *  investment income, and the SAME account the bank/cash path books interest to.
   *  Falls back to incomeCode when not set. */
  interestIncomeCode?: string; // '510'
  fxCode: string; // '6800'
  writeOffCode: string; // '6850'
}

/** What the AI READ from the document. */
export interface SourceFigures {
  amount: number;
  quantity: number | null;
  fairValue: number | null;
  currency: string;
}

/** What the engine COMPUTED. */
export interface EngineFigures {
  functionalAmount: number;
  currency: 'EUR';
  lineCount: number;
  fxRate: number | null;
  fxRateDate: string | null;
  originalCurrency: string;
  originalAmount: number;
}
