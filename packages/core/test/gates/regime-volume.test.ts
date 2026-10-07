// Regime volume rule (FACTS-1d, docs/DECISIONS.md "Regime volume window"): day D-3 against the nearest-rank 25th
// percentile of the expanding window from the series start (2026-07-20) to D-3, capped at 365 days, at least 28 days.
import { describe, expect, it } from 'vitest';
import { POLICY_RULES, TRIAL_POLICY, policyIssues } from '../../src/config/index.ts';
import { VOLUME_SERIES_START_DAY } from '../../src/config/time.ts';
import { CURVE_VOLUME_KEY, DAY_MS, HOUR_MS, evaluateRegime, volumeCondition, type CurveVolumeFact, type Mode } from '../../src/gates/index.ts';
import { T, contextOf, deps, eventObs, passingFacts, patch, SLOT } from './world.ts';

const P = TRIAL_POLICY.regime;
const START = VOLUME_SERIES_START_DAY;
const BIG = 10_000_000_000n;
/** A check at 15:00 UTC on the day whose D-3 is `lastDay`. */
const checkFor = (lastDay: number): number => (lastDay + 3) * DAY_MS + 15 * HOUR_MS;
const fact = (days: { day: number; volumeLamports: bigint }[]): CurveVolumeFact => ({ obs: eventObs(T, SLOT), days });
const series = (from: number, to: number, f: (day: number) => bigint = () => BIG) =>
  Array.from({ length: to - from + 1 }, (_, k) => ({ day: from + k, volumeLamports: f(from + k) }));

describe('regime volume rule', () => {
  it('the series start is 2026-07-20', () => {
    expect(START * DAY_MS).toBe(Date.UTC(2026, 6, 20));
  });

  it('27 days in the window is unknown, 28 is computed', () => {
    const at27 = checkFor(START + 26);
    const r27 = volumeCondition(fact(series(START, START + 40)), at27, P);
    expect(r27).toEqual(expect.objectContaining({ condition: 'volume', ok: null, code: 'not-covered', input: 'curve-volume' }));
    expect((r27 as { detail: string }).detail).toContain('27 days');
    const r28 = volumeCondition(fact(series(START, START + 40)), checkFor(START + 27), P);
    expect(r28).toEqual({ condition: 'volume', ok: true, value: String(BIG), limit: String(BIG) });
  });

  it('days before the series start never count, even when present', () => {
    // 27 days from the start plus older days: still too few.
    expect(volumeCondition(fact(series(START - 100, START + 40)), checkFor(START + 26), P).ok).toBeNull();
  });

  it('reads day D-3: D-2 and D-1 are never used', () => {
    const last = START + 60;
    const at = checkFor(last);
    const base = volumeCondition(fact(series(START, last)), at, P);
    expect(base).toEqual(expect.objectContaining({ ok: true, value: String(BIG) }));
    // D-2 and D-1 present and tiny: the same answer.
    expect(volumeCondition(fact(series(START, last + 2, (d) => (d > last ? 1n : BIG))), at, P)).toEqual(base);
    // D-3 tiny, D-2 large: fails on D-3's value.
    const low = volumeCondition(fact(series(START, last + 2, (d) => (d === last ? 1n : BIG))), at, P);
    expect(low).toEqual(expect.objectContaining({ ok: false, value: '1' }));
  });

  it('a missing D-3 is unknown and turns the regime off, whatever D-2 holds', () => {
    const D = Math.floor(T / DAY_MS);
    const days = series(START, D - 1).filter((d) => d.day !== D - 3);
    const r = evaluateRegime(contextOf(patch(passingFacts(), CURVE_VOLUME_KEY, { days })), { session: deps('live').session, mode: 'live' });
    expect(r.on).toBe(false);
    expect(r.reasons).toContainEqual({ code: 'unknown', input: 'curve-volume', detail: `no curve volume for UTC day ${D - 3}` });
  });

  it('NT-1: a missing day inside the window is left out and named; the day judged, or fewer than 28 present, is unknown', () => {
    const last = START + 60;
    // The percentile is taken over the 60 days present; the missing one is named for the alert.
    expect(volumeCondition(fact(series(START, last).filter((d) => d.day !== START)), checkFor(last), P)).toEqual({ condition: 'volume', ok: true, value: String(BIG), limit: String(BIG), missing: [START] });
    // The day judged itself missing: unknown (its volume is the value compared).
    expect(volumeCondition(fact(series(START, last).filter((d) => d.day !== last)), checkFor(last), P)).toMatchObject({ ok: null, code: 'not-covered' });
    // Exactly 28 days present in a 40-day window: judged; 27: unknown.
    const short = START + 39;
    const holes = (n: number) => series(START, short).filter((d) => d.day === short || d.day - START >= n);
    expect(holes(12)).toHaveLength(28);
    expect(volumeCondition(fact(holes(12)), checkFor(short), P)).toMatchObject({ ok: true, missing: Array.from({ length: 12 }, (_, k) => START + k) });
    expect(volumeCondition(fact(holes(13)), checkFor(short), P)).toMatchObject({ ok: null, code: 'not-covered', detail: expect.stringContaining('27 days of curve volume present') });
  });

  it('caps the window at 365 days', () => {
    const last = START + 600;
    const outside = last - P.volumeWindowDays;
    // Days older than the cap are tiny (39% of the series) and one is missing: neither counts.
    const days = series(START, last, (d) => (d <= outside ? 1n : BIG)).filter((d) => d.day !== outside);
    expect(volumeCondition(fact(days), checkFor(last), P)).toEqual({ condition: 'volume', ok: true, value: String(BIG), limit: String(BIG) });
    // The oldest day inside the cap is read: missing, it is left out and named (NT-1), while one outside is not named.
    expect(volumeCondition(fact(days.filter((d) => d.day !== outside + 1)), checkFor(last), P)).toEqual({ condition: 'volume', ok: true, value: String(BIG), limit: String(BIG), missing: [outside + 1] });
  });

  it('a day not yet ended at the check is never read', () => {
    const last = START + 60;
    const at = checkFor(last);
    const days = series(START, last);
    expect(volumeCondition(fact(days), (last + 1) * DAY_MS - 1, { ...P, volumeLagDays: 0 }).ok).toBeNull();
    expect(volumeCondition(fact(days), at, P).ok).toBe(true);
  });

  it.each(['live', 'backtest'] as const)('live and backtest compute the same volume condition on the same series (%s)', (mode: Mode) => {
    const D = Math.floor(T / DAY_MS);
    const days = series(START, D - 1, (d) => BIG + BigInt(d % 11) * 1_000_000_000n);
    const f = patch(passingFacts(), CURVE_VOLUME_KEY, { days });
    const live = evaluateRegime(contextOf(f), { session: deps('live').session, mode: 'live' });
    const other = evaluateRegime(contextOf(f), { session: deps(mode).session, mode });
    expect(other.checks.map((c) => c.conditions[1])).toEqual(live.checks.map((c) => c.conditions[1]));
    expect(other.checks[0]!.conditions[1]).toEqual(volumeCondition(fact(days), T - HOUR_MS, P));
  });

  it('policy: lag 3 and at least 28 days, both locked; a lag under 1 or a minimum outside 1..window is refused', () => {
    expect(P).toEqual(expect.objectContaining({ volumeLagDays: 3, volumeMinDays: 28, volumeWindowDays: 365 }));
    expect(POLICY_RULES.regime).toEqual(expect.objectContaining({ volumeLagDays: 'locked', volumeMinDays: 'locked', volumeWindowDays: 'locked' }));
    const issues = (r: Partial<typeof P>) => policyIssues({ ...TRIAL_POLICY, regime: { ...P, ...r } });
    expect(issues({})).toEqual([]);
    expect(issues({ volumeLagDays: 0 })).toEqual([expect.stringContaining('volumeLagDays')]);
    expect(issues({ volumeLagDays: 1 })).toEqual([]);
    expect(issues({ volumeMinDays: 0 })).toEqual([expect.stringContaining('volumeMinDays')]);
    expect(issues({ volumeMinDays: 1 })).toEqual([]);
    expect(issues({ volumeMinDays: 365 })).toEqual([]);
    expect(issues({ volumeMinDays: 366 })).toEqual([expect.stringContaining('volumeMinDays')]);
  });
});
