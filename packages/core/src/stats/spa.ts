// Joint day-block bootstrap maximum-statistic test over the whole frozen registry: Hansen's test for superior predictive
// ability, studentised, with consistent recentring (SPA_c). Hansen, "A Test for Superior Predictive Ability", Journal
// of Business & Economic Statistics 23(4):365–380, 2005; White, "A Reality Check for Data Snooping", Econometrica
// 68(5):1097–1126, 2000. Supervisor ruling STATS-1c (c), DECISIONS "Follow-up rulings".
//
// H0: no variant has a positive mean daily net return (the benchmark is zero mean net; S0 is compared elsewhere).
// - Every variant's daily net P&L is on one calendar; idle days are 0 with their costs (onCalendar).
// - Each replicate draws ONE circular-block index sequence (Politis & Romano, "A circular block-resampling procedure
//   for stationary data", 1992) and applies it to every variant, so the dependence between variants (duplicates,
//   shared days, common shocks) is kept.
// - Block length is fixed in advance by spaBlockLength: ⌈D^(1/3)⌉ days for D days, at least 1 (the n^(1/3) rate for
//   block bootstraps of a mean, Hall, Horowitz & Jing, Biometrika 82(3), 1995). Blocks fill positions 0..L−1, L..2L−1,
//   …, the same blocks the batch-means estimator below uses.
// - ω̂ₖ² is the batch-means long-run variance over consecutive blocks of the same length (unbiased for independent
//   days). T = max(0, maxₖ √D·d̄ₖ/ω̂ₖ). Recentring g_c(x) = x·1{x ≥ −Aₖ}, Aₖ = ω̂ₖ·√(2·ln ln D / D) (Hansen 2005,
//   §2.4): variants far below zero do not inflate the null distribution.
// - Bootstrap-t: every replicate is studentised by the same estimator on the resampled series,
//   T*_b = max(0, maxₖ √D·(d̄*ₖ,b − g_c(d̄ₖ))/ω*ₖ,b); p = (1 + #{T*_b ≥ T}) / (1 + B). Studentising with one fixed
//   ω̂ (Hansen's form) ran at 7% for one variant and 13% for five at D = 40 in simulation, because ω̂ is noisy and
//   biased low with few days; re-studentising each replicate carries that noise into the null distribution (Hall,
//   The Bootstrap and Edgeworth Expansion, 1992, §3.5).
// A variant whose series never moves (ω̂ₖ = 0) has no studentised statistic and is left out, and reported.

import { DEFAULT_REPLICATES } from './bootstrap.ts';
import { nextInt, type Rng } from './rng.ts';

/** Fewest days the test accepts (ln ln D must be positive and the block bootstrap needs room). */
export const SPA_MIN_DAYS = 10;

/** The block-length rule, fixed before any data is seen: mean block length ⌈D^(1/3)⌉ days. */
export const spaBlockLength = (days: number): number => Math.max(1, Math.ceil(days ** (1 / 3) - 1e-9));

export interface SpaOptions {
  readonly rng: Rng;
  /** Bootstrap replicates (default DEFAULT_REPLICATES, 2,000). */
  readonly replicates?: number;
}

export interface SpaResult {
  readonly statistic: number;
  readonly pValue: number;
  /** Variant with the largest studentised mean, or null when none has a positive mean. */
  readonly best: string | null;
  readonly days: number;
  readonly blockLength: number;
  readonly variants: number;
  /** Variants left out because their series never moves. */
  readonly excluded: readonly string[];
}

/**
 * Put each variant's dated daily P&L on one calendar: days without an entry are idle days, 0 (their costs, if any,
 * must already be in the dated entries). Throws on a day outside the calendar.
 */
export const onCalendar = (
  calendar: readonly string[],
  variants: Readonly<Record<string, readonly { readonly day: string; readonly pnl: number }[]>>,
): Record<string, number[]> => {
  const index = new Map(calendar.map((d, i) => [d, i]));
  if (index.size !== calendar.length) throw new RangeError('calendar days must be distinct');
  const out: Record<string, number[]> = {};
  for (const [id, rows] of Object.entries(variants)) {
    const s = new Array<number>(calendar.length).fill(0);
    for (const r of rows) {
      const i = index.get(r.day);
      if (i === undefined) throw new RangeError(`variant ${id} has a day outside the calendar: ${r.day}`);
      if (!Number.isFinite(r.pnl)) throw new RangeError(`variant ${id} has a non-finite P&L on ${r.day}`);
      s[i] = s[i]! + r.pnl;
    }
    out[id] = s;
  }
  return out;
};

/** Hansen's SPA_c test over every variant at once. `series`: variant id → daily net P&L, one calendar for all. */
export const spaTest = (series: Readonly<Record<string, readonly number[]>>, opts: SpaOptions): SpaResult => {
  const ids = Object.keys(series).sort();
  if (ids.length === 0) throw new RangeError('no variants');
  const D = series[ids[0]!]!.length;
  for (const id of ids) {
    const s = series[id]!;
    if (s.length !== D) throw new RangeError(`variant ${id} has ${s.length} days, expected ${D}: put every variant on one calendar`);
    for (const x of s) if (!Number.isFinite(x)) throw new RangeError(`variant ${id} has a non-finite daily P&L`);
  }
  if (D < SPA_MIN_DAYS) throw new RangeError(`the SPA test needs at least ${SPA_MIN_DAYS} days, got ${D}`);
  const B = opts.replicates ?? DEFAULT_REPLICATES;
  if (!Number.isInteger(B) || B < 100) throw new RangeError(`replicates must be an integer >= 100, got ${B}`);
  const L = spaBlockLength(D);
  const K = ids.length;
  const X = ids.map((id) => series[id]!);
  const means = X.map((s) => s.reduce((a, b) => a + b, 0) / D);
  // Batch means: blocks of L consecutive positions; Σⱼ (Sⱼ − nⱼ·mean)² · m/(m − 1) / D.
  const m = Math.ceil(D / L);
  const longRunSd = (get: (i: number) => number, mean: number): number => {
    let ss = 0;
    for (let j = 0; j < m; j++) {
      let sum = 0;
      let n = 0;
      for (let i = j * L; i < Math.min(D, (j + 1) * L); i++) {
        sum += get(i);
        n++;
      }
      ss += (sum - n * mean) ** 2;
    }
    return Math.sqrt((ss * m) / (m - 1) / D);
  };
  const omega = X.map((s, k) => longRunSd((i) => s[i]!, means[k]!));

  const live: number[] = [];
  const excluded: string[] = [];
  ids.forEach((id, k) => {
    // Spread below rounding noise counts as none.
    if (omega[k]! > 1e-12 * Math.max(1, Math.abs(means[k]!))) live.push(k);
    else excluded.push(id);
  });
  const rootD = Math.sqrt(D);
  let statistic = 0;
  let best: string | null = null;
  for (const k of live) {
    const t = (rootD * means[k]!) / omega[k]!;
    if (t > statistic) {
      statistic = t;
      best = ids[k]!;
    }
  }
  const lil = Math.sqrt((2 * Math.log(Math.log(D))) / D);
  const centre = live.map((k) => (means[k]! >= -omega[k]! * lil ? means[k]! : 0));
  // Every replicate draws one index sequence and applies it to every variant.
  const idx = new Array<number>(D);
  let exceed = 0;
  for (let b = 0; b < B; b++) {
    for (let j = 0; j < m; j++) {
      const start = nextInt(opts.rng, D);
      for (let i = j * L; i < Math.min(D, (j + 1) * L); i++) idx[i] = (start + i - j * L) % D;
    }
    let tb = 0;
    live.forEach((k, j) => {
      const s = X[k]!;
      let sum = 0;
      for (let i = 0; i < D; i++) sum += s[idx[i]!]!;
      const mb = sum / D;
      const w = longRunSd((i) => s[idx[i]!]!, mb);
      if (!(w > 0)) return;
      const z = (rootD * (mb - centre[j]!)) / w;
      if (z > tb) tb = z;
    });
    if (tb >= statistic) exceed++;
  }
  return { statistic, pValue: (1 + exceed) / (1 + B), best, days: D, blockLength: L, variants: live.length, excluded };
};
