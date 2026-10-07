// RT-A5 (red team A on 959d8017): a hole on a pool's trade stream seen before the pool's candle book opened (a late
// migration) heals once the book opens, through the same heal a live hole takes: the hole, its fetched transaction's
// swaps, anything that taints it and its fetch outcome are kept for the book in release order and replayed when it
// opens. Fail closed as live: a not-found outcome, a PumpSwap event other than a swap in the hole's transaction, or one
// on the pool's watch since the mark, leaves the hole for good.
import { describe, expect, it } from 'vitest';
import {
  type MarketEvent, FactWorld, R, VIA, at, candles, fetched, fetchedSwaps, gapFree, head, hole, logOf, migration, nextN, opened, outcome,
  readEv, startEv, tape, verdicts,
} from '../redteam/kit.ts';

/** A confirmed PumpSwap event other than a swap on the pool's watch, at `slot`. */
const otherOnWatch = (slot: bigint): MarketEvent => ({
  kind: 'market', id: `log:other${slot}:confirmed:00000`, moment: { slot, txIndex: 2 ** 32 + 999, ixIndex: 2 ** 36, receivedAt: at(slot) + 999 },
  key: 'logs:pump_amm:other:pump_amm',
  value: { event: { program: 'pump_amm', name: 'other', discriminator: '0011223344556677', logIndex: 0 }, signature: `other${slot}`, txSlot: slot, truncated: false, via: VIA, commitment: 'confirmed', source: 'helius', backfilled: false, seq: nextN() },
});

/** The tape with swap 3 cut, everything about the hole released before the late migration (at R+6). */
const late = (o: { found?: boolean; taint?: boolean; other?: boolean } = {}) => {
  const { state } = opened();
  const s = tape(state);
  const world = new FactWorld().push(startEv(), readEv(), logOf(s[0]!), logOf(s[1]!), hole(s[2]!.sig, s[2]!.slot), logOf(s[3]!));
  if (o.other === true) world.push(otherOnWatch(s[3]!.slot));
  world.push(logOf(s[4]!));
  const arrives = R + 5n;
  const tx: MarketEvent[] = o.taint === true
    ? fetched(s[2]!.sig, s[2]!.slot, arrives, [{ name: s[2]!.name, data: s[2]!.data }, { name: 'other' }])
    : fetchedSwaps(s[2]!.sig, s[2]!.slot, arrives, [s[2]!]);
  world.push(...tx, outcome(s[2]!.sig, o.found ?? true, arrives, 20, 3), ...migration(state, R + 6n));
  return head(world);
};

describe('a hole seen before a late-opened book (RT-A5)', () => {
  it('its fetch and found outcome, also released before the book, heal it once the book opens', () => {
    const w = late();
    expect(gapFree(w)).toBeLessThanOrEqual(candles(w).obs.slot!);
    expect(verdicts(w).candles).toBe('ok');
    expect(candles(w).obs.quality).toEqual([]);
  });

  it('fails closed as live: not found, a tainted transaction, or a non-swap pool event since the mark leave the hole', () => {
    for (const o of [{ found: false }, { taint: true }, { other: true }]) {
      const w = late(o);
      expect(verdicts(w).candles, JSON.stringify(o)).toBe('H16:gap');
    }
  });
});
