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
  readonly features: Readonly<Record<SurvivalFeature, number | null>>;
  readonly survived: boolean;
}

/** Earliest ceil(2/3) of the days find features; the rest check them (survival.md §4). */
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

/** Day-block bootstrap of a statistic over decisions: resample whole days, 2.5/97.5 percentiles and a two-sided p. */
export const dayBootstrap = (xs: readonly LabelledDecision[], stat: (ys: readonly LabelledDecision[]) => number | null, reps: number, seed: number) => {
  const byDay = new Map<string, LabelledDecision[]>();
  for (const x of xs) byDay.set(x.day, [...(byDay.get(x.day) ?? []), x]);
  const days = [...byDay.keys()].sort();
  const est = stat(xs);
  if (est === null || days.length < 2) return { est, lower: null, upper: null, p: null };
  const rng = createRng(seed);
  const vals: number[] = [];
  for (let r = 0; r < reps; r++) {
    const ys: LabelledDecision[] = [];
    for (let i = 0; i < days.length; i++) ys.push(...byDay.get(days[nextInt(rng, days.length)]!)!);
    const v = stat(ys);
    if (v !== null) vals.push(v);
  }
  if (vals.length < reps * 0.9) return { est, lower: null, upper: null, p: null };
  vals.sort((a, b) => a - b);
  const q = (p: number) => vals[Math.min(vals.length - 1, Math.max(0, Math.floor(p * vals.length)))]!;
  const le = vals.filter((v) => v <= 0).length / vals.length;
  const ge = vals.filter((v) => v >= 0).length / vals.length;
  return { est, lower: q(0.025), upper: q(0.975), p: Math.min(1, 2 * Math.min(le, ge)) };
};

export interface FeatureTest {
  readonly feature: SurvivalFeature;
  readonly ageMs: number;
  /** Median on the find-days, fixed before the check-days are read. */
  readonly split: number | null;
  readonly base: ReturnType<typeof wilson>;
  readonly high: ReturnType<typeof wilson>;
  readonly find: ReturnType<typeof dayBootstrap>;
  readonly check: ReturnType<typeof dayBootstrap>;
  readonly holmPass: boolean;
  /** Same sign on find- and check-days, and Holm passes on the check-days. */
  readonly heldUp: boolean;
}

/** Every feature at every decision age (survival.md §3): 15 × 3 = 45 counted tests. */
export const featureTests = (xs: readonly LabelledDecision[], reps: number, seed: number): FeatureTest[] => {
  const { find, check } = splitDays(xs.map((x) => x.day));
  const F = new Set(find);
  const C = new Set(check);
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
      find: split === null ? { est: null, lower: null, upper: null, p: null } : dayBootstrap(fd, (ys) => mhRiskDifference(ys, feature, split), reps, seed),
      check: split === null ? { est: null, lower: null, upper: null, p: null } : dayBootstrap(cd, (ys) => mhRiskDifference(ys, feature, split), reps, seed + 1),
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
