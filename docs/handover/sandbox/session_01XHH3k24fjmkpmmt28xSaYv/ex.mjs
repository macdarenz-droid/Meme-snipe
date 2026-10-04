import fs from 'node:fs'; import zlib from 'node:zlib';
const U=process.argv[2];
for (const f of ['curve_trades','amm_trades']) {
  const t=zlib.zstdDecompressSync(fs.readFileSync(U+'/'+f+'.csv.zst')).toString().trim().split('\n'); const h=t[0].split(',');
  const i=h.indexOf('extra_hex'); const lens={}; const ex=[];
  for (const l of t.slice(1)) { const c=l.split(','); const x=c[c.length-(h.length-i)]; lens[x.length/2]=(lens[x.length/2]||0)+1; if(ex.length<4&&x) ex.push(x); }
  console.log(f,lens,ex);
}
const ev=zlib.zstdDecompressSync(fs.readFileSync(U+'/events.jsonl.zst')).toString().trim().split('\n').map(JSON.parse).filter(e=>e.event==='Unknown');
const by={}; for(const e of ev){(by[e.program+':'+e.discriminator]??=[]).push(e)}
for(const [k,v] of Object.entries(by)) console.log(k,v.length,v[0].data_hex.length/2,v[0].data_hex.slice(0,200), v[0].signature);
