// Opening-balances HTTP routes. Mounted by the controller at /api/opening.
//
// A client who already keeps books can paste or upload their existing trial
// balance; the deterministic parser reads it, it must balance, and then it
// becomes the brought-forward starting position the autopilot builds on.

import { Router, type Request, type Response } from 'express';

import { parseTrialBalanceCsv } from './opening';
import {
  getOpeningBalance,
  setOpeningBalance,
  clearOpeningBalance,
  getSettings,
  listPeriods,
  setBooksOpeningDate,
  type OpeningBalanceRecord,
} from '../db/store';
import { accountName } from '../core/chart';
import { ensureAccount } from '../core/chart-store';

export const openingRouter: Router = Router();

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** The period the opening balances are brought forward into: an explicit valid
 *  request value, else the current working month, else the earliest period in
 *  the books, else a sensible default. */
function pickPeriod(requested: unknown): string {
  if (typeof requested === 'string' && /^\d{4}-\d{2}$/.test(requested)) return requested;
  const current = getSettings().currentPeriod;
  if (current && /^\d{4}-\d{2}$/.test(current)) return current;
  const periods = listPeriods();
  if (periods.length) return periods[0].period;
  return '2025-04';
}

function csvFrom(req: Request): string {
  const body = req.body ?? {};
  return typeof body.csv === 'string' ? body.csv : '';
}

// --- GET current opening balance -------------------------------------------
openingRouter.get('/', (_req: Request, res: Response) => {
  res.json({ openingBalance: getOpeningBalance() });
});

// --- POST preview (parse + validate, no commit) ----------------------------
openingRouter.post('/preview', (req: Request, res: Response) => {
  const csv = csvFrom(req);
  if (!csv.trim()) return res.status(400).json({ error: 'Paste or upload a trial balance first.' });
  res.json(parseTrialBalanceCsv(csv));
});

// --- POST commit ------------------------------------------------------------
openingRouter.post('/', (req: Request, res: Response) => {
  const csv = csvFrom(req);
  if (!csv.trim()) return res.status(400).json({ error: 'Paste or upload a trial balance first.' });

  const parsed = parseTrialBalanceCsv(csv);
  if (!parsed.rows.length) {
    return res.status(400).json({ error: 'No accounts were found in that trial balance.' });
  }
  if (!parsed.balanced) {
    return res.status(400).json({
      error: `That trial balance is out of balance by ${Math.abs(parsed.difference).toFixed(2)}. Debits must equal credits before it can be imported.`,
    });
  }

  const period = pickPeriod(req.body?.period);
  // Optional explicit opening cut-off date (the as-at date of these balances).
  // When omitted, getBooksOpeningDate derives it from `period` (day before it).
  const openingDate = req.body?.openingDate;
  if (typeof openingDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(openingDate)) {
    setBooksOpeningDate(openingDate);
  }
  const record: OpeningBalanceRecord = {
    period,
    importedAt: new Date().toISOString(),
    lines: parsed.rows.map((r) => {
      // Any account in the imported trial balance that we don't recognise is
      // created in the chart, so it carries its name everywhere from now on.
      const acct = ensureAccount(r.accountCode, r.accountName);
      return {
        accountCode: r.accountCode,
        accountName: r.accountName || acct.name || accountName(r.accountCode),
        amount: round2(r.debit - r.credit),
      };
    }),
  };
  setOpeningBalance(record);
  res.json({ openingBalance: record });
});

// --- DELETE clear -----------------------------------------------------------
openingRouter.delete('/', (_req: Request, res: Response) => {
  clearOpeningBalance();
  res.json({ ok: true });
});
