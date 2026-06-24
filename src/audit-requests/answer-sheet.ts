// Answer an auditor's request SHEET from the gathered evidence. Reads an Excel/CSV
// sheet (the auditor's questions, one per row), and appends answer columns: the
// evidence reference, the evidence file name(s), and a status. The matching is
// DETERMINISTIC — each row is matched to the gathered evidence by the same entity/
// year/keyword terms the request gathering uses. Rows with no match are flagged
// "needs review" (these are where the AI reader would help once connected); the
// deterministic answers + citations always come back, with or without AI.

import * as XLSX from 'xlsx';
import type { EvidenceItem } from '../evidence/evidence';
import { termsFromText } from './audit-requests';

export const ANSWER_HEADERS = ['Evidence reference', 'Evidence file(s)', 'Status'];

export interface AnswerResult {
  rows: string[][];
  answered: number; // rows matched to evidence
  needsReview: number; // rows with no deterministic match
}

/** Parse a sheet buffer (xlsx/xls/csv) into a 2-D array of strings (first sheet). */
export function sheetBufferToRows(buf: Buffer): string[][] {
  const wb = XLSX.read(buf, { type: 'buffer' });
  const name = wb.SheetNames[0];
  const ws = name ? wb.Sheets[name] : undefined;
  if (!ws) return [];
  const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, blankrows: false, defval: '' });
  return rows.map((r) => (Array.isArray(r) ? r.map((c) => (c == null ? '' : String(c))) : []));
}

/** Write rows back to an .xlsx buffer (the answered copy of the sheet). */
export function rowsToXlsxBuffer(rows: string[][]): Buffer {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Answered');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

/**
 * Deterministically answer each question row from the gathered evidence. The first
 * non-empty row is treated as the header (answer headers are appended to it); each
 * subsequent row is matched to evidence by its terms, and the reference + file name(s)
 * + status are appended. Blank rows pass through unchanged.
 */
export function answerSheetRows(rows: string[][], evidence: EvidenceItem[]): AnswerResult {
  if (!rows.length) return { rows: [], answered: 0, needsReview: 0 };
  const out: string[][] = [];
  out.push([...(rows[0] || []), ...ANSWER_HEADERS]);
  let answered = 0;
  let needsReview = 0;
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] || [];
    if (!row.join('').trim()) {
      out.push(row);
      continue;
    }
    const terms = termsFromText(row.join(' '));
    const matched = terms.length
      ? evidence.filter((it) => {
          const hay = `${it.fileName} ${it.linkedTo} ${it.classification} ${it.period}`.toLowerCase();
          return terms.some((t) => hay.includes(t));
        })
      : [];
    if (matched.length) {
      answered += 1;
      out.push([
        ...row,
        matched.map((m) => m.linkedTo).join('; '),
        matched.map((m) => m.fileName).join('; '),
        'Provided',
      ]);
    } else {
      needsReview += 1;
      out.push([...row, '', '', 'Not found in evidence — needs review']);
    }
  }
  return { rows: out, answered, needsReview };
}
