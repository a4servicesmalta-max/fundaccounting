// Turn an uploaded file's bytes into an ExtractContent block for Claude (CONTRACT §7).

import * as path from 'path';
import * as XLSX from 'xlsx';
import type { ExtractContent } from '../ai/claude';

function ext(fileName: string): string {
  return path.extname(fileName).toLowerCase().replace(/^\./, '');
}

const IMAGE_MEDIA: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

/**
 * Decide by extension AND/OR mime (lenient).
 * PDF → pdf; CSV/TXT → text; XLSX/XLS → text (sheets → CSV); images → image; else null.
 */
export function toContent(fileName: string, mime: string, buffer: Buffer): ExtractContent | null {
  const e = ext(fileName);
  const m = (mime || '').toLowerCase();

  // PDF
  if (m === 'application/pdf' || e === 'pdf') {
    return { kind: 'pdf', base64: buffer.toString('base64') };
  }

  // Images
  if (e in IMAGE_MEDIA || m.startsWith('image/')) {
    const mediaType = IMAGE_MEDIA[e] || (m.startsWith('image/') ? m : 'image/png');
    return { kind: 'image', base64: buffer.toString('base64'), mediaType };
  }

  // Spreadsheets → flatten every sheet to CSV text
  if (
    e === 'xlsx' ||
    e === 'xls' ||
    m === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    m === 'application/vnd.ms-excel'
  ) {
    try {
      const wb = XLSX.read(buffer, { type: 'buffer' });
      const parts: string[] = [];
      for (const name of wb.SheetNames) {
        const sheet = wb.Sheets[name];
        const csv = XLSX.utils.sheet_to_csv(sheet);
        parts.push(`# Sheet: ${name}\n${csv}`);
      }
      return { kind: 'text', text: parts.join('\n\n') };
    } catch {
      return null;
    }
  }

  // CSV / TXT and other plain text
  if (e === 'csv' || e === 'txt' || m === 'text/csv' || m.startsWith('text/')) {
    return { kind: 'text', text: buffer.toString('utf8') };
  }

  return null;
}
