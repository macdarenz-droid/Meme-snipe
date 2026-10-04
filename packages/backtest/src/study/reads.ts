// Read latency and read budget for the backtest's staged evaluation (FACTS-1 staging; supervisor ruling: no optimistic
// defaults). The budget is the live worker's own configuration, imported, never copied. The latencies are conservative
// named figures until the live dry run measures p95s; each source is in docs/DECISIONS.md.
import { ASSUMPTIONS } from '../../../worker/src/facts/budget.ts';
import { HOLDER_SCANS_PER_DAY } from '../../../worker/src/facts/readers.ts';
import { DEFAULT_LIVE_FEED } from '../../../worker/src/providers/live-feed.ts';

export interface ReadLatency {
  /** Stage 2: mint, pool and LP accounts and the cross-checks. */
  readonly accountsMs: number;
  /** Stage 3: the complete holder scan (and the funders read with it). */
  readonly holderScanMs: number;
  /** A read's answer reaches the engine only when the live feed releases its slot. */
  readonly feedReleaseMs: number;
}

/**
 * Account and largest-holder reads 500 ms; the complete holder scan 5,000 ms (gpa-probe: 4.3 s for a 569k-account
 * legacy scan; Token-2022 0.07–0.26 s); plus the live feed's longest release hold (`DEFAULT_LIVE_FEED.staleReleaseMs`).
 */
export const READ_LATENCY: ReadLatency = { accountsMs: 500, holderScanMs: 5_000, feedReleaseMs: DEFAULT_LIVE_FEED.staleReleaseMs };

export interface ReadLimits {
  /** Complete holder scans allowed per UTC day; reached, H12/H13 abstain ("not evaluated"). */
  readonly holderScansPerUtcDay: number;
  /** At most one read of each kind per mint in this window. */
  readonly minReadGapMs: number;
}

/** The live caps: FACTS-1's `HOLDER_SCANS_PER_DAY` and one evaluation (read round) per mint per minute. */
export const READ_LIMITS: ReadLimits = { holderScansPerUtcDay: HOLDER_SCANS_PER_DAY, minReadGapMs: 60_000 / ASSUMPTIONS.evaluationsPerMinute };

/** When stage-2 and stage-3 answers land after a check at `atMs`. */
export const landings = (atMs: number, l: ReadLatency): { readonly stage2: number; readonly stage3: number } => {
  const stage2 = atMs + l.accountsMs + l.feedReleaseMs;
  return { stage2, stage3: stage2 + l.holderScanMs + l.feedReleaseMs };
};
