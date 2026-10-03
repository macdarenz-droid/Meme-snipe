// Paper fill model parameters (docs/ARCHITECTURE.md §11), one versioned object like the policy. These are model
// defaults until our own landing and latency data exist ("Measured during paper mode", §21); the dry run replaces them.
// Promotion uses the conservative scenario only.
import type { DelayProfile, DelayProfileName, FillNetwork, FillScenario, ScenarioName } from '../fills/index.ts';
import { lamports } from '../units/index.ts';
import { deepFreeze } from './freeze.ts';

export interface FillConfig {
  readonly version: string;
  /** True while the values are assumptions, not measured; reports show it. */
  readonly provisional: boolean;
  readonly network: FillNetwork;
  readonly scenarios: Readonly<Record<ScenarioName, FillScenario>>;
  readonly delays: Readonly<Record<DelayProfileName, DelayProfile>>;
}

// Landing defaults from §11 (0.66 PumpSwap, 0.49 curve), in ppm, for the base case. The conservative and optimistic
// cases move them by about 0.1 each way.
const LAND = { pumpswap: 660_000n, 'pump-curve': 490_000n } as const;
const LAND_LOW = { pumpswap: 560_000n, 'pump-curve': 400_000n } as const;
const LAND_HIGH = { pumpswap: 760_000n, 'pump-curve': 590_000n } as const;
// Congestion windows of 150 slots (about one minute, one blockhash lifetime).
const WINDOW = 150;
// The network chain restarts from its stationary share every 4,096 windows (about a week of slots).
const SEGMENT = 4_096;

const VALUES: FillConfig = {
  version: 'fills-2',
  provisional: true,
  network: {
    signaturesPerTx: 1n,
    baseFeePerSignature: 5_000n,
    // Successful pump trades paid a median 13,334 lamports priority; the entry cap is about 50k (§10).
    entryPriorityFee: lamports(20_000n),
    // Helius Sender SWQoS-only tip (§10).
    tip: lamports(5_000n),
    blockhashValidBlocks: 150n,
    // Token-2022 pump ATA, 170 bytes at 5,080 lamports/byte (§5.1); the larger of the two account kinds.
    tokenAccountRent: lamports(1_513_840n),
  },
  // Every value below is provisional (BT-1c item 4) until the dry run measures landing, drops and latency:
  // - dropPpm: share of misses that never reach a block (cost nothing, resolve only at expiry).
  // - landingTail: a few attempts land much later (leader skips, forwarding loss); some then expire.
  // - congestion: correlated bursts in which landing falls and latency rises for every attempt at once.
  // - exitRetryHaircutPpm: each repeated exit on a position gets that much less, as other sellers drain the pool.
  scenarios: {
    // Slots are about 0.3 s. Discovery: two free feeds, p50 within a second or two (§6.1, data.md §7).
    base: {
      name: 'base', landPpm: LAND, dropPpm: 300_000n,
      landingTail: { ppm: 30_000n, slots: [15, 30, 60] },
      congestion: { windowSlots: WINDOW, segmentWindows: SEGMENT, network: { enterPpm: 30_000n, stayPpm: 600_000n }, pool: { enterPpmPerSol: 5_000n, maxEnterPpm: 200_000n, stayPpm: 600_000n }, providerFailPpm: 5_000n, landFactorPpm: 600_000n, extraLandingSlots: 8 },
      exitRetryHaircutPpm: 25_000n,
      delay: 'measured',
      discoverySlots: [2, 3, 4, 5, 8], landingSlots: [1, 2, 2, 3, 4],
      confirmSlots: 2, finalizeSlots: 32, slippagePpm: 1_000_000n, takeProfit: 'wick', rentRecovery: true,
      closeSuccessPpm: 950_000n, dustPpm: 20_000n,
    },
    // p90 latency (a Jupiter-recent fallback is about 5 s), slippage x1.5, close-based take-profit, no rent recovery.
    conservative: {
      name: 'conservative', landPpm: LAND_LOW, dropPpm: 200_000n,
      landingTail: { ppm: 50_000n, slots: [30, 60, 120] },
      congestion: { windowSlots: WINDOW, segmentWindows: SEGMENT, network: { enterPpm: 60_000n, stayPpm: 750_000n }, pool: { enterPpmPerSol: 10_000n, maxEnterPpm: 400_000n, stayPpm: 750_000n }, providerFailPpm: 20_000n, landFactorPpm: 400_000n, extraLandingSlots: 20 },
      exitRetryHaircutPpm: 50_000n,
      delay: 'adverse',
      discoverySlots: [17], landingSlots: [6],
      confirmSlots: 2, finalizeSlots: 32, slippagePpm: 1_500_000n, takeProfit: 'close', rentRecovery: false,
      closeSuccessPpm: 900_000n, dustPpm: 50_000n,
    },
    optimistic: {
      name: 'optimistic', landPpm: LAND_HIGH, dropPpm: 400_000n,
      landingTail: { ppm: 10_000n, slots: [8, 15] },
      congestion: { windowSlots: WINDOW, segmentWindows: SEGMENT, network: { enterPpm: 10_000n, stayPpm: 500_000n }, pool: { enterPpmPerSol: 2_000n, maxEnterPpm: 100_000n, stayPpm: 500_000n }, providerFailPpm: 1_000n, landFactorPpm: 800_000n, extraLandingSlots: 2 },
      exitRetryHaircutPpm: 10_000n,
      delay: 'measured',
      discoverySlots: [1, 2], landingSlots: [1],
      confirmSlots: 2, finalizeSlots: 32, slippagePpm: 1_000_000n, takeProfit: 'wick', rentRecovery: true,
      closeSuccessPpm: 990_000n, dustPpm: 5_000n,
    },
  },
  // Observation delay (supervisor ruling after external review, DECISIONS "Follow-up rulings"): event → processed,
  // processed → confirmed (charged when the decision path waits for confirmed), provider → worker.
  delays: {
    // Source: none yet. Today's base values (2 slots + 200 ms) until the worker's recorder measures processed and
    // confirmed arrival on the VPS; then this profile takes the measured values. Status: unmeasured.
    measured: { status: 'unmeasured', eventToProcessedSlots: 1, processedToConfirmedSlots: 1, providerMs: 200, blackouts: [] },
    // Stress budgets, not measured percentiles (ruling values). Promotion's conservative scenario uses `adverse`.
    adverse: { status: 'stress-budget', eventToProcessedSlots: 2, processedToConfirmedSlots: 6, providerMs: 1_000, blackouts: [] },
    stress: { status: 'stress-budget', eventToProcessedSlots: 4, processedToConfirmedSlots: 12, providerMs: 2_000, blackouts: [{ durationMs: 30_000 }, { durationMs: 60_000 }] },
  },
};

export const FILL_CONFIG: FillConfig = deepFreeze(VALUES);
