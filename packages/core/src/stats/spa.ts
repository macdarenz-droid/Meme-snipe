// Joint day-block bootstrap maximum-statistic test over the whole frozen registry: Hansen's test for superior predictive
// ability, studentised, with consistent recentring (SPA_c), against two benchmarks at once, with a step-down for the
// selected configuration. Hansen, "A Test for Superior Predictive Ability", JBES 23(4):365–380, 2005; White, "A Reality
// Check for Data Snooping", Econometrica 68(5), 2000; Romano & Wolf, "Stepwise multiple testing as formalized data
// snooping", Econometrica 73(4), 2005; Hsu, Hsu & Kuan, "Testing the predictive ability of technical analysis using a
// new stepwise test without data snooping bias", J. Empirical Finance 17(3), 2010. Supervisor rulings STATS-1c.
//
// Inputs and units:
// - Every variant's daily net P&L over a fixed capital base from the capacity-constrained deployment replay, summed
//   per day (never per-trade fractions summed or averaged), on ONE calendar of T days for every variant and S0.
// - Idle days are 0 before costs. The only costs that fall on an idle day are fees of entry attempts that never filled
//   and rent locked in an account that was not recovered; both are negative entries. Fixed operating costs are not
//   charged per variant.
//
// Statistics: for each variant j and benchmark b ∈ {zero, S0}, d_jb[t] = x_j[t] − b[t]; 2K statistics
// z_jb = √T·mean(d_jb)/ω_jb. One critical value comes from the bootstrap maximum over all 2K statistics, and a variant
// passes only when BOTH of its statistics exceed it. Recentring (Hansen 2005): μc_jb = mean(d_jb) when
// z_jb < −√(2·ln ln T), else 0; T_boot = max(0, max √T·(mean(d*) − mean(d) + μc)/ω).
// Bootstrap: one stationary-bootstrap index sequence per replicate (Politis & Romano, JASA 89(428), 1994) applied to
// every variant and S0 alike, drawn within each registered regime (a block never crosses a regime boundary; each regime
// keeps its registered number of days, so its weight); a regime shorter than the longest block is first merged into a
// neighbour (mergeShortRegimes). Expected block lengths 3, 5 and 7 days; promotion uses the
// largest p of the three, and a variant passes only if it passes at all three.
// Support: variants active on fewer than SPA_MIN_ACTIVE_DAYS days (from activity counts, decided before outcomes) are
// left out of selection; an all-zero series is never active. Every ω is floored at the registered SE floor, applied
// identically to observed and bootstrap statistics. p-values are (1 + k)/(1 + B), never 0.

import { nextInt, type Rng } from './rng.ts';

/** Expected block lengths in days; promotion takes the largest p across them. */
export const SPA_BLOCK_LENGTHS = [3, 5, 7] as const;
/**
 * Registered before any data (STATS-1e ruling): a regime shorter than the longest expected block is merged, for
 * resampling only, into its preceding neighbour, or into the following one when it is first; repeated until every
 * regime is at least that long or one remains. No day is dropped. On the real practice layout (07-20 .. 09-21 with B2
 * on day 1, B3 on day 51 and B4 on day 54) the regimes [0,1) [1,51) [51,54) [54,64) resample as [0,54) [54,64).
 */
export const mergeShortRegimes = (
  regimes: readonly { readonly from: number; readonly to: number }[],
  minDays: number = Math.max(...SPA_BLOCK_LENGTHS),
): { from: number; to: number }[] => {
  const out = regimes.map((r) => ({ from: r.from, to: r.to }));
  for (;;) {
    if (out.length <= 1) return out;
    const i = out.findIndex((r) => r.to - r.from < minDays);
    if (i < 0) return out;
    if (i > 0) out.splice(i - 1, 2, { from: out[i - 1]!.from, to: out[i]!.to });
    else out.splice(0, 2, { from: out[0]!.from, to: out[1]!.to });
  }
};

/** Fewest active days for a variant to be selectable (the stats MIN_DAYS). */
export const SPA_MIN_ACTIVE_DAYS = 10;

/** How each statistic is studentised; both are calibrated in stats-simulation.test.ts and one is frozen. */
export type SpaStudentisation = 'fixed' | 'replicate';

/**
 * The studentisation frozen before any data (STATS-1c calibration, T = 50, 12 scenarios, 300 runs each at zero edge):
 * Hansen's fixed ω̂ rejected globally in 12–42% of runs and passed a variant in up to 9.3%; re-studentising every
 * replicate (batch means over the same blocks) rejected globally in at most 3.0% and passed a variant in at most 0.33%.
 */
export const SPA_STUDENTISATION: SpaStudentisation = 'replicate';

/** Regime index ranges a resample may draw from; exported so tests can check a block never crosses a boundary. */
export const spaResampleIndices = (regimes: readonly { from: number; to: number }[], L: number, rng: Rng, T: number): Int32Array => {
  const out = new Int32Array(T);
  stationaryIndices(regimes, L, rng, out);
  return out;
};

/** The registered settings of a run: fixed before any data is seen. */
export interface SpaRegistration {
  /** Floor on every ω, in the daily P&L's units. */
  readonly seFloor: number;
  readonly studentisation: SpaStudentisation;
  /** Regimes as [from, to) day indices covering 0..T in order; empty or omitted for one regime. */
  readonly regimes?: readonly { readonly from: number; readonly to: number }[];
}

export interface SpaInput {
  /** Variant id → daily net P&L on the common calendar. */
  readonly variants: Readonly<Record<string, readonly number[]>>;
  /** S0's daily net P&L on the same calendar. */
  readonly s0: readonly number[];
  /** Variant id → days with any trading activity (counted before outcomes are read). */
  readonly activeDays: Readonly<Record<string, number>>;
  readonly registration: SpaRegistration;
}

export interface SpaOptions {
  readonly rng: Rng;
  readonly replicates: number;
  /** Test level. */
  readonly alpha: number;
}

export interface SpaVariantResult {
  readonly id: string;
  readonly zVsZero: number;
  readonly zVsS0: number;
  /** Passed against both benchmarks at every block length, by the step-down. */
  readonly passed: boolean;
}

export interface SpaResult {
  /** Global p: the largest over the block lengths of (1 + #{T* ≥ T}) / (1 + B). */
  readonly pValue: number;
  readonly pByBlockLength: Readonly<Record<number, number>>;
  readonly statistic: number;
  readonly days: number;
  /** Mean number of blocks a replicate draws, per block length (T / L, summed over regimes). */
  readonly effectiveBlocks: Readonly<Record<number, number>>;
  /** The regimes resampled within, after short ones were merged (mergeShortRegimes). */
  readonly resampleRegimes: readonly { readonly from: number; readonly to: number }[];
  readonly variants: readonly SpaVariantResult[];
  /** Variants left out of selection for too little activity (all-zero series included). */
  readonly excluded: readonly string[];
  readonly passing: readonly string[];
}

interface Stat {
  readonly series: Float64Array;
  readonly mean: number;
  omega: number;
  centre: number;
}

const stationaryIndices = (regimes: readonly { from: number; to: number }[], L: number, rng: Rng, out: Int32Array): void => {
  const q = 1 / L;
  for (const r of regimes) {
    const len = r.to - r.from;
    let t = nextInt(rng, len);
    for (let i = 0; i < len; i++) {
      if (i > 0) t = rng.next() < q ? nextInt(rng, len) : (t + 1) % len;
      out[r.from + i] = r.from + t;
    }
  }
};

const meanOf = (s: Float64Array, idx: Int32Array | null): number => {
  let sum = 0;
  if (idx) for (let i = 0; i < s.length; i++) sum += s[idx[i]!]!;
  else for (let i = 0; i < s.length; i++) sum += s[i]!;
  return sum / s.length;
};

/** Batch-means long-run SD over consecutive blocks of L positions (for per-replicate studentisation). */
const batchSd = (s: Float64Array, idx: Int32Array | null, mean: number, L: number): number => {
  const T = s.length;
  const m = Math.ceil(T / L);
  if (m < 2) return 0;
  let ss = 0;
  for (let j = 0; j < m; j++) {
    let sum = 0;
    let n = 0;
    for (let i = j * L; i < Math.min(T, (j + 1) * L); i++) {
      sum += idx ? s[idx[i]!]! : s[i]!;
      n++;
    }
    ss += (sum - n * mean) ** 2;
  }
  return Math.sqrt((ss * m) / (m - 1) / T);
};

/** One block length: observed statistics, the bootstrap max distribution, the global p and the step-down. */
const runAtBlockLength = (
  stats: Stat[],
  T: number,
  regimes: readonly { from: number; to: number }[],
  L: number,
  reg: SpaRegistration,
  opts: SpaOptions,
): { p: number; tObs: number; rejected: Set<number> } => {
  const B = opts.replicates;
  const rootT = Math.sqrt(T);
  const idx = new Int32Array(T);
  const boot = stats.map(() => new Float64Array(B));
  const bootSd = reg.studentisation === 'replicate' ? stats.map(() => new Float64Array(B)) : null;
  for (let b = 0; b < B; b++) {
    stationaryIndices(regimes, L, opts.rng, idx);
    stats.forEach((st, k) => {
      const mb = meanOf(st.series, idx);
      boot[k]![b] = mb;
      if (bootSd) bootSd[k]![b] = Math.max(batchSd(st.series, idx, mb, L), reg.seFloor);
    });
  }
  const lil = Math.sqrt(2 * Math.log(Math.log(T)));
  for (const [k, st] of stats.entries()) {
    if (reg.studentisation === 'fixed') {
      let v = 0;
      for (let b = 0; b < B; b++) v += (boot[k]![b]! - st.mean) ** 2;
      st.omega = Math.max(Math.sqrt((T * v) / B), reg.seFloor);
    } else {
      st.omega = Math.max(batchSd(st.series, null, st.mean, L), reg.seFloor);
    }
    st.centre = (rootT * st.mean) / st.omega < -lil ? st.mean : 0;
  }
  const zOf = (st: Stat) => (rootT * st.mean) / st.omega;
  const tObs = Math.max(0, ...stats.map(zOf));
  const maxOver = (active: readonly number[]): Float64Array => {
    const out = new Float64Array(B);
    for (let b = 0; b < B; b++) {
      let m = 0;
      for (const k of active) {
        const st = stats[k]!;
        const w = bootSd ? bootSd[k]![b]! : st.omega;
        const z = (rootT * (boot[k]![b]! - st.mean + st.centre)) / w;
        if (z > m) m = z;
      }
      out[b] = m;
    }
    return out;
  };
  const all = stats.map((_, k) => k);
  const first = maxOver(all);
  let exceed = 0;
  for (let b = 0; b < B; b++) if (first[b]! >= tObs) exceed++;
  const p = (1 + exceed) / (1 + B);
  // Step-down: reject every statistic above the (1 − α) critical value of the max over those not yet rejected; repeat.
  const rejected = new Set<number>();
  let dist = first;
  for (;;) {
    const sorted = Array.from(dist).sort((a, c) => a - c);
    const crit = sorted[Math.min(B - 1, Math.ceil((1 - opts.alpha) * (B + 1)) - 1)]!;
    const fresh = all.filter((k) => !rejected.has(k) && zOf(stats[k]!) > crit);
    if (fresh.length === 0) break;
    for (const k of fresh) rejected.add(k);
    const left = all.filter((k) => !rejected.has(k));
    if (left.length === 0) break;
    dist = maxOver(left);
  }
  return { p, tObs, rejected };
};

/** Run the SPA test over the whole registry (see the header). */
export const spaTest = (input: SpaInput, opts: SpaOptions): SpaResult => {
  const ids = Object.keys(input.variants).sort();
  if (ids.length === 0) throw new RangeError('no variants');
  const T = input.s0.length;
  for (const id of ids) {
    const s = input.variants[id]!;
    if (s.length !== T) throw new RangeError(`variant ${id} has ${s.length} days, expected ${T}: put every variant on one calendar`);
    for (const x of s) if (!Number.isFinite(x)) throw new RangeError(`variant ${id} has a non-finite daily P&L`);
  }
  for (const x of input.s0) if (!Number.isFinite(x)) throw new RangeError('S0 has a non-finite daily P&L');
  if (T < SPA_MIN_ACTIVE_DAYS) throw new RangeError(`the SPA test needs at least ${SPA_MIN_ACTIVE_DAYS} days, got ${T}`);
  const reg = input.registration;
  if (!(reg.seFloor > 0) || !Number.isFinite(reg.seFloor)) throw new RangeError('the registered SE floor must be a positive number');
  if (!(opts.alpha > 0 && opts.alpha < 1)) throw new RangeError(`alpha must be in (0, 1), got ${opts.alpha}`);
  if (!Number.isInteger(opts.replicates) || opts.replicates < Math.ceil(20 / opts.alpha)) {
    throw new RangeError(`replicates must be an integer >= 20 / α = ${Math.ceil(20 / opts.alpha)}, got ${opts.replicates}`);
  }
  const regimes = reg.regimes && reg.regimes.length > 0 ? reg.regimes : [{ from: 0, to: T }];
  let at = 0;
  for (const r of regimes) {
    if (r.from !== at || !(r.to > r.from)) throw new RangeError('regimes must cover the calendar in order, each at least one day');
    at = r.to;
  }
  if (at !== T) throw new RangeError(`regimes cover ${at} days, the calendar has ${T}`);
  const merged = mergeShortRegimes(regimes);

  const excluded: string[] = [];
  const kept: string[] = [];
  for (const id of ids) {
    const allZero = input.variants[id]!.every((x) => x === 0);
    if (allZero || (input.activeDays[id] ?? 0) < SPA_MIN_ACTIVE_DAYS) excluded.push(id);
    else kept.push(id);
  }
  const s0 = Float64Array.from(input.s0);
  const build = (): Stat[] => kept.flatMap((id) => {
    const x = input.variants[id]!;
    return [Float64Array.from(x), Float64Array.from(x, (v, t) => v - s0[t]!)].map((series) => ({ series, mean: meanOf(series, null), omega: 0, centre: 0 }));
  });
  const pBy: Record<number, number> = {};
  const blocks: Record<number, number> = {};
  const passAll = new Set(kept.map((_, j) => j));
  let statistic = 0;
  let zs: { zVsZero: number; zVsS0: number }[] = [];
  const rootT = Math.sqrt(T);
  for (const L of SPA_BLOCK_LENGTHS) {
    blocks[L] = merged.reduce((s, r) => s + (r.to - r.from) / L, 0);
    if (kept.length === 0) {
      pBy[L] = 1;
      continue;
    }
    const stats = build();
    const r = runAtBlockLength(stats, T, merged, L, reg, opts);
    pBy[L] = r.p;
    statistic = Math.max(statistic, r.tObs);
    zs = kept.map((_, j) => ({ zVsZero: (rootT * stats[2 * j]!.mean) / stats[2 * j]!.omega, zVsS0: (rootT * stats[2 * j + 1]!.mean) / stats[2 * j + 1]!.omega }));
    for (const j of [...passAll]) if (!(r.rejected.has(2 * j) && r.rejected.has(2 * j + 1))) passAll.delete(j);
  }
  const pValue = Math.max(...SPA_BLOCK_LENGTHS.map((L) => pBy[L]!));
  const variants = kept.map((id, j) => ({ id, zVsZero: zs[j]?.zVsZero ?? 0, zVsS0: zs[j]?.zVsS0 ?? 0, passed: passAll.has(j) }));
  return { pValue, pByBlockLength: pBy, statistic, days: T, effectiveBlocks: blocks, resampleRegimes: merged, variants, excluded, passing: variants.filter((v) => v.passed).map((v) => v.id) };
};

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
