// Settings of research runs that are not owner limits: the S0 random control's universe window and execution terms,
// and the backtest feed's heartbeat. Versioned like the policy; the policy still supplies sizes, the hold time and
// the exit ladder. Nothing here is a constant of the code that reads it.
import type { MicroUsd } from '../units/index.ts';
import { usd } from './amounts.ts';
import { deepFreeze } from './freeze.ts';

const MINUTE = 60_000;

export interface ResearchConfig {
  readonly version: string;
  readonly s0: {
    /** Universe U2: graduates aged 60–240 min after migration (§3.2). */
    readonly u2WindowFromMs: number;
    readonly u2WindowToMs: number;
    /** Least accepted entry output below the local quote (§10: entry 2–3%). */
    readonly entryMinOutBelowBps: number;
    /** A blocked exit is tried again after this long, at most this many times. */
    readonly blockedRetryMs: number;
    readonly blockedRetries: number;
    /** No entry starts later than the data end minus the hold time and this margin, so every trade can finish. */
    readonly endMarginMs: number;
  };
  /** Blocks between heartbeat slot events while no intent is in flight. */
  readonly heartbeatBlocks: number;
  /**
   * The commitment the decision path waits for. 'confirmed' charges the processed → confirmed delay too (the harsher
   * choice until WORKER-1 settles the live path).
   */
  readonly decisionCommitment: 'processed' | 'confirmed';
  /**
   * The sealed holdout (DECISIONS: holdout in UTC data days; final form). Days from `fromDay` are reserved before
   * registration: research runs never touch them. The holdout admits entries before `entryCutoffDay` and observes
   * until `tailEndDay` (exclusive) so every position can finish; it is opened once, after the tail.
   */
  readonly holdout: {
    readonly fromDay: string;
    readonly entryCutoffDay: string;
    readonly tailEndDay: string;
    /** The local copy of the registry, relative to the repository root (ignored by the code branch). */
    readonly registryPath: string;
    /** The remote branch that holds the registry (survives fresh clones); every write is pushed there. */
    readonly registryRemote: string;
    readonly registryBranch: string;
    /** The only GitHub repository (`owner/name`) the registry remote may be. */
    readonly registryRepo: string;
  };
  /** Running costs charged against results, apart from the bankroll and per-trade costs. */
  readonly operating: {
    /** The Frankfurt VPS the owner approved (DECISIONS.md 2026-10-03, about US$6/month). */
    readonly hostingUsdPerMonth: MicroUsd;
    /**
     * Bankrolls the operating-cost line is also shown at (the owner intends US$100-200 after the proof). A projection
     * only: the policy's limits stay what the owner set.
     */
    readonly projectionBankrolls: readonly MicroUsd[];
  };
}

const VALUES: ResearchConfig = {
  version: 'research-2',
  s0: { u2WindowFromMs: 60 * MINUTE, u2WindowToMs: 240 * MINUTE, entryMinOutBelowBps: 300, blockedRetryMs: 10 * MINUTE, blockedRetries: 3, endMarginMs: 30 * MINUTE },
  heartbeatBlocks: 150,
  decisionCommitment: 'confirmed',
  holdout: { fromDay: '2026-09-22', entryCutoffDay: '2026-10-20', tailEndDay: '2026-10-21', registryPath: 'research/holdout/registry.json', registryRemote: 'origin', registryBranch: 'holdout-registry', registryRepo: 'macdarenz-droid/Meme-snipe' },
  operating: { hostingUsdPerMonth: usd('6'), projectionBankrolls: [usd('20'), usd('100'), usd('200')] },
};

export const RESEARCH_CONFIG: ResearchConfig = deepFreeze(VALUES);
