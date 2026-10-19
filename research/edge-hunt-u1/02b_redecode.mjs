// Step 2b: re-decode migrations whose first decode looked wrong (token amount outside 150M-260M: another account that
// holds both the coin and WSOL had more WSOL than the pool). The pool is the owner holding the most of the coin among
// owners that also hold WSOL. Output: data/migrations_fixed.jsonl (replaces those records in later steps).
import fs from 'node:fs';
import { rpc, sleep, DATA } from './lib.mjs';
const WSOL = 'So11111111111111111111111111111111111111112';
const sigs = JSON.parse(fs.readFileSync(DATA + 'redecode_sigs.json'));
const out = fs.createWriteStream(DATA + 'migrations_fixed.jsonl');
for (const sig of sigs) {
  const r = await rpc('getTransaction', [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]);
  const t = r.result; if (!t) { console.log('fail', sig); continue; }
  const pb = t.meta.postTokenBalances || [];
  let best = null;
  for (const tb of pb.filter(b => b.mint !== WSOL)) {
    const sb = pb.find(x => x.mint === WSOL && x.owner === tb.owner);
    const amt = tb.uiTokenAmount.uiAmount || 0;
    if (sb && amt > 0 && (!best || amt > best.tok)) best = { mint: tb.mint, pool: tb.owner, tok: amt, sol: sb.uiTokenAmount.uiAmount };
  }
  out.write(JSON.stringify({ sig, t: t.blockTime, slot: t.slot, kind: best ? 'migrate' : 'migrate_nopool', ...(best || {}) }) + '\n');
  await sleep(600);
}
out.end(); console.log('done');
