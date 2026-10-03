import type { Effect } from '../lifecycle/index.ts';
import type { Moment } from './moment.ts';

/**
 * Performs lifecycle effects in the outside world (persist, broadcast, status reads, reconciles).
 * Called synchronously and in order; it returns nothing (the engine refuses any returned value, a promise
 * included). Results come back later as feed events, never as return values,
 * so the engine stays deterministic. Live: real adapters. Backtest: the fill model.
 */
export interface EffectRunner {
  run(effect: Effect, now: Moment): void;
}

/** Operational limits for wallet reads. Not money limits. */
export interface ReconcileLimits {
  /** The same reconcile (type, intent, signature) is sent at most once per this many slots. */
  readonly minSlotsBetween: bigint;
  /** At most `maxPerWindow` reconciles of any key in any `windowSlots` slots. */
  readonly windowSlots: bigint;
  readonly maxPerWindow: number;
}

/** About 10 s between repeats of one reconcile, at most 20 reconciles a minute (400 ms slots). */
export const DEFAULT_RECONCILE_LIMITS: ReconcileLimits = { minSlotsBetween: 25n, windowSlots: 150n, maxPerWindow: 20 };

export type Dispatch = 'sent' | 'duplicate' | 'rate_limited';

const reconcileKey = (fx: Effect): string | null => {
  if (fx.type === 'reconcile_balances') return `reconcile_balances|${fx.intentId}`;
  if (fx.type === 'reconcile_orphan') return `reconcile_orphan|${fx.intentId}|${fx.signature}`;
  return null;
};

/**
 * The runner rule from the CORE-1 review: every tick re-emits `reconcile_balances` for each intent with a
 * known outcome and `reconcile_orphan` for each unbooked landing, so repeats are de-duplicated and the
 * total is rate-limited. Under the cap, an unbooked landing (`reconcile_orphan`, which blocks every entry)
 * goes before a balance read, except that each window reserves max(1, cap / 4) places for waiting balance reads;
 * within a kind, keys are served in rounds: a free place goes to the waiting key
 * sent the fewest times, then the one waiting longest. A new key joins the current round (it neither jumps ahead
 * of keys still owed a send nor falls behind), so no key is starved however many keys there are.
 * Dropping a repeat is safe because the lifecycle asks again on a later tick and the queue keeps its place.
 * Every other effect passes straight through.
 */
interface Turn {
  /** Sends so far: the key's round. */
  sends: number;
  /** Place in line within a round; a sequence number, never tied. */
  seq: number;
}

const beforeTurn = (a: Turn, b: Turn): boolean => a.sends < b.sends || (a.sends === b.sends && a.seq < b.seq);

/** Keys of one kind waiting for a place, kept sorted by turn so a key's rank is a binary search. */
class Line {
  readonly #keys: string[] = [];
  readonly #turn: (k: string) => Turn;

  constructor(turn: (k: string) => Turn) {
    this.#turn = turn;
  }

  get size(): number {
    return this.#keys.length;
  }

  /** How many waiting keys come before `t`. */
  rank(t: Turn): number {
    let lo = 0;
    let hi = this.#keys.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (beforeTurn(this.#turn(this.#keys[mid]!), t)) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  add(key: string): void {
    this.#keys.splice(this.rank(this.#turn(key)), 0, key);
  }

  /** Call before the key's turn changes. */
  remove(key: string): void {
    const at = this.rank(this.#turn(key));
    if (this.#keys[at] === key) this.#keys.splice(at, 1);
  }

  first(): string | undefined {
    return this.#keys[0];
  }
}

export class ReconcileGuard {
  readonly #limits: ReconcileLimits;
  readonly #reserve: number;
  readonly #lastSent = new Map<string, bigint>();
  readonly #turns = new Map<string, Turn>();
  #seq = 0;
  /** Keys refused for the cap, with the slot they were last asked for. */
  readonly #waiting = new Map<string, bigint>();
  readonly #orphans = new Line((k) => this.#turns.get(k)!);
  readonly #balances = new Line((k) => this.#turns.get(k)!);
  /** Sends in the current window, oldest first, consumed from `#head`; counts kept incrementally. */
  readonly #recent: { readonly slot: bigint; readonly orphan: boolean }[] = [];
  #head = 0;
  #balancesInWindow = 0;
  #slot: bigint | null = null;

  constructor(limits: ReconcileLimits = DEFAULT_RECONCILE_LIMITS) {
    if (limits.minSlotsBetween < 1n || limits.windowSlots < 1n || !Number.isSafeInteger(limits.maxPerWindow) || limits.maxPerWindow < 1) {
      throw new RangeError('reconcile limits must be positive');
    }
    this.#limits = limits;
    // Balance reads keep the larger of one place and a quarter of the cap in every window.
    this.#reserve = Math.min(limits.maxPerWindow, Math.max(1, Math.floor(limits.maxPerWindow / 4)));
  }

  /** Decides whether `effect` goes to the runner now. Records it as sent when it does. */
  admit(effect: Effect, now: Moment): Dispatch {
    const key = reconcileKey(effect);
    if (key === null) return 'sent';
    const last = this.#lastSent.get(key);
    if (last !== undefined && now.slot - last < this.#limits.minSlotsBetween) return 'duplicate';
    if (this.#slot !== now.slot) this.#newSlot(now.slot);

    const orphan = key.startsWith('reconcile_orphan|');
    const mine = this.#turnOf(key);
    const waiting = this.#waiting.has(key);
    const own = orphan ? this.#orphans : this.#balances;
    const free = this.#limits.maxPerWindow - (this.#recent.length - this.#head);
    const owed = Math.max(0, this.#reserve - this.#balancesInWindow);
    const othersOf = (line: Line, mineInIt: boolean) => line.size - (mineInIt ? 1 : 0);
    let ahead: number;
    let places = free;
    if (orphan) {
      // Orphans (unbooked landings block every entry) go first, minus the places owed to waiting balance reads.
      ahead = own.rank(mine);
      places -= Math.min(owed, othersOf(this.#balances, false));
    } else if (owed > 0) {
      // A reserved place: balance reads in rounds order take them ahead of any orphan.
      ahead = own.rank(mine);
      places = Math.min(free, owed);
    } else {
      ahead = this.#orphans.size + own.rank(mine);
    }
    if (ahead >= places) {
      if (!waiting) own.add(key);
      this.#waiting.set(key, now.slot);
      return 'rate_limited';
    }
    if (waiting) {
      own.remove(key);
      this.#waiting.delete(key);
    }
    this.#recent.push({ slot: now.slot, orphan });
    if (!orphan) this.#balancesInWindow++;
    this.#lastSent.set(key, now.slot);
    mine.sends++;
    mine.seq = this.#seq++;
    return 'sent';
  }

  /** Once per slot: slide the window, drop waiters no longer asked for, forget long-finished keys. */
  #newSlot(slot: bigint): void {
    this.#slot = slot;
    const { windowSlots, minSlotsBetween } = this.#limits;
    while (this.#head < this.#recent.length && slot - this.#recent[this.#head]!.slot >= windowSlots) {
      if (!this.#recent[this.#head]!.orphan) this.#balancesInWindow--;
      this.#head++;
    }
    if (this.#head > 512 && this.#head * 2 > this.#recent.length) {
      this.#recent.splice(0, this.#head);
      this.#head = 0;
    }
    for (const [k, asked] of this.#waiting) {
      if (slot - asked <= windowSlots) continue;
      (k.startsWith('reconcile_orphan|') ? this.#orphans : this.#balances).remove(k);
      this.#waiting.delete(k);
    }
    if (this.#lastSent.size > 512) {
      for (const [k, sent] of this.#lastSent) {
        if (slot - sent >= minSlotsBetween && !this.#waiting.has(k)) {
          this.#lastSent.delete(k);
          this.#turns.delete(k);
        }
      }
    }
  }

  /** A key seen for the first time joins the current round: the fewest sends among the waiting keys. */
  #turnOf(key: string): Turn {
    let t = this.#turns.get(key);
    if (t === undefined) {
      const heads = [this.#orphans.first(), this.#balances.first()].flatMap((k) => (k === undefined ? [] : [this.#turns.get(k)!.sends]));
      t = { sends: heads.length === 0 ? 0 : Math.min(...heads), seq: this.#seq++ };
      this.#turns.set(key, t);
    }
    return t;
  }
}
