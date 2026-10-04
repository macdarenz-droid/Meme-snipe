// Rejects inconsistent policies. Returns every problem found, so a bad file is fixed in one pass.
import { EXIT_UNIVERSES, TRIAL_POLICY, type Policy } from './policy.ts';
import { MINUTE_MS } from './time.ts';

/** Phase 1 (§9): no position is held past 120 min. A hard check, so the cap never rests on the baselines alone. */
export const PHASE1_T_MAX_MS = 120 * MINUTE_MS;

/** Structural check against the trial policy: same keys, same value types, lists of the same kind. */
const shapeIssues = (template: unknown, value: unknown, path: string, out: string[]): void => {
  if (Array.isArray(template)) {
    if (!Array.isArray(value)) { out.push(`${path}: must be a list`); return; }
    if (value.length === 0) out.push(`${path}: must not be empty`);
    for (let i = 0; i < value.length; i++) shapeIssues(template[0], value[i], `${path}[${i}]`, out);
    return;
  }
  if (typeof template === 'object' && template !== null) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) { out.push(`${path}: must be an object`); return; }
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) { out.push(`${path}: must be a plain object`); return; }
    const t = template as Record<string, unknown>;
    const v = value as Record<string, unknown>;
    // Own keys only: a field supplied through the prototype chain is not a field.
    for (const k of Object.keys(t)) {
      if (!Object.hasOwn(v, k)) out.push(`${path}.${k}: missing`);
      else shapeIssues(t[k], v[k], `${path}.${k}`, out);
    }
    for (const k of Object.keys(v)) if (!Object.hasOwn(t, k)) out.push(`${path}.${k}: unknown field`);
    return;
  }
  if (typeof value !== typeof template) out.push(`${path}: must be a ${typeof template}, got ${typeof value}`);
};

/** Every number and bigint leaf: integers, never negative (the signed regime floor is the one exception). */
const rangeIssues = (value: unknown, path: string, out: string[]): void => {
  if (typeof value === 'bigint') { if (value < 0n) out.push(`${path}: must not be negative`); return; }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) out.push(`${path}: must be a whole number`);
    else if (value < 0 && path !== 'policy.regime.solChange24hFloorBps') out.push(`${path}: must not be negative`);
    return;
  }
  if (Array.isArray(value)) { value.forEach((v, i) => rangeIssues(v, `${path}[${i}]`, out)); return; }
  if (typeof value === 'object' && value !== null) for (const [k, v] of Object.entries(value)) rangeIssues(v, `${path}.${k}`, out);
};

const BPS_FIELDS: readonly (readonly [string, (p: Policy) => number])[] = [
  ['capital.drawdownResetBps', (p) => p.capital.drawdownResetBps],
  ['loss.plannedRiskBps', (p) => p.loss.plannedRiskBps],
  ['loss.stopMaxBps', (p) => p.loss.stopMaxBps],
  ['loss.dailyBps', (p) => p.loss.dailyBps],
  ['loss.weeklyBps', (p) => p.loss.weeklyBps],
  ['loss.killSwitchFloorBps', (p) => p.loss.killSwitchFloorBps],
  ['liquidity.maxImpactBps', (p) => p.liquidity.maxImpactBps],
  ['costGate.maxRoundTripBps', (p) => p.costGate.maxRoundTripBps],
  ['costGate.maxShareOfMedianTargetBps', (p) => p.costGate.maxShareOfMedianTargetBps],
  ['gates.hardHolderBps', (p) => p.gates.hardHolderBps],
  ['gates.singleHolderBps', (p) => p.gates.singleHolderBps],
  ['gates.top10Bps', (p) => p.gates.top10Bps],
  ['gates.insiderBps', (p) => p.gates.insiderBps],
  ['gates.devClusterBps', (p) => p.gates.devClusterBps],
  ['exits.deployerSellSupplyBps', (p) => p.exits.deployerSellSupplyBps],
  ['exits.liquidityDropBps', (p) => p.exits.liquidityDropBps],
  ['exits.universes.U1.partialMinShareBps', (p) => p.exits.universes.U1.partialMinShareBps],
  ['exits.universes.U2.partialMinShareBps', (p) => p.exits.universes.U2.partialMinShareBps],
  ['exits.ladder.steps[].minOutBelowTriggerBps (max)', (p) => Math.max(...p.exits.ladder.steps.map((s) => s.minOutBelowTriggerBps))],
];

const crossIssues = (p: Policy, out: string[]): void => {
  const need = (ok: boolean, message: string): void => { if (!ok) out.push(message); };
  const { capital: c, positions, loss, liquidity, gates, exits, regime } = p;

  need(c.bankroll > 0n, 'capital.bankroll: must be above zero');
  need(c.minNotional > 0n, 'capital.minNotional: must be above zero');
  need(c.minNotional <= c.maxNotional, 'capital.minNotional is larger than capital.maxNotional');
  need(c.maxNotional <= c.bankroll, 'capital.maxNotional is larger than the bankroll');

  need(positions.maxOpen >= 1, 'positions.maxOpen: must be at least 1');
  need(positions.maxEntriesPerDay >= 1, 'positions.maxEntriesPerDay: must be at least 1');
  need(positions.maxEntriesPerMintPerDay >= 1, 'positions.maxEntriesPerMintPerDay: must be at least 1');
  need(positions.maxEntriesPerMintPerDay <= positions.maxEntriesPerDay, 'positions.maxEntriesPerMintPerDay is larger than maxEntriesPerDay');

  need(loss.dailyBps > 0, 'loss.dailyBps: must be above zero');
  need(loss.dailyBps <= loss.weeklyBps, 'loss.dailyBps (daily loss) is larger than loss.weeklyBps');
  need(loss.plannedRiskBps > 0 && loss.plannedRiskBps <= loss.dailyBps, 'loss.plannedRiskBps must be above zero and no larger than the daily loss');
  need(loss.stopMaxBps > 0, 'loss.stopMaxBps: must be above zero');
  need(loss.killSwitchFloorBps > 0 && loss.killSwitchFloorBps < 10_000, 'loss.killSwitchFloorBps must be between 1 and 9,999');
  need(10_000 - loss.killSwitchFloorBps >= loss.weeklyBps, 'loss.weeklyBps is larger than the room above the kill-switch floor');
  need(loss.cooldownAfterLosses >= 1 && loss.cooldownAfterLosses < loss.pauseDayAfterLosses, 'loss.cooldownAfterLosses must be at least 1 and below pauseDayAfterLosses');
  need(loss.reviewLosses <= loss.reviewWindowTrades, 'loss.reviewLosses is larger than loss.reviewWindowTrades');

  need(liquidity.floorNotionalMultiple >= 1, 'liquidity.floorNotionalMultiple: must be at least 1');
  need(liquidity.u1FloorUsd >= liquidity.floorUsd, 'liquidity.u1FloorUsd is lower than liquidity.floorUsd');
  need(liquidity.maxImpactBps > 0, 'liquidity.maxImpactBps: must be above zero');

  need(p.costGate.maxRoundTripBps > 0, 'costGate.maxRoundTripBps: must be above zero');
  need(p.costGate.maxShareOfMedianTargetBps > 0, 'costGate.maxShareOfMedianTargetBps: must be above zero');

  need(regime.volumePercentile >= 1 && regime.volumePercentile <= 99, 'regime.volumePercentile must be between 1 and 99');
  need(regime.volumeLagDays >= 1, 'regime.volumeLagDays: must be at least 1 (the current UTC day is never complete)');
  need(regime.volumeMinDays >= 1 && regime.volumeMinDays <= regime.volumeWindowDays, 'regime.volumeMinDays must be between 1 and regime.volumeWindowDays');
  need(regime.solChange24hFloorBps >= -10_000 && regime.solChange24hFloorBps <= 10_000, 'regime.solChange24hFloorBps must be between -10,000 and 10,000');
  need(regime.failedChecksToDisable >= 1, 'regime.failedChecksToDisable: must be at least 1');

  need(gates.singleHolderBps <= gates.hardHolderBps, 'gates.singleHolderBps is larger than gates.hardHolderBps');
  need(gates.singleHolderBps <= gates.top10Bps, 'gates.singleHolderBps is larger than gates.top10Bps');
  need(gates.devClusterBps <= gates.insiderBps, 'gates.devClusterBps is larger than gates.insiderBps');
  need(gates.deployerRugLookbackDays >= 1, 'gates.deployerRugLookbackDays: must be at least 1');
  need(gates.maxQuoteAgeMs > 0, 'gates.maxQuoteAgeMs: must be above zero');

  need(exits.maxExitTxAtMinNotional >= 1 && exits.maxExitTxAtMinNotional <= exits.maxExitTxAboveDoubleMin, 'exits.maxExitTxAtMinNotional must be at least 1 and no larger than maxExitTxAboveDoubleMin');
  need(exits.negativeFlowMinutes >= 1, 'exits.negativeFlowMinutes: must be at least 1');
  need(exits.tMaxCapMs <= PHASE1_T_MAX_MS, `exits.tMaxCapMs is above the phase-1 hard maximum of ${PHASE1_T_MAX_MS} ms`);
  for (const u of EXIT_UNIVERSES) {
    need(exits.universes[u].tMaxMs <= PHASE1_T_MAX_MS, `exits.universes.${u}.tMaxMs is above the phase-1 hard maximum of ${PHASE1_T_MAX_MS} ms`);
    const x = exits.universes[u];
    const at = `exits.universes.${u}`;
    need(x.tMaxMs <= exits.tMaxCapMs, `${at}.tMaxMs is above exits.tMaxCapMs, the phase-1 hard maximum`);
    need(x.tFlatMs > 0 && x.tFlatMs <= x.tMaxMs, `${at}.tFlatMs must be above zero and no later than ${at}.tMaxMs`);
    need(x.stopAtrTenths >= 1 && x.trailAtrTenths >= 1, `${at}.stopAtrTenths and ${at}.trailAtrTenths: must be at least 1`);
    need(x.partialMinShareBps > 0, `${at}.partialMinShareBps: must be above zero`);
    need(x.partialAtRBps > 0 && x.partialAtGainBps > 0, `${at}.partialAtRBps and ${at}.partialAtGainBps: must be above zero`);
    need(x.atrPeriod >= 1 && x.atrBarMs > 0, `${at}.atrPeriod and ${at}.atrBarMs: must be above zero`);
  }
  need(exits.blockedRetryMs > 0, 'exits.blockedRetryMs: must be above zero');

  const { steps, maxAttempts, maxFeePerAttempt } = exits.ladder;
  need(steps.length >= 1, 'exits.ladder.steps: needs at least one step');
  need(maxAttempts >= steps.length, 'exits.ladder.maxAttempts is lower than the number of steps');
  need(p.reserve.exitAttempts >= maxAttempts, 'reserve.exitAttempts does not cover exits.ladder.maxAttempts');
  need(maxFeePerAttempt > 0n, 'exits.ladder.maxFeePerAttempt: must be above zero');
  steps.forEach((step, i) => {
    // A zero fee or zero slippage allowance can stop an exit landing, so no rung may have one.
    need(step.priorityFeeLamports > 0n, `exits.ladder.steps[${i}].priorityFeeLamports: must be above zero`);
    need(step.minOutBelowTriggerBps > 0, `exits.ladder.steps[${i}].minOutBelowTriggerBps: must be above zero`);
    need(step.priorityFeeLamports <= maxFeePerAttempt, `exits.ladder.steps[${i}] fee is above exits.ladder.maxFeePerAttempt`);
    const prev = steps[i - 1];
    if (prev) need(step.priorityFeeLamports >= prev.priorityFeeLamports && step.minOutBelowTriggerBps >= prev.minOutBelowTriggerBps, `exits.ladder.steps[${i}] is milder than the step before it`);
  });
};

/** All problems with a candidate policy; an empty list means it is consistent. */
export const policyIssues = (candidate: unknown): string[] => {
  const out: string[] = [];
  shapeIssues(TRIAL_POLICY, candidate, 'policy', out);
  if (out.length > 0) return out;
  rangeIssues(candidate, 'policy', out);
  const p = candidate as Policy;
  if (p.schemaVersion !== TRIAL_POLICY.schemaVersion) out.push(`policy.schemaVersion: expected ${TRIAL_POLICY.schemaVersion}, got ${p.schemaVersion}`);
  for (const [name, read] of BPS_FIELDS) if (read(p) > 10_000) out.push(`${name}: basis points cannot exceed 10,000`);
  if (out.length > 0) return out;
  crossIssues(p, out);
  return out;
};

export class PolicyError extends Error {
  readonly issues: readonly string[];
  constructor(issues: readonly string[]) {
    super(`Invalid policy: ${issues.join('; ')}`);
    this.name = 'PolicyError';
    this.issues = issues;
  }
}

/** Throws PolicyError listing every problem; returns the policy when it is consistent. */
export const assertValidPolicy = (candidate: unknown): Policy => {
  const issues = policyIssues(candidate);
  if (issues.length > 0) throw new PolicyError(issues);
  return candidate as Policy;
};
