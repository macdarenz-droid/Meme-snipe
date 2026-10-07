// Measures, on public mainnet, how far the processed slot tip (slotSubscribe) is ahead of each confirmed
// logsSubscribe notification's slot when it arrives. LiveFeed releases slot S once tip >= S + 2 (horizonSlots 2).
import net from 'node:net'; import tls from 'node:tls'; import fs from 'node:fs'; import crypto from 'node:crypto';
const HOST = process.argv[2] ?? 'api.mainnet-beta.solana.com'; const MS = Number(process.argv[3] ?? 120000);
const PROGRAM = process.argv[4] ?? 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const proxy = new URL(process.env.HTTPS_PROXY);
const sock = net.connect(Number(proxy.port), proxy.hostname, () => sock.write(`CONNECT ${HOST}:443 HTTP/1.1\r\nHost: ${HOST}:443\r\n\r\n`));
let buf = Buffer.alloc(0);
sock.once('data', (d) => {
  if (!/ 200 /.test(d.toString().split('\r\n')[0])) { console.error('CONNECT failed', d.toString()); process.exit(1); }
  const t = tls.connect({ socket: sock, servername: HOST, ca: fs.readFileSync('/root/.ccr/ca-bundle.crt') }, () => {
    const key = crypto.randomBytes(16).toString('base64');
    t.write(`GET / HTTP/1.1\r\nHost: ${HOST}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  });
  let up = false; let tip = 0; const lags = []; let n = 0; const start = Date.now();
  const send = (o) => { const p = Buffer.from(JSON.stringify(o)); const mask = crypto.randomBytes(4); let h;
    if (p.length < 126) h = Buffer.from([0x81, 0x80 | p.length]); else { h = Buffer.alloc(4); h[0] = 0x81; h[1] = 0x80 | 126; h.writeUInt16BE(p.length, 2); }
    const m = Buffer.from(p.map((b, i) => b ^ mask[i % 4])); t.write(Buffer.concat([h, mask, m])); };
  const onMsg = (s) => { const o = JSON.parse(s);
    if (o.method === 'slotNotification') { if (o.params.result.slot > tip) tip = o.params.result.slot; }
    else if (o.method === 'logsNotification') { const S = o.params.result.context.slot; if (tip > 0 && o.params.result.value.err === null) { lags.push(tip - S); n++; } }
    else console.log('rpc', s.slice(0, 200)); };
  t.on('data', (d) => { buf = Buffer.concat([buf, d]);
    if (!up) { const i = buf.indexOf('\r\n\r\n'); if (i < 0) return; const head = buf.subarray(0, i).toString(); if (!/ 101 /.test(head)) { console.error(head); process.exit(1); }
      up = true; buf = buf.subarray(i + 4); send({ jsonrpc: '2.0', id: 1, method: 'slotSubscribe' }); send({ jsonrpc: '2.0', id: 2, method: 'logsSubscribe', params: [{ mentions: [PROGRAM] }, { commitment: process.argv[5] ?? 'confirmed' }] }); }
    for (;;) { if (buf.length < 2) return; let len = buf[1] & 0x7f; let off = 2; if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; } else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (buf.length < off + len) return; const op = buf[0] & 0x0f; const p = buf.subarray(off, off + len); buf = buf.subarray(off + len);
      if (op === 1) onMsg(p.toString()); else if (op === 9) { /* ping: ignore */ } else if (op === 8) { console.log('closed'); finish(); } } });
  const finish = () => { lags.sort((a, b) => a - b); const late = lags.filter((x) => x >= 2).length; const q = (p) => lags[Math.min(lags.length - 1, Math.floor(p * lags.length))];
    console.log(JSON.stringify({ host: HOST, seconds: (Date.now() - start) / 1000, notifications: n, lateAtHorizon2: late, lateShare: n ? +(late / n).toFixed(3) : null, p10: q(0.1), p50: q(0.5), p90: q(0.9), max: lags.at(-1), hist: Object.fromEntries([...new Set(lags)].map((k) => [k, lags.filter((x) => x === k).length])) }));
    process.exit(0); };
  setTimeout(finish, MS);
});
sock.on('error', (e) => { console.error('sock', e.message); process.exit(1); });
