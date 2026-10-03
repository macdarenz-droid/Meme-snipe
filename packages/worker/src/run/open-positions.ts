// /health's open positions (WORKER-1c): every position not closed and not still opening, oldest first (by the
// account's open time, then id), each with its entry, stop, latest mark and universe in the RUN-1d contract's shape.
import type { PositionState } from '../../../core/src/lifecycle/index.ts';
import { execPrice } from '../../../core/src/exits/index.ts';
import type { OpenPositionHealth } from '../../../runner/src/contract.ts';

/** A position's entry as a price per token (PRICE_SCALE), the unit of its stop and mark: entry spend over tokens bought. */
export const entryPrice = (p: { readonly cost: bigint; readonly quantity: bigint; readonly sold: bigint }): bigint =>
  p.quantity + p.sold > 0n ? execPrice(p.cost, p.quantity + p.sold) : 0n;

export interface PositionSources {
  /** When the account saw the position open; null when it has no record (sorted last). */
  readonly openedAt: (id: string) => number | null;
  /** The saved exit plan's stop and universe; null without a saved plan. */
  readonly plan: (id: string) => { readonly stopPrice: bigint; readonly universe: string } | null;
  readonly mark: (id: string) => { readonly price: bigint; readonly atMs: number; readonly slot: bigint } | null;
}

export const openPositionsHealth = (positions: readonly PositionState[], s: PositionSources): OpenPositionHealth[] => {
  const at = (id: string): number => s.openedAt(id) ?? Number.MAX_SAFE_INTEGER;
  return positions.filter((x) => x.status !== 'closed' && x.status !== 'opening')
    .sort((a, b) => at(a.id) - at(b.id) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((p) => {
      const plan = s.plan(p.id);
      const mark = s.mark(p.id);
      return {
        trade: p.id, mint: p.mint, qty: String(p.quantity), entry: String(entryPrice(p)), stop: plan === null ? 'unknown' : String(plan.stopPrice),
        // No mark read yet: the entry, seen at time 0, which the runner reads as unmeasured (older than 30 s).
        mark: String(mark?.price ?? entryPrice(p)), mark_slot: mark === null ? 0 : Number(mark.slot), mark_ts: mark?.atMs ?? 0,
        // The universe the position was entered under (CFG-2; RUN-1d contract); no saved plan: unknown, which fails the drill.
        universe: plan === null ? 'unknown' : plan.universe,
      };
    });
};
