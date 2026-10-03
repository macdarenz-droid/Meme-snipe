// Executable liquidation value (docs/ARCHITECTURE.md §9): our whole size sold into the current pool or curve state,
// net of fees, with the exact CORE-2 quote math. Exit triggers read only this, never a last-trade print or a candle.
import {
  type CurveFeeContext, type CurveState, type NoQuoteReason, type PoolFeeContext, type PoolState,
  curveSell, effectiveQuoteReserve, poolSell,
} from '../amm/index.ts';
import { PRICE_SCALE } from '../config/index.ts';

/** The market an exit sells into, as of the current moment. */
export type ExitMarket =
  | { readonly venue: 'pumpswap'; readonly pool: PoolState; readonly ctx: PoolFeeContext }
  | { readonly venue: 'pump-curve'; readonly curve: CurveState; readonly ctx: CurveFeeContext };

export type Liquidation =
  | { readonly ok: true; readonly value: bigint }
  | { readonly ok: false; readonly reason: NoQuoteReason | 'nothing-held' | 'no-market'; readonly detail: string };

/** Lamports we would receive for `tokens`, fees deducted, at the real size against current reserves. */
export const liquidationValue = (m: ExitMarket, tokens: bigint): Liquidation => {
  if (tokens <= 0n) return { ok: false, reason: 'nothing-held', detail: 'no tokens to sell' };
  const q = m.venue === 'pumpswap' ? poolSell(m.pool, tokens, m.ctx) : curveSell(m.curve, tokens, m.ctx);
  if (!q.ok) return q;
  return { ok: true, value: q.trade.userQuote };
};

/** SOL that can leave the market: the pool's effective quote reserve or the curve's real SOL reserve. */
export const quoteReserve = (m: ExitMarket): bigint =>
  m.venue === 'pumpswap' ? effectiveQuoteReserve(m.pool) : m.curve.realQuoteReserves;

export { PRICE_SCALE };

/** Executable price of a position: its liquidation value per raw token, scaled, floored. */
export const execPrice = (value: bigint, tokens: bigint): bigint => {
  if (tokens <= 0n) throw new RangeError('tokens must be > 0');
  return (value * PRICE_SCALE) / tokens;
};

/** True when `value` for `tokens` is at or below the price level `levelFp`. Exact: no division. */
export const atOrBelow = (value: bigint, tokens: bigint, levelFp: bigint): boolean => value * PRICE_SCALE <= levelFp * tokens;

/** A completed bar of executable price (fixed-point, PRICE_SCALE), as of its end. */
export interface PriceBar {
  readonly startMs: number;
  readonly high: bigint;
  readonly low: bigint;
  readonly close: bigint;
}

/**
 * Wilder's ATR over the last bars that ended by `nowMs`: the first value is the mean true range of the first `period`
 * bars, then ATR = (ATR × (period − 1) + TR) / period. Bars must be contiguous `barMs` steps; a gap, an unordered or
 * an unfinished bar is not used (the series restarts after a gap). Null when fewer than `period` usable bars exist.
 */
export const atr = (bars: readonly PriceBar[], period: number, barMs: number, nowMs: number): bigint | null => {
  if (!Number.isSafeInteger(period) || period < 1) throw new RangeError('period must be a whole number >= 1');
  const done = bars.filter((b) => b.startMs + barMs <= nowMs);
  // The run of contiguous bars that ends with the latest finished bar.
  let from = done.length - 1;
  while (from > 0 && done[from - 1]!.startMs + barMs === done[from]!.startMs) from--;
  const run = from < 0 ? [] : done.slice(from);
  if (run.length < period) return null;
  const p = BigInt(period);
  const tr = run.map((b, i) => {
    const prev = i === 0 ? null : run[i - 1]!.close;
    const hi = prev !== null && prev > b.high ? prev : b.high;
    const lo = prev !== null && prev < b.low ? prev : b.low;
    return hi - lo;
  });
  let value = tr.slice(0, period).reduce((a, b) => a + b, 0n) / p;
  for (let i = period; i < tr.length; i++) value = (value * (p - 1n) + tr[i]!) / p;
  return value;
};
