// G2 machinery from the 2026-10-03 architecture review: Holm across universes, the holdout registry with the burned
// flag, bootstrap p-values, and n_power found by simulating the exact G2 rule.
import { describe, expect, test } from 'vitest';
import {
  abandonHoldout, ATTEMPT_ALPHA, attemptAlpha, nextAttemptIndex, spendHoldout, burnHoldout, createHoldoutRegistry, dayFromNumber, daysBetween, extendHoldout, freezeRequirement, nextDay, HOLDOUT_COUNT_FIELDS, createRng, dayBlockMeanInterval, holm, MIN_DAYS, nPower, openHoldout, registerHoldout,
  holdoutPlan, sd, sealHoldout, simulateG2Power,
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
  // Attempt 1: entries 09-01..09-20 (E = 09-21), one tail day, so the seal may open from 09-22.
  const win = { fromDay: '2026-09-01', toDay: '2026-09-20', registeredOnDay: '2026-08-30' };
  const reg0 = registerHoldout(createHoldoutRegistry(2), { holdoutId: 'h1', universe: 'U1', configId: 'c1', ...win });
  const frozen = freezeRequirement(reg0, 'h1', { requiredTrades: 330, requiredDays: 10, nPower: 300, nPowerSeed: 7 }).registry;
  const sealed = sealHoldout(frozen, 'h1', { configId: 'c1', ledgerHash: 'H', counts }).registry;
  // The same window frozen at 21 days: 400 entries on 20 days are short of it.
  const sealed21 = sealHoldout(freezeRequirement(reg0, 'h1', { requiredTrades: 330, requiredDays: 21, nPower: 300, nPowerSeed: 7 }).registry, 'h1', { configId: 'c1', ledgerHash: 'H', counts }).registry;
  const open = (reg = sealed, over: Partial<Parameters<typeof openHoldout>[2]> = {}) =>
    openHoldout(reg, 'h1', { configId: 'c1', ledgerHash: 'H', requiredTrades: 330, minDays: MIN_DAYS, nowMs: 5, nowDay: '2026-09-22', g1Passed: true, ...over });

  test('family size is fixed at creation and counts every universe ever registered; one unspent configuration per universe', () => {
    expect(() => createHoldoutRegistry(4)).toThrow(RangeError);
    expect(() => registerHoldout(reg0, { holdoutId: 'h2', universe: 'U1', configId: 'c2', ...win })).toThrow(/already has an unspent holdout/);
    const two = registerHoldout(reg0, { holdoutId: 'h2', universe: 'U2', configId: 'c9', ...win });
    expect(() => registerHoldout(two, { holdoutId: 'h3', universe: 'U3', configId: 'c', ...win })).toThrow(/created for 2 universes/);
    expect(() => registerHoldout(reg0, { holdoutId: 'h1', universe: 'U3', configId: 'c', ...win })).toThrow(/already registered/);
    // The loophole: a spent universe still counts, so a new universe cannot take its place.
    const one = registerHoldout(createHoldoutRegistry(1), { holdoutId: 'a', universe: 'U1', configId: 'c', ...win });
    const spent = burnHoldout(one, 'a', 'inspected', 'x').registry;
    expect(() => registerHoldout(spent, { holdoutId: 'b', universe: 'U2', configId: 'c', ...win })).toThrow(/created for 1 universes; U1 are registered/);
  });
  test('attempt 1 of every universe shares one window, at most 28 entry days', () => {
    expect(() => registerHoldout(reg0, { holdoutId: 'h2', universe: 'U2', configId: 'c', ...win, toDay: '2026-09-19' })).toThrow(/shares one window/);
    expect(() => registerHoldout(createHoldoutRegistry(1), { holdoutId: 'x', universe: 'U1', configId: 'c', fromDay: '2026-09-22', toDay: '2026-10-20', registeredOnDay: '2026-09-01' }))
      .toThrow(/29 entry days, the rule allows at most 28/);
    expect(registerHoldout(createHoldoutRegistry(1), { holdoutId: 'x', universe: 'U1', configId: 'c', fromDay: '2026-09-22', toDay: '2026-10-19', registeredOnDay: '2026-09-01' }).entries[0])
      .toMatchObject({ attempt: 1, alpha: 0.04, tailEnd: '2026-10-21' });
  });
  test('before the seal opens, the registry exposes candidate and entry counts only: no exit, fill or P&L field', () => {
    const banned = /exit|fill|pnl|p_l|profit|loss|return|rnet|blocked|open|position|price|value|amount/i;
    expect(HOLDOUT_COUNT_FIELDS).toEqual(['candidates', 'entries', 'entryDays']);
    const e = sealed.entries[0]!;
    expect(Object.keys(e.counts!).sort()).toEqual(['candidates', 'entries', 'entryDays']);
    for (const k of Object.keys(e.counts!)) expect(k).not.toMatch(banned);
    // The entry's own fields: identity, window, attempt, requirement, seal bookkeeping and counts; nothing from outcomes.
    expect(Object.keys(e).sort()).toEqual(['alpha', 'attempt', 'burnReason', 'burned', 'configId', 'counts', 'fromDay', 'holdoutId', 'ledgerHash', 'openedAtMs', 'registeredOnDay', 'requirement', 'seal', 'tailEnd', 'toDay', 'universe']);
    // Sealing refuses extra fields, so exit counts or P&L cannot be smuggled in.
    expect(() => sealHoldout(frozen, 'h1', { configId: 'c1', ledgerHash: 'H', counts: { ...counts, exits: 400 } as never })).toThrow(/may hold only candidates, entries, entryDays; got exits/);
    expect(() => sealHoldout(frozen, 'h1', { configId: 'c1', ledgerHash: 'H', counts: { ...counts, pnl: 1 } as never })).toThrow(/got pnl/);
  });
  test('an attempt index is the registry\'s next round; a holdout ends without an opening only for a reason the registry proves', () => {
    expect(nextAttemptIndex(createHoldoutRegistry(1))).toBe(1);
    expect(nextAttemptIndex(reg0)).toBe(2);
    expect(() => registerHoldout(createHoldoutRegistry(1), { holdoutId: 'x', universe: 'U1', configId: 'c', ...win, attempt: 2 })).toThrow(/attempt 1, not attempt 2/);
    expect(ATTEMPT_ALPHA).toEqual({ first: 0.04, laterBase: 0.01 });
    const after = { nowDay: '2026-09-22', g1Passed: false };
    // Before the tail, for another reason, or once burned: refused.
    expect(() => spendHoldout(sealed, 'h1', { ...after, why: 'g1-failed', nowDay: '2026-09-21' })).toThrow(/tail runs until 2026-09-22/);
    expect(() => spendHoldout(sealed, 'h1', { ...after, why: 'tired' as never })).toThrow(/not a reason/);
    // g1-failed: refused after a G1 pass.
    expect(() => spendHoldout(sealed, 'h1', { ...after, why: 'g1-failed', g1Passed: true })).toThrow(/G1 passed/);
    const g1 = spendHoldout(sealed, 'h1', { ...after, why: 'g1-failed' });
    expect(g1.registry.entries[0]).toMatchObject({ burned: true, burnReason: 'spent' });
    expect(() => spendHoldout(g1.registry, 'h1', { ...after, why: 'g1-failed' })).toThrow(/already burned/);
    // short: judged against the frozen requirement, never a caller's number (400 entries on 20 days meet 330 on 10).
    expect(() => spendHoldout(sealed, 'h1', { ...after, why: 'short' })).toThrow(/is ready/);
    // BT review S1: a holdout ready on 12 days against its frozen 10 cannot be spent as short, whatever a caller wants.
    const twelve = sealHoldout(frozen, 'h1', { configId: 'c1', ledgerHash: 'H', counts: { ...counts, entryDays: 12 } }).registry;
    expect(() => spendHoldout(twelve, 'h1', { ...after, why: 'short' })).toThrow(/is ready \(400 entries on 12 days\)/);
    expect(spendHoldout(sealed21, 'h1', { ...after, why: 'short' }).registry.entries[0]!.burnReason).toBe('spent');
    expect(() => spendHoldout(reg0, 'h1', { ...after, why: 'short' })).toThrow(/no frozen requirement/);
    // never-run: only while the seal is still 'registered'.
    expect(() => spendHoldout(sealed, 'h1', { ...after, why: 'never-run' })).toThrow(/was run/);
    expect(spendHoldout(frozen, 'h1', { ...after, why: 'never-run' }).registry.entries[0]!.burnReason).toBe('spent');
  });
  test('the requirement and n_power seed are frozen before any count; sealing refuses without them', () => {
    expect(() => freezeRequirement(reg0, 'h1', { requiredTrades: 299, requiredDays: 10, nPower: 300, nPowerSeed: 7 })).toThrow(/below n_power 300/);
    expect(() => freezeRequirement(reg0, 'h1', { requiredTrades: 300, requiredDays: 0, nPower: 300, nPowerSeed: 7 })).toThrow(RangeError);
    // The owner's floor: 300 trades on 10 days; only a test rule (synthetic data) sits below it.
    expect(() => freezeRequirement(reg0, 'h1', { requiredTrades: 299, requiredDays: 10, nPower: 0, nPowerSeed: 7 })).toThrow(/below the floor of 300 on 10/);
    expect(() => freezeRequirement(reg0, 'h1', { requiredTrades: 300, requiredDays: 9, nPower: 0, nPowerSeed: 7 })).toThrow(/below the floor of 300 on 10/);
    expect(reg0.rule).toEqual({ windowDays: 28, tailDays: 1, minTrades: 300, minDays: 10 });
    const testReg = registerHoldout(createHoldoutRegistry(1, { windowDays: 28, tailDays: 1, minTrades: 1, minDays: 1 }), { holdoutId: 't', universe: 'U1', configId: 'c', ...win });
    expect(freezeRequirement(testReg, 't', { requiredTrades: 1, requiredDays: 1, nPower: 0, nPowerSeed: 7 }).ok).toBe(true);
    expect(sealHoldout(reg0, 'h1', { configId: 'c1', ledgerHash: 'H', counts })).toMatchObject({ ok: false, reason: expect.stringMatching(/no frozen requirement/) });
    expect(freezeRequirement(frozen, 'h1', { requiredTrades: 300, requiredDays: 10, nPower: 300, nPowerSeed: 7 }).ok).toBe(false);
    expect(freezeRequirement(sealed, 'h1', { requiredTrades: 330, requiredDays: 10, nPower: 300, nPowerSeed: 7 }).ok).toBe(false);
    expect(sealed.entries[0]!.requirement).toEqual({ requiredTrades: 330, requiredDays: 10, nPower: 300, nPowerSeed: 7 });
  });
  test('M6: after a G1 fail the seal stays closed, unburned, even when ready and past the tail', () => {
    const r = open(sealed, { g1Passed: false });
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/stays sealed: G1 did not pass for c1/) });
    expect(r.registry.entries[0]).toMatchObject({ seal: 'sealed', burned: false, burnReason: null, openedAtMs: null });
  });
  test('sealing stores hash and counts; an identical re-run is fine, a changed one burns', () => {
    expect(sealed.entries[0]).toMatchObject({ seal: 'sealed', ledgerHash: 'H', counts, burned: false });
    expect(sealHoldout(sealed, 'h1', { configId: 'c1', ledgerHash: 'H', counts }).ok).toBe(true);
    expect(sealHoldout(sealed, 'h1', { configId: 'c1', ledgerHash: 'H2', counts }).registry.entries[0]).toMatchObject({ burned: true, burnReason: 'reconfigured' });
    expect(sealHoldout(sealed, 'h1', { configId: 'c2', ledgerHash: 'H', counts }).registry.entries[0]).toMatchObject({ burned: true, burnReason: 'reconfigured' });
  });
  test('the seal opens once, after the tail and a G1 pass; a short window is a spent attempt; everything else burns', () => {
    const ok = open();
    expect(ok.ok).toBe(true);
    expect(ok.registry.entries[0]).toMatchObject({ seal: 'opened', openedAtMs: 5, burned: true, burnReason: 'scored' });
    expect(open(ok.registry).reason).toMatch(/burned \(scored\): a second look is refused/);
    // Refused without looking (nothing burns): before the tail has matured, after a G1 fail, or for another requirement.
    for (const over of [{ nowDay: '2026-09-21' }, { g1Passed: false }, { requiredTrades: 401 }, { minDays: 21 }]) {
      const r = open(sealed, over);
      expect(r.ok).toBe(false);
      expect(r.registry.entries[0]!.burned).toBe(false);
    }
    expect(open(sealed, { nowDay: '2026-09-21' }).reason).toMatch(/stays sealed until 2026-09-22/);
    expect(open(sealed, { g1Passed: false }).reason).toMatch(/G1 did not pass/);
    // Short against its frozen requirement (21 days here): a spent attempt.
    expect(open(sealed21, { minDays: 21 }).registry.entries[0]).toMatchObject({ burned: true, burnReason: 'short', seal: 'sealed' });
    expect(open(sealed, { ledgerHash: 'X' }).registry.entries[0]!.burnReason).toBe('hash-mismatch');
    expect(open(sealed, { configId: 'c2' }).registry.entries[0]!.burnReason).toBe('reconfigured');
    expect(open(reg0).ok).toBe(false); // never run: nothing to open, nothing burned
    expect(open(reg0).registry.entries[0]!.burned).toBe(false);
    expect(sealed.entries[0]!.burned).toBe(false); // inputs are never mutated
  });
  test('inspection outside the scoring stage burns; new proof needs a later window', () => {
    const seen = burnHoldout(sealed, 'h1', 'inspected', 'a log line showed holdout P&L');
    expect(seen.registry.entries[0]).toMatchObject({ burned: true, burnReason: 'inspected' });
    expect(() => registerHoldout(seen.registry, { holdoutId: 'h2', universe: 'U1', configId: 'c2', fromDay: '2026-09-21', toDay: '2026-10-18', registeredOnDay: '2026-09-20' }))
      .toThrow(/must start on or after 2026-09-22/);
    expect(registerHoldout(seen.registry, { holdoutId: 'h2', universe: 'U1', configId: 'c2', fromDay: '2026-09-23', toDay: '2026-10-20', registeredOnDay: '2026-09-22' }).entries).toHaveLength(2);
    expect(() => registerHoldout(createHoldoutRegistry(1), { holdoutId: 'x', universe: 'U1', configId: 'c', fromDay: '2026-09-21', toDay: '2026-09-01', registeredOnDay: '2026-08-01' })).toThrow(RangeError);
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

// Supervisor rulings (DECISIONS "STATS-1c"): repeated holdout attempts share one error budget, an attempt is spent at
// registration, later attempts follow a rule fixed from the start, and there is no count-driven extension.
describe('holdout attempts', () => {
  const w1 = { fromDay: '2026-09-22', toDay: '2026-10-19', registeredOnDay: '2026-09-01' };
  test('attempt 1 is tested at 0.04, attempt k >= 2 at 0.01 / 2^(k − 1); all attempts sum to at most 0.05', () => {
    expect(attemptAlpha(1)).toBe(0.04);
    expect(attemptAlpha(2)).toBe(0.005);
    expect(attemptAlpha(3)).toBe(0.0025);
    let total = 0;
    for (let k = 1; k <= 60; k++) total += attemptAlpha(k);
    expect(total).toBeLessThanOrEqual(0.05);
    expect(() => attemptAlpha(0)).toThrow(RangeError);
  });
  test('attempt 2 is refused before attempt 1 is spent, starts the day after its registration and runs exactly 28 days', () => {
    const reg = registerHoldout(createHoldoutRegistry(1), { holdoutId: 'a1', universe: 'U1', configId: 'c1', ...w1 });
    const a2 = { holdoutId: 'a2', universe: 'U1', configId: 'c2', registeredOnDay: '2026-10-25', fromDay: '2026-10-26', toDay: '2026-11-22' };
    expect(() => registerHoldout(reg, a2)).toThrow(/unspent holdout \(a1/);
    const spent = burnHoldout(reg, 'a1', 'inspected', 'x').registry;
    expect(registerHoldout(spent, a2).entries[1]).toMatchObject({ attempt: 2, alpha: 0.005, tailEnd: '2026-11-24' });
    expect(() => registerHoldout(spent, { ...a2, fromDay: '2026-10-25', toDay: '2026-11-21' })).toThrow(/first whole UTC day after its registration \(2026-10-26\)/);
    expect(() => registerHoldout(spent, { ...a2, toDay: '2026-11-20' })).toThrow(/runs exactly 28 days/);
    expect(() => registerHoldout(spent, { ...a2, alpha: 0.01 })).toThrow(/attempt 2 is tested at 0.005, not 0.01/);
  });
  test('registration spends the attempt: an abandoned or short window still moves the next registration to level k + 1', () => {
    const reg = registerHoldout(createHoldoutRegistry(1), { holdoutId: 'a1', universe: 'U1', configId: 'c1', ...w1 });
    const abandoned = abandonHoldout(reg, 'a1', 'halted by the operator').registry;
    expect(abandoned.entries[0]).toMatchObject({ burned: true, burnReason: 'abandoned' });
    const next = registerHoldout(abandoned, { holdoutId: 'a2', universe: 'U1', configId: 'c2', registeredOnDay: '2026-10-25', fromDay: '2026-10-26', toDay: '2026-11-22' });
    expect(next.entries[1]!.alpha).toBe(0.005);
    let short = freezeRequirement(reg, 'a1', { requiredTrades: 300, requiredDays: 10, nPower: 300, nPowerSeed: 1 }).registry;
    short = sealHoldout(short, 'a1', { configId: 'c1', ledgerHash: 'H', counts: { candidates: 900, entries: 120, entryDays: 12 } }).registry;
    short = openHoldout(short, 'a1', { configId: 'c1', ledgerHash: 'H', requiredTrades: 300, minDays: 10, nowMs: 1, nowDay: '2026-10-21', g1Passed: true }).registry;
    expect(short.entries[0]!.burnReason).toBe('short');
    expect(registerHoldout(short, { holdoutId: 'a2', universe: 'U1', configId: 'c2', registeredOnDay: '2026-10-25', fromDay: '2026-10-26', toDay: '2026-11-22' }).entries[1]!.attempt).toBe(2);
  });
  test('there is no count-driven extension: extendHoldout always refuses and changes nothing', () => {
    let reg = registerHoldout(createHoldoutRegistry(1), { holdoutId: 'h', universe: 'U2', configId: 'c', ...w1 });
    reg = freezeRequirement(reg, 'h', { requiredTrades: 300, requiredDays: 10, nPower: 300, nPowerSeed: 1 }).registry;
    reg = sealHoldout(reg, 'h', { configId: 'c', ledgerHash: 'H0', counts: { candidates: 900, entries: 180, entryDays: 8 } }).registry;
    for (const d of ['2026-10-25', '2026-10-10', '2026-11-30']) {
      const step = extendHoldout(reg, 'h', d);
      expect(step.ok).toBe(false);
      expect(step.registry).toBe(reg);
      expect(step.reason).toMatch(/ends at its registered cutoff 2026-10-20/);
    }
  });
  test('UTC day arithmetic without a clock', () => {
    expect(nextDay('2026-12-31')).toBe('2027-01-01');
    expect(nextDay('2028-02-28')).toBe('2028-02-29');
    expect(daysBetween('2026-09-22', '2026-10-20')).toBe(28);
    expect(dayFromNumber(0)).toBe('1970-01-01');
    expect(dayFromNumber(20_718)).toBe('2026-09-22');
  });
});

// Supervisor ruling STATS-1c item 5: n_power per attempt is reported with the chance of reaching n by E and the overall
// pass probability.
describe('holdout plan', () => {
  const plan = (dailyEntries: number[], powerGivenN = 0.8) =>
    holdoutPlan({ dailyEntries, windowDays: 28, requiredTrades: 300, minDays: 10, powerGivenN, rng: createRng(1), simulations: 2000 });
  test('certain, impossible and in-between windows; overall = P(reach n by E) × power given n', () => {
    expect(plan(Array(20).fill(15))).toEqual({ powerGivenN: 0.8, pReach: 1, overall: 0.8 });
    expect(plan(Array(20).fill(10)).pReach).toBe(0); // 280 < 300
    const mixed = plan(Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? 18 : 4)));
    expect(mixed.pReach).toBeGreaterThan(0);
    expect(mixed.pReach).toBeLessThan(1);
    expect(mixed.overall).toBeCloseTo(mixed.pReach * 0.8, 12);
    // Enough entries on too few days is not enough.
    expect(plan(Array.from({ length: 20 }, (_, i) => (i % 4 === 0 ? 60 : 0))).pReach).toBeLessThan(0.5);
    expect(() => plan([1, 2])).toThrow(RangeError);
  });
});
