// Deterministic keyword categorisation of bank transactions (CONTRACT §12(b)).
// PURE: no I/O, no store access. Maps a transaction description (and amount sign)
// to a chart account code + a confidence in [0,1]. Unrecognised lines fall to the
// 9999 suspense account at low confidence so they force user review.

import { accountName } from '../core/chart';

export interface CategorizeInput {
  description: string;
  amount: number;
}

export interface CategorizeResult {
  code: string;
  name: string;
  confidence: number;
}

interface Rule {
  code: string;
  confidence: number;
  keywords: string[];
  /** Optional extra predicate over the (normalised desc, amount). */
  when?: (desc: string, amount: number) => boolean;
  /** Materiality cap: if |amount| exceeds this, the keyword match is not trusted
   *  (a "fee" of millions is not a fee) and the line is left for review. */
  maxAbsAmount?: number;
}

// Lowercase AND strip diacritics so accented EU-language descriptions match
// their plain-ASCII keywords (e.g. "Opłata"->"oplata", "Odsetki"->"odsetki",
// "Gebühr"->"gebuhr", "intérêts"->"interets"). NFD splits a base letter from
// its combining marks; we drop the combining-mark range. The Polish stroked-l
// "ł" has no decomposition, so it is mapped explicitly.
function normalize(s: string): string {
  return (s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ł/g, 'l') // ł
    .replace(/Ł/g, 'l') // Ł
    .toLowerCase();
}

// Order matters: first matching rule wins. More specific / higher-confidence
// rules are listed first. All keywords MUST be lowercase + diacritic-free
// (i.e. already normalised) so they compare against normalize(description).
const RULES: Rule[] = [
  // 6100 (legal/professional) is checked before the generic fee rule so that
  // "audit fee", "legal fees" etc. land on professional fees, not bank charges.
  { code: '6100', confidence: 0.8, keywords: ['legal', 'notary', 'law', 'audit', 'accounting', 'accountant'] },
  // Interest is sign-disambiguated: an interest INFLOW (credit, amount > 0) is
  // interest INCOME (510), an interest OUTFLOW is interest EXPENSE (6400). Both
  // are checked BEFORE the generic fee/charge rule, because "interest charged"
  // contains "charge" and would otherwise be mis-booked as a bank charge (6300).
  {
    code: '510', // Loan interest income (REVENUE)
    confidence: 0.85,
    keywords: ['interest', 'odsetki', 'zinsen', 'interets'],
    when: (_desc, amount) => amount > 0,
  },
  {
    code: '6400', // Interest expense
    confidence: 0.85,
    keywords: ['interest', 'odsetki', 'zinsen', 'interets'],
    when: (_desc, amount) => amount < 0,
  },
  {
    code: '6300',
    confidence: 0.9,
    // A genuine bank charge / fee / commission is small. A line that merely
    // contains "fee" but moves a material amount (e.g. a "Wire transfer fee" of
    // €5.8m) is a payment, not a fee — leave it for review instead of booking it
    // as a bank charge (which would grossly distort the P&L).
    maxAbsAmount: 10000,
    keywords: [
      // EN
      'bank charge', 'bank charges', 'charge', 'fee', 'fees', 'commission',
      // PL: opłata (fee), prowizja (commission)
      'oplata', 'prowizja',
      // DE: Gebühr; FR: frais
      'gebuhr', 'frais',
    ],
  },
  {
    code: '6000',
    confidence: 0.85,
    keywords: [
      // EN
      'rent', 'lease',
      // PL: czynsz / najem; DE: Miete; FR: loyer
      'czynsz', 'najem', 'miete', 'loyer',
    ],
  },
  {
    code: '6500',
    confidence: 0.85,
    keywords: [
      // EN
      'salary', 'salaries', 'payroll', 'wages', 'wage',
      // PL: wynagrodzenie / pensja / płaca; DE: Gehalt/Lohn; FR: salaire
      'wynagrodzenie', 'pensja', 'placa', 'gehalt', 'lohn', 'salaire',
    ],
  },
  {
    code: '4000',
    confidence: 0.8,
    keywords: [
      // EN
      'dividend', 'distribution',
      // PL: dywidenda; DE: Dividende; FR: dividende
      'dywidenda', 'dividende',
    ],
    when: (_desc, amount) => amount > 0,
  },
];

export function categorizeTransaction(txn: CategorizeInput): CategorizeResult {
  const desc = normalize(txn.description);
  for (const rule of RULES) {
    const hit = rule.keywords.some((kw) => desc.includes(kw));
    if (!hit) continue;
    if (rule.when && !rule.when(desc, txn.amount)) continue;
    // Materiality guard: an immaterial-expense keyword on a material amount is not
    // trustworthy — fall through to suspense/review rather than mis-book it.
    if (rule.maxAbsAmount != null && Math.abs(txn.amount) > rule.maxAbsAmount) continue;
    return { code: rule.code, name: accountName(rule.code), confidence: rule.confidence };
  }
  // Default: suspense, low confidence -> always lands in REVIEW.
  return { code: '9999', name: accountName('9999'), confidence: 0.2 };
}
