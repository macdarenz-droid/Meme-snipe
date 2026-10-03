// Every gate has a passing and a failing fixture; thresholds can be tightened but never loosened.
import { describe, expect, test } from 'vitest';
import {
  createRng, evaluateDemotion, gateG0, gateG1, gateG2, gateG3, gateG4, gateG5, mean, sd, sharpeRatio,
  registerHoldout, type DemotionInput, type G0Input, type G1Input, type G2Input, type G2PowerResult, type G2Universe,
  type G3Input, type G4Input, type G5Input, type TradeOutcome,
} from '../src/stats/index.ts';
import { bracketTrades, type DayTrade } from './stats-fixtures.ts';

const DAY = 86_400_000;
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

// Holdout fixture: 25 days × 16 = 400 trades at +10%. S0 at −20% on the same days over 200 seeds.
const holdout = bracketTrades(31, 0.1, 25, 16);
const controlRuns = Array.from({ length: 200 }, (_, k) => bracketTrades(1000 + k, -0.2, 25, 2).map(({ day, rNet }) => ({ day, rNet })));
const power = (nPower: number): G2PowerResult => ({ nPower, powerAtN: 0.8, level: 0.05, evaluations: [] });
const holdouts = registerHoldout([], { holdoutId: 'h1', universe: 'U1', configId: 'u1-v1', fromDay: '2026-09-01', toDay: '2026-09-25' });
const u1 = (over: Partial<G2Universe> = {}): G2Universe => ({
  universe: 'U1', configId: 'u1-v1', holdoutId: 'h1', trades: holdout, controlRuns,
  walkForward: wf.map(({ day, rNet }) => ({ day, rNet })), power: power(330), ...over,
});
const g2Pass = (over: Partial<G2Input> = {}): G2Input => ({
  scenario: 'conservative', registry: holdouts, universes: [u1()], rng: createRng(2), replicates: 1000, ...over,
});

describe('G2 holdout', () => {
  test('passes with enough trades and both CIs (mean, vs S0) above zero; the holdout is burned', () => {
    const r = gateG2(g2Pass());
    expect(r.reasons).toEqual([]);
    expect(r.status).toBe('pass');
    expect(r.universes[0]).toMatchObject({ universe: 'U1', status: 'pass', requiredTrades: 330, level: 0.05 });
    expect(r.registry.find((e) => e.holdoutId === 'h1')!.burned).toBe(true);
    expect(holdouts[0]!.burned).toBe(false); // the input registry is not mutated
  });
  test('the e-process, futility and predictive interval do not gate G2', () => {
    const names = gateG2(g2Pass()).checks.map((c) => c.name);
    expect(names.some((n) => /e-process|futility|predictive/.test(n))).toBe(false);
    // A holdout far from the walk-forward still passes; the miss is a note that asks for a written review.
    const r = gateG2(g2Pass({ universes: [u1({ walkForward: wf.map(({ day, rNet }) => ({ day, rNet: rNet + 0.2 })) })] }));
    expect(r.status).toBe('pass');
    expect(r.notes[0]).toMatch(/predictive interval.*write a review/);
  });
  test('a second look is refused', () => {
    const first = gateG2(g2Pass());
    const second = gateG2(g2Pass({ registry: first.registry }));
    expect(second).toMatchObject({ passed: false, status: 'fail' });
    expect(second.reasons[0]).toMatch(/burned: it was already scored, a second look is refused/);
    expect(second.registry).toBe(first.registry);
  });
  test('an unregistered or mismatched configuration, a duplicate universe or too few S0 seeds is refused', () => {
    expect(gateG2(g2Pass({ universes: [u1({ configId: 'u1-v2' })] })).reasons[0]).toMatch(/registered for U1\/u1-v1/);
    expect(gateG2(g2Pass({ universes: [u1({ holdoutId: 'nope' })] })).reasons[0]).toMatch(/not registered/);
    expect(gateG2(g2Pass({ universes: [u1(), u1()] })).reasons.join()).toMatch(/one configuration per universe/);
    expect(gateG2(g2Pass({ universes: [u1({ controlRuns: controlRuns.slice(0, 199) })] })).reasons[0]).toMatch(/199 S0 seeds/);
    expect(gateG2(g2Pass({ scenario: 'base' })).status).toBe('fail');
  });
  test('fewer trades than max(300, n_power) is "not proven", unscored and not burned', () => {
    const r = gateG2(g2Pass({ universes: [u1({ power: power(450) })] }));
    expect(r.status).toBe('not-proven');
    expect(r.universes[0]).toMatchObject({ status: 'not-proven', requiredTrades: 450, p: null });
    expect(r.registry[0]!.burned).toBe(false);
    expect(gateG2(g2Pass({ universes: [u1({ trades: holdout.slice(0, 299), power: power(100) })] })).universes[0]!.requiredTrades).toBe(300);
  });
  test('a positive mean that does not beat S0 fails', () => {
    // S0 matches the strategy day by day, slightly better: the edge is the market's, not the rules'.
    const asGood = Array.from({ length: 200 }, () => holdout.map(({ day, rNet }) => ({ day, rNet: rNet + 0.01 })));
    const r = gateG2(g2Pass({ universes: [u1({ controlRuns: asGood })] }));
    expect(r.status).toBe('fail');
    expect(r.universes[0]!.lower!).toBeGreaterThan(0);
    expect(r.universes[0]!.diffVsS0Lower!).toBeLessThanOrEqual(0);
  });
  test('Holm across universes: a marginal universe passes alone but not as the weaker of three', () => {
    // U2 is built so its p sits between 0.05/3 and 0.05: it passes at α = 0.05, not at the Holm level of a family of 3.
    let found: { trades: TradeOutcome[]; p: number } | null = null;
    for (let seed = 0; seed < 400 && !found; seed++) {
      const t = bracketTrades(5000 + seed, 0.035, 25, 16);
      const p = gateG2({ ...g2Pass(), universes: [u1({ trades: t })] }).universes[0]!.p!;
      if (p > 0.025 && p < 0.045) found = { trades: t, p };
    }
    expect(found).not.toBeNull();
    const alone = gateG2(g2Pass({ universes: [u1({ trades: found!.trades })] }));
    expect(alone.universes[0]!.status).toBe('pass');
    let reg = holdouts;
    reg = registerHoldout(reg, { holdoutId: 'h2', universe: 'U2', configId: 'u2-v1', fromDay: '2026-09-01', toDay: '2026-09-25' });
    reg = registerHoldout(reg, { holdoutId: 'h3', universe: 'U3', configId: 'u3-v1', fromDay: '2026-09-01', toDay: '2026-09-25' });
    const weak = bracketTrades(6000, -0.1, 25, 16);
    const r = gateG2(g2Pass({
      registry: reg,
      universes: [
        u1({ universe: 'U1', trades: found!.trades }),
        u1({ universe: 'U2', configId: 'u2-v1', holdoutId: 'h2', trades: weak }),
        u1({ universe: 'U3', configId: 'u3-v1', holdoutId: 'h3', trades: weak }),
      ],
    }));
    expect(r.universes[0]!.level).toBeCloseTo(0.05 / 3, 12);
    expect(r.universes[0]!.status).toBe('fail');
    expect(r.status).toBe('fail');
    expect(r.registry.every((e) => e.burned)).toBe(true);
  }, 60_000);
  test('G2 thresholds tighten but never loosen', () => {
    expect(() => gateG2(g2Pass(), { minTradesFloor: 200 })).toThrow(/only be tightened/);
    expect(() => gateG2(g2Pass(), { familyAlpha: 0.1 })).toThrow(/only be tightened/);
    expect(gateG2(g2Pass(), { minTradesFloor: 500 }).status).toBe('not-proven');
  });
});

const dry = bracketTrades(41, 0.1, 2, 30).map((t) => t.rNet);
const g3Pass: G3Input = {
  qualifyingRun: true, liveOnlyVetoRate: 0.02, dryRunHours: 49, dryRunReturns: dry,
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
  test('fewer than 30 paper trades: no mean check, rates and reject mix decide, and the result says so', () => {
    const few = gateG3({ ...g3Pass, dryRunReturns: dry.slice(0, 29).map((x) => x - 0.3) });
    expect(few.passed).toBe(true);
    expect(few.checks.some((c) => c.name === 'mean')).toBe(false);
    expect(few.notes[0]).toMatch(/29 paper trades.*candidate rate and the reject mix/);
    expect(gateG3({ ...g3Pass, dryRunReturns: [] }).passed).toBe(true);
  });
  test('a rehearsal run counts for nothing', () => {
    expect(gateG3({ ...g3Pass, qualifyingRun: false }).reasons[0]).toMatch(/^qualifying run/);
  });
  test('the live-only veto rate is reported', () => {
    expect(gateG3(g3Pass).metrics.liveOnlyVetoRate).toBe(0.02);
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
