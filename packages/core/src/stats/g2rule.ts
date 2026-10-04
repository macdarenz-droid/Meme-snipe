// The G2 decision rule for one universe, and n_power found by simulating that exact rule (ARCHITECTURE.md §14).
// Rule: at the universe's level a, the day-block bootstrap two-sided (1 − a) CI of the mean net return is above zero
// AND the CI of the paired difference against the random control S0 (same candidates and days) is above zero.
// Both must hold (intersection–union test), so the universe's p-value is the larger of the two; Holm then compares it
// with the universe's adjusted level.

import { dayBlockMeanDiffInterval, dayBlockMeanInterval, DEFAULT_REPLICATES, type DayReturn, type MeanInterval } from './bootstrap.ts';
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
  /**
   * Resampling units of the rule simulated (default all of G2_SENSITIVITY_VARIANTS). gateG2 accepts only an n_power
   * simulated with every unit; a subset is for studying one property of the rule.
   */
  readonly units?: readonly G2SensitivityVariant[];
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

export const describeSummary = (s: WalkForwardSummary): string => `(${s.n} trades, ${s.days} days, mean ${s.mean}, sd ${s.sd})`;

/** Every setting that changes the n_power simulation's result. */
export interface G2PowerSettings {
  readonly targetMean: number;
  readonly familySize: number;
  readonly alpha: number;
  readonly power: number;
  readonly simulations: number;
  readonly replicates: number;
  readonly maxTrades: number;
  readonly units: readonly G2SensitivityVariant[];
  readonly seed: number;
}

/**
 * The exact fingerprint of an n_power simulation's inputs (external audit S3): the ordered, labelled walk-forward
 * trades (day, net return, creator and funder cluster), the ordered S0 control trades and every setting, in one
 * canonical string. A summary (n, days, mean, SD) cannot tell the same returns under independent creators from the same
 * returns under one creator; this can. It is the inputs themselves rather than a hash of them (the stats module imports
 * no crypto), so two fingerprints are equal exactly when the inputs are.
 */
export const g2PowerInputs = (walkForward: readonly ClusteredReturn[], control: readonly DayReturn[], settings: G2PowerSettings): string =>
  JSON.stringify({
    walkForward: walkForward.map((t) => [t.day, t.rNet, t.creatorCluster ?? null, t.funderCluster ?? null]),
    control: control.map((t) => [t.day, t.rNet]),
    settings: { ...settings, units: [...settings.units] },
  });

export interface G2PowerResult {
  /** The walk-forward data the simulation ran on (for messages; G2 checks `inputs`). */
  readonly walkForward: WalkForwardSummary;
  /** Exact fingerprint of the simulation's inputs (`g2PowerInputs`). */
  readonly inputs: string;
  readonly settings: G2PowerSettings;
  /** Monte Carlo standard error of powerAtN: √(p(1 − p)/simulations). */
  readonly standardError: number;
  /**
   * An independent check of the chosen n (external audit S3): the full rule simulated again at nPower on a seed stream
   * the search never used, with its Monte Carlo standard error.
   */
  readonly validation: { readonly n: number; readonly power: number; readonly standardError: number };
  /** Smallest n found with simulated power ≥ the target. */
  readonly nPower: number;
  readonly powerAtN: number;
  readonly level: number;
  /** Every n evaluated with its simulated power, in evaluation order. */
  readonly evaluations: readonly { readonly n: number; readonly power: number }[];
  /** The resampling units simulated. */
  readonly units: readonly G2SensitivityVariant[];
  /** The seed every draw came from (frozen in the holdout registry before the first count). */
  readonly seed: number;
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
 * Clusters seen on more than one walk-forward day: a prolific creator or funder keeps its id across repeat draws (its
 * trades are not independent new launches), so n_power is not understated. Built once from the walk-forward.
 */
const multiDay = (a: readonly ClusteredReturn[], key: 'creatorCluster' | 'funderCluster'): ReadonlySet<string> => {
  const seen = new Map<string, string>();
  const multi = new Set<string>();
  for (const t of a) {
    const prev = seen.get(t[key]);
    if (prev === undefined) seen.set(t[key], t.day);
    else if (prev !== t.day) multi.add(t[key]);
  }
  return multi;
};

/**
 * One simulated holdout of exactly n strategy trades, built from runs of SIM_BLOCK_DAYS consecutive walk-forward days
 * drawn with replacement. A day drawn again stands for new launches, so a single-day creator's (or funder's) repeat
 * copies get a fresh id; a creator seen on several walk-forward days keeps its id, because a prolific deployer makes
 * most coins and its trades are still its own. Simulated days keep their drawn order.
 */
const simulateHoldout = (
  days: readonly Day[],
  n: number,
  shift: number,
  rng: Rng,
  multiCreator: ReadonlySet<string>,
  multiFunder: ReadonlySet<string>,
): { a: ClusteredReturn[]; b: DayReturn[]; days: number } => {
  const a: ClusteredReturn[] = [];
  const b: DayReturn[] = [];
  let withEntries = 0;
  const drawn = new Array<number>(days.length).fill(0);
  for (let k = 0; a.length < n; ) {
    const start = nextInt(rng, days.length);
    for (let j = 0; j < SIM_BLOCK_DAYS && a.length < n; j++, k++) {
      const di = (start + j) % days.length;
      const d = days[di]!;
      const copy = drawn[di]!++;
      const tag = copy === 0 ? '' : `~${copy}`;
      // Zero-padded so the 2- and 3-day units, which sort day keys, see the drawn order.
      const key = `s${String(k).padStart(7, '0')}`;
      if (d.a.length > 0) withEntries++;
      for (const x of d.a) {
        if (a.length === n) break;
        a.push({
          day: key, rNet: x.rNet + shift,
          creatorCluster: multiCreator.has(x.creatorCluster) ? x.creatorCluster : x.creatorCluster + tag,
          funderCluster: multiFunder.has(x.funderCluster) ? x.funderCluster : x.funderCluster + tag,
        });
      }
      for (const x of d.b) b.push({ day: key, rNet: x });
    }
  }
  return { a, b, days: withEntries };
};

/** The full G2 rule at `level`: the 1-day rule and then every other resampling unit, all below the level. */
const fullRulePasses = (
  a: readonly ClusteredReturn[],
  b: readonly DayReturn[],
  level: number,
  opts: { readonly rng: Rng; readonly replicates?: number },
  units: readonly G2SensitivityVariant[],
): boolean => {
  if (!g2RulePasses(g2Rule(a, b, level, opts), level)) return false;
  // One unit at a time, stopping at the first that fails (same answer, less work).
  for (const v of (['days-3', 'days-2', 'creator', 'funder'] as const).filter((x) => units.includes(x))) {
    if (!(g2Sensitivity(a, b, level, opts, [v])[0]!.p < level)) return false;
  }
  return true;
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
  const units = [...new Set(['days-1' as const, ...(opts.units ?? G2_SENSITIVITY_VARIANTS)])];
  if (!Number.isInteger(universes) || universes < 1 || universes > 3) throw new RangeError('familySize must be 1, 2 or 3');
  if (!Number.isInteger(sims) || sims < 100) throw new RangeError('simulations must be an integer >= 100');
  // Search streams use seed·STRIDE + n and the validation stream seed·STRIDE + STRIDE − 1 − n: disjoint while n < STRIDE / 2.
  if (!Number.isInteger(maxTrades) || maxTrades < 1 || maxTrades >= SEED_STRIDE / 2) throw new RangeError(`maxTrades must be an integer in 1..${Math.floor(SEED_STRIDE / 2) - 1}`);
  if (opts.walkForward.length < 2 || opts.control.length === 0) throw new RangeError('need walk-forward trades and S0 control trades');
  const days = byDay(opts.walkForward, opts.control);
  const multiCreator = multiDay(opts.walkForward, 'creatorCluster');
  const multiFunder = multiDay(opts.walkForward, 'funderCluster');
  if (days.filter((d) => d.a.length > 0).length < 2) throw new RangeError('walk-forward trades must cover at least two days');
  const wf = opts.walkForward.map((t) => t.rNet);
  const shift = target - mean(wf);
  const level = alpha / universes;
  const evaluations: { n: number; power: number }[] = [];
  const cache = new Map<number, number>();

  const simulatePower = (n: number, rng: ReturnType<typeof createRng>): number => {
    let pass = 0;
    for (let s = 0; s < sims; s++) {
      const h = simulateHoldout(days, n, shift, rng, multiCreator, multiFunder);
      // The gate needs MIN_DAYS days; a holdout on fewer days is "not proven", which counts as not passing.
      if (h.days >= MIN_DAYS && fullRulePasses(h.a, h.b, level, { rng, replicates }, units)) pass++;
    }
    return pass / sims;
  };
  const powerAt = (n: number): number => {
    const hit = cache.get(n);
    if (hit !== undefined) return hit;
    // Each n gets its own stream derived from the seed, so the result does not depend on search order.
    const pw = simulatePower(n, createRng(opts.seed * SEED_STRIDE + n));
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
  const se = (p: number) => Math.sqrt((p * (1 - p)) / sims);
  // The independent check: a stream no search step used (search streams are seed·STRIDE + n with n ≤ maxTrades).
  const validationPower = simulatePower(hi, createRng(opts.seed * SEED_STRIDE + (SEED_STRIDE - 1 - hi)));
  const settings: G2PowerSettings = { targetMean: target, familySize: universes, alpha, power: goal, simulations: sims, replicates, maxTrades, units, seed: opts.seed };
  return {
    nPower: hi, powerAtN: powerAt(hi), level, evaluations, walkForward: summarizeWalkForward(opts.walkForward), units, seed: opts.seed,
    inputs: g2PowerInputs(opts.walkForward, opts.control, settings), settings, standardError: se(powerAt(hi)),
    validation: { n: hi, power: validationPower, standardError: se(validationPower) },
  };
};

export interface HoldoutPlan {
  /** Power of the full G2 rule once n trades are in (n_power's simulated power at n). */
  readonly powerGivenN: number;
  /** Probability the window reaches n entries on at least minDays trade days by its cutoff E. */
  readonly pReach: number;
  /** pReach × powerGivenN: the chance this attempt passes when the edge is the target. */
  readonly overall: number;
}

/**
 * What one holdout attempt can deliver, reported with n_power (supervisor ruling STATS-1c, item 5). The window's entry
 * counts are simulated from practice-day entry counts (post-B4, from the funnel, counts only) drawn in runs of
 * SIM_BLOCK_DAYS consecutive days, so busy and quiet stretches stay together.
 */
export const holdoutPlan = (opts: {
  readonly dailyEntries: readonly number[];
  readonly windowDays: number;
  readonly requiredTrades: number;
  readonly minDays: number;
  readonly powerGivenN: number;
  readonly rng: Rng;
  readonly simulations?: number;
}): HoldoutPlan => {
  const d = opts.dailyEntries;
  if (d.length < SIM_BLOCK_DAYS) throw new RangeError(`need at least ${SIM_BLOCK_DAYS} practice days of entry counts`);
  for (const x of d) if (!Number.isInteger(x) || x < 0) throw new RangeError('daily entry counts are integers >= 0');
  if (!(opts.powerGivenN >= 0 && opts.powerGivenN <= 1)) throw new RangeError('powerGivenN must be in [0, 1]');
  const sims = opts.simulations ?? 5 * DEFAULT_REPLICATES;
  let reached = 0;
  for (let s = 0; s < sims; s++) {
    let n = 0;
    let days = 0;
    for (let k = 0; k < opts.windowDays; ) {
      const start = nextInt(opts.rng, d.length);
      for (let j = 0; j < SIM_BLOCK_DAYS && k < opts.windowDays; j++, k++) {
        const x = d[(start + j) % d.length]!;
        n += x;
        if (x > 0) days++;
      }
    }
    if (n >= opts.requiredTrades && days >= opts.minDays) reached++;
  }
  const pReach = reached / sims;
  return { powerGivenN: opts.powerGivenN, pReach, overall: pReach * opts.powerGivenN };
};
