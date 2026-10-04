const [acct, after] = process.argv.slice(2);
const r = await fetch('https://api.mainnet-beta.solana.com',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'getSignaturesForAddress',params:[acct,{limit:25}]})}).then(r=>r.json());
for (const s of r.result.filter(s=>s.slot>=+after)) console.log(s.slot, s.err?'FAIL':'ok', s.signature);
