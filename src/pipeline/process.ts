// Per-file pipeline (CONTRACT §7): bytes → Claude intent → DocumentRecord → (EVENT) Draft.
// One bad file must never crash a batch — everything is wrapped in try/catch.

import * as crypto from 'crypto';
import * as path from 'path';

import { saveObject, readObject, uploadKey } from '../storage/objects';

import { controlCodeFor } from '../core/chart';
import { ensureAccount } from '../core/chart-store';
import { composeDraft } from '../core/compose';
import type { FundAccountRefs } from '../core/types';
import type { IntakeIntent } from '../core/intake-schema';
import {
  insertDocument,
  insertDraft,
  updateDocument,
  getDocument,
  getSettings,
  getBooksOpeningDate,
  listInvesteeNames,
  listInvestees,
  type DocumentRecord,
  type DraftRecord,
} from '../db/store';
import { extractIntent, extractErrorMessage, type ExtractErrorKind, type ExtractContent } from '../ai/claude';
import { extractBankStatement } from '../ai/extract-bank';
import { ingestStatement } from '../bank/ingest';
import { extractArAp } from '../ai/extract-arap';
import { insertItem, findDuplicate } from '../arap/arap-store';
import { rematchAll } from '../bank/settle';
import { suggestJournal } from '../ai/suggest-journal';
import { listFullChart } from '../core/chart-store';
import { getDailyRateToEur } from '../fx/daily';
import { functionalFromEurPerUnit } from '../fx/functional';
import { accountName } from '../core/chart';
import { resolveToStandardAccount } from '../core/account-resolver';
import { loadRates } from '../fx/rates';
import { toContent } from './extract-content';
import { detectBundle } from '../ai/detect-bundle';
import { validateBundleSegments, pdfPageCount, splitPdfByPages } from './bundle';
import { carryingValueFor, disposalCarryingCost, unitsHeldFor, assessDisposalCarrying } from '../report/positions';
import { checkDate } from '../core/date-validate';
import { matchInvestee, findExistingHolding } from '../core/investee-match';


/** Map a mime type to a file extension (fallback for files with no extension). */
const MIME_EXT: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'text/csv': 'csv',
  'text/plain': 'txt',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-excel': 'xls',
};

/** Save the original uploaded bytes (local disk or Supabase Storage, by driver).
 *  Returns the stored key for `storedPath` (or null if saving failed). */
async function saveOriginalBytes(documentId: string, fileName: string, mime: string, buffer: Buffer): Promise<string | null> {
  try {
    let ext = path.extname(fileName).toLowerCase().replace(/^\./, '');
    if (!ext) ext = MIME_EXT[(mime || '').toLowerCase()] || 'bin';
    return await saveObject(uploadKey(documentId, ext), buffer, mime);
  } catch {
    return null;
  }
}

/** Period (YYYY-MM) from a transaction date, falling back to the current period. */
function periodFor(txnDate: string | undefined): string {
  if (txnDate && /^\d{4}-\d{2}/.test(txnDate)) return txnDate.slice(0, 7);
  return getSettings().currentPeriod ?? new Date().toISOString().slice(0, 7);
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Ask the AI to SUGGEST a balanced journal entry for a document that isn't a
 * bank statement or invoice (a contract, a share purchase, a receipt, …), then
 * file it as a PENDING draft so it lands in Review. The engine converts every
 * figure to EUR and forces the entry to balance; the user approves it. Returns
 * the new draft id, or null if nothing usable could be suggested.
 */
/** A suggested journal is degenerate — nothing real to book — when it carries no
 *  amount at all (an empty file / a non-accounting note) or every line sits in the
 *  9999 suspense account. Such a suggestion must be filed as UNKNOWN, never queued
 *  as a draft to approve. PURE. */
export function isDegenerateSuggestion(
  lines: ReadonlyArray<{ accountCode: string; amount: number }>,
  origMax: number,
): boolean {
  if (!lines.length || origMax === 0) return true;
  return lines.every((l) => l.accountCode === '9999');
}

async function trySuggestJournal(
  documentId: string,
  fileName: string,
  content: NonNullable<ReturnType<typeof toContent>>,
): Promise<string | null> {
  try {
    const chart = listFullChart().map((a) => ({ code: a.code, name: a.name }));
    const r = await suggestJournal({ fileName, content, chart });
    if (!r.ok || !r.suggestion || !Array.isArray(r.suggestion.lines) || r.suggestion.lines.length < 2) {
      return null;
    }
    const s = r.suggestion;
    const ccy = (s.currency || 'EUR').toUpperCase();
    const date = /^\d{4}-\d{2}-\d{2}/.test(s.date || '') ? s.date : new Date().toISOString().slice(0, 10);
    const fx = await getDailyRateToEur(ccy, date);
    const rate = fx.rate || 1;

    // Convert each suggested line to EUR (engine owns the figure) and make sure
    // any account the AI proposed exists in the chart.
    const lines = s.lines.map((ln) => {
      // Resolve onto the STANDARD chart — never mint a new account from an AI
    // suggestion (that polluted the trial balance with arbitrary codes).
    const acct = resolveToStandardAccount(ln.accountCode, ln.accountName);
      return {
        accountCode: acct.code,
        accountName: acct.name || accountName(acct.code),
        amount: round2(ln.amount * rate),
        description: s.description || fileName,
      };
    });
    // Force debits == credits: push any rounding residual onto the largest line.
    const residual = round2(lines.reduce((a, l) => a + l.amount, 0));
    if (residual !== 0 && lines.length) {
      let idx = 0;
      for (let i = 1; i < lines.length; i++) if (Math.abs(lines[i].amount) > Math.abs(lines[idx].amount)) idx = i;
      lines[idx].amount = round2(lines[idx].amount - residual);
    }

    const origMax = s.lines.reduce((m, l) => Math.max(m, Math.abs(Number(l.amount) || 0)), 0);
    // A degenerate suggestion must not become a draft to approve: an empty file or
    // a non-accounting note (shopping list etc.) yields a €0 entry, and an entry
    // entirely in the 9999 suspense account books nothing real. Return null so the
    // document is filed as UNKNOWN ("couldn't make sense of this") instead.
    if (isDegenerateSuggestion(lines, origMax)) return null;
    // Store fxRate in the canonical foreign-per-EUR convention (same as the typed
    // event path / ECB table), not the raw EUR-per-unit rate used for the math.
    const conv = functionalFromEurPerUnit(origMax, rate);
    const eurMax = conv.functionalAmount;
    const now = new Date().toISOString();
    const draft: DraftRecord = {
      id: crypto.randomUUID(),
      documentId,
      investeeName: (s.description || 'Suggested entry').slice(0, 80),
      instrument: 'SHARES',
      eventType: 'JOURNAL',
      controlCode: '',
      currency: ccy,
      txnDate: date,
      period: periodFor(date),
      status: 'PENDING',
      sourceFigures: { amount: origMax, quantity: null, fairValue: null, currency: ccy },
      engineFigures: {
        functionalAmount: eurMax,
        currency: 'EUR',
        lineCount: lines.length,
        fxRate: ccy === 'EUR' ? null : conv.fxRate,
        fxRateDate: ccy === 'EUR' ? null : fx.rateDate,
        originalCurrency: ccy,
        originalAmount: origMax,
      },
      lines,
      confidence: s.confidence ?? null,
      citation: null,
      rationale: s.rationale || null,
      docName: fileName,
      createdAt: now,
      postedAt: null,
    };
    insertDraft(draft);
    return draft.id;
  } catch {
    return null;
  }
}

export interface ProcessInput {
  fileName: string;
  folderPath: string;
  mime: string;
  buffer: Buffer;
}

export interface ProcessOutcome {
  kind: 'EVENT' | 'EVIDENCE' | 'UNKNOWN' | 'ERROR' | 'SKIPPED' | 'BANK' | 'ARAP' | 'DUPLICATE';
  fileName: string;
  documentId?: string;
  draftId?: string;
  message: string;
  added?: number; // BANK: how many transactions were imported
  aiUnavailable?: boolean; // the read failed because the AI reader was down/out of credits
}

/** A bank statement dropped into the general Documents area should be processed
 *  by the bank pipeline (transactions extracted) rather than just filed as
 *  evidence. Detect it from the AI's document type and the file name. */
function looksLikeBankStatement(documentType: string, fileName: string): boolean {
  const hay = `${documentType} ${fileName}`.toLowerCase();
  return /bank\w*\s*statement|account\s*statement|statement\s*of\s*account|historia\s*rachunku|rachunku|kontoauszug|\bbank\w*\b.*\bstatement\b|\bstatement\b.*\bbank\b|\bbs\b/.test(
    hay,
  );
}

/** Detect a bank statement from its CONTENT, independent of the file name or the
 *  AI's classification. A statement the model mis-reads as an event/unknown (so it
 *  carries no documentType and a non-matching name) would otherwise fall through
 *  to the suggested-journal path and be booked as a nonsensical compound entry.
 *  The strong tell is an account number/IBAN together with running balances or
 *  several dated transaction lines — things a share agreement or a financial
 *  statement do not have. PURE. */
export function looksLikeBankStatementContent(content: ExtractContent): boolean {
  if (content.kind !== 'text' || !content.text) return false;
  const t = content.text.toLowerCase();
  const hasIban = /\b[a-z]{2}\d{2}\s?(?:[a-z0-9]{4}\s?){3,}/.test(t);
  const balances = /(opening|closing)\s*balance|saldo\s*(pocz|ko[ńn]c|otwarcia|zamkni)/.test(t);
  const stmtWord = /account\s*statement|bank\s*statement|historia\s*rachunku|kontoauszug|statement\s*of\s*account/.test(t);
  const datedLines = (t.match(/\b\d{1,2}[.\/-]\d{1,2}[.\/-]\d{2,4}\b/g) || []).length;
  return (hasIban && (balances || stmtWord || datedLines >= 3)) || (balances && datedLines >= 3);
}

/** A CREDIT NOTE reverses/reduces an invoice — its AR/AP amount must be negated so
 *  it offsets the related invoice rather than inflating debtors/creditors. Detected
 *  from the file name + content, multilingual (EN/IT/DE/FR/PL/ES). */
export function looksLikeCreditNote(fileName: string, content: ExtractContent): boolean {
  const hay = `${fileName} ${content.kind === 'text' ? content.text ?? '' : ''}`.toLowerCase();
  return /credit\s*note|nota\s*di\s*credito|gutschrift|note\s*de\s*cr[ée]dit|facture\s*d['’]?avoir|nota\s*de\s*cr[ée]dito|nota\s*kredytowa/.test(hay);
}

/** An invoice or supplier bill should go to the Debtors & Creditors (AR/AP)
 *  ledger rather than just being filed as supporting evidence. */
function looksLikeInvoice(documentType: string, fileName: string): boolean {
  const hay = `${documentType} ${fileName}`.toLowerCase();
  return /invoice|\bbill\b|faktura|supplier|receipt|credit\s*note/.test(hay);
}

/** Detect an invoice/bill from its CONTENT, independent of the file name or the
 *  AI's classification. A fund-issued invoice named "USD receivable.txt" matches
 *  neither — so it fell to the suggested-journal path and never reached the AR/AP
 *  ledger. The tell is an invoice/bill word together with an amount-due / due-date
 *  / invoice-number marker — things a share agreement or a bank statement lack. */
export function looksLikeInvoiceContent(content: ExtractContent): boolean {
  if (content.kind !== 'text' || !content.text) return false;
  const t = content.text.toLowerCase();
  // Strong, unambiguous invoice nouns — the word "invoice" across EN/PL/IT/DE/FR/NL
  // — are an invoice on their own (a foreign invoice often has no English marker).
  const strongInvWord = /\binvoice\b|faktura|fattura|rechnung|facture|factuur/.test(t);
  // Weaker terms that also appear elsewhere — require an amount/due marker. ('fee
  // statement' / 'statement of fees' are matched specifically so a bank/financial
  // STATEMENT is not a false positive.)
  const weakInvWord = /\bbill\b|(credit|debit)\s*note|fee\s*(note|statement)|statement\s*of\s*fees?|request\s*for\s*payment/.test(t);
  // Amount-due / due-date / invoice-number markers — EN plus IT/FR/DE/PL.
  const marker = /amount\s*(due|payable|owed|to\s*us)|total\s*due|\bdue\s*date|invoice\s*(no|number|#)|payment\s*due|importo|dovut|scadenz|montant|[ée]ch[ée]anc|betrag|f[äa]llig|kwota|zap[lł]at|p[lł]atno/.test(t);
  return strongInvWord || (weakInvWord && marker);
}

// Documents that are NOT accounting entries — audited reports, statutory/registry
// papers, confirmations, KYC, etc. These are filed as supporting evidence and must
// NEVER be posted or turned into a journal entry. (The "reject list".)
const NON_POSTABLE = [
  /financial\s*statement|annual\s*report|\bfs\s*20\d\d\b|audited|audit\s*report|auditor'?s?\s*report/i,
  /registry\s*extract|business\s*registr|companies?\s*house|\bkrs\b|\bregon\b|certificate\s*of\s*incorporation|company\s*extract|registration\s*certificate|incorporation/i,
  /memorandum\s*of\s*association|articles\s*of\s*association|statute|deed\s*of\s*incorporation|by-?laws/i,
  /(cash|bank|balance|audit|independent)\s*confirmation|confirmation\s*(letter|of\s*balance)/i,
  /engagement\s*letter|representation\s*letter|management\s*letter|power\s*of\s*attorney/i,
  /\bkyc\b|know\s*your\s*customer|passport|identity\s*(card|document)|proof\s*of\s*address|utility\s*bill/i,
  /due\s*diligence|screening|sanctions|\bpep\b|compliance\s*(report|check)/i,
  /tax\s*(certificate|residence)|certificate\s*of\s*(good\s*standing|tax)/i,
  // Risk-assessment / onboarding / governance papers — never accounting entries.
  /business\s*risk\s*assessment|\brisk\s*assessment\b|\bbra\b/i,
  /malta\s*business\s*registr|\bmbr\b|board\s*resolution(?!.*dividend)|register\s*of\s*(companies|members|directors|beneficial)/i,
  // The client's OWN working papers / lead schedules (their OUTPUT, not source
  // documents) — a financial-statement line-item breakdown must never be booked as
  // a transaction (a "Revenue" lead schedule was posting an €11.5m phantom entry).
  /lead\s*schedule|working\s*paper|trial\s*balance|nominal\s*ledger/i,
  /\bfinancial\s*assets?\b|\bother\s*receivables?\b|trade\s*(and|&)\s*other\s*(payables?|receivables?)|cash\s*(and|&)\s*bank\b/i,
  /\b(revenue|expenses)\b[^.]*\.xlsx?$/i, // a "Revenue"/"Expenses" spreadsheet is a lead schedule, not a transaction
];

// Folder names (and strong filename prefixes) that are NEVER accounting entries,
// regardless of how the AI read the contents. A registry extract that the model
// mistakes for a share transfer, or a risk assessment it turns into a journal,
// must still be filed as supporting evidence — not posted.
const NON_ACCOUNTING_FOLDERS = [
  /extracts?\s*from\s*the\s*register/i,
  /register\s*of\s*companies/i,
  /\bmbr\b|malta\s*business\s*regist/i,
  /\bbra\b|business\s*risk/i,
  /\bkyc\b|know\s*your\s*customer/i,
  /do\s*not\s*use/i,
];
const NON_ACCOUNTING_FILE = [
  /^f2b\d/i, // Malta Business Registry extract prefix (e.g. "F2B1.13 - …")
  /\bbra\b|business\s*risk/i,
  /register\s*certificate|registry\s*extract|malta\s*business\s*regist/i,
];

/** Hard reject on folder/filename signals — overrides even an EVENT misread.
 *  These are structurally non-accounting documents (registry extracts, risk
 *  assessments, KYC) that must never become a posting or a suggested journal. */
const TRANSACTIONAL_SIGNAL = /(?:^|[^a-z0-9])spa(?:[^a-z0-9]|$)|share\s*purchase|sale\s*agreement|umowa\s*po[zż]yczki|loan\s*agreement|invoice|faktura/i;

export function isHardNonPostable(fileName: string, folderPath: string): boolean {
  const folder = (folderPath || '').toLowerCase();
  const file = (fileName || '').toLowerCase();
  // A document physically filed in a non-accounting folder is supporting material,
  // full stop (registry extracts, risk assessments, KYC).
  if (NON_ACCOUNTING_FOLDERS.some((re) => re.test(folder))) return true;
  // Filename-only signals (e.g. an "F2B…" registry-extract prefix) are weaker: a
  // genuine deal document that happens to carry that prefix (e.g.
  // "F2B1.32 - …SPA_Woodpecker") must still be processed, so transactional
  // signals in the name override the filename reject.
  if (TRANSACTIONAL_SIGNAL.test(file)) return false;
  if (NON_ACCOUNTING_FILE.some((re) => re.test(file))) return true;
  return false;
}

/** True if the document is supporting/statutory material, not an accounting entry. */
export function isNonPostable(documentType: string, fileName: string, folderPath = ''): boolean {
  if (isHardNonPostable(fileName, folderPath)) return true;
  const hay = `${documentType} ${fileName}`.toLowerCase();
  // Never reject things that are clearly transactional documents.
  if (/invoice|faktura|\bspa\b|share\s*purchase|sale\s*agreement|umowa\s*po[zż]yczki|loan\s*agreement|statement\s*of\s*account|bank\s*statement/i.test(hay)) {
    return false;
  }
  return NON_POSTABLE.some((re) => re.test(hay));
}

/** Pull a company name out of a filename like
 *  "F2B1 - RUBICON VENTURE LIMITED (C 94936) - Malta Business Registry extract.pdf"
 *  → "RUBICON VENTURE LIMITED". */
function investeeNameFromFileName(fileName: string): string {
  let s = fileName.replace(/\.[a-z0-9]+$/i, '');
  s = s.replace(/^\s*[A-Za-z]?\d+[A-Za-z]?\d*\s*[-–]\s*/, ''); // leading "F2B1 - "
  s = s.split(/\s[-–]\s|_|\(/)[0]; // up to " - ", "_", "("
  return s.trim();
}

/** A supporting document (registry extract, etc.) that concerns a KNOWN holding is
 *  filed as ownership evidence FOR that investee — linked + clearly labelled, never
 *  posted. Returns an enriched note + the matched investee, or nulls when no holding
 *  matches (then the caller keeps its generic supporting-document note). */
function supportingEvidenceLink(
  intent: IntakeIntent,
  fileName: string,
): { note: string | null; investee: { name: string; controlCode: string } | null } {
  const fromIntent = (intent as { investeeName?: string | null }).investeeName || '';
  const candidate = fromIntent || investeeNameFromFileName(fileName);
  const match = candidate ? matchInvestee(candidate, listInvestees()) : null;
  if (!match) return { note: null, investee: null };
  const qty = (intent as { sourceFigures?: { quantity?: number | null } }).sourceFigures?.quantity;
  const shares = typeof qty === 'number' && qty > 0 ? ` (states ${qty} shares)` : '';
  return {
    note: `Ownership evidence for ${match.name}${shares} — supporting document, not posted.`,
    investee: match,
  };
}

/** lowercase, non-alphanumeric → '-', collapse + trim hyphens. */
function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function newDocument(
  fileName: string,
  folderPath: string,
  mime: string,
  classification: DocumentRecord['classification'],
  note: string | null,
): DocumentRecord {
  return {
    id: crypto.randomUUID(),
    fileName,
    folderPath,
    mime,
    storedPath: null,
    classification,
    note,
    createdAt: new Date().toISOString(),
  };
}

// Coarse category → a filename hint that nudges each split sub-document toward its
// correct route (the bank/invoice detectors also look at the file name).
const CATEGORY_HINT: Record<string, string> = {
  bank_statement: 'bank statement',
  invoice: 'invoice',
  agreement: 'agreement',
  resolution: 'dividend resolution',
  financial_statement: 'financial statements',
  registry: 'registry extract',
  other: '',
};

/**
 * Entry point for an uploaded file. If the file is a PDF that bundles several
 * distinct documents (different categories scanned into one file), split it into
 * per-document sub-PDFs and process each on its own; otherwise process the file
 * as a single document. Always returns one outcome per resulting document so the
 * upload summary tallies each correctly.
 */
export async function processFileWithBundles(input: ProcessInput): Promise<ProcessOutcome[]> {
  const isPdf =
    /\.pdf$/i.test(input.fileName) ||
    /pdf/i.test(input.mime || '') ||
    (!!input.buffer && input.buffer.subarray(0, 5).toString('latin1') === '%PDF-');
  if (isPdf) {
    const pageCount = await pdfPageCount(input.buffer);
    if (pageCount >= 2) {
      const content = toContent(input.fileName, input.mime, input.buffer);
      if (content) {
        const det = await detectBundle({ fileName: input.fileName, content, pageCount });
        const segments = det.ok ? validateBundleSegments(det.documents, pageCount) : [];
        if (segments.length >= 2) {
          const parts = await splitPdfByPages(input.buffer, segments);
          // Only split when every segment produced a sub-PDF; otherwise process whole.
          if (parts.length === segments.length) {
            const base = input.fileName.replace(/\.pdf$/i, '');
            const outcomes: ProcessOutcome[] = [];
            for (let i = 0; i < parts.length; i++) {
              const seg = segments[i];
              const hint = CATEGORY_HINT[seg.category] ?? seg.category.replace(/_/g, ' ');
              // Include BOTH the title and the detected-category hint so the per-
              // document routing (bank/invoice detection keys on the file name) sees
              // the bundle's classification even when the title lacks the keyword.
              const label = [seg.title, hint].map((s) => (s || '').trim()).filter(Boolean).join(' — ') || `document ${i + 1}`;
              const nm = `${base} — ${label} (p${seg.pageStart}-${seg.pageEnd}).pdf`;
              outcomes.push(
                await processFile({ fileName: nm, folderPath: input.folderPath, mime: 'application/pdf', buffer: parts[i] }),
              );
            }
            return outcomes;
          }
        }
      }
    }
  }
  return [await processFile(input)];
}

export async function processFile(input: ProcessInput): Promise<ProcessOutcome> {
  const { fileName, folderPath, mime, buffer } = input;

  // Create the document record FIRST so its id is known, then save the original
  // bytes under data/uploads/<id>.<ext> for the live preview (CONTRACT §11(d)).
  const doc = newDocument(fileName, folderPath, mime, 'UNKNOWN', null);
  doc.storedPath = await saveOriginalBytes(doc.id, fileName, mime, buffer);
  insertDocument(doc);

  try {
    // 1. Bytes → content block.
    const content = toContent(fileName, mime, buffer);
    if (!content) {
      updateDocument(doc.id, { classification: 'UNKNOWN', note: 'Unsupported file type' });
      return {
        kind: 'SKIPPED',
        fileName,
        documentId: doc.id,
        message: 'Unsupported file type',
      };
    }

    // 2. Read it with Claude. A failed/garbled read must NOT dead-end as
    //    "couldn't read" — fall through as UNKNOWN so the routing (bank / invoice
    //    by file name) and the suggested-journal fallback still get a chance.
    const result = await extractIntent({
      fileName,
      folderPath,
      content,
      investees: listInvesteeNames(),
    });
    const intent: IntakeIntent = result.ok && result.intent
      ? result.intent
      : { kind: 'UNKNOWN', rationale: '', needsReview: true };
    const readFailed = !result.ok; // the AI couldn't read the document at all
    // If the read FAILED because the AI reader was unavailable (out of credits, bad
    // key, or temporarily down) — as opposed to the model genuinely not knowing —
    // remember why, so a document that can't be routed shows an honest reason rather
    // than a vague "needs a look".
    const aiUnavailable: ExtractErrorKind | undefined =
      !result.ok && result.errorKind && result.errorKind !== 'other' ? result.errorKind : undefined;

    // 3. Record the AI's classification on the document.
    updateDocument(doc.id, { classification: intent.kind, note: intent.rationale ?? null });

    // 3a-reject. Structurally non-accounting documents (registry extracts, risk
    //     assessments, KYC) are rejected on folder/filename signal BEFORE any
    //     routing — even if the AI misread the contents as a share event. They are
    //     filed as supporting evidence and never posted or journalled.
    if (isHardNonPostable(fileName, folderPath)) {
      const link = supportingEvidenceLink(intent, fileName);
      const note = link.note
        || 'Supporting document only (registry extract / risk assessment / onboarding) — not an accounting entry.';
      updateDocument(doc.id, {
        classification: 'EVIDENCE', note,
        relatedInvestee: link.investee?.name ?? null,
        relatedControlCode: link.investee?.controlCode ?? null,
      });
      return { kind: 'EVIDENCE', fileName, documentId: doc.id, message: note };
    }

    // 3b. A bank statement (filed as evidence by the intake reader) is routed to
    //     the bank pipeline so its transactions are actually extracted — "drop
    //     anything and the portal does its thing".
    // Routing applies to anything that isn't a bookable investment event — both
    // EVIDENCE and UNKNOWN (the intake reader is not always sure, so we also lean
    // on the file name). documentType is only present on EVIDENCE intents.
    const documentType = intent.kind === 'EVIDENCE' ? intent.documentType ?? '' : '';
    const routable = intent.kind === 'EVIDENCE' || intent.kind === 'UNKNOWN';
    // Any bank-statement signal — the file name/documentType OR the content —
    // routes to the bank pipeline even when the model mis-classified the file as an
    // event/unknown (a split bundle page or a misread statement). extractBankStatement
    // still has to parse real transactions, so a false positive simply falls through.
    const bankSignal =
      looksLikeBankStatement(documentType, fileName) || looksLikeBankStatementContent(content);
    if (bankSignal && (content.kind === 'pdf' || content.kind === 'text')) {
      const bank = await extractBankStatement({ fileName, content });
      if (bank.ok && bank.statements && bank.statements.length) {
        // One file can hold several accounts (e.g. EUR + PLN) — ingest each.
        let total = 0;
        for (const st of bank.statements) {
          const ingest = ingestStatement({ ...st, fileName, storedPath: doc.storedPath });
          total += ingest.added;
        }
        const accs = bank.statements.length;
        const accPart = accs > 1 ? ` across ${accs} accounts` : '';
        const months = total > 0 ? `, ${total} new transaction${total === 1 ? '' : 's'}${accPart}` : '';
        const note = `Bank statement read into the Bank section${months}.`;
        updateDocument(doc.id, { classification: 'BANK', note });
        return { kind: 'BANK', fileName, documentId: doc.id, message: note, added: total };
      }
      // Couldn't parse it as a statement — leave it filed as supporting evidence.
    }

    // 3c. An invoice/bill is routed to the Debtors & Creditors (AR/AP) ledger.
    //     Detected by file name/documentType OR by content, so a fund-issued
    //     invoice the model mis-read (and whose name lacks "invoice") still lands
    //     in AR/AP rather than the suggested-journal path. extractArAp must still
    //     parse a real invoice, so a false positive simply falls through.
    const invoiceSignal = looksLikeInvoice(documentType, fileName) || looksLikeInvoiceContent(content);
    if (
      (routable || invoiceSignal) &&
      (content.kind === 'pdf' || content.kind === 'text' || content.kind === 'image') &&
      invoiceSignal
    ) {
      const ar = await extractArAp({ fileName, content });
      if (ar.ok && ar.item) {
        // A credit note REDUCES the related invoice — negate its amount so it
        // offsets the debtor/creditor instead of inflating the balance.
        const isCreditNote = looksLikeCreditNote(fileName, content);
        if (isCreditNote) ar.item.amount = -Math.abs(ar.item.amount);
        // Already filed? Mark this upload as a duplicate instead of double-filing.
        const dup = findDuplicate(ar.item);
        if (dup) {
          const dnote = `Duplicate of an invoice/bill already filed (${dup.counterparty} ${dup.currency} ${dup.amount}). Not added again.`;
          updateDocument(doc.id, { classification: 'DUPLICATE', note: dnote });
          return { kind: 'DUPLICATE', fileName, documentId: doc.id, message: dnote };
        }
        insertItem({
          documentId: doc.id,
          kind: ar.item.kind,
          counterparty: ar.item.counterparty,
          amount: ar.item.amount,
          currency: ar.item.currency,
          issueDate: ar.item.issueDate ?? null,
          dueDate: ar.item.dueDate ?? null,
          status: 'OPEN',
          docName: fileName,
        });
        // If a matching bank line was already imported, settle it now (invoice
        // filed AFTER the statement still reverses against the debtor/creditor).
        rematchAll();
        const label = isCreditNote
          ? (ar.item.kind === 'RECEIVABLE' ? 'Credit note (reduces what is owed to the fund)' : 'Credit note (reduces what the fund owes)')
          : (ar.item.kind === 'RECEIVABLE' ? 'Invoice (owed to the fund)' : 'Bill (the fund owes)');
        const note = `${label} — ${ar.item.counterparty} ${ar.item.currency} ${ar.item.amount}. Added to Debtors & Creditors.`;
        updateDocument(doc.id, { classification: 'ARAP', note });
        return { kind: 'ARAP', fileName, documentId: doc.id, message: note };
      }
      // Couldn't parse it as an invoice — leave it filed as supporting evidence.
    }

    // 3d-reject. Statutory / audited / informational documents (financial
    //     statements, registry extracts, confirmations, KYC, …) are NOT accounting
    //     entries — file them as supporting evidence and never post or journal them.
    if (routable && isNonPostable(documentType, fileName, folderPath)) {
      const link = supportingEvidenceLink(intent, fileName);
      const note = link.note || 'Supporting document only — not an accounting entry, so it was not posted.';
      updateDocument(doc.id, {
        classification: 'EVIDENCE', note,
        relatedInvestee: link.investee?.name ?? null,
        relatedControlCode: link.investee?.controlCode ?? null,
      });
      return { kind: 'EVIDENCE', fileName, documentId: doc.id, message: note };
    }

    // 3e. Anything else with accounting meaning (a contract, a share purchase, a
    //     receipt, a misc. document) → ask the AI to SUGGEST a journal entry and
    //     send it to Review, instead of dead-ending as inert evidence.
    if (routable && !readFailed && (content.kind === 'pdf' || content.kind === 'text' || content.kind === 'image')) {
      const draftId = await trySuggestJournal(doc.id, fileName, content);
      if (draftId) {
        updateDocument(doc.id, { classification: 'EVENT', note: 'AI-suggested journal entry — review and approve.' });
        return {
          kind: 'EVENT',
          fileName,
          documentId: doc.id,
          draftId,
          message: 'Suggested a journal entry for your review.',
        };
      }
    }

    // 4. Non-events stop here. If the document is UNKNOWN only because the AI
    //    reader was unavailable (out of credits / bad key / down), say so plainly —
    //    the document wasn't understood because it couldn't be READ, not because it
    //    is unclassifiable.
    if (intent.kind !== 'EVENT') {
      if (intent.kind === 'UNKNOWN' && readFailed) {
        const msg = extractErrorMessage(aiUnavailable)
          || 'We couldn’t fully read this document (a long or complex file can need a second try) — please upload it again.';
        updateDocument(doc.id, { classification: 'UNKNOWN', note: msg });
        return { kind: 'UNKNOWN', fileName, documentId: doc.id, message: msg, aiUnavailable: true };
      }
      return { kind: intent.kind, fileName, documentId: doc.id, message: intent.rationale ?? '' };
    }

    // 4b. Prior-period guard. A document dated on/before the books opening date is
    //     already captured in the brought-forward opening balance — re-booking it
    //     would double-count. File it as supporting evidence (the reviewer can
    //     reclassify if it genuinely belongs in the current period). This is what
    //     lets a user drop a folder mixing historical and current documents.
    const openingCut = getBooksOpeningDate();
    const evDateStr = (intent.txnDate || '').slice(0, 10);
    if (openingCut && /^\d{4}-\d{2}-\d{2}$/.test(evDateStr) && evDateStr <= openingCut) {
      const note = `Dated ${evDateStr}, on/before the books opening date (${openingCut}) — already reflected in the opening balance. Filed as supporting evidence; reclassify if it belongs in the current period.`;
      updateDocument(doc.id, { classification: 'EVIDENCE', note });
      return { kind: 'EVIDENCE', fileName, documentId: doc.id, message: note };
    }

    // 5. Build account refs for this investee/instrument. The per-investee control
    //    sub-account is registered with the investee's name (e.g. "030-gamivo") —
    //    a deliberate per-holding sub-account the fund sub-ledger needs.
    //    A purchase/assignment of a RECEIVABLE (claim/debt) is NOT a share or loan —
    //    its debit belongs in the STANDARD Accounts receivable account (1100), not a
    //    bespoke per-debtor code — so the entry is Dr 1100 / Cr Bank, and it never
    //    inflates the portfolio (which counts only 030/032).
    const recvText = `${intent.citation || ''} ${intent.rationale || ''} ${fileName}`.toLowerCase();
    const isReceivablePurchase =
      (intent.eventType === 'ACQUISITION' || intent.eventType === 'DISPOSAL') &&
      /receivabl|\bclaim\b|debt purchase|assignment of receiv|factoring|cession of/.test(recvText);
    // Reuse the EXISTING holding for this investee+instrument when one is already
    // on the books (opening balance or a prior draft), so a disposal/follow-on
    // hits the same control account its carrying cost lives in. Only mint a fresh
    // slug for a genuinely new position. Receivables post to the standard 1100.
    const instrPrefix = controlCodeFor(intent.instrument);
    const existingHolding = isReceivablePurchase
      ? null
      : findExistingHolding(intent.investeeName, instrPrefix, listInvestees());
    const controlCode = isReceivablePurchase
      ? '1100'
      : (existingHolding?.controlCode ?? `${instrPrefix}-${slug(intent.investeeName)}`);
    // Only the deliberate per-investee investment/loan sub-account is registered;
    // 1100 is already a standard account (ensureAccount returns it without minting).
    ensureAccount(controlCode, isReceivablePurchase ? undefined : intent.investeeName, 'ASSET');
    const refs: FundAccountRefs = {
      controlCode,
      bankCode: '1010',
      gainLossCode: '500', // realised gain/loss on disposal of shares
      incomeCode: '4000', // investment income / distributions
      fxCode: '6800', // FX gain/loss
      writeOffCode: '610', // impairment loss on investments
    };

    // 6. DISPOSAL / WRITE_OFF need the carrying cost from the current posted position.
    //    A PARTIAL disposal (selling some of the units held) must release only the
    //    proportionate carrying amount of the units sold — not the whole position
    //    (IFRS: cost flows out on carrying amount, pro-rata). disposalCarryingCost
    //    handles the proportioning when both the units sold and the units held are
    //    known; otherwise it falls back to the full carrying value.
    let carryingCostFunctional: number | undefined;
    let note: string | null = null;
    let carryingUnverified = false;
    if (intent.eventType === 'DISPOSAL' || intent.eventType === 'WRITE_OFF') {
      const fullCarrying = carryingValueFor(controlCode);
      const qtySold = intent.sourceFigures?.quantity ?? null;
      const unitsHeld = unitsHeldFor(controlCode);
      // Proportion only a partial SHARE disposal; a write-off removes the whole position.
      carryingCostFunctional =
        intent.eventType === 'DISPOSAL'
          ? disposalCarryingCost(controlCode, qtySold)
          : fullCarrying;
      const assess = assessDisposalCarrying(
        intent.eventType,
        qtySold,
        unitsHeld,
        fullCarrying,
        carryingCostFunctional ?? fullCarrying,
      );
      note = assess.note;
      carryingUnverified = assess.forceReview;
    }

    // 6b. Impossible event date (trap T2): an out-of-range day (e.g. 31 Feb) would
    //     silently roll forward in new Date() and land in the wrong period. Flag it
    //     and hold it for the reviewer rather than booking a wrong date.
    const dchk = checkDate(intent.txnDate);
    const dateImpossible = dchk.impossible;
    if (dateImpossible) {
      const dnote = `Impossible date "${intent.txnDate}" — ${dchk.reason}${dchk.suggestion ? ` Suggested: ${dchk.suggestion}.` : ''} Please correct before posting.`;
      note = note ? `${note} ${dnote}` : dnote;
    }

    // 7. Engine computes the balanced lines (no AI figures here). For a non-EUR
    //    event, inject the accurate ECB rate for the transaction date (same daily
    //    source the bank uses) so FX isn't pinned to the sparse bundled table.
    let rates = loadRates();
    const evCcy = (intent.currency || 'EUR').toUpperCase();
    const evDate = /^\d{4}-\d{2}-\d{2}/.test(intent.txnDate || '') ? intent.txnDate.slice(0, 10) : '';
    if (evCcy !== 'EUR' && evDate) {
      const fx = await getDailyRateToEur(evCcy, evDate); // EUR per 1 unit
      if (fx.rate && fx.rate > 0) {
        rates = [{ currency: evCcy, rateDate: new Date(evDate), rate: 1 / fx.rate }, ...rates];
      }
    }
    const composition = composeDraft(intent, {
      rates,
      refs,
      carryingCostFunctional,
    });

    // 7b. Zero-amount guard. A value-bearing event whose figure couldn't be read
    //     would otherwise post a meaningless €0 entry that looks ready to approve.
    //     Flag it and hold it below the bulk-approve bar so the reviewer enters the
    //     amount (WRITE_OFF can legitimately be 0 when a position is already nil —
    //     that case is already noted via the carrying-cost guard above).
    const zeroAmount = Math.abs(Number(composition.engineFigures.functionalAmount) || 0) < 0.01
      && intent.eventType !== 'WRITE_OFF';
    if (zeroAmount) {
      const znote = 'We couldn’t read the amount from this document — please enter the figure (or check the document) before posting.';
      note = note ? `${note} ${znote}` : znote;
    }

    // 8. Persist the draft (PENDING).
    const now = new Date().toISOString();
    const draft: DraftRecord = {
      id: crypto.randomUUID(),
      documentId: doc.id,
      investeeName: intent.investeeName,
      instrument: intent.instrument,
      eventType: intent.eventType,
      controlCode,
      currency: intent.currency,
      txnDate: intent.txnDate,
      period: periodFor(intent.txnDate),
      status: 'PENDING',
      sourceFigures: composition.sourceFigures,
      engineFigures: composition.engineFigures,
      lines: composition.engineLines,
      // An impossible date, an unreadable amount, or an unverifiable disposal carrying
      // cost forces per-line review (held below the bulk-approve bar).
      confidence: (dateImpossible || zeroAmount || carryingUnverified) ? Math.min(intent.confidence ?? 0.6, 0.3) : intent.confidence,
      citation: intent.citation,
      rationale: note ? `${intent.rationale} (${note})` : intent.rationale,
      docName: fileName,
      createdAt: now,
      postedAt: null,
    };
    insertDraft(draft);

    return {
      kind: 'EVENT',
      fileName,
      documentId: doc.id,
      draftId: draft.id,
      message: note ? `Transaction drafted — ${note}` : 'Transaction drafted for your review.',
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    updateDocument(doc.id, { classification: 'ERROR', note: message });
    return {
      kind: 'ERROR',
      fileName,
      documentId: doc.id,
      message,
    };
  }
}

// --- Manual reclassification ("what to do with this document") --------------
// For a document the portal couldn't confidently place ("needs a look"), the
// reviewer chooses a treatment and we re-run that specific path on the stored
// bytes. Deterministic for 'supporting'; the others re-read with Claude.
export type ReclassifyAction = 'supporting' | 'bank' | 'invoice' | 'journal' | 'event';

export async function reclassifyDocument(documentId: string, action: ReclassifyAction): Promise<ProcessOutcome> {
  const doc = getDocument(documentId);
  if (!doc) return { kind: 'ERROR', fileName: '(unknown)', documentId, message: 'Document not found.' };
  const fileName = doc.fileName;

  // 'supporting' needs no bytes — just file it as evidence, no accounting entry.
  if (action === 'supporting') {
    const note = 'Filed as a supporting document (no accounting entry) — your choice.';
    updateDocument(documentId, { classification: 'EVIDENCE', note });
    return { kind: 'EVIDENCE', fileName, documentId, message: note };
  }

  if (!doc.storedPath) {
    return { kind: 'ERROR', fileName, documentId, message: 'The original file is no longer available to re-read.' };
  }
  let content;
  try {
    const buffer = await readObject(doc.storedPath);
    content = toContent(fileName, doc.mime, buffer);
  } catch {
    return { kind: 'ERROR', fileName, documentId, message: 'Could not read the stored file.' };
  }
  if (!content) {
    return { kind: 'ERROR', fileName, documentId, message: 'This file type cannot be re-read.' };
  }

  try {
    if (action === 'bank') {
      const bank = await extractBankStatement({ fileName, content });
      if (!bank.ok || !bank.statements || !bank.statements.length) {
        return { kind: 'ERROR', fileName, documentId, message: 'Could not read this as a bank statement.' };
      }
      let total = 0;
      for (const st of bank.statements) total += ingestStatement({ ...st, fileName, storedPath: doc.storedPath }).added;
      updateDocument(documentId, { classification: 'BANK', note: `Treated as a bank statement — ${total} transactions imported.` });
      return { kind: 'BANK', fileName, documentId, added: total, message: `Imported ${total} bank transactions.` };
    }
    if (action === 'invoice') {
      const ar = await extractArAp({ fileName, content });
      if (!ar.ok || !ar.item) return { kind: 'ERROR', fileName, documentId, message: 'Could not read this as an invoice/bill.' };
      const dup = findDuplicate(ar.item);
      if (dup) {
        const dnote = `Duplicate of an invoice/bill already filed (${dup.counterparty} ${dup.currency} ${dup.amount}). Not added again.`;
        updateDocument(documentId, { classification: 'DUPLICATE', note: dnote });
        return { kind: 'DUPLICATE', fileName, documentId, message: dnote };
      }
      insertItem({
        documentId, kind: ar.item.kind, counterparty: ar.item.counterparty, amount: ar.item.amount,
        currency: ar.item.currency, issueDate: ar.item.issueDate ?? null, dueDate: ar.item.dueDate ?? null,
        status: 'OPEN', docName: fileName,
      });
      rematchAll();
      updateDocument(documentId, { classification: 'ARAP', note: `Treated as ${ar.item.kind === 'RECEIVABLE' ? 'an invoice' : 'a bill'} — added to Debtors & Creditors.` });
      return { kind: 'ARAP', fileName, documentId, message: 'Added to Debtors & Creditors.' };
    }
    if (action === 'journal' || action === 'event') {
      const draftId = await trySuggestJournal(documentId, fileName, content);
      if (draftId) {
        updateDocument(documentId, { classification: 'EVENT', note: 'AI-suggested journal entry — review and approve.' });
        return { kind: 'EVENT', fileName, documentId, draftId, message: 'Suggested a journal entry for your review.' };
      }
      return { kind: 'ERROR', fileName, documentId, message: 'Could not derive a journal entry from this document.' };
    }
    return { kind: 'ERROR', fileName, documentId, message: 'Unknown action.' };
  } catch (err) {
    return { kind: 'ERROR', fileName, documentId, message: err instanceof Error ? err.message : String(err) };
  }
}
