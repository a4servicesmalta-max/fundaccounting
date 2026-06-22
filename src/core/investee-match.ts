// Match a company name read off a supporting document (e.g. a registry extract)
// to a known investee/holding, so the document can be filed as *ownership evidence
// for that holding* rather than a disconnected "supporting document". PURE: no I/O.

export interface InvesteeRef {
  name: string;
  controlCode: string;
}

// Legal-form suffixes, matched with internal dots/spaces still present (run BEFORE
// punctuation is stripped) so "S.A.", "Sp. z o.o.", "z o.o." are removed cleanly.
const LEGAL_SUFFIXES =
  /\b(limited|ltd|plc|incorporated|inc|llc|corporation|corp|company|co|s\.?\s*a\.?|s\.?\s*p\.?\s*a\.?|sp\.?\s*z\s*o\.?\s*o\.?|z\s*o\.?\s*o\.?|gmbh|ag|b\.?\s*v\.?|n\.?\s*v\.?|oyj|asi|ulc)\.?(?=\s|$|[,.])/gi;

/** Normalise a company name for comparison: lowercase, strip diacritics, legal
 *  suffixes, then punctuation; collapse whitespace. "Gamivo S.A." → "gamivo". */
export function normalizeCompany(name: string): string {
  let s = (name || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ł/g, 'l') // ł
    .toLowerCase();
  s = s.replace(LEGAL_SUFFIXES, ' '); // suffixes first, while dots are intact
  s = s.replace(/[.,/()'"&-]/g, ' ').replace(/\s+/g, ' ').trim();
  return s;
}

/** Find the known investee a company name refers to. Exact-normalised match first,
 *  then a contains-match either way (so "Gamivo" matches "Gamivo S.A." and vice
 *  versa). Returns null when nothing plausible matches. Requires ≥3 chars to avoid
 *  spurious matches on tiny tokens. */
export function matchInvestee(name: string | null | undefined, roster: InvesteeRef[]): InvesteeRef | null {
  const want = normalizeCompany(name || '');
  if (want.length < 3) return null;

  // 1. Exact normalised equality.
  for (const r of roster) {
    if (normalizeCompany(r.name) === want) return r;
  }
  // 2. One contains the other (whole-token boundary via padded spaces). When more
  //    than one holding matches, prefer the equity (030) account over the loan
  //    (032) — a registry extract evidences SHARE ownership — then the most
  //    specific (shortest) roster name.
  const wantPad = ` ${want} `;
  let best: InvesteeRef | null = null;
  let bestScore = Infinity;
  for (const r of roster) {
    const rn = normalizeCompany(r.name);
    if (!rn || rn.length < 3) continue;
    const rnPad = ` ${rn} `;
    if (wantPad.includes(rnPad) || rnPad.includes(wantPad)) {
      const score = (r.controlCode.startsWith('030') ? 0 : 1000) + rn.length;
      if (score < bestScore) { best = r; bestScore = score; }
    }
  }
  return best;
}

/** Resolve an event's investee to an EXISTING holding under the given instrument
 *  control prefix ('030' equity / '032' loan). A disposal or follow-on purchase
 *  must reuse the account the opening balance registered (e.g. "030-BSA") rather
 *  than mint a fresh slug ("030-booste-spolka-akcyjna") — minting orphans the
 *  carrying cost, so a sale finds carrying 0 and books the whole proceeds as
 *  gain without removing the position. Returns null when nothing matches, so the
 *  caller can mint a new code for a genuinely new position. */
export function findExistingHolding(
  investeeName: string | null | undefined,
  prefix: '030' | '032',
  roster: InvesteeRef[],
): InvesteeRef | null {
  return matchInvestee(investeeName, roster.filter((r) => r.controlCode.startsWith(prefix)));
}
