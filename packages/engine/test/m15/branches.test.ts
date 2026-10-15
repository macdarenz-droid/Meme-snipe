// Z01-COV: the remaining branches of the slot-time maths (SPEC-B Common DoD #8, ARCH 16.1): anchor checks, anchor order
// and distance, and the clamp of a time before the first slot.
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';
import type { Slot } from '@bot/types';
import { historySlotTimeBasis, liveSlotTimeBasis, slotDelta, timeToSlot } from '../../src/m15/slot-time.ts';

const S = (n: number | bigint): Slot => BigInt(n) as Slot;

describe('slot-time: remaining refusals and clamps', () => {
  it('an anchor needs a bigint slot ≥ 0 and a finite time ≥ 0', () => {
    for (const slot of [-1n, 5, '5']) assert.throws(() => liveSlotTimeBasis({ slot: slot as unknown as Slot, atMs: 1_000 }, 400), /anchor slot/);
    for (const atMs of [-1, Number.NaN, Infinity]) assert.throws(() => liveSlotTimeBasis({ slot: S(1), atMs }, 400), /anchor time/);
  });
  it('anchors given newest first are sorted; two on one slot and two too far apart in slots are refused', () => {
    const newestFirst = historySlotTimeBasis([{ slot: S(1_100), atMs: 1_040_000 }, { slot: S(1_000), atMs: 1_000_000 }]);
    assert.equal(timeToSlot(1_020_000, newestFirst), S(1_050));
    assert.throws(() => historySlotTimeBasis([{ slot: S(5), atMs: 1_000 }, { slot: S(5), atMs: 1_000 }]), /two anchors on one slot/);
    assert.throws(() => historySlotTimeBasis([{ slot: S(0), atMs: 0 }, { slot: S(2n ** 53n), atMs: 1_000 }]), /anchors too far apart/);
  });
  it('slotDelta refuses a distance past 2^52 in either direction', () => {
    assert.equal(slotDelta(S(5), S(9)), 4);
    assert.equal(slotDelta(S(9), S(5)), -4);
    assert.throws(() => slotDelta(S(0), S(2n ** 53n)), /too far/);
    assert.throws(() => slotDelta(S(2n ** 53n), S(0)), /too far/);
  });
  it('a time before the first slot of a live basis gives slot 0, never a negative slot', () => {
    const basis = liveSlotTimeBasis({ slot: S(10), atMs: 5_000 }, 400);
    assert.equal(timeToSlot(0, basis), S(0));
  });
});
