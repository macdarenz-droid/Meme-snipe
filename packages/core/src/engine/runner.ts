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
 * total is rate-limited. Dropping a repeat is safe: the lifecycle asks again on a later tick and the key keeps
 * its place in line. Every other effect passes straight through.
 *
 * Under the cap:
 * - Between kinds, an unbooked landing (`reconcile_orphan`, which blocks every entry) goes before a balance
 *   read, but each window reserves max(1, ⌊cap/4⌋) places for waiting balance reads, never more than cap − 1,
 *   so orphans always keep a place too. With a cap of 1 the two kinds alternate window by window while both wait.
 * - Within a kind, the key served least recently goes first; a key never served counts as served when it was
 *   first asked for (ties by key). A key asked continuously therefore waits behind at most the K keys of its
 *   kind served before it: ⌈K / its share⌉ windows.
 */
interface Turn {
  /** Slot of the last send, or of the first ask for a key never sent. */
  served: bigint;
  readonly key: string;
}

const beforeTurn = (a: Turn, b: Turn): boolean => a.served < b.served || (a.served === b.served && a.key < b.key);

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
}

type Kind = 'orphan' | 'balance';

export class ReconcileGuard {
  readonly #limits: ReconcileLimits;
  readonly #reserve: number;
  readonly #lastSent = new Map<string, bigint>();
  readonly #turns = new Map<string, Turn>();
  /** Slot each key was last asked for (sent, refused or duplicate). */
  readonly #asked = new Map<string, bigint>();
  /** Keys refused for the cap, with the slot they were last asked for. */
  readonly #waiting = new Map<string, bigint>();
  readonly #lines: Record<Kind, Line> = {
    orphan: new Line((k) => this.#turns.get(k)!),
    balance: new Line((k) => this.#turns.get(k)!),
  };
  /** Sends in the current window, oldest first, consumed from `#head`; counts kept incrementally. */
  readonly #recent: { readonly slot: bigint; readonly kind: Kind }[] = [];
  #head = 0;
  #balancesInWindow = 0;
  /** With a cap of 1: the kind sent last, so the other goes next while both wait. */
  #lastKind: Kind | null = null;
  #slot: bigint | null = null;

  constructor(limits: ReconcileLimits = DEFAULT_RECONCILE_LIMITS) {
    if (limits.minSlotsBetween < 1n || limits.windowSlots < 1n || !Number.isSafeInteger(limits.maxPerWindow) || limits.maxPerWindow < 1) {
      throw new RangeError('reconcile limits must be positive');
    }
    this.#limits = limits;
    const cap = limits.maxPerWindow;
    this.#reserve = cap === 1 ? 0 : Math.min(cap - 1, Math.max(1, Math.floor(cap / 4)));
  }

  /** Decides whether `effect` goes to the runner now. Records it as sent when it does. */
  admit(effect: Effect, now: Moment): Dispatch {
    const key = reconcileKey(effect);
    if (key === null) return 'sent';
    this.#asked.set(key, now.slot);
    const last = this.#lastSent.get(key);
    if (last !== undefined && now.slot - last < this.#limits.minSlotsBetween) return 'duplicate';
    if (this.#slot !== now.slot) this.#newSlot(now.slot);

    const kind: Kind = key.startsWith('reconcile_orphan|') ? 'orphan' : 'balance';
    const other: Kind = kind === 'orphan' ? 'balance' : 'orphan';
    const mine = this.#turnOf(key, now.slot);
    const waiting = this.#waiting.has(key);
    const own = this.#lines[kind];
    const free = this.#limits.maxPerWindow - (this.#recent.length - this.#head);
    let ahead = own.rank(mine);
    let places = free;
    if (this.#limits.maxPerWindow === 1) {
      // One place per window: alternate kinds while both wait.
      if (this.#lines[other].size > 0 && this.#lastKind === kind) places = 0;
    } else {
      const owed = Math.max(0, this.#reserve - this.#balancesInWindow);
      if (kind === 'orphan') {
        places -= Math.min(owed, this.#lines.balance.size);
      } else if (owed > 0) {
        places = Math.min(free, owed);
      } else {
        ahead += this.#lines.orphan.size;
      }
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
    this.#recent.push({ slot: now.slot, kind });
    if (kind === 'balance') this.#balancesInWindow++;
    this.#lastKind = kind;
    this.#lastSent.set(key, now.slot);
    mine.served = now.slot;
    return 'sent';
  }

  /** Once per slot: slide the window, drop waiters no longer asked for, forget long-finished keys. */
  #newSlot(slot: bigint): void {
    this.#slot = slot;
    const { windowSlots, minSlotsBetween } = this.#limits;
    while (this.#head < this.#recent.length && slot - this.#recent[this.#head]!.slot >= windowSlots) {
      if (this.#recent[this.#head]!.kind === 'balance') this.#balancesInWindow--;
      this.#head++;
    }
    if (this.#head > 512 && this.#head * 2 > this.#recent.length) {
      this.#recent.splice(0, this.#head);
      this.#head = 0;
    }
    // A waiter not asked for in the last slot leaves the line, so a resolved intent never holds a place.
    // Its turn is kept: asked again (the next tick), it rejoins at the same rank.
    for (const [k, asked] of this.#waiting) {
      if (slot - asked <= 1n) continue;
      this.#lines[k.startsWith('reconcile_orphan|') ? 'orphan' : 'balance'].remove(k);
      this.#waiting.delete(k);
    }
    // Forget keys not asked for a whole window (and past their repeat interval): finished intents.
    if (this.#turns.size > 512) {
      for (const [k, asked] of this.#asked) {
        const sent = this.#lastSent.get(k);
        if (slot - asked > windowSlots && !this.#waiting.has(k) && (sent === undefined || slot - sent >= minSlotsBetween)) {
          this.#lastSent.delete(k);
          this.#turns.delete(k);
          this.#asked.delete(k);
        }
      }
    }
  }

  /** A key seen for the first time counts as served at its first ask, behind every key already in line. */
  #turnOf(key: string, slot: bigint): Turn {
    let t = this.#turns.get(key);
    if (t === undefined) {
      t = { served: slot, key };
      this.#turns.set(key, t);
    }
    return t;
  }
}
