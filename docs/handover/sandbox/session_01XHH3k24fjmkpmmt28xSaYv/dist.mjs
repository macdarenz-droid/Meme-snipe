import fs from 'node:fs'; import zlib from 'node:zlib';
const U=process.argv[2];
const rd=f=>zlib.zstdDecompressSync(fs.readFileSync(U+'/'+f)).toString().trim().split('\n');
const cnt=(lines,col)=>{const h=lines[0].split(',');const i=h.indexOf(col);const m=new Map();for(const l of lines.slice(1)){const k=l.split(',')[i];m.set(k,(m.get(k)||0)+1)}return m};
const c=cnt(rd('curve_trades.csv.zst'),'mint'), a=cnt(rd('amm_trades.csv.zst'),'base_mint');
for(const [name,m] of [['curve',c],['amm',a]]){const v=[...m.values()].sort((x,y)=>y-x);const tot=v.reduce((s,x)=>s+x,0);
 console.log(name,'mints',m.size,'trades',tot,'top10 share',(v.slice(0,10).reduce((s,x)=>s+x,0)/tot).toFixed(3),'top100',(v.slice(0,100).reduce((s,x)=>s+x,0)/tot).toFixed(3),'median',v[v.length>>1]);}
const ev=rd('events.jsonl.zst').map(l=>JSON.parse(l));const ec={};for(const e of ev)ec[e.event]=(ec[e.event]||0)+1;console.log(ec);
const created=new Set(ev.filter(e=>e.event==='CreateEvent').map(e=>e.fields.mint));
let ct=0,at=0;for(const [k,v] of c) if(created.has(k)) ct+=v; for(const [k,v] of a) if(created.has(k)) at+=v;
console.log('created in unit',created.size,'their curve trades',ct,'amm trades',at);
