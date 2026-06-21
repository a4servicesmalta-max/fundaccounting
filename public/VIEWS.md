# Fund Autopilot — Frontend rebuild contract (A4 redesign)

The full design spec is `C:\Users\user\Downloads\New\.fa_redesign\BLUEPRINT.md` (read your section there). Working reference of the OLD wired logic (proven fetch/render to reuse): `public_legacy/app.js`. Design tokens: `.fa_redesign/_ds/final-design-0cc26dad-bdd9-485f-8732-3528596e484f/colors_and_type.css`.

This file is the **integration boundary** between the app shell and the per-screen view modules. Build to it exactly.

## Architecture
- **Shell** = `public/index.html` + `public/styles.css` + `public/app.js`. Owns the sidebar, header, routing, design system, and a global `window.FA` runtime. Loads `styles.css`, then `app.js`, then each `views/*.js` via `<script>` tags (plain JS, no build/modules — each view file calls `FA.registerView(...)` at load).
- **Views** = `public/views/<name>.js`, one per screen: `overview, documents, review, bank, aging, loans, books, settings`. Each registers itself and renders into a mount element. **No two agents share a file.**

## `window.FA` runtime (the shell provides; views consume)
```
FA.registerView(name, { label, render })   // render(mount, ctx): build DOM into mount (already cleared). may be async.
FA.el(tag, attrs?, ...children)             // DOM builder. attrs: {class, id, onclick, href, type, value, placeholder, html, title, ...}. children: string|Node|array (falsy skipped). html:'<...>' sets innerHTML.
FA.api(path, opts?)                         // fetch -> parsed JSON; NEVER throws; returns {error:'...'} on failure. opts pass through to fetch (method, body, headers). For JSON body pass {json: obj}.
FA.money(n, currency='EUR')                 // "€1,234.56" ; FA.num(n) "1,234.56" ; FA.pct(n) "63.6%"
FA.monthLabel('2025-04')                    // "April 2025"  ; FA.fmtDate('2025-04-05') "5 Apr 2025"
FA.state.period                             // 'all' | 'YYYY-MM' (the active period filter)
FA.setPeriod(p)                             // sets period + re-renders current view + refreshes chrome
FA.onPeriodChange(cb)                       // register a callback
FA.state.health                             // { aiConfigured:boolean, model:string } (kept fresh)
FA.navigate(name)                           // switch view (updates sidebar active + renders)
FA.refreshChrome()                          // re-pull /api/health + sidebar badge counts (review pending, bank needs)
FA.toast(msg, kind='info'|'success'|'warn'|'error')
FA.confirmAction(msg) -> Promise<boolean>   // styled confirm modal
FA.icon(name)                               // returns inline-SVG string for: overview, documents, bank, review, loans, aging, books, settings, help, logout, search, bell, chevron, plus, upload, check, arrow, paperclip, clock, x
FA.periodQuery()                            // '' or '?period=YYYY-MM' for appending to endpoints
```
`FA.api` example: `const r = await FA.api('/api/drafts?status=PENDING' + (FA.state.period!=='all'?'&period='+FA.state.period:''));`

## Design system (styles.css defines these classes; views just apply them)
Tokens come from `colors_and_type.css` (import it) PLUS: `--lime:#c7ef3e; --lime-deep:#b2da2a; --lime-ink:#1d2600`. Brand `--primary:#494fdf`. Sidebar black `#000`, active nav bg `#16181a` with `inset 3px 0 0 var(--lime)`. Fonts: `--font-display` (General Sans) for headings/numbers, `--font-body` (Inter) for text. Card radius 20px, pill 9999px, input/nav 12px.

Class vocabulary (shell implements; views reuse — do NOT invent parallel classes):
- Layout: `.app` (grid: 256px 1fr), `.sidebar`, `.nav-group`, `.nav-group-label`, `.nav-item` (+`.active`), `.nav-badge` (+`.warn` orange / `.lime`), `.topbar`, `.main`, `.view`.
- Cards/sections: `.card`, `.card-pad` (22–24px), `.section-title` (display 20px), `.section-help` (muted), `.muted`, `.row` (flex), `.spread` (flex space-between), `.grid-2`, `.grid-3`, `.grid-4`, `.right-rail` (360px).
- KPI: `.kpi` (+`.kpi-primary` cobalt bg / white text), `.kpi-num` (display 40px), `.kpi-label`, `.kpi-delta` (+`.up` green / `.flat`).
- Tables: `.tbl` (width:100%), `thead th` styled (uppercase 11.5px ash), `tbody tr` hairline rows + hover; `.t-right` right-align; `.num` tabular figures.
- Badges/tags/pills: `.badge` (+`.lime` "Posted"/balanced, `.dark` "Pending", `.warn` amber, `.blue`, `.green`, `.muted`), `.tag-airead` (cobalt-tint "AI read"), `.tag-calc` (lime-tint "we calculated"), `.pill` (status pill; `.pill-ok` green dot / `.pill-missing` red dot), `.chip` (confidence).
- Buttons: `.btn` + `.btn-dark` (black), `.btn-primary` (cobalt), `.btn-secondary` (soft), `.btn-ghost` (outline), `.btn-sm`. Pills by default (radius 9999px).
- Inputs: `.input`, `.select`, `.search`.
- Misc: `.dropzone`, `.tabs`/`.tab` (+`.active`), `.avatar` (initials, rounded 11px, colored), `.dropdown`/`.dropdown-menu`, `.banner`/`.banner-warn`, `.empty` (empty state), `.footing-ok` (lime) / `.footing-bad` (amber), `.spinner`.

## index.html shell structure (shell agent builds)
- `<aside class="sidebar">`: brand (a4 logo `assets/a4-logo.png` + "Fund Autopilot" / "An A4 product"); nav groups WORKSPACE (Overview, Documents, Bank statements [badge `#bankBadge`], Review [badge `#reviewBadge`]), LEDGERS (Loans, Aging, Books & reports), GENERAL (Settings, Help & support); bottom: AI-reader status block `#aiStatus` (lime dot + "AI reader connected"/"Reading documents live" when `health.aiConfigured`, else amber + "AI not connected"), and a "Start over" item (`/api/reset`, confirm). Each nav item: `<a class="nav-item" data-view="bank">` + `FA.icon(...)` + label + optional badge span.
- `<header class="topbar">`: greeting `#greeting` ("Good evening" by time of day, generic — single-user, no name needed; subtitle "Here's where your fund stands today."); search input (cosmetic placeholder "Search documents, accounts…", non-functional, title="Search is coming soon"); bell button (cosmetic, shows a dot when there are pending reviews); a small generic avatar (initials "FA" or the `assets/avery-avatar.png`) — cosmetic, single-user.
- `<main class="main"><div id="view" class="view"></div></main>` + the `#keyHint` banner (shown when `!health.aiConfigured`).

## Per-view assignment + endpoints (views agents)
- `overview.js` → `GET /api/overview` (NEW: shell agent adds it server-side; returns the KPIs + holdings + allocation + recent docs + nav chart series). Hero (static copy ok), 4 KPI tiles, NAV chart, Holdings + Allocation right rail, Recent documents table. Buttons route via `FA.navigate('review'|'bank'|'documents'|'books')`.
- `documents.js` → `GET /api/documents`, upload via `POST /api/upload` (multipart files[]; reuse legacy dropzone logic). List documents as rows with classification badge + a link to `/api/documents/:id/file` when `storedPath`.
- `review.js` → `GET /api/drafts?status=PENDING` (+period); per-draft "AI read vs we calculated" card (reuse legacy review card incl. fx line + doc preview), Approve `POST /api/drafts/:id/approve`, Reject `.../reject`, Approve all.
- `bank.js` → `GET /api/bank/accounts`, `/api/bank/statements`, `/api/bank/transactions?accountId=&period=&status=`; account selector cards, balance tiles + footing badge, dedup notice, transactions table with Post-to (`POST /api/bank/transactions/:id/post-to {code}`) for REVIEW / Approve (`/approve`) for AUTO, matched-doc 📎 link, and a document preview pane. Bank statement upload `POST /api/bank/upload`.
- `aging.js` → `GET /api/aging?asOf=`; tabs Receivables/Payables, 5 buckets, per-counterparty rows, totals; upload invoices/bills `POST /api/aging/upload`; "as at" date input.
- `loans.js` → `GET /api/loans`; loans-by-party table (advanced/repaid/outstanding), expandable event history, totals.
- `books.js` → `GET /api/report/portfolio|ledger|trial-balance` (+period) + the period toolbar (`GET /api/periods`, `POST /api/period`, "Start new month"); tabs + Download CSV (`/api/export/:type`).
- `settings.js` → REAL: shows `health` (AI connected? model), the `.env` instructions when not connected, period management (current period, start new month), and a destructive "Start over" (`POST /api/reset`). Help & support nav → a simple static help panel (can live in settings.js or its own; keep it simple).

## Verify (all agents)
`export PATH="/c/Users/user/Downloads/vacei-stack/.tools/node-v20.20.2-win-x64:$PATH"`. `npx tsc --noEmit` stays clean (only server.ts changes for /api/overview). `node --check public/<file>.js` for JS. Don't start the server (controller restarts the preview). Not a git repo — no commits. Match the BLUEPRINT visually; reuse `public_legacy/app.js` logic; keep it defensive (guard missing data) and non-technical in tone.
