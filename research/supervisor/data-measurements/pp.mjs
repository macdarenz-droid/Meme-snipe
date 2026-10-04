const ws = new WebSocket('wss://pumpportal.fun/api/data');
const t0=Date.now(); const ev=[];
ws.onopen=()=>{console.log('open',Date.now()-t0); ws.send(JSON.stringify({method:'subscribeNewToken'})); ws.send(JSON.stringify({method:'subscribeMigration'}));};
ws.onmessage=(m)=>{const d=JSON.parse(m.data); ev.push({t:Date.now(),sig:d.signature,type:d.txType,mint:d.mint,pool:d.pool, keys:Object.keys(d).join(',')});};
ws.onerror=(e)=>console.log('err',e.message||e);
setTimeout(()=>{ws.close(); require_out();},90000);
function require_out(){ import('fs').then(fs=>{fs.writeFileSync('pp_events.json',JSON.stringify(ev)); console.log('events',ev.length); console.log(JSON.stringify(ev.slice(0,3)));});}
