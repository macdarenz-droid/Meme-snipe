import fs from 'node:fs'; import zlib from 'node:zlib';
const [ds,pool]=process.argv.slice(2);
const d=ds+'/days/2026-10-02/';
const ev=zlib.zstdDecompressSync(fs.readFileSync(d+'events-000.jsonl.zst')).toString().trim().split('\n').map(JSON.parse).filter(e=>e.fields?.pool===pool);
const t=zlib.zstdDecompressSync(fs.readFileSync(d+'amm_trades-000.csv.zst')).toString().trim().split('\n');const h=t[0].split(',');
const rows=t.slice(1).map(l=>Object.fromEntries(l.split(',').map((v,i)=>[h[i],v]))).filter(r=>r.pool===pool);
const all=[...ev.map(e=>({k:[e.slot,e.tx_idx,e.ev_idx],s:e.event+' '+JSON.stringify(e.fields)})),...rows.map(r=>({k:[+r.slot,+r.tx_idx,+r.ev_idx],s:`${r.side} base=${r.base_amount} adj=${r.quote_amount_lp_adjusted} pre=${r.pool_base_token_reserves}/${r.pool_quote_token_reserves} vq=${r.virtual_quote_reserves} chain=${r.chain_pool_base}/${r.chain_pool_quote}`}))];
all.sort((a,b)=>a.k[0]-b.k[0]||a.k[1]-b.k[1]||a.k[2]-b.k[2]);
for(const x of all.slice(0,+process.argv[4]||30)) console.log(x.k.join(':'),x.s.slice(0,400));
