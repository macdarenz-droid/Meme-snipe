// Day-block bootstrap for the mean net return per trade. Trades on the same calendar day share SOL price,
// launchpad flow and the bot population, so their returns are correlated; resampling whole days keeps that
// correlation in every replicate (cluster bootstrap; quant.md §2.1, Kamat arXiv 2607.02823 v4).
// The statistic is the pooled mean: Σ returns over the resampled days / Σ trades over the resampled days.
//
// The interval is a studentized (bootstrap-t) interval: each replicate gives t* = (θ* − θ̂)/SE*, with SE the
// cluster-robust (CR1) standard error over days, SE² = D/(D − 1) · Σ_d u_d², u_d the day's influence on the estimate.
// The CI is [θ̂ − q*(1 − α/2)·SE, θ̂ − q*(α/2)·SE]. Percentile tails of a D-cluster bootstrap under-cover when D is small
// and returns are skewed (review of PR #8: a "95%" CI acted like ~91% at D = 10–15; a t_{D−1}-scaled SE interval still
// ran ~0.5 points over nominal in the lower tail at D = 30 because the bracket returns are left-skewed). Bootstrap-t
// corrects both to second order (Hall, The Bootstrap and Edgeworth Expansion, Springer 1992, §3.5; Cameron, Gelbach &
// Miller, REStat 90(3), 2008, on few-cluster inference). Each tail then takes the wider of the bootstrap-t quantile and
// the t_{D−1} quantile: in simulation either one alone ran 5–10% (relative) above the nominal tail rate in some cells,
// and the wider of the two keeps the rate at or below nominal. Gates also require a minimum number of days (MIN_DAYS in
// g2rule.ts), chosen from the simulation table in the PR.

import { quantileSorted } from './descriptive.ts';
import { nextInt, type Rng } from './rng.ts';
import { studentTCdf, studentTQuantile } from './special.ts';

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

/** Bootstrap replicates when the caller gives none. */
export const DEFAULT_REPLICATES = 2000;

export interface BootstrapOptions {
  readonly rng: Rng;
  /** Number of bootstrap replicates (default 2,000). */
  readonly replicates?: number;
}

/** Pooled-mean estimate and its CR1 standard error for one side over the given day indices (with repeats). */
const ratioWithSe = (days: readonly DayBlock[], idx: readonly number[], side: 'A' | 'B'): { est: number; n: number; u: number[] } => {
  let s = 0;
  let n = 0;
  for (const i of idx) {
    const d = days[i]!;
    s += side === 'A' ? d.sumA : d.sumB;
    n += side === 'A' ? d.countA : d.countB;
  }
  const est = n > 0 ? s / n : Number.NaN;
  // Influence of each drawn day on the pooled mean: (S_d − θ·n_d) / N.
  const u = idx.map((i) => {
    const d = days[i]!;
    return side === 'A' ? (d.sumA - est * d.countA) / n : (d.sumB - est * d.countB) / n;
  });
  return { est, n, u };
};

const cr1 = (u: readonly number[]): number => {
  const D = u.length;
  let ss = 0;
  for (const x of u) ss += x * x;
  return Math.sqrt((D / (D - 1)) * ss);
};

type Kind = 'mean' | 'diff';

/** θ and its SE over a set of drawn days. */
const statistic = (days: readonly DayBlock[], idx: readonly number[], kind: Kind): { theta: number; se: number } => {
  const a = ratioWithSe(days, idx, 'A');
  if (kind === 'mean') return { theta: a.est, se: cr1(a.u) };
  const b = ratioWithSe(days, idx, 'B');
  return { theta: a.est - b.est, se: cr1(a.u.map((x, i) => x - b.u[i]!)) };
};

/** Studentized replicates t* = (θ* − θ̂) / SE*, sorted. */
const studentizedReplicates = (days: readonly DayBlock[], kind: Kind, thetaHat: number, opts: BootstrapOptions): number[] => {
  const reps = opts.replicates ?? DEFAULT_REPLICATES;
  if (!Number.isInteger(reps) || reps < 100) throw new RangeError(`replicates must be an integer >= 100, got ${reps}`);
  const out: number[] = [];
  const idx: number[] = new Array<number>(days.length);
  for (let r = 0; r < reps; r++) {
    for (let i = 0; i < days.length; i++) idx[i] = nextInt(opts.rng, days.length);
    const { theta, se } = statistic(days, idx, kind);
    const t = (theta - thetaHat) / se;
    if (Number.isFinite(t)) out.push(t);
  }
  // A replicate is undefined when it drew no trades for one side or a single repeated day (SE* = 0).
  if (out.length < reps * 0.9) throw new RangeError('too few valid bootstrap replicates: trades on too few days');
  return out.sort((x, y) => x - y);
};

export interface MeanInterval {
  readonly mean: number;
  readonly n: number;
  readonly days: number;
  /** Cluster-robust (CR1, by day) standard error of the estimate. */
  readonly se: number;
  /** Lower bound, or −∞ for a one-sided upper interval. */
  readonly lower: number;
  /** Upper bound, or +∞ for a one-sided lower interval. */
  readonly upper: number;
  /**
   * Two-sided bootstrap-t p-value for "the value is 0": 2·min(share of t* ≥ t, share of t* ≤ t), t = estimate/SE,
   * capped at 1. The two-sided (1 − α) CI excludes 0 ⇔ p < α (up to replicate granularity).
   */
  readonly pTwoSided: number;
}

export type Sides = 'two' | 'lower' | 'upper';

const run = (days: readonly DayBlock[], kind: Kind, level: number, sides: Sides, opts: BootstrapOptions) => {
  if (!(level > 0 && level < 1)) throw new RangeError(`level must be in (0, 1), got ${level}`);
  if (days.length < 2) throw new RangeError('day-block bootstrap needs trades on at least two days');
  const all = days.map((_, i) => i);
  const stat = statistic(days, all, kind);
  const theta = stat.theta;
  // Spread below rounding noise counts as none.
  const se = stat.se <= 1e-12 * Math.max(1, Math.abs(theta)) ? 0 : stat.se;
  if (se === 0) {
    // Every day agrees exactly: no sampling spread to studentize.
    const bounds = sides === 'two' ? { lower: theta, upper: theta } : sides === 'lower' ? { lower: theta, upper: Infinity } : { lower: -Infinity, upper: theta };
    return { mean: theta, days: days.length, se, ...bounds, pTwoSided: theta === 0 ? 1 : 0 };
  }
  const tStar = studentizedReplicates(days, kind, theta, opts);
  const alpha = 1 - level;
  const df = days.length - 1;
  // Each tail uses the wider of the bootstrap-t and the t_{D−1} critical value (see the header).
  const q = (p: number) => (p > 0.5 ? Math.max(quantileSorted(tStar, p), studentTQuantile(p, df)) : Math.min(quantileSorted(tStar, p), studentTQuantile(p, df)));
  const bounds =
    sides === 'two' ? { lower: theta - q(1 - alpha / 2) * se, upper: theta - q(alpha / 2) * se }
      : sides === 'lower' ? { lower: theta - q(1 - alpha) * se, upper: Infinity }
        : { lower: -Infinity, upper: theta - q(alpha) * se };
  const t = theta / se;
  let ge = 0;
  let le = 0;
  for (const x of tStar) {
    if (x >= t) ge++;
    if (x <= t) le++;
  }
  const pBoot = Math.min(1, (2 * Math.min(ge, le)) / tStar.length);
  const pT = Math.min(1, 2 * (1 - studentTCdf(Math.abs(t), df)));
  const pTwoSided = Math.max(pBoot, pT);
  return { mean: theta, days: days.length, se, ...bounds, pTwoSided };
};

/** Studentized day-block bootstrap interval for the mean net return per trade. */
export const dayBlockMeanInterval = (
  trades: readonly DayReturn[],
  level: number,
  sides: Sides,
  opts: BootstrapOptions,
): MeanInterval => {
  if (trades.length === 0) throw new RangeError('no trades');
  return { n: trades.length, ...run(blocks(trades), 'mean', level, sides, opts) };
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
  return { n: a.length, ...run(blocks(a, b), 'diff', level, sides, opts) };
};
