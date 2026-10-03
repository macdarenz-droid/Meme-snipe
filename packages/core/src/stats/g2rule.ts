// The G2 decision rule for one universe, and n_power found by simulating that exact rule (ARCHITECTURE.md §14).
// Rule: at the universe's level a, the day-block bootstrap two-sided (1 − a) CI of the mean net return is above zero
// AND the CI of the paired difference against the random control S0 (same candidates and days) is above zero.
// Both must hold (intersection–union test), so the universe's p-value is the larger of the two; Holm then compares it
// with the universe's adjusted level.

import { dayBlockMeanDiffInterval, dayBlockMeanInterval, type DayReturn, type MeanInterval } from './bootstrap.ts';
import { mean, sd } from './descriptive.ts';
import { nPower } from './power.ts';
import { createRng, nextInt, type Rng } from './rng.ts';

export interface G2RuleResult {
  readonly mean: MeanInterval;
  readonly vsControl: MeanInterval;
  /** max of the two two-sided p-values, or 1 when either estimate is not positive. */
  readonly p: number;
}

/** Apply the G2 rule's statistics; intervals are reported at level 1 − `level`. */
export const g2Rule = (
  trades: readonly DayReturn[],
  control: readonly DayReturn[],
  level: number,
  opts: { readonly rng: Rng; readonly replicates?: number },
): G2RuleResult => {
  const m = dayBlockMeanInterval(trades, 1 - level, 'two', opts);
  const d = dayBlockMeanDiffInterval(trades, control, 1 - level, 'two', opts);
  const p = m.mean > 0 && d.mean > 0 ? Math.max(m.pTwoSided, d.pTwoSided) : 1;
  return { mean: m, vsControl: d, p };
};

/** A holdout trade with the clusters it belongs to, as known at decision time (quant.md §2: creator and funder groups). */
export interface ClusteredReturn extends DayReturn {
  readonly creatorCluster: string;
  readonly funderCluster: string;
}

/** Resampling units G2 must pass under (review STATS-1b): 1-, 2- and 3-day blocks, creator and funder clusters. */
export const G2_SENSITIVITY_VARIANTS = ['days-1', 'days-2', 'days-3', 'creator', 'funder'] as const;
export type G2SensitivityVariant = (typeof G2_SENSITIVITY_VARIANTS)[number];

export interface G2SensitivityResult {
  readonly variant: G2SensitivityVariant;
  readonly mean: MeanInterval | null;
  /** The paired difference against S0; null for creator and funder clusters (S0 trades carry no cluster). */
  readonly vsControl: MeanInterval | null;
  /** max of the two-sided p-values, or 1 when an estimate is not positive or the interval cannot be formed. */
  readonly p: number;
  /** Error message when the interval cannot be formed (e.g. fewer than two blocks). */
  readonly error: string | null;
}

/** Days relabelled into consecutive blocks of `len` observed days (strategy and S0 days together, in day order). */
const relabelDays = <T extends DayReturn>(a: readonly T[], b: readonly DayReturn[], len: number): { a: DayReturn[]; b: DayReturn[] } => {
  const days = [...new Set([...a.map((t) => t.day), ...b.map((t) => t.day)])].sort();
  const block = new Map(days.map((d, i) => [d, `b${Math.floor(i / len)}`]));
  const map = (t: DayReturn): DayReturn => ({ day: block.get(t.day)!, rNet: t.rNet });
  return { a: a.map(map), b: b.map(map) };
};

/**
 * The G2 statistics under every resampling unit of G2_SENSITIVITY_VARIANTS. Trades on nearby days, from one creator
 * cluster or from one funder cluster are not independent (quant.md §2: the top 1% of creator clusters make 58.57% of
 * coins), so 300 trades are fewer than 300 observations. Blocks of 2 and 3 days are non-overlapping runs of consecutive
 * observed days; creator and funder clusters resample the mean only. G2 passes a universe only when the largest p of
 * all variants is below its level, so every CI must exclude zero.
 */
export const g2Sensitivity = (
  trades: readonly ClusteredReturn[],
  control: readonly DayReturn[],
  level: number,
  opts: { readonly rng: Rng; readonly replicates?: number },
  variants: readonly G2SensitivityVariant[] = G2_SENSITIVITY_VARIANTS,
): G2SensitivityResult[] =>
  variants.map((variant): G2SensitivityResult => {
    try {
      if (variant === 'creator' || variant === 'funder') {
        const key = variant === 'creator' ? 'creatorCluster' : 'funderCluster';
        const m = dayBlockMeanInterval(trades.map((t) => ({ day: t[key], rNet: t.rNet })), 1 - level, 'two', opts);
        return { variant, mean: m, vsControl: null, p: m.mean > 0 ? m.pTwoSided : 1, error: null };
      }
      const r = relabelDays(trades, control, Number(variant.slice(5)));
      const g = g2Rule(r.a, r.b, level, opts);
      return { variant, mean: g.mean, vsControl: g.vsControl, p: g.p, error: null };
    } catch (e) {
      return { variant, mean: null, vsControl: null, p: 1, error: (e as Error).message };
    }
  });

/** The gate's pass condition for one universe tested at `level` (the same comparison gateG2 makes after Holm). */
export const g2RulePasses = (r: G2RuleResult, level: number): boolean => r.p < level;

/**
 * Fewest days for a day-block interval in G1 and G2 (below it: "not proven"). Chosen per the review ruling: of the
 * candidates D = 10, 15, 20, 30, the smallest whose per-tail false-positive rate at zero edge (20 trades a day,
 * ρ = 0.05 and 0.1, 8,000 runs) was at or below nominal within Monte Carlo error. With the interval of bootstrap.ts all
 * of them were (largest: 0.0503 one-sided, 0.0238 per tail); the table is in the PR.
 */
export const MIN_DAYS = 10;

/** Largest n the power search tries before giving up. */
const DEFAULT_MAX_TRADES = 50_000;
/** Prime stride that gives each candidate n its own random stream from one seed. */
const SEED_STRIDE = 1_000_003;

export interface G2PowerOptions {
  /**
   * Walk-forward trades of the pre-registered configuration with their creator and funder clusters: σ̂, the day
   * structure and the cluster structure come from here.
   */
  readonly walkForward: readonly ClusteredReturn[];
  /** S0 on the same walk-forward days, pooled over its seeds. */
  readonly control: readonly DayReturn[];
  /** Seed for every random draw of the simulation. */
  readonly seed: number;
  /** True mean the strategy is shifted to (default +0.05, the smallest edge worth trading). */
  readonly targetMean?: number;
  /** The Holm family size fixed in the holdout registry; power is computed at the strictest Holm level α/m. */
  readonly familySize: number;
  readonly alpha?: number;
  readonly power?: number;
  /** Simulated holdouts per candidate n (default 400). */
  readonly simulations?: number;
  /** Bootstrap replicates inside each simulated G2 (default 500). */
  readonly replicates?: number;
  /** Largest n searched before giving up (default 50,000). */
  readonly maxTrades?: number;
}

/** Fingerprint of the walk-forward data a simulation used, so G2 can check n_power belongs to its universe. */
export interface WalkForwardSummary {
  readonly n: number;
  readonly days: number;
  readonly mean: number;
  readonly sd: number;
}

export const summarizeWalkForward = (wf: readonly DayReturn[]): WalkForwardSummary => {
  const xs = wf.map((t) => t.rNet);
  return { n: xs.length, days: new Set(wf.map((t) => t.day)).size, mean: xs.length ? mean(xs) : Number.NaN, sd: xs.length > 1 ? sd(xs) : Number.NaN };
};

export const sameSummary = (a: WalkForwardSummary, b: WalkForwardSummary): boolean =>
  a.n === b.n && a.days === b.days && Object.is(a.mean, b.mean) && Object.is(a.sd, b.sd);

export const describeSummary = (s: WalkForwardSummary): string => `(${s.n} trades, ${s.days} days, mean ${s.mean}, sd ${s.sd})`;

export interface G2PowerResult {
  /** The walk-forward data the simulation ran on. */
  readonly walkForward: WalkForwardSummary;
  /** Smallest n found with simulated power ≥ the target. */
  readonly nPower: number;
  readonly powerAtN: number;
  readonly level: number;
  /** Every n evaluated with its simulated power, in evaluation order. */
  readonly evaluations: readonly { readonly n: number; readonly power: number }[];
}

interface Day {
  readonly a: readonly ClusteredReturn[];
  readonly b: readonly number[];
}

const byDay = (a: readonly ClusteredReturn[], b: readonly DayReturn[]): Day[] => {
  const map = new Map<string, { a: ClusteredReturn[]; b: number[] }>();
  const get = (d: string) => {
    let v = map.get(d);
    if (!v) map.set(d, (v = { a: [], b: [] }));
    return v;
  };
  for (const t of a) get(t.day).a.push(t);
  for (const t of b) get(t.day).b.push(t.rNet);
  return [...map.entries()].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)).map(([, v]) => v);
};

/**
 * Days a simulated holdout draws together: runs of 3 consecutive walk-forward days (circular), so dependence across
 * nearby days survives into the simulation that the 2- and 3-day block units of the rule then measure.
 */
const SIM_BLOCK_DAYS = 3;

/**
 * One simulated holdout of exactly n strategy trades, built from runs of SIM_BLOCK_DAYS consecutive walk-forward days
 * drawn with replacement. Trades keep their creator and funder clusters; simulated days keep their drawn order.
 */
const simulateHoldout = (days: readonly Day[], n: number, shift: number, rng: Rng): { a: ClusteredReturn[]; b: DayReturn[]; days: number } => {
  const a: ClusteredReturn[] = [];
  const b: DayReturn[] = [];
  let withEntries = 0;
  for (let k = 0; a.length < n; ) {
    const start = nextInt(rng, days.length);
    for (let j = 0; j < SIM_BLOCK_DAYS && a.length < n; j++, k++) {
      const d = days[(start + j) % days.length]!;
      // Zero-padded so the 2- and 3-day units, which sort day keys, see the drawn order.
      const key = `s${String(k).padStart(7, '0')}`;
      if (d.a.length > 0) withEntries++;
      for (const x of d.a) {
        if (a.length === n) break;
        a.push({ day: key, rNet: x.rNet + shift, creatorCluster: x.creatorCluster, funderCluster: x.funderCluster });
      }
      for (const x of d.b) b.push({ day: key, rNet: x });
    }
  }
  return { a, b, days: withEntries };
};

/** The full G2 rule at `level`: the 1-day rule and then every other resampling unit, all below the level. */
const fullRulePasses = (a: readonly ClusteredReturn[], b: readonly DayReturn[], level: number, opts: { readonly rng: Rng; readonly replicates?: number }): boolean => {
  if (!g2RulePasses(g2Rule(a, b, level, opts), level)) return false;
  return g2Sensitivity(a, b, level, opts, ['days-2', 'days-3', 'creator', 'funder']).every((x) => x.p < level);
};

/**
 * n_power by simulation of the exact G2 rule, cluster sensitivity included (review of STATS-1b: the largest p over
 * 1-, 2- and 3-day blocks and creator and funder clusters). The holdout must hold max(300, nPower) trades.
 */
export const simulateG2Power = (opts: G2PowerOptions): G2PowerResult => {
  const target = opts.targetMean ?? 0.05;
  const universes = opts.familySize;
  const alpha = opts.alpha ?? 0.05;
  const goal = opts.power ?? 0.8;
  const sims = opts.simulations ?? 400;
  const replicates = opts.replicates ?? 500;
  const maxTrades = opts.maxTrades ?? DEFAULT_MAX_TRADES;
  if (!Number.isInteger(universes) || universes < 1 || universes > 3) throw new RangeError('familySize must be 1, 2 or 3');
  if (!Number.isInteger(sims) || sims < 100) throw new RangeError('simulations must be an integer >= 100');
  if (opts.walkForward.length < 2 || opts.control.length === 0) throw new RangeError('need walk-forward trades and S0 control trades');
  const days = byDay(opts.walkForward, opts.control);
  if (days.filter((d) => d.a.length > 0).length < 2) throw new RangeError('walk-forward trades must cover at least two days');
  const wf = opts.walkForward.map((t) => t.rNet);
  const shift = target - mean(wf);
  const level = alpha / universes;
  const evaluations: { n: number; power: number }[] = [];
  const cache = new Map<number, number>();

  const powerAt = (n: number): number => {
    const hit = cache.get(n);
    if (hit !== undefined) return hit;
    // Each n gets its own stream derived from the seed, so the result does not depend on search order.
    const rng = createRng(opts.seed * SEED_STRIDE + n);
    let pass = 0;
    for (let s = 0; s < sims; s++) {
      const h = simulateHoldout(days, n, shift, rng);
      // The gate needs MIN_DAYS days; a holdout on fewer days is "not proven", which counts as not passing.
      if (h.days >= MIN_DAYS && fullRulePasses(h.a, h.b, level, { rng, replicates })) pass++;
    }
    const pw = pass / sims;
    cache.set(n, pw);
    evaluations.push({ n, power: pw });
    return pw;
  };

  // Bracket from the textbook z-test n (independent trades), then bisect on integers.
  const sigma = sd(wf);
  let hi = Math.max(20, sigma > 0 ? nPower(sigma, target, { alpha: level }) : 20);
  let lo = 0;
  if (powerAt(hi) >= goal) {
    for (;;) {
      const next = Math.floor(hi / 1.5);
      if (next < 20) {
        lo = 0;
        break;
      }
      if (powerAt(next) >= goal) hi = next;
      else {
        lo = next;
        break;
      }
    }
  } else {
    for (;;) {
      lo = hi;
      hi = Math.ceil(hi * 1.5);
      if (hi > maxTrades) throw new RangeError(`power ${goal} not reached by ${maxTrades} trades`);
      if (powerAt(hi) >= goal) break;
    }
  }
  while (hi - lo > Math.max(5, Math.ceil(hi * 0.02))) {
    const mid = Math.floor((lo + hi) / 2);
    if (powerAt(mid) >= goal) hi = mid;
    else lo = mid;
  }
  return { nPower: hi, powerAtN: powerAt(hi), level, evaluations, walkForward: summarizeWalkForward(opts.walkForward) };
};
