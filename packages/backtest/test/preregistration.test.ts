// RES-4's pre-registered family read in BT-2's shape: bound by its sha256, every hypothesis parsed strictly, its ids
// tagging the configurations; the plan records the hash and ids, so the family is fixed for the window.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { STUDY_CONFIG, configId } from '../src/strategy/config.ts';
import { parsePreregistration } from '../src/strategy/preregistration.ts';
import { holdoutPlanOf, studyPlan } from '../src/study/plan.ts';
import { RULED_ALPHA } from '../src/holdout.ts';

const U2W = { universe: 'U2', fromMs: 3_600_000, toMs: 14_400_000, everyMs: 60_000, minQuoteLamports: '0' };
const doc = (over: Record<string, unknown>[] = []) => JSON.stringify({
  task: 'RES-4',
  hypotheses: [
    { id: 'H4-U2-reclaim', universe: 'U2', window: U2W, rules: { kind: 'U2', flushBps: 3000, higherLowBps: 500, recentMs: 900_000, stopBelowLowBps: 100 }, edgePpm: '50000', medianTargetBps: 3000 },
    {
      id: 'H5-U2-exhausted-dump', universe: 'U2', window: U2W,
      rules: { kind: 'features', conds: [{ f: 'f_dd', dir: 'le', t: '-0.60' }, { f: 'f_early_sold', dir: 'ge', t: '0.80' }, { f: 'f_devnet', dir: 'le', t: '0.01' }, { f: 'f_net15', dir: 'ge', t: '0' }, { f: 'f_hl', dir: 'ge', t: '1' }], stopBelowBps: 2000 },
      edgePpm: '50000', medianTargetBps: 3000,
    },
    ...over,
  ],
}, null, 1);
const sha = (t: string) => createHash('sha256').update(t).digest('hex');

describe('pre-registration', () => {
  it('reads every hypothesis in BT-2\'s shape, five-condition feature rules included, tagged by its id', () => {
    const t = doc();
    const p = parsePreregistration(t, sha(t));
    expect(p.sha256).toBe(sha(t));
    expect(p.hypotheses.map((h) => [h.id, h.universe, h.rules.kind])).toEqual([['H4-U2-reclaim', 'U2', 'U2'], ['H5-U2-exhausted-dump', 'U2', 'features']]);
    expect(p.hypotheses[1]!.rules).toMatchObject({ kind: 'features', stopBelowBps: 2000 });
    expect((p.hypotheses[1]!.rules as unknown as { conds: unknown[] }).conds).toHaveLength(5);
    expect(p.hypotheses[0]!).toMatchObject({ edgePpm: 50_000n, window: { minQuoteLamports: 0n, everyMs: 60_000 } });
    // The id is the configuration's tag and names its configuration id.
    const c = { ...STUDY_CONFIG, universes: [p.hypotheses[1]!] };
    expect(configId(c, 'H5-U2-exhausted-dump')).toMatch(/^H5-U2-exhausted-dump-[0-9a-f]{16}$/);
  });

  it('refuses a file whose sha256 is not the registered one, and any malformed hypothesis', () => {
    const t = doc();
    expect(() => parsePreregistration(t, sha(`${t} `))).toThrow(/is not the registered/);
    const refuse = (h: Record<string, unknown>, re: RegExp) => { const x = doc([h]); expect(() => parsePreregistration(x, sha(x))).toThrow(re); };
    const base = { id: 'H9', universe: 'U2', window: U2W, rules: { kind: 'features', conds: [{ f: 'f_dd', dir: 'le', t: '-0.6' }], stopBelowBps: 2000 }, edgePpm: '50000', medianTargetBps: 3000 };
    refuse({ ...base, id: 'H4-U2-reclaim' }, /repeated/);
    refuse({ ...base, rules: { kind: 'features', conds: [{ f: 'f_nope', dir: 'le', t: '1' }], stopBelowBps: 1 } }, /unknown feature f_nope/);
    refuse({ ...base, rules: { kind: 'features', conds: [{ f: 'f_dd', dir: 'le', t: 0.5 }], stopBelowBps: 1 } }, /exact decimal text/);
    refuse({ ...base, window: { ...U2W, universe: 'U1' } }, /window must be for its universe/);
    refuse({ ...base, edgePpm: 50000 }, /decimal integer string/);
  });

  it('binds the family to the holdout plan: its hash and ids are in the plan, so a seventh hypothesis is a different plan', () => {
    const t = doc();
    const p = parsePreregistration(t, sha(t));
    const sp = studyPlan(STUDY_CONFIG, 2 * 3_600_000 + 900_000);
    const plan = holdoutPlanOf(STUDY_CONFIG, sp, RULED_ALPHA, p);
    expect(plan.details['preregistration']).toEqual({ sha256: sha(t), ids: ['H4-U2-reclaim', 'H5-U2-exhausted-dump'] });
    const seven = doc([{ id: 'H7', universe: 'U2', window: U2W, rules: { kind: 'U2', flushBps: 1, higherLowBps: 1, recentMs: 1, stopBelowLowBps: 1 }, edgePpm: '1', medianTargetBps: 1 }]);
    expect(holdoutPlanOf(STUDY_CONFIG, sp, RULED_ALPHA, parsePreregistration(seven, sha(seven))).details['preregistration']).not.toEqual(plan.details['preregistration']);
    expect(holdoutPlanOf(STUDY_CONFIG, sp, RULED_ALPHA).details['preregistration']).toBeUndefined();
  });
});
