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
import { TagSet, keyTag } from './tag-set.ts';
import { SigRanks, chainSlot, dedupKey, echoKey, eventsOfFrame, rankIn, type Frame, type FrameBody, type Source } from './canonical.ts';

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
  /** Called with every event handed to the engine, in release order. The recorder keeps each `Release`. */
  readonly onRelease?: (event: FeedEvent, release: Release) => void;
}

/**
 * One event handed to the engine. The recorder stores these with the frames: the parity replay of recorded live
 * data (`replayRecorded`) feeds exactly this sequence, late events included, instead of re-sorting the frames.
 */
export interface Release {
  /** Position in the release sequence, from 0. */
  readonly index: number;
  /** The frame the event came from. */
  readonly frameSeq: number;
  readonly eventId: string;
  /** Its slot was already released when the frame arrived; the engine refuses it if it is not after the last event. */
  readonly late: boolean;
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
  /**
   * Placed off-chain after everything ingested so far, whatever its own slot (S0-ZERO): a fill's transactions and the
   * live notifications held back during it go on the feed in the order they are ingested, oldest trade first, and
   * after every off-chain fact ingested before them (FILL-ORDER: off-chain frames keep arrival order, canonical.ts).
   */
  readonly after?: boolean;
  /**
   * BEHIND: an off-chain body placed first in this slot, which must still be held (above the release point): a shed
   * range's coverage gap, so it is released before any event of the range, in live and in the recording's replay alike.
   */
  readonly firstIn?: bigint;
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

/** The engine's live clock: the moment of the last event released, never moving back. */
export class ReleaseClock implements Clock {
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

/**
 * The backtest Feed for recorded live data: the frames' events in the recorded release order, late ones included,
 * on a clock that moves exactly as the live one did. This, not a re-sort, is the parity replay (docs/DECISIONS.md,
 * ENG-1). `frameEvents` with `createReplay` stays for data with no release record.
 */
export const replayRecorded = (frames: readonly Frame[], releases: readonly Release[], start: Moment = GENESIS): { readonly clock: Clock; readonly feed: Feed } => {
  const byId = new Map<string, { event: FeedEvent; frameSeq: number }>();
  const kept = frames.filter((f) => !f.duplicate).sort((a, b) => a.seq - b.seq);
  const ranks = new Map<bigint, Map<string, number>>();
  for (const f of kept) {
    let r = ranks.get(f.place.slot);
    if (r === undefined) ranks.set(f.place.slot, (r = new Map()));
    rankIn(r, f);
  }
  for (const f of kept) for (const e of eventsOfFrame(f, ranks.get(f.place.slot)!)) byId.set(e.id, { event: deepFreeze(e), frameSeq: f.seq });
  const sequence = [...releases].sort((a, b) => a.index - b.index).map((r, k) => {
    if (r.index !== k) throw new RangeError(`release ${k} is missing`);
    const hit = byId.get(r.eventId);
    if (hit === undefined || hit.frameSeq !== r.frameSeq) throw new RangeError(`release ${k}: event ${r.eventId} is not in frame ${r.frameSeq}`);
    return hit.event;
  });
  const clock = new ReleaseClock(start);
  let head = 0;
  return {
    clock,
    feed: {
      next: () => {
        const e = sequence[head];
        if (e === undefined) return null;
        head++;
        clock.cover(e.moment);
        return e;
      },
    },
  };
};

export class LiveFeed implements Feed {
  readonly #opts: LiveFeedOptions;
  readonly #clock: ReleaseClock;
  #seq = 0;
  #lastReceivedAt = Number.NEGATIVE_INFINITY;
  #tip: bigint | null = null;
  #tipAt = 0;
  #firstHeldAt: number | null = null;
  #released: bigint;
  readonly #held = new Map<bigint, Frame[]>();
  readonly #ranks = new Map<bigint, SigRanks>();
  /** FEED-KEYS: the dedupe keys as 96-bit tags (`TagSet`), and each placement slot's tags as pairs, for the prune. */
  readonly #keys = new TagSet();
  readonly #keysBySlot = new Map<bigint, number[]>();
  readonly #gaps = new Map<string, { readonly fromSlot: bigint; readonly since: number }>();
  #ready: { readonly event: FeedEvent; readonly frameSeq: number; readonly late: boolean }[] = [];
  #releases = 0;
  #head = 0;
  #stale = false;
  #duplicates = 0;
  #late = 0;

  constructor(opts: LiveFeedOptions = DEFAULT_LIVE_FEED) {
    this.#opts = checkOptions(opts);
    const start = opts.start ?? GENESIS;
    this.#clock = new ReleaseClock(start);
    this.#released = start.slot - 1n;
  }

  /** The engine's clock: the moment of the last event released, never moving back. */
  get clock(): Clock {
    return this.#clock;
  }

  get tip(): bigint | null {
    return this.#tip;
  }

  /** The latest receipt time stamped so far (receipt times never decrease); -Infinity before the first frame. */
  get lastReceivedAt(): number {
    return this.#lastReceivedAt;
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
    // FILL-ORDER: every off-chain frame in arrival order (canonical.ts `arrival`).
    if (cs === null && o.firstIn !== undefined) {
      if (o.firstIn <= this.#released) throw new RangeError(`slot ${o.firstIn} is already released`);
      place = { at: 'chain', slot: o.firstIn, first: true };
    } else if (cs === null || cs <= cutoff || o.after === true || (o.lookup === true && cs <= this.#released)) place = { at: 'offchain', slot: this.openSlot, arrival: true };
    else place = { at: 'chain', slot: cs };
    const text = dedupKey(body);
    const key = text === null ? null : keyTag(text);
    let duplicate = key !== null && this.#keys.has(key);
    // DEDUP-PER-WATCH: a log's copy on its own watch. Taken already on another watch only: an echo, which releases that
    // watch's hole and pool-other mark (canonical.ts `echoEvents`); taken on this watch too: a duplicate.
    const own = body.type === 'logs' ? keyTag(echoKey(body)) : null;
    const echo = duplicate && own !== null && !this.#keys.has(own);
    if (echo) {
      duplicate = false;
      // Its slot already released: placed after everything, so its hole is never refused as out of order (fail closed).
      if (place.at === 'chain' && place.slot <= this.#released) place = { at: 'offchain', slot: this.openSlot, arrival: true };
    }
    // Frozen one level down: the body may hold transaction bytes, and a typed array with elements cannot be frozen.
    const frame: Frame = Object.freeze({ seq: this.#seq++, receivedAt, source, backfilled, place: Object.freeze(place), duplicate, ...(echo ? { echo: true as const } : {}), body: Object.freeze(body) });
    this.#opts.onFrame?.(frame);
    if (duplicate) {
      this.#duplicates++;
      return frame;
    }
    for (const k of [echo ? null : key, own]) {
      if (k === null) continue;
      this.#keys.add(k);
      const list = this.#keysBySlot.get(place.slot);
      if (list === undefined) this.#keysBySlot.set(place.slot, [k[0], k[1]]);
      else list.push(k[0], k[1]);
    }
    if (cs !== null && !backfilled && (this.#tip === null || cs > this.#tip)) {
      this.#tip = cs;
      this.#tipAt = receivedAt;
      this.#stale = false;
    }
    if (place.slot <= this.#released) {
      // Late: its slot is gone. Released now, in arrival order, for the engine to refuse or accept by the total order.
      this.#late++;
      for (const r of this.#eventsOf([frame], place.slot)) this.#ready.push({ ...r, late: true });
      return frame;
    }
    const held = this.#held.get(place.slot);
    if (held === undefined) this.#held.set(place.slot, [frame]);
    else held.push(frame);
    this.#firstHeldAt ??= receivedAt;
    return frame;
  }

  /** BEHIND: frames held now (not yet released), the backlog the shed cap bounds. */
  get heldFrames(): number {
    let n = 0;
    for (const f of this.#held.values()) n += f.length;
    return n;
  }

  /**
   * BEHIND: drops every held (not yet released) frame of a stream `shed` names, by its `via`, and returns each shed
   * stream's slot range. Frames without a stream (transactions, slots, facts) always stay. The worker opens a coverage
   * gap over each range, so a candidate on a shed stream fails closed; it never sheds a held position's stream.
   */
  shed(shed: (via: string) => boolean): Map<string, { fromSlot: bigint; toSlot: bigint }> {
    const out = new Map<string, { fromSlot: bigint; toSlot: bigint }>();
    for (const [slot, frames] of this.#held) {
      const named = (f: Frame) => 'via' in f.body && typeof f.body.via === 'string' && shed(f.body.via);
      if (!frames.some(named)) continue;
      // Ranked first, in arrival order, as the recording's replay ranks every recorded frame of the slot: a shed frame
      // keeps its rank, so a frame released from this slot later takes the same transaction index live and in replay.
      let ranks = this.#ranks.get(slot);
      if (ranks === undefined) this.#ranks.set(slot, (ranks = new SigRanks()));
      for (const f of [...frames].sort((a, b) => a.seq - b.seq)) rankIn(ranks, f);
      const kept = frames.filter((f) => {
        const via = 'via' in f.body && typeof f.body.via === 'string' ? f.body.via : null;
        if (via === null || !shed(via)) return true;
        const r = out.get(via);
        if (r === undefined) out.set(via, { fromSlot: slot, toSlot: slot });
        else {
          if (slot < r.fromSlot) r.fromSlot = slot;
          if (slot > r.toSlot) r.toSlot = slot;
        }
        return false;
      });
      if (kept.length === 0) this.#held.delete(slot);
      else if (kept.length < frames.length) this.#held.set(slot, kept);
    }
    if (this.#held.size === 0) this.#firstHeldAt = null;
    return out;
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
    const out: { event: FeedEvent; frameSeq: number }[] = [];
    for (const s of slots) {
      out.push(...this.#eventsOf(this.#held.get(s)!, s));
      this.#held.delete(s);
    }
    out.sort((a, b) => compareEvents(a.event, b.event));
    for (const r of out) this.#ready.push({ ...r, late: false });
    this.#released = target;
    if (this.#held.size === 0) this.#firstHeldAt = null;
    this.#prune();
    return out.length;
  }

  /**
   * Marks the next slot released with nothing in it, for events the worker puts ahead of every live one (SEED-1's seed
   * and coverage history): they sort after everything released and before every live event still to come. Only while
   * nothing is held or waiting, so no live event can sort below them; null otherwise.
   */
  reserveSlot(): bigint | null {
    if (this.#held.size > 0 || this.#head < this.#ready.length) return null;
    this.#released += 1n;
    return this.#released;
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
    this.#opts.onRelease?.(r.event, Object.freeze({ index: this.#releases++, frameSeq: r.frameSeq, eventId: r.event.id, late: r.late }));
    return r.event;
  }

  /** MEM-PROBE: counts only: held frames, slot ranks, dedupe keys and their slot lists, gaps, events ready. */
  sizes(): Record<string, number> {
    let held = 0;
    for (const f of this.#held.values()) held += f.length;
    let ranks = 0;
    for (const m of this.#ranks.values()) ranks += m.size;
    return { held, held_slots: this.#held.size, ranks, rank_slots: this.#ranks.size, keys: this.#keys.size, key_slots: this.#keysBySlot.size, gaps: this.#gaps.size, ready: this.#ready.length - this.#head };
  }

  status(): LiveFeedStatus {
    let held = 0;
    for (const f of this.#held.values()) held += f.length;
    return {
      tip: this.#tip, releasedThrough: this.#released, held, ready: this.#ready.length - this.#head, stale: this.#stale,
      gaps: [...this.#gaps.keys()], duplicates: this.#duplicates, late: this.#late,
    };
  }

  #eventsOf(frames: readonly Frame[], slot: bigint): { event: FeedEvent; frameSeq: number }[] {
    let ranks = this.#ranks.get(slot);
    if (ranks === undefined) this.#ranks.set(slot, (ranks = new SigRanks()));
    const sorted = [...frames].sort((a, b) => a.seq - b.seq);
    for (const f of sorted) rankIn(ranks, f);
    return sorted.flatMap((f) => eventsOfFrame(f, ranks).map((e) => ({ event: deepFreeze(e), frameSeq: f.seq })));
  }

  /** Forgets duplicates and ranks of slots no chain fact can be placed in any more. */
  #prune(): void {
    const cutoff = this.#released - BigInt(this.#opts.keepSlots);
    for (const [slot, keys] of this.#keysBySlot) {
      if (slot > cutoff) continue;
      for (let i = 0; i < keys.length; i += 2) this.#keys.delete([keys[i]!, keys[i + 1]!]);
      this.#keysBySlot.delete(slot);
    }
    for (const slot of this.#ranks.keys()) if (slot <= cutoff) this.#ranks.delete(slot);
  }
}
