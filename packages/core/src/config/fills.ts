// Paper fill model parameters (docs/ARCHITECTURE.md §11), one versioned object like the policy. These are model
// defaults until our own landing and latency data exist ("Measured during paper mode", §21); the dry run replaces them.
// Promotion uses the conservative scenario only.
import type { FillNetwork, FillScenario, ScenarioName } from '../fills/index.ts';
import { lamports } from '../units/index.ts';
import { deepFreeze } from './freeze.ts';

export interface FillConfig {
  readonly version: string;
  readonly network: FillNetwork;
  readonly scenarios: Readonly<Record<ScenarioName, FillScenario>>;
}

// Landing defaults from §11 (0.66 PumpSwap, 0.49 curve), in ppm.
const LAND = { pumpswap: 660_000n, 'pump-curve': 490_000n } as const;

const VALUES: FillConfig = {
  version: 'fills-1',
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
  // Observation delay (provisional until FEED-1 and the recorder measure it): every swap, lifecycle event and regime
  // change reaches the engine `observationSlots` after its own slot plus `receiptMs`. Confirmed commitment trails the
  // processed tip by about 1-2 slots; the conservative case adds a slot and half a second of receipt and decoding.
  scenarios: {
    // Slots are about 0.3 s. Discovery: two free feeds, p50 within a second or two (§6.1, data.md §7).
    base: {
      name: 'base', landPpm: LAND, dropPpm: 0n, observationSlots: 2, receiptMs: 200,
      discoverySlots: [2, 3, 4, 5, 8], landingSlots: [1, 2, 2, 3, 4],
      confirmSlots: 2, finalizeSlots: 32, slippagePpm: 1_000_000n, takeProfit: 'wick', rentRecovery: true,
    },
    // p90 latency (a Jupiter-recent fallback is about 5 s), slippage x1.5, close-based take-profit, no rent recovery.
    conservative: {
      name: 'conservative', landPpm: LAND, dropPpm: 0n, observationSlots: 3, receiptMs: 500,
      discoverySlots: [17], landingSlots: [6],
      confirmSlots: 2, finalizeSlots: 32, slippagePpm: 1_500_000n, takeProfit: 'close', rentRecovery: false,
    },
    optimistic: {
      name: 'optimistic', landPpm: LAND, dropPpm: 0n, observationSlots: 1, receiptMs: 50,
      discoverySlots: [1, 2], landingSlots: [1],
      confirmSlots: 2, finalizeSlots: 32, slippagePpm: 1_000_000n, takeProfit: 'wick', rentRecovery: true,
    },
  },
};

export const FILL_CONFIG: FillConfig = deepFreeze(VALUES);
