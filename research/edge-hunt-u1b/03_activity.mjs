// Step 3: activity screen on the public RPC before spending GeckoTerminal calls. For each sampled pool, the newest 1000
// signatures; count those in [migration + 1 d, migration + 14 d). Pools with fewer than MIN_TX there are skipped by
// step 4, except a fixed 10% audit subset (by signature hash) that is fetched anyway to measure what the skip loses.
// Output: data/activity.jsonl {pool, n, known}. known=false means the page did not reach back to day 14 (busy pool).
import fs from 'node:fs';
import { earliest, rpc, sleep, DATA, WALL_S } from './lib.mjs';
const FOLLOW = process.argv.includes('--follow');
const outF = DATA + 'activity.jsonl';
const done = new Set(fs.existsSync(outF) ? fs.readFileSync(outF, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l).pool) : []);
const out = fs.createWriteStream(outF, { flags: 'a' });
while (true) {
  const ms = earliest(fs.readFileSync(DATA + 'migrations.jsonl', 'utf8').trim().split('\n').map(JSON.parse))
    .filter(x => x.pool && x.t + 86400 < WALL_S - 3 * 3600 && !done.has(x.pool));
  for (const m of ms) {
    done.add(m.pool);
    const r = await rpc('getSignaturesForAddress', [m.pool, { limit: 1000 }]);
    const a = r.result;
    if (!a) { out.write(JSON.stringify({ pool: m.pool, err: true }) + '\n'); continue; }
    const lo = m.t + 86400, hi = m.t + 14 * 86400;
    const known = a.length < 1000 || a.at(-1).blockTime < hi; // page reaches into the window from above
    const n = a.filter(s => s.blockTime >= lo && s.blockTime < hi).length;
    out.write(JSON.stringify({ pool: m.pool, n, known: known && (a.length < 1000 || a.at(-1).blockTime < lo) }) + '\n');
    await sleep(250);
  }
  if (!FOLLOW) break;
  await sleep(30000);
}
