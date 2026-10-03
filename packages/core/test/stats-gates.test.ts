// Every gate has a passing and a failing fixture; thresholds can be tightened but never loosened.
import { describe, expect, test } from 'vitest';
import {
  createRng, evaluateDemotion, gateG0, gateG1, gateG2, gateG3, gateG4, gateG5, mean, sd, sharpeRatio,
  type DemotionInput, type G0Input, type G1Input, type G2Input, type G3Input, type G4Input, type G5Input,
} from '../src/stats/index.ts';
import { bracketTrades, type DayTrade } from './stats-fixtures.ts';

const DAY = 86_400_000;
const NOW = 1_790_000_000_000;

const g0Pass: G0Input = {
  survivorshipFree: true, secondSourceCoverage: 0.97, leakTestPassed: true, shiftTestPassed: true,
  replayLogHashes: Array(10).fill('abc'), parityTestPassed: true, labelsScoredSeparately: true, labelCoverageAuditPassed: true,
};

describe('G0 data and engine validity', () => {
  test('passes when every check holds', () => {
    const r = gateG0(g0Pass);
    expect(r).toMatchObject({ gate: 'G0', passed: true, status: 'pass', reasons: [] });
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
const winnerDaily = [...new Set(wf.map((t) => t.day))].map((d) => mean(wf.filter((t) => t.day === d).map((t) => t.rNet)));
const pboMatrix = [winnerDaily, ...Array.from({ length: 5 }, (_, k) => winnerDaily.map((x, i) => x - 0.15 - 0.01 * k + 0.02 * Math.sin(i + k)))];
const g1Pass = (): G1Input => ({
  scenario: 'conservative', rulesRegisteredBeforeHoldout: true, trades: wf, control, selectedTrialId: 't19', registry,
  pboMatrix, pboBlocks: 8, modelUsed: false, calibrationSlope: null, rng: createRng(1), replicates: 1000,
});

describe('G1 walk-forward', () => {
  test('passes a strong, spread-out edge', () => {
    const r = gateG1(g1Pass());
    expect(r.reasons).toEqual([]);
    expect(r.passed).toBe(true);
    expect(r.metrics.dsr!).toBeGreaterThanOrEqual(0.95);
    expect(r.metrics.pbo).toBe(0);
  });
  test('fails a zero-edge strategy on the bound, DSR, concentration and S0', () => {
    const flat = bracketTrades(23, 0, 40, 15);
    const r = gateG1({ ...g1Pass(), trades: flat, control: bracketTrades(24, 0, 40, 15) });
    expect(r.passed).toBe(false);
    const failed = r.reasons.map((x) => x.split(':')[0]);
    expect(failed).toContain('mean');
    expect(failed).toContain('DSR');
    expect(failed).toContain('S0');
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
  test('too little data is "not proven", not a pass', () => {
    const r = gateG1({ ...g1Pass(), trades: wf.slice(0, 2) });
    expect(r.status).toBe('not-proven');
    expect(r.passed).toBe(false);
  });
  test('thresholds tighten but never loosen', () => {
    expect(gateG1(g1Pass(), { dsrMin: 0.999999 }).reasons.some((x) => x.startsWith('DSR'))).toBe(true);
    expect(() => gateG1(g1Pass(), { dsrMin: 0.9 })).toThrow(/only be tightened/);
    expect(() => gateG1(g1Pass(), { pboMax: 0.5 })).toThrow(/only be tightened/);
    expect(() => gateG1(g1Pass(), { madeUp: 1 } as never)).toThrow(/unknown threshold/);
  });
});

// Holdout fixture: 25 days × 16 = 400 trades at +10%. σ̂ ≈ 0.32 → n_power ≈ 322.
const holdout = bracketTrades(31, 0.1, 25, 16);
const g2Pass = (): G2Input => ({
  scenario: 'conservative', rulesFrozenBeforeHoldout: true, holdoutEvaluations: 1, holdout,
  walkForward: wf.map(({ day, rNet }) => ({ day, rNet })), rng: createRng(2), replicates: 1000,
});

describe('G2 holdout', () => {
  test('passes with enough trades, CI above zero, e-process ≥ 20 and a consistent mean', () => {
    const r = gateG2(g2Pass());
    expect(r.reasons).toEqual([]);
    expect(r.status).toBe('pass');
    expect(r.metrics.requiredTrades!).toBeGreaterThan(300);
    expect(r.metrics.eWealthMax!).toBeGreaterThanOrEqual(20);
  });
  test('a second look at the holdout fails', () => {
    const r = gateG2({ ...g2Pass(), holdoutEvaluations: 2 });
    expect(r).toMatchObject({ passed: false, status: 'fail' });
  });
  test('fewer trades than max(300, n_power) is "not proven"', () => {
    const r = gateG2({ ...g2Pass(), holdout: holdout.slice(0, 250) });
    expect(r.status).toBe('not-proven');
    expect(r.reasons[0]).toMatch(/^sample size/);
  });
  test('a losing holdout of 400+ trades is rejected for futility', () => {
    const r = gateG2({ ...g2Pass(), holdout: bracketTrades(32, -0.05, 25, 20) });
    expect(r.status).toBe('futile');
    expect(r.reasons.some((x) => x.startsWith('futility'))).toBe(true);
  });
  test('a holdout far from the walk-forward fails the predictive check', () => {
    const r = gateG2({ ...g2Pass(), walkForward: wf.map(({ day, rNet }) => ({ day, rNet: rNet + 0.2 })) });
    expect(r.reasons.some((x) => x.startsWith('predictive'))).toBe(true);
    expect(r.status).toBe('fail');
  });
});

const dry = bracketTrades(41, 0.1, 2, 30).map((t) => t.rNet);
const g3Pass: G3Input = {
  dryRunHours: 49, dryRunReturns: dry,
  holdout: { n: holdout.length, mean: mean(holdout.map((t) => t.rNet)), sd: sd(holdout.map((t) => t.rNet)) },
  candidates: { dryRunCount: 980, dryRunHours: 49, backtestCount: 20_000, backtestHours: 1000 },
  rejectMix: { dryRun: { H8: 210, H9: 700, H11: 70 }, backtest: { H8: 4300, H9: 14_200, H11: 1500 } },
  fillDifferences: [0.001, 0.002, 0.004, 0.003, 0.012], parityTestPassed: true,
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
    const r = gateG3({ ...g3Pass, dryRunReturns: dry.map((x) => x - 0.3) });
    expect(r.reasons.some((x) => x.startsWith('mean'))).toBe(true);
  });
  test('no paper trades is "not proven"', () => {
    expect(gateG3({ ...g3Pass, dryRunReturns: [] }).status).toBe('not-proven');
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
});

const live = bracketTrades(51, 0.1, 10, 12).map((t) => t.rNet);
const g5Pass: G5Input = {
  liveReturns: live, backtestGatesPassingOnNewestData: true, impactAtProposedSize: 0.003,
  lastPlatformChangeMs: NOW - 10 * DAY, nowMs: NOW,
};

describe('G5 proposal to the owner', () => {
  test('passes: the proposal may go to the owner', () => {
    const r = gateG5(g5Pass);
    expect(r.reasons).toEqual([]);
    expect(r.passed).toBe(true);
    expect(sharpeRatio(live)).toBeGreaterThan(0);
  });
  test('fails on a recent platform change, high impact or a stale backtest', () => {
    const r = gateG5({ ...g5Pass, lastPlatformChangeMs: NOW - 3 * DAY, impactAtProposedSize: 0.005, backtestGatesPassingOnNewestData: false });
    expect(r.reasons.map((x) => x.split(':')[0])).toEqual(['backtest gates', 'impact', 'platform']);
  });
  test('fewer than 100 live trades is "not proven"', () => {
    expect(gateG5({ ...g5Pass, liveReturns: live.slice(0, 40) }).status).toBe('not-proven');
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
    const r = evaluateDemotion({ ...demotionQuiet, returns: bracketTrades(52, -0.08, 10, 30).map((t) => t.rNet) });
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
  test('demotion triggers can be made more sensitive, not less', () => {
    expect(() => evaluateDemotion(demotionQuiet, { reverseWealth: 50 })).toThrow(/only be tightened/);
    expect(evaluateDemotion(demotionQuiet, { blockedExitsMax: 1 }).demote).toBe(true);
  });
});
