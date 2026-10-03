// Promotion gates G0–G5 and demotion (ARCHITECTURE.md §14, quant.md §8) as pure functions.
// Each takes measured inputs, returns pass or fail with the reason for every failed check, and never reads a clock,
// a file or the network. Thresholds default to the documented values; overrides may only tighten them
// (loosening needs the owner and a change to the defaults here).

import { dayBlockMeanDiffInterval, dayBlockMeanInterval, type DayReturn } from './bootstrap.ts';
import { g2Rule, MIN_DAYS, type G2PowerResult } from './g2rule.ts';
import { burnHoldout, holdoutReady, openHoldout, type HoldoutRegistry } from './holdout.ts';
import { holm } from './holm.ts';
import { clopperPearsonInterval, clopperPearsonUpper, ratesConsistent } from './binomial.ts';
import { mean, median, sd } from './descriptive.ts';
import { bettingEProcess, MAX_RETURN_CAP, reverseEProcess } from './eprocess.ts';
import { probabilityOfBacktestOverfitting } from './pbo.ts';
import { nPower } from './power.ts';
import { meanPredictiveInterval, type SampleSummary } from './predictive.ts';
import type { Rng } from './rng.ts';
import { deflatedSharpe, type TrialRecord } from './sharpe.ts';

export type GateName = 'G0' | 'G1' | 'G2' | 'G3' | 'G4' | 'G5';
/** 'not-proven': too little data to decide (collect more, never lower n). 'futile': the version is rejected (G2). */
export type GateStatus = 'pass' | 'fail' | 'not-proven' | 'futile';

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

export const G3_DEFAULTS = { minHours: 48, fillDiffMedianMax: 0.005, minPaperTradesForMean: 30, liveOnlyVetoRateMax: 0.1 };
// Fewer paper trades needed before the mean is checked means the check applies more often: stricter.
const G3_DIR = { minHours: 'min', fillDiffMedianMax: 'max', minPaperTradesForMean: 'max', liveOnlyVetoRateMax: 'max' } as const;

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
  /** Holdout trades from the sealed ledger, in decision-time order. Read only after the size check passes. */
  readonly trades: readonly TradeOutcome[];
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
  const scored = entering.map(({ u }) => g2Rule(u.trades, u.controlRuns.flat(), th.familyAlpha, opts));
  const h = holm(scored.map((r) => r.p), th.familyAlpha);
  const perUniverse: G2UniverseResult[] = sized.map(({ u, e, required, ready }) => {
    const k = entering.findIndex((x) => x.u === u);
    if (!ready || k < 0) {
      return { universe: u.universe, status: 'not-proven', requiredTrades: required, entries: e.counts!.entries, level: null, p: null, mean: null, lower: null, diffVsS0: null, diffVsS0Lower: null };
    }
    const level = h.levels[k]!;
    const r = scored[k]!;
    // Pass ⇔ Holm rejects at the universe's level: p < level means both two-sided (1 − level) CIs exclude zero, and
    // p is 1 unless both estimates are positive. The intervals are reported at the family level (95%).
    const passed = h.rejected[k]!;
    c.add(`proof ${u.universe}`, passed,
      `mean ${fmt(r.mean.mean)}, 95% CI [${fmt(r.mean.lower)}, ${fmt(r.mean.upper)}]; vs S0 ${fmt(r.vsControl.mean)}, 95% CI [${fmt(r.vsControl.lower)}, ${fmt(r.vsControl.upper)}]; p ${fmt(r.p)} (need < Holm level ${fmt(level)})`);
    const wf = u.walkForward.map((t) => t.rNet);
    if (wf.length >= 2) {
      const pi = meanPredictiveInterval({ n: wf.length, mean: mean(wf), sd: sd(wf) }, u.trades.length, 0.9);
      if (r.mean.mean < pi.lower || r.mean.mean > pi.upper) {
        notes.push(`${u.universe}: holdout mean ${fmt(r.mean.mean)} is outside the walk-forward 90% predictive interval [${fmt(pi.lower)}, ${fmt(pi.upper)}]; write a review`);
      }
    }
    return {
      universe: u.universe, status: passed ? 'pass' : 'fail', requiredTrades: required, entries: e.counts!.entries, level, p: r.p,
      mean: r.mean.mean, lower: r.mean.lower, diffVsS0: r.vsControl.mean, diffVsS0Lower: r.vsControl.lower,
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
  /** Net returns of the dry-run paper trades. */
  readonly dryRunReturns: readonly number[];
  /** The backtest holdout the dry run is compared with. */
  readonly holdout: SampleSummary;
  readonly candidates: { readonly dryRunCount: number; readonly dryRunHours: number; readonly backtestCount: number; readonly backtestHours: number };
  /** Rejected candidates per reason code. */
  readonly rejectMix: { readonly dryRun: Readonly<Record<string, number>>; readonly backtest: Readonly<Record<string, number>> };
  /** Eligible candidates vetoed by checks that exist only live, out of all eligible candidates in the run. */
  readonly liveOnlyVetoes: { readonly vetoed: number; readonly eligible: number };
  /** |paper fill − simulated transaction amount| per simulated entry or exit, as a fraction of notional. */
  readonly fillDifferences: readonly number[];
  readonly parityTestPassed: boolean;
}

/** G3 Live dry-run consistency. */
export const gateG3 = (input: G3Input, overrides?: Partial<typeof G3_DEFAULTS>): GateResult => {
  const th = tighten('G3', G3_DEFAULTS, G3_DIR, overrides);
  const c = new Checks();
  const notes: string[] = [];
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

  const v = input.liveOnlyVetoes;
  if (v.eligible === 0) {
    c.add('live-only vetoes', false, 'no eligible candidates in the run');
  } else {
    const rate = v.vetoed / v.eligible;
    metrics.liveOnlyVetoRate = rate;
    metrics.liveOnlyVetoUpper95 = clopperPearsonUpper(v.vetoed, v.eligible);
    c.add('live-only vetoes', rate <= th.liveOnlyVetoRateMax,
      `${v.vetoed}/${v.eligible} = ${fmt(rate)} vetoed by live-only checks, 95% upper bound ${fmt(metrics.liveOnlyVetoUpper95)} (need rate <= ${th.liveOnlyVetoRateMax})`);
  }

  if (input.fillDifferences.length === 0) {
    c.add('fills', false, 'no simulated fills to compare');
  } else {
    const md = median(input.fillDifferences.map(Math.abs));
    metrics.fillDiffMedian = md;
    c.add('fills', md <= th.fillDiffMedianMax, `median |paper − simulated| ${fmt(md)} (need <= ${th.fillDiffMedianMax})`);
  }
  return { ...result('G3', c, statusFrom(c), metrics), notes };
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

/** G4 Canary mechanics. Live P&L is reported elsewhere and is not proof of edge. */
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
  return result('G4', c, status, { liveTrades: n, liveMinusPaperMedian: md });
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
