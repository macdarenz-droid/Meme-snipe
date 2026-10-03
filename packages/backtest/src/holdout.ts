// Holdout mode (docs/ARCHITECTURE.md §14): the run writes fills, exits and P&L into a separate sealed ledger file and
// exposes only the file's hash and, per universe, the candidate and entry counts (and entry days, from entry times
// only). Nothing else leaves this function: no exit count, fill, P&L or log line. The file is made read-only; only the
// scoring stage opens it, once, after STATS-1's size check passes.
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, readFileSync } from 'node:fs';
import type { RunOptions } from './run.ts';
import { runBacktest } from './run.ts';
import { melbourneDay } from './report.ts';
import { type HoldoutCounts, type HoldoutRegistry, type RegistryStep, sealHoldout } from '../../core/src/stats/index.ts';

export interface SealedHoldout {
  /** sha256 of the sealed ledger file. */
  readonly ledgerHash: string;
  readonly counts: Readonly<Record<string, HoldoutCounts>>;
}

/** Each universe's registered holdout (STATS-1 registry) and the configuration it was registered with. */
export interface HoldoutTargets {
  readonly registry: HoldoutRegistry;
  readonly byUniverse: Readonly<Record<string, { readonly holdoutId: string; readonly configId: string }>>;
}

/**
 * Runs the holdout and seals it in the STATS-1 registry: one `sealHoldout` per universe with the file hash and that
 * universe's counts. Returns the new registry and each step's result, plus the hash and counts (nothing else).
 */
export const runAndSealHoldout = (o: RunOptions & { readonly ledgerPath: string }, targets: HoldoutTargets): SealedHoldout & { readonly registry: HoldoutRegistry; readonly steps: readonly RegistryStep[] } => {
  const sealed = runHoldout(o);
  let registry = targets.registry;
  const steps: RegistryStep[] = [];
  for (const [u, t] of Object.entries(targets.byUniverse)) {
    const counts = sealed.counts[u] ?? { candidates: 0, entries: 0, entryDays: 0 };
    const step = sealHoldout(registry, t.holdoutId, { configId: t.configId, ledgerHash: sealed.ledgerHash, counts });
    registry = step.registry;
    steps.push(step);
  }
  return { ...sealed, registry, steps };
};

export const runHoldout = (o: RunOptions & { readonly ledgerPath: string }): SealedHoldout => {
  if (existsSync(o.ledgerPath)) throw new RangeError(`${o.ledgerPath} exists: a holdout is run once, into a new file`);
  const r = runBacktest(o);
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
  chmodSync(o.ledgerPath, 0o400);
  const ledgerHash = createHash('sha256').update(readFileSync(o.ledgerPath)).digest('hex');
  return {
    ledgerHash,
    counts: Object.fromEntries(Object.entries(counts).map(([u, c]): [string, HoldoutCounts] => [u, { candidates: c.candidates, entries: c.entries, entryDays: c.days.size }])),
  };
};
