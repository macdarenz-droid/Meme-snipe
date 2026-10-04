// Audit B2: the study's entry decision evaluates every hard-gate stage from stage 1 in one call at one moment, as the
// live worker's staged path (FACTS-1f), and on the same facts it allows an entry exactly when the live gate does.
import { describe, expect, it } from 'vitest';
import { createKey, evaluateHardRejects, HARD_GATES, holdersKey, mintKey, type Mode } from '../../core/src/gates/index.ts';
import { contextOf, deps, drop, passingFacts, request, session, type Facts } from '../../core/test/gates/world.ts';
import { HARD_STAGE_GROUPS, stagedHardRejects } from '../src/strategy/study.ts';

const WORLDS: Record<string, Facts> = {
  passing: passingFacts(),
  'stage 1 fails (no create)': drop(passingFacts(), createKey(request().mint)),
  'stage 2 fails (no mint account)': drop(passingFacts(), mintKey(request().mint)),
  'stage 3 fails (no holders)': drop(passingFacts(), holdersKey(request().mint)),
};

describe('staged hard rejects (audit B2)', () => {
  for (const mode of ['live', 'backtest'] as const satisfies readonly Mode[]) {
    for (const [name, facts] of Object.entries(WORLDS)) {
      it(`${mode}, ${name}: allows an entry exactly when the live single evaluation passes; each group's reasons are that stage's`, () => {
        const ctx = contextOf(facts);
        const d = deps(mode, session(), 'RUG-1');
        const s = stagedHardRejects(ctx, d, request());
        const live = evaluateHardRejects(ctx, d, request());
        expect(s.hard.complete && s.hard.reasons.length === 0).toBe(live.pass);
        expect(s.stopped).toBe(!live.pass);
        // The groups that ran, each as its own every-gate call at the same moment; the rest are named, never passed.
        let k = 0;
        for (const g of HARD_STAGE_GROUPS) {
          if (!g.every((x) => s.hard.evaluated.includes(x))) break;
          expect(s.hard.reasons.filter((r) => g.includes(r.neededBy ?? r.gate))).toEqual(evaluateHardRejects(ctx, d, request(), { stopAtFirst: false, only: g }).reasons.filter((r) => g.includes(r.neededBy ?? r.gate)));
          k++;
        }
        expect(s.notEvaluated).toEqual(HARD_STAGE_GROUPS.slice(k).flat());
        expect(s.hard.passed.some((x) => s.notEvaluated.includes(x))).toBe(false);
      });
    }
  }

  it('is complete only when every hard gate was evaluated (GATE-2): stopping short of stage 3 never is', () => {
    const ctx = contextOf(passingFacts());
    const d = deps('backtest', session(), 'RUG-1');
    expect(stagedHardRejects(ctx, d, request(), 3).hard.complete).toBe(true);
    expect(stagedHardRejects(ctx, d, request(), 3).hard.evaluated.slice().sort()).toEqual(HARD_GATES.slice().sort());
    for (const groups of [1, 2] as const) {
      const r = stagedHardRejects(ctx, d, request(), groups);
      expect([r.hard.complete, r.stopped]).toEqual([false, false]);
      expect(r.notEvaluated).toEqual(HARD_STAGE_GROUPS.slice(groups).flat());
    }
  });

  it('an ablation run goes on past a group whose only failures are ablated gates, and stops on any other', () => {
    const facts = drop(passingFacts(), createKey(request().mint));
    const ctx = contextOf(facts);
    const d = deps('backtest', session(), 'RUG-1');
    const every = evaluateHardRejects(ctx, d, request(), { stopAtFirst: false }).failed;
    const first = stagedHardRejects(ctx, d, request());
    expect(first.notEvaluated).toEqual(HARD_STAGE_GROUPS.slice(1).flat());
    const ablated = stagedHardRejects(ctx, d, request(), 3, every);
    expect([ablated.stopped, ablated.hard.complete]).toEqual([false, true]);
    // One stage-1 failure not ablated: it stops at stage 1 again.
    expect(stagedHardRejects(ctx, d, request(), 3, every.filter((g) => g !== first.hard.failed[0])).notEvaluated).toEqual(HARD_STAGE_GROUPS.slice(1).flat());
  });
});
