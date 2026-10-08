// The schema transaction (Z02 rulings 22, 24, 26, 29): a write transaction in which schema statements (CREATE, DROP,
// ALTER, PRAGMA, ATTACH) and SQLite's own sqlite_* tables are allowed. It is the migration runner's alone. openDb
// registers each database's runner in this module-private WeakMap (nothing on the Db object, nothing exported by
// db.ts); only db.ts, migrate.ts and the engine's tests may import this file, which tools/policy enforces
// (E_SCHEMA_TX_IMPORT). The guard stops accidental misuse by our own code; deliberately written bypass code in the
// repository is out of its scope and is caught by review (docs/DECISIONS.md).
import type { Db, TxHandle } from './db.ts';

export type SchemaRunner = <T>(fn: (tx: TxHandle) => T, trusted: ReadonlySet<string>) => T;

const runners = new WeakMap<Db, SchemaRunner>();
const NONE: ReadonlySet<string> = new Set();

/** Called once by openDb for the Db it returns. */
export function registerSchemaRunner(db: Db, run: SchemaRunner): void {
  if (runners.has(db)) throw new TypeError('m24: this database already has a schema runner');
  runners.set(db, run);
}

/**
 * Runs `fn` in a schema transaction. A statement naming `retention_clock` runs only when its exact text is in
 * `trusted`, the migrations' own statements (ruling 24).
 */
export function schemaTx<T>(db: Db, fn: (tx: TxHandle) => T, trusted: ReadonlySet<string> = NONE): T {
  const run = runners.get(db);
  if (run === undefined) throw new TypeError('m24: schemaTx needs a database opened by openDb');
  return run(fn, trusted);
}
