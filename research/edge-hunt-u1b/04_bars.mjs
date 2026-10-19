// EDGE-HUNT-U1-B changes (preregistration.json): every graduation, universe B only. 5-minute bars are fetched over the
// hours where the pool could be in B (hourly high at or above the price where the quote proxy reaches max(100 SOL,
// $50k / (SOL/USD x 1.03)): a 3% margin so no B check is lost), plus 7 h lead-in. Pricing filter: busy pools plus the
// fixed audit of quiet pools, sha256 fraction in [0.08, 0.09).
// Step 4: price bars per sampled pool from GeckoTerminal (price in SOL, currency=token). Never a bar that ends after
// the wall. (a) hourly bars from migration to +15 d -> U1 screen; (b) 5-minute bars over the hours where the pool could
// be in U1 (hourly high at or above the 100-SOL-quote price), plus 7 h of lead-in for the 6 h range and 60-min features.
// Skips pools step 3 found inactive (fewer than MIN_TX signatures in days 1-14), except the audit subset.
// Follows data/migrations.jsonl as it grows (run with --follow). Output: data/bars/<pool>.json {h, m5}.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { earliest, gt, sleep, DATA, WALL_S } from './lib.mjs';
const AUDIT_LO = 0.08, AUDIT_HI = 0.09;
const SOLUSD = JSON.parse(fs.readFileSync(DATA + 'sol_usd_hour.json'));
const usdAt = (t) => { let v = null; for (const b of SOLUSD) { if (b[0] + 3600 <= t) v = b[4]; else break; } return v; };
const isAudit = (sig) => frac(sig) >= AUDIT_LO && frac(sig) < AUDIT_HI;
// BUSY_ONLY (set 2026-10-06 23:30 Melbourne, after the first 408 pools): of 39 pools with any U1 hour, all with tradeable
// bars were 'busy' (more than one page of signatures, known=false); none of ~250 fetched pools with 30+ known
// signatures reached U1. From then on only busy pools (plus the audit subset) are fetched; README reports the check.
const frac = (sig) => parseInt(crypto.createHash('sha256').update(sig).digest('hex').slice(0, 8), 16) / 2 ** 32;
const FOLLOW = process.argv.includes('--follow');
const BD = DATA + 'bars/'; fs.mkdirSync(BD, { recursive: true });
const D1 = 86400, D14 = 14 * 86400;
export const u1Price = (m, quoteSol = 100) => (quoteSol * quoteSol) / (m.tok * m.sol); // constant product: quote = sqrt(k p)
async function ohlcv(pool, tf, agg, before, after) {
  // pages back from `before` until `after`; keeps only bars that end at or before the wall
  const len = tf === 'hour' ? 3600 * agg : tf === 'minute' ? 60 * agg : 86400;
  let out = [], b = Math.min(before, WALL_S) - 1, calls = 0;
  while (b > after) {
    const r = await gt(`/networks/solana/pools/${pool}/ohlcv/${tf}?aggregate=${agg}&limit=1000&currency=token&token=base&before_timestamp=${b}`); calls++;
    const l = r?.data?.attributes?.ohlcv_list;
    if (!l) return { err: JSON.stringify(r).slice(0, 160), bars: out, calls };
    if (!l.length) break;
    out.push(...l); const mn = Math.min(...l.map(x => x[0]));
    if (l.length < 1000) break;
    b = mn - 1;
  }
  out = [...new Map(out.filter(x => x[0] + len <= WALL_S && x[0] + len > after).map(x => [x[0], x])).values()].sort((a, c) => a[0] - c[0]);
  return { bars: out, calls };
}
let totalCalls = 0;
async function one(m) {
  const f = BD + m.pool + '.json';
  if (fs.existsSync(f)) return;
  const end = Math.min(m.t + D14 + 3 * 3600, WALL_S);
  const h = await ohlcv(m.pool, 'hour', 1, end, m.t - 3600); totalCalls += h.calls;
  if (h.err) { console.log('hour err', m.pool, h.err); return; }
  const elig = h.bars.filter(b => { const u = usdAt(b[0] + 3600) || usdAt(b[0]); if (!u) return false;
    const thr = u1Price(m, Math.max(100, 50000 / (u * 1.03)));
    return b[0] + 3600 > m.t + D1 && b[0] < m.t + D14 && b[2] >= thr; });
  let m5 = { bars: [], calls: 0 };
  if (elig.length) {
    const from = Math.max(m.t, elig[0][0] - 7 * 3600), to = Math.min(elig.at(-1)[0] + 4 * 3600, end);
    m5 = await ohlcv(m.pool, 'minute', 5, to, from); totalCalls += m5.calls;
    if (m5.err) { console.log('m5 err', m.pool, m5.err); return; }
  }
  fs.writeFileSync(f, JSON.stringify({ pool: m.pool, mint: m.mint, t: m.t, tok: m.tok, sol: m.sol, h: h.bars, m5: m5.bars, eligHours: elig.length }));
}
const seen = new Set();
while (true) {
  const act = new Map(fs.readFileSync(DATA + 'activity.jsonl', 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).map(a => [a.pool, a]));
  const ms = earliest(fs.readFileSync(DATA + 'migrations.jsonl', 'utf8').trim().split('\n').map(JSON.parse))
    .filter(x => x.pool && x.t + D1 < WALL_S - 3 * 3600 && x.sol > 1 && !seen.has(x.pool) && act.has(x.pool))
    .filter(x => { const a = act.get(x.pool); return a.err || !a.known || isAudit(x.sig); });
  // Busiest first (activity in days 1-14; unknown = busier than one page), audit subset interleaved at the front.
  const score = (x) => { const a = act.get(x.pool); return a.err || !a.known ? 1e6 : a.n; };
  ms.sort((a, b) => score(b) - score(a));
  for (const m of ms.slice(0, 15)) { seen.add(m.pool); await one(m); }
  if (ms.length > 15) continue;
  console.log(new Date().toISOString(), 'pools', seen.size, 'gt calls', totalCalls);
  if (!FOLLOW) break;
  await sleep(60000);
}
