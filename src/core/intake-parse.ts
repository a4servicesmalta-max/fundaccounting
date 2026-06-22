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
  REDEMPTION: 'DISPOSAL', SHARE_REDEMPTION: 'DISPOSAL', REDEEM: 'DISPOSAL',
  BUYBACK: 'DISPOSAL', SHARE_BUYBACK: 'DISPOSAL', REPURCHASE: 'DISPOSAL', SHARE_REPURCHASE: 'DISPOSAL', EXIT: 'DISPOSAL',
  LOAN_ADVANCE: 'LOAN_ADVANCE', LOAN: 'LOAN_ADVANCE', LOAN_GRANTED: 'LOAN_ADVANCE', LOAN_AGREEMENT: 'LOAN_ADVANCE',
  LOAN_DISBURSEMENT: 'LOAN_ADVANCE', LOAN_PROVIDED: 'LOAN_ADVANCE', LOAN_GRANT: 'LOAN_ADVANCE',
  LOAN_REPAYMENT: 'LOAN_REPAYMENT', LOAN_REPAID: 'LOAN_REPAYMENT', REPAYMENT: 'LOAN_REPAYMENT',
  DISTRIBUTION: 'DISTRIBUTION', DIVIDEND: 'DISTRIBUTION', DIVIDEND_RECEIVED: 'DISTRIBUTION',
  INTEREST_ACCRUAL: 'INTEREST_ACCRUAL', INTEREST: 'INTEREST_ACCRUAL',
  FX_REVAL: 'FX_REVAL', WRITE_OFF: 'WRITE_OFF', IMPAIRMENT: 'WRITE_OFF',
  WRITE_DOWN: 'WRITE_OFF', WRITEDOWN: 'WRITE_OFF', WRITE_OFFS: 'WRITE_OFF', IMPAIR: 'WRITE_OFF',
  // Disposals that aren't a plain "sale" word.
  PARTIAL_REDEMPTION: 'DISPOSAL', PARTIAL_DISPOSAL: 'DISPOSAL', PARTIAL_SALE: 'DISPOSAL', DIVESTMENT: 'DISPOSAL',
  // Follow-on / capital increases are acquisitions (investment up).
  CAPITAL_CONTRIBUTION: 'ACQUISITION', CAPITAL_INJECTION: 'ACQUISITION', EQUITY_INJECTION: 'ACQUISITION',
  FOLLOW_ON: 'ACQUISITION', FOLLOW_ON_INVESTMENT: 'ACQUISITION', RIGHTS_ISSUE: 'ACQUISITION', TOP_UP: 'ACQUISITION',
  // Loan variants and interest income.
  BRIDGE_LOAN: 'LOAN_ADVANCE', SHAREHOLDER_LOAN: 'LOAN_ADVANCE', LOAN_FACILITY: 'LOAN_ADVANCE', DRAWDOWN: 'LOAN_ADVANCE',
  ACCRUED_INTEREST: 'INTEREST_ACCRUAL', INTEREST_INCOME: 'INTEREST_ACCRUAL', INTEREST_RECEIVED: 'INTEREST_ACCRUAL', COUPON: 'INTEREST_ACCRUAL',
};

// Resolve a free-text / foreign-language eventType LABEL (the model's explicit
// direction call) to a canonical type by keyword. Applied only to the eventType
// field — NOT the document body — because an SPA's text contains both "sale" and
// "purchase" regardless of side; the label is the model's decision. Order matters:
// the directional/specific events are tested before the generic ACQUISITION default.
function eventTypeFromLabel(label: string): string | undefined {
  const s = (label || '').toLowerCase();
  if (!s) return undefined;
  // Disposal: sale / transfer / redemption / buyback / divestment (EN/PL/DE/FR/IT).
  if (/dispos|divest|redempt|buyback|buy-back|repurchas|\bsale\b|\bsell\b|cession|vendit|sprzeda|zbyci|umorz|verkauf|veräu|verau|cessione/.test(s)) return 'DISPOSAL';
  // Loan repayment.
  if (/repay|repaid|r[üu]ckzahl|rembours|sp[lł]at|rimbors|amortizz/.test(s)) return 'LOAN_REPAYMENT';
  // Dividend / distribution.
  if (/dividend|dywidend|distribut|aussch[üu]tt|distribuzione/.test(s)) return 'DISTRIBUTION';
  // Interest income / coupon.
  if (/interest|odsetk|\bzins|int[ée]r[êe]t|interess|coupon/.test(s)) return 'INTEREST_ACCRUAL';
  // Impairment / write-off / write-down.
  if (/write[- ]?off|write[- ]?down|impair|abschreib|svalutaz/.test(s)) return 'WRITE_OFF';
  // Loan advance / grant / drawdown (loan words but not a repayment, handled above).
  if (/\bloan\b|advance|po[zż]yczk|darlehen|\bpr[êe]t\b|prestito|disburs|drawdown/.test(s)) return 'LOAN_ADVANCE';
  // Acquisition / subscription / capital increase / follow-on.
  if (/acqui|purchas|\bbuy\b|subscri|capital\s*increase|aumento|kapitalerh|augmentation|nabyci|obj[ęe]ci|invest/.test(s)) return 'ACQUISITION';
  return undefined;
}

// The canonical event types the schema accepts (the distinct alias targets). An
// event label that isn't one of these — and can't be inferred from share/loan
// signals — must NOT reach the strict enum (it would fail the whole read); it is
// degraded to UNKNOWN for review instead.
const VALID_EVENT_TYPES = new Set(Object.values(EVENT_ALIASES));

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

// The model is inconsistent about WHERE it puts the headline figure: sometimes a
// top-level field (amount/principalAmount/purchasePrice…), sometimes nested under a
// container ("amounts":{"principal":…}, "figures":{…}). Scan a list of candidate
// containers for any of the known amount keys so the figure is never lost.
const AMOUNT_KEYS = [
  'amount', 'total', 'totalPrice', 'totalAmount', 'totalConsideration', 'consideration',
  'proceeds', 'loanAmount', 'principal', 'principalAmount', 'loanPrincipal', 'nominalAmount',
  'faceValue', 'purchasePrice', 'salePrice', 'disposalProceeds', 'subscriptionAmount',
  'dividendAmount', 'distributionAmount', 'grossDividend', 'netDividend', 'interestAmount',
  'repaymentAmount', 'grossAmount', 'netAmount', 'value',
];
const CCY_KEYS = ['currency', 'ccy', 'currencyCode', 'curr'];
function pickNum(containers: unknown[], keys: string[]): number | undefined {
  for (const c of containers) {
    if (!c || typeof c !== 'object' || Array.isArray(c)) continue;
    const rec = c as Record<string, unknown>;
    for (const k of keys) {
      const n = toNum(rec[k]);
      if (n !== undefined) return n;
    }
  }
  return undefined;
}

// The model often returns the figures as an ARRAY of {label, value, currency}
// (a receivables purchase listing the purchase price + claim components; an invoice
// listing line items). Pick the HEADLINE figure: a label that names the deal total
// (purchase price / total / consideration / principal / amount due), else the
// largest value. Returns its value + currency so neither is lost.
const HEADLINE_LABEL = /purchase price|total|consideration|principal|amount due|gross|net amount|invoice total|price|proceeds|loan amount|subscription/i;
function pickFromAmountArray(arr: unknown): { amount: number; currency?: string } | null {
  if (!Array.isArray(arr)) return null;
  const entries = arr
    .map((x) => (x && typeof x === 'object' ? x as Record<string, unknown> : null))
    .filter((x): x is Record<string, unknown> => x !== null)
    .map((x) => ({ n: toNum(x.value ?? x.amount ?? x.total), label: String(x.label ?? x.name ?? x.description ?? '').toLowerCase(), ccy: typeof x.currency === 'string' ? x.currency : undefined }))
    .filter((e) => e.n !== undefined) as { n: number; label: string; ccy?: string }[];
  if (!entries.length) return null;
  const preferred = entries.find((e) => HEADLINE_LABEL.test(e.label));
  const chosen = preferred || entries.reduce((a, b) => (Math.abs(b.n) > Math.abs(a.n) ? b : a));
  return { amount: chosen.n, currency: chosen.ccy };
}
// Same container scan for the currency string (the model sometimes nests it under
// "amounts"/"figures", which left foreign amounts defaulting to EUR with no FX).
function pickStr(containers: unknown[], keys: string[]): string | undefined {
  for (const c of containers) {
    if (!c || typeof c !== 'object') continue;
    const rec = c as Record<string, unknown>;
    for (const k of keys) {
      const v = rec[k];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
  }
  return undefined;
}
function firstStr(...vs: unknown[]): string | undefined {
  for (const v of vs) if (typeof v === 'string' && v.trim()) return v.trim();
  return undefined;
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

// Normalise a date the model wrote in ANY form to ISO YYYY-MM-DD. The model emits
// "20 March 2025", "March 20, 2025", "20/03/2025", "2025-03-20", etc.; downstream
// (period derivation, the books-opening-date guard, the NH-0 bank matcher which
// does Date.parse(`${d}T00:00:00Z`)) all assume ISO, so a human-readable date
// silently broke matching and period scoping. Unparseable input is returned as-is
// so the impossible-date validator still flags it.
function toIsoDate(s: string | undefined): string {
  const raw = (s || '').trim();
  if (!raw) return '';
  const iso = raw.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  // "20 March 2025" / "20 Mar 2025" / "March 20, 2025"
  const dmy = raw.match(/(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})/);
  const mdy = raw.match(/([A-Za-z]{3,})\s+(\d{1,2}),?\s+(\d{4})/);
  let y: number | undefined, m: number | undefined, d: number | undefined;
  if (dmy) { d = +dmy[1]; m = MONTHS[dmy[2].slice(0, 3).toLowerCase()]; y = +dmy[3]; }
  else if (mdy) { m = MONTHS[mdy[1].slice(0, 3).toLowerCase()]; d = +mdy[2]; y = +mdy[3]; }
  else {
    // dd/mm/yyyy or dd.mm.yyyy (day-first, the EU convention these docs use)
    const num = raw.match(/(\d{1,2})[\/.](\d{1,2})[\/.](\d{4})/);
    if (num) { d = +num[1]; m = +num[2]; y = +num[3]; }
  }
  if (y && m && d && m >= 1 && m <= 12 && d >= 1 && d <= 31) {
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  return raw; // leave for the impossible-date validator downstream
}

/** Coerce a free-text instrument to the canonical SHARES|LOAN the schema accepts.
 *  The model echoes the document's own wording ("ordinary shares", "preferred
 *  stock", "loan note", "Umowa pożyczki"); passing that raw to a strict enum made
 *  the WHOLE document fail to read. Loan signals are checked first so "loan stock"
 *  is debt, while "preferred stock" stays equity. */
function coerceInstrument(raw: unknown, isLoan: boolean): 'SHARES' | 'LOAN' {
  const s = String(raw ?? '').toLowerCase();
  if (/loan|promissory|debenture|debt|facility|\bbond\b|po[zż]yczk|pozyczk|obligacj/.test(s)) return 'LOAN';
  if (/share|stock|equity|udzia|akcj|warrant|ordinary|preferen|preferred/.test(s)) return 'SHARES';
  return isLoan ? 'LOAN' : 'SHARES';
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
  // A share document doesn't always carry an explicit quantity — the share count
  // may be implied by the instrument ("Series A registered shares") or share-number
  // range. Recognise those so a share SPA the model hedged to EVIDENCE/UNKNOWN is
  // still rescued to a typed ACQUISITION/DISPOSAL (not the free-form journal path).
  const sharesLike = shares !== undefined
    || o.shareNumbersFrom !== undefined || o.shareNumbersTo !== undefined || o.shareSeries !== undefined
    || /\b(share|shares|udzia|akcj|stock|equity)\b/i.test(`${o.instrument ?? ''} ${o.documentTitle ?? o.documentType ?? ''}`);
  // Use the SAME array-aware extraction as the main path — otherwise a share SPA
  // whose figures are in an `amounts:[…]` array isn't recognised as having money,
  // so it falls to the free-form suggested-journal path (which mis-books it) instead
  // of being rescued to a clean typed ACQUISITION/DISPOSAL.
  const money = firstNum(sf.amount, o.totalPrice, o.totalAmount, o.amount, o.totalConsideration, o.consideration, o.proceeds, o.pricePerShare, o.unitPrice, o.value, o.loanAmount, o.principal)
    ?? pickNum([sf, o, o.amounts, o.figures, o.financials, o.details, o.terms], AMOUNT_KEYS)
    ?? pickFromAmountArray(o.amounts)?.amount
    ?? pickFromAmountArray(o.figures)?.amount
    ?? pickFromAmountArray(o.lineItems)?.amount;
  return (sharesLike || loan !== undefined) && money !== undefined;
}

export function normalizeIntakeObject(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const o = raw as Record<string, any>;
  const kind = String(o.kind || '').toUpperCase();
  const rawEvent = String(o.eventType || o.event || o.transactionType || o.type || '').toUpperCase().replace(/[^A-Z_]/g, '_');
  const mapped = EVENT_ALIASES[rawEvent] || EVENT_ALIASES[rawEvent.replace(/_/g, '')]
    || eventTypeFromLabel(String(o.eventType ?? o.event ?? o.transactionType ?? o.type ?? ''));
  // Re-shape anything that is an investment event — either the model said so, or
  // it carries strong investment signals (investee + shares/loan + amount).
  if (kind !== 'EVENT' && !mapped && !hasInvestmentSignals(o)) return raw;

  const sf = (o.sourceFigures && typeof o.sourceFigures === 'object') ? o.sourceFigures : {};
  let eventType = mapped || (typeof o.eventType === 'string' ? o.eventType.toUpperCase() : '');
  // No usable event label (the model hedged the kind)? Infer it from the signals:
  // a loan principal → LOAN_ADVANCE; shares → ACQUISITION by default. A Sale &
  // Purchase Agreement has BOTH a buyer and a seller, so "sale"/"sell"/"transfer"/
  // "sprzedaż" appear regardless of which side the fund is on and cannot decide the
  // direction. Only an explicit disposal/seller signal (the fund selling/disposing)
  // flips it to DISPOSAL; the precise buyer-vs-seller call is the AI's (it is told the
  // reporting entity) — this is just the deterministic fallback when the model hedged.
  if (!EVENT_ALIASES[eventType]) {
    const hasShares = firstNum(sf.quantity, o.quantity, o.shares, o.numberOfShares, o.noShares) !== undefined;
    const hasLoan = firstNum(o.loanAmount, o.principal) !== undefined;
    const txt = (firstStr(o.documentType, o.documentTitle, o.title, o.rationale, o.summary, o.notes, o.eventType) || '').toLowerCase();
    if (hasLoan && !hasShares) eventType = 'LOAN_ADVANCE';
    else if (hasShares || /\bspa\b|share|udzia|akcj/.test(txt)) {
      const sellsOut = /dispos|zbyci|written?\s*-?\s*off|write[- ]?off|as (the )?seller|fund[^.]{0,40}\bseller\b|seller[^.]{0,40}fund/.test(txt);
      eventType = sellsOut ? 'DISPOSAL' : 'ACQUISITION';
    }
  }
  // Safety net: an event label we still can't resolve to a canonical type (e.g.
  // "CAPITAL_CALL", "RETURN_OF_CAPITAL", "CONVERSION") must not hit the strict
  // schema enum — that would fail the entire read. Hand it on as UNKNOWN so the
  // document is reviewed (or suggested-journalled), never dropped or mis-booked.
  if (!VALID_EVENT_TYPES.has(eventType)) {
    return {
      kind: 'UNKNOWN',
      rationale: firstStr(o.rationale, o.notes, o.summary, o.documentType, o.documentTitle) ?? '',
      needsReview: true,
    };
  }
  const isLoan = eventType === 'LOAN_ADVANCE' || eventType === 'LOAN_REPAYMENT';
  const investeeName = firstStr(o.investeeName, o.investee, o.company, o.companyName, o.target, o.targetCompany, o.borrower, o.counterparty, o.issuer);
  const quantity = firstNum(sf.quantity, o.quantity, o.shares, o.numberOfShares, o.noShares);
  const perShare = firstNum(o.pricePerShare, o.pricePerShare, o.unitPrice, o.sharePrice, o.price);
  // Prefer an explicit total; otherwise derive it from quantity × price-per-share
  // (agreements often state shares + unit price but no total line).
  // sourceFigures.amount wins; then top-level fields; then nested containers the
  // model sometimes uses ("amounts"/"figures"/"financials"/"details"/"terms").
  let amount = pickNum(
    [sf, o, o.amounts, o.figures, o.financials, o.details, o.terms],
    AMOUNT_KEYS,
  );
  // The figure may be in an ARRAY of {label, value, currency} (receivables purchase,
  // invoice line items). Pick the headline value + carry its currency.
  let arrayCcy: string | undefined;
  if (amount === undefined) {
    const fromArr = pickFromAmountArray(o.amounts) || pickFromAmountArray(o.figures)
      || pickFromAmountArray(o.lineItems) || pickFromAmountArray(o.items) || pickFromAmountArray(o.amountBreakdown);
    if (fromArr) { amount = fromArr.amount; arrayCcy = fromArr.currency; }
  }
  if (amount === undefined && quantity !== undefined && perShare !== undefined) {
    amount = Math.round(quantity * perShare * 100) / 100;
  }
  if (amount === undefined && perShare !== undefined && quantity === undefined) amount = perShare;
  const fairValue = firstNum(sf.fairValue, o.fairValue, o.valuation);
  const currency = pickStr([o, sf, o.amounts, o.figures, o.financials, o.details, o.terms], CCY_KEYS) || arrayCcy || 'EUR';
  // Prefer the settlement/value date (when cash moves) over the trade/agreement
  // date, then fall back to any date field the model used.
  const txnDate = toIsoDate(firstStr(
    o.txnDate, o.settlementDate, o.valueDate, o.completionDate, o.tradeDate, o.dealDate,
    o.effectiveDate, o.documentDate, o.agreementDate, o.signingDate, o.date, o.transactionDate, o.issueDate,
  ));

  return {
    kind: 'EVENT',
    investeeName,
    instrument: coerceInstrument(o.instrument, isLoan),
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
