import type { Clock } from './clock.ts';
import { checkMoment, compareMoments, type Moment } from './moment.ts';

export interface AsOfEntry {
  readonly moment: Moment;
  readonly value: unknown;
  /** Id of the event that carried the value. Logged as a decision input. */
  readonly source: string;
}

export type AsOfFailure = 'future' | 'missing';

export type Lookup = ({ readonly ok: true } & AsOfEntry) | { readonly ok: false; readonly reason: AsOfFailure };

/**
 * How long each key's past is kept, in ms before now (by receipt time): `null` keeps everything. A key always keeps
 * its latest value at or before the horizon, so a lookup at or after the horizon answers exactly as without the limit;
 * only `history` ranges that start before the horizon come back shorter. A long run (the backtest over weeks, the live
 * worker) bounds its memory with it; reads of older values must not be made for keys it limits.
 *
 * WORKER-GROW: a rule `{ horizonMs, dropStale: true }` also lets `prune` drop the key whole once its newest value is
 * at or before the horizon (a per-object key, such as one mint's facts, that nobody reads after its horizon).
 */
export type RetentionRule = number | null | { readonly horizonMs: number; readonly dropStale: true };
export type Retention = (key: string) => RetentionRule;

const horizonOf = (r: RetentionRule): number | null => (r === null || typeof r === 'number' ? r : r.horizonMs);

/**
 * Point-in-time state. Every answer is "as of" a moment at or before the clock's now: a lookup for a
 * later moment is refused, and a value cannot be recorded with a moment later than now.
 */
export class AsOfStore {
  readonly #clock: Clock;
  readonly #series = new Map<string, AsOfEntry[]>();
  readonly #retention: Retention | null;
  readonly #keep = new Map<string, RetentionRule>();

  constructor(clock: Clock, retention: Retention | null = null) {
    this.#clock = clock;
    this.#retention = retention;
  }

  #ruleOf(key: string): RetentionRule {
    let r = this.#keep.get(key);
    if (r === undefined) {
      r = this.#retention === null ? null : this.#retention(key);
      this.#keep.set(key, r);
    }
    return r;
  }

  /** How many leading values of `series` are older than the cutoff, keeping the latest one at or before it. */
  static #dropCount(series: readonly AsOfEntry[], cutoff: number): number {
    let drop = 0;
    while (drop + 1 < series.length && series[drop + 1]!.moment.receivedAt <= cutoff) drop++;
    return drop;
  }

  /** Drops the values of `key` older than its horizon, keeping the latest one at or before it. Batched. */
  #trim(key: string, series: AsOfEntry[], nowMs: number): void {
    if (this.#retention === null) return;
    const keep = horizonOf(this.#ruleOf(key));
    if (keep === null) return;
    const drop = AsOfStore.#dropCount(series, nowMs - keep);
    // Small trims wait: splicing on every record would make a busy key quadratic.
    if (drop >= 32 || (drop > 0 && drop * 2 >= series.length)) series.splice(0, drop);
  }

  /** Appends a value. Refused if it is dated after now or before the key's latest value. */
  record(key: string, value: unknown, moment: Moment, source: string): void {
    checkMoment(moment);
    if (compareMoments(moment, this.#clock.now()) > 0) throw new RangeError(`cannot record ${key} from the future`);
    const series = this.#series.get(key);
    const last = series?.[series.length - 1];
    if (last !== undefined && compareMoments(moment, last.moment) < 0) throw new RangeError(`${key} must be recorded in time order`);
    const entry: AsOfEntry = Object.freeze({ moment, value, source });
    if (series === undefined) this.#series.set(key, [entry]);
    else {
      series.push(entry);
      this.#trim(key, series, this.#clock.now().receivedAt);
    }
  }

  /** The latest value of `key` at or before `asOf` (default: now). */
  lookup(key: string, asOf: Moment = this.#clock.now()): Lookup {
    if (compareMoments(asOf, this.#clock.now()) > 0) return { ok: false, reason: 'future' };
    const series = this.#series.get(key);
    if (series === undefined) return { ok: false, reason: 'missing' };
    const i = this.#lastAtOrBefore(series, asOf);
    const entry = series[i];
    return entry === undefined ? { ok: false, reason: 'missing' } : { ok: true, ...entry };
  }

  /** Every value of `key` with `from` <= moment <= `to` (default: now), oldest first. A `to` after now is refused. */
  history(key: string, from: Moment, to: Moment = this.#clock.now()): readonly AsOfEntry[] | { readonly ok: false; readonly reason: 'future' } {
    if (compareMoments(to, this.#clock.now()) > 0) return { ok: false, reason: 'future' };
    const series = this.#series.get(key) ?? [];
    const end = this.#lastAtOrBefore(series, to) + 1;
    let start = end;
    while (start > 0 && compareMoments(series[start - 1]!.moment, from) >= 0) start--;
    return series.slice(start, end);
  }

  /**
   * WORKER-GROW: the retention applied to every key as of `nowMs`, including keys not written again (the on-record trim
   * only touches the key it writes). Per key, the values older than its horizon go, keeping the latest one at or before
   * it, exactly as the trim does; a `dropStale` key whose newest value is at or before the horizon goes whole. A lookup
   * or a history from at or after the horizon answers as before. Returns what was dropped.
   */
  prune(nowMs: number): { readonly entries: number; readonly keys: number } {
    let entries = 0;
    let keys = 0;
    if (this.#retention === null) return { entries, keys };
    for (const [key, series] of this.#series) {
      const r = this.#ruleOf(key);
      const keep = horizonOf(r);
      if (keep === null) continue;
      const cutoff = nowMs - keep;
      if (r !== null && typeof r === 'object' && series[series.length - 1]!.moment.receivedAt <= cutoff) {
        this.#series.delete(key);
        this.#keep.delete(key);
        entries += series.length;
        keys++;
        continue;
      }
      const drop = AsOfStore.#dropCount(series, cutoff);
      if (drop > 0) {
        series.splice(0, drop);
        entries += drop;
      }
    }
    return { entries, keys };
  }

  /** How many keys and entries the store holds (for the retention measure). */
  get size(): { readonly keys: number; readonly entries: number } {
    let entries = 0;
    for (const s of this.#series.values()) entries += s.length;
    return { keys: this.#series.size, entries };
  }

  /** Index of the last entry with moment <= `at`, or -1. */
  #lastAtOrBefore(series: readonly AsOfEntry[], at: Moment): number {
    let lo = 0;
    let hi = series.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (compareMoments(series[mid]!.moment, at) <= 0) lo = mid + 1;
      else hi = mid;
    }
    return lo - 1;
  }
}
