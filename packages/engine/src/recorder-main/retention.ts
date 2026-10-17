// SW-1(b) (red team 1 on bac1f88a): what keeps the recorder's database bounded. Nothing called these before, so
// `metric_rollup_1m`, `bar_1m`, `outbox` and `candidate_event` grew for as long as the recorder ran.
// - M24's retention job (ARCH 15; SPEC-B B-M24-02 logic 3, CL-51): every append-only table with a horizon, through
//   `deleteExpired` (M24's own retention transaction), so only rows past it by both clocks go: `candidate_event` and
//   `screen_result` at 1 year, `metric_rollup_1m` pool series at 7 days and aggregate ones at 1 year (Z02 round 2
//   ruling 7), the others at theirs. The rollup sink is told how many of its rows went.
// - M08's daily purge of `bar_1m` past `bars.bar_1m_retention_days` (SPEC-A A-M08-03 logic 5; 90 days).
// - M24's outbox (SPEC-B B-M24-01 logic 4): no module in the recorder consumes an outbox event, so the drain publishes
//   to nothing and marks the rows published; `drain` itself deletes published rows after 7 days (its retention).
// Each runs inside the caller's guard: a failure is one `recorder.internal_error` and the next run tries again.
import type { Clock } from '@bot/types';
import type { Db } from '../m24/db.ts';
import { deleteExpired, retentionTables, type ExpiryObserver } from '../m24/retention.ts';
import type { BarStore } from '../m08/bar-store.ts';

/** How often the daily jobs run (and once at start, after the first loop tick). */
export const RETENTION_EVERY_MS = 86_400_000;
/** How often the outbox is drained. */
export const OUTBOX_DRAIN_EVERY_MS = 60_000;

export interface RetentionResult { rows: number; bars: number; byTable: Record<string, number> }

export function recorderRetention(o: { db: Db; clock: Clock; barStore: Pick<BarStore, 'purge'>; rollupSink: ExpiryObserver }): { run(): RetentionResult; drainOutbox(): void } {
  return {
    run(): RetentionResult {
      const byTable: Record<string, number> = {};
      let rows = 0;
      for (const t of retentionTables()) {
        const n = deleteExpired(o.db, t, o.clock, t === 'metric_rollup_1m' ? [o.rollupSink] : []);
        if (n > 0) byTable[t] = n;
        rows += n;
      }
      const bars = o.barStore.purge(o.clock.nowMs());
      return { rows, bars, byTable };
    },
    drainOutbox(): void {
      o.db.outbox.drain(() => { /* no consumer in the recorder: published to nothing */ });
    },
  };
}
