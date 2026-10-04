// Comparison of a survival-filtered rule with what we have (RES-5, docs/research/survival.md §5): RES-4's
// pre-registered feature rules and S0, on the same check-days and decision points, one exit for all.
import { createRng, dayBlockMeanDiffInterval, dayBlockMeanInterval, type MeanInterval } from '../../../core/src/stats/index.ts';
import type { FeatureTest } from './survival-analysis.ts';
import { tradeMeasures, type TradeMeasures } from './survival-analysis.ts';
import type { SurvivalDecision, SurvivalFeature } from './survival.ts';
import type { FeatureId, Features } from './tracker.ts';

export interface SurvivalCond {
  readonly f: SurvivalFeature;
  readonly dir: 'gt' | 'le';
  readonly t: number;
}

/**
 * The survival-filtered rule (§5): at most two held-up features, the strongest first (smallest check p), each pointing
 * the way its find-day difference pointed. Empty when nothing held up.
 */
export const survivalRule = (tests: readonly FeatureTest[], max = 2): SurvivalCond[] =>
  tests
    .filter((x) => x.heldUp && x.split !== null && x.find.est !== null)
    .sort((a, b) => (a.check.p ?? 1) - (b.check.p ?? 1) || (a.feature < b.feature ? -1 : 1))
    .filter((x, i, all) => all.findIndex((y) => y.feature === x.feature) === i)
    .slice(0, max)
    .map((x) => ({ f: x.feature, dir: x.find.est! > 0 ? 'gt' : 'le', t: x.split! }));

export const passesSurvival = (conds: readonly SurvivalCond[], d: Pick<SurvivalDecision, 'features'>): boolean =>
  conds.length > 0 && conds.every((c) => {
    const v = d.features[c.f];
    return v !== null && Number.isFinite(v) && (c.dir === 'gt' ? v > c.t : v <= c.t);
  });

export interface FeatureCond {
  readonly f: string;
  readonly dir: 'ge' | 'le';
  readonly t: string;
}

/** RES-4's `features` rule over RES-3's as-of features: every condition must hold; an unknown feature fails it. */
export const passesFeatures = (conds: readonly FeatureCond[], f: Features): boolean =>
  conds.every((c) => {
    const v = f[c.f as FeatureId];
    const t = Number(c.t);
    return v !== null && v !== undefined && Number.isFinite(v) && (c.dir === 'ge' ? v >= t : v <= t);
  });

export interface RuleResult {
  readonly rule: string;
  readonly measures: TradeMeasures;
  readonly meanCi: MeanInterval | null;
  /** Mean minus S0's mean on the same days, paired day-block 95% interval. */
  readonly vsS0: MeanInterval | null;
}

const safe = <T>(f: () => T): T | null => {
  try {
    return f();
  } catch {
    return null;
  }
};

export const compareRules = (
  rules: readonly { readonly rule: string; readonly trades: readonly { readonly day: string; readonly rNet: number }[] }[],
  s0: readonly { readonly day: string; readonly rNet: number }[],
  o: { readonly seed: number; readonly replicates: number },
): RuleResult[] =>
  rules.map((r) => ({
    rule: r.rule,
    measures: tradeMeasures(r.trades),
    meanCi: r.trades.length === 0 ? null : safe(() => dayBlockMeanInterval([...r.trades], 0.95, 'two', { rng: createRng(o.seed), replicates: o.replicates })),
    vsS0: r.trades.length === 0 || s0.length === 0 ? null : safe(() => dayBlockMeanDiffInterval([...r.trades], [...s0], 0.95, 'two', { rng: createRng(o.seed), replicates: o.replicates })),
  }));
