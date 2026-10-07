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
import { chmodSync, existsSync, statSync } from 'node:fs';
import { backup, DatabaseSync, type StatementSync } from 'node:sqlite';
import { canonicalJson, type Clock, type UnixMs } from '@bot/types';
import type { Logger } from '../m27/log.ts';
import type { GaugeHandle, HistogramHandle } from '../m27/metrics.ts';

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
  /** Runs `fn` in one write transaction; a throw rolls back and is rethrown. The body must be synchronous. */
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
const STATEMENT_CACHE = 512;
const BUSY_TIMEOUT_MS = 5_000;

export const M24_LOG_CODES = {
  'm24.outbox_replay': { fields: { rows: 'integer' } },
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

/**
 * Transaction control belongs to `withTx` alone: a module cannot commit or roll back half of a transaction. Before the
 * first keyword SQLite skips whitespace, empty statements (`;`), `-- line` and `/* block *\/` comments, and so does this
 * scan, in one pass over the text (no backtracking, red team n1). A comment left open runs to the end: no statement.
 */
export function isTxControl(sql: string): boolean {
  let i = 0;
  while (i < sql.length) {
    if (sql[i] === ';' || /\s/.test(sql[i] as string)) {
      i += 1;
    } else if (sql.startsWith('--', i)) {
      const end = sql.indexOf('\n', i + 2);
      if (end === -1) return false;
      i = end + 1;
    } else if (sql.startsWith('/*', i)) {
      const end = sql.indexOf('*/', i + 2);
      if (end === -1) return false;
      i = end + 2;
    } else {
      break;
    }
  }
  TX_KEYWORD.lastIndex = i;
  return TX_KEYWORD.test(sql);
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
  const lockPath = `${path}-writer.lock`;
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
  const memory = opts.path === ':memory:';
  // An existing empty file is a lost or truncated database, never a first start: a new database has its WAL header
  // written below before any other step, so it is not empty afterwards (red team C R2-C2: a 0-byte ledger opened as a
  // fresh one and dropped an open position).
  if (!memory && opts.path !== '' && existsSync(opts.path) && statSync(opts.path).size === 0) {
    throw new Error(`m24: ${opts.path} exists and is empty; a lost or truncated database is never replaced by a fresh one`);
  }
  const release = memory || opts.path === '' ? () => {} : takeWriterLock(opts.path);
  let writer: DatabaseSync;
  try {
    writer = new DatabaseSync(opts.path, { enableForeignKeyConstraints: true, timeout: 0 });
  } catch (e) {
    release();
    throw e;
  }
  const mode = (writer.prepare('PRAGMA journal_mode=WAL').get() as { journal_mode: string }).journal_mode;
  if (!memory && mode !== 'wal') {                    // an anonymous temporary database ('') cannot use WAL
    writer.close();
    release();
    throw new Error(`m24: journal_mode is ${mode}, not wal`);
  }
  writer.exec('PRAGMA synchronous=FULL');
  writer.exec('PRAGMA foreign_keys=ON');
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
  const handleFor = (active: () => boolean): TxHandle => {
    const guard = (sql: string): void => {
      if (!active()) throw new Error('m24: transaction handle used outside its withTx');
      if (isTxControl(sql)) throw new Error('m24: transaction control is withTx\'s alone');
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

  const db: Db = {
    withTx<T>(fn: (tx: TxHandle) => T): T {
      if (inTx) throw new Error('m24: withTx cannot be nested');
      const started = opts.clock.nowMs();
      let open = true;
      const tx = handleFor(() => open);
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
          // A row stamped ahead of `now` was published under a clock that came back; it is delivered, so it goes too.
          db.withTx((tx) => tx.run('DELETE FROM outbox WHERE published_at IS NOT NULL AND (published_at < ? OR published_at > ?)', now - OUTBOX_RETENTION_MS, now));
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
