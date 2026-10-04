const a=process.argv[2];
const r=await fetch('https://api.mainnet-beta.solana.com',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'getAccountInfo',params:[a,{encoding:'base64'}]})}).then(r=>r.json());
const b=Buffer.from(r.result.value.data[0],'base64');console.log('vtok',b.readBigUInt64LE(8),'vquote',b.readBigUInt64LE(16),'rtok',b.readBigUInt64LE(24),'rquote',b.readBigUInt64LE(32),'supply',b.readBigUInt64LE(40),'complete',b[48]);
