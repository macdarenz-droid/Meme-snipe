import fs from 'fs';
const DUR=240000; const pp={}, ppMint={}, ls={}; const jup={}, gt={}; let jupErr=0, gtErr=0, jupCalls=0, gtCalls=0;
const a=new WebSocket('wss://pumpportal.fun/api/data');
a.onopen=()=>{a.send(JSON.stringify({method:'subscribeNewToken'}));a.send(JSON.stringify({method:'subscribeMigration'}));};
a.onmessage=m=>{const d=JSON.parse(m.data); if(d.signature&&!pp[d.signature]){pp[d.signature]={t:Date.now(),type:d.txType,mint:d.mint}; if(d.mint&&!ppMint[d.mint]) ppMint[d.mint]={t:Date.now(),type:d.txType};}};
const b=new WebSocket('wss://api.mainnet-beta.solana.com');
b.onopen=()=>{b.send(JSON.stringify({jsonrpc:'2.0',id:1,method:'logsSubscribe',params:[{mentions:['6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P']},{commitment:'processed'}]}));};
b.onmessage=m=>{const d=JSON.parse(m.data); const v=d.params?.result?.value; if(!v) return; const c=v.logs.some(l=>/Program log: Instruction: Create(V2)?$/.test(l)); const mg=v.logs.some(l=>/Program log: Instruction: Migrate$/.test(l)); if((c||mg)&&!ls[v.signature]) ls[v.signature]={t:Date.now(),c,mg,err:!!v.err};};
async function pollJ(){ try{jupCalls++; const r=await fetch('https://api.jup.ag/tokens/v2/recent'); if(!r.ok){jupErr++;return;} const j=await r.json(); for(const t of j){ if(!jup[t.id]) jup[t.id]={t:Date.now(),created:t.firstPool?.createdAt};}}catch(e){jupErr++;} }
async function pollG(){ try{gtCalls++; const r=await fetch('https://api.geckoterminal.com/api/v2/networks/solana/new_pools'); if(!r.ok){gtErr++;return;} const j=await r.json(); for(const p of j.data){ const mint=p.relationships?.base_token?.data?.id?.replace('solana_',''); if(mint&&!gt[mint]) gt[mint]={t:Date.now(),created:p.attributes?.pool_created_at,dex:p.relationships?.dex?.data?.id};}}catch(e){gtErr++;} }
const ij=setInterval(pollJ,2500); const ig=setInterval(pollG,4000); pollJ(); pollG();
const start=Date.now();
setTimeout(()=>{clearInterval(ij);clearInterval(ig);a.close();b.close();
 const q=(d,p)=>d[Math.floor(p*(d.length-1))];
 const stats=d=>{d.sort((x,y)=>x-y); return d.length?{n:d.length,min:+d[0].toFixed(3),p10:+q(d,.1).toFixed(3),p50:+q(d,.5).toFixed(3),p90:+q(d,.9).toFixed(3),max:+d.at(-1).toFixed(3)}:{n:0}};
 const both=Object.keys(pp).filter(s=>ls[s]);
 const lsC=Object.entries(ls).filter(([s,v])=>v.c&&!v.err);
 // jupiter / gecko lag vs PumpPortal for mints first seen by PP after start (exclude initial snapshot)
 const late=(src)=>Object.entries(src).filter(([m,v])=>ppMint[m]).map(([m,v])=>(v.t-ppMint[m].t)/1000);
 const createdLag=(src)=>Object.values(src).filter(v=>v.created&&v.t-start>15000).map(v=>(v.t-Date.parse(v.created))/1000);
 console.log(JSON.stringify({durS:DUR/1000, pp:Object.keys(pp).length, ppTypes:Object.values(pp).reduce((a,o)=>(a[o.type]=(a[o.type]||0)+1,a),{}), lsCreatesOK:lsC.length, lsMigrates:Object.values(ls).filter(v=>v.mg).length, matched:both.length, ppMinusLs:stats(both.map(s=>(pp[s].t-ls[s].t)/1000)), lsCreateNotInPP:lsC.filter(([s])=>!pp[s]).length, ppNotInLs:Object.keys(pp).filter(s=>!ls[s]).length,
  jup:{calls:jupCalls,err:jupErr,uniq:Object.keys(jup).length, overlapWithPP:late(jup).length, lagVsPP:stats(late(jup)), lagVsFirstPoolCreatedAt:stats(createdLag(jup))},
  gt:{calls:gtCalls,err:gtErr,uniq:Object.keys(gt).length, dexes:Object.values(gt).reduce((a,o)=>(a[o.dex]=(a[o.dex]||0)+1,a),{}), overlapWithPP:late(gt).length, lagVsPP:stats(late(gt)), lagVsPoolCreatedAt:stats(createdLag(gt))}}));
 fs.writeFileSync('cmp2.json',JSON.stringify({pp,ls,jup,gt}));
 process.exit(0);},DUR);
