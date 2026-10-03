// The live Feed and Clock the engine runs on (docs/ARCHITECTURE.md §16.1, docs/DECISIONS.md "Engine").
// Providers hand raw inputs to `ingest`; the feed stamps arrival order, drops duplicates (first copy wins),
// holds facts behind a slot horizon and releases them in the engine's total order. A fact that arrives after its
// slot was released is still released, marked late, and the engine refuses it as `out_of_order`; the recorder
// keeps the release sequence so the parity replay feeds exactly what live fed.
//
// Everything that reads wall time happens in `ingest` and `advance`, which the worker calls. `next` and the
// clock only pop and compare, so they run inside the engine's runtime trap.
import type { Clock, Feed, FeedEvent, Moment } from '../../../core/src/engine/index.ts';
import { compareEvents, compareMoments, GENESIS } from '../../../core/src/engine/index.ts';
import { deepFreeze } from '../../../core/src/engine/freeze.ts';
import { chainSlot, dedupKey, eventsOfFrame, rankIn, type Frame, type FrameBody, type Source } from './canonical.ts';

export interface LiveFeedOptions {
  /** A slot is released once the tip is this many slots past it (late notifications get that long to arrive). */
  readonly horizonSlots: number;
  /** With no tip progress for this long, everything held up to the tip is released (a stale feed never blocks). */
  readonly staleReleaseMs: number;
  /** How long one reconnect gap may hold the horizon while its backfill runs. */
  readonly maxGapHoldMs: number;
  /** Duplicates and ranks are kept this many slots behind the release point; older chain facts enter as off-chain facts. */
  readonly keepSlots: number;
  readonly start?: Moment;
  /** Called with every frame, duplicates included: the recorder's input. */
  readonly onFrame?: (frame: Frame) => void;
  /** Called with every event handed to the engine, in release order. */
  readonly onRelease?: (event: FeedEvent, info: { readonly late: boolean }) => void;
}

export const DEFAULT_LIVE_FEED: Omit<LiveFeedOptions, 'onFrame' | 'onRelease' | 'start'> = {
  horizonSlots: 2,
  staleReleaseMs: 2_000,
  maxGapHoldMs: 3_000,
  keepSlots: 1_500,
};

export interface IngestOptions {
  readonly receivedAt: number;
  readonly backfilled?: boolean;
  /** An answer to our own request (e.g. `getTransaction`): placed off-chain when its own slot is already released. */
  readonly lookup?: boolean;
}

export interface LiveFeedStatus {
  readonly tip: bigint | null;
  readonly releasedThrough: bigint;
  readonly held: number;
  readonly ready: number;
  readonly stale: boolean;
  readonly gaps: readonly string[];
  readonly duplicates: number;
  readonly late: number;
}

const checkOptions = (o: LiveFeedOptions): LiveFeedOptions => {
  for (const k of ['horizonSlots', 'staleReleaseMs', 'maxGapHoldMs', 'keepSlots'] as const) {
    if (!Number.isSafeInteger(o[k]) || o[k] < 0) throw new RangeError(`${k} must be an integer >= 0`);
  }
  return o;
};

class LiveClock implements Clock {
  #now: Moment;
  constructor(start: Moment) {
    this.#now = start;
  }
  now(): Moment {
    return this.#now;
  }
  /** Moves to `m` if it is later. A late event leaves the clock where it is. */
  cover(m: Moment): void {
    if (compareMoments(m, this.#now) > 0) this.#now = m;
  }
}

export class LiveFeed implements Feed {
  readonly #opts: LiveFeedOptions;
  readonly #clock: LiveClock;
  #seq = 0;
  #lastReceivedAt = Number.NEGATIVE_INFINITY;
  #tip: bigint | null = null;
  #tipAt = 0;
  #firstHeldAt: number | null = null;
  #released: bigint;
  readonly #held = new Map<bigint, Frame[]>();
  readonly #ranks = new Map<bigint, Map<string, number>>();
  readonly #keys = new Set<string>();
  readonly #keysBySlot = new Map<bigint, string[]>();
  readonly #gaps = new Map<string, { readonly fromSlot: bigint; readonly since: number }>();
  #ready: { readonly event: FeedEvent; readonly late: boolean }[] = [];
  #head = 0;
  #stale = false;
  #duplicates = 0;
  #late = 0;

  constructor(opts: LiveFeedOptions = DEFAULT_LIVE_FEED) {
    this.#opts = checkOptions(opts);
    const start = opts.start ?? GENESIS;
    this.#clock = new LiveClock(start);
    this.#released = start.slot - 1n;
  }

  /** The engine's clock: the moment of the last event released, never moving back. */
  get clock(): Clock {
    return this.#clock;
  }

  get tip(): bigint | null {
    return this.#tip;
  }

  get releasedThrough(): bigint {
    return this.#released;
  }

  /** The slot a fact with no slot of its own is placed in: never one already released. */
  get openSlot(): bigint {
    const next = this.#released + 1n;
    return this.#tip !== null && this.#tip > next ? this.#tip : next;
  }

  /** Takes one raw input. Returns the frame as recorded (check `duplicate`). */
  ingest(source: Source, body: FrameBody, o: IngestOptions): Frame {
    if (!Number.isSafeInteger(o.receivedAt)) throw new RangeError('receivedAt must be an integer');
    // Receipt times never decrease with arrival order, even if the wall clock steps back.
    const receivedAt = Math.max(o.receivedAt, this.#lastReceivedAt);
    this.#lastReceivedAt = receivedAt;
    const backfilled = o.backfilled ?? false;
    const cs = chainSlot(body);
    const cutoff = this.#released - BigInt(this.#opts.keepSlots);
    let place: Frame['place'];
    if (cs === null || cs <= cutoff || (o.lookup === true && cs <= this.#released)) place = { at: 'offchain', slot: this.openSlot };
    else place = { at: 'chain', slot: cs };
    const key = dedupKey(body);
    const duplicate = key !== null && this.#keys.has(key);
    // Frozen one level down: the body may hold transaction bytes, and a typed array with elements cannot be frozen.
    const frame: Frame = Object.freeze({ seq: this.#seq++, receivedAt, source, backfilled, place: Object.freeze(place), duplicate, body: Object.freeze(body) });
    this.#opts.onFrame?.(frame);
    if (duplicate) {
      this.#duplicates++;
      return frame;
    }
    if (key !== null) {
      this.#keys.add(key);
      const list = this.#keysBySlot.get(place.slot);
      if (list === undefined) this.#keysBySlot.set(place.slot, [key]);
      else list.push(key);
    }
    if (cs !== null && !backfilled && (this.#tip === null || cs > this.#tip)) {
      this.#tip = cs;
      this.#tipAt = receivedAt;
      this.#stale = false;
    }
    if (place.slot <= this.#released) {
      // Late: its slot is gone. Released now, in arrival order, for the engine to refuse or accept by the total order.
      this.#late++;
      for (const event of this.#eventsOf([frame], place.slot)) this.#ready.push({ event, late: true });
      return frame;
    }
    const held = this.#held.get(place.slot);
    if (held === undefined) this.#held.set(place.slot, [frame]);
    else held.push(frame);
    this.#firstHeldAt ??= receivedAt;
    return frame;
  }

  /** A provider lost its stream from `fromSlot`: hold the release point below it until its backfill ends or the hold times out. */
  openGap(id: string, fromSlot: bigint, nowMs: number): void {
    if (!this.#gaps.has(id)) this.#gaps.set(id, { fromSlot, since: nowMs });
  }

  closeGap(id: string): void {
    this.#gaps.delete(id);
  }

  /** Moves the release point as far as the tip, the gaps and the stale rule allow. Returns the events made ready. */
  advance(nowMs: number): number {
    let target = this.#tip === null ? this.#released : this.#tip - BigInt(this.#opts.horizonSlots);
    const stale = this.#tip === null ? this.#firstHeldAt !== null && nowMs - this.#firstHeldAt >= this.#opts.staleReleaseMs : nowMs - this.#tipAt >= this.#opts.staleReleaseMs;
    if (stale) {
      // Nothing new from the chain: release what we hold, up to the newest slot any fact sits in.
      for (const s of this.#held.keys()) if (s > target) target = s;
      if (this.#tip !== null && this.#tip > target) target = this.#tip;
    }
    this.#stale = stale;
    for (const [id, g] of this.#gaps) {
      if (nowMs - g.since >= this.#opts.maxGapHoldMs) this.#gaps.delete(id);
      else if (g.fromSlot - 1n < target) target = g.fromSlot - 1n;
    }
    if (target <= this.#released) return 0;
    const slots = [...this.#held.keys()].filter((s) => s <= target).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const out: FeedEvent[] = [];
    for (const s of slots) {
      out.push(...this.#eventsOf(this.#held.get(s)!, s));
      this.#held.delete(s);
    }
    out.sort(compareEvents);
    for (const event of out) this.#ready.push({ event, late: false });
    this.#released = target;
    if (this.#held.size === 0) this.#firstHeldAt = null;
    this.#prune();
    return out.length;
  }

  /** Feed: the next released event, or null. Moves the clock to it. */
  next(): FeedEvent | null {
    const r = this.#ready[this.#head];
    if (r === undefined) return null;
    this.#head++;
    if (this.#head > 1024 && this.#head * 2 > this.#ready.length) {
      this.#ready = this.#ready.slice(this.#head);
      this.#head = 0;
    }
    this.#clock.cover(r.event.moment);
    this.#opts.onRelease?.(r.event, { late: r.late });
    return r.event;
  }

  status(): LiveFeedStatus {
    let held = 0;
    for (const f of this.#held.values()) held += f.length;
    return {
      tip: this.#tip, releasedThrough: this.#released, held, ready: this.#ready.length - this.#head, stale: this.#stale,
      gaps: [...this.#gaps.keys()], duplicates: this.#duplicates, late: this.#late,
    };
  }

  #eventsOf(frames: readonly Frame[], slot: bigint): FeedEvent[] {
    let ranks = this.#ranks.get(slot);
    if (ranks === undefined) this.#ranks.set(slot, (ranks = new Map()));
    const sorted = [...frames].sort((a, b) => a.seq - b.seq);
    for (const f of sorted) rankIn(ranks, f);
    return sorted.flatMap((f) => eventsOfFrame(f, ranks).map((e) => deepFreeze(e)));
  }

  /** Forgets duplicates and ranks of slots no chain fact can be placed in any more. */
  #prune(): void {
    const cutoff = this.#released - BigInt(this.#opts.keepSlots);
    for (const [slot, keys] of this.#keysBySlot) {
      if (slot > cutoff) continue;
      for (const k of keys) this.#keys.delete(k);
      this.#keysBySlot.delete(slot);
    }
    for (const slot of this.#ranks.keys()) if (slot <= cutoff) this.#ranks.delete(slot);
  }
}
