import 'dotenv/config';

import * as fs from 'fs';
import * as path from 'path';
import express, { type Request, type Response } from 'express';
import multer from 'multer';
import AdmZip from 'adm-zip';

import {
  initDb,
  loadDb,
  saveDb,
  counts,
  resetAll,
  getDraft,
  insertDraft,
  listDrafts,
  listPeriods,
  getSettings,
  setCurrentPeriod,
  getBooksOpeningDate,
  setBooksOpeningDate,
  getDocument,
  listDocuments,
  listPostedLines,
  listAudit,
  verifyAudit,
  listLockedPeriods,
} from './db/store';
import { ensureRatesSeeded } from './fx/rates';
import { readObject } from './storage/objects';
import { mountAuth } from './auth/gate';
import { listFullChart, ensureAccount, hydrateChartFromStore } from './core/chart-store';
import { isConfigured } from './ai/claude';
import { processFileWithBundles, reclassifyDocument, type ProcessOutcome } from './pipeline/process';
import { approveDraft, approveAll, rejectDraft, editDraft, reverseDraft, closePeriod, reopenPeriod, closeYear, reopenYear, isYearClosed } from './posting/post';
import { taxFlagsForDraft } from './core/tax-flags';
import { composeFairValueRemeasurement } from './core/fair-value';
import { portfolio, ledger, trialBalance, exportCsv, profitAndLoss, balanceSheet, navAllocation, ensureRevaluationRates } from './report/report';
import { buildFsReportHtml } from './report/fs-report';
import { bankRouter } from './bank/bank.routes';
import { arapRouter } from './arap/arap.routes';
import { loansRouter } from './loans/loans.routes';
import { openingRouter } from './opening/opening.routes';

const PORT = Number(process.env.PORT) || 4350;
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-4-8';

// --- Boot --------------------------------------------------------------------
// Storage driver: 'file' (local/CLI) loads the on-disk store once at boot;
// 'supabase' (serverless) loads the blob per-request via the middleware below.
const STORAGE_DRIVER = process.env.STORAGE_DRIVER === 'supabase' ? 'supabase' : 'file';

if (STORAGE_DRIVER !== 'supabase') {
  initDb();
  hydrateChartFromStore(); // load any custom accounts created in earlier sessions
  ensureRatesSeeded();
  try {
    fs.mkdirSync(path.resolve(process.cwd(), 'data', 'uploads'), { recursive: true });
  } catch {
    // ignore on read-only filesystems
  }
}

const app = express();
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: false })); // login form posts

// Shared-password gate (no-op unless APP_PASSWORD is set). Must precede static
// serving and the API routers so unauthenticated requests never reach them.
mountAuth(app);

app.use(express.static(path.resolve(process.cwd(), 'public')));

// Supabase request lifecycle: load the books blob before each API request and
// persist it after the handler runs, before the response socket closes. This
// keeps the synchronous in-memory store correct on serverless, where the
// filesystem is ephemeral and the process may be fresh on every request.
if (STORAGE_DRIVER === 'supabase') {
  app.use('/api', async (req: Request, res: Response, next) => {
    try {
      await loadDb();
      hydrateChartFromStore();
    } catch {
      return res.status(503).json({ error: 'Storage is temporarily unavailable. Please try again.' });
    }
    const origEnd = res.end.bind(res);
    let finishing = false;
    (res as unknown as { end: (...a: unknown[]) => unknown }).end = (...args: unknown[]) => {
      if (finishing) return (origEnd as (...a: unknown[]) => unknown)(...args);
      finishing = true;
      saveDb()
        .catch((e) => console.error('saveDb failed:', e))
        .finally(() => (origEnd as (...a: unknown[]) => unknown)(...args));
      return res;
    };
    next();
  });
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024, files: 200 },
});

// --- Health / status ---------------------------------------------------------
app.get('/api/health', (_req: Request, res: Response) => {
  res.json({ ok: true, aiConfigured: isConfigured(), model: MODEL });
});

app.get('/api/status', (_req: Request, res: Response) => {
  res.json({ counts: counts() });
});

// --- Periods (monthly periods + "start a new month") -------------------------
app.get('/api/periods', (_req: Request, res: Response) => {
  res.json({ periods: listPeriods(), current: getSettings().currentPeriod });
});

app.post('/api/period', (req: Request, res: Response) => {
  const period = (req.body?.period ?? '').toString();
  if (!/^\d{4}-\d{2}$/.test(period)) {
    return res.status(400).json({ error: 'Period must be in YYYY-MM format.' });
  }
  setCurrentPeriod(period);
  res.json({ current: period });
});

// --- Settings (engagement-level config) --------------------------------------
app.get('/api/settings', (_req: Request, res: Response) => {
  const s = getSettings();
  res.json({
    currentPeriod: s.currentPeriod,
    lockedPeriods: s.lockedPeriods ?? [],
    booksOpeningDate: getBooksOpeningDate(), // resolved (explicit or derived from opening balance)
    booksOpeningDateExplicit: s.booksOpeningDate ?? null,
    reportingEntity: process.env.REPORTING_ENTITY || null,
  });
});

app.post('/api/settings', (req: Request, res: Response) => {
  const raw = req.body?.booksOpeningDate;
  if (raw === null || raw === '') {
    setBooksOpeningDate(null);
    return res.json({ booksOpeningDate: getBooksOpeningDate() });
  }
  const date = String(raw);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Opening date must be in YYYY-MM-DD format.' });
  }
  setBooksOpeningDate(date);
  res.json({ booksOpeningDate: getBooksOpeningDate() });
});

// --- Upload ------------------------------------------------------------------
const ZIP_EXTS = /\.zip$/i;

app.post('/api/upload', upload.array('files'), async (req: Request, res: Response) => {
  try {
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded.' });
    }

    const outcomes: ProcessOutcome[] = [];

    for (const file of files) {
      const originalName = file.originalname;
      if (ZIP_EXTS.test(originalName)) {
        // Unzip and process each inner file, preserving its path as folderPath.
        try {
          const zip = new AdmZip(file.buffer);
          for (const entry of zip.getEntries()) {
            if (entry.isDirectory) continue;
            const entryPath = entry.entryName; // e.g. SHARES/DISPOSAL/GAMIVO/sale.pdf
            const fileName = path.basename(entryPath);
            const folderPath = path.dirname(entryPath);
            const buffer = entry.getData();
            const outs = await processFileWithBundles({
              fileName,
              folderPath: folderPath === '.' ? '' : folderPath,
              mime: '',
              buffer,
            });
            outcomes.push(...outs);
          }
        } catch (err) {
          outcomes.push({
            kind: 'ERROR',
            fileName: originalName,
            message: err instanceof Error ? `Could not read zip: ${err.message}` : 'Could not read zip',
          });
        }
        continue;
      }

      const outs = await processFileWithBundles({
        fileName: originalName,
        folderPath: '',
        mime: file.mimetype || '',
        buffer: file.buffer,
      });
      outcomes.push(...outs);
    }

    const events = outcomes.filter((o) => o.kind === 'EVENT');
    const evidence = outcomes.filter((o) => o.kind === 'EVIDENCE');
    const bank = outcomes.filter((o) => o.kind === 'BANK');
    const arap = outcomes.filter((o) => o.kind === 'ARAP');
    const duplicates = outcomes.filter((o) => o.kind === 'DUPLICATE');
    const unknown = outcomes.filter((o) => o.kind === 'UNKNOWN' || o.kind === 'SKIPPED');
    const errors = outcomes.filter((o) => o.kind === 'ERROR');

    res.json({
      processed: outcomes.length,
      events,
      evidence,
      bank,
      arap,
      duplicates,
      unknown,
      errors,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Upload failed.' });
  }
});

// --- Drafts ------------------------------------------------------------------
app.get('/api/drafts', (req: Request, res: Response) => {
  const status = req.query.status as string | undefined;
  if (status && !['PENDING', 'POSTED', 'REJECTED'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status filter.' });
  }
  const period = req.query.period as string | undefined;
  const drafts = listDrafts(status as any, period).map((d) => ({
    ...d,
    taxFlags: taxFlagsForDraft({ eventType: d.eventType, instrument: d.instrument }),
  }));
  res.json({ drafts });
});

app.get('/api/drafts/:id', (req: Request, res: Response) => {
  const draft = getDraft(req.params.id);
  if (!draft) return res.status(404).json({ error: 'Draft not found.' });
  res.json({ draft: { ...draft, taxFlags: taxFlagsForDraft({ eventType: draft.eventType, instrument: draft.instrument }) } });
});

app.post('/api/drafts/approve-all', (_req: Request, res: Response) => {
  const r = approveAll();
  res.json({ approved: r.approved, skipped: r.skipped });
});

app.post('/api/drafts/:id/approve', (req: Request, res: Response) => {
  try {
    const draft = approveDraft(req.params.id, (req.body?.actor as string) || 'reviewer');
    if (!draft) return res.status(404).json({ error: 'Draft not found.' });
    res.json({ draft });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Could not post draft.' });
  }
});

app.post('/api/drafts/:id/reject', (req: Request, res: Response) => {
  const ok = rejectDraft(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Draft not found.' });
  res.json({ ok: true });
});

// Inline edit of a still-pending draft (records a before/after audit entry).
app.post('/api/drafts/:id/edit', (req: Request, res: Response) => {
  try {
    const draft = editDraft(req.params.id, req.body ?? {}, (req.body?.actor as string) || 'reviewer');
    if (!draft) return res.status(404).json({ error: 'Draft not found.' });
    res.json({ draft });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Could not edit draft.' });
  }
});

// Reverse a posted entry (books an equal-and-opposite posted entry; never deletes).
app.post('/api/drafts/:id/reverse', (req: Request, res: Response) => {
  try {
    const reason = (req.body?.reason as string) || 'Correction';
    const reversal = reverseDraft(req.params.id, reason, (req.body?.actor as string) || 'reviewer');
    res.json({ reversal });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Could not reverse entry.' });
  }
});

// --- Audit trail -------------------------------------------------------------
app.get('/api/audit', (req: Request, res: Response) => {
  const entity = req.query.entity as string | undefined;
  const entityId = req.query.entityId as string | undefined;
  res.json({ entries: listAudit({ entity, entityId }), integrity: verifyAudit() });
});

// --- Period locks (close / reopen a period) ----------------------------------
app.get('/api/period-locks', (_req: Request, res: Response) => {
  res.json({ locked: listLockedPeriods() });
});

app.post('/api/period-locks', (req: Request, res: Response) => {
  const period = (req.body?.period ?? '').toString();
  if (!/^\d{4}-\d{2}$/.test(period)) {
    return res.status(400).json({ error: 'Period must be in YYYY-MM format.' });
  }
  const action = (req.body?.action ?? 'lock').toString();
  const actor = (req.body?.actor as string) || 'reviewer';
  const locked = action === 'unlock' ? reopenPeriod(period, actor) : closePeriod(period, actor);
  res.json({ locked });
});

// --- Year-end close (calendar fiscal year) -----------------------------------
function parseYear(raw: unknown): number | null {
  const y = Number(raw);
  return Number.isInteger(y) && y >= 2000 && y <= 2100 ? y : null;
}

app.get('/api/year/:year/status', (req: Request, res: Response) => {
  const year = parseYear(req.params.year);
  if (year === null) return res.status(400).json({ error: 'Year must be a 4-digit year.' });
  res.json({ year, closed: isYearClosed(year) });
});

app.post('/api/year/close', (req: Request, res: Response) => {
  const year = parseYear(req.body?.year);
  if (year === null) return res.status(400).json({ error: 'Year must be a 4-digit year.' });
  try {
    res.json(closeYear(year, (req.body?.actor as string) || 'reviewer'));
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Could not close the year.' });
  }
});

app.post('/api/year/reopen', (req: Request, res: Response) => {
  const year = parseYear(req.body?.year);
  if (year === null) return res.status(400).json({ error: 'Year must be a 4-digit year.' });
  try {
    res.json(reopenYear(year, (req.body?.actor as string) || 'reviewer'));
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Could not reopen the year.' });
  }
});

// --- Fair-value remeasurement (trap T7 / IFRS9 FVTPL) ------------------------
// The reviewer supplies the fair value; the engine computes a balanced
// remeasurement journal and files it as a PENDING draft for approval.
app.post('/api/investments/:controlCode/revalue', (req: Request, res: Response) => {
  try {
    const controlCode = req.params.controlCode;
    const fairValue = Number(req.body?.fairValue);
    if (!isFinite(fairValue)) return res.status(400).json({ error: 'A numeric fair value is required.' });
    const row = portfolio().rows.find((r) => r.controlCode === controlCode);
    if (!row) return res.status(404).json({ error: 'Holding not found in the portfolio.' });
    const rem = composeFairValueRemeasurement({
      controlCode,
      investeeName: row.investeeName,
      carrying: row.carryingValue,
      fairValue,
    });
    if (rem.direction === 'NONE') {
      return res.status(400).json({ error: 'Fair value equals the carrying amount — nothing to remeasure.' });
    }
    const now = new Date().toISOString();
    const date = (req.body?.date as string) || now.slice(0, 10);
    const source = (req.body?.source as string) || 'Reviewer-supplied fair value';
    insertDraft({
      id: '',
      documentId: null,
      investeeName: row.investeeName,
      instrument: row.instrument,
      eventType: 'FV_REMEAS',
      controlCode,
      currency: 'EUR',
      txnDate: date,
      period: date.slice(0, 7),
      status: 'PENDING',
      sourceFigures: { amount: fairValue, quantity: null, fairValue, currency: 'EUR' },
      engineFigures: {
        functionalAmount: rem.movement, currency: 'EUR', lineCount: rem.lines.length,
        fxRate: null, fxRateDate: null, originalCurrency: 'EUR', originalAmount: rem.movement,
      },
      lines: rem.lines,
      confidence: 1,
      citation: source,
      rationale: `Fair-value remeasurement (IFRS 9 FVTPL): carrying ${rem.carrying.toFixed(2)} → fair value ${rem.fairValue.toFixed(2)} = ${rem.movement >= 0 ? 'gain' : 'loss'} ${Math.abs(rem.movement).toFixed(2)} to P&L (710).`,
      docName: null,
      createdAt: now,
      postedAt: null,
    });
    res.json({ ok: true, movement: rem.movement, direction: rem.direction });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Revaluation failed.' });
  }
});

// --- Reports -----------------------------------------------------------------
app.get('/api/report/portfolio', async (req: Request, res: Response) => {
  try {
    const period = req.query.period as string | undefined;
    await ensureRevaluationRates(period); // warm the period-end ECB closing rate
    res.json(portfolio(period));
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Report failed.' });
  }
});

app.get('/api/report/ledger', (req: Request, res: Response) => {
  res.json(ledger(req.query.period as string | undefined));
});

app.get('/api/report/trial-balance', (req: Request, res: Response) => {
  try {
    res.json(trialBalance(req.query.period as string | undefined));
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Report failed.' });
  }
});

app.get('/api/report/pnl', (req: Request, res: Response) => {
  try {
    res.json(profitAndLoss(req.query.period as string | undefined));
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Report failed.' });
  }
});

app.get('/api/report/balance-sheet', (req: Request, res: Response) => {
  try {
    res.json(balanceSheet(req.query.period as string | undefined));
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Report failed.' });
  }
});

// Printable financial-statements pack (HTML the user prints to PDF).
app.get('/api/report/fs', async (req: Request, res: Response) => {
  try {
    const period = req.query.period as string | undefined;
    const entity = typeof req.query.entity === 'string' && req.query.entity ? req.query.entity : undefined;
    await ensureRevaluationRates(period); // warm the period-end ECB closing rate for the notes
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(buildFsReportHtml(period, entity));
  } catch (err) {
    res.status(500).send('Could not build the report.');
  }
});

// --- CSV export --------------------------------------------------------------
app.get('/api/export/:type', async (req: Request, res: Response) => {
  const type = req.params.type;
  if (type !== 'portfolio' && type !== 'ledger' && type !== 'trial-balance') {
    return res.status(400).json({ error: 'Unknown export type.' });
  }
  try {
    const period = req.query.period as string | undefined;
    if (type === 'portfolio') await ensureRevaluationRates(period); // period-end ECB closing rate
    const csv = exportCsv(type, period);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${type}.csv"`);
    res.send(csv);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Export failed.' });
  }
});

// --- Document preview --------------------------------------------------------
const EXT_CONTENT_TYPE: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  csv: 'text/csv; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
};

app.get('/api/documents/:id/file', async (req: Request, res: Response) => {
  const doc = getDocument(req.params.id);
  if (!doc || !doc.storedPath) {
    return res.status(404).json({ error: 'Document file not found.' });
  }
  let buffer: Buffer;
  try {
    buffer = await readObject(doc.storedPath);
  } catch {
    return res.status(404).json({ error: 'Document file not found.' });
  }
  const ext = path.extname(doc.storedPath).toLowerCase().replace(/^\./, '');
  const contentType = EXT_CONTENT_TYPE[ext] || doc.mime || 'application/octet-stream';
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Disposition', `inline; filename="${doc.fileName.replace(/"/g, '')}"`);
  res.end(buffer);
});

// Reclassify a "needs a look" document: the reviewer chooses what to do with it.
app.post('/api/documents/:id/reclassify', async (req: Request, res: Response) => {
  const action = (req.body?.action ?? '').toString();
  const valid = ['supporting', 'bank', 'invoice', 'journal', 'event'];
  if (!valid.includes(action)) {
    return res.status(400).json({ error: `action must be one of: ${valid.join(', ')}.` });
  }
  try {
    const outcome = await reclassifyDocument(req.params.id, action as any);
    res.json({ outcome });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Reclassify failed.' });
  }
});

// --- Reset -------------------------------------------------------------------
app.post('/api/reset', (_req: Request, res: Response) => {
  resetAll();
  res.json({ ok: true });
});

// --- Documents list ----------------------------------------------------------
app.get('/api/documents', (_req: Request, res: Response) => {
  res.json({ documents: listDocuments() });
});

// --- Overview dashboard aggregation (figures from the store, never fabricated) ---
app.get('/api/overview', async (_req: Request, res: Response) => {
  try {
    await ensureRevaluationRates(); // warm the closing ECB rate so NAV/holdings revalue at it
    const c = counts();
    const pf = portfolio();
    const r2 = (n: number) => Math.round((n || 0) * 100) / 100;

    // Equity investments (030) and loans granted (032) are kept SEPARATE
    // throughout — they are different instruments and must never be lumped. Equity
    // is shown at valuation (closing-FX revaluation); loans at carrying amount.
    const isLoan = (code: string) => /^032/.test(code || '');
    const equityRows = pf.rows.filter((r: { controlCode: string }) => !isLoan(r.controlCode));
    const loanRows = pf.rows.filter((r: { controlCode: string }) => isLoan(r.controlCode));
    const valOf = (r: { carryingValue: number; revaluedValue?: number }) =>
      r.revaluedValue != null ? r.revaluedValue : (r.carryingValue || 0);

    const equityCost = r2(equityRows.reduce((s, r) => s + (r.carryingValue || 0), 0));
    const equityValuation = r2(equityRows.reduce((s, r) => s + valOf(r), 0));
    const loansValue = r2(loanRows.reduce((s, r) => s + (r.carryingValue || 0), 0));
    const fairValueMovement = r2(equityValuation - equityCost); // FV movement applies to equity only

    // Net asset value, with equity (at valuation) and loans shown as components.
    const portfolioCost = r2(equityCost + loansValue);
    const portfolioFairValue = r2(equityValuation + loansValue);
    const nav = portfolioFairValue;

    // Cash in EUR: net balance of bank/cash asset accounts across the WHOLE general
    // ledger — opening balances + posted drafts + bank-statement movements + AR/AP
    // settlements. Using only listPostedLines() here missed every bank deposit and
    // withdrawal (those GL lines are synthesized by the report layer, not stored as
    // draft lines), so dashboard cash never moved with the statements. The cash-code
    // match is anchored to actual cash/bank accounts (no longer the stray 20x range,
    // which is the liabilities band).
    const cashEur =
      Math.round(
        ledger('all').lines
          .filter((l) => /^(1010|1011|101|130|10[0-9]?0)$/.test(l.accountCode) || /bank|cash/i.test(l.accountName || ''))
          .reduce((s, l) => s + (l.amount || 0), 0) * 100,
      ) / 100;

    // Net profit for the year (management P&L).
    let netProfit = 0;
    try {
      netProfit = Math.round((profitAndLoss().netProfit || 0) * 100) / 100;
    } catch {
      netProfit = 0;
    }

    // Holdings: each posted position (top by value), friendly kind from control code.
    const holdings = [...pf.rows]
      .sort((a: { carryingValue: number }, b: { carryingValue: number }) => b.carryingValue - a.carryingValue)
      .slice(0, 6)
      .map((r: { investeeName: string; instrument: string; controlCode: string; currency: string; carryingValue: number; revaluedValue?: number }) => ({
        name: r.investeeName,
        kind: r.controlCode.startsWith('032') || r.instrument === 'LOAN' ? 'LOAN' : 'EQUITY',
        sub: r.controlCode.startsWith('032') || r.instrument === 'LOAN' ? 'Loan granted' : 'Shares held',
        currency: r.currency,
        value: Math.round(r.carryingValue * 100) / 100,
        revalued: r.revaluedValue != null ? Math.round(r.revaluedValue * 100) / 100 : null,
      }));

    // Allocation: each position as a % of NAV. The NAV denominator carries equity at
    // valuation (revalued) and loans at carrying, so the numerator must use the same
    // basis — equity revalued, loans at carrying — otherwise the percentages don't sum
    // to ~100 once a foreign loan's revalued figure is populated. (See navAllocation.)
    const allocation = navAllocation(holdings, nav);

    // Recent documents: latest drafts, newest first.
    const recentDocuments = [...listDrafts()]
      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
      .slice(0, 6)
      .map((d) => ({
        docName: d.docName || '(document)',
        investee: d.investeeName || '—',
        date: d.txnDate,
        status: d.status,
        amount: Math.round(((d.engineFigures && d.engineFigures.functionalAmount) || 0) * 100) / 100,
      }));

    // NAV series: investments (030) + loans (032) carried as-at the END of every
    // period that has any posted activity — so the trend spans the whole book
    // history, not only the periods where a holding happened to change. (The old
    // version only emitted a point when 030/032 moved, so opening-only books gave
    // a single point and the chart showed "not enough history".)
    const allLines = listPostedLines();
    const isInvest = (code: string) => code.startsWith('030') || code.startsWith('032');
    // Imported opening balances are the brought-forward baseline — present in every
    // period regardless of the date they were tagged with — so the NAV trend starts
    // at that baseline and moves with subsequent transactions.
    const openingNav = r2(allLines.filter((l) => isInvest(l.accountCode) && l.eventType === 'OPENING').reduce((s, l) => s + l.amount, 0));
    const movePeriods = [...new Set(allLines.filter((l) => l.eventType !== 'OPENING').map((l) => l.period).filter(Boolean))].sort();
    let navSeries = movePeriods.map((p) => ({
      period: p,
      value: r2(openingNav + allLines.filter((l) => isInvest(l.accountCode) && l.eventType !== 'OPENING' && l.period <= p).reduce((s, l) => s + l.amount, 0)),
    }));
    // Guarantee the chart can draw whenever there are holdings (≥2 points): a book
    // with only the opening position still renders a flat NAV line.
    const navNow = r2(openingNav + allLines.filter((l) => isInvest(l.accountCode) && l.eventType !== 'OPENING').reduce((s, l) => s + l.amount, 0));
    if (navSeries.length < 2 && navNow !== 0) {
      navSeries = [
        { period: 'opening', value: openingNav || navNow },
        { period: getSettings().currentPeriod || 'current', value: navNow },
      ];
    }

    res.json({
      kpis: {
        documentsProcessed: c.documents,
        netAssetValue: Math.round(nav * 100) / 100,
        draftsToReview: c.pending,
        postedEntries: c.posted,
        // Equity (030) and loans (032) kept SEPARATE throughout.
        equityCost,
        equityValuation,
        loansValue,
        portfolioCost,
        portfolioFairValue,
        fairValueMovement,
        cashEur,
        netProfit,
      },
      holdings,
      allocation,
      recentDocuments,
      navSeries,
    });
  } catch (err) {
    res.status(500).json({ error: 'Could not build the overview.' });
  }
});

// --- Chart of accounts (dynamic: grows as accounts are referenced) -----------
app.get('/api/chart', (_req: Request, res: Response) => {
  res.json({ accounts: listFullChart() });
});

app.post('/api/chart', (req: Request, res: Response) => {
  const code = typeof req.body?.code === 'string' ? req.body.code.trim() : '';
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  const type = typeof req.body?.type === 'string' ? req.body.type : undefined;
  if (!code) return res.status(400).json({ error: 'An account code is required.' });
  const account = ensureAccount(code, name, type as any);
  res.json({ account, accounts: listFullChart() });
});

// --- Section routers (v0.3): bank statements, aging, loans -------------------
app.use('/api/bank', bankRouter);
app.use('/api/aging', arapRouter);
app.use('/api/loans', loansRouter);
app.use('/api/opening', openingRouter);

// --- Listen ------------------------------------------------------------------
// Bind a port only when run directly (npm start / tsx src/server.ts). When this
// module is imported by the Vercel serverless entrypoint, we export `app`
// instead and never listen.
if (require.main === module && !process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`Open http://localhost:${PORT} in your browser`);
  });
}

export { app };
