import fs from 'fs';
const ev=JSON.parse(fs.readFileSync('pp_events.json')).filter(e=>e.sig);
const out=[];
for(const e of ev){
  const r=await fetch('https://api.mainnet-beta.solana.com',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'getTransaction',params:[e.sig,{commitment:'confirmed',maxSupportedTransactionVersion:0,encoding:'json'}]})});
  const j=await r.json(); const bt=j.result?.blockTime; out.push({type:e.type,lag: bt? (e.t/1000-bt):null, slot:j.result?.slot, err:j.error?.message});
  await new Promise(r=>setTimeout(r,300));
}
const lags=out.filter(o=>o.lag!=null).map(o=>o.lag).sort((a,b)=>a-b);
console.log('n',lags.length,'missing',out.length-lags.length, 'errs', [...new Set(out.map(o=>o.err).filter(Boolean))]);
const q=p=>lags[Math.floor(p*(lags.length-1))];
console.log('min',lags[0]?.toFixed(2),'p50',q(.5)?.toFixed(2),'p90',q(.9)?.toFixed(2),'max',lags.at(-1)?.toFixed(2));
console.log('types',JSON.stringify(out.reduce((a,o)=>(a[o.type]=(a[o.type]||0)+1,a),{})));
