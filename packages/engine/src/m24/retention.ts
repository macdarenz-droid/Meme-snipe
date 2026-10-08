// Retention deletes (ARCH 15, CL-51; Z02 rulings 10, 14, 19). The append-only triggers allow a DELETE only of a row
// older than its horizon by both clocks: the time in `retention_clock`, which only this job sets (through
// `Db.withRetentionClock`, inside its own transaction, from the engine's clock, reset to 0 before the commit; db.ts
// refuses any other SQL that names the table), and SQLite's wall clock. So neither a stepped host clock nor a forged
// `retention_clock` alone deletes a young row. Each sink told about the table's size is told how many rows went.
import type { Clock } from '@bot/types';
import type { Db } from './db.ts';
import { snake, TABLES, type TableName } from './schema.ts';

const DAY_MS = 86_400_000;
/** Selects only rows the triggers will let go (old by SQLite's wall clock too), so one young row never aborts the job. */
const OLD_BY_WALL = `"created_at" <= unixepoch('now') * 1000 - ?`;

/** The append-only tables whose rows expire (every other table is never deleted by this job). */
export function retentionTables(): TableName[] {
  return (Object.keys(TABLES) as TableName[]).filter((t) => TABLES[t].appendOnly && TABLES[t].retention !== 'forever');
}

/** Something that counts a table's rows (the metric rollup sink): told how many rows the job deleted. */
export interface ExpiryObserver { expired(n: number): void }

/** Deletes the rows of `table` older than its horizon as of the engine clock's now; returns how many went. */
export function deleteExpired(db: Db, table: TableName, clock: Clock, observers: readonly ExpiryObserver[] = []): number {
  const def = TABLES[table];
  const r = def.retention;
  if (!def.appendOnly || r === 'forever') throw new RangeError(`m24: ${table} has no expiring append-only rows`);
  const now = clock.nowMs();
  if (!Number.isSafeInteger(now) || now <= 0) throw new RangeError('m24: retention needs a positive epoch-ms time');
  const deleted = db.withRetentionClock(now, (tx) => {
    let n = 0;
    if ('byColumn' in r) {
      for (const [value, days] of Object.entries(r.days)) {
        n += tx.run(`DELETE FROM "${table}" WHERE "${snake(r.byColumn)}" = ? AND "created_at" <= ? AND ${OLD_BY_WALL}`, value, now - days * DAY_MS, days * DAY_MS).changes;
      }
    } else {
      n += tx.run(`DELETE FROM "${table}" WHERE "created_at" <= ? AND ${OLD_BY_WALL}`, now - r.days * DAY_MS, r.days * DAY_MS).changes;
    }
    return n;
  });
  for (const o of observers) o.expired(deleted);
  return deleted;
}
