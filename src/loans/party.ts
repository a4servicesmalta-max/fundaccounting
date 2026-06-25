// Clean a loan counterparty name out of a raw bank narration, and a normalised key so
// the same borrower under different name forms (e.g. "Booste S.A." vs "Booste Spółka
// Akcyjna") groups together. Pure + deterministic.
//
// A Polish/EU transfer narration typically starts with the counterparty name, then the
// account number / IBAN, then the agreement + transfer-type text:
//   "Bartosz Lis 20 1140 2004 0000 3602 5599 3961 Loan Agreement PRZELEW ELIXIR …"
//   "Sentryc GmbH DE 6910 0208 9000 2934 0250 Loan Agreement POLECENIE WYPŁATY …"
// We keep the text BEFORE the account/IBAN as the party name.

// A bank account / IBAN: an optional 2-letter country code, then groups of 2–4 digits.
const ACCOUNT_RE = /\s(?:[A-Z]{2}\s?)?\d{2,4}(?:\s\d{2,4}){2,}/;

/** Extract a clean party name from a raw narration (or pass through an already-clean
 *  name). Never returns empty. */
export function cleanPartyName(raw: string): string {
  const s = (raw || '').replace(/\s+/g, ' ').trim();
  if (!s) return 'Unknown';
  const m = s.match(ACCOUNT_RE);
  let name = m && (m.index ?? 0) > 0 ? s.slice(0, m.index).trim() : s;
  name = name.replace(/[\s,;:\-–—]+$/, '').trim(); // strip trailing separators (keep abbrev. dots)
  if (name.length < 2) name = s.split(' ').slice(0, 4).join(' '); // account-first: fall back
  // No account number found and it's a long narration → keep it readable.
  if (!m && name.split(' ').length > 6) name = name.split(' ').slice(0, 6).join(' ');
  return name || 'Unknown';
}

/** Normalised grouping key: lowercase, legal suffixes (S.A. / Spółka Akcyjna / GmbH /
 *  Ltd / Sp. z o.o. …) removed, so name-form variants of the same party collapse. */
export function partyKey(name: string): string {
  let s = (name || '').toLowerCase();
  s = s.replace(/\bs\.?\s?a\.?\b/g, ' '); // S.A. / S A / SA
  s = s.replace(/\bsp\.?\s?z\s?o\.?\s?o\.?\b/g, ' '); // Sp. z o.o.
  s = s.replace(/\bspó?[lł]ka z ogranicz[oą]n[aą] odpowiedzialno[śs]ci[aą]\b/g, ' ');
  s = s.replace(/\bspó?[lł]ka akcyjna\b/g, ' ');
  s = s.replace(/\b(gmbh|ag|ltd|limited|llc|plc|inc|b\.?v\.?|oy|ab|s\.?r\.?l\.?)\b/g, ' ');
  s = s.replace(/[^a-z0-9ąćęłńóśźż ]+/g, ' ').replace(/\s+/g, ' ').trim();
  return s || (name || '').toLowerCase().trim();
}
