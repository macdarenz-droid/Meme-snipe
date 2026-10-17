// SW-1(b) (red team 1 on bac1f88a): what keeps the recorder's database bounded. Nothing called these before, so
// `metric_rollup_1m`, `bar_1m`, `outbox` and `candidate_event` grew for as long as the recorder ran.
// - M24's retention job (ARCH 15; SPEC-B B-M24-02 logic 3, CL-51): every append-only table with a horizon, through
//   M24's own retention transactions, so only rows past it by both clocks go: `candidate_event` and `screen_result` at
//   1 year, `metric_rollup_1m` pool series at 7 days and aggregate ones at 1 year (Z02 round 2 ruling 7), the others at
//   theirs. The rollup sink is told how many of its rows went.
// - M08's daily purge of `bar_1m` past `bars.bar_1m_retention_days` (SPEC-A A-M08-03 logic 5; 90 days).
// - M24's outbox (SPEC-B B-M24-01 logic 4): no module in the recorder consumes an outbox event, so the drain publishes
//   to nothing and marks the rows published; `drain` itself deletes published rows after 7 days (its retention).
// SW-32: a daily pass runs as bounded steps, one a loop tick (`step`), each at most RETENTION_BATCH_ROWS rows in one
// transaction, so no step holds the loop for long (whole-table deletes took about 1.06 s at day-90 sizes on 1 CPU).
// Each step runs inside the caller's guard: a failure is one `recorder.internal_error` and the next step tries again.
import type { Clock } from '@bot/types';
import type { Db } from '../m24/db.ts';
import { expiryJob, RETENTION_BATCH_ROWS, retentionTables, type ExpiryJob, type ExpiryObserver } from '../m24/retention.ts';
import type { BarStore } from '../m08/bar-store.ts';

/** How often a retention pass starts (and once at start, after the first loop tick). */
export const RETENTION_EVERY_MS = 86_400_000;
/** How often the outbox is drained. */
export const OUTBOX_DRAIN_EVERY_MS = 60_000;

export interface RetentionResult { rows: number; bars: number; byTable: Record<string, number> }
/** One step of a pass: `done` once every table and the bars are through; the totals are the pass's so far. */
export interface RetentionStep extends RetentionResult { done: boolean }

export interface RecorderRetention {
  /** Starts a pass (a pass already running carries on). */
  start(): void;
  /** One bounded step of the running pass; null when none is running. */
  step(): RetentionStep | null;
  /** A whole pass at once (tests and the soak's tooling). */
  run(): RetentionResult;
  drainOutbox(): void;
}

export function recorderRetention(o: { db: Db; clock: Clock; barStore: Pick<BarStore, 'purge'>; rollupSink: ExpiryObserver; batchRows?: number }): RecorderRetention {
  const batch = o.batchRows ?? RETENTION_BATCH_ROWS;
  let pass: { jobs: Array<{ table: string; job: ExpiryJob }>; barsDone: boolean; total: RetentionResult } | null = null;
  const self: RecorderRetention = {
    start(): void {
      if (pass !== null) return;
      pass = {
        jobs: retentionTables().map((t) => ({ table: t, job: expiryJob(o.db, t, o.clock, t === 'metric_rollup_1m' ? [o.rollupSink] : [], { rows: batch }) })),
        barsDone: false, total: { rows: 0, bars: 0, byTable: {} },
      };
    },
    step(): RetentionStep | null {
      const p = pass;
      if (p === null) return null;
      const head = p.jobs[0];
      if (head !== undefined) {
        const s = head.job.step();
        if (s.deleted > 0) { p.total.byTable[head.table] = (p.total.byTable[head.table] ?? 0) + s.deleted; p.total.rows += s.deleted; }
        if (s.done) p.jobs.shift();
      } else if (!p.barsDone) {
        const n = o.barStore.purge(o.clock.nowMs(), batch);
        p.total.bars += n;
        if (n < batch) p.barsDone = true;
      }
      const done = p.jobs.length === 0 && p.barsDone;
      if (done) pass = null;
      return { ...p.total, byTable: { ...p.total.byTable }, done };
    },
    run(): RetentionResult {
      self.start();
      for (;;) {
        const s = self.step() as RetentionStep;
        if (s.done) return { rows: s.rows, bars: s.bars, byTable: s.byTable };
      }
    },
    drainOutbox(): void {
      o.db.outbox.drain(() => { /* no consumer in the recorder: published to nothing */ });
    },
  };
  return self;
}

/** SW-34: the first wait after a failed step, doubled on each failure in a row up to RETENTION_BACKOFF_MAX_MS. */
export const RETENTION_BACKOFF_START_MS = 1_000;
export const RETENTION_BACKOFF_MAX_MS = 3_600_000;
/** SW-34: failures in a row that raise the held state code `recorder.retention_failed`. */
export const RETENTION_FAILED_AFTER = 3;

export interface RetentionGate {
  /** Whether a step may run now (monotonic ms). */
  due(monoMs: number): boolean;
  /** A step threw: the failures in a row so far and the wait before the next try. */
  failed(monoMs: number): { failures: number; waitMs: number };
  /** A step ran: the back-off and the held code clear. */
  succeeded(): void;
  /** RETENTION_FAILED_AFTER or more failures in a row. */
  failing(): boolean;
}

/**
 * SW-34: a step that fails the same way every time never finishes its pass, so it is not retried every loop tick:
 * after each failure in a row the next try waits twice as long (1 s, 2 s, 4 s, ... at most 1 h), with one log line per
 * failure, and from the third the held state code `recorder.retention_failed` is up until a step succeeds.
 */
export function retentionGate(): RetentionGate {
  let failures = 0;
  let nextAt = -Infinity;
  return {
    due: (monoMs) => monoMs >= nextAt,
    failed(monoMs) {
      failures++;
      const waitMs = Math.min(RETENTION_BACKOFF_MAX_MS, RETENTION_BACKOFF_START_MS * 2 ** Math.min(failures - 1, 32));
      nextAt = monoMs + waitMs;
      return { failures, waitMs };
    },
    succeeded() { failures = 0; nextAt = -Infinity; },
    failing: () => failures >= RETENTION_FAILED_AFTER,
  };
}
