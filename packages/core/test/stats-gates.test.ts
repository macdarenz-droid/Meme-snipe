// Every gate has a passing and a failing fixture; thresholds can be tightened but never loosened.
import { describe, expect, test } from 'vitest';
import {
  createRng, evaluateDemotion, gateG0, gateG1, gateG2, gateG3, gateG4, gateG5, mean, sd, sharpeRatio,
  createHoldoutRegistry, nPower, registerHoldout, summarizeWalkForward, type WalkForwardSummary, sealHoldout, type DemotionInput, type HoldoutRegistry, type G0Input, type G1Input, type G2Input, type G2PowerResult, type G2Universe,
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
// Keyed by trialId: the selected trial t19 wins every day; the other 19 registry trials trail it.
const pboMatrix: Record<string, number[]> = Object.fromEntries(registry.map((t, k) => [
  t.trialId, t.trialId === 't19' ? winnerDaily : winnerDaily.map((x, i) => x - 0.15 - 0.01 * k + 0.02 * Math.sin(i + k)),
]));
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
  test('the PBO matrix must hold exactly the registry trials, the selected one included', () => {
    const { t3: _a, t4: _b, ...subset } = pboMatrix;
    expect(gateG1({ ...g1Pass(), pboMatrix: subset }).reasons.join()).toMatch(/PBO: PBO matrix must hold exactly the registry's 20 trials \(missing 2/);
    const { t19: _c, ...noSelected } = pboMatrix;
    expect(gateG1({ ...g1Pass(), pboMatrix: noSelected }).reasons.join()).toMatch(/missing 1: t19/);
    expect(gateG1({ ...g1Pass(), pboMatrix: { ...pboMatrix, stranger: winnerDaily } }).reasons.join()).toMatch(/not in registry 1: stranger/);
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
  test('thresholds tighten but never loosen', () => {
    expect(gateG1(g1Pass(), { dsrMin: 0.999999 }).reasons.some((x) => x.startsWith('DSR'))).toBe(true);
    expect(() => gateG1(g1Pass(), { dsrMin: 0.9 })).toThrow(/only be tightened/);
    expect(() => gateG1(g1Pass(), { pboMax: 0.5 })).toThrow(/only be tightened/);
    expect(() => gateG1(g1Pass(), { madeUp: 1 } as never)).toThrow(/unknown threshold/);
  });
});

// Holdout fixture: 25 days × 20 = 500 trades at +10%, sealed. S0 at −20% on the same days over 200 seeds.
const holdout = bracketTrades(31, 0.1, 25, 20);
const counts = { candidates: 2000, entries: 500, entryDays: 25 };
const controlRuns = Array.from({ length: 200 }, (_, k) => bracketTrades(1000 + k, -0.2, 25, 2).map(({ day, rNet }) => ({ day, rNet })));
type PowerSpec = Omit<G2PowerResult, 'walkForward'> & { readonly walkForward?: WalkForwardSummary };
const power = (nPower: number, familySize = 1): PowerSpec => ({ nPower, powerAtN: 0.8, level: 0.05 / familySize, evaluations: [] });
const sealed = (familySize: number, universes: readonly string[], c = counts): HoldoutRegistry => {
  let reg = createHoldoutRegistry(familySize);
  for (const u of universes) {
    reg = registerHoldout(reg, { holdoutId: `h-${u}`, universe: u, configId: `${u}-v1`, fromDay: '2026-09-01', toDay: '2026-09-25' });
    reg = sealHoldout(reg, `h-${u}`, { configId: `${u}-v1`, ledgerHash: `hash-${u}`, counts: c }).registry;
  }
  return reg;
};
/** A universe whose n_power result fingerprints its own walk-forward unless the test says otherwise. */
const u = (name: string, over: Partial<Omit<G2Universe, 'power'>> & { readonly power?: PowerSpec } = {}, familySize = 1): G2Universe => {
  const walkForward = over.walkForward ?? wf.map(({ day, rNet }) => ({ day, rNet }));
  const p = over.power ?? power(330, familySize);
  return {
    universe: name, configId: `${name}-v1`, holdoutId: `h-${name}`, ledgerHash: `hash-${name}`, trades: holdout, controlRuns, ...over,
    walkForward, power: { ...p, walkForward: p.walkForward ?? summarizeWalkForward(walkForward) },
  };
};
const g2Pass = (over: Partial<G2Input> = {}): G2Input => ({
  scenario: 'conservative', registry: sealed(1, ['U1']), universes: [u('U1')], nowMs: NOW, rng: createRng(2), replicates: 1000, ...over,
});

// The closed-form n for the walk-forward σ̂ (≈ 0.33) is a lower bound on what the gate requires.
const closedWf = nPower(sd(wf.map((t) => t.rNet)), 0.05);

describe('G2 holdout (sealed, ARCHITECTURE.md §14 at 333f4ac)', () => {
  test('passes with enough trades and both CIs (mean, vs S0) above zero; the seal is opened once and burned', () => {
    const r = gateG2(g2Pass());
    expect(r.reasons).toEqual([]);
    expect(r.status).toBe('pass');
    expect(closedWf).toBeGreaterThan(330);
    expect(r.universes[0]).toMatchObject({ universe: 'U1', status: 'pass', requiredTrades: closedWf, entries: 500, level: 0.05 });
    expect(r.registry.entries[0]).toMatchObject({ seal: 'opened', openedAtMs: NOW, burned: true, burnReason: 'scored' });
  });
  test('the e-process, futility and predictive interval do not gate G2', () => {
    const names = gateG2(g2Pass()).checks.map((c) => c.name);
    expect(names.some((n) => /e-process|futility|predictive/.test(n))).toBe(false);
    const r = gateG2(g2Pass({ universes: [u('U1', { walkForward: wf.map(({ day, rNet }) => ({ day, rNet: rNet + 0.2 })) })] }));
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
  test('size comes from the sealed counts; short means "not proven", still sealed, not burned', () => {
    const r = gateG2(g2Pass({ universes: [u('U1', { power: power(600) })] }));
    expect(r.status).toBe('not-proven');
    expect(r.universes[0]).toMatchObject({ status: 'not-proven', requiredTrades: 600, p: null });
    expect(r.registry.entries[0]).toMatchObject({ seal: 'sealed', burned: false });
    // Counts decide, not the trades handed in: a short sealed count stays sealed even with 500 trades passed.
    const short = gateG2(g2Pass({ registry: sealed(1, ['U1'], { ...counts, entries: 299 }) }));
    expect(short.universes[0]).toMatchObject({ status: 'not-proven', requiredTrades: closedWf, entries: 299 });
    expect(short.registry.entries[0]!.burned).toBe(false);
    const fewDays = gateG2(g2Pass({ registry: sealed(1, ['U1'], { ...counts, entryDays: 9 }) }));
    expect(fewDays.status).toBe('not-proven');
  });
  test('the floor is 300 and the closed form is a lower bound on the simulated n_power', () => {
    const calm = wf.map(({ day, rNet }) => ({ day, rNet: rNet * 0.5 })); // σ̂ ≈ 0.16: closed form ≈ 90
    expect(gateG2(g2Pass({ universes: [u('U1', { power: power(100), walkForward: calm })] })).universes[0]!.requiredTrades).toBe(300);
    expect(gateG2(g2Pass({ universes: [u('U1', { power: power(450) })] })).universes[0]!.requiredTrades).toBe(450);
    // A walk-forward with σ̂ ≈ 0.65 needs ~1,300 by the closed form; a low simulated n_power cannot lower that.
    const wide = wf.map(({ day, rNet }, i) => ({ day, rNet: i % 2 === 0 ? rNet * 2 : rNet * 2 - 0.1 }));
    const r = gateG2(g2Pass({ universes: [u('U1', { walkForward: wide })] }));
    expect(r.universes[0]!.requiredTrades).toBeGreaterThan(1000);
    expect(r.status).toBe('not-proven');
  });
  test('Holm runs over the registry family: one ready universe of three is tested at α/3, absent ones count as p = 1', () => {
    // Find a holdout with p ≈ 0.03: it would pass at α = 0.05 but must fail at α/3 = 0.0167.
    let found: TradeOutcome[] | null = null;
    for (let seed = 0; seed < 400 && !found; seed++) {
      const t = bracketTrades(7000 + seed, 0.035, 25, 20);
      const p = gateG2(g2Pass({ universes: [u('U1', { trades: t })] })).universes[0]!.p!;
      if (p > 0.02 && p < 0.045) found = t;
    }
    expect(found).not.toBeNull();
    const r = gateG2(g2Pass({ registry: sealed(3, ['U1', 'U2', 'U3']), universes: [u('U1', { trades: found! }, 3)] }));
    expect(r.universes[0]).toMatchObject({ status: 'fail', level: 0.05 / 3 });
    expect(r.status).toBe('fail');
    // The other two stay sealed for a later call, which also runs Holm over the family of three.
    expect(r.registry.entries.filter((e) => e.seal === 'sealed').map((e) => e.universe)).toEqual(['U2', 'U3']);
  }, 120_000);
  test('n_power must come from this universe\'s walk-forward', () => {
    const other = wf.map(({ day, rNet }) => ({ day, rNet: rNet + 0.01 }));
    const r = gateG2(g2Pass({ universes: [u('U1', { power: { ...power(330), walkForward: summarizeWalkForward(other) } })] }));
    expect(r.status).toBe('fail');
    expect(r.reasons.join()).toMatch(/n_power inputs U1: n_power was simulated on walk-forward/);
    expect(r.registry.entries[0]!.seal).toBe('sealed');
  });
  test('n_power must be simulated for the family size fixed in the registry', () => {
    const r = gateG2(g2Pass({ universes: [u('U1', { power: power(330, 3) })] }));
    expect(r.reasons.join()).toMatch(/n_power U1: n_power was simulated at level 0.016667/);
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
    let found: TradeOutcome[] | null = null;
    for (let seed = 0; seed < 400 && !found; seed++) {
      const t = bracketTrades(5000 + seed, 0.035, 25, 20);
      const p = gateG2(g2Pass({ universes: [u('U1', { trades: t })] })).universes[0]!.p!;
      if (p > 0.02 && p < 0.045) found = t;
    }
    expect(found).not.toBeNull();
    expect(gateG2(g2Pass({ universes: [u('U1', { trades: found! })] })).universes[0]!.status).toBe('pass');
    const weak = bracketTrades(6000, -0.1, 25, 20);
    const r = gateG2(g2Pass({
      registry: sealed(3, ['U1', 'U2', 'U3']),
      universes: [u('U1', { trades: found! }, 3), u('U2', { trades: weak }, 3), u('U3', { trades: weak }, 3)],
    }));
    expect(r.universes[0]!.level).toBeCloseTo(0.05 / 3, 12);
    expect(r.universes[0]!.status).toBe('fail');
    expect(r.status).toBe('fail');
    expect(r.registry.entries.every((e) => e.burned && e.seal === 'opened')).toBe(true);
  }, 120_000);
  test('G2 thresholds tighten but never loosen', () => {
    expect(() => gateG2(g2Pass(), { minTradesFloor: 200 })).toThrow(/only be tightened/);
    expect(() => gateG2(g2Pass(), { familyAlpha: 0.1 })).toThrow(/only be tightened/);
    expect(() => gateG2(g2Pass(), { constructor: 1 } as never)).toThrow(/unknown threshold/);
    expect(gateG2(g2Pass(), { minTradesFloor: 600 }).status).toBe('not-proven');
  });
});

const dry = bracketTrades(41, 0.1, 2, 30).map((t) => t.rNet);
const g3Pass: G3Input = {
  qualifyingRun: true, liveOnlyVetoes: { vetoed: 20, eligible: 1000 }, dryRunHours: 49, dryRunReturns: dry,
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
  test('the live-only veto rate gates at 10% and its 95% upper bound is reported', () => {
    const r = gateG3(g3Pass);
    expect(r.metrics.liveOnlyVetoRate).toBe(0.02);
    expect(r.metrics.liveOnlyVetoUpper95!).toBeGreaterThan(0.02);
    expect(gateG3({ ...g3Pass, liveOnlyVetoes: { vetoed: 101, eligible: 1000 } }).reasons[0]).toMatch(/^live-only vetoes/);
    expect(gateG3({ ...g3Pass, liveOnlyVetoes: { vetoed: 0, eligible: 0 } }).passed).toBe(false);
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
  test('with the cap at the take-profit, demotion catches a −10% decay within 30 days', () => {
    let caught = 0;
    for (let r = 0; r < 200; r++) {
      const decay = bracketTrades(9000 + r, -0.1, 30, 10).map(({ day, rNet }) => ({ day, rNet }));
      if (evaluateDemotion({ ...demotionQuiet, returns: decay, returnCap: 0.27 }).demote) caught++;
    }
    expect(caught / 200).toBeGreaterThanOrEqual(0.95);
  });
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
