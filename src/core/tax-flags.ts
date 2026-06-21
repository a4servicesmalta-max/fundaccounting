// Tax flags (CONTRACT: trap T8 — the engine FLAGS tax treatment for the reviewer;
// it never computes or applies tax automatically). Three fund-relevant cases:
//   · share disposals → Malta participation exemption likely applies (review)
//   · share dealing   → outside the scope of / exempt from VAT
//   · cross-border services from a foreign supplier → reverse-charge VAT
// These are advisory only and must be confirmed by a qualified preparer.

export interface TaxFlag {
  code: 'PARTICIPATION_EXEMPTION' | 'VAT_EXEMPT_SHARE_DEALING' | 'REVERSE_CHARGE';
  label: string;
  note: string;
}

const PARTICIPATION: TaxFlag = {
  code: 'PARTICIPATION_EXEMPTION',
  label: 'Participation exemption?',
  note: 'Gains/income from a participating holding may be exempt under the Malta participation exemption — confirm the holding qualifies; do not auto-tax.',
};
const VAT_EXEMPT: TaxFlag = {
  code: 'VAT_EXEMPT_SHARE_DEALING',
  label: 'VAT-exempt (share dealing)',
  note: 'Dealing in shares/securities is exempt from / outside the scope of VAT — no output VAT on the proceeds.',
};
const REVERSE_CHARGE: TaxFlag = {
  code: 'REVERSE_CHARGE',
  label: 'Reverse-charge VAT?',
  note: 'Services received from a supplier in another country are typically subject to the reverse charge — account for VAT on both sides; confirm the place of supply.',
};

/** Flags for an investment draft, from its event type and instrument. */
export function taxFlagsForDraft(input: { eventType?: string; instrument?: string }): TaxFlag[] {
  const ev = (input.eventType || '').toUpperCase();
  const isShares = (input.instrument || '').toUpperCase() === 'SHARES';
  const flags: TaxFlag[] = [];
  if (ev === 'DISPOSAL' && isShares) {
    flags.push(PARTICIPATION, VAT_EXEMPT);
  } else if (ev === 'DISTRIBUTION') {
    // Dividends from a participating holding may also be exempt.
    flags.push(PARTICIPATION);
  }
  return flags;
}

// Service vendors whose bills usually represent cross-border services (brokerage,
// legal, advisory, corporate services). Diacritic-insensitive, lower-cased.
const SERVICE_HINTS = [
  'maklerski', 'broker', 'brokerage', 'legal', 'law', 'advisory', 'advisor',
  'consult', 'corporate service', 'accounting', 'audit', 'notary', 'cheran',
  'professional', 'kancelaria', 'doradztwo',
];

function norm(s: string): string {
  return (s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l').toLowerCase();
}

/** Flags for an AR/AP item. A foreign-currency (or evidently foreign-supplier)
 *  PAYABLE for services is flagged for the reverse charge. baseCurrency defaults
 *  to EUR. */
export function taxFlagsForArap(input: {
  kind?: string;
  counterparty?: string;
  currency?: string;
  baseCurrency?: string;
}): TaxFlag[] {
  if ((input.kind || '').toUpperCase() !== 'PAYABLE') return [];
  const base = (input.baseCurrency || 'EUR').toUpperCase();
  const ccy = (input.currency || base).toUpperCase();
  const name = norm(input.counterparty || '');
  const looksService = SERVICE_HINTS.some((h) => name.includes(h));
  const foreign = ccy !== base;
  // Reverse charge is relevant when a service is supplied from abroad. We treat a
  // foreign-currency service bill, or a clearly foreign service vendor, as such.
  if (looksService && (foreign || /maklerski|cheran|kancelaria|doradztwo/.test(name))) {
    return [REVERSE_CHARGE];
  }
  return [];
}
