// RED TEAM 2 / H15: the simulation fact is judged only by its receipt age ('offchain', maxQuoteAgeMs = 2 s); the chain
// slot it was simulated at is never compared with the tip or with the pool/mint state the round trip was quoted on.
//
// Scenario: the sim answer arrives 500 ms before the decision (fresh by receipt time) but its context slot is 5,000
// slots (about 33 minutes) behind the decision slot and the pool fact (SLOT - 1). That is a simulation of a different
// pool state (and possibly different global config / fee tier) than the round trip it is compared with, yet H15 passes.
//
// Realism: the producer stores the RPC's context slot in obs.slot (producer.ts read:sim). The worker's sim reader
// passes minContextSlot = feed head (worker/src/sim/roundtrip.ts:41), so today's live path bounds it; but the gate
// itself (the one rule live and replay share) accepts any slot, so a sim reader without that guard, a recorded
// session with an old sim frame, or a node that ignores minContextSlot all pass H15 on the wrong moment. Defense in
// depth: a chain-slot-bearing read must be judged against the tip like every other chain state ('state' lag).
import { describe, expect, it } from 'vitest';
import { evaluateHardRejects, simKey } from '../../src/gates/index.ts';
import { MINT, SLOT, T, contextOf, deps, obs, passingFacts, patch, request, session } from '../gates/world.ts';

describe('redteam2: H15 sim slot is never bound to the decision moment', () => {
  it('a simulation 5,000 slots behind the tip (received 500 ms ago) must not pass H15', () => {
    const f = patch(passingFacts(), simKey(MINT), { obs: obs({ slot: SLOT - 5_000n, receivedAt: T - 500 }) });
    const r = evaluateHardRejects(contextOf(f), deps('live', session(), 'RUG-1'), request(), { stopAtFirst: false });
    const h15 = r.reasons.filter((x) => x.gate === 'H15' || x.neededBy === 'H15');
    // Fail-closed: the simulation is of state 5,000 slots old, so it is stale evidence for H15.
    expect(h15.map((x) => x.code)).not.toEqual([]);
  });
});
