// Tighten-only overrides. The engine may ask for a stricter policy, never a looser one (CLAUDE.md: code can only
// load or tighten limits). Raising a cap or lowering a floor needs a new policy version made outside the engine.
import { deepFreeze } from './freeze.ts';
import { policyHash } from './hash.ts';
import type { Policy, UniverseExits } from './policy.ts';
import { policyIssues } from './validate.ts';

/**
 * How a field may move in an override:
 * - max: a cap or trigger. It may fall, never rise (a lower number is stricter).
 * - min: a floor. It may rise, never fall.
 * - locked: not a risk limit (a window, a share, an attempt count), or part of the exit path (fees, priority-fee
 *   ceilings, min-out and the emergency rung), where a lower number can stop an exit landing. Any change needs a new version.
 * - free: a label.
 */
export type Rule = 'max' | 'min' | 'locked' | 'free';

export type RuleTree<T> = T extends bigint | number | string
  ? Rule
  : T extends readonly (infer U)[] ? RuleTree<U> : { readonly [K in keyof T]-?: RuleTree<T[K]> };

const UNIVERSE_EXIT_RULES: RuleTree<UniverseExits> = {
  stopAtrTenths: 'max',
  tFlatMs: 'max',
  flatMinRBps: 'min',
  tMaxMs: 'max',
  partialMinShareBps: 'locked',
  partialAtRBps: 'locked',
  partialAtGainBps: 'locked',
  atrPeriod: 'locked',
  atrBarMs: 'locked',
  trailAtrTenths: 'max',
};

/** One rule for every field. A new Policy field without a rule here fails to compile. */
export const POLICY_RULES: RuleTree<Policy> = {
  schemaVersion: 'locked',
  name: 'free',
  capital: { bankroll: 'max', minNotional: 'max', maxNotional: 'max', drawdownResetBps: 'max' },
  positions: { maxOpen: 'max', maxEntriesPerDay: 'max', maxEntriesPerMintPerDay: 'max', reentryBlockMs: 'min' },
  reserve: { opsFloor: 'min', exitAttempts: 'min' },
  loss: {
    plannedRiskBps: 'max',
    stopMaxBps: 'max',
    dailyBps: 'max',
    weeklyBps: 'max',
    killSwitchFloorBps: 'min',
    cooldownAfterLosses: 'max',
    cooldownMs: 'min',
    pauseDayAfterLosses: 'max',
    reviewWindowTrades: 'min',
    reviewLosses: 'max',
  },
  liquidity: { floorUsd: 'min', floorNotionalMultiple: 'min', u1FloorUsd: 'min', maxImpactBps: 'max' },
  costGate: { maxRoundTripBps: 'max', maxShareOfMedianTargetBps: 'max' },
  regime: {
    survivalReserveFloor: 'min',
    survivalAfterMs: 'locked',
    survivalMedianDays: 'locked',
    volumePercentile: 'min',
    volumeWindowDays: 'locked',
    solChange24hFloorBps: 'min',
    failedChecksToDisable: 'max',
  },
  gates: {
    dustPoolMinAtMigration: 'min',
    instantGraduationMinMs: 'min',
    excludedWindowMs: 'min',
    chaseCheckAfterMs: 'locked',
    chaseMaxAboveMigrationBps: 'max',
    candleSpikeBps: 'max',
    candleWindowMs: 'locked',
    hardHolderBps: 'max',
    singleHolderBps: 'max',
    top10Bps: 'max',
    insiderBps: 'max',
    devClusterBps: 'max',
    serialMaxMints24h: 'max',
    deployerRugLookbackDays: 'min',
    maxStateSlotLag: 'max',
    maxQuoteAgeMs: 'max',
  },
  exits: {
    // Checked per universe against the same universe's block in the baseline.
    universes: { U1: UNIVERSE_EXIT_RULES, U2: UNIVERSE_EXIT_RULES },
    tMaxCapMs: 'max',
    deployerSellSupplyBps: 'max',
    liquidityDropBps: 'max',
    reverseQuoteFailures: 'max',
    negativeFlowMinutes: 'max',
    maxExitTxAtMinNotional: 'locked',
    maxExitTxAboveDoubleMin: 'locked',
    ladder: {
      // The exit path is never loosened or tightened by an override: lower fees or slippage can stop an exit landing.
      steps: { priorityFeeLamports: 'locked', minOutBelowTriggerBps: 'locked' },
      maxAttempts: 'locked',
      maxFeePerAttempt: 'locked',
    },
    // Part of the exit path: fewer retries can strand a position, more spend the fee reserve.
    blockedRetryMs: 'locked',
    blockedRetryAttempts: 'locked',
  },
};

export type PolicyOverride = DeepPartial<Policy>;
type DeepPartial<T> = T extends bigint | number | string | boolean | readonly unknown[]
  ? T
  : { readonly [K in keyof T]?: DeepPartial<T[K]> };

export interface Refusal {
  /** loosens: raises a cap or lowers a floor. locked: not changeable by override. invalid: not a consistent policy. */
  readonly kind: 'loosens' | 'locked' | 'unknown-field' | 'wrong-type' | 'invalid';
  readonly path: string;
  readonly reason: string;
}

export interface Change {
  readonly path: string;
  readonly from: bigint | number | string;
  readonly to: bigint | number | string;
}

export type OverrideResult =
  | { readonly ok: true; readonly policy: Policy; readonly versionHash: string; readonly changes: readonly Change[] }
  | { readonly ok: false; readonly refusals: readonly Refusal[] };

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

// Objects are built with fromEntries, which defines own properties: a "__proto__" key stays a plain (and refused) field.
const merge = (base: unknown, patch: unknown): unknown => {
  if (isObject(base) && isObject(patch)) {
    const entries = Object.entries(base).map(([k, v]): [string, unknown] => [k, Object.hasOwn(patch, k) ? merge(v, patch[k]) : v]);
    for (const [k, v] of Object.entries(patch)) if (!Object.hasOwn(base, k)) entries.push([k, v]);
    return Object.fromEntries(entries);
  }
  return patch === undefined ? base : patch;
};

const walk = (rule: unknown, cur: unknown, next: unknown, path: string, refusals: Refusal[], changes: Change[]): void => {
  if (typeof rule === 'string') {
    if (typeof cur !== typeof next) { refusals.push({ kind: 'wrong-type', path, reason: `${path}: expected ${typeof cur}, got ${typeof next}` }); return; }
    if (next === cur || rule === 'free') {
      if (next !== cur) changes.push({ path, from: cur as string, to: next as string });
      return;
    }
    const a = cur as bigint | number;
    const b = next as bigint | number;
    if (rule === 'locked') refusals.push({ kind: 'locked', path, reason: `${path}: cannot change by override (${a} to ${b}); needs a new policy version` });
    else if (rule === 'max' && b > a) refusals.push({ kind: 'loosens', path, reason: `${path}: raises a cap from ${a} to ${b}` });
    else if (rule === 'min' && b < a) refusals.push({ kind: 'loosens', path, reason: `${path}: lowers a floor from ${a} to ${b}` });
    else changes.push({ path, from: a, to: b });
    return;
  }
  if (Array.isArray(cur)) {
    if (!Array.isArray(next) || next.length !== cur.length) { refusals.push({ kind: 'locked', path, reason: `${path}: the number of entries cannot change by override` }); return; }
    cur.forEach((c, i) => walk(rule, c, next[i], `${path}[${i}]`, refusals, changes));
    return;
  }
  const r = rule as Json;
  const c = cur as Json;
  if (!isObject(next)) { refusals.push({ kind: 'wrong-type', path, reason: `${path}: expected an object` }); return; }
  for (const k of Object.keys(next)) if (!Object.hasOwn(r, k)) refusals.push({ kind: 'unknown-field', path: `${path}.${k}`, reason: `${path}.${k}: no such policy field` });
  for (const k of Object.keys(r)) walk(r[k], c[k], next[k], `${path}.${k}`, refusals, changes);
};

/**
 * Apply an override to a policy. Refused as a whole if any field loosens a limit, touches a locked field, is unknown or
 * mistyped, or leaves the policy inconsistent. Never mutates `current`. The result is a deep-frozen copy.
 */
export const applyOverride = (current: Policy, override: PolicyOverride): OverrideResult => {
  // Copy both inputs once, up front, so what is checked is what is returned (no getter can change between check and use)
  // and the result shares nothing with either input.
  const base = structuredClone(current);
  const next = structuredClone(merge(base, structuredClone(override)));
  const refusals: Refusal[] = [];
  const changes: Change[] = [];
  walk(POLICY_RULES, base, next, 'policy', refusals, changes);
  if (refusals.length > 0) return { ok: false, refusals };
  const issues = policyIssues(next);
  if (issues.length > 0) return { ok: false, refusals: issues.map((reason) => ({ kind: 'invalid' as const, path: 'policy', reason })) };
  const policy = deepFreeze(next as Policy);
  return { ok: true, policy, versionHash: policyHash(policy), changes };
};

/** Paths of every field that has a rule, for tests that must cover them all. */
export const ruleLeafPaths = (): string[] => {
  const out: string[] = [];
  const visit = (rule: unknown, path: string): void => {
    if (typeof rule === 'string') { out.push(path); return; }
    for (const [k, v] of Object.entries(rule as Json)) visit(v, `${path}.${k}`);
  };
  visit(POLICY_RULES, 'policy');
  return out;
};

