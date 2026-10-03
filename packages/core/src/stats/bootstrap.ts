// Day-block bootstrap for the mean net return per trade. Trades on the same calendar day share SOL price,
// launchpad flow and the bot population, so their returns are correlated; resampling whole days keeps that
// correlation in every replicate (cluster bootstrap; quant.md §2.1, Kamat arXiv 2607.02823 v4).
// The statistic is the pooled mean: Σ returns over the resampled days / Σ trades over the resampled days.

import { quantileSorted } from './descriptive.ts';
import { nextInt, type Rng } from './rng.ts';

export interface DayReturn {
  /** Calendar day key, e.g. "2026-10-03" (Melbourne day, chosen by the caller). */
  readonly day: string;
  /** Net return as a fraction of notional, all costs included. */
  readonly rNet: number;
}

interface DayBlock {
  readonly day: string;
  sumA: number;
  countA: number;
  sumB: number;
  countB: number;
}

const blocks = (a: readonly DayReturn[], b: readonly DayReturn[] = []): DayBlock[] => {
  const byDay = new Map<string, DayBlock>();
  const get = (day: string): DayBlock => {
    let blk = byDay.get(day);
    if (!blk) {
      blk = { day, sumA: 0, countA: 0, sumB: 0, countB: 0 };
      byDay.set(day, blk);
    }
    return blk;
  };
  for (const t of a) {
    if (!Number.isFinite(t.rNet)) throw new RangeError(`rNet must be finite, got ${t.rNet} on ${t.day}`);
    const blk = get(t.day);
    blk.sumA += t.rNet;
    blk.countA += 1;
  }
  for (const t of b) {
    if (!Number.isFinite(t.rNet)) throw new RangeError(`rNet must be finite, got ${t.rNet} on ${t.day}`);
    const blk = get(t.day);
    blk.sumB += t.rNet;
    blk.countB += 1;
  }
  // Sorted by day so the result does not depend on input order.
  return [...byDay.values()].sort((x, y) => (x.day < y.day ? -1 : x.day > y.day ? 1 : 0));
};

export interface BootstrapOptions {
  readonly rng: Rng;
  /** Number of bootstrap replicates (default 2,000). */
  readonly replicates?: number;
}

const replicateStats = (
  days: readonly DayBlock[],
  estimate: number,
  opts: BootstrapOptions,
  stat: (sumA: number, countA: number, sumB: number, countB: number) => number,
): number[] => {
  const reps = opts.replicates ?? 2000;
  if (!Number.isInteger(reps) || reps < 100) throw new RangeError(`replicates must be an integer >= 100, got ${reps}`);
  if (days.length < 2) throw new RangeError('day-block bootstrap needs trades on at least two days');
  const out: number[] = [];
  for (let r = 0; r < reps; r++) {
    let sA = 0;
    let cA = 0;
    let sB = 0;
    let cB = 0;
    for (let i = 0; i < days.length; i++) {
      const d = days[nextInt(opts.rng, days.length)]!;
      sA += d.sumA;
      cA += d.countA;
      sB += d.sumB;
      cB += d.countB;
    }
    const v = stat(sA, cA, sB, cB);
    if (Number.isFinite(v)) out.push(v);
  }
  // A replicate can be undefined only when it drew no trades for one side; too many of those means too little data.
  if (out.length < reps * 0.9) throw new RangeError('too few valid bootstrap replicates: one side has trades on too few days');
  // Resampling D clusters gives a variance D/(D − 1) times too small, which makes intervals too narrow when there
  // are few days. Rescale each replicate around the point estimate by √(D/(D − 1)) (Davison & Hinkley, Bootstrap
  // Methods and their Application, CUP 1997, §3.8). Monotone, so the order is kept.
  const k = Math.sqrt(days.length / (days.length - 1));
  return out.map((v) => estimate + k * (v - estimate)).sort((x, y) => x - y);
};

export interface MeanInterval {
  readonly mean: number;
  readonly n: number;
  readonly days: number;
  /** Lower bound, or −∞ for a one-sided upper interval. */
  readonly lower: number;
  /** Upper bound, or +∞ for a one-sided lower interval. */
  readonly upper: number;
  /**
   * Two-sided percentile bootstrap p-value for "the mean is 0": 2·min(share of replicates ≤ 0, share ≥ 0), capped at 1.
   * A two-sided (1 − α) interval excludes 0 exactly when this is below α (up to replicate granularity).
   */
  readonly pTwoSided: number;
}

const pTwoSided = (sorted: readonly number[]): number => {
  let le = 0;
  let ge = 0;
  for (const v of sorted) {
    if (v <= 0) le++;
    if (v >= 0) ge++;
  }
  return Math.min(1, (2 * Math.min(le, ge)) / sorted.length);
};

export type Sides = 'two' | 'lower' | 'upper';

const interval = (sorted: readonly number[], level: number, sides: Sides): { lower: number; upper: number } => {
  if (!(level > 0 && level < 1)) throw new RangeError(`level must be in (0, 1), got ${level}`);
  const alpha = 1 - level;
  if (sides === 'two') return { lower: quantileSorted(sorted, alpha / 2), upper: quantileSorted(sorted, 1 - alpha / 2) };
  if (sides === 'lower') return { lower: quantileSorted(sorted, alpha), upper: Infinity };
  return { lower: -Infinity, upper: quantileSorted(sorted, 1 - alpha) };
};

/** Percentile day-block bootstrap interval for the mean net return per trade. */
export const dayBlockMeanInterval = (
  trades: readonly DayReturn[],
  level: number,
  sides: Sides,
  opts: BootstrapOptions,
): MeanInterval => {
  if (trades.length === 0) throw new RangeError('no trades');
  const days = blocks(trades);
  let s = 0;
  for (const t of trades) s += t.rNet;
  const est = s / trades.length;
  const stats = replicateStats(days, est, opts, (sum, c) => (c > 0 ? sum / c : Number.NaN));
  return { mean: est, n: trades.length, days: days.length, ...interval(stats, level, sides), pTwoSided: pTwoSided(stats) };
};

/**
 * Paired day-block bootstrap interval for mean(a) − mean(b), resampling the same days for both sides
 * (used for "beats the random control S0": both strategies saw the same market days).
 */
export const dayBlockMeanDiffInterval = (
  a: readonly DayReturn[],
  b: readonly DayReturn[],
  level: number,
  sides: Sides,
  opts: BootstrapOptions,
): MeanInterval => {
  if (a.length === 0 || b.length === 0) throw new RangeError('both samples need at least one trade');
  const days = blocks(a, b);
  let sA = 0;
  for (const t of a) sA += t.rNet;
  let sB = 0;
  for (const t of b) sB += t.rNet;
  const est = sA / a.length - sB / b.length;
  const stats = replicateStats(days, est, opts, (xA, cA, xB, cB) => (cA > 0 && cB > 0 ? xA / cA - xB / cB : Number.NaN));
  return { mean: est, n: a.length, days: days.length, ...interval(stats, level, sides), pTwoSided: pTwoSided(stats) };
};
