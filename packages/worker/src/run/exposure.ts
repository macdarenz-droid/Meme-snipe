// RUN-1c's `exposure` line: after a restart, for each trade open or in flight at the kill, the worst price move of its
// pool over the down window, rebuilt from chain history (the pool's swaps between the last line the previous process
// wrote and now). The reference is the position's last spot price before the kill (saved with its exit plan). Each
// swap's pool price is taken before and after it (pre-trade reserves from the event, then the trade applied, as
// FACTS-1 builds candles). A rebuild that cannot be done says why and gives no number: the run then fails its check.
import { type TransactionRecord, transactionEvents } from '../../../core/src/chain/index.ts';
import { PRICE_SCALE } from '../../../core/src/config/index.ts';
import { P2 } from '../scheduler/index.ts';
import type { SeedRpc } from '../seed/rpc.ts';

export interface ExposureResult {
  readonly worst_move_bps: number | null;
  readonly swaps: number;
  readonly reason: string;
}

const big = (v: unknown): bigint | null => (typeof v === 'bigint' ? v : null);
const priceOf = (base: bigint, quote: bigint): bigint | null => (base > 0n && quote >= 0n ? (quote * PRICE_SCALE) / base : null);

/** The pool prices before and after each PumpSwap swap on `pool` in a transaction. */
export const swapPrices = (rec: TransactionRecord, pool: string): bigint[] => {
  const out: bigint[] = [];
  for (const e of transactionEvents(rec)) {
    if (e.program !== 'pump_amm' || (e.name !== 'BuyEvent' && e.name !== 'SellEvent')) continue;
    const d = e.data as unknown as Record<string, unknown>;
    if (d['pool'] !== pool) continue;
    const base = big(d['poolBaseTokenReserves']);
    const quote = big(d['poolQuoteTokenReserves']);
    if (base === null || quote === null) continue;
    const virtual = big(d['virtualQuoteReserves']) ?? 0n;
    const after = e.name === 'BuyEvent'
      ? { base: base - (big(d['baseAmountOut']) ?? 0n), quote: quote + (big(d['quoteAmountInWithLpFee']) ?? 0n) }
      : { base: base + (big(d['baseAmountIn']) ?? 0n), quote: quote - (big(d['quoteAmountOutWithoutLpFee']) ?? 0n) };
    for (const p of [priceOf(base, quote + virtual), priceOf(after.base, after.quote + virtual)]) if (p !== null) out.push(p);
  }
  return out;
};

/** |p − ref| / ref in basis points, rounded up. */
const moveBps = (p: bigint, ref: bigint): number => {
  const d = p > ref ? p - ref : ref - p;
  return Number((d * 10_000n + ref - 1n) / ref);
};

export const rebuildMove = async (o: {
  readonly rpc: SeedRpc; readonly pool: string | null; readonly ref: bigint | null; readonly fromMs: number; readonly toMs: number; readonly maxTx: number;
}): Promise<ExposureResult> => {
  if (o.pool === null) return { worst_move_bps: null, swaps: 0, reason: 'pool unknown (not saved with the exit plan)' };
  if (o.ref === null || o.ref <= 0n) return { worst_move_bps: null, swaps: 0, reason: 'no price saved before the kill' };
  let worst = 0;
  let swaps = 0;
  let read = 0;
  let before: string | undefined;
  try {
    for (;;) {
      const page = await o.rpc.getSignaturesForAddress(o.pool, before === undefined ? { limit: 100 } : { before, limit: 100 }, P2);
      if (page.length === 0) break;
      for (const s of page) {
        const ms = s.blockTime === null ? null : s.blockTime * 1000;
        if (ms !== null && ms > o.toMs + 1_000) continue;
        if (ms !== null && ms < o.fromMs - 1_000) return { worst_move_bps: worst, swaps, reason: `${swaps} swaps read over the down window` };
        if (s.err !== null) continue;
        if (read >= o.maxTx) return { worst_move_bps: null, swaps, reason: `more than ${o.maxTx} transactions in the down window; not rebuilt in full` };
        read++;
        const rec = await o.rpc.getTransaction(s.signature, P2);
        if (rec === null) return { worst_move_bps: null, swaps, reason: `transaction ${s.signature} not readable` };
        const prices = swapPrices(rec, o.pool);
        if (prices.length > 0) swaps++;
        for (const p of prices) worst = Math.max(worst, moveBps(p, o.ref));
      }
      if (page.length < 100) break;
      before = page[page.length - 1]!.signature;
    }
  } catch (e) {
    return { worst_move_bps: null, swaps, reason: `chain history read failed: ${e instanceof Error ? e.message : 'error'}` };
  }
  return { worst_move_bps: worst, swaps, reason: `${swaps} swaps read over the down window` };
};
