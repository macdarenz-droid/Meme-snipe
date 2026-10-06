// 1-minute OHLCV (price in SOL per token, currency=token) from GeckoTerminal's free public API for each migrated pool,
// from migration to migration + 361 min (U2 window 60-240 min plus T_max 120 min). Follows migrations.jsonl (already in
// seeded random order) until it stops growing. GeckoTerminal returns only minutes with trades, newest first, max 1000.
// Usage: node fetch_ohlcv.mjs <datadir> [gapMs]
import fs from 'node:fs';
const [, , D, GAP = '2100'] = process.argv;
const OUT = `${D}/ohlcv`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Adaptive pacing: 10% slower after each 429, 5% faster after 50 clean replies, never below the start gap.
let gap = Number(GAP), last = 0, n429 = 0, okRun = 0;
const minGap = Number(GAP);
async function gt(path) {
  for (let i = 0; i < 8; i++) {
    const w = last + gap - Date.now(); if (w > 0) await sleep(w); last = Date.now();
    try {
      const r = await fetch('https://api.geckoterminal.com/api/v2' + path, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(30000) });
      if (r.status === 429) { n429++; gap = Math.min(6000, Math.round(gap * 1.1)); await sleep(Math.min(120000, 10000 * 2 ** i)); continue; }
      if (++okRun % 50 === 0) gap = Math.max(minGap, Math.round(gap * 0.95));
      if (!r.ok) return { _err: r.status, _body: (await r.text()).slice(0, 200) };
      return await r.json();
    } catch (e) { await sleep(3000 * (i + 1)); }
  }
  return { _err: 'failed' };
}
const seen = new Set(fs.readdirSync(OUT).map((f) => f.replace('.json', '')));
let idle = 0, n = 0;
while (idle < 20) {
  const L = fs.existsSync(`${D}/migrations.jsonl`) ? fs.readFileSync(`${D}/migrations.jsonl`, 'utf8').trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((x) => x && x.pool && x.mint) : [];
  // H8 dust (< 5 SOL at migration) and H9 (created < 5 min before migration) reject in every trial: skip those graduates.
  const h9 = new Map();
  if (fs.existsSync(`${D}/created.jsonl`)) for (const l of fs.readFileSync(`${D}/created.jsonl`, 'utf8').trim().split('\n').filter(Boolean)) {
    const c = JSON.parse(l);
    h9.set(c.mint, c.oldestBefore === null ? null : c.complete ? c.migTs - c.oldestBefore >= 300 : c.oldestBefore < c.migTs - 300 ? true : null);
  }
  const todo = L.filter((x) => !seen.has(x.pool) && x.sol >= 5 && h9.has(x.mint) && h9.get(x.mint) !== false);
  if (!todo.length) { idle++; await sleep(30000); continue; }
  idle = 0;
  for (const x of todo) {
    const before = x.blockTime + 361 * 60;
    if (before > Date.now() / 1000) continue;
    const j = await gt(`/networks/solana/pools/${x.pool}/ohlcv/minute?aggregate=1&limit=1000&currency=token&before_timestamp=${before}`);
    fs.writeFileSync(`${OUT}/${x.pool}.json`, JSON.stringify({ mint: x.mint, pool: x.pool, migTs: x.blockTime, fetchedAt: Date.now(), resp: j }));
    seen.add(x.pool);
    if (j._err) console.log('err', x.pool, JSON.stringify(j).slice(0, 150));
    if (++n % 100 === 0) console.log(new Date().toISOString(), 'have', seen.size, '429s', n429, 'gap', gap);
  }
}
console.log('done');
