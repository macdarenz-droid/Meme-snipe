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
 */
export type Retention = (key: string) => number | null;

/**
 * OOM-SWAPS: for a key whose past is read only for entries that can fail a check (a trade key's tails), the test an
 * older entry must pass to stay; `null` keeps every entry of the key. When a value is recorded, the key's previous
 * newest entry is dropped if it fails the test and is not received later than the new one, so the key holds its newest
 * entry and the entries that matter. Its readers must answer the same from that subset (proved per reader).
 */
export type Collapse = (key: string) => ((older: AsOfEntry) => boolean) | null;

/**
 * Point-in-time state. Every answer is "as of" a moment at or before the clock's now: a lookup for a
 * later moment is refused, and a value cannot be recorded with a moment later than now.
 */
/** MEM-PROBE: the most keys whose kind `sizes()` reads one by one; a larger store is sampled evenly. */
export const PROBE_KIND_SAMPLE = 50_000;
/** Knuth's multiplicative hash constant (2^32 / golden ratio): spreads the sampled positions. */
const KIND_SPREAD = 2654435761;
/** The range of an unsigned 32-bit hash. */
const KIND_RANGE = 4294967296;

export class AsOfStore {
  readonly #clock: Clock;
  readonly #series = new Map<string, AsOfEntry[]>();
  readonly #retention: Retention | null;
  readonly #keep = new Map<string, number | null>();
  readonly #collapse: Collapse | null;
  readonly #keepOlder = new Map<string, ((older: AsOfEntry) => boolean) | null>();
  /** OOM-MINT review: keys by their last `:`-separated part, so a retire costs only the keys it forgets. */
  readonly #byTail = new Map<string, Set<string>>();

  constructor(clock: Clock, retention: Retention | null = null, collapse: Collapse | null = null) {
    this.#clock = clock;
    this.#retention = retention;
    this.#collapse = collapse;
  }

  /**
   * OOM-MINT: forgets every key whose last `:`-separated part is one of `ids` (a mint or a pool nothing will read again),
   * with its cached rules. Returns how many keys went. A key recorded again later starts afresh.
   */
  retire(ids: ReadonlySet<string>): number {
    let n = 0;
    for (const id of ids) {
      const keys = this.#byTail.get(id);
      if (keys === undefined) continue;
      this.#byTail.delete(id);
      for (const key of keys) {
        this.#series.delete(key);
        this.#keep.delete(key);
        this.#keepOlder.delete(key);
        n++;
      }
    }
    return n;
  }

  /** The key's collapse test, cached (`Collapse`). */
  #olderTest(key: string): ((older: AsOfEntry) => boolean) | null {
    if (this.#collapse === null) return null;
    let t = this.#keepOlder.get(key);
    if (t === undefined) {
      t = this.#collapse(key);
      this.#keepOlder.set(key, t);
    }
    return t;
  }

  /** Drops the values of `key` older than its horizon, keeping the latest one at or before it. Batched. */
  #trim(key: string, series: AsOfEntry[], nowMs: number): void {
    if (this.#retention === null) return;
    let keep = this.#keep.get(key);
    if (keep === undefined) {
      keep = this.#retention(key);
      this.#keep.set(key, keep);
    }
    if (keep === null) return;
    const cutoff = nowMs - keep;
    let drop = 0;
    while (drop + 1 < series.length && series[drop + 1]!.moment.receivedAt <= cutoff) drop++;
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
    if (series === undefined) {
      this.#series.set(key, [entry]);
      const at = key.lastIndexOf(':');
      if (at !== -1) {
        const tail = key.slice(at + 1);
        const keys = this.#byTail.get(tail);
        if (keys === undefined) this.#byTail.set(tail, new Set([key]));
        else keys.add(key);
      }
    }
    else {
      const keepOlder = this.#olderTest(key);
      if (keepOlder !== null && last !== undefined && last.moment.receivedAt <= moment.receivedAt && !keepOlder(last)) series.pop();
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
   * MEM-PROBE: counts only, for the worker's memory probe: keys, entries and the tail index exactly, and keys by their
   * first two `:`-separated parts (the kind of value they hold). Over PROBE_KIND_SAMPLE keys the kinds are counted on
   * about one key in n, spread by a hash of each key's position, and scaled by n (an estimate), so the probe's pause stays a few ms at any store size (all keys: about 60 ms per
   * 300k).
   */
  sizes(): { readonly keys: number; readonly entries: number; readonly tails: number; readonly byPrefix: ReadonlyMap<string, number> } {
    let entries = 0;
    const byPrefix = new Map<string, number>();
    const every = Math.max(1, Math.ceil(this.#series.size / PROBE_KIND_SAMPLE));
    let i = 0;
    for (const [key, series] of this.#series) {
      entries += series.length;
      // Which keys: a multiplicative hash of the position, so a store whose kinds repeat in a period never aliases.
      if (every > 1 && Math.imul(i++, KIND_SPREAD) >>> 0 >= KIND_RANGE / every) continue;
      const a = key.indexOf(':');
      const b = a < 0 ? -1 : key.indexOf(':', a + 1);
      const prefix = a < 0 ? key : b < 0 ? key.slice(0, a) : key.slice(0, b);
      byPrefix.set(prefix, (byPrefix.get(prefix) ?? 0) + every);
    }
    return { keys: this.#series.size, entries, tails: this.#byTail.size, byPrefix };
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
