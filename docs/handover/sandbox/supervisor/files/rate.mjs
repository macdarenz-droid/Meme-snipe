// Measure pump.fun and PumpSwap transaction density (tx per slot, failed share) at sampled points
// using only the public RPC: getBlock(signatures) then getSignaturesForAddress(before=sig).
const RPC = 'https://api.mainnet-beta.solana.com';
const PROGS = { pump: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', amm: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
let id = 0;
async function rpc(method, params) {
  for (let a = 0; a < 6; a++) {
    const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
    if (r.status === 429) { await sleep(5000); continue; }
    const j = await r.json();
    if (j.error) { if (/skipped|not available|missing/i.test(j.error.message)) return { error: j.error }; await sleep(3000); continue; }
    return j.result;
  }
  throw new Error('rpc failed ' + method);
}
const slots = process.argv.slice(2).map(Number);
const pages = Number(process.env.PAGES || 3);
for (const s0 of slots) {
  let blk, s = s0;
  for (let k = 0; k < 10; k++, s++) {
    blk = await rpc('getBlock', [s, { transactionDetails: 'signatures', rewards: false, maxSupportedTransactionVersion: 1, commitment: 'finalized' }]);
    await sleep(1800);
    if (blk && !blk.error) break;
  }
  if (!blk || blk.error) { console.log(JSON.stringify({ slot: s0, error: 'no block' })); continue; }
  const sig = blk.signatures[blk.signatures.length - 1];
  const out = { slot: s, blockTime: new Date(blk.blockTime * 1000).toISOString() };
  for (const [name, prog] of Object.entries(PROGS)) {
    let before = sig, n = 0, failed = 0, hi = null, lo = null, tHi = null, tLo = null;
    for (let p = 0; p < pages; p++) {
      const res = await rpc('getSignaturesForAddress', [prog, { before, limit: 1000, commitment: 'finalized' }]);
      await sleep(1200);
      if (!res || res.error || res.length === 0) { out[name + '_err'] = res && res.error ? res.error.message : 'empty'; break; }
      for (const x of res) { n++; if (x.err) failed++; }
      if (hi === null) { hi = res[0].slot; tHi = res[0].blockTime; }
      lo = res[res.length - 1].slot; tLo = res[res.length - 1].blockTime;
      before = res[res.length - 1].signature;
    }
    if (n) {
      // drop the partial lowest slot: count only slots strictly above lo is complicated; use span lo..hi inclusive
      out[name] = { n, failed, slotSpan: hi - lo + 1, secSpan: tHi - tLo, txPerSlot: +(n / (hi - lo + 1)).toFixed(1), txPerSec: tHi > tLo ? +(n / (tHi - tLo)).toFixed(0) : null, failedShare: +(failed / n).toFixed(3) };
    }
  }
  console.log(JSON.stringify(out));
}
