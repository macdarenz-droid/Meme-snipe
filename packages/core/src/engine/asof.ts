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
 * CREATE-COMPACT: for a key whose stored value is read only for some of its fields, the function that keeps those
 * fields (`null` stores the value as released). The strategy still receives the released event whole; only lookups and
 * history answer with the compact value, so its readers must read nothing else (proved per reader).
 */
export type Shape = (key: string) => ((value: unknown) => unknown) | null;

/**
 * G4a: for a key nothing looks up once it is old, how long after its newest value the whole key is forgotten
 * (`forgetOlder`); `null` keeps it. Its readers must never ask for it past that age (proved per reader).
 */
export type Forget = (key: string) => number | null;

/**
 * Point-in-time state. Every answer is "as of" a moment at or before the clock's now: a lookup for a
 * later moment is refused, and a value cannot be recorded with a moment later than now.
 */
/** A flat copy of a string (UTF-16 unit by unit): never holds the pieces or the larger string it was built or cut from. */
const CHAR_CHUNK = 8192;
export const flatCopy = (s: string): string => {
  const units: number[] = [];
  for (let i = 0; i < s.length; i++) units.push(s.charCodeAt(i));
  let out = '';
  for (let i = 0; i < units.length; i += CHAR_CHUNK) out += String.fromCharCode(...units.slice(i, i + CHAR_CHUNK));
  return out;
};
const flat = flatCopy;

export class AsOfStore {
  readonly #clock: Clock;
  readonly #series = new Map<string, AsOfEntry[]>();
  readonly #retention: Retention | null;
  readonly #collapse: Collapse | null;
  readonly #keepOlder = new Map<string, ((older: AsOfEntry) => boolean) | null>();
  /**
   * OOM-MINT review: keys by their last `:`-separated part, so a retire costs only the keys it forgets. CREATE-COMPACT:
   * one key as itself, a Set only from the second (most parts end one or two keys; a Set each cost about 150 B).
   */
  readonly #byTail = new Map<string, string | Set<string>>();

  readonly #shape: Shape | null;
  readonly #forget: Forget | null;

  constructor(clock: Clock, retention: Retention | null = null, collapse: Collapse | null = null, shape: Shape | null = null, forget: Forget | null = null) {
    this.#clock = clock;
    this.#retention = retention;
    this.#collapse = collapse;
    this.#shape = shape;
    this.#forget = forget;
  }

  /** G4a: forgets every key whose `Forget` age has passed since its newest value (by receipt time). Returns how many. */
  forgetOlder(nowMs: number): number {
    if (this.#forget === null) return 0;
    let n = 0;
    for (const [key, series] of this.#series) {
      const age = this.#forget(key);
      const last = series[series.length - 1];
      if (age === null || last === undefined || last.moment.receivedAt + age > nowMs) continue;
      this.#series.delete(key);
      this.#keepOlder.delete(key);
      const at = key.lastIndexOf(':');
      if (at !== -1) {
        const tail = key.slice(at + 1);
        const keys = this.#byTail.get(tail);
        if (keys === key) this.#byTail.delete(tail);
        else if (keys !== undefined && typeof keys !== 'string') {
          keys.delete(key);
          if (keys.size === 0) this.#byTail.delete(tail);
        }
      }
      n++;
    }
    return n;
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
      for (const key of typeof keys === 'string' ? [keys] : keys) {
        this.#series.delete(key);
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
    // CREATE-COMPACT: asked at each record, not cached per key (a cache entry cost about 80 B a key; the rule is a prefix test).
    const keep = this.#retention?.(key) ?? null;
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
    // CREATE-COMPACT: the id kept as a flat copy, never the pieces (and the signature) it was built from.
    if (compareMoments(moment, this.#clock.now()) > 0) throw new RangeError(`cannot record ${key} from the future`);
    const series = this.#series.get(key);
    const last = series?.[series.length - 1];
    if (last !== undefined && compareMoments(moment, last.moment) < 0) throw new RangeError(`${key} must be recorded in time order`);
    const compact = this.#shape?.(key) ?? null;
    const entry: AsOfEntry = Object.freeze({ moment, value: compact === null ? value : compact(value), source: flat(source) });
    if (series === undefined) {
      // A new key is kept as a flat copy too.
      const kept = flat(key);
      this.#series.set(kept, [entry]);
      const at = kept.lastIndexOf(':');
      if (at !== -1) {
        const tail = kept.slice(at + 1);
        const keys = this.#byTail.get(tail);
        if (keys === undefined) this.#byTail.set(tail, kept);
        else if (typeof keys === 'string') this.#byTail.set(tail, new Set([keys, kept]));
        else keys.add(kept);
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
