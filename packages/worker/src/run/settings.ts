// The worker's trading settings, all from versioned configuration: the locked policy (owner limits), the fill config
// (network terms, paper scenarios) and the research config (U2's window). Nothing here is a limit of its own.
import { type FillConfig, type Policy, type ResearchConfig, exitsFor } from '../../../core/src/config/index.ts';
import type { FillScenario } from '../../../core/src/fills/index.ts';
import { PPM } from '../../../core/src/costs/index.ts';
import { MAX_CREATED_ACCOUNT_BYTES, USER_VOLUME_ACCUMULATOR_SIZE, rentExempt } from '../../../core/src/tx/rent.ts';
import { CREATE_KEEP_MS, type StrategyConfig } from '../engine/strategy.ts';
import { CONFIRM_LAG_SLOTS } from '../../../core/src/facts/index.ts';

/** The paper fill scenario: conservative (the safe side) until the dry run measures our own latency (§11). */
export const PAPER_SCENARIO = 'conservative';

/**
 * `entry.timing`: `gates` enters once the gates and risk pass in the window; `random` is S0, the random-entry control
 * (docs/ARCHITECTURE.md §3.2): each candidate's entry moment is drawn in its window from a hash of `entry.salt` and the
 * mint (fixed and journaled before any entry), and the same gates, risk and exits then apply from that moment.
 */
export const strategyConfig = (
  policy: Policy, fills: FillConfig, research: ResearchConfig, edgePpm: bigint = 0n,
  entry: { readonly timing: 'gates' | 'random'; readonly salt: string; readonly s0Diagnostic?: boolean } = { timing: 'gates', salt: '' },
): StrategyConfig => {
  const net = fills.network;
  const s: FillScenario = fills.scenarios[PAPER_SCENARIO];
  const fail = PPM - s.landPpm.pumpswap;
  const steps = policy.exits.ladder.steps;
  return {
    version: `${entry.timing === 'random' ? 's0' : 'paper'}-u2-0.${research.version}.${fills.version}`,
    universe: 'U2',
    entryTiming: entry.timing,
    entrySalt: entry.salt,
    s0Diagnostic: entry.timing === 'random' && entry.s0Diagnostic === true,
    windowFromMs: research.s0.u2WindowFromMs,
    windowToMs: research.s0.u2WindowToMs,
    entryMinOutBelowBps: research.s0.entryMinOutBelowBps,
    // No edge is proven yet: risk refuses every entry until research registers one (CLAUDE.md, "zeroed trades only
    // when the data proves the setup").
    edgePpm,
    medianTargetBps: exitsFor(policy.exits, 'U2').partialAtGainBps,
    takeProfitOn: s.takeProfit,
    network: {
      signaturesPerTx: net.signaturesPerTx, baseFeePerSignature: net.baseFeePerSignature, entryPriorityFee: net.entryPriorityFee,
      exitPriorityFee: steps[0]!.priorityFeeLamports, tip: net.tip, entryFailurePpm: fail, exitFailurePpm: fail,
    },
    // A full exit closes the token account in the same transaction (TX-1 `closeTokenAccount`), so its rent comes back;
    // the WSOL account is transient. One-time accounts (the volume accumulator) are paid once per wallet: the decision
    // takes them from the paper wallet's state (`AccountFact.oneTimeRent`): paid at the wallet's setup, 0 after it.
    rent: { tokenAccount: net.tokenAccountRent, tokenAccountClosedOnExit: true, oneTime: oneTimeRent(fills), transient: net.tokenAccountRent },
    blockhashValidBlocks: net.blockhashValidBlocks,
    evaluateEveryMs: policy.gates.maxQuoteAgeMs,
    confirmLagSlots: CONFIRM_LAG_SLOTS,
    barMs: exitsFor(policy.exits, 'U2').atrBarMs,
    // Mainnet's slot target is 350 ms since epoch 1020 (August 2026; 400 ms from genesis, about 360 ms measured after the
    // change); 500 ms bounds the mean from above, so a fill dated from its slot is never dated later than it happened.
    maxSlotMs: 500,
    keepBars: exitsFor(policy.exits, 'U2').atrPeriod * 4,
    // REC-1 (supervisor ruling): at most 3 rejected candidates' pools watched past their window at once (Helius cost).
    maxTails: 3,
    createKeepMs: CREATE_KEEP_MS,
  };
};

/**
 * Rent of the one-time accounts a fresh wallet still lacks: the venue's user volume accumulator (137 bytes), created by
 * its first buy and never closed. At the configured rate (the token-account figure is 170 bytes at that rate).
 */
export const oneTimeRent = (fills: FillConfig): bigint =>
  rentExempt(USER_VOLUME_ACCUMULATOR_SIZE, { lamportsPerByte: fills.network.tokenAccountRent / (128n + BigInt(MAX_CREATED_ACCOUNT_BYTES)) });
