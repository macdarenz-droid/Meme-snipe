import { readFileSync } from 'node:fs';
import { replaySwap, type RealSwap } from '/home/user/Meme-snipe/packages/core/src/fills/index.ts';
import { bps } from '/home/user/Meme-snipe/packages/core/src/units/index.ts';
const g = JSON.parse(readFileSync('/home/user/Meme-snipe/packages/core/test/amm/fixtures/golden.json', 'utf8'));
const V2 = ['5df6823ce7e940b2', 'c2ab1c46684d5b2f', 'b817ee6167c5d33d'];
const n = (s: string) => BigInt(s);
const res: Record<string, { bt: number[]; vault: number[]; neg: number }> = {};
for (const v of g.pumpswap) {
  const e = v.event;
  const kind = `${v.kind}${v.pool.canonical ? '' : ' (non-canonical)'}`;
  const r = (res[v.kind] ??= { bt: [], vault: [], neg: 0 });
  const swap = (virt: bigint): RealSwap => ({
    side: v.kind, mode: v.kind === 'buy' && v.ixName !== 'buy' ? 'exact-quote-in' : 'exact-base', amount: n(v.args[0]),
    pre: { baseReserve: n(e.pool_base_token_reserves), quoteVault: n(e.pool_quote_token_reserves), virtualQuoteReserves: virt },
    fees: { split: { lp: bps(+e.lp_fee_basis_points), protocol: bps(+e.protocol_fee_basis_points), creator: bps(+e.coin_creator_fee_basis_points) }, buybackFeeBps: bps(+e.buyback_fee_basis_points), instruction: V2.includes(v.ixDisc) ? 'v2' : 'v1' },
    baseSupply: n(e.base_supply),
  });
  const actual = v.kind === 'buy' ? n(e.base_amount_out) : n(e.user_quote_amount_out);
  const err = (virt: bigint) => {
    const q = replaySwap(swap(virt).pre, swap(virt));
    if (!q.ok) return NaN;
    const got = v.kind === 'buy' ? q.trade.base : q.trade.userQuote;
    return Number(((got - actual) * 1_000_000n) / actual) / 10_000; // percent
  };
  const virt = n(e.virtual_quote_reserves ?? '0');
  if (virt !== 0n) r.neg++;
  r.bt.push(err(virt));
  r.vault.push(err(0n));
  void kind;
}
const stat = (xs: number[]) => {
  const s = xs.filter((x) => !Number.isNaN(x)).sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
  const abs = s.map(Math.abs).sort((a, b) => a - b);
  return `n=${s.length} median ${q(0.5).toFixed(4)}% p95 ${q(0.95).toFixed(4)}% worst |err| ${abs[abs.length - 1]!.toFixed(4)}%`;
};
for (const [k, r] of Object.entries(res)) {
  console.log(`${k}: swaps with non-zero virtual_quote_reserves: ${r.neg}`);
  console.log(`  BT-1 (vault + virtual):   ${stat(r.bt)}`);
  console.log(`  vault only (RES-2 model): ${stat(r.vault)}`);
  const sub = r.vault.filter((_, i) => true);
  void sub;
}
// Vault balance deltas measured on chain (pre/post token balances) against BT-1's replayed post-state.
let ok = 0, bad = 0;
const bySig = new Map(g.pumpswap.map((v: any) => [`${v.signature}:${v.eventIndex}`, v]));
for (const d of g.vaultDeltas) {
  const v: any = bySig.get(`${d.signature}:${d.eventIndex}`);
  if (!v) continue;
  const e = v.event;
  const s: RealSwap = {
    side: v.kind, mode: v.kind === 'buy' && v.ixName !== 'buy' ? 'exact-quote-in' : 'exact-base', amount: n(v.args[0]),
    pre: { baseReserve: n(e.pool_base_token_reserves), quoteVault: n(e.pool_quote_token_reserves), virtualQuoteReserves: n(e.virtual_quote_reserves ?? '0') },
    fees: { split: { lp: bps(+e.lp_fee_basis_points), protocol: bps(+e.protocol_fee_basis_points), creator: bps(+e.coin_creator_fee_basis_points) }, buybackFeeBps: bps(+e.buyback_fee_basis_points), instruction: V2.includes(v.ixDisc) ? 'v2' : 'v1' },
    baseSupply: n(e.base_supply),
  };
  const q = replaySwap(s.pre, s);
  if (q.ok && q.trade.after.baseReserve - s.pre.baseReserve === n(d.basePost) - n(d.basePre) && q.trade.after.quoteVault - s.pre.quoteVault === n(d.quotePost) - n(d.quotePre)) ok++; else bad++;
}
console.log(`on-chain vault balance deltas reproduced exactly: ${ok} of ${ok + bad}`);
