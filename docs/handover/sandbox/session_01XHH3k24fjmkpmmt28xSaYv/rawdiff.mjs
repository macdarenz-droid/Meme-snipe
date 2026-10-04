import fs from 'node:fs'; import zlib from 'node:zlib';
const [a,b,slot]=process.argv.slice(2);
const rd=d=>zlib.zstdDecompressSync(fs.readFileSync(`${d}/raw.jsonl.zst`)).toString().split('\n').filter(Boolean).map(JSON.parse).filter(r=>String(r.slot)===slot);
const A=new Map(rd(a).map(r=>[r.signature,r])), B=new Map(rd(b).map(r=>[r.signature,r]));
const diff=(x,y,p)=>{ if (JSON.stringify(x)===JSON.stringify(y)) return; if (x&&y&&typeof x==='object'&&typeof y==='object'){ for (const k of new Set([...Object.keys(x),...Object.keys(y)])) diff(x[k],y[k],p+'.'+k); } else console.log(' ',p,'OF=',JSON.stringify(x)?.slice(0,200),'RPC=',JSON.stringify(y)?.slice(0,200)); };
for (const [s,r] of A) { if (JSON.stringify(r)!==JSON.stringify(B.get(s))) { console.log(slot, s.slice(0,12)); diff(r,B.get(s),''); } }
