// Promotion gates G0–G5 and demotion (ARCHITECTURE.md §14, quant.md §8) as pure functions.
// Each takes measured inputs, returns pass or fail with the reason for every failed check, and never reads a clock,
// a file or the network. Thresholds default to the documented values; overrides may only tighten them
// (loosening needs the owner and a change to the defaults here).

import { dayBlockMeanDiffInterval, dayBlockMeanInterval, DEFAULT_REPLICATES, type DayReturn } from './bootstrap.ts';
import { describeSummary, G2_SENSITIVITY_VARIANTS, g2PowerInputs, g2Rule, g2Sensitivity, MIN_DAYS, summarizeWalkForward, type ClusteredReturn, type G2PowerResult, type G2SensitivityVariant } from './g2rule.ts';
import { burnHoldout, dayFromNumber, G1_TESTS, type G1Test, holdoutReady, openHoldout, type HoldoutRegistry } from './holdout.ts';
import { holm } from './holm.ts';
import { clopperPearsonInterval, clopperPearsonUpper, ratesConsistent } from './binomial.ts';
import { mean, median, sd, variance } from './descriptive.ts';
import { bettingEProcess, MAX_RETURN_CAP, reverseEProcess } from './eprocess.ts';
import { probabilityOfBacktestOverfitting } from './pbo.ts';
import { nPower } from './power.ts';
import { meanPredictiveInterval, type SampleSummary } from './predictive.ts';
import type { TripleBarrierLabel } from './labeller.ts';
import type { Rng } from './rng.ts';
import { incompleteGammaUpper, studentTQuantile } from './special.ts';
import { deflatedSharpe, deflatedSharpeDaily, sharpeBootstrap, type TrialRecord } from './sharpe.ts';
import { SPA_STUDENTISATION, spaTest } from './spa.ts';

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
  minHours: 48, fillDiffMedianMax: 0.005, fillDiffMax: 0.02, minPaperTradesForMean: 30, liveOnlyVetoRateMax: 0.1,
  minVetoedForGap: 10, minKeptForGap: 10, vetoBiasMax: 0.05, retainedLowerMin: 0,
  minCandidatesForRate: 50, minRejectsForMix: 50, minFills: 20, minSimulations: 20, simSuccessMin: 0.95,
  // The mean must sit inside the holdout's predictive interval at this level. A narrower interval is the stricter
  // direction for an "inside" agree test, so tightening lowers it.
  meanPredictiveLevel: 0.9,
};
// Every minimum sample is a floor: below it a comparison is inconclusive (extend the run), never agreement, so raising
// it is stricter. More scored vetoed or kept trades before the gap is measured means the worst-case gap is used more
// often: stricter.
const G3_DIR = {
  minHours: 'min', fillDiffMedianMax: 'max', fillDiffMax: 'max', minPaperTradesForMean: 'min', liveOnlyVetoRateMax: 'max',
  minVetoedForGap: 'min', minKeptForGap: 'min', vetoBiasMax: 'max', retainedLowerMin: 'min',
  minCandidatesForRate: 'min', minRejectsForMix: 'min', minFills: 'min', minSimulations: 'min', simSuccessMin: 'min',
  meanPredictiveLevel: 'max',
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
/** A net return at or below this is severe (`y_severe`, quant.md §1.2). */
const SEVERE_RETURN = -0.5;

const MS_PER_DAY = 86_400_000;
const MS_PER_HOUR = MS_PER_DAY / 24;
/** Level of the SPA test when it gates G1 (one test over the whole registry). */
const SPA_ALPHA = 0.05;
const COVERAGE_WINDOW = 100;
/** One-sided 95% normal quantile: the validation power may sit at most this many standard errors below the target. */
const N_POWER_VALIDATION_Z = 1.645;
/**
 * The n_power settings G2 accepts (STATS-1g review B3): a result cannot declare its own goal. Power at least 80%
 * (owner rule 6), a design edge of at most +5 points (a smaller edge needs more trades), at least 400 simulations; the
 * family size, α and bootstrap replicates are the registry's and the gate's own.
 */
const N_POWER_MIN_POWER = 0.8;
const N_POWER_MAX_TARGET_MEAN = 0.05;
const N_POWER_MIN_SIMULATIONS = 400;
/**
 * Days of the trailing reverse e-process that runs beside the full-history one (STATS-1d). After a good stretch the
 * full-history process has bet against the strategy for weeks and lost wealth, so a later decay barely moves it
 * (U1, −10% after 60 days at +5%: caught within 40 days in under 1% of runs); a process restarted on the last 40 days
 * catches it. Demotion fires on either. Fixed, not an override: it only adds a trigger.
 */
export const DEMOTION_TRAILING_DAYS = 40;
/** How far the judged dry-run data may end from G3's registered end (inputs are cut at it). */
export const G3_END_TOLERANCE_MS = MS_PER_HOUR / 60;

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
   * Per-trial daily P&L for PBO and the day-level DSR, keyed by trialId: every trial on one calendar, idle days as 0
   * with their costs. Must hold exactly the registry's trials (a subset would lower PBO and the DSR's N), every one with
   * the same rows.
   */
  readonly pboMatrix: Readonly<Record<string, readonly number[]>>;
  readonly pboBlocks?: number;
  /**
   * The holdout registry, created with the plan before any G1 evaluation: its stored `g1Test` decides which
   * significance test gates G1 (owner decision, 2026-10-04: 'spa'). 'spa': the joint SPA test as registered and
   * calibrated in STATS-1e (the global test with the step-down promotion of the selected rule, both benchmarks, blocks
   * 3/5/7 with the worst p, short regimes merged). 'dsr': the per-trade DSR over every registered trial with clamped
   * moments. The other is always reported, never gating. A registry without a valid stored test fails G1 closed.
   */
  readonly holdoutRegistry: Pick<HoldoutRegistry, 'g1Test'>;
  /** Optional: the test the caller expects; if it differs from the stored one, G1 fails (it never chooses). */
  readonly g1Test?: G1Test;
  /**
   * The joint SPA test's other inputs, on the calendar of `pboMatrix` (whose rows are the variants' daily net P&L over a
   * fixed capital base): S0's daily P&L, each variant's active days (counted before outcomes) and the registered SE
   * floor and regimes. Without them SPA is not run (and cannot gate).
   */
  readonly spa?: { readonly s0Daily: readonly number[]; readonly activeDays: Readonly<Record<string, number>>; readonly seFloor: number; readonly regimes?: readonly { readonly from: number; readonly to: number }[] };
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
  // The test comes from the stored registry, never from the caller: a missing or unknown stored test, or a caller who
  // expects a different one, fails G1 and nothing gates.
  const stored: unknown = input.holdoutRegistry?.g1Test;
  const valid = (G1_TESTS as readonly unknown[]).includes(stored);
  const agrees = input.g1Test === undefined || input.g1Test === stored;
  const test: G1Test | null = valid && agrees ? (stored as G1Test) : null;
  c.add('G1 test', test !== null, !valid
    ? `the holdout registry stores no G1 test (got ${JSON.stringify(stored)}; need one of ${G1_TESTS.join(', ')})`
    : !agrees ? `the registry stores ${String(stored)}; the caller asked for ${input.g1Test}` : `stored in the registry: ${String(stored)}`);
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

  const ids = input.registry.map((t) => t.trialId);
  const keys = Object.keys(input.pboMatrix);
  const missing = ids.filter((id) => !Object.hasOwn(input.pboMatrix, id));
  const extra = keys.filter((k) => !ids.includes(k));
  const matrixOk = missing.length === 0 && extra.length === 0;
  const matrixProblem = `the daily P&L matrix must hold exactly the registry's ${ids.length} trials (missing ${missing.length}: ${missing.slice(0, 5).join(', ')}; not in registry ${extra.length}: ${extra.slice(0, 5).join(', ')})`;

  if (!input.registry.some((t) => t.trialId === input.selectedTrialId)) {
    c.add('registry', false, `selected trial "${input.selectedTrialId}" is not in the experiment registry`);
  } else if (!matrixOk) {
    c.add(test === 'dsr' ? 'DSR' : 'SPA', false, matrixProblem);
  } else {
    // Reported only (STATS-1c): the day-level DSR under raw, configuration-de-duplicated and effective N, the
    // block-bootstrap Sharpe p-value of the selected trial's days, and the joint SPA test.
    let diag = '';
    let spaP: number | null = null;
    let spaDetail = '';
    try {
      const configOf = Object.fromEntries(input.registry.map((t) => [t.trialId, t.configId ?? t.trialId]));
      const d = deflatedSharpeDaily(input.pboMatrix, input.selectedTrialId, configOf);
      metrics.dailySharpe = d.sharpe;
      metrics.dsrDays = d.days;
      metrics.dsrDaily = d.raw.dsr;
      metrics.dsrDailyDeduplicated = d.deduplicated.dsr;
      metrics.trialsDeduplicated = d.deduplicated.trials;
      metrics.dsrDailyEffective = d.effective.dsr;
      metrics.trialsEffective = d.effective.trials;
      const sb = sharpeBootstrap(input.pboMatrix[input.selectedTrialId]!, { rng: input.rng, ...(input.replicates === undefined ? {} : { replicates: input.replicates }) });
      metrics.dailySharpeP = sb.pNull;
      diag = `day-level DSR ${fmt(d.raw.dsr)} over ${d.raw.trials} trials and ${d.days} days, ${fmt(d.deduplicated.dsr)} over ${d.deduplicated.trials} configurations, `
        + `${fmt(d.effective.dsr)} over ${d.effective.trials} effective trials; day-level Sharpe ${fmt(d.sharpe)}, bootstrap p ${fmt(sb.pNull)}`;
    } catch (e) {
      diag = `diagnostics unavailable: ${(e as Error).message}`;
    }
    // The joint SPA test, in its own try: when it gates, it never depends on the diagnostics above.
    try {
      if (input.spa) {
        const spa = spaTest(
          { variants: input.pboMatrix, s0: input.spa.s0Daily, activeDays: input.spa.activeDays,
            registration: { seFloor: input.spa.seFloor, studentisation: SPA_STUDENTISATION, ...(input.spa.regimes ? { regimes: input.spa.regimes } : {}) } },
          { rng: input.rng, replicates: Math.max(input.replicates ?? DEFAULT_REPLICATES, Math.ceil(20 / SPA_ALPHA)), alpha: SPA_ALPHA },
        );
        // The selected configuration needs its own simultaneous evidence (step-down), not only a global rejection.
        spaP = spa.passing.includes(input.selectedTrialId) ? spa.pValue : 1;
        metrics.spaP = spa.pValue;
        metrics.spaStatistic = spa.statistic;
        spaDetail = `SPA over ${spa.variants.length} variants (${spa.excluded.length} left out for activity) and ${spa.days} days: p ${fmt(spa.pValue)} (max over blocks 3, 5, 7); `
          + `${input.selectedTrialId} ${spa.passing.includes(input.selectedTrialId) ? 'passes' : 'does not pass'} against zero and S0`;
      } else {
        spaDetail = 'SPA not run (no S0 calendar or activity counts)';
      }
    } catch (e) {
      spaDetail = `SPA unavailable: ${(e as Error).message}`;
    }
    // The per-trade DSR over every registered trial with clamped moments (skewness ≤ 0, kurtosis ≥ the registered floor):
    // the gate when 'dsr' is registered, a descriptive number otherwise.
    let dsrDetail = '';
    let dsrOk = false;
    try {
      const d = deflatedSharpe(returns, input.registry, { clamp: true });
      metrics.dsr = d.dsr;
      metrics.trials = d.trials;
      dsrOk = d.dsr >= th.dsrMin;
      dsrDetail = `deflated Sharpe ${fmt(d.dsr)} over ${d.trials} trials, moments clamped`;
    } catch (e) {
      dsrDetail = (e as Error).message;
    }
    if (test === 'spa') {
      c.add('SPA', spaP !== null && spaP < SPA_ALPHA, `${spaDetail} (need < ${SPA_ALPHA}); reported only: ${dsrDetail}; ${diag}`);
    } else if (test === 'dsr') {
      c.add('DSR', dsrOk, `${dsrDetail} (need >= ${th.dsrMin}); reported only: ${diag}; ${spaDetail}`);
    }
  }
  if (!matrixOk) {
    c.add('PBO', false, `PBO ${matrixProblem.replace('the daily P&L matrix', 'matrix')}`);
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
   * A trade without a creator or funder cluster fails the gate (missing evidence is the stricter outcome).
   */
  readonly trades: readonly HoldoutTrade[];
  /** The random control S0 on the same eligible candidates and days, one run per seed. */
  readonly controlRuns: readonly (readonly DayReturn[])[];
  /** Walk-forward trades of the same configuration: σ̂ for the closed-form check and the reported predictive interval. */
  readonly walkForward: readonly ClusteredReturn[];
  /** S0 on the walk-forward days, pooled over its seeds: the control n_power was simulated with. */
  readonly walkForwardControl: readonly DayReturn[];
  /** n_power from `simulateG2Power` on the walk-forward data with the registry's family size. */
  readonly power: G2PowerResult;
  /** G1 passed for this configuration: a precondition for opening the seal (a G1 fail keeps it sealed). */
  readonly g1Passed: boolean;
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
  /** Resampling units the interval was formed from: days, blocks of days, or clusters; null if none was formed. */
  readonly blocks: number | null;
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
 * CI against S0 above 0. The test is two-sided at each level, so the false-pass rate for a positive-edge claim is α/2
 * (one-sided 0.025 at 0.05). The level comes from the registry's attempt; the requirement is the number frozen before
 * any count; the seal opens only after the tail and a G1 pass. Size comes from the sealed counts; a universe short at
 * its cutoff is a spent attempt ('short') and "not proven". Every
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
  // Each universe's holdout attempt sets its family α in the registry (0.04 first, then 0.01 / 2^(k − 1)); a call tests
  // every universe at the smallest α among them, never above the familyAlpha threshold.
  const alphaOf = (holdoutId: string): number => {
    const e = registry.entries.find((x) => x.holdoutId === holdoutId);
    return Math.min(th.familyAlpha, e ? e.alpha : th.familyAlpha);
  };
  const alpha = Math.min(...input.universes.map((u) => alphaOf(u.holdoutId)), th.familyAlpha);
  const level0 = alpha / registry.familySize;
  const nowDay = dayFromNumber(Math.floor(input.nowMs / MS_PER_DAY));
  // p-values resolve the smallest Holm level: about 20 / level replicates.
  const replicates = input.replicates ?? DEFAULT_REPLICATES;
  const minReplicates = Math.ceil(20 / level0);

  // Integrity that needs no outcome and changes nothing.
  c.add('replicates', replicates >= minReplicates, `${replicates} bootstrap replicates (need >= 20 / ${fmt(level0)} = ${minReplicates})`);
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
    if (e && !e.burned) {
      c.add(`n_power seed ${u.universe}`, e.requirement !== null && u.power.seed === e.requirement.nPowerSeed,
        `n_power seed ${u.power.seed}, frozen ${e.requirement?.nPowerSeed ?? 'none'}`);
      c.add(`G1 ${u.universe}`, u.g1Passed, u.g1Passed ? 'G1 passed' : `G1 did not pass for ${u.configId}: the holdout stays sealed`);
    }
    c.add(`S0 ${u.universe}`, u.controlRuns.length >= th.minControlSeeds, `${u.controlRuns.length} S0 seeds (need >= ${th.minControlSeeds})`);
    c.add(`n_power ${u.universe}`, Math.abs(u.power.level - level0) < 1e-12,
      `n_power was simulated at level ${fmt(u.power.level)}, attempt α ${fmt(alpha)} over the registry's family of ${registry.familySize} needs ${fmt(level0)}`);
    const missingUnits = G2_SENSITIVITY_VARIANTS.filter((x) => !u.power.units.includes(x));
    c.add(`n_power units ${u.universe}`, missingUnits.length === 0,
      `n_power simulated without ${missingUnits.join(', ') || 'none'} (need every resampling unit of the rule)`);
    // The exact inputs (ordered, labelled walk-forward and S0 trades plus every setting), not a summary (audit S3).
    const wfNow = summarizeWalkForward(u.walkForward);
    const settings = u.power.settings;
    const inputsNow = settings ? g2PowerInputs(u.walkForward, u.walkForwardControl ?? [], settings) : null;
    c.add(`n_power inputs ${u.universe}`, inputsNow !== null && inputsNow === u.power.inputs && settings!.seed === u.power.seed,
      inputsNow === null ? 'n_power carries no settings: its inputs cannot be checked'
        : `n_power was simulated on walk-forward ${describeSummary(u.power.walkForward)}${inputsNow === u.power.inputs ? '' : ' with other trades, labels, control or settings'}; this universe's walk-forward is ${describeSummary(wfNow)}`);
    // The settings are pinned to fixed or registered values, never taken from the result itself (review B3).
    if (settings) {
      const off = [
        ...(settings.power >= N_POWER_MIN_POWER ? [] : [`power ${fmt(settings.power)} (need >= ${N_POWER_MIN_POWER})`]),
        ...(settings.targetMean <= N_POWER_MAX_TARGET_MEAN ? [] : [`target mean ${fmt(settings.targetMean)} (need <= ${N_POWER_MAX_TARGET_MEAN})`]),
        ...(settings.simulations >= N_POWER_MIN_SIMULATIONS ? [] : [`${settings.simulations} simulations (need >= ${N_POWER_MIN_SIMULATIONS})`]),
        ...(settings.replicates >= minReplicates ? [] : [`${settings.replicates} replicates (need >= ${minReplicates})`]),
        ...(settings.familySize === registry.familySize ? [] : [`family size ${settings.familySize} (the registry's is ${registry.familySize})`]),
        ...(Math.abs(settings.alpha - alpha) < 1e-12 ? [] : [`α ${fmt(settings.alpha)} (the attempt's is ${fmt(alpha)})`]),
        ...(G2_SENSITIVITY_VARIANTS.every((x) => settings.units.includes(x)) ? [] : ['not every resampling unit']),
      ];
      c.add(`n_power settings ${u.universe}`, off.length === 0, `n_power simulated with ${off.join(', ') || 'the required settings'}`);
    }
    // The chosen n confirmed on independent draws: its validation power may not sit significantly below the target.
    const val = u.power.validation;
    const goal = settings?.power ?? Number.NaN;
    const confirmed = val !== undefined && val.n === u.power.nPower && val.power >= goal - N_POWER_VALIDATION_Z * val.standardError;
    c.add(`n_power validated ${u.universe}`, confirmed, val === undefined
      ? 'n_power has no independent validation'
      : `n ${val.n}: power ${fmt(u.power.powerAtN)} ± ${fmt(u.power.standardError)} in the search, ${fmt(val.power)} ± ${fmt(val.standardError)} on independent draws (need >= ${fmt(goal)} − ${N_POWER_VALIDATION_Z}·SE)`);
    // A missing cluster label is missing evidence: the stricter outcome, fail, before the seal opens.
    const unclustered = u.trades.filter((t) => !t.creatorCluster || !t.funderCluster).length;
    c.add(`clusters ${u.universe}`, unclustered === 0, `${unclustered} trades without a creator or funder cluster (need 0)`);
    const wfUnclustered = u.walkForward.filter((t) => !t.creatorCluster || !t.funderCluster).length;
    c.add(`walk-forward clusters ${u.universe}`, wfUnclustered === 0, `${wfUnclustered} walk-forward trades without a creator or funder cluster (need 0)`);
  }
  if (c.failed.length > 0) return failWith();
  // The seal opens only after the observation tail has matured; before that nothing changes and nothing is proven.
  for (const u of input.universes) {
    const e = registry.entries.find((x) => x.holdoutId === u.holdoutId)!;
    c.add(`tail ${u.universe}`, nowDay >= e.tailEnd, `today ${nowDay}; the seal stays closed until ${e.tailEnd}`);
  }
  if (c.failed.length > 0) return { ...result('G2', c, 'not-proven', {}), universes: [], registry };

  // Size from the sealed counts alone, against the requirement frozen before any count was read. The frozen number is
  // the requirement; it may not sit below max(300, n_power, closed form) recomputed now.
  const sized = input.universes.map((u) => {
    const e = registry.entries.find((x) => x.holdoutId === u.holdoutId)!;
    const wf = u.walkForward.map((t) => t.rNet);
    const closed = wf.length >= 2 && sd(wf) > 0 ? nPower(sd(wf), 0.05, { alpha: level0 }) : 0;
    const computed = Math.max(th.minTradesFloor, u.power.nPower, closed);
    const required = e.requirement!.requiredTrades;
    c.add(`requirement ${u.universe}`, required >= computed,
      `frozen ${required} trades (need >= max(${th.minTradesFloor}, simulated n_power ${u.power.nPower}, closed form ${closed}) = ${computed})`);
    // The frozen days are the day requirement; they may not sit below the gate's MIN_DAYS.
    const days = e.requirement!.requiredDays;
    c.add(`requirement days ${u.universe}`, days >= MIN_DAYS, `frozen ${days} entry days (need >= ${MIN_DAYS})`);
    const ready = holdoutReady(e, required, days);
    c.add(`sample ${u.universe}`, ready,
      `${e.counts!.entries} sealed entries on ${e.counts!.entryDays} days at the cutoff (need >= ${required}, on >= ${days} days)`);
    return { u, e, required, ready, fits: required >= computed && days >= MIN_DAYS };
  });
  if (sized.some((x) => !x.fits)) return failWith();
  // A window short at its cutoff is a failed attempt: it is recorded as spent ('short') and is "not proven".
  for (const { e, ready } of sized) {
    if (!ready) registry = burnHoldout(registry, e.holdoutId, 'short', `${e.counts!.entries} entries on ${e.counts!.entryDays} days at the cutoff`).registry;
  }
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
    const step = openHoldout(registry, e.holdoutId, {
      configId: u.configId, ledgerHash: u.ledgerHash, requiredTrades: required, minDays: e.requirement!.requiredDays, nowMs: input.nowMs, nowDay, g1Passed: u.g1Passed,
    });
    registry = step.registry;
    if (!step.ok) {
      c.add(`seal ${u.universe}`, false, step.reason);
      return failWith();
    }
  }

  // Score: the G2 rule per universe, then Holm across the universes that entered.
  const opts = { rng: input.rng, replicates };
  // The primary rule (1-day blocks), then every other resampling unit (review STATS-1b): the universe's p is the
  // largest, so it passes only if every CI excludes zero. The intervals are reported at the family level (95%).
  const scored = entering.map(({ u }) => {
    const control = u.controlRuns.flat();
    const primary = g2Rule(u.trades, control, alpha, opts);
    const rest = primary.p < alpha ? g2Sensitivity(u.trades, control, alpha, opts, ['days-2', 'days-3', 'creator', 'funder']) : [];
    const rows: G2SensitivityRow[] = [
      { variant: 'days-1', blocks: primary.mean.days, lower: primary.mean.lower, upper: primary.mean.upper, diffVsS0Lower: primary.vsControl.lower, p: primary.p },
      ...rest.map((x) => ({ variant: x.variant, blocks: x.mean?.days ?? null, lower: x.mean?.lower ?? null, upper: x.mean?.upper ?? null, diffVsS0Lower: x.vsControl?.lower ?? null, p: x.p })),
    ];
    const weakest = rows.reduce((w, x) => (x.p > w.p ? x : w));
    return { ...primary, p: weakest.p, rows, weakest };
  });
  // Holm over the whole family fixed in the registry: universes that did not enter count as p = 1, so a universe scored
  // now, or one scored in a later call, is never tested at a looser level than its place in the full family allows.
  const familyP = [...scored.map((r) => r.p), ...Array<number>(registry.familySize - scored.length).fill(1)];
  const h = holm(familyP, alpha);
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
      + `weakest resampling ${r.weakest.variant} (${r.weakest.blocks ?? 'no'} units): 95% CI [${fmt(r.weakest.lower)}, ${fmt(r.weakest.upper)}], p ${fmt(r.p)} (need < Holm level ${fmt(level)} under every unit)`);
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
  /**
   * Hours from dryRunStartMs to the registered end. Decisions (candidates, entries, rejects, simulations) are cut at
   * registration.evaluateAtMs; outcomes of trades entered by then are read up to evaluateAtMs plus the outcome tail
   * (the G3 report tool's outcomeTailMs), so every judged trade can finish.
   */
  readonly dryRunHours: number;
  /** Net returns of the dry-run paper trades (the candidates live kept). */
  readonly dryRunReturns: readonly number[];
  /**
   * Creator cluster of each kept trade, aligned with dryRunReturns (decision-time facts). The veto-gap bounds are
   * cluster-robust over these (external audit S4): trades of one creator in a 48-hour run are not assumed independent.
   */
  readonly dryRunClusters: readonly string[];
  /** The backtest holdout the dry run is compared with. */
  readonly holdout: SampleSummary;
  /** The holdout's share of severe outcomes (`y_severe`: blocked, or a net return of −50% or worse). */
  readonly holdoutSevereRate: number;
  /** The agreement plan, registered before the run started. */
  readonly registration: G3Registration;
  /** When the run started (the injected clock's time); the plan must be registered before it. */
  readonly dryRunStartMs: number;
  /**
   * Every paper entry and exit built as a real transaction and simulated against mainnet (TEST-2): attempts,
   * successes, and the failures by error code.
   */
  readonly simulations: { readonly attempted: number; readonly succeeded: number; readonly errors: Readonly<Record<string, number>> };
  /**
   * One-sided lower bound of the holdout's mean net return at level 1 − α/4 (VETO_COMPOSITE_LEVEL), from the day-block
   * bootstrap of the holdout (`dayBlockMeanInterval(trades, level, 'lower', …)`) in the scoring stage. The level is
   * checked: a 95% bound would make the composite's simultaneous coverage fall below 95%.
   */
  readonly holdoutLower: { readonly value: number; readonly level: number };
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

/**
 * What "agrees" means for the dry run, fixed before it starts (supervisor ruling after external review, STATS-1b).
 * The thresholds can only tighten G3_DEFAULTS. Simulation error codes not listed here are a disagreement.
 */
export interface G3Registration {
  readonly registeredAtMs: number;
  /**
   * When the run is judged, fixed when the strategy is registered: the end of the holdout tail or 48 h after the start
   * if that is later (supervisor ruling, "Qualifying-run length"); never a stop chosen from results.
   */
  readonly evaluateAtMs: number;
  readonly thresholds: Partial<typeof G3_DEFAULTS>;
  readonly expectedSimulationErrors: readonly string[];
}

/** Paper outcomes of the live-only-vetoed candidates, as if entered. */
export interface VetoCounterfactuals {
  /** Net return of each scored vetoed candidate. */
  readonly returns: readonly number[];
  /** Creator cluster of each scored return, aligned with `returns`. */
  readonly clusters: readonly string[];
  /** Vetoed candidates whose outcome window is not fully observed yet. */
  readonly censored: number;
}

/**
 * Counterfactual scoring of live-only-vetoed candidates (ARCHITECTURE.md §14 G3, §16.3). The scoring stage labels each
 * vetoed candidate with the same triple-barrier configuration and execution model as the kept trades, from a paper
 * entry at its decision moment, exactly as it labels a kept trade; this collects those labels. The engine never sees them.
 */
export const scoreVetoCounterfactuals = (labels: readonly TripleBarrierLabel[], creatorClusters: readonly string[]): VetoCounterfactuals => {
  if (new Set(labels.map((l) => l.cfgId)).size > 1) throw new RangeError('veto counterfactuals must use one barrier configuration');
  if (creatorClusters.length !== labels.length) throw new RangeError(`${labels.length} labels but ${creatorClusters.length} creator clusters`);
  const returns: number[] = [];
  const clusters: string[] = [];
  let censored = 0;
  labels.forEach((l, i) => {
    if (l.censored || l.rNet === null) censored++;
    else {
      returns.push(l.rNet);
      clusters.push(creatorClusters[i]!);
    }
  });
  return { returns, clusters, censored };
};

/**
 * The retained-expectancy bound is a lower-bound safety claim built from four uncertain parts: the holdout lower bound,
 * the veto-rate upper bound, the gap bound and the fill-error bound (the execution allowance). Each is taken at α/4
 * (Bonferroni), so all four hold together with probability at least 95%. Before STATS-1g the fill bound was a separate
 * 95% bound beside three α/3 parts: 3·α/3 + 0.05 = 0.10, so only 90% coverage was established (external audit S1).
 * Wider bounds are the stricter direction here; the consistency ("agree") checks keep their own levels.
 */
export const VETO_COMPOSITE_PARTS = 4;
export const VETO_COMPOSITE_ALPHA = 0.05 / VETO_COMPOSITE_PARTS;
export const VETO_COMPOSITE_LEVEL = 1 - VETO_COMPOSITE_ALPHA;

/** Level of the joint reject-mix test; an "agree" test, so it is not widened (supervisor ruling). */
const REJECT_MIX_ALPHA = 0.05;

/**
 * G-test of goodness of fit (likelihood ratio, Sokal & Rohlf, Biometry, 4th ed., 2012, §17.2): the dry run's reject
 * counts against the shares the backtest predicts. G = 2·Σ O·ln(O/E), df = reasons − 1, p from χ²(df). A reason the
 * backtest never produced but the dry run did has E = 0: p = 0.
 */
export const rejectMixGTest = (
  observed: Readonly<Record<string, number>>,
  reference: Readonly<Record<string, number>>,
): { g: number; df: number; p: number } => {
  const reasons = [...new Set([...Object.keys(observed), ...Object.keys(reference)])].sort();
  const n = reasons.reduce((t, r) => t + (observed[r] ?? 0), 0);
  const refTotal = reasons.reduce((t, r) => t + (reference[r] ?? 0), 0);
  if (n === 0 || refTotal === 0) throw new RangeError('the G-test needs counts on both sides');
  let g = 0;
  for (const r of reasons) {
    const o = observed[r] ?? 0;
    const e = (n * (reference[r] ?? 0)) / refTotal;
    if (o > 0 && e === 0) return { g: Infinity, df: reasons.length - 1, p: 0 };
    if (o > 0) g += 2 * o * Math.log(o / e);
  }
  const df = reasons.length - 1;
  return { g, df, p: df === 0 ? 1 : incompleteGammaUpper(df / 2, Math.max(0, g) / 2) };
};

/**
 * Cluster-robust variance of a sample mean with the Bell–McCaffrey small-sample correction (CR2; Bell & McCaffrey,
 * Survey Methodology 28(2), 2002; Pustejovsky & Tipton, JBES 36(4), 2018), and its Bell–McCaffrey degrees of freedom
 * (Imbens & Kolesár, REStat 98(4), 2016). For a mean the hat matrix of cluster g is J/n, so CR2 scales each cluster's
 * residual sum by (1 − n_g/n)^−½: V = Σ_g (Σ_{i∈g} (x_i − x̄))² / (1 − n_g/n) / n². The df is (tr M)² / tr(M²) for
 * M_gh = c_g c_h (δ_gh n_g − n_g n_h / n), c_g = (1 − n_g/n)^−½, under a working model of independent equal-variance
 * trades: tr M = n and tr(M²) = Σ n_g² + (Σ r_g)² − Σ r_g², r_g = n_g² / (n − n_g). With equal cluster sizes the df is
 * G − 1; with every trade its own cluster V = s²/n and the df is n − 1. One dominant creator lowers the df well below
 * G − 1, which is what CR1 with G − 1 missed (STATS-1g review B1).
 */
const clusterMeanVariance = (xs: readonly number[], clusters: readonly string[]): { variance: number; df: number; clusters: number } => {
  const n = xs.length;
  const m = mean(xs);
  const sums = new Map<string, { sum: number; size: number }>();
  xs.forEach((x, i) => {
    const c = sums.get(clusters[i]!) ?? { sum: 0, size: 0 };
    sums.set(clusters[i]!, { sum: c.sum + (x - m), size: c.size + 1 });
  });
  const g = sums.size;
  if (g < 2) return { variance: Number.NaN, df: Number.NaN, clusters: g };
  let ss = 0;
  let sizeSq = 0;
  let r = 0;
  let rSq = 0;
  for (const { sum, size } of sums.values()) {
    ss += (sum * sum) / (1 - size / n);
    sizeSq += size * size;
    const rg = (size * size) / (n - size);
    r += rg;
    rSq += rg * rg;
  }
  return { variance: ss / (n * n), df: (n * n) / (sizeSq + r * r - rSq), clusters: g };
};

/**
 * One-sided (1 − α) cluster-robust Welch bounds on mean(a) − mean(b) (external audit S4, review B1): CR2 variances,
 * Bell–McCaffrey df per side, combined by Satterthwaite. Equals the classic Welch bound when every observation is its
 * own cluster.
 */
export const clusterWelchBounds = (
  a: readonly number[], ca: readonly string[], b: readonly number[], cb: readonly string[], alpha = 0.05,
): { diff: number; lower: number; upper: number; se: number; df: number; clustersA: number; clustersB: number } => {
  if (ca.length !== a.length || cb.length !== b.length) throw new RangeError('every observation needs its cluster');
  const diff = mean(a) - mean(b);
  const va = clusterMeanVariance(a, ca);
  const vb = clusterMeanVariance(b, cb);
  if (va.clusters < 2 || vb.clusters < 2) throw new RangeError('cluster-robust bounds need at least two clusters on each side');
  const se = Math.sqrt(va.variance + vb.variance);
  const df = (va.variance + vb.variance) ** 2 / (va.variance ** 2 / va.df + vb.variance ** 2 / vb.df);
  const base = { diff, se, df, clustersA: va.clusters, clustersB: vb.clusters };
  if (!(se > 0)) return { ...base, lower: diff, upper: diff };
  const t = studentTQuantile(1 - alpha, df);
  return { ...base, lower: diff - t * se, upper: diff + t * se };
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
 * G3 Live dry-run consistency, ARCHITECTURE.md §14: does the dry run agree with the backtest? "Agrees" is registered
 * before the run (G3Registration); every comparison has a minimum sample, and below it the answer is inconclusive
 * ('not-proven': extend the run), never agreement. The notes say agrees, disagrees or inconclusive. It also bounds the live-only veto
 * bias (review STATS-1b): the backtest keeps trades live would veto, so the retained strategy's expectancy is the holdout
 * mean minus v·Δ, Δ the mean of vetoed candidates (scored as if entered) minus the mean of kept trades. The gate needs
 * holdoutLower − v⁺·max(0, Δ⁺) − execution allowance > 0, and v⁺·|Δ|⁺ ≤ 5 points. Each of the four components is
 * at α/4 (VETO_COMPOSITE_ALPHA): the holdout's one-sided lower bound, v⁺ the one-sided Clopper–Pearson upper bound,
 * Δ⁺ the one-sided Welch upper bound for the selection allowance (with |Δ|⁺ from the two-sided bounds, α/8 a side, for
 * the bias) and the fill-error bound in the execution allowance. The gap bounds are cluster-robust by creator (external
 * audit S4): trades of one creator are not assumed independent, and with every trade its own creator the bound is the
 * classic Welch bound. With fewer than 10 scored vetoed or kept trades, unlabelled trades or fewer than two creators a
 * side, Δ is the worst case the return range allows (cap − RETURN_FLOOR), never an assumed value. A failure that more
 * run time can clear (missing, censored or too few counterfactuals; a bound that fails while the point estimate passes)
 * is "not proven": extend the dry run. The consistency ("agree") checks still treat kept trades as independent: that
 * makes their intervals narrower, so it can only add disagreements, never hide one.
 */
export const gateG3 = (input: G3Input, overrides?: Partial<typeof G3_DEFAULTS>): GateResult => {
  // The registered plan tightens the defaults; overrides can only tighten the plan further.
  const th = tighten('G3', tighten('G3', G3_DEFAULTS, G3_DIR, input.registration.thresholds), G3_DIR, overrides);
  const c = new Checks();
  const notes: string[] = [];
  /** Failed checks that a longer run can clear: too little evidence is inconclusive, never agreement. */
  const extend = new Set<string>();
  const short = (name: string, detail: string): void => {
    c.add(name, false, `${detail}: inconclusive, extend the dry run`);
    extend.add(name);
  };
  const m = input.dryRunReturns.length;
  const metrics: Record<string, number | null> = { dryRunTrades: m, dryRunHours: input.dryRunHours };
  c.add('qualifying run', input.qualifyingRun, input.qualifyingRun ? 'the qualifying dry run' : 'a rehearsal run counts for no gate');
  c.add('registration', input.registration.registeredAtMs <= input.dryRunStartMs,
    `agreement plan registered at ${input.registration.registeredAtMs}, run started at ${input.dryRunStartMs} (need registered before the run)`);
  c.add('duration', input.dryRunHours >= th.minHours, `${fmt(input.dryRunHours)} h (need >= ${th.minHours})`);
  // G3 is judged at its registered end, neither earlier (a run judged early could stop on a good stretch) nor later (a
  // run judged late could wait for one). The inputs are cut at evaluateAtMs (the G3 report tool does the cut); the
  // judged data must end there, within G3_END_TOLERANCE_MS.
  const runEndMs = input.dryRunStartMs + input.dryRunHours * MS_PER_HOUR;
  const endAt = input.registration.evaluateAtMs;
  const reached = runEndMs >= endAt - G3_END_TOLERANCE_MS;
  const cut = runEndMs <= endAt + G3_END_TOLERANCE_MS;
  c.add('registered end', endAt >= input.dryRunStartMs + th.minHours * MS_PER_HOUR && reached && cut,
    `run ends ${runEndMs}, registered end ${endAt} (need the judged data to end there within ${(G3_END_TOLERANCE_MS / MS_PER_HOUR) * 60} min, cut at it, and it at least ${th.minHours} h after the start)`);
  if (!reached) extend.add('registered end');
  c.add('parity', input.parityTestPassed, input.parityTestPassed ? 'parity passed on the recorded dry-run data' : 'parity failed on the recorded dry-run data');

  // Paper outcomes against the holdout's expected distribution: the mean and the severe-outcome share.
  if (m >= th.minPaperTradesForMean) {
    const dm = mean(input.dryRunReturns);
    const pi = meanPredictiveInterval(input.holdout, m, th.meanPredictiveLevel);
    metrics.dryRunMean = dm;
    metrics.predictiveLower90 = pi.lower;
    metrics.predictiveUpper90 = pi.upper;
    c.add('mean', dm >= pi.lower && dm <= pi.upper,
      `dry-run mean ${fmt(dm)} vs holdout ${fmt(100 * th.meanPredictiveLevel)}% predictive interval [${fmt(pi.lower)}, ${fmt(pi.upper)}] for ${m} trades`);
    const severe = input.dryRunReturns.filter((x) => x <= SEVERE_RETURN).length;
    const ci = clopperPearsonInterval(severe, m);
    metrics.dryRunSevereRate = severe / m;
    c.add('severe share', input.holdoutSevereRate >= ci.lower && input.holdoutSevereRate <= ci.upper,
      `dry run ${severe}/${m} severe, 95% interval [${fmt(ci.lower)}, ${fmt(ci.upper)}] vs holdout ${fmt(input.holdoutSevereRate)}`);
  } else {
    short('paper outcomes', `${m} paper trades (need >= ${th.minPaperTradesForMean})`);
  }

  const k = input.candidates;
  metrics.candidateRateDryRun = k.dryRunCount / k.dryRunHours;
  metrics.candidateRateBacktest = k.backtestCount / k.backtestHours;
  if (k.dryRunCount < th.minCandidatesForRate) {
    short('candidate rate', `${k.dryRunCount} dry-run candidates (need >= ${th.minCandidatesForRate})`);
  } else {
    const rate = ratesConsistent(k.dryRunCount, k.dryRunHours, k.backtestCount, k.backtestHours);
    c.add('candidate rate', rate.consistent,
      `${fmt(metrics.candidateRateDryRun)}/h vs ${fmt(metrics.candidateRateBacktest)}/h (expected share ${fmt(rate.expectedShare)} vs 95% interval [${fmt(rate.lower)}, ${fmt(rate.upper)}])`);
  }

  const dryTotal = Object.values(input.rejectMix.dryRun).reduce((s, x) => s + x, 0);
  const btTotal = Object.values(input.rejectMix.backtest).reduce((s, x) => s + x, 0);
  if (btTotal === 0) {
    c.add('reject mix', false, 'no backtest rejects to compare');
  } else if (dryTotal < th.minRejectsForMix) {
    short('reject mix', `${dryTotal} dry-run rejects (need >= ${th.minRejectsForMix})`);
  } else {
    const reasons = [...new Set([...Object.keys(input.rejectMix.dryRun), ...Object.keys(input.rejectMix.backtest)])].sort();
    for (const r of reasons) {
      const kDry = input.rejectMix.dryRun[r] ?? 0;
      const share = (input.rejectMix.backtest[r] ?? 0) / btTotal;
      const ci = clopperPearsonInterval(kDry, dryTotal);
      c.add(`reject mix ${r}`, share >= ci.lower && share <= ci.upper,
        `dry run ${kDry}/${dryTotal}, 95% interval [${fmt(ci.lower)}, ${fmt(ci.upper)}] vs backtest share ${fmt(share)}`);
    }
    // One joint test of the whole reason distribution beside the per-reason intervals; failing either disagrees.
    const g = rejectMixGTest(input.rejectMix.dryRun, input.rejectMix.backtest);
    metrics.rejectMixG = g.g;
    metrics.rejectMixP = g.p;
    c.add('reject mix joint', g.p >= REJECT_MIX_ALPHA,
      `G-test over ${g.df + 1} reasons: G ${fmt(g.g)}, df ${g.df}, p ${fmt(g.p)} (need >= ${REJECT_MIX_ALPHA})`);
  }

  // Executable amounts (TEST-2's bounds: median <= 0.5 points, each <= 2 points). The fill-error bound is the fourth
  // part of the retained-expectancy composite, so it is one-sided at 1 − α/4 (VETO_COMPOSITE_ALPHA).
  let fillUpper = Infinity;
  let fillMean = Infinity;
  const abs = input.fillDifferences.map(Math.abs);
  if (abs.length > 0) {
    fillMean = mean(abs);
    fillUpper = abs.length >= 2 ? fillMean + studentTQuantile(VETO_COMPOSITE_LEVEL, abs.length - 1) * sd(abs) / Math.sqrt(abs.length) : Math.max(...abs);
    metrics.fillDiffMedian = median(abs);
    metrics.fillDiffMax = Math.max(...abs);
  }
  if (abs.length > 0 && metrics.fillDiffMax! > th.fillDiffMax) {
    c.add('fills', false, `largest |paper − simulated| ${fmt(metrics.fillDiffMax)} (need each <= ${th.fillDiffMax})`);
  } else if (abs.length < th.minFills) {
    short('fills', `${abs.length} simulated fills (need >= ${th.minFills})`);
  } else {
    c.add('fills', metrics.fillDiffMedian! <= th.fillDiffMedianMax,
      `median |paper − simulated| ${fmt(metrics.fillDiffMedian)} (need <= ${th.fillDiffMedianMax}), largest ${fmt(metrics.fillDiffMax)}`);
  }

  // Transaction behaviour: simulation success and the error mix.
  const sim = input.simulations;
  const simFailed = sim.attempted - sim.succeeded;
  const errTotal = Object.values(sim.errors).reduce((s, x) => s + x, 0);
  if (!(sim.succeeded >= 0 && simFailed >= 0 && errTotal === simFailed)) {
    c.add('simulations', false, `${sim.succeeded} of ${sim.attempted} succeeded but ${errTotal} errors are listed (need every failure listed once)`);
  } else {
    const unexpected = Object.entries(sim.errors).filter(([code, n]) => n > 0 && !input.registration.expectedSimulationErrors.includes(code)).map(([code, n]) => `${code} ×${n}`);
    c.add('simulation errors', unexpected.length === 0, unexpected.length === 0 ? 'only registered error codes' : `unregistered error codes: ${unexpected.join(', ')}`);
    if (sim.attempted < th.minSimulations) {
      short('simulations', `${sim.attempted} simulated transactions (need >= ${th.minSimulations})`);
    } else {
      metrics.simSuccessRate = sim.succeeded / sim.attempted;
      c.add('simulations', metrics.simSuccessRate >= th.simSuccessMin,
        `${sim.succeeded}/${sim.attempted} = ${fmt(metrics.simSuccessRate)} simulated successfully (need >= ${th.simSuccessMin})`);
    }
  }

  const v = input.liveOnlyVetoes;
  if (v.eligible === 0) {
    c.add('live-only vetoes', false, 'no eligible candidates in the run');
    return { ...result('G3', c, statusFrom(c), metrics), notes: [...notes, 'disagrees'] };
  }
  const vRate = v.vetoed / v.eligible;
  const vUpper = clopperPearsonUpper(v.vetoed, v.eligible);
  metrics.liveOnlyVetoRate = vRate;
  metrics.liveOnlyVetoUpper95 = vUpper;
  // The composite's own veto-rate bound, at α/4.
  const vComposite = clopperPearsonUpper(v.vetoed, v.eligible, VETO_COMPOSITE_ALPHA);
  metrics.vetoRateUpperComposite = vComposite;
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
  // Cluster labels for the cluster-robust gap: one per scored vetoed and kept trade, none empty. Missing labels fail.
  const labelled = cf.clusters?.length === scored && input.dryRunClusters?.length === m
    && [...cf.clusters, ...input.dryRunClusters].every((x) => typeof x === 'string' && x !== '');
  if (!labelled) c.add('veto clusters', false, `${cf.clusters?.length ?? 0} cluster labels for ${scored} scored vetoed and ${input.dryRunClusters?.length ?? 0} for ${m} kept trades (need one non-empty creator cluster each)`);
  const clusterCount = (xs: readonly string[] | undefined) => new Set(xs ?? []).size;
  const enoughClusters = labelled && clusterCount(cf.clusters) >= 2 && clusterCount(input.dryRunClusters) >= 2;
  const measured = complete && labelled && enoughClusters && scored >= th.minVetoedForGap && m >= th.minKeptForGap;
  // Δ = vetoed − kept. Unmeasured: the worst gap the return range allows, in either direction.
  let gapUpper = worstGap;
  let gapAbsUpper = worstGap;
  let gapPoint: number | null = null;
  if (measured) {
    const one = clusterWelchBounds(cf.returns, cf.clusters, input.dryRunReturns, input.dryRunClusters, VETO_COMPOSITE_ALPHA);
    const two = clusterWelchBounds(cf.returns, cf.clusters, input.dryRunReturns, input.dryRunClusters, VETO_COMPOSITE_ALPHA / 2);
    metrics.vetoGapClustersVetoed = one.clustersA;
    metrics.vetoGapClustersKept = one.clustersB;
    gapPoint = one.diff;
    gapUpper = Math.min(one.upper, worstGap);
    gapAbsUpper = Math.min(Math.max(Math.abs(two.upper), Math.abs(two.lower)), worstGap);
  } else {
    notes.push(`veto gap not measured (${scored} vetoed scored, ${m} kept; need >= ${th.minVetoedForGap} and >= ${th.minKeptForGap}, all scored, labelled and on >= 2 creator clusters each): the worst case ${fmt(worstGap)} is used`);
  }
  metrics.vetoGap = gapPoint;
  metrics.vetoGapUpper = gapUpper;
  metrics.vetoGapAbsUpper = gapAbsUpper;
  const bias = vComposite * gapAbsUpper;
  const biasPoint = gapPoint === null ? null : vRate * Math.abs(gapPoint);
  metrics.vetoBiasUpper = bias;
  if (!c.add('veto bias', bias <= th.vetoBiasMax,
    `v⁺·|Δ|⁺ at α/4 = ${fmt(vComposite)} × ${fmt(gapAbsUpper)} = ${fmt(bias)}${measured ? '' : ' (worst-case gap)'} (need <= ${th.vetoBiasMax})`)
    && !(biasPoint !== null && biasPoint > th.vetoBiasMax)) extend.add('veto bias');

  const levelOk = Math.abs(input.holdoutLower.level - VETO_COMPOSITE_LEVEL) < 1e-12;
  c.add('holdout bound level', levelOk,
    `holdout lower bound at one-sided ${fmt(input.holdoutLower.level)} (need ${fmt(VETO_COMPOSITE_LEVEL)}, α/4 of the retained-expectancy composite)`);
  const selection = vComposite * Math.max(0, gapUpper);
  const execution = 2 * fillUpper; // an entry and an exit per trade
  const retainedLower = input.holdoutLower.value - selection - execution;
  const retainedPoint = input.holdout.mean - vRate * Math.max(0, gapPoint ?? 0) - 2 * fillMean;
  metrics.selectionAllowance = selection;
  metrics.executionAllowance = execution;
  metrics.retainedLower = retainedLower;
  const retainedOk = retainedLower > th.retainedLowerMin;
  // The point estimate already fails only when the gap was measured; otherwise more evidence may clear it.
  const retainedExtend = !retainedOk && retainedPoint > th.retainedLowerMin;
  c.add('retained expectancy', retainedOk,
    `holdout lower ${fmt(input.holdoutLower.value)} − selection ${fmt(selection)} − execution ${fmt(execution)} = ${fmt(retainedLower)} (need > ${th.retainedLowerMin})`
    + (retainedExtend ? `; point estimate ${fmt(retainedPoint)}: extend the dry run` : ''));
  if (retainedExtend) extend.add('retained expectancy');

  const failed = c.list.filter((x) => !x.passed).map((x) => x.name);
  const status: GateStatus = failed.length === 0 ? 'pass' : failed.every((f) => extend.has(f)) ? 'not-proven' : 'fail';
  notes.push(status === 'pass' ? 'agrees' : status === 'fail' ? 'disagrees' : 'inconclusive: extend the dry run');
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
    // The same detector restarted on the last DEMOTION_TRAILING_DAYS trading days (days with returns).
    const days = [...new Set(input.returns.map((t) => t.day))];
    const from = days[Math.max(0, days.length - DEMOTION_TRAILING_DAYS)];
    const recent = from === undefined ? [] : input.returns.filter((t) => t.day >= from);
    const trail = reverseEProcess(recent, { cap: input.returnCap, threshold: th.reverseWealth });
    metrics.trailingReverseWealthMax = trail.maxWealth;
    c.add(`reverse e-process (last ${DEMOTION_TRAILING_DAYS} days)`, trail.maxWealth < th.reverseWealth,
      `max reverse wealth over the last ${Math.min(days.length, DEMOTION_TRAILING_DAYS)} trading days ${fmt(trail.maxWealth)} (demote at >= ${th.reverseWealth})`);
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
  /** Start (inclusive) and end (exclusive) of the holdout window the G2 proof rests on. */
  readonly holdoutStartMs: number;
  readonly holdoutEndMs: number;
  readonly platformChanges: readonly PlatformChange[];
  /** The qualifying dry run and its G3 result against the holdout; null when none has run. */
  readonly dryRun: { readonly qualifyingRun: boolean; readonly startMs: number; readonly g3: GateResult } | null;
  /**
   * The before/after economics report for a platform change that falls inside the holdout window but is marked
   * `economicsUnchanged: true` (e.g. B5, UPG-1): it shows trade economics unchanged across the boundary within the
   * window. Required only when such a change is inside; null otherwise.
   */
  readonly insideReport?: { readonly produced: boolean; readonly economicsUnchanged: boolean } | null;
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
  // A change inside the window that changed economics (or was not reviewed) splits the holdout across two regimes and
  // fails it. A change marked economics-unchanged (B5/UPG-1) may lie inside, but then the before/after report across
  // its boundary is required (supervisor ruling, review of #52).
  const inside = input.platformChanges.filter((x) => x.atMs > input.holdoutStartMs && x.atMs < input.holdoutEndMs);
  const insideBreaking = inside.filter((x) => x.economicsUnchanged !== true);
  const insideUnchanged = inside.filter((x) => x.economicsUnchanged === true);
  c.add('holdout regime', insideBreaking.length === 0,
    insideBreaking.length === 0 ? 'no economics-changing platform change inside the holdout window'
      : `${insideBreaking.map((x) => `${x.id} (${x.economicsUnchanged === null ? 'not reviewed' : 'economics changed'})`).join(', ')} inside the holdout window`);
  let insideReportMissing = false;
  if (insideUnchanged.length > 0) {
    const r = input.insideReport;
    const ok = r !== null && r !== undefined && r.produced && r.economicsUnchanged;
    c.add('inside-change report', ok,
      ok ? `${insideUnchanged.map((x) => x.id).join(', ')} inside the window; before/after report shows economics unchanged`
        : `${insideUnchanged.map((x) => x.id).join(', ')} inside the window needs a before/after report showing economics unchanged${r && r.produced && !r.economicsUnchanged ? ' (the report found a change)' : ''}`);
    if (!ok && !(r && r.produced && !r.economicsUnchanged)) insideReportMissing = true;
  }
  const done = (status: GateStatus): RevalidationResult => ({
    passed: status === 'pass', status, reasons: c.failed, checks: c.list, pendingChanges: pending.map((x) => x.id),
  });
  const regimeStatus = (): GateStatus => {
    const failed = c.list.filter((x) => !x.passed).map((x) => x.name);
    if (failed.length === 0) return 'pass';
    // A missing-but-promised inside report is "not proven" (produce it); a breaking change inside is a hard fail.
    return failed.every((f) => f === 'inside-change report' && insideReportMissing) ? 'not-proven' : 'fail';
  };
  if (pending.length === 0) {
    c.add('changes', true, 'no platform change after the holdout');
    return done(regimeStatus());
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
  if (insideReportMissing) missing.add('inside-change report');
  const failed = c.list.filter((x) => !x.passed).map((x) => x.name);
  return done(failed.length === 0 ? 'pass' : failed.every((f) => missing.has(f)) ? 'not-proven' : 'fail');
};
