// Opening-balances (starting trial balance) parser.
//
// This is deterministic engine logic, NOT AI: every figure here is computed
// straight from the numbers the user uploaded or pasted. We only read columns
// and add them up. A trial balance must balance (debits == credits) before it
// can be imported as the starting position the books continue from.

export interface ParsedTbRow {
  accountCode: string;
  accountName: string;
  debit: number;
  credit: number;
}

export interface ParsedTrialBalance {
  rows: ParsedTbRow[];
  totals: { debit: number; credit: number };
  difference: number; // round2(totalDebit - totalCredit)
  balanced: boolean;
  errors: string[];
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Parse a money cell that may carry a currency symbol, thousands separators,
 *  parentheses for negatives, or a trailing minus. Returns NaN if non-numeric,
 *  0 for an empty cell. */
export function parseAmount(raw: unknown): number {
  if (raw == null) return 0;
  let s = String(raw).trim();
  if (!s) return 0;
  let neg = false;
  if (/^\(.*\)$/.test(s)) {
    neg = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/[€$£]|chf|zł|eur|usd|gbp/gi, '').replace(/\s/g, '');
  if (/-$/.test(s)) {
    neg = true;
    s = s.replace(/-$/, '');
  }
  if (/^-/.test(s)) {
    neg = !neg;
    s = s.replace(/^-/, '');
  }
  if (s === '' || s === '+') return 0;

  // Decide which symbol is the decimal point. When both '.' and ',' appear, the
  // LAST one is the decimal separator and the other is a thousands separator
  // (covers both "1,234.56" and "1.234,56"). A lone comma is a decimal only when
  // it sits before the final 1–2 digits ("1234,5"); otherwise it's thousands.
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  let decimal: '.' | ',' | '' = '';
  if (lastDot >= 0 && lastComma >= 0) decimal = lastDot > lastComma ? '.' : ',';
  else if (lastComma >= 0) decimal = /,\d{1,2}$/.test(s) && (s.match(/,/g) || []).length === 1 ? ',' : '';
  else if (lastDot >= 0) decimal = '.';

  if (decimal === '.') s = s.replace(/,/g, '');
  else if (decimal === ',') s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(/[.,]/g, '');

  const n = Number(s);
  return isFinite(n) ? (neg ? -n : n) : NaN;
}

/** True only for a cell that actually carries a number (so header text like
 *  "EUR" or "Debit" is not mistaken for a value). */
function isNumericCell(s: string): boolean {
  return /\d/.test(s) && isFinite(parseAmount(s));
}

/** Split one CSV/TSV line, honouring quoted fields and comma/semicolon/tab. */
function splitLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuote) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuote = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuote = true;
    } else if (ch === ',' || ch === '\t' || ch === ';') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

interface ColumnMap {
  code: number;
  name: number;
  debit: number;
  credit: number;
  balance: number; // single signed-balance column; -1 if not used
}

/** Work out which column is which from a header row, if there is one. */
function detectColumns(headerCells: string[]): ColumnMap {
  const map: ColumnMap = { code: -1, name: -1, debit: -1, credit: -1, balance: -1 };
  headerCells.forEach((cell, i) => {
    const c = cell.toLowerCase();
    if (map.credit < 0 && /credit|^cr$/.test(c)) map.credit = i;
    else if (map.debit < 0 && /debit|^dr$/.test(c)) map.debit = i;
    else if (map.balance < 0 && /balance|amount/.test(c)) map.balance = i;
    else if (map.name < 0 && /name|description|narrative/.test(c)) map.name = i;
    else if (map.code < 0 && /code|account|nominal/.test(c)) map.code = i;
  });
  if (map.code < 0) map.code = 0;
  if (map.name < 0) map.name = map.code === 1 ? 0 : 1;
  return map;
}

/** Positional columns when there is no header. */
function positionalColumns(width: number): ColumnMap {
  if (width <= 2) return { code: 0, name: -1, debit: -1, credit: -1, balance: 1 };
  if (width === 3) return { code: 0, name: 1, debit: -1, credit: -1, balance: 2 };
  return { code: 0, name: 1, debit: 2, credit: 3, balance: -1 };
}

function isTotalRow(code: string, name: string): boolean {
  return /^total/i.test(code) || (code === '' && /^total/i.test(name));
}

export function parseTrialBalanceCsv(text: string): ParsedTrialBalance {
  const errors: string[] = [];
  const lines = String(text || '')
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '');

  if (!lines.length) {
    return { rows: [], totals: { debit: 0, credit: 0 }, difference: 0, balanced: false, errors: ['The trial balance looks empty.'] };
  }

  const first = splitLine(lines[0]);
  const hasHeader = first.some((c) => /code|account|name|debit|credit|balance|amount|nominal|narrative/i.test(c)) && !first.some(isNumericCell);

  const cols = hasHeader ? detectColumns(first) : positionalColumns(first.length);
  const startRow = hasHeader ? 1 : 0;

  const rows: ParsedTbRow[] = [];
  let totalDebit = 0;
  let totalCredit = 0;

  for (let i = startRow; i < lines.length; i++) {
    const cells = splitLine(lines[i]);
    const accountCode = (cols.code >= 0 ? cells[cols.code] : '') || '';
    const accountName = (cols.name >= 0 ? cells[cols.name] : '') || '';

    if (isTotalRow(accountCode, accountName)) continue; // skip a totals row

    let debit = 0;
    let credit = 0;
    if (cols.balance >= 0 && cols.debit < 0 && cols.credit < 0) {
      const bal = parseAmount(cells[cols.balance]);
      if (Number.isNaN(bal)) {
        errors.push(`Line ${i + 1}: "${cells[cols.balance]}" is not a number.`);
        continue;
      }
      debit = bal > 0 ? bal : 0;
      credit = bal < 0 ? -bal : 0;
    } else {
      const d = parseAmount(cols.debit >= 0 ? cells[cols.debit] : '');
      const c = parseAmount(cols.credit >= 0 ? cells[cols.credit] : '');
      if (Number.isNaN(d) || Number.isNaN(c)) {
        errors.push(`Line ${i + 1}: the debit/credit value is not a number.`);
        continue;
      }
      debit = d;
      credit = c;
    }

    if (round2(debit) === 0 && round2(credit) === 0) continue; // blank/zero line

    if (!accountCode) {
      errors.push(`Line ${i + 1}: missing an account code, so it was skipped.`);
      continue;
    }

    debit = round2(debit);
    credit = round2(credit);
    totalDebit = round2(totalDebit + debit);
    totalCredit = round2(totalCredit + credit);
    rows.push({ accountCode, accountName, debit, credit });
  }

  const difference = round2(totalDebit - totalCredit);
  return {
    rows,
    totals: { debit: totalDebit, credit: totalCredit },
    difference,
    balanced: rows.length > 0 && Math.abs(difference) < 0.005,
    errors,
  };
}
