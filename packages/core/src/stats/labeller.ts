// Execution-aware triple-barrier labels (ARCHITECTURE.md §13.1; quant.md §1.2, after López de Prado, AFML ch. 3.4).
// This is the scoring stage. It runs after the engine, on the recorded path of executable value, and the engine never
// imports it: decisions are made blind, labels are computed later.
//
// The path gives, per slot, the net quote (lamports) the position would receive if sold whole at that slot, after all
// sell-side fees and price impact at the real size (computed by the fill model, not here). `null` means it cannot be
// sold at that slot (pool drained, transfer blocked), which is an executable value of 0.
// Barriers are on that value relative to the entry cost (all buy-side costs included), so they are net of costs.

import type { Rng } from './rng.ts';

export interface ValuePoint {
  readonly slot: number;
  /** Net lamports a whole-position sell would return at this slot, or null if it cannot be sold. */
  readonly value: bigint | null;
}

export interface BarrierConfig {
  /** Identifier stored with the label, e.g. "tp30_sl15_h15m". Every configuration counts as a trial. */
  readonly cfgId: string;
  /** Upper barrier as a fraction of entry cost, e.g. 0.30 for +30%. */
  readonly takeProfit: number;
  /** Lower barrier as a fraction of entry cost, e.g. 0.15 for −15%. */
  readonly stopLoss: number;
  /** Vertical barrier: slots after the entry fill. */
  readonly horizonSlots: number;
}

export interface ExitModel {
  /** Slots from barrier touch to the first exit attempt landing. */
  readonly latencySlots: number;
  /** Slots between attempts. */
  readonly retrySlots: number;
  /** Attempts on the escalation ladder before the exit counts as blocked. */
  readonly maxAttempts: number;
  /** Probability that an attempt fails although the position is sellable (from the bot's own logs). */
  readonly failProbability: number;
  /** Lamports a failed attempt still costs (base and priority fee). */
  readonly failedAttemptCost: bigint;
}

export interface EntryFill {
  readonly filled: boolean;
  /** Slot the entry filled at (or was attempted at). */
  readonly slot: number;
  /** Lamports committed: the full entry cost with all buy-side fees (the notional the return is measured against). */
  readonly cost: bigint;
  /** Lamports lost on failed entry attempts (counted in r_net whether or not the entry filled). */
  readonly failedCost: bigint;
}

export interface LabelInput {
  readonly entry: EntryFill;
  /** Executable value after the entry, ordered by slot. */
  readonly path: readonly ValuePoint[];
  /** Last slot whose data is complete. Anything later is unobserved. */
  readonly observedThroughSlot: number;
  readonly barrier: BarrierConfig;
  readonly exit: ExitModel;
  /** Seeded randomness for exit-attempt failures. */
  readonly rng: Rng;
  /** `y_meta` is 1 when r_net is above this buffer (default 0). */
  readonly metaBuffer?: number;
}

export interface TripleBarrierLabel {
  readonly cfgId: string;
  readonly entryFilled: boolean;
  /** +1 upper first, −1 lower first, 0 vertical; null when the entry did not fill or the window is censored. */
  readonly yTb: 1 | -1 | 0 | null;
  /** Net return as a fraction of entry cost, all costs; null when censored (never 0 for an unseen window). */
  readonly rNet: number | null;
  readonly touchSlot: number | null;
  readonly exitSlot: number | null;
  /** Maximum favourable and adverse excursion of executable value before the exit, as fractions of cost. */
  readonly mfe: number | null;
  readonly mae: number | null;
  readonly blocked: boolean;
  readonly nExitAttempts: number;
  readonly yMeta: 0 | 1 | null;
  readonly ySevere: 0 | 1 | null;
  readonly censored: boolean;
}

const validate = (input: LabelInput): void => {
  const { barrier, exit, entry, path } = input;
  if (!(barrier.takeProfit > 0) || !(barrier.stopLoss > 0 && barrier.stopLoss <= 1)) {
    throw new RangeError('takeProfit must be > 0 and stopLoss in (0, 1]');
  }
  if (!Number.isInteger(barrier.horizonSlots) || barrier.horizonSlots < 1) throw new RangeError('horizonSlots must be an integer >= 1');
  if (!Number.isInteger(exit.latencySlots) || exit.latencySlots < 0) throw new RangeError('latencySlots must be an integer >= 0');
  if (!Number.isInteger(exit.retrySlots) || exit.retrySlots < 1) throw new RangeError('retrySlots must be an integer >= 1');
  if (!Number.isInteger(exit.maxAttempts) || exit.maxAttempts < 1) throw new RangeError('maxAttempts must be an integer >= 1');
  if (!(exit.failProbability >= 0 && exit.failProbability <= 1)) throw new RangeError('failProbability must be in [0, 1]');
  if (exit.failedAttemptCost < 0n || entry.failedCost < 0n) throw new RangeError('costs must be >= 0');
  if (entry.cost <= 0n) throw new RangeError('entry cost must be > 0');
  let prev = entry.slot;
  for (const p of path) {
    if (!Number.isInteger(p.slot) || p.slot <= prev) throw new RangeError('path slots must be integers, increasing, after the entry slot');
    if (p.slot > input.observedThroughSlot) throw new RangeError('path has a point after observedThroughSlot');
    if (p.value !== null && p.value < 0n) throw new RangeError('executable value must be >= 0');
    prev = p.slot;
  }
};

/** Executable value as of a slot: the latest point at or before it, else null (nothing observed yet). */
const asOf = (path: readonly ValuePoint[], slot: number): ValuePoint | undefined => {
  let found: ValuePoint | undefined;
  for (const p of path) {
    if (p.slot > slot) break;
    found = p;
  }
  return found;
};

const ratio = (num: bigint, den: bigint): number => Number(num) / Number(den);

export const labelTripleBarrier = (input: LabelInput): TripleBarrierLabel => {
  validate(input);
  const { entry, path, barrier, exit, rng } = input;
  const base = { cfgId: barrier.cfgId, entryFilled: entry.filled };
  if (!entry.filled) {
    const rNet = -ratio(entry.failedCost, entry.cost);
    return {
      ...base, yTb: null, rNet, touchSlot: null, exitSlot: null, mfe: null, mae: null, blocked: false,
      nExitAttempts: 0, yMeta: rNet > (input.metaBuffer ?? 0) ? 1 : 0, ySevere: rNet <= -0.5 ? 1 : 0, censored: false,
    };
  }

  const cost = entry.cost;
  const vertical = entry.slot + barrier.horizonSlots;
  const censored = (): TripleBarrierLabel => ({
    ...base, yTb: null, rNet: null, touchSlot: null, exitSlot: null, mfe: null, mae: null, blocked: false,
    nExitAttempts: 0, yMeta: null, ySevere: null, censored: true,
  });

  // First touch. Upper: value ≥ cost·(1 + tp). Lower: value ≤ cost·(1 − sl); an unsellable slot counts as value 0.
  let yTb: 1 | -1 | 0 | null = null;
  let touchSlot: number | null = null;
  for (const p of path) {
    if (p.slot > vertical) break;
    const v = p.value === null ? -1 : ratio(p.value, cost) - 1;
    if (v >= barrier.takeProfit) {
      yTb = 1;
      touchSlot = p.slot;
      break;
    }
    if (v <= -barrier.stopLoss) {
      yTb = -1;
      touchSlot = p.slot;
      break;
    }
  }
  if (yTb === null) {
    if (input.observedThroughSlot < vertical) return censored();
    yTb = 0;
    touchSlot = vertical;
  }

  // Exit ladder: attempt k lands at touch + latency + k·retry and fills at the value as of that slot.
  let attempts = 0;
  let failedCost = 0n;
  let exitSlot = touchSlot!;
  let exitValue: bigint | null = null;
  for (let k = 0; k < exit.maxAttempts; k++) {
    const slot = touchSlot! + exit.latencySlots + k * exit.retrySlots;
    if (slot > input.observedThroughSlot) return censored();
    attempts++;
    exitSlot = slot;
    const point = asOf(path, slot);
    const sellable = point !== undefined && point.value !== null;
    if (sellable && rng.next() >= exit.failProbability) {
      exitValue = point.value;
      break;
    }
    failedCost += exit.failedAttemptCost;
  }
  const blocked = exitValue === null;
  if (blocked) {
    // End of the ladder: the liquidation value then, or 0 if it cannot be sold (quant.md §1.2 item 4).
    exitValue = asOf(path, exitSlot)?.value ?? 0n;
  }

  let mfe = -Infinity;
  let mae = Infinity;
  for (const p of path) {
    if (p.slot > exitSlot) break;
    const v = p.value === null ? -1 : ratio(p.value, cost) - 1;
    if (v > mfe) mfe = v;
    if (v < mae) mae = v;
  }
  const rNet = ratio(exitValue! - cost - failedCost - entry.failedCost, cost);
  if (mfe === -Infinity) mfe = rNet;
  if (mae === Infinity) mae = rNet;
  return {
    ...base,
    yTb,
    rNet,
    touchSlot,
    exitSlot,
    mfe,
    mae,
    blocked,
    nExitAttempts: attempts,
    yMeta: rNet > (input.metaBuffer ?? 0) ? 1 : 0,
    ySevere: rNet <= -0.5 || blocked ? 1 : 0,
    censored: false,
  };
};
