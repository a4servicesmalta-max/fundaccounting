# THCP Autopilot — Internal Build Contract

This is the single source of truth that every build agent codes against. **Do not deviate** from the names/shapes here — they are the integration boundary between independently-built parts.

The product: a non-technical user drops their fund documents (bank statements, share purchase/sale agreements, loan docs, dividend resolutions, invoices, registry extracts…) into a web page. The app reads each with the Claude API, the **deterministic engine** computes the bookkeeping (FX, balanced double-entry, gains/losses), the user reviews & approves, and posted books + reports come out. **The AI only reads/classifies and transcribes figures; the engine computes every number.** An AI-authored figure must never become an accounting figure.

Stack: Node 20 + TypeScript (run via `tsx`, no build step), Express, better-sqlite3 (file `data/autopilot.db`), `@anthropic-ai/sdk` (`claude-opus-4-8`), zod. Frontend: a single static page (vanilla JS) served from `public/`.

---

## 1. Chart of accounts (fixed, standalone) — `src/core/chart.ts`

```ts
export type AccountType = 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE';
export interface Account { code: string; name: string; type: AccountType; }

export const CHART: Account[] = [
  { code: '030', name: 'Investments in shares (control)', type: 'ASSET' },
  { code: '032', name: 'Loans granted (control)', type: 'ASSET' },
  { code: '1010', name: 'Bank', type: 'ASSET' },
  { code: '4000', name: 'Investment income', type: 'REVENUE' },
  { code: '6800', name: 'Foreign exchange gain/loss', type: 'EXPENSE' },
  { code: '6850', name: 'Investment write-offs', type: 'EXPENSE' },
];
// Per-investee control sub-accounts are formed as `030-<slug>` / `032-<slug>`
// but ALWAYS roll up to the parent control code for reporting.
export function controlCodeFor(instrument: Instrument): '030' | '032'; // SHARES->030, LOAN->032
export function accountName(code: string): string; // looks up CHART, falls back to code
```

## 2. Core domain types — `src/core/types.ts`

```ts
export type Instrument = 'SHARES' | 'LOAN';
export type InvestmentEventType =
  | 'ACQUISITION' | 'DISPOSAL' | 'LOAN_ADVANCE' | 'LOAN_REPAYMENT'
  | 'DISTRIBUTION' | 'INTEREST_ACCRUAL' | 'FX_REVAL' | 'WRITE_OFF';

/** Sign convention on journal lines: positive = debit, negative = credit. */
export interface JournalLine { accountCode: string; accountName: string; amount: number; description: string; }

/** Account codes the engine posts against for one event. */
export interface FundAccountRefs {
  controlCode: string;   // e.g. '030-gamivo'
  bankCode: string;      // '1010'
  gainLossCode: string;  // '6800'
  incomeCode: string;    // '4000'
  fxCode: string;        // '6800'
  writeOffCode: string;  // '6850'
}

export interface SourceFigures { amount: number; quantity: number | null; fairValue: number | null; currency: string; } // what the AI READ
export interface EngineFigures { functionalAmount: number; currency: 'EUR'; lineCount: number; }                       // what the engine COMPUTED
```

## 3. Core engine (PORT from the proven backend code, adapted to account-CODE refs)

The agent building `src/core/` ports these verbatim-in-spirit from the existing, tested implementations (provided below as the authority). All money is `number` in major units (EUR); every builder balances to the cent by construction; sign convention positive=debit/negative=credit.

- `src/core/fx.ts` — `RatePoint { currency; rateDate: Date; rate }` (rate = foreign units per 1 EUR), `findRateForDate(rates, currency, date): number|null`, `convertToFunctional(amount, currency, date, rates): number` (EUR=1:1; else amount/rate; round 2dp; throw if no rate). **Source:** the Plan-1 `fund-fx.ts`.
- `src/core/journal.ts` — `buildInvestmentJournalLines(event, refs): JournalLine[]` for all 8 event types; balanced by construction; DISPOSAL gain = `-(proceeds-cost)` (gain credit / loss debit); requires `carryingCostFunctional` for DISPOSAL/WRITE_OFF. Returns `JournalLine` (with `accountCode`/`accountName`/`description`). **Source:** Plan-1 `fund-journal.ts` (adapt `chartAccountId`→`accountCode`, add `accountName` via `accountName()`).
- `src/core/rollforward.ts` — `rollForwardPositions(opening, events): Record<string, number>`. **Source:** Plan-1 `fund-rollforward.ts`.
- `src/core/invariant.ts` — `assertControlInvariant(glBalance, positions)`, `sumPositions`. **Source:** Plan-1 `fund-invariant.ts`.
- `src/core/intake-schema.ts` — zod `intakeIntentSchema` + `IntakeIntent`/`InvestmentEventIntent` (EVENT/EVIDENCE/UNKNOWN). `sourceFigures` = `{ amount, quantity, fairValue }` (NO carryingCost — engine-owned). **Source:** Plan-2 `intake.types.ts`.
- `src/core/intake-prompt.ts` — `buildIntakePrompt(ctx): {system, user}`. **Source:** Plan-2 `intake-prompt.ts`.
- `src/core/intake-parse.ts` — `extractJsonObject`, `parseIntakeResponse(content): {ok:true,intent}|{ok:false,error}`. **Source:** Plan-2 `intake-parse.ts`.
- `src/core/compose.ts` — `composeDraft(intent, {rates, refs, carryingCostFunctional?}): { eventInput, engineLines: JournalLine[], sourceFigures, engineFigures }`. **Source:** Plan-4 `compose-draft.ts` (lines are `JournalLine`).
- Each core file gets a co-located `*.test.ts` (`node:test`) mirroring the proven tests.

> The exact verbatim source code for every one of the above is in the build prompt for the CORE agent.

## 4. FX rates — `src/fx/rates.ts`

`loadRates(): RatePoint[]` — reads bundled `data/ecb-rates.csv` (columns: `currency,date,rate` where rate=foreign-per-EUR). Ships with a small recent set (EUR implicit 1:1; PLN, USD, GBP, CHF at least). `ensureRatesSeeded()` writes the CSV if missing.

## 5. Storage — `src/db/store.ts` (pure-JSON file store, file `data/autopilot.json`)

**No native modules.** A simple synchronous store backed by one JSON file (`data/autopilot.json`) holding `{ investees: [], investments: [], drafts: [], documents: [] }`. `initDb()` loads the file into an in-memory object (creating it if missing); every mutating function updates the in-memory object and writes the whole file back atomically (write to a temp file, then rename). IDs are generated with `crypto.randomUUID()`. This keeps `npm install` pure-JS and reliable on any client machine. Same synchronous function signatures as below:

```ts
// tables: investee, investment, txn (drafts+posted), document, (fx handled in CSV)
export interface DraftRecord {
  id: string; documentId: string | null; investeeName: string; instrument: Instrument;
  eventType: InvestmentEventType; controlCode: string; currency: string; txnDate: string; // ISO
  status: 'PENDING' | 'POSTED' | 'REJECTED';
  sourceFigures: SourceFigures; engineFigures: EngineFigures; lines: JournalLine[];
  confidence: number | null; citation: string | null; rationale: string | null;
  docName: string | null; createdAt: string; postedAt: string | null;
}
export interface DocumentRecord {
  id: string; fileName: string; folderPath: string; mime: string;
  classification: 'EVENT' | 'EVIDENCE' | 'UNKNOWN' | 'ERROR'; note: string | null; createdAt: string;
}
export function initDb(): void;                       // create tables if missing
export function listInvesteeNames(): string[];        // for the AI roster
export function insertDocument(d: DocumentRecord): void;
export function insertDraft(d: DraftRecord): void;
export function listDrafts(status?: DraftRecord['status']): DraftRecord[];
export function getDraft(id: string): DraftRecord | null;
export function setDraftStatus(id: string, status: DraftRecord['status'], postedAt?: string): void;
export function listDocuments(): DocumentRecord[];
export function listPostedLines(): Array<JournalLine & { txnId: string; txnDate: string; eventType: string; investeeName: string }>;
export function counts(): { documents: number; pending: number; posted: number; rejected: number };
export function resetAll(): void;                     // wipe everything (for the "Start over" button)
```

JSON columns (`sourceFigures`, `engineFigures`, `lines`) are stored as TEXT (JSON.stringify) and parsed on read.

## 6. Claude client — `src/ai/claude.ts`

```ts
export interface ExtractContent {
  kind: 'text' | 'pdf' | 'image';
  text?: string;                 // kind==='text'
  base64?: string;               // kind==='pdf' | 'image'
  mediaType?: string;            // images: 'image/png' | 'image/jpeg' | ...
}
export interface ExtractInput { fileName: string; folderPath: string; content: ExtractContent; investees: string[]; }
export interface ExtractResult { ok: boolean; intent?: IntakeIntent; error?: string; modelUsed?: string; }
export async function extractIntent(input: ExtractInput): Promise<ExtractResult>;
export function isConfigured(): boolean; // ANTHROPIC_API_KEY present
```
Uses `@anthropic-ai/sdk`, `model = process.env.ANTHROPIC_MODEL || 'claude-opus-4-8'`, builds the message from `buildIntakePrompt` (system + user) plus the content block: text → appended to the user text; pdf → a `document` base64 block; image → an `image` base64 block. Adaptive thinking on. Parse with `parseIntakeResponse`. Never throw — return `{ok:false,error}` on any failure (incl. missing key).

## 7. Pipeline — `src/pipeline/`

- `extract-content.ts` — `toContent(fileName, mime, buffer): ExtractContent | null`: PDF→`{kind:'pdf', base64}`; CSV/TXT→`{kind:'text', text}`; XLSX→ parse with `xlsx` to CSV text → `{kind:'text', text}`; PNG/JPG/WEBP/GIF→`{kind:'image', base64, mediaType}`; else null (skip with note).
- `process.ts` — `processFile({fileName, folderPath, mime, buffer}): Promise<ProcessOutcome>`: toContent → extractIntent → store a `DocumentRecord`; if intent.kind==='EVENT' → resolve `FundAccountRefs` (control = `${controlCodeFor(instrument)}-${slug(investeeName)}`), `composeDraft` (carryingCost omitted in v1 — DISPOSAL/WRITE_OFF still drafts but flags `needsCarryingCost`), `insertDraft` (PENDING). Returns `{ kind, draftId?, documentId, fileName, message }`.
- Handle `.zip` at the API layer: unzip with `adm-zip`, process each entry preserving its path as `folderPath`.

## 8. Posting & reports

- `src/posting/post.ts` — `approveDraft(id)`: load PENDING draft → mark POSTED (lines are already balanced/computed; "posting" finalizes them). `approveAll()`. `rejectDraft(id)`.
- `src/report/report.ts` —
  - `portfolio()`: per investee+instrument, roll forward POSTED transactions to a carrying value; group by control code; return rows `{ investeeName, instrument, controlCode, currency, carryingValue }` + totals per control code. Assert the control invariant.
  - `ledger()`: posted journals with lines.
  - `trialBalance()`: net balance per account code (sum of posted lines), grouped, with totals (debits==credits).
  - `exportCsv(type: 'portfolio'|'ledger'|'trial-balance'): string`.

## 9. HTTP API — `src/server.ts` (Express, also serves `public/`)

All JSON unless noted. Errors → `{ error: string }` with appropriate status.

| Method | Path | Body / Query | Response |
|---|---|---|---|
| GET | `/api/health` | — | `{ ok, aiConfigured: boolean, model }` |
| GET | `/api/status` | — | `{ counts: {documents,pending,posted,rejected} }` |
| POST | `/api/upload` | multipart `files[]` (pdf/csv/xlsx/img/zip) | `{ processed: number, events: ProcessOutcome[], evidence: [...], unknown: [...], errors: [...] }` |
| GET | `/api/drafts` | `?status=PENDING` | `{ drafts: DraftRecord[] }` |
| GET | `/api/drafts/:id` | — | `{ draft: DraftRecord }` |
| POST | `/api/drafts/:id/approve` | — | `{ draft: DraftRecord }` |
| POST | `/api/drafts/approve-all` | — | `{ approved: number }` |
| POST | `/api/drafts/:id/reject` | — | `{ ok: true }` |
| GET | `/api/report/portfolio` | — | `{ rows, totals }` |
| GET | `/api/report/ledger` | — | `{ lines }` |
| GET | `/api/report/trial-balance` | — | `{ rows, totals }` |
| GET | `/api/export/:type` | `type ∈ portfolio|ledger|trial-balance` | CSV download |
| POST | `/api/reset` | — | `{ ok: true }` (wipes data — used by "Start over") |

On boot: `initDb()`, `ensureRatesSeeded()`, print `Open http://localhost:<PORT> in your browser`.

## 10. Frontend — `public/index.html` + `public/app.js` + `public/styles.css`

A single, friendly page for a NON-TECHNICAL user. Sections, top to bottom:
1. **Header** — product name "Fund Autopilot", one-line plain-English explanation, and a small status pill (green "AI ready" / red "Add your API key") from `/api/health`.
2. **Upload** — a big drag-and-drop zone ("Drop your documents here, or click to choose") accepting multiple files and folders/zip. On drop → `POST /api/upload` with a progress indicator and a plain-language result summary ("Read 12 documents: 7 transactions found, 4 supporting files, 1 needs your attention").
3. **Review & approve** — a card per PENDING draft showing, in plain language: investee, what happened (event type in friendly words), the date, **"What the document said"** (sourceFigures) vs **"What we booked"** (the engine's balanced journal lines, with account names), an AI-confidence chip, and the citation. Buttons: **Approve**, **Reject**. Plus an **Approve all** button. Make the "AI read this / we calculated that" distinction visually obvious and reassuring.
4. **Books & reports** — tabs: **Portfolio** (NAV per investee), **Ledger** (posted entries), **Trial balance**. Each with a **Download CSV** button.
5. A small **"Start over"** (calls `/api/reset`, with confirm).

Design: clean, calm, professional, lots of whitespace, readable fonts, no jargon, helpful empty-states and tooltips. Vanilla JS (fetch), no framework/build. Mobile-friendly enough. It must be obvious to a bookkeeper with zero technical background.

---

## File ownership (no two agents write the same file)

- **CORE agent** → `src/core/*` (types, chart, fx, journal, rollforward, invariant, intake-schema, intake-prompt, intake-parse, compose) + their `*.test.ts`.
- **DB agent** → `src/db/store.ts`, `src/db/index.ts`.
- **WEB agent** → `public/index.html`, `public/app.js`, `public/styles.css`.
- **DOCS agent** → `README.md`, `QUICKSTART.md`, `data/ecb-rates.csv` (seed), `.gitignore`.
- **INTEGRATION agent (round 2)** → `src/ai/claude.ts`, `src/fx/rates.ts`, `src/pipeline/extract-content.ts`, `src/pipeline/process.ts`, `src/posting/post.ts`, `src/report/report.ts`, `src/server.ts`.

Run/verify (all agents): Node is at `C:\Users\user\Downloads\vacei-stack\.tools\node-v20.20.2-win-x64` — prepend `export PATH="/c/Users/user/Downloads/vacei-stack/.tools/node-v20.20.2-win-x64:$PATH"`. Tests: `node --import tsx --test <file>`. This project is NOT a git repo — no commits.

---

## 11. v0.2 enhancements (THIS round)

Four features. File ownership for this round: **CORE-FX agent** → `src/core/fx.ts`, `src/core/compose.ts`, `src/core/types.ts` (+ their tests). **BACKEND agent** → `src/ai/claude.ts`, `src/db/store.ts`, `src/pipeline/process.ts`, `src/pipeline/extract-content.ts`, `src/report/report.ts`, `src/server.ts`. **FRONTEND agent** → `public/index.html`, `public/app.js`, `public/styles.css`.

### (a) Adaptive thinking (BACKEND → `src/ai/claude.ts`)
SDK is now `@anthropic-ai/sdk@0.105` (supports it). Add `thinking: { type: 'adaptive' }` to the `messages.create` params. Keep `max_tokens` (raise to e.g. 4096 to leave room for thinking). Do NOT pass `temperature`. When reading the response, **skip non-text blocks** (thinking blocks) and read the first `type:'text'` block (already the pattern — just make sure thinking blocks are ignored).

### (b) Exchange-rate-used (CORE-FX + BACKEND + FRONTEND)
- CORE-FX `src/core/fx.ts`: add `convertWithRate(amount, currency, date, rates): { amount: number; rate: number | null; rateDate: string | null }` — same math as `convertToFunctional` but also returns the `rate` used (foreign units per 1 EUR) and the `rateDate` (ISO `yyyy-mm-dd` of the rate point used). EUR → `{ amount: round2(amount), rate: null, rateDate: null }`.
- CORE-FX `src/core/types.ts`: extend `EngineFigures` to `{ functionalAmount: number; currency: 'EUR'; lineCount: number; fxRate: number | null; fxRateDate: string | null; originalCurrency: string; originalAmount: number }`.
- CORE-FX `src/core/compose.ts`: use `convertWithRate`; populate the new `EngineFigures` fields (`fxRate`, `fxRateDate`, `originalCurrency = ev.currency`, `originalAmount = ev.sourceFigures.amount`). Update compose/fx tests.
- FRONTEND: in each review card's "What we booked", when `engineFigures.fxRate` is non-null, show a line: **"Exchange rate used: 1 EUR = {fxRate} {originalCurrency} (as at {fxRateDate})"**. Also add an "FX rate" column to the Ledger/Trial-balance views where a converted entry exists (best-effort; from the draft's engineFigures — BACKEND may include `fxRate`/`fxRateDate` on `listPostedLines` rows).

### (c) Monthly periods + "Start a new month" (BACKEND + FRONTEND)
- A period is `YYYY-MM`. `DraftRecord` gains **`period: string`** (BACKEND, in `store.ts`): set by `process.ts`/seed from the transaction date (`txnDate.slice(0,7)`); if no usable date, use the current period.
- Store settings: the JSON file gains a `settings: { currentPeriod: string | null }` object. Add `getSettings()`, `setCurrentPeriod(period: string)`, and `listPeriods(): { period: string; pending: number; posted: number }[]` (distinct periods across drafts, sorted ascending). `initDb()` defaults `currentPeriod` to null.
- API: `GET /api/periods` → `{ periods: [{period,pending,posted}], current: string|null }`. `POST /api/period` body `{ period: "YYYY-MM" }` → sets current ("start a new month"); returns `{ current }`. `GET /api/drafts` and the report endpoints accept an optional **`?period=YYYY-MM`** filter (omitted or `all` = no filter). For reports: filter `ledger` and `trial-balance` to entries whose draft `period` matches; `portfolio` shows positions **as at end of that period** (include posted txns with `period <= selected`); with no filter, everything/cumulative.
- "Start a new month" semantics: `POST /api/period` just sets `currentPeriod`. Default suggestion for the picker = the month AFTER the latest period present, else `2025-04` (April) as a sensible starting month.
- FRONTEND: a **period toolbar** under the header: shows "Working month: {currentPeriod or 'All'}", a dropdown to filter views by month (`All months` + each period with counts), and a **"Start new month"** button that opens a small month picker (defaulting per above) → `POST /api/period` then refresh. The selected filter drives the drafts list and all three reports (pass `?period=`).

### (d) Real-time document preview (BACKEND + FRONTEND)
- BACKEND `process.ts` + `server.ts`: when processing an uploaded file, **save the original bytes** to `data/uploads/<documentId>.<ext>` (create dir; ext from filename/mime). `DocumentRecord` gains **`storedPath: string | null`** and keep its `mime`. The created **draft must link to its document via `documentId`** (set it — not null). Add endpoint **`GET /api/documents/:id/file`** that streams the stored file with the correct `Content-Type` and `Content-Disposition: inline` (so PDFs/images render in the browser). Also expose the document id on draft rows (already there) and on `GET /api/drafts/:id`.
- FRONTEND: in each review card, add a **"Document" preview pane** (alongside or above the read/booked comparison) that renders the source file from `/api/documents/{documentId}/file`: PDFs via `<iframe>`/`<embed>` (a reasonable height, ~360px, scrollable), images via `<img>`, other types via a "Download / open" link. Make it feel live — show it as soon as the card appears. If `documentId` is null (e.g. seeded data), show a subtle "No preview available" placeholder. Keep it tidy (a collapsible "View document" section is fine, but default it open so the user sees the contract immediately).

Boot note: `server.ts` should `fs.mkdirSync('data/uploads', { recursive: true })` on boot. The integration shapes (EngineFigures fields, DraftRecord.period, DocumentRecord.storedPath, the new endpoints) are the fixed boundary — code to them exactly.

---

## 12. v0.3 — Bank statements · Aging debtors/creditors · Loans (THIS round)

Four new capabilities, built as **per-section modules**. Shared scaffolding is ALREADY DONE: `src/db/store.ts` exposes `getDb(): StoreShape` (the in-memory object) and `persist()` (atomic flush), with new collections `bankAccounts[]`, `bankStatements[]`, `bankTransactions[]`, `arapItems[]`; `src/core/chart.ts` has operating accounts (1100 debtors, 2010 creditors, 2300 borrowings, 4000/4010 income, 6000 rent, 6100 legal, 6200 office, 6300 bank charges, 6400 interest, 6500 salaries, 6800 FX, 6850 write-off, 9999 suspense). Section modules import `getDb`/`persist` from `../db/store` and own their collections with the record types below.

**Sign convention everywhere:** bank `amount` is signed — **positive = money IN, negative = money OUT**. Money is `number` EUR-or-original-currency major units.

### Shared record types (define in each section's `*-store.ts`)
```ts
// Bank
interface BankAccount { id: string; bankName: string; accountRef: string; currency: string; createdAt: string; }
interface BankStatement { id: string; bankAccountId: string; fileName: string; storedPath: string | null;
  periodStart: string; periodEnd: string; // YYYY-MM-DD
  openingBalance: number; closingBalance: number; footingOk: boolean; footingDiff: number;
  monthsCovered: string[]; // YYYY-MM
  createdAt: string; }
interface BankTransaction { id: string; bankAccountId: string; statementId: string;
  date: string; period: string; // YYYY-MM-DD / YYYY-MM
  description: string; amount: number; balance: number | null; // signed; running balance if known
  postToCode: string | null; postToName: string | null; postConfidence: number | null;
  status: 'AUTO' | 'REVIEW' | 'POSTED' | 'REJECTED';
  matchedDocumentId: string | null; createdAt: string; }
// AR/AP
interface ArApItem { id: string; documentId: string | null; kind: 'RECEIVABLE' | 'PAYABLE';
  counterparty: string; amount: number; currency: string;
  issueDate: string | null; dueDate: string | null; // YYYY-MM-DD
  status: 'OPEN' | 'PAID'; paidByTxnId: string | null; docName: string | null; createdAt: string; }
```

### File ownership (this round — disjoint; no two agents share a file)
- **AI agent** → `src/ai/extract-bank.ts`, `src/ai/extract-arap.ts` (+ tests).
- **BANK agent** → `src/bank/bank-store.ts`, `src/bank/categorize.ts`, `src/bank/match.ts`, `src/bank/ingest.ts`, `src/bank/bank.routes.ts` (+ tests for categorize/match/ingest dedup+footing).
- **ARAP agent** → `src/arap/arap-store.ts`, `src/arap/aging.ts`, `src/arap/arap.routes.ts` (+ aging test).
- **LOANS agent** → `src/loans/loans.ts`, `src/loans/loans.routes.ts` (+ test).
- **UI agent** → `public/index.html`, `public/app.js`, `public/styles.css`.
- Controller wires the 3 routers into `src/server.ts` afterward (do NOT edit server.ts).

### (a) AI extraction — `src/ai/extract-bank.ts`, `src/ai/extract-arap.ts`
Reuse the DI'd caller pattern from `src/ai/claude.ts` (read it: a `StructuredCaller` default that calls `anthropicProvider`/the Anthropic SDK; never throws; `claude-opus-4-8`; adaptive thinking). Each new extractor takes an `ExtractContent` (text/pdf/image — same shape as claude.ts) and an injectable caller (default = the real Claude call), builds a system+user prompt instructing the model to ONLY transcribe what's printed (never compute), returns a zod-validated object, never throws.
- `extractBankStatement(input, deps?): Promise<{ ok: boolean; statement?: { bankName: string; accountRef: string; currency: string; periodStart: string; periodEnd: string; openingBalance: number; closingBalance: number; transactions: { date: string; description: string; amount: number; balance?: number | null }[] }; error?: string }>`. Prompt: extract bank name, account number/IBAN, currency, statement period, opening balance, EVERY transaction (date, description, signed amount: + in / − out, running balance if shown), and closing balance. Return JSON only.
- `extractArAp(input, deps?): Promise<{ ok: boolean; item?: { kind: 'RECEIVABLE'|'PAYABLE'; counterparty: string; amount: number; currency: string; issueDate: string|null; dueDate: string|null }; error?: string }>`. Prompt: is this an invoice the FUND ISSUED (money owed TO the fund → RECEIVABLE) or a bill/supplier invoice the FUND RECEIVED (money the fund OWES → PAYABLE)? Extract counterparty, amount, currency, issue date, due date. Return JSON only.

### (b) Bank section — `src/bank/*`
- `categorize.ts` — `categorizeTransaction(txn: {description; amount}): { code: string; name: string; confidence: number }`. Deterministic keyword rules over `description` → a chart code + confidence (0–1). Examples: bank charge/fee/commission → 6300 (0.9); interest → 6400 (0.85); rent → 6000 (0.85); salary/payroll/wages → 6500 (0.85); legal/notary/law/audit/accounting → 6100 (0.8); dividend/distribution received (amount>0) → 4000 (0.8); else **9999 "Suspense — to review" at low confidence (0.2)**. Use `accountName(code)` for the name. Pure + tested.
- `match.ts` — `matchTransaction(txn: {amount; date; description}, openItems: ArApItem[]): ArApItem | null`. Return the best OPEN item where `Math.abs(Math.abs(item.amount) - Math.abs(txn.amount)) < 0.01` AND the dates are within **30 days** (item.dueDate or issueDate vs txn.date) AND the counterparty name fuzzy-matches the description (case-insensitive token overlap). Null if none. Pure + tested (pass candidates in).
- `ingest.ts` — `ingestStatement(extracted): { bankAccountId; statementId; added: number; skippedMonths: string[]; footingOk: boolean; footingDiff: number; continuityOk: boolean }`. Steps: find-or-create `BankAccount` by (bankName, accountRef) [match case-insensitively; create if new] → **split bank by bank**. Compute `monthsCovered` from the transactions' dates. **Dedup:** for each month already present for THIS bank account (from existing `bankTransactions`), skip that month's incoming transactions (collect into `skippedMonths`); also a txn-level guard (skip an incoming txn whose date+amount+description already exists for this account). Insert remaining as `BankTransaction`s (period = date.slice(0,7)). **Footing (engine math):** `footingDiff = round2(openingBalance + sum(ALL extracted txn amounts) − closingBalance)`; `footingOk = |footingDiff| < 0.01`. **Continuity:** `continuityOk` = the statement's opening balance equals the most recent prior running balance for this account (±0.01) when prior data exists, else true. For each NEWLY-inserted txn: run `categorizeTransaction` → set postToCode/postToName/postConfidence and `status = confidence >= 0.75 ? 'AUTO' : 'REVIEW'`; run `matchTransaction` against OPEN `arapItems` → set `matchedDocumentId` and mark that ArApItem `PAID` + `paidByTxnId` (via getDb/persist). Persist the BankStatement record. **Tests:** dedup (overlapping Jan–Jun then May–Dec → May/Jun skipped, Jul–Dec added), footing pass/fail, categorize threshold (AUTO vs REVIEW), match marks item paid.
- `bank-store.ts` — CRUD over `getDb().bankAccounts/bankStatements/bankTransactions` + `persist()`: `findOrCreateAccount`, `insertStatement`, `insertTransaction`, `listAccounts`, `listStatements`, `listTransactions({accountId?, period?, status?})`, `getTransaction`, `setTransactionPostTo(id, code)`, `setTransactionStatus(id, status)`, monthsPresentForAccount(accountId): string[].
- `bank.routes.ts` — `export const bankRouter: Router`. Endpoints (mounted at `/api/bank`): `POST /upload` (multer files[]; for each: save bytes to data/uploads, `extractBankStatement` → `ingestStatement`; aggregate result), `GET /accounts`, `GET /statements`, `GET /transactions?accountId=&period=&status=`, `POST /transactions/:id/post-to` body `{code}` (sets postToCode/name, status→'POSTED' if it was AUTO/REVIEW), `POST /transactions/:id/approve` (status→'POSTED'), `POST /transactions/:id/reject`. Errors → `{error}`.

### (c) Aging debtors/creditors — `src/arap/*`
- `arap-store.ts` — CRUD over `getDb().arapItems` + `persist()`: `insertItem`, `listItems(kind?)`, `getItem`, `markPaid(id, txnId)`, plus the `ArApItem` type (exported; BANK's match.ts imports it from here).
- `aging.ts` — `agingReport(asOf: string): { receivables: AgingSide; payables: AgingSide }` where `AgingSide = { buckets: { current: number; d1_30: number; d31_60: number; d61_90: number; d90_plus: number }; byCounterparty: { counterparty: string; total: number; buckets: {...} }[]; total: number }`. Only OPEN items; bucket by `dueDate` vs `asOf` (not yet due → current; else by days overdue). Pure + tested.
- `arap.routes.ts` — `export const arapRouter: Router` (mounted at `/api/aging`): `POST /upload` (multer files[]; save bytes; `extractArAp` → `insertItem` OPEN; link documentId), `GET /` → `agingReport(asOf=req.query.asOf || today)`, `GET /items?kind=`.

### (d) Loans — `src/loans/*`
- `loans.ts` — `loansReport(): { loans: LoanRow[]; totals: { granted: number; borrowed: number; outstanding: number } }`. `LoanRow = { party: string; direction: 'GRANTED'|'BORROWED'; currency: string; advanced: number; repaid: number; outstanding: number; lastEventDate: string|null; events: { date: string; type: 'ADVANCE'|'REPAYMENT'; amount: number; source: string }[] }`. Aggregate from: (1) POSTED investment drafts (`listPostedLines`/drafts) with eventType `LOAN_ADVANCE` (advance) / `LOAN_REPAYMENT` (repayment) → party = investeeName, direction GRANTED, amount = engineFigures.functionalAmount; (2) POSTED `bankTransactions` with `postToCode` starting `032` (granted) or `2300` (borrowed) → party from description/counterparty. `outstanding = advanced − repaid`. Group by (party, direction, currency). Pure-ish (reads store); tested with seeded drafts.
- `loans.routes.ts` — `export const loansRouter: Router` (mounted at `/api/loans`): `GET /` → `loansReport()`.

### (e) UI — `public/*` (extend the existing page)
Add three new tabs to the existing "Books & reports" tabbed area (or a new top-level "Operations" tab group) — keep the calm style:
- **Bank**: a statement upload zone (CSV/PDF, multiple) → `POST /api/bank/upload`, then a per-bank-account view (account picker) showing the statement(s) with opening/closing + a **green "balances tie"** or **amber "doesn't tie (diff €X)"** footing badge, and a transactions table: date · description · money in · money out · running balance · **Post to** (the categorised account; if `status==='REVIEW'` show an editable account dropdown the user sets via `POST /transactions/:id/post-to`; if `AUTO` show it pre-filled with an "auto" tag and an Approve) · **linked document** (if `matchedDocumentId`, a small 📎 link to `/api/documents/{id}/file`). Plain-language summary after upload ("Read 2 statements · 1 new month added · May–June skipped (already loaded) · balances tie").
- **Debtors & Creditors**: an invoice/bill upload zone → `POST /api/aging/upload`, then two aging tables (Receivables, Payables) with the 5 buckets (Current · 1–30 · 31–60 · 61–90 · 90+) and a per-counterparty breakdown + totals, plus an "as at" date selector.
- **Loans**: a table of all loans by party (advanced / repaid / **outstanding**), expandable to the event history; totals.
All reuse the guarded `api()` helper, `?period=`/`?asOf=` where relevant, friendly empty states, defensive rendering. No CDNs.

**Verification (each agent):** `export PATH="/c/Users/user/Downloads/vacei-stack/.tools/node-v20.20.2-win-x64:$PATH"`; run your `node --import tsx --test <file>` tests; `npx tsc --noEmit 2>&1 | grep -i "<your dir>"` clean. Routers are exported but NOT mounted (controller mounts them) — so don't start the server. No commits (not a git repo).
