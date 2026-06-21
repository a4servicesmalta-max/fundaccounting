# Fund Autopilot — Ship status & go-live runbook

_Last updated by the autonomous run, 2026-06-21._

## ✅ LIVE — all three deliverables done (2026-06-21)
- **Live production URL: https://fundaccounting.vercel.app** — deployed to Vercel (project `fundaccounting`, status READY). `/api/health` → `{ok:true, aiConfigured:true, model:claude-opus-4-8}` (the AI key is configured in production). The root redirects to a working **sign-in page** (`THCP Autopilot — Sign in`) — the app is auth-gated, correct for a financial app handling client data.
- **GitHub: pushed** to `github.com/a4servicesmalta-max/fundaccounting` (private), `origin/main` == local. Latest commit `b7ad78a`.
- **Final working product:** 211/211 tests green, tsc clean; full 2022 reconciliation validated (TB ties €83,077,192.72, share capital exact, **P&L clean**); accounting test-and-fix loop verdict **shippable** (approval gate held on every ingest, 0 P1). 3 NEEDS-HUMAN judgement items in `qa/JE_LOOP_RESULTS.md`.
- **Sign-in:** the app now sits behind a login (added during deployment). Use your configured credentials. To redeploy after changes: `vercel deploy --prod` from this folder.
- **Persistence note:** if `STORAGE_DRIVER=supabase` is set in the Vercel env (with the Supabase keys), books + uploads persist via Supabase; otherwise the file driver is ephemeral on Vercel — run `supabase/setup.sql` and set the env vars (below) for durable storage.

---
## Original go-live runbook (for reference / re-deploy)

## What's done (the working product)
- Accounting engine, document intake, bank/AR-AP/loans, trust/audit layer, management accounts (P&L/BS), portfolio + month-close revaluation, FS report. 211 automated tests pass.
- Accounting correctness fixes this session: P&L account-typing (no more balance-sheet accounts as expenses), 9999 suspense out of P&L, materiality guard (a €5.88M "fee" no longer books as bank charges), SPA→typed-event rescue, reject-list hardening (BRA/registry extracts), GL-vs-bank reconciliation, fair-value remeasurement, tax flags, PCC net-zero, impossible-date flag. Trap scorecard ~11–13/13 (see `qa/RETEST_REPORT.md`).
- Hosting prep (by the migration): `STORAGE_DRIVER=supabase` driver (books → `app_kv` row, uploads → `documents` bucket), `vercel.json`, `api/index.ts`, `supabase/setup.sql`. Lazy DB path + isolated tests so tests never touch live data.
- **`.gitignore` hardened** so `.env` (your API key) and all of `data/` (real client financial docs) can never be committed. Verify with `git status` before pushing.

## Go-live — 3 steps

### 1. Supabase (persistent storage; Vercel's disk is ephemeral)
1. Create a project at https://supabase.com (or use your new account).
2. SQL Editor → paste & run `supabase/setup.sql` (creates the `app_kv` table + private `documents` bucket).
3. Project Settings → API: copy the **Project URL** and the **service_role key**.

### 2. GitHub (private repo — this is a financial app)
```
# from the project root:
git remote add origin https://github.com/<you>/<repo>.git   # create the repo PRIVATE first
git push -u origin master
```
(There was no remote configured and no `gh` available, so this is the one manual git step.)

### 3. Vercel (production URL)
Easiest: import the GitHub repo at https://vercel.com → it reads `vercel.json` automatically. Then set **Environment Variables** (Project → Settings → Environment Variables):
```
STORAGE_DRIVER     = supabase
SUPABASE_URL       = <your Project URL>
SUPABASE_SERVICE_KEY = <your service_role key>
SUPABASE_BUCKET    = documents
ANTHROPIC_API_KEY  = <your key>           # same one in your local .env
ANTHROPIC_MODEL    = claude-opus-4-8
```
Deploy → you get the production URL. (CLI alternative: `npx vercel link` then `npx vercel deploy --prod`, setting the same env vars.)

### Smoke test the live URL
- `https://<url>/api/health` → `{ok:true, aiConfigured:true}` (aiConfigured needs ANTHROPIC_API_KEY set).
- Open the URL → dashboard loads → upload a document → it routes/drafts.

## Loops running (validation — see qa/)
- **Loop A (reconciliation):** re-importing the full 2022 document set and grading the figures against the client's Excel baseline (`qa/THCP_2022_TB_BASELINE.json`). Result + any divergences → `qa/RECONCILIATION_2022.md`.
- **Loop B (accounting test-and-fix):** grading each document type's suggested entry against the THCP test-pack oracle and fixing defects → `qa/JE_LOOP_RESULTS.md`.

## Honest residual risk
- The figure-by-figure 2022 reconciliation completes when Loop A finishes; until then, the opening balances + capital reconcile exactly and the gaps are 2022 movements awaiting approval (human gate by design). See `qa/RECONCILIATION_2022.md`.
- One known production note: the app books bank to `1010` while the client's books use `130/101` — reconcile by value, or unify the cash code before relying on a like-for-like account match.
