// The sealed holdout (docs/ARCHITECTURE.md §14 "Holdout discipline"), through the one holdout registry (src/holdout.ts:
// checks, start record, burn on failure, seal). Its ledger and its outcomes go into two read-only files whose combined
// hash seals each universe's holdout with its candidate and entry counts. Nothing else leaves `runSealedHoldout`: no exit count, fill, P&L or log line.
// The outcomes are read once, by `openSealed`, in the scoring stage, after the size check passes on the counts.
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { FillConfig } from '../../../core/src/config/index.ts';
import { holdoutReady, type HoldoutCounts, MIN_DAYS } from '../../../core/src/stats/index.ts';
import { g1Blocks, type HoldoutAuthority, type HoldoutStore, sealThroughStore } from '../holdout.ts';
import type { DatasetRow } from '../dataset/rows.ts';
import { runStudy, type StudyRunOptions } from './run.ts';
import { countsOf, type FunderOf, scoreRun, type ScoredTrade } from './score.ts';
import { rejectMixOf } from './summary.ts';

export interface SealedTargets {
  /** Per universe: its registered holdout and configuration. */
  /** Per universe: its registered holdout and configuration, and the configuration's tag (hypothesis id, else universe). */
  readonly byUniverse: readonly { readonly universe: string; readonly tag?: string; readonly holdoutId: string; readonly configId: string }[];
  /** Trades each universe needs before its seal may open (max(300, n_power)); S0 runs only when one is ready. */
  readonly required: Readonly<Record<string, number>>;
  /** The registered window, first and last UTC day (the data runs on to its last day; rows after it stop the run). */
  readonly window: { readonly fromDay: string; readonly toDay: string };
  /** G2's funder cluster per mint (none: no label). */
  readonly funderOf?: FunderOf;
}

export interface SealedResult {
  readonly sealHash: string;
  readonly counts: Readonly<Record<string, HoldoutCounts>>;
}

interface Outcomes {
  readonly strategy: Readonly<Record<string, readonly ScoredTrade[]>>;
  /** S0 trades per seed, per universe; empty when no universe had enough entries to be scored. */
  readonly s0: readonly Readonly<Record<string, readonly ScoredTrade[]>>[];
  /** Per universe: never-entered candidates by the typed reason of their last abstention (G3's reject mix). */
  readonly rejectMix: Readonly<Record<string, Readonly<Record<string, number>>>>;
}

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
/** The seal: sha256 over the two files' hashes, so neither can change without breaking it. */
export const sealHashOf = (ledgerPath: string, outcomesPath: string): string => sha(`${sha(readFileSync(ledgerPath))}\n${sha(readFileSync(outcomesPath))}\n`);
const outcomesPathOf = (ledgerPath: string) => `${ledgerPath}.outcomes.json`;

const byTag = (trades: readonly ScoredTrade[], tags: readonly string[]) => Object.fromEntries(tags.map((t) => [t, trades.filter((x) => x.tag === t)]));

/**
 * Runs the holdout once, through the registry: refused (and logged) unless every universe's holdout is registered with
 * its configuration and window, never run and unburned; recorded before it starts; burned when it fails. `run` holds
 * the holdout's entry window, whose end must be the registered cutoff; `ledgerPath` must not exist.
 */
export const runSealedHoldout = (
  authority: HoldoutAuthority, ledgerPath: string, run: Omit<StudyRunOptions, 'mode' | 'ledgerPath'>, targets: SealedTargets, s0Seeds: readonly string[], fills: FillConfig,
): SealedResult => {
  const outcomesPath = outcomesPathOf(ledgerPath);
  for (const p of [ledgerPath, outcomesPath]) if (existsSync(p)) throw new RangeError(`${p} exists: a holdout is run once, into new files`);
  const configOf = new Map(targets.byUniverse.map((u) => [u.universe, u.configId]));
  const t = { ...authority, byUniverse: Object.fromEntries(targets.byUniverse.map((u) => [u.universe, u.holdoutId])), window: targets.window };
  const sealed = sealThroughStore(t, (u) => configOf.get(u) ?? '', ledgerPath, (cutoff) => {
    const lock = () => { for (const p of [ledgerPath, outcomesPath]) if (existsSync(p)) chmodSync(p, 0o400); };
    try {
      if (run.entriesTo !== cutoff) throw new RangeError(`entries end at ${new Date(run.entriesTo).toISOString()}, the registered cutoff is ${new Date(cutoff).toISOString()}`);
      // The lead-in before the window feeds history only (no entries); nothing after the window's last day may be read.
      const rows = run.rows;
      const last = Date.parse(`${targets.window.toDay}T00:00:00Z`) + 86_400_000;
      const bounded = (): Iterator<DatasetRow> => {
        const it = rows();
        return { next: () => {
          const r = it.next();
          if (!r.done && r.value.blockTime * 1000 >= last) throw new RangeError(`row at ${new Date(r.value.blockTime * 1000).toISOString()} is after the registered window`);
          return r;
        } };
      };
      const r = runStudy({ ...run, rows: bounded, mode: 'strategy', ledgerPath });
      // Validity failures carry no outcome, so they may be reported.
      if (r.stats.crash !== null) throw new Error(`crashed: ${r.stats.crash}`);
      if (r.stats.illegalStates !== 0 || r.stats.unreconciledIntents !== 0) throw new Error('illegal states or unreconciled intents');
      const all = countsOf(r);
      const counts: Record<string, HoldoutCounts> = Object.fromEntries(targets.byUniverse.map((u) => [u.universe, all[u.tag ?? u.universe] ?? { candidates: 0, entries: 0, entryDays: 0 }]));
      const tags = targets.byUniverse.map((u) => u.universe);
      const tagOfU = new Map(targets.byUniverse.map((u) => [u.universe, u.tag ?? u.universe]));
      // S0 is needed only by a universe that can be scored; the decision reads the counts alone.
      const ready = targets.byUniverse.some((u) => counts[u.universe]!.entries >= (targets.required[u.universe] ?? Infinity) && counts[u.universe]!.entryDays >= MIN_DAYS);
      const s0 = ready
        ? s0Seeds.map((seed) => {
          const x = runStudy({ ...run, rows: bounded, mode: 's0', seed });
          if (x.stats.crash !== null || x.stats.illegalStates !== 0) throw new Error(`S0 seed ${seed}: crashed or illegal states`);
          return byTag(scoreRun(x, fills, targets.funderOf), tags.map((tg) => `S0-${tg}`));
        })
        : [];
      const scored = scoreRun(r, fills, targets.funderOf);
      const outcomes: Outcomes = { strategy: Object.fromEntries(tags.map((u) => [u, scored.filter((x) => x.tag === tagOfU.get(u))])), s0, rejectMix: Object.fromEntries(tags.map((u) => [u, rejectMixOf(r.records, tagOfU.get(u)!)])) };
      writeFileSync(outcomesPath, `${JSON.stringify(outcomes)}\n`);
      lock();
      return { ledgerHash: sealHashOf(ledgerPath, outcomesPath), counts };
    } catch (e) {
      lock();
      throw e;
    }
  });
  return { sealHash: sealed.ledgerHash, counts: sealed.counts };
};

/** Whether a universe's sealed counts pass the size check (counts only; nothing is read from the sealed files). */
export const sealedReady = (store: HoldoutStore, holdoutId: string, required: number): boolean => {
  const e = store.registry.entries.find((x) => x.holdoutId === holdoutId);
  return e !== undefined && holdoutReady(e, required, e.requirement?.requiredDays ?? MIN_DAYS);
};

/**
 * The scoring stage's one read of the sealed outcomes. The caller must have passed the size check; the hash of the
 * files is returned with them so G2 verifies it against the registry before opening (a mismatch burns the holdout).
 */
export const openSealed = (ledgerPath: string, store: HoldoutStore, holdoutIds: readonly string[]): { readonly sealHash: string; readonly outcomes: Outcomes } => {
  // Never opened on a G1 fail: the registry refuses unless every holdout to score has a latest G1 pass on record.
  const blocks = holdoutIds.map((id) => g1Blocks(store, id)).filter((x): x is string => x !== null);
  if (blocks.length > 0) throw new Error(`the sealed holdout stays closed: ${blocks.join('; ')}`);
  const outcomesPath = outcomesPathOf(ledgerPath);
  return { sealHash: sealHashOf(ledgerPath, outcomesPath), outcomes: JSON.parse(readFileSync(outcomesPath, 'utf8')) as Outcomes };
};
