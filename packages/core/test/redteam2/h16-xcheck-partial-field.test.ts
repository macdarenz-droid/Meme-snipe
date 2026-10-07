// RED TEAM 2 / H16 cross-check: `reported` keeps a source when it reported EITHER authority (hard.ts:592), so a fact in
// which no third party reported the mint authority (or none reported the freeze authority) passes H16 with that
// field never cross-checked.
//
// Scenario: RugCheck and Jupiter are rate limited / unkeyed (no read in the last 2 s), GoPlus answers with
// `freezable.status = "0"` and no `mintable` status (producer status() -> null). The xcheck fact is
// { sources: [{ goplus, mintAuthority: null, freezeAuthority: 'none' }] }. H16 passes although no one cross-checked
// the mint authority. The gate already treats "no source reported anything" as missing (hard.ts:593); the same
// rule per field is the fail-closed reading of §7.1 H16 ("a third-party cross-check ... of authorities").
//
// Realism: medium. GoPlus omits fields for fresh tokens; RugCheck is often 429; Jupiter audit needs a key and
// returns nullable booleans (producer `off(null)` -> null). Our own read (H2/H3) still runs, so this is a lost
// independent check, not a direct pass on a set authority.
import { describe, expect, it } from 'vitest';
import { evaluateHardRejects, xcheckKey } from '../../src/gates/index.ts';
import { MINT, contextOf, deps, passingFacts, patch, request, session } from '../gates/world.ts';

const h16 = (sources: unknown[]) => {
  const f = patch(passingFacts(), xcheckKey(MINT), { sources });
  const r = evaluateHardRejects(contextOf(f), deps('live', session(), 'RUG-1'), request(), { stopAtFirst: false });
  return r.reasons.filter((x) => x.gate === 'H16' && (x.input === 'xcheck'));
};

describe('redteam2: H16 passes with an authority no third party reported', () => {
  it('mint authority reported by no source must be missing evidence', () => {
    expect(h16([{ provider: 'goplus', mintAuthority: null, freezeAuthority: 'none' }]).map((x) => x.code)).toContain('missing');
  });
  it('freeze authority reported by no source must be missing evidence', () => {
    expect(h16([{ provider: 'jupiter', mintAuthority: 'none', freezeAuthority: null }]).map((x) => x.code)).toContain('missing');
  });
});
