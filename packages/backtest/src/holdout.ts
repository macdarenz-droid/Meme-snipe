// Holdout mode (docs/ARCHITECTURE.md §14): the run writes fills, exits and P&L into a separate sealed ledger file and
// exposes only the file's hash and, per universe, the candidate and entry counts (and entry days, from entry times
// only). Nothing else leaves this function: no exit count, fill, P&L or log line. The file is made read-only; only the
// scoring stage opens it, once, after STATS-1's size check passes.
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { refuseSymlink } from './registry-git.ts';
import { canonical } from '../../core/src/engine/index.ts';
import {
  ATTEMPT_ALPHA, attemptAlpha as registryAlpha, burnHoldout, createHoldoutRegistry, freezeRequirement, type FrozenRequirement, type HoldoutCounts, type HoldoutEntry,
  type HoldoutRegistry, nextAttemptIndex, openHoldout, registerHoldout, sealHoldout, SPEND_REASONS, spendHoldout, type SpendReason,
} from '../../core/src/stats/index.ts';
import type { DatasetRow } from './dataset/rows.ts';
import { melbourneDay } from './report.ts';
import { type RunOptions, runBacktest, s0Config } from './run.ts';

export interface SealedHoldout {
  /** sha256 of the sealed ledger file. */
  readonly ledgerHash: string;
  readonly counts: Readonly<Record<string, HoldoutCounts>>;
}

/**
 * Version control of the registry file (the CLI's keeps it on a remote branch, registry-git.ts): `check` refuses
 * unless the local copy equals the shared one (a fresh clone takes the shared copy); `commit` records and publishes a
 * write, and throws when it cannot (then the write is undone locally and nothing runs).
 */
export interface RegistryVcs {
  check(): void;
  commit(message: string): void;
}

/** What a holdout run is bound to besides its options: the code it ran and the dataset it read. */
export interface HoldoutAuthority {
  /** The registry file (JSON): the STATS-1 registry and every run attempt, kept across processes. */
  readonly registryPath: string;
  readonly codeCommit: string;
  readonly datasetId: string;
  readonly vcs?: RegistryVcs;
}

/** The registered window of the research config's holdout: [fromDay, tailEndDay), as first and last UTC day. */
export const holdoutWindow = (o: RunOptions): { readonly fromDay: string; readonly toDay: string } => {
  const h = o.research.holdout;
  return { fromDay: h.fromDay, toDay: new Date(Date.parse(`${h.tailEndDay}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10) };
};

const dayBefore = (day: string): string => new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

/**
 * A registered holdout's run window: its entry days and its observation tail, [fromDay, tailEnd). The STATS-1c
 * registry records the entry days as fromDay..toDay and the tail end separately.
 */
const runWindowOf = (e: HoldoutEntry): { readonly fromDay: string; readonly toDay: string } => ({ fromDay: e.fromDay, toDay: dayBefore(e.tailEnd) });

const overlaps = (a: { fromDay: string; toDay: string }, b: { fromDay: string; toDay: string }): boolean => a.fromDay <= b.toDay && b.fromDay <= a.toDay;

/** Holdouts with a start record whose window overlaps `w`, other than `exceptId`. */
const startedOverlapping = (store: HoldoutStore, w: { fromDay: string; toDay: string }, exceptId: string | null): string[] =>
  store.registry.entries
    .filter((e) => e.holdoutId !== exceptId && overlaps(runWindowOf(e), w) && store.runs.some((r) => r.holdoutId === e.holdoutId && r.outcome !== 'refused'))
    .map((e) => e.holdoutId);

/**
 * The days a research run may read (H1 of the BT-1c review): never a day at or after the reserved holdout start, nor
 * one inside any registered window. Explicitly chosen days that break this are refused; without a choice, only
 * allowed (practice) days are kept.
 */
export const researchDays = (days: readonly string[], research: RunOptions['research'], store: HoldoutStore | null, explicit: boolean): string[] => {
  const why = (d: string): string | null => {
    if (d >= research.holdout.fromDay) return `${d} is at or after the reserved holdout start ${research.holdout.fromDay}`;
    const e = store?.registry.entries.find((x) => x.fromDay <= d && d <= runWindowOf(x).toDay);
    return e === undefined ? null : `${d} is inside holdout ${e.holdoutId}`;
  };
  const refused = days.map(why).filter((x): x is string => x !== null);
  if (explicit && refused.length > 0) throw new RangeError(`research runs never read holdout days: ${refused.join('; ')}`);
  const kept = days.filter((d) => why(d) === null);
  if (kept.length === 0) throw new RangeError('no practice days to run');
  return kept;
};

/**
 * The configuration id a holdout is registered under: sha256 of the strategy's resolved configuration, the policy, the
 * fill model (scenario and seed included), the research settings, the code commit and the dataset. Any change to one of
 * them is a different configuration.
 */
export const holdoutConfigId = (o: RunOptions, a: Pick<HoldoutAuthority, 'codeCommit' | 'datasetId'>): string =>
  createHash('sha256').update(canonical({
    s0: s0Config(o), policy: o.policy, fills: o.fills, scenario: o.scenario, seed: o.seed, research: o.research,
    delay: o.delay ?? null, observation: o.observation ?? 'chain-time', failureBursts: o.failureBursts ?? null,
    regimeBoundaries: o.regimeBoundaries ?? [], codeCommit: a.codeCommit, datasetId: a.datasetId,
  })).digest('hex');

export interface HoldoutRunRecord {
  readonly holdoutId: string;
  readonly outcome: 'refused' | 'started' | 'failed' | 'sealed';
  readonly configId: string;
  readonly ledgerPath: string;
  /** Wall-clock time of the record (ISO), outside the engine. */
  readonly at: string;
  readonly reason: string;
}

/**
 * The registered procedure of a holdout (BT-2 writes it through setHoldoutPlan): its window and cutoff (they must equal
 * the research config's), the tie salt, the α schedule of attempts, decoder boundaries and the procedure in words.
 * Fixed once set.
 */
export interface HoldoutPlan {
  readonly fromDay: string;
  readonly entryCutoffDay: string;
  readonly tailEndDay: string;
  /** Universes in the Holm family, fixed before n_power is simulated. */
  readonly familySize: number;
  readonly tieSalt: string;
  /** Family α of attempt 1, and of attempt k ≥ 2: laterBase / 2^(k-1). */
  readonly alpha: { readonly first: number; readonly laterBase: number };
  /** Decoder boundaries inside the window: reported before and after, not gating (B5). */
  readonly decoderBoundaries: readonly { readonly label: string; readonly at: string }[];
  readonly procedure: readonly string[];
  /** Anything else the study fixes in advance (sizing estimates, study id); recorded, never read here. */
  readonly details: Readonly<Record<string, unknown>>;
}

/** An attempt's window in UTC data days: entries from `fromDay` until `entryCutoffDay`, observed until `tailEndDay` (exclusive). */
export interface AttemptWindow {
  readonly fromDay: string;
  readonly entryCutoffDay: string;
  readonly tailEndDay: string;
}

/** Entry days of an attempt k ≥ 2 (from the first whole UTC day after its registration). */
export const LATER_ATTEMPT_ENTRY_DAYS = 28;

/** One attempt of the shared error budget: registering it spends it, whatever happens later. */
export interface HoldoutAttempt {
  readonly index: number;
  /** The family α this attempt spends: G2 takes it as familyAlpha (Holm across the attempt's universes). */
  readonly alpha: number;
  /** Attempt 1: the plan's window. Attempt k ≥ 2: its own, written at registration. */
  readonly window: AttemptWindow;
  readonly holdoutIds: readonly string[];
  readonly configIds: Readonly<Record<string, string>>;
  readonly registeredAt: string;
  readonly started: string | null;
  /** `spent`: ended by endAttempt after its tail without an opening, `why` saying how (failed G1, short, never run). */
  readonly ended: { readonly at: string; readonly outcome: 'sealed' | 'failed' | 'spent'; readonly why?: string } | null;
}

/** A G1 result for a registered holdout; appended, never replaced, so a fail stays on record. */
export interface G1Record {
  readonly holdoutId: string;
  readonly configId: string;
  readonly passed: boolean;
  /** What G1 was evaluated on (days, dataset), for the record. */
  readonly evaluatedOn: string;
  readonly at: string;
}

/** The one holdout registry (supervisor ruling): typed sections, every write one pushed commit. */
export interface HoldoutStore {
  readonly version: 2;
  readonly plan: HoldoutPlan | null;
  /** The windows: STATS-1's registry of every holdout. */
  readonly registry: HoldoutRegistry;
  readonly attempts: readonly HoldoutAttempt[];
  readonly g1: readonly G1Record[];
  /** Every run attempt: refused, started, failed, sealed. */
  readonly runs: readonly HoldoutRunRecord[];
}

/**
 * The ruled error budget (DECISIONS "Follow-up rulings", holdout): attempt 1 at family α 0.04, attempt k ≥ 2 at
 * 0.01 / 2^(k-1), so all attempts together stay under 0.05. Any other plan is refused. G2 uses the attempt's α as its
 * family α (Holm across the attempt's universes).
 */
export const RULED_ALPHA = ATTEMPT_ALPHA;

/** The α of attempt `index` under a plan: the STATS-1c registry's schedule, which the plan must state (STATS-1c owns α). */
export const attemptAlpha = (plan: Pick<HoldoutPlan, 'alpha'>, index: number): number => {
  if (!Number.isSafeInteger(index) || index < 1) throw new RangeError(`attempt index must be >= 1, got ${index}`);
  if (plan.alpha.first !== RULED_ALPHA.first || plan.alpha.laterBase !== RULED_ALPHA.laterBase) throw new RangeError('the plan does not state the ruled α budget');
  return registryAlpha(index);
};

export const readHoldoutStore = (path: string): HoldoutStore => {
  refuseSymlink(path);
  const s = JSON.parse(readFileSync(path, 'utf8')) as HoldoutStore;
  if (s.version !== 2 || s.registry === undefined || !Array.isArray(s.attempts) || !Array.isArray(s.g1) || !Array.isArray(s.runs)) {
    throw new RangeError(`${path} is not a version-2 holdout registry`);
  }
  return s;
};

/**
 * One write: checks the shared copy, reads the store, applies `fn` and publishes the result as one commit. `fn` may
 * return an error to raise after the result is published (a refusal that burns must still be recorded).
 */
const mutate = <T>(a: HoldoutAuthority, message: string, fn: (s: HoldoutStore | null) => { readonly store: HoldoutStore; readonly value: T; readonly error?: Error }): T => {
  a.vcs?.check();
  const before = existsSync(a.registryPath) ? readHoldoutStore(a.registryPath) : null;
  const out = fn(before);
  // Nothing changed (the same plan set again): no write, no commit.
  if (before === null || canonical(before) !== canonical(out.store)) saveStore(a.registryPath, out.store, a.vcs, message);
  if (out.error !== undefined) throw out.error;
  return out.value;
};

/** Sets the plan once, before any attempt; it must agree with the research config's holdout. Creates the registry. */
export const setHoldoutPlan = (
  a: HoldoutAuthority, plan: HoldoutPlan, research: RunOptions['research'],
  /** Tests on synthetic data only: a requirement floor below the owner's 300 trades on 10 days. The CLI never passes it. */
  testFloor?: { readonly minTrades: number; readonly minDays: number },
): HoldoutStore => {
  const h = research.holdout;
  if (plan.fromDay !== h.fromDay || plan.entryCutoffDay !== h.entryCutoffDay || plan.tailEndDay !== h.tailEndDay) {
    throw new RangeError(`the plan's window ${plan.fromDay}, cutoff ${plan.entryCutoffDay}, tail end ${plan.tailEndDay} is not the research config's (${h.fromDay}, ${h.entryCutoffDay}, ${h.tailEndDay})`);
  }
  if (plan.alpha.first !== RULED_ALPHA.first || plan.alpha.laterBase !== RULED_ALPHA.laterBase) {
    throw new RangeError(`the plan's α (${plan.alpha.first}, ${plan.alpha.laterBase}) is not the ruled α budget (attempt 1: ${RULED_ALPHA.first}; attempt k ≥ 2: ${RULED_ALPHA.laterBase} / 2^(k-1))`);
  }
  return mutate(a, 'Holdout plan: set', (s) => {
    if (s !== null && s.plan !== null) {
      if (canonical(s.plan) === canonical(plan)) return { store: s, value: s };
      throw new RangeError('the holdout plan is fixed once set');
    }
    const store: HoldoutStore = s === null
      ? { version: 2, plan, registry: createHoldoutRegistry(plan.familySize, { windowDays: LATER_ATTEMPT_ENTRY_DAYS, tailDays: daysBetween(plan.entryCutoffDay, plan.tailEndDay), ...testFloor }), attempts: [], g1: [], runs: [] }
      : { ...s, plan };
    return { store, value: store };
  });
};

/** Why an attempt ends without an opening (the STATS-1c registry's spend reasons). */
export type SpentReason = SpendReason;

/**
 * Ends attempt `index` once its tail has passed without an opening. Every holdout of it not yet burned or opened must
 * qualify under the STATS-1c registry's rule (`spendHoldout`, so a mandatory opening is never skipped):
 * - 'g1-failed': its latest G1 is not a pass for the registered configuration (g1Blocks);
 * - 'short': it is not ready against the requirement frozen at registration (trades and days, read from the registry);
 * - 'never-run': its seal is still 'registered'.
 * Those holdouts are burned 'spent' and the attempt is marked ended; then the next attempt may register.
 */
export const endAttempt = (a: HoldoutAuthority, index: number, why: SpentReason, now: Date = new Date()): HoldoutStore =>
  mutate(a, `Holdout attempt ${index}: spent (${why})`, (s) => {
    if (!(SPEND_REASONS as readonly string[]).includes(why)) throw new RangeError(`holdout attempt ${index}: "${String(why)}" is not a reason an attempt may end without an opening`);
    const at = s?.attempts.find((x) => x.index === index);
    if (s === null || at === undefined) throw new RangeError(`holdout attempt ${index} is not registered`);
    if (now.getTime() < Date.parse(`${at.window.tailEndDay}T00:00:00Z`)) throw new RangeError(`holdout attempt ${index}: its tail runs until ${at.window.tailEndDay}`);
    const nowDay = now.toISOString().slice(0, 10);
    const open = at.holdoutIds.map((id) => s.registry.entries.find((x) => x.holdoutId === id)!).filter((e) => e !== undefined && !e.burned && e.seal !== 'opened');
    let registry = s.registry;
    for (const e of open) registry = spendHoldout(registry, e.holdoutId, { why, nowDay, g1Passed: g1Blocks(s, e.holdoutId) === null }).registry;
    const ended = at.ended?.outcome === 'spent' ? at.ended : { at: now.toISOString(), outcome: 'spent' as const, why };
    const store = { ...s, registry, attempts: s.attempts.map((x) => (x.index === index ? { ...x, ended } : x)) };
    return { store, value: store };
  });

/** Appends a G1 result for a registered holdout. */
export const recordHoldoutG1 = (a: HoldoutAuthority, rec: Omit<G1Record, 'at'>, now: Date = new Date()): HoldoutStore =>
  mutate(a, `Holdout ${rec.holdoutId}: G1 ${rec.passed ? 'pass' : 'fail'} for ${rec.configId.slice(0, 12)}`, (s) => {
    if (s === null || !s.registry.entries.some((e) => e.holdoutId === rec.holdoutId)) throw new RangeError(`holdout ${rec.holdoutId} is not registered`);
    const store = { ...s, g1: [...s.g1, { ...rec, at: now.toISOString() }] };
    return { store, value: store };
  });

/** Why `holdoutId` may not be opened (null when it may): its latest G1 must be a pass for its registered configuration. */
export const g1Blocks = (s: HoldoutStore, holdoutId: string): string | null => {
  const e = s.registry.entries.find((x) => x.holdoutId === holdoutId);
  if (e === undefined) return `${holdoutId} is not registered`;
  const last = s.g1.filter((g) => g.holdoutId === holdoutId).at(-1);
  if (last === undefined) return `${holdoutId} has no G1 result on record`;
  if (last.configId !== e.configId) return `${holdoutId}'s latest G1 is for ${last.configId}, registered ${e.configId}`;
  return last.passed ? null : `${holdoutId}'s latest G1 did not pass`;
};

/**
 * Opens a sealed holdout for scoring, once (STATS-1's openHoldout), only when its latest G1 passed for the registered
 * configuration; otherwise refused. Misuse (early, mismatched, repeated) burns it, as STATS-1 rules.
 */
export const openSealedHoldout = (a: HoldoutAuthority, holdoutId: string,
  open: { readonly configId: string; readonly ledgerHash: string; readonly requiredTrades: number; readonly minDays: number; readonly nowMs: number }): HoldoutStore =>
  mutate(a, `Holdout ${holdoutId}: open`, (s) => {
    if (s === null) throw new RangeError(`holdout ${holdoutId} is not registered`);
    const blocked = g1Blocks(s, holdoutId);
    if (blocked !== null) throw new RangeError(`holdout ${holdoutId} cannot be opened: ${blocked}`);
    // The core registry also refuses an open before the tail has matured and checks the frozen requirement.
    const step = openHoldout(s.registry, holdoutId, { ...open, nowDay: new Date(open.nowMs).toISOString().slice(0, 10), g1Passed: true });
    const store = { ...s, registry: step.registry };
    return { store, value: store, ...(step.ok ? {} : { error: new RangeError(step.reason) }) };
  });

/**
 * Stores the registry G2 returns (gateG2 opens and burns holdouts itself). Refused unwritten unless only sealed
 * holdouts changed, each to opened or burned with nothing else touched, and every opened one had a latest G1 pass for
 * its registered configuration (g1Blocks) before this write.
 */
export const recordHoldoutG2 = (a: HoldoutAuthority, after: HoldoutRegistry): HoldoutStore =>
  mutate(a, 'Holdout G2: opened or burned seals', (s) => {
    if (s === null) throw new RangeError('no holdout registry');
    const before = s.registry;
    if (after.familySize !== before.familySize || after.entries.length !== before.entries.length) throw new RangeError('G2 may not add, remove or resize holdouts');
    const fixed = (e: HoldoutEntry) => canonical({ ...e, seal: null, openedAtMs: null, burned: null, burnReason: null });
    after.entries.forEach((e, k) => {
      const b = before.entries[k]!;
      if (canonical(b) === canonical(e)) return;
      if (b.holdoutId !== e.holdoutId || fixed(b) !== fixed(e)) throw new RangeError(`G2 changed more than the seal of ${b.holdoutId}`);
      if (b.seal !== 'sealed' || b.burned) throw new RangeError(`holdout ${b.holdoutId} was ${b.burned ? 'burned' : b.seal}, not sealed, before G2`);
      if (e.seal === 'opened') {
        const blocked = g1Blocks(s, b.holdoutId);
        if (blocked !== null) throw new RangeError(`holdout ${b.holdoutId} cannot be opened: ${blocked}`);
      } else if (!e.burned) throw new RangeError(`G2 left holdout ${b.holdoutId} ${e.seal} without a burn`);
    });
    const store = { ...s, registry: after };
    return { store, value: store };
  });

/**
 * Registers attempt `index` of the shared error budget: one holdout per universe, all on the plan's window, with their
 * configuration ids. Registering commits the attempt. The index must be the next one: a skipped or repeated index is
 * refused and burns the holdouts it names (and, if repeated, the earlier attempt's), recorded before the refusal.
 */
const addDays = (day: string, n: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const daysBetween = (from: string, to: string): number => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

export const registerAttempt = (a: HoldoutAuthority,
  req: {
    readonly index: number;
    /** Each holdout's frozen size requirement and n_power seed (from the walk-forward) are frozen with its registration (STATS-1c). */
    readonly entries: readonly { readonly holdoutId: string; readonly universe: string; readonly configId: string; readonly requirement: FrozenRequirement }[];
    readonly fromDay?: string;
  },
  now: Date = new Date()): HoldoutStore =>
  mutate(a, `Holdout attempt ${req.index}: registered ${req.entries.map((e) => e.holdoutId).join(', ')}`, (s) => {
    if (s === null || s.plan === null) throw new RangeError('no holdout plan: set the plan before registering an attempt');
    if (req.entries.length === 0) throw new RangeError('an attempt needs at least one holdout');
    const plan = s.plan;
    // The STATS-1c registry's next round (every BT attempt registers its holdouts at that attempt).
    const next = nextAttemptIndex(s.registry);
    if (req.index !== next) {
      let reg = s.registry;
      const why = `attempt ${req.index} asked, next is ${next}`;
      const repeated = s.attempts.find((x) => x.index === req.index);
      const ids = [...req.entries.map((e) => e.holdoutId), ...(repeated?.holdoutIds ?? [])];
      for (const id of ids) {
        const e = reg.entries.find((x) => x.holdoutId === id);
        if (e !== undefined && !e.burned) reg = burnHoldout(reg, id, 'reconfigured', why).registry;
      }
      return { store: { ...s, registry: reg }, value: s, error: new RangeError(`holdout attempt refused: ${why}`) };
    }
    // Attempt 1 takes the plan's window. Attempt k ≥ 2 is registered only after every earlier holdout is scored or
    // burned, and starts exactly on the first whole UTC day after its registration (the STATS-1c registry's rule; a
    // requested start must be that day), with 28 entry days and the plan's tail length.
    let aw: AttemptWindow;
    if (req.index === 1) aw = { fromDay: plan.fromDay, entryCutoffDay: plan.entryCutoffDay, tailEndDay: plan.tailEndDay };
    else {
      const open = s.attempts.flatMap((x) => x.holdoutIds).filter((id) => s.registry.entries.find((e) => e.holdoutId === id)?.burned !== true);
      if (open.length > 0) throw new RangeError(`holdout attempt ${req.index}: earlier holdouts are not scored yet (${open.join(', ')})`);
      const earliest = addDays(now.toISOString().slice(0, 10), 1);
      const fromDay = req.fromDay ?? earliest;
      if (fromDay !== earliest) throw new RangeError(`holdout attempt ${req.index}: its window cannot start before ${earliest} or after it, the first whole UTC day after registration`);
      const cutoff = addDays(fromDay, LATER_ATTEMPT_ENTRY_DAYS);
      aw = { fromDay, entryCutoffDay: cutoff, tailEndDay: addDays(cutoff, daysBetween(plan.entryCutoffDay, plan.tailEndDay)) };
    }
    const clashing = s.attempts.filter((x) => aw.fromDay < x.window.tailEndDay && x.window.fromDay < aw.tailEndDay).map((x) => x.index);
    if (clashing.length > 0) throw new RangeError(`holdout attempt ${req.index}: its window overlaps attempt ${clashing.join(', ')}`);
    const window = { fromDay: aw.fromDay, toDay: addDays(aw.tailEndDay, -1) };
    const clash = startedOverlapping(s, window, null);
    if (clash.length > 0) throw new RangeError(`holdout attempt ${req.index}: its window overlaps ${clash.join(', ')}, already run`);
    // The STATS-1c registry records the entry days, decides each holdout's attempt and α, and spends them now.
    const registeredOnDay = now.toISOString().slice(0, 10);
    let registry = s.registry;
    for (const e of req.entries) {
      registry = registerHoldout(registry, {
        holdoutId: e.holdoutId, universe: e.universe, configId: e.configId, fromDay: aw.fromDay, toDay: addDays(aw.entryCutoffDay, -1), registeredOnDay, attempt: req.index,
      });
      const step = freezeRequirement(registry, e.holdoutId, e.requirement);
      if (!step.ok) throw new RangeError(step.reason);
      registry = step.registry;
    }
    const added = registry.entries.filter((e) => req.entries.some((x) => x.holdoutId === e.holdoutId));
    const tail = added.find((e) => e.tailEnd !== aw.tailEndDay);
    if (tail !== undefined) throw new RangeError(`holdout ${tail.holdoutId}: the registry's tail ends ${tail.tailEnd}, the attempt's ${aw.tailEndDay}`);
    const alpha = added[0]!.alpha;
    const attempt: HoldoutAttempt = {
      index: req.index, alpha, window: aw, holdoutIds: req.entries.map((e) => e.holdoutId),
      configIds: Object.fromEntries(req.entries.map((e) => [e.holdoutId, e.configId])), registeredAt: now.toISOString(), started: null, ended: null,
    };
    const store = { ...s, registry, attempts: [...s.attempts, attempt] };
    return { store, value: store };
  });

/** Writes and publishes the store; when publishing fails, the local file goes back to what it was and the error stands. */
const saveStore = (path: string, store: HoldoutStore, vcs: RegistryVcs | undefined, message: string): void => {
  refuseSymlink(path);
  const before = existsSync(path) ? readFileSync(path, 'utf8') : null;
  writeHoldoutStore(path, store);
  if (vcs === undefined) return;
  try {
    vcs.commit(message);
  } catch (err) {
    if (before === null) rmSync(path, { force: true });
    else writeFileSync(path, before);
    throw err;
  }
};

/** Written whole to a temporary file and renamed, so a crash leaves the old or the new store, never half of one. */
export const writeHoldoutStore = (path: string, store: HoldoutStore): void => {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(store, null, 1)}\n`);
  renameSync(tmp, path);
};

/**
 * Registers S0's holdout attempt: the configuration id of exactly these options under this code and dataset, for each
 * universe S0 produces (another universe is refused), on the plan's window, with each holdout's size requirement and
 * n_power seed from the walk-forward (frozen in the same write, before any holdout count exists).
 */
export const authoriseHoldout = (a: HoldoutAuthority,
  req: { readonly attempt: number; readonly holdouts: readonly { readonly holdoutId: string; readonly universe: string; readonly requirement: FrozenRequirement }[] }, o: RunOptions): HoldoutStore => {
  const produced = s0Config(o).universe;
  for (const h of req.holdouts) if (h.universe !== produced) throw new RangeError(`holdout ${h.holdoutId}: the strategy produces ${produced}, not ${h.universe}`);
  const configId = holdoutConfigId(o, a);
  return registerAttempt(a, { index: req.attempt, entries: req.holdouts.map((h) => ({ ...h, configId })) });
};

export interface HoldoutTargets extends HoldoutAuthority {
  /** The registered holdout id of each universe the run feeds. */
  readonly byUniverse: Readonly<Record<string, string>>;
  /**
   * The run's window, UTC calendar days; it must equal the registered one, and every row must fall inside it. One
   * sealed ledger serves every registered universe of the run.
   */
  readonly window: { readonly fromDay: string; readonly toDay: string };
}

const utcDay = (blockTimeSeconds: number): string => new Date(blockTimeSeconds * 1000).toISOString().slice(0, 10);

/**
 * Runs an authorised holdout and seals it. Before anything runs, every universe's holdout must be registered with this
 * exact configuration id and window, unburned and never run (no earlier start record); otherwise the attempt is
 * refused and logged. A start record is written before the run, so a run killed mid-way spends the window. A run that
 * fails burns its holdouts ('run-failed'). Returns only the hash and counts.
 */
export const runAndSealHoldout = (o: RunOptions & { readonly ledgerPath: string }, t: HoldoutTargets): SealedHoldout => {
  const configId = holdoutConfigId(o, t);
  // Rows outside the authorised window stop the run (and so burn the holdout).
  const inWindow = (): Iterator<DatasetRow> => {
    const it = o.rows();
    return { next: () => {
      const r = it.next();
      if (!r.done) {
        const d = utcDay(r.value.blockTime);
        if (d < t.window.fromDay || d > t.window.toDay) throw new RangeError(`row at ${d} is outside the authorised window`);
      }
      return r;
    } };
  };
  return sealThroughStore(t, () => configId, o.ledgerPath, (cutoff) => runHoldout({ ...o, rows: inWindow, entryCutoff: cutoff }));
};

/**
 * The checks, start record, burn on failure and seal of runAndSealHoldout around any holdout run (BT-2's study run
 * writes its own ledger and outcomes). `configIdOf` gives the configuration each universe ran under; `run` receives
 * the attempt's entry cutoff (ms) and returns the seal: one hash and the counts per universe.
 */
export const sealThroughStore = (t: HoldoutTargets, configIdOf: (universe: string) => string, ledgerPath: string, run: (entryCutoffMs: number) => SealedHoldout): SealedHoldout => {
  t.vcs?.check();
  if (!existsSync(t.registryPath)) throw new RangeError(`no holdout registry at ${t.registryPath}: holdout not registered`);
  let store = readHoldoutStore(t.registryPath);
  const save = (message: string) => saveStore(t.registryPath, store, t.vcs, message);
  const universeOf = new Map(Object.entries(t.byUniverse).map(([u, id]) => [id, u]));
  const log = (holdoutId: string, outcome: HoldoutRunRecord['outcome'], reason: string) => {
    const u = universeOf.get(holdoutId);
    store = { ...store, runs: [...store.runs, { holdoutId, outcome, configId: u === undefined ? '' : configIdOf(u), ledgerPath, at: new Date().toISOString(), reason }] };
  };
  const burnAll = (why: string) => {
    let reg = store.registry;
    for (const id of Object.values(t.byUniverse)) if (reg.entries.some((e) => e.holdoutId === id)) reg = burnHoldout(reg, id, 'run-failed', why).registry;
    store = { ...store, registry: reg };
  };
  const refuse = (holdoutId: string, reason: string): never => {
    log(holdoutId, 'refused', reason);
    save(`Holdout ${holdoutId}: refused (${reason})`);
    throw new RangeError(`holdout ${holdoutId}: ${reason}`);
  };
  for (const [u, id] of Object.entries(t.byUniverse)) {
    const e = store.registry.entries.find((x) => x.holdoutId === id);
    if (e === undefined) refuse(id, 'not registered');
    else if (e.burned) refuse(id, `burned (${e.burnReason})`);
    else if (store.runs.some((r) => r.holdoutId === id && r.outcome !== 'refused')) {
      // A start without an end is a run that died: the window is spent.
      if (e.seal === 'registered') burnAll(`holdout ${id} has a start record and no result`);
      refuse(id, 'window already run');
    } else if (e.universe !== u) refuse(id, `registered for ${e.universe}, run for ${u}`);
    else if (e.configId !== configIdOf(u)) refuse(id, `configuration ${configIdOf(u)} is not the authorised ${e.configId}`);
    else if (e.requirement === null) refuse(id, 'no frozen size requirement');
    else {
      const w = runWindowOf(e);
      if (w.fromDay !== t.window.fromDay || w.toDay !== t.window.toDay) refuse(id, `window ${t.window.fromDay}..${t.window.toDay} is not the authorised ${w.fromDay}..${w.toDay}`);
    }
  }
  // One sealed ledger and one endpoint for every holdout of the attempt: the run must feed all of them.
  const ids = Object.values(t.byUniverse);
  const attempt = store.attempts.find((x) => ids.every((id) => x.holdoutIds.includes(id)));
  if (attempt === undefined || attempt.holdoutIds.length !== ids.length) refuse(ids[0] ?? '?', 'the run must feed every holdout of its registered attempt, and only those');
  const markAttempt = (patch: Partial<HoldoutAttempt>) => {
    store = { ...store, attempts: store.attempts.map((x) => (x.index === attempt!.index ? { ...x, ...patch } : x)) };
  };
  for (const id of ids) log(id, 'started', '');
  markAttempt({ started: new Date().toISOString() });
  save(`Holdout ${ids.join(', ')}: started`);
  t.vcs?.check();
  // Entries stop at the attempt's cutoff; the run keeps observing to the end of the tail so every position can finish.
  const cutoff = Date.parse(`${attempt!.window.entryCutoffDay}T00:00:00Z`);
  let sealed: SealedHoldout;
  try {
    sealed = run(cutoff);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    burnAll(why);
    for (const id of Object.values(t.byUniverse)) log(id, 'failed', why);
    markAttempt({ ended: { at: new Date().toISOString(), outcome: 'failed' } });
    save(`Holdout ${Object.values(t.byUniverse).join(', ')}: failed and burned`);
    throw err;
  }
  for (const [u, id] of Object.entries(t.byUniverse)) {
    const counts = sealed.counts[u] ?? { candidates: 0, entries: 0, entryDays: 0 };
    const step = sealHoldout(store.registry, id, { configId: configIdOf(u), ledgerHash: sealed.ledgerHash, counts });
    store = { ...store, registry: step.registry };
    log(id, step.ok ? 'sealed' : 'failed', step.reason);
  }
  markAttempt({ ended: { at: new Date().toISOString(), outcome: 'sealed' } });
  save(`Holdout ${Object.values(t.byUniverse).join(', ')}: sealed ${sealed.ledgerHash.slice(0, 12)}`);
  return sealed;
};

export const runHoldout = (o: RunOptions & { readonly ledgerPath: string }): SealedHoldout => {
  if (existsSync(o.ledgerPath)) throw new RangeError(`${o.ledgerPath} exists: a holdout is run once, into a new file`);
  let r: ReturnType<typeof runBacktest>;
  try {
    r = runBacktest(o);
  } finally {
    // Read-only whatever happened, so a failed holdout file cannot be edited and rerun as if new.
    if (existsSync(o.ledgerPath)) chmodSync(o.ledgerPath, 0o400);
  }
  // Validity failures carry no outcome, so they may be reported; a crashed or illegal run cannot be sealed.
  if (r.stats.crash !== null) throw new Error(`holdout run crashed: ${r.stats.crash}`);
  if (r.stats.illegalStates !== 0 || r.stats.unreconciledIntents !== 0) throw new Error('holdout run has illegal states or unreconciled intents; not sealed');
  const universeOf = new Map<string, string>();
  const counts: Record<string, { candidates: number; entries: number; days: Set<string> }> = {};
  for (const rec of r.records) {
    if (rec.type !== 'decision' || rec.reasons[0] !== 'candidate') continue;
    const [, u, mint] = rec.reasons as [string, string, string];
    universeOf.set(mint, u);
    (counts[u] ??= { candidates: 0, entries: 0, days: new Set() }).candidates++;
  }
  // An entry is a filled entry attempt; only its time is read.
  for (const a of r.attempts) {
    if (a.purpose !== 'entry' || a.outcome !== 'filled' || a.landedAt === null) continue;
    const u = universeOf.get(a.mint);
    if (u === undefined) throw new Error('an entry without a candidate decision');
    counts[u]!.entries++;
    counts[u]!.days.add(melbourneDay(a.landedAt));
  }
  const ledgerHash = createHash('sha256').update(readFileSync(o.ledgerPath)).digest('hex');
  return {
    ledgerHash,
    counts: Object.fromEntries(Object.entries(counts).map(([u, c]): [string, HoldoutCounts] => [u, { candidates: c.candidates, entries: c.entries, entryDays: c.days.size }])),
  };
};
