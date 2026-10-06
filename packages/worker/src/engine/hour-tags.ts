// OOM-MINT: a week of let-go creates held as 8 bytes each. A Map of 22-character mint prefixes measured 95 B an entry
// (68 MB a week at 75 creates a minute); here each mint is a 53-bit SHA-256 tag in an hour's sorted Float64Array.
import { createHash } from 'node:crypto';

const HOUR_MS = 3_600_000;

/** A mint's tag: the first 53 bits of its SHA-256, exact in a double. Two mints share one with odds of 2^-53. */
export const hourTag = (mint: string): number => {
  const b = createHash('sha256').update(mint).digest();
  return (b.readUInt32BE(0) & 0x1f_ffff) * 0x1_0000_0000 + b.readUInt32BE(4);
};

const has = (a: Float64Array, x: number): boolean => {
  let lo = 0;
  let hi = a.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const v = a[mid]!;
    if (v === x) return true;
    if (v < x) lo = mid + 1;
    else hi = mid - 1;
  }
  return false;
};

/** Mints added by hour of `now`; an hour is dropped once `keepMs` has passed since it ended. */
export class HourTags {
  readonly #keepMs: number;
  #hour = Number.NaN;
  #open: number[] = [];
  readonly #sealed: { readonly hour: number; readonly tags: Float64Array }[] = [];

  constructor(keepMs: number) {
    this.#keepMs = keepMs;
  }

  add(mint: string, now: number): void {
    const hour = Math.floor(now / HOUR_MS);
    if (hour !== this.#hour) this.#seal(hour);
    this.#open.push(hourTag(mint));
  }

  has(mint: string): boolean {
    const t = hourTag(mint);
    return this.#open.includes(t) || this.#sealed.some((s) => has(s.tags, t));
  }

  /** Drops every hour that ended `keepMs` or more before `now`. */
  prune(now: number): void {
    const gone = (hour: number): boolean => (hour + 1) * HOUR_MS + this.#keepMs <= now;
    while (this.#sealed.length > 0 && gone(this.#sealed[0]!.hour)) this.#sealed.shift();
    if (this.#open.length > 0 && gone(this.#hour)) this.#open = [];
  }

  get size(): number {
    return this.#open.length + this.#sealed.reduce((n, s) => n + s.tags.length, 0);
  }

  #seal(hour: number): void {
    if (this.#open.length > 0) this.#sealed.push({ hour: this.#hour, tags: Float64Array.from(this.#open).sort() });
    this.#open = [];
    this.#hour = hour;
  }
}
