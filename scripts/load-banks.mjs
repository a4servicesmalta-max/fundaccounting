import * as fs from 'fs';
const files = process.argv.slice(2);
for (const f of files){
  const fd = new FormData();
  fd.append('files', new Blob([fs.readFileSync(f)], {type:'text/csv'}), f.split('/').pop());
  const t0=Date.now();
  const d = await (await fetch('http://localhost:4350/api/bank/upload',{method:'POST',body:fd})).json();
  console.log(`${f.split('/').pop()} (${Math.round((Date.now()-t0)/1000)}s): statementsRead=${d.statementsRead} added=${(d.results||[]).reduce((s,r)=>s+(Number(r.added)||0),0)} ${d.error||''}`);
}
const acc = (await (await fetch('http://localhost:4350/api/bank/accounts')).json()).accounts||[];
for (const a of acc){
  const st = (await (await fetch('http://localhost:4350/api/bank/statements?accountId='+a.id)).json()).statements||[];
  const last = st.sort((x,y)=>String(x.periodEnd).localeCompare(String(y.periodEnd))).pop();
  console.log(`ACCOUNT ${a.bankName} | ${a.currency} | closing=${last?last.closingBalance:'?'}`);
}
