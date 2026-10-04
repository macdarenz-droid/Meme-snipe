// The survival label (RES-5, docs/research/survival.md §1), as a pure rule. Shared by the outcome stage (labels of the
// graduates being studied) and by the feature stage, which may apply it only to other graduates whose label time has
// already passed (creator history, the market's survival rate). Asking about a label time after "now" throws.

export const SURVIVAL_RULE = {
  /** The pool's real quote vault at T, lamports (30 SOL). */
  minQuoteLamports: 30_000_000_000n,
  /** Spot price at T at least this fraction of the migration price. */
  minPriceRatio: 0.5,
  /** At least one swap in this long before T. */
  activityMs: 60 * 60_000,
  /** Rug (description only): price at T at most this fraction of the migration price. */
  rugPriceRatio: 0.1,
  /** Label time after migration: 24 h for decisions at 60 and 240 min, 48 h for the 24 h decision. */
  horizonMs: (decisionAgeMs: number): number => (decisionAgeMs >= 24 * 3_600_000 ? 48 : 24) * 3_600_000,
} as const;

export interface LabelInputs {
  readonly labelAtMs: number;
  /** The moment the rule is evaluated; must be at or after labelAtMs. */
  readonly nowMs: number;
  readonly migrationPrice: number | null;
  readonly priceAtT: number | null;
  readonly quoteVaultAtT: bigint | null;
  /** Block time (ms) of the last swap at or before T, or null if none. */
  readonly lastSwapMs: number | null;
}

export interface SurvivalLabel {
  readonly survived: boolean;
  readonly rug: boolean;
}

export class LabelTimeError extends Error {
  override readonly name = 'LabelTimeError';
}

/** The label at T, or null when an input is unknown (counted as censored by the caller). */
export const survivalLabel = (i: LabelInputs): SurvivalLabel | null => {
  if (i.labelAtMs > i.nowMs) throw new LabelTimeError(`label at ${new Date(i.labelAtMs).toISOString()} asked at ${new Date(i.nowMs).toISOString()}: it has not happened yet`);
  if (i.migrationPrice === null || i.migrationPrice <= 0 || i.priceAtT === null || i.quoteVaultAtT === null) return null;
  const ratio = i.priceAtT / i.migrationPrice;
  const active = i.lastSwapMs !== null && i.lastSwapMs > i.labelAtMs - SURVIVAL_RULE.activityMs && i.lastSwapMs <= i.labelAtMs;
  return {
    survived: i.quoteVaultAtT >= SURVIVAL_RULE.minQuoteLamports && ratio >= SURVIVAL_RULE.minPriceRatio && active,
    rug: ratio <= SURVIVAL_RULE.rugPriceRatio,
  };
};
