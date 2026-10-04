// The one engine live and backtest share (docs/ARCHITECTURE.md §16.1). It reads time only from the
// injected Clock, data only from the injected Feed, randomness only from its seed, and acts on the
// world only through the EffectRunner. Same seed and same events give the same log, byte for byte.

import { createHash, type Hash } from 'node:crypto';
import { applyBookEvent, emptyBook, isIllegal, type Book, type BookConfig, type BookEvent, type Effect } from '../lifecycle/index.ts';
import { AsOfStore, type AsOfEntry, type Lookup, type RetentionRule } from './asof.ts';
import type { Clock } from './clock.ts';
import type { Feed, FeedEvent, MarketEvent } from './feed.ts';
import { deepFreeze } from './freeze.ts';
import { canonical } from './log.ts';
import { compareEvents, compareMoments, type Moment } from './moment.ts';
import { createRng, type Rng } from './random.ts';
import { DEFAULT_RECONCILE_LIMITS, ReconcileGuard, type Dispatch, type EffectRunner, type ReconcileLimits } from './runner.ts';

/** What a strategy may see while it decides. Every read is as of now. */
export interface StrategyContext {
  readonly now: Moment;
  readonly book: Book;
  readonly rng: Rng;
  lookup(key: string, asOf?: Moment): Lookup;
  history(key: string, from: Moment, to?: Moment): readonly AsOfEntry[] | { readonly ok: false; readonly reason: 'future' };
}

/** One decision with its reasons. A null action is an abstention, logged like any other decision. */
export interface Decision {
  readonly action: BookEvent | null;
  readonly reasons: readonly string[];
}

export interface Strategy {
  onMarket(event: MarketEvent, ctx: StrategyContext): readonly Decision[];
}

export interface DispatchedEffect {
  readonly effect: Effect;
  readonly dispatch: Dispatch;
}

export type LogRecord =
  | { readonly type: 'start'; readonly seq: number; readonly seed: string; readonly limits: ReconcileLimits; readonly book: BookConfig }
  | {
    readonly type: 'decision'; readonly seq: number; readonly at: Moment; readonly eventId: string;
    /** Ids of every event the strategy read for this decision: the trigger and each lookup's source. */
    readonly inputs: readonly string[];
    readonly action: BookEvent | null; readonly reasons: readonly string[];
    readonly result: 'applied' | 'abstained' | 'illegal'; readonly reason?: string;
    readonly effects: readonly DispatchedEffect[];
  }
  | {
    readonly type: 'world'; readonly seq: number; readonly at: Moment; readonly eventId: string; readonly event: BookEvent;
    readonly result: 'applied' | 'illegal'; readonly reason?: string; readonly effects: readonly DispatchedEffect[];
  }
  /** A refused event: dated after now, or not after the previous event in the total order. */
  | { readonly type: 'fault'; readonly seq: number; readonly at: Moment; readonly eventId: string; readonly fault: 'future_event' | 'out_of_order' };

type Body<R> = R extends unknown ? Omit<R, 'seq'> : never;

export interface EngineDeps {
  readonly clock: Clock;
  readonly feed: Feed;
  readonly strategy: Strategy;
  readonly runner: EffectRunner;
  /** Recorded in the log; the only source of randomness. */
  readonly seed: string;
  readonly book: BookConfig;
  readonly reconcileLimits?: ReconcileLimits;
  /** Keep every record in memory (default true). The hash is kept either way. */
  readonly keepLog?: boolean;
  /** Retention of the as-of store (WORKER-GROW); none keeps everything. Live, the parity replay and the backtest pass the same. */
  readonly retention?: Retention;
}

/**
 * What the as-of store keeps over a long run. At each `everyMs` boundary of the event clock (the received time of the
 * events, never the wall clock, so a replay of the same events prunes at the same points), each key is pruned to its
 * rule's horizon before that boundary (`AsOfStore.prune`). A rule's horizon must cover every look-back a reader of
 * that key takes (see `engineRetention`).
 */
export interface Retention {
  readonly everyMs: number;
  readonly rule: (key: string) => RetentionRule;
}

export class Engine {
  readonly #clock: Clock;
  readonly #feed: Feed;
  readonly #strategy: Strategy;
  readonly #runner: EffectRunner;
  readonly #store: AsOfStore;
  readonly #rng: Rng;
  readonly #guard: ReconcileGuard;
  readonly #hash: Hash = createHash('sha256');
  readonly #records: LogRecord[] | null;
  #book: Book;
  #seq = 0;
  #last: FeedEvent | null = null;
  readonly #retention: Retention | null;
  /** The next event-clock boundary at which the store is pruned. */
  #pruneAt = Number.NEGATIVE_INFINITY;

  constructor(deps: EngineDeps) {
    this.#clock = deps.clock;
    this.#feed = deps.feed;
    this.#strategy = deps.strategy;
    this.#runner = deps.runner;
    this.#store = new AsOfStore(deps.clock);
    this.#rng = createRng(deps.seed);
    const limits = deps.reconcileLimits ?? DEFAULT_RECONCILE_LIMITS;
    this.#guard = new ReconcileGuard(limits);
    this.#book = deepFreeze(emptyBook(deps.book));
    this.#records = deps.keepLog === false ? null : [];
    const r = deps.retention ?? null;
    if (r !== null && !(Number.isSafeInteger(r.everyMs) && r.everyMs > 0)) throw new RangeError('retention needs a positive everyMs');
    this.#retention = r;
    this.#log({ type: 'start', seed: deps.seed, limits, book: deps.book });
  }

  get book(): Book {
    return this.#book;
  }

  /** Every record so far (empty when `keepLog` is false). */
  get records(): readonly LogRecord[] {
    return this.#records ?? [];
  }

  /** SHA-256 of the canonical log lines so far. */
  logHash(): string {
    return this.#hash.copy().digest('hex');
  }

  /** Processes every event the feed has released. Returns how many it took. */
  drain(): number {
    let n = 0;
    for (let e = this.#feed.next(); e !== null; e = this.#feed.next()) {
      this.#handle(e);
      n++;
    }
    return n;
  }

  #log(body: Body<LogRecord>): void {
    const record = deepFreeze({ ...body, seq: this.#seq++ } as LogRecord);
    this.#hash.update(`${canonical(record)}\n`, 'utf8');
    this.#records?.push(record);
  }

  #handle(e: FeedEvent): void {
    const now = this.#clock.now();
    if (compareMoments(e.moment, now) > 0) {
      this.#log({ type: 'fault', at: now, eventId: e.id, fault: 'future_event' });
      return;
    }
    if (this.#last !== null && compareEvents(e, this.#last) <= 0) {
      this.#log({ type: 'fault', at: now, eventId: e.id, fault: 'out_of_order' });
      return;
    }
    this.#last = e;
    if (e.kind === 'world') {
      const r = this.#apply(e.event, now);
      this.#log({ type: 'world', at: now, eventId: e.id, event: e.event, ...r });
      return;
    }
    this.#prune(e.moment.receivedAt);
    this.#store.record(e.key, e.value, e.moment, e.id);
    const inputs = new Set<string>([e.id]);
    const store = this.#store;
    const ctx = Object.freeze<StrategyContext>({
      now,
      book: this.#book,
      rng: this.#rng,
      lookup: (key, asOf) => {
        const r = store.lookup(key, asOf);
        if (r.ok) inputs.add(r.source);
        return r;
      },
      history: (key, from, to) => {
        const r = store.history(key, from, to);
        if (Array.isArray(r)) for (const entry of r as readonly AsOfEntry[]) inputs.add(entry.source);
        return r;
      },
    });
    const decisions = this.#strategy.onMarket(e, ctx);
    const read = [...inputs].sort();
    // Frozen before use: a strategy cannot change a decision after making it, nor reach engine state through it.
    for (const d of deepFreeze(decisions)) {
      const base = { type: 'decision' as const, at: now, eventId: e.id, inputs: read, action: d.action, reasons: [...d.reasons] };
      if (d.action === null) this.#log({ ...base, result: 'abstained', effects: [] });
      else this.#log({ ...base, ...this.#apply(d.action, now) });
    }
  }

  /** At the first market event at or past a boundary: prune to the horizon before that boundary (deterministic in the events). */
  #prune(atMs: number): void {
    const r = this.#retention;
    if (r === null || atMs < this.#pruneAt) return;
    const boundary = Math.floor(atMs / r.everyMs) * r.everyMs;
    this.#pruneAt = boundary + r.everyMs;
    this.#store.prune(boundary, (key) => {
      const rule = r.rule(key);
      if (rule !== 'all' && !(Number.isSafeInteger(rule.horizonMs) && rule.horizonMs >= r.everyMs)) throw new RangeError(`retention of ${key}: the horizon must be a whole number of ms, at least everyMs`);
      return rule;
    });
  }

  /** The as-of store's size (keys and entries), for the retention measure and the worker's health. */
  get storeSize(): { readonly keys: number; readonly entries: number } {
    return this.#store.size;
  }

  #apply(event: BookEvent, now: Moment): { result: 'applied' | 'illegal'; reason?: string; effects: DispatchedEffect[] } {
    const r = applyBookEvent(this.#book, deepFreeze(event));
    if (isIllegal(r)) return { result: 'illegal', reason: `${r.reason} (from ${r.from})`, effects: [] };
    // The book is shared with the strategy and the log; frozen, nobody can change it outside the lifecycle.
    this.#book = deepFreeze(r.state);
    const effects: DispatchedEffect[] = [];
    for (const effect of deepFreeze(r.effects)) {
      const dispatch = this.#guard.admit(effect, now);
      if (dispatch === 'sent') {
        const out: unknown = this.#runner.run(effect, now);
        // Results come back only as feed events. A returned value (an async runner's promise above all) would be lost.
        if (out !== undefined) throw new TypeError('EffectRunner.run must be synchronous and return nothing; schedule results as feed events');
      }
      effects.push({ effect, dispatch });
    }
    return { result: 'applied', effects };
  }
}

/** Drives a replay to the end: move the clock to the next event, let the engine take what is due, repeat. */
export const runToEnd = (replay: { advance(): boolean }, engine: Engine): void => {
  while (replay.advance()) engine.drain();
};
