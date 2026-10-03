// Selection and validation for signal research (RES-3, docs/research/signals.md §5–6). Input: labelled practice-day
// observations (features from the feature stage, r_net from the outcome stage). Output: the walk-forward
// out-of-sample result of the selection procedure, the trial registry, and the §6 verdict per universe.
import {
  dayBlockMeanDiffInterval, dayBlockMeanInterval, createRng, deflatedSharpe, holm, type DayReturn, type MeanInterval,
  probabilityOfBacktestOverfitting, sharpeRatio, studentTQuantile, type TrialRecord,
} from '../../../core/src/stats/index.ts';
import { FEATURE_IDS, type FeatureId, type Features } from './tracker.ts';

export interface Obs {
  readonly id: string;
  readonly day: string;
  readonly decisionMs: number;
  readonly features: Features;
  readonly rNet: number;
  readonly severe: boolean;
  readonly blocked: boolean;
}

export const QUANTILES = [0.2, 0.4, 0.6, 0.8] as const;
export interface Cond {
  readonly f: FeatureId;
  readonly dir: 'ge' | 'le';
  readonly q: number;
  readonly t: number;
}
export type Rule = readonly Cond[];

export const GROUPS: Readonly<Record<FeatureId, string>> = {
  f_net15: 'flow', f_net60: 'flow', f_bsr15: 'flow', f_indep60: 'flow', f_size15: 'flow', f_trades15: 'activity',
  f_ret15: 'momentum', f_ret60: 'momentum', f_dd: 'flush', f_vwap: 'reclaim', f_hl: 'higher-low', f_vol60: 'risk',
  f_liq: 'liquidity', f_liqchg60: 'liquidity', f_age: 'age', f_2side60: 'wash', f_top60: 'concentration', f_c2g: 'launch',
  f_devnet: 'insider', f_bundle: 'bundle', f_top10: 'concentration', f_dep24: 'deployer', f_grad24: 'regime', f_sol24: 'regime',
  f_liqmig: 'liquidity', f_turn60: 'activity', f_early_sold: 'insider',
};

export const ruleId = (r: Rule): string =>
  r.length === 0 ? 'base' : r.map((c) => `${c.f}${c.dir === 'ge' ? '>=' : '<='}q${Math.round(c.q * 100)}`).join('&');

/** A null feature never passes (abstain). */
export const passes = (r: Rule, o: Obs): boolean =>
  r.every((c) => {
    const v = o.features[c.f];
    return v !== null && Number.isFinite(v) && (c.dir === 'ge' ? v >= c.t : v <= c.t);
  });

/** Empirical quantile (type 7) of the non-null values, or null when there are none. */
export const quantile = (xs: readonly number[], q: number): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const h = (s.length - 1) * q;
  const lo = Math.floor(h);
  return s[lo]! + (h - lo) * (s[Math.min(lo + 1, s.length - 1)]! - s[lo]!);
};

/** Every single condition, thresholds from the training set. */
export const singleConds = (train: readonly Obs[]): Cond[] => {
  const out: Cond[] = [];
  for (const f of FEATURE_IDS) {
    const vals = train.map((o) => o.features[f]).filter((v): v is number => v !== null && Number.isFinite(v));
    for (const q of QUANTILES) {
      const t = quantile(vals, q);
      if (t === null) continue;
      out.push({ f, dir: 'ge', q, t }, { f, dir: 'le', q, t });
    }
  }
  return out;
};

export interface Score {
  readonly n: number;
  readonly days: number;
  readonly mean: number;
  /** One-sided 95% lower bound: mean − t_{D−1}(0.95)·SE, SE cluster-robust (CR1) by day; −∞ below the minimums. */
  readonly lower: number;
  readonly sharpe: number;
}

export const MIN_TRADES = 30;
export const MIN_DAYS = 5;

/** Deterministic selection score (signals.md §5): the CR1 day-clustered lower bound of the mean. */
export const score = (xs: readonly Obs[]): Score => {
  const n = xs.length;
  const byDay = new Map<string, { s: number; c: number }>();
  let sum = 0;
  for (const o of xs) {
    sum += o.rNet;
    const d = byDay.get(o.day) ?? { s: 0, c: 0 };
    d.s += o.rNet;
    d.c++;
    byDay.set(o.day, d);
  }
  const mean = n > 0 ? sum / n : Number.NaN;
  const D = byDay.size;
  const sharpe = n >= 2 ? sharpeRatio(xs.map((o) => o.rNet)) : Number.NaN;
  if (n < MIN_TRADES || D < MIN_DAYS) return { n, days: D, mean, lower: -Infinity, sharpe };
  let ss = 0;
  for (const d of byDay.values()) ss += ((d.s - mean * d.c) / n) ** 2;
  const se = Math.sqrt((D / (D - 1)) * ss);
  return { n, days: D, mean, lower: mean - studentTQuantile(0.95, D - 1) * se, sharpe };
};

export interface TrialRow {
  readonly trialId: string;
  readonly universe: string;
  readonly barrier: string;
  readonly fold: string;
  readonly rule: string;
  readonly n: number;
  readonly days: number;
  readonly mean: number;
  readonly sharpe: number;
}

export interface Registry {
  readonly rows: TrialRow[];
}

const better = (a: { rule: Rule; s: Score }, b: { rule: Rule; s: Score }): boolean => {
  if (a.s.lower !== b.s.lower) return a.s.lower > b.s.lower;
  if (a.rule.length !== b.rule.length) return a.rule.length < b.rule.length;
  return ruleId(a.rule) < ruleId(b.rule);
};

/** The rule family's pick on a training set: base, the best single condition, then the best second condition given it. */
export const selectRule = (train: readonly Obs[], reg: Registry, tag: { universe: string; barrier: string; fold: string }): { rule: Rule; score: Score } => {
  const log = (rule: Rule, s: Score): void => {
    reg.rows.push({ trialId: `${tag.universe}|${tag.barrier}|${tag.fold}|${ruleId(rule)}`, ...tag, rule: ruleId(rule), n: s.n, days: s.days, mean: s.mean, sharpe: s.sharpe });
  };
  let best = { rule: [] as Rule, s: score(train) };
  log(best.rule, best.s);
  const singles = singleConds(train);
  let bestSingle: { rule: Rule; s: Score } | null = null;
  for (const c of singles) {
    const r: Rule = [c];
    const s = score(train.filter((o) => passes(r, o)));
    log(r, s);
    const cand = { rule: r, s };
    if (bestSingle === null || better(cand, bestSingle)) bestSingle = cand;
  }
  if (bestSingle !== null && better(bestSingle, best)) best = bestSingle;
  if (bestSingle !== null && bestSingle.s.lower > -Infinity) {
    const first = bestSingle.rule[0]!;
    const sub = train.filter((o) => passes(bestSingle!.rule, o));
    for (const c of singles) {
      if (c.f === first.f && c.dir === first.dir) continue;
      const r: Rule = [first, c];
      const s = score(sub.filter((o) => passes([c], o)));
      log(r, s);
      const cand = { rule: r, s };
      if (better(cand, best)) best = cand;
    }
  }
  return { rule: best.rule, score: best.s };
};

/** K contiguous day blocks of equal size; the last takes the remainder. */
export const dayBlocks = (days: readonly string[], k: number): string[][] => {
  const sorted = [...new Set(days)].sort();
  if (sorted.length < k) throw new RangeError(`need at least ${k} practice days, have ${sorted.length}`);
  const size = Math.floor(sorted.length / k);
  return Array.from({ length: k }, (_, i) => sorted.slice(i * size, i === k - 1 ? sorted.length : (i + 1) * size));
};

export interface Fold {
  readonly fold: string;
  readonly testDays: readonly string[];
  readonly rule: Rule;
  readonly trainScore: Score;
  readonly oos: readonly Obs[];
}

/**
 * Expanding walk-forward (signals.md §5): for k = 2..K, choose on blocks 1..k−1 minus the embargo day(s) just before
 * block k (which also purges every training decision whose outcome window could reach block k), test on block k.
 */
export const walkForward = (obs: readonly Obs[], k: number, embargoDays: number, reg: Registry, tag: { universe: string; barrier: string }): Fold[] => {
  const blocks = dayBlocks(obs.map((o) => o.day), k);
  const folds: Fold[] = [];
  for (let i = 1; i < k; i++) {
    const before = blocks.slice(0, i).flat();
    const train = new Set(before.slice(0, Math.max(0, before.length - embargoDays)));
    const test = new Set(blocks[i]!);
    const fold = `wf${i + 1}`;
    const pick = selectRule(obs.filter((o) => train.has(o.day)), reg, { ...tag, fold });
    folds.push({ fold, testDays: blocks[i]!, rule: pick.rule, trainScore: pick.score, oos: obs.filter((o) => test.has(o.day) && passes(pick.rule, o)) });
  }
  return folds;
};

const dayReturns = (xs: readonly Obs[]): DayReturn[] => xs.map((o) => ({ day: o.day, rNet: o.rNet }));

const safe = <T>(f: () => T): T | null => {
  try {
    return f();
  } catch {
    return null;
  }
};

export interface Verdict {
  readonly universe: string;
  readonly barrier: string;
  /** The rule the procedure picks on all practice days (the candidate configuration). */
  readonly finalRule: string;
  readonly folds: readonly { readonly fold: string; readonly rule: string; readonly group: string; readonly oosN: number; readonly oosMean: number | null }[];
  readonly oos: MeanInterval | null;
  readonly oosTwoSided: MeanInterval | null;
  readonly vsBase: MeanInterval | null;
  readonly dsr: number | null;
  readonly pbo: number | null;
  readonly oosTrades: number;
  readonly oosDays: number;
  /** Pooled out-of-sample r_net, in fold order (for the deflated Sharpe ratio against the final registry). */
  readonly oosReturns: readonly number[];
  readonly top1Share: number | null;
  readonly maxDayShare: number | null;
  readonly severeRate: number | null;
  readonly blockedRate: number | null;
  readonly stableFolds: number;
  readonly checks: Readonly<Record<string, boolean>>;
  readonly pass: boolean;
}

/** P&L concentration: share of the total from the top 1% of trades and from the best day (null unless the total is > 0). */
export const concentration = (xs: readonly Obs[]): { top1: number | null; maxDay: number | null } => {
  const total = xs.reduce((a, o) => a + o.rNet, 0);
  if (!(total > 0)) return { top1: null, maxDay: null };
  const sorted = xs.map((o) => o.rNet).sort((a, b) => b - a);
  const k = Math.max(1, Math.ceil(sorted.length * 0.01));
  const top = sorted.slice(0, k).reduce((a, b) => a + b, 0);
  const byDay = new Map<string, number>();
  for (const o of xs) byDay.set(o.day, (byDay.get(o.day) ?? 0) + o.rNet);
  return { top1: top / total, maxDay: Math.max(...byDay.values()) / total };
};

/** Day-by-trial matrix of daily P&L (sum of r_net; no trade is 0) for PBO. */
const dailyMatrix = (obs: readonly Obs[], rules: readonly Rule[]): number[][] => {
  const days = [...new Set(obs.map((o) => o.day))].sort();
  const idx = new Map(days.map((d, i) => [d, i]));
  return rules.map((r) => {
    const col = Array<number>(days.length).fill(0);
    for (const o of obs) if (passes(r, o)) col[idx.get(o.day)!]! += o.rNet;
    return col;
  });
};

export interface EvaluateOptions {
  readonly k: number;
  readonly embargoDays: number;
  readonly seed: number;
  readonly replicates: number;
}

/** The whole §5–6 procedure for one universe and barrier. Trials are appended to `reg`. */
export const evaluate = (obs: readonly Obs[], tag: { universe: string; barrier: string }, reg: Registry, o: EvaluateOptions): Verdict => {
  const folds = walkForward(obs, o.k, o.embargoDays, reg, tag);
  const final = selectRule(obs, reg, { ...tag, fold: 'all' });
  const oos = folds.flatMap((f) => f.oos);
  const testDays = new Set(folds.flatMap((f) => f.testDays));
  const baseOos = obs.filter((x) => testDays.has(x.day));
  const rng = () => createRng(o.seed);
  const lower = oos.length > 0 ? safe(() => dayBlockMeanInterval(dayReturns(oos), 0.95, 'lower', { rng: rng(), replicates: o.replicates })) : null;
  const two = oos.length > 0 ? safe(() => dayBlockMeanInterval(dayReturns(oos), 0.95, 'two', { rng: rng(), replicates: o.replicates })) : null;
  const vsBase = oos.length > 0 && baseOos.length > 0 ? safe(() => dayBlockMeanDiffInterval(dayReturns(oos), dayReturns(baseOos), 0.95, 'lower', { rng: rng(), replicates: o.replicates })) : null;
  const trials: TrialRecord[] = reg.rows.filter((r) => Number.isFinite(r.sharpe) && r.n >= 2).map((r) => ({ trialId: r.trialId, sharpe: r.sharpe, nTrades: r.n }));
  const dsr = oos.length >= 3 && trials.length > 0 ? safe(() => deflatedSharpe(oos.map((x) => x.rNet), trials).dsr) : null;
  const famRules: Rule[] = [[], ...singleConds(obs).map((c) => [c] as Rule)];
  const days = new Set(obs.map((x) => x.day)).size;
  const pbo = days >= 4 ? safe(() => probabilityOfBacktestOverfitting(dailyMatrix(obs, famRules), { blocks: Math.min(10, days - (days % 2)), metric: 'mean' }).pbo) : null;
  const conc = concentration(oos);
  const severeRate = oos.length > 0 ? oos.filter((x) => x.severe).length / oos.length : null;
  const blockedRate = oos.length > 0 ? oos.filter((x) => x.blocked).length / oos.length : null;
  const finalGroup = final.rule.length === 0 ? 'base' : GROUPS[final.rule[0]!.f];
  const groupOf = (r: Rule) => (r.length === 0 ? 'base' : GROUPS[r[0]!.f]);
  const stableFolds = folds.filter((f) => groupOf(f.rule) === finalGroup).length;
  const oosDays = new Set(oos.map((x) => x.day)).size;
  const checks = {
    meanAboveZero: lower !== null && lower.lower > 0,
    beatsBase: vsBase !== null && vsBase.lower > 0,
    dsr: dsr !== null && dsr >= 0.95,
    pbo: pbo !== null && pbo <= 0.25,
    sampleSize: oos.length >= 100 && oosDays >= 10,
    concentration: conc.top1 !== null && conc.top1 <= 0.5 && conc.maxDay !== null && conc.maxDay <= 0.25,
    severe: severeRate !== null && severeRate <= 0.1,
    blocked: blockedRate !== null && blockedRate <= 0.05,
    stable: final.rule.length > 0 && stableFolds >= Math.min(3, folds.length),
  };
  return {
    universe: tag.universe, barrier: tag.barrier, finalRule: ruleId(final.rule),
    folds: folds.map((f) => ({ fold: f.fold, rule: ruleId(f.rule), group: groupOf(f.rule), oosN: f.oos.length, oosMean: f.oos.length > 0 ? f.oos.reduce((a, x) => a + x.rNet, 0) / f.oos.length : null })),
    oos: lower, oosTwoSided: two, vsBase, dsr, pbo, oosTrades: oos.length, oosDays, oosReturns: oos.map((x) => x.rNet),
    top1Share: conc.top1, maxDayShare: conc.maxDay, severeRate, blockedRate, stableFolds, checks,
    pass: Object.values(checks).every(Boolean),
  };
};

export interface FeatureView {
  readonly feature: FeatureId;
  readonly known: number;
  readonly spearman: number | null;
  /** Mean r_net per quintile of the feature (quintile edges from these observations). */
  readonly quintiles: readonly (number | null)[];
  /** Top minus bottom quintile, paired by day, two-sided 95%. */
  readonly topMinusBottom: MeanInterval | null;
  readonly holmPass: boolean;
}

const ranks = (xs: readonly number[]): number[] => {
  const idx = xs.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const r = Array<number>(xs.length);
  for (let i = 0; i < idx.length;) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1]!.v === idx[i]!.v) j++;
    for (let k = i; k <= j; k++) r[idx[k]!.i] = (i + j) / 2 + 1;
    i = j + 1;
  }
  return r;
};

export const spearman = (x: readonly number[], y: readonly number[]): number | null => {
  if (x.length < 3) return null;
  const rx = ranks(x);
  const ry = ranks(y);
  const mx = rx.reduce((a, b) => a + b, 0) / rx.length;
  const my = ry.reduce((a, b) => a + b, 0) / ry.length;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < rx.length; i++) {
    sxy += (rx[i]! - mx) * (ry[i]! - my);
    sxx += (rx[i]! - mx) ** 2;
    syy += (ry[i]! - my) ** 2;
  }
  return sxx === 0 || syy === 0 ? null : sxy / Math.sqrt(sxx * syy);
};

/** Descriptive per-feature view (signals.md §5), Holm-adjusted across the features on the top-minus-bottom test. */
export const univariate = (obs: readonly Obs[], o: { seed: number; replicates: number }): FeatureView[] => {
  const views = FEATURE_IDS.map((f) => {
    const known = obs.filter((x) => x.features[f] !== null && Number.isFinite(x.features[f]!));
    const vals = known.map((x) => x.features[f]!);
    const edges = [0.2, 0.4, 0.6, 0.8].map((q) => quantile(vals, q));
    const bucket = (v: number): number => edges.filter((e) => e !== null && v > e).length;
    const groups: Obs[][] = [[], [], [], [], []];
    for (const x of known) groups[bucket(x.features[f]!)]!.push(x);
    const tmb = groups[4]!.length > 0 && groups[0]!.length > 0
      ? safe(() => dayBlockMeanDiffInterval(dayReturns(groups[4]!), dayReturns(groups[0]!), 0.95, 'two', { rng: createRng(o.seed), replicates: o.replicates }))
      : null;
    return {
      feature: f, known: known.length, spearman: spearman(vals, known.map((x) => x.rNet)),
      quintiles: groups.map((g) => (g.length > 0 ? g.reduce((a, x) => a + x.rNet, 0) / g.length : null)),
      topMinusBottom: tmb, holmPass: false,
    };
  });
  const h = holm(views.map((v) => v.topMinusBottom?.pTwoSided ?? 1));
  return views.map((v, i) => ({ ...v, holmPass: h.rejected[i]! }));
};

/** Recomputes the DSR check against the complete registry (every universe, barrier and fold), as §5 requires. */
export const withRegistry = (v: Verdict, reg: Registry): Verdict => {
  const trials: TrialRecord[] = reg.rows.filter((r) => Number.isFinite(r.sharpe) && r.n >= 2).map((r) => ({ trialId: r.trialId, sharpe: r.sharpe, nTrades: r.n }));
  const dsr = v.oosReturns.length >= 3 && trials.length > 0 ? safe(() => deflatedSharpe(v.oosReturns, trials).dsr) : null;
  const checks = { ...v.checks, dsr: dsr !== null && dsr >= 0.95 };
  return { ...v, dsr, checks, pass: Object.values(checks).every(Boolean) };
};
