// The policy: every limit in ARCHITECTURE.md sections 7 (gates), 8 (risk) and 9 (exits) as one versioned object.
// Nothing here is a constant of the engine. Code loads a policy and can only tighten it (tighten.ts); the owner
// raises limits by creating a new policy version outside the running engine.
import { type Lamports, type MicroUsd, lamports } from '../units/index.ts';
import { sol, usd } from './amounts.ts';
import { deepFreeze } from './freeze.ts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Bump when the shape of Policy changes. Values are versioned by the hash of the whole policy. */
export const POLICY_SCHEMA_VERSION = 3;

/** One rung of the exit escalation ladder (section 9). */
export interface LadderStep {
  /** Priority fee for this attempt. */
  readonly priorityFeeLamports: Lamports;
  /** Lowest acceptable output, in basis points below the trigger value. */
  readonly minOutBelowTriggerBps: number;
}

/** The universes that trade (ARCHITECTURE §3.2). U3 gets a block when RES-2 adds it. */
export const EXIT_UNIVERSES = ['U1', 'U2'] as const;
export type ExitUniverse = (typeof EXIT_UNIVERSES)[number];

/** Section 9 exit parameters that belong to a strategy, so they differ by universe. */
export interface UniverseExits {
  /** ATR multiple for the price stop, in tenths (30 = 3.0). */
  readonly stopAtrTenths: number;
  /** Time stop: exit if not at flatMinRBps of R by this time. */
  readonly tFlatMs: number;
  readonly flatMinRBps: number;
  readonly tMaxMs: number;
  readonly partialMinShareBps: number;
  /** Partial taken at this multiple of R (10,000 = 1R). The k-th partial needs k times this. */
  readonly partialAtRBps: number;
  /** Or at this gain on the cost basis (10,000 = +100%), whichever comes first; the k-th partial needs k times it. */
  readonly partialAtGainBps: number;
  /** ATR for the price stop cap and the trail: this many bars of this length (ATR(14) on 1-minute bars). */
  readonly atrPeriod: number;
  readonly atrBarMs: number;
  /** ATR multiple for the trailing stop, in tenths (30 = 3.0). */
  readonly trailAtrTenths: number;
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
    /**
     * R2-6: the most of the 24 h survival window a restart's unobserved stretch may cover; more is not covered, less is
     * judged on the observed marks (S1 ruling, docs/DECISIONS.md A2-GATE-FIXES).
     */
    readonly survivalMaxUnobservedMs: number;
    readonly volumePercentile: number;
    /** Cap on the expanding volume window, in days. */
    readonly volumeWindowDays: number;
    /** The volume day read is the check's UTC day minus this (the archive completes a day 0.4 to 1.9 days late). */
    readonly volumeLagDays: number;
    /** Fewest days the volume window must hold; fewer is unknown. */
    readonly volumeMinDays: number;
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
    /** H13: the dev's linked cluster, as a share of circulating supply. */
    readonly devClusterBps: number;
    readonly serialMaxMints24h: number;
    /** H14: a prior rug within this many days of our own index rejects. Same window live and in the backtest. */
    readonly deployerRugLookbackDays: number;
    readonly maxStateSlotLag: number;
    readonly maxQuoteAgeMs: number;
  };

  /**
   * Section 9. The ladder, the exit-transaction counts, blocked retries and R9's thesis, flow, liquidity and quote stops are global: they feed
   * the cost reservation (risk/evaluate.ts) and the fee reserve, so a reservation never depends on the universe. Time
   * stops, partials, the ATR and its multiples are strategy parameters, one block per universe (CFG-2).
   */
  readonly exits: {
    /** Strategy exits per universe. Every universe in use has a block; S0 uses the block of the universe it controls for. */
    readonly universes: { readonly [U in ExitUniverse]: UniverseExits };
    /**
     * Phase-1 hard maximum hold (§9): no universe's tMaxMs may exceed it, and validation keeps it at or below 120 min
     * (PHASE1_T_MAX_MS). A longer hold is a new version the owner approves.
     */
    readonly tMaxCapMs: number;
    readonly deployerSellSupplyBps: number;
    readonly liquidityDropBps: number;
    readonly reverseQuoteFailures: number;
    /** R9 flow stop: exit when net SOL flow has been negative this many minutes in a row. */
    readonly negativeFlowMinutes: number;
    readonly maxExitTxAtMinNotional: number;
    readonly maxExitTxAboveDoubleMin: number;
    readonly ladder: {
      /** Normal rungs, then the emergency rung last. */
      readonly steps: readonly LadderStep[];
      readonly maxAttempts: number;
      /** Ceiling on the priority fee of any single attempt. */
      readonly maxFeePerAttempt: Lamports;
    };
    /**
     * A blocked exit is tried again, at the last rung with a fresh quote, no sooner than this after the last block and
     * at most this many times per position. Bounded so a dead pool cannot drain the fee reserve.
     */
    readonly blockedRetryMs: number;
    readonly blockedRetryAttempts: number;
  };
}

/** $20 bankroll, $2 to $5 trades. Everything else is the paper default from sections 6.4 to 9. */
const TRIAL_VALUES: Policy = {
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
    survivalMaxUnobservedMs: 2 * HOUR,
    volumePercentile: 25,
    volumeWindowDays: 365,
    volumeLagDays: 3,
    volumeMinDays: 28,
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
    top10Bps: 3000,
    insiderBps: 1500,
    devClusterBps: 500,
    serialMaxMints24h: 2,
    deployerRugLookbackDays: 14,
    maxStateSlotLag: 2,
    maxQuoteAgeMs: 2000,
  },
  exits: {
    universes: {
      // Paper trial values from risk.md S2 (T_flat 30 min, 50% at +2R, ATR14 on 5-minute bars × 3); where S2 is silent,
      // U2's value. T_max stays at the phase-1 hard maximum of 120 min (§9): S2's 4 h is a variant that needs the owner.
      // The study sets the frozen values.
      U1: {
        stopAtrTenths: 30,
        tFlatMs: 30 * MINUTE,
        flatMinRBps: 5000,
        tMaxMs: 120 * MINUTE,
        partialMinShareBps: 5000,
        partialAtRBps: 20_000,
        partialAtGainBps: 10_000,
        atrPeriod: 14,
        atrBarMs: 5 * MINUTE,
        trailAtrTenths: 30,
      },
      U2: {
        stopAtrTenths: 30,
        tFlatMs: 15 * MINUTE,
        flatMinRBps: 5000,
        tMaxMs: 120 * MINUTE,
        partialMinShareBps: 5000,
        partialAtRBps: 15_000,
        partialAtGainBps: 10_000,
        atrPeriod: 14,
        atrBarMs: MINUTE,
        trailAtrTenths: 30,
      },
    },
    tMaxCapMs: 120 * MINUTE,
    deployerSellSupplyBps: 200,
    liquidityDropBps: 3000,
    reverseQuoteFailures: 2,
    negativeFlowMinutes: 5,
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
    blockedRetryMs: MINUTE,
    blockedRetryAttempts: 5,
  },
};

/** The trial setting. Deep-frozen: nothing can change it at runtime. */
export const TRIAL_POLICY: Policy = deepFreeze(TRIAL_VALUES);

/**
 * The strategy exits for a position's universe. Throws on a universe without a block: a position never falls back to
 * another universe's exits.
 */
export const exitsFor = (exits: Policy['exits'], universe: string): UniverseExits => {
  if (!Object.hasOwn(exits.universes, universe)) throw new RangeError(`no exit parameters for universe ${universe}`);
  return exits.universes[universe as ExitUniverse];
};
