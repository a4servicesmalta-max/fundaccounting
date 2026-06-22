// Split one uploaded PDF that bundles several distinct documents (different
// categories scanned into a single file) into per-document sub-PDFs, so each is
// classified and routed on its own. The AI proposes page-range segments; this
// module validates them conservatively (never over-split a single document) and
// performs the deterministic page split with pdf-lib.

import { PDFDocument } from 'pdf-lib';

export interface BundleSegment {
  category: string;
  title: string;
  pageStart: number; // 1-based, inclusive
  pageEnd: number; // 1-based, inclusive
}

/** Validate AI-proposed segments against the real page count. Returns a sorted,
 *  non-overlapping, in-bounds set ONLY when it genuinely looks like ≥2 documents;
 *  otherwise returns [] (the caller then processes the file as a single document).
 *  PURE. */
export function validateBundleSegments(
  raw: Array<Partial<BundleSegment>> | null | undefined,
  pageCount: number,
): BundleSegment[] {
  if (!Array.isArray(raw) || pageCount < 1) return [];

  const clean: BundleSegment[] = [];
  for (const r of raw) {
    const ps = Math.trunc(Number(r?.pageStart));
    const pe = Math.trunc(Number(r?.pageEnd));
    if (!Number.isFinite(ps) || !Number.isFinite(pe)) continue;
    if (ps < 1 || pe < ps || pe > pageCount) continue; // out of bounds / inverted
    clean.push({
      category: String(r?.category || '').trim() || 'unknown',
      title: String(r?.title || '').trim(),
      pageStart: ps,
      pageEnd: pe,
    });
  }

  clean.sort((a, b) => a.pageStart - b.pageStart);

  // Drop any segment that overlaps the previous accepted one.
  const nonOverlapping: BundleSegment[] = [];
  let lastEnd = 0;
  for (const s of clean) {
    if (s.pageStart <= lastEnd) continue;
    nonOverlapping.push(s);
    lastEnd = s.pageEnd;
  }

  // Only a bundle if at least two distinct documents survived.
  return nonOverlapping.length >= 2 ? nonOverlapping : [];
}

/** Page count of a PDF buffer (0 if it can't be parsed). */
export async function pdfPageCount(buffer: Buffer | Uint8Array): Promise<number> {
  try {
    const doc = await PDFDocument.load(buffer, { ignoreEncryption: true });
    return doc.getPageCount();
  } catch {
    return 0;
  }
}

/** Split a PDF into one sub-PDF buffer per validated segment (page ranges copied
 *  in order). Returns [] if the split fails. */
export async function splitPdfByPages(
  buffer: Buffer | Uint8Array,
  segments: BundleSegment[],
): Promise<Buffer[]> {
  try {
    const src = await PDFDocument.load(buffer, { ignoreEncryption: true });
    const total = src.getPageCount();
    const out: Buffer[] = [];
    for (const seg of segments) {
      const start = Math.max(1, seg.pageStart);
      const end = Math.min(total, seg.pageEnd);
      if (end < start) continue;
      const sub = await PDFDocument.create();
      const indices = [];
      for (let p = start; p <= end; p++) indices.push(p - 1); // 0-based
      const copied = await sub.copyPages(src, indices);
      copied.forEach((pg) => sub.addPage(pg));
      const bytes = await sub.save();
      out.push(Buffer.from(bytes));
    }
    return out;
  } catch {
    return [];
  }
}
