// The funnel counts every check once, at the first failed gate in H1…H16 order or the later stage it stopped at, and
// keeps adverse rejects apart from missing evidence ("not covered"); mints are counted at their furthest stage.
import { describe, expect, it } from 'vitest';
import type { GateReason, HardGate, HardResult } from '../../core/src/gates/index.ts';
import { firstStop, Funnel, funnelLines } from '../src/study/funnel.ts';

const result = (reasons: GateReason[]): HardResult => {
  const failed = [...new Set(reasons.map((r) => r.gate))] as HardGate[];
  return { pass: reasons.length === 0, mode: 'backtest', mint: 'm', evaluated: [], passed: [], failed, reasons, notes: [] };
};
const r = (gate: HardGate, code: GateReason['code'], neededBy?: HardGate): GateReason => ({ gate, code, detail: 'x', ...(neededBy === undefined ? {} : { neededBy }) });

describe('funnel', () => {
  it('stops a check at the first failed gate in order, counting evidence the gate needed under that gate', () => {
    expect(firstStop(result([r('H14', 'prior-rug'), r('H9', 'excluded-window')]))).toEqual({ gate: 'H9', cls: 'adverse' });
    // Missing pool evidence is filed under H16 for H5: the check stops at H5, not covered.
    expect(firstStop(result([r('H16', 'missing', 'H5'), r('H12', 'single-holder')]))).toEqual({ gate: 'H5', cls: 'not covered' });
    // A lead-in mint's unjudged deployer is "not covered" at H14, never a reject.
    expect(firstStop(result([r('H14', 'not-covered')]))).toEqual({ gate: 'H14', cls: 'not covered' });
    expect(firstStop(result([]))).toBeNull();
  });

  it('counts checks by stage and mints at their furthest stage, by universe, with evidence-only stops apart', () => {
    const f = new Funnel();
    f.gates('U2', 'a', result([r('H13', 'not-covered')]));
    f.gates('U2', 'a', result([r('H12', 'single-holder'), r('H13', 'not-covered')]));
    f.record('U2', 'a', 'setup', 'adverse');
    f.gates('U2', 'b', result([r('H16', 'stale', 'H8')]));
    f.record('U2', 'c', 'entered', 'adverse');
    f.gates('U1', 'd', result([r('H14', 'serial-deployer')]));
    const s = f.summary();
    expect(Object.keys(s)).toEqual(['U1', 'U2']);
    const u2 = s['U2']!;
    expect(u2.checks).toBe(5);
    expect(u2.mints).toBe(3);
    expect(u2.checksAt).toEqual({ H8: { adverse: 0, notCovered: 1 }, H12: { adverse: 1, notCovered: 0 }, H13: { adverse: 0, notCovered: 1 }, setup: { adverse: 1, notCovered: 0 }, entered: { adverse: 1, notCovered: 0 } });
    // Mint a reached setup on its third check; b stopped at H8 for missing evidence; c entered.
    expect(u2.mintsAt).toEqual({ H8: { adverse: 0, notCovered: 1 }, setup: { adverse: 1, notCovered: 0 }, entered: { adverse: 1, notCovered: 0 } });
    expect(u2.gateFailures).toEqual({ H8: { adverse: 0, notCovered: 1 }, H12: { adverse: 1, notCovered: 0 }, H13: { adverse: 0, notCovered: 2 } });
    expect(u2.evidenceOnly).toBe(2);
    // b is excluded for coverage (1 of 3 mints); a and c are not.
    expect(u2.coverageExclusions).toEqual({ mints: 1, share: 1 / 3 });
    expect(funnelLines(u2)[1]).toBe('coverage exclusions: 1 mints (33.3%), not rejects');
    expect(s['U1']!.checksAt).toEqual({ H14: { adverse: 1, notCovered: 0 } });
    expect(funnelLines(u2)[0]).toBe('5 checks on 3 mints; 2 checks stopped by missing evidence alone');
    expect(funnelLines(u2)).toContain('entered: checks 1; mints 1');
  });
});

describe('feature rule', () => {
  const rule = { kind: 'features' as const, conds: [{ f: 'f_net15' as const, dir: 'ge' as const, t: '0.5' }, { f: 'f_age' as const, dir: 'le' as const, t: '90' }], stopBelowBps: 2000 };
  it('holds only when every condition holds; an unknown feature fails; the stop is fixed below the spot', async () => {
    const { featureSetup } = await import('../src/strategy/study.ts');
    expect(featureSetup(rule, { features: { f_net15: 0.5, f_age: 90 } }, 1_000n)).toEqual({ ok: true, stopSpot: 800n });
    expect(featureSetup(rule, { features: { f_net15: 0.49, f_age: 10 } }, 1_000n)).toMatchObject({ ok: false, why: 'f_net15 0.49 < 0.5' });
    expect(featureSetup(rule, { features: { f_net15: 1, f_age: 91 } }, 1_000n)).toMatchObject({ ok: false, why: 'f_age 91 > 90' });
    expect(featureSetup(rule, { features: { f_net15: null, f_age: 1 } }, 1_000n)).toMatchObject({ ok: false, why: 'f_net15 unknown' });
    expect(featureSetup(rule, null, 1_000n)).toMatchObject({ ok: false });
  });
});
