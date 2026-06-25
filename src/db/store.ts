// Pure-JSON file store for THCP Autopilot. No database, no native modules.
// Backed by a single JSON file at data/autopilot.json. All operations are
// synchronous; every mutation rewrites the whole file atomically (write to a
// temp file, then rename over the real file).

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

import type {
  Instrument,
  InvestmentEventType,
  JournalLine,
  SourceFigures,
  EngineFigures,
} from '../core/types';
import { resetRegistry } from '../core/chart';
import type { InvesteeRef } from '../core/investee-match';

// --- Records (CONTRACT §5) ---------------------------------------------------

export interface DraftRecord {
  id: string;
  documentId: string | null;
  investeeName: string;
  instrument: Instrument;
  // 'JOURNAL' = a generic AI-suggested journal entry (contract / share purchase /
  // anything that isn't a clean bank statement or invoice) awaiting review.
  // 'FV_REMEAS' = a fair-value remeasurement of a holding (trap T7 / IFRS9 FVTPL).
  // 'YEAR_CLOSE' = an audited year-end closing journal (zeroes P&L to retained earnings).
  eventType: InvestmentEventType | 'JOURNAL' | 'FV_REMEAS' | 'YEAR_CLOSE';
  controlCode: string;
  currency: string;
  txnDate: string; // ISO
  period: string; // YYYY-MM (derived from txnDate or the current period)
  status: 'PENDING' | 'POSTED' | 'REJECTED';
  sourceFigures: SourceFigures;
  engineFigures: EngineFigures;
  lines: JournalLine[];
  confidence: number | null;
  citation: string | null;
  rationale: string | null;
  docName: string | null;
  createdAt: string;
  postedAt: string | null;
  // Maker-checker: who created the draft vs who approved it (segregation of duties).
  createdBy?: string;
  postedBy?: string;
  editedAt?: string | null;
  // Reversal linkage (corrections never delete the original).
  reversesDraftId?: string | null; // set on a reversing entry → points at the original
  reversedByDraftId?: string | null; // set on the original → points at its reversal
}

export interface DocumentRecord {
  id: string;
  fileName: string;
  folderPath: string;
  mime: string;
  storedPath: string | null; // relative path to the saved original bytes (data/uploads/...)
  classification: 'EVENT' | 'EVIDENCE' | 'UNKNOWN' | 'ERROR' | 'BANK' | 'ARAP' | 'DUPLICATE';
  note: string | null;
  createdAt: string;
  // When a supporting document (e.g. a registry extract) concerns a known holding,
  // it is linked to that investee as ownership evidence — never posted, but no
  // longer a disconnected "supporting document".
  relatedInvestee?: string | null;
  relatedControlCode?: string | null;
}

// --- Audit trail (CONTRACT: append-only, hash-chained) -----------------------

/** One immutable audit-trail entry. The trail is append-only: entries are never
 *  edited or deleted. Each entry chains the previous entry's hash so any tamper
 *  is detectable (Phase-5 evidence-hashing convention). */
export interface AuditEntry {
  id: string;
  at: string; // ISO timestamp
  action: string; // e.g. DRAFT_EDIT, DRAFT_POST, DRAFT_REVERSE, PERIOD_LOCK
  entity: string; // 'draft' | 'period' | 'document' | ...
  entityId: string;
  actor: string; // who did it ('system' until real users exist)
  summary: string; // human-readable one-liner
  before?: unknown; // prior state snapshot (for edits)
  after?: unknown; // new state snapshot
  prevHash: string; // hash of the previous entry ('' for the first)
  hash: string; // SHA-256 of this entry's content + prevHash
}

// --- Settings ---------------------------------------------------------------

export interface Settings {
  currentPeriod: string | null; // YYYY-MM or null
  // Periods that have been closed/locked: no posting, editing, or reversing into
  // them is allowed once locked (a reversal must be booked in an open period).
  lockedPeriods?: string[];
  // The as-at date of the opening balances (ISO YYYY-MM-DD). Transactions dated on
  // or before this are PRIOR-PERIOD — already reflected in the brought-forward
  // opening balance — so intake files them as supporting evidence instead of
  // re-booking them (which would double-count). Null = no opening cut-off set.
  booksOpeningDate?: string | null;
}

// --- Opening balances (imported trial balance) ------------------------------

/** One line of an imported opening trial balance. amount is signed:
 *  positive = debit, negative = credit (same convention as JournalLine). */
export interface OpeningBalanceLine {
  accountCode: string;
  accountName: string;
  amount: number;
}

/** A starting trial balance the user imports so the books continue from an
 *  existing position rather than from zero. Held as a single brought-forward
 *  entry tagged to one period. */
export interface OpeningBalanceRecord {
  period: string; // YYYY-MM the opening position is brought forward into
  importedAt: string; // ISO
  lines: OpeningBalanceLine[];
}

// --- Internal store shape ----------------------------------------------------

interface StoreShape {
  investees: unknown[];
  investments: unknown[];
  drafts: DraftRecord[];
  documents: DocumentRecord[];
  settings: Settings;
  openingBalance: OpeningBalanceRecord | null;
  // Custom chart-of-accounts additions (built-in accounts live in core/chart.ts).
  chartAccounts: any[];
  // Section collections (records typed/owned by their section modules; held loosely here).
  bankAccounts: any[];
  bankStatements: any[];
  bankTransactions: any[];
  arapItems: any[];
  // Audit requests (auditor evidence requests + their gathered packs / answered sheets).
  auditRequests: any[];
  // Persistent per-day FX cache, keyed "CCY:YYYY-MM-DD" -> EUR-per-1-unit rate.
  fxDailyCache: Record<string, number>;
  // Append-only, hash-chained audit trail.
  auditLog: AuditEntry[];
}

// The database file. Override with AUTOPILOT_DB (used by the test suite so tests
// never touch a real client's data/autopilot.json). Resolved LAZILY on each
// access so a test can set process.env.AUTOPILOT_DB before initDb() and be
// isolated even with static imports — a const captured at module load would
// otherwise pin the live path and let a directly-run test wipe real data.
function dbFile(): string {
  return process.env.AUTOPILOT_DB
    ? path.resolve(process.env.AUTOPILOT_DB)
    : path.resolve(process.cwd(), 'data', 'autopilot.json');
}
function dataDir(): string {
  return path.dirname(dbFile());
}
function tmpFile(): string {
  return dbFile() + '.tmp';
}

function emptyStore(): StoreShape {
  return {
    investees: [],
    investments: [],
    drafts: [],
    documents: [],
    settings: { currentPeriod: null, lockedPeriods: [] },
    openingBalance: null,
    chartAccounts: [],
    bankAccounts: [],
    bankStatements: [],
    bankTransactions: [],
    arapItems: [],
    auditRequests: [],
    fxDailyCache: {},
    auditLog: [],
  };
}

/** The effective period for a draft: its stored period, or — for legacy records
 *  written before periods existed — derived from the transaction date. */
function effectivePeriod(d: DraftRecord): string {
  if (d.period && /^\d{4}-\d{2}$/.test(d.period)) return d.period;
  return (d.txnDate || '').slice(0, 7);
}

// In-memory mirror of the file. Loaded by initDb()/loadDb().
let db: StoreShape = emptyStore();

// Storage driver. 'file' (default) keeps the original on-disk JSON behaviour for
// local dev and the test suite. 'supabase' holds the whole blob in a Supabase
// `app_kv` row instead — synchronous flush() calls just mark the store dirty and
// the real write happens in the async saveDb() at the end of each request.
const STORAGE_DRIVER = process.env.STORAGE_DRIVER === 'supabase' ? 'supabase' : 'file';
let dirty = false;

// --- Persistence -------------------------------------------------------------

function ensureDataDir(): void {
  const dir = dataDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/** Persist the in-memory store. File driver: atomic temp-file write + rename
 *  (rename is atomic on the same filesystem). Supabase driver: mark dirty so the
 *  request's async saveDb() upserts the blob. */
function flush(): void {
  if (STORAGE_DRIVER === 'supabase') {
    dirty = true;
    return;
  }
  ensureDataDir();
  fs.writeFileSync(tmpFile(), JSON.stringify(db, null, 2), 'utf8');
  fs.renameSync(tmpFile(), dbFile());
}

/** Replace the in-memory store from a parsed blob, normalising every field so a
 *  partial/legacy shape can never crash a reader. Shared by initDb (file) and
 *  loadDb (supabase). */
function hydrate(parsed: Partial<StoreShape>): void {
  const settings: Settings =
    parsed.settings && typeof parsed.settings === 'object'
      ? {
          currentPeriod: (parsed.settings as Settings).currentPeriod ?? null,
          lockedPeriods: Array.isArray((parsed.settings as Settings).lockedPeriods)
            ? [...((parsed.settings as Settings).lockedPeriods as string[])]
            : [],
        }
      : { currentPeriod: null, lockedPeriods: [] };
  db = {
    investees: Array.isArray(parsed.investees) ? parsed.investees : [],
    investments: Array.isArray(parsed.investments) ? parsed.investments : [],
    drafts: Array.isArray(parsed.drafts) ? parsed.drafts : [],
    documents: Array.isArray(parsed.documents) ? parsed.documents : [],
    settings,
    openingBalance:
      parsed.openingBalance && typeof parsed.openingBalance === 'object' && Array.isArray((parsed.openingBalance as OpeningBalanceRecord).lines)
        ? (parsed.openingBalance as OpeningBalanceRecord)
        : null,
    chartAccounts: Array.isArray(parsed.chartAccounts) ? parsed.chartAccounts : [],
    bankAccounts: Array.isArray(parsed.bankAccounts) ? parsed.bankAccounts : [],
    bankStatements: Array.isArray(parsed.bankStatements) ? parsed.bankStatements : [],
    bankTransactions: Array.isArray(parsed.bankTransactions) ? parsed.bankTransactions : [],
    arapItems: Array.isArray(parsed.arapItems) ? parsed.arapItems : [],
    auditRequests: Array.isArray(parsed.auditRequests) ? parsed.auditRequests : [],
    fxDailyCache:
      parsed.fxDailyCache && typeof parsed.fxDailyCache === 'object' && !Array.isArray(parsed.fxDailyCache)
        ? (parsed.fxDailyCache as Record<string, number>)
        : {},
    auditLog: Array.isArray(parsed.auditLog) ? (parsed.auditLog as AuditEntry[]) : [],
  };
}

/** Load the file into the in-memory object, creating it (and data/) if missing.
 *  Synchronous; used by the file driver (local dev, tests) and at CLI boot. */
export function initDb(): void {
  ensureDataDir();
  if (!fs.existsSync(dbFile())) {
    db = emptyStore();
    flush();
    return;
  }
  const raw = fs.readFileSync(dbFile(), 'utf8');
  let parsed: Partial<StoreShape>;
  try {
    parsed = raw.trim() ? (JSON.parse(raw) as Partial<StoreShape>) : {};
  } catch {
    // Corrupt/unreadable file: start clean rather than crash.
    parsed = {};
  }
  hydrate(parsed);
}

/** Async load used by the serverless request lifecycle. File driver delegates to
 *  initDb(); supabase driver fetches the blob row (seeding an empty one the first
 *  time). Call once at the start of every request before touching the store. */
export async function loadDb(): Promise<void> {
  if (STORAGE_DRIVER !== 'supabase') {
    initDb();
    return;
  }
  const { loadBlobRemote } = await import('../storage/supabase');
  const parsed = (await loadBlobRemote()) as Partial<StoreShape> | null;
  if (!parsed) {
    db = emptyStore();
    dirty = true;
    await saveDb();
    return;
  }
  hydrate(parsed);
  dirty = false;
}

/** Async save used by the serverless request lifecycle. No-op for the file driver
 *  (flush() already wrote to disk) and a no-op when nothing changed. */
export async function saveDb(): Promise<void> {
  if (STORAGE_DRIVER !== 'supabase' || !dirty) return;
  const { saveBlobRemote } = await import('../storage/supabase');
  await saveBlobRemote(db);
  dirty = false;
}

// --- Shared accessors for section modules (bank, AR/AP, loans) ----------------

/**
 * Direct access to the in-memory store for section modules that own their own
 * collections (`bankAccounts`, `bankStatements`, `bankTransactions`, `arapItems`).
 * Mutate the returned object's arrays, then call `persist()` to write to disk.
 */
export function getDb(): StoreShape {
  return db;
}

/** Flush the in-memory store to disk atomically (call after mutating via getDb()). */
export function persist(): void {
  flush();
}

// --- Settings ---------------------------------------------------------------

export function getSettings(): Settings {
  return {
    currentPeriod: db.settings?.currentPeriod ?? null,
    lockedPeriods: [...(db.settings?.lockedPeriods ?? [])],
    booksOpeningDate: db.settings?.booksOpeningDate ?? null,
  };
}

export function setCurrentPeriod(period: string): void {
  if (!db.settings) db.settings = { currentPeriod: null, lockedPeriods: [] };
  db.settings.currentPeriod = period;
  flush();
}

/** The opening cut-off date: events on/before it are prior-period (in the opening
 *  balance). Explicit setting wins; otherwise derive from the opening balance's
 *  period (the day before that period starts); null when neither is available. */
export function getBooksOpeningDate(): string | null {
  const explicit = db.settings?.booksOpeningDate;
  if (typeof explicit === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(explicit)) return explicit;
  const ob = getOpeningBalance();
  if (ob?.period && /^\d{4}-\d{2}$/.test(ob.period)) {
    const [y, m] = ob.period.split('-').map(Number);
    const lastPrevDay = new Date(Date.UTC(y, m - 1, 0)); // day 0 of month m = last day of m-1
    return lastPrevDay.toISOString().slice(0, 10);
  }
  return null;
}

/** True only for a real calendar date in YYYY-MM-DD form (rejects 2021-13-99,
 *  2021-02-30, etc. — format-valid strings that aren't real dates). */
function isRealIsoDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function setBooksOpeningDate(date: string | null): void {
  if (!db.settings) db.settings = { currentPeriod: null, lockedPeriods: [] };
  db.settings.booksOpeningDate = date && isRealIsoDate(date) ? date : null;
  flush();
}

// --- Period locks (close a period; no posting/editing into it) ---------------

export function listLockedPeriods(): string[] {
  return [...(db.settings?.lockedPeriods ?? [])];
}

export function isPeriodLocked(period: string | null | undefined): boolean {
  if (!period) return false;
  return (db.settings?.lockedPeriods ?? []).includes(period);
}

export function lockPeriod(period: string): void {
  if (!db.settings) db.settings = { currentPeriod: null, lockedPeriods: [] };
  if (!db.settings.lockedPeriods) db.settings.lockedPeriods = [];
  if (!db.settings.lockedPeriods.includes(period)) {
    db.settings.lockedPeriods.push(period);
    db.settings.lockedPeriods.sort();
    flush();
  }
}

export function unlockPeriod(period: string): void {
  if (!db.settings?.lockedPeriods) return;
  db.settings.lockedPeriods = db.settings.lockedPeriods.filter((p) => p !== period);
  flush();
}

// --- Audit trail (append-only, hash-chained) ---------------------------------

function hashAudit(e: Omit<AuditEntry, 'hash'>): string {
  const payload = JSON.stringify({
    id: e.id,
    at: e.at,
    action: e.action,
    entity: e.entity,
    entityId: e.entityId,
    actor: e.actor,
    summary: e.summary,
    before: e.before ?? null,
    after: e.after ?? null,
    prevHash: e.prevHash,
  });
  return crypto.createHash('sha256').update(payload).digest('hex');
}

/** Append one immutable, hash-chained entry to the audit trail. */
export function appendAudit(input: {
  action: string;
  entity: string;
  entityId: string;
  summary: string;
  actor?: string;
  before?: unknown;
  after?: unknown;
}): AuditEntry {
  if (!Array.isArray(db.auditLog)) db.auditLog = [];
  const prev = db.auditLog[db.auditLog.length - 1];
  const base: Omit<AuditEntry, 'hash'> = {
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    action: input.action,
    entity: input.entity,
    entityId: input.entityId,
    actor: input.actor || 'system',
    summary: input.summary,
    before: input.before,
    after: input.after,
    prevHash: prev?.hash ?? '',
  };
  const entry: AuditEntry = { ...base, hash: hashAudit(base) };
  db.auditLog.push(entry);
  flush();
  return entry;
}

/** Read the audit trail (newest first), optionally filtered by entity/entityId. */
export function listAudit(filter?: { entity?: string; entityId?: string }): AuditEntry[] {
  let rows = [...(db.auditLog ?? [])];
  if (filter?.entity) rows = rows.filter((e) => e.entity === filter.entity);
  if (filter?.entityId) rows = rows.filter((e) => e.entityId === filter.entityId);
  return rows.reverse();
}

/** Re-walk the chain and confirm no entry was altered or removed. */
export function verifyAudit(): { ok: boolean; brokenAt: number | null } {
  let prevHash = '';
  const log = db.auditLog ?? [];
  for (let i = 0; i < log.length; i++) {
    const e = log[i];
    const expected = hashAudit({ ...e, prevHash });
    if (e.prevHash !== prevHash || e.hash !== expected) return { ok: false, brokenAt: i };
    prevHash = e.hash;
  }
  return { ok: true, brokenAt: null };
}

// --- Opening balances (imported trial balance) ------------------------------

export function getOpeningBalance(): OpeningBalanceRecord | null {
  return db.openingBalance ?? null;
}

export function setOpeningBalance(record: OpeningBalanceRecord): void {
  db.openingBalance = record;
  flush();
}

export function clearOpeningBalance(): void {
  db.openingBalance = null;
  flush();
}

// --- Daily FX cache ----------------------------------------------------------

/** Look up a cached daily FX rate by "CCY:YYYY-MM-DD" key (EUR per 1 unit). */
export function getFxRate(key: string): number | undefined {
  return db.fxDailyCache?.[key];
}

/** Cache a daily FX rate under "CCY:YYYY-MM-DD" (EUR per 1 unit) and persist. */
export function setFxRate(key: string, rate: number): void {
  if (!db.fxDailyCache) db.fxDailyCache = {};
  db.fxDailyCache[key] = rate;
  flush();
}

/** Distinct periods across all drafts (ascending), with pending/posted counts. */
export function listPeriods(): { period: string; pending: number; posted: number }[] {
  const map = new Map<string, { pending: number; posted: number }>();
  for (const d of db.drafts) {
    const p = effectivePeriod(d);
    if (!p) continue;
    const entry = map.get(p) ?? { pending: 0, posted: 0 };
    if (d.status === 'PENDING') entry.pending++;
    else if (d.status === 'POSTED') entry.posted++;
    map.set(p, entry);
  }
  return [...map.entries()]
    .map(([period, c]) => ({ period, pending: c.pending, posted: c.posted }))
    .sort((a, b) => a.period.localeCompare(b.period));
}

// --- Reads / writes ----------------------------------------------------------

/** Distinct investee names seen across drafts (so the AI roster grows as
 *  documents are processed). */
export function listInvesteeNames(): string[] {
  const seen = new Set<string>();
  for (const d of db.drafts) {
    const name = d.investeeName?.trim();
    if (name) seen.add(name);
  }
  return [...seen];
}

/** Known holdings as {name, controlCode} — from drafts (any status) plus the
 *  opening-balance control accounts (030-/032-). Used to link a supporting
 *  document to the holding it is evidence for. */
export function listInvestees(): InvesteeRef[] {
  const byCode = new Map<string, string>(); // controlCode -> best name
  for (const d of db.drafts) {
    if (d.controlCode && /^03[02]/.test(d.controlCode) && d.investeeName?.trim()) {
      byCode.set(d.controlCode, d.investeeName.trim());
    }
  }
  const ob = db.openingBalance;
  if (ob) {
    for (const l of ob.lines) {
      if (/^03[02]/.test(l.accountCode) && !/^032-1/.test(l.accountCode)) {
        if (!byCode.has(l.accountCode)) byCode.set(l.accountCode, l.accountName || l.accountCode);
      }
    }
  }
  return [...byCode].map(([controlCode, name]) => ({ name, controlCode }));
}

export function insertDocument(d: DocumentRecord): void {
  if (!d.id) d.id = crypto.randomUUID();
  db.documents.push(d);
  flush();
}

export function insertDraft(d: DraftRecord): void {
  if (!d.id) d.id = crypto.randomUUID();
  db.drafts.push(d);
  flush();
}

export function listDrafts(
  status?: DraftRecord['status'],
  period?: string,
): DraftRecord[] {
  const filterPeriod = period && period !== 'all' ? period : undefined;
  return db.drafts.filter((d) => {
    if (status && d.status !== status) return false;
    if (filterPeriod && effectivePeriod(d) !== filterPeriod) return false;
    return true;
  });
}

export function getDraft(id: string): DraftRecord | null {
  return db.drafts.find((d) => d.id === id) ?? null;
}

export function setDraftStatus(
  id: string,
  status: DraftRecord['status'],
  postedAt?: string,
): void {
  const draft = db.drafts.find((d) => d.id === id);
  if (!draft) return;
  draft.status = status;
  if (status === 'POSTED') {
    draft.postedAt = postedAt ?? new Date().toISOString();
  } else if (postedAt !== undefined) {
    draft.postedAt = postedAt;
  }
  flush();
}

/** Low-level in-place patch of a draft record. Callers (posting/edit module)
 *  enforce status/lock rules and write the audit entry. */
export function patchDraft(id: string, patch: Partial<DraftRecord>): DraftRecord | null {
  const draft = db.drafts.find((d) => d.id === id);
  if (!draft) return null;
  Object.assign(draft, patch);
  flush();
  return draft;
}

export function listDocuments(): DocumentRecord[] {
  return [...db.documents];
}

export function getDocument(id: string): DocumentRecord | null {
  return db.documents.find((d) => d.id === id) ?? null;
}

/** Update an existing document record in place (e.g. to set storedPath). */
export function updateDocument(id: string, patch: Partial<DocumentRecord>): void {
  const doc = db.documents.find((d) => d.id === id);
  if (!doc) return;
  Object.assign(doc, patch);
  flush();
}

export type PostedLineRow = JournalLine & {
  txnId: string;
  txnDate: string;
  period: string;
  eventType: string;
  investeeName: string;
  fxRate: number | null;
  fxRateDate: string | null;
  documentId: string | null; // source document, if any (doc↔entry linkage)
  docName: string | null;
  statementId?: string | null; // bank statement this line came from (evidence link)
};

/** Flatten lines from all POSTED drafts into ledger rows. Each row carries its
 *  draft's effective period and FX details (for the Ledger FX column, §11(b)). */
export function listPostedLines(): PostedLineRow[] {
  const rows: PostedLineRow[] = [];

  // Imported opening trial balance comes first, as a single brought-forward
  // entry. These are real posted balances the rest of the books build on.
  const opening = db.openingBalance;
  if (opening && Array.isArray(opening.lines)) {
    for (const ln of opening.lines) {
      rows.push({
        accountCode: ln.accountCode,
        accountName: ln.accountName || '',
        amount: ln.amount,
        description: 'Opening balance',
        txnId: 'opening',
        txnDate: `${opening.period}-01`,
        period: opening.period,
        eventType: 'OPENING',
        investeeName: 'Opening balance',
        fxRate: null,
        fxRateDate: null,
        documentId: null,
        docName: null,
      });
    }
  }

  for (const d of db.drafts) {
    if (d.status !== 'POSTED') continue;
    const fxRate = d.engineFigures?.fxRate ?? null;
    const fxRateDate = d.engineFigures?.fxRateDate ?? null;
    const period = effectivePeriod(d);
    for (const line of d.lines) {
      rows.push({
        ...line,
        txnId: d.id,
        txnDate: d.txnDate,
        period,
        eventType: d.eventType,
        investeeName: d.investeeName,
        fxRate,
        fxRateDate,
        documentId: d.documentId ?? null,
        docName: d.docName ?? null,
      });
    }
  }
  return rows;
}

export function counts(): {
  documents: number;
  pending: number;
  posted: number;
  rejected: number;
} {
  let pending = 0;
  let posted = 0;
  let rejected = 0;
  for (const d of db.drafts) {
    if (d.status === 'PENDING') pending++;
    else if (d.status === 'POSTED') posted++;
    else if (d.status === 'REJECTED') rejected++;
  }
  return { documents: db.documents.length, pending, posted, rejected };
}

/** Wipe everything and rewrite the file (the "Start over" button). */
export function resetAll(): void {
  db = emptyStore();
  resetRegistry(); // drop custom accounts back to the built-in chart
  flush();
}
