// Migration 0004 (card SWITCH-FIX-2, SW-46): two indexes so the daily universe manifest reads a bounded set of pools
// instead of every candidate event since the first start. FROZEN once applied, like 0001. No new data: indexes only
// (stored-data ruling, 3 Oct). `candidate_pool`: a pool's candidates (its events are then read along
// `candidate_event_candidate`). `candidate_state_updated`: the evicted candidates written in the last 8 days (an
// eviction's tail can still be running at the day's start). DECISIONS "SWITCH-FIX" SW-46.
import type { Migration } from '../migrate.ts';

export const M0004_MANIFEST_INDEXES: Migration = {
  version: 4,
  name: 'manifest_indexes',
  statements: [
    `CREATE INDEX "candidate_pool" ON "candidate" ("pool_id")`,
    `CREATE INDEX "candidate_state_updated" ON "candidate" ("state", "updated_at")`,
  ],
};
