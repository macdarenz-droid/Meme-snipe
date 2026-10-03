// G2 machinery from the 2026-10-03 architecture review: Holm across universes, the holdout registry with the burned
// flag, bootstrap p-values, and n_power found by simulating the exact G2 rule.
import { describe, expect, test } from 'vitest';
import {
  burnHoldouts, createRng, dayBlockMeanInterval, holm, nPower, registerHoldout, sd, simulateG2Power,
} from '../src/stats/index.ts';
import { bracketTrades } from './stats-fixtures.ts';

describe('Holm step-down', () => {
  test('textbook cases', () => {
    // Sorted: 0.01 at α/3 rejects, 0.03 at α/2 fails, so 0.04 is not tested further.
    expect(holm([0.01, 0.04, 0.03])).toEqual({ rejected: [true, false, false], levels: [0.05 / 3, 0.05, 0.025] });
    expect(holm([0.01, 0.02, 0.04]).rejected).toEqual([true, true, true]);
    expect(holm([0.04]).rejected).toEqual([true]);
    expect(holm([0.06]).rejected).toEqual([false]);
    expect(holm([]).rejected).toEqual([]);
    expect(() => holm([1.2])).toThrow(RangeError);
  });
  test('family-wise error is at most α when every null is true (3 universes, uniform p)', () => {
    const rng = createRng(4);
    const reps = 200_000;
    let anyReject = 0;
    for (let r = 0; r < reps; r++) if (holm([rng.next(), rng.next(), rng.next()]).rejected.some(Boolean)) anyReject++;
    // With independent nulls Holm rejects anything only if min p < α/3: P = 1 − (1 − α/3)³ = 0.0492 ≤ α.
    const exact = 1 - (1 - 0.05 / 3) ** 3;
    expect(exact).toBeLessThanOrEqual(0.05);
    expect(Math.abs(anyReject / reps - exact)).toBeLessThan(0.002); // 4 standard errors
  });
});

describe('holdout registry', () => {
  const base = registerHoldout([], { holdoutId: 'h1', universe: 'U1', configId: 'c1', fromDay: '2026-09-01', toDay: '2026-09-20' });
  test('one unscored configuration per universe', () => {
    expect(() => registerHoldout(base, { holdoutId: 'h2', universe: 'U1', configId: 'c2', fromDay: '2026-09-01', toDay: '2026-09-20' }))
      .toThrow(/already has an unscored holdout/);
    expect(registerHoldout(base, { holdoutId: 'h2', universe: 'U2', configId: 'c9', fromDay: '2026-09-01', toDay: '2026-09-20' })).toHaveLength(2);
    expect(() => registerHoldout(base, { holdoutId: 'h1', universe: 'U3', configId: 'c', fromDay: '2026-09-01', toDay: '2026-09-02' })).toThrow(/already registered/);
  });
  test('burning is single-use and new proof needs a later window', () => {
    const burned = burnHoldouts(base, ['h1']);
    expect(burned[0]!.burned).toBe(true);
    expect(base[0]!.burned).toBe(false);
    expect(() => burnHoldouts(burned, ['h1'])).toThrow(/already scored/);
    expect(() => burnHoldouts(burned, ['zz'])).toThrow(/not registered/);
    expect(() => registerHoldout(burned, { holdoutId: 'h2', universe: 'U1', configId: 'c2', fromDay: '2026-09-20', toDay: '2026-10-10' }))
      .toThrow(/must start after 2026-09-20/);
    expect(registerHoldout(burned, { holdoutId: 'h2', universe: 'U1', configId: 'c2', fromDay: '2026-09-21', toDay: '2026-10-10' })).toHaveLength(2);
  });
  test('rejects malformed windows', () => {
    expect(() => registerHoldout([], { holdoutId: 'x', universe: 'U1', configId: 'c', fromDay: '2026-09-21', toDay: '2026-09-01' })).toThrow(RangeError);
  });
});

describe('bootstrap p-value', () => {
  test('agrees with the interval: p < α exactly when the (1 − α) CI excludes zero', () => {
    for (let seed = 0; seed < 40; seed++) {
      const t = bracketTrades(700 + seed, 0.03, 20, 10);
      const ci = dayBlockMeanInterval(t, 0.95, 'two', { rng: createRng(seed), replicates: 2000 });
      expect(ci.pTwoSided < 0.05).toBe(ci.lower > 0 || ci.upper < 0);
    }
  });
});

describe('n_power by simulating the G2 rule', () => {
  const opts = { simulations: 300, replicates: 400 } as const;
  // S0 far below the strategy, so the paired comparison does not bind and the mean test decides.
  const control = (seed: number, days: number, perDay: number) => bracketTrades(seed, -0.3, days, perDay).map(({ day, rNet }) => ({ day, rNet }));

  test('independent trades: close to the textbook n; power at n ≥ 80% and below it < 80%', () => {
    const wf = bracketTrades(801, 0, 80, 5).map(({ day, rNet }) => ({ day, rNet }));
    const r = simulateG2Power({ walkForward: wf, control: control(802, 80, 5), seed: 1, ...opts });
    const textbook = nPower(sd(wf.map((t) => t.rNet)), 0.05);
    expect(r.nPower).toBeGreaterThan(0.85 * textbook);
    expect(r.nPower).toBeLessThan(1.35 * textbook);
    expect(r.powerAtN).toBeGreaterThanOrEqual(0.8);
    expect(r.evaluations.some((e) => e.n < r.nPower && e.power < 0.8)).toBe(true);
    // Same seed, same answer.
    expect(simulateG2Power({ walkForward: wf, control: control(802, 80, 5), seed: 1, ...opts }).nPower).toBe(r.nPower);
  }, 120_000);

  test('intra-day correlation raises n by about the design effect; three universes raise it further', () => {
    const iid = bracketTrades(811, 0, 40, 20).map(({ day, rNet }) => ({ day, rNet }));
    const corr = bracketTrades(811, 0, 40, 20, 0.05).map(({ day, rNet }) => ({ day, rNet }));
    const c = control(812, 40, 20);
    const nIid = simulateG2Power({ walkForward: iid, control: c, seed: 2, ...opts }).nPower;
    const nCorr = simulateG2Power({ walkForward: corr, control: c, seed: 2, ...opts }).nPower;
    expect(nCorr).toBeGreaterThan(1.4 * nIid); // design effect 1 + 19·0.05 = 1.95
    const three = simulateG2Power({ walkForward: iid, control: c, seed: 2, universes: 3, ...opts });
    expect(three.level).toBeCloseTo(0.05 / 3, 15);
    expect(three.nPower).toBeGreaterThan(nIid);
  }, 180_000);

  test('a control as good as the strategy makes the S0 comparison bind', () => {
    const wf = bracketTrades(821, 0, 40, 10).map(({ day, rNet }) => ({ day, rNet }));
    const weak = simulateG2Power({ walkForward: wf, control: control(822, 40, 10), seed: 3, ...opts }).nPower;
    // S0 at +3%: the strategy (shifted to +5%) must beat it by 2 points, which needs far more trades.
    const strong = bracketTrades(823, 0.03, 40, 10).map(({ day, rNet }) => ({ day, rNet }));
    const strongN = simulateG2Power({ walkForward: wf, control: strong, seed: 3, ...opts, maxTrades: 200_000 }).nPower;
    expect(strongN).toBeGreaterThan(2 * weak);
  }, 240_000);
});
