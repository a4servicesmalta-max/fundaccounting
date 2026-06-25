// Bank section HTTP routes (CONTRACT §12(b)). Exported as `bankRouter`; the
// controller mounts it at /api/bank (we do NOT mount it here).

import * as path from 'path';
import * as crypto from 'crypto';
import { Router, type Request, type Response } from 'express';
import multer from 'multer';

import { saveObject, uploadKey, readObject } from '../storage/objects';
import { extractBankStatement } from '../ai/extract-bank';
import { ingestStatement, type ExtractedBankStatement } from './ingest';
import {
  listAccounts,
  listStatements,
  listTransactions,
  getTransaction,
  setTransactionPostTo,
  setTransactionStatus,
  setTransactionSplits,
  fixTransactionDate,
  isHighConfidenceBankTxn,
  getStatement,
} from './bank-store';
import { checkDate } from '../core/date-validate';
import { reconcileAccount } from './reconcile';
import { accountName } from '../core/chart';
import { ensureAccount, listFullChart } from '../core/chart-store';
import { classifyBankDescriptions } from '../ai/classify-bank';
import { rematchAll } from './settle';
import { getDailyRateToEur } from '../fx/daily';
import { setFxRate } from '../db/store';
import type { ExtractContent } from '../ai/claude';

const upload = multer({ storage: multer.memoryStorage() });

export const bankRouter: Router = Router();

// --- helpers ----------------------------------------------------------------

function extFor(fileName: string, mime: string): string {
  const fromName = path.extname(fileName || '').replace(/^\./, '').toLowerCase();
  if (fromName) return fromName;
  const map: Record<string, string> = {
    'application/pdf': 'pdf',
    'text/csv': 'csv',
    'text/plain': 'txt',
    'image/png': 'png',
    'image/jpeg': 'jpg',
  };
  return map[mime] || 'bin';
}

/** Build the AI ExtractContent from raw bytes (PDF/image as base64, else text). */
function toContent(mime: string, fileName: string, buffer: Buffer): ExtractContent {
  const lower = (fileName || '').toLowerCase();
  if (mime === 'application/pdf' || lower.endsWith('.pdf')) {
    return { kind: 'pdf', base64: buffer.toString('base64') };
  }
  if (mime.startsWith('image/')) {
    return { kind: 'image', base64: buffer.toString('base64'), mediaType: mime };
  }
  return { kind: 'text', text: buffer.toString('utf8') };
}

// --- POST /upload -----------------------------------------------------------

bankRouter.post(
  '/upload',
  upload.array('files'),
  async (req: Request, res: Response) => {
    try {
      const files = (req.files as Express.Multer.File[]) || [];
      if (files.length === 0) {
        return res.status(400).json({ error: 'No files uploaded.' });
      }

      const results: any[] = [];
      let statementsRead = 0;
      let totalAdded = 0;
      const allSkippedMonths: string[] = [];

      for (const file of files) {
        const id = crypto.randomUUID();
        const ext = extFor(file.originalname, file.mimetype);

        let extractResult;
        let storedPath = '';
        try {
          storedPath = await saveObject(
            uploadKey(id, ext),
            file.buffer,
            file.mimetype || 'application/octet-stream',
          );
          const content = toContent(file.mimetype, file.originalname, file.buffer);
          extractResult = await extractBankStatement({
            fileName: file.originalname,
            content,
          });
        } catch (err) {
          results.push({
            fileName: file.originalname,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
          continue;
        }

        if (!extractResult.ok || !extractResult.statements || !extractResult.statements.length) {
          results.push({
            fileName: file.originalname,
            ok: false,
            error: extractResult.error || 'Could not read this statement.',
          });
          continue;
        }

        // One file can carry several accounts (e.g. EUR + PLN) — ingest each.
        for (const statement of extractResult.statements) {
          const extracted: ExtractedBankStatement = {
            ...statement,
            fileName: file.originalname,
            storedPath,
          };
          const ingest = ingestStatement(extracted);
          statementsRead++;
          totalAdded += ingest.added;
          for (const m of ingest.skippedMonths) {
            if (!allSkippedMonths.includes(m)) allSkippedMonths.push(m);
          }
          results.push({ fileName: file.originalname, ok: true, currency: statement.currency, accountRef: statement.accountRef, ...ingest });
        }
      }

      allSkippedMonths.sort();

      return res.json({
        statementsRead,
        added: totalAdded,
        skippedMonths: allSkippedMonths,
        results,
      });
    } catch (err) {
      return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  },
);

// --- reads ------------------------------------------------------------------

bankRouter.get('/accounts', (_req: Request, res: Response) => {
  res.json({ accounts: listAccounts() });
});

bankRouter.get('/statements', (req: Request, res: Response) => {
  const accountId = typeof req.query.accountId === 'string' ? req.query.accountId : undefined;
  res.json({ statements: listStatements(accountId) });
});

bankRouter.get('/transactions', (req: Request, res: Response) => {
  const accountId = typeof req.query.accountId === 'string' ? req.query.accountId : undefined;
  const period = typeof req.query.period === 'string' ? req.query.period : undefined;
  const status =
    typeof req.query.status === 'string'
      ? (req.query.status as 'AUTO' | 'REVIEW' | 'POSTED' | 'REJECTED')
      : undefined;
  res.json({ transactions: listTransactions({ accountId, period, status }) });
});

// Serve a bank statement's original file (evidence for the bank lines it produced).
const STMT_CT: Record<string, string> = { pdf: 'application/pdf', csv: 'text/csv', txt: 'text/plain', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg' };
bankRouter.get('/statements/:id/file', async (req: Request, res: Response) => {
  const s = getStatement(req.params.id);
  if (!s || !s.storedPath) return res.status(404).json({ error: 'Statement file not found.' });
  try {
    const bytes = await readObject(s.storedPath);
    const ext = path.extname(s.storedPath).toLowerCase().replace(/^\./, '');
    res.setHeader('Content-Type', STMT_CT[ext] || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${(s.fileName || 'statement').replace(/"/g, '')}"`);
    res.end(bytes);
  } catch {
    res.status(404).json({ error: 'Statement file not found.' });
  }
});

// --- mutations --------------------------------------------------------------

bankRouter.post('/transactions/:id/post-to', (req: Request, res: Response) => {
  const txn = getTransaction(req.params.id);
  if (!txn) return res.status(404).json({ error: 'Transaction not found.' });
  const code = req.body?.code;
  if (!code || typeof code !== 'string') {
    return res.status(400).json({ error: 'A "code" is required.' });
  }
  // Posting to an account that isn't in the chart yet creates it (with an
  // optional name the caller supplies) rather than failing.
  const name = typeof req.body?.name === 'string' ? req.body.name : undefined;
  const account = ensureAccount(code, name);
  setTransactionPostTo(txn.id, code, account.name || accountName(code));
  if (txn.status === 'AUTO' || txn.status === 'REVIEW') {
    setTransactionStatus(txn.id, 'POSTED');
  }
  return res.json({ transaction: getTransaction(txn.id) });
});

// Bulk-approve every high-confidence (AUTO, real account, no date flag) transaction —
// optionally scoped to an account/period. Low-confidence (REVIEW / 9999 / unset) lines
// are left for the reviewer.
bankRouter.post('/transactions/approve-all', (req: Request, res: Response) => {
  const accountId = typeof req.body?.accountId === 'string' ? req.body.accountId : undefined;
  const period = typeof req.body?.period === 'string' && req.body.period !== 'all' ? req.body.period : undefined;
  const candidates = listTransactions({ accountId, period, status: 'AUTO' });
  let approved = 0;
  let skipped = 0;
  for (const t of candidates) {
    if (isHighConfidenceBankTxn(t)) {
      setTransactionStatus(t.id, 'POSTED');
      approved += 1;
    } else {
      skipped += 1;
    }
  }
  return res.json({ approved, skipped });
});

bankRouter.post('/transactions/:id/approve', (req: Request, res: Response) => {
  const txn = getTransaction(req.params.id);
  if (!txn) return res.status(404).json({ error: 'Transaction not found.' });
  setTransactionStatus(txn.id, 'POSTED');
  return res.json({ transaction: getTransaction(txn.id) });
});

bankRouter.post('/transactions/:id/reject', (req: Request, res: Response) => {
  const txn = getTransaction(req.params.id);
  if (!txn) return res.status(404).json({ error: 'Transaction not found.' });
  setTransactionStatus(txn.id, 'REJECTED');
  return res.json({ transaction: getTransaction(txn.id) });
});

// Re-match unmatched bank lines against open invoices/bills (settles debtors/creditors).
bankRouter.post('/rematch', (_req: Request, res: Response) => {
  return res.json(rematchAll());
});

// Split one bank line across multiple accounts (e.g. principal + interest).
bankRouter.post('/transactions/:id/split', (req: Request, res: Response) => {
  const txn = getTransaction(req.params.id);
  if (!txn) return res.status(404).json({ error: 'Transaction not found.' });
  const allocations = Array.isArray(req.body?.allocations) ? req.body.allocations : [];
  if (allocations.length < 2) {
    return res.status(400).json({ error: 'Provide at least two allocations to split a line.' });
  }
  const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
  const sum = round2(allocations.reduce((a: number, x: any) => a + (Number(x.amount) || 0), 0));
  if (Math.abs(sum - txn.amount) >= 0.01) {
    return res.status(400).json({ error: `The split must add up to ${txn.amount} (currently ${sum}).` });
  }
  const splits = allocations.map((a: any) => {
    const acct = ensureAccount(a.code, a.name);
    return { accountCode: acct.code, accountName: acct.name, amount: round2(Number(a.amount) || 0) };
  });
  setTransactionSplits(txn.id, splits);
  return res.json({ transaction: getTransaction(txn.id) });
});

// Trap T10: GL-vs-bank reconciliation for one account — ties the statement
// closing balance to the posted GL balance and lists reconciling items.
bankRouter.get('/reconcile', (req: Request, res: Response) => {
  const accountId = (req.query.accountId ?? '').toString();
  if (!accountId) return res.status(400).json({ error: 'accountId is required.' });
  const account = listAccounts().find((a) => a.id === accountId);
  if (!account) return res.status(404).json({ error: 'Bank account not found.' });
  const txns = listTransactions({ accountId }) as any[];
  const statements = listStatements(accountId) as any[];
  const recon = reconcileAccount(txns, statements);
  return res.json({ account: { id: account.id, bankName: account.bankName, currency: account.currency }, reconciliation: recon });
});

// Trap T2: correct a flagged impossible date (no silent coercion).
bankRouter.post('/transactions/:id/fix-date', (req: Request, res: Response) => {
  const txn = getTransaction(req.params.id);
  if (!txn) return res.status(404).json({ error: 'Transaction not found.' });
  const newDate = (req.body?.date ?? '').toString().trim();
  const check = checkDate(newDate);
  if (!check.ok) {
    return res.status(400).json({ error: check.reason || 'Please provide a valid YYYY-MM-DD date.' });
  }
  if (!fixTransactionDate(txn.id, newDate)) {
    return res.status(400).json({ error: 'Could not apply that date.' });
  }
  return res.json({ transaction: getTransaction(txn.id) });
});

// --- Interactive classification guide ---------------------------------------

/** A normalised "signature" for a description so recurring lines group together
 *  (strips digits, dates, diacritics, punctuation). */
function signatureOf(desc: string): string {
  return (desc || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ł/g, 'l') // Polish ł
    .replace(/[0-9]/g, ' ')
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Transactions still needing a real account (REVIEW, or sitting in suspense). */
function unclassifiedFor(accountId: string) {
  return listTransactions({ accountId }).filter(
    (t) => t.status === 'REVIEW' || t.postToCode === '9999' || !t.postToCode,
  );
}

// Ask the AI what the unknown transactions are, grouped by recurring pattern.
bankRouter.post('/classify-suggest', async (req: Request, res: Response) => {
  const accountId = req.body?.accountId;
  if (!accountId || typeof accountId !== 'string') {
    return res.status(400).json({ error: 'An accountId is required.' });
  }
  const txns = unclassifiedFor(accountId);
  if (!txns.length) return res.json({ groups: [] });

  // Group by signature.
  const groups = new Map<string, { signature: string; sample: string; count: number }>();
  for (const t of txns) {
    const sig = signatureOf(t.description);
    const g = groups.get(sig) || { signature: sig, sample: t.description, count: 0 };
    g.count += 1;
    groups.set(sig, g);
  }
  const distinct = [...groups.values()].sort((a, b) => b.count - a.count).slice(0, 40);

  const chart = listFullChart().map((a) => ({ code: a.code, name: a.name }));
  const ai = await classifyBankDescriptions({ descriptions: distinct.map((d) => d.sample), chart });
  const suggestions = ai.ok && ai.suggestions ? ai.suggestions : [];

  const out = distinct.map((d, i) => {
    const match =
      suggestions.find((s) => signatureOf(s.pattern) === d.signature) ||
      suggestions.find((s) => s.pattern === d.sample) ||
      suggestions[i] ||
      null;
    return {
      signature: d.signature,
      sample: d.sample,
      count: d.count,
      suggestedCode: match ? match.accountCode : '',
      suggestedName: match ? match.accountName : '',
      isNewAccount: match ? !!match.isNewAccount : false,
      confidence: match ? match.confidence : 0,
      rationale: match ? match.rationale : '',
    };
  });
  return res.json({ groups: out, aiOk: ai.ok, aiError: ai.error });
});

// Apply a chosen account to EVERY transaction matching a signature.
bankRouter.post('/classify-apply', (req: Request, res: Response) => {
  const accountId = req.body?.accountId;
  const signature = req.body?.signature;
  const code = req.body?.code;
  const name = typeof req.body?.name === 'string' ? req.body.name : undefined;
  if (!accountId || typeof signature !== 'string' || !code || typeof code !== 'string') {
    return res.status(400).json({ error: 'accountId, signature and code are required.' });
  }
  const account = ensureAccount(code, name);
  const txns = listTransactions({ accountId }).filter(
    (t) => signatureOf(t.description) === signature && t.status !== 'POSTED',
  );
  for (const t of txns) {
    setTransactionPostTo(t.id, account.code, account.name);
    setTransactionStatus(t.id, 'POSTED');
  }
  return res.json({ applied: txns.length, account });
});

// --- EUR conversion (daily FX) for non-EUR accounts -------------------------

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Bulk-fetch ECB daily rates (foreign→EUR) for a date range in one call; caches
 *  each into the store. Returns a Map<YYYY-MM-DD, rate> or null on failure. */
async function ratesForRange(currency: string, start: string, end: string): Promise<Map<string, number> | null> {
  const cur = currency.toUpperCase();
  try {
    const url = `https://api.frankfurter.app/${start}..${end}?from=${encodeURIComponent(cur)}&to=EUR`;
    const r = await fetch(url);
    if (!r.ok) return null;
    const j: any = await r.json();
    const map = new Map<string, number>();
    for (const [d, obj] of Object.entries(j.rates || {})) {
      const rate = obj && (obj as any).EUR;
      if (typeof rate === 'number') {
        map.set(d, rate);
        setFxRate(`${cur}:${d}`, rate);
      }
    }
    return map.size ? map : null;
  } catch {
    return null;
  }
}

function rateOnOrBefore(map: Map<string, number>, date: string): number | null {
  if (map.has(date)) return map.get(date)!;
  const keys = [...map.keys()].sort();
  let best: number | null = null;
  for (const k of keys) {
    if (k <= date) best = map.get(k)!;
    else break;
  }
  return best ?? (keys.length ? map.get(keys[0])! : null);
}

bankRouter.get('/fx', async (req: Request, res: Response) => {
  const accountId = typeof req.query.accountId === 'string' ? req.query.accountId : undefined;
  const acc = listAccounts().find((a) => a.id === accountId);
  if (!acc) return res.status(404).json({ error: 'Account not found.' });
  const cur = (acc.currency || 'EUR').toUpperCase();
  if (cur === 'EUR') return res.json({ currency: 'EUR', needed: false, lines: [], totals: { inEur: 0, outEur: 0, netEur: 0 } });

  const txns = listTransactions({ accountId }).slice().sort((a, b) => String(a.date).localeCompare(String(b.date)));
  if (!txns.length) return res.json({ currency: cur, needed: true, lines: [], totals: { inEur: 0, outEur: 0, netEur: 0 } });

  const dates = txns.map((t) => t.date).filter(Boolean).sort();
  const map = await ratesForRange(cur, dates[0], dates[dates.length - 1]);

  async function rateFor(date: string): Promise<{ rate: number; source: string; rateDate: string }> {
    let rate: number | null = map ? rateOnOrBefore(map, date) : null;
    if (rate != null) return { rate, source: 'live', rateDate: date };
    const d = await getDailyRateToEur(cur, date);
    return { rate: d.rate, source: d.source, rateDate: d.rateDate };
  }

  const lines: any[] = [];
  let inEur = 0;
  let outEur = 0;
  for (const t of txns) {
    const r = await rateFor(t.date);
    const eur = round2(t.amount * r.rate);
    const balanceEur = t.balance == null || !isFinite(Number(t.balance)) ? null : round2(Number(t.balance) * r.rate);
    if (t.amount >= 0) inEur = round2(inEur + eur);
    else outEur = round2(outEur + eur);
    lines.push({ id: t.id, date: t.date, amount: t.amount, eur, balanceEur, rate: r.rate, rateDate: r.rateDate, source: r.source });
  }

  // Opening/closing balances converted at the statement's period boundaries.
  const stmts = listStatements(accountId).slice().sort((a, b) => String(a.periodStart).localeCompare(String(b.periodStart)));
  let openingEur: number | null = null;
  let closingEur: number | null = null;
  if (stmts.length) {
    const first = stmts[0];
    const last = stmts[stmts.length - 1];
    const orate = await rateFor(first.periodStart);
    const crate = await rateFor(last.periodEnd);
    openingEur = round2(Number(first.openingBalance) * orate.rate);
    closingEur = round2(Number(last.closingBalance) * crate.rate);
  }

  return res.json({
    currency: cur,
    needed: true,
    lines,
    openingEur,
    closingEur,
    totals: { inEur: round2(inEur), outEur: round2(outEur), netEur: round2(inEur + outEur) },
  });
});
