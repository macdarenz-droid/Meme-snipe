// G2 machinery from the 2026-10-03 architecture review: Holm across universes, the holdout registry with the burned
// flag, bootstrap p-values, and n_power found by simulating the exact G2 rule.
import { describe, expect, test } from 'vitest';
import {
  burnHoldout, createHoldoutRegistry, HOLDOUT_COUNT_FIELDS, createRng, dayBlockMeanInterval, holm, MIN_DAYS, nPower, openHoldout, registerHoldout,
  sd, sealHoldout, simulateG2Power,
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

describe('sealed holdout registry', () => {
  const counts = { candidates: 2000, entries: 400, entryDays: 20 };
  const reg0 = registerHoldout(createHoldoutRegistry(2), { holdoutId: 'h1', universe: 'U1', configId: 'c1', fromDay: '2026-09-01', toDay: '2026-09-20' });
  const sealed = sealHoldout(reg0, 'h1', { configId: 'c1', ledgerHash: 'H', counts }).registry;
  const open = (reg = sealed, over: Partial<Parameters<typeof openHoldout>[2]> = {}) =>
    openHoldout(reg, 'h1', { configId: 'c1', ledgerHash: 'H', requiredTrades: 330, minDays: MIN_DAYS, nowMs: 5, ...over });

  test('family size is fixed at creation; one unscored configuration per universe', () => {
    expect(() => createHoldoutRegistry(4)).toThrow(RangeError);
    expect(() => registerHoldout(reg0, { holdoutId: 'h2', universe: 'U1', configId: 'c2', fromDay: '2026-09-01', toDay: '2026-09-20' }))
      .toThrow(/already has an unscored holdout/);
    const two = registerHoldout(reg0, { holdoutId: 'h2', universe: 'U2', configId: 'c9', fromDay: '2026-09-01', toDay: '2026-09-20' });
    expect(() => registerHoldout(two, { holdoutId: 'h3', universe: 'U3', configId: 'c', fromDay: '2026-09-01', toDay: '2026-09-02' }))
      .toThrow(/created for 2 universes/);
    expect(() => registerHoldout(reg0, { holdoutId: 'h1', universe: 'U3', configId: 'c', fromDay: '2026-09-01', toDay: '2026-09-02' })).toThrow(/already registered/);
  });
  test('before the seal opens, the registry exposes candidate and entry counts only: no exit, fill or P&L field', () => {
    const banned = /exit|fill|pnl|p_l|profit|loss|return|rnet|blocked|open|position|price|value|amount/i;
    expect(HOLDOUT_COUNT_FIELDS).toEqual(['candidates', 'entries', 'entryDays']);
    const e = sealed.entries[0]!;
    expect(Object.keys(e.counts!).sort()).toEqual(['candidates', 'entries', 'entryDays']);
    for (const k of Object.keys(e.counts!)) expect(k).not.toMatch(banned);
    // The entry's own fields: identity, window, seal bookkeeping and counts; nothing from outcomes.
    expect(Object.keys(e).sort()).toEqual(['burnReason', 'burned', 'configId', 'counts', 'fromDay', 'holdoutId', 'ledgerHash', 'openedAtMs', 'seal', 'toDay', 'universe']);
    // Sealing refuses extra fields, so exit counts or P&L cannot be smuggled in.
    expect(() => sealHoldout(reg0, 'h1', { configId: 'c1', ledgerHash: 'H', counts: { ...counts, exits: 400 } as never })).toThrow(/may hold only candidates, entries, entryDays; got exits/);
    expect(() => sealHoldout(reg0, 'h1', { configId: 'c1', ledgerHash: 'H', counts: { ...counts, pnl: 1 } as never })).toThrow(/got pnl/);
  });
  test('sealing stores hash and counts; an identical re-run is fine, a changed one burns', () => {
    expect(sealed.entries[0]).toMatchObject({ seal: 'sealed', ledgerHash: 'H', counts, burned: false });
    expect(sealHoldout(sealed, 'h1', { configId: 'c1', ledgerHash: 'H', counts }).ok).toBe(true);
    expect(sealHoldout(sealed, 'h1', { configId: 'c1', ledgerHash: 'H2', counts }).registry.entries[0]).toMatchObject({ burned: true, burnReason: 'reconfigured' });
    expect(sealHoldout(sealed, 'h1', { configId: 'c2', ledgerHash: 'H', counts }).registry.entries[0]).toMatchObject({ burned: true, burnReason: 'reconfigured' });
  });
  test('the seal opens once, after the counts suffice; everything else burns', () => {
    const ok = open();
    expect(ok.ok).toBe(true);
    expect(ok.registry.entries[0]).toMatchObject({ seal: 'opened', openedAtMs: 5, burned: true, burnReason: 'scored' });
    expect(open(ok.registry).reason).toMatch(/burned \(scored\): a second look is refused/);
    expect(open(sealed, { requiredTrades: 401 }).registry.entries[0]).toMatchObject({ burned: true, burnReason: 'early-open', seal: 'sealed' });
    expect(open(sealed, { minDays: 21 }).registry.entries[0]!.burnReason).toBe('early-open');
    expect(open(sealed, { ledgerHash: 'X' }).registry.entries[0]!.burnReason).toBe('hash-mismatch');
    expect(open(sealed, { configId: 'c2' }).registry.entries[0]!.burnReason).toBe('reconfigured');
    expect(open(reg0).ok).toBe(false); // never run: nothing to open, nothing burned
    expect(open(reg0).registry.entries[0]!.burned).toBe(false);
    expect(sealed.entries[0]!.burned).toBe(false); // inputs are never mutated
  });
  test('inspection outside the scoring stage burns; new proof needs a later window', () => {
    const seen = burnHoldout(sealed, 'h1', 'inspected', 'a log line showed holdout P&L');
    expect(seen.registry.entries[0]).toMatchObject({ burned: true, burnReason: 'inspected' });
    expect(() => registerHoldout(seen.registry, { holdoutId: 'h2', universe: 'U1', configId: 'c2', fromDay: '2026-09-20', toDay: '2026-10-10' }))
      .toThrow(/must start after 2026-09-20/);
    expect(registerHoldout(seen.registry, { holdoutId: 'h2', universe: 'U1', configId: 'c2', fromDay: '2026-09-21', toDay: '2026-10-10' }).entries).toHaveLength(2);
    expect(() => registerHoldout(createHoldoutRegistry(1), { holdoutId: 'x', universe: 'U1', configId: 'c', fromDay: '2026-09-21', toDay: '2026-09-01' })).toThrow(RangeError);
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
  // Budgets sized for CI (15 min for every suite): the full rule runs five bootstraps a simulated holdout.
  const opts = { simulations: 200, replicates: 200, familySize: 1 } as const;
  // Properties of the 1-day comparison alone are studied on that unit (gateG2 refuses such an n_power).
  const dayOnly = { ...opts, units: ['days-1'] } as const;
  // Every trade its own creator and funder: clusters do not bind unless a test says otherwise.
  const own = (ts: readonly { day: string; rNet: number }[]) => ts.map(({ day, rNet }, i) => ({ day, rNet, creatorCluster: `c${i}`, funderCluster: `f${i}` }));
  // S0 far below the strategy, so the paired comparison does not bind and the mean test decides.
  const control = (seed: number, days: number, perDay: number) => bracketTrades(seed, -0.3, days, perDay).map(({ day, rNet }) => ({ day, rNet }));

  test('independent trades: the 1-day rule near the textbook n, the full rule at least that; power at n ≥ 80%', () => {
    const wf = own(bracketTrades(801, 0, 80, 5));
    const r = simulateG2Power({ walkForward: wf, control: control(802, 80, 5), seed: 1, ...opts });
    expect(r.units).toEqual(['days-1', 'days-2', 'days-3', 'creator', 'funder']);
    const textbook = nPower(sd(wf.map((t) => t.rNet)), 0.05);
    const day = simulateG2Power({ walkForward: wf, control: control(802, 80, 5), seed: 1, ...dayOnly });
    expect(day.nPower).toBeGreaterThan(0.85 * textbook);
    expect(day.nPower).toBeLessThan(1.35 * textbook);
    expect(r.nPower).toBeGreaterThanOrEqual(day.nPower);
    expect(r.powerAtN).toBeGreaterThanOrEqual(0.8);
    expect(r.evaluations.some((e) => e.n < r.nPower && e.power < 0.8)).toBe(true);
  }, 600_000);

  test('intra-day correlation raises n by about the design effect; three universes raise it further', () => {
    const iid = own(bracketTrades(811, 0, 40, 20));
    const corr = own(bracketTrades(811, 0, 40, 20, 0.05));
    const c = control(812, 40, 20);
    const nIid = simulateG2Power({ walkForward: iid, control: c, seed: 2, ...dayOnly }).nPower;
    const nCorr = simulateG2Power({ walkForward: corr, control: c, seed: 2, ...dayOnly }).nPower;
    expect(nCorr).toBeGreaterThan(1.4 * nIid); // design effect 1 + 19·0.05 = 1.95
    const three = simulateG2Power({ walkForward: iid, control: c, seed: 2, ...dayOnly, familySize: 3 });
    expect(three.level).toBeCloseTo(0.05 / 3, 15);
    expect(three.nPower).toBeGreaterThan(nIid);
    // Same seed, same answer.
    expect(simulateG2Power({ walkForward: iid, control: c, seed: 2, ...dayOnly }).nPower).toBe(nIid);
  }, 600_000);

  // Review of 437e60d: n_power simulates the exact G2 rule, cluster sensitivity included. 20 creators, each with its
  // own lasting edge or loss (±20 points), need more trades than the same returns from a creator each: a creator's
  // trades are not independent observations.
  // Same returns either way; only the creator labels differ. With a creator per trade (single-day) the creator unit
  // does not bind, so n is the day-block n. With 10 creators spanning every walk-forward day (multi-day: they keep
  // their ids in the simulation, as a prolific deployer would), the creator-cluster CI is over 10 clusters and needs
  // far more trades. Measured: nSpread 736, nFew 1,252.
  test('n_power includes the creator cluster unit: concentrated creators raise it', () => {
    const spread = own(bracketTrades(831, 0, 40, 30));
    const few = spread.map((t, i) => ({ ...t, creatorCluster: `c${i % 10}` }));
    const c = control(832, 40, 30);
    const nSpread = simulateG2Power({ walkForward: spread, control: c, seed: 4, ...opts }).nPower;
    const nFew = simulateG2Power({ walkForward: few, control: c, seed: 4, ...opts, maxTrades: 200_000 }).nPower;
    expect(nFew).toBeGreaterThan(1.2 * nSpread);
  }, 600_000);

  test('a control as good as the strategy makes the S0 comparison bind', () => {
    const wf = own(bracketTrades(821, 0, 40, 10));
    const weak = simulateG2Power({ walkForward: wf, control: control(822, 40, 10), seed: 3, ...dayOnly }).nPower;
    // S0 at +3%: the strategy (shifted to +5%) must beat it by 2 points, which needs far more trades.
    const strong = bracketTrades(823, 0.03, 40, 10).map(({ day, rNet }) => ({ day, rNet }));
    const strongN = simulateG2Power({ walkForward: wf, control: strong, seed: 3, ...dayOnly, maxTrades: 200_000 }).nPower;
    expect(strongN).toBeGreaterThan(2 * weak);
  }, 600_000);
});
