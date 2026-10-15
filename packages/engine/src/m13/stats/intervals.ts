// Intervals for the gates (A-M13-03 logic 1, 8-10; addendum A14, clarification C-65).
//
// Stationary bootstrap (logic 1) [ST-35]: Politis & Romano, JASA 89(428), 1994, pp. 1303-1313. Each resample of n
// observations is built from blocks that start at a uniform index and have a geometric length with mean `b` (P(L = k)
// = (1 − 1/b)^(k−1)·(1/b)), wrapping around the end of the series, until n observations are drawn. 10,000 resamples
// (POLICY, ARCH 3.4), a seeded `Rng`, percentile interval. VERIFY V3 (research/verify-next/RESULTS.md) could not read
// the paper's text: the mean block length `b = max(1, round(n^(1/3)))` is the ticket's own POLICY, not the paper's,
// and the reported interval is the most conservative (lowest lower bound) of runs at b/2, b and 2b (C-34). Series are
// in time order (per-trade returns in entry order).
//
// Day-cluster t-interval (A14, C-65): trades on one calendar day share the market, so their returns are correlated.
// θ = Σx / N; with S_d and n_d the sum and count of day d, u_d = (S_d − θ·n_d) / N and SE² = D/(D − 1)·Σ u_d² (the CR1
// cluster-robust standard error; D days); the interval is θ ± t_{D−1}(0.975)·SE. DEFF = SE² / (s²/N), s² the sample
// variance: the factor by which same-day correlation inflates the variance of the mean (R-1's n_80 uses it).
// The gate interval is the more conservative of the two (the one with the lower lower bound): the A14 evidence is that
// a block bootstrap covered a nominal 99% about 86% of the time on day-correlated data (research/daily-probe/PREREG.md:36).
//
// Edge cases: an empty or constant series, or fewer than two days, gives null; a NaN or infinite input throws E_INPUT.
import type { Rng } from '@bot/types';
import { nextBelow } from '../../m10/rng.ts';
import { checkFinite, mean, quantileSorted, sampleVariance } from './descriptive.ts';
import { normalQuantile, studentTQuantile } from './special.ts';

/** POLICY (ARCH 3.4): resamples of every gate bootstrap. Changing it is a code change. */
export const BOOTSTRAP_RESAMPLES = 10_000;
export const CI_LEVEL = 0.95;
const TWO_POW_32 = 4_294_967_296;
const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface Interval { low: number; high: number }
export interface BootstrapInterval extends Interval { meanBlockUsed: number }
export interface ClusterInterval extends Interval { estimate: number; se: number; days: number; deff: number }
export interface GateInterval extends Interval {
  chosen: 'stationary_bootstrap' | 'day_cluster_t';
  bootstrap: BootstrapInterval;
  cluster: ClusterInterval;
  deff: number;
}

/** POLICY mean block length b = max(1, round(n^(1/3))). */
export function policyMeanBlock(n: number): number {
  return Math.max(1, Math.round(Math.cbrt(n)));
}

/** The three block lengths of the conservative rule: b/2 (at least 1), b and 2b. */
function blockTriple(b: number): number[] {
  return [Math.max(1, b / 2), b, 2 * b];
}

function checkMeanBlock(b: number): void {
  if (!Number.isFinite(b) || b < 1) throw new RangeError('E_INPUT: the mean block length must be >= 1');
}

/** Visits the blocks of one stationary-bootstrap resample of n observations: (start, length), start + length ≤ 2n. */
function resampleBlocks(n: number, meanBlock: number, rng: Rng, visit: (start: number, len: number) => void): void {
  const logQ = meanBlock > 1 ? Math.log(1 - 1 / meanBlock) : 0;
  let remaining = n;
  while (remaining > 0) {
    const start = nextBelow(rng, n);
    let len = logQ === 0 ? 1 : 1 + Math.floor(Math.log(1 - rng.nextFloat()) / logQ);
    if (len > remaining) len = remaining;
    visit(start, len);
    remaining -= len;
  }
}

/** Prefix sums of f(x) over the series written twice (so a wrapping block is one difference). */
function prefix(x: readonly number[], f: (v: number, i: number) => number): Float64Array {
  const n = x.length, p = new Float64Array(2 * n + 1);
  for (let i = 0; i < 2 * n; i++) p[i + 1] = (p[i] as number) + f(x[i % n] as number, i % n);
  return p;
}

/** Resample means of a stationary bootstrap, in draw order (`resampleBlocks` inlined: this is the hot loop). */
function bootstrapMeans(x: readonly number[], meanBlock: number, resamples: number, rng: Rng): Float64Array {
  const n = x.length, p = prefix(x, (v) => v), out = new Float64Array(resamples);
  const invLogQ = meanBlock > 1 ? 1 / Math.log(1 - 1 / meanBlock) : 0;
  const threshold = (TWO_POW_32 - n) % n;                     // nextBelow's rejection threshold, hoisted
  for (let r = 0; r < resamples; r++) {
    let s = 0, remaining = n;
    while (remaining > 0) {
      let u = rng.nextU32();
      while (u < threshold) u = rng.nextU32();
      const start = u % n;
      let len = invLogQ === 0 ? 1 : 1 + Math.floor(Math.log(1 - rng.nextFloat()) * invLogQ);
      if (len > remaining) len = remaining;
      s += (p[start + len] as number) - (p[start] as number);
      remaining -= len;
    }
    out[r] = s / n;
  }
  return out;
}

/** The three runs of logic 1 (b/2, b, 2b, in that order and on one generator); null when logic 1 gives null. */
export function stationaryBootstrapRuns(x: readonly number[], o: { resamples: 10_000; level: 0.95; rng: Rng; meanBlock?: number }): BootstrapInterval[] | null {
  checkFinite(x);
  if (o.resamples !== BOOTSTRAP_RESAMPLES || o.level !== CI_LEVEL) throw new RangeError('E_INPUT: resamples and level are POLICY (10,000; 0.95)');
  if (sampleVariance(x) === null) return null;
  const b = o.meanBlock ?? policyMeanBlock(x.length);
  checkMeanBlock(b);
  const alpha = 1 - o.level;
  return blockTriple(b).map((m) => {
    const means = bootstrapMeans(x, m, o.resamples, o.rng).sort();
    return { low: quantileSorted(means, alpha / 2), high: quantileSorted(means, 1 - alpha / 2), meanBlockUsed: m };
  });
}

/**
 * Logic 1. The percentile interval of the mean at the given level, from the run (b/2, b, 2b) with the lowest lower
 * bound. `meanBlock` replaces the POLICY b. Null for fewer than two observations or a constant series.
 */
export function stationaryBootstrapMeanCi(x: readonly number[], o: { resamples: 10_000; level: 0.95; rng: Rng; meanBlock?: number }): BootstrapInterval | null {
  const runs = stationaryBootstrapRuns(x, o);
  if (runs === null) return null;
  return runs.reduce((best, r) => (r.low < best.low ? r : best));
}

/** The day-cluster t-interval of the mean (A14). `days[i]` is the calendar day of `x[i]` (UTC, e.g. "2026-10-15"). */
export function dayClusterMeanCi(x: readonly number[], days: readonly string[], level: 0.95 = CI_LEVEL): ClusterInterval | null {
  checkFinite(x);
  if (!Array.isArray(days) || days.length !== x.length) throw new RangeError('E_INPUT: one day key per observation');
  // Ruling Z06-4: one exact form, so '2026-10-15' and '2026-10-15 ' can never split one day into two clusters.
  if (!days.every((d) => typeof d === 'string' && DAY_KEY_RE.test(d))) throw new RangeError('E_INPUT: day keys must be YYYY-MM-DD');
  if (level !== CI_LEVEL) throw new RangeError('E_INPUT: level is 0.95');
  const v = sampleVariance(x);
  if (v === null) return null;
  const n = x.length, theta = mean(x);
  const sums = new Map<string, { s: number; k: number }>();
  for (let i = 0; i < n; i++) {
    const d = days[i] as string, e = sums.get(d);
    if (e === undefined) sums.set(d, { s: x[i] as number, k: 1 }); else { e.s += x[i] as number; e.k++; }
  }
  const dCount = sums.size;
  if (dCount < 2) return null;
  let ss = 0;
  for (const { s, k } of sums.values()) { const u = (s - theta * k) / n; ss += u * u; }
  const se2 = (dCount / (dCount - 1)) * ss;
  if (!(se2 > 0)) return null;
  const se = Math.sqrt(se2), t = studentTQuantile(1 - (1 - level) / 2, dCount - 1);
  return { low: theta - t * se, high: theta + t * se, estimate: theta, se, days: dCount, deff: se2 / (v / n) };
}

/** The gate interval of the mean (A14): the more conservative (lower lower bound) of the two; null if either is. */
export function gateMeanCi(x: readonly number[], days: readonly string[], o: { rng: Rng }): GateInterval | null {
  const cluster = dayClusterMeanCi(x, days);
  const bootstrap = stationaryBootstrapMeanCi(x, { resamples: BOOTSTRAP_RESAMPLES, level: CI_LEVEL, rng: o.rng });
  if (cluster === null || bootstrap === null) return null;
  const useCluster = cluster.low <= bootstrap.low;
  const pick = useCluster ? cluster : bootstrap;
  return { low: pick.low, high: pick.high, chosen: useCluster ? 'day_cluster_t' : 'stationary_bootstrap', bootstrap, cluster, deff: cluster.deff };
}

/** Wilson score interval for k successes in n trials (no continuity correction). */
export function wilson(k: number, n: number, level: 0.95 = CI_LEVEL): Interval {
  if (!Number.isInteger(k) || !Number.isInteger(n) || n < 1 || k < 0 || k > n) throw new RangeError('E_INPUT: need integers 0 <= k <= n, n >= 1');
  if (level !== CI_LEVEL) throw new RangeError('E_INPUT: level is 0.95');
  const z = normalQuantile(1 - (1 - level) / 2), z2 = z * z, p = k / n;
  const den = 1 + z2 / n, centre = (p + z2 / (2 * n)) / den;
  const half = (z / den) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return { low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

/**
 * Logic 10 (LS-3): the one-sided lower bound at `level` of mean(live) − mean(paper), from independent stationary
 * bootstraps of the two series (resampling the paper side too is the conservative reading, C-34), 10,000 resamples,
 * the lowest bound of the b/2, b, 2b runs (b by each side's own length). The caller compares it with −δ. Null when
 * either side has fewer than two observations or is constant.
 */
export function nonInferiorityLowerBound(live: readonly number[], paper: readonly number[], o: { level: 0.95; rng: Rng }): number | null {
  checkFinite(live, 'live');
  checkFinite(paper, 'paper');
  if (o.level !== CI_LEVEL) throw new RangeError('E_INPUT: level is 0.95');
  if (sampleVariance(live) === null || sampleVariance(paper) === null) return null;
  const bl = blockTriple(policyMeanBlock(live.length)), bp = blockTriple(policyMeanBlock(paper.length));
  let lowest = Infinity;
  for (let i = 0; i < 3; i++) {
    const ml = bootstrapMeans(live, bl[i] as number, BOOTSTRAP_RESAMPLES, o.rng);
    const mp = bootstrapMeans(paper, bp[i] as number, BOOTSTRAP_RESAMPLES, o.rng);
    // Independent resamples, paired in draw order.
    const d = new Float64Array(BOOTSTRAP_RESAMPLES);
    for (let r = 0; r < BOOTSTRAP_RESAMPLES; r++) d[r] = (ml[r] as number) - (mp[r] as number);
    d.sort();
    lowest = Math.min(lowest, quantileSorted(d, 1 - o.level));
  }
  return lowest;
}

/**
 * Logic 9 [ST-36]: a studentized time-series bootstrap interval (two-sided 95%) for SR(a) − SR(b) on paired series
 * (same periods, time order). SR = μ / √(E[x²] − μ²) per series; the standard error is the delta method on the
 * moments (μa, μb, E[a²], E[b²]) with their sample covariance; resamples are stationary-bootstrap blocks of whole
 * rows (mean block b = POLICY), so the dependence over time stays in t* = (Δ* − Δ̂) / SE*. Interval
 * [Δ̂ − q*(0.975)·SE, Δ̂ − q*(0.025)·SE]. For reporting comparisons only. Null below 4 rows, for a constant series,
 * or when more than 1% of resamples are degenerate.
 */
export function studentizedTsBootstrapSharpeDiff(a: readonly number[], b: readonly number[], o: { resamples: number; rng: Rng }): Interval | null {
  checkFinite(a, 'a');
  checkFinite(b, 'b');
  if (a.length !== b.length) throw new RangeError('E_INPUT: the two series must be paired');
  if (!Number.isInteger(o.resamples) || o.resamples < 1_000) throw new RangeError('E_INPUT: resamples must be an integer >= 1,000');
  const n = a.length;
  if (n < 4 || sampleVariance(a) === null || sampleVariance(b) === null) return null;
  // Prefix sums of the four moment series and their ten cross products.
  const y = [(i: number) => a[i] as number, (i: number) => b[i] as number, (i: number) => (a[i] as number) ** 2, (i: number) => (b[i] as number) ** 2];
  const p1 = y.map((f) => prefix(a, (_, i) => f(i)));
  const p2: Float64Array[] = [];
  for (let i = 0; i < 4; i++) for (let j = i; j < 4; j++) p2.push(prefix(a, (_, k) => (y[i] as (k: number) => number)(k) * (y[j] as (k: number) => number)(k)));
  const s1 = new Float64Array(4), s2 = new Float64Array(10);
  const stat = (): { d: number; se: number } | null => {
    const m = Array.from(s1, (v) => v / n);
    const va = (m[2] as number) - (m[0] as number) ** 2, vb = (m[3] as number) - (m[1] as number) ** 2;
    if (!(va > 0) || !(vb > 0)) return null;
    const d = (m[0] as number) / Math.sqrt(va) - (m[1] as number) / Math.sqrt(vb);
    const g = [(m[2] as number) / va ** 1.5, -(m[3] as number) / vb ** 1.5, -(m[0] as number) / (2 * va ** 1.5), (m[1] as number) / (2 * vb ** 1.5)];
    let q = 0, k = 0;
    for (let i = 0; i < 4; i++) for (let j = i; j < 4; j++) {
      const cov = (s2[k++] as number) / n - (m[i] as number) * (m[j] as number);
      q += (i === j ? 1 : 2) * (g[i] as number) * (g[j] as number) * cov;
    }
    return q > 0 && Number.isFinite(d) ? { d, se: Math.sqrt(q / n) } : null;
  };
  const fill = (rows: (visit: (start: number, len: number) => void) => void): void => {
    s1.fill(0); s2.fill(0);
    rows((st, len) => {
      for (let i = 0; i < 4; i++) { const q = p1[i] as Float64Array; s1[i] = (s1[i] as number) + (q[st + len] as number) - (q[st] as number); }
      for (let k = 0; k < 10; k++) { const q = p2[k] as Float64Array; s2[k] = (s2[k] as number) + (q[st + len] as number) - (q[st] as number); }
    });
  };
  fill((visit) => visit(0, n));
  const full = stat();
  if (full === null) return null;
  const mb = policyMeanBlock(n), ts: number[] = [];
  let bad = 0;
  for (let r = 0; r < o.resamples; r++) {
    fill((visit) => resampleBlocks(n, mb, o.rng, visit));
    const s = stat();
    if (s === null) bad++; else ts.push((s.d - full.d) / s.se);
  }
  if (bad > o.resamples / 100) return null;
  ts.sort((x, z) => x - z);
  return { low: full.d - quantileSorted(ts, 0.975) * full.se, high: full.d - quantileSorted(ts, 0.025) * full.se };
}
