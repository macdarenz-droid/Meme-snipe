// Per-pool sample: for SOL-quoted pump pools seen trading now, read their last swaps and decode the tails.
import { logEvents } from '/home/user/wt-crash/packages/core/src/chain/transaction.ts';
import { decodePool } from '/home/user/wt-crash/packages/core/src/chain/pump-amm.ts';
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
const SOL = 'So11111111111111111111111111111111111111112';
// 1) find pools from a few program txs
const sigs: any[] = (await call('getSignaturesForAddress', ['pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', { limit: 300 }])).filter((s: any) => s.err === null);
const pools = new Set<string>();
for (const s of sigs.slice(0, 80)) {
  if (pools.size >= 14) break;
  try { const tx = await getTx(s.signature); const r = logEvents(tx.meta.logMessages, null); for (const e of r.events as any[]) if (e.program === 'pump_amm' && (e.name === 'BuyEvent' || e.name === 'SellEvent')) pools.add(e.data.pool); } catch {}
  await sleep(200);
}
const list = [...pools];
const acc: any = await call('getMultipleAccounts', [list, { encoding: 'base64' }]);
const solPump = list.filter((p, k) => { const a = acc.value[k]; if (!a) return false; try { const v = decodePool(Buffer.from(a.data[0], 'base64')).value as any; return v.quoteMint === SOL && String(v.baseMint).endsWith('pump'); } catch { return false; } });
console.log('pools found', list.length, 'SOL pump pools', solPump.length);
const u64 = (hex: string) => { let v = 0n; for (let i = hex.length - 2; i >= 0; i -= 2) v = (v << 8n) | BigInt(parseInt(hex.slice(i, i + 2), 16)); return v; };
let tot = 0, nz = 0;
for (const pool of solPump.slice(0, 10)) {
  const ps: any[] = (await call('getSignaturesForAddress', [pool, { limit: 25 }])).filter((s: any) => s.err === null).slice(0, 12);
  let n = 0, z = 0; const samples: string[] = [];
  for (const s of ps) {
    try {
      const tx = await getTx(s.signature);
      const r = logEvents(tx.meta.logMessages, null);
      for (const e of r.events as any[]) {
        if (e.program !== 'pump_amm' || (e.name !== 'BuyEvent' && e.name !== 'SellEvent') || e.data.pool !== pool) continue;
        n++; if (/[^0]/.test(e.extra)) { z++; if (samples.length < 4) { const q = e.name === 'BuyEvent' ? e.data.quoteAmountIn : e.data.quoteAmountOut; samples.push(`${e.name[0]} tail=${u64(e.extra)} quote=${q} ratio_bp=${q ? (u64(e.extra) * 10000n / BigInt(q)) : '-'}`); } }
      }
    } catch {}
    await sleep(200);
  }
  tot += n; nz += z;
  console.log(pool.slice(0, 8), 'swaps', n, 'nonzero', z, samples.join(' | '));
}
console.log('TOTAL swaps', tot, 'nonzero tails', nz, (100 * nz / Math.max(1, tot)).toFixed(0) + '%');
