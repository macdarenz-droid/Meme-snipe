// REPLAY-1000 debugging aid: a pool's transactions around one signature, with each one's pre-trade fields and the
// rebuilt state after it (offline, from the cache).
//   node research/replay-1000/trace-pool.ts <pool> <signature> [slots before] [slots after]
import { loadIndex } from './coins.ts';
import { DATA_DIR, PublicRpc } from './rpc.ts';
import { ChainView } from './world/chain.ts';
import { accountKeys, poolAfter, type RpcTx } from './world/pool-state.ts';

const main = async () => {
  const [pool, sig, before = '40', after = '5'] = process.argv.slice(2) as [string, string, string?, string?];
  const chain = new ChainView(new PublicRpc([], DATA_DIR), loadIndex());
  const t = (await chain.transaction(sig, Number.MAX_SAFE_INTEGER)) as unknown as RpcTx & { slot: number };
  const keys = accountKeys(sig, t);
  void keys;
  const sigs = (await chain.signaturesBetween(pool, t.slot - Number(before) - 1, t.slot + Number(after))).filter((x) => x.err === null);
  sigs.sort((a, b) => a.slot - b.slot || ((a as { transactionIndex?: number }).transactionIndex ?? 0) - ((b as { transactionIndex?: number }).transactionIndex ?? 0));
  let vaults: { baseVault: string; quoteVault: string } | null = null;
  let e: bigint | null = null;
  for (const s of sigs) {
    const tx = (await chain.transaction(s.signature, Number.MAX_SAFE_INTEGER)) as unknown as RpcTx;
    if (vaults === null) {
      const k = accountKeys(sig, t);
      const owned = (t.meta.postTokenBalances ?? []).filter((x) => x.owner === pool);
      const q = owned.find((x) => x.mint === 'So11111111111111111111111111111111111111112')!;
      const bb = owned.find((x) => x.mint !== 'So11111111111111111111111111111111111111112')!;
      vaults = { baseVault: k[bb.accountIndex]!, quoteVault: k[q.accountIndex]! };
    }
    const p = poolAfter(s.signature, tx, { address: pool, ...vaults }, e);
    if (p !== null && p.effective !== null) e = p.effective;
    console.log(s.slot, (s as { transactionIndex?: number }).transactionIndex, s.signature.slice(0, 10), s.signature === sig ? '<==' : '   ',
      p === null ? 'no vault change' : `pre ${p.firstPre ? `${p.firstPre.baseVault}/${p.firstPre.quoteVault}/${p.firstPre.virtual}` : '-'} post ${p.baseVault}/${p.quoteVault}/${p.virtualQuoteReserves} ${p.events.join(',')}`);
  }
};

await main();
