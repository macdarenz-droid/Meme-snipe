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
 * goes before a balance read, except that each window keeps one place for a balance read while one waits;
 * within a kind, keys are served in rounds: a free place goes to the waiting key
 * sent the fewest times, then the one waiting longest. A new key joins the current round (it neither jumps ahead
 * of keys still owed a send nor falls behind), so no key is starved however many keys there are.
 * Dropping a repeat is safe because the lifecycle asks again on a later tick and the queue keeps its place.
 * Every other effect passes straight through.
 */
export class ReconcileGuard {
  readonly #limits: ReconcileLimits;
  readonly #lastSent = new Map<string, bigint>();
  /** Per key: sends so far (its round) and its place in line (a sequence number, never tied). */
  readonly #turn = new Map<string, { sends: number; seq: number }>();
  #seq = 0;
  /** Keys refused for the cap, with the slot they were last asked for. */
  readonly #waiting = new Map<string, bigint>();
  /** Sends in the current window: when, and whether it was an orphan reconcile. */
  #recent: { readonly slot: bigint; readonly orphan: boolean }[] = [];

  constructor(limits: ReconcileLimits = DEFAULT_RECONCILE_LIMITS) {
    if (limits.minSlotsBetween < 1n || limits.windowSlots < 1n || !Number.isSafeInteger(limits.maxPerWindow) || limits.maxPerWindow < 1) {
      throw new RangeError('reconcile limits must be positive');
    }
    this.#limits = limits;
  }

  /** Decides whether `effect` goes to the runner now. Records it as sent when it does. */
  admit(effect: Effect, now: Moment): Dispatch {
    const key = reconcileKey(effect);
    if (key === null) return 'sent';
    const { minSlotsBetween, windowSlots, maxPerWindow } = this.#limits;
    const last = this.#lastSent.get(key);
    if (last !== undefined && now.slot - last < minSlotsBetween) return 'duplicate';
    this.#recent = this.#recent.filter((r) => now.slot - r.slot < windowSlots);
    // A waiter no longer asked for (its intent resolved) gives up its place.
    for (const [k, asked] of this.#waiting) if (now.slot - asked > windowSlots) this.#waiting.delete(k);
    const mine = this.#turnOf(key);
    const free = maxPerWindow - this.#recent.length;
    const isOrphan = (k: string) => k.startsWith('reconcile_orphan|');
    const before = (k: string) => {
      const theirs = this.#turnOf(k);
      return theirs.sends < mine.sends || (theirs.sends === mine.sends && theirs.seq < mine.seq);
    };
    const others = [...this.#waiting.keys()].filter((k) => k !== key);
    // Orphans go first, but every window keeps one place for a balance read while one waits, so exits
    // still reconcile (and positions close) when orphan reads keep failing.
    const balanceSentThisWindow = this.#recent.some((r) => !r.orphan);
    let ahead: number;
    let places = free;
    if (isOrphan(key)) {
      ahead = others.filter((k) => isOrphan(k) && before(k)).length;
      if (!balanceSentThisWindow && others.some((k) => !isOrphan(k))) places--;
    } else if (!balanceSentThisWindow) {
      // The reserved place: the first balance read in rounds order takes it, ahead of any orphan.
      ahead = others.filter((k) => !isOrphan(k) && before(k)).length;
      places = Math.min(free, 1);
    } else {
      ahead = others.filter((k) => isOrphan(k) || before(k)).length;
    }
    if (ahead >= places) {
      this.#waiting.set(key, now.slot);
      return 'rate_limited';
    }
    this.#waiting.delete(key);
    this.#recent.push({ slot: now.slot, orphan: isOrphan(key) });
    this.#lastSent.set(key, now.slot);
    mine.sends++;
    mine.seq = this.#seq++;
    if (this.#lastSent.size > 1024) {
      for (const [k, slot] of this.#lastSent) {
        if (now.slot - slot >= minSlotsBetween && !this.#waiting.has(k)) {
          this.#lastSent.delete(k);
          this.#turn.delete(k);
        }
      }
    }
    return 'sent';
  }

  /** A key seen for the first time joins the current round: the fewest sends among the keys tracked. */
  #turnOf(key: string): { sends: number; seq: number } {
    let t = this.#turn.get(key);
    if (t === undefined) {
      let round = Infinity;
      for (const k of this.#waiting.keys()) round = Math.min(round, this.#turn.get(k)?.sends ?? 0);
      if (round === Infinity) for (const other of this.#turn.values()) round = Math.min(round, other.sends);
      t = { sends: round === Infinity ? 0 : round, seq: this.#seq++ };
      this.#turn.set(key, t);
    }
    return t;
  }
}
