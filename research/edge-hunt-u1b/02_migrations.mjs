// Step 2: decode the migration transactions whose sha256(signature) falls below fraction P (argv[2]): a uniform random
// sample of all graduations in [T0, WALL), survivorship-free by construction (selection never looks at the coin).
// Raising P later only adds coins; the sample stays uniform.
// Output: data/migrations.jsonl {sig, t, slot, mint, pool, tok, sol}. Resumable.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { rpc, sleep, DATA } from './lib.mjs';
const WSOL = 'So11111111111111111111111111111111111111112';
const P = Number(process.argv[2] || 0.05);
const sigs = fs.readFileSync(DATA + 'migration_sigs.jsonl', 'utf8').trim().split('\n').map(JSON.parse).filter(s => s.ok);
const key = (s) => crypto.createHash('sha256').update(s.sig).digest('hex');
sigs.sort((a, b) => (key(a) < key(b) ? -1 : 1));
const outF = DATA + 'migrations.jsonl';
const done = new Set(fs.existsSync(outF) ? fs.readFileSync(outF, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l).sig) : []);
const out = fs.createWriteStream(outF, { flags: 'a' });
export const frac = (s) => parseInt(key(s).slice(0, 8), 16) / 2 ** 32;
const todo = sigs.filter(s => frac(s) < P && !done.has(s.sig));
console.log('ok sigs', sigs.length, 'todo', todo.length);
let n = 0, i = 0;
async function work() {
  while (i < todo.length) {
    const s = todo[i++];
    const r = await rpc('getTransaction', [s.sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]);
    const t = r.result;
    if (!t) { out.write(JSON.stringify({ sig: s.sig, t: s.t, kind: 'fetch_failed', err: r._err || r.error?.code || null }) + '\n'); continue; }
    const logs = t.meta.logMessages || [];
    const rec = { sig: s.sig, t: t.blockTime, slot: t.slot, kind: logs.some(l => /Instruction: Migrate/.test(l)) ? 'migrate' : 'other' };
    if (rec.kind === 'migrate') {
      const pb = t.meta.postTokenBalances || [];
      let best = null;
      for (const tb of pb.filter(b => b.mint !== WSOL)) {
        const sb = pb.find(x => x.mint === WSOL && x.owner === tb.owner);
        if (sb && (tb.uiTokenAmount.uiAmount || 0) > 0 && (!best || sb.uiTokenAmount.uiAmount > best.sol)) best = { mint: tb.mint, pool: tb.owner, tok: tb.uiTokenAmount.uiAmount, sol: sb.uiTokenAmount.uiAmount };
      }
      // U1 02b_redecode: when the most-WSOL owner's token amount is outside 150M-260M it was a trader's account; the
      // pool is then the owner holding the most of the coin among owners that also hold WSOL.
      if (best && (best.tok < 150e6 || best.tok > 260e6)) {
        best = null;
        for (const tb of pb.filter(b => b.mint !== WSOL)) {
          const sb = pb.find(x => x.mint === WSOL && x.owner === tb.owner); const amt = tb.uiTokenAmount.uiAmount || 0;
          if (sb && amt > 0 && (!best || amt > best.tok)) best = { mint: tb.mint, pool: tb.owner, tok: amt, sol: sb.uiTokenAmount.uiAmount, redecoded: true };
        }
      }
      Object.assign(rec, best || { kind: 'migrate_nopool' });
    }
    out.write(JSON.stringify(rec) + '\n');
    if (++n % 200 === 0) console.log(new Date().toISOString(), 'fetched', n);
    
  }
}
await Promise.all(Array.from({ length: Number(process.env.WORKERS || 4) }, work));
console.log('done', n);
