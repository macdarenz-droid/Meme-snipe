// Every gate has a passing and a failing fixture; thresholds can be tightened but never loosened.
import { describe, expect, test } from 'vitest';
import {
  createRng, deflatedSharpe, deflatedSharpeDaily, evaluateDemotion, gateG0, gateG1, gateG2, gateG3, gateG4, gateG5, mean, sd, sharpeRatio,
  burnHoldout, createHoldoutRegistry, nPower, registerHoldout, summarizeWalkForward, type WalkForwardSummary, sealHoldout, type DemotionInput, type HoldoutRegistry, type G0Input, type G1Input, type G2Input, type G2PowerResult, type G2Universe,
  type G3Input, type G4Input, type G5Input, type TradeOutcome, type HoldoutTrade, type TripleBarrierLabel,
  clopperPearsonUpper, evaluateRevalidation, g2Sensitivity, RETURN_FLOOR, scoreVetoCounterfactuals,
  type RevalidationInput,
} from '../src/stats/index.ts';
import { KNOWN_PLATFORM_CHANGES, RESEARCH_CONFIG, TRIAL_POLICY } from '../src/config/index.ts';
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
const dailyOf = (ts: readonly DayTrade[]): number[] => [...new Set(ts.map((t) => t.day))].map((d) => mean(ts.filter((t) => t.day === d).map((t) => t.rNet)));
// Keyed by trialId: the selected trial t19 wins every day; the other 19 registry trials trail it by 10 points a day.
const matrixFor = (ts: readonly DayTrade[]): Record<string, number[]> => {
  const daily = dailyOf(ts);
  return Object.fromEntries(registry.map((t, k) => [t.trialId, t.trialId === 't19' ? daily : daily.map((x, i) => x - 0.1 + 0.02 * Math.sin(i + k))]));
};
const winnerDaily = dailyOf(wf);
const pboMatrix = matrixFor(wf);
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
    const r = gateG1({ ...g1Pass(), trades: flat, control: bracketTrades(24, 0, 40, 15), pboMatrix: matrixFor(flat) });
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
  // STATS-1c (a): PSR and DSR on day-level returns. Trades on one day share a shock (ρ = 0.4), so 600 trades are far
  // fewer than 600 observations; the per-trade DSR passed this, the day-level one does not.
  test('correlated same-day trades no longer inflate the DSR', () => {
    const corr = bracketTrades(25, 0.06, 40, 15, 0.4);
    const perTrade = deflatedSharpe(corr.map((t) => t.rNet), registry);
    expect(perTrade.dsr).toBeGreaterThanOrEqual(0.95);
    const r = gateG1({ ...g1Pass(), trades: corr, pboMatrix: matrixFor(corr) });
    expect(r.metrics.dsrDays).toBe(40);
    expect(r.metrics.dsr!).toBeLessThan(0.95);
    expect(r.reasons.join(' | ')).toMatch(/DSR: day-level deflated Sharpe/);
  });
  test('the DSR reports raw, de-duplicated and effective-N lines; only raw N gates', () => {
    const r = gateG1(g1Pass());
    expect(r.metrics.trials).toBe(20);
    expect(r.metrics.trialsDeduplicated).toBe(20);
    expect(r.metrics.trialsEffective).toBeGreaterThanOrEqual(1);
    expect(r.checks.find((c) => c.name === 'DSR')!.detail).toMatch(/reported only: .* distinct series, .* effective trials/);
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
  test('SPA is always reported; it gates G1 only when edgeTest is "spa", and the config keeps "dsr"', () => {
    expect(RESEARCH_CONFIG.g1EdgeTest).toBe('dsr');
    const r = gateG1(g1Pass());
    expect(r.metrics.spaP).not.toBeNull();
    expect(r.checks.some((c) => c.name === 'SPA')).toBe(false);
    const s = gateG1({ ...g1Pass(), edgeTest: 'spa' });
    expect(s.checks.some((c) => c.name === 'DSR')).toBe(false);
    expect(s.checks.find((c) => c.name === 'SPA')!.passed).toBe(true);
    const flat = bracketTrades(23, 0, 40, 15);
    const f = gateG1({ ...g1Pass(), trades: flat, pboMatrix: Object.fromEntries(registry.map((t, k) => [t.trialId, dailyOf(bracketTrades(900 + k, 0, 40, 15))])), edgeTest: 'spa' });
    expect(f.reasons.join(' | ')).toMatch(/SPA: SPA over 20 variants/);
  });
  test('exact duplicates count once in the de-duplicated line: two identical variants give the same DSR as one', () => {
    const one = { t19: winnerDaily, t0: pboMatrix.t0!, t1: pboMatrix.t1! };
    const two = { ...one, copy: [...winnerDaily] };
    const a = deflatedSharpeDaily(one, 't19');
    const b = deflatedSharpeDaily(two, 't19');
    expect(b.deduplicated).toEqual(a.deduplicated);
    expect(b.raw.trials).toBe(4);
    expect(b.deduplicated.trials).toBe(3);
    // A near-copy is a different series: exact equality only.
    const near = deflatedSharpeDaily({ ...one, copy: winnerDaily.map((x, i) => (i === 0 ? x + 1e-12 : x)) }, 't19');
    expect(near.deduplicated.trials).toBe(4);
  });
  test('thresholds tighten but never loosen', () => {
    expect(gateG1(g1Pass(), { dsrMin: 0.999999 }).reasons.some((x) => x.startsWith('DSR'))).toBe(true);
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
type PowerSpec = Omit<G2PowerResult, 'walkForward'> & { readonly walkForward?: WalkForwardSummary };
const power = (nPower: number, familySize = 1): PowerSpec => ({ nPower, powerAtN: 0.8, level: 0.04 / familySize, evaluations: [] });
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
const closedWf = nPower(sd(wf.map((t) => t.rNet)), 0.05, { alpha: 0.04 });
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
    let found: HoldoutTrade[] | null = null;
    for (let seed = 0; seed < 400 && !found; seed++) {
      const t = withClusters(bracketTrades(7000 + seed, 0.035, 26, 20));
      const p = gateG2(g2Pass({ registry: sealed(1, ['U1'], counts520), universes: [u('U1', { trades: t })] })).universes[0]!.p!;
      if (p > 0.02 && p < 0.035) found = t;
    }
    expect(found).not.toBeNull();
    const r = gateG2(g2Pass({ registry: sealed(3, ['U1', 'U2', 'U3'], counts520), universes: [u('U1', { trades: found! }, 3)] }));
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
          replicates: 400,
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
    const other = wf.map(({ day, rNet }) => ({ day, rNet: rNet + 0.01 }));
    const r = gateG2(g2Pass({ universes: [u('U1', { power: { ...power(330), walkForward: summarizeWalkForward(other) } })] }));
    expect(r.status).toBe('fail');
    expect(r.reasons.join()).toMatch(/n_power inputs U1: n_power was simulated on walk-forward/);
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
      registry: sealed(3, ['U1', 'U2', 'U3'], counts520),
      universes: [u('U1', { trades: found! }, 3), u('U2', { trades: weak }, 3), u('U3', { trades: weak }, 3)],
    }));
    expect(r.universes[0]!.level).toBeCloseTo(0.04 / 3, 12);
    expect(r.universes[0]!.status).toBe('fail');
    expect(r.status).toBe('fail');
    expect(r.registry.entries.every((e) => e.burned && e.seal === 'opened')).toBe(true);
  }, 120_000);
  test('a second attempt is tested at 0.005: n_power simulated at 0.04 is refused, at 0.005 it is accepted', () => {
    let reg = registerHoldout(createHoldoutRegistry(1), { holdoutId: 'h-old', universe: 'U1', configId: 'U1-v0', fromDay: '2026-08-01', toDay: '2026-08-25' });
    reg = burnHoldout(reg, 'h-old', 'inspected', 'test').registry;
    reg = registerHoldout(reg, { holdoutId: 'h-U1', universe: 'U1', configId: 'U1-v1', fromDay: '2026-09-01', toDay: '2026-09-25' });
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
    expect(gateG2(g2Pass(), { minTradesFloor: 600 }).status).toBe('not-proven');
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
});

const dry = bracketTrades(41, 0.1, 2, 30).map((t) => t.rNet);
const g3Pass: G3Input = {
  qualifyingRun: true, liveOnlyVetoes: { vetoed: 20, eligible: 1000 }, dryRunHours: 49, dryRunReturns: dry,
  holdout: { n: holdout.length, mean: mean(holdout.map((t) => t.rNet)), sd: sd(holdout.map((t) => t.rNet)) },
  candidates: { dryRunCount: 980, dryRunHours: 49, backtestCount: 20_000, backtestHours: 1000 },
  rejectMix: { dryRun: { H8: 210, H9: 700, H11: 70 }, backtest: { H8: 4300, H9: 14_200, H11: 1500 } },
  fillDifferences: Array.from({ length: 24 }, (_, i) => [0.001, 0.002, 0.004, 0.003, 0.012, -0.002][i % 6]!), parityTestPassed: true,
  holdoutSevereRate: holdout.filter((t) => t.ySevere).length / holdout.length,
  registration: { registeredAtMs: NOW - 2 * DAY, thresholds: {}, expectedSimulationErrors: ['BlockhashNotFound'] },
  dryRunStartMs: NOW - DAY,
  simulations: { attempted: 120, succeeded: 118, errors: { BlockhashNotFound: 2 } },
  // The 20 vetoed candidates scored as if entered, like the kept trades; the holdout's lower bound from G2.
  vetoCounterfactuals: { returns: bracketTrades(42, 0.1, 1, 20).map((t) => t.rNet), censored: 0 },
  holdoutLower: 0.06, returnCap: 0.3,
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
  test('fewer than 30 paper trades is inconclusive, never agreement (supervisor ruling after external review)', () => {
    const few = gateG3({ ...g3Pass, dryRunReturns: dry.slice(0, 29) });
    expect(few).toMatchObject({ passed: false, status: 'not-proven' });
    expect(few.reasons.join()).toMatch(/paper outcomes: 29 paper trades \(need >= 30\): inconclusive, extend the dry run/);
    expect(few.notes).toContain('inconclusive: extend the dry run');
    expect(gateG3({ ...g3Pass, dryRunReturns: [] }).status).toBe('not-proven');
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
    const severe = gateG3({ ...g3Pass, dryRunReturns: dry.map((x, i) => (i % 3 === 0 ? -0.9 : x)), holdout: { ...g3Pass.holdout, sd: 2 } });
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
      ...g3Pass, dryRunReturns: kept.map((x) => x + shift), liveOnlyVetoes: { vetoed: 100, eligible: 1000 },
      holdout: { n: 500, mean: 0.05, sd: 0.33 }, holdoutLower: 0.02, vetoCounterfactuals: { returns: [], censored: 0 }, ...over,
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
    const r = gateG3(reviewerCase({ vetoCounterfactuals: { returns: cf, censored: 0 } }));
    expect(r.passed).toBe(false);
    expect(r.status).toBe('not-proven');
    expect(r.metrics.vetoGap!).toBeCloseTo(0.06, 12);
    expect(r.metrics.retainedLower!).toBeLessThanOrEqual(0);
    expect(r.reasons.join()).toMatch(/retained expectancy: .*extend the dry run/);
  });
  test('vetoed candidates far better than kept trades fail outright: the point estimate is already below 0', () => {
    const cf = bracketTrades(45, 0.2, 1, 100).map((t) => t.rNet + 0.3);
    const kept = bracketTrades(46, -0.2, 1, 40).map((t) => t.rNet);
    const r = gateG3({ ...g3Pass, dryRunReturns: kept, liveOnlyVetoes: { vetoed: 100, eligible: 1000 }, vetoCounterfactuals: { returns: cf, censored: 0 } });
    expect(r.status).toBe('fail');
    expect(r.reasons.join()).toMatch(/veto bias/);
  });
  test('the fixed 50-point gap is gone: the measured gap and its 95% upper bound are used and reported', () => {
    const r = gateG3(g3Pass);
    expect(r.passed).toBe(true);
    const dryMean = mean(dry);
    expect(r.metrics.vetoGap!).toBeCloseTo(mean(g3Pass.vetoCounterfactuals.returns) - dryMean, 12);
    expect(r.metrics.vetoGapUpper95!).toBeGreaterThan(r.metrics.vetoGap!);
    expect(r.metrics.vetoGapUpper95!).toBeLessThan(0.5);
    expect(r.metrics.liveOnlyVetoUpper95!).toBeCloseTo(clopperPearsonUpper(20, 1000), 12);
    expect(r.metrics.retainedLower!).toBeGreaterThan(0);
  });
  test('with fewer than 10 vetoed or kept trades the gap is the worst case the return range allows, never an assumption', () => {
    const r = gateG3({ ...g3Pass, liveOnlyVetoes: { vetoed: 3, eligible: 1000 }, vetoCounterfactuals: { returns: [0.1, 0.2, -0.1], censored: 0 } });
    expect(r.metrics.vetoGapUpper95).toBeCloseTo(0.3 - RETURN_FLOOR, 12);
    // 3 of 1,000: the rate bound is small enough that even the worst gap keeps the retained bound above 0.
    expect(r.passed).toBe(true);
    const many = gateG3({ ...g3Pass, liveOnlyVetoes: { vetoed: 60, eligible: 1000 }, vetoCounterfactuals: { returns: Array(60).fill(0.1), censored: 0 }, dryRunReturns: dry.slice(0, 8) });
    expect(many.metrics.vetoGapUpper95).toBeCloseTo(0.3 - RETURN_FLOOR, 12);
    expect(many.status).toBe('not-proven');
  });
  test('an unscored or censored vetoed candidate is missing evidence; a count that does not add up fails', () => {
    const censored = gateG3({ ...g3Pass, vetoCounterfactuals: { returns: g3Pass.vetoCounterfactuals.returns.slice(1), censored: 1 } });
    expect(censored.status).toBe('not-proven');
    expect(censored.reasons.join()).toMatch(/1 censored: wait for their windows to close/);
    const extra = gateG3({ ...g3Pass, vetoCounterfactuals: { returns: [...g3Pass.vetoCounterfactuals.returns, 0.1], censored: 0 } });
    expect(extra.status).toBe('fail');
    expect(() => gateG3({ ...g3Pass, returnCap: 5 })).not.toThrow();
    expect(gateG3({ ...g3Pass, returnCap: 5 }).reasons.join()).toMatch(/^return cap/);
  });
  test('the new G3 thresholds tighten but never loosen', () => {
    expect(() => gateG3(g3Pass, { minVetoedForGap: 5 })).toThrow(/only be tightened/);
    expect(() => gateG3(g3Pass, { vetoBiasMax: 0.1 })).toThrow(/only be tightened/);
    expect(() => gateG3(g3Pass, { retainedLowerMin: -0.01 })).toThrow(/only be tightened/);
    expect(gateG3(g3Pass, { retainedLowerMin: 0.2 }).passed).toBe(false);
  });
  test('counterfactual scoring takes the outcome-stage labels of the vetoed candidates and counts censored ones', () => {
    const label = (rNet: number | null, censored = false): TripleBarrierLabel => ({
      cfgId: 'tp30_sl15', entryFilled: rNet !== null, yTb: null, rNet, touchSlot: null, exitSlot: null, mfe: null, mae: null,
      blocked: false, nExitAttempts: 1, yMeta: null, ySevere: null, censored,
    });
    expect(scoreVetoCounterfactuals([label(0.27), label(-0.18), label(null, true)])).toEqual({ returns: [0.27, -0.18], censored: 1 });
    expect(() => scoreVetoCounterfactuals([label(0.27), { ...label(0.1), cfgId: 'other' }])).toThrow(/one barrier configuration/);
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

// Review STATS-1b, finding 3: B5 (2026-10-02) comes after the holdout window (ends 2026-10-01). ARCHITECTURE.md §14.
describe('post-change revalidation', () => {
  const holdoutEndMs = Date.UTC(2026, 9, 2); // the holdout covers up to the end of 2026-10-01 UTC
  const b5 = KNOWN_PLATFORM_CHANGES.find((c) => c.id === 'B5')!;
  const g3Ok = gateG3(g3Pass);
  const ok: RevalidationInput = {
    holdoutEndMs, platformChanges: KNOWN_PLATFORM_CHANGES,
    dryRun: { qualifyingRun: true, startMs: b5.atMs + DAY, g3: g3Ok }, postChangeBacktest: null,
  };
  test('B5 is recorded at 2026-10-02 15:47 UTC with economics unchanged (UPG-1)', () => {
    expect(b5).toMatchObject({ atMs: Date.UTC(2026, 9, 2, 15, 47), economicsUnchanged: true });
  });
  test('passes with a qualifying post-B5 dry run that passed G3 against the holdout', () => {
    expect(evaluateRevalidation(ok)).toMatchObject({ passed: true, status: 'pass', reasons: [] });
  });
  test('no post-change dry run, or one started before B5, is not proven; a failed G3 fails', () => {
    expect(evaluateRevalidation({ ...ok, dryRun: null }).status).toBe('not-proven');
    const early = evaluateRevalidation({ ...ok, dryRun: { ...ok.dryRun!, startMs: b5.atMs - 1 } });
    expect(early.status).toBe('not-proven');
    expect(early.reasons.join()).toMatch(/started before B5/);
    expect(evaluateRevalidation({ ...ok, dryRun: { ...ok.dryRun!, qualifyingRun: false } }).status).toBe('not-proven');
    expect(evaluateRevalidation({ ...ok, dryRun: { ...ok.dryRun!, g3: gateG3({ ...g3Pass, parityTestPassed: false }) } }).status).toBe('fail');
    expect(evaluateRevalidation({ ...ok, dryRun: { ...ok.dryRun!, g3: gateG3({ ...g3Pass, vetoCounterfactuals: { returns: [], censored: 0 } }) } }).status).toBe('not-proven');
  });
  const contradicted = KNOWN_PLATFORM_CHANGES.map((c) => (c.id === 'B5' ? { ...c, economicsUnchanged: false } : c));
  test('if "economics unchanged" is contradicted, a backtest on >= 200 post-change candidates is also required', () => {
    const base = { ...ok, platformChanges: contradicted };
    expect(evaluateRevalidation(base).status).toBe('not-proven');
    expect(evaluateRevalidation(base).reasons.join()).toMatch(/post-change backtest: none/);
    expect(evaluateRevalidation({ ...base, postChangeBacktest: { firstCandidateMs: b5.atMs + 1, candidates: 199, gatesPassed: true } }).status).toBe('not-proven');
    expect(evaluateRevalidation({ ...base, postChangeBacktest: { firstCandidateMs: b5.atMs - 1, candidates: 400, gatesPassed: true } }).status).toBe('not-proven');
    expect(evaluateRevalidation({ ...base, postChangeBacktest: { firstCandidateMs: b5.atMs + 1, candidates: 200, gatesPassed: false } }).status).toBe('fail');
    expect(evaluateRevalidation({ ...base, postChangeBacktest: { firstCandidateMs: b5.atMs + 1, candidates: 200, gatesPassed: true } }).status).toBe('pass');
  });
  test('an unreviewed change (economics unknown) is treated as contradicted', () => {
    const unknown = KNOWN_PLATFORM_CHANGES.map((c) => (c.id === 'B5' ? { ...c, economicsUnchanged: null } : c));
    expect(evaluateRevalidation({ ...ok, platformChanges: unknown }).status).toBe('not-proven');
  });
  test('changes before the holdout ends need nothing more; the minimum count only tightens', () => {
    const before = KNOWN_PLATFORM_CHANGES.filter((c) => c.atMs < holdoutEndMs).map((c) => ({ ...c, economicsUnchanged: false }));
    expect(before.length).toBeGreaterThan(0);
    expect(evaluateRevalidation({ ...ok, platformChanges: before, dryRun: null }).status).toBe('pass');
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
  // the maximum stop distance (ARCHITECTURE.md §9: 1.5R at R ≤ 20%, i.e. +30%). Returns above it (the runner) are capped,
  // which can only make demotion fire sooner.
  const trialCap = (TRIAL_POLICY.exits.partialAtRBps / 10_000) * (TRIAL_POLICY.loss.stopMaxBps / 10_000);
  test('at the trial take-profit cap and 20 trades a day, demotion catches a −10% decay within 30 trading days in ≥ 80% of runs', () => {
    expect(trialCap).toBeCloseTo(0.3, 12);
    for (const rho of [0, 0.05, 0.1]) {
      let caught = 0;
      for (let r = 0; r < 300; r++) {
        const decay = bracketTrades(9000 + r + Math.round(rho * 1e6), -0.1, 30, 20, rho).map(({ day, rNet }) => ({ day, rNet }));
        if (evaluateDemotion({ ...demotionQuiet, returns: decay, returnCap: trialCap }).demote) caught++;
      }
      // Measured (1,000 runs): 0.991 at ρ 0, 0.964 at ρ 0.05, 0.921 at ρ 0.1; median 22 days.
      expect(caught / 300, `ρ = ${rho}`).toBeGreaterThanOrEqual(0.8);
    }
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
