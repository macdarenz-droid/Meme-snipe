// Live, survivorship-free trade stream for the pump.fun ecosystem (free, no key).
// Subscribes to public RPC logsSubscribe for the pump.fun bonding-curve program and the PumpSwap AMM program
// (commitment confirmed), decodes Anchor events from "Program data:" logs and writes compact records.
// Records (jsonl.gz, rotated every 30 min, data/raw/):
//   ["P", slot, recvMs, sig16, mint, user, isBuy, solLamports, tokRaw, vSol, vTok, realSol, creator, ts]   pump.fun TradeEvent
//   ["A", slot, recvMs, sig16, pool, user, isBuy, quoteLamports(user side, after fees), baseRaw, poolQuoteBefore, poolBaseBefore, lpBps, protoBps, creatorBps, ts]  PumpSwap Buy/SellEvent
//   ["C"|"M"|"N", slot, recvMs, sig16, base64]  pump.fun CreateEvent / CompleteEvent / PumpSwap CreatePoolEvent (decoded later)
// Stats per minute in data/raw/collector.log (messages, failed txs, reconnects).
import fs from 'node:fs'; import zlib from 'node:zlib';
const D = new URL('./data/raw/', import.meta.url).pathname; fs.mkdirSync(D, { recursive: true });
const PROGS = ['6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA'];
const DISC = { 'vdt/007mYe4=': 'P', 'Z/RSHyz1d3c=': 'B', 'Pi83CqUD3Co=': 'S', 'G3KpTd7rY3Y=': 'C', 'X3JhnNQumAg=': 'M', 'sTEM0qB2p3Q=': 'N' };
const ALPH = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58(buf) { let n = BigInt('0x' + Buffer.from(buf).toString('hex')), s = ''; while (n > 0n) { s = ALPH[Number(n % 58n)] + s; n /= 58n; } for (const b of buf) { if (b) break; s = '1' + s; } return s; }
const u64 = (b, o) => b.readBigUInt64LE(o).toString();
let out, outName, stats = { msg: 0, fail: 0, ev: 0, dup: 0, recon: 0 };
function rotate() { if (out) out.end(); outName = D + 'trades_' + new Date().toISOString().replace(/[:.]/g, '-') + '.jsonl.gz'; out = zlib.createGzip(); out.pipe(fs.createWriteStream(outName)); }
rotate(); setInterval(rotate, 30 * 60e3);
const log = (s) => fs.appendFileSync(D + 'collector.log', new Date().toISOString() + ' ' + s + '\n');
setInterval(() => { log(JSON.stringify(stats)); stats = { msg: 0, fail: 0, ev: 0, dup: 0, recon: stats.recon }; }, 60e3);
const seen = new Map(); // sig -> 1, pruned
function handle(v, slot) {
  stats.msg++; if (v.err) { stats.fail++; return; }
  if (seen.has(v.signature)) { stats.dup++; return; } seen.set(v.signature, 1); if (seen.size > 300000) { let i = 0; for (const k of seen.keys()) { seen.delete(k); if (++i > 100000) break; } }
  const now = Date.now(), s16 = v.signature.slice(0, 16);
  for (const l of v.logs) {
    if (!l.startsWith('Program data: ')) continue;
    const b = Buffer.from(l.slice(14), 'base64'); if (b.length < 16) continue;
    const k = DISC[b.subarray(0, 8).toString('base64')]; if (!k) continue;
    try {
      let r;
      if (k === 'P') r = ['P', slot, now, s16, b58(b.subarray(8, 40)), b58(b.subarray(57, 89)), b[56], u64(b, 40), u64(b, 48), u64(b, 97), u64(b, 105), u64(b, 113), b58(b.subarray(177, 209)), Number(b.readBigInt64LE(89))];
      else if (k === 'B' || k === 'S') {
        // numeric block: ts, baseAmt, limit, userBase, userQuote, poolBase, poolQuote, quoteAmt, lpBps, lpFee, protoBps, protoFee, quoteAmt2, userQuoteAmt
        const n = i => u64(b, 8 + 8 * i); const ub = 8 + 8 * 14;
        const cbps = b.length >= ub + 32 * 7 + 16 ? u64(b, ub + 32 * 7) : null;
        r = ['A', slot, now, s16, b58(b.subarray(ub, ub + 32)), b58(b.subarray(ub + 32, ub + 64)), k === 'B' ? 1 : 0, n(13), n(1), n(6), n(5), n(8), n(10), cbps, Number(b.readBigInt64LE(8)), n(7)];
      } else r = [k, slot, now, s16, b.toString('base64')];
      out.write(JSON.stringify(r) + '\n'); stats.ev++;
    } catch (e) { }
  }
}
function connect() {
  const ws = new WebSocket('wss://api.mainnet-beta.solana.com');
  let alive = Date.now();
  ws.onopen = () => PROGS.forEach((p, i) => ws.send(JSON.stringify({ jsonrpc: '2.0', id: i + 1, method: 'logsSubscribe', params: [{ mentions: [p] }, { commitment: 'confirmed' }] })));
  ws.onmessage = e => { alive = Date.now(); const j = JSON.parse(e.data); if (j.params) handle(j.params.result.value, j.params.result.context.slot); else log('ctl ' + e.data); };
  const t = setInterval(() => { if (Date.now() - alive > 20000) { log('stale, reconnect'); try { ws.close(); } catch { } } }, 5000);
  ws.onclose = (e) => { clearInterval(t); stats.recon++; log('close ' + e.code); setTimeout(connect, 1000); };
  ws.onerror = (e) => log('err ' + (e.message || ''));
}
connect();
process.on('SIGTERM', () => { out.end(() => process.exit(0)); });
