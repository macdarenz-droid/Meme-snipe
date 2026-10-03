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

/** The gate's pass condition for one universe tested at `level` (the same comparison gateG2 makes after Holm). */
export const g2RulePasses = (r: G2RuleResult, level: number): boolean => r.p < level;

export interface G2PowerOptions {
  /** Walk-forward trades of the pre-registered configuration (σ̂ and the day structure come from here). */
  readonly walkForward: readonly DayReturn[];
  /** S0 on the same walk-forward days, pooled over its seeds. */
  readonly control: readonly DayReturn[];
  /** Seed for every random draw of the simulation. */
  readonly seed: number;
  /** True mean the strategy is shifted to (default +0.05, the smallest edge worth trading). */
  readonly targetMean?: number;
  /** Universes entering the holdout; power is computed at the strictest Holm level α/m (default 1). */
  readonly universes?: number;
  readonly alpha?: number;
  readonly power?: number;
  /** Simulated holdouts per candidate n (default 400). */
  readonly simulations?: number;
  /** Bootstrap replicates inside each simulated G2 (default 500). */
  readonly replicates?: number;
  /** Largest n searched before giving up (default 50,000). */
  readonly maxTrades?: number;
}

export interface G2PowerResult {
  /** Smallest n found with simulated power ≥ the target. */
  readonly nPower: number;
  readonly powerAtN: number;
  readonly level: number;
  /** Every n evaluated with its simulated power, in evaluation order. */
  readonly evaluations: readonly { readonly n: number; readonly power: number }[];
}

interface Day {
  readonly a: readonly number[];
  readonly b: readonly number[];
}

const byDay = (a: readonly DayReturn[], b: readonly DayReturn[]): Day[] => {
  const map = new Map<string, { a: number[]; b: number[] }>();
  const get = (d: string) => {
    let v = map.get(d);
    if (!v) map.set(d, (v = { a: [], b: [] }));
    return v;
  };
  for (const t of a) get(t.day).a.push(t.rNet);
  for (const t of b) get(t.day).b.push(t.rNet);
  return [...map.entries()].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)).map(([, v]) => v);
};

/** One simulated holdout of exactly n strategy trades, built from whole walk-forward days drawn with replacement. */
const simulateHoldout = (days: readonly Day[], n: number, shift: number, rng: Rng): { a: DayReturn[]; b: DayReturn[] } => {
  const a: DayReturn[] = [];
  const b: DayReturn[] = [];
  for (let k = 0; a.length < n; k++) {
    const d = days[nextInt(rng, days.length)]!;
    const key = `s${k}`;
    for (const x of d.a) {
      if (a.length === n) break;
      a.push({ day: key, rNet: x + shift });
    }
    for (const x of d.b) b.push({ day: key, rNet: x });
  }
  return { a, b };
};

/** n_power by simulation of the exact G2 rule; the holdout must hold max(300, nPower) trades. */
export const simulateG2Power = (opts: G2PowerOptions): G2PowerResult => {
  const target = opts.targetMean ?? 0.05;
  const universes = opts.universes ?? 1;
  const alpha = opts.alpha ?? 0.05;
  const goal = opts.power ?? 0.8;
  const sims = opts.simulations ?? 400;
  const replicates = opts.replicates ?? 500;
  const maxTrades = opts.maxTrades ?? 50_000;
  if (!Number.isInteger(universes) || universes < 1) throw new RangeError('universes must be an integer >= 1');
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
    const rng = createRng(opts.seed * 1_000_003 + n);
    let pass = 0;
    for (let s = 0; s < sims; s++) {
      const h = simulateHoldout(days, n, shift, rng);
      if (g2RulePasses(g2Rule(h.a, h.b, level, { rng, replicates }), level)) pass++;
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
  return { nPower: hi, powerAtN: powerAt(hi), level, evaluations };
};
