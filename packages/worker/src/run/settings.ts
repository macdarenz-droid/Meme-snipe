// The worker's trading settings, all from versioned configuration: the locked policy (owner limits), the fill config
// (network terms, paper scenarios) and the research config (U2's window). Nothing here is a limit of its own.
import type { FillConfig, Policy, ResearchConfig } from '../../../core/src/config/index.ts';
import type { FillScenario } from '../../../core/src/fills/index.ts';
import { PPM } from '../../../core/src/costs/index.ts';
import type { StrategyConfig } from '../engine/strategy.ts';

/** The paper fill scenario: conservative (the safe side) until the dry run measures our own latency (§11). */
export const PAPER_SCENARIO = 'conservative';

export const strategyConfig = (policy: Policy, fills: FillConfig, research: ResearchConfig, edgePpm: bigint = 0n): StrategyConfig => {
  const net = fills.network;
  const s: FillScenario = fills.scenarios[PAPER_SCENARIO];
  const fail = PPM - s.landPpm.pumpswap;
  const steps = policy.exits.ladder.steps;
  return {
    version: `paper-u2-0.${research.version}.${fills.version}`,
    universe: 'U2',
    windowFromMs: research.s0.u2WindowFromMs,
    windowToMs: research.s0.u2WindowToMs,
    entryMinOutBelowBps: research.s0.entryMinOutBelowBps,
    // No edge is proven yet: risk refuses every entry until research registers one (CLAUDE.md, "zeroed trades only
    // when the data proves the setup").
    edgePpm,
    medianTargetBps: policy.exits.partialAtGainBps,
    takeProfitOn: s.takeProfit,
    network: {
      signaturesPerTx: net.signaturesPerTx, baseFeePerSignature: net.baseFeePerSignature, entryPriorityFee: net.entryPriorityFee,
      exitPriorityFee: steps[0]!.priorityFeeLamports, tip: net.tip, entryFailurePpm: fail, exitFailurePpm: fail,
    },
    // A full exit closes the token account in the same transaction (TX-1 `closeTokenAccount`), so its rent comes back;
    // one-time accounts (volume accumulators) are paid once per wallet, not per trade; the WSOL account is transient.
    rent: { tokenAccount: net.tokenAccountRent, tokenAccountClosedOnExit: true, oneTime: 0n, transient: net.tokenAccountRent },
    blockhashValidBlocks: net.blockhashValidBlocks,
    evaluateEveryMs: policy.gates.maxQuoteAgeMs,
    barMs: policy.exits.atrBarMs,
    keepBars: policy.exits.atrPeriod * 4,
  };
};
