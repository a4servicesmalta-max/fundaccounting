// FX rates (CONTRACT §4). Loads the bundled ECB CSV (foreign-per-EUR) into RatePoints.

import * as fs from 'fs';
import * as path from 'path';
import type { RatePoint } from '../core/fx';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const RATES_FILE = path.join(DATA_DIR, 'ecb-rates.csv');

const SEED_CSV = `currency,date,rate
PLN,2024-12-02,4.28
USD,2024-12-02,1.05
GBP,2024-12-02,0.83
CHF,2024-12-02,0.93
`;

/** Write data/ecb-rates.csv with a minimal recent set if it is missing.
 *  Tolerant of a read-only filesystem (e.g. Vercel): if the file can't be
 *  written, callers fall back to the bundled SEED_CSV string. */
export function ensureRatesSeeded(): void {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (!fs.existsSync(RATES_FILE)) {
      fs.writeFileSync(RATES_FILE, SEED_CSV, 'utf8');
    }
  } catch {
    // read-only FS — loadRates() will use the in-memory seed instead.
  }
}

/** Read data/ecb-rates.csv → RatePoint[] (rate = foreign units per 1 EUR).
 *  Falls back to the bundled seed if the file can't be read (read-only FS). */
export function loadRates(): RatePoint[] {
  ensureRatesSeeded();
  let raw: string;
  try {
    raw = fs.readFileSync(RATES_FILE, 'utf8');
  } catch {
    raw = SEED_CSV;
  }
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const out: RatePoint[] = [];
  for (const line of lines) {
    // skip header
    const lower = line.toLowerCase();
    if (lower.startsWith('currency,')) continue;
    const [currency, date, rate] = line.split(',').map((c) => c.trim());
    if (!currency || !date || !rate) continue;
    const numRate = Number(rate);
    if (!Number.isFinite(numRate)) continue;
    out.push({ currency: currency.toUpperCase(), rateDate: new Date(date), rate: numRate });
  }
  return out;
}
