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
 * OOM-SWAPS, F1: for a key whose past is read only for entries that can fail a check (a trade key's tails), the class
 * of an older entry; `null` keeps every entry of the key. When a value is recorded, every older entry is classed:
 * - `true`: kept;
 * - `false` (nothing to keep it for): only the one received last stays, and only while it was received later than the
 *   new entry (a reader by receipt time still finds the latest receipt);
 * - a class name (an entry that matters): the earliest of its class, the latest of its class in order, and the one of
 *   its class received last stay; the others are dropped.
 * So a key holds its newest entry and at most a few per class, however long it runs. Its readers must answer the same
 * from that subset (proved per reader). Before F1 a class kept every entry: when non-zero trade tails became common on
 * mainnet (2026-10-06), every swap stayed, and the store grew about 3 KB a swap until the worker died.
 */
export type Collapse = (key: string) => ((older: AsOfEntry) => boolean | string) | null;

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
/** MEM-PROBE: the most keys whose kind `sizes()` reads one by one; a larger store is sampled evenly. */
export const PROBE_KIND_SAMPLE = 50_000;
/** Knuth's multiplicative hash constant (2^32 / golden ratio): spreads the sampled positions. */
const KIND_SPREAD = 2654435761;
/** The range of an unsigned 32-bit hash. */
const KIND_RANGE = 4294967296;
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

/** STORE-GROWTH: the most values `roughBytes` visits in one value, so a probe never walks a huge value whole. */
const ROUGH_NODES = 256;
/**
 * STORE-GROWTH (MEM-PROBE): a rough size of a value in bytes, for comparing key kinds, not an exact heap size: a string
 * its length plus a header, a number 8, a bigint 16, an object or array 16, and each field 16 more. Stops after
 * ROUGH_NODES values and scales what it saw to the values it skipped.
 */
export const roughBytes = (v: unknown): number => {
  let bytes = 0;
  let nodes = 0;
  let skipped = 0;
  // Each value carries the 16-byte field that holds it, so what was seen is a fair sample of what was skipped.
  const stack: unknown[] = [v];
  let root = true;
  while (stack.length > 0) {
    if (nodes >= ROUGH_NODES) {
      skipped = stack.length;
      break;
    }
    const x = stack.pop();
    nodes += 1;
    bytes += root ? 0 : 16;
    root = false;
    if (typeof x === 'string') bytes += 16 + x.length;
    else if (typeof x === 'bigint') bytes += 16;
    else if (typeof x === 'object' && x !== null) {
      bytes += 16;
      for (const y of Array.isArray(x) ? x : Object.values(x as Record<string, unknown>)) stack.push(y);
    } else bytes += 8;
  }
  return nodes === 0 ? 0 : Math.round(bytes * (1 + skipped / nodes));
};

/**
 * F1 (`Collapse`): of the entries before the newest, keeps per class the earliest, the latest in order and the one
 * received last (the latest of them on a tie); of the `false` class only the one received last, while it was received
 * later than the newest. In place, order kept.
 */
const collapseOlder = (series: AsOfEntry[], keepOlder: (older: AsOfEntry) => boolean | string): void => {
  const n = series.length - 1;
  if (n < 1) return;
  const newest = series[n]!;
  const classes = new Map<string | false, number[]>();
  for (let i = 0; i < n; i++) {
    const c = keepOlder(series[i]!);
    if (c === true) continue;
    const at = classes.get(c);
    if (at === undefined) classes.set(c, [i]);
    else at.push(i);
  }
  const drop = new Set<number>();
  for (const [c, at] of classes) {
    let received = at[0]!;
    for (const i of at) if (series[i]!.moment.receivedAt >= series[received]!.moment.receivedAt) received = i;
    const keep = c === false
      ? (series[received]!.moment.receivedAt > newest.moment.receivedAt ? [received] : [])
      : [at[0]!, at[at.length - 1]!, received];
    for (const i of at) if (!keep.includes(i)) drop.add(i);
  }
  if (drop.size === 0) return;
  let w = 0;
  for (let i = 0; i < series.length; i++) if (!drop.has(i)) series[w++] = series[i]!;
  series.length = w;
};

export class AsOfStore {
  readonly #clock: Clock;
  readonly #series = new Map<string, AsOfEntry[]>();
  readonly #retention: Retention | null;
  readonly #collapse: Collapse | null;
  readonly #keepOlder = new Map<string, ((older: AsOfEntry) => boolean | string) | null>();
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
  #olderTest(key: string): ((older: AsOfEntry) => boolean | string) | null {
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
      series.push(entry);
      if (keepOlder !== null) collapseOlder(series, keepOlder);
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
  sizes(): { readonly keys: number; readonly entries: number; readonly tails: number; readonly byPrefix: ReadonlyMap<string, number>; readonly entriesByPrefix: ReadonlyMap<string, number>; readonly bytesByPrefix: ReadonlyMap<string, number> } {
    let entries = 0;
    const byPrefix = new Map<string, number>();
    // STORE-GROWTH: entries per kind too, so a kind of one key whose series grows (a running fact) is seen.
    const entriesByPrefix = new Map<string, number>();
    // And a rough size per kind: the newest value's `roughBytes` times the series' length, for the sampled keys.
    const bytesByPrefix = new Map<string, number>();
    const every = Math.max(1, Math.ceil(this.#series.size / PROBE_KIND_SAMPLE));
    let i = 0;
    for (const [key, series] of this.#series) {
      entries += series.length;
      // Which keys: a multiplicative hash of the position, so a store whose kinds repeat in a period never aliases.
      if (every > 1 && Math.imul(i++, KIND_SPREAD) >>> 0 >= KIND_RANGE / every) continue;
      const a = key.indexOf(':');
      const b = a < 0 ? -1 : key.indexOf(':', a + 1);
      const prefix = a < 0 ? key : b < 0 ? key.slice(0, a) : key.slice(0, b);
      const had = byPrefix.get(prefix);
      // A new kind is kept as a fresh copy, never a slice that would pin its whole key (facts review).
      const newest = series[series.length - 1];
      const size = newest === undefined ? 0 : roughBytes(newest.value) * series.length * every;
      if (had === undefined) {
        const kind = flat(prefix);
        byPrefix.set(kind, every);
        entriesByPrefix.set(kind, series.length * every);
        bytesByPrefix.set(kind, size);
      } else {
        byPrefix.set(prefix, had + every);
        entriesByPrefix.set(prefix, (entriesByPrefix.get(prefix) ?? 0) + series.length * every);
        bytesByPrefix.set(prefix, (bytesByPrefix.get(prefix) ?? 0) + size);
      }
    }
    return { keys: this.#series.size, entries, tails: this.#byTail.size, byPrefix, entriesByPrefix, bytesByPrefix };
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
