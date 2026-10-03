// A streaming backtest replay (docs/ARCHITECTURE.md §16.1). The future stays in three places only the driver holds:
// the dataset stream, the scheduled world reports and the fill hooks. The engine gets `clock` and `feed`; the feed
// releases an event only once the clock has reached it. Unlike core's createReplay it never holds the whole dataset
// in memory, and it builds each market event when it is released, so pool states include our earlier trades.
import { type Clock, compareEvents, compareMoments, type Feed, type FeedEvent, GENESIS, type Moment, SimClock } from '../../../core/src/engine/index.ts';

/** Driver work at a moment: our transaction reaching a block. Never seen by the engine. */
export interface Hook {
  readonly id: string;
  readonly moment: Moment;
  run(): void;
}

export interface Pending<T> {
  readonly moment: Moment;
  readonly item: T;
}

/** A min-heap ordered by (moment, id). */
class Heap<T extends { readonly moment: Moment; readonly id: string }> {
  readonly #a: T[] = [];
  get size(): number {
    return this.#a.length;
  }
  peek(): T | undefined {
    return this.#a[0];
  }
  push(x: T): void {
    const a = this.#a;
    a.push(x);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (compareEvents(a[p]!, a[i]!) <= 0) break;
      [a[p], a[i]] = [a[i]!, a[p]!];
      i = p;
    }
  }
  pop(): T | undefined {
    const a = this.#a;
    const top = a[0];
    const last = a.pop();
    if (a.length > 0 && last !== undefined) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && compareEvents(a[l]!, a[m]!) < 0) m = l;
        if (r < a.length && compareEvents(a[r]!, a[m]!) < 0) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i]!, a[m]!];
        i = m;
      }
    }
    return top;
  }
}

const freeze = <T>(v: T): T => {
  if (typeof v === 'object' && v !== null && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const x of Object.values(v)) freeze(x);
  }
  return v;
};

export interface StreamSource<R> {
  /** Next row and its moment, in non-decreasing order; null at the end. */
  next(): Pending<R> | null;
}

export class StreamReplay<R> {
  readonly #clock: SimClock;
  readonly #source: StreamSource<R>;
  readonly #release: (row: R) => FeedEvent[];
  readonly #finalize: (e: FeedEvent) => FeedEvent;
  #head: Pending<R> | null;
  #lastSource: Moment | null = null;
  readonly #buffer: FeedEvent[] = [];
  readonly #world = new Heap<FeedEvent>();
  readonly #hooks = new Heap<Hook>();
  readonly #ids = new Set<string>();
  readonly feed: Feed;
  released = 0;

  /**
   * `release` turns a due row into its events (all at the row's moment). `finalize` completes a scheduled event when
   * it is released (default: unchanged).
   */
  constructor(source: StreamSource<R>, release: (row: R) => FeedEvent[], finalize: (e: FeedEvent) => FeedEvent = (e) => e, start: Moment = GENESIS) {
    this.#clock = new SimClock(start);
    this.#source = source;
    this.#release = release;
    this.#finalize = finalize;
    this.#head = source.next();
    this.feed = { next: () => this.#next() };
  }

  get clock(): Clock {
    return this.#clock;
  }

  #pull(): void {
    const h = this.#head;
    if (h === null) return;
    if (this.#lastSource !== null && compareMoments(h.moment, this.#lastSource) < 0) throw new RangeError('dataset rows are out of order');
    this.#lastSource = h.moment;
    this.#head = this.#source.next();
    const events = this.#release(h.item);
    for (const e of events) {
      if (compareMoments(e.moment, h.moment) !== 0) throw new RangeError(`event ${e.id} is not at its row's moment`);
    }
    this.#buffer.push(...events.sort(compareEvents));
  }

  #next(): FeedEvent | null {
    const now = this.#clock.now();
    for (;;) {
      const b = this.#buffer[0];
      const w = this.#world.peek();
      // Released rows wait in the buffer; a world report earlier in the order goes first.
      if (b !== undefined && (w === undefined || compareEvents(b, w) < 0)) {
        this.#buffer.shift();
        return this.#emit(b);
      }
      const h = this.#head;
      if (h !== null && compareMoments(h.moment, now) <= 0 && (w === undefined || compareMoments(h.moment, w.moment) <= 0)) {
        this.#pull();
        continue;
      }
      if (w !== undefined && compareMoments(w.moment, now) <= 0) {
        this.#world.pop();
        return this.#emit(this.#finalize(w));
      }
      return null;
    }
  }

  #emit(e: FeedEvent): FeedEvent {
    // Scheduled ids are checked for duplicates when scheduled; rows are unique by moment.
    this.released++;
    return freeze(e);
  }

  /** Adds an event the outside world produces (a send result, a status read, a discovery). Strictly after now. */
  schedule(e: FeedEvent): void {
    if (compareMoments(e.moment, this.#clock.now()) <= 0) throw new RangeError(`event ${e.id} must be scheduled after now`);
    if (this.#ids.has(e.id)) throw new RangeError(`duplicate event id ${e.id}`);
    this.#ids.add(e.id);
    this.#world.push(e);
  }

  /** Adds driver work at a later moment. */
  hook(h: Hook): void {
    if (compareMoments(h.moment, this.#clock.now()) <= 0) throw new RangeError(`hook ${h.id} must be after now`);
    this.#hooks.push(h);
  }

  /** The earliest pending moment and what it is; null when everything is done. */
  #earliest(): { readonly moment: Moment; readonly hook: boolean } | null {
    const b = this.#buffer[0];
    if (b !== undefined) return { moment: b.moment, hook: false };
    const cands: { moment: Moment; hook: boolean }[] = [];
    if (this.#head !== null) cands.push({ moment: this.#head.moment, hook: false });
    const w = this.#world.peek();
    if (w !== undefined) cands.push({ moment: w.moment, hook: false });
    const k = this.#hooks.peek();
    if (k !== undefined) cands.push({ moment: k.moment, hook: true });
    if (cands.length === 0) return null;
    return cands.reduce((a, c) => (compareMoments(c.moment, a.moment) < 0 ? c : a));
  }

  /**
   * Moves the clock to the next pending moment. Runs a hook that is due and returns 'hook'; returns 'events' when
   * the engine has events to drain; 'done' at the end.
   */
  advance(): 'events' | 'hook' | 'done' {
    const e = this.#earliest();
    if (e === null) return 'done';
    if (compareMoments(e.moment, this.#clock.now()) > 0) this.#clock.advanceTo(e.moment);
    if (e.hook) {
      this.#hooks.pop()!.run();
      return 'hook';
    }
    return 'events';
  }

  /** True when rows, reports or hooks remain. */
  pending(): boolean {
    return this.#earliest() !== null;
  }

  /** Ends the dataset early (a run window's end): rows after it are never released. */
  hasRows(): boolean {
    return this.#head !== null || this.#buffer.length > 0;
  }
}
