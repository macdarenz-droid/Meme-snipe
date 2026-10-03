// Promotion gates G0–G5 and demotion (ARCHITECTURE.md §14, quant.md §8) as pure functions.
// Each takes measured inputs, returns pass or fail with the reason for every failed check, and never reads a clock,
// a file or the network. Thresholds default to the documented values; overrides may only tighten them
// (loosening needs the owner and a change to the defaults here).

import { dayBlockMeanDiffInterval, dayBlockMeanInterval, type DayReturn } from './bootstrap.ts';
import { describeSummary, g2Rule, g2Sensitivity, MIN_DAYS, sameSummary, summarizeWalkForward, type ClusteredReturn, type G2PowerResult, type G2SensitivityVariant } from './g2rule.ts';
import { burnHoldout, holdoutReady, openHoldout, type HoldoutRegistry } from './holdout.ts';
import { holm } from './holm.ts';
import { clopperPearsonInterval, clopperPearsonUpper, ratesConsistent } from './binomial.ts';
import { mean, median, sd, variance } from './descriptive.ts';
import { bettingEProcess, MAX_RETURN_CAP, reverseEProcess } from './eprocess.ts';
import { probabilityOfBacktestOverfitting } from './pbo.ts';
import { nPower } from './power.ts';
import { meanPredictiveInterval, type SampleSummary } from './predictive.ts';
import type { TripleBarrierLabel } from './labeller.ts';
import type { Rng } from './rng.ts';
import { studentTQuantile } from './special.ts';
import { deflatedSharpe, type TrialRecord } from './sharpe.ts';

export type GateName = 'G0' | 'G1' | 'G2' | 'G3' | 'G4' | 'G5';
/** 'not-proven': too little data to decide (collect more, never lower n). */
export type GateStatus = 'pass' | 'fail' | 'not-proven';

export interface Check {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}

export interface GateResult {
  readonly gate: GateName;
  readonly passed: boolean;
  readonly status: GateStatus;
  /** Details of every failed check; empty when the gate passes. */
  readonly reasons: readonly string[];
  readonly checks: readonly Check[];
  readonly metrics: Readonly<Record<string, number | null>>;
  /** Observations that are reported but do not gate (e.g. a predictive-interval miss that needs a written review). */
  readonly notes: readonly string[];
}

export interface DemotionResult {
  readonly demote: boolean;
  readonly reasons: readonly string[];
  readonly checks: readonly Check[];
  readonly metrics: Readonly<Record<string, number | null>>;
}

/** A labelled out-of-sample trade, in decision-time order. */
export interface TradeOutcome extends DayReturn {
  readonly ySevere: boolean;
  readonly blocked: boolean;
}

/** A holdout trade with its creator and funder clusters as known at decision time (G2 cluster sensitivity). */
export interface HoldoutTrade extends TradeOutcome, ClusteredReturn {}

// ---- thresholds -------------------------------------------------------------------------------------------------

/** 'min': a floor (tightening raises it). 'max': a ceiling (tightening lowers it). */
type Direction = 'min' | 'max';

const tighten = <T extends Record<string, number>>(
  gate: string,
  defaults: T,
  directions: { readonly [K in keyof T]: Direction },
  overrides: Partial<T> | undefined,
): T => {
  const out = { ...defaults };
  for (const key of Object.keys(overrides ?? {}) as (keyof T & string)[]) {
    const v = overrides![key];
    if (v === undefined) continue;
    if (!Object.hasOwn(defaults, key)) throw new RangeError(`${gate}: unknown threshold "${key}"`);
    if (!Number.isFinite(v)) throw new RangeError(`${gate}: threshold "${key}" must be finite`);
    const d = defaults[key] as number;
    const looser = directions[key] === 'min' ? v < d : v > d;
    if (looser) throw new RangeError(`${gate}: threshold "${key}" can only be tightened (default ${d}, got ${v}); loosening is the owner's decision`);
    out[key] = v as T[keyof T & string];
  }
  return out;
};

export const G0_DEFAULTS = { minSecondSourceCoverage: 0.95, minReplays: 10 };
const G0_DIR = { minSecondSourceCoverage: 'min', minReplays: 'min' } as const;

export const G1_DEFAULTS = {
  dsrMin: 0.95, pboMax: 0.25, top1PctShareMax: 0.5, dayShareMax: 0.25, severeRateMax: 0.1, severeUpperMax: 0.15,
  blockedUpperMax: 0.05, calibrationSlopeMin: 0.8, calibrationSlopeMax: 1.25, lowerBoundMin: 0,
};
const G1_DIR = {
  dsrMin: 'min', pboMax: 'max', top1PctShareMax: 'max', dayShareMax: 'max', severeRateMax: 'max', severeUpperMax: 'max',
  blockedUpperMax: 'max', calibrationSlopeMin: 'min', calibrationSlopeMax: 'max', lowerBoundMin: 'min',
} as const;

export const G2_DEFAULTS = { minTradesFloor: 300, familyAlpha: 0.05, minControlSeeds: 200 };
const G2_DIR = { minTradesFloor: 'min', familyAlpha: 'max', minControlSeeds: 'min' } as const;

export const G3_DEFAULTS = {
  minHours: 48, fillDiffMedianMax: 0.005, minPaperTradesForMean: 30, liveOnlyVetoRateMax: 0.1,
  minVetoedForGap: 10, minKeptForGap: 10, vetoBiasMax: 0.05, retainedLowerMin: 0,
};
// Fewer paper trades needed before the mean is checked means the check applies more often: stricter. More scored
// vetoed or kept trades before the gap is measured means the worst-case gap is used more often: stricter.
const G3_DIR = {
  minHours: 'min', fillDiffMedianMax: 'max', minPaperTradesForMean: 'max', liveOnlyVetoRateMax: 'max',
  minVetoedForGap: 'min', minKeptForGap: 'min', vetoBiasMax: 'max', retainedLowerMin: 'min',
} as const;

export const G4_DEFAULTS = { minTrades: 30, firstAttemptFailRateMax: 0.1, liveMinusPaperMedianMin: -0.01 };
const G4_DIR = { minTrades: 'min', firstAttemptFailRateMax: 'max', liveMinusPaperMedianMin: 'min' } as const;

export const G5_DEFAULTS = { minTrades: 100, eWealthMin: 10, impactMax: 0.005, quietDays: 7 };
const G5_DIR = { minTrades: 'min', eWealthMin: 'min', impactMax: 'max', quietDays: 'min' } as const;

export const DEMOTION_DEFAULTS = { reverseWealth: 20, miscoverageFactor: 2, blockedExitsMax: 2, blockedWindowDays: 30, returnCapMax: MAX_RETURN_CAP };
// Demotion triggers are tightened by firing sooner: lower wealth, lower factor, fewer blocked exits, a longer window.
const DEMOTION_DIR = { reverseWealth: 'max', miscoverageFactor: 'max', blockedExitsMax: 'max', blockedWindowDays: 'min', returnCapMax: 'max' } as const;

/** Net returns can fall slightly below −100% (failed-attempt fees on a blocked exit); the e-process needs a fixed floor. */
export const RETURN_FLOOR = -1.1;

const MS_PER_DAY = 86_400_000;
const COVERAGE_WINDOW = 100;

// ---- helpers ----------------------------------------------------------------------------------------------------

const fmt = (x: number | null | undefined): string => (x === null || x === undefined ? 'n/a' : Number.isFinite(x) ? String(+x.toFixed(6)) : String(x));

class Checks {
  readonly list: Check[] = [];
  add(name: string, passed: boolean, detail: string): boolean {
    this.list.push({ name, passed, detail });
    return passed;
  }
  get failed(): string[] {
    return this.list.filter((c) => !c.passed).map((c) => `${c.name}: ${c.detail}`);
  }
  has(name: string): boolean {
    return this.list.some((c) => c.name === name && !c.passed);
  }
}

const result = (gate: GateName, checks: Checks, status: GateStatus, metrics: Record<string, number | null>): GateResult => ({
  gate, passed: status === 'pass', status, reasons: checks.failed, checks: checks.list, metrics, notes: [],
});

const statusFrom = (checks: Checks): GateStatus => (checks.failed.length === 0 ? 'pass' : 'fail');

/** 'not-proven' when the sample check failed and every other failure is one a larger sample could clear. */
const statusWithSample = (checks: Checks, sample: string, sampleDependent: readonly string[] = []): GateStatus => {
  const failed = checks.list.filter((x) => !x.passed).map((x) => x.name);
  if (failed.includes(sample) && failed.every((f) => f === sample || sampleDependent.includes(f))) return 'not-proven';
  return statusFrom(checks);
};

/** Share of total P&L from the top 1% of trades (by net return), and from the best day. Null when P&L ≤ 0. */
const concentration = (trades: readonly DayReturn[]): { top1Share: number | null; dayShare: number | null } => {
  const total = trades.reduce((s, t) => s + t.rNet, 0);
  if (!(total > 0)) return { top1Share: null, dayShare: null };
  const sorted = trades.map((t) => t.rNet).sort((a, b) => b - a);
  const k = Math.ceil(trades.length * 0.01);
  const top = sorted.slice(0, k).reduce((s, x) => s + x, 0);
  const byDay = new Map<string, number>();
  for (const t of trades) byDay.set(t.day, (byDay.get(t.day) ?? 0) + t.rNet);
  return { top1Share: top / total, dayShare: Math.max(...byDay.values()) / total };
};

const minReturn = (xs: readonly number[]): number => xs.reduce((m, x) => Math.min(m, x), Infinity);

// ---- G0 ---------------------------------------------------------------------------------------------------------

export interface G0Input {
  readonly survivorshipFree: boolean;
  /** Share of migrations also seen by a second source (coverage audit). */
  readonly secondSourceCoverage: number;
  /** Every migration seen but not decoded is counted and reported (none dropped silently). */
  readonly undecodedMigrationsReported: boolean;
  readonly leakTestPassed: boolean;
  readonly shiftTestPassed: boolean;
  /** Decision-log hash of each replay of the same data. */
  readonly replayLogHashes: readonly string[];
  readonly parityTestPassed: boolean;
  /** Labels were scored in the separate stage, which the engine cannot read. */
  readonly labelsScoredSeparately: boolean;
  /** Unobserved windows are censored, never scored 0. */
  readonly labelCoverageAuditPassed: boolean;
}

/** G0 Data and engine validity (always on). */
export const gateG0 = (input: G0Input, overrides?: Partial<typeof G0_DEFAULTS>): GateResult => {
  const th = tighten('G0', G0_DEFAULTS, G0_DIR, overrides);
  const c = new Checks();
  c.add('survivorship', input.survivorshipFree, input.survivorshipFree ? 'dataset is survivorship-free' : 'dataset is not survivorship-free');
  c.add('coverage', input.secondSourceCoverage >= th.minSecondSourceCoverage,
    `second-source coverage ${fmt(input.secondSourceCoverage)} (need >= ${th.minSecondSourceCoverage})`);
  c.add('undecoded', input.undecodedMigrationsReported,
    input.undecodedMigrationsReported ? 'undecoded migrations counted and reported' : 'migrations seen but not decoded are not all counted and reported');
  c.add('leak test', input.leakTestPassed, input.leakTestPassed ? 'passed' : 'failed');
  c.add('shift test', input.shiftTestPassed, input.shiftTestPassed ? '+1-slot shift test passed' : '+1-slot shift test failed');
  const hashes = new Set(input.replayLogHashes);
  c.add('replays', input.replayLogHashes.length >= th.minReplays && hashes.size === 1,
    `${input.replayLogHashes.length} replays, ${hashes.size} distinct decision logs (need >= ${th.minReplays} replays, 1 distinct log)`);
  c.add('parity', input.parityTestPassed, input.parityTestPassed ? 'live/backtest parity passed' : 'live/backtest parity failed');
  c.add('label stage', input.labelsScoredSeparately, input.labelsScoredSeparately ? 'labels scored outside the engine' : 'labels not scored in the separate stage');
  c.add('label coverage', input.labelCoverageAuditPassed, input.labelCoverageAuditPassed ? 'passed' : 'unobserved windows not marked censored');
  return result('G0', c, statusFrom(c), { secondSourceCoverage: input.secondSourceCoverage, replays: input.replayLogHashes.length });
};

// ---- G1 ---------------------------------------------------------------------------------------------------------

export interface G1Input {
  /** Must be 'conservative' (ARCHITECTURE.md §14). */
  readonly scenario: string;
  readonly rulesRegisteredBeforeHoldout: boolean;
  /** Walk-forward out-of-sample trades of the selected version, in decision-time order. */
  readonly trades: readonly TradeOutcome[];
  /** Random control S0 on the same days. */
  readonly control: readonly DayReturn[];
  readonly selectedTrialId: string;
  /** Every trial ever evaluated (experiment registry). */
  readonly registry: readonly TrialRecord[];
  /**
   * Per-trial returns per time row (e.g. per day) for PBO, keyed by trialId. Must hold exactly the registry's trials
   * (a subset would lower PBO), every one with the same rows.
   */
  readonly pboMatrix: Readonly<Record<string, readonly number[]>>;
  readonly pboBlocks?: number;
  readonly modelUsed: boolean;
  readonly calibrationSlope: number | null;
  readonly rng: Rng;
  readonly replicates?: number;
}

/** G1 Walk-forward (research). */
export const gateG1 = (input: G1Input, overrides?: Partial<typeof G1_DEFAULTS>): GateResult => {
  const th = tighten('G1', G1_DEFAULTS, G1_DIR, overrides);
  const c = new Checks();
  const metrics: Record<string, number | null> = { trades: input.trades.length };
  c.add('scenario', input.scenario === 'conservative', `scenario "${input.scenario}" (need "conservative")`);
  c.add('pre-registration', input.rulesRegisteredBeforeHoldout,
    input.rulesRegisteredBeforeHoldout ? 'rules registered before the holdout' : 'rules not registered before the holdout was opened');
  const returns = input.trades.map((t) => t.rNet);
  const days = new Set(input.trades.map((t) => t.day)).size;
  if (!c.add('sample', input.trades.length >= 3 && days >= MIN_DAYS, `${input.trades.length} trades on ${days} days (need >= ${MIN_DAYS} days)`)) {
    return result('G1', c, statusWithSample(c, 'sample'), metrics);
  }
  const opts = { rng: input.rng, ...(input.replicates === undefined ? {} : { replicates: input.replicates }) };

  const ci = dayBlockMeanInterval(input.trades, 0.95, 'lower', opts);
  metrics.mean = ci.mean;
  metrics.lowerBound95 = ci.lower;
  c.add('mean', ci.lower > th.lowerBoundMin, `one-sided 95% lower bound ${fmt(ci.lower)} (need > ${th.lowerBoundMin})`);

  if (!input.registry.some((t) => t.trialId === input.selectedTrialId)) {
    c.add('registry', false, `selected trial "${input.selectedTrialId}" is not in the experiment registry`);
  } else {
    try {
      const d = deflatedSharpe(returns, input.registry);
      metrics.dsr = d.dsr;
      metrics.trials = d.trials;
      c.add('DSR', d.dsr >= th.dsrMin, `deflated Sharpe ${fmt(d.dsr)} over ${d.trials} trials (need >= ${th.dsrMin})`);
    } catch (e) {
      c.add('DSR', false, (e as Error).message);
    }
  }
  const ids = input.registry.map((t) => t.trialId);
  const keys = Object.keys(input.pboMatrix);
  const missing = ids.filter((id) => !Object.hasOwn(input.pboMatrix, id));
  const extra = keys.filter((k) => !ids.includes(k));
  if (missing.length > 0 || extra.length > 0) {
    c.add('PBO', false, `PBO matrix must hold exactly the registry's ${ids.length} trials (missing ${missing.length}: ${missing.slice(0, 5).join(', ')}; not in registry ${extra.length}: ${extra.slice(0, 5).join(', ')})`);
  } else try {
    const p = probabilityOfBacktestOverfitting(ids.map((id) => input.pboMatrix[id]!), input.pboBlocks === undefined ? {} : { blocks: input.pboBlocks });
    metrics.pbo = p.pbo;
    c.add('PBO', p.pbo <= th.pboMax, `PBO ${fmt(p.pbo)} over ${p.combinations} splits (need <= ${th.pboMax})`);
  } catch (e) {
    c.add('PBO', false, (e as Error).message);
  }

  const conc = concentration(input.trades);
  metrics.top1PctShare = conc.top1Share;
  metrics.maxDayShare = conc.dayShare;
  c.add('top 1%', conc.top1Share !== null && conc.top1Share <= th.top1PctShareMax,
    conc.top1Share === null ? 'total P&L is not positive' : `top 1% of trades hold ${fmt(conc.top1Share)} of P&L (need <= ${th.top1PctShareMax})`);
  c.add('best day', conc.dayShare !== null && conc.dayShare <= th.dayShareMax,
    conc.dayShare === null ? 'total P&L is not positive' : `best day holds ${fmt(conc.dayShare)} of P&L (need <= ${th.dayShareMax})`);

  const n = input.trades.length;
  const severe = input.trades.filter((t) => t.ySevere).length;
  const severeUpper = clopperPearsonUpper(severe, n);
  metrics.severeRate = severe / n;
  metrics.severeUpper95 = severeUpper;
  c.add('severe', severe / n <= th.severeRateMax && severeUpper <= th.severeUpperMax,
    `severe ${severe}/${n} = ${fmt(severe / n)}, upper bound ${fmt(severeUpper)} (need <= ${th.severeRateMax}, upper <= ${th.severeUpperMax})`);
  const blocked = input.trades.filter((t) => t.blocked).length;
  const blockedUpper = clopperPearsonUpper(blocked, n);
  metrics.blockedUpper95 = blockedUpper;
  c.add('blocked exits', blockedUpper <= th.blockedUpperMax,
    `blocked ${blocked}/${n}, upper bound ${fmt(blockedUpper)} (need <= ${th.blockedUpperMax})`);

  if (input.modelUsed) {
    const s = input.calibrationSlope;
    c.add('calibration', s !== null && s >= th.calibrationSlopeMin && s <= th.calibrationSlopeMax,
      `calibration slope ${fmt(s)} (need ${th.calibrationSlopeMin}..${th.calibrationSlopeMax})`);
  }

  if (input.control.length === 0) {
    c.add('S0', false, 'no random-control trades');
  } else {
    try {
      const diff = dayBlockMeanDiffInterval(input.trades, input.control, 0.95, 'lower', opts);
      metrics.diffVsS0LowerBound95 = diff.lower;
      c.add('S0', diff.lower > 0, `mean minus S0 one-sided 95% lower bound ${fmt(diff.lower)} (need > 0)`);
    } catch (e) {
      c.add('S0', false, (e as Error).message);
    }
  }
  return result('G1', c, statusFrom(c), metrics);
};

// ---- G2 ---------------------------------------------------------------------------------------------------------

export interface G2Universe {
  readonly universe: string;
  /** The single pre-registered configuration; must match the holdout registry entry. */
  readonly configId: string;
  readonly holdoutId: string;
  /** Hash of the sealed ledger file the trades below were read from (the caller hashes the file it scores). */
  readonly ledgerHash: string;
  /**
   * Holdout trades from the sealed ledger, in decision-time order. Outcomes are read only after the size check passes;
   * the cluster labels are checked before (they are decision-time facts, not outcomes).
   */
  readonly trades: readonly HoldoutTrade[];
  /** The random control S0 on the same eligible candidates and days, one run per seed. */
  readonly controlRuns: readonly (readonly DayReturn[])[];
  /** Walk-forward trades of the same configuration: σ̂ for the closed-form check and the reported predictive interval. */
  readonly walkForward: readonly DayReturn[];
  /** n_power from `simulateG2Power` on the walk-forward data with the registry's family size. */
  readonly power: G2PowerResult;
}

export interface G2Input {
  /** Must be 'conservative' (ARCHITECTURE.md §14). */
  readonly scenario: string;
  readonly registry: HoldoutRegistry;
  readonly universes: readonly G2Universe[];
  /** The injected clock's time, recorded as the seal's opening time. */
  readonly nowMs: number;
  readonly rng: Rng;
  readonly replicates?: number;
}

export interface G2UniverseResult {
  readonly universe: string;
  readonly status: GateStatus;
  readonly requiredTrades: number;
  /** Entries from the registry's sealed counts. */
  readonly entries: number;
  /** Holm-adjusted level the universe was tested at; null when it did not enter. */
  readonly level: number | null;
  readonly p: number | null;
  readonly mean: number | null;
  readonly lower: number | null;
  readonly diffVsS0: number | null;
  readonly diffVsS0Lower: number | null;
  /**
   * The mean's CI under each resampling unit at the Holm level (days-1 is the primary rule). The other variants are
   * computed only when the primary p is below the family α; above it no level can pass the universe.
   */
  readonly sensitivity: readonly G2SensitivityRow[];
}

export interface G2SensitivityRow {
  readonly variant: G2SensitivityVariant;
  readonly lower: number | null;
  readonly upper: number | null;
  readonly diffVsS0Lower: number | null;
  readonly p: number;
}

export interface G2Result extends GateResult {
  readonly universes: readonly G2UniverseResult[];
  /** The registry after this run (opened and burned holdouts). Store it whatever the result. */
  readonly registry: HoldoutRegistry;
}

/**
 * G2 Holdout (proof, owner rule 6), ARCHITECTURE.md §14. Per universe at its Holm-adjusted level: n ≥ max(300, n_power)
 * (n_power simulated; the closed form is a lower-bound check), the day-block CI of mean net return above 0 and the paired
 * CI against S0 above 0. Size comes from the sealed counts; a short universe stays sealed and is "not proven". Every
 * entering seal is verified first (hash, configuration, entry count) and only then opened; any mismatch burns that
 * holdout and fails the gate without opening the others. A burned holdout fails on integrity. Passes when at least one
 * universe passes; the predictive interval is a note, not a check.
 */
export const gateG2 = (input: G2Input, overrides?: Partial<typeof G2_DEFAULTS>): G2Result => {
  const th = tighten('G2', G2_DEFAULTS, G2_DIR, overrides);
  const c = new Checks();
  const notes: string[] = [];
  let registry = input.registry;
  const failWith = (): G2Result => ({ ...result('G2', c, 'fail', {}), universes: [], registry });
  const level0 = th.familyAlpha / registry.familySize;

  // Integrity that needs no outcome and changes nothing.
  c.add('scenario', input.scenario === 'conservative', `scenario "${input.scenario}" (need "conservative")`);
  c.add('universes', input.universes.length > 0 && input.universes.length <= registry.familySize,
    `${input.universes.length} universes (need 1..${registry.familySize}, the family size fixed in the registry)`);
  const seen = new Set<string>();
  for (const u of input.universes) {
    const tag = `holdout ${u.universe}`;
    if (seen.has(u.universe)) c.add(tag, false, `universe ${u.universe} appears twice: one configuration per universe`);
    seen.add(u.universe);
    const e = registry.entries.find((x) => x.holdoutId === u.holdoutId);
    if (!e) c.add(tag, false, `holdout ${u.holdoutId} is not registered`);
    else if (e.burned) c.add(tag, false, `holdout ${u.holdoutId} is burned (${e.burnReason}): integrity`);
    else if (e.universe !== u.universe) c.add(tag, false, `holdout ${u.holdoutId} belongs to ${e.universe}`);
    else if (e.seal !== 'sealed') c.add(tag, false, `holdout ${u.holdoutId} is ${e.seal}, not sealed`);
    c.add(`S0 ${u.universe}`, u.controlRuns.length >= th.minControlSeeds, `${u.controlRuns.length} S0 seeds (need >= ${th.minControlSeeds})`);
    c.add(`n_power ${u.universe}`, Math.abs(u.power.level - level0) < 1e-12,
      `n_power was simulated at level ${fmt(u.power.level)}, the registry's family of ${registry.familySize} needs ${fmt(level0)}`);
    const wfNow = summarizeWalkForward(u.walkForward);
    c.add(`n_power inputs ${u.universe}`, sameSummary(wfNow, u.power.walkForward),
      `n_power was simulated on walk-forward ${describeSummary(u.power.walkForward)}, this universe's walk-forward is ${describeSummary(wfNow)}`);
    const unclustered = u.trades.filter((t) => !t.creatorCluster || !t.funderCluster).length;
    c.add(`clusters ${u.universe}`, unclustered === 0, `${unclustered} trades without a creator or funder cluster (need 0)`);
  }
  if (c.failed.length > 0) return failWith();

  // Size from the sealed counts alone.
  const sized = input.universes.map((u) => {
    const e = registry.entries.find((x) => x.holdoutId === u.holdoutId)!;
    const wf = u.walkForward.map((t) => t.rNet);
    const closed = wf.length >= 2 && sd(wf) > 0 ? nPower(sd(wf), 0.05, { alpha: level0 }) : 0;
    const required = Math.max(th.minTradesFloor, u.power.nPower, closed);
    const ready = holdoutReady(e, required, MIN_DAYS);
    c.add(`sample ${u.universe}`, ready,
      `${e.counts!.entries} sealed entries on ${e.counts!.entryDays} days (need >= max(${th.minTradesFloor}, simulated n_power ${u.power.nPower}, closed form ${closed}) = ${required}, on >= ${MIN_DAYS} days)`);
    return { u, e, required, ready };
  });
  const entering = sized.filter((x) => x.ready);

  // Verify every entering seal before opening any: configuration, hash and the entry count of the file to score.
  for (const { u, e } of entering) {
    let bad: { reason: 'reconfigured' | 'hash-mismatch' | 'count-mismatch'; why: string } | null = null;
    if (u.configId !== e.configId) bad = { reason: 'reconfigured', why: `scored as ${u.configId}, registered ${e.configId}` };
    else if (u.ledgerHash !== e.ledgerHash) bad = { reason: 'hash-mismatch', why: 'the file to score is not the sealed ledger' };
    else if (u.trades.length !== e.counts!.entries) bad = { reason: 'count-mismatch', why: `${u.trades.length} trades given, ${e.counts!.entries} sealed` };
    if (bad) {
      const step = burnHoldout(registry, e.holdoutId, bad.reason, bad.why);
      registry = step.registry;
      c.add(`seal ${u.universe}`, false, step.reason);
    }
  }
  if (c.list.some((x) => !x.passed && x.name.startsWith('seal '))) return failWith();

  for (const { u, e, required } of entering) {
    const step = openHoldout(registry, e.holdoutId, { configId: u.configId, ledgerHash: u.ledgerHash, requiredTrades: required, minDays: MIN_DAYS, nowMs: input.nowMs });
    registry = step.registry;
    if (!step.ok) {
      c.add(`seal ${u.universe}`, false, step.reason);
      return failWith();
    }
  }

  // Score: the G2 rule per universe, then Holm across the universes that entered.
  const opts = { rng: input.rng, ...(input.replicates === undefined ? {} : { replicates: input.replicates }) };
  // The primary rule (1-day blocks), then every other resampling unit (review STATS-1b): the universe's p is the
  // largest, so it passes only if every CI excludes zero. The intervals are reported at the family level (95%).
  const scored = entering.map(({ u }) => {
    const control = u.controlRuns.flat();
    const primary = g2Rule(u.trades, control, th.familyAlpha, opts);
    const rest = primary.p < th.familyAlpha ? g2Sensitivity(u.trades, control, th.familyAlpha, opts, ['days-2', 'days-3', 'creator', 'funder']) : [];
    const rows: G2SensitivityRow[] = [
      { variant: 'days-1', lower: primary.mean.lower, upper: primary.mean.upper, diffVsS0Lower: primary.vsControl.lower, p: primary.p },
      ...rest.map((x) => ({ variant: x.variant, lower: x.mean?.lower ?? null, upper: x.mean?.upper ?? null, diffVsS0Lower: x.vsControl?.lower ?? null, p: x.p })),
    ];
    const weakest = rows.reduce((w, x) => (x.p > w.p ? x : w));
    return { ...primary, p: weakest.p, rows, weakest };
  });
  // Holm over the whole family fixed in the registry: universes that did not enter count as p = 1, so a universe scored
  // now, or one scored in a later call, is never tested at a looser level than its place in the full family allows.
  const familyP = [...scored.map((r) => r.p), ...Array<number>(registry.familySize - scored.length).fill(1)];
  const h = holm(familyP, th.familyAlpha);
  const perUniverse: G2UniverseResult[] = sized.map(({ u, e, required, ready }) => {
    const k = entering.findIndex((x) => x.u === u);
    if (!ready || k < 0) {
      return { universe: u.universe, status: 'not-proven', requiredTrades: required, entries: e.counts!.entries, level: null, p: null, mean: null, lower: null, diffVsS0: null, diffVsS0Lower: null, sensitivity: [] };
    }
    const level = h.levels[k]!;
    const r = scored[k]!;
    // Pass ⇔ Holm rejects at the universe's level: p < level means every two-sided (1 − level) CI, under every
    // resampling unit, excludes zero, and p is 1 unless every estimate is positive. The intervals are reported at the family level (95%).
    const passed = h.rejected[k]!;
    c.add(`proof ${u.universe}`, passed,
      `mean ${fmt(r.mean.mean)}, 95% CI [${fmt(r.mean.lower)}, ${fmt(r.mean.upper)}]; vs S0 ${fmt(r.vsControl.mean)}, 95% CI [${fmt(r.vsControl.lower)}, ${fmt(r.vsControl.upper)}]; `
      + `weakest resampling ${r.weakest.variant}: 95% CI [${fmt(r.weakest.lower)}, ${fmt(r.weakest.upper)}], p ${fmt(r.p)} (need < Holm level ${fmt(level)} under every unit)`);
    const wf = u.walkForward.map((t) => t.rNet);
    if (wf.length >= 2) {
      const pi = meanPredictiveInterval({ n: wf.length, mean: mean(wf), sd: sd(wf) }, u.trades.length, 0.9);
      if (r.mean.mean < pi.lower || r.mean.mean > pi.upper) {
        notes.push(`${u.universe}: holdout mean ${fmt(r.mean.mean)} is outside the walk-forward 90% predictive interval [${fmt(pi.lower)}, ${fmt(pi.upper)}]; write a review`);
      }
    }
    return {
      universe: u.universe, status: passed ? 'pass' : 'fail', requiredTrades: required, entries: e.counts!.entries, level, p: r.p,
      mean: r.mean.mean, lower: r.mean.lower, diffVsS0: r.vsControl.mean, diffVsS0Lower: r.vsControl.lower, sensitivity: r.rows,
    };
  });

  const anyPass = perUniverse.some((x) => x.status === 'pass');
  const status: GateStatus = anyPass ? 'pass' : entering.length === 0 ? 'not-proven' : 'fail';
  const metrics: Record<string, number | null> = { universesEntered: entering.length, universesPassed: perUniverse.filter((x) => x.status === 'pass').length };
  // Per-universe failures stay in `checks` and `universes`; the gate's reasons list them only when it does not pass.
  return { ...result('G2', c, status, metrics), reasons: anyPass ? [] : c.failed, notes, universes: perUniverse, registry };
};

// ---- G3 ---------------------------------------------------------------------------------------------------------

export interface G3Input {
  /** The run is the single qualifying dry run (on the VPS, same commit; ARCHITECTURE.md §15), not a rehearsal. */
  readonly qualifyingRun: boolean;
  readonly dryRunHours: number;
  /** Net returns of the dry-run paper trades (the candidates live kept). */
  readonly dryRunReturns: readonly number[];
  /** The backtest holdout the dry run is compared with. */
  readonly holdout: SampleSummary;
  /** Lower bound of the holdout's mean net return: G2's `lower` for this universe (two-sided CI at its Holm level). */
  readonly holdoutLower: number;
  readonly candidates: { readonly dryRunCount: number; readonly dryRunHours: number; readonly backtestCount: number; readonly backtestHours: number };
  /** Rejected candidates per reason code. */
  readonly rejectMix: { readonly dryRun: Readonly<Record<string, number>>; readonly backtest: Readonly<Record<string, number>> };
  /** Eligible candidates vetoed by checks that exist only live, out of all eligible candidates in the run. */
  readonly liveOnlyVetoes: { readonly vetoed: number; readonly eligible: number };
  /** The vetoed candidates scored as if entered, after the run, by the scoring stage (`scoreVetoCounterfactuals`). */
  readonly vetoCounterfactuals: VetoCounterfactuals;
  /** Largest net return one trade can make (the bracket's take-profit; 0 < cap ≤ 3). Bounds the worst-case veto gap. */
  readonly returnCap: number;
  /** |paper fill − simulated transaction amount| per simulated entry or exit, as a fraction of notional. */
  readonly fillDifferences: readonly number[];
  readonly parityTestPassed: boolean;
}

/** Paper outcomes of the live-only-vetoed candidates, as if entered. */
export interface VetoCounterfactuals {
  /** Net return of each scored vetoed candidate. */
  readonly returns: readonly number[];
  /** Vetoed candidates whose outcome window is not fully observed yet. */
  readonly censored: number;
}

/**
 * Counterfactual scoring of live-only-vetoed candidates (ARCHITECTURE.md §14 G3, §16.3). The scoring stage labels each
 * vetoed candidate with the same triple-barrier configuration and execution model as the kept trades, from a paper
 * entry at its decision moment, exactly as it labels a kept trade; this collects those labels. The engine never sees them.
 */
export const scoreVetoCounterfactuals = (labels: readonly TripleBarrierLabel[]): VetoCounterfactuals => {
  if (new Set(labels.map((l) => l.cfgId)).size > 1) throw new RangeError('veto counterfactuals must use one barrier configuration');
  const returns: number[] = [];
  let censored = 0;
  for (const l of labels) {
    if (l.censored || l.rNet === null) censored++;
    else returns.push(l.rNet);
  }
  return { returns, censored };
};

/** One-sided (1 − α) Welch bounds on mean(a) − mean(b). */
const welchBounds = (a: readonly number[], b: readonly number[], alpha = 0.05): { diff: number; lower: number; upper: number } => {
  const diff = mean(a) - mean(b);
  const qa = variance(a) / a.length;
  const qb = variance(b) / b.length;
  const se = Math.sqrt(qa + qb);
  if (!(se > 0)) return { diff, lower: diff, upper: diff };
  const df = (qa + qb) ** 2 / (qa ** 2 / (a.length - 1) + qb ** 2 / (b.length - 1));
  const t = studentTQuantile(1 - alpha, df);
  return { diff, lower: diff - t * se, upper: diff + t * se };
};

/**
 * G3 Live dry-run consistency, ARCHITECTURE.md §14. Besides rates, reject mix and fills, it bounds the live-only veto
 * bias (review STATS-1b): the backtest keeps trades live would veto, so the retained strategy's expectancy is the holdout
 * mean minus v·Δ, Δ the mean of vetoed candidates (scored as if entered) minus the mean of kept trades. The gate needs
 * holdoutLower − v₉₅·max(0, Δ₉₅) − execution allowance > 0, with v₉₅ the Clopper–Pearson and Δ₉₅ the Welch one-sided
 * 95% upper bounds, and v₉₅·|Δ|₉₅ ≤ 5 points. With fewer than 10 scored vetoed or kept trades Δ is the worst case the
 * return range allows (cap − RETURN_FLOOR), never an assumed value. A failure that more run time can clear (missing,
 * censored or too few counterfactuals; a bound that fails while the point estimate passes) is "not proven": extend the
 * dry run. Kept trades within one run are treated as independent (48 h holds about two days, too few to estimate day
 * correlation); the run says so.
 */
export const gateG3 = (input: G3Input, overrides?: Partial<typeof G3_DEFAULTS>): GateResult => {
  const th = tighten('G3', G3_DEFAULTS, G3_DIR, overrides);
  const c = new Checks();
  const notes: string[] = [];
  /** Failed checks that a longer run can clear. */
  const extend = new Set<string>();
  const m = input.dryRunReturns.length;
  const metrics: Record<string, number | null> = { dryRunTrades: m, dryRunHours: input.dryRunHours };
  c.add('qualifying run', input.qualifyingRun, input.qualifyingRun ? 'the qualifying dry run' : 'a rehearsal run counts for no gate');
  c.add('duration', input.dryRunHours >= th.minHours, `${fmt(input.dryRunHours)} h (need >= ${th.minHours})`);
  c.add('parity', input.parityTestPassed, input.parityTestPassed ? 'parity passed on the recorded dry-run data' : 'parity failed on the recorded dry-run data');

  if (m >= th.minPaperTradesForMean) {
    const dm = mean(input.dryRunReturns);
    const pi = meanPredictiveInterval(input.holdout, m, 0.9);
    metrics.dryRunMean = dm;
    metrics.predictiveLower90 = pi.lower;
    metrics.predictiveUpper90 = pi.upper;
    c.add('mean', dm >= pi.lower && dm <= pi.upper, `dry-run mean ${fmt(dm)} vs holdout 90% predictive interval [${fmt(pi.lower)}, ${fmt(pi.upper)}] for ${m} trades`);
  } else {
    notes.push(`${m} paper trades (fewer than ${th.minPaperTradesForMean}): consistency rests on the candidate rate and the reject mix`);
  }

  const k = input.candidates;
  const rate = ratesConsistent(k.dryRunCount, k.dryRunHours, k.backtestCount, k.backtestHours);
  metrics.candidateRateDryRun = k.dryRunCount / k.dryRunHours;
  metrics.candidateRateBacktest = k.backtestCount / k.backtestHours;
  c.add('candidate rate', rate.consistent,
    `${fmt(metrics.candidateRateDryRun)}/h vs ${fmt(metrics.candidateRateBacktest)}/h (expected share ${fmt(rate.expectedShare)} vs 95% interval [${fmt(rate.lower)}, ${fmt(rate.upper)}])`);

  const dryTotal = Object.values(input.rejectMix.dryRun).reduce((s, x) => s + x, 0);
  const btTotal = Object.values(input.rejectMix.backtest).reduce((s, x) => s + x, 0);
  if (dryTotal === 0 || btTotal === 0) {
    c.add('reject mix', false, `no rejects to compare (dry run ${dryTotal}, backtest ${btTotal})`);
  } else {
    const reasons = [...new Set([...Object.keys(input.rejectMix.dryRun), ...Object.keys(input.rejectMix.backtest)])].sort();
    for (const r of reasons) {
      const kDry = input.rejectMix.dryRun[r] ?? 0;
      const share = (input.rejectMix.backtest[r] ?? 0) / btTotal;
      const ci = clopperPearsonInterval(kDry, dryTotal);
      c.add(`reject mix ${r}`, share >= ci.lower && share <= ci.upper,
        `dry run ${kDry}/${dryTotal}, 95% interval [${fmt(ci.lower)}, ${fmt(ci.upper)}] vs backtest share ${fmt(share)}`);
    }
  }

  let fillUpper = Infinity;
  let fillMean = Infinity;
  if (input.fillDifferences.length === 0) {
    c.add('fills', false, 'no simulated fills to compare');
  } else {
    const abs = input.fillDifferences.map(Math.abs);
    const md = median(abs);
    metrics.fillDiffMedian = md;
    c.add('fills', md <= th.fillDiffMedianMax, `median |paper − simulated| ${fmt(md)} (need <= ${th.fillDiffMedianMax})`);
    fillMean = mean(abs);
    fillUpper = abs.length >= 2 ? fillMean + studentTQuantile(0.95, abs.length - 1) * sd(abs) / Math.sqrt(abs.length) : Math.max(...abs);
  }

  const v = input.liveOnlyVetoes;
  if (v.eligible === 0) {
    c.add('live-only vetoes', false, 'no eligible candidates in the run');
    return { ...result('G3', c, statusFrom(c), metrics), notes };
  }
  const vRate = v.vetoed / v.eligible;
  const vUpper = clopperPearsonUpper(v.vetoed, v.eligible);
  metrics.liveOnlyVetoRate = vRate;
  metrics.liveOnlyVetoUpper95 = vUpper;
  c.add('live-only vetoes', vRate <= th.liveOnlyVetoRateMax,
    `${v.vetoed}/${v.eligible} = ${fmt(vRate)} vetoed by live-only checks, 95% upper bound ${fmt(vUpper)} (need rate <= ${th.liveOnlyVetoRateMax})`);

  // Veto bias (review STATS-1b). Every vetoed candidate must be scored as if entered, in the separate scoring stage.
  const capOk = input.returnCap > 0 && input.returnCap <= MAX_RETURN_CAP;
  c.add('return cap', capOk, `return cap ${fmt(input.returnCap)} (need in (0, ${MAX_RETURN_CAP}])`);
  const worstGap = (capOk ? input.returnCap : MAX_RETURN_CAP) - RETURN_FLOOR;
  const cf = input.vetoCounterfactuals;
  const scored = cf.returns.length;
  const unscored = v.vetoed - scored - cf.censored;
  if (unscored < 0) {
    c.add('veto counterfactuals', false, `${scored} scored + ${cf.censored} censored is more than the ${v.vetoed} vetoed candidates`);
  } else if (unscored > 0 || cf.censored > 0) {
    const parts = [`${scored} of ${v.vetoed} vetoed candidates scored`];
    if (unscored > 0) parts.push(`${unscored} unscored: score them in the outcome stage`);
    if (cf.censored > 0) parts.push(`${cf.censored} censored: wait for their windows to close`);
    c.add('veto counterfactuals', false, parts.join('; '));
    extend.add('veto counterfactuals');
  }
  const complete = unscored === 0 && cf.censored === 0;
  const measured = complete && scored >= th.minVetoedForGap && m >= th.minKeptForGap;
  // Δ = vetoed − kept. Unmeasured: the worst gap the return range allows, in either direction.
  let gapUpper = worstGap;
  let gapAbsUpper = worstGap;
  let gapPoint: number | null = null;
  if (measured) {
    const w = welchBounds(cf.returns, input.dryRunReturns);
    gapPoint = w.diff;
    gapUpper = Math.min(w.upper, worstGap);
    gapAbsUpper = Math.min(Math.max(Math.abs(w.upper), Math.abs(w.lower)), worstGap);
  } else {
    notes.push(`veto gap not measured (${scored} vetoed scored, ${m} kept; need >= ${th.minVetoedForGap} and >= ${th.minKeptForGap}, all scored): the worst case ${fmt(worstGap)} is used`);
  }
  metrics.vetoGap = gapPoint;
  metrics.vetoGapUpper95 = gapUpper;
  const bias = vUpper * gapAbsUpper;
  const biasPoint = gapPoint === null ? null : vRate * Math.abs(gapPoint);
  metrics.vetoBiasUpper95 = bias;
  if (!c.add('veto bias', bias <= th.vetoBiasMax,
    `v₉₅·|Δ|₉₅ = ${fmt(vUpper)} × ${fmt(gapAbsUpper)} = ${fmt(bias)}${measured ? '' : ' (worst-case gap)'} (need <= ${th.vetoBiasMax})`)
    && !(biasPoint !== null && biasPoint > th.vetoBiasMax)) extend.add('veto bias');

  const selection = vUpper * Math.max(0, gapUpper);
  const execution = 2 * fillUpper; // an entry and an exit per trade
  const retainedLower = input.holdoutLower - selection - execution;
  const retainedPoint = input.holdout.mean - vRate * Math.max(0, gapPoint ?? 0) - 2 * fillMean;
  metrics.selectionAllowance = selection;
  metrics.executionAllowance = execution;
  metrics.retainedLower = retainedLower;
  const retainedOk = retainedLower > th.retainedLowerMin;
  // The point estimate already fails only when the gap was measured; otherwise more evidence may clear it.
  const retainedExtend = !retainedOk && retainedPoint > th.retainedLowerMin;
  c.add('retained expectancy', retainedOk,
    `holdout lower ${fmt(input.holdoutLower)} − selection ${fmt(selection)} − execution ${fmt(execution)} = ${fmt(retainedLower)} (need > ${th.retainedLowerMin})`
    + (retainedExtend ? `; point estimate ${fmt(retainedPoint)}: extend the dry run` : ''));
  if (retainedExtend) extend.add('retained expectancy');

  const failed = c.list.filter((x) => !x.passed).map((x) => x.name);
  const status: GateStatus = failed.length === 0 ? 'pass' : failed.every((f) => extend.has(f)) ? 'not-proven' : 'fail';
  if (status === 'not-proven') notes.push('not proven: extend the dry run');
  return { ...result('G3', c, status, metrics), notes };
};


// ---- G4 ---------------------------------------------------------------------------------------------------------

export interface G4Input {
  readonly liveTrades: number;
  readonly doubleBuys: number;
  readonly unreconciledBalances: number;
  readonly signerPolicyBypasses: number;
  readonly firstAttemptLandingFailures: number;
  /** Exits that never landed. */
  readonly unlandedExits: number;
  readonly blockedExits: number;
  /** live − paper net return per trade, same candidates. */
  readonly liveMinusPaper: readonly number[];
}

/**
 * G4 Canary mechanics. Live P&L is reported elsewhere and is not proof of edge. Its blocked-exit evidence is a bound:
 * 0 of 30 still allows a rate up to about 9.5% (one-sided 95%), reported as `blockedExitUpper95` and in the notes.
 */
export const gateG4 = (input: G4Input, overrides?: Partial<typeof G4_DEFAULTS>): GateResult => {
  const th = tighten('G4', G4_DEFAULTS, G4_DIR, overrides);
  const c = new Checks();
  const n = input.liveTrades;
  c.add('trades', n >= th.minTrades, `${n} live trades (need >= ${th.minTrades})`);
  c.add('double buys', input.doubleBuys === 0, `${input.doubleBuys} (need 0)`);
  c.add('unreconciled', input.unreconciledBalances === 0, `${input.unreconciledBalances} (need 0)`);
  c.add('signer bypass', input.signerPolicyBypasses === 0, `${input.signerPolicyBypasses} (need 0)`);
  c.add('landing', n > 0 && input.firstAttemptLandingFailures <= th.firstAttemptFailRateMax * n + 1e-9,
    `${input.firstAttemptLandingFailures} first-attempt failures in ${n} (need <= ${fmt(th.firstAttemptFailRateMax * n)})`);
  c.add('exits land', input.unlandedExits === 0, `${input.unlandedExits} exits never landed (need 0)`);
  c.add('blocked exits', input.blockedExits === 0, `${input.blockedExits} (need 0)`);
  const md = input.liveMinusPaper.length > 0 ? median(input.liveMinusPaper) : null;
  c.add('live vs paper', md !== null && md >= th.liveMinusPaperMedianMin, `median live − paper ${fmt(md)} (need >= ${th.liveMinusPaperMedianMin})`);
  const status = statusWithSample(c, 'trades', ['landing', 'live vs paper']);
  // Zero observed is not zero: the exact one-sided 95% upper bound is what the canary shows (quant.md §5.5).
  const blockedUpper = n > 0 && input.blockedExits <= n ? clopperPearsonUpper(input.blockedExits, n) : null;
  const notes = blockedUpper === null ? [] : [
    `${input.blockedExits} blocked exits in ${n} trades bounds the blocked-exit rate at ${fmt(+(100 * blockedUpper).toFixed(1))}% (one-sided 95%), not 0`,
  ];
  return { ...result('G4', c, status, { liveTrades: n, liveMinusPaperMedian: md, blockedExitUpper95: blockedUpper }), notes };
};

// ---- G5 ---------------------------------------------------------------------------------------------------------

export interface G5Input {
  /** Live net returns in order, with their day (the e-process bets once per day). */
  readonly liveReturns: readonly DayReturn[];
  /** G1 and G2 re-run on the newest data still pass. */
  readonly backtestGatesPassingOnNewestData: boolean;
  /** Modelled price impact at the proposed size, as a fraction. */
  readonly impactAtProposedSize: number;
  readonly lastPlatformChangeMs: number | null;
  /** The injected clock's time; this module never reads a clock. */
  readonly nowMs: number;
}

/** G5 Proposal to the owner for larger sizes. Passing only allows the proposal; the owner decides. */
export const gateG5 = (input: G5Input, overrides?: Partial<typeof G5_DEFAULTS>): GateResult => {
  const th = tighten('G5', G5_DEFAULTS, G5_DIR, overrides);
  const c = new Checks();
  const n = input.liveReturns.length;
  const metrics: Record<string, number | null> = { liveTrades: n };
  c.add('trades', n >= th.minTrades, `${n} live trades (need >= ${th.minTrades})`);
  const lowest = minReturn(input.liveReturns.map((t) => t.rNet));
  if (n > 0 && lowest < RETURN_FLOOR) {
    c.add('e-process', false, `a return of ${fmt(lowest)} is below the floor ${RETURN_FLOOR}`);
  } else {
    const e = bettingEProcess(input.liveReturns, { lowerBound: RETURN_FLOOR, threshold: th.eWealthMin });
    metrics.eWealthMax = e.maxWealth;
    c.add('e-process', e.maxWealth >= th.eWealthMin, `live max wealth ${fmt(e.maxWealth)} (need >= ${th.eWealthMin})`);
  }
  c.add('backtest gates', input.backtestGatesPassingOnNewestData,
    input.backtestGatesPassingOnNewestData ? 'G1 and G2 pass on the newest data' : 'G1 or G2 fails on the newest data');
  c.add('impact', input.impactAtProposedSize < th.impactMax, `impact ${fmt(input.impactAtProposedSize)} at the proposed size (need < ${th.impactMax})`);
  const quietMs = input.lastPlatformChangeMs === null ? Infinity : input.nowMs - input.lastPlatformChangeMs;
  metrics.daysSincePlatformChange = quietMs === Infinity ? null : quietMs / MS_PER_DAY;
  c.add('platform', quietMs >= th.quietDays * MS_PER_DAY, `last platform change ${fmt(metrics.daysSincePlatformChange)} days ago (need >= ${th.quietDays})`);
  return result('G5', c, statusWithSample(c, 'trades', ['e-process']), metrics);
};

// ---- demotion ---------------------------------------------------------------------------------------------------

export interface DemotionInput {
  /** Live (or paper, when demoting a paper version) net returns in order, with their day. */
  readonly returns: readonly DayReturn[];
  /** Cap for the reverse e-process (quant.md §5.3): 0 < cap ≤ 3, e.g. the take-profit of a bracketed exit. */
  readonly returnCap: number;
  readonly driftAlarm: boolean;
  /** Prediction-set coverage of the most recent decisions, oldest first, with the target miscoverage rate. */
  readonly coverage: { readonly targetMiscoverage: number; readonly covered: readonly boolean[] } | null;
  readonly platformChange: boolean;
  readonly blockedExitTimesMs: readonly number[];
  readonly nowMs: number;
  readonly ownerLossLimitHit: boolean;
}

/** Demotion to paper (any one trigger). Exits continue after demotion. */
export const evaluateDemotion = (input: DemotionInput, overrides?: Partial<typeof DEMOTION_DEFAULTS>): DemotionResult => {
  const th = tighten('demotion', DEMOTION_DEFAULTS, DEMOTION_DIR, overrides);
  const c = new Checks();
  const metrics: Record<string, number | null> = {};
  // An invalid cap demotes: a cap above the limit would make the decay detector nearly blind.
  if (!(input.returnCap > 0 && input.returnCap <= th.returnCapMax)) {
    c.add('return cap', false, `return cap ${fmt(input.returnCap)} is outside (0, ${th.returnCapMax}]`);
  } else {
    const rev = reverseEProcess(input.returns, { cap: input.returnCap, threshold: th.reverseWealth });
    metrics.reverseWealthMax = rev.maxWealth;
    c.add('reverse e-process', rev.maxWealth < th.reverseWealth, `max reverse wealth ${fmt(rev.maxWealth)} (demote at >= ${th.reverseWealth})`);
  }
  c.add('drift', !input.driftAlarm, input.driftAlarm ? 'drift alarm on calibration or log loss' : 'no drift alarm');
  if (input.coverage && input.coverage.covered.length >= COVERAGE_WINDOW) {
    const recent = input.coverage.covered.slice(-COVERAGE_WINDOW);
    const miss = recent.filter((x) => !x).length / COVERAGE_WINDOW;
    metrics.miscoverage = miss;
    c.add('miscoverage', miss <= th.miscoverageFactor * input.coverage.targetMiscoverage,
      `miscoverage ${fmt(miss)} over the last ${COVERAGE_WINDOW} decisions (demote above ${fmt(th.miscoverageFactor * input.coverage.targetMiscoverage)})`);
  }
  c.add('platform change', !input.platformChange, input.platformChange ? 'platform change: re-run the backtest on >= 200 post-change candidates' : 'none');
  const since = input.nowMs - th.blockedWindowDays * MS_PER_DAY;
  const blocked = input.blockedExitTimesMs.filter((t) => t > since && t <= input.nowMs).length;
  metrics.blockedExitsInWindow = blocked;
  c.add('blocked exits', blocked < th.blockedExitsMax, `${blocked} blocked exits in ${th.blockedWindowDays} days (demote at >= ${th.blockedExitsMax})`);
  c.add('loss limit', !input.ownerLossLimitHit, input.ownerLossLimitHit ? 'an owner loss limit was hit' : 'none');
  return { demote: c.failed.length > 0, reasons: c.failed, checks: c.list, metrics };
};

// ---- post-change revalidation -----------------------------------------------------------------------------------

/** A platform change (program upgrade, fee or layout change) that starts a new regime (ARCHITECTURE.md §6.5, §14). */
export interface PlatformChange {
  readonly id: string;
  readonly atMs: number;
  /**
   * The written review's finding that trade economics on the markets we trade (fees, quotes, accounts, event layouts) are
   * unchanged. false when contradicted; null when not reviewed (treated as contradicted: unproven means no trade).
   * The known changes are in config (KNOWN_PLATFORM_CHANGES).
   */
  readonly economicsUnchanged: boolean | null;
}

export interface RevalidationInput {
  /** End of the holdout window the G2 proof rests on (exclusive). */
  readonly holdoutEndMs: number;
  readonly platformChanges: readonly PlatformChange[];
  /** The qualifying dry run and its G3 result against the holdout; null when none has run. */
  readonly dryRun: { readonly qualifyingRun: boolean; readonly startMs: number; readonly g3: GateResult } | null;
  /** Backtest re-run on candidates after the change: G1 and G2 on that data passed or not; null when none has run. */
  readonly postChangeBacktest: { readonly firstCandidateMs: number; readonly candidates: number; readonly gatesPassed: boolean } | null;
}

export const REVALIDATION_DEFAULTS = { minPostChangeCandidates: 200 };
const REVALIDATION_DIR = { minPostChangeCandidates: 'min' } as const;

export interface RevalidationResult {
  readonly passed: boolean;
  readonly status: GateStatus;
  readonly reasons: readonly string[];
  readonly checks: readonly Check[];
  /** Changes after the holdout ends, which the holdout's proof does not cover. */
  readonly pendingChanges: readonly string[];
}

/**
 * Post-change revalidation (ARCHITECTURE.md §14 demotion rule; review STATS-1b). A platform change after the holdout
 * window means the proof predates the market being traded. Funding then also needs, from after the latest such change:
 * a qualifying dry run that passed G3 against the holdout; and, if any such change's "economics unchanged" finding is
 * contradicted or missing, a backtest re-run on >= 200 post-change candidates whose gates pass. Missing evidence is "not
 * proven"; failed evidence fails.
 */
export const evaluateRevalidation = (input: RevalidationInput, overrides?: Partial<typeof REVALIDATION_DEFAULTS>): RevalidationResult => {
  const th = tighten('revalidation', REVALIDATION_DEFAULTS, REVALIDATION_DIR, overrides);
  const c = new Checks();
  const missing = new Set<string>();
  const pending = input.platformChanges.filter((x) => x.atMs >= input.holdoutEndMs).sort((a, b) => a.atMs - b.atMs);
  const done = (status: GateStatus): RevalidationResult => ({
    passed: status === 'pass', status, reasons: c.failed, checks: c.list, pendingChanges: pending.map((x) => x.id),
  });
  if (pending.length === 0) {
    c.add('changes', true, 'no platform change after the holdout');
    return done('pass');
  }
  const latest = pending[pending.length - 1]!;
  const d = input.dryRun;
  if (!d) {
    c.add('post-change dry run', false, `none: run the qualifying dry run after ${latest.id}`);
    missing.add('post-change dry run');
  } else if (!d.qualifyingRun) {
    c.add('post-change dry run', false, 'a rehearsal run counts for no gate');
    missing.add('post-change dry run');
  } else if (d.startMs < latest.atMs) {
    c.add('post-change dry run', false, `started before ${latest.id}: run a new qualifying dry run`);
    missing.add('post-change dry run');
  } else {
    c.add('post-change dry run', d.g3.passed, `G3 against the holdout: ${d.g3.status}`);
    if (d.g3.status === 'not-proven') missing.add('post-change dry run');
  }

  const unproven = pending.filter((x) => x.economicsUnchanged !== true);
  if (unproven.length > 0) {
    const since = unproven[unproven.length - 1]!;
    const ids = unproven.map((x) => `${x.id} (${x.economicsUnchanged === null ? 'not reviewed' : 'economics changed'})`).join(', ');
    const b = input.postChangeBacktest;
    const tag = 'post-change backtest';
    if (!b) {
      c.add(tag, false, `none: re-run the backtest on >= ${th.minPostChangeCandidates} candidates after ${ids}`);
      missing.add(tag);
    } else if (b.firstCandidateMs < since.atMs) {
      c.add(tag, false, `its candidates start before ${since.id}: re-run on post-change candidates only`);
      missing.add(tag);
    } else if (b.candidates < th.minPostChangeCandidates) {
      c.add(tag, false, `${b.candidates} post-change candidates (need >= ${th.minPostChangeCandidates})`);
      missing.add(tag);
    } else {
      c.add(tag, b.gatesPassed, `${b.candidates} post-change candidates; gates ${b.gatesPassed ? 'pass' : 'fail'}`);
    }
  }
  const failed = c.list.filter((x) => !x.passed).map((x) => x.name);
  return done(failed.length === 0 ? 'pass' : failed.every((f) => missing.has(f)) ? 'not-proven' : 'fail');
};
