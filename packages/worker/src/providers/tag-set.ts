// FEED-KEYS: the live feed's dedupe keys as 96-bit tags (two 48-bit numbers) in an open-addressing table with linear
// probing, about 32 B a key at the table's half load, against about 90 B for a key string and its Set entry (measured:
// 252 B a swap's two frames and rank in the feed). Removal shifts the following run back, so no tombstones build up.
import { createHash } from 'node:crypto';

const MIN_CAPACITY = 256;

/** A dedupe key's tag: the first 96 bits of its SHA-256. Two different keys share one with odds of about 2^-96. */
export const keyTag = (key: string): readonly [number, number] => {
  const b = createHash('sha256').update(key, 'utf8').digest();
  return [b.readUIntBE(0, 6), b.readUIntBE(6, 6)];
};

export class TagSet {
  #hi = new Float64Array(MIN_CAPACITY).fill(-1);
  #lo = new Float64Array(MIN_CAPACITY);
  #size = 0;

  get size(): number {
    return this.#size;
  }

  has(t: readonly [number, number]): boolean {
    return this.#find(t[0], t[1]) >= 0;
  }

  /** False when it was already there. */
  add(t: readonly [number, number]): boolean {
    if (this.#find(t[0], t[1]) >= 0) return false;
    if (2 * (this.#size + 1) > this.#hi.length) this.#resize(this.#hi.length * 2);
    this.#put(t[0], t[1]);
    this.#size++;
    return true;
  }

  delete(t: readonly [number, number]): boolean {
    let i = this.#find(t[0], t[1]);
    if (i < 0) return false;
    const mask = this.#hi.length - 1;
    // Backward shift: each later entry of the run that may move into the hole does.
    let j = i;
    for (;;) {
      j = (j + 1) & mask;
      if (this.#hi[j] === -1) break;
      const home = this.#home(this.#hi[j]!, this.#lo[j]!);
      // Move j to i when its home is not cyclically in (i, j].
      if (i <= j ? home <= i || home > j : home <= i && home > j) {
        this.#hi[i] = this.#hi[j]!;
        this.#lo[i] = this.#lo[j]!;
        i = j;
      }
    }
    this.#hi[i] = -1;
    this.#size--;
    if (this.#hi.length > MIN_CAPACITY && 8 * this.#size < this.#hi.length) this.#resize(this.#hi.length / 2);
    return true;
  }

  #home(hi: number, lo: number): number {
    return (lo + hi) % this.#hi.length;
  }

  #find(hi: number, lo: number): number {
    const mask = this.#hi.length - 1;
    for (let i = this.#home(hi, lo); ; i = (i + 1) & mask) {
      const h = this.#hi[i]!;
      if (h === -1) return -1;
      if (h === hi && this.#lo[i] === lo) return i;
    }
  }

  #put(hi: number, lo: number): void {
    const mask = this.#hi.length - 1;
    let i = this.#home(hi, lo);
    while (this.#hi[i] !== -1) i = (i + 1) & mask;
    this.#hi[i] = hi;
    this.#lo[i] = lo;
  }

  #resize(capacity: number): void {
    const hi = this.#hi;
    const lo = this.#lo;
    this.#hi = new Float64Array(capacity).fill(-1);
    this.#lo = new Float64Array(capacity);
    for (let i = 0; i < hi.length; i++) if (hi[i] !== -1) this.#put(hi[i]!, lo[i]!);
  }
}
