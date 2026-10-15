// The one slot-to-time function (B-M15-01, clarification C-61; addendum A10; fixes bug B1, docs/MIGRATION.md "Known
// bugs"). Slot length is not constant [LD-08, RS-10]: it fell from about 420 ms (late July 2026) to about 316 ms (early
// September) and was about 267 ms on 2026-10-06, with 200 ms scheduled. So nothing dates a slot with a fixed slot time.
// Every conversion between slots and milliseconds in group A and B code goes through `slotToTimeMs` or its inverse
// `timeToSlot`, on one of two bases:
// - live: the latest primary height reading of the slot clock (its slot and receive time) and the measured slot
//   duration from performance samples (`SlotClock.slotDurationMsEstimate()`, `m15.slot_ms_initial` before the first);
// - history: block-time anchors (`getBlockTime`, whole seconds [A-37]; at most 60 s apart, ruling Z06-7), interpolated linearly
//   between neighbouring anchors and extrapolated outside them at the rate of the nearest pair.
// A named upper bound for a timing guard, where a larger slot time is the stricter choice, is not a slot time and is
// not built here (MIGRATION A10 acceptance; Zeroed `worker/src/run/config.ts:81-84`).
import type { Slot, UnixMs } from '@bot/types';

/** One slot dated by a time: a live height reading (receive time) or a block-time anchor (`getBlockTime` × 1,000). */
export interface SlotTimeAnchor { readonly slot: Slot; readonly atMs: number }
export type SlotTimeBasis =
  | { readonly kind: 'live'; readonly anchor: SlotTimeAnchor; readonly slotMs: number }
  | { readonly kind: 'history'; readonly anchors: readonly SlotTimeAnchor[]; readonly firstRate: number; readonly lastRate: number; readonly maxGapMs: number };

/** Slot durations a basis may hold, in ms (the range of `m15.slot_ms_initial`; a value outside it is not a slot time). */
export const SLOT_MS_MIN = 100;
export const SLOT_MS_MAX = 1_000;
const MAX_SLOT_GAP = 2n ** 52n;

function checkSlotMs(slotMs: number): void {
  if (!Number.isFinite(slotMs) || slotMs < SLOT_MS_MIN || slotMs > SLOT_MS_MAX) {
    throw new RangeError(`E_SLOT_BASIS: slot duration must be in ${SLOT_MS_MIN}..${SLOT_MS_MAX} ms`);
  }
}

function checkAnchor(a: SlotTimeAnchor): void {
  if (typeof a.slot !== 'bigint' || a.slot < 0n) throw new RangeError('E_SLOT_BASIS: anchor slot must be a bigint >= 0');
  if (!Number.isFinite(a.atMs) || a.atMs < 0) throw new RangeError('E_SLOT_BASIS: anchor time must be finite and >= 0');
}

/** A live basis: one anchor and the measured slot duration. */
export function liveSlotTimeBasis(anchor: SlotTimeAnchor, slotMs: number): SlotTimeBasis {
  checkAnchor(anchor);
  checkSlotMs(slotMs);
  return Object.freeze({ kind: 'live', anchor: Object.freeze({ ...anchor }), slotMs });
}

/** Block-time resolution: `getBlockTime` is whole seconds [A-37], so an anchor is up to 1 s early. */
export const BLOCK_TIME_RESOLUTION_MS = 1_000;
/**
 * Ruling Z06-7 (docs/DECISIONS.md, "Z06"): neighbouring history anchors are at most 60 s apart. Slot time drifts within
 * a day, so per-day anchors date mid-day slots tens of seconds off; with anchors at most 60 s apart a slot between them
 * is dated within ±2 s (the floor of a whole-second block time; A10's ±1 s holds only at the anchors).
 */
export const MAX_ANCHOR_GAP_MS = 60_000;

/**
 * A history basis from at least two anchors (any order), neighbours at most `maxAnchorGapMs` apart (default and ceiling
 * MAX_ANCHOR_GAP_MS). Slots must be distinct, times must not fall as slots rise,
 * and the time between neighbours must fit their slot count at SLOT_MS_MIN..SLOT_MS_MAX per slot, give or take the
 * 1 s block-time resolution (anchors that disagree more are not the same chain's clock). Outside the anchors, slots
 * are dated at the rate of the nearest pair whose times differ (`firstRate`, `lastRate`), so at least one pair must.
 * Anything else throws `E_SLOT_BASIS`: history without a sound clock is not dated at all.
 */
export function historySlotTimeBasis(anchors: readonly SlotTimeAnchor[], o: { maxAnchorGapMs?: number } = {}): SlotTimeBasis {
  // A caller may only tighten the gap (a smaller maximum), never widen it.
  const maxGap = o.maxAnchorGapMs ?? MAX_ANCHOR_GAP_MS;
  if (!Number.isFinite(maxGap) || maxGap <= 0 || maxGap > MAX_ANCHOR_GAP_MS) throw new RangeError(`E_SLOT_BASIS: the maximum anchor gap must be in (0, ${MAX_ANCHOR_GAP_MS}] ms`);
  if (anchors.length < 2) throw new RangeError('E_SLOT_BASIS: a history basis needs at least two anchors');
  for (const a of anchors) checkAnchor(a);
  const sorted = [...anchors].sort((x, y) => (x.slot < y.slot ? -1 : x.slot > y.slot ? 1 : 0)).map((a) => Object.freeze({ ...a }));
  const rates: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1] as SlotTimeAnchor, b = sorted[i] as SlotTimeAnchor;
    if (a.slot === b.slot) throw new RangeError('E_SLOT_BASIS: two anchors on one slot');
    if (b.slot - a.slot > MAX_SLOT_GAP) throw new RangeError('E_SLOT_BASIS: anchors too far apart');
    if (b.atMs < a.atMs) throw new RangeError('E_SLOT_BASIS: anchor time falls as slots rise');
    if (b.atMs - a.atMs > maxGap) throw new RangeError(`E_SLOT_BASIS: anchors ${b.atMs - a.atMs} ms apart, more than ${maxGap} ms`);
    const n = slotDelta(a.slot, b.slot), span = b.atMs - a.atMs;
    if (span < n * SLOT_MS_MIN - BLOCK_TIME_RESOLUTION_MS || span > n * SLOT_MS_MAX + BLOCK_TIME_RESOLUTION_MS) {
      throw new RangeError(`E_SLOT_BASIS: anchors imply a slot time outside ${SLOT_MS_MIN}..${SLOT_MS_MAX} ms`);
    }
    if (span > 0) rates.push(span / n);
  }
  if (rates.length === 0) throw new RangeError('E_SLOT_BASIS: every anchor has the same time');
  return Object.freeze({ kind: 'history', anchors: Object.freeze(sorted), firstRate: rates[0] as number, lastRate: rates[rates.length - 1] as number, maxGapMs: maxGap });
}

/** A block-time anchor: `getBlockTime(slot)` is whole Unix seconds [A-37], so it carries up to 1 s of error. */
export function blockTimeAnchor(s: Slot, blockTimeSec: number): SlotTimeAnchor {
  if (!Number.isSafeInteger(blockTimeSec) || blockTimeSec < 0) throw new RangeError('E_SLOT_BASIS: block time must be whole seconds >= 0');
  return { slot: s, atMs: blockTimeSec * 1_000 };
}

/** Index i of the anchor pair (i, i + 1) around `s`, for a slot within the anchors. */
function segment(anchors: readonly SlotTimeAnchor[], s: Slot): number {
  let lo = 0, hi = anchors.length - 1;
  if (s <= (anchors[0] as SlotTimeAnchor).slot) return 0;
  if (s >= (anchors[hi] as SlotTimeAnchor).slot) return hi - 1;
  while (hi - lo > 1) {                                       // invariant: anchors[lo].slot < s < anchors[hi].slot
    const mid = (lo + hi) >> 1;
    if ((anchors[mid] as SlotTimeAnchor).slot <= s) lo = mid; else hi = mid;
  }
  return lo;
}

/** Slots from `a` to `b` as a number: the one bounded conversion of a slot count (|b − a| ≤ 2^52, else E_SLOT_BASIS). */
export function slotDelta(a: Slot, b: Slot): number {
  const d = b - a;
  if (d > MAX_SLOT_GAP || d < -MAX_SLOT_GAP) throw new RangeError('E_SLOT_BASIS: slot too far from the basis');
  return Number(d);
}

/** The time of slot `s` in Unix ms (fractional; round where an integer `UnixMs` is stored). */
export function slotToTimeMs(s: Slot, basis: SlotTimeBasis): number {
  return timeOf(s, basis, true);
}

/** `checked`: refuse a history slot more than `maxGapMs` outside the anchors (Z06-10). `timeToSlot` checks the time instead. */
function timeOf(s: Slot, basis: SlotTimeBasis, checked: boolean): number {
  if (basis.kind === 'live') return basis.anchor.atMs + slotDelta(basis.anchor.slot, s) * basis.slotMs;
  const as = basis.anchors;
  const first = as[0] as SlotTimeAnchor, last = as[as.length - 1] as SlotTimeAnchor;
  // Z06-10: outside the anchors, extrapolate no further than the maximum anchor gap.
  const out = (t: number, edge: SlotTimeAnchor): number => {
    if (checked && Math.abs(t - edge.atMs) > basis.maxGapMs) throw new RangeError(`E_SLOT_BASIS: slot ${s} is more than ${basis.maxGapMs} ms outside the anchors`);
    return t;
  };
  if (s < first.slot) return out(first.atMs + slotDelta(first.slot, s) * basis.firstRate, first);
  if (s > last.slot) return out(last.atMs + slotDelta(last.slot, s) * basis.lastRate, last);
  const i = segment(as, s);
  const a = as[i] as SlotTimeAnchor, b = as[i + 1] as SlotTimeAnchor;
  return a.atMs + (slotDelta(a.slot, s) * (b.atMs - a.atMs)) / slotDelta(a.slot, b.slot);
}

/** `slotToTimeMs` rounded to whole ms, for a stored `UnixMs`. */
export function slotToUnixMs(s: Slot, basis: SlotTimeBasis): UnixMs {
  return Math.round(slotToTimeMs(s, basis)) as UnixMs;
}

/** Milliseconds from slot `from` to slot `to` (negative when `to` is earlier). */
export function slotSpanMs(from: Slot, to: Slot, basis: SlotTimeBasis): number {
  return slotToTimeMs(to, basis) - slotToTimeMs(from, basis);
}

/**
 * The first slot whose time is at or after `ms` (for example the slot an action lands in after a latency). Every slot
 * returned satisfies `slotToTimeMs(slot) >= ms` and `slotToTimeMs(slot - 1) < ms`, except at slot 0. In a history
 * segment whose two anchors share one second, every slot in it has that time.
 */
export function timeToSlot(ms: number, basis: SlotTimeBasis): Slot {
  if (!Number.isFinite(ms)) throw new RangeError('E_SLOT_BASIS: time must be finite');
  let guess: Slot;
  if (basis.kind === 'live') {
    guess = basis.anchor.slot + BigInt(Math.ceil((ms - basis.anchor.atMs) / basis.slotMs));
  } else {
    const as = basis.anchors;
    const first = as[0] as SlotTimeAnchor, last = as[as.length - 1] as SlotTimeAnchor;
    if (ms < first.atMs - basis.maxGapMs || ms > last.atMs + basis.maxGapMs) {
      throw new RangeError(`E_SLOT_BASIS: time ${ms} is more than ${basis.maxGapMs} ms outside the anchors`);
    }
    if (ms < first.atMs) guess = first.slot + BigInt(Math.ceil((ms - first.atMs) / basis.firstRate));
    else if (ms > last.atMs) guess = last.slot + BigInt(Math.ceil((ms - last.atMs) / basis.lastRate));
    else {
      // The first pair whose later anchor is at or after `ms` (times are non-decreasing); binary search.
      let lo = 0, hi = as.length - 1;                          // as[lo].atMs <= ms <= as[hi].atMs
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if ((as[mid] as SlotTimeAnchor).atMs < ms) lo = mid; else hi = mid;
      }
      const a = as[lo] as SlotTimeAnchor, b = as[hi] as SlotTimeAnchor;
      const span = b.atMs - a.atMs;
      guess = span === 0 ? a.slot : a.slot + BigInt(Math.ceil(((ms - a.atMs) * slotDelta(a.slot, b.slot)) / span));
    }
  }
  if (guess < 0n) guess = 0n;
  // Floating-point rounding can leave the guess one slot off either way: settle it on the forward function itself.
  while (guess > 0n && timeOf((guess - 1n) as Slot, basis, false) >= ms) guess--;
  while (timeOf(guess as Slot, basis, false) < ms) guess++;
  return guess as Slot;
}
