// Bulk-load a folder of client documents into the running portal (localhost:4350).
// Bank statements go through the deterministic /api/bank/upload; everything else
// through the general /api/upload (which routes to AR/AP, investment events,
// suggested journals, or the reject list).  Usage: node scripts/bulk-upload.mjs <folder>
import * as fs from 'fs';
import * as path from 'path';

const ROOT = process.argv[2] || 'C:/Users/user/Downloads/client-data-2021';
function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.pdf$/i.test(e.name)) out.push(p);
  }
  return out;
}
const all = walk(ROOT, []);
const isStmt = (f) => { const n = path.basename(f); return /bendura/i.test(n) || /santander\s+(bs|banking statement)/i.test(n); };
const stmts = all.filter(isStmt);
const others = all.filter((f) => !isStmt(f));
console.log(`statements: ${stmts.length}, others: ${others.length}`);
const totals = { bankTxns: 0, arap: 0, events: 0, dup: 0, err: 0, evidence: 0 };

for (const f of stmts) {
  const fd = new FormData();
  fd.append('files', new Blob([fs.readFileSync(f)], { type: 'application/pdf' }), path.basename(f));
  const t0 = Date.now();
  try {
    const d = await (await fetch('http://localhost:4350/api/bank/upload', { method: 'POST', body: fd })).json();
    const added = (d.results || []).reduce((s, r) => s + (Number(r.added) || 0), 0);
    totals.bankTxns += added;
    console.log(`STMT ${path.basename(f).slice(0, 44)} (${Math.round((Date.now() - t0) / 1000)}s): +${added} txns, statementsRead ${d.statementsRead || 0}`);
  } catch (e) { console.log(`STMT ${path.basename(f)} FAILED: ${e.message}`); }
}
const B = 4;
for (let i = 0; i < others.length; i += B) {
  const slice = others.slice(i, i + B);
  const fd = new FormData();
  for (const f of slice) fd.append('files', new Blob([fs.readFileSync(f)], { type: 'application/pdf' }), path.basename(f));
  const t0 = Date.now();
  try {
    const d = await (await fetch('http://localhost:4350/api/upload', { method: 'POST', body: fd })).json();
    totals.arap += (d.arap || []).length; totals.events += (d.events || []).length;
    totals.dup += (d.duplicates || []).length; totals.err += (d.errors || []).length; totals.evidence += (d.evidence || []).length;
    console.log(`batch ${i / B + 1}/${Math.ceil(others.length / B)} (${Math.round((Date.now() - t0) / 1000)}s): arap+${(d.arap || []).length} events+${(d.events || []).length} evidence+${(d.evidence || []).length} dup+${(d.duplicates || []).length} err+${(d.errors || []).length} | ${JSON.stringify(totals)}`);
  } catch (e) { console.log(`batch ${i / B + 1} FAILED: ${e.message}`); }
}
console.log('DONE', JSON.stringify(totals));
