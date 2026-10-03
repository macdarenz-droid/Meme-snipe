// Time for the worker's I/O layer. Injected everywhere, so tests and fault drills run on a manual clock.
// The engine never sees these: it reads time only from its Clock (docs/ARCHITECTURE.md §16.1).

export type TimerHandle = { readonly id: number };

export interface Timers {
  /** Wall time in integer ms since epoch. */
  now(): number;
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

/** The system clock and Node's timers. */
export const systemTimers = (): Timers => {
  const live = new Map<number, ReturnType<typeof setTimeout>>();
  let next = 1;
  return {
    now: () => Date.now(),
    setTimeout: (fn, ms) => {
      const id = next++;
      live.set(id, setTimeout(() => { live.delete(id); fn(); }, Math.max(0, ms)));
      return { id };
    },
    clearTimeout: (h) => {
      const t = live.get(h.id);
      if (t !== undefined) clearTimeout(t);
      live.delete(h.id);
    },
  };
};

/** A clock that only moves when told. `advance` fires due timers in time order, then id order. */
export class ManualTimers implements Timers {
  #now: number;
  #next = 1;
  readonly #pending = new Map<number, { at: number; fn: () => void }>();

  constructor(start = 0) {
    this.#now = start;
  }

  now(): number {
    return this.#now;
  }

  setTimeout(fn: () => void, ms: number): TimerHandle {
    const id = this.#next++;
    this.#pending.set(id, { at: this.#now + Math.max(0, ms), fn });
    return { id };
  }

  clearTimeout(h: TimerHandle): void {
    this.#pending.delete(h.id);
  }

  /** Moves the clock forward by `ms`, firing every timer that falls due on the way. */
  advance(ms: number): void {
    const end = this.#now + ms;
    for (;;) {
      let due: [number, { at: number; fn: () => void }] | undefined;
      for (const entry of this.#pending) if (entry[1].at <= end && (due === undefined || entry[1].at < due[1].at)) due = entry;
      if (due === undefined) break;
      this.#pending.delete(due[0]);
      this.#now = Math.max(this.#now, due[1].at);
      due[1].fn();
    }
    this.#now = end;
  }

  pending(): number {
    return this.#pending.size;
  }
}
