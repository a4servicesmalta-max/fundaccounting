import { intakeIntentSchema, type IntakeIntent } from './intake-schema';

/** Extract a JSON object from raw model text (handles ```json fences + surrounding prose). */
export function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fence ? fence[1].trim() : trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    const s = candidate.indexOf('{');
    const e = candidate.lastIndexOf('}');
    if (s >= 0 && e > s) return JSON.parse(candidate.slice(s, e + 1));
    throw new Error('No valid JSON in model output');
  }
}

// The model reads documents well but uses its own natural field names and event
// labels (e.g. `investee`, `totalPrice`, `eventType: "SHARE_DISPOSAL"`). This
// maps that natural shape onto the strict intake schema so a good read is never
// thrown away. Only applied to EVENT-shaped objects; EVIDENCE/UNKNOWN pass through.
const EVENT_ALIASES: Record<string, string> = {
  ACQUISITION: 'ACQUISITION', SHARE_ACQUISITION: 'ACQUISITION', SHARE_PURCHASE: 'ACQUISITION',
  SHARES_PURCHASE: 'ACQUISITION', PURCHASE: 'ACQUISITION', BUY: 'ACQUISITION', SUBSCRIPTION: 'ACQUISITION',
  SHARE_SUBSCRIPTION: 'ACQUISITION', CAPITAL_INCREASE: 'ACQUISITION', INVESTMENT: 'ACQUISITION',
  DISPOSAL: 'DISPOSAL', SHARE_DISPOSAL: 'DISPOSAL', SHARE_SALE: 'DISPOSAL', SHARES_SALE: 'DISPOSAL',
  SALE: 'DISPOSAL', SELL: 'DISPOSAL', SHARE_TRANSFER: 'DISPOSAL', SHARE_SALE_AGREEMENT: 'DISPOSAL',
  LOAN_ADVANCE: 'LOAN_ADVANCE', LOAN: 'LOAN_ADVANCE', LOAN_GRANTED: 'LOAN_ADVANCE', LOAN_AGREEMENT: 'LOAN_ADVANCE',
  LOAN_DISBURSEMENT: 'LOAN_ADVANCE', LOAN_PROVIDED: 'LOAN_ADVANCE', LOAN_GRANT: 'LOAN_ADVANCE',
  LOAN_REPAYMENT: 'LOAN_REPAYMENT', LOAN_REPAID: 'LOAN_REPAYMENT', REPAYMENT: 'LOAN_REPAYMENT',
  DISTRIBUTION: 'DISTRIBUTION', DIVIDEND: 'DISTRIBUTION', DIVIDEND_RECEIVED: 'DISTRIBUTION',
  INTEREST_ACCRUAL: 'INTEREST_ACCRUAL', INTEREST: 'INTEREST_ACCRUAL',
  FX_REVAL: 'FX_REVAL', WRITE_OFF: 'WRITE_OFF', IMPAIRMENT: 'WRITE_OFF',
};

// Parse a numeric amount that may arrive as a continental- or anglo-formatted
// string. The naive `Number(strip-non-digits)` corrupted EU formats: "1.234,56"
// → 1.234 and "1.234.567,00" → NaN. Here the decimal separator is inferred — when
// both '.' and ',' appear, the RIGHT-MOST one is the decimal point; a lone comma
// with a 3-digit tail is a thousands group ("1,234" = 1234) while "12,50" is
// decimal; multiple dots are thousands. Grouping separators are then removed.
function toNum(v: unknown): number | undefined {
  if (typeof v === 'number') return isFinite(v) ? v : undefined;
  if (typeof v !== 'string') return undefined;
  let s = v.replace(/[^0-9.,\-]/g, '');
  if (!s) return undefined;
  const neg = s.startsWith('-');
  s = s.replace(/-/g, '');
  if (!s) return undefined;

  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  let decSep = '';
  if (lastComma >= 0 && lastDot >= 0) {
    decSep = lastComma > lastDot ? ',' : '.'; // right-most separator is the decimal
  } else if (lastComma >= 0) {
    const commas = (s.match(/,/g) || []).length;
    const tail = s.length - lastComma - 1;
    if (commas === 1 && tail !== 3) decSep = ','; // "12,50" decimal; "1,234" thousands
  } else if (lastDot >= 0) {
    const dots = (s.match(/\./g) || []).length;
    if (dots === 1) decSep = '.'; // single dot = canonical decimal; multiple = thousands
  }

  let combined: string;
  if (decSep) {
    const idx = s.lastIndexOf(decSep);
    const intPart = s.slice(0, idx).replace(/[.,]/g, '');
    const fracPart = s.slice(idx + 1).replace(/[.,]/g, '');
    combined = `${intPart}.${fracPart}`;
  } else {
    combined = s.replace(/[.,]/g, '');
  }
  const n = Number(combined);
  if (!isFinite(n)) return undefined;
  return neg ? -n : n;
}
function firstNum(...vs: unknown[]): number | undefined {
  for (const v of vs) { const n = toNum(v); if (n !== undefined) return n; }
  return undefined;
}
function firstStr(...vs: unknown[]): string | undefined {
  for (const v of vs) if (typeof v === 'string' && v.trim()) return v.trim();
  return undefined;
}

/** Strong investment signals: a named investee plus either a share quantity or a
 *  loan principal, with a monetary figure. When these are present the document is
 *  a share-purchase/disposal or loan agreement even if the model hedged the kind
 *  to EVIDENCE/UNKNOWN — a typed event must not be thrown away. (Genuine non-
 *  accounting docs are still filed as evidence by process.ts's hard-reject gate,
 *  which runs after this and overrides an EVENT for registry extracts etc.) */
function hasInvestmentSignals(o: Record<string, any>): boolean {
  const sf = (o.sourceFigures && typeof o.sourceFigures === 'object') ? o.sourceFigures : {};
  const investee = firstStr(o.investeeName, o.investee, o.company, o.companyName, o.target, o.targetCompany, o.borrower, o.issuer);
  if (!investee) return false;
  const shares = firstNum(sf.quantity, o.quantity, o.shares, o.numberOfShares, o.noShares);
  const loan = firstNum(o.loanAmount, o.principal);
  const money = firstNum(sf.amount, o.totalPrice, o.totalAmount, o.amount, o.totalConsideration, o.consideration, o.proceeds, o.pricePerShare, o.unitPrice, o.value, o.loanAmount, o.principal);
  return (shares !== undefined || loan !== undefined) && money !== undefined;
}

export function normalizeIntakeObject(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const o = raw as Record<string, any>;
  const kind = String(o.kind || '').toUpperCase();
  const rawEvent = String(o.eventType || o.event || o.transactionType || o.type || '').toUpperCase().replace(/[^A-Z_]/g, '_');
  const mapped = EVENT_ALIASES[rawEvent] || EVENT_ALIASES[rawEvent.replace(/_/g, '')];
  // Re-shape anything that is an investment event — either the model said so, or
  // it carries strong investment signals (investee + shares/loan + amount).
  if (kind !== 'EVENT' && !mapped && !hasInvestmentSignals(o)) return raw;

  const sf = (o.sourceFigures && typeof o.sourceFigures === 'object') ? o.sourceFigures : {};
  let eventType = mapped || (typeof o.eventType === 'string' ? o.eventType.toUpperCase() : '');
  // No usable event label (the model hedged the kind)? Infer it from the signals:
  // a loan principal → LOAN_ADVANCE; shares → DISPOSAL when the text says sell/
  // dispose/transfer (sprzedaż/zbycie), else ACQUISITION.
  if (!EVENT_ALIASES[eventType]) {
    const hasShares = firstNum(sf.quantity, o.quantity, o.shares, o.numberOfShares, o.noShares) !== undefined;
    const hasLoan = firstNum(o.loanAmount, o.principal) !== undefined;
    const txt = (firstStr(o.documentType, o.documentTitle, o.title, o.rationale, o.summary, o.notes, o.eventType) || '').toLowerCase();
    if (hasLoan && !hasShares) eventType = 'LOAN_ADVANCE';
    else if (hasShares || /\bspa\b|share|udzia|akcj/.test(txt)) {
      eventType = /dispos|\bsale\b|\bsell\b|sprzeda|zbyci|transfer/.test(txt) ? 'DISPOSAL' : 'ACQUISITION';
    }
  }
  const isLoan = eventType === 'LOAN_ADVANCE' || eventType === 'LOAN_REPAYMENT';
  const investeeName = firstStr(o.investeeName, o.investee, o.company, o.companyName, o.target, o.targetCompany, o.borrower, o.counterparty, o.issuer);
  const quantity = firstNum(sf.quantity, o.quantity, o.shares, o.numberOfShares, o.noShares);
  const perShare = firstNum(o.pricePerShare, o.pricePerShare, o.unitPrice, o.sharePrice, o.price);
  // Prefer an explicit total; otherwise derive it from quantity × price-per-share
  // (agreements often state shares + unit price but no total line).
  let amount = firstNum(sf.amount, o.totalPrice, o.totalAmount, o.amount, o.totalConsideration, o.consideration, o.proceeds, o.loanAmount, o.principal, o.value);
  if (amount === undefined && quantity !== undefined && perShare !== undefined) {
    amount = Math.round(quantity * perShare * 100) / 100;
  }
  if (amount === undefined && perShare !== undefined && quantity === undefined) amount = perShare;
  const fairValue = firstNum(sf.fairValue, o.fairValue, o.valuation);
  const currency = firstStr(o.currency, sf.currency) || 'EUR';
  // Prefer the settlement/value date (when cash moves) over the trade/agreement
  // date, then fall back to any date field the model used.
  const txnDate = firstStr(
    o.txnDate, o.settlementDate, o.valueDate, o.completionDate, o.tradeDate, o.dealDate,
    o.effectiveDate, o.documentDate, o.agreementDate, o.signingDate, o.date, o.transactionDate, o.issueDate,
  ) || '';

  return {
    kind: 'EVENT',
    investeeName,
    instrument: firstStr(o.instrument) ? String(o.instrument).toUpperCase() : (isLoan ? 'LOAN' : 'SHARES'),
    eventType,
    currency,
    txnDate,
    sourceFigures: { amount: amount ?? 0, quantity: quantity ?? null, fairValue: fairValue ?? null },
    // Leave soft fields undefined when absent so the schema's own defaults apply.
    confidence: firstNum(o.confidence),
    citation: firstStr(o.citation, o.documentTitle, o.documentType),
    rationale: firstStr(o.rationale, o.notes, o.summary),
    needsReview: o.needsReview,
  };
}

export type ParseResult = { ok: true; intent: IntakeIntent } | { ok: false; error: string };

/** Parse + validate a model response into a typed intake intent. Never throws. */
export function parseIntakeResponse(content: string): ParseResult {
  let raw: unknown;
  try {
    raw = extractJsonObject(content);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'parse error' };
  }
  const parsed = intakeIntentSchema.safeParse(normalizeIntakeObject(raw));
  if (!parsed.success) {
    return { ok: false, error: parsed.error.message };
  }
  return { ok: true, intent: parsed.data };
}
