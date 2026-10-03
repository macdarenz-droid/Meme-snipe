// Time series the gates share: SOL/USD, used by the liquidity floor (H8) and the regime gate (§6.4).
// Series cadence is part of the series definition (hourly SOL/USD, daily volume), not a tunable threshold.
import { HOUR_MS } from '../config/time.ts';
import type { SolUsdFact } from './facts.ts';

export { DAY_MS, HOUR_MS, MINUTE_MS } from '../config/time.ts';

/** An hourly series is current while its latest point is at most two of its steps old (one step of publishing lag). */
export const HOURLY_MAX_AGE_MS = 2 * HOUR_MS;

/** The latest SOL/USD point at or before `atMs`, ignoring any point dated later. */
export const solUsdAt = (f: SolUsdFact, atMs: number): { readonly tMs: number; readonly price: bigint } | null => {
  let best: { readonly tMs: number; readonly price: bigint } | null = null;
  for (const p of f.points) if (p.tMs <= atMs && (best === null || p.tMs > best.tMs)) best = p;
  return best;
};

/** The point stamped exactly `tMs`, or null. */
export const solUsdExact = (f: SolUsdFact, tMs: number): bigint | null => f.points.find((p) => p.tMs === tMs)?.price ?? null;

export const floorTo = (ms: number, step: number): number => Math.floor(ms / step) * step;
