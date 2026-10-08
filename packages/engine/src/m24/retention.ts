// Retention deletes (ARCH 15, CL-51; Z02 round 2 ruling 10). The append-only triggers compare a row's `created_at` with
// the time in `retention_clock`, which only this job sets, inside its own transaction, from the engine's clock; it is
// reset to 0 before the transaction commits, so outside the job every DELETE of an append-only row is refused. SQLite's
// wall clock is never read, so a host clock that is skewed or stepped neither deletes young rows nor keeps old ones.
import type { Clock } from '@bot/types';
import type { Db } from './db.ts';
import { snake, TABLES, type TableName } from './schema.ts';

const DAY_MS = 86_400_000;
const SET_NOW = 'INSERT INTO "retention_clock" ("id", "now_ms") VALUES (1, ?) ON CONFLICT ("id") DO UPDATE SET "now_ms" = excluded."now_ms"';

/** The append-only tables whose rows expire (every other table is never deleted by this job). */
export function retentionTables(): TableName[] {
  return (Object.keys(TABLES) as TableName[]).filter((t) => TABLES[t].appendOnly && TABLES[t].retention !== 'forever');
}

/** Deletes the rows of `table` older than its horizon as of the engine clock's now; returns how many went. */
export function deleteExpired(db: Db, table: TableName, clock: Clock): number {
  const def = TABLES[table];
  const r = def.retention;
  if (!def.appendOnly || r === 'forever') throw new RangeError(`m24: ${table} has no expiring append-only rows`);
  const now = clock.nowMs();
  if (!Number.isSafeInteger(now) || now <= 0) throw new RangeError('m24: retention needs a positive epoch-ms time');
  return db.withTx((tx) => {
    tx.run(SET_NOW, now);
    let deleted = 0;
    if ('byColumn' in r) {
      for (const [value, days] of Object.entries(r.days)) {
        deleted += tx.run(`DELETE FROM "${table}" WHERE "${snake(r.byColumn)}" = ? AND "created_at" <= ?`, value, now - days * DAY_MS).changes;
      }
    } else {
      deleted += tx.run(`DELETE FROM "${table}" WHERE "created_at" <= ?`, now - r.days * DAY_MS).changes;
    }
    tx.run(SET_NOW, 0);
    return deleted;
  });
}
