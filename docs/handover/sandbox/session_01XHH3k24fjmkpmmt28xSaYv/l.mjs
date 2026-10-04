import fs from 'node:fs'; import zlib from 'node:zlib'; import path from 'node:path';
const JUP='JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const A='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const enc=(b)=>{let n=0n;for(const x of b)n=n*256n+BigInt(x);let s='';while(n>0n){s=A[Number(n%58n)]+s;n/=58n}for(const x of b){if(x)break;s='1'+s}return s};
const files=process.argv.slice(2);let n=0,withInner=0,none=0,empty=0,ex=null;
for(const f of files)for(const l of zlib.zstdDecompressSync(fs.readFileSync(f)).toString().split('\n').filter(Boolean)){
 const r=JSON.parse(l); if(!r.err)continue; const tx=Buffer.from(r.transaction,'base64');
 const jup=Buffer.from(JUP); // check by key bytes
 const keyHit=(()=>{const k=enc;return false})();
 // search raw key bytes of JUP
 const dec=(s)=>{let n=0n;for(const c of s)n=n*58n+BigInt(A.indexOf(c));let h=n.toString(16).padStart(64,'0');return Buffer.from(h,'hex')};
 if(!tx.includes(dec(JUP)) && !(r.meta.loadedAddresses.readonly||[]).includes(JUP))continue;
 n++; const ii=r.meta.innerInstructions; if(ii===null)none++; else if(ii.length===0)empty++; else {withInner++; if(!ex)ex={sig:r.signature,slot:r.slot,groups:ii.length,inner:ii.reduce((s,g)=>s+g.instructions.length,0),err:r.err,logs:(r.meta.logMessages||[]).slice(-3)}}
}
console.log(JSON.stringify({failed_jupiter_txs:n,with_inner:withInner,inner_empty:empty,inner_null:none,example:ex},null,1));
