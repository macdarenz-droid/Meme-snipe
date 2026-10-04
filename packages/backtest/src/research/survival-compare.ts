// Comparison of a survival-filtered rule with what we have (RES-5, docs/research/survival.md §5): RES-4's
// pre-registered feature rules and S0, on the same check-days and decision points, one exit for all. The survival rule
// is chosen and frozen on the find-days alone, then scored once on the untouched check-days.
import { createRng, dayBlockMeanDiffInterval, dayBlockMeanInterval, holm, type MeanInterval } from '../../../core/src/stats/index.ts';
import { createHash } from 'node:crypto';
import { dayBootstrap, type LabelledDecision, mhRiskDifference, splitDays, tradeMeasures, type TradeMeasures } from './survival-analysis.ts';
import { SURVIVAL_FEATURES, type SurvivalDecision, type SurvivalFeature } from './survival.ts';
import type { FeatureId, Features } from './tracker.ts';

export interface SurvivalCond {
  readonly f: SurvivalFeature;
  readonly dir: 'gt' | 'le';
  readonly t: number;
}

/** A frozen survival rule: one decision age, at most two conditions, and the hash of exactly that content. */
export interface FrozenRule {
  readonly ageMs: number | null;
  readonly conds: readonly SurvivalCond[];
  /** sha256 of the rule's canonical JSON, recorded before any check-day trade is scored. */
  readonly hash: string;
  /** Feature tests run on the find-days to choose it (counted trials). */
  readonly trials: number;
}

/**
 * Chooses the survival rule from find-day decisions only (survival.md §5): every feature at every age is tested on
 * them (median split, matched Mantel–Haenszel difference, day-block bootstrap p), Holm across all of them; the age of
 * the strongest passing test is kept, with at most two passing features at that age, each pointing the way its
 * find-day difference points. Nothing from a check-day is an input.
 */
export const selectSurvivalRule = (find: readonly LabelledDecision[], reps: number, seed: number, max = 2): FrozenRule => {
  const ages = [...new Set(find.map((x) => x.ageMs))].sort((a, b) => a - b);
  const tests = ages.flatMap((ageMs) => SURVIVAL_FEATURES.map((f) => {
    const xs = find.filter((x) => x.ageMs === ageMs);
    const vals = xs.map((x) => x.features[f]).filter((v): v is number => v !== null && Number.isFinite(v)).sort((a, b) => a - b);
    const split = vals.length === 0 ? null : vals.length % 2 === 1 ? vals[vals.length >> 1]! : (vals[(vals.length >> 1) - 1]! + vals[vals.length >> 1]!) / 2;
    const r = split === null ? { est: null, p: null } : dayBootstrap(xs, (ys) => mhRiskDifference(ys, f, split), reps, seed);
    return { f, ageMs, split, est: r.est, p: r.p };
  }));
  const h = holm(tests.map((t) => t.p ?? 1));
  const passing = tests.filter((t, i) => h.rejected[i] && t.split !== null && t.est !== null && t.est !== 0)
    .sort((a, b) => (a.p ?? 1) - (b.p ?? 1) || a.ageMs - b.ageMs || (a.f < b.f ? -1 : 1));
  const ageMs = passing[0]?.ageMs ?? null;
  const conds: SurvivalCond[] = passing.filter((t) => t.ageMs === ageMs).slice(0, max).map((t) => ({ f: t.f, dir: t.est! > 0 ? 'gt' : 'le', t: t.split! }));
  const body = { ageMs, conds };
  return { ...body, hash: createHash('sha256').update(JSON.stringify(body)).digest('hex'), trials: tests.length };
};

/** Splits the labelled decisions by day (find = earliest two thirds) and freezes the rule from the find-days alone. */
export const freezeRule = (labelled: readonly LabelledDecision[], reps: number, seed: number): FrozenRule => {
  const { find } = splitDays(labelled.map((x) => x.day));
  const F = new Set(find);
  return selectSurvivalRule(labelled.filter((x) => F.has(x.day)), reps, seed);
};

/** The frozen rule holds for a decision at its age when every condition does; unknown values fail. */
export const passesSurvival = (rule: Pick<FrozenRule, 'ageMs' | 'conds'>, d: Pick<SurvivalDecision, 'features' | 'ageMs'>): boolean =>
  rule.conds.length > 0 && d.ageMs === rule.ageMs && rule.conds.every((c) => {
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
