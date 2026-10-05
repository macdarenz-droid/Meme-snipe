// SEEN-TAGS: a candle book's remembered trades as 96-bit tags (two 48-bit numbers) in per-minute buckets, 16 B a trade
// in a sorted Float64Array once its minute is behind, against about 96 B for a repeat-id string and its Map entry
// (measured in the 3× run: 90 MB of books at 409 pools). A minute's bucket is sorted when a later minute's trade
// arrives; a late trade for an older minute reopens that bucket until the next one.
import { createHash } from 'node:crypto';
import { MINUTE_MS } from '../config/time.ts';

/**
 * OOM-SEEN/SEEN-TAGS: a swap's repeat tag, the same from a log line and from a fetched transaction: the first 96 bits of
 * a SHA-256 of its whole signature and its pre-trade reserves (two swaps in one transaction leave different reserves).
 * Two different trades share a tag with odds of about 2^-96 per pair.
 */
export const tradeRepeatTag = (signature: string, baseBefore: bigint, quoteBefore: bigint): readonly [number, number] => {
  const b = createHash('sha256').update(`${signature}:${baseBefore}:${quoteBefore}`, 'utf8').digest();
  return [b.readUIntBE(0, 6), b.readUIntBE(6, 6)];
};

interface Bucket {
  /** Tags as pairs (hi, lo), sorted by hi then lo when `sorted`. */
  tags: Float64Array | number[];
  sorted: boolean;
}

const sortPairs = (a: readonly number[] | Float64Array): Float64Array => {
  const idx = Array.from({ length: a.length / 2 }, (_, i) => i);
  idx.sort((x, y) => a[2 * x]! - a[2 * y]! || a[2 * x + 1]! - a[2 * y + 1]!);
  const out = new Float64Array(a.length);
  idx.forEach((k, i) => { out[2 * i] = a[2 * k]!; out[2 * i + 1] = a[2 * k + 1]!; });
  return out;
};

const hasPair = (b: Bucket, hi: number, lo: number): boolean => {
  const t = b.tags;
  if (!b.sorted) {
    for (let i = 0; i < t.length; i += 2) if (t[i] === hi && t[i + 1] === lo) return true;
    return false;
  }
  let l = 0;
  let h = t.length / 2 - 1;
  while (l <= h) {
    const m = (l + h) >>> 1;
    const d = t[2 * m]! - hi || t[2 * m + 1]! - lo;
    if (d === 0) return true;
    if (d < 0) l = m + 1;
    else h = m - 1;
  }
  return false;
};

/** Remembered trade tags by the minute they were stamped in. */
export class RepeatTags {
  readonly #buckets = new Map<number, Bucket>();
  #size = 0;

  get size(): number {
    return this.#size;
  }

  has(tag: readonly [number, number]): boolean {
    for (const b of this.#buckets.values()) if (hasPair(b, tag[0], tag[1])) return true;
    return false;
  }

  /** Remembers a trade stamped in `minute`; buckets of minutes before it are sorted for lookups. */
  add(tag: readonly [number, number], minute: number): void {
    let b = this.#buckets.get(minute);
    if (b === undefined) {
      b = { tags: [], sorted: false };
      this.#buckets.set(minute, b);
    } else if (b.sorted) {
      b.tags = Array.from(b.tags);
      b.sorted = false;
    }
    (b.tags as number[]).push(tag[0], tag[1]);
    this.#size++;
    for (const [m, o] of this.#buckets) if (m < minute && !o.sorted) {
      o.tags = sortPairs(o.tags);
      o.sorted = true;
    }
  }

  /** Forgets every trade stamped in a minute that ended at or before `cutoffMs`. */
  sweep(cutoffMs: number): void {
    for (const [m, b] of this.#buckets) if ((m + 1) * MINUTE_MS <= cutoffMs) {
      this.#size -= b.tags.length / 2;
      this.#buckets.delete(m);
    }
  }
}
