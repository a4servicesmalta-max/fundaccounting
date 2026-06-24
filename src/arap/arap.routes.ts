// AR/AP HTTP routes (CONTRACT §12(c)). Mounted by the controller at /api/aging
// (do NOT mount here). Express Router; multer v2 memory storage for uploads.

import * as path from 'path';
import * as crypto from 'crypto';
import { Router, type Request, type Response } from 'express';
import multer from 'multer';

import { insertItem, listItems, findDuplicate, updateItem, getItem } from './arap-store';
import { taxFlagsForArap } from '../core/tax-flags';
import { agingReport } from './aging';
import { arapItemToEur } from '../report/report';
import { resolveArApFxRate } from './arap-fx';
import { extractArAp } from '../ai/extract-arap';
import { insertDocument, type DocumentRecord } from '../db/store';
import { saveObject, uploadKey } from '../storage/objects';

// multer v2: memory storage; files arrive on req.files (array) as Buffers.
const upload = multer({ storage: multer.memoryStorage() });

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Pick a file extension from the original name, falling back to the mimetype. */
function extFor(file: { originalname?: string; mimetype?: string }): string {
  const fromName = file.originalname ? path.extname(file.originalname) : '';
  if (fromName) return fromName.replace(/^\./, '').toLowerCase();
  const mime = (file.mimetype || '').toLowerCase();
  if (mime.includes('pdf')) return 'pdf';
  if (mime.includes('png')) return 'png';
  if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg';
  if (mime.includes('csv')) return 'csv';
  if (mime.includes('text')) return 'txt';
  return 'bin';
}

/** Build the ExtractContent block (claude.ts shape) for a given upload buffer. */
function toContent(file: Express.Multer.File): {
  kind: 'text' | 'pdf' | 'image';
  text?: string;
  base64?: string;
  mediaType?: string;
} {
  const mime = (file.mimetype || '').toLowerCase();
  const ext = extFor(file);
  if (mime.includes('pdf') || ext === 'pdf') {
    return { kind: 'pdf', base64: file.buffer.toString('base64') };
  }
  if (mime.startsWith('image/') || ['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(ext)) {
    return {
      kind: 'image',
      base64: file.buffer.toString('base64'),
      mediaType: mime.startsWith('image/') ? mime : `image/${ext === 'jpg' ? 'jpeg' : ext}`,
    };
  }
  // CSV / TXT / anything else -> treat as text.
  return { kind: 'text', text: file.buffer.toString('utf8') };
}

export const arapRouter = Router();

// POST /upload — multipart files[]; save bytes, extract, insert OPEN item.
arapRouter.post('/upload', upload.array('files'), async (req: Request, res: Response) => {
  try {
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (files.length === 0) {
      res.status(400).json({ error: 'No files uploaded (expected multipart field "files").' });
      return;
    }

    const items: unknown[] = [];
    const duplicates: { fileName: string; counterparty: string; amount: number; currency: string }[] = [];
    const errors: { fileName: string; error: string }[] = [];

    for (const file of files) {
      const documentId = crypto.randomUUID();
      const ext = extFor(file);

      // Save the original bytes (local disk or Supabase Storage, by driver).
      const storedRel = await saveObject(
        uploadKey(documentId, ext),
        file.buffer,
        file.mimetype || 'application/octet-stream',
      );

      // Record the document.
      const doc: DocumentRecord = {
        id: documentId,
        fileName: file.originalname || `${documentId}.${ext}`,
        folderPath: '',
        mime: file.mimetype || 'application/octet-stream',
        storedPath: storedRel,
        classification: 'EVENT',
        note: null,
        createdAt: new Date().toISOString(),
      };
      insertDocument(doc);

      // Extract with the AI (transcription only).
      const result = await extractArAp({ fileName: doc.fileName, content: toContent(file) });
      if (!result.ok || !result.item) {
        errors.push({ fileName: doc.fileName, error: result.error || 'Could not read this document.' });
        continue;
      }

      const it = result.item;
      const dup = findDuplicate(it);
      if (dup) {
        duplicates.push({ fileName: doc.fileName, counterparty: dup.counterparty, amount: dup.amount, currency: dup.currency });
        continue;
      }
      const fx = await resolveArApFxRate(it.currency, it.issueDate ?? null, it.dueDate ?? null);
      const inserted = insertItem({
        documentId,
        kind: it.kind,
        counterparty: it.counterparty,
        amount: it.amount,
        currency: it.currency,
        issueDate: it.issueDate ?? null,
        dueDate: it.dueDate ?? null,
        status: 'OPEN',
        docName: doc.fileName,
        fxRate: fx.fxRate,
        fxRateDate: fx.fxRateDate,
      });
      items.push(inserted);
    }

    res.json({ added: items.length, items, duplicates, errors });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// GET / — aging report as at ?asOf (defaults to today).
arapRouter.get('/', (req: Request, res: Response) => {
  try {
    const asOf = (req.query.asOf as string) || todayISO();
    // Convert each item to EUR using the SAME converter the general ledger uses —
    // the exact-date ECB rate captured at intake (IAS 21 spot), so a foreign-currency
    // item is bucketed/totalled in EUR consistently with the GL and BS.
    res.json(agingReport(asOf, arapItemToEur));
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// GET /items?kind= — list AR/AP items (optionally filtered by kind).
arapRouter.get('/items', (req: Request, res: Response) => {
  try {
    const kindRaw = (req.query.kind as string | undefined)?.toUpperCase();
    const kind = kindRaw === 'RECEIVABLE' || kindRaw === 'PAYABLE' ? kindRaw : undefined;
    const items = listItems(kind).map((it) => ({
      ...it,
      taxFlags: taxFlagsForArap({ kind: it.kind, counterparty: it.counterparty, currency: it.currency }),
    }));
    res.json({ items });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// POST /items/:id — manually edit an invoice/bill's fields.
arapRouter.post('/items/:id', (req: Request, res: Response) => {
  if (!getItem(req.params.id)) {
    res.status(404).json({ error: 'Item not found.' });
    return;
  }
  const b = req.body ?? {};
  const updated = updateItem(req.params.id, {
    kind: b.kind,
    counterparty: typeof b.counterparty === 'string' ? b.counterparty : undefined,
    amount: b.amount,
    currency: typeof b.currency === 'string' ? b.currency : undefined,
    issueDate: b.issueDate,
    dueDate: b.dueDate,
    status: b.status,
  });
  res.json({ item: updated });
});
