// Shared SQLite plumbing for the ledger and the scoring store: pragmas, the single-writer lock,
// forward-only migrations, transactions and exact amount columns. Knows no table of either file.

import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

/** Which store a file holds. A file is opened only as the kind it was created as. */
export type StoreKind = 'ledger' | 'scoring';

export interface Migration {
  /** 1, 2, 3, ... with no gaps. Applied in order, once, never edited after release. */
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export class LedgerError extends Error {
  override readonly name = 'LedgerError';
}

/** SQL check that a TEXT column holds a canonical non-negative integer ("0", "15", never "015", "-1" or "1.5"). */
export const amountCheck = (column: string): string =>
  `(${column} GLOB '[0-9]*' AND ${column} NOT GLOB '*[^0-9]*' AND (${column} = '0' OR ${column} NOT GLOB '0*'))`;

/** As amountCheck, but a leading minus is allowed for non-zero values (P&L). */
export const signedAmountCheck = (column: string): string =>
  `(${amountCheck(column)} OR (${column} GLOB '-[1-9]*' AND substr(${column}, 2) NOT GLOB '*[^0-9]*'))`;

/** Refuse every UPDATE and DELETE on a table. */
export const appendOnly = (table: string): string => `
CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT, 'append-only: ${table}'); END;
CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT, 'append-only: ${table}'); END;`;

/** Amounts are stored as decimal text and read back as bigint, so no float ever touches them. */
export const amountText = (value: bigint): string => {
  if (typeof value !== 'bigint' || value < 0n) throw new LedgerError(`amount must be a non-negative bigint, got ${String(value)}`);
  return value.toString();
};

export const signedAmountText = (value: bigint): string => {
  if (typeof value !== 'bigint') throw new LedgerError(`amount must be a bigint, got ${String(value)}`);
  return value.toString();
};

export const amountOf = (text: unknown): bigint => {
  if (typeof text !== 'string' || !/^(0|-?[1-9][0-9]*)$/.test(text)) throw new LedgerError(`stored amount is not an integer: ${String(text)}`);
  return BigInt(text);
};

const checksum = (kind: StoreKind, m: Migration): string =>
  createHash('sha256').update(`${kind}\n${m.version}\n${m.name}\n${m.sql}`).digest('hex');

/**
 * Holds an exclusive SQLite lock on a sidecar file for the writer's whole life. The lock is an OS
 * file lock: the kernel drops it when the process dies, so there is no pid file, no stale check
 * and no window where two openers can both win. A second opener, in this process or another, is refused.
 */
const takeWriterLock = (dbPath: string): (() => void) => {
  const lock = new DatabaseSync(`${dbPath}-writer.lock`, { timeout: 0 });
  try {
    lock.exec('PRAGMA locking_mode = EXCLUSIVE');
    lock.exec('BEGIN EXCLUSIVE');
  } catch (err) {
    lock.close();
    const message = (err as Error).message;
    if (/locked|busy/i.test(message)) throw new LedgerError(`${dbPath} already has a writer`);
    throw new LedgerError(`${dbPath}: cannot take the writer lock (${message})`);
  }
  return () => {
    if (lock.isOpen) lock.close(); // closing ends the transaction and releases the lock
  };
};

export interface OpenedStore {
  readonly db: DatabaseSync;
  readonly release: () => void;
}

/**
 * Opens a store for writing: takes the writer lock, sets WAL, synchronous=FULL and foreign keys,
 * then applies pending migrations. Refuses a file of another kind, a file newer than this code,
 * and a file whose applied migrations differ from the code's.
 */
export const openWriter = (path: string, kind: StoreKind, migrations: readonly Migration[]): OpenedStore => {
  checkMigrationList(migrations);
  const release = path === ':memory:' ? () => {} : takeWriterLock(path);
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readBigInts: true, timeout: 5000, enableForeignKeyConstraints: true });
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = FULL');
    db.exec('PRAGMA trusted_schema = OFF');
    db.exec('PRAGMA recursive_triggers = ON'); // so INSERT OR REPLACE fires the DELETE guard
    migrate(db, kind, migrations);
    return { db, release };
  } catch (err) {
    db?.close();
    release();
    throw err;
  }
};

/** A read-only connection (API, backups). Never migrates; refuses an unmigrated or foreign file. */
export const openReader = (path: string, kind: StoreKind, migrations: readonly Migration[]): DatabaseSync => {
  const db = new DatabaseSync(path, { readOnly: true, readBigInts: true, timeout: 5000 });
  try {
    db.exec('PRAGMA recursive_triggers = ON');
    const applied = appliedMigrations(db);
    verifyApplied(path, kind, applied, migrations);
    if (applied.length !== migrations.length) throw new LedgerError(`${path} is at schema ${applied.length}, code expects ${migrations.length}; open the writer first`);
    return db;
  } catch (err) {
    db.close();
    throw err;
  }
};

const checkMigrationList = (migrations: readonly Migration[]): void => {
  migrations.forEach((m, i) => {
    if (m.version !== i + 1) throw new LedgerError(`migration versions must run 1..n without gaps; found ${m.version} at position ${i + 1}`);
  });
};

interface Applied { readonly version: number; readonly checksum: string }

const appliedMigrations = (db: DatabaseSync): Applied[] => {
  const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
  if (table === undefined) return [];
  return db.prepare('SELECT version, checksum FROM schema_migrations ORDER BY version').all()
    .map((r) => ({ version: Number(r['version']), checksum: String(r['checksum']) }));
};

const verifyApplied = (path: string, kind: StoreKind, applied: readonly Applied[], migrations: readonly Migration[]): void => {
  if (applied.length > migrations.length) {
    throw new LedgerError(`${path} has schema ${applied.length}, newer than this code (${migrations.length}); migrations only go forward`);
  }
  applied.forEach((a, i) => {
    const m = migrations[i];
    if (m === undefined || a.version !== m.version || a.checksum !== checksum(kind, m)) {
      throw new LedgerError(`${path}: applied migration ${a.version} does not match this code's ${kind} migration (wrong kind of file or an edited migration)`);
    }
  });
};

const migrate = (db: DatabaseSync, kind: StoreKind, migrations: readonly Migration[]): void => {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS schema_migrations_no_update BEFORE UPDATE ON schema_migrations BEGIN SELECT RAISE(ABORT, 'append-only: schema_migrations'); END;
    CREATE TRIGGER IF NOT EXISTS schema_migrations_no_delete BEFORE DELETE ON schema_migrations BEGIN SELECT RAISE(ABORT, 'append-only: schema_migrations'); END;`);
  const applied = appliedMigrations(db);
  verifyApplied(String(db.location() ?? ':memory:'), kind, applied, migrations);
  for (const m of migrations.slice(applied.length)) {
    inTransaction(db, () => {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (version, name, checksum) VALUES (?, ?, ?)').run(m.version, m.name, checksum(kind, m));
    });
  }
};

/**
 * Runs fn inside BEGIN IMMEDIATE (the write lock is taken up front, so a read-then-write inside
 * cannot race another connection). Nested calls join the outer transaction. Any throw rolls back all of it.
 */
export const inTransaction = <T>(db: DatabaseSync, fn: () => T): T => {
  if (db.isTransaction) return fn();
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw err;
  }
};
