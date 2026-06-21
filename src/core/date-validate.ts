// Date validation (CONTRACT: no silent coercion — trap T2).
// JS `new Date("2021-09-31")` silently rolls forward to 2021-10-01, which moves a
// transaction into the wrong period. We detect impossible calendar dates and
// surface them for the reviewer instead of guessing.

export interface DateCheck {
  ok: boolean;
  /** true when the string is a well-formed YYYY-MM-DD whose day exceeds the
   *  number of days in that month (e.g. 2021-09-31, 2021-02-30). */
  impossible: boolean;
  /** the nearest sensible correction (last valid day of that month) when impossible. */
  suggestion: string | null;
  reason: string | null;
}

function daysInMonth(year: number, month1to12: number): number {
  // Day 0 of next month = last day of this month.
  return new Date(Date.UTC(year, month1to12, 0)).getUTCDate();
}

/** Validate a YYYY-MM-DD date string. Non-ISO inputs are reported as not-ok but
 *  not "impossible" (other parsers handle free-form dates). */
export function checkDate(input: string | null | undefined): DateCheck {
  const s = (input ?? '').trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) {
    return { ok: false, impossible: false, suggestion: null, reason: s ? 'Not an ISO (YYYY-MM-DD) date.' : 'No date.' };
  }
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12) {
    return { ok: false, impossible: true, suggestion: null, reason: `Month ${m[2]} is not 01–12.` };
  }
  const dim = daysInMonth(y, mo);
  if (d < 1 || d > dim) {
    const suggestion = `${m[1]}-${m[2]}-${String(dim).padStart(2, '0')}`;
    return {
      ok: false,
      impossible: true,
      suggestion,
      reason: `${m[2]}/${y} has ${dim} days, but the date says day ${m[3]}.`,
    };
  }
  return { ok: true, impossible: false, suggestion: null, reason: null };
}
