// Resume the 2022 import: process ONLY the documents not already in the store,
// one per request with a generous timeout (avoids the undici body-timeout that
// killed batches of large SPAs). Bank statements are already loaded. Appends to
// scripts/import-2022.log. Run: node scripts/resume-import-2022.mjs
import * as fs from 'fs';
import * as path from 'path';

const BASE = 'http://localhost:4350';
const ROOT = 'C:/Users/user/Downloads/supdocs-full/Supporting Documents';
const LOG = path.resolve('scripts/import-2022.log');
function log(s) { const l = `[${new Date().toISOString()}] RESUME ${s}`; fs.appendFileSync(LOG, l + '\n'); console.log(l); }

const SKIP_DIR = /(DO Not Use)/i;
const SKIP_FILE = /\.(xlsx|xls)$/i;
function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIR.test(e.name)) walk(p, out); }
    else if (!SKIP_FILE.test(e.name)) out.push(p);
  }
  return out;
}
const isBank = (f) => f.replace(/\\/g, '/').toLowerCase().includes('/bank statements/') || /bendura|santander|historia rachunku/i.test(path.basename(f));
const mimeFor = (f) => { const e = path.extname(f).toLowerCase(); return e === '.pdf' ? 'application/pdf' : e === '.csv' ? 'text/csv' : e === '.png' ? 'image/png' : /\.jpe?g$/.test(e) ? 'image/jpeg' : e === '.docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'application/octet-stream'; };

async function fetchWithTimeout(url, opts, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(t); }
}

async function main() {
  const docs = await (await fetch(`${BASE}/api/documents`)).json();
  const done = new Set((docs.documents || []).map((d) => (d.fileName || '').toLowerCase()));
  const all = walk(ROOT, []).filter((f) => !isBank(f));
  const todo = all.filter((f) => !done.has(path.basename(f).toLowerCase()));
  log(`already processed ${done.size} docs; ${todo.length} remaining to import`);

  const totals = { arap: 0, events: 0, evidence: 0, dup: 0, err: 0, fail: 0 };
  for (let i = 0; i < todo.length; i++) {
    const f = todo[i];
    const fd = new FormData();
    fd.append('files', new Blob([fs.readFileSync(f)], { type: mimeFor(f) }), path.basename(f));
    const t0 = Date.now();
    try {
      const d = await (await fetchWithTimeout(`${BASE}/api/upload`, { method: 'POST', body: fd }, 540000)).json();
      totals.arap += (d.arap || []).length; totals.events += (d.events || []).length;
      totals.evidence += (d.evidence || []).length; totals.dup += (d.duplicates || []).length; totals.err += (d.errors || []).length;
      log(`${i + 1}/${todo.length} ${path.basename(f).slice(0, 42)} (${Math.round((Date.now() - t0) / 1000)}s) ${JSON.stringify(totals)}`);
    } catch (e) { totals.fail++; log(`${i + 1}/${todo.length} ${path.basename(f).slice(0, 42)} FAILED: ${e.message}`); }
  }
  log(`RESUME DONE ${JSON.stringify(totals)}`);
}
main().then(() => log('RESUME COMPLETE')).catch((e) => log('RESUME ERROR ' + e.message));
