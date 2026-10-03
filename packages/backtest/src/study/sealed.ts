// The sealed holdout (docs/ARCHITECTURE.md §14 "Holdout discipline"). The run is recorded in the registry before it
// starts; its ledger and its outcomes go into two read-only files whose combined hash seals each universe's holdout
// with its candidate and entry counts. Nothing else leaves `runSealedHoldout`: no exit count, fill, P&L or log line.
// The outcomes are read once, by `openSealed`, in the scoring stage, after the size check passes on the counts.
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { FillConfig } from '../../../core/src/config/index.ts';
import { holdoutReady, type HoldoutCounts, MIN_DAYS } from '../../../core/src/stats/index.ts';
import { beginHoldoutRun, failHoldoutRun, g1Blocks, readStudyRegistry, sealHoldoutRun, type StudyRegistry, writeStudyRegistry } from './registry.ts';
import { runStudy, type StudyRunOptions } from './run.ts';
import { countsOf, scoreRun, type ScoredTrade } from './score.ts';

export interface SealedTargets {
  /** Per universe: its registered holdout and configuration. */
  readonly byUniverse: readonly { readonly universe: string; readonly holdoutId: string; readonly configId: string }[];
  /** Trades each universe needs before its seal may open (max(300, n_power)); S0 runs only when one is ready. */
  readonly required: Readonly<Record<string, number>>;
}

export interface SealedResult {
  readonly sealHash: string;
  readonly counts: Readonly<Record<string, HoldoutCounts>>;
}

interface Outcomes {
  readonly strategy: Readonly<Record<string, readonly ScoredTrade[]>>;
  /** S0 trades per seed, per universe; empty when no universe had enough entries to be scored. */
  readonly s0: readonly Readonly<Record<string, readonly ScoredTrade[]>>[];
}

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
/** The seal: sha256 over the two files' hashes, so neither can change without breaking it. */
export const sealHashOf = (ledgerPath: string, outcomesPath: string): string => sha(`${sha(readFileSync(ledgerPath))}\n${sha(readFileSync(outcomesPath))}\n`);
const outcomesPathOf = (ledgerPath: string) => `${ledgerPath}.outcomes.json`;

const byTag = (trades: readonly ScoredTrade[], tags: readonly string[]) => Object.fromEntries(tags.map((t) => [t, trades.filter((x) => x.tag === t)]));

/**
 * Runs the holdout once. `run` holds the holdout's entry window; `ledgerPath` must not exist. Throws (after recording
 * the run as failed) when the registry refuses the run, the run crashes or its book is not clean.
 */
export const runSealedHoldout = (
  registryPath: string, ledgerPath: string, run: Omit<StudyRunOptions, 'mode' | 'ledgerPath'>, targets: SealedTargets, s0Seeds: readonly string[], fills: FillConfig, startedAt: string,
): SealedResult => {
  const ids = targets.byUniverse.map((u) => u.holdoutId);
  const outcomesPath = outcomesPathOf(ledgerPath);
  for (const p of [ledgerPath, outcomesPath]) if (existsSync(p)) throw new RangeError(`${p} exists: a holdout is run once, into new files`);
  let reg: StudyRegistry = readStudyRegistry(registryPath);
  const begun = beginHoldoutRun(reg, ids, ledgerPath, startedAt, run.study.holdoutAttempt);
  writeStudyRegistry(registryPath, begun.registry);
  if (!begun.ok) throw new Error(`holdout run refused and burned: ${begun.reason}`);
  reg = begun.registry;
  const fail = (why: string): never => {
    writeStudyRegistry(registryPath, failHoldoutRun(reg, ids, why));
    for (const p of [ledgerPath, outcomesPath]) if (existsSync(p)) chmodSync(p, 0o400);
    throw new Error(`holdout run failed: ${why}`);
  };
  let r: ReturnType<typeof runStudy>;
  try {
    r = runStudy({ ...run, mode: 'strategy', ledgerPath });
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
  // Validity failures carry no outcome, so they may be reported.
  if (r.stats.crash !== null) fail(`crashed: ${r.stats.crash}`);
  if (r.stats.illegalStates !== 0 || r.stats.unreconciledIntents !== 0) fail('illegal states or unreconciled intents');
  const all = countsOf(r);
  const counts: Record<string, HoldoutCounts> = Object.fromEntries(targets.byUniverse.map((u) => [u.universe, all[u.universe] ?? { candidates: 0, entries: 0, entryDays: 0 }]));
  const tags = targets.byUniverse.map((u) => u.universe);
  // S0 is needed only by a universe that can be scored; the decision reads the counts alone.
  const ready = targets.byUniverse.some((u) => counts[u.universe]!.entries >= (targets.required[u.universe] ?? Infinity) && counts[u.universe]!.entryDays >= MIN_DAYS);
  const s0 = ready
    ? s0Seeds.map((seed) => {
      const x = runStudy({ ...run, mode: 's0', seed });
      if (x.stats.crash !== null || x.stats.illegalStates !== 0) fail(`S0 seed ${seed}: crashed or illegal states`);
      return byTag(scoreRun(x, fills), tags.map((t) => `S0-${t}`));
    })
    : [];
  const outcomes: Outcomes = { strategy: byTag(scoreRun(r, fills), tags), s0 };
  writeFileSync(outcomesPath, `${JSON.stringify(outcomes)}\n`);
  chmodSync(outcomesPath, 0o400);
  chmodSync(ledgerPath, 0o400);
  const sealHash = sealHashOf(ledgerPath, outcomesPath);
  const sealed = sealHoldoutRun(reg, targets.byUniverse.map((u) => ({ holdoutId: u.holdoutId, configId: u.configId, counts: counts[u.universe]! })), sealHash);
  writeStudyRegistry(registryPath, sealed.registry);
  const bad = sealed.steps.find((s) => !s.ok);
  if (bad !== undefined) throw new Error(`holdout not sealed: ${bad.reason}`);
  return { sealHash, counts };
};

/** Whether a universe's sealed counts pass the size check (counts only; nothing is read from the sealed files). */
export const sealedReady = (reg: StudyRegistry, holdoutId: string, required: number): boolean => {
  const e = reg.holdouts.entries.find((x) => x.holdoutId === holdoutId);
  return e !== undefined && holdoutReady(e, required, MIN_DAYS);
};

/**
 * The scoring stage's one read of the sealed outcomes. The caller must have passed the size check; the hash of the
 * files is returned with them so G2 verifies it against the registry before opening (a mismatch burns the holdout).
 */
export const openSealed = (ledgerPath: string, reg: StudyRegistry, holdoutIds: readonly string[]): { readonly sealHash: string; readonly outcomes: Outcomes } => {
  // Never opened on a G1 fail: the registry refuses unless every holdout to score has a latest G1 pass on record.
  const blocks = holdoutIds.map((id) => g1Blocks(reg, id)).filter((x): x is string => x !== null);
  if (blocks.length > 0) throw new Error(`the sealed holdout stays closed: ${blocks.join('; ')}`);
  const outcomesPath = outcomesPathOf(ledgerPath);
  return { sealHash: sealHashOf(ledgerPath, outcomesPath), outcomes: JSON.parse(readFileSync(outcomesPath, 'utf8')) as Outcomes };
};
