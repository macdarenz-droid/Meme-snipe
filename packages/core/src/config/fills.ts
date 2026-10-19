// Paper fill model parameters (docs/ARCHITECTURE.md §11), one versioned object like the policy. Promotion uses the
// conservative scenario only.
//
// Assumptions are harsh and documented until measurements justify a change (supervisor ruling after external review,
// DECISIONS "Backtest review fixes (BT-1c)"). Source and status of each:
//
// | Assumption                         | Source                                         | Status      | Refined from                            |
// |------------------------------------|------------------------------------------------|-------------|-----------------------------------------|
// | landPpm (base 0.66 / 0.49)         | §11 defaults (landing of pump trades)          | assumption  | observed-chain landing of comparable    |
// |   conservative 0.1 lower           | supervisor margin                              | assumption  | transactions in DATA-1, then the        |
// | landingSlots, landingTail          | §11 p50/p90 latency; tail is a stress margin   | assumption  | owner-authorised canary. The dry run    |
// | congestion (shared network state,  | stress budget; no measured congestion data     | assumption  | sends nothing, so it cannot refine      |
// |   activity term, provider failures)|                                                | assumption  | landing: these stay as set through it   |
// | dropPpm                            | stress margin                                  | assumption  |                                         |
// | exitRetryHaircutPpm                | proxy for sellers ahead of us                  | assumption  | exit fills of the canary                |
// | exitRetryHaircutWindowMs (10 min)  | supervisor ruling: one exit episode            | assumption  | exit fills of the canary                |
// | closeSuccessPpm, dustPpm           | none measured                                  | assumption  | no refinement source yet                |
// | delays.measured                    | today's base values (2 slots + 200 ms)         | unmeasured  | the worker recorder on the VPS          |
// | delays.adverse, delays.stress      | ruling values (2+6 slots + 1 s, 4+12 + 2 s)    | stress      | kept as stress budgets                  |
// | slippagePpm, takeProfit, rent flag | §11                                            | §11 rule    |                                         |
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

const VALUES: FillConfig = {
  version: 'fills-4',
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
  // What each stress field does (sources and status in the table at the top):
  // - dropPpm: share of misses that never reach a block (cost nothing, resolve only at expiry).
  // - landingTail: a few attempts land much later (leader skips, forwarding loss); some then expire.
  // - congestion: one persistent network state shared by every position and provider, whose entry probability rises
  //   with the previous window's market volume (never congestion on its own); landing falls and latency rises for
  //   every attempt at once; provider failures drop attempts on top.
  // - exitRetryHaircutPpm: each repeated exit on a position gets that much less, as other sellers drain the pool; only
  //   the position's exit sends in the last exitRetryHaircutWindowMs count (fills-4, EXIT-FILL-FIXES ruling).
  // - closeSuccessPpm, dustPpm: the atomic sell-and-close outcome that decides whether rent comes back.
  scenarios: {
    // Slots are about 0.3 s. Discovery: two free feeds, p50 within a second or two (§6.1, data.md §7).
    base: {
      name: 'base', landPpm: LAND, dropPpm: 300_000n,
      landingTail: { ppm: 30_000n, slots: [15, 30, 60] },
      congestion: { windowSlots: WINDOW, network: { enterPpm: 40_000n, activityEnterPpmPerSol: 500n, maxEnterPpm: 200_000n, stayPpm: 600_000n }, providerFailPpm: 5_000n, landFactorPpm: 600_000n, extraLandingSlots: 8 },
      exitRetryHaircutPpm: 25_000n, exitRetryHaircutWindowMs: 10 * 60_000,
      delay: 'measured',
      discoverySlots: [2, 3, 4, 5, 8], landingSlots: [1, 2, 2, 3, 4],
      confirmSlots: 2, finalizeSlots: 32, slippagePpm: 1_000_000n, takeProfit: 'wick',
      closeSuccessPpm: 950_000n, dustPpm: 20_000n,
    },
    // p90 latency (a Jupiter-recent fallback is about 5 s), slippage x1.5, close-based take-profit; the rent comes back per
    // its own close outcome, like every scenario (RENT-1: the no-recovery line is a reported sensitivity, not a scenario).
    conservative: {
      name: 'conservative', landPpm: LAND_LOW, dropPpm: 200_000n,
      landingTail: { ppm: 50_000n, slots: [30, 60, 120] },
      congestion: { windowSlots: WINDOW, network: { enterPpm: 60_000n, activityEnterPpmPerSol: 1_000n, maxEnterPpm: 400_000n, stayPpm: 750_000n }, providerFailPpm: 20_000n, landFactorPpm: 400_000n, extraLandingSlots: 20 },
      exitRetryHaircutPpm: 50_000n, exitRetryHaircutWindowMs: 10 * 60_000,
      delay: 'adverse',
      discoverySlots: [17], landingSlots: [6],
      confirmSlots: 2, finalizeSlots: 32, slippagePpm: 1_500_000n, takeProfit: 'close',
      closeSuccessPpm: 900_000n, dustPpm: 50_000n,
    },
    optimistic: {
      name: 'optimistic', landPpm: LAND_HIGH, dropPpm: 400_000n,
      landingTail: { ppm: 10_000n, slots: [8, 15] },
      congestion: { windowSlots: WINDOW, network: { enterPpm: 10_000n, activityEnterPpmPerSol: 200n, maxEnterPpm: 100_000n, stayPpm: 500_000n }, providerFailPpm: 1_000n, landFactorPpm: 800_000n, extraLandingSlots: 2 },
      exitRetryHaircutPpm: 10_000n, exitRetryHaircutWindowMs: 10 * 60_000,
      delay: 'measured',
      discoverySlots: [1, 2], landingSlots: [1],
      confirmSlots: 2, finalizeSlots: 32, slippagePpm: 1_000_000n, takeProfit: 'wick',
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
