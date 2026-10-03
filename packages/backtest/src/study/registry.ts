// The study's registry on disk (docs/ARCHITECTURE.md §13.2, §14): STATS-1's holdout registry, the log of every
// holdout run, and the experiment registry of every trial evaluated. One JSON file, committed with the evidence.
//
// Every holdout run is recorded before it starts (PR #24 review follow-up). A run that finds an earlier run of the
// same holdout, finished or not, burns the holdout and stops: a holdout cannot be run again into a new file, and a
// run that crashed half-way counts as a look. New proof needs a new, later window.
import { readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import {
  burnHoldout, createHoldoutRegistry, type HoldoutCounts, type HoldoutRegistry, registerHoldout, type RegistryStep, sealHoldout, type TrialRecord,
} from '../../../core/src/stats/index.ts';

export interface HoldoutRun {
  /** The holdouts this run covers (one per universe, same window). */
  readonly holdoutIds: readonly string[];
  readonly ledgerPath: string;
  /** Wall-clock start, for the record only (the engine never reads it). */
  readonly startedAt: string;
  readonly status: 'started' | 'sealed' | 'failed';
  /** sha256 of the sealed bundle (ledger and outcomes), once sealed. */
  readonly sealHash: string | null;
  readonly detail: string | null;
}

/** The holdout boundary as fixed before any data was read, with the assumptions its size was planned from. */
export interface HoldoutPlan {
  readonly study: string;
  readonly decisionWindow: { readonly from: string; readonly to: string; readonly leadInFrom: string };
  readonly holdout: { readonly fromDay: string; readonly toDay: string; readonly entriesFrom: string; readonly entriesTo: string };
  readonly practice: { readonly fromDay: string; readonly toDay: string; readonly postB4From: string };
  readonly after: { readonly label: string; readonly at: string };
  readonly embargoMs: number;
  readonly familySize: number;
  readonly holdoutIds: readonly string[];
  /** Pre-registered estimates only: nothing here was measured on data. */
  readonly sizing: Readonly<Record<string, string | number>>;
}

export interface StudyRegistry {
  readonly version: 1;
  readonly plan?: HoldoutPlan;
  readonly holdouts: HoldoutRegistry;
  readonly runs: readonly HoldoutRun[];
  readonly trials: readonly (TrialRecord & { readonly configId: string; readonly evaluatedOn: string })[];
}

export const newStudyRegistry = (familySize: number): StudyRegistry => ({ version: 1, holdouts: createHoldoutRegistry(familySize), runs: [], trials: [] });

export const readStudyRegistry = (path: string): StudyRegistry => {
  const r = JSON.parse(readFileSync(path, 'utf8')) as StudyRegistry;
  if (r.version !== 1 || !Array.isArray(r.runs) || !Array.isArray(r.trials) || r.holdouts === undefined) throw new RangeError(`${path} is not a study registry`);
  return r;
};

/** Written to a temporary file and renamed, so a crash never leaves a half-written registry. */
export const writeStudyRegistry = (path: string, r: StudyRegistry): void => {
  writeFileSync(`${path}.tmp`, `${JSON.stringify(r, null, 1)}\n`);
  renameSync(`${path}.tmp`, path);
};

export const loadOrCreate = (path: string, familySize: number): StudyRegistry => (existsSync(path) ? readStudyRegistry(path) : newStudyRegistry(familySize));

export const register = (r: StudyRegistry, entries: Parameters<typeof registerHoldout>[1][]): StudyRegistry =>
  ({ ...r, holdouts: entries.reduce((h, e) => registerHoldout(h, e), r.holdouts) });

/** Adds a trial unless one with the same id is there (the same configuration evaluated on the same data). */
export const recordTrial = (r: StudyRegistry, t: StudyRegistry['trials'][number]): StudyRegistry =>
  (r.trials.some((x) => x.trialId === t.trialId) ? r : { ...r, trials: [...r.trials, t] });

export type BeginResult = { readonly ok: true; readonly registry: StudyRegistry } | { readonly ok: false; readonly registry: StudyRegistry; readonly reason: string };

/**
 * Records the start of a holdout run. Refused, and every holdout it names burned, when any of them was run before
 * (whatever that run's status), is burned, or is not in the registered state.
 */
export const beginHoldoutRun = (r: StudyRegistry, holdoutIds: readonly string[], ledgerPath: string, startedAt: string): BeginResult => {
  const problems: string[] = [];
  for (const id of holdoutIds) {
    const e = r.holdouts.entries.find((x) => x.holdoutId === id);
    if (e === undefined) problems.push(`${id} is not registered`);
    else if (e.burned) problems.push(`${id} is burned (${e.burnReason})`);
    else if (e.seal !== 'registered') problems.push(`${id} is ${e.seal}`);
    const prior = r.runs.find((x) => x.holdoutIds.includes(id));
    if (prior !== undefined) problems.push(`${id} was already run into ${prior.ledgerPath} (${prior.status}, started ${prior.startedAt})`);
  }
  if (problems.length === 0) {
    return { ok: true, registry: { ...r, runs: [...r.runs, { holdoutIds: [...holdoutIds], ledgerPath, startedAt, status: 'started', sealHash: null, detail: null }] } };
  }
  let holdouts = r.holdouts;
  for (const id of holdoutIds) {
    if (!holdouts.entries.some((x) => x.holdoutId === id)) continue;
    holdouts = burnHoldout(holdouts, id, 'reconfigured', `a second holdout run was attempted: ${problems.join('; ')}`).registry;
  }
  return { ok: false, registry: { ...r, holdouts }, reason: problems.join('; ') };
};

const updateRun = (r: StudyRegistry, holdoutIds: readonly string[], patch: Partial<HoldoutRun>): StudyRegistry => ({
  ...r,
  runs: r.runs.map((x) => (x.status === 'started' && x.holdoutIds.join('|') === holdoutIds.join('|') ? { ...x, ...patch } : x)),
});

/** Seals each universe's holdout with the bundle hash and its counts (candidates and entries only). */
export const sealHoldoutRun = (
  r: StudyRegistry, byUniverse: readonly { readonly holdoutId: string; readonly configId: string; readonly counts: HoldoutCounts }[], sealHash: string,
): { readonly registry: StudyRegistry; readonly steps: readonly RegistryStep[] } => {
  let holdouts = r.holdouts;
  const steps: RegistryStep[] = [];
  for (const u of byUniverse) {
    const step = sealHoldout(holdouts, u.holdoutId, { configId: u.configId, ledgerHash: sealHash, counts: u.counts });
    holdouts = step.registry;
    steps.push(step);
  }
  const ids = byUniverse.map((u) => u.holdoutId);
  return { registry: updateRun({ ...r, holdouts }, ids, { status: steps.every((s) => s.ok) ? 'sealed' : 'failed', sealHash }), steps };
};

/** A run that failed before it could seal: it stays recorded (and so counts as a look). */
export const failHoldoutRun = (r: StudyRegistry, holdoutIds: readonly string[], detail: string): StudyRegistry => updateRun(r, holdoutIds, { status: 'failed', detail });
