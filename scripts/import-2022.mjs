// Full 2022 acceptance-test import into the running app (localhost:4350).
// Flow: reset → import 2021-closing opening balances → bank statements
// (Bendura PDF + Santander/PKO CSV) → all other 2022 docs in batches.
// Logs progress to scripts/import-2022.log. Run: node scripts/import-2022.mjs
import * as fs from 'fs';
import * as path from 'path';

const BASE = 'http://localhost:4350';
const ROOT = 'C:/Users/user/Downloads/supdocs-full/Supporting Documents';
const LOG = path.resolve('scripts/import-2022.log');
function log(s) { const line = `[${new Date().toISOString()}] ${s}`; fs.appendFileSync(LOG, line + '\n'); console.log(line); }
fs.writeFileSync(LOG, '');

const SKIP_DIR = /(DO Not Use)/i;
const SKIP_FILE = /\.(xlsx|xls)$/i; // the client's working books are OUTPUT, not input
function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIR.test(e.name)) walk(p, out); }
    else if (!SKIP_FILE.test(e.name)) out.push(p);
  }
  return out;
}

function isBankStatement(f) {
  const p = f.replace(/\\/g, '/').toLowerCase();
  return p.includes('/bank statements/') || /bendura|santander|historia rachunku/i.test(path.basename(f));
}
function mimeFor(f) {
  const e = path.extname(f).toLowerCase();
  return e === '.pdf' ? 'application/pdf' : e === '.csv' ? 'text/csv'
    : e === '.png' ? 'image/png' : /\.jpe?g$/.test(e) ? 'image/jpeg'
    : e === '.docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'application/octet-stream';
}

async function main() {
  // 1. Reset.
  await fetch(`${BASE}/api/reset`, { method: 'POST' });
  log('reset done');

  // 2. Opening balances from the 2021 closing TB.
  const csv = fs.readFileSync(path.resolve('data/opening-2021.csv'), 'utf8');
  const prev = await (await fetch(`${BASE}/api/opening/preview`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ csv }) })).json();
  log(`opening preview: balanced=${prev.balanced} lines=${(prev.lines || prev.rows || []).length || 'n/a'}`);
  const imp = await (await fetch(`${BASE}/api/opening`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ csv }) })).json();
  log(`opening import: ${JSON.stringify(imp).slice(0, 200)}`);

  // 3. Gather + classify files.
  const all = walk(ROOT, []);
  const stmts = all.filter(isBankStatement);
  const others = all.filter((f) => !isBankStatement(f));
  log(`files: ${all.length} (statements ${stmts.length}, others ${others.length})`);

  // Bank statements one at a time (each can be large).
  let bankTxns = 0;
  for (const f of stmts) {
    const fd = new FormData();
    fd.append('files', new Blob([fs.readFileSync(f)], { type: mimeFor(f) }), path.basename(f));
    const t0 = Date.now();
    try {
      const d = await (await fetch(`${BASE}/api/bank/upload`, { method: 'POST', body: fd })).json();
      const added = (d.results || []).reduce((s, r) => s + (Number(r.added) || 0), 0);
      bankTxns += added;
      log(`STMT ${path.basename(f).slice(0, 46)} (${Math.round((Date.now() - t0) / 1000)}s): +${added} txns`);
    } catch (e) { log(`STMT ${path.basename(f)} FAILED: ${e.message}`); }
  }
  log(`bank txns total: ${bankTxns}`);

  // Other docs ONE PER REQUEST with a generous timeout — batching large bilingual
  // SPAs caused undici body-timeouts that killed the run.
  const totals = { arap: 0, events: 0, evidence: 0, dup: 0, err: 0, fail: 0 };
  const withTimeout = async (url, opts, ms) => {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), ms);
    try { return await fetch(url, { ...opts, signal: ctrl.signal }); } finally { clearTimeout(t); }
  };
  for (let i = 0; i < others.length; i++) {
    const f = others[i];
    const fd = new FormData();
    fd.append('files', new Blob([fs.readFileSync(f)], { type: mimeFor(f) }), path.basename(f));
    const t0 = Date.now();
    try {
      const d = await (await withTimeout(`${BASE}/api/upload`, { method: 'POST', body: fd }, 540000)).json();
      totals.arap += (d.arap || []).length; totals.events += (d.events || []).length;
      totals.evidence += (d.evidence || []).length; totals.dup += (d.duplicates || []).length; totals.err += (d.errors || []).length;
      log(`${i + 1}/${others.length} ${path.basename(f).slice(0, 40)} (${Math.round((Date.now() - t0) / 1000)}s): ${JSON.stringify(totals)}`);
    } catch (e) { totals.fail++; log(`${i + 1}/${others.length} ${path.basename(f).slice(0, 40)} FAILED: ${e.message}`); }
  }
  log(`DONE others. totals ${JSON.stringify(totals)}`);
}
main().then(() => log('IMPORT COMPLETE')).catch((e) => log('IMPORT ERROR: ' + e.message));
