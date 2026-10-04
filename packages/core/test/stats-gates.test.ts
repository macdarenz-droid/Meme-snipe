// Every gate has a passing and a failing fixture; thresholds can be tightened but never loosened.
import { describe, expect, test } from 'vitest';
import {
  createRng, deflatedSharpe, deflatedSharpeDaily, spaTest, DEMOTION_TRAILING_DAYS, evaluateDemotion, G2_SENSITIVITY_VARIANTS, G3_DEFAULTS, rejectMixGTest, studentTQuantile, variance, gateG0, gateG1, gateG2, gateG3, gateG4, gateG5, mean, sd, sharpeRatio,
  burnHoldout, createHoldoutRegistry, freezeRequirement, g2PowerInputs, type G2PowerSettings, type ClusteredReturn, type DayReturn, nPower, registerHoldout, summarizeWalkForward, type WalkForwardSummary, sealHoldout, type DemotionInput, type HoldoutRegistry, type G0Input, type G1Input, type G2Input, type G2PowerResult, type G2Universe,
  type G3Input, type G4Input, type G5Input, type TradeOutcome, type HoldoutTrade, type TripleBarrierLabel,
  clopperPearsonUpper, evaluateRevalidation, VETO_COMPOSITE_LEVEL, VETO_COMPOSITE_ALPHA, VETO_COMPOSITE_PARTS, clusterWelchBounds, g2Sensitivity, RETURN_FLOOR, scoreVetoCounterfactuals,
  type RevalidationInput, G1_TESTS, G2_DEFAULTS, MIN_DAYS, REQUIREMENT_FLOOR, CAPPED_ESTIMAND, MAX_RETURN_CAP, fisherGreater, VETO_TAIL_ALPHA, HOLDOUT_LOWER_LEVEL,
} from '../src/stats/index.ts';
import { EXIT_UNIVERSES, KNOWN_PLATFORM_CHANGES, RESEARCH_CONFIG, TRIAL_POLICY } from '../src/config/index.ts';
import { bracketTrades, dayKey, type DayTrade } from './stats-fixtures.ts';

const DAY = 86_400_000;
const HOUR = DAY / 24;
const NOW = 1_790_000_000_000;

const g0Pass: G0Input = {
  survivorshipFree: true, secondSourceCoverage: 0.97, undecodedMigrationsReported: true, leakTestPassed: true, shiftTestPassed: true,
  replayLogHashes: Array(10).fill('abc'), parityTestPassed: true, labelsScoredSeparately: true, labelCoverageAuditPassed: true,
};

describe('G0 data and engine validity', () => {
  test('passes when every check holds', () => {
    const r = gateG0(g0Pass);
    expect(r).toMatchObject({ gate: 'G0', passed: true, status: 'pass', reasons: [] });
  });
  test('fails when undecoded migrations are not counted and reported', () => {
    expect(gateG0({ ...g0Pass, undecodedMigrationsReported: false }).reasons[0]).toMatch(/^undecoded/);
  });
  test('fails on a non-deterministic replay, low coverage or a failed leak test', () => {
    const r = gateG0({ ...g0Pass, replayLogHashes: [...Array(9).fill('abc'), 'abd'], secondSourceCoverage: 0.9, leakTestPassed: false });
    expect(r.passed).toBe(false);
    expect(r.reasons.map((x) => x.split(':')[0])).toEqual(['coverage', 'leak test', 'replays']);
    expect(gateG0({ ...g0Pass, replayLogHashes: Array(9).fill('abc') }).passed).toBe(false);
  });
});

// Walk-forward fixture: 40 days × 15 trades at +10% (bracket model), a few blocked exits, a random control S0 at −20%.
const wf: DayTrade[] = bracketTrades(21, 0.1, 40, 15).map((t, i) => ({ ...t, blocked: i % 120 === 0 && t.rNet === -1 }));
const control = bracketTrades(22, -0.2, 40, 15).map(({ day, rNet }) => ({ day, rNet }));
const registry = Array.from({ length: 20 }, (_, i) => ({ trialId: `t${i}`, sharpe: 0.05 + 0.004 * i, nTrades: 600 }));
const dailyOf = (ts: readonly DayTrade[]): number[] => [...new Set(ts.map((t) => t.day))].map((d) => mean(ts.filter((t) => t.day === d).map((t) => t.rNet)));
// Keyed by trialId: the selected trial t19 wins every day; the other 19 registry trials trail it by 10 points a day.
const matrixFor = (ts: readonly DayTrade[]): Record<string, number[]> => {
  const daily = dailyOf(ts);
  return Object.fromEntries(registry.map((t, k) => [t.trialId, t.trialId === 't19' ? daily : daily.map((x, i) => x - 0.1 + 0.02 * Math.sin(i + k))]));
};
const winnerDaily = dailyOf(wf);
const pboMatrix = matrixFor(wf);
// S0 at −20% a day on the walk-forward calendar; every variant traded on all 40 days.
const spaInputs = { s0Daily: dailyOf(control.map((t) => ({ ...t, ySevere: false, blocked: false }))), activeDays: Object.fromEntries(registry.map((t) => [t.trialId, 40])), seFloor: 1e-9 };
// G1's test is the one stored in the holdout registry (created with the plan): SPA, the owner's decision of 2026-10-04.
const g1Pass = (): G1Input => ({
  scenario: 'conservative', rulesRegisteredBeforeHoldout: true, trades: wf, control, selectedTrialId: 't19', registry,
  pboMatrix, pboBlocks: 8, modelUsed: false, calibrationSlope: null, rng: createRng(1), replicates: 1000,
  holdoutRegistry: createHoldoutRegistry(1, 'spa'), spa: spaInputs,
});
/** A registry that stores the clamped per-trade DSR: the path the owner can still select. */
const g1Dsr = (): G1Input => ({ ...g1Pass(), holdoutRegistry: createHoldoutRegistry(1, 'dsr') });

describe('G1 walk-forward', () => {
  test('passes a strong, spread-out edge', () => {
    const r = gateG1(g1Pass());
    expect(r.reasons).toEqual([]);
    expect(r.passed).toBe(true);
    expect(r.metrics.dsr!).toBeGreaterThanOrEqual(0.95);
    expect(r.metrics.pbo).toBe(0);
  });
  test('fails a zero-edge strategy on the bound, the registered significance test (SPA, or DSR when registered), concentration and S0', () => {
    const flat = bracketTrades(23, 0, 40, 15);
    for (const [g1, test] of [[g1Pass, 'SPA'], [g1Dsr, 'DSR']] as const) {
      const r = gateG1({ ...g1(), trades: flat, control: bracketTrades(24, 0, 40, 15), pboMatrix: matrixFor(flat) });
      expect(r.passed).toBe(false);
      const failed = r.reasons.map((x) => x.split(':')[0]);
      expect(failed).toContain('mean');
      expect(failed).toContain(test);
      expect(failed).toContain('S0');
    }
  });
  test('fails a non-conservative scenario, a late registration, a missing calibration and an unregistered trial', () => {
    const r = gateG1({ ...g1Pass(), scenario: 'base', rulesRegisteredBeforeHoldout: false, modelUsed: true, selectedTrialId: 'nope' });
    expect(r.reasons.map((x) => x.split(':')[0])).toEqual(['scenario', 'pre-registration', 'registry', 'calibration']);
  });
  test('fails when one day carries the P&L or blocked exits are too frequent', () => {
    const lucky = wf.map((t, i) => (i < 15 ? { ...t, rNet: t.rNet + 5 } : t));
    const rl = gateG1({ ...g1Pass(), trades: lucky });
    expect(rl.reasons.join(" | ")).toContain("best day");
    const blocky = wf.map((t, i) => ({ ...t, blocked: i % 20 === 0 })); // 30 of 600: upper bound about 6.8%
    const rb = gateG1({ ...g1Pass(), trades: blocky });
    expect(rb.reasons.join(" | ")).toContain("blocked exits");
  });
  test('the DSR gate clamps the moments: positive skew and thin tails cannot carry a pass (review STATS-1c)', () => {
    // A two-point return (+32.5% in 3 of 10 trades, −10% otherwise): skewness 0.87, kurtosis 1.76. Unclamped, both
    // flatter the PSR to 0.9509; clamped to skewness 0 and kurtosis 3, it is 0.9388, under 0.95.
    const twoPoint = Array.from({ length: 600 }, (_, i) => ({ day: dayKey(Math.floor(i / 15)), rNet: i % 10 < 3 ? 0.325 : -0.1, ySevere: false, blocked: false }));
    const returns = twoPoint.map((t) => t.rNet);
    expect(deflatedSharpe(returns, registry).dsr).toBeGreaterThanOrEqual(0.95);
    expect(deflatedSharpe(returns, registry, { clamp: true }).dsr).toBeLessThan(0.95);
    const r = gateG1({ ...g1Dsr(), trades: twoPoint, pboMatrix: matrixFor(twoPoint) });
    expect(r.metrics.dsr!).toBeCloseTo(deflatedSharpe(returns, registry, { clamp: true }).dsr, 12);
    expect(r.reasons.join(' | ')).toMatch(/DSR: deflated Sharpe 0\.93\d* over 20 trials, moments clamped/);
  });
  test('the PBO matrix must hold exactly the registry trials, the selected one included', () => {
    const { t3: _a, t4: _b, ...subset } = pboMatrix;
    expect(gateG1({ ...g1Pass(), pboMatrix: subset }).reasons.join()).toMatch(/PBO: PBO matrix must hold exactly the registry's 20 trials \(missing 2/);
    const { t19: _c, ...noSelected } = pboMatrix;
    expect(gateG1({ ...g1Pass(), pboMatrix: noSelected }).reasons.join()).toMatch(/missing 1: t19/);
    expect(gateG1({ ...g1Pass(), pboMatrix: { ...pboMatrix, stranger: winnerDaily } }).reasons.join()).toMatch(/not in registry 1: stranger/);
  });
  // STATS-1c (revised ruling 1): G1 keeps the per-trade DSR; moving to days can raise or lower PSR, so the day-level
  // DSR is reported only. While the DSR gates, its moments are clamped (tighten-only, ruling C).
  test('the gate is the per-trade DSR with clamped moments; the day-level DSR is reported only', () => {
    const corr = bracketTrades(25, 0.06, 40, 15, 0.4);
    const r = gateG1({ ...g1Dsr(), trades: corr, pboMatrix: matrixFor(corr) });
    expect(r.metrics.dsr).toBeCloseTo(deflatedSharpe(corr.map((t) => t.rNet), registry, { clamp: true }).dsr, 12);
    expect(r.metrics.dsrDays).toBe(40);
    expect(r.metrics.dsrDaily!).not.toBeCloseTo(r.metrics.dsr!, 3);
    expect(r.checks.find((c) => c.name === 'DSR')!.detail).toMatch(/moments clamped .*reported only: day-level DSR/);
  });
  test('the DSR reports day-level lines under raw, configuration and effective N, and a bootstrap p; only per-trade raw N gates', () => {
    const r = gateG1(g1Dsr());
    expect(r.metrics.trials).toBe(20);
    expect(r.metrics.trialsDeduplicated).toBe(20);
    expect(r.metrics.trialsEffective).toBeGreaterThanOrEqual(1);
    expect(r.metrics.dailySharpeP).toBeGreaterThan(0);
    expect(r.checks.find((c) => c.name === 'DSR')!.detail).toMatch(/over 20 configurations, .* effective trials; .*bootstrap p/);
  });
  test('fewer than MIN_DAYS days is "not proven"', () => {
    const nine = wf.filter((t) => t.day < 'd0009');
    expect(new Set(nine.map((t) => t.day)).size).toBe(9);
    expect(gateG1({ ...g1Pass(), trades: nine }).status).toBe('not-proven');
  });
  test('too little data is "not proven", not a pass', () => {
    const r = gateG1({ ...g1Pass(), trades: wf.slice(0, 2) });
    expect(r.status).toBe('not-proven');
    expect(r.passed).toBe(false);
  });
  test('G1 gates on the registered test: SPA by the owner\'s decision; the clamped DSR is reported only (STATS-1f)', () => {
    expect(RESEARCH_CONFIG.g1Test).toBe('spa');
    expect(G1_TESTS).toEqual(['spa', 'dsr']);
    const r = gateG1(g1Pass());
    expect(r.passed).toBe(true);
    expect(r.checks.some((c) => c.name === 'DSR')).toBe(false);
    expect(r.checks.find((c) => c.name === 'SPA')!.detail).toMatch(/t19 passes against zero and S0 .*reported only: deflated Sharpe/);
    expect(r.metrics.dsr).not.toBeNull();
    // SPA decides, DSR does not: a registry whose Sharpe ratios are spread wide drives the DSR benchmark up (DSR fails)
    // without touching SPA (it reads only the daily P&L matrix).
    const spread = registry.map((t, k) => ({ ...t, sharpe: k % 2 === 0 ? -2 : 2 }));
    expect(gateG1({ ...g1Dsr(), registry: spread }).reasons.join(' | ')).toMatch(/DSR: deflated Sharpe/);
    expect(gateG1({ ...g1Pass(), registry: spread }).checks.find((c) => c.name === 'SPA')!.passed).toBe(true);
    // ... and the other way: a zero-edge daily P&L matrix (all SPA reads) fails SPA, while the trades and the registry
    // (all the DSR reads) are unchanged, so the DSR still passes.
    const flatDaily = Object.fromEntries(registry.map((t, k) => [t.trialId, dailyOf(bracketTrades(900 + k, 0, 40, 15))]));
    expect(gateG1({ ...g1Pass(), pboMatrix: flatDaily }).reasons.join(' | ')).toMatch(/SPA: SPA over 20 variants .*t19 does not pass/);
    expect(gateG1({ ...g1Dsr(), pboMatrix: flatDaily }).checks.find((c) => c.name === 'DSR')!.passed).toBe(true);
    // Fail closed: SPA without its inputs fails; a zero-edge stream fails.
    const { spa: _spa, ...noSpa } = g1Pass();
    expect(gateG1(noSpa).checks.find((c) => c.name === 'SPA')).toMatchObject({ passed: false, detail: expect.stringMatching(/SPA not run/) });
    const flat = bracketTrades(23, 0, 40, 15);
    const f = gateG1({ ...g1Pass(), trades: flat, pboMatrix: Object.fromEntries(registry.map((t, k) => [t.trialId, dailyOf(bracketTrades(900 + k, 0, 40, 15))])) });
    expect(f.reasons.join(' | ')).toMatch(/SPA: SPA over 20 variants .*t19 does not pass/);
  });
  test('G1 takes its test from the stored registry, never from the caller (review of #109, B1)', () => {
    // Storing a registry without a valid test is refused.
    for (const bad of [undefined, 'both', '']) expect(() => createHoldoutRegistry(1, bad as never)).toThrow(/needs G1's test/);
    expect(createHoldoutRegistry(1, 'spa').g1Test).toBe('spa');
    // The stored test is what gates: SPA stored → the SPA check; DSR stored → the DSR check.
    expect(gateG1(g1Pass()).checks.map((c) => c.name)).toEqual(expect.arrayContaining(['G1 test', 'SPA']));
    expect(gateG1(g1Dsr()).checks.map((c) => c.name)).toEqual(expect.arrayContaining(['G1 test', 'DSR']));
    // A caller asking for the other test fails G1, and neither test gates: it cannot pick the one that passes.
    for (const [g1, asked] of [[g1Pass, 'dsr'], [g1Dsr, 'spa']] as const) {
      const r = gateG1({ ...g1(), g1Test: asked });
      expect(r.passed).toBe(false);
      expect(r.reasons[0]).toMatch(new RegExp(`^G1 test: the registry stores .*; the caller asked for ${asked}`));
      expect(r.checks.some((c) => c.name === 'SPA' || c.name === 'DSR')).toBe(false);
    }
    // Asking for the stored test is fine.
    expect(gateG1({ ...g1Pass(), g1Test: 'spa' }).passed).toBe(true);
    // A record stored before STATS-1f (no g1Test) fails G1 closed.
    for (const old of [{}, { g1Test: undefined }, { g1Test: 'both' }]) {
      const r = gateG1({ ...g1Pass(), holdoutRegistry: old as never });
      expect(r.passed).toBe(false);
      expect(r.reasons[0]).toMatch(/^G1 test: the holdout registry stores no G1 test/);
      expect(r.checks.some((c) => c.name === 'SPA' || c.name === 'DSR')).toBe(false);
    }
  });
  test('repeated runs of one configuration count once; different configurations with identical returns count twice', () => {
    const one = { t19: winnerDaily, t0: pboMatrix.t0!, t1: pboMatrix.t1! };
    const rerun = { ...one, rerun: [...winnerDaily] };
    const a = deflatedSharpeDaily(one, 't19');
    // The same configuration run twice: one hypothesis.
    const b = deflatedSharpeDaily(rerun, 't19', { rerun: 't19' });
    expect(b.raw.trials).toBe(4);
    expect(b.deduplicated.trials).toBe(3);
    expect(b.deduplicated).toEqual(a.deduplicated);
    // A different configuration whose returns happen to be identical: still its own hypothesis.
    expect(deflatedSharpeDaily(rerun, 't19').deduplicated.trials).toBe(4);
    const scaled = deflatedSharpeDaily({ ...one, other: winnerDaily.map((x) => 2 * x + 0.01) }, 't19');
    expect(scaled.deduplicated.trials).toBe(4);
    // The joint test's maximum statistic does not move when an identical series is added.
    const spaOf = (v: Record<string, number[]>) => spaTest(
      { variants: v, s0: Array<number>(40).fill(0), activeDays: Object.fromEntries(Object.keys(v).map((k) => [k, 40])), registration: { seFloor: 1e-9, studentisation: 'replicate' } },
      { rng: createRng(1), replicates: 400, alpha: 0.05 },
    );
    expect(spaOf(rerun).statistic).toBeCloseTo(spaOf(one).statistic, 12);
  });
  test('thresholds tighten but never loosen', () => {
    expect(gateG1(g1Dsr(), { dsrMin: 0.999999 }).reasons.some((x) => x.startsWith('DSR'))).toBe(true);
    expect(() => gateG1(g1Pass(), { dsrMin: 0.9 })).toThrow(/only be tightened/);
    expect(() => gateG1(g1Pass(), { pboMax: 0.5 })).toThrow(/only be tightened/);
    expect(() => gateG1(g1Pass(), { madeUp: 1 } as never)).toThrow(/unknown threshold/);
  });
});

// Holdout fixture: 25 days × 20 = 500 trades at +10%, sealed. S0 at −20% on the same days over 200 seeds.
const withClusters = (ts: readonly TradeOutcome[]): HoldoutTrade[] =>
  ts.map((t, i) => ({ ...t, creatorCluster: `c${i % 211}`, funderCluster: `f${i % 157}` }));
const holdout = withClusters(bracketTrades(31, 0.1, 25, 20));
const counts = { candidates: 2000, entries: 500, entryDays: 25 };
const controlRuns = Array.from({ length: 200 }, (_, k) => bracketTrades(1000 + k, -0.2, 25, 2).map(({ day, rNet }) => ({ day, rNet })));
/**
 * A hand-made n_power result. Unless the test says otherwise it was simulated on the universe's own walk-forward and
 * S0 (`simulatedOn`) with the registry's settings, and validated on independent draws at power 0.8 ± 0.02.
 */
type PowerSpec = Omit<G2PowerResult, 'walkForward' | 'inputs' | 'settings' | 'standardError' | 'validation'> & {
  readonly walkForward?: WalkForwardSummary;
  readonly simulatedOn?: { readonly walkForward: readonly ClusteredReturn[]; readonly control: readonly DayReturn[] };
  readonly settings?: G2PowerSettings;
  readonly validation?: G2PowerResult['validation'];
};
const power = (nPower: number, familySize = 1): PowerSpec => ({ nPower, powerAtN: 0.8, level: 0.04 / familySize, evaluations: [], units: G2_SENSITIVITY_VARIANTS, seed: 7 });
const settingsOf = (p: PowerSpec, familySize: number): G2PowerSettings => ({
  targetMean: 0.05, familySize, alpha: 0.04, power: 0.8, simulations: 400, replicates: Math.ceil(20 / (0.04 / familySize)), maxTrades: 50_000, units: p.units, seed: p.seed,
});
// The closed-form n for the walk-forward σ̂ (≈ 0.33) at a family's level; the frozen requirement is at least it.
const closedFor = (familySize: number) => nPower(sd(wf.map((t) => t.rNet)), 0.05, { alpha: 0.04 / familySize });
// Attempt 1 window: entries 08-01..08-25, one tail day: opens from 08-27 (NOW is 2026-09-21).
const window1 = { fromDay: '2026-08-01', toDay: '2026-08-25', registeredOnDay: '2026-07-20' };
const sealed = (familySize: number, universes: readonly string[], c = counts, required = Math.max(300, 330, closedFor(familySize)), requiredDays = 10): HoldoutRegistry => {
  // A day requirement under the floor needs a test rule (it exists only to show that G2 refuses it).
  let reg = createHoldoutRegistry(familySize, 'spa', requiredDays < 10 ? { windowDays: 28, tailDays: 1, minDays: 1 } : undefined);
  for (const u of universes) {
    reg = registerHoldout(reg, { holdoutId: `h-${u}`, universe: u, configId: `${u}-v1`, ...window1 });
    reg = freezeRequirement(reg, `h-${u}`, { requiredTrades: required, requiredDays, nPower: 300, nPowerSeed: 7 }).registry;
    reg = sealHoldout(reg, `h-${u}`, { configId: `${u}-v1`, ledgerHash: `hash-${u}`, counts: c }).registry;
  }
  return reg;
};
/** A universe whose n_power result fingerprints its own walk-forward unless the test says otherwise. */
const u = (name: string, over: Partial<Omit<G2Universe, 'power'>> & { readonly power?: PowerSpec } = {}, familySize = 1): G2Universe => {
  const walkForward = over.walkForward ?? wfClustered;
  const walkForwardControl = over.walkForwardControl ?? control;
  const p = over.power ?? power(330, familySize);
  const on = p.simulatedOn ?? { walkForward, control: walkForwardControl };
  const settings = p.settings ?? settingsOf(p, familySize);
  const { simulatedOn: _on, ...rest } = p;
  return {
    universe: name, configId: `${name}-v1`, holdoutId: `h-${name}`, ledgerHash: `hash-${name}`, trades: holdout, controlRuns, g1Passed: true, ...over,
    walkForward, walkForwardControl,
    power: {
      ...rest, walkForward: p.walkForward ?? summarizeWalkForward(on.walkForward), settings, inputs: g2PowerInputs(on.walkForward, on.control, settings),
      standardError: 0.02, validation: p.validation ?? { n: p.nPower, power: 0.8, standardError: 0.02 },
    },
  };
};
const wfClustered = wf.map(({ day, rNet }, i) => ({ day, rNet, creatorCluster: `c${i % 211}`, funderCluster: `f${i % 157}` }));
const g2Pass = (over: Partial<G2Input> = {}): G2Input => ({
  scenario: 'conservative', registry: sealed(1, ['U1']), universes: [u('U1')], nowMs: NOW, rng: createRng(2), replicates: 1000, ...over,
});

// The closed-form n for the walk-forward σ̂ (≈ 0.33) is a lower bound on what the gate requires.
const closedWf = closedFor(1);
// A family of 3 tests at 0.04/3, where the closed form needs about 514 trades: those fixtures hold 520 on 26 days.
const counts520 = { candidates: 2000, entries: 520, entryDays: 26 };

describe('G2 holdout (sealed, ARCHITECTURE.md §14 at 333f4ac)', () => {
  test('passes with enough trades and both CIs (mean, vs S0) above zero; the seal is opened once and burned', () => {
    const r = gateG2(g2Pass());
    expect(r.reasons).toEqual([]);
    expect(r.status).toBe('pass');
    expect(closedWf).toBeGreaterThan(330);
    expect(r.universes[0]).toMatchObject({ universe: 'U1', status: 'pass', requiredTrades: closedWf, entries: 500, level: 0.04 });
    expect(r.registry.entries[0]).toMatchObject({ seal: 'opened', openedAtMs: NOW, burned: true, burnReason: 'scored' });
  });
  test('the e-process, futility and predictive interval do not gate G2', () => {
    const names = gateG2(g2Pass()).checks.map((c) => c.name);
    expect(names.some((n) => /e-process|futility|predictive/.test(n))).toBe(false);
    const r = gateG2(g2Pass({ universes: [u('U1', { walkForward: wfClustered.map((t) => ({ ...t, rNet: t.rNet + 0.2 })) })] }));
    expect(r.status).toBe('pass');
    expect(r.notes[0]).toMatch(/predictive interval.*write a review/);
  });
  test('a second look is refused: a burned holdout fails on integrity', () => {
    const first = gateG2(g2Pass());
    const second = gateG2(g2Pass({ registry: first.registry }));
    expect(second).toMatchObject({ passed: false, status: 'fail' });
    expect(second.reasons[0]).toMatch(/burned \(scored\): integrity/);
  });
  test('a hash mismatch, a different configuration or a count mismatch burns the holdout and fails', () => {
    const hash = gateG2(g2Pass({ universes: [u('U1', { ledgerHash: 'other' })] }));
    expect(hash.status).toBe('fail');
    expect(hash.registry.entries[0]).toMatchObject({ burned: true, burnReason: 'hash-mismatch', seal: 'sealed' });
    expect(gateG2(g2Pass({ registry: hash.registry })).reasons[0]).toMatch(/burned \(hash-mismatch\)/);
    expect(gateG2(g2Pass({ universes: [u('U1', { configId: 'U1-v2' })] })).registry.entries[0]!.burnReason).toBe('reconfigured');
    expect(gateG2(g2Pass({ universes: [u('U1', { trades: holdout.slice(1) })] })).registry.entries[0]!.burnReason).toBe('count-mismatch');
  });
  test('the frozen day requirement is the one the seal opens at: 21 days frozen, 25 present, passes; 26 frozen is short (review STATS-1c)', () => {
    const r21 = gateG2(g2Pass({ registry: sealed(1, ['U1'], counts, undefined, 21) }));
    expect(r21.reasons).toEqual([]);
    expect(r21.status).toBe('pass');
    expect(r21.registry.entries[0]).toMatchObject({ seal: 'opened', burnReason: 'scored' });
    const r26 = gateG2(g2Pass({ registry: sealed(1, ['U1'], counts, undefined, 26) }));
    expect(r26.status).toBe('not-proven');
    expect(r26.reasons.join()).toMatch(/on >= 26 days/);
    // A day requirement under MIN_DAYS (only a test rule can freeze one) fails.
    const r9 = gateG2(g2Pass({ registry: sealed(1, ['U1'], counts, undefined, 9) }));
    expect(r9.status).toBe('fail');
    expect(r9.reasons.join()).toMatch(/requirement days U1: frozen 9 entry days \(need >= 10\)/);
    expect(REQUIREMENT_FLOOR).toEqual({ minTrades: G2_DEFAULTS.minTradesFloor, minDays: MIN_DAYS });
  });
  test('size comes from the sealed counts against the frozen requirement; short at the cutoff is "not proven" and spends the attempt', () => {
    const r = gateG2(g2Pass({ registry: sealed(1, ['U1'], counts, 600), universes: [u('U1', { power: power(600) })] }));
    expect(r.status).toBe('not-proven');
    expect(r.universes[0]).toMatchObject({ status: 'not-proven', requiredTrades: 600, p: null });
    // Never opened (nothing seen), but recorded as a failed attempt.
    expect(r.registry.entries[0]).toMatchObject({ seal: 'sealed', burned: true, burnReason: 'short' });
    // Counts decide, not the trades handed in.
    const short = gateG2(g2Pass({ registry: sealed(1, ['U1'], { ...counts, entries: 299 }) }));
    expect(short.universes[0]).toMatchObject({ status: 'not-proven', requiredTrades: closedWf, entries: 299 });
    expect(short.registry.entries[0]!.burnReason).toBe('short');
    const fewDays = gateG2(g2Pass({ registry: sealed(1, ['U1'], { ...counts, entryDays: 9 }) }));
    expect(fewDays.status).toBe('not-proven');
  });
  test('the frozen requirement may not sit below max(300, n_power, closed form); the seal stays closed', () => {
    const r = gateG2(g2Pass({ universes: [u('U1', { power: power(600) })] }));
    expect(r.status).toBe('fail');
    expect(r.reasons.join()).toMatch(new RegExp(`requirement U1: frozen ${closedWf} trades \\(need >= .* = 600\\)`));
    expect(r.registry.entries[0]).toMatchObject({ seal: 'sealed', burned: false });
  });
  test('the seal opens only after the observation tail and a G1 pass; the seed must match the frozen one', () => {
    const early = gateG2(g2Pass({ nowMs: Date.UTC(2026, 7, 26) }));
    expect(early.status).toBe('not-proven');
    expect(early.reasons.join()).toMatch(/tail U1: today 2026-08-26; the seal stays closed until 2026-08-27/);
    expect(early.registry.entries[0]).toMatchObject({ seal: 'sealed', burned: false });
    const g1 = gateG2(g2Pass({ universes: [u('U1', { g1Passed: false })] }));
    expect(g1.status).toBe('fail');
    expect(g1.registry.entries[0]).toMatchObject({ seal: 'sealed', burned: false });
    const seed = gateG2(g2Pass({ universes: [u('U1', { power: { ...power(330), seed: 8 } })] }));
    expect(seed.reasons.join()).toMatch(/n_power seed U1: n_power seed 8, frozen 7/);
  });
  test('p-values resolve the smallest Holm level: at least 20 / level bootstrap replicates', () => {
    expect(gateG2(g2Pass({ replicates: 499 })).reasons.join()).toMatch(/replicates: 499 bootstrap replicates \(need >= 20 \/ 0.04 = 500\)/);
    expect(gateG2(g2Pass({ replicates: 500 })).status).toBe('pass');
  });
  test('the floor is 300 and the closed form is a lower bound on the simulated n_power', () => {
    const calm = wfClustered.map((t) => ({ ...t, rNet: t.rNet * 0.5 })); // σ̂ ≈ 0.16: closed form ≈ 90
    expect(gateG2(g2Pass({ registry: sealed(1, ['U1'], counts, 300), universes: [u('U1', { power: power(100), walkForward: calm })] })).universes[0]!.requiredTrades).toBe(300);
    expect(gateG2(g2Pass({ registry: sealed(1, ['U1'], counts, 450), universes: [u('U1', { power: power(450) })] })).universes[0]!.requiredTrades).toBe(450);
    // A walk-forward with σ̂ ≈ 0.65 needs ~1,300 by the closed form; a low simulated n_power cannot lower that.
    const wide = wfClustered.map((t, i) => ({ ...t, rNet: i % 2 === 0 ? t.rNet * 2 : t.rNet * 2 - 0.1 }));
    const r = gateG2(g2Pass({ universes: [u('U1', { walkForward: wide })] }));
    expect(r.status).toBe('fail');
    expect(r.reasons.join()).toMatch(/requirement U1: .*closed form 1[0-9]{3}/);
  });
  test('Holm runs over the registry family: one ready universe of three is tested at α/3, absent ones count as p = 1', () => {
    // Find a holdout with p ≈ 0.03: it would pass at α = 0.05 but must fail at α/3 = 0.0167.
    let found: HoldoutTrade[] | null = null;
    for (let seed = 0; seed < 400 && !found; seed++) {
      const t = withClusters(bracketTrades(7000 + seed, 0.035, 26, 20));
      const p = gateG2(g2Pass({ registry: sealed(1, ['U1'], counts520), universes: [u('U1', { trades: t })] })).universes[0]!.p!;
      if (p > 0.02 && p < 0.035) found = t;
    }
    expect(found).not.toBeNull();
    const r = gateG2(g2Pass({ registry: sealed(3, ['U1', 'U2', 'U3'], counts520), universes: [u('U1', { trades: found! }, 3)], replicates: 1500 }));
    expect(r.universes[0]).toMatchObject({ status: 'fail', level: 0.04 / 3 });
    expect(r.status).toBe('fail');
    // The other two stay sealed for a later call, which also runs Holm over the family of three.
    expect(r.registry.entries.filter((e) => e.seal === 'sealed').map((e) => e.universe)).toEqual(['U2', 'U3']);
  }, 120_000);
  // Family-wise error across separate G2 calls (supervisor ruling and review of c20806d). All three universes have zero
  // true edge; the registry family is 3; a family-wise error is any universe passing in any call. ≥ 2,000 runs per
  // variant; the bound is α plus two Monte Carlo standard errors (0.05 + 2·√(0.05·0.95/2000) ≈ 0.0597).
  const FWER_REPS = 2000;
  const FWER_BOUND = 0.05 + 2 * Math.sqrt((0.05 * 0.95) / FWER_REPS);
  const nullTrades = (seed: number) => withClusters(bracketTrades(seed, 0, 26, 20));
  const fwer = (plan: readonly (readonly string[])[], seedBase: number): number => {
    let anyPass = 0;
    for (let r = 0; r < FWER_REPS; r++) {
      let reg = sealed(3, ['U1', 'U2', 'U3'], counts520);
      let rejected = false;
      plan.forEach((call, k) => {
        const res = gateG2(g2Pass({
          registry: reg,
          universes: call.map((name, j) => u(name, { trades: nullTrades(seedBase + 10 * r + 3 * k + j) }, 3)),
          rng: createRng(seedBase + 7 * r + k),
          replicates: 1500,
        }));
        reg = res.registry;
        if (res.passed) rejected = true;
      });
      expect(reg.entries.every((e) => e.seal === 'opened')).toBe(true);
      if (rejected) anyPass++;
    }
    return anyPass / FWER_REPS;
  };
  test('family-wise error ≤ α: U1 and U2 in one call, U3 in a later call (2,000 null runs)', () => {
    expect(fwer([['U1', 'U2'], ['U3']], 1_000_000)).toBeLessThanOrEqual(FWER_BOUND);
  }, 600_000);
  test('family-wise error ≤ α: one universe per call, three calls (2,000 null runs)', () => {
    expect(fwer([['U1'], ['U2'], ['U3']], 2_000_000)).toBeLessThanOrEqual(FWER_BOUND);
  }, 600_000);
  test('n_power must come from this universe\'s walk-forward', () => {
    const other = wfClustered.map((t) => ({ ...t, rNet: t.rNet + 0.01 }));
    const r = gateG2(g2Pass({ universes: [u('U1', { power: { ...power(330), simulatedOn: { walkForward: other, control } } })] }));
    expect(r.status).toBe('fail');
    expect(r.reasons.join()).toMatch(/n_power inputs U1: n_power was simulated on walk-forward .* with other trades, labels, control or settings/);
    expect(r.registry.entries[0]!.seal).toBe('sealed');
  });
  test('the n_power fingerprint is the exact labelled inputs: one common creator is not independent creators (external audit S3)', () => {
    // The audit's counterexample: the same returns, days, mean and SD; only the creator labels differ.
    const independent = wf.map(({ day, rNet }, i) => ({ day, rNet, creatorCluster: `c${i}`, funderCluster: `f${i}` }));
    const common = wf.map(({ day, rNet }, i) => ({ day, rNet, creatorCluster: 'c0', funderCluster: `f${i}` }));
    expect(summarizeWalkForward(independent)).toEqual(summarizeWalkForward(common));
    const st = settingsOf(power(330), 1);
    expect(g2PowerInputs(independent, control, st)).not.toBe(g2PowerInputs(common, control, st));
    // Order, the control and every setting count too.
    expect(g2PowerInputs([...independent].reverse(), control, st)).not.toBe(g2PowerInputs(independent, control, st));
    expect(g2PowerInputs(independent, control.slice(1), st)).not.toBe(g2PowerInputs(independent, control, st));
    expect(g2PowerInputs(independent, control, { ...st, simulations: 401 })).not.toBe(g2PowerInputs(independent, control, st));
    // n_power simulated under independent creators does not pass for a walk-forward from one creator.
    const r = gateG2(g2Pass({ universes: [u('U1', { walkForward: common, power: { ...power(330), simulatedOn: { walkForward: independent, control } } })] }));
    expect(r.status).toBe('fail');
    expect(r.reasons.join()).toMatch(/n_power inputs U1: .*with other trades, labels, control or settings/);
    // A result without settings cannot be checked and fails.
    const bare = u('U1');
    const { settings: _s, ...noSettings } = bare.power;
    expect(gateG2(g2Pass({ universes: [{ ...bare, power: noSettings as never }] })).reasons.join()).toMatch(/n_power carries no settings/);
  });
  test('the chosen n is validated on independent draws, with its Monte Carlo error reported (external audit S3)', () => {
    const ok = gateG2(g2Pass());
    expect(ok.checks.find((x) => x.name === 'n_power validated U1')).toMatchObject({ passed: true, detail: expect.stringMatching(/power 0\.8 ± 0\.02 in the search, 0\.8 ± 0\.02 on independent draws/) });
    // 0.8 − 1.645 × 0.02 = 0.7671: 0.77 is within Monte Carlo error, 0.76 is not; a validation at another n fails.
    expect(gateG2(g2Pass({ universes: [u('U1', { power: { ...power(330), validation: { n: 330, power: 0.77, standardError: 0.02 } } })] })).checks.find((x) => x.name === 'n_power validated U1')!.passed).toBe(true);
    const low = gateG2(g2Pass({ universes: [u('U1', { power: { ...power(330), validation: { n: 330, power: 0.76, standardError: 0.02 } } })] }));
    expect(low.status).toBe('fail');
    expect(low.reasons.join()).toMatch(/n_power validated U1: n 330: .*0\.76 ± 0\.02 on independent draws/);
    expect(gateG2(g2Pass({ universes: [u('U1', { power: { ...power(330), validation: { n: 300, power: 0.9, standardError: 0.02 } } })] })).status).toBe('fail');
  });
  test('n_power settings are pinned, not taken from the result: each self-declared goal fails (review B3)', () => {
    const base = settingsOf(power(330), 1);
    expect(gateG2(g2Pass()).checks.find((x) => x.name === 'n_power settings U1')).toMatchObject({ passed: true });
    // A consistent result (its inputs fingerprint matches) that declared an easier goal for itself.
    const cases: [Partial<G2PowerSettings>, RegExp][] = [
      [{ power: 0.5 }, /power 0\.5 \(need >= 0\.8\)/],
      [{ power: 0.79 }, /power 0\.79 \(need >= 0\.8\)/],
      [{ targetMean: 0.2 }, /target mean 0\.2 \(need <= 0\.05\)/],
      [{ targetMean: 0.051 }, /target mean 0\.051 \(need <= 0\.05\)/],
      [{ simulations: 100 }, /100 simulations \(need >= 400\)/],
      [{ simulations: 399 }, /399 simulations \(need >= 400\)/],
      [{ replicates: 499 }, /499 replicates \(need >= 500\)/],
      [{ familySize: 2 }, /family size 2 \(the registry's is 1\)/],
      [{ alpha: 0.05 }, /α 0\.05 \(the attempt's is 0\.04\)/],
      [{ units: ['days-1', 'days-2', 'days-3', 'creator'] }, /not every resampling unit/],
    ];
    for (const [over, why] of cases) {
      const r = gateG2(g2Pass({ universes: [u('U1', { power: { ...power(330), settings: { ...base, ...over } } })] }));
      expect(r.checks.find((x) => x.name === 'n_power inputs U1')!.passed).toBe(true);
      expect(r.status).toBe('fail');
      expect(r.reasons.join()).toMatch(new RegExp(`n_power settings U1: n_power simulated with ${why.source}`));
      expect(r.registry.entries[0]!.seal).toBe('sealed');
    }
    // Stricter settings pass: more power, a smaller edge, more simulations and replicates.
    const strict = gateG2(g2Pass({ universes: [u('U1', { power: { ...power(330), settings: { ...base, power: 0.9, targetMean: 0.03, simulations: 1000, replicates: 2000 } } })] }));
    expect(strict.checks.find((x) => x.name === 'n_power settings U1')!.passed).toBe(true);
    // A family of 3 at 0.04/3 needs 20 / (0.04/3) = 1,500 replicates.
    const fam3 = gateG2(g2Pass({ registry: sealed(3, ['U1'], counts520), universes: [u('U1', { power: { ...power(330, 3), settings: { ...settingsOf(power(330, 3), 3), replicates: 1499 } } }, 3)] }));
    expect(fam3.reasons.join()).toMatch(/n_power settings U1: n_power simulated with 1499 replicates \(need >= 1500\)/);
  });
  test('the settings\' seed must be the result\'s seed (the frozen one), even when the fingerprint matches', () => {
    const r = gateG2(g2Pass({ universes: [u('U1', { power: { ...power(330), settings: { ...settingsOf(power(330), 1), seed: 8 } } })] }));
    expect(r.status).toBe('fail');
    expect(r.checks.find((x) => x.name === 'n_power seed U1')!.passed).toBe(true);
    expect(r.checks.find((x) => x.name === 'n_power inputs U1')!.passed).toBe(false);
  });
  test('n_power simulated without every resampling unit is refused before the seal opens', () => {
    const r = gateG2(g2Pass({ universes: [u('U1', { power: { ...power(330), units: ['days-1'] } })] }));
    expect(r.status).toBe('fail');
    expect(r.reasons.join()).toMatch(/n_power units U1: n_power simulated without days-2, days-3, creator, funder/);
    expect(r.registry.entries[0]!.seal).toBe('sealed');
  });
  test('n_power must be simulated for the family size fixed in the registry', () => {
    const r = gateG2(g2Pass({ universes: [u('U1', { power: power(330, 3) })] }));
    expect(r.reasons.join()).toMatch(/n_power U1: n_power was simulated at level 0.013333/);
    expect(r.registry.entries[0]!.seal).toBe('sealed');
  });
  test('an unregistered holdout, a duplicate universe, too many universes or too few S0 seeds is refused unopened', () => {
    expect(gateG2(g2Pass({ universes: [u('U1', { holdoutId: 'nope' })] })).reasons[0]).toMatch(/not registered/);
    expect(gateG2(g2Pass({ universes: [u('U1'), u('U1')] })).reasons.join()).toMatch(/1\.\.1, the family size fixed in the registry/);
    expect(gateG2(g2Pass({ universes: [u('U1', { controlRuns: controlRuns.slice(0, 199) })] })).reasons[0]).toMatch(/199 S0 seeds/);
    const base = gateG2(g2Pass({ scenario: 'base' }));
    expect(base.status).toBe('fail');
    expect(base.registry.entries[0]!.seal).toBe('sealed');
  });
  test('a positive mean that does not beat S0 fails', () => {
    const asGood = Array.from({ length: 200 }, () => holdout.map(({ day, rNet }) => ({ day, rNet: rNet + 0.01 })));
    const r = gateG2(g2Pass({ universes: [u('U1', { controlRuns: asGood })] }));
    expect(r.status).toBe('fail');
    expect(r.universes[0]!.lower!).toBeGreaterThan(0);
    expect(r.universes[0]!.diffVsS0Lower!).toBeLessThanOrEqual(0);
  });
  test('Holm across universes: a marginal universe passes alone but not as the weakest of three', () => {
    let found: HoldoutTrade[] | null = null;
    for (let seed = 0; seed < 400 && !found; seed++) {
      const t = withClusters(bracketTrades(5000 + seed, 0.035, 26, 20));
      const p = gateG2(g2Pass({ registry: sealed(1, ['U1'], counts520), universes: [u('U1', { trades: t })] })).universes[0]!.p!;
      if (p > 0.02 && p < 0.035) found = t;
    }
    expect(found).not.toBeNull();
    expect(gateG2(g2Pass({ registry: sealed(1, ['U1'], counts520), universes: [u('U1', { trades: found! })] })).universes[0]!.status).toBe('pass');
    const weak = withClusters(bracketTrades(6000, -0.1, 26, 20));
    const r = gateG2(g2Pass({
      registry: sealed(3, ['U1', 'U2', 'U3'], counts520), replicates: 1500,
      universes: [u('U1', { trades: found! }, 3), u('U2', { trades: weak }, 3), u('U3', { trades: weak }, 3)],
    }));
    expect(r.universes[0]!.level).toBeCloseTo(0.04 / 3, 12);
    expect(r.universes[0]!.status).toBe('fail');
    expect(r.status).toBe('fail');
    expect(r.registry.entries.every((e) => e.burned && e.seal === 'opened')).toBe(true);
  }, 120_000);
  test('a second attempt is tested at 0.005: n_power simulated at 0.04 is refused, at 0.005 it is accepted', () => {
    // Attempt 1 in July, spent; attempt 2 registered 08-02 runs 08-03..08-30 and opens from 09-01 (NOW is 09-21).
    let reg = registerHoldout(createHoldoutRegistry(1, 'spa'), { holdoutId: 'h-old', universe: 'U1', configId: 'U1-v0', fromDay: '2026-07-01', toDay: '2026-07-25', registeredOnDay: '2026-06-20' });
    reg = burnHoldout(reg, 'h-old', 'inspected', 'test').registry;
    reg = registerHoldout(reg, { holdoutId: 'h-U1', universe: 'U1', configId: 'U1-v1', fromDay: '2026-08-03', toDay: '2026-08-30', registeredOnDay: '2026-08-02' });
    reg = freezeRequirement(reg, 'h-U1', { requiredTrades: 600, requiredDays: 10, nPower: 300, nPowerSeed: 7 }).registry;
    reg = sealHoldout(reg, 'h-U1', { configId: 'U1-v1', ledgerHash: 'hash-U1', counts }).registry;
    const refused = gateG2(g2Pass({ registry: reg }));
    expect(refused.reasons.join()).toMatch(/n_power U1: n_power was simulated at level 0.04, attempt α 0.005/);
    expect(refused.registry.entries[1]!.seal).toBe('sealed');
    const p2 = { ...power(330), level: 0.005 };
    const r = gateG2(g2Pass({ registry: reg, universes: [u('U1', { power: p2 })] }));
    expect(r.checks.some((c) => c.name === 'n_power U1' && c.passed)).toBe(true);
  });
  test('G2 thresholds tighten but never loosen', () => {
    expect(() => gateG2(g2Pass(), { minTradesFloor: 200 })).toThrow(/only be tightened/);
    expect(() => gateG2(g2Pass(), { familyAlpha: 0.1 })).toThrow(/only be tightened/);
    expect(() => gateG2(g2Pass(), { constructor: 1 } as never)).toThrow(/unknown threshold/);
    expect(gateG2(g2Pass(), { minTradesFloor: 600 }).reasons.join()).toMatch(/requirement U1: .*max\(600,/);
  });
});

// Review STATS-1b, finding 2: 300 trades are not 300 independent observations. G2 also resamples multi-day blocks (2 and
// 3 days) and creator and funder clusters, and passes only if every one of those CIs stays above zero.
describe('G2 cluster sensitivity (STATS-1b)', () => {
  // One creator (or funder) cluster carries the P&L: 50 trades at +100%, spread 2 a day, the other 450 at −2%.
  const concentrated = (key: 'creatorCluster' | 'funderCluster'): HoldoutTrade[] =>
    withClusters(bracketTrades(61, -0.02, 25, 20)).map((t, i) => (i % 10 === 0
      ? { ...t, rNet: 1, [key]: 'whale' }
      : { ...t, creatorCluster: `c-own-${i}`, funderCluster: `f-own-${i}` }));
  test('a creator cluster that carries the P&L fails G2, though the day-block CI is above zero', () => {
    const t = concentrated('creatorCluster');
    const r = gateG2(g2Pass({ universes: [u('U1', { trades: t })] }));
    expect(r.status).toBe('fail');
    const s = r.universes[0]!.sensitivity;
    expect(s.find((x) => x.variant === 'days-1')!.lower).toBeGreaterThan(0);
    expect(s.find((x) => x.variant === 'creator')!.lower).toBeLessThanOrEqual(0);
    expect(r.reasons.join()).toMatch(/proof U1: .*creator/);
  });
  test('a funder cluster that carries the P&L fails G2', () => {
    const r = gateG2(g2Pass({ universes: [u('U1', { trades: concentrated('funderCluster') })] }));
    expect(r.status).toBe('fail');
    expect(r.universes[0]!.sensitivity.find((x) => x.variant === 'funder')!.lower).toBeLessThanOrEqual(0);
  });
  test('P&L that moves in 3-day runs fails on the 3-day blocks, though 1-day blocks pass', () => {
    // 24 days; every 3-day run shares a shock of ±6 points, alternating: days are not independent, runs are.
    const base = withClusters(bracketTrades(62, 0.05, 24, 20));
    const t = base.map((x) => ({ ...x, rNet: x.rNet + (Math.floor(Number(x.day.slice(1)) / 3) % 2 === 0 ? 0.06 : -0.06) }));
    const ctl = controlRuns.flat();
    const lvl = 0.05;
    const s = g2Sensitivity(t, ctl, lvl, { rng: createRng(3), replicates: 1000 });
    const p = (v: string) => s.find((x) => x.variant === v)!.p;
    expect(p('days-1')).toBeLessThan(lvl);
    expect(p('days-3')).toBeGreaterThanOrEqual(lvl);
    const r = gateG2(g2Pass({ universes: [u('U1', { trades: t })], registry: sealed(1, ['U1'], { ...counts, entries: 480, entryDays: 24 }) }));
    expect(r.status).toBe('fail');
    expect(r.universes[0]!.p!).toBeGreaterThanOrEqual(lvl);
  });
  test('the passing holdout passes every variant, and each variant is reported', () => {
    const r = gateG2(g2Pass());
    expect(r.status).toBe('pass');
    expect(r.universes[0]!.sensitivity.map((x) => x.variant)).toEqual(['days-1', 'days-2', 'days-3', 'creator', 'funder']);
    expect(r.universes[0]!.sensitivity.every((x) => x.lower! > 0)).toBe(true);
  });
  test('a holdout trade without a creator or funder cluster is refused before the seal opens', () => {
    const t = holdout.map((x, i) => (i === 7 ? { ...x, funderCluster: '' } : x));
    const r = gateG2(g2Pass({ universes: [u('U1', { trades: t })] }));
    expect(r.status).toBe('fail');
    expect(r.reasons.join()).toMatch(/clusters U1: 1 trades without a creator or funder cluster/);
    expect(r.registry.entries[0]!.seal).toBe('sealed');
  });
  test('a walk-forward trade without a cluster label is refused too (n_power simulates the cluster rule)', () => {
    const wfMissing = wfClustered.map((x, i) => (i === 3 ? { ...x, creatorCluster: '' } : x));
    const r = gateG2(g2Pass({ universes: [u('U1', { walkForward: wfMissing })] }));
    expect(r.status).toBe('fail');
    expect(r.reasons.join()).toMatch(/walk-forward clusters U1: 1 walk-forward trades without a creator or funder cluster/);
  });
});

const dry = bracketTrades(41, 0.1, 2, 30).map((t) => t.rNet);
/** Kept trades with their creator clusters (each its own creator unless given), for the cluster-robust veto gap. */
const keptOf = (xs: readonly number[], clusters: readonly string[] = xs.map((_, i) => `k${i}`)) => ({ dryRunReturns: xs, dryRunClusters: clusters });
/** Scored vetoed candidates with their creator clusters (each its own creator unless given). */
const cfOf = (returns: readonly number[], censored = 0, clusters: readonly string[] = returns.map((_, i) => `v${i}`)) => ({ returns, clusters, censored });
const g3Pass: G3Input = {
  qualifyingRun: true, liveOnlyVetoes: { vetoed: 20, eligible: 1000 }, dryRunHours: 49, ...keptOf(dry),
  holdout: { n: holdout.length, mean: mean(holdout.map((t) => t.rNet)), sd: sd(holdout.map((t) => t.rNet)), estimand: CAPPED_ESTIMAND },
  candidates: { dryRunCount: 980, dryRunHours: 49, backtestCount: 20_000, backtestHours: 1000 },
  rejectMix: { dryRun: { H8: 210, H9: 700, H11: 70 }, backtest: { H8: 4300, H9: 14_200, H11: 1500 } },
  fillDifferences: Array.from({ length: 24 }, (_, i) => [0.001, 0.002, 0.004, 0.003, 0.012, -0.002][i % 6]!), parityTestPassed: true,
  holdoutSevereRate: holdout.filter((t) => t.ySevere).length / holdout.length,
  registration: { registeredAtMs: NOW - 2 * DAY, evaluateAtMs: NOW - DAY + 49 * HOUR, thresholds: {}, expectedSimulationErrors: ['BlockhashNotFound'] },
  dryRunStartMs: NOW - DAY,
  simulations: { attempted: 120, succeeded: 118, errors: { BlockhashNotFound: 2 } },
  // The 20 vetoed candidates scored as if entered, like the kept trades; the holdout's lower bound from G2.
  vetoCounterfactuals: cfOf(bracketTrades(42, 0.1, 1, 20).map((t) => t.rNet)),
  holdoutLower: { value: 0.06, level: HOLDOUT_LOWER_LEVEL, estimand: CAPPED_ESTIMAND }, holdoutCapped: 0, holdoutBelowFloor: 0, returnCap: 0.3,
};

describe('G3 live dry-run consistency', () => {
  test('passes when the dry run matches the backtest', () => {
    const r = gateG3(g3Pass);
    expect(r.reasons).toEqual([]);
    expect(r.passed).toBe(true);
  });
  test('fails on a short run, a shifted reject mix, a different candidate rate and loose fills', () => {
    const r = gateG3({
      ...g3Pass, dryRunHours: 30,
      candidates: { ...g3Pass.candidates, dryRunCount: 1500 },
      rejectMix: { dryRun: { H8: 500, H9: 400, H11: 80 }, backtest: g3Pass.rejectMix.backtest },
      fillDifferences: [0.01, 0.02, 0.006],
    });
    const failed = r.reasons.map((x) => x.split(':')[0]);
    expect(failed).toEqual(expect.arrayContaining(['duration', 'candidate rate', 'reject mix H8', 'reject mix H9', 'fills']));
  });
  test('a dry-run mean outside the holdout predictive interval fails', () => {
    const r = gateG3({ ...g3Pass, ...keptOf(dry.map((x) => x - 0.3)) });
    expect(r.reasons.some((x) => x.startsWith('mean'))).toBe(true);
  });
  test('fewer than 30 paper trades is inconclusive, never agreement (supervisor ruling after external review)', () => {
    const few = gateG3({ ...g3Pass, ...keptOf(dry.slice(0, 29)) });
    expect(few).toMatchObject({ passed: false, status: 'not-proven' });
    expect(few.reasons.join()).toMatch(/paper outcomes: 29 paper trades \(need >= 30\): inconclusive, extend the dry run/);
    expect(few.notes).toContain('inconclusive: extend the dry run');
    expect(gateG3({ ...g3Pass, ...keptOf([]) }).status).toBe('not-proven');
  });
  // Pre-registered agreement (STATS-1b item 3): agree, disagree and inconclusive for each comparison.
  test('agrees: every comparison inside its registered tolerance with enough evidence', () => {
    const r = gateG3(g3Pass);
    expect(r.status).toBe('pass');
    expect(r.notes).toContain('agrees');
    expect(r.metrics.simSuccessRate).toBeCloseTo(118 / 120, 12);
  });
  test('disagrees: simulation success under 95%, an unregistered error code, one fill off by more than 2 points, or a different severe share', () => {
    const lowSim = gateG3({ ...g3Pass, simulations: { attempted: 120, succeeded: 110, errors: { BlockhashNotFound: 10 } } });
    expect(lowSim.status).toBe('fail');
    expect(lowSim.notes).toContain('disagrees');
    expect(gateG3({ ...g3Pass, simulations: { attempted: 120, succeeded: 118, errors: { SlippageExceeded: 2 } } }).reasons.join()).toMatch(/unregistered error codes: SlippageExceeded ×2/);
    expect(gateG3({ ...g3Pass, simulations: { attempted: 120, succeeded: 118, errors: {} } }).status).toBe('fail');
    expect(gateG3({ ...g3Pass, fillDifferences: [...g3Pass.fillDifferences, 0.03] }).reasons.join()).toMatch(/largest \|paper − simulated\| 0.03/);
    // A small fill sample with one fill off by more than 2 points already disagrees.
    expect(gateG3({ ...g3Pass, fillDifferences: [0.001, 0.025] }).status).toBe('fail');
    const severe = gateG3({ ...g3Pass, ...keptOf(dry.map((x, i) => (i % 3 === 0 ? -0.9 : x))), holdout: { ...g3Pass.holdout, sd: 2 } });
    expect(severe.reasons.join()).toMatch(/severe share/);
    expect(severe.status).toBe('fail');
  });
  test('inconclusive: too few candidates, rejects, fills or simulations', () => {
    const cases: Partial<G3Input>[] = [
      { candidates: { ...g3Pass.candidates, dryRunCount: 49 } },
      { rejectMix: { dryRun: { H8: 10, H9: 30, H11: 5 }, backtest: g3Pass.rejectMix.backtest } },
      { fillDifferences: g3Pass.fillDifferences.slice(0, 19) },
      { simulations: { attempted: 19, succeeded: 19, errors: {} } },
    ];
    for (const over of cases) {
      const r = gateG3({ ...g3Pass, ...over });
      expect(r.status, JSON.stringify(over)).toBe('not-proven');
      expect(r.reasons.join()).toMatch(/inconclusive, extend the dry run/);
    }
  });
  test('the plan is registered before the run, and it can only tighten the defaults', () => {
    const late = gateG3({ ...g3Pass, registration: { ...g3Pass.registration, registeredAtMs: g3Pass.dryRunStartMs + 1 } });
    expect(late.status).toBe('fail');
    expect(late.reasons[0]).toMatch(/^registration/);
    expect(() => gateG3({ ...g3Pass, registration: { ...g3Pass.registration, thresholds: { simSuccessMin: 0.9 } } })).toThrow(/only be tightened/);
    expect(() => gateG3({ ...g3Pass, registration: { ...g3Pass.registration, thresholds: { minPaperTradesForMean: 20 } } })).toThrow(/only be tightened/);
    expect(gateG3({ ...g3Pass, registration: { ...g3Pass.registration, thresholds: { minPaperTradesForMean: 100 } } }).status).toBe('not-proven');
    expect(() => gateG3({ ...g3Pass, registration: { ...g3Pass.registration, thresholds: { simSuccessMin: 0.99 } } }, { simSuccessMin: 0.97 })).toThrow(/only be tightened/);
  });
  test('a rehearsal run counts for nothing', () => {
    expect(gateG3({ ...g3Pass, qualifyingRun: false }).reasons[0]).toMatch(/^qualifying run/);
  });
  test('the live-only veto rate gates at 10% and its 95% upper bound is reported', () => {
    const r = gateG3(g3Pass);
    expect(r.metrics.liveOnlyVetoRate).toBe(0.02);
    expect(r.metrics.liveOnlyVetoUpper95!).toBeGreaterThan(0.02);
    expect(gateG3({ ...g3Pass, liveOnlyVetoes: { vetoed: 101, eligible: 1000 } }).reasons[0]).toMatch(/^live-only vetoes/);
    expect(gateG3({ ...g3Pass, liveOnlyVetoes: { vetoed: 0, eligible: 0 } }).passed).toBe(false);
  });
  // Review STATS-1b, finding 1 (the reviewer's synthetic case): 20 paper trades averaging −1%, a +5% holdout and 10%
  // live-only vetoes passed, because below 30 paper trades nothing compared returns and the veto gap was never measured.
  const reviewerCase = (over: Partial<G3Input> = {}): G3Input => {
    const kept = bracketTrades(43, -0.01, 1, 20).map((t) => t.rNet);
    const shift = -0.01 - mean(kept);
    return {
      ...g3Pass, ...keptOf(kept.map((x) => x + shift)), liveOnlyVetoes: { vetoed: 100, eligible: 1000 },
      holdout: { n: 500, mean: 0.05, sd: 0.33, estimand: CAPPED_ESTIMAND }, holdoutLower: { value: 0.02, level: HOLDOUT_LOWER_LEVEL, estimand: CAPPED_ESTIMAND }, vetoCounterfactuals: cfOf([]), ...over,
    };
  };
  test('the reviewer\'s case does not pass: with no vetoed candidate scored the dry run is extended', () => {
    const r = gateG3(reviewerCase());
    expect(r.passed).toBe(false);
    expect(r.status).toBe('not-proven');
    expect(r.reasons.join()).toMatch(/veto counterfactuals: 0 of 100 vetoed candidates scored/);
  });
  test('the reviewer\'s case with every veto scored: the measured gap and its uncertainty push the retained lower bound below 0', () => {
    const raw = bracketTrades(44, 0.05, 1, 100).map((t) => t.rNet);
    const cf = raw.map((x) => x + 0.05 - mean(raw)); // vetoed candidates at the holdout's +5%, kept trades at −1%
    const r = gateG3(reviewerCase({ vetoCounterfactuals: cfOf(cf) }));
    expect(r.passed).toBe(false);
    expect(r.status).toBe('not-proven');
    expect(r.metrics.vetoGap!).toBeCloseTo(0.06, 12);
    expect(r.metrics.retainedLower!).toBeLessThanOrEqual(0);
    expect(r.reasons.join()).toMatch(/retained expectancy: .*extend the dry run/);
  });
  test('vetoed candidates far better than kept trades fail outright: the point estimate is already below 0', () => {
    const cf = bracketTrades(45, 0.2, 1, 100).map((t) => t.rNet + 0.3);
    const kept = bracketTrades(46, -0.2, 1, 40).map((t) => t.rNet);
    const r = gateG3({ ...g3Pass, ...keptOf(kept), liveOnlyVetoes: { vetoed: 100, eligible: 1000 }, vetoCounterfactuals: cfOf(cf) });
    expect(r.status).toBe('fail');
    expect(r.reasons.join()).toMatch(/veto bias/);
  });
  test('the fixed 50-point gap is gone: the measured gap and its 95% upper bound are used and reported', () => {
    const r = gateG3(g3Pass);
    expect(r.passed).toBe(true);
    const dryMean = mean(dry);
    expect(r.metrics.vetoGap!).toBeCloseTo(mean(g3Pass.vetoCounterfactuals.returns) - dryMean, 12);
    expect(r.metrics.vetoGapUpper!).toBeGreaterThan(r.metrics.vetoGap!);
    expect(r.metrics.vetoGapUpper!).toBeLessThan(0.5);
    expect(r.metrics.liveOnlyVetoUpper95!).toBeCloseTo(clopperPearsonUpper(20, 1000), 12);
    expect(r.metrics.retainedLower!).toBeGreaterThan(0);
  });
  test('with fewer than 10 vetoed or kept trades the gap is the worst case the return range allows, never an assumption', () => {
    const r = gateG3({ ...g3Pass, liveOnlyVetoes: { vetoed: 3, eligible: 1000 }, vetoCounterfactuals: cfOf([0.1, 0.2, -0.1]) });
    // The estimand's worst case (S2 ruling C5): 3 − RETURN_FLOOR = 4.1, whatever take-profit is configured.
    expect(r.metrics.vetoGapUpper).toBeCloseTo(MAX_RETURN_CAP - RETURN_FLOOR, 12);
    // 3 of 1,000: the rate bound is small enough that even the worst gap keeps the retained bound above 0.
    expect(r.passed).toBe(true);
    const many = gateG3({ ...g3Pass, liveOnlyVetoes: { vetoed: 60, eligible: 1000 }, vetoCounterfactuals: cfOf(Array(60).fill(0.1)), ...keptOf(dry.slice(0, 8)) });
    expect(many.metrics.vetoGapUpper).toBeCloseTo(MAX_RETURN_CAP - RETURN_FLOOR, 12);
    expect(many.status).toBe('not-proven');
  });
  test('an unscored or censored vetoed candidate is missing evidence; a count that does not add up fails', () => {
    const censored = gateG3({ ...g3Pass, vetoCounterfactuals: cfOf(g3Pass.vetoCounterfactuals.returns.slice(1), 1) });
    expect(censored.status).toBe('not-proven');
    expect(censored.reasons.join()).toMatch(/1 censored: wait for their windows to close/);
    const extra = gateG3({ ...g3Pass, vetoCounterfactuals: cfOf([...g3Pass.vetoCounterfactuals.returns, 0.1]) });
    expect(extra.status).toBe('fail');
    expect(() => gateG3({ ...g3Pass, returnCap: 5 })).not.toThrow();
    expect(gateG3({ ...g3Pass, returnCap: 5 }).reasons.join()).toMatch(/^return cap/);
  });
  // Final G3 ruling: each component of the veto-bias composite at α/3, so all three hold together with ≥ 95%.
  const welch = (a: readonly number[], b: readonly number[], alpha: number) => {
    const qa = variance(a) / a.length;
    const qb = variance(b) / b.length;
    const df = (qa + qb) ** 2 / (qa ** 2 / (a.length - 1) + qb ** 2 / (b.length - 1));
    const half = studentTQuantile(1 - alpha, df) * Math.sqrt(qa + qb);
    const d = mean(a) - mean(b);
    return { lower: d - half, upper: d + half };
  };
  test('each of the four composite components is computed at α/4: veto rate, gap, holdout bound and fill error (external audit S1)', () => {
    // Union bound: before, three parts at α/3 plus a 95% fill bound gave 3·(0.05/3) + 0.05 = 0.10, only 90% joint coverage.
    expect(VETO_COMPOSITE_PARTS).toBe(4);
    expect(VETO_COMPOSITE_ALPHA).toBeCloseTo(0.05 / 4, 15);
    expect(VETO_COMPOSITE_PARTS * VETO_COMPOSITE_ALPHA).toBeCloseTo(0.05, 15);
    const r = gateG3(g3Pass);
    expect(r.metrics.vetoRateUpperComposite).toBeCloseTo(clopperPearsonUpper(20, 1000, 0.05 / 4), 12);
    const cf = g3Pass.vetoCounterfactuals.returns;
    // Every trade its own creator: the cluster-robust bound is the classic Welch bound.
    expect(r.metrics.vetoGapUpper).toBeCloseTo(welch(cf, dry, 0.05 / 4).upper, 12);
    const two = welch(cf, dry, 0.05 / 8);
    expect(r.metrics.vetoGapAbsUpper).toBeCloseTo(Math.max(Math.abs(two.upper), Math.abs(two.lower)), 12);
    // The fill-error bound in the execution allowance is the fourth part, one-sided at 1 − α/4 (it was 95%).
    const abs = g3Pass.fillDifferences.map(Math.abs);
    const fillUpper = mean(abs) + studentTQuantile(1 - 0.05 / 4, abs.length - 1) * sd(abs) / Math.sqrt(abs.length);
    expect(r.metrics.executionAllowance).toBeCloseTo(2 * fillUpper, 12);
    const at95 = gateG3({ ...g3Pass, holdoutLower: { value: 0.06, level: 0.95, estimand: CAPPED_ESTIMAND } });
    expect(at95.status).toBe('fail');
    expect(at95.reasons.join()).toMatch(/holdout bound level: .*need 0.9875/);
    // S2 ruling C6 with M1: the capped holdout bound's level is the composite's own, one constant.
    expect(HOLDOUT_LOWER_LEVEL).toBe(VETO_COMPOSITE_LEVEL);
  });
  // Mutant S3 (the |Δ| bound replaced by its point estimate) must fail this test: only Δ's uncertainty pushes the bias
  // above 5 points. Vetoed candidates are 40 points worse than kept trades, so the selection allowance is 0.
  test('the bias uses the gap bound, not its point estimate (kills mutant S3)', () => {
    const keptMean = mean(dry);
    // A wide spread (±0.8) kept inside the estimand's range [RETURN_FLOOR, 3] once shifted (S2: below the floor fails).
    const raw = Array.from({ length: 100 }, (_, i) => (i % 2 === 0 ? -0.8 : 0.8));
    const cf = raw.map((x) => x - mean(raw) + keptMean - 0.4);
    expect(Math.min(...cf)).toBeGreaterThanOrEqual(RETURN_FLOOR);
    const r = gateG3({ ...g3Pass, liveOnlyVetoes: { vetoed: 100, eligible: 1000 }, vetoCounterfactuals: cfOf(cf) });
    const point = 0.1 * Math.abs(r.metrics.vetoGap!);
    expect(point).toBeLessThanOrEqual(0.05);
    expect(r.metrics.vetoRateUpperComposite! * Math.abs(r.metrics.vetoGap!)).toBeLessThanOrEqual(0.05);
    expect(r.metrics.vetoBiasUpper!).toBeGreaterThan(0.05);
    expect(r.metrics.selectionAllowance).toBe(0);
    expect(r.passed).toBe(false);
    expect(r.reasons.map((x) => x.split(':')[0])).toEqual(['veto bias']);
  });
  // Mutant S9 (execution allowance 0) must fail this test: only 2 × the fill-difference bound pushes the retained
  // lower bound to 0 or below.
  test('the retained bound subtracts the execution allowance (kills mutant S9)', () => {
    const base = gateG3(g3Pass);
    const sel = base.metrics.selectionAllowance!;
    const exec = base.metrics.executionAllowance!;
    expect(exec).toBeGreaterThan(0);
    const r = gateG3({ ...g3Pass, holdoutLower: { value: sel + exec / 2, level: HOLDOUT_LOWER_LEVEL, estimand: CAPPED_ESTIMAND } });
    expect(r.metrics.retainedLower!).toBeLessThanOrEqual(0);
    expect(r.metrics.retainedLower! + exec).toBeGreaterThan(0);
    expect(r.passed).toBe(false);
    expect(r.reasons.map((x) => x.split(':')[0])).toEqual(['retained expectancy']);
  });
  // S2 (external audit; supervisor and stats rulings C1, C2, C5, C6): G3's bounded inputs are the capped estimand
  // r_c = min(rNet, 3), "net, capped at +300%"; both sides of every comparison are capped identically.
  test('C5: a vetoed trade at +500% with a 0.3 take-profit never gives a gap above the stated worst case 3 − RETURN_FLOOR', () => {
    const cf = Array(12).fill(5) as number[];
    const r = gateG3({ ...g3Pass, liveOnlyVetoes: { vetoed: 12, eligible: 1000 }, vetoCounterfactuals: cfOf(cf) });
    expect(r.metrics.vetoWorstGap).toBeCloseTo(MAX_RETURN_CAP - RETURN_FLOOR, 12);
    expect(r.metrics.vetoGap!).toBeCloseTo(3 - mean(dry.map((x) => Math.min(x, 3))), 12);
    expect(r.metrics.vetoGap!).toBeLessThanOrEqual(r.metrics.vetoWorstGap!);
    expect(r.metrics.vetoGapAbsUpper!).toBeLessThanOrEqual(r.metrics.vetoWorstGap!);
  });

  test('C6: the holdout bound must be the capped estimand\'s, and no return may sit below RETURN_FLOOR', () => {
    // The holdout summary as a whole carries the tag too: its mean and sd must be the capped ones.
    const wholeWrong = gateG3({ ...g3Pass, holdout: { ...g3Pass.holdout, estimand: 'net' } });
    expect(wholeWrong.status).toBe('fail');
    expect(wholeWrong.reasons.join()).toMatch(/estimand: .*holdout summary on "net"/);
    const wrong = gateG3({ ...g3Pass, holdoutLower: { ...g3Pass.holdoutLower, estimand: 'net' } });
    expect(wrong.status).toBe('fail');
    expect(wrong.reasons.join()).toMatch(/estimand: .*net, capped at \+300%/);
    expect(gateG3({ ...g3Pass, holdoutBelowFloor: 1 }).reasons.join()).toMatch(/return floor/);
    expect(gateG3({ ...g3Pass, ...keptOf([...dry.slice(1), -1.2]) }).reasons.join()).toMatch(/return floor/);
    expect(gateG3({ ...g3Pass, vetoCounterfactuals: cfOf([...g3Pass.vetoCounterfactuals.returns.slice(1), -1.5]) }).reasons.join()).toMatch(/return floor/);
  });

  test('C1: capped counts are reported per arm and for the holdout; a capped tail only among the vetoed is "not proven", never a pass', () => {
    const base = gateG3({ ...g3Pass, holdoutCapped: 4 });
    expect(base.passed).toBe(true);
    expect([base.metrics.keptCapped, base.metrics.vetoedCapped, base.metrics.holdoutCapped]).toEqual([0, 0, 4]);
    const cf = [...g3Pass.vetoCounterfactuals.returns.slice(1), 4];
    const tail = gateG3({ ...g3Pass, vetoCounterfactuals: cfOf(cf) });
    expect(tail.metrics.vetoedCapped).toBe(1);
    expect(tail.status).toBe('not-proven');
    expect(tail.reasons.map((x) => x.split(':')[0])).toEqual(['veto bias tail']);
    // Kept trades capped too, at a like share: the tail rule is satisfied.
    const both = gateG3({ ...g3Pass, vetoCounterfactuals: cfOf(cf), ...keptOf([...dry.slice(2), 4, 4]) });
    expect(both.checks.find((x) => x.name === 'veto bias tail')!.passed).toBe(true);
    // Both arms capped, but the vetoed far more often (10 of 20 against 1 of 30): one-sided Fisher below α/4.
    const heavy = [...g3Pass.vetoCounterfactuals.returns.slice(10), ...Array(10).fill(4)] as number[];
    const skew = gateG3({ ...g3Pass, vetoCounterfactuals: cfOf(heavy), ...keptOf([...dry.slice(1), 4]) });
    expect(skew.metrics.vetoTailP!).toBeLessThan(VETO_TAIL_ALPHA);
    expect(skew.checks.find((x) => x.name === 'veto bias tail')!.passed).toBe(false);
    expect(skew.passed).toBe(false);
    // The test itself: all 3 of 6 successes in the first arm of 3 has probability 1 / C(6, 3).
    expect(fisherGreater(3, 3, 0, 3)).toBeCloseTo(1 / 20, 12);
    expect(fisherGreater(0, 3, 3, 3)).toBeCloseTo(1, 12);
  });

  test('C2: the agree checks compare capped means; each side\'s capped count is shown', () => {
    // One dry-run trade at +5,000%: uncapped it would move the mean by about 1.7 points per trade.
    const r = gateG3({ ...g3Pass, ...keptOf([...dry.slice(1), 50]) });
    expect(r.metrics.dryRunMean).toBeCloseTo(mean([...dry.slice(1), 3]), 12);
    expect(r.checks.find((x) => x.name === 'mean')!.detail).toMatch(/capped at \+300%: dry run 1, holdout 0/);
  });

  test('a joint G-test of the reject mix sits beside the per-reason intervals; a doubled H8 share disagrees', () => {
    const ok = gateG3(g3Pass);
    expect(ok.checks.find((c) => c.name === 'reject mix joint')!.passed).toBe(true);
    // The backtest puts 21.5% of rejects on H8; the dry run doubles it.
    const doubled = gateG3({ ...g3Pass, rejectMix: { dryRun: { H8: 421, H9: 490, H11: 69 }, backtest: g3Pass.rejectMix.backtest } });
    expect(doubled.status).toBe('fail');
    expect(doubled.reasons.join(' | ')).toMatch(/reject mix joint: G-test over 3 reasons/);
    expect(rejectMixGTest({ a: 5, b: 1 }, { a: 10 }).p).toBe(0);
  });
  test('consistency levels stay at their registered values: 95% per-reason intervals, an explicit 90% predictive interval', () => {
    expect(G3_DEFAULTS.meanPredictiveLevel).toBe(0.9);
    expect(gateG3(g3Pass).checks.find((c) => c.name === 'mean')!.detail).toMatch(/holdout 90% predictive interval/);
    expect(gateG3(g3Pass).checks.find((c) => c.name === 'reject mix H8')!.detail).toMatch(/95% interval/);
    expect(() => gateG3(g3Pass, { meanPredictiveLevel: 0.95 })).toThrow(/only be tightened/);
    expect(gateG3(g3Pass, { meanPredictiveLevel: 0.5 }).checks.find((c) => c.name === 'mean')!.detail).toMatch(/50% predictive/);
  });
  test('G3 is judged at the end registered with the strategy, never earlier; the end is at least 48 h after the start', () => {
    const reg = (endMs: number) => ({ ...g3Pass.registration, evaluateAtMs: endMs });
    const early = gateG3({ ...g3Pass, registration: reg(g3Pass.dryRunStartMs + 10 * DAY) });
    expect(early.status).toBe('not-proven');
    expect(early.reasons.join()).toMatch(/registered end: /);
    const tooShort = gateG3({ ...g3Pass, registration: reg(g3Pass.dryRunStartMs + DAY) });
    expect(tooShort.status).toBe('fail');
    expect(gateG3({ ...g3Pass, dryRunHours: 24 * 10, registration: reg(g3Pass.dryRunStartMs + 10 * DAY) }).checks.find((c) => c.name === 'registered end')!.passed).toBe(true);
    // Nor later (review STATS-1c): a run that kept going past its registered end, uncut, fails; within a minute is fine.
    const late = gateG3({ ...g3Pass, dryRunHours: 24 * 10 + 1, registration: reg(g3Pass.dryRunStartMs + 10 * DAY) });
    expect(late.status).toBe('fail');
    expect(late.reasons.join()).toMatch(/registered end: .*cut at it/);
    expect(gateG3({ ...g3Pass, dryRunHours: 24 * 10 + 0.5 / 60, registration: reg(g3Pass.dryRunStartMs + 10 * DAY) }).checks.find((c) => c.name === 'registered end')!.passed).toBe(true);
  });
  test('the new G3 thresholds tighten but never loosen', () => {
    expect(() => gateG3(g3Pass, { minVetoedForGap: 5 })).toThrow(/only be tightened/);
    expect(() => gateG3(g3Pass, { vetoBiasMax: 0.1 })).toThrow(/only be tightened/);
    expect(() => gateG3(g3Pass, { retainedLowerMin: -0.01 })).toThrow(/only be tightened/);
    expect(gateG3(g3Pass, { retainedLowerMin: 0.2 }).passed).toBe(false);
  });
  test('the veto gap is cluster-robust by creator: shared creators widen it, missing labels fail (external audit S4)', () => {
    const cf = g3Pass.vetoCounterfactuals.returns;
    const base = gateG3(g3Pass);
    // The same kept trades from 3 creators instead of 60, each creator's trades alike (low, middle and high returns):
    // the gap bounds widen, because their shared component is no longer assumed away.
    const order = dry.map((_, i) => i).sort((i, j) => dry[i]! - dry[j]!);
    const fewCreators = dry.map(() => '');
    order.forEach((i, pos) => { fewCreators[i] = `k${Math.floor((3 * pos) / dry.length)}`; });
    const clustered = gateG3({ ...g3Pass, ...keptOf(dry, fewCreators) });
    expect(clustered.metrics.vetoGapClustersKept).toBe(3);
    expect(clustered.metrics.vetoGapUpper!).toBeGreaterThan(base.metrics.vetoGapUpper!);
    expect(clustered.metrics.vetoGapUpper).toBeCloseTo(clusterWelchBounds(cf, cf.map((_, i) => `v${i}`), dry, fewCreators, VETO_COMPOSITE_ALPHA).upper, 12);
    // Missing or misaligned labels fail; one creator a side leaves the gap unmeasured (worst case).
    const unlabelled = gateG3({ ...g3Pass, dryRunClusters: dry.slice(1).map((_, i) => `k${i}`) });
    expect(unlabelled.reasons.join(' | ')).toMatch(/veto clusters: .* for 60 kept trades \(need one non-empty creator cluster each\)/);
    expect(gateG3({ ...g3Pass, ...keptOf(dry, dry.map(() => '')) }).reasons.join()).toMatch(/veto clusters/);
    const oneCreator = gateG3({ ...g3Pass, ...keptOf(dry, dry.map(() => 'same')) });
    expect(oneCreator.metrics.vetoGap).toBeNull();
    expect(oneCreator.notes.join()).toMatch(/on >= 2 creator clusters each\): the worst case/);
  });
  test('the cluster-robust gap bound by hand: CR2 variance and Bell–McCaffrey df on 3 creators a side (review B4)', () => {
    // a = 1, 2, 3, 6 on creators x, x, y, z: mean 3, residual sums x −3, y 0, z 3, sizes 2, 1, 1 of 4.
    // CR2: (9/(1 − 2/4) + 0/(1 − 1/4) + 9/(1 − 1/4)) / 4² = 30/16 = 1.875 (CR1 would give 3/2 · 18/16 = 1.6875).
    // df: r_g = n_g²/(n − n_g) = 2, 1/3, 1/3; 4² / (Σn_g² + (Σr)² − Σr²) = 16 / (6 + 64/9 − 38/9) = 1.8 (G − 1 would be 2).
    // b = 0, 2, 4 on creators p, q, r: mean 2, sums −2, 0, 2, sizes 1 of 3: (4/(2/3) + 0 + 4/(2/3))/9 = 4/3 = 32/24,
    // df: r_g = 1/2 each, 9 / (3 + 9/4 − 3/4) = 2 (one trade a creator: n − 1).
    // Satterthwaite: (Va + Vb)² / (Va²/1.8 + Vb²/2) = 77² / (45²/1.8 + 32²/2) = 5929/1637 with Va = 45/24, Vb = 32/24.
    const r = clusterWelchBounds([1, 2, 3, 6], ['x', 'x', 'y', 'z'], [0, 2, 4], ['p', 'q', 'r'], 0.05);
    const df = 5929 / 1637;
    expect(r.diff).toBe(1);
    expect(r.se ** 2).toBeCloseTo(77 / 24, 12);
    expect(r.df).toBeCloseTo(df, 12);
    expect(r.df).toBeCloseTo(3.62187, 5);
    expect(r.upper).toBeCloseTo(1 + studentTQuantile(0.95, df) * Math.sqrt(77 / 24), 12);
    expect(r.lower).toBeCloseTo(1 - studentTQuantile(0.95, df) * Math.sqrt(77 / 24), 12);
    // Every observation its own cluster: the Welch variance s²/n and df n − 1 a side.
    const own = clusterWelchBounds([1, 2, 3, 6], ['a', 'b', 'c', 'd'], [0, 0, 3, 5], ['e', 'f', 'g', 'h']);
    expect(own.se ** 2).toBeCloseTo(variance([1, 2, 3, 6]) / 4 + variance([0, 0, 3, 5]) / 4, 12);
    expect(own.df).toBeCloseTo((7 / 6 + 1.5) ** 2 / ((7 / 6) ** 2 / 3 + 1.5 ** 2 / 3), 12);
  });
  test('counterfactual scoring takes the outcome-stage labels of the vetoed candidates and counts censored ones', () => {
    const label = (rNet: number | null, censored = false): TripleBarrierLabel => ({
      cfgId: 'tp30_sl15', entryFilled: rNet !== null, yTb: null, rNet, touchSlot: null, exitSlot: null, mfe: null, mae: null,
      blocked: false, nExitAttempts: 1, yMeta: null, ySevere: null, censored,
    });
    expect(scoreVetoCounterfactuals([label(0.27), label(-0.18), label(null, true)], ['c1', 'c2', 'c3'])).toEqual({ returns: [0.27, -0.18], clusters: ['c1', 'c2'], censored: 1 });
    expect(() => scoreVetoCounterfactuals([label(0.27), { ...label(0.1), cfgId: 'other' }], ['c1', 'c2'])).toThrow(/one barrier configuration/);
    expect(() => scoreVetoCounterfactuals([label(0.27)], [])).toThrow(/1 labels but 0 creator clusters/);
  });
});

const g4Pass: G4Input = {
  liveTrades: 30, doubleBuys: 0, unreconciledBalances: 0, signerPolicyBypasses: 0, firstAttemptLandingFailures: 3,
  unlandedExits: 0, blockedExits: 0, liveMinusPaper: [-0.004, 0.001, -0.008, -0.002, 0.0],
};

describe('G4 canary mechanics', () => {
  test('passes clean mechanics with 3 of 30 first-attempt failures', () => {
    expect(gateG4(g4Pass)).toMatchObject({ passed: true, reasons: [] });
  });
  test('fails on 4 of 30 landing failures, a double buy or a blocked exit', () => {
    expect(gateG4({ ...g4Pass, firstAttemptLandingFailures: 4 }).reasons[0]).toMatch(/^landing/);
    expect(gateG4({ ...g4Pass, doubleBuys: 1 }).status).toBe('fail');
    expect(gateG4({ ...g4Pass, blockedExits: 1 }).passed).toBe(false);
    expect(gateG4({ ...g4Pass, liveMinusPaper: [-0.02, -0.03] }).reasons[0]).toMatch(/^live vs paper/);
  });
  test('fewer than 30 clean trades is "not proven"; a double buy is still a fail', () => {
    expect(gateG4({ ...g4Pass, liveTrades: 12, firstAttemptLandingFailures: 1 }).status).toBe('not-proven');
    expect(gateG4({ ...g4Pass, liveTrades: 12, doubleBuys: 1 }).status).toBe('fail');
  });
  test('0 blocked exits in 30 trades is reported as a bound (about 9.5% one-sided), not a proof', () => {
    const r = gateG4(g4Pass);
    expect(r.metrics.blockedExitUpper95!).toBeCloseTo(0.0950, 4);
    expect(r.notes.join()).toMatch(/0 blocked exits in 30 trades bounds the blocked-exit rate at 9\.5% \(one-sided 95%\), not 0/);
  });
});

// 120 days of one live trade at +12%: the e-process bets once per day.
const live = bracketTrades(51, 0.12, 120, 1).map(({ day, rNet }) => ({ day, rNet }));
const g5Pass: G5Input = {
  liveReturns: live, backtestGatesPassingOnNewestData: true, impactAtProposedSize: 0.003,
  lastPlatformChangeMs: NOW - 10 * DAY, nowMs: NOW,
};

describe('G5 proposal to the owner', () => {
  test('passes: the proposal may go to the owner', () => {
    const r = gateG5(g5Pass);
    expect(r.reasons).toEqual([]);
    expect(r.passed).toBe(true);
    expect(sharpeRatio(live.map((t) => t.rNet))).toBeGreaterThan(0);
  });
  test('fails on a recent platform change, high impact or a stale backtest', () => {
    const r = gateG5({ ...g5Pass, lastPlatformChangeMs: NOW - 3 * DAY, impactAtProposedSize: 0.005, backtestGatesPassingOnNewestData: false });
    expect(r.reasons.map((x) => x.split(':')[0])).toEqual(['backtest gates', 'impact', 'platform']);
  });
  test('fewer than 100 live trades is "not proven"', () => {
    expect(gateG5({ ...g5Pass, liveReturns: live.slice(0, 40) }).status).toBe('not-proven');
  });
});

// Review STATS-1b, finding 3 and the #52 review: B5 (2026-10-02 15:47) lies INSIDE the registered holdout window
// [09-22, 10-20) but is marked economics-unchanged (UPG-1), so revalidation needs its before/after report, not a
// post-B5 dry run. A change that changed economics, or was not reviewed, inside the window fails it.
describe('post-change revalidation', () => {
  const holdoutStartMs = Date.UTC(2026, 8, 22);
  const holdoutEndMs = Date.UTC(2026, 9, 20); // E = 2026-10-20
  const b5 = KNOWN_PLATFORM_CHANGES.find((c) => c.id === 'B5')!;
  const report = { produced: true, economicsUnchanged: true };
  const ok: RevalidationInput = {
    holdoutStartMs, holdoutEndMs, platformChanges: KNOWN_PLATFORM_CHANGES, dryRun: null, postChangeBacktest: null, insideReport: report,
  };
  test('B5 is recorded at 2026-10-02 15:47 UTC, inside the window, with economics unchanged (UPG-1)', () => {
    expect(b5).toMatchObject({ atMs: Date.UTC(2026, 9, 2, 15, 47), economicsUnchanged: true });
    expect(b5.atMs > holdoutStartMs && b5.atMs < holdoutEndMs).toBe(true);
  });
  test('passes when B5 is inside the window and its before/after report shows economics unchanged', () => {
    expect(evaluateRevalidation(ok)).toMatchObject({ passed: true, status: 'pass', reasons: [] });
  });
  test('B5 inside with no report is not proven; with a report that found a change it fails', () => {
    expect(evaluateRevalidation({ ...ok, insideReport: null }).status).toBe('not-proven');
    expect(evaluateRevalidation({ ...ok, insideReport: null }).reasons.join()).toMatch(/inside-change report: B5 inside the window needs a before\/after report/);
    const changed = evaluateRevalidation({ ...ok, insideReport: { produced: true, economicsUnchanged: false } });
    expect(changed.status).toBe('fail');
    expect(changed.reasons.join()).toMatch(/the report found a change/);
  });
  // Mutant R2: a breaking or unreviewed change inside the window, with nothing after it, must fail (not done('pass')).
  test('an economics-changed or unreviewed change inside the window fails (no later change)', () => {
    for (const eu of [false, null]) {
      const changed = KNOWN_PLATFORM_CHANGES.map((c) => (c.id === 'B5' ? { ...c, economicsUnchanged: eu } : c));
      const r = evaluateRevalidation({ ...ok, platformChanges: changed, insideReport: null });
      expect(r.status, `economicsUnchanged ${eu}`).toBe('fail');
      expect(r.reasons.join()).toMatch(/holdout regime: B5/);
    }
  });
  // A change AFTER the window (E = 10-20) keeps the post-change dry run and backtest machinery.
  const after = { id: 'B6', atMs: Date.UTC(2026, 9, 25), economicsUnchanged: true as boolean | null };
  const withAfter = { ...ok, platformChanges: [...KNOWN_PLATFORM_CHANGES, after] };
  test('a change after the window needs a qualifying post-change dry run that passed G3', () => {
    expect(evaluateRevalidation(withAfter).status).toBe('not-proven');
    expect(evaluateRevalidation(withAfter).reasons.join()).toMatch(/post-change dry run: none/);
    const dry = { qualifyingRun: true, startMs: after.atMs + DAY, g3: gateG3(g3Pass) };
    expect(evaluateRevalidation({ ...withAfter, dryRun: dry }).status).toBe('pass');
    expect(evaluateRevalidation({ ...withAfter, dryRun: { ...dry, startMs: after.atMs - 1 } }).reasons.join()).toMatch(/started before B6/);
    expect(evaluateRevalidation({ ...withAfter, dryRun: { ...dry, g3: gateG3({ ...g3Pass, parityTestPassed: false }) } }).status).toBe('fail');
  });
  test('an after-window change whose economics are contradicted also needs a backtest on >= 200 post-change candidates', () => {
    const base = { ...withAfter, platformChanges: [...KNOWN_PLATFORM_CHANGES, { ...after, economicsUnchanged: false }], dryRun: { qualifyingRun: true, startMs: after.atMs + DAY, g3: gateG3(g3Pass) } };
    expect(evaluateRevalidation(base).reasons.join()).toMatch(/post-change backtest: none/);
    expect(evaluateRevalidation({ ...base, postChangeBacktest: { firstCandidateMs: after.atMs + 1, candidates: 199, gatesPassed: true } }).status).toBe('not-proven');
    expect(evaluateRevalidation({ ...base, postChangeBacktest: { firstCandidateMs: after.atMs - 1, candidates: 400, gatesPassed: true } }).status).toBe('not-proven');
    expect(evaluateRevalidation({ ...base, postChangeBacktest: { firstCandidateMs: after.atMs + 1, candidates: 200, gatesPassed: false } }).status).toBe('fail');
    expect(evaluateRevalidation({ ...base, postChangeBacktest: { firstCandidateMs: after.atMs + 1, candidates: 200, gatesPassed: true } }).status).toBe('pass');
  });
  test('changes before the holdout starts need nothing more; the minimum count only tightens', () => {
    const before = KNOWN_PLATFORM_CHANGES.filter((c) => c.atMs < holdoutStartMs).map((c) => ({ ...c, economicsUnchanged: false }));
    expect(before.length).toBeGreaterThan(0);
    expect(evaluateRevalidation({ ...ok, platformChanges: before, insideReport: null }).status).toBe('pass');
    expect(() => evaluateRevalidation(ok, { minPostChangeCandidates: 100 })).toThrow(/only be tightened/);
  });
});


const demotionQuiet: DemotionInput = {
  returns: live, returnCap: 0.27, driftAlarm: false,
  coverage: { targetMiscoverage: 0.1, covered: Array.from({ length: 120 }, (_, i) => i % 10 !== 0) },
  platformChange: false, blockedExitTimesMs: [NOW - 40 * DAY, NOW - 5 * DAY], nowMs: NOW, ownerLossLimitHit: false,
};

describe('demotion', () => {
  test('no trigger: stays', () => {
    expect(evaluateDemotion(demotionQuiet)).toMatchObject({ demote: false, reasons: [] });
  });
  test('decay detected by the reverse e-process demotes', () => {
    const r = evaluateDemotion({ ...demotionQuiet, returns: bracketTrades(52, -0.08, 60, 5).map(({ day, rNet }) => ({ day, rNet })) });
    expect(r.demote).toBe(true);
    expect(r.reasons[0]).toMatch(/^reverse e-process/);
  });
  test('each other trigger demotes on its own', () => {
    expect(evaluateDemotion({ ...demotionQuiet, driftAlarm: true }).demote).toBe(true);
    expect(evaluateDemotion({ ...demotionQuiet, platformChange: true }).demote).toBe(true);
    expect(evaluateDemotion({ ...demotionQuiet, ownerLossLimitHit: true }).demote).toBe(true);
    expect(evaluateDemotion({ ...demotionQuiet, blockedExitTimesMs: [NOW - 20 * DAY, NOW - 1 * DAY] }).demote).toBe(true);
    const missed = Array.from({ length: 100 }, (_, i) => i % 4 !== 0); // 25% miscoverage vs 2 × 10%
    expect(evaluateDemotion({ ...demotionQuiet, coverage: { targetMiscoverage: 0.1, covered: missed } }).reasons[0]).toMatch(/^miscoverage/);
  });
  // The trial policy has no fixed take-profit: its first profit exit is the partial at partialAtR × R, with R at most
  // the maximum stop distance (ARCHITECTURE.md §9), so each universe's cap is its own partial: U2 1.5R (+30%), U1 2R
  // (+40%). Returns above it (the runner) are capped, which can only make demotion fire sooner. STATS-1c: the check
  // runs for every universe at its own cap. Measured (300 runs, 20 trades a day, a −10% decay): U2 at 30 days 0.987 /
  // 0.983 / 0.927 at ρ 0 / 0.05 / 0.1; U1 at 30 days 0.713 / 0.613 / 0.523, below 80%; U1 would need 40 days (1.0 / 0.99
  // / 0.93) or a −12.5% decay at 30 days (0.997 / 0.987 / 0.91). Recorded as is (supervisor ruling); STATS-1d's trailing
  // detector below cannot change a decay from the start, where it sees the same days.
  const capOf = (u: (typeof EXIT_UNIVERSES)[number]) => (TRIAL_POLICY.exits.universes[u].partialAtRBps / 10_000) * (TRIAL_POLICY.loss.stopMaxBps / 10_000);
  const caught = (cap: number, days: number, decay: number, rho: number) => {
    let n = 0;
    for (let r = 0; r < 300; r++) {
      const d = bracketTrades(9000 + r + Math.round(rho * 1e6), decay, days, 20, rho).map(({ day, rNet }) => ({ day, rNet }));
      if (evaluateDemotion({ ...demotionQuiet, returns: d, returnCap: cap }).demote) n++;
    }
    return n / 300;
  };
  test('demotion power is checked for every universe at its own cap; U2 catches a −10% decay within 30 days in ≥ 80% of runs', () => {
    expect(EXIT_UNIVERSES).toEqual(['U1', 'U2']);
    expect(capOf('U2')).toBeCloseTo(0.3, 12);
    expect(capOf('U1')).toBeCloseTo(0.4, 12);
    const checked: string[] = [];
    for (const u of EXIT_UNIVERSES) {
      for (const rho of [0, 0.05, 0.1]) {
        const p30 = caught(capOf(u), 30, -0.1, rho);
        if (u === 'U2') expect(p30, `${u} ρ ${rho}`).toBeGreaterThanOrEqual(0.8);
        else {
          // Reported shortfall: below 80% at 30 days, at or above it with 40 days.
          expect(p30, `${u} ρ ${rho}`).toBeLessThan(0.8);
          expect(caught(capOf(u), 40, -0.1, rho), `${u} ρ ${rho} at 40 days`).toBeGreaterThanOrEqual(0.8);
        }
      }
      checked.push(u);
    }
    expect(checked).toEqual([...EXIT_UNIVERSES]);
  }, 600_000);
  // STATS-1d (supervisor ruling, 2026-10-04): beside the full-history reverse e-process, the same detector restarted on
  // the last 40 trading days; demotion fires on either. Measured by evaluating demotion daily, as the worker does.
  // Measured (100 runs): a −10% decay after 60 days at +5% is caught within 40 days by U1 1.0 / 0.95 and U2 1.0 / 1.0 at
  // ρ 0 / 0.1; full history alone at most 0.17; no demotion during the good stretch.
  /** The first day (0-based) a daily evaluation demotes, or null; `fullOnly` drops the trailing trigger (ablation). */
  const firstDemotion = (d: readonly { day: string; rNet: number }[], cap: number, fullOnly = false): number | null => {
    const days = [...new Set(d.map((t) => t.day))];
    for (let i = 0; i < days.length; i++) {
      const upTo = d.filter((t) => t.day <= days[i]!);
      const r = evaluateDemotion({ ...demotionQuiet, returns: upTo, returnCap: cap });
      const fired = fullOnly ? r.reasons.some((x) => x.startsWith('reverse e-process:')) : r.demote;
      if (fired) return i;
    }
    return null;
  };
  /** `good` days at +5%, then `bad` days at `decay`, 20 trades a day, day shock ρ. */
  const lateDecay = (seed: number, good: number, bad: number, decay: number, rho: number) => [
    ...bracketTrades(seed, 0.05, good, 20, rho).map(({ day, rNet }) => ({ day, rNet })),
    ...bracketTrades(seed + 50_000, decay, bad, 20, rho).map(({ rNet }, i) => ({ day: dayKey(good + Math.floor(i / 20)), rNet })),
  ];
  test('a decay after a good stretch is caught by the 40-day trailing detector; full history alone misses it', () => {
    expect(DEMOTION_TRAILING_DAYS).toBe(40);
    const RUNS = 100;
    for (const u of EXIT_UNIVERSES) {
      for (const rho of [0, 0.1]) {
        let caught = 0;
        let caughtFull = 0;
        let early = 0;
        for (let r = 0; r < RUNS; r++) {
          const d = lateDecay(20_000 + r + Math.round(rho * 1e6), 60, 40, -0.1, rho);
          const at = firstDemotion(d, capOf(u));
          if (at !== null && at < 60) early++;
          else if (at !== null) caught++;
          const full = firstDemotion(d, capOf(u), true);
          if (full !== null && full >= 60) caughtFull++;
        }
        expect(caught / RUNS, `${u} ρ ${rho}: caught within 40 days of the decay`).toBeGreaterThanOrEqual(0.8);
        expect(caughtFull / RUNS, `${u} ρ ${rho}: full history alone`).toBeLessThan(0.2);
        expect(early / RUNS, `${u} ρ ${rho}: demoted during the good stretch`).toBeLessThanOrEqual(0.05);
      }
    }
  }, 900_000);
  // Measured (100 runs, 120 days at zero edge, daily evaluation): U1 0 / 0.01 and U2 0 / 0.21 at ρ 0 / 0.1. U2 at ρ 0.1
  // comes from its +30% cap clipping the day shocks (full history alone: 0.18), the intended safe side; the trailing
  // detector adds at most a few points.
  test('false demotion at zero edge over 120 days: at most 5% unless the cap clips day shocks; the trailing detector adds at most 5 points', () => {
    const RUNS = 100;
    const rate: Record<string, number> = {};
    for (const u of EXIT_UNIVERSES) {
      for (const rho of [0, 0.1]) {
        let fired = 0;
        let full = 0;
        for (let r = 0; r < RUNS; r++) {
          const d = bracketTrades(30_000 + r + Math.round(rho * 1e6), 0, 120, 20, rho).map(({ day, rNet }) => ({ day, rNet }));
          if (firstDemotion(d, capOf(u)) !== null) fired++;
          if (firstDemotion(d, capOf(u), true) !== null) full++;
        }
        rate[`${u} ${rho}`] = fired / RUNS;
        expect((fired - full) / RUNS, `${u} ρ ${rho}: added by the trailing detector`).toBeLessThanOrEqual(0.05);
        if (rho === 0 || u === 'U1') expect(fired / RUNS, `${u} ρ ${rho}`).toBeLessThanOrEqual(0.05);
      }
    }
    expect(rate).toEqual({ 'U1 0': 0, 'U1 0.1': 0.01, 'U2 0': 0, 'U2 0.1': 0.21 });
  }, 900_000);
  test('the return cap is limited to (0, 3]: an out-of-range cap demotes instead of blinding the detector', () => {
    const decay = bracketTrades(53, -0.1, 100, 10).map(({ day, rNet }) => ({ day, rNet }));
    expect(evaluateDemotion({ ...demotionQuiet, returns: decay, returnCap: 0.27 }).reasons[0]).toMatch(/^reverse e-process/);
    expect(evaluateDemotion({ ...demotionQuiet, returnCap: 30 })).toMatchObject({ demote: true });
    expect(evaluateDemotion({ ...demotionQuiet, returnCap: 30 }).reasons[0]).toMatch(/^return cap: return cap 30 is outside \(0, 3\]/);
    expect(evaluateDemotion({ ...demotionQuiet, returnCap: 0 }).demote).toBe(true);
    expect(() => evaluateDemotion(demotionQuiet, { returnCapMax: 5 })).toThrow(/only be tightened/);
    expect(evaluateDemotion(demotionQuiet, { returnCapMax: 0.2 }).reasons[0]).toMatch(/^return cap/);
  });
  test('demotion triggers can be made more sensitive, not less', () => {
    expect(() => evaluateDemotion(demotionQuiet, { reverseWealth: 50 })).toThrow(/only be tightened/);
    expect(evaluateDemotion(demotionQuiet, { blockedExitsMax: 1 }).demote).toBe(true);
  });
});
