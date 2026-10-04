import fs from 'fs';
const RPC='https://api.mainnet-beta.solana.com';
const r = JSON.parse(fs.readFileSync('blk-448000001.json')).result;
// a signature from block 448000001 (last tx) to page backwards
const lastTx = r.transactions[r.transactions.length-1];
const bs58 = s=>s; 
// signature is first 64 bytes of base64 wire tx after shortvec count
const buf = Buffer.from(lastTx.transaction[0],'base64');
const ALPH='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58(b){let x=BigInt('0x'+b.toString('hex'));let s='';while(x>0n){s=ALPH[Number(x%58n)]+s;x/=58n;}for(const c of b){if(c===0)s='1'+s;else break;}return s;}
const sig=b58(buf.subarray(1,65));
for (const [name,prog] of [['pump','6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'],['amm','pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA']]) {
  const res = await (await fetch(RPC,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'getSignaturesForAddress',params:[prog,{before:sig,limit:1000}]})})).json();
  const bySlot={};
  for (const x of res.result) bySlot[x.slot]=(bySlot[x.slot]||0)+1;
  console.log(name, 'first sig slot', res.result[0].slot, 'counts by slot', JSON.stringify(bySlot).slice(0,400));
  await new Promise(r=>setTimeout(r,1500));
}
