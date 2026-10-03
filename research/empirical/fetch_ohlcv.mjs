// Fetch 1-minute OHLCV (SOL-denominated, currency=token) from GeckoTerminal for each migrated pool:
// candles from migration to migration+300 min. Follows a migrations jsonl file until it stops growing.
// Usage: node fetch_ohlcv.mjs <migrations.jsonl> <outdir> [gapMs]
import fs from 'node:fs';
import { gt, sleep } from './lib.mjs';
const [, , MIGF, OUT, GAP = '2600'] = process.argv;
const seen = new Set(fs.readdirSync(OUT).map(f => f.replace('.json', '')));
let idle = 0;
while (idle < 6) {
  const L = fs.readFileSync(MIGF, 'utf8').trim().split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(x => x && x.pool && x.mint);
  const byMint = new Map();
  for (const x of L) { const t = x.blockTime || Math.floor(x.ts / 1000); if (!byMint.has(x.mint) || byMint.get(x.mint).t > t) byMint.set(x.mint, { ...x, t }); }
  const todo = [...byMint.values()].filter(x => !seen.has(x.pool));
  if (!todo.length) { idle++; await sleep(30000); continue; }
  idle = 0;
  for (const x of todo) {
    const before = x.t + 301 * 60;
    if (before > Date.now() / 1000 + 60 && !process.env.ALLOW_PARTIAL) continue;
    const j = await gt(`/networks/solana/pools/${x.pool}/ohlcv/minute?aggregate=1&limit=300&currency=token&before_timestamp=${Math.min(before, Math.floor(Date.now()/1000))}`, Number(GAP));
    fs.writeFileSync(`${OUT}/${x.pool}.json`, JSON.stringify({ mint: x.mint, pool: x.pool, migTs: x.t, fetchedAt: Date.now(), resp: j }));
    seen.add(x.pool);
    if (j._err) console.log('err', x.pool, JSON.stringify(j).slice(0, 150));
  }
  console.log(new Date().toISOString(), 'have', seen.size);
}
console.log('done');
