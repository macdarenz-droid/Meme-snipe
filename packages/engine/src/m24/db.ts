// SQLite connection model, `withTx` and the transactional outbox (B-M24-01; ARCH 4.5, 7.1, M24).
//
// Library (CA-33, VERIFY A-45, recorded in DEPENDENCIES.md): Node's built-in `node:sqlite` on the pinned
// Node 22.23.3 (SQLite 3.51.3). Confirmed on that build: explicit transactions (`BEGIN IMMEDIATE` / `COMMIT` /
// `ROLLBACK`, `isTransaction`), WAL mode (`PRAGMA journal_mode=WAL` returns `wal` on a file database) and the online
// backup API (`backup(sourceDb, path)`, added in v22.16.0). No install script and no downloaded binary.
//
// One writer connection, used only from the engine's event loop (all writes serialised); `withTx` is synchronous, so
// no `await` can run inside it (lint rule `bot/no-await-in-withtx`, and a run-time check on the callback's result).
// Read-only reader connections for API queries wait up to 5 s on a busy database. Every integer is read as a bigint
// (no silent loss above 2^53); callers convert. PRAGMAs: WAL, `synchronous=FULL` (durability over speed for money
// tables), `foreign_keys=ON`.
//
// Outbox: rows are appended in the same transaction as the state change; `drain` hands unpublished rows, in `seq`
// order, to the publisher after commit and then marks them published. A crash between commit and publish leaves the
// rows unpublished, so they are published again after restart (`m24.outbox_replay`); consumers are idempotent by
// entity key and `seq` (`OutboxConsumer`). Published rows are deleted after 7 days.
// Transaction control is `withTx`'s alone: a statement that would begin, commit or roll back (also behind leading
// comments or empty statements) is refused before it runs, and every statement checks that the transaction is still
// open before and after it runs, so nothing inside `withTx` can run outside the transaction (for example after a
// caught RAISE(ROLLBACK)).
import { chmodSync, existsSync, rmSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { backup, DatabaseSync, type StatementSync } from 'node:sqlite';
import { canonicalJson, type Clock, type UnixMs } from '@bot/types';
import type { Logger } from '../m27/log.ts';
import type { GaugeHandle, HistogramHandle } from '../m27/metrics.ts';
import { registerSchemaRunner } from './schema-tx.ts';
import { writerLockPath } from '../paths.ts';

export type SqlValue = null | number | bigint | string | Uint8Array;
export type Row = Record<string, SqlValue>;

export interface ReaderHandle {
  get(sql: string, ...params: SqlValue[]): Row | undefined;
  all(sql: string, ...params: SqlValue[]): Row[];
}
export interface TxHandle extends ReaderHandle {
  run(sql: string, ...params: SqlValue[]): { changes: number; lastInsertRowid: bigint };
}

export interface OutboxRow { seq: bigint; topic: string; payloadJson: string; createdAtMs: UnixMs; publishedAtMs: UnixMs | null }

export interface Db {
  /** Runs `fn` in one write transaction; a throw rolls back and is rethrown. The body must be synchronous. No DDL. */
  withTx<T>(fn: (tx: TxHandle) => T): T;
  /** A read-only connection for API queries (round robin over the reader pool). */
  reader(): ReaderHandle;
  outbox: {
    append(tx: TxHandle, topic: string, payload: unknown): void;
    /** Publishes unpublished rows in `seq` order, in batches, then marks them published; a throw leaves them for the next drain. */
    drain(h: (rows: OutboxRow[]) => void): void;
    /** Number of unpublished rows. */
    backlog(): number;
  };
  integrityCheck(kind: 'quick' | 'full'): { ok: boolean; messages: string[] };
  /**
   * The retention job's transaction (retention.ts only; Z02 round 3 ruling 14): sets `retention_clock` to `nowMs`, runs
   * `fn`, and resets it to 0 before the commit. No other SQL may name `retention_clock`.
   */
  withRetentionClock<T>(nowMs: number, fn: (tx: TxHandle) => T): T;
  /** Online backup of the main database to `path` (overwritten), `rate` pages per step. */
  backupTo(path: string, rate?: number): Promise<number>;
  close(): void;
}

export interface DbOptions {
  /** `m24.db_path`; `:memory:` only in tests (no readers then). */
  path: string;
  clock: Clock;
  /** Reader connections (default 2). */
  readers?: number;
  /** `db_write_latency_ms` and `outbox_backlog` (B-M27-01 registry handles). */
  metrics?: { writeLatencyMs: HistogramHandle; outboxBacklog: GaugeHandle };
  log?: Logger;
  /**
   * A missing database file is created only by an explicit init (Z02 round 2 ruling 2): `create: true` is `botctl init`;
   * `initMarker` is a first-start marker file kept outside the database directory, removed once the database exists.
   * Without either, a missing file refuses the start (E_DATABASE_MISSING, critical log). The marker's directory must be
   * writable by the engine's user, so the marker can be removed (ruling 15): on the host, `ENGINE_PATHS.initMarker`
   * (`/var/lib/zeroed/init/first-start`, PATHS-FIX), in the unit's 0700 state folder. A marker that cannot be removed refuses the start
   * (E_INIT_MARKER_STUCK) with the writer closed and the lock released, so it can never later recreate an empty
   * database; a marker found beside an existing database is removed first, or the start is refused the same way.
   */
  create?: boolean;
  initMarker?: string;
}

export type DbOpenCode = 'E_DATABASE_MISSING' | 'E_DATABASE_EMPTY' | 'E_DATABASE_CORRUPT' | 'E_WRITER_LOCKED' | 'E_NOT_WAL' | 'E_INIT_MARKER_STUCK';

/** A start-up refusal of `openDb`; the caller keeps the engine stopped and the critical log raises the alert. */
export class DbOpenError extends Error {
  readonly code: DbOpenCode;
  constructor(code: DbOpenCode, message: string) {
    super(message);
    this.name = 'DbOpenError';
    this.code = code;
  }
}

/** SQLite's messages for a damaged file (SQLITE_CORRUPT, SQLITE_NOTADB). */
export function isCorruptionError(e: unknown): boolean {
  return /malformed|not a database|corrupt/i.test(e instanceof Error ? e.message : String(e));
}

/** Outbox table. Part of the first migration (B-M24-02), so the exact text is shared. */
export const OUTBOX_DDL = `CREATE TABLE outbox (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  topic TEXT NOT NULL CHECK (length(topic) BETWEEN 1 AND 128),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  created_at INTEGER NOT NULL,
  published_at INTEGER
);
CREATE INDEX outbox_unpublished ON outbox(seq) WHERE published_at IS NULL;
CREATE INDEX outbox_published_at ON outbox(published_at) WHERE published_at IS NOT NULL;`;

export const OUTBOX_RETENTION_MS = 7 * 86_400_000;
const DRAIN_BATCH = 500;
const NONE: ReadonlySet<string> = new Set();
const STATEMENT_CACHE = 512;
const BUSY_TIMEOUT_MS = 5_000;

export const M24_LOG_CODES = {
  'm24.outbox_replay': { fields: { rows: 'integer' } },
  'm24.open_refused': { fields: { error_code: 'string', message: 'string' } },
} as const;

function isThenable(v: unknown): boolean {
  return typeof v === 'object' && v !== null && typeof (v as { then?: unknown }).then === 'function';
}

/** Prepared statements per connection, every integer read as a bigint. */
class Statements {
  private readonly cache = new Map<string, StatementSync>();
  private readonly conn: DatabaseSync;
  constructor(conn: DatabaseSync) {
    this.conn = conn;
  }
  get(sql: string): StatementSync {
    let st = this.cache.get(sql);
    if (st === undefined) {
      if (this.cache.size >= STATEMENT_CACHE) this.cache.clear();
      st = this.conn.prepare(sql);
      // node:sqlite compiles only the first statement and drops the rest without an error (Z02 round 5 ruling 28):
      // anything after SQLite's own end of that statement must be whitespace, `;` or comments.
      const tail = sql.slice(st.sourceSQL.length);
      const next = statementStart(tail);
      if (next >= 0 && next < tail.length) throw new Error('m24: one SQL statement per call; the text holds a second statement');
      st.setReadBigInts(true);
      this.cache.set(sql, st);
    }
    return st;
  }
}

function readerOf(st: Statements): ReaderHandle {
  return {
    get: (sql, ...params) => st.get(sql).get(...params) as Row | undefined,
    all: (sql, ...params) => st.get(sql).all(...params) as Row[],
  };
}

/** An unpublished row as `drain` hands it over. */
function toOutboxRow(r: Row): OutboxRow {
  return { seq: r.seq as bigint, topic: r.topic as string, payloadJson: r.payload_json as string, createdAtMs: Number(r.created_at) as UnixMs, publishedAtMs: null };
}

const TX_KEYWORD = /(?:BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b/iy;
/** Schema changes and the statements that can reach the schema by other doors (writable_schema, another file). */
const DDL_KEYWORD = /(?:CREATE|DROP|ALTER|PRAGMA|ATTACH|DETACH|VACUUM|REINDEX)\b/iy;

/**
 * Where the first keyword of `sql` starts, or -1 when there is no statement. Before it SQLite skips whitespace, empty
 * statements (`;`), `-- line` and `/* block *\/` comments, and so does this scan, in one pass over the text (no
 * backtracking, red team n1). A comment left open runs to the end: no statement.
 */
function statementStart(sql: string): number {
  let i = 0;
  while (i < sql.length) {
    if (sql[i] === ';' || /\s/.test(sql[i] as string)) {
      i += 1;
    } else if (sql.startsWith('--', i)) {
      const end = sql.indexOf('\n', i + 2);
      if (end === -1) return -1;
      i = end + 1;
    } else if (sql.startsWith('/*', i)) {
      const end = sql.indexOf('*/', i + 2);
      if (end === -1) return -1;
      i = end + 2;
    } else {
      break;
    }
  }
  return i;
}

const startsWith = (re: RegExp, sql: string): boolean => {
  const i = statementStart(sql);
  if (i < 0) return false;
  re.lastIndex = i;
  return re.test(sql);
};

/** Transaction control belongs to `withTx` alone: a module cannot commit or roll back half of a transaction. */
export function isTxControl(sql: string): boolean {
  return startsWith(TX_KEYWORD, sql);
}

/** Schema statements belong to the migration runner alone (`schemaTx`; Z02 round 4 ruling 22). */
export function isDdl(sql: string): boolean {
  return startsWith(DDL_KEYWORD, sql);
}

/** Restricts the database file and its WAL and shared-memory files to the owner (ARCH B-M24-01 security notes). */
function restrictFiles(path: string): void {
  for (const f of [path, `${path}-wal`, `${path}-shm`]) if (existsSync(f)) chmodSync(f, 0o600);
}

/**
 * Holds an exclusive SQLite lock on `<db>-writer.lock` for the writer's whole life (ported from Zeroed's LEDGER-1
 * writer lock, `packages/core/src/ledger/adapters/lock.ts`). It is an OS file lock, so the kernel drops it when the
 * process dies: no pid file and no stale check. A second writer, in this process or another, is refused at once;
 * two openers racing for a new lock file may both be refused, and neither runs (a start retries).
 */
function takeWriterLock(path: string): () => void {
  const lockPath = writerLockPath(path);
  const lock = new DatabaseSync(lockPath, { timeout: 0 });
  try {
    lock.exec('PRAGMA locking_mode = EXCLUSIVE');
    lock.exec('BEGIN EXCLUSIVE');
  } catch (e) {
    lock.close();
    const message = (e as Error).message;
    throw new Error(/locked|busy/i.test(message) ? `m24: ${path} already has a writer` : `m24: cannot take the writer lock of ${path}: ${message}`);
  }
  chmodSync(lockPath, 0o600);
  return () => { if (lock.isOpen) lock.close(); };     // closing ends the transaction and drops the lock
}

/** Opens the writer (and the readers for a file database) with the M24 PRAGMAs. */
export function openDb(opts: DbOptions): Db {
  const refuse = (code: DbOpenCode, message: string): DbOpenError => {
    opts.log?.event('critical', 'm24.open_refused', { error_code: code, message });
    return new DbOpenError(code, `m24: ${message}`);
  };
  const memory = opts.path === ':memory:';
  const file = !memory && opts.path !== '';
  let fromMarker = false;
  const removeMarker = (): string | null => {
    try {
      rmSync(opts.initMarker as string, { force: true });
      return existsSync(opts.initMarker as string) ? 'it is still there' : null;
    } catch (e) {
      return (e as Error).message;
    }
  };
  if (file && opts.initMarker !== undefined) {
    const rel = relative(dirname(resolve(opts.path)), resolve(opts.initMarker));
    if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) throw new TypeError('m24: the init marker must be outside the database directory');
  }
  if (file && existsSync(opts.path) && opts.initMarker !== undefined && existsSync(opts.initMarker)) {
    const stuck = removeMarker();                                          // a marker left beside a live database
    if (stuck !== null) throw refuse('E_INIT_MARKER_STUCK', `the first-start marker ${opts.initMarker} beside ${opts.path} cannot be removed: ${stuck}`);
  }
  if (file && !existsSync(opts.path)) {
    if (opts.initMarker !== undefined) fromMarker = existsSync(opts.initMarker);
    if (opts.create !== true && !fromMarker) {
      throw refuse('E_DATABASE_MISSING', `${opts.path} does not exist; a database is created only by botctl init or a first-start marker`);
    }
  }
  // An existing empty file is a lost or truncated database, never a first start: a new database has its WAL header
  // written below before any other step, so it is not empty afterwards (red team C R2-C2: a 0-byte ledger opened as a
  // fresh one and dropped an open position).
  if (file && existsSync(opts.path) && statSync(opts.path).size === 0) {
    throw refuse('E_DATABASE_EMPTY', `${opts.path} exists and is empty; a lost or truncated database is never replaced by a fresh one`);
  }
  let release: () => void;
  try {
    release = file ? takeWriterLock(opts.path) : () => {};
  } catch (e) {
    throw refuse('E_WRITER_LOCKED', (e as Error).message.replace(/^m24: /, ''));
  }
  let opened: DatabaseSync | undefined;
  try {
    opened = new DatabaseSync(opts.path, { enableForeignKeyConstraints: true, timeout: 0 });
    const mode = (opened.prepare('PRAGMA journal_mode=WAL').get() as { journal_mode: string }).journal_mode;
    if (!memory && mode !== 'wal') throw refuse('E_NOT_WAL', `journal_mode is ${mode}, not wal`);  // '' cannot use WAL
    opened.exec('PRAGMA synchronous=FULL');
    opened.exec('PRAGMA foreign_keys=ON');
    opened.prepare('SELECT count(*) AS n FROM sqlite_schema').get();      // reads page 1: a torn header fails here
  } catch (e) {
    opened?.close();
    release();
    if (e instanceof DbOpenError) throw e;
    if (isCorruptionError(e)) throw refuse('E_DATABASE_CORRUPT', `${opts.path} is damaged: ${(e as Error).message}`);
    throw e;
  }
  const writer: DatabaseSync = opened;
  if (fromMarker) {                                                       // the database exists now: the marker is spent
    const stuck = removeMarker();
    if (stuck !== null) {
      writer.close();
      release();
      throw refuse('E_INIT_MARKER_STUCK', `the first-start marker ${opts.initMarker as string} cannot be removed: ${stuck}`);
    }
  }
  if (!memory) restrictFiles(opts.path);
  const ws = new Statements(writer);
  const readerConns = memory ? [] : Array.from({ length: opts.readers ?? 2 },
    () => new DatabaseSync(opts.path, { readOnly: true, enableForeignKeyConstraints: true, timeout: BUSY_TIMEOUT_MS }));
  const readers = readerConns.map((conn) => readerOf(new Statements(conn)));
  let next = 0;
  let inTx = false;
  let lastPruneMs = Number.NEGATIVE_INFINITY;

  const outboxExists = writer.prepare("SELECT 1 AS x FROM sqlite_schema WHERE type = 'table' AND name = 'outbox'").get() !== undefined;
  let backlog = outboxExists ? Number((ws.get('SELECT count(*) AS n FROM outbox WHERE published_at IS NULL').get() as { n: bigint }).n) : 0;
  opts.metrics?.outboxBacklog.set(backlog);
  if (backlog > 0) opts.log?.event('info', 'm24.outbox_replay', { rows: backlog });

  /** Throws when the transaction has ended inside `withTx` (a caught RAISE(ROLLBACK) or SQLITE_FULL rolled it back). */
  const stillOpen = (): void => {
    if (!writer.isTransaction) throw new Error('m24: the transaction ended inside withTx; nothing more runs in it');
  };
  const handleFor = (active: () => boolean, schema: boolean, trusted: ReadonlySet<string>): TxHandle => {
    const guard = (sql: string): void => {
      if (!active()) throw new Error('m24: transaction handle used outside its withTx');
      if (isTxControl(sql)) throw new Error('m24: transaction control is withTx\'s alone');
      // Ruling 22: a trigger, table or view is changed only by the migration runner (schemaTx), so no module can
      // drop the append-only triggers. Rulings 14 and 24: only the retention job (withRetentionClock) writes
      // retention_clock, and only the migrations' own text may name it in a schema transaction.
      if (!schema && isDdl(sql)) throw new Error('m24: schema statements (CREATE, DROP, ALTER, PRAGMA, ATTACH) are the migration runner\'s alone (schemaTx)');
      // Ruling 27: SQLite's own tables (sqlite_schema, sqlite_sequence, …) are read and written only by the migration runner.
      if (!schema && /sqlite_/i.test(sql)) throw new Error('m24: SQLite\'s own sqlite_* tables are the migration runner\'s alone (schemaTx)');
      if (/retention_clock/i.test(sql) && !trusted.has(sql)) throw new Error('m24: retention_clock is the retention job\'s alone (retention.ts, withRetentionClock)');
      stillOpen();
    };
    return {
      run: (sql, ...params) => {
        guard(sql);
        const r = ws.get(sql).run(...params);
        stillOpen();
        return { changes: Number(r.changes), lastInsertRowid: BigInt(r.lastInsertRowid) };
      },
      get: (sql, ...params) => {
        guard(sql);
        const r = ws.get(sql).get(...params) as Row | undefined;
        stillOpen();
        return r;
      },
      all: (sql, ...params) => {
        guard(sql);
        const r = ws.get(sql).all(...params) as Row[];
        stillOpen();
        return r;
      },
    };
  };

  let currentTx: TxHandle | null = null;
  let appended = 0;

  const runTx = <T>(fn: (tx: TxHandle) => T, schema: boolean, trusted: ReadonlySet<string> = NONE): T => {
    if (inTx) throw new Error('m24: withTx cannot be nested');
    const started = opts.clock.nowMs();
    let open = true;
    const tx = handleFor(() => open, schema, trusted);
    const end = (): void => {
      open = false;
      inTx = false;
      currentTx = null;
      opts.metrics?.writeLatencyMs.observe(opts.clock.nowMs() - started);
    };
    writer.exec('BEGIN IMMEDIATE');
    inTx = true;
    currentTx = tx;
    appended = 0;
    let result: T;
    try {
      result = fn(tx);
      if (isThenable(result)) throw new TypeError('m24: a withTx callback must be synchronous (ARCH 7.1); it returned a promise');
      stillOpen();
      writer.exec('COMMIT');
    } catch (e) {
      if (writer.isTransaction) writer.exec('ROLLBACK');   // SQLite may already have rolled back (RAISE(ROLLBACK), SQLITE_FULL)
      end();
      throw e;
    }
    end();
    backlog += appended;
    opts.metrics?.outboxBacklog.set(backlog);
    return result;
  };

  const db: Db = {
    withTx<T>(fn: (tx: TxHandle) => T): T {
      return runTx(fn, false);
    },

    withRetentionClock<T>(nowMs: number, fn: (tx: TxHandle) => T): T {
      if (!Number.isSafeInteger(nowMs) || nowMs <= 0) throw new RangeError('m24: retention needs a positive epoch-ms time');
      const set = (v: number): void => {
        ws.get('INSERT INTO "retention_clock" ("id", "now_ms") VALUES (1, ?) ON CONFLICT ("id") DO UPDATE SET "now_ms" = excluded."now_ms"').run(v);
      };
      return db.withTx((tx) => {
        set(nowMs);
        const result = fn(tx);
        set(0);
        return result;
      });
    },

    reader(): ReaderHandle {
      if (readers.length === 0) throw new Error('m24: an in-memory database has no reader connections');
      const r = readers[next % readers.length] as ReaderHandle;
      next += 1;
      return r;
    },

    outbox: {
      append(tx, topic, payload): void {
        if (tx !== currentTx) throw new Error('m24: outbox.append needs the active withTx handle');
        tx.run('INSERT INTO outbox (topic, payload_json, created_at) VALUES (?, ?, ?)', topic, canonicalJson(payload), opts.clock.nowMs());
        appended += 1;
      },
      drain(h): void {
        if (inTx) throw new Error('m24: outbox.drain runs after commit, never inside withTx');
        for (;;) {
          const rows = (ws.get(`SELECT seq, topic, payload_json, created_at FROM outbox WHERE published_at IS NULL ORDER BY seq LIMIT ${DRAIN_BATCH}`).all() as Row[]).map(toOutboxRow);
          if (rows.length === 0) break;
          h(rows);
          const last = (rows[rows.length - 1] as OutboxRow).seq;
          const now = opts.clock.nowMs();
          db.withTx((tx) => tx.run('UPDATE outbox SET published_at = ? WHERE published_at IS NULL AND seq <= ?', now, last));
          backlog = Math.max(0, backlog - rows.length);
          opts.metrics?.outboxBacklog.set(backlog);
          if (rows.length < DRAIN_BATCH) break;
        }
        const now = opts.clock.nowMs();
        // A clock that ran ahead and came back must not stop pruning until that date (red team C M3 pattern).
        if (now - lastPruneMs >= 3_600_000 || now < lastPruneMs) {
          lastPruneMs = now;
          db.withTx((tx) => tx.run('DELETE FROM outbox WHERE published_at IS NOT NULL AND published_at < ?', now - OUTBOX_RETENTION_MS));
        }
      },
      backlog: () => backlog,
    },

    integrityCheck(kind) {
      const rows = writer.prepare(kind === 'quick' ? 'PRAGMA quick_check' : 'PRAGMA integrity_check').all() as Array<Record<string, string>>;
      const messages = rows.map((r) => String(Object.values(r)[0]));
      return { ok: messages.length === 1 && messages[0] === 'ok', messages };
    },

    async backupTo(path, rate = 100) {
      const pages = await backup(writer, path, { rate });
      restrictFiles(path);
      return pages;
    },

    close(): void {
      for (const c of readerConns) c.close();
      writer.close();
      release();
    },
  };
  // The schema runner lives in schema-tx.ts's private WeakMap, not on `db` (ruling 29).
  registerSchemaRunner(db, (fn, trusted) => runTx(fn, true, trusted));
  return db;
}

/**
 * Idempotent consumer (B-M24-01 logic 4) with one watermark: the highest `seq` it has applied. `drain` hands rows over
 * in ascending `seq` and, after a failed publish or a crash, hands them over again from the lowest unpublished `seq`
 * (the single writer commits `seq` values in order), so every row at or below the watermark has been applied and is
 * skipped: each row, and so each entity key's event, is applied once. Memory stays constant however many keys pass;
 * the consumer persists `watermark()` and passes it back after a restart.
 */
export class OutboxConsumer {
  private last: bigint;
  private readonly apply: (row: OutboxRow) => void;
  constructor(apply: (row: OutboxRow) => void, watermark = 0n) {
    this.apply = apply;
    this.last = watermark;
  }
  handle(rows: readonly OutboxRow[]): void {
    for (const row of rows) {
      if (row.seq <= this.last) continue;
      this.apply(row);
      this.last = row.seq;
    }
  }
  /** The highest `seq` applied. */
  watermark(): bigint {
    return this.last;
  }
}
