const ws = new WebSocket('wss://pumpportal.fun/api/data');
let n=0;
ws.onopen=()=>{console.log('open');ws.send(JSON.stringify({method:'subscribeNewToken'}));ws.send(JSON.stringify({method:'subscribeMigration'}));};
ws.onmessage=(e)=>{n++; if(n<6) console.log(String(e.data).slice(0,700)); };
ws.onerror=(e)=>console.log('err',e.message||e);
setTimeout(()=>{console.log('msgs in 20s',n);process.exit(0)},20000);
