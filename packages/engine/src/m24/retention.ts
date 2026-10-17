// Retention deletes (ARCH 15, CL-51; Z02 rulings 10, 14, 19). The append-only triggers allow a DELETE only of a row
// older than its horizon by both clocks: the time in `retention_clock`, which only this job sets (through
// `Db.withRetentionClock`, inside its own transaction, from the engine's clock, reset to 0 before the commit; db.ts
// refuses any other SQL that names the table), and SQLite's wall clock. So neither a stepped host clock nor a forged
// `retention_clock` alone deletes a young row. Each sink told about the table's size is told how many rows went.
import type { Clock } from '@bot/types';
import type { Db } from './db.ts';
import { snake, TABLES, type TableDef, type TableName } from './schema.ts';

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

/** SW-32: the most rows one retention step deletes, and the most key series one step of a seek job visits. */
export const RETENTION_BATCH_ROWS = 2_000;
export const RETENTION_BATCH_SERIES = 200;

/**
 * SW-32: a table without a rowid is seeked along its primary key, one series (every key column but the last) at a
 * time, with its last key column bounded by the cutoff. Sound only where that column is never after `created_at`:
 * `metric_rollup_1m` writes a minute's rollups once the minute has passed (repos.ts metricRollupSink), so every expired
 * row has `minute` <= the cutoff. Its `scope` follows from the series' labels (m27 scopeOf), so one series has one
 * scope, read from its first row. An index on `created_at` there would hold about 15M entries at day 366.
 */
const KEY_SEEK: Partial<Record<TableName, string>> = { metric_rollup_1m: 'minute' };

export interface ExpiryStep { deleted: number; done: boolean }
export interface ExpiryJob { step(): ExpiryStep }

/**
 * SW-32: `deleteExpired` in bounded steps, so no step holds the writer (and the recorder's loop) for long: each step is
 * one retention transaction of at most `rows` deleted rows (and `series` key series for a seek table). The same rows go
 * as with `deleteExpired`, by the same two clocks, read at each step. A rowid table's batch is found through its
 * `created_at` index where it has one (migration 0003: `candidate_event`); the recorder's other expiring rowid tables
 * hold no rows.
 */
export function expiryJob(db: Db, table: TableName, clock: Clock, observers: readonly ExpiryObserver[] = [],
  o: { rows?: number; series?: number } = {}): ExpiryJob {
  const def: TableDef = TABLES[table];
  const r = def.retention;
  if (!def.appendOnly || r === 'forever') throw new RangeError(`m24: ${table} has no expiring append-only rows`);
  const rows = o.rows ?? RETENTION_BATCH_ROWS;
  const series = o.series ?? RETENTION_BATCH_SERIES;
  if (!Number.isSafeInteger(rows) || rows < 1 || !Number.isSafeInteger(series) || series < 1) throw new RangeError('m24: retention batch sizes must be positive');
  const byCol = 'byColumn' in r ? snake(r.byColumn) : null;
  const daysOf = (v: unknown): number | undefined => ('byColumn' in r ? (r.days as Readonly<Record<string, number>>)[String(v)] : r.days);
  const nowOf = (): number => {
    const now = clock.nowMs();
    if (!Number.isSafeInteger(now) || now <= 0) throw new RangeError('m24: retention needs a positive epoch-ms time');
    return now;
  };
  let done = false;
  const finish = (deleted: number): ExpiryStep => {
    for (const ob of observers) ob.expired(deleted);
    return { deleted, done };
  };
  const seek = KEY_SEEK[table];
  if (def.withoutRowid === true) {
    const key = def.key.map((k) => snake(k));
    if (seek === undefined || key.at(-1) !== seek) throw new RangeError(`m24: ${table} has no key seek for its retention`);
    const prefix = key.slice(0, -1);
    // The next series is found with two plain seeks, never a row-value comparison: `(a, b) > (?, ?)` reports a key
    // range in its plan but measured about 40 times slower (600 series: 82 ms against 2 ms, node:sqlite 22.23.3).
    if (prefix.length !== 2) throw new RangeError(`m24: ${table}: the key seek needs a two-column series`);
    const [p1, p2] = prefix as [string, string];
    const cols = `"${p1}", "${p2}"`;
    const keyCols = key.map((c) => `"${c}"`).join(', ');
    const first = `SELECT ${cols}${byCol === null ? '' : `, "${byCol}" AS "v"`} FROM "${table}"`;
    const sameFirst = `${first} WHERE "${p1}" = ? AND "${p2}" > ? ORDER BY "${p2}" LIMIT 1`;
    const nextFirst = `${first} WHERE "${p1}" > ? ORDER BY ${cols} LIMIT 1`;
    const order = ` ORDER BY ${cols} LIMIT 1`;
    const inSeries = `"${p1}" = ? AND "${p2}" = ?`;
    let after: unknown[] | null = null;
    return {
      step(): ExpiryStep {
        if (done) return { deleted: 0, done };
        const now = nowOf();
        return finish(db.withRetentionClock(now, (tx) => {
          let n = 0;
          for (let visits = 0; n < rows && visits < series; visits++) {
            const s = after === null ? tx.get(first + order) : (tx.get(sameFirst, ...(after as never[])) ?? tx.get(nextFirst, after[0] as never));
            if (s === undefined) { done = true; break; }
            const vals = prefix.map((c) => s[c]);
            const days = daysOf(s.v);
            if (days === undefined) { after = vals; continue; }
            const cutoff = now - days * DAY_MS;
            const want = rows - n;
            const k = tx.run(`DELETE FROM "${table}" WHERE (${keyCols}) IN (SELECT ${keyCols} FROM "${table}" WHERE ${inSeries} AND "${seek}" <= ?`
              + `${byCol === null ? '' : ` AND "${byCol}" = ?`} AND "created_at" <= ? AND ${OLD_BY_WALL} LIMIT ?)`,
            ...(vals as never[]), cutoff, ...(byCol === null ? [] : [s.v as never]), cutoff, days * DAY_MS, want).changes;
            n += k;
            if (k < want) after = vals;                                     // the series has no more expired rows
          }
          return n;
        }));
      },
    };
  }
  const values: Array<[string | null, number]> = 'byColumn' in r ? Object.entries(r.days) : [[null, r.days]];
  let vi = 0;
  return {
    step(): ExpiryStep {
      if (done) return { deleted: 0, done };
      const now = nowOf();
      return finish(db.withRetentionClock(now, (tx) => {
        let n = 0;
        while (vi < values.length && n < rows) {
          const [value, days] = values[vi] as [string | null, number];
          const want = rows - n;
          const k = tx.run(`DELETE FROM "${table}" WHERE rowid IN (SELECT rowid FROM "${table}" WHERE ${value === null ? '' : `"${byCol}" = ? AND `}"created_at" <= ? AND ${OLD_BY_WALL} LIMIT ?)`,
            ...(value === null ? [] : [value]), now - days * DAY_MS, days * DAY_MS, want).changes;
          n += k;
          if (k < want) vi++;
        }
        if (vi >= values.length) done = true;
        return n;
      }));
    },
  };
}
