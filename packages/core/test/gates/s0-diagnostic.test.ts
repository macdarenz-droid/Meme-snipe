// WORKER-1e: S0's diagnostic set (supervisor ruling 2026-10-04). Three named parts, each only relaxing its own check
// and each reported where it was relied on; without the set every check is judged as before.
import { describe, expect, it } from 'vitest';
import { OFF_CHAIN } from '../../src/engine/index.ts';
import { CURVE_VOLUME_KEY, DAY_MS, EXEC_HEALTH_KEY, S0_DIAGNOSTIC_PARTS, SOL_USD_KEY, deployerKey, evaluateHardRejects, evaluateRegime } from '../../src/gates/index.ts';
import { DEV, SLOT, T, contextOf, deps, drop, passingFacts, patch, request, type Facts } from './world.ts';

const DIAG = { s0Diagnostic: true } as const;
const regime = (f: Facts, diag: boolean) => evaluateRegime(contextOf(f), { ...deps('live'), ...(diag ? DIAG : {}) });
const hard = (f: Facts, diag: boolean) => evaluateHardRejects(contextOf(f), { ...deps('live'), ...(diag ? DIAG : {}) }, request());

/** The creates stream started `days` ago (a fresh host), and the deployer index with it. */
const freshHost = (days: number): Facts => {
  const f = patch(passingFacts(), deployerKey(DEV), { coverageFromMs: T - days * DAY_MS });
  const start = f.get('coverage:creates:start')!;
  f.set('coverage:creates:start', { value: start.value, moment: { slot: SLOT - BigInt(days) * 216_000n, txIndex: OFF_CHAIN, ixIndex: OFF_CHAIN, receivedAt: T - days * DAY_MS } });
  return f;
};

describe('S0 diagnostic set', () => {
  it('names exactly three parts', () => {
    expect(S0_DIAGNOSTIC_PARTS).toEqual(['regime-volume', 'exec-health', 'h14-creates-coverage']);
  });

  it('regime volume: a missing curve-volume fact turns the regime off, and with the set is logged but not judged', () => {
    const f = drop(passingFacts(), CURVE_VOLUME_KEY);
    expect(regime(f, false).on).toBe(false);
    const r = regime(f, true);
    expect(r.on).toBe(true);
    expect(r.waived).toContain('regime-volume');
    expect(r.checks[0]!.conditions).toContainEqual(expect.objectContaining({ condition: 'volume', ok: null, input: 'curve-volume' }));
  });

  it('regime volume: a failing volume day is not judged with the set; survival and SOL change still are', () => {
    const v = passingFacts().get(CURVE_VOLUME_KEY)!.value as { days: { day: number; volumeLamports: bigint }[] };
    const lag = Math.floor(T / DAY_MS) - 3;
    const low = patch(passingFacts(), CURVE_VOLUME_KEY, { days: v.days.map((d) => (d.day === lag ? { ...d, volumeLamports: 1n } : d)) });
    expect(regime(low, false).checks[0]!.conditions).toContainEqual(expect.objectContaining({ condition: 'volume', ok: false }));
    expect(regime(low, true).waived).toContain('regime-volume');
    // The SOL series missing still turns it off: only volume is relaxed.
    const r = regime(drop(drop(passingFacts(), CURVE_VOLUME_KEY), SOL_USD_KEY), true);
    expect(r.on).toBe(false);
    expect(r.waived).toEqual([]);
  });

  it('regime with a computed passing volume relies on no part but exec-health', () => {
    expect(regime(passingFacts(), true).waived).toEqual(['exec-health']);
    expect(regime(passingFacts(), false).waived).toEqual([]);
  });

  it('exec-health: absent or red turns the regime off; with the set it is measured and logged, never judged', () => {
    const none = drop(passingFacts(), EXEC_HEALTH_KEY);
    expect(regime(none, false).reasons).toContainEqual(expect.objectContaining({ code: 'unknown', input: 'exec-health' }));
    const red = patch(passingFacts(), EXEC_HEALTH_KEY, { green: false, detail: '3 attempts, 2 failed' });
    expect(regime(red, false).reasons).toContainEqual(expect.objectContaining({ code: 'exec-health' }));
    for (const f of [none, red]) {
      const r = regime(f, true);
      expect(r.on).toBe(true);
      expect(r.execHealth.applied).toBe(false);
      expect(r.execHealth.detail).toMatch(/^S0 diagnostic, not judged: /);
    }
    expect(regime(red, true).execHealth).toEqual({ applied: false, green: false, detail: 'S0 diagnostic, not judged: 3 attempts, 2 failed' });
  });

  it('H14 creates coverage: a 2-day host is not covered; with the set the deployer is judged over those 2 days and noted', () => {
    const f = freshHost(2);
    expect(hard(f, false).reasons).toContainEqual(expect.objectContaining({ gate: 'H16', code: 'not-covered', neededBy: 'H14' }));
    const r = hard(f, true);
    expect(r.failed).not.toContain('H14');
    expect(r.notes).toContainEqual(expect.objectContaining({ gate: 'H14', code: 's0-diagnostic' }));
  });

  it('H14 with the set still judges the deployer: a serial deployer inside the short coverage rejects', () => {
    const f = patch(freshHost(2), deployerKey(DEV), {
      mints: Array.from({ length: 30 }, (_, k) => ({ mint: `M${k}`, createdAtMs: T - 3_600_000 - k * 1000 })),
    });
    const r = hard(f, true);
    expect(r.reasons).toContainEqual(expect.objectContaining({ gate: 'H14', code: 'serial-deployer' }));
  });

  it('H14 with the set: full coverage relies on nothing, no note', () => {
    expect(hard(passingFacts(), true).notes.filter((n) => n.code === 's0-diagnostic')).toEqual([]);
  });
});
