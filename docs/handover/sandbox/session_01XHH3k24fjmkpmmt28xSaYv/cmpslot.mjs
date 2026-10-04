import fs from 'node:fs'; import zlib from 'node:zlib';
const [a,b,slotsArg]=process.argv.slice(2); const slots=new Set(slotsArg.split(','));
const read=(d,f)=>{try{return zlib.zstdDecompressSync(fs.readFileSync(`${d}/${f}.zst`)).toString().split('\n').filter(Boolean)}catch{return null}};
for (const f of ['blocks.csv','curve_trades.csv','amm_trades.csv','failed.csv','movements.csv','raw.jsonl','events.jsonl','agg_hourly.csv','movement_coverage.csv']) {
  const A=read(a,f), B=read(b,f); if(!A||!B){console.log(f,'missing',!!A,!!B);continue}
  const csv=f.endsWith('.csv'); const keep=(L)=>csv?L.slice(1).filter(l=>slots.has(l.split(',')[0])||f.startsWith('agg')||f.startsWith('movement_cov')):L.filter(l=>slots.has(String(JSON.parse(l).slot)));
  const hA=csv?A[0]:'', hB=csv?B[0]:'';
  const x=keep(A).sort(), y=keep(B).sort();
  const sx=new Set(x), sy=new Set(y);
  const onlyA=x.filter(l=>!sy.has(l)), onlyB=y.filter(l=>!sx.has(l));
  console.log(f, 'header', hA===hB?'same':'DIFF', 'rows', x.length, y.length, 'onlyA', onlyA.length, 'onlyB', onlyB.length);
  if (onlyA.length && !f.startsWith('agg') && !f.startsWith('movement_cov')) { console.log('  A:', onlyA[0].slice(0,600)); console.log('  B:', (onlyB[0]||'').slice(0,600)); }
}
