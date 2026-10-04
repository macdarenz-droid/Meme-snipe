import type { Clock } from './clock.ts';
import { checkMoment, compareMoments, type Moment } from './moment.ts';

export interface AsOfEntry {
  readonly moment: Moment;
  readonly value: unknown;
  /** Id of the event that carried the value. Logged as a decision input. */
  readonly source: string;
}

export type AsOfFailure = 'future' | 'missing';

/** How long a key's entries are kept (see `AsOfStore.prune`). */
export type RetentionRule = 'all' | { readonly horizonMs: number; readonly dropStale: boolean };

export type Lookup = ({ readonly ok: true } & AsOfEntry) | { readonly ok: false; readonly reason: AsOfFailure };

/**
 * Point-in-time state. Every answer is "as of" a moment at or before the clock's now: a lookup for a
 * later moment is refused, and a value cannot be recorded with a moment later than now.
 */
export class AsOfStore {
  readonly #clock: Clock;
  readonly #series = new Map<string, AsOfEntry[]>();

  constructor(clock: Clock) {
    this.#clock = clock;
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
    else series.push(entry);
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
   * Retention (WORKER-GROW): drops what no read inside a key's horizon can see. `rule(key)` is 'all' (every entry kept:
   * coverage, whose readers replay the stream from the start) or a horizon. For a horizon, the entries received before
   * `atMs - horizonMs` go, except the newest of them, so a lookup answers as before and a history that starts at or after
   * the cut holds the same entries; with `dropStale`, a key whose newest entry is older than the cut goes whole (a
   * per-object key nobody reads after its horizon). Returns what was dropped.
   */
  prune(atMs: number, rule: (key: string) => RetentionRule): { readonly entries: number; readonly keys: number } {
    let entries = 0;
    let keys = 0;
    for (const [key, series] of this.#series) {
      const r = rule(key);
      if (r === 'all') continue;
      const cutMs = atMs - r.horizonMs;
      // The last entry received before the cut; every entry after it was received at or after the cut.
      let last = -1;
      for (let i = series.length - 1; i >= 0; i--) {
        if (series[i]!.moment.receivedAt < cutMs) {
          last = i;
          break;
        }
      }
      if (last === -1) continue;
      if (last === series.length - 1 && r.dropStale) {
        this.#series.delete(key);
        entries += series.length;
        keys++;
        continue;
      }
      if (last > 0) {
        series.splice(0, last);
        entries += last;
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
