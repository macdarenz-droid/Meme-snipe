// Migration 0003 (card SWITCH-FIX-2, SW-32): two indexes for the retention job's bounded batches, so no step scans a
// whole table (about 1.06 s at day-90 sizes on 1 CPU before). FROZEN once applied, like 0001. No new data: an index only
// (stored-data ruling, 3 Oct). `metric_rollup_1m` gets none (an index on its 15M rows at day 366 would add hundreds
// of MB): its batches seek along its primary key (m24/retention.ts). Measured in docs/DECISIONS.md "SWITCH-FIX" SW-32.
import type { Migration } from '../migrate.ts';

export const M0003_RETENTION_INDEXES: Migration = {
  version: 3,
  name: 'retention_indexes',
  statements: [
    `CREATE INDEX "candidate_event_created_at" ON "candidate_event" ("created_at")`,
    `CREATE INDEX "bar_1m_minute" ON "bar_1m" ("minute")`,
  ],
};
