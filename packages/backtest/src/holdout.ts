// Holdout mode (docs/ARCHITECTURE.md §14): the run writes fills, exits and P&L into a separate sealed ledger file and
// exposes only the file's hash and, per universe, the candidate and entry counts (and entry days, from entry times
// only). Nothing else leaves this function: no exit count, fill, P&L or log line. The file is made read-only; only the
// scoring stage opens it, once, after STATS-1's size check passes.
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { canonical } from '../../core/src/engine/index.ts';
import { burnHoldout, createHoldoutRegistry, type HoldoutCounts, type HoldoutRegistry, registerHoldout, sealHoldout } from '../../core/src/stats/index.ts';
import type { DatasetRow } from './dataset/rows.ts';
import { melbourneDay } from './report.ts';
import { type RunOptions, runBacktest, s0Config } from './run.ts';

export interface SealedHoldout {
  /** sha256 of the sealed ledger file. */
  readonly ledgerHash: string;
  readonly counts: Readonly<Record<string, HoldoutCounts>>;
}

/**
 * Version control of the registry file (the CLI's is git): `check` refuses unless the file is tracked and unchanged
 * from HEAD (or, before the first registration, absent); `commit` records a write. Every start and burn becomes a
 * commit, so deleting or rewinding the file shows in history.
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

const overlaps = (a: { fromDay: string; toDay: string }, b: { fromDay: string; toDay: string }): boolean => a.fromDay <= b.toDay && b.fromDay <= a.toDay;

/** Holdouts with a start record whose window overlaps `w`, other than `exceptId`. */
const startedOverlapping = (store: HoldoutStore, w: { fromDay: string; toDay: string }, exceptId: string | null): string[] =>
  store.registry.entries
    .filter((e) => e.holdoutId !== exceptId && overlaps(e, w) && store.runs.some((r) => r.holdoutId === e.holdoutId && r.outcome !== 'refused'))
    .map((e) => e.holdoutId);

/**
 * The days a research run may read (H1 of the BT-1c review): never a day at or after the reserved holdout start, nor
 * one inside any registered window. Explicitly chosen days that break this are refused; without a choice, only
 * allowed (practice) days are kept.
 */
export const researchDays = (days: readonly string[], research: RunOptions['research'], store: HoldoutStore | null, explicit: boolean): string[] => {
  const why = (d: string): string | null => {
    if (d >= research.holdout.fromDay) return `${d} is at or after the reserved holdout start ${research.holdout.fromDay}`;
    const e = store?.registry.entries.find((x) => x.fromDay <= d && d <= x.toDay);
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

export interface HoldoutStore {
  readonly registry: HoldoutRegistry;
  readonly runs: readonly HoldoutRunRecord[];
}

export const readHoldoutStore = (path: string): HoldoutStore => JSON.parse(readFileSync(path, 'utf8')) as HoldoutStore;

/** Written whole to a temporary file and renamed, so a crash leaves the old or the new store, never half of one. */
export const writeHoldoutStore = (path: string, store: HoldoutStore): void => {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(store, null, 1)}\n`);
  renameSync(tmp, path);
};

/**
 * Registers a holdout before anything runs: the research config's window (from the reserved start to the end of the
 * tail; entries stop at the cutoff) and the configuration id of exactly these options under this code and dataset.
 * Refuses a universe the strategy does not produce and a window overlapping one already started under any id or
 * universe. Creates the registry file (with the Holm family size) if it does not exist.
 */
export const authoriseHoldout = (a: HoldoutAuthority, familySize: number, entry: { readonly holdoutId: string; readonly universe: string }, o: RunOptions): HoldoutStore => {
  a.vcs?.check();
  const produced = s0Config(o).universe;
  if (entry.universe !== produced) throw new RangeError(`holdout ${entry.holdoutId}: the strategy produces ${produced}, not ${entry.universe}`);
  const window = holdoutWindow(o);
  const store: HoldoutStore = existsSync(a.registryPath) ? readHoldoutStore(a.registryPath) : { registry: createHoldoutRegistry(familySize), runs: [] };
  const clash = startedOverlapping(store, window, null);
  if (clash.length > 0) throw new RangeError(`holdout ${entry.holdoutId}: its window overlaps ${clash.join(', ')}, already run`);
  const next = { ...store, registry: registerHoldout(store.registry, { ...entry, ...window, configId: holdoutConfigId(o, a) }) };
  writeHoldoutStore(a.registryPath, next);
  a.vcs?.commit(`Holdout ${entry.holdoutId}: registered ${window.fromDay}..${window.toDay}, entries before ${o.research.holdout.entryCutoffDay}`);
  return next;
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
  t.vcs?.check();
  if (!existsSync(t.registryPath)) throw new RangeError(`no holdout registry at ${t.registryPath}: holdout not registered`);
  let store = readHoldoutStore(t.registryPath);
  const save = (message: string) => {
    writeHoldoutStore(t.registryPath, store);
    t.vcs?.commit(message);
  };
  const log = (holdoutId: string, outcome: HoldoutRunRecord['outcome'], reason: string) => {
    store = { ...store, runs: [...store.runs, { holdoutId, outcome, configId, ledgerPath: o.ledgerPath, at: new Date().toISOString(), reason }] };
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
    else if (e.configId !== configId) refuse(id, `configuration ${configId} is not the authorised ${e.configId}`);
    else if (e.fromDay !== t.window.fromDay || e.toDay !== t.window.toDay) refuse(id, `window ${t.window.fromDay}..${t.window.toDay} is not the authorised ${e.fromDay}..${e.toDay}`);
  }
  for (const id of Object.values(t.byUniverse)) log(id, 'started', '');
  save(`Holdout ${Object.values(t.byUniverse).join(', ')}: started`);
  t.vcs?.check();
  // Entries stop at the cutoff; the run keeps observing to the end of the tail so every position can finish.
  const cutoff = Date.parse(`${o.research.holdout.entryCutoffDay}T00:00:00Z`);
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
  let sealed: SealedHoldout;
  try {
    sealed = runHoldout({ ...o, rows: inWindow, entryCutoff: cutoff });
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    burnAll(why);
    for (const id of Object.values(t.byUniverse)) log(id, 'failed', why);
    save(`Holdout ${Object.values(t.byUniverse).join(', ')}: failed and burned`);
    throw err;
  }
  for (const [u, id] of Object.entries(t.byUniverse)) {
    const counts = sealed.counts[u] ?? { candidates: 0, entries: 0, entryDays: 0 };
    const step = sealHoldout(store.registry, id, { configId, ledgerHash: sealed.ledgerHash, counts });
    store = { ...store, registry: step.registry };
    log(id, step.ok ? 'sealed' : 'failed', step.reason);
  }
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
