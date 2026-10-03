// A rate bucket that holds `limit` grants per sliding `windowMs`. Provider limits are windows (Jupiter documents a
// 60 s sliding window; Helius counts requests per second), and a classic refill-rate bucket either bursts past such
// a window or wastes part of it. This one never lets more than `limit` grants fall inside any window.

export interface WindowSpec {
  readonly limit: number;
  readonly windowMs: number;
}

export const checkWindow = (w: WindowSpec, what: string): WindowSpec => {
  if (!Number.isSafeInteger(w.limit) || w.limit < 1) throw new RangeError(`${what}: limit must be an integer >= 1`);
  if (!Number.isSafeInteger(w.windowMs) || w.windowMs < 1) throw new RangeError(`${what}: windowMs must be an integer >= 1`);
  return w;
};

export class SlidingWindow {
  readonly spec: WindowSpec;
  /** Grant times, oldest first. */
  readonly #grants: number[] = [];

  constructor(spec: WindowSpec, what = 'window') {
    this.spec = checkWindow(spec, what);
  }

  #expire(now: number): void {
    let k = 0;
    while (k < this.#grants.length && this.#grants[k]! <= now - this.spec.windowMs) k++;
    if (k > 0) this.#grants.splice(0, k);
  }

  /** Grants still free in the window ending at `now`. */
  free(now: number): number {
    this.#expire(now);
    return Math.max(0, this.spec.limit - this.#grants.length);
  }

  /** Records `n` grants at `now`. The caller checks `free` first; this never refuses (server-reported use can overfill). */
  take(now: number, n = 1): void {
    this.#expire(now);
    for (let k = 0; k < n; k++) this.#grants.push(now);
  }

  /** When at least `need` grants will be free again (now if they already are). */
  freeAt(now: number, need = 1): number {
    this.#expire(now);
    const over = this.#grants.length - (this.spec.limit - need);
    if (over <= 0) return now;
    const g = this.#grants[over - 1];
    return g === undefined ? Number.POSITIVE_INFINITY : g + this.spec.windowMs;
  }
}
