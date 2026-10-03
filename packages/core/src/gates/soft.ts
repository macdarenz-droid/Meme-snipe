// Soft features (docs/ARCHITECTURE.md §7.2): measured and logged for calibration, never a reject. A feature whose
// input is unknown, stale or degraded is logged as unknown with the reason, never filled in. No score is computed
// before calibration (§13): the journal carries the features and their reasons only.
import { Evidence, type GateContext } from './evidence.ts';
import { SOFT_BIGINTS, SOFT_FLAGS, SOFT_NUMBERS, createKey, deployerKey, holdersKey, parseCreate, parseDeployer, parseHolders, parsePool, parseSoft, poolKey, softKey } from './facts.ts';
import type { GateDeps } from './hard.ts';
import { createsCoverage } from './deployer-index.ts';
import { EXCLUDED, concentration, mintAccounts } from './holders.ts';
import { DAY_MS } from './series.ts';

export interface SoftFeature {
  readonly name: string;
  /** Decimal or boolean text; null when unknown. */
  readonly value: string | null;
  /** Why it is unknown, or how it was adjusted. */
  readonly note?: string;
}

export interface SoftResult {
  readonly mint: string;
  readonly features: readonly SoftFeature[];
}

export const evaluateSoftFeatures = (ctx: GateContext, deps: GateDeps, mint: string): SoftResult => {
  const policy = deps.session.policy;
  const ev = new Evidence(ctx, policy);
  const features: SoftFeature[] = [];
  const unknownAll = (names: readonly string[], note: string) => { for (const name of names) features.push({ name, value: null, note }); };

  // Read as an event: FACTS-1 writes soft values once their window is covered and they no longer change (creation-slot
  // buyers, same-transaction dev buy, funding classes), so a fact from creation is still the value at the decision.
  const soft = ev.read('soft', softKey(mint), parseSoft, 'event', 'H16');
  const third = deps.mode === 'live';
  // Third-party scores are live only (§16.3): never logged in the backtest, even if a feed supplied one.
  const names = [...SOFT_BIGINTS, ...SOFT_NUMBERS, ...SOFT_FLAGS].filter((n) => n !== 'rugcheckSingleHolderFlag' && (third || n !== 'rugcheckScore'));
  if (!soft.ok) unknownAll(names, soft.reason.detail);
  else {
    for (const name of names) {
      const v = (soft.fact as unknown as Readonly<Record<string, unknown>>)[name];
      features.push(v === undefined ? { name, value: null, note: 'not reported' } : { name, value: String(v) });
    }
  }
  if (!third) features.push({ name: 'rugcheckScore', value: null, note: 'live only (§16.3)' });

  // 5. Holders, after the same exclusions as H12.
  const holders = ev.read('holders', holdersKey(mint), parseHolders, 'state', 'H12');
  const pool = ev.read('pool', poolKey(mint), parsePool, 'state', 'H12');
  let largestExcluded: boolean | null = null;
  if (!holders.ok || !pool.ok) unknownAll(['observedDistinctOwners', 'unknownProgramHolders'], (!holders.ok ? holders.reason : (pool as { ok: false; reason: { detail: string } }).reason).detail);
  else {
    const c = concentration(holders.fact, mintAccounts(mint, { address: pool.fact.address, baseVault: pool.fact.pool.poolBaseTokenAccount }));
    // Distinct owners seen in the holder read: not "independent" (no funding evidence here; FACTS-1 reports that split).
    features.push({ name: 'observedDistinctOwners', value: String(c.owners.length), ...(holders.fact.coverage === 'largest' ? { note: 'largest accounts only' } : {}) });
    features.push({ name: 'unknownProgramHolders', value: String(c.classes.filter((x) => x.cls === 'unknown-program').length) });
    const largest = [...c.classes].sort((a, b) => (a.amount > b.amount ? -1 : a.amount < b.amount ? 1 : a.address < b.address ? -1 : 1))[0];
    largestExcluded = largest === undefined ? null : EXCLUDED.has(largest.cls);
  }

  // 7. RugCheck's single-holder flag is a false positive when the largest account is a known vault (§7.2).
  if (!third) features.push({ name: 'rugcheckSingleHolderFlag', value: null, note: 'live only (§16.3)' });
  else if (!soft.ok || soft.fact.rugcheckSingleHolderFlag === undefined) features.push({ name: 'rugcheckSingleHolderFlag', value: null, note: 'not reported' });
  else if (soft.fact.rugcheckSingleHolderFlag && largestExcluded === true) features.push({ name: 'rugcheckSingleHolderFlag', value: 'false', note: 'ignored: the largest holder is a known vault' });
  else features.push({ name: 'rugcheckSingleHolderFlag', value: String(soft.fact.rugcheckSingleHolderFlag) });

  // 4. Deployer history from our own index, over the same look-back as H14.
  const create = ev.read('create', createKey(mint), parseCreate, 'event', 'H14');
  const dep = create.ok ? ev.read('deployer', deployerKey(create.fact.creator), parseDeployer, 'state', 'H14') : create;
  if (!dep.ok) unknownAll(['indexMints', 'indexRugs'], dep.reason.detail);
  else {
    const now = ctx.now.receivedAt;
    const from = now - policy.gates.deployerRugLookbackDays * DAY_MS;
    features.push({ name: 'indexMints', value: String(dep.fact.mints.filter((m) => m.createdAtMs <= now && m.createdAtMs >= from).length) });
    const rugCov = deps.rugLabeller === undefined
      ? { covered: false as const, detail: 'no reviewed labeller; RUG-1' }
      : createsCoverage((k, f, t) => ctx.history(k, f, t), ctx.now, from, 'rugs');
    features.push(rugCov.covered
      ? { name: 'indexRugs', value: String(dep.fact.rugs.filter((r) => r.knownAtMs <= now && r.knownAtMs >= from).length) }
      : { name: 'indexRugs', value: null, note: `rug labels unavailable: ${rugCov.detail}` });
  }
  return { mint, features };
};
