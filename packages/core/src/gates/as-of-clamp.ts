import type { Moment } from '../engine/moment.ts';

/**
 * SAVE-ASOF: a save holds nothing dated after its moment, and restore refuses anything that is. Moments order by slot
 * first, so an event at or before the moment can carry a receipt time after it, and a chain block time (a create's, a
 * migration's) is routinely seconds off local receipt. Such a time is saved as at the moment, never after; slot,
 * transaction and instruction are kept. Each clamp is counted with the largest, so a real future-dated bug stays
 * visible (the worker logs a save whose largest clamp is over its `CLAMP_LOG_MS`).
 */
export class AsOfClamp {
  #count = 0;
  #maxMs = 0;

  readonly asOfMs: number;

  constructor(asOfMs: number) {
    this.asOfMs = asOfMs;
  }

  /** How many times were clamped, and the largest amount (ms). */
  get count(): number {
    return this.#count;
  }

  get maxMs(): number {
    return this.#maxMs;
  }

  ms(t: number): number {
    if (t <= this.asOfMs) return t;
    this.#count += 1;
    if (t - this.asOfMs > this.#maxMs) this.#maxMs = t - this.asOfMs;
    return this.asOfMs;
  }

  moment(m: Moment): Moment {
    return m.receivedAt <= this.asOfMs ? m : { ...m, receivedAt: this.ms(m.receivedAt) };
  }
}
