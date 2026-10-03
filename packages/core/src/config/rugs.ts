// The rug definition H14 reads through our deployer index (RUG-1, docs/DECISIONS.md "Rug labels"). Versioned like the
// policy; every label carries the version that made it. Lower thresholds and longer windows label more mints, which
// is the safe side for H14. Nothing here is a constant of the labeller.
import { DAY_MS } from './time.ts';
import { deepFreeze } from './freeze.ts';

export interface RugConfig {
  readonly version: string;
  /** The creator (or the launch signer) sold at least this share of total supply, in bps, within the window. */
  readonly creatorDump: { readonly supplyBps: number; readonly windowMs: number };
  /** Quote liquidity fell at least this far below its peak since launch, in bps of the peak, within the window. */
  readonly collapse: { readonly dropBps: number; readonly windowMs: number };
}

const VALUES: RugConfig = {
  version: 'rugs-1',
  // R9's deployer-sale exit (risk.md, ARCHITECTURE §9, policy exits.deployerSellSupplyBps).
  creatorDump: { supplyBps: 200, windowMs: DAY_MS },
  // The TVL −99% label of Li et al., arXiv 2608.20271.
  collapse: { dropBps: 9_900, windowMs: DAY_MS },
};

export const RUG_CONFIG: RugConfig = deepFreeze(VALUES);

/** The on-demand check of one deployer's prior mints (RUG-1c). Operational limits, versioned apart from the definition. */
export interface RugCheckConfig {
  readonly version: string;
  /** RPC credits one candidate's check may use; past it, the mints not yet read are unfetched (H14 not covered). */
  readonly creditCapPerCandidate: number;
  /** H14 accepts a check at most this many slots behind the decision. */
  readonly maxLagSlots: number;
}

const CHECK_VALUES: RugCheckConfig = {
  version: 'rug-check-1',
  creditCapPerCandidate: 2_000,
  maxLagSlots: 150,
};

export const RUG_CHECK_CONFIG: RugCheckConfig = deepFreeze(CHECK_VALUES);

/** Problems with a rug check config; empty when it is usable. */
export const rugCheckConfigIssues = (c: RugCheckConfig): string[] => {
  const issues: string[] = [];
  if (typeof c.version !== 'string' || c.version.length === 0) issues.push('version must be a non-empty string');
  if (!Number.isSafeInteger(c.creditCapPerCandidate) || c.creditCapPerCandidate < 1) issues.push('creditCapPerCandidate must be a positive integer');
  if (!Number.isSafeInteger(c.maxLagSlots) || c.maxLagSlots < 0) issues.push('maxLagSlots must be a non-negative integer');
  return issues;
};

/** Problems with a rug config; empty when it is usable. */
export const rugConfigIssues = (c: RugConfig): string[] => {
  const issues: string[] = [];
  if (typeof c.version !== 'string' || c.version.length === 0) issues.push('version must be a non-empty string');
  const bps = (name: string, v: number) => {
    if (!Number.isInteger(v) || v < 1 || v > 10_000) issues.push(`${name} must be an integer 1..10000`);
  };
  const duration = (name: string, v: number) => {
    if (!Number.isSafeInteger(v) || v < 1) issues.push(`${name} must be a positive integer of milliseconds`);
  };
  bps('creatorDump.supplyBps', c.creatorDump.supplyBps);
  duration('creatorDump.windowMs', c.creatorDump.windowMs);
  bps('collapse.dropBps', c.collapse.dropBps);
  duration('collapse.windowMs', c.collapse.windowMs);
  return issues;
};
