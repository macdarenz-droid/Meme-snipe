// FACTS-1 evaluation staging: every hard gate belongs to exactly one stage, stream-derived gates come first, the
// complete holder scan and funders after the account reads, the simulation last; `only` evaluates one stage alone
// (GATE-2, taken from #41 so FACTS-1f and BT-2 share one stage table).
import { describe, expect, it } from 'vitest';
import { evaluateHardRejects, gatesOfStages, HARD_GATES, HARD_ORDER, HARD_STAGE, type HardGate } from '../../src/gates/index.ts';
import { contextOf, deps, passingFacts, request, session } from './world.ts';

describe('evaluation stages', () => {
  it('partition the hard gates, each stage in evaluation order', () => {
    const all = [...gatesOfStages([1]), ...gatesOfStages([2]), ...gatesOfStages([3]), ...gatesOfStages([4])];
    expect([...all].sort()).toEqual([...HARD_GATES].sort());
    expect(new Set(all).size).toBe(HARD_GATES.length);
    const order = HARD_ORDER.map((x) => x.gate);
    for (const s of [1, 2, 3, 4] as const) {
      const g = gatesOfStages([s]);
      expect(g).toEqual(order.filter((x) => g.includes(x)));
    }
  });

  it('put stream-derived gates first, account reads second, the holder scan and funders third, the simulation last', () => {
    expect(gatesOfStages([1])).toEqual(['H7', 'H9', 'H10', 'H11', 'H14']);
    expect(HARD_STAGE.H12).toBe(3);
    expect(HARD_STAGE.H13).toBe(3);
    expect(HARD_STAGE.H15).toBe(4);
    for (const g of ['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'H8', 'H16', 'H17'] as const) expect(HARD_STAGE[g]).toBe(2);
  });
});

describe('evaluating one stage (`only`)', () => {
  const all = (only?: readonly HardGate[]) =>
    evaluateHardRejects(contextOf(passingFacts()), deps('live', session(), 'RUG-1'), request(), { stopAtFirst: false, ...(only === undefined ? {} : { only }) });

  it('evaluates exactly the given gates, in evaluation order, and leaves the others out of the result', () => {
    for (const s of [1, 2, 3, 4] as const) {
      const r = all(gatesOfStages([s]));
      expect(r.evaluated).toEqual(gatesOfStages([s]));
      expect([...r.passed, ...r.failed].every((g) => HARD_STAGE[g] === s)).toBe(true);
      expect(r.reasons.every((x) => HARD_STAGE[x.gate] === s || (x.neededBy !== undefined && HARD_STAGE[x.neededBy] === s))).toBe(true);
    }
  });

  it('the stages together give what one full evaluation gives', () => {
    const full = all();
    const staged = ([1, 2, 3, 4] as const).map((s) => all(gatesOfStages([s])));
    expect(staged.flatMap((r) => r.evaluated).sort()).toEqual([...full.evaluated].sort());
    expect(staged.flatMap((r) => r.passed).sort()).toEqual([...full.passed].sort());
    expect(staged.flatMap((r) => r.failed).sort()).toEqual([...full.failed].sort());
  });

  it('without `only`, every gate is evaluated, as before', () => {
    expect(all().evaluated).toEqual(HARD_ORDER.map((x) => x.gate));
  });
});
