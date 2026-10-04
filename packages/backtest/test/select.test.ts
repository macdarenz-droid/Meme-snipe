// RES-4's family on the practice days: one joint SPA test over every hypothesis, each against its universe's S0, and at
// most one pick per universe (the highest statistic against S0 among those that pass; ties by file order).
import { describe, expect, it } from 'vitest';
import { createRng, nextNormal } from '../../core/src/stats/index.ts';
import { selectHypotheses } from '../src/study/select.ts';
import type { SpaVariant } from '../src/study/spa.ts';

const T = 40;
const rng = createRng(21);
const series = (mu: number) => Array.from({ length: T }, () => mu + nextNormal(rng) * 0.002);
const v = (variant: string, daily: number[]): SpaVariant => ({ variant, daily, activeDays: T, entries: T, eligible: true });
const settings = { seFloor: 1e-6, replicates: 1000, alpha: 0.05 };
const universeOf = { 'H4-U2-reclaim': 'U2', 'H5-U2-exhausted-dump': 'U2', 'H1-U1-dip': 'U1' };
const order = ['H1-U1-dip', 'H4-U2-reclaim', 'H5-U2-exhausted-dump'];

describe('hypothesis selection', () => {
  it('picks per universe the passing hypothesis with the highest statistic against its own S0; none passing, none', () => {
    const s0 = { U1: series(0), U2: series(-0.004) };
    const sel = selectHypotheses([v('H1-U1-dip', series(0)), v('H4-U2-reclaim', series(0.004)), v('H5-U2-exhausted-dump', series(0.008))], order, universeOf, s0, settings, [], 3);
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
});
