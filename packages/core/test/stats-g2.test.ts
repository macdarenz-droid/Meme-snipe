// G2 machinery from the 2026-10-03 architecture review: Holm across universes, the holdout registry with the burned
// flag, bootstrap p-values, and n_power found by simulating the exact G2 rule.
import { describe, expect, test } from 'vitest';
import {
  attemptAlpha, burnHoldout, createHoldoutRegistry, extendHoldout, nextDay, HOLDOUT_COUNT_FIELDS, createRng, dayBlockMeanInterval, holm, MIN_DAYS, nPower, openHoldout, registerHoldout,
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
    expect(Object.keys(e).sort()).toEqual(['attempt', 'burnReason', 'burned', 'configId', 'counts', 'extension', 'fromDay', 'holdoutId', 'ledgerHash', 'openedAtMs', 'seal', 'toDay', 'universe']);
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
  const opts = { simulations: 300, replicates: 400, familySize: 1 } as const;
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
    const three = simulateG2Power({ walkForward: iid, control: c, seed: 2, ...opts, familySize: 3 });
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

// Supervisor ruling (DECISIONS "Follow-up rulings", STATS-1c): repeated holdout attempts share one error budget, and a
// short holdout extends by a rule fixed at registration, from counts only.
describe('holdout attempt budget and extension', () => {
  test('attempt 1 is tested at 0.04, attempt k >= 2 at 0.01 / 2^(k − 1); all attempts sum to at most 0.05', () => {
    expect(attemptAlpha(1)).toBe(0.04);
    expect(attemptAlpha(2)).toBe(0.005);
    expect(attemptAlpha(3)).toBe(0.0025);
    let total = 0;
    for (let k = 1; k <= 60; k++) total += attemptAlpha(k);
    expect(total).toBeLessThanOrEqual(0.05);
    expect(() => attemptAlpha(0)).toThrow(RangeError);
  });
  test('the registry numbers each universe\'s attempts; a later attempt needs n_power at its own level', () => {
    let reg = registerHoldout(createHoldoutRegistry(1), { holdoutId: 'a1', universe: 'U1', configId: 'c1', fromDay: '2026-09-01', toDay: '2026-09-10' });
    expect(reg.entries[0]!.attempt).toBe(1);
    reg = burnHoldout(reg, 'a1', 'inspected', 'test').registry;
    reg = registerHoldout(reg, { holdoutId: 'a2', universe: 'U1', configId: 'c2', fromDay: '2026-09-11', toDay: '2026-09-20' });
    expect(reg.entries[1]!.attempt).toBe(2);
  });
  test('the extension rule is fixed at registration and starts the day after the window', () => {
    expect(nextDay('2026-09-30')).toBe('2026-10-01');
    expect(nextDay('2026-12-31')).toBe('2027-01-01');
    expect(nextDay('2028-02-28')).toBe('2028-02-29');
    expect(() => registerHoldout(createHoldoutRegistry(1), { holdoutId: 'x', universe: 'U1', configId: 'c', fromDay: '2026-09-22', toDay: '2026-10-01', extension: { firstDay: '2026-10-03', maxDays: 28 } })).toThrow(/starts the day after/);
  });
  const extReg = () => {
    let reg = registerHoldout(createHoldoutRegistry(1), {
      holdoutId: 'h', universe: 'U2', configId: 'c', fromDay: '2026-09-22', toDay: '2026-10-01', extension: { firstDay: '2026-10-02', maxDays: 28 },
    });
    reg = sealHoldout(reg, 'h', { configId: 'c', ledgerHash: 'H0', counts: { candidates: 900, entries: 180, entryDays: 8 } }).registry;
    return reg;
  };
  const days = (n: number, perDay: number, base = 180, baseDays = 8) => {
    const out: { day: string; entries: number; entryDays: number }[] = [];
    let d = '2026-10-02';
    for (let i = 0; i < n; i++) {
      out.push({ day: d, entries: base + perDay * (i + 1), entryDays: baseDays + i + 1 });
      d = nextDay(d);
    }
    return out;
  };
  test('stops on the first day both n and trade days are met, resets the seal for the re-run', () => {
    const step = extendHoldout(extReg(), 'h', days(10, 20), 300, 10);
    expect(step).toMatchObject({ ok: true, outcome: 'extended' });
    // Day 6 is the first with 180 + 120 = 300 entries (and 14 trade days).
    expect(step.registry.entries[0]).toMatchObject({ toDay: '2026-10-07', seal: 'registered', ledgerHash: null, counts: null, burned: false });
  });
  test('not met yet with days left: wait; past 28 days: not proven; never past the rule', () => {
    expect(extendHoldout(extReg(), 'h', days(5, 1), 300, 10).outcome).toBe('wait');
    expect(extendHoldout(extReg(), 'h', days(28, 1), 300, 10)).toMatchObject({ ok: false, outcome: 'not-proven' });
    // Day 29 would meet the size check, but the rule stops at 28 days.
    const late = [...days(28, 1), { day: '2026-10-30', entries: 400, entryDays: 37 }];
    expect(extendHoldout(extReg(), 'h', late, 300, 10).outcome).toBe('not-proven');
  });
  test('refuses gaps, a missing rule or an opened holdout', () => {
    const gap = days(3, 50);
    expect(extendHoldout(extReg(), 'h', [gap[0]!, gap[2]!], 300, 10).outcome).toBe('refused');
    const noRule = sealHoldout(registerHoldout(createHoldoutRegistry(1), { holdoutId: 'h', universe: 'U2', configId: 'c', fromDay: '2026-09-22', toDay: '2026-10-01' }), 'h',
      { configId: 'c', ledgerHash: 'H', counts: { candidates: 1, entries: 1, entryDays: 1 } }).registry;
    expect(extendHoldout(noRule, 'h', days(3, 50), 300, 10).reason).toMatch(/no extension rule/);
    const burned = burnHoldout(extReg(), 'h', 'inspected', 'x').registry;
    expect(extendHoldout(burned, 'h', days(3, 50), 300, 10).outcome).toBe('refused');
  });
});
