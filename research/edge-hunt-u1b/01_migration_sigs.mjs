// Step 1: every pump.fun migration signature (account 39azUYF..., as research/empirical/backfill_migrations.mjs)
// with blockTime in [T0, WALL). Signatures after the wall are paged through (they come first, newest-first) but never stored.
import fs from 'node:fs';
import { rpc, sleep, DATA, WALL_S } from './lib.mjs';
const MIG = '39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg';
const T0 = Date.parse(process.argv[2] || '2026-07-19T00:00:00Z') / 1000;
const out = DATA + 'migration_sigs.jsonl';
let before = process.argv[3], kept = 0;
const w = fs.createWriteStream(out, { flags: 'a' });
while (true) {
  const r = await rpc('getSignaturesForAddress', [MIG, { limit: 1000, ...(before ? { before } : {}) }]);
  const arr = r.result;
  if (!arr) { console.log('err', JSON.stringify(r).slice(0, 200)); await sleep(5000); continue; }
  if (!arr.length) break;
  for (const s of arr) if (s.blockTime >= T0 && s.blockTime < WALL_S) { w.write(JSON.stringify({ sig: s.signature, t: s.blockTime, slot: s.slot, ok: s.err === null }) + '\n'); kept++; }
  before = arr[arr.length - 1].signature;
  console.log(new Date(arr[arr.length - 1].blockTime * 1000).toISOString(), 'kept', kept, 'cursor', before);
  if (arr[arr.length - 1].blockTime < T0) break;
  await sleep(600);
}
w.end(); console.log('done', kept);
