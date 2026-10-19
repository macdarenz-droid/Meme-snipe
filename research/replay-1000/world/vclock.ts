// REPLAY-1000: virtual time for the worker. The worker's own code runs unchanged on these Timers; time moves only when
// nothing is in flight. Every answer the world gives (an RPC reply, a socket message) is delivered by a timer at a
// virtual moment fixed when it was asked, so the order of events never depends on how long the real network took:
// while the world is fetching (real I/O), virtual time stands still.
import type { TimerHandle, Timers } from '../../../packages/worker/src/scheduler/timers.ts';

interface Entry {
  readonly at: number;
  readonly seq: number;
  readonly id: number;
  fn: (() => void) | null;
}

const before = (a: Entry, b: Entry): boolean => a.at < b.at || (a.at === b.at && a.seq < b.seq);

class Heap {
  readonly #a: Entry[] = [];
  get size(): number {
    return this.#a.length;
  }
  peek(): Entry | undefined {
    return this.#a[0];
  }
  push(e: Entry): void {
    const a = this.#a;
    a.push(e);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!before(a[i]!, a[p]!)) break;
      [a[i], a[p]] = [a[p]!, a[i]!];
      i = p;
    }
  }
  pop(): Entry | undefined {
    const a = this.#a;
    const top = a[0];
    const last = a.pop();
    if (a.length > 0 && last !== undefined) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && before(a[l]!, a[m]!)) m = l;
        if (r < a.length && before(a[r]!, a[m]!)) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m]!, a[i]!];
        i = m;
      }
    }
    return top;
  }
}

const turn = (): Promise<void> => new Promise((r) => setImmediate(r));

export class VirtualClock implements Timers {
  #now: number;
  #seq = 0;
  #id = 1;
  readonly #heap = new Heap();
  readonly #cancelled = new Set<number>();
  /** Real work in flight (world fetches): virtual time does not move while it is above 0. */
  #busy = 0;
  #idle: (() => void)[] = [];
  /** A callback threw: the run stops with it. */
  failure: unknown = null;
  fired = 0;

  constructor(startMs: number) {
    this.#now = startMs;
  }

  now(): number {
    return this.#now;
  }

  setTimeout(fn: () => void, ms: number): TimerHandle {
    const id = this.#id++;
    this.#heap.push({ at: this.#now + Math.max(0, Math.floor(ms)), seq: this.#seq++, id, fn });
    return { id };
  }

  clearTimeout(h: TimerHandle): void {
    this.#cancelled.add(h.id);
  }

  /**
   * A delivery slot at `at`, taken now (so its order among equal times is fixed by when it was asked), filled later by
   * `fill`. The driver will not pass an unfilled slot.
   */
  reserve(at: number): { fill(fn: () => void): void } {
    const e: Entry = { at: Math.max(at, this.#now), seq: this.#seq++, id: this.#id++, fn: null };
    this.#heap.push(e);
    this.#busy++;
    let filled = false;
    return {
      fill: (fn) => {
        if (filled) throw new Error('slot filled twice');
        filled = true;
        e.fn = fn;
        this.#done();
      },
    };
  }

  /** Real work that must finish before time moves on. */
  async hold<T>(p: Promise<T>): Promise<T> {
    this.#busy++;
    try {
      return await p;
    } finally {
      this.#done();
    }
  }

  #done(): void {
    this.#busy--;
    if (this.#busy === 0) for (const w of this.#idle.splice(0)) w();
  }

  get busy(): number {
    return this.#busy;
  }

  /** Lets every continuation run, and waits for real work in flight, until nothing is left to do now. */
  async settle(): Promise<void> {
    for (;;) {
      for (let i = 0; i < 4; i++) await turn();
      if (this.#busy === 0) return;
      await new Promise<void>((r) => this.#idle.push(r));
    }
  }

  /**
   * Runs timers in time order up to `endMs` (inclusive), settling after each. `stop` is asked after each timer;
   * true ends the run early. Returns the virtual time reached.
   */
  async run(endMs: number, stop?: () => boolean): Promise<number> {
    for (;;) {
      await this.settle();
      if (this.failure !== null) throw this.failure;
      const next = this.#heap.peek();
      if (next === undefined || next.at > endMs) break;
      if (next.fn === null) {
        // Reserved but not filled: real work is still in flight for it.
        await new Promise<void>((r) => this.#idle.push(r));
        continue;
      }
      this.#heap.pop();
      if (this.#cancelled.delete(next.id)) continue;
      if (next.at > this.#now) this.#now = next.at;
      this.fired++;
      try {
        next.fn();
      } catch (e) {
        this.failure = e;
      }
      if (stop?.() === true) break;
    }
    if (endMs > this.#now && this.#heap.peek() === undefined) this.#now = endMs;
    return this.#now;
  }
}
