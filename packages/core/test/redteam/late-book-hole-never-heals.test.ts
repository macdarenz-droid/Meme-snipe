// RED TEAM (liveness, fail-closed): a hole on a pool's trade stream released before the pool's candle book exists (the
// migration's transaction released late, POOL-FIRST-READ part 3) is never healed, although its transaction is fetched
// and found and every swap is delivered. `#holeHeal` returns at `book === undefined` without starting a heal, while the
// hole's signature is already in `#holeSigs`; the fetched swap is then dropped by `#swap` (`!fromLogs && holeSigs.has`,
// no heal waiting) from both the book and the chain, and the hole's gap stays in the stream for good: H11 refuses the
// coin (H16 gap) for its whole window. The same tape with the migration released in order heals (trade-heal.test.ts).
//
// Realism: needs the late-migration case (a re-read / fill placing the migration transaction after the pool's swaps)
// plus a cut log among the swaps kept before it. Holes are common (DECISIONS TRADE-GAP-HEAL: median ~16 per coin), so
// given a late migration this is likely. Whether WORKER-1 fetches for it depends on `#candidatePool` knowing the
// pool's migration slot when the cut log is seen; if it does not, it answers not found and the hole stays anyway.
// Impact: a missed candidate (no wrong data reaches a gate). Severity LOW.
import { describe, expect, it } from 'vitest';
import { FactWorld, R, candles, fetchedSwaps, gapFree, head, hole, logOf, migration, opened, outcome, readEv, startEv, tape, verdicts } from './kit.ts';

describe('red team: a hole released before a late-opened book', () => {
  it('heals once its transaction is fetched and found, as it does when the migration came first', () => {
    const { state } = opened();
    const s = tape(state);
    const world = new FactWorld().push(startEv(), readEv(), logOf(s[0]!), logOf(s[1]!), hole(s[2]!.sig, s[2]!.slot), logOf(s[3]!), logOf(s[4]!));
    const arrives = R + 6n;
    world.push(...migration(state, arrives));
    world.push(...fetchedSwaps(s[2]!.sig, s[2]!.slot, arrives, [s[2]!], 4), outcome(s[2]!.sig, true, arrives, 40, 5));
    head(world);
    expect({ gapFreeFromOpen: gapFree(world) <= candles(world).obs.slot!, H11: verdicts(world).candles }).toEqual({ gapFreeFromOpen: true, H11: 'ok' });
  });
});
