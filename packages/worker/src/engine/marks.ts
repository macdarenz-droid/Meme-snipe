// RISK-MARK: risk's mark of each open position. Risk counts an open position with no mark as a total loss and refuses
// entries while one is unknown or stale, and R10's NAV needs every mark; so each mark is the position's executable
// value now (core exits `executableMark`: the full-size sell after fees, less the exit's accepted slippage and its
// network cost), valued at the live SOL price, and only from a fresh, usable market. Anything else keeps mark null.
import type { PoolFeeContext, PoolState } from '../../../core/src/amm/index.ts';
import { executableMark } from '../../../core/src/exits/index.ts';
import type { AccountHistory, Timed } from '../../../core/src/risk/index.ts';
import { type Lamports, type MicroUsd, lamportsToMicroUsd } from '../../../core/src/units/index.ts';

/** A held position as the mark needs it: its tokens and the market it sells into now, or why there is none. */
export interface HeldMarket {
  readonly quantity: bigint;
  readonly market: { readonly pool: PoolState; readonly ctx: PoolFeeContext; readonly atMs: number } | null;
}

export interface MarkSettings {
  /** The exit's accepted slippage (the first ladder rung's minimum out below the quote). */
  readonly slippageBps: number;
  /** The exit transaction's network cost, lamports. */
  readonly exitCost: bigint;
  /** A market older than this keeps the mark null (the gates' maxQuoteAgeMs). */
  readonly maxAgeMs: number;
}

/** The account history with each open position marked, or left null (a total loss to risk) when it cannot be. */
export const markedHistory = (h: AccountHistory, held: (mint: string) => HeldMarket | undefined, sol: Timed<MicroUsd> | null, nowMs: number, s: MarkSettings): AccountHistory => ({
  ...h,
  openPositions: h.openPositions.map((o) => {
    const p = held(o.mint);
    const m = p?.market ?? null;
    if (p === undefined || m === null || sol === null || sol.value <= 0n || nowMs - m.atMs > s.maxAgeMs || m.atMs > nowMs) return { ...o, mark: null, markAtMs: null };
    const v = executableMark({ venue: 'pumpswap', pool: m.pool, ctx: m.ctx }, p.quantity, { slippageBps: s.slippageBps, exitCost: s.exitCost });
    return v.ok ? { ...o, mark: lamportsToMicroUsd(v.value as Lamports, sol.value, 'floor'), markAtMs: m.atMs } : { ...o, mark: null, markAtMs: null };
  }),
});
