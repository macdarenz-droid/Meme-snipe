// M14's provider usage ledger (SPEC-A A-M14-05 logic 2, card Z08), kept under m24 because M24 owns every node:sqlite
// use (policy E_SQLITE_OUTSIDE_M24). One SQLite file per host, `/var/lib/zeroed-usage/rpc-usage.db` (ENGINE_PATHS.rpcUsageDb), shared by the engine and the sentinel. Each send is
// reserved here before it goes out, in an exclusive transaction that checks the account's rolling 31-day sum and the
// consumer's own sum against their caps; the reservation is written before the request, so every request sent counts
// whatever its result. Mode 0660 is set explicitly on the database and its -wal/-shm files because the engine's unit
// keeps UMask=0077 (PATHS-FIX ruling 21). The four ledger counts are kept per provider, consumer and UTC month.
//
// A failed open, read or write throws; the meter (meter.ts) turns that into a refused send (fail closed) and tries
// again on the next send, so an unreadable file never halts the month for good (Zeroed round 4 item 9) and a failed
// write never spends the cap (round 4 item 7).
import { chmodSync, existsSync } from 'node:fs';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { UnixMs } from '@bot/types';
import { DAY_MS, monthKeyUtc, monthStartUtc, ROLLING_WINDOW_MS, type LedgerCounts, type Outcome } from '../m14/usage.ts';

/**
 * A monthly call cap on the ledger (A-M14-03: CoinGecko's 2,000 calls a month): one unit per call, counted from the start
 * of the UTC month, in the same exclusive transaction as every other reservation. Throws when the ledger fails.
 */
export function monthlyCapOn(open: () => UsageLedgerPort): { take(service: string, atMs: UnixMs, cap: number): boolean } {
  let l: UsageLedgerPort | null = null;
  return {
    take(service: string, atMs: UnixMs, cap: number): boolean {
      try {
        l ??= open();
        return l.reserveMonthly(service, atMs, cap);
      } catch (e) {
        try { l?.close(); } catch { /* already broken */ }
        l = null;
        throw e;
      }
    },
  };
}

export type ReserveResult = 'ok' | 'over_account' | 'over_consumer';
export interface ReserveRequest { provider: string; consumer: string; units: number; atMs: UnixMs; accountCap: number; consumerCap: number }
export interface LedgerTotals { accountRolling: number; consumerRolling: number; monthToDate: number; last24h: number }

/** What the meter needs from the ledger; tests pass an in-memory one or a failing one. */
export interface UsageLedgerPort {
  reserve(r: ReserveRequest): ReserveResult;
  /** One call against a cap counted from the start of the UTC month (consumer `month`). */
  reserveMonthly(provider: string, atMs: UnixMs, cap: number): boolean;
  totals(provider: string, consumer: string, atMs: UnixMs): LedgerTotals;
  count(provider: string, consumer: string, atMs: UnixMs, what: 'attempt' | Outcome): void;
  counts(provider: string, consumer: string, monthKey: string): LedgerCounts;
  close(): void;
}

/** Entries older than this are deleted: the rolling window plus the month before it, for the projection. */
export const KEEP_MS = 62 * DAY_MS;
/** How long a send waits for the sentinel's transaction before it is refused (the event loop blocks meanwhile). */
export const BUSY_TIMEOUT_MS = 250;
const FILE_MODE = 0o660;

const DDL = `
CREATE TABLE IF NOT EXISTS usage_entry (
  id INTEGER PRIMARY KEY, provider TEXT NOT NULL, consumer TEXT NOT NULL, at_ms INTEGER NOT NULL, units INTEGER NOT NULL CHECK (units > 0));
CREATE INDEX IF NOT EXISTS usage_entry_by_time ON usage_entry (provider, at_ms);
CREATE TABLE IF NOT EXISTS usage_count (
  provider TEXT NOT NULL, consumer TEXT NOT NULL, month TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0, ok INTEGER NOT NULL DEFAULT 0, errors INTEGER NOT NULL DEFAULT 0, timeouts INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (provider, consumer, month));`;

const COLUMN: Readonly<Record<'attempt' | Outcome, string>> = { attempt: 'attempts', ok: 'ok', error: 'errors', timeout: 'timeouts' };

/** Opens (or creates) the ledger at `path`. Throws when it cannot be opened. */
export function openUsageLedger(path: string): UsageLedgerPort {
  const db = new DatabaseSync(path, { timeout: BUSY_TIMEOUT_MS });
  try {
    db.exec('PRAGMA journal_mode=WAL');
    db.exec(DDL);
    for (const f of [path, `${path}-wal`, `${path}-shm`]) if (existsSync(f)) chmodSync(f, FILE_MODE);
  } catch (e) {
    db.close();
    throw e;
  }
  const sumSince: StatementSync = db.prepare('SELECT COALESCE(SUM(units), 0) AS s FROM usage_entry WHERE provider = ? AND at_ms > ?');
  const sumConsumerSince = db.prepare('SELECT COALESCE(SUM(units), 0) AS s FROM usage_entry WHERE provider = ? AND consumer = ? AND at_ms > ?');
  const sumFrom = db.prepare('SELECT COALESCE(SUM(units), 0) AS s FROM usage_entry WHERE provider = ? AND at_ms >= ?');
  const insert = db.prepare('INSERT INTO usage_entry (provider, consumer, at_ms, units) VALUES (?, ?, ?, ?)');
  const prune = db.prepare('DELETE FROM usage_entry WHERE at_ms < ?');
  const countsStmt = db.prepare('SELECT attempts, ok, errors, timeouts FROM usage_count WHERE provider = ? AND consumer = ? AND month = ?');
  const countStmts = new Map<string, StatementSync>();
  const num = (st: StatementSync, ...args: Array<string | number>): number => Number((st.get(...args) as { s: number | bigint }).s);

  return {
    reserve(r: ReserveRequest): ReserveResult {
      db.exec('BEGIN IMMEDIATE');
      try {
        const since = r.atMs - ROLLING_WINDOW_MS;
        let result: ReserveResult = 'ok';
        if (num(sumSince, r.provider, since) + r.units > r.accountCap) result = 'over_account';
        else if (num(sumConsumerSince, r.provider, r.consumer, since) + r.units > r.consumerCap) result = 'over_consumer';
        if (result === 'ok') {
          insert.run(r.provider, r.consumer, r.atMs, r.units);
          prune.run(r.atMs - KEEP_MS);
        }
        db.exec('COMMIT');
        return result;
      } catch (e) {
        // node:sqlite on Node 22 has no isTransaction [VF-08]: a failed COMMIT or statement leaves the transaction open.
        try { db.exec('ROLLBACK'); } catch { /* none open */ }
        throw e;
      }
    },
    reserveMonthly(provider: string, atMs: UnixMs, cap: number): boolean {
      db.exec('BEGIN IMMEDIATE');
      try {
        const ok = num(sumFrom, provider, monthStartUtc(atMs)) + 1 <= cap;
        if (ok) insert.run(provider, 'month', atMs, 1);
        db.exec('COMMIT');
        return ok;
      } catch (e) {
        try { db.exec('ROLLBACK'); } catch { /* none open */ }
        throw e;
      }
    },
    totals(provider: string, consumer: string, atMs: UnixMs): LedgerTotals {
      return {
        accountRolling: num(sumSince, provider, atMs - ROLLING_WINDOW_MS),
        consumerRolling: num(sumConsumerSince, provider, consumer, atMs - ROLLING_WINDOW_MS),
        monthToDate: num(sumFrom, provider, monthStartUtc(atMs)),
        last24h: num(sumSince, provider, atMs - DAY_MS),
      };
    },
    count(provider: string, consumer: string, atMs: UnixMs, what: 'attempt' | Outcome): void {
      const col = COLUMN[what];
      // Prepared once per column, not per call: a statement per read left native statements waiting on GC (Z10-38).
      let st = countStmts.get(col);
      if (st === undefined) {
        st = db.prepare(`INSERT INTO usage_count (provider, consumer, month, ${col}) VALUES (?, ?, ?, 1)
        ON CONFLICT (provider, consumer, month) DO UPDATE SET ${col} = ${col} + 1`);
        countStmts.set(col, st);
      }
      st.run(provider, consumer, monthKeyUtc(atMs));
    },
    counts(provider: string, consumer: string, monthKey: string): LedgerCounts {
      const row = countsStmt.get(provider, consumer, monthKey) as LedgerCounts | undefined;
      return row === undefined ? { attempts: 0, ok: 0, errors: 0, timeouts: 0 }
        : { attempts: Number(row.attempts), ok: Number(row.ok), errors: Number(row.errors), timeouts: Number(row.timeouts) };
    },
    close(): void { db.close(); },
  };
}
