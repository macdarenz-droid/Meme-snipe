// BEHIND: the golden-rule bound on a worker that cannot keep up. A message's receipt time is stamped when JavaScript
// parses it, so the time it waited in the socket while a long step held the loop never shows in its age; the loop's
// own cycle (step start to step start, less the planned interval, on a monotonic clock) is that wait, and bounds how
// stale any input is.
// Past BEHIND_MS new entries fail closed (the `behind` halt, through the same path as SEEDING); exits and held
// positions are never held back. It clears once every cycle stays under CLEAR_MS for CLEAR_FOR_MS.
import { SECOND_MS } from '../../../core/src/config/time.ts';

export const BEHIND = 'behind: the worker is not keeping up with its feeds';
export const BEHIND_MS = 10 * SECOND_MS;
export const CLEAR_MS = 2 * SECOND_MS;
export const CLEAR_FOR_MS = 30 * SECOND_MS;

export class BehindGuard {
  #behind = false;
  #lastStart: number | null = null;
  #calmSince: number | null = null;

  get behind(): boolean {
    return this.#behind;
  }

  /**
   * One loop cycle starting at `nowMs`, planned `loopMs` after the last one started. Returns the change it made (with
   * how late this cycle was), or null.
   */
  cycle(nowMs: number, loopMs: number): { readonly behind: boolean; readonly lateMs: number } | null {
    const lateMs = this.#lastStart === null ? 0 : Math.max(0, nowMs - this.#lastStart - loopMs);
    this.#lastStart = nowMs;
    if (!this.#behind) {
      if (lateMs <= BEHIND_MS) return null;
      this.#behind = true;
      this.#calmSince = null;
      return { behind: true, lateMs };
    }
    if (lateMs >= CLEAR_MS) {
      this.#calmSince = null;
      return null;
    }
    this.#calmSince ??= nowMs;
    if (nowMs - this.#calmSince < CLEAR_FOR_MS) return null;
    this.#behind = false;
    this.#calmSince = null;
    return { behind: false, lateMs };
  }
}
