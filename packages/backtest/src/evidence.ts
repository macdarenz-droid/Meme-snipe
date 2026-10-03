// Pre-funding gate evidence, items 1 and 2 (CLAUDE.md "No deposit before proof"; BT-3): every assembled window of a
// day range is replayed through the same engine code `replays` times and must give identical decision-log hashes, with
// zero crashes, zero illegal states, zero unreconciled intents, the mirror book equal to the engine's, and the ledger
// replay check (LEDGER-REPLAY) passing on the run's ledger. What it ran on is recorded: the code commit, each window's
// manifest and SHA256SUMS digests, release tag and scanner revisions.
//
// Gate mode needs each window assembled with its 14 lead-in days and verified against SHA256SUMS. The labelled
// no-lead-in mode checks determinism on a window without its lead-in; its output says gate: false and is never gate
// evidence.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FillConfig, Policy, ResearchConfig } from '../../core/src/config/index.ts';
import type { ScenarioName } from '../../core/src/fills/index.ts';
import { loadDay, loadManifest, manifestHash, regimeBoundariesOf, verifySums } from './dataset/dataset.ts';
import type { OffchainSeries } from './dataset/offchain.ts';
import type { DatasetRow } from './dataset/rows.ts';
import { runBacktest, type RunOptions } from './run.ts';

/** The lead-in every gate window needs (DATA-1: finalize -lead-in-days 14). */
export const GATE_LEAD_IN_DAYS = 14;

/** The ledger replay check (core ledger/replay), passed in so this module never imports it. */
export type LedgerReplay = (path: string) => { readonly ok: boolean; readonly failure?: unknown; readonly counts?: unknown };

export interface EvidenceWindow {
  readonly dir: string;
  /** The release the window came from (data-FROM-TO), when fetched. */
  readonly release?: string;
}

export interface EvidenceInput {
  readonly windows: readonly EvidenceWindow[];
  readonly mode: 'gate' | 'no-lead-in';
  readonly replays: number;
  readonly scenario: ScenarioName;
  readonly seed: string;
  readonly solUsd: OffchainSeries;
  readonly policy: Policy;
  readonly fills: FillConfig;
  readonly research: ResearchConfig;
  /** The code commit the evidence runs on; refused when the tree carries code changes (see the script). */
  readonly commit: string;
  readonly ledgerReplay: LedgerReplay;
  /** Where the run writes its ledger files. */
  readonly workDir: string;
}

export interface WindowEvidence {
  readonly dir: string;
  readonly release: string | null;
  readonly window: { readonly from: string; readonly toExclusive: string };
  readonly leadInDays: number;
  readonly days: readonly string[];
  readonly manifestSha256: string;
  readonly sha256sumsSha256: string | null;
  readonly filesChecked: number;
  readonly scannerRevisions: readonly string[];
  readonly hashes: readonly string[];
  readonly identicalReplays: boolean;
  readonly crashes: number;
  readonly crash: string | null;
  readonly illegalStates: number;
  readonly unreconciledIntents: number;
  readonly mirrorMatches: boolean;
  readonly ledgerReplay: { readonly ok: boolean; readonly failure: unknown; readonly counts: unknown };
  readonly counts: Readonly<Record<string, number>>;
  readonly elapsedMs: readonly number[];
  readonly pass: boolean;
}

export interface Evidence {
  readonly kind: 'pre-funding gate items 1 and 2';
  readonly mode: 'gate' | 'no-lead-in';
  /** True only in gate mode: a no-lead-in run is never gate evidence. */
  readonly gate: boolean;
  readonly commit: string;
  readonly replays: number;
  readonly scenario: ScenarioName;
  readonly seed: string;
  readonly configs: { readonly fills: string; readonly research: string; readonly policy: string };
  readonly windows: readonly WindowEvidence[];
  readonly pass: boolean;
}

const sha256File = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');

export const runEvidence = (input: EvidenceInput): Evidence => {
  if (!Number.isSafeInteger(input.replays) || input.replays < 2) throw new RangeError('evidence needs at least two replays');
  if (input.windows.length === 0) throw new RangeError('evidence needs at least one window');
  const windows = input.windows.map((w, k): WindowEvidence => {
    const filesChecked = verifySums(w.dir);
    if (input.mode === 'gate' && filesChecked === 0) throw new RangeError(`${w.dir}: gate evidence needs the release's SHA256SUMS`);
    const manifest = loadManifest(w.dir);
    const leadInDays = Number((manifest.window as { lead_in_days?: number }).lead_in_days ?? 0);
    if (input.mode === 'gate' && leadInDays < GATE_LEAD_IN_DAYS) {
      throw new RangeError(`${w.dir}: assembled with ${leadInDays} lead-in days; gate evidence needs ${GATE_LEAD_IN_DAYS} (use the labelled no-lead-in mode for a determinism-only check)`);
    }
    const units = (manifest['units'] ?? []) as readonly { readonly scanner_revision?: string }[];
    const scannerRevisions = [...new Set(units.map((u) => u.scanner_revision ?? '').filter((r) => r !== ''))].sort();
    const days = manifest.days;
    const rows = function* (): Generator<DatasetRow> {
      for (const d of days) yield* loadDay(w.dir, d);
    };
    const last = days[days.length - 1]!;
    const lastDay = Date.parse(`${last.day}T00:00:00Z`) + 86_400_000;
    const covered = manifest.coverage.last_block_time === undefined ? lastDay : manifest.coverage.last_block_time * 1000;
    const base: RunOptions = {
      rows, series: [input.solUsd], seed: input.seed, scenario: input.scenario, policy: input.policy, fills: input.fills, research: input.research,
      windowEnd: Math.min(lastDay, covered), regimeBoundaries: regimeBoundariesOf(manifest),
    };
    const ledgerPath = join(input.workDir, `window-${k}.db`);
    if (existsSync(ledgerPath)) throw new RangeError(`${ledgerPath} exists: each evidence run writes a new ledger`);
    const first = runBacktest({ ...base, ledgerPath });
    const hashes = [first.logHash];
    const elapsedMs = [first.stats.elapsedMs];
    for (let r = 1; r < input.replays; r++) {
      const again = runBacktest(base);
      hashes.push(again.logHash);
      elapsedMs.push(again.stats.elapsedMs);
    }
    const lr = input.ledgerReplay(ledgerPath);
    const identicalReplays = new Set(hashes).size === 1;
    const s = first.stats;
    const counts: Record<string, number> = {
      rows: s.rows, events: s.events, decisions: first.records.filter((x) => x.type === 'decision').length,
      candidates: first.records.filter((x) => x.type === 'decision' && x.reasons[0] === 'candidate').length,
      entryIntents: Object.values(first.book.intents).filter((i) => i.intent.purpose === 'entry').length,
      positions: Object.keys(first.book.positions).length, skippedSwaps: s.skippedSwaps, unquotableSwaps: s.unquotableSwaps,
    };
    for (const o of ['filled', 'failed', 'dropped', 'expired', 'in_flight']) counts[`attempts_${o}`] = first.attempts.filter((a) => a.outcome === o).length;
    const sums = join(w.dir, 'SHA256SUMS');
    const pass = identicalReplays && s.crashes === 0 && s.illegalStates === 0 && s.unreconciledIntents === 0 && s.mirrorMatches && lr.ok;
    return {
      dir: w.dir, release: w.release ?? null, window: { from: manifest.window.from, toExclusive: manifest.window.to_exclusive }, leadInDays,
      days: days.map((d) => d.day), manifestSha256: manifestHash(w.dir), sha256sumsSha256: existsSync(sums) ? sha256File(sums) : null, filesChecked,
      scannerRevisions, hashes, identicalReplays, crashes: s.crashes, crash: s.crash, illegalStates: s.illegalStates, unreconciledIntents: s.unreconciledIntents,
      mirrorMatches: s.mirrorMatches, ledgerReplay: { ok: lr.ok, failure: lr.failure ?? null, counts: lr.counts ?? null }, counts, elapsedMs, pass,
    };
  });
  return {
    kind: 'pre-funding gate items 1 and 2', mode: input.mode, gate: input.mode === 'gate', commit: input.commit, replays: input.replays,
    scenario: input.scenario, seed: input.seed, configs: { fills: input.fills.version, research: input.research.version, policy: input.policy.name },
    windows, pass: windows.every((w) => w.pass),
  };
};
