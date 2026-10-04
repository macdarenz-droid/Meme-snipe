// Regime survival minimum (REGIME-MIN, docs/ARCHITECTURE.md §6.4): a day with fewer graduates than
// survivalMinGraduates, the recent 24 h or any of the 14 median days, is unknown and turns the regime off; never a pass.
import { describe, expect, it } from 'vitest';
import { POLICY_RULES, TRIAL_POLICY, policyIssues } from '../../src/config/index.ts';
import { DAY_MS, GRADUATES_KEY, HOUR_MS, evaluateRegime } from '../../src/gates/index.ts';
import { T, contextOf, deps, passingFacts, patch } from './world.ts';

const P = TRIAL_POLICY.regime;
/** The current check: the graduate snapshot is taken just before T. */
const C0 = T - HOUR_MS;
/**
 * Graduates whose +30 min mark falls inside day k before C0, i.e. in (C0 − (k+1)·24 h, C0 − k·24 h], `count(k)` of them
 * spread evenly; half survive on day 0 and a third on every other day, so the recent share beats the median.
 */
const graduates = (count: (k: number) => number) => {
  const items: { mint: string; migratedAtMs: number; reserveAfter: bigint }[] = [];
  for (let k = 0; k <= P.survivalMedianDays + 1; k++) {
    const n = count(k);
    for (let j = 0; j < n; j++) {
      const mark = C0 - k * DAY_MS - Math.floor((j * DAY_MS) / n);
      const survives = k === 0 ? j % 2 === 0 : j % 3 === 0;
      items.push({ mint: `R${k}:${j}`, migratedAtMs: mark - P.survivalAfterMs, reserveAfter: survives ? 40_000_000_000n : 10_000_000_000n });
    }
  }
  return items;
};
const run = (count: (k: number) => number) => evaluateRegime(contextOf(patch(passingFacts(), GRADUATES_KEY, { items: graduates(count) })), { session: deps('live').session, mode: 'live' });
const survivalAt = (r: ReturnType<typeof run>, atMs: number) => r.checks.find((c) => c.atMs === atMs)?.conditions.find((c) => c.condition === 'survival');

describe('regime survival minimum (REGIME-MIN)', () => {
  it('policy: 100 graduates a day, locked; anything under 1 or fractional is refused', () => {
    expect(P.survivalMinGraduates).toBe(100);
    expect(POLICY_RULES.regime.survivalMinGraduates).toBe('locked');
    const issues = (r: Partial<typeof P>) => policyIssues({ ...TRIAL_POLICY, regime: { ...P, ...r } });
    expect(issues({})).toEqual([]);
    expect(issues({ survivalMinGraduates: 0 })).toEqual([expect.stringContaining('survivalMinGraduates')]);
    expect(issues({ survivalMinGraduates: 1.5 })).toEqual([expect.stringContaining('survivalMinGraduates')]);
    expect(issues({ survivalMinGraduates: 1 })).toEqual([]);
  });

  it('exactly the minimum on every day is computed and passes', () => {
    const r = run(() => P.survivalMinGraduates);
    expect(survivalAt(r, C0)).toEqual(expect.objectContaining({ ok: true, value: '50/100' }));
    expect(r.on).toBe(true);
  });

  it('one graduate short in the recent 24 h is unknown, and the regime is off at once', () => {
    const r = run((k) => (k === 0 ? P.survivalMinGraduates - 1 : P.survivalMinGraduates));
    expect(survivalAt(r, C0)).toEqual(expect.objectContaining({ ok: null, code: 'not-covered', input: 'graduates', detail: expect.stringMatching(/^99 graduates .*; 100 needed$/) }));
    expect(r.on).toBe(false);
    expect(r.reasons).toContainEqual(expect.objectContaining({ code: 'unknown', input: 'graduates' }));
  });

  it.each([1, 7, 14])('one graduate short on median day -%i is unknown, even though the recent share would pass', (day) => {
    const r = run((k) => (k === day ? P.survivalMinGraduates - 1 : P.survivalMinGraduates));
    expect(survivalAt(r, C0)).toEqual(expect.objectContaining({ ok: null, code: 'not-covered', detail: expect.stringMatching(new RegExp(`^99 graduates in day -${day} .*; 100 needed$`)) }));
    expect(r.on).toBe(false);
  });

  it('a thin day is never a pass: a recent day of 10 graduates that all survive is unknown, not true', () => {
    const items = graduates((k) => (k === 0 ? 0 : P.survivalMinGraduates));
    const thin = Array.from({ length: 10 }, (_, j) => ({ mint: `thin${j}`, migratedAtMs: C0 - j * HOUR_MS - P.survivalAfterMs, reserveAfter: 40_000_000_000n }));
    const r = evaluateRegime(contextOf(patch(passingFacts(), GRADUATES_KEY, { items: [...items, ...thin] })), { session: deps('live').session, mode: 'live' });
    expect(survivalAt(r, C0)).toEqual(expect.objectContaining({ ok: null }));
    expect(r.on).toBe(false);
  });
});
