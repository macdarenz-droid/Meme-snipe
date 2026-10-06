import { logEvents } from '/home/user/wt-crash/packages/core/src/chain/transaction.ts';
import { tradeTailCollapse } from '/home/user/wt-crash/packages/core/src/gates/tails.ts';
import { decodePool } from '/home/user/wt-crash/packages/core/src/chain/pump-amm.ts';
const RPC = 'https://api.mainnet-beta.solana.com';
const sleep = (ms: number) => new Promise((g) => setTimeout(g, ms));
const call = async (method: string, params: unknown[]) => {
  for (let i = 0; i < 10; i++) {
    const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    if (r.status === 429) { await sleep(2000); continue; }
    const j: any = await r.json();
    if (j.error?.code === 429) { await sleep(2000); continue; }
    if (j.error) throw new Error(JSON.stringify(j.error));
    return j.result;
  }
  throw new Error('429s');
};
const N = Number(process.argv[2] ?? 120);
const sigs: any[] = await call('getSignaturesForAddress', ['pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', { limit: 1000 }]);
const ok = sigs.filter((s) => s.err === null);
// spread the sample over the page
const step = Math.max(1, Math.floor(ok.length / N));
const pick = ok.filter((_, i) => i % step === 0).slice(0, N);
type Ev = { pool: string; name: string; extra: string; kept: boolean; trailing: number };
const evs: Ev[] = [];
for (const s of pick) {
  let tx: any;
  try { tx = await call('getTransaction', [s.signature, { maxSupportedTransactionVersion: 1, commitment: 'confirmed', encoding: 'json' }]); } catch { continue; }
  if (!tx?.meta?.logMessages) continue;
  let read; try { read = logEvents(tx.meta.logMessages, null); } catch { continue; }
  for (const e of read.events as any[]) {
    if (e.program !== 'pump_amm' || (e.name !== 'BuyEvent' && e.name !== 'SellEvent')) continue;
    const key = `logs:pump_amm:${e.name}:${e.data.pool}`;
    const entry = { moment: { slot: BigInt(tx.slot), txIndex: 0, ixIndex: 0, receivedAt: 0 }, source: 'x', value: { event: e, signature: s.signature, txSlot: BigInt(tx.slot), truncated: read.truncated, via: 'logs:x' } };
    evs.push({ pool: e.data.pool, name: e.name, extra: e.extra, trailing: e.trailing, kept: tradeTailCollapse(key)!(entry as any) });
  }
  await sleep(250);
}
const pools = [...new Set(evs.map((e) => e.pool))];
const info = new Map<string, any>();
for (let i = 0; i < pools.length; i += 50) {
  const r: any = await call('getMultipleAccounts', [pools.slice(i, i + 50), { encoding: 'base64' }]);
  r.value.forEach((a: any, k: number) => {
    if (a === null) return;
    try { const p = decodePool(Buffer.from(a.data[0], 'base64')).value as any; info.set(pools[i + k]!, p); } catch (e) { info.set(pools[i + k]!, { err: String(e).slice(0, 60) }); }
  });
}
const SOL = 'So11111111111111111111111111111111111111112';
const tally = new Map<string, number>();
for (const e of evs) {
  const p = info.get(e.pool);
  const quote = p?.quoteMint === SOL ? 'SOL' : p?.quoteMint ? String(p.quoteMint).slice(0, 6) : '?';
  const pumpCoin = p?.baseMint ? String(p.baseMint).endsWith('pump') : '?';
  const k = `quote=${quote} pumpBase=${pumpCoin} cashback=${p?.isCashbackCoin} mayhem=${p?.isMayhemMode} tailNonZero=${/[^0]/.test(e.extra)} trailing=${e.trailing} keptByCollapse=${e.kept}`;
  tally.set(k, (tally.get(k) ?? 0) + 1);
}
console.log('events', evs.length, 'pools', pools.length, 'txs sampled', pick.length, 'slots', pick[0]?.slot, pick.at(-1)?.slot);
for (const [k, n] of [...tally].sort((a, b) => b[1] - a[1])) console.log(n, k);
