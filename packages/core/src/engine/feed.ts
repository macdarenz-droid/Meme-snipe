import type { BookEvent } from '../lifecycle/index.ts';
import { SimClock, type Clock } from './clock.ts';
import { deepFreeze } from './freeze.ts';
import { checkMoment, compareEvents, compareMoments, type Moment } from './moment.ts';

/** A market fact: the value of `key` (pool state, a trade, a fee config, a cluster label) as observed at `moment`. */
export interface MarketEvent {
  readonly kind: 'market';
  readonly id: string;
  readonly moment: Moment;
  readonly key: string;
  readonly value: unknown;
}

/** A report from the outside world that drives the lifecycle: a send result, a status read, a balance reconcile, a tick. */
export interface WorldEvent {
  readonly kind: 'world';
  readonly id: string;
  readonly moment: Moment;
  readonly event: BookEvent;
}

export type FeedEvent = MarketEvent | WorldEvent;

/**
 * The only source of data for the engine. Returns the next released event, or null when none is due yet.
 * Events must come in the total order of `compareEvents`; the engine refuses one that is not after the
 * previous event (`out_of_order`) or is dated after now (`future_event`). A live Feed therefore holds facts
 * behind a slot horizon and releases them in order, so a late slot-99 fact is not dropped after a slot-100
 * one. The parity replay feeds the recorded release sequence, refused events included (docs/DECISIONS.md).
 */
export interface Feed {
  next(): FeedEvent | null;
}

/** Validates an event and returns a frozen copy, so neither the engine nor the caller can change it afterwards. */
const checkEvent = (input: FeedEvent): FeedEvent => {
  const e = deepFreeze(structuredClone(input));
  if (typeof e.id !== 'string' || e.id.length === 0) throw new TypeError('event id must be a non-empty string');
  checkMoment(e.moment);
  if (e.kind === 'market' && (typeof e.key !== 'string' || e.key.length === 0)) throw new TypeError(`event ${e.id}: key must be a non-empty string`);
  return e;
};

/**
 * A backtest replay. The future lives in a store only the driver holds: the engine receives `clock` and
 * `feed`, and the feed releases an event only once `clock` has reached its moment.
 * The driver calls `advance()` to move the clock to the next pending event.
 * Only the driver and the fill model it runs may hold a `Replay`: `momentOf` and `pending` reveal
 * whether future events exist, so a `Replay` is never handed to the engine or a strategy.
 */
export interface Replay {
  readonly clock: Clock;
  readonly feed: Feed;
  /** Moves the clock to the next pending event if none is due yet. False once every event is released. */
  advance(): boolean;
  /** Adds an event the outside world produces during the run (a send result, a status read). Only strictly after now. */
  schedule(e: FeedEvent): void;
  /** Driver and proof use only: when an event was due. The engine never holds a `Replay`. */
  momentOf(id: string): Moment | undefined;
  /** Events not yet released. */
  pending(): number;
}

/** Before every slot: the clock's start when a replay does not give one. */
export const GENESIS: Moment = { slot: 0n, txIndex: 0, ixIndex: 0, receivedAt: 0 };

export const createReplay = (events: readonly FeedEvent[], start: Moment = GENESIS): Replay => {
  const clock = new SimClock(start);
  const due = new Map<string, Moment>();
  const add = (input: FeedEvent): FeedEvent => {
    const e = checkEvent(input);
    if (due.has(e.id)) throw new RangeError(`duplicate event id ${e.id}`);
    due.set(e.id, e.moment);
    return e;
  };
  const queue = events.map(add).sort(compareEvents);
  for (const e of queue) if (compareMoments(e.moment, start) < 0) throw new RangeError(`event ${e.id} is before the replay start`);
  let head = 0;

  const feed: Feed = {
    next: () => {
      const e = queue[head];
      if (e === undefined || compareMoments(e.moment, clock.now()) > 0) return null;
      head++;
      return e;
    },
  };

  return {
    clock,
    feed,
    advance: () => {
      const e = queue[head];
      if (e === undefined) return false;
      if (compareMoments(e.moment, clock.now()) > 0) clock.advanceTo(e.moment);
      return true;
    },
    schedule: (input) => {
      checkMoment(input.moment);
      if (compareMoments(input.moment, clock.now()) <= 0) throw new RangeError(`event ${input.id} must be scheduled after now`);
      const e = add(input);
      // Released events are never revisited, so insert among the pending ones only.
      let lo = head;
      let hi = queue.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (compareEvents(queue[mid]!, e) < 0) lo = mid + 1;
        else hi = mid;
      }
      queue.splice(lo, 0, e);
    },
    momentOf: (id) => due.get(id),
    pending: () => queue.length - head,
  };
};
