// Survivorship-free universe: every successful pump.fun migration (program 6EF8..., touching the migration account
// 39azUYF...) with blockTime in [T0, T1), from the public keyless RPC. Same method as research/empirical/backfill_migrations.mjs.
// Transactions are fetched in a seeded random order, so any stopping point is a uniform sample of the window.
// Usage: node fetch_migrations.mjs <datadir> <T0 iso> <T1 iso> [workers]
import fs from 'node:fs';
const [, , D, T0s, T1s, W = '3'] = process.argv;
const T0 = Date.parse(T0s) / 1000, T1 = Date.parse(T1s) / 1000;
const RPC = 'https://api.mainnet-beta.solana.com';
const MIG = '39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg';
const WSOL = 'So11111111111111111111111111111111111111112';
let n429 = 0, nErr = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function rpc(method, params) {
  for (let i = 0; i < 10; i++) {
    try {
      const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(30000) });
      if (r.status === 429) { n429++; await sleep(Math.min(30000, 1000 * 2 ** i)); continue; }
      const j = await r.json();
      if (j.error) { if (nErr++ < 5) console.log('rpc error', method, JSON.stringify(j.error).slice(0, 200)); await sleep(Math.min(30000, 1000 * 2 ** i)); continue; }
      return j.result;
    } catch { await sleep(2000 * (i + 1)); }
  }
  return undefined;
}
const sigFile = `${D}/migration_sigs.json`;
let sigs = fs.existsSync(sigFile) ? JSON.parse(fs.readFileSync(sigFile)) : null;
if (!sigs) {
  sigs = []; let before;
  for (;;) {
    const arr = await rpc('getSignaturesForAddress', [MIG, { limit: 1000, ...(before ? { before } : {}) }]);
    if (!arr || !arr.length) { console.log('empty page, retry'); await sleep(5000); continue; }
    sigs.push(...arr.filter((s) => s.blockTime >= T0 && s.blockTime < T1).map((s) => ({ signature: s.signature, blockTime: s.blockTime, slot: s.slot, err: s.err })));
    before = arr[arr.length - 1].signature;
    console.log('page', arr.length, new Date(arr[arr.length - 1].blockTime * 1000).toISOString(), 'kept', sigs.length);
    if (arr[arr.length - 1].blockTime < T0) break;
    await sleep(400);
  }
  fs.writeFileSync(sigFile, JSON.stringify(sigs));
}
// seeded shuffle (mulberry32, seed 20261006)
let a = 20261006; const rnd = () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const ok = sigs.filter((s) => s.err === null);
for (let i = ok.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [ok[i], ok[j]] = [ok[j], ok[i]]; }
console.log('sigs', sigs.length, 'ok', ok.length);
const outF = `${D}/migrations.jsonl`;
const done = new Set(fs.existsSync(outF) ? fs.readFileSync(outF, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).sig) : []);
const out = fs.createWriteStream(outF, { flags: 'a' });
const todo = ok.filter((s) => !done.has(s.signature));
let n = 0, idx = 0;
async function worker() {
  while (idx < todo.length) {
    const s = todo[idx++];
    const t = await rpc('getTransaction', [s.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, commitment: 'confirmed' }]);
    if (!t) { out.write(JSON.stringify({ sig: s.signature, blockTime: s.blockTime, kind: 'fetch_failed' }) + '\n'); continue; }
    const logs = t.meta.logMessages || [];
    const isMig = logs.some((l) => /Instruction: Migrate/.test(l));
    const pb = t.meta.postTokenBalances || [];
    const rec = { sig: s.signature, blockTime: t.blockTime, slot: t.slot, kind: isMig ? 'migrate' : 'other' };
    if (isMig) {
      let best = null;
      for (const tb of pb.filter((b) => b.mint !== WSOL)) {
        const sb = pb.find((x) => x.mint === WSOL && x.owner === tb.owner);
        if (sb && (tb.uiTokenAmount.uiAmount || 0) > 0 && (!best || sb.uiTokenAmount.uiAmount > best.sol)) best = { mint: tb.mint, pool: tb.owner, tok: tb.uiTokenAmount.uiAmount, sol: sb.uiTokenAmount.uiAmount, decimals: tb.uiTokenAmount.decimals };
      }
      Object.assign(rec, best || {});
      if (best) rec.migPriceSol = best.sol / best.tok;
    }
    out.write(JSON.stringify(rec) + '\n');
    if (++n % 100 === 0) console.log(new Date().toISOString(), 'fetched', n, 'of', todo.length, '429s', n429, 'errors', nErr);
    await sleep(Number(process.env.GAP_MS || 700));
  }
}
await Promise.all(Array.from({ length: Number(W) }, worker));
console.log('done');
