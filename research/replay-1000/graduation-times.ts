// REPLAY-1000: how long after its create each of the day's graduates migrated (create = the mint's oldest successful
// signature, from the cache; offline). The H9 rule refuses graduation within 5 minutes of the create.
//   node research/replay-1000/graduation-times.ts <coins.json> [others.json]
import { readFileSync } from 'node:fs';
import { loadIndex } from './coins.ts';
import { PublicRpc } from './rpc.ts';
import { ChainView } from './world/chain.ts';
import type { RunCoin } from './run.ts';

const main = async () => {
  const coins = process.argv.slice(2).flatMap((f) => JSON.parse(readFileSync(f, 'utf8')) as RunCoin[]);
  const chain = new ChainView(new PublicRpc([]), loadIndex());
  const buckets: Record<string, number> = { 'same slot': 0, '< 5 min': 0, '5-60 min': 0, '> 60 min': 0, unknown: 0 };
  for (const c of coins) {
    let first: { slot: number; blockTime: number | null } | undefined;
    try {
      first = (await chain.signaturesBetween(c.mint, 0, c.migrationSlot)).find((x) => x.err === null);
    } catch {
      first = undefined;
    }
    if (first === undefined || first.blockTime === null) { buckets['unknown']!++; continue; }
    const dt = c.migrationTime - first.blockTime;
    if (first.slot === c.migrationSlot) buckets['same slot']!++;
    else if (dt < 300) buckets['< 5 min']!++;
    else if (dt <= 3600) buckets['5-60 min']!++;
    else buckets['> 60 min']!++;
  }
  console.log(JSON.stringify({ coins: coins.length, ...buckets }));
};

if (process.argv[1] === new URL(import.meta.url).pathname) await main();
