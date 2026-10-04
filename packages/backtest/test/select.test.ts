// RES-4's family on the practice days: one joint SPA test over every hypothesis, each against its universe's S0, and at
// most one pick per universe (01FHfb's rule below).
import { describe, expect, it } from 'vitest';
import { createRng, nextNormal } from '../../core/src/stats/index.ts';
import type { SpaResult } from '../../core/src/stats/index.ts';
import { pickOf, selectHypotheses } from '../src/study/select.ts';
import type { SpaVariant } from '../src/study/spa.ts';

const T = 40;
const rng = createRng(21);
const series = (mu: number) => Array.from({ length: T }, () => mu + nextNormal(rng) * 0.002);
const v = (variant: string, daily: number[]): SpaVariant => ({ variant, daily, activeDays: T, entries: T, eligible: true });
const settings = { seFloor: 1e-6, replicates: 1000, alpha: 0.05 };
const universeOf = { 'H4-U2-reclaim': 'U2', 'H5-U2-exhausted-dump': 'U2', 'H1-U1-dip': 'U1' };
const order = ['H1-U1-dip', 'H4-U2-reclaim', 'H5-U2-exhausted-dump'];

describe('hypothesis selection', () => {
  it('picks per universe the passing hypothesis with the highest min(z vs zero, z vs its own S0); none passing, none', () => {
    const s0 = { U1: series(0), U2: series(-0.004) };
    const room = Object.fromEntries(order.map((id) => [id, { entriesPerDay: 20, required: 300 }]));
    const sel = selectHypotheses([v('H1-U1-dip', series(0)), v('H4-U2-reclaim', series(0.004)), v('H5-U2-exhausted-dump', series(0.008))], order, universeOf, s0, settings, [], 3, room);
    expect(sel.spa!.variants).toHaveLength(3);
    expect(sel.byUniverse).toEqual({ U1: null, U2: 'H5-U2-exhausted-dump' });
    expect(sel.why['U1']).toMatch(/no U1 hypothesis passes/);
  });

  it('chooses nothing on too few days', () => {
    const short = (x: number[]) => x.slice(0, 5);
    const sel = selectHypotheses([v('H4-U2-reclaim', short(series(0.01)))], ['H4-U2-reclaim'], universeOf, { U2: short(series(0)) }, settings, [], 1);
    expect(sel).toMatchObject({ byUniverse: { U2: null }, spa: null });
    expect(sel.why['U2']).toMatch(/needs at least 10/);
  });

  it('s0Of is required: a hypothesis whose universe has no S0 series stops the selection, never compared with another universe\'s S0', () => {
    const sel = selectHypotheses([v('H1-U1-dip', series(0.01)), v('H4-U2-reclaim', series(0.01))], ['H1-U1-dip', 'H4-U2-reclaim'], universeOf, { U1: series(0) }, settings, [], 3);
    expect(sel).toMatchObject({ byUniverse: { U1: null, U2: null }, spa: null });
    expect(sel.why['U2']).toMatch(/no S0 series for U2/);
  });
});

// 01FHfb's pick rule (binding, 2026-10-04): rank the SPA-passing hypotheses of a universe by min(zVsZero, zVsS0), ties
// by file order, after dropping any whose practice entries per day × 28 fall short of the holdout requirement.
describe('the pick rule', () => {
  const spa = (variants: { id: string; zVsZero: number; zVsS0: number; passed?: boolean }[]): SpaResult => ({
    pValue: 0.001, pByBlockLength: {}, statistic: 5, days: 64, effectiveBlocks: {}, resampleRegimes: [], excluded: [],
    variants: variants.map((x) => ({ passed: true, ...x })), passing: variants.filter((x) => x.passed !== false).map((x) => x.id),
  });
  const order6 = ['H4-U2-reclaim', 'H5-U2-exhausted-dump'];
  const roomy = { entriesPerDay: 20, required: 300 };

  it('ranks by the smaller of the two statistics, not by the statistic against S0 alone', () => {
    // H4 beats S0 by more, but only just beats zero; H5 beats both clearly.
    const r = pickOf(spa([{ id: 'H4-U2-reclaim', zVsZero: 2.1, zVsS0: 6 }, { id: 'H5-U2-exhausted-dump', zVsZero: 4, zVsS0: 4.5 }]), order6, universeOf, { 'H4-U2-reclaim': roomy, 'H5-U2-exhausted-dump': roomy });
    expect(r.byUniverse['U2']).toBe('H5-U2-exhausted-dump');
  });

  it('breaks ties by file order', () => {
    const r = pickOf(spa([{ id: 'H5-U2-exhausted-dump', zVsZero: 3, zVsS0: 4 }, { id: 'H4-U2-reclaim', zVsZero: 4, zVsS0: 3 }]), order6, universeOf, { 'H4-U2-reclaim': roomy, 'H5-U2-exhausted-dump': roomy });
    expect(r.byUniverse['U2']).toBe('H4-U2-reclaim');
  });

  it('drops a passing hypothesis that cannot fill the holdout: entries per day × 28 below its requirement, or no requirement', () => {
    const variants = [{ id: 'H4-U2-reclaim', zVsZero: 9, zVsS0: 9 }, { id: 'H5-U2-exhausted-dump', zVsZero: 3, zVsS0: 3 }];
    // 10 a day × 28 = 280 < 300: H4 is dropped, H5 (11 a day, 308) is picked.
    expect(pickOf(spa(variants), order6, universeOf, { 'H4-U2-reclaim': { entriesPerDay: 10, required: 300 }, 'H5-U2-exhausted-dump': { entriesPerDay: 11, required: 300 } }).byUniverse['U2']).toBe('H5-U2-exhausted-dump');
    // A larger n_power raises the bar: 11 a day no longer fills 420.
    const none = pickOf(spa(variants), order6, universeOf, { 'H4-U2-reclaim': { entriesPerDay: 10, required: 300 }, 'H5-U2-exhausted-dump': { entriesPerDay: 11, required: 420 } });
    expect(none.byUniverse['U2']).toBeNull();
    expect(none.why['U2']).toMatch(/cannot fill the holdout/);
    expect(pickOf(spa(variants), order6, universeOf, { 'H4-U2-reclaim': { entriesPerDay: 50, required: null } }).byUniverse['U2']).toBeNull();
  });

  it('never picks a hypothesis that did not pass the SPA test', () => {
    expect(pickOf(spa([{ id: 'H4-U2-reclaim', zVsZero: 9, zVsS0: 9, passed: false }]), order6, universeOf, { 'H4-U2-reclaim': roomy }).byUniverse['U2']).toBeNull();
  });
});
