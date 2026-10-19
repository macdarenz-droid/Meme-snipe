// RED TEAM: a TRADE-GAP-HEAL heal clears the sticky `partial` flag that POOL-FIRST-READ part 3 set on a late-opened
// candle book (swaps let go past PRE_READ_KEEP before the migration), so H11 reads candles with trades missing as
// complete (FAIL-OPEN).
//
// Scenario (deterministic):
//   1. The trade stream starts and the pool is read; then PRE_READ_KEEP + 2 swaps are released (66 at R+1, one at R+2)
//      before the migration transaction is (the migration fetched late, off-chain at R+6). The two oldest swaps are let
//      go past the per-pool cap.
//   2. The migration's events open the book; at the next event of another transaction `#bookTake` applies the 64 kept
//      swaps. Each new slot calls `#markBook` (capturing `partial: false`), and only AFTER the loop `book.partial = true`
//      is set (the dropped swaps). The candles are correctly partial here.
//   3. That next event is a cut log (truncated, with an event before the cut) of a transaction at slot R+2 on the pool's
//      watch, released late (off-chain, as a catch-up's held notification is: `lookup` + `after`). `#program` calls
//      `#hole(via, seen.slot = R+2)`. The book's mark is at R+2 (from #bookTake), so `#holeHeal` reuses it: a mark whose
//      `partial` is false.
//   4. The hole's transaction is fetched (no swap on this pool in it) and the found outcome comes. `#heal` rebuilds the
//      book from the mark: `book.partial = m.partial` (false); the replay of the R+2 swap does not set it again. The
//      hole's gap is removed: the stream is gap-free since its start.
//   Result: candles with no 'partial' flag, a gap-free trade stream, and two swaps of the pool missing from them. H11 ok.
//
// Realism: needs (a) more than PRE_READ_KEEP (64) swaps of one pool released before its migration's transaction (a
// re-read / catch-up fill placing the migration late: the case POOL-FIRST-READ part 3 was written for), and (b) a cut
// log on that pool's watch at exactly the slot of the last kept swap, released after the migration transaction. In the
// live worker both the fill's transactions and a catch-up's held notifications are placed off-chain (`lookup` +
// `after`), so they can interleave at the same open slot; a busy pool emits many swaps a slot, so "the last kept swap's
// slot" is the most likely slot for any cut log in the held batch. Rare but reachable; the outcome is fail-open on H11.
import { describe, expect, it } from 'vitest';
import { PRE_READ_KEEP } from '../../src/facts/index.ts';
import {
  type MarketEvent, type Swap, FactWorld, OFF_CHAIN, R, VIA, at, candles, fetched, gapFree, head, logOf, migration, nextN, opened, outcome, readEv,
  startEv, swap, verdicts,
} from './kit.ts';

/** A cut log of a transaction at `slot` on the pool's watch (an event before the cut, on another pool), released late. */
const lateCutLog = (sig: string, slot: bigint, arrives: bigint, data: Record<string, unknown>): MarketEvent => ({
  kind: 'market', id: `log:${sig}:confirmed:00000`, moment: { slot: arrives, txIndex: OFF_CHAIN, ixIndex: 3, receivedAt: at(arrives) + 30 },
  key: 'logs:pump_amm:BuyEvent:OtherPool111111111111111111111111111111111',
  value: { event: { program: 'pump_amm', name: 'BuyEvent', data: { ...data, pool: 'OtherPool111111111111111111111111111111111' }, logIndex: 0 }, signature: sig, txSlot: slot, truncated: true, via: VIA, commitment: 'confirmed', source: 'helius', backfilled: false, seq: nextN() },
});

describe('red team: a heal at the last kept swap\'s slot clears the late book\'s sticky partial', () => {
  it('candles with swaps let go past the cap stay partial after a heal of a hole at the last kept swap\'s slot', () => {
    const { state } = opened();
    const s: Swap[] = [];
    let pre = state;
    for (let i = 0; i <= PRE_READ_KEEP; i++) {
      const x = swap('buy', pre, 1_000n, R + 1n);
      s.push(x);
      pre = x.after;
    }
    s.push(swap('buy', pre, 1_000n, R + 2n));
    const arrives = R + 6n;
    const world = new FactWorld().push(startEv(), readEv(), ...s.map((x, k) => logOf(x, k)), ...migration(state, arrives));
    // The cut log (tx at R+2) released late: it is also the "first event of another transaction" that runs #bookTake.
    world.push(lateCutLog('lateCut', R + 2n, arrives, s[0]!.data));
    expect(candles(world).obs.quality).toContain('partial');
    // The hole's transaction fetched (nothing on this pool in it) and found.
    world.push(...fetched('lateCut', R + 2n, arrives, [], 4), outcome('lateCut', true, arrives, 40, 5));
    head(world);
    // Two of the pool's swaps (the oldest two at R+1) are not in the candles: they must stay partial, H11 must refuse.
    expect(gapFree(world)).toBeLessThanOrEqual(candles(world).obs.slot!);
    // H11 must refuse; on the current code it passes ('ok') with the two swaps missing.
    expect({ quality: candles(world).obs.quality, H11: verdicts(world).candles }).toEqual({ quality: ['partial'], H11: expect.not.stringMatching(/^ok$/) });
  });
});
