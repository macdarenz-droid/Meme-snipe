// Young pools (what the bot watches): pools created by recent pump migrations; decode the tails of their latest swaps.
import { logEvents } from '/home/user/wt-crash/packages/core/src/chain/transaction.ts';
const RPC = 'https://api.mainnet-beta.solana.com';
const sleep = (ms: number) => new Promise((g) => setTimeout(g, ms));
const call = async (method: string, params: unknown[]) => {
  for (let i = 0; i < 12; i++) {
    const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    if (r.status === 429) { await sleep(2500); continue; }
    const j: any = await r.json();
    if (j.error?.code === 429) { await sleep(2500); continue; }
    if (j.error) throw new Error(JSON.stringify(j.error));
    return j.result;
  }
  throw new Error('429s');
};
const getTx = (sig: string) => call('getTransaction', [sig, { maxSupportedTransactionVersion: 1, commitment: 'confirmed', encoding: 'json' }]);
const migs: any[] = (await call('getSignaturesForAddress', ['39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg', { limit: 40 }])).filter((s: any) => s.err === null);
const pools: { pool: string; at: number }[] = [];
for (const s of migs) {
  if (pools.length >= 12) break;
  try { const tx = await getTx(s.signature); for (const e of logEvents(tx.meta.logMessages, null).events as any[]) if (e.program === 'pump_amm' && e.name === 'CreatePoolEvent') pools.push({ pool: e.data.pool, at: tx.blockTime }); } catch {}
  await sleep(250);
}
console.log('young pools', pools.length, 'age min', pools.map((p) => Math.round((Date.now() / 1000 - p.at) / 60)).join(','));
let tot = 0, nz = 0, poolsNz = 0, poolsAny = 0;
for (const { pool } of pools) {
  const ps: any[] = (await call('getSignaturesForAddress', [pool, { limit: 30 }])).filter((s: any) => s.err === null).slice(0, 8);
  let n = 0, z = 0; const vals = new Set<string>();
  for (const s of ps) {
    try { const tx = await getTx(s.signature); for (const e of logEvents(tx.meta.logMessages, null).events as any[]) if (e.program === 'pump_amm' && (e.name === 'BuyEvent' || e.name === 'SellEvent') && e.data.pool === pool) { n++; if (/[^0]/.test(e.extra)) { z++; vals.add(e.extra); } } } catch {}
    await sleep(250);
  }
  tot += n; nz += z; if (n > 0) poolsAny++; if (z > 0) poolsNz++;
  console.log(pool.slice(0, 8), 'swaps', n, 'nonzero', z, [...vals].slice(0, 3).join(','));
}
console.log('TOTAL young-pool swaps', tot, 'nonzero', nz, 'pools with swaps', poolsAny, 'pools with nonzero', poolsNz);
