// The hook where live fact producers plug into the worker (FACTS-1 and later RUG-1c). A producer reads the chain or a
// provider through the worker's schedulers and puts each fact on the live Feed with `sink.fact`, as a `fact` frame:
// released unwrapped, as of its receipt, recorded with every other input (so a replay sees exactly what live saw).
// The value is the fact itself with its own provenance (`obs`), in the shape GATE-1's parsers read
// (packages/core/src/gates/facts.ts) or one of the worker keys below. A producer never decides anything: the gates
// judge freshness and quality from `obs`, so an old, degraded or missing fact rejects under H16.
import { P2, P3, type Priority, type Scheduler } from '../scheduler/index.ts';
import type { Timers } from '../scheduler/timers.ts';
import type { CandidateReason } from '../engine/strategy.ts';
import type { Ingest } from '../facts/readers.ts';

/** Keys the worker's strategy reads besides GATE-1's (`gates/*`): see engine/strategy.ts. */
export const WORKER_FACT_KEYS = {
  /** `worker:fees:<mint>`: the pool's CORE-2 `PoolFeeContext`, read with the pool. */
  fees: 'worker:fees:',
  /** `worker:sol-price`: `{ value: MicroUsd bigint, atMs }`, a live SOL/USD read (risk needs one younger than maxQuoteAgeMs). */
  solPrice: 'worker:sol-price',
} as const;

export interface FactSink {
  /** Puts one fact on the feed now. `key` is a GATE-1 key (`gates/...`) or a WORKER_FACT_KEYS key. */
  fact(key: string, value: unknown): void;
  /** Wall time in integer ms (the producer stamps `obs.receivedAt` with it). */
  now(): number;
}

/** What the worker hands a producer at start. */
export interface FactContext {
  readonly sink: FactSink;
  readonly timers: Timers;
  /** The worker's provider schedulers: every call a producer makes goes through one, at P2 or P3 (never P0/P1). */
  readonly schedulers: Readonly<Record<'helius' | 'alchemy' | 'jupiter' | 'rugcheck', Scheduler>>;
  /** Mints the strategy currently cares about: shortlisted candidates and open positions (refreshed each step). */
  readonly watched: () => ReadonlySet<string>;
  /**
   * FACTS-1b: the live Feed itself, for raw reads (`read:*`, `sol-usd` as `offchain` frames). They are recorded and
   * released like every input, and the engine's FactFeed turns them into gate facts with core's producer, so a
   * replay of the recording rebuilds the same facts.
   */
  readonly ingest: Ingest;
  /** Each candidate's migration time, its last evaluation and that evaluation's typed reasons (null before the first). */
  readonly candidates: () => ReadonlyMap<string, { readonly migratedAtMs: number; readonly lastEvalMs: number | null; readonly gates: readonly CandidateReason[] | null }>;
  /** The newest slot the feed has seen (the decision slot for point-in-time reads), or null before any. */
  readonly tip: () => bigint | null;
}

export interface FactSource {
  readonly name: string;
  /** Called once, after the start reconcile and before the live feeds start. */
  start(ctx: FactContext): void;
  stop(): void;
}

/** The lowest class a fact producer may use: P2 (dry run, facts) or P3 (discovery). */
export const FACT_PRIORITIES: readonly Priority[] = [P2, P3];
