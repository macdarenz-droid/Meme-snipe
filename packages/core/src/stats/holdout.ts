// Sealed holdout registry (ARCHITECTURE.md §13.1, §14 "Holdout discipline", §20 STATS-1). Pure data: the ledger
// stores it; these functions return a new registry and never mutate the old one.
// - The number of universes (the Holm family size) is fixed when the registry is created, before n_power is simulated.
// - Exactly one pre-registered configuration per universe may enter a holdout.
// - The backtester runs the holdout into a sealed ledger file; the registry keeps only its hash and entry counts.
//   The size check reads the counts alone.
// - The seal opens once, and only when n ≥ max(300, n_power). Opening early, a hash mismatch, a second open, a re-run
//   with a different configuration or any inspection outside the scoring stage burns the holdout. Scoring burns it too.
// - New proof needs a new, later window that has never been run.

export interface HoldoutCounts {
  readonly candidates: number;
  /** Filled entries: the out-of-sample trades n. */
  readonly entries: number;
  readonly exits: number;
  /** Calendar days with at least one entry. */
  readonly days: number;
}

export type SealState = 'registered' | 'sealed' | 'opened';
export type BurnReason = 'scored' | 'early-open' | 'hash-mismatch' | 'count-mismatch' | 'second-open' | 'reconfigured' | 'inspected';

export interface HoldoutEntry {
  readonly holdoutId: string;
  readonly universe: string;
  /** The single pre-registered configuration (rules, thresholds, barriers, exits) for this universe. */
  readonly configId: string;
  /** First and last calendar day of the window, "YYYY-MM-DD" (compared as strings). */
  readonly fromDay: string;
  readonly toDay: string;
  readonly seal: SealState;
  /** Hash of the sealed ledger file, set when sealed. */
  readonly ledgerHash: string | null;
  readonly counts: HoldoutCounts | null;
  /** The injected clock's time when the seal was opened. */
  readonly openedAtMs: number | null;
  readonly burned: boolean;
  readonly burnReason: BurnReason | null;
}

export interface HoldoutRegistry {
  /** Universes in the Holm family (U1–U3), fixed before the n_power simulation. */
  readonly familySize: number;
  readonly entries: readonly HoldoutEntry[];
}

export interface RegistryStep {
  readonly registry: HoldoutRegistry;
  readonly ok: boolean;
  readonly reason: string;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export const createHoldoutRegistry = (familySize: number): HoldoutRegistry => {
  if (!Number.isInteger(familySize) || familySize < 1 || familySize > 3) throw new RangeError(`familySize must be 1, 2 or 3, got ${familySize}`);
  return { familySize, entries: [] };
};

const find = (registry: HoldoutRegistry, holdoutId: string): HoldoutEntry => {
  const e = registry.entries.find((x) => x.holdoutId === holdoutId);
  if (!e) throw new RangeError(`holdout ${holdoutId} is not registered`);
  return e;
};

const update = (registry: HoldoutRegistry, holdoutId: string, patch: Partial<HoldoutEntry>): HoldoutRegistry => ({
  ...registry,
  entries: registry.entries.map((e) => (e.holdoutId === holdoutId ? { ...e, ...patch } : e)),
});

const burn = (registry: HoldoutRegistry, holdoutId: string, reason: BurnReason, why: string): RegistryStep => ({
  registry: update(registry, holdoutId, { burned: true, burnReason: reason }),
  ok: false,
  reason: `holdout ${holdoutId} burned (${reason}): ${why}`,
});

/** Register a holdout window for one universe. Throws on anything that would break single-look discipline. */
export const registerHoldout = (
  registry: HoldoutRegistry,
  entry: Pick<HoldoutEntry, 'holdoutId' | 'universe' | 'configId' | 'fromDay' | 'toDay'>,
): HoldoutRegistry => {
  if (!DAY.test(entry.fromDay) || !DAY.test(entry.toDay) || entry.fromDay > entry.toDay) {
    throw new RangeError(`holdout ${entry.holdoutId}: window must be two YYYY-MM-DD days in order`);
  }
  if (registry.entries.some((e) => e.holdoutId === entry.holdoutId)) throw new RangeError(`holdout ${entry.holdoutId} is already registered`);
  const same = registry.entries.filter((e) => e.universe === entry.universe);
  const open = same.find((e) => !e.burned);
  if (open) throw new RangeError(`universe ${entry.universe} already has an unscored holdout (${open.holdoutId}, config ${open.configId})`);
  const live = new Set(registry.entries.filter((e) => !e.burned).map((e) => e.universe));
  if (live.size >= registry.familySize) throw new RangeError(`the registry was created for ${registry.familySize} universes`);
  const lastRun = same.reduce((d, e) => (e.toDay > d ? e.toDay : d), '');
  if (lastRun && entry.fromDay <= lastRun) {
    throw new RangeError(`holdout ${entry.holdoutId} must start after ${lastRun}, the end of the last window run for ${entry.universe}`);
  }
  return {
    ...registry,
    entries: [...registry.entries, { ...entry, seal: 'registered', ledgerHash: null, counts: null, openedAtMs: null, burned: false, burnReason: null }],
  };
};

const checkCounts = (c: HoldoutCounts): void => {
  for (const v of [c.candidates, c.entries, c.exits, c.days]) {
    if (!Number.isInteger(v) || v < 0) throw new RangeError('holdout counts must be integers >= 0');
  }
};

/**
 * Record the sealed ledger after the backtester ran the holdout. A re-run with the same configuration and identical
 * output is accepted; a different configuration or a different output burns the holdout.
 */
export const sealHoldout = (
  registry: HoldoutRegistry,
  holdoutId: string,
  run: { readonly configId: string; readonly ledgerHash: string; readonly counts: HoldoutCounts },
): RegistryStep => {
  checkCounts(run.counts);
  const e = find(registry, holdoutId);
  if (e.burned) return { registry, ok: false, reason: `holdout ${holdoutId} is burned (${e.burnReason})` };
  if (run.configId !== e.configId) return burn(registry, holdoutId, 'reconfigured', `run with ${run.configId}, registered ${e.configId}`);
  if (e.seal === 'opened') return burn(registry, holdoutId, 'second-open', 'already opened');
  if (e.seal === 'sealed') {
    const same = e.ledgerHash === run.ledgerHash && JSON.stringify(e.counts) === JSON.stringify(run.counts);
    return same ? { registry, ok: true, reason: 'identical re-run' } : burn(registry, holdoutId, 'reconfigured', 're-run produced a different ledger');
  }
  return { registry: update(registry, holdoutId, { seal: 'sealed', ledgerHash: run.ledgerHash, counts: run.counts }), ok: true, reason: 'sealed' };
};

/** Size check from the counts alone; the sealed ledger is not read. */
export const holdoutReady = (entry: HoldoutEntry, requiredTrades: number, minDays: number): boolean =>
  entry.seal === 'sealed' && !entry.burned && entry.counts !== null && entry.counts.entries >= requiredTrades && entry.counts.days >= minDays;

/**
 * Open the seal for scoring (once). The caller passes the hash of the file it is about to score. Opening burns the
 * holdout whatever happens: early, mismatched or repeated opens with a reason, a valid open as 'scored'.
 */
export const openHoldout = (
  registry: HoldoutRegistry,
  holdoutId: string,
  open: { readonly configId: string; readonly ledgerHash: string; readonly requiredTrades: number; readonly minDays: number; readonly nowMs: number },
): RegistryStep => {
  const e = find(registry, holdoutId);
  if (e.burned) return { registry, ok: false, reason: `holdout ${holdoutId} is burned (${e.burnReason}): a second look is refused` };
  if (e.seal === 'registered') return { registry, ok: false, reason: `holdout ${holdoutId} has not been run and sealed` };
  if (e.seal === 'opened') return burn(registry, holdoutId, 'second-open', 'the seal was already opened');
  if (open.configId !== e.configId) return burn(registry, holdoutId, 'reconfigured', `scored as ${open.configId}, registered ${e.configId}`);
  if (open.ledgerHash !== e.ledgerHash) return burn(registry, holdoutId, 'hash-mismatch', 'the file to score is not the sealed ledger');
  if (!holdoutReady(e, open.requiredTrades, open.minDays)) {
    return burn(registry, holdoutId, 'early-open', `${e.counts?.entries ?? 0} entries on ${e.counts?.days ?? 0} days, need ${open.requiredTrades} on ${open.minDays}`);
  }
  return {
    registry: update(registry, holdoutId, { seal: 'opened', openedAtMs: open.nowMs, burned: true, burnReason: 'scored' }),
    ok: true,
    reason: 'opened for scoring',
  };
};

/**
 * Burn a holdout for a reason found outside these functions: outcomes seen outside the scoring stage ('inspected': a
 * read of the sealed file, a log line with P&L) or a file whose entries differ from the sealed counts. Idempotent.
 */
export const burnHoldout = (registry: HoldoutRegistry, holdoutId: string, reason: Exclude<BurnReason, 'scored'>, why: string): RegistryStep => {
  const e = find(registry, holdoutId);
  return e.burned ? { registry, ok: false, reason: `holdout ${holdoutId} was already burned (${e.burnReason})` } : burn(registry, holdoutId, reason, why);
};
