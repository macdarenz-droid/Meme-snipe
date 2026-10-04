// Survival study analysis (RES-5, docs/research/survival.md §3–5): find/check day split, matched look-alike strata,
// Mantel–Haenszel risk difference with a day-block bootstrap interval, Wilson intervals, Holm over every test, and
// the trade measures used to compare rules. Exploration, not proof.
import { createRng, holm, nextInt } from '../../../core/src/stats/index.ts';
import { SURVIVAL_FEATURES, type SurvivalFeature } from './survival.ts';

export interface LabelledDecision {
  readonly id: string;
  readonly day: string;
  readonly ageMs: number;
  readonly stratum: string;
  /** The creator (cluster) of the coin; absent means a cluster of its own. Read only by the creator features' test. */
  readonly cluster?: string;
  readonly features: Readonly<Record<SurvivalFeature, number | null>>;
  readonly survived: boolean;
}

/**
 * Features fixed per creator: graduates of one creator share both the feature and, often, their fate, so their
 * decisions are not exchangeable one by one (review of #120, N5). These are tested on creator blocks.
 */
export const CREATOR_FEATURES: ReadonlySet<SurvivalFeature> = new Set(['s_creator_surv', 's_creator_rugs']);

/** Earliest ceil(2/3) of the days find features; the rest check them (survival.md §4). Pass the window's readable days. */
export const splitDays = (days: readonly string[]): { readonly find: string[]; readonly check: string[] } => {
  const d = [...new Set(days)].sort();
  const k = Math.ceil((2 * d.length) / 3);
  return { find: d.slice(0, k), check: d.slice(k) };
};

/** Wilson score interval for k of n at 95%. */
export const wilson = (k: number, n: number): { readonly rate: number; readonly lower: number; readonly upper: number } | null => {
  if (n === 0) return null;
  const z = 1.959963984540054;
  const p = k / n;
  const den = 1 + (z * z) / n;
  const mid = (p + (z * z) / (2 * n)) / den;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / den;
  return { rate: p, lower: Math.max(0, mid - half), upper: Math.min(1, mid + half) };
};

const median = (xs: readonly number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/**
 * Mantel–Haenszel risk difference of survival, feature high (> split) minus low, within look-alike strata:
 * Σ w_s (p_hi − p_lo) / Σ w_s with w_s = n_hi·n_lo / (n_hi + n_lo). Strata missing either side add nothing. null when no stratum has both.
 */
export const mhRiskDifference = (xs: readonly LabelledDecision[], f: SurvivalFeature, split: number): number | null => {
  const s = new Map<string, { hk: number; hn: number; lk: number; ln: number }>();
  for (const x of xs) {
    const v = x.features[f];
    if (v === null || !Number.isFinite(v)) continue;
    const c = s.get(x.stratum) ?? { hk: 0, hn: 0, lk: 0, ln: 0 };
    if (v > split) {
      c.hn++;
      if (x.survived) c.hk++;
    } else {
      c.ln++;
      if (x.survived) c.lk++;
    }
    s.set(x.stratum, c);
  }
  let num = 0;
  let den = 0;
  for (const c of s.values()) {
    if (c.hn === 0 || c.ln === 0) continue;
    const w = (c.hn * c.ln) / (c.hn + c.ln);
    num += w * (c.hk / c.hn - c.lk / c.ln);
    den += w;
  }
  return den === 0 ? null : num / den;
};

/** Day-block bootstrap of a statistic over decisions: resample whole days, 2.5/97.5 percentiles. An interval only, never a test. */
export const dayBootstrap = (xs: readonly LabelledDecision[], stat: (ys: readonly LabelledDecision[]) => number | null, reps: number, seed: number) => {
  const byDay = new Map<string, LabelledDecision[]>();
  for (const x of xs) byDay.set(x.day, [...(byDay.get(x.day) ?? []), x]);
  const days = [...byDay.keys()].sort();
  const est = stat(xs);
  if (est === null || days.length < 2) return { est, lower: null, upper: null };
  const rng = createRng(seed);
  const vals: number[] = [];
  for (let r = 0; r < reps; r++) {
    const ys: LabelledDecision[] = [];
    for (let i = 0; i < days.length; i++) ys.push(...byDay.get(days[nextInt(rng, days.length)]!)!);
    const v = stat(ys);
    if (v !== null) vals.push(v);
  }
  if (vals.length < reps * 0.9) return { est, lower: null, upper: null };
  vals.sort((a, b) => a - b);
  const q = (p: number) => vals[Math.min(vals.length - 1, Math.max(0, Math.floor(p * vals.length)))]!;
  return { est, lower: q(0.025), upper: q(0.975) };
};

/** Family-wise level, the number of tests in the family, and the registered permutation count B ≥ ceil(20·45/α). */
export const ALPHA = 0.05;
export const FAMILY_TESTS = 45;
export const PERMUTATIONS = Math.ceil((20 * FAMILY_TESTS) / ALPHA);
/** Fewer find-days than this: no rule is chosen, recorded as such (survival.md §5; as g2rule.ts's minimum). */
export const MIN_FIND_DAYS = 10;

interface Cell {
  readonly stratum: number;
  /** Decisions, survivors and feature-high decisions in the cell. */
  readonly m: number;
  readonly k: number;
  readonly h: number;
  /** CDF of the hypergeometric number of high survivors, from `lo` up. */
  readonly lo: number;
  readonly cdf: Float64Array;
}

const logFact = (() => {
  const t: number[] = [0];
  return (n: number): number => {
    for (let i = t.length; i <= n; i++) t.push(t[i - 1]! + Math.log(i));
    return t[n]!;
  };
})();
const logChoose = (n: number, k: number): number => logFact(n) - logFact(k) - logFact(n - k);

/**
 * Permutation test of the matched (Mantel–Haenszel) difference: survival labels are shuffled within each day ×
 * stratum cell, which keeps the day structure, the strata and every cell's survivor count. Under that shuffle the
 * high-group survivors of a cell are hypergeometric, so each permutation draws one number per cell. Two-sided;
 * p = (1 + k) / (1 + B) with k the permutations at least as extreme (Phipson & Smyth 2010).
 */
export const permutationTest = (xs: readonly LabelledDecision[], f: SurvivalFeature, split: number, permutations: number, seed: number): { readonly est: number | null; readonly p: number | null } => {
  if (CREATOR_FEATURES.has(f)) return creatorBlockTest(xs, f, split, permutations, seed);
  const est = mhRiskDifference(xs, f, split);
  if (est === null) return { est, p: null };
  const strataIds = new Map<string, number>();
  const cellMap = new Map<string, { stratum: number; m: number; k: number; h: number }>();
  for (const x of xs) {
    const v = x.features[f];
    if (v === null || !Number.isFinite(v)) continue;
    const sid = strataIds.get(x.stratum) ?? strataIds.size;
    strataIds.set(x.stratum, sid);
    const key = `${x.day}|${x.stratum}`;
    const c = cellMap.get(key) ?? { stratum: sid, m: 0, k: 0, h: 0 };
    c.m++;
    if (x.survived) c.k++;
    if (v > split) c.h++;
    cellMap.set(key, c);
  }
  const S = strataIds.size;
  const hn = new Float64Array(S);
  const ln = new Float64Array(S);
  const kTot = new Float64Array(S);
  const cells: Cell[] = [];
  for (const c of cellMap.values()) {
    hn[c.stratum]! += c.h;
    ln[c.stratum]! += c.m - c.h;
    kTot[c.stratum]! += c.k;
    const lo = Math.max(0, c.h + c.k - c.m);
    const hi = Math.min(c.h, c.k);
    const cdf = new Float64Array(hi - lo + 1);
    let acc = 0;
    for (let x = lo; x <= hi; x++) {
      acc += Math.exp(logChoose(c.k, x) + logChoose(c.m - c.k, c.h - x) - logChoose(c.m, c.h));
      cdf[x - lo] = acc;
    }
    cells.push({ ...c, lo, cdf });
  }
  const w = new Float64Array(S);
  let wSum = 0;
  for (let s = 0; s < S; s++) {
    if (hn[s]! > 0 && ln[s]! > 0) {
      w[s] = (hn[s]! * ln[s]!) / (hn[s]! + ln[s]!);
      wSum += w[s]!;
    }
  }
  const rng = createRng(seed);
  const xHi = new Float64Array(S);
  const abs = Math.abs(est) - 1e-12;
  let k = 0;
  for (let b = 0; b < permutations; b++) {
    xHi.fill(0);
    for (const c of cells) {
      const u = rng.next() * c.cdf[c.cdf.length - 1]!;
      let i = 0;
      while (i < c.cdf.length - 1 && c.cdf[i]! < u) i++;
      xHi[c.stratum]! += c.lo + i;
    }
    let num = 0;
    for (let s = 0; s < S; s++) if (w[s]! > 0) num += w[s]! * (xHi[s]! / hn[s]! - (kTot[s]! - xHi[s]!) / ln[s]!);
    if (Math.abs(num / wSum) >= abs) k++;
  }
  return { est, p: (1 + k) / (1 + permutations) };
};

/**
 * The creator features' permutation test (RES-5c). Within each day × stratum cell, one creator's decisions form one
 * unit; the unit is high when its first decision's value (in time order as given) is above the split, and every
 * decision of the unit counts on that side. The permutation shuffles high and low among the units of a cell, keeping
 * each unit's decisions and survivors together, so survival shared within a creator can no longer pass as signal.
 * The statistic is the matched (Mantel–Haenszel) difference over decisions; two-sided; p = (1 + k) / (1 + B).
 */
const creatorBlockTest = (xs: readonly LabelledDecision[], f: SurvivalFeature, split: number, permutations: number, seed: number): { readonly est: number | null; readonly p: number | null } => {
  const strataIds = new Map<string, number>();
  const cells = new Map<string, { stratum: number; units: Map<string, { m: number; k: number; high: boolean }> }>();
  for (const x of xs) {
    const v = x.features[f];
    if (v === null || !Number.isFinite(v)) continue;
    const sid = strataIds.get(x.stratum) ?? strataIds.size;
    strataIds.set(x.stratum, sid);
    const key = `${x.day}|${x.stratum}`;
    const c = cells.get(key) ?? { stratum: sid, units: new Map() };
    const id = x.cluster ?? `id:${x.id}`;
    const u = c.units.get(id) ?? { m: 0, k: 0, high: v > split };
    u.m++;
    if (x.survived) u.k++;
    c.units.set(id, u);
    cells.set(key, c);
  }
  const S = strataIds.size;
  const list = [...cells.values()].map((c) => ({ stratum: c.stratum, units: [...c.units.values()], highs: [...c.units.values()].filter((u) => u.high).length }));
  const hk = new Float64Array(S);
  const hn = new Float64Array(S);
  const lk = new Float64Array(S);
  const ln = new Float64Array(S);
  const mh = (): number | null => {
    let num = 0;
    let den = 0;
    for (let s = 0; s < S; s++) {
      if (hn[s]! === 0 || ln[s]! === 0) continue;
      const w = (hn[s]! * ln[s]!) / (hn[s]! + ln[s]!);
      num += w * (hk[s]! / hn[s]! - lk[s]! / ln[s]!);
      den += w;
    }
    return den === 0 ? null : num / den;
  };
  const add = (stratum: number, u: { m: number; k: number }, high: boolean): void => {
    if (high) {
      hn[stratum]! += u.m;
      hk[stratum]! += u.k;
    } else {
      ln[stratum]! += u.m;
      lk[stratum]! += u.k;
    }
  };
  const reset = (): void => {
    hk.fill(0);
    hn.fill(0);
    lk.fill(0);
    ln.fill(0);
  };
  for (const c of list) for (const u of c.units) add(c.stratum, u, u.high);
  const est = mh();
  if (est === null) return { est, p: null };
  const rng = createRng(seed);
  const abs = Math.abs(est) - 1e-12;
  let k = 0;
  const order: number[] = [];
  for (let b = 0; b < permutations; b++) {
    reset();
    for (const c of list) {
      // A uniform choice of which `highs` units of the cell are high (partial Fisher–Yates).
      order.length = 0;
      for (let i = 0; i < c.units.length; i++) order.push(i);
      for (let i = 0; i < c.highs; i++) {
        const j = i + nextInt(rng, c.units.length - i);
        const t = order[i]!;
        order[i] = order[j]!;
        order[j] = t;
      }
      for (let i = 0; i < c.units.length; i++) add(c.stratum, c.units[order[i]!]!, i < c.highs);
    }
    const v = mh();
    if (v !== null && Math.abs(v) >= abs) k++;
  }
  return { est, p: (1 + k) / (1 + permutations) };
};

interface SideResult {
  readonly est: number | null;
  readonly lower: number | null;
  readonly upper: number | null;
  readonly p: number | null;
}

export interface FeatureTest {
  readonly feature: SurvivalFeature;
  readonly ageMs: number;
  /** Median on the find-days, fixed before the check-days are read. */
  readonly split: number | null;
  readonly base: ReturnType<typeof wilson>;
  readonly high: ReturnType<typeof wilson>;
  readonly find: SideResult;
  readonly check: SideResult;
  readonly holmPass: boolean;
  /** Same sign on find- and check-days, and Holm passes on the check-days. Description only: it never chooses a rule. */
  readonly heldUp: boolean;
}

const side = (xs: readonly LabelledDecision[], f: SurvivalFeature, split: number | null, reps: number, perms: number, seed: number): SideResult => {
  if (split === null) return { est: null, lower: null, upper: null, p: null };
  const ci = dayBootstrap(xs, (ys) => mhRiskDifference(ys, f, split), reps, seed);
  return { ...ci, p: permutationTest(xs, f, split, perms, seed + 7).p };
};

/** Every feature at every decision age (survival.md §3): 15 × 3 = 45 counted tests, find- and check-days given. */
export const featureTests = (xs: readonly LabelledDecision[], days: { readonly find: readonly string[]; readonly check: readonly string[] }, reps: number, perms: number, seed: number): FeatureTest[] => {
  const F = new Set(days.find);
  const C = new Set(days.check);
  const ages = [...new Set(xs.map((x) => x.ageMs))].sort((a, b) => a - b);
  const raw = ages.flatMap((ageMs) => SURVIVAL_FEATURES.map((feature) => {
    const all = xs.filter((x) => x.ageMs === ageMs);
    const fd = all.filter((x) => F.has(x.day));
    const cd = all.filter((x) => C.has(x.day));
    const split = median(fd.map((x) => x.features[feature]).filter((v): v is number => v !== null && Number.isFinite(v)));
    const hi = split === null ? [] : cd.filter((x) => { const v = x.features[feature]; return v !== null && v > split; });
    return {
      feature, ageMs, split,
      base: wilson(cd.filter((x) => x.survived).length, cd.length),
      high: wilson(hi.filter((x) => x.survived).length, hi.length),
      find: side(fd, feature, split, reps, perms, seed),
      check: side(cd, feature, split, reps, perms, seed + 1),
    };
  }));
  const h = holm(raw.map((r) => r.check.p ?? 1));
  return raw.map((r, i) => ({
    ...r, holmPass: h.rejected[i]!,
    heldUp: h.rejected[i]! && r.find.est !== null && r.check.est !== null && Math.sign(r.find.est) === Math.sign(r.check.est) && r.check.est !== 0,
  }));
};

export interface TradeMeasures {
  readonly entries: number;
  readonly days: number;
  readonly winRate: number | null;
  readonly mean: number | null;
  readonly median: number | null;
  /** Gross wins ÷ gross losses; null without a loss. */
  readonly profitFactor: number | null;
}

export const tradeMeasures = (rs: readonly { readonly day: string; readonly rNet: number }[]): TradeMeasures => {
  const r = rs.map((x) => x.rNet);
  const wins = r.filter((x) => x > 0).reduce((a, b) => a + b, 0);
  const losses = -r.filter((x) => x < 0).reduce((a, b) => a + b, 0);
  return {
    entries: r.length, days: new Set(rs.map((x) => x.day)).size,
    winRate: r.length === 0 ? null : r.filter((x) => x > 0).length / r.length,
    mean: r.length === 0 ? null : r.reduce((a, b) => a + b, 0) / r.length,
    median: median(r), profitFactor: losses === 0 ? null : wins / losses,
  };
};
