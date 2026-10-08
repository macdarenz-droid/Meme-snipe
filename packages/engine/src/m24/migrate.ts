// Forward-only migrations (B-M24-02 logic 5; CL-52). At engine start, before anything else: the applied migrations
// are read and checked; when migrations are pending, an online backup of the database, then every pending migration in
// ONE transaction, each recorded in `schema_migrations` with the SHA-256 of its text. Any failure rolls the transaction
// back, so the database stays at its previous version. A start with nothing to apply takes no backup (CL-52: "backup
// first, migrate"; the routine backups are B-M24-04's), so a large database does not delay every start. The backup is
// written through SQLite's online backup API to `<backup>.tmp`, checked (quick_check and page count), then renamed over
// the previous backup, so a failed, killed or bad backup leaves the previous one as it was (Z02 rulings 9 and 18).
//
// The caller acts on the result (ARCH 7.6, M24): any error means the engine runs `exits_only` on the unmigrated
// database (positions still managed, entries blocked) and raises a critical alert:
// - E_MIGRATION_CHECKSUM: an applied migration's text differs from this build's (edge case: start refused for entries);
// - E_SCHEMA_NEWER: the database has a migration this build does not know (a downgrade);
// - E_BACKUP_FAILED: migrations are pending but the start backup failed, or the copy fails its quick_check or has a
//   different page count from the database (ruling 9), so none is applied;
// - E_MIGRATION_FAILED: a migration statement failed and everything was rolled back;
// - E_DATABASE_CORRUPT: quick_check fails, or SQLite reports the file damaged (round 2 ruling 9); nothing is applied;
// - E_FOREIGN_DATABASE: the file holds tables but not this schema's migration record (an old Zeroed ledger or the
//   host stand-in's database at `m24.db_path`): nothing is applied on top of it and it is left as it was (MIGRATION
//   Rule 3, the old state is never reused; red team B RB-15).
import { createHash } from 'node:crypto';
import { renameSync, rmSync } from 'node:fs';
import type { Clock, Result } from '@bot/types';
import type { Logger } from '../m27/log.ts';
import { DatabaseSync } from 'node:sqlite';
import { isCorruptionError, type Db } from './db.ts';
import { schemaTx } from './schema-tx.ts';
import { tableStatements } from './ddl.ts';
import { M0001_INITIAL } from './migrations/0001_initial.ts';
import { TABLES } from './schema.ts';

export interface Migration { readonly version: number; readonly name: string; readonly statements: readonly string[] }

/** Every migration of this build, in order. Append only. */
export const MIGRATIONS: readonly Migration[] = [M0001_INITIAL];

export type MigrateErrorCode = 'E_MIGRATION_CHECKSUM' | 'E_SCHEMA_NEWER' | 'E_BACKUP_FAILED' | 'E_MIGRATION_FAILED' | 'E_FOREIGN_DATABASE' | 'E_DATABASE_CORRUPT';
export interface MigrateError { code: MigrateErrorCode; message: string; version: number | null }
export interface MigrateOk { from: number; to: number; applied: number[] }

export const M24_MIGRATION_LOG_CODES = {
  'm24.migration_applied': { fields: { version: 'integer', name: 'string', sha256: 'string' } },
  'm24.migration_failed': { fields: { version: 'integer', error_code: 'string', message: 'string' } },
  'm24.start_backup_failed': { fields: { message: 'string' } },
} as const;

/** SHA-256 (hex) of a migration's text: its statements joined by ";\n". */
export function migrationSha256(m: Migration): string {
  return createHash('sha256').update(m.statements.join(';\n')).digest('hex');
}

/** A migration list must be numbered 1, 2, 3 … without gaps (programmer error otherwise). */
export function checkMigrationList(list: readonly Migration[]): void {
  list.forEach((m, i) => {
    if (m.version !== i + 1) throw new TypeError(`migration ${i}: version ${m.version}, expected ${i + 1}`);
    if (m.statements.length === 0) throw new TypeError(`migration ${m.version}: no statements`);
  });
}

/** The runner's own table, created before the first migration when it is missing. */
export const SCHEMA_MIGRATIONS_STATEMENT = (tableStatements('schema_migrations', TABLES.schema_migrations)[0] as string)
  .replace('CREATE TABLE "schema_migrations"', 'CREATE TABLE IF NOT EXISTS "schema_migrations"');

const MIGRATION_COLUMNS = ['version', 'sha256', 'applied_at'];

/** Why the database is not this schema's (null when it is, or when it is empty). */
export function foreignDatabase(db: Db): string | null {
  return schemaTx(db, (tx) => {
    if (tx.get("SELECT 1 AS x FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'") === undefined) return null;
    const columns = tx.all("SELECT name FROM pragma_table_info('schema_migrations') ORDER BY cid").map((r) => r.name as string);
    if (columns.length === 0) return 'it holds tables but no schema_migrations';
    return columns.join(',') === MIGRATION_COLUMNS.join(',') ? null : `its schema_migrations has the columns ${columns.join(', ')}`;
  });
}

/** Applied migrations as recorded in the database (empty when the table does not exist yet). */
export function appliedMigrations(db: Db): Array<{ version: number; sha256: string }> {
  return schemaTx(db, (tx) => {
    if (tx.get("SELECT 1 AS x FROM sqlite_schema WHERE type = 'table' AND name = 'schema_migrations'") === undefined) return [];
    return tx.all('SELECT version, sha256 FROM schema_migrations ORDER BY version').map((r) => ({ version: Number(r.version), sha256: r.sha256 as string }));
  });
}

export interface PrepareOptions {
  clock: Clock;
  /** Where the start backup is written (overwritten by each start that applies migrations). */
  backupPath: string;
  migrations?: readonly Migration[];
  log?: Logger;
}

/** Trusts a start backup only when its copy passes quick_check and has the database's page count (ruling 9). */
function checkBackup(db: Db, path: string): void {
  const pages = Number(db.reader().get('PRAGMA page_count')?.page_count);
  const copy = new DatabaseSync(path, { readOnly: true });
  try {
    const quick = (copy.prepare('PRAGMA quick_check').all() as Array<Record<string, string>>).map((r) => String(Object.values(r)[0]));
    if (quick.length !== 1 || quick[0] !== 'ok') throw new Error(`the backup copy fails quick_check: ${quick.slice(0, 5).join('; ')}`);
    const copied = Number((copy.prepare('PRAGMA page_count').get() as { page_count: number | bigint }).page_count);
    if (copied !== pages) throw new Error(`the backup copy has ${copied} pages, the database ${pages}`);
  } finally {
    copy.close();
  }
}

/** Start sequence of M24: verify applied migrations; when some are pending, back up, then apply them in one transaction. */
export async function prepareDatabase(db: Db, opts: PrepareOptions): Promise<Result<MigrateOk, MigrateError>> {
  const list = opts.migrations ?? MIGRATIONS;
  checkMigrationList(list);
  const fail = (code: MigrateErrorCode, message: string, version: number | null): Result<MigrateOk, MigrateError> => {
    opts.log?.event('critical', 'm24.migration_failed', { version, error_code: code, message });
    return { ok: false, error: { code, message, version } };
  };
  let foreign: string | null;
  try {
    const quick = db.integrityCheck('quick');
    if (!quick.ok) return fail('E_DATABASE_CORRUPT', `quick_check failed: ${quick.messages.slice(0, 5).join('; ')}`, null);
    foreign = foreignDatabase(db);
  } catch (e) {
    if (isCorruptionError(e)) return fail('E_DATABASE_CORRUPT', `the database is damaged: ${(e as Error).message}`, null);
    throw e;
  }
  if (foreign !== null) return fail('E_FOREIGN_DATABASE', `the database is not this engine's (${foreign}); nothing applied`, null);
  const applied = appliedMigrations(db);
  for (const a of applied) {
    const known = list[a.version - 1];
    if (known === undefined) return fail('E_SCHEMA_NEWER', `the database has migration ${a.version}, this build knows ${list.length}`, a.version);
    if (migrationSha256(known) !== a.sha256) return fail('E_MIGRATION_CHECKSUM', `migration ${a.version} (${known.name}) differs from the applied text`, a.version);
  }
  const from = applied.length;
  const pending = list.slice(from);
  if (pending.length === 0) return { ok: true, value: { from, to: from, applied: [] } };
  try {
    // Written beside the previous backup and checked there; only a good copy replaces it (ruling 18).
    rmSync(`${opts.backupPath}.tmp`, { force: true });
    await db.backupTo(`${opts.backupPath}.tmp`);
    checkBackup(db, `${opts.backupPath}.tmp`);
    renameSync(`${opts.backupPath}.tmp`, opts.backupPath);
  } catch (e) {
    rmSync(`${opts.backupPath}.tmp`, { force: true });
    const message = (e as Error).message;
    opts.log?.event('error', 'm24.start_backup_failed', { message });
    return fail('E_BACKUP_FAILED', `start backup failed, ${pending.length} migration(s) not applied: ${message}`, null);
  }
  let current: Migration = pending[0] as Migration;
  try {
    schemaTx(db, (tx) => {
      tx.run(SCHEMA_MIGRATIONS_STATEMENT);
      for (const m of pending) {
        current = m;
        for (const statement of m.statements) tx.run(statement);
        tx.run('INSERT INTO schema_migrations (version, sha256, applied_at) VALUES (?, ?, ?)', m.version, migrationSha256(m), opts.clock.nowMs());
      }
    }, new Set(pending.flatMap((m) => m.statements)));
  } catch (e) {
    return fail('E_MIGRATION_FAILED', `migration ${current.version} (${current.name}) failed and nothing was applied: ${(e as Error).message}`, current.version);
  }
  for (const m of pending) opts.log?.event('info', 'm24.migration_applied', { version: m.version, name: m.name, sha256: migrationSha256(m) });
  return { ok: true, value: { from, to: list.length, applied: pending.map((m) => m.version) } };
}
