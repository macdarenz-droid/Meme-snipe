// The policy: every limit in ARCHITECTURE.md sections 7 (gates), 8 (risk) and 9 (exits) as one versioned object.
// Nothing here is a constant of the engine. Code loads a policy and can only tighten it (tighten.ts); the owner
// raises limits by creating a new policy version outside the running engine.
import { type Lamports, type MicroUsd, lamports } from '../units/index.ts';
import { sol, usd } from './amounts.ts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Bump when the shape of Policy changes. Values are versioned by the hash of the whole policy. */
export const POLICY_SCHEMA_VERSION = 1;

/** One rung of the exit escalation ladder (section 9). */
export interface LadderStep {
  /** Priority fee for this attempt. */
  readonly priorityFeeLamports: Lamports;
  /** Lowest acceptable output, in basis points below the trigger value. */
  readonly minOutBelowTriggerBps: number;
}

export interface Policy {
  readonly schemaVersion: typeof POLICY_SCHEMA_VERSION;
  /** Label only; it does not change behaviour (it does change the hash). */
  readonly name: string;

  /** R1, R2. */
  readonly capital: {
    readonly bankroll: MicroUsd;
    readonly minNotional: MicroUsd;
    readonly maxNotional: MicroUsd;
    /** A drawdown from the high-water mark of this size returns sizing to the minimum. */
    readonly drawdownResetBps: number;
  };

  /** R3, R11. */
  readonly positions: {
    readonly maxOpen: number;
    readonly maxEntriesPerDay: number;
    readonly maxEntriesPerMintPerDay: number;
    /** No re-entry on a mint that was stopped out. */
    readonly reentryBlockMs: number;
  };

  /** R4. */
  readonly reserve: {
    /** Entries blocked when SOL cash for operations falls below this. */
    readonly opsFloor: Lamports;
    /** Exit attempts the live reserve must cover, at the exit fee cap. */
    readonly exitAttempts: number;
  };

  /** R5 to R10. Percentages of the bankroll are in basis points so they scale with it. */
  readonly loss: {
    readonly plannedRiskBps: number;
    /** Widest allowed stop distance. */
    readonly stopMaxBps: number;
    readonly dailyBps: number;
    readonly weeklyBps: number;
    /** Entries disabled when equity is at or below this share of the high-water mark. */
    readonly killSwitchFloorBps: number;
    readonly cooldownAfterLosses: number;
    readonly cooldownMs: number;
    readonly pauseDayAfterLosses: number;
    readonly reviewWindowTrades: number;
    readonly reviewLosses: number;
  };

  /** R12, R13. */
  readonly liquidity: {
    readonly floorUsd: MicroUsd;
    /** The floor is at least this many times the trade size. */
    readonly floorNotionalMultiple: number;
    /** Stricter floor for the U1 universe. */
    readonly u1FloorUsd: MicroUsd;
    /** Entry plus exit price impact allowed at current reserves. */
    readonly maxImpactBps: number;
  };

  /** R14, section 5.3. */
  readonly costGate: {
    readonly maxRoundTripBps: number;
    readonly maxShareOfMedianTargetBps: number;
  };

  /** R16, section 6.4. */
  readonly regime: {
    readonly survivalReserveFloor: Lamports;
    readonly survivalAfterMs: number;
    readonly survivalMedianDays: number;
    readonly volumePercentile: number;
    readonly volumeWindowDays: number;
    /** SOL 24 h change must be above this (signed). */
    readonly solChange24hFloorBps: number;
    readonly failedChecksToDisable: number;
  };

  /** Section 7.1 hard rejects that carry a number. */
  readonly gates: {
    readonly dustPoolMinAtMigration: Lamports;
    readonly instantGraduationMinMs: number;
    readonly excludedWindowMs: number;
    readonly chaseCheckAfterMs: number;
    readonly chaseMaxAboveMigrationBps: number;
    readonly candleSpikeBps: number;
    readonly candleWindowMs: number;
    /** Any single holder or the dev at or above this always rejects. */
    readonly hardHolderBps: number;
    readonly singleHolderBps: number;
    readonly top10Bps: number;
    readonly insiderBps: number;
    readonly serialMaxMints24h: number;
    readonly maxStateSlotLag: number;
    readonly maxQuoteAgeMs: number;
  };

  /** Section 9. */
  readonly exits: {
    readonly stopAtrMultiple: number;
    readonly deployerSellSupplyBps: number;
    readonly liquidityDropBps: number;
    readonly reverseQuoteFailures: number;
    readonly negativeFlowMinutes: number;
    /** Time stop: exit if not at flatMinRBps of R by this time. */
    readonly tFlatMs: number;
    readonly flatMinRBps: number;
    readonly tMaxMs: number;
    readonly partialMinShareBps: number;
    /** Partial taken at this multiple of R (10,000 = 1R). */
    readonly partialAtRBps: number;
    readonly trailAtrMultiple: number;
    readonly maxExitTxAtMinNotional: number;
    readonly maxExitTxAboveDoubleMin: number;
    readonly ladder: {
      /** Normal rungs, then the emergency rung last. */
      readonly steps: readonly LadderStep[];
      readonly maxAttempts: number;
      /** Ceiling on the priority fee of any single attempt. */
      readonly maxFeePerAttempt: Lamports;
    };
  };
}

/** The trial setting: $20 bankroll, $2 to $5 trades. Everything else is the paper default from section 8 to 9. */
export const TRIAL_POLICY: Policy = {
  schemaVersion: POLICY_SCHEMA_VERSION,
  name: 'trial',
  capital: { bankroll: usd('20'), minNotional: usd('2'), maxNotional: usd('5'), drawdownResetBps: 1000 },
  positions: { maxOpen: 1, maxEntriesPerDay: 3, maxEntriesPerMintPerDay: 1, reentryBlockMs: 24 * HOUR },
  reserve: { opsFloor: sol('0.015'), exitAttempts: 5 },
  loss: {
    plannedRiskBps: 275,
    stopMaxBps: 2000,
    dailyBps: 750,
    weeklyBps: 2000,
    killSwitchFloorBps: 7000,
    cooldownAfterLosses: 2,
    cooldownMs: 2 * HOUR,
    pauseDayAfterLosses: 3,
    reviewWindowTrades: 20,
    reviewLosses: 5,
  },
  liquidity: { floorUsd: usd('15000'), floorNotionalMultiple: 1000, u1FloorUsd: usd('50000'), maxImpactBps: 100 },
  costGate: { maxRoundTripBps: 500, maxShareOfMedianTargetBps: 3333 },
  regime: {
    survivalReserveFloor: sol('30'),
    survivalAfterMs: 30 * MINUTE,
    survivalMedianDays: 14,
    volumePercentile: 25,
    volumeWindowDays: 365,
    solChange24hFloorBps: -800,
    failedChecksToDisable: 2,
  },
  gates: {
    dustPoolMinAtMigration: sol('5'),
    instantGraduationMinMs: 5 * MINUTE,
    excludedWindowMs: 60 * MINUTE,
    chaseCheckAfterMs: 5 * MINUTE,
    chaseMaxAboveMigrationBps: 0,
    candleSpikeBps: 2500,
    candleWindowMs: 3 * MINUTE,
    hardHolderBps: 4000,
    singleHolderBps: 1000,
    top10Bps: 3500,
    insiderBps: 1500,
    serialMaxMints24h: 2,
    maxStateSlotLag: 2,
    maxQuoteAgeMs: 2000,
  },
  exits: {
    stopAtrMultiple: 3,
    deployerSellSupplyBps: 200,
    liquidityDropBps: 3000,
    reverseQuoteFailures: 2,
    negativeFlowMinutes: 5,
    tFlatMs: 15 * MINUTE,
    flatMinRBps: 5000,
    tMaxMs: 120 * MINUTE,
    partialMinShareBps: 5000,
    partialAtRBps: 15_000,
    trailAtrMultiple: 3,
    maxExitTxAtMinNotional: 2,
    maxExitTxAboveDoubleMin: 3,
    ladder: {
      steps: [
        { priorityFeeLamports: lamports(20_000n), minOutBelowTriggerBps: 800 },
        { priorityFeeLamports: lamports(60_000n), minOutBelowTriggerBps: 800 },
        { priorityFeeLamports: lamports(150_000n), minOutBelowTriggerBps: 2500 },
        { priorityFeeLamports: lamports(500_000n), minOutBelowTriggerBps: 2500 },
      ],
      maxAttempts: 5,
      maxFeePerAttempt: sol('0.0005'),
    },
  },
};
