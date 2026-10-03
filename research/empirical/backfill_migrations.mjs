// Survivorship-free universe: every successful pump.fun MigrateV2 tx (program 6EF8..., touching migration account 39azUYF...)
// with blockTime in [T0, T1). Output: backfill/migrations.jsonl (one line per migration).
import fs from 'node:fs';
import { rpc, sleep } from './lib.mjs';
const MIG = '39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg';
const WSOL = 'So11111111111111111111111111111111111111112';
const T0 = Date.parse(process.argv[2] || '2026-10-01T23:00:00Z') / 1000, T1 = Date.parse(process.argv[3] || '2026-10-02T11:00:00Z') / 1000;
const D = new URL('./backfill/', import.meta.url).pathname;
const sigFile = D + 'migration_sigs.json';
let sigs = fs.existsSync(sigFile) ? JSON.parse(fs.readFileSync(sigFile)) : null;
if (!sigs) {
  sigs = []; let before;
  while (true) {
    const r = await rpc('getSignaturesForAddress', [MIG, { limit: 1000, ...(before ? { before } : {}) }]);
    const arr = r.result || []; if (!arr.length) { console.log('sig page err', JSON.stringify(r).slice(0, 200)); await sleep(5000); continue; }
    sigs.push(...arr.filter(s => s.blockTime >= T0 && s.blockTime < T1));
    before = arr[arr.length - 1].signature;
    console.log('page', arr.length, new Date(arr[arr.length - 1].blockTime * 1000).toISOString());
    if (arr[arr.length - 1].blockTime < T0) break;
    await sleep(1500);
  }
  fs.writeFileSync(sigFile, JSON.stringify(sigs));
}
const okSigs = sigs.filter(s => s.err === null);
console.log('sigs in window', sigs.length, 'ok', okSigs.length);
const outF = D + 'migrations.jsonl';
const done = new Set(fs.existsSync(outF) ? fs.readFileSync(outF, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l).sig) : []);
const out = fs.createWriteStream(outF, { flags: 'a' });
let n = 0;
for (const s of okSigs) {
  if (done.has(s.signature)) continue;
  const r = await rpc('getTransaction', [s.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]);
  const t = r.result;
  if (!t) { out.write(JSON.stringify({ sig: s.signature, blockTime: s.blockTime, kind: 'fetch_failed' }) + '\n'); continue; }
  const logs = t.meta.logMessages || [];
  const isMig = logs.some(l => /Instruction: Migrate/.test(l));
  const pb = t.meta.postTokenBalances || [];
  const tokBal = pb.filter(b => b.mint !== WSOL);
  const solBal = pb.filter(b => b.mint === WSOL);
  // pool = owner that holds both the token and WSOL after migration
  let rec = { sig: s.signature, blockTime: t.blockTime, slot: t.slot, kind: isMig ? 'migrate' : 'other', logIx: logs.filter(l => /Instruction:/.test(l)).slice(0, 4) };
  if (isMig) {
    let best = null;
    for (const tb of tokBal) {
      const sb = solBal.find(x => x.owner === tb.owner);
      if (sb && (tb.uiTokenAmount.uiAmount || 0) > 0) { if (!best || sb.uiTokenAmount.uiAmount > best.sol) best = { mint: tb.mint, pool: tb.owner, tok: tb.uiTokenAmount.uiAmount, sol: sb.uiTokenAmount.uiAmount, decimals: tb.uiTokenAmount.decimals }; }
    }
    Object.assign(rec, best || {}, { feePayer: t.transaction.message.accountKeys[0].pubkey, programs: [...new Set(t.transaction.message.instructions.map(i => i.programId))] });
    if (best) rec.migPriceSol = best.sol / best.tok;
  }
  out.write(JSON.stringify(rec) + '\n');
  if (++n % 25 === 0) console.log(new Date().toISOString(), 'fetched', n);
  await sleep(450);
}
console.log('done');
