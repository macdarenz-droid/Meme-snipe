// Sealed holdout registry (ARCHITECTURE.md §13.1, §14 "Holdout discipline", §20 STATS-1). Pure data: the ledger
// stores it; these functions return a new registry and never mutate the old one.
// - The number of universes (the Holm family size) is fixed when the registry is created, before n_power is simulated.
// - Exactly one pre-registered configuration per universe may enter a holdout.
// - The backtester runs the holdout into a sealed ledger file; the registry keeps only its hash and entry counts.
//   The size check reads the counts alone.
// - The seal opens once, and only when n ≥ max(300, n_power). Opening early, a hash mismatch, a second open, a re-run
//   with a different configuration or any inspection outside the scoring stage burns the holdout. Scoring burns it too.
// - New proof needs a new, later window that has never been run.
// - Attempts share one error budget (supervisor rulings, DECISIONS "STATS-1c"): attempt 1 of a universe is tested at
//   family α = 0.04, attempt k ≥ 2 at 0.01 / 2^(k − 1), each on a new, later window: at most 0.05 family error across
//   attempts; the bound requires valid testing under each attempt's registered selection, stopping and dependence
//   assumptions.
// - An attempt is spent when its configuration is registered, whatever happens next: a window that is halted,
//   abandoned or short of the requirement is a failed attempt that spent its α, and the next registration takes the
//   next attempt's level. There is no unspent path after registration.
// - Every window has a fixed entry cutoff E, registered before any count is known: entries on whole UTC days
//   [fromDay, E), at most `windowDays` days, then an observation-only tail of `tailDays` days so labels mature. The
//   seal opens once, after the tail, and never on a failed G1. There is no count-driven extension.
// - Attempt 1 of every registered universe shares one window (one common endpoint; no universe is dropped after
//   counts). The rule for later attempts is held from the start: attempt k ≥ 2 is registered only after the
//   universe's previous attempt is spent, starts on the first whole UTC day after its registration and runs exactly
//   `windowDays` days with the same tail.
// - The family size is fixed at creation and counts every universe ever registered, scored or not, so it cannot shrink.
//   The registry must persist in one append-only store (the scoring stage's ledger): a fresh registry would reset the
//   attempt count, and that is a storage rule this pure module cannot enforce.
// - The stopping and gate requirement is one frozen number, max(300, n_power, closed form), recorded with the n_power
//   seed before the first count is read (freezeRequirement before sealHoldout).

/**
 * What the registry exposes about a sealed holdout: candidate and entry counts only (review of PR #6). Never exit counts
 * (they would reveal blocked or still-open positions) and never anything derived from exits, fills' outcomes or P&L.
 */
export interface HoldoutCounts {
  readonly candidates: number;
  /** Filled entries: the out-of-sample trades n. */
  readonly entries: number;
  /** Calendar days with at least one entry (from entry times only; needed for the day-block minimum). */
  readonly entryDays: number;
}

/** The only fields a HoldoutCounts may carry; sealing rejects anything else. */
export const HOLDOUT_COUNT_FIELDS = ['candidates', 'entries', 'entryDays'] as const;

export type SealState = 'registered' | 'sealed' | 'opened';
export type BurnReason =
  | 'scored' | 'early-open' | 'hash-mismatch' | 'count-mismatch' | 'second-open' | 'reconfigured' | 'inspected'
  // Failed attempts that spent their α without a score: short of the requirement at E, or halted / abandoned.
  | 'short' | 'abandoned';

/** The window rule every attempt follows, fixed when the registry is created. */
export interface AttemptRule {
  /** Most whole UTC days of entries in a window (the entry cutoff E is at most fromDay + windowDays). */
  readonly windowDays: number;
  /** Observation-only days after E before the seal may open (labels mature). */
  readonly tailDays: number;
}

/** 28 entry days (09-22 .. 10-19, E = 10-20 for attempt 1) and one tail day: the trial exits end within 120 minutes. */
export const DEFAULT_ATTEMPT_RULE: AttemptRule = { windowDays: 28, tailDays: 1 };

/** The frozen size requirement and the seed its n_power simulation used. */
export interface FrozenRequirement {
  readonly requiredTrades: number;
  readonly nPowerSeed: number;
}

export interface HoldoutEntry {
  readonly holdoutId: string;
  readonly universe: string;
  /** 1 for the universe's first holdout, k for its k-th; sets the level it is tested at (attemptAlpha). */
  readonly attempt: number;
  /** The α this attempt spent at registration (attemptAlpha(attempt)). */
  readonly alpha: number;
  /** The UTC day the configuration was registered. */
  readonly registeredOnDay: string;
  readonly requirement: FrozenRequirement | null;
  /** The single pre-registered configuration (rules, thresholds, barriers, exits) for this universe. */
  readonly configId: string;
  /** First and last UTC entry day of the window, "YYYY-MM-DD" (compared as strings). The entry cutoff E is the day
   * after toDay; the seal may open from tailEnd on. */
  readonly fromDay: string;
  readonly toDay: string;
  readonly tailEnd: string;
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
  /** Universes in the Holm family (U1–U3), fixed before the n_power simulation; counts every universe ever registered. */
  readonly familySize: number;
  readonly rule: AttemptRule;
  readonly entries: readonly HoldoutEntry[];
}

export interface RegistryStep {
  readonly registry: HoldoutRegistry;
  readonly ok: boolean;
  readonly reason: string;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Family α for a universe's k-th holdout attempt: 0.04, then 0.01 / 2^(k − 1). */
export const attemptAlpha = (attempt: number): number => {
  if (!Number.isInteger(attempt) || attempt < 1) throw new RangeError(`attempt must be an integer >= 1, got ${attempt}`);
  return attempt === 1 ? 0.04 : 0.01 / 2 ** (attempt - 1);
};

const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** The calendar day after a "YYYY-MM-DD" day (proleptic Gregorian; no clock or Date object). */
export const nextDay = (day: string): string => {
  if (!DAY.test(day)) throw new RangeError(`not a YYYY-MM-DD day: ${day}`);
  let y = Number(day.slice(0, 4));
  let m = Number(day.slice(5, 7));
  let d = Number(day.slice(8, 10)) + 1;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const len = m === 2 && leap ? 29 : MONTH_DAYS[m - 1]!;
  if (d > len) {
    d = 1;
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
};

/** Whole days from `from` to `to` (to − from), by stepping days; refuses more than `limit` steps. */
export const daysBetween = (from: string, to: string, limit = 400): number => {
  if (!DAY.test(from) || !DAY.test(to)) throw new RangeError(`not YYYY-MM-DD days: ${from}, ${to}`);
  if (to < from) return -daysBetween(to, from, limit);
  let d = from;
  let n = 0;
  while (d < to) {
    d = nextDay(d);
    n++;
    if (n > limit) throw new RangeError(`days ${from} and ${to} are more than ${limit} days apart`);
  }
  return n;
};

/** The day `n` days after `day`. */
export const addDays = (day: string, n: number): string => {
  let d = day;
  for (let i = 0; i < n; i++) d = nextDay(d);
  return d;
};

/** Day 0 of dayFromNumber. */
const EPOCH_DAY = '1970-01-01';

/** The UTC day of a day number counted from 1970-01-01 (day 0). */
export const dayFromNumber = (n: number): string => {
  if (!Number.isInteger(n) || n < 0) throw new RangeError(`day number must be an integer >= 0, got ${n}`);
  let y = Number(EPOCH_DAY.slice(0, 4));
  let rest = n;
  for (;;) {
    const len = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 366 : 365;
    if (rest < len) break;
    rest -= len;
    y++;
  }
  return addDays(`${String(y).padStart(4, '0')}-01-01`, rest);
};

export const createHoldoutRegistry = (familySize: number, rule: AttemptRule = DEFAULT_ATTEMPT_RULE): HoldoutRegistry => {
  if (!Number.isInteger(familySize) || familySize < 1 || familySize > 3) throw new RangeError(`familySize must be 1, 2 or 3, got ${familySize}`);
  if (!Number.isInteger(rule.windowDays) || rule.windowDays < 1 || !Number.isInteger(rule.tailDays) || rule.tailDays < 0) {
    throw new RangeError('the attempt rule needs windowDays >= 1 and tailDays >= 0, both integers');
  }
  return { familySize, rule: { windowDays: rule.windowDays, tailDays: rule.tailDays }, entries: [] };
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

/**
 * Register a holdout window for one universe; this spends the attempt. Throws on anything that would break single-look
 * discipline or the attempt rules (see the header).
 */
export const registerHoldout = (
  registry: HoldoutRegistry,
  entry: Pick<HoldoutEntry, 'holdoutId' | 'universe' | 'configId' | 'fromDay' | 'toDay' | 'registeredOnDay'> & { readonly alpha?: number },
): HoldoutRegistry => {
  const id = entry.holdoutId;
  if (!DAY.test(entry.fromDay) || !DAY.test(entry.toDay) || !DAY.test(entry.registeredOnDay) || entry.fromDay > entry.toDay) {
    throw new RangeError(`holdout ${id}: window and registration day must be YYYY-MM-DD days, the window in order`);
  }
  if (registry.entries.some((e) => e.holdoutId === id)) throw new RangeError(`holdout ${id} is already registered`);
  const same = registry.entries.filter((e) => e.universe === entry.universe);
  const open = same.find((e) => !e.burned);
  if (open) throw new RangeError(`universe ${entry.universe} already has an unspent holdout (${open.holdoutId}, config ${open.configId})`);
  const universes = new Set(registry.entries.map((e) => e.universe));
  if (!universes.has(entry.universe) && universes.size >= registry.familySize) {
    throw new RangeError(`the registry was created for ${registry.familySize} universes; ${[...universes].join(', ')} are registered`);
  }
  const attempt = same.length + 1;
  const alpha = attemptAlpha(attempt);
  if (entry.alpha !== undefined && entry.alpha !== alpha) throw new RangeError(`holdout ${id}: attempt ${attempt} is tested at ${alpha}, not ${entry.alpha}`);
  const days = daysBetween(entry.fromDay, entry.toDay) + 1;
  if (days > registry.rule.windowDays) throw new RangeError(`holdout ${id}: ${days} entry days, the rule allows at most ${registry.rule.windowDays}`);
  const lastRun = same.reduce((d, e) => (e.tailEnd > d ? e.tailEnd : d), '');
  if (lastRun && entry.fromDay < lastRun) {
    throw new RangeError(`holdout ${id} must start on or after ${lastRun}, the end of the last window run for ${entry.universe}`);
  }
  if (attempt === 1) {
    const peers = registry.entries.filter((e) => e.attempt === 1);
    const other = peers.find((e) => e.fromDay !== entry.fromDay || e.toDay !== entry.toDay);
    if (peers.length > 0 && (peers[0]!.fromDay !== entry.fromDay || peers[0]!.toDay !== entry.toDay || other)) {
      throw new RangeError(`holdout ${id}: attempt 1 of every universe shares one window, ${peers[0]!.fromDay}..${peers[0]!.toDay}`);
    }
  } else {
    if (entry.fromDay !== nextDay(entry.registeredOnDay)) {
      throw new RangeError(`holdout ${id}: attempt ${attempt} starts on the first whole UTC day after its registration (${nextDay(entry.registeredOnDay)})`);
    }
    if (days !== registry.rule.windowDays) throw new RangeError(`holdout ${id}: attempt ${attempt} runs exactly ${registry.rule.windowDays} days`);
  }
  return {
    ...registry,
    entries: [...registry.entries, {
      holdoutId: id, universe: entry.universe, attempt, alpha, registeredOnDay: entry.registeredOnDay, requirement: null,
      configId: entry.configId, fromDay: entry.fromDay, toDay: entry.toDay, tailEnd: addDays(entry.toDay, 1 + registry.rule.tailDays),
      seal: 'registered', ledgerHash: null, counts: null, openedAtMs: null, burned: false, burnReason: null,
    }],
  };
};

/**
 * Freeze the size requirement max(300, n_power, closed form) and the n_power seed, before the first count is read
 * (sealing refuses a holdout without one). Once frozen it never changes.
 */
export const freezeRequirement = (registry: HoldoutRegistry, holdoutId: string, req: FrozenRequirement): RegistryStep => {
  const e = find(registry, holdoutId);
  if (!Number.isInteger(req.requiredTrades) || req.requiredTrades < 1 || !Number.isSafeInteger(req.nPowerSeed)) {
    throw new RangeError('the requirement is a positive integer and the seed a safe integer');
  }
  if (e.requirement) return { registry, ok: false, reason: `holdout ${holdoutId} already froze ${e.requirement.requiredTrades} trades` };
  if (e.seal !== 'registered' || e.burned) return { registry, ok: false, reason: `holdout ${holdoutId} is ${e.burned ? 'spent' : e.seal}: the requirement is frozen before any count` };
  return { registry: update(registry, holdoutId, { requirement: { requiredTrades: req.requiredTrades, nPowerSeed: req.nPowerSeed } }), ok: true, reason: 'frozen' };
};

/** Record a halted or abandoned window: the attempt stays spent (a failed attempt). */
export const abandonHoldout = (registry: HoldoutRegistry, holdoutId: string, why: string): RegistryStep => burnHoldout(registry, holdoutId, 'abandoned', why);

const checkCounts = (c: HoldoutCounts): HoldoutCounts => {
  const extra = Object.keys(c).filter((k) => !(HOLDOUT_COUNT_FIELDS as readonly string[]).includes(k));
  if (extra.length > 0) throw new RangeError(`holdout counts may hold only ${HOLDOUT_COUNT_FIELDS.join(', ')}; got ${extra.join(', ')}`);
  for (const k of HOLDOUT_COUNT_FIELDS) {
    if (!Number.isInteger(c[k]) || c[k] < 0) throw new RangeError('holdout counts must be integers >= 0');
  }
  // Store a copy with exactly the allowed fields.
  return { candidates: c.candidates, entries: c.entries, entryDays: c.entryDays };
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
  const counts = checkCounts(run.counts);
  const e = find(registry, holdoutId);
  if (e.burned) return { registry, ok: false, reason: `holdout ${holdoutId} is burned (${e.burnReason})` };
  if (!e.requirement) return { registry, ok: false, reason: `holdout ${holdoutId} has no frozen requirement: freeze it before any count is read` };
  if (run.configId !== e.configId) return burn(registry, holdoutId, 'reconfigured', `run with ${run.configId}, registered ${e.configId}`);
  if (e.seal === 'opened') return burn(registry, holdoutId, 'second-open', 'already opened');
  if (e.seal === 'sealed') {
    const same = e.ledgerHash === run.ledgerHash && JSON.stringify(e.counts) === JSON.stringify(counts);
    return same ? { registry, ok: true, reason: 'identical re-run' } : burn(registry, holdoutId, 'reconfigured', 're-run produced a different ledger');
  }
  return { registry: update(registry, holdoutId, { seal: 'sealed', ledgerHash: run.ledgerHash, counts }), ok: true, reason: 'sealed' };
};

/** Size check from the counts alone; the sealed ledger is not read. */
export const holdoutReady = (entry: HoldoutEntry, requiredTrades: number, minDays: number): boolean =>
  entry.seal === 'sealed' && !entry.burned && entry.counts !== null && entry.counts.entries >= requiredTrades && entry.counts.entryDays >= minDays;

/**
 * Open the seal for scoring (once). The caller passes the hash of the file it is about to score, the UTC day of the
 * injected clock and whether G1 passed for this configuration. Before the tail has matured, or after a G1 fail, the
 * open is refused and nothing is seen. Otherwise opening burns the holdout whatever happens: mismatched or repeated
 * opens with a reason, a short window as 'short' (a failed attempt), a valid open as 'scored'.
 */
export const openHoldout = (
  registry: HoldoutRegistry,
  holdoutId: string,
  open: {
    readonly configId: string; readonly ledgerHash: string; readonly requiredTrades: number; readonly minDays: number;
    readonly nowMs: number; readonly nowDay: string; readonly g1Passed: boolean;
  },
): RegistryStep => {
  const e = find(registry, holdoutId);
  if (e.burned) return { registry, ok: false, reason: `holdout ${holdoutId} is burned (${e.burnReason}): a second look is refused` };
  if (e.seal === 'registered') return { registry, ok: false, reason: `holdout ${holdoutId} has not been run and sealed` };
  if (!open.g1Passed) return { registry, ok: false, reason: `holdout ${holdoutId} stays sealed: G1 did not pass for ${e.configId}` };
  if (!(open.nowDay >= e.tailEnd)) return { registry, ok: false, reason: `holdout ${holdoutId} stays sealed until ${e.tailEnd}, when its observation tail has matured` };
  if (e.requirement && open.requiredTrades !== e.requirement.requiredTrades) {
    return { registry, ok: false, reason: `holdout ${holdoutId} froze ${e.requirement.requiredTrades} trades, the open asked for ${open.requiredTrades}` };
  }
  if (e.seal === 'opened') return burn(registry, holdoutId, 'second-open', 'the seal was already opened');
  if (open.configId !== e.configId) return burn(registry, holdoutId, 'reconfigured', `scored as ${open.configId}, registered ${e.configId}`);
  if (open.ledgerHash !== e.ledgerHash) return burn(registry, holdoutId, 'hash-mismatch', 'the file to score is not the sealed ledger');
  if (!holdoutReady(e, open.requiredTrades, open.minDays)) {
    return burn(registry, holdoutId, 'short', `${e.counts?.entries ?? 0} entries on ${e.counts?.entryDays ?? 0} days at the cutoff, need ${open.requiredTrades} on ${open.minDays}: not proven, the attempt is spent`);
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

/**
 * Count-driven extension is not allowed (supervisor ruling: a count-driven stop is not outcome-independent, because
 * entry frequency moves with the market). Kept as an API so a caller gets a clear refusal; it never changes the
 * registry. The window ends at its registered cutoff E.
 */
export const extendHoldout = (registry: HoldoutRegistry, holdoutId: string, newToDay: string): RegistryStep => {
  const e = find(registry, holdoutId);
  return { registry, ok: false, reason: `holdout ${holdoutId} ends at its registered cutoff ${nextDay(e.toDay)}; extending it to ${newToDay} is refused` };
};
