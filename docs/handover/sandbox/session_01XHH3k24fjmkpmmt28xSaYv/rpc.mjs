const U='https://api.mainnet-beta.solana.com';
async function call(url,method,params){const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});const j=await r.json().catch(()=>({}));return {s:r.status,h:Object.fromEntries([...r.headers].filter(([k])=>/ratelimit|retry/.test(k))),j};}
const P='6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
let before;let prev=null;
for(let i=0;i<4;i++){const r=await call(U,'getSignaturesForAddress',[P,{limit:1000,...(before?{before}:{})}]);
 if(!r.j.result){console.log('page',i,r.s,JSON.stringify(r.j).slice(0,300),JSON.stringify(r.h));break;}
 const a=r.j.result;console.log('page',i,r.s,a.length,'newest',a[0].slot,new Date(a[0].blockTime*1000).toISOString(),'oldest',a.at(-1).slot,new Date(a.at(-1).blockTime*1000).toISOString(),'mlimit',r.h['x-ratelimit-method-limit'],r.h['x-ratelimit-method-remaining']);before=a.at(-1).signature;}
const now=452944793;
for(const [n,d] of [['30d',30],['60d',60]]){
 let slot=now-Math.round(d*86400/0.4);
 for(let k=0;k<30;k++){const r=await call(U,'getBlock',[slot,{maxSupportedTransactionVersion:0,transactionDetails:'signatures',rewards:false}]);
  if(r.j.result){const b=r.j.result;console.log(n,'slot',slot,new Date(b.blockTime*1000).toISOString(),'sigs',b.signatures.length,'sample',b.signatures[0]);break;}
  else {console.log(n,'slot',slot,JSON.stringify(r.j.error||r.j).slice(0,200));if(r.j.error&&r.j.error.code==-32009||r.j.error?.code==-32007)slot++;else break;}
 }}
