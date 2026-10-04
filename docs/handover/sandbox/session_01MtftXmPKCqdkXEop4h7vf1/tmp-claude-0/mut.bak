// RISK-MARK: risk's mark of each open position. Risk counts an open position with no mark as a total loss and refuses
// entries while one is unknown or stale, and R10's NAV needs every mark; so each mark is the position's executable
// value now (core exits `executableMark`: the full-size sell after fees, less the worst slippage the exit ladder accepts
// and that rung's network cost), valued at a fresh SOL price, and only from a fresh, usable market. Anything else keeps
// the mark null. One helper for entries and exits (`riskAccount`); on the exit path a failure falls back to the
// unmarked account, so marking can never block an exit.
import type { PoolFeeContext, PoolState } from '../../../core/src/amm/index.ts';
import type { Policy } from '../../../core/src/config/index.ts';
import type { NetworkPolicy } from '../../../core/src/costs/index.ts';
import { executableMark } from '../../../core/src/exits/index.ts';
import type { AccountHistory, Timed } from '../../../core/src/risk/index.ts';
import { type Lamports, type MicroUsd, lamportsToMicroUsd } from '../../../core/src/units/index.ts';

/** A held position as the mark needs it: its tokens and the market it sells into now, or why there is none. */
export interface HeldMarket {
  readonly quantity: bigint;
  readonly market: { readonly pool: PoolState; readonly ctx: PoolFeeContext; readonly atMs: number } | null;
}

export interface MarkSettings {
  /** The worst slippage the exit accepts (the last ladder rung's minimum out below the quote). */
  readonly slippageBps: number;
  /** That rung's exit transaction network cost, lamports: signatures × base fee + its priority fee + the tip. */
  readonly exitCost: bigint;
  /** A market or SOL price older than this keeps the mark null (the gates' maxQuoteAgeMs). */
  readonly maxAgeMs: number;
}

/** The mark's settings from the locked policy and the network costs: the ladder's last rung, the gates' freshness. */
export const markSettings = (policy: Policy, n: Pick<NetworkPolicy, 'signaturesPerTx' | 'baseFeePerSignature' | 'tip'>): MarkSettings => {
  const last = policy.exits.ladder.steps.at(-1)!;
  return { slippageBps: last.minOutBelowTriggerBps, exitCost: n.signaturesPerTx * n.baseFeePerSignature + last.priorityFeeLamports + n.tip, maxAgeMs: policy.gates.maxQuoteAgeMs };
};

/** Risk's freshness rule: stamped at or before now and no older than `maxAgeMs`. */
const fresh = (atMs: number, nowMs: number, maxAgeMs: number): boolean => atMs <= nowMs && nowMs - atMs <= maxAgeMs;

/** The account history with each open position marked, or left null (a total loss to risk) when it cannot be. */
export const markedHistory = (h: AccountHistory, held: (mint: string) => HeldMarket | undefined, sol: Timed<MicroUsd> | null, nowMs: number, s: MarkSettings): AccountHistory => ({
  ...h,
  openPositions: h.openPositions.map((o) => {
    const p = held(o.mint);
    const m = p?.market ?? null;
    if (p === undefined || m === null || sol === null || sol.value <= 0n || !fresh(sol.atMs, nowMs, s.maxAgeMs) || !fresh(m.atMs, nowMs, s.maxAgeMs)) return { ...o, mark: null, markAtMs: null };
    const v = executableMark({ venue: 'pumpswap', pool: m.pool, ctx: m.ctx }, p.quantity, { slippageBps: s.slippageBps, exitCost: s.exitCost });
    return v.ok ? { ...o, mark: lamportsToMicroUsd(v.value as Lamports, sol.value, 'floor'), markAtMs: m.atMs } : { ...o, mark: null, markAtMs: null };
  }),
});

/**
 * The account risk judges, for entries and exits alike. On an exit (`fallback`), any failure while marking gives the
 * unmarked account back (every open position a total loss, as before marks existed): an exit is never blocked by it.
 * On an entry it throws, and the strategy refuses that candidate. `mark` replaces `markedHistory` (tests inject a fault).
 */
export const riskAccount = (
  h: AccountHistory, held: (mint: string) => HeldMarket | undefined, sol: Timed<MicroUsd> | null, nowMs: number, s: MarkSettings,
  o: { readonly fallback: boolean; readonly mark?: typeof markedHistory },
): AccountHistory => {
  const mark = o.mark ?? markedHistory;
  if (!o.fallback) return mark(h, held, sol, nowMs, s);
  try {
    return mark(h, held, sol, nowMs, s);
  } catch {
    return h;
  }
};
