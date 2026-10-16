// M04's `ChainStatePort` from M15 (card Z10; SPEC-A C-84, rulings Z07-10, Z07-27, Z07-29, Z07-34).
//
// - `expectedSlot(now)` is the slot clock's estimate, `timeToSlot(now, basis)`, never 0 and never a highest slot seen.
// - Its anchor never comes from one provider (Z07-29). Every `anchorEveryMs` the adapter reads the height on each read
//   provider (`readHeight`: one `getEpochInfo` pinned to that provider, through M14's limiter). Not M15's `heightOn`:
//   that refuses a provider whose newest context slot is over 10 slots behind, and a backup read only every few seconds
//   always is, so it would never be read again (found in Z10). An anchor is taken only when at least two providers' slots,
//   moved to the same time at the measured slot time, are within `maxProviderLagSlots`. It is then the lowest of the
//   agreeing slots at that time, so one provider ahead can never push the estimate forward. Without agreement the
//   last agreed anchor stays and is moved on at the measured slot time.
// - Until a first agreed anchor exists, `ready()` is false: the composition root does not start M04 before then.
// - `slotDurationMsEstimate()` passes M15's value through as it is (0, NaN or ∞ included), so M04's own guard sees it
//   (Z07-34). The estimate itself uses the last valid slot time, so `expectedSlot` never throws.
// - `highestSeenBy()`: the one provider whose newest context slot equals M15's highest; null when none or more than
//   one does (null is never an independent witness, C-84).
import type { Slot, UnixMs } from '@bot/types';
import type { ChainStatePort } from '../m04/types.ts';
import type { SlotClock } from '../m15/clock.ts';
import { SLOT_MS_MAX, SLOT_MS_MIN, liveSlotTimeBasis, timeToSlot, type SlotTimeAnchor } from '../m15/slot-time.ts';

export const ANCHOR_EVERY_MS = 60_000;

export interface AnchorLog { event(level: 'info' | 'warn' | 'critical', code: string, fields: Readonly<Record<string, unknown>>): void }

export interface AgreedChainState extends ChainStatePort {
  /** True once two providers agreed on an anchor. */
  ready(): boolean;
  /** Reads every provider's height and takes an anchor when two agree. Never rejects. */
  refresh(): Promise<boolean>;
  /** The anchor in use (tests and health). */
  anchor(): { slot: Slot; atMs: number; providers: readonly string[] } | null;
}

const validSlotMs = (ms: number): boolean => Number.isFinite(ms) && ms >= SLOT_MS_MIN && ms <= SLOT_MS_MAX;

/** One height reading of one provider: its slot and when it was read (wall ms), or null on any failure. */
export type ReadHeight = (provider: string) => Promise<{ slot: Slot; atMs: number } | null>;

export function createAgreedChainState(o: {
  clock: Pick<SlotClock, 'highestSeenSlot' | 'slotDurationMsEstimate' | 'providerSlotLag'>;
  readHeight: ReadHeight;
  providers: readonly string[];
  maxProviderLagSlots: number;
  /** The slot time used until M15 has measured a valid one. */
  initialSlotMs: number;
  nowMs: () => UnixMs;
  log: AnchorLog;
}): AgreedChainState {
  if (o.providers.length < 2) throw new RangeError('recorder: the slot-clock anchor needs at least two read providers (C-84)');
  if (!validSlotMs(o.initialSlotMs)) throw new RangeError('recorder: initialSlotMs must be a valid slot time');
  let agreed: { slot: Slot; atMs: number; providers: readonly string[] } | null = null;
  let lastSlotMs = o.initialSlotMs;
  let disagreeing = false;

  const slotMs = (): number => {
    const ms = o.clock.slotDurationMsEstimate();
    if (validSlotMs(ms)) lastSlotMs = ms;
    return lastSlotMs;
  };

  const refresh = async (): Promise<boolean> => {
    let readings: Array<{ provider: string; slot: Slot; atMs: number }>;
    try {
      const rs = await Promise.all(o.providers.map(async (p) => ({ p, r: await o.readHeight(p) })));
      readings = rs.flatMap(({ p, r }) => (r !== null && r.slot > 0n ? [{ provider: p, slot: r.slot, atMs: r.atMs }] : []));
    } catch {
      readings = [];
    }
    if (readings.length < 2) return false;
    const ms = slotMs();
    const at = Math.max(...readings.map((r) => r.atMs));
    // Each reading moved to the same time `at`.
    const moved = readings.map((r) => ({ provider: r.provider, slot: (r.slot + BigInt(Math.floor((at - r.atMs) / ms))) as Slot }));
    const lag = BigInt(o.maxProviderLagSlots);
    let best: { slot: Slot; providers: string[] } | null = null;
    for (const a of moved) {
      // The providers within the lag of `a` and not below it: a group whose lowest slot is `a`.
      const group = moved.filter((b) => b.slot >= a.slot && b.slot - a.slot <= lag);
      if (group.length >= 2 && (best === null || a.slot < best.slot)) best = { slot: a.slot, providers: group.map((g) => g.provider).sort() };
    }
    if (best === null) {
      if (!disagreeing) o.log.event('warn', 'recorder.anchor_disagreement', { providers: moved.map((m) => m.provider).join(','), slots: moved.map((m) => m.slot.toString()).join(',') });
      disagreeing = true;
      return false;
    }
    if (disagreeing) o.log.event('info', 'recorder.anchor_agreed', { providers: best.providers.join(',') });
    disagreeing = false;
    agreed = { slot: best.slot, atMs: at, providers: best.providers };
    return true;
  };

  return {
    ready: () => agreed !== null,
    refresh,
    anchor: () => agreed,
    highestSeenSlot: () => o.clock.highestSeenSlot(),
    slotDurationMsEstimate: () => o.clock.slotDurationMsEstimate(),
    expectedSlot(nowMs: number): Slot {
      if (agreed === null) throw new RangeError('recorder: no agreed slot-clock anchor yet (M04 must not start before one)');
      const a: SlotTimeAnchor = { slot: agreed.slot, atMs: agreed.atMs };
      const t = Number.isFinite(nowMs) ? nowMs : o.nowMs();
      return timeToSlot(Math.max(t, agreed.atMs), liveSlotTimeBasis(a, slotMs()));
    },
    highestSeenBy(): string | null {
      const at = o.providers.filter((p) => o.clock.providerSlotLag(p) === 0);
      return at.length === 1 ? (at[0] as string) : null;
    },
  };
}
