import type { Effect } from '../lifecycle/index.ts';
import type { Moment } from './moment.ts';

/**
 * Performs lifecycle effects in the outside world (persist, broadcast, status reads, reconciles).
 * Called synchronously and in order; results come back later as feed events, never as return values,
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
 * total is rate-limited. Dropping a repeat is safe: the lifecycle asks again on a later tick.
 * Every other effect passes straight through.
 */
export class ReconcileGuard {
  readonly #limits: ReconcileLimits;
  readonly #lastSent = new Map<string, bigint>();
  #window: bigint[] = [];

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
    const last = this.#lastSent.get(key);
    if (last !== undefined && now.slot - last < this.#limits.minSlotsBetween) return 'duplicate';
    this.#window = this.#window.filter((slot) => now.slot - slot < this.#limits.windowSlots);
    if (this.#window.length >= this.#limits.maxPerWindow) return 'rate_limited';
    this.#window.push(now.slot);
    this.#lastSent.set(key, now.slot);
    if (this.#lastSent.size > 1024) {
      for (const [k, slot] of this.#lastSent) if (now.slot - slot >= this.#limits.minSlotsBetween) this.#lastSent.delete(k);
    }
    return 'sent';
  }
}
