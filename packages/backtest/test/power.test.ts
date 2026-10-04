// BT-2's n_power for G2 (STATS-1g's pinned settings, M2): simulated with the settings G2 accepts and fingerprinted on
// the walk-forward and S0 control the study hands G2 (walkForward, walkForwardControl), so G2's inputs check matches.
import { describe, expect, it } from 'vitest';
import { createRng, G2_SENSITIVITY_VARIANTS, g2PowerInputs, nextNormal } from '../../core/src/stats/index.ts';
import { g2PowerReplicates, powerOf } from '../src/study/gates.ts';

describe('BT-2 n_power for G2', () => {
  it('passes every pinned setting G2 checks, at the family of 2 and the attempt\'s α, and its inputs are the study\'s', () => {
    const rng = createRng(5);
    const day = (k: number) => `2026-08-${String(1 + (k % 20)).padStart(2, '0')}`;
    const walkForward = Array.from({ length: 60 }, (_, k) => ({ day: day(k), rNet: 0.05 + 0.1 * nextNormal(rng), creatorCluster: `c${k % 30}`, funderCluster: `f${k % 25}` }));
    const control = Array.from({ length: 60 }, (_, k) => ({ day: day(k), rNet: 0.1 * nextNormal(rng) }));
    const p = powerOf(walkForward, control, 2, 11, 0.04);
    expect(p.ok).toBe(true);
    const s = (p as Extract<typeof p, { ok: true }>).power.settings;
    // G2's minimum replicates at the strictest Holm level: ceil(20 / (0.04 / 2)) = 1,000.
    expect(g2PowerReplicates(2, 0.04)).toBe(1000);
    expect(s.replicates).toBeGreaterThanOrEqual(1000);
    expect(s).toMatchObject({ familySize: 2, alpha: 0.04, seed: 11 });
    expect(s.power).toBeGreaterThanOrEqual(0.8);
    expect(s.targetMean).toBeLessThanOrEqual(0.05);
    expect(s.simulations).toBeGreaterThanOrEqual(400);
    expect(G2_SENSITIVITY_VARIANTS.every((u) => s.units.includes(u))).toBe(true);
    expect((p as Extract<typeof p, { ok: true }>).power.inputs).toBe(g2PowerInputs(walkForward, control, s));
  }, 600_000);
});
