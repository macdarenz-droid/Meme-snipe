// Regime gate (docs/ARCHITECTURE.md §6.4): computed as of the decision moment from stored snapshots only.
import { describe, expect, it } from 'vitest';
import { startSession, TRIAL_POLICY } from '../../src/config/index.ts';
import { CURVE_VOLUME_KEY, DAY_MS, EXEC_HEALTH_KEY, GRADUATES_KEY, HOUR_MS, SOL_USD_KEY, evaluateRegime, type Mode } from '../../src/gates/index.ts';
import { NOW, SLOT, SOL_PRICE, T, contextOf, deps, drop, eventObs, obs, passingFacts, patch, solPoints, volumeDays, type Facts } from './world.ts';

const run = (facts: Facts, mode: Mode = 'live', s = deps(mode).session) => evaluateRegime(contextOf(facts), { session: s, mode });
/** Check times: the graduate snapshot was taken just before T, so the current check is T - 1 h. */
const C0 = T - HOUR_MS;
const C1 = T - 2 * HOUR_MS;

/** SOL down 8.01% over the 24 h ending at each listed check time. */
const solDropAt = (checks: number[]) => (k: number): bigint => {
  const t = T - k * HOUR_MS;
  return checks.includes(t) ? (SOL_PRICE * 9_199n) / 10_000n : SOL_PRICE;
};

describe('regime gate', () => {
  it.each(['live', 'backtest'] as const)('is on in the passing world (%s)', (mode) => {
    const r = run(passingFacts(), mode);
    expect(r.reasons).toEqual([]);
    expect(r.on).toBe(true);
    expect(r.checks.map((c) => c.atMs)).toEqual([C0, C1]);
    expect(r.checks[0]!.conditions.map((c) => c.condition)).toEqual(['survival', 'volume', 'sol-change']);
  });

  it('logs every condition with its value and limit', () => {
    const c = run(passingFacts()).checks[0]!.conditions;
    for (const x of c) expect(x).toEqual(expect.objectContaining({ ok: true, value: expect.any(String), limit: expect.any(String) }));
    expect(c.find((x) => x.condition === 'sol-change')).toEqual(expect.objectContaining({ value: '0', limit: '-800' }));
  });

  it('stays on after one failed check and turns off after two in a row (failedChecksToDisable = 2)', () => {
    const one = patch(passingFacts(), SOL_USD_KEY, { points: solPoints(T, 72, solDropAt([C0])) });
    const r1 = run(one);
    expect(r1.checks.map((c) => c.ok)).toEqual([false, true]);
    expect(r1.on).toBe(true);
    const two = patch(passingFacts(), SOL_USD_KEY, { points: solPoints(T, 72, solDropAt([C0, C1])) });
    const r2 = run(two);
    expect(r2.on).toBe(false);
    expect(r2.reasons).toEqual([expect.objectContaining({ code: 'regime-off' })]);
  });

  it('takes the number of checks from the session policy', () => {
    const one = patch(passingFacts(), SOL_USD_KEY, { points: solPoints(T, 72, solDropAt([C0])) });
    const strict = startSession({ ...TRIAL_POLICY, regime: { ...TRIAL_POLICY.regime, failedChecksToDisable: 1 } });
    expect(run(one, 'live', strict).on).toBe(false);
  });

  it('a SOL change of exactly -8% fails (it must be above the floor)', () => {
    const f = patch(passingFacts(), SOL_USD_KEY, { points: solPoints(T, 72, (k) => (T - k * HOUR_MS === C0 || T - k * HOUR_MS === C1 ? (SOL_PRICE * 92n) / 100n : SOL_PRICE)) });
    expect(run(f).checks[0]!.conditions[2]).toEqual(expect.objectContaining({ ok: false, value: '-800' }));
  });

  it('turns off when the D-3 curve volume is below its window\'s 25th percentile', () => {
    const f = patch(passingFacts(), CURVE_VOLUME_KEY, { days: volumeDays(Math.floor(T / DAY_MS) - 1, 400, (k) => (k === 2 ? 1n : 10_000_000_000n)) });
    const r = run(f);
    expect(r.on).toBe(false);
    expect(r.checks[0]!.conditions[1]).toEqual(expect.objectContaining({ ok: false, value: '1', limit: '10000000000' }));
  });

  it('turns off when graduate survival is below its 14-day median', () => {
    const g = (passingFacts().get(GRADUATES_KEY)!.value as { items: { mint: string; migratedAtMs: number; reserveAfter: bigint }[] }).items;
    const worse = g.map((i) => (i.migratedAtMs > T - 4 * DAY_MS ? { ...i, reserveAfter: 1n } : i));
    const r = run(patch(passingFacts(), GRADUATES_KEY, { items: worse }));
    expect(r.on).toBe(false);
    expect(r.checks[0]!.conditions[0]).toEqual(expect.objectContaining({ condition: 'survival', ok: false, value: expect.stringMatching(/^0\//) }));
  });

  it('is off at once when the current check cannot be computed (unknown evidence)', () => {
    const missingDay = patch(passingFacts(), CURVE_VOLUME_KEY, { days: volumeDays(Math.floor(T / DAY_MS) - 1, 400).filter((d) => d.day !== Math.floor(T / DAY_MS) - 50) });
    const r = run(missingDay);
    expect(r.on).toBe(false);
    expect(r.reasons).toContainEqual(expect.objectContaining({ code: 'unknown', input: 'curve-volume' }));
    expect(run(drop(passingFacts(), GRADUATES_KEY)).reasons).toContainEqual(expect.objectContaining({ code: 'unknown', input: 'graduates' }));
  });

  it('is off when the series are more than 2 h behind', () => {
    const r = run(patch(passingFacts(), SOL_USD_KEY, { points: solPoints(T - 3 * HOUR_MS, 72) }));
    expect(r.on).toBe(false);
    expect(r.reasons).toContainEqual(expect.objectContaining({ code: 'unknown', input: 'sol-usd' }));
  });

  it('a degraded snapshot is unknown evidence', () => {
    const r = run(patch(passingFacts(), SOL_USD_KEY, { obs: { ...eventObs(T - 120_000, SLOT - 300n), quality: ['estimated'] } }));
    expect(r.on).toBe(false);
  });

  it('execution health is a live-only veto: red turns live off, the backtest does not read it', () => {
    const red = patch(passingFacts(), EXEC_HEALTH_KEY, { green: false, detail: 'failure share 40%' });
    expect(run(red, 'live').reasons).toEqual([expect.objectContaining({ code: 'exec-health' })]);
    const bt = run(red, 'backtest');
    expect(bt.on).toBe(true);
    expect(bt.execHealth).toEqual({ applied: false, green: null, detail: 'live only (§16.3)' });
    expect(run(drop(passingFacts(), EXEC_HEALTH_KEY), 'live').on).toBe(false);
    expect(run(patch(passingFacts(), EXEC_HEALTH_KEY, { obs: obs({ slot: null, receivedAt: T - 2_001 }) }), 'live').on).toBe(false);
  });

  it('never uses a point dated after the check, even inside a stored snapshot', () => {
    const base = run(passingFacts());
    const withFuture = patch(passingFacts(), SOL_USD_KEY, { points: [...solPoints(T, 72), { tMs: T + HOUR_MS, price: 1n }] });
    expect(run(withFuture)).toEqual(base);
    const futureVolume = patch(passingFacts(), CURVE_VOLUME_KEY, { days: [...volumeDays(Math.floor(T / DAY_MS) - 1, 400), { day: Math.floor(T / DAY_MS), volumeLamports: 1n }] });
    expect(run(futureVolume)).toEqual(base);
    const g = passingFacts().get(GRADUATES_KEY)!.value as { items: unknown[] };
    const futureGrad = patch(passingFacts(), GRADUATES_KEY, { items: [...g.items, { mint: 'late', migratedAtMs: T, reserveAfter: 0n }] });
    expect(run(futureGrad)).toEqual(base);
  });

  it('a snapshot stored after now is not visible (as-of store)', () => {
    const f = passingFacts();
    f.set(SOL_USD_KEY, { value: { obs: eventObs(T + 60_000, SLOT + 150n), points: [] }, moment: { ...NOW, slot: SLOT + 150n, receivedAt: T + 60_000 } });
    // The only SOL snapshot is in the future: unknown now.
    expect(run(f).reasons).toContainEqual(expect.objectContaining({ code: 'unknown', input: 'sol-usd' }));
  });
});
