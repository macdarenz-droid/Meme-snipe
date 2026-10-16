// Migration 0002 (card Z10, ruling Z09-23): a partial index on `candidate.cooldown_until` for M05's `due` query
// (m05/store.ts). FROZEN once applied, like 0001. Measured with packages/engine/scripts/measure-due.ts on 2026-10-16
// (docs/DECISIONS.md, Z10): 110,000 candidates with 10,000 timers, median 47.0 ms without it, 1.6 ms with it;
// 1,000,000 with 100,000 timers, 455 ms without, 1.0 ms with. No new data: an index only.
import type { Migration } from '../migrate.ts';

export const M0002_CANDIDATE_COOLDOWN: Migration = {
  version: 2,
  name: 'candidate_cooldown_until',
  statements: [
    `CREATE INDEX "candidate_cooldown_until" ON "candidate" ("cooldown_until") WHERE "cooldown_until" IS NOT NULL`,
  ],
};
