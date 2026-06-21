import * as fs from 'fs';
import * as path from 'path';
const dir=process.argv[2];
const files=fs.readdirSync(dir).filter(f=>/\.pdf$/i.test(f)).map(f=>path.join(dir,f));
for(const f of files){
  const fd=new FormData(); fd.append('files', new Blob([fs.readFileSync(f)],{type:'application/pdf'}), path.basename(f));
  const t0=Date.now();
  try{
    const d=await (await fetch('http://localhost:4350/api/upload',{method:'POST',body:fd})).json();
    const o=(d.events||[]).concat(d.arap||[],d.bank||[],d.evidence||[],d.duplicates||[],d.errors||[]);
    const kinds=['events','arap','bank','evidence','duplicates','errors'].filter(k=>(d[k]||[]).length).map(k=>k+':'+d[k].length).join(' ');
    console.log(`${path.basename(f).slice(0,42)} (${Math.round((Date.now()-t0)/1000)}s): ${kinds} | msg="${(o[0]&&o[0].message||'').slice(0,70)}"`);
  }catch(e){ console.log(`${path.basename(f)} FAILED ${e.message}`); }
}
