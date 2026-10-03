// Holdout registry (ARCHITECTURE.md §13.1, §14 "Holdout discipline"). Pure data: the ledger stores it, these functions
// return a new registry and never mutate the old one.
// - Exactly one pre-registered configuration per universe may enter a holdout.
// - A holdout is scored once. Scoring burns it; a burned holdout can never be scored again.
// - New proof needs a new, later window that has never been scored.

export interface HoldoutEntry {
  readonly holdoutId: string;
  readonly universe: string;
  /** The single pre-registered configuration (rules, thresholds, barriers, exits) for this universe. */
  readonly configId: string;
  /** First and last calendar day of the window, "YYYY-MM-DD" (compared as strings). */
  readonly fromDay: string;
  readonly toDay: string;
  readonly burned: boolean;
}

export type HoldoutRegistry = readonly HoldoutEntry[];

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Register a holdout window for one universe. Throws on anything that would break single-look discipline. */
export const registerHoldout = (registry: HoldoutRegistry, entry: Omit<HoldoutEntry, 'burned'>): HoldoutRegistry => {
  if (!DAY.test(entry.fromDay) || !DAY.test(entry.toDay) || entry.fromDay > entry.toDay) {
    throw new RangeError(`holdout ${entry.holdoutId}: window must be two YYYY-MM-DD days in order`);
  }
  if (registry.some((e) => e.holdoutId === entry.holdoutId)) throw new RangeError(`holdout ${entry.holdoutId} is already registered`);
  const same = registry.filter((e) => e.universe === entry.universe);
  const open = same.find((e) => !e.burned);
  if (open) throw new RangeError(`universe ${entry.universe} already has an unscored holdout (${open.holdoutId}, config ${open.configId})`);
  const lastScored = same.reduce((d, e) => (e.toDay > d ? e.toDay : d), '');
  if (lastScored && entry.fromDay <= lastScored) {
    throw new RangeError(`holdout ${entry.holdoutId} must start after ${lastScored}, the end of the last scored window for ${entry.universe}`);
  }
  return [...registry, { ...entry, burned: false }];
};

/** Mark holdouts as scored. Throws if one is unknown or already burned. */
export const burnHoldouts = (registry: HoldoutRegistry, holdoutIds: readonly string[]): HoldoutRegistry => {
  for (const id of holdoutIds) {
    const e = registry.find((x) => x.holdoutId === id);
    if (!e) throw new RangeError(`holdout ${id} is not registered`);
    if (e.burned) throw new RangeError(`holdout ${id} is burned: it was already scored`);
  }
  const ids = new Set(holdoutIds);
  return registry.map((e) => (ids.has(e.holdoutId) ? { ...e, burned: true } : e));
};
