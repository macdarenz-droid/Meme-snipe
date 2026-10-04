// Test fixtures only (POS-1): a PumpSwap swap continuing a pool's reserves, as the program logs it. Amounts come from
// the exact PumpSwap math at fixed observed fee terms; `logs` is the logsSubscribe notification's lines with the Borsh
// BuyEvent/SellEvent in its `Program data:` line, so FEED-1 and DEC-1 decode it as live.
import { type PoolState, poolBuyExactBase, poolSell } from '../../src/amm/index.ts';
import { BuyEventLayout, PUMP_AMM_PROGRAM, SellEventLayout, toBase64 } from '../../src/chain/index.ts';
import { observedFeeContext } from '../../src/fills/index.ts';
import { bps } from '../../src/units/index.ts';
import { encode } from '../chain/encode.ts';

const USER = 'Trader1111111111111111111111111111111111111';

export const swapLog = (o: {
  readonly pool: string; readonly coinCreator: string; readonly supply: bigint; readonly pre: PoolState; readonly side: 'buy' | 'sell'; readonly base: bigint; readonly atMs: number;
}): { readonly data: Record<string, unknown>; readonly logs: string[]; readonly after: PoolState } => {
  const ctx = observedFeeContext({ split: { lp: bps(2), protocol: bps(93), creator: bps(30) }, buybackFeeBps: bps(5_000), instruction: 'v1' }, o.supply, { mayhemMode: false, transferFee: false, transferHook: false });
  const q = o.side === 'buy' ? poolBuyExactBase(o.pre, o.base, ctx) : poolSell(o.pre, o.base, ctx);
  if (!q.ok) throw new Error(q.reason);
  const t = q.trade;
  const data = {
    timestamp: BigInt(Math.floor(o.atMs / 1000)), poolBaseTokenReserves: o.pre.baseReserve, poolQuoteTokenReserves: o.pre.quoteVault,
    lpFeeBasisPoints: 2n, lpFee: t.lpFee, protocolFeeBasisPoints: 93n, protocolFee: t.protocolFee, pool: o.pool, user: USER, userBaseTokenAccount: USER, userQuoteTokenAccount: USER,
    protocolFeeRecipient: USER, protocolFeeRecipientTokenAccount: USER, coinCreator: o.coinCreator, coinCreatorFeeBasisPoints: 30n, coinCreatorFee: t.creatorFee, cashbackFeeBasisPoints: 0n, cashback: 0n,
    buybackFeeBasisPoints: 5_000n, buybackFee: t.buybackFee, virtualQuoteReserves: o.pre.virtualQuoteReserves, canBoost: false, baseSupply: o.supply, holderRewardsBps: 0n, holderRewards: 0n,
    userBaseTokenReserves: 0n, userQuoteTokenReserves: 0n, trackVolume: false, totalUnclaimedTokens: 0n, totalClaimedTokens: 0n, currentSolVolume: 0n, lastUpdateTimestamp: 0n,
    ...(o.side === 'buy'
      ? { baseAmountOut: o.base, maxQuoteAmountIn: t.userQuote, quoteAmountIn: t.quote, quoteAmountInWithLpFee: t.quote + t.lpFee, userQuoteAmountIn: t.userQuote, minBaseAmountOut: o.base, ixName: 'buy' }
      : { baseAmountIn: o.base, minQuoteAmountOut: 0n, quoteAmountOut: t.quote, quoteAmountOutWithoutLpFee: t.quote - t.lpFee, userQuoteAmountOut: t.userQuote }),
  };
  const l = o.side === 'buy' ? BuyEventLayout : SellEventLayout;
  const bytes = Uint8Array.from([...l.discriminator, ...encode([...l.base, ...l.added] as unknown as readonly (readonly [string, { idl: unknown }])[], data)]);
  return { data, after: t.after, logs: [`Program ${PUMP_AMM_PROGRAM} invoke [1]`, `Program data: ${toBase64(bytes)}`, `Program ${PUMP_AMM_PROGRAM} success`] };
};
