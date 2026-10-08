// Typed repositories (B-M24-02 interfaces): one per table, generated from the descriptors. Every module writes only
// through these (ARCH 7.2: schema owned by M24). Rows are camelCase objects whose field types follow the column kinds:
// lamports and other 64-bit integers are bigint, times and counts are number, booleans are boolean, everything else is
// a string (base-unit amounts and prices are decimal strings). Append-only tables get `insert` and reads only.
// Versioned tables (a `version` column outside the key: candidate, order_intent, tx_attempt, position) change only by
// a compare-and-set update that increments `version` and returns E_STATE_CHANGED on a lost race (ARCH 7.1, SPEC-B
// convention 5): they have no plain update or upsert, so no write can leave `version` unchanged or set it.
import type { Clock, Result } from '@bot/types';
import type { RollupRow, RollupSink } from '../m27/metrics.ts';
import type { Logger } from '../m27/log.ts';
import type { Db, ReaderHandle, Row, SqlValue, TxHandle } from './db.ts';
import { snake, TABLES, type ColumnDef, type TableName } from './schema.ts';

type Tables = typeof TABLES;
type Cols<N extends TableName> = Tables[N]['columns'];
type TsOf<C> = C extends { readonly kind: 'enum'; readonly values: readonly (infer V)[] } ? V
  : C extends { readonly kind: 'bool' } ? boolean
    : C extends { readonly kind: 'int' | 'ms' | 'real' } ? number
      : C extends { readonly kind: 'lamports' | 'slamports' | 'i64' } ? bigint
        : C extends { readonly kind: 'blob' } ? Uint8Array
          : string;
type Field<C> = C extends { readonly nullable: true } ? TsOf<C> | null : TsOf<C>;

/** The row type of a table. */
export type RowOf<N extends TableName> = { -readonly [K in keyof Cols<N>]: Field<Cols<N>[K]> };
type KeyCols<N extends TableName> = Tables[N]['key'][number] & keyof RowOf<N>;
/** The primary-key fields of a table. */
export type KeyOf<N extends TableName> = Pick<RowOf<N>, KeyCols<N>>;
/** Fields an update may set: every column except the key (and the version, which the CAS update sets). */
export type PatchOf<N extends TableName> = Partial<Omit<RowOf<N>, KeyCols<N> | 'version'>>;
export interface FindOptions<N extends TableName> { orderBy?: keyof RowOf<N> & string; desc?: boolean; limit?: number }

const q = (name: string): string => `"${name}"`;

function toSql(v: unknown): SqlValue {
  return typeof v === 'boolean' ? (v ? 1 : 0) : (v as SqlValue);
}

function fromSql(def: ColumnDef, v: SqlValue): unknown {
  if (v === null) return null;
  switch (def.kind) {
    case 'bool':
      return v === 1n;
    case 'int': case 'ms': {
      const n = Number(v);
      if (!Number.isSafeInteger(n)) throw new RangeError('m24: an integer column holds a value beyond 2^53');
      return n;
    }
    default:
      return v;
  }
}

/** Reads and inserts for any table. */
export class Repo<N extends TableName> {
  readonly table: N;
  protected readonly cols: ReadonlyArray<[string, ColumnDef]>;
  protected readonly key: readonly string[];

  constructor(table: N) {
    this.table = table;
    this.cols = Object.entries(TABLES[table].columns) as Array<[string, ColumnDef]>;
    this.key = TABLES[table].key;
  }

  /** Inserts one row (every column given; append-only tables accept nothing else). */
  insert(tx: TxHandle, row: RowOf<N>): void {
    const names = this.cols.map(([n]) => q(snake(n))).join(', ');
    const marks = this.cols.map(() => '?').join(', ');
    tx.run(`INSERT INTO ${q(this.table)} (${names}) VALUES (${marks})`, ...this.cols.map(([n]) => toSql((row as Record<string, unknown>)[n])));
  }

  /** The row with this key, or null. */
  get(h: ReaderHandle, key: KeyOf<N>): RowOf<N> | null {
    const where = this.key.map((k) => `${q(snake(k))} = ?`).join(' AND ');
    const r = h.get(`SELECT * FROM ${q(this.table)} WHERE ${where}`, ...this.key.map((k) => toSql((key as Record<string, unknown>)[k])));
    return r === undefined ? null : this.read(r);
  }

  /** Rows whose fields equal `where` (null matches NULL), optionally ordered and limited. A name that is not a column throws. */
  find(h: ReaderHandle, where: Partial<RowOf<N>> = {}, opts: FindOptions<N> = {}): Array<RowOf<N>> {
    const entries = this.columnsOf(where);
    if (opts.orderBy !== undefined) this.columnsOf({ [opts.orderBy]: null });
    const clause = entries.length === 0 ? '' : ` WHERE ${entries.map(([k, v]) => `${q(snake(k))} ${v === null ? 'IS NULL' : '= ?'}`).join(' AND ')}`;
    const params = entries.filter(([, v]) => v !== null).map(([, v]) => toSql(v));
    const order = opts.orderBy === undefined ? '' : ` ORDER BY ${q(snake(opts.orderBy))}${opts.desc === true ? ' DESC' : ''}`;
    const limit = opts.limit === undefined ? '' : ` LIMIT ${Math.max(0, Math.floor(opts.limit) || 0)}`;   // NaN reads as 0
    return h.all(`SELECT * FROM ${q(this.table)}${clause}${order}${limit}`, ...params).map((r) => this.read(r));
  }

  protected has(name: string): boolean {
    return this.cols.some(([n]) => n === name);
  }

  /** The entries of `fields`; a name that is not a column of this table throws (a misspelt filter must not match every row). */
  protected columnsOf(fields: object): Array<[string, unknown]> {
    const entries = Object.entries(fields);
    const unknown = entries.find(([k]) => !this.has(k));
    if (unknown !== undefined) throw new TypeError(`m24: ${this.table} has no column "${unknown[0]}"`);
    return entries;
  }

  protected read(r: Row): RowOf<N> {
    const out: Record<string, unknown> = {};
    for (const [n, def] of this.cols) out[n] = fromSql(def, r[snake(n)] as SqlValue);
    return out as RowOf<N>;
  }
}

/** True when the table's rows carry a compare-and-set `version` column (one that is not part of the key; ARCH 7.1). */
export function isVersioned(table: TableName): boolean {
  return 'version' in TABLES[table].columns && !(TABLES[table].key as readonly string[]).includes('version');
}

/** Repositories of tables that may change and have no compare-and-set version: plain updates and upsert. */
export class MutableRepo<N extends TableName> extends Repo<N> {
  constructor(table: N) {
    super(table);
    if (isVersioned(table)) throw new TypeError(`m24: ${table} rows change only by compare-and-set (VersionedRepo)`);
  }

  /** Sets the given fields of the row with this key; returns the number of rows changed (0 or 1). */
  update(tx: TxHandle, key: KeyOf<N>, patch: PatchOf<N>): number {
    const entries = this.columnsOf(patch).filter(([k]) => !this.key.includes(k) && k !== 'version');
    if (entries.length === 0) return 0;
    const set = entries.map(([k]) => `${q(snake(k))} = ?`).join(', ');
    const where = this.key.map((k) => `${q(snake(k))} = ?`).join(' AND ');
    return tx.run(`UPDATE ${q(this.table)} SET ${set} WHERE ${where}`, ...entries.map(([, v]) => toSql(v)),
      ...this.key.map((k) => toSql((key as Record<string, unknown>)[k]))).changes;
  }

  /** Inserts the row, or replaces every non-key field of the existing row with the same key. */
  upsert(tx: TxHandle, row: RowOf<N>): void {
    const names = this.cols.map(([n]) => q(snake(n))).join(', ');
    const marks = this.cols.map(() => '?').join(', ');
    const set = this.cols.filter(([n]) => !this.key.includes(n)).map(([n]) => `${q(snake(n))} = excluded.${q(snake(n))}`).join(', ');
    tx.run(`INSERT INTO ${q(this.table)} (${names}) VALUES (${marks}) ON CONFLICT (${this.key.map((k) => q(snake(k))).join(', ')}) DO UPDATE SET ${set}`,
      ...this.cols.map(([n]) => toSql((row as Record<string, unknown>)[n])));
  }
}

/** Repositories of versioned rows: inserts, reads and the compare-and-set update only (ARCH 7.1). */
export class VersionedRepo<N extends TableName> extends Repo<N> {
  constructor(table: N) {
    super(table);
    if (!isVersioned(table)) throw new TypeError(`m24: ${table} has no version column outside its key`);
  }

  /**
   * Compare-and-set update for a versioned row (ARCH 7.1): applies the patch and increments `version` only if the
   * stored version equals `expectedVersion`; otherwise E_STATE_CHANGED and nothing changes.
   */
  updateVersioned(tx: TxHandle, key: KeyOf<N>, expectedVersion: number, patch: PatchOf<N>): Result<number, { code: 'E_STATE_CHANGED' }> {
    const entries = this.columnsOf(patch).filter(([k]) => !this.key.includes(k) && k !== 'version');
    const set = [...entries.map(([k]) => `${q(snake(k))} = ?`), '"version" = "version" + 1'].join(', ');
    const where = [...this.key.map((k) => `${q(snake(k))} = ?`), '"version" = ?'].join(' AND ');
    const changes = tx.run(`UPDATE ${q(this.table)} SET ${set} WHERE ${where}`, ...entries.map(([, v]) => toSql(v)),
      ...this.key.map((k) => toSql((key as Record<string, unknown>)[k])), expectedVersion).changes;
    return changes === 1 ? { ok: true, value: expectedVersion + 1 } : { ok: false, error: { code: 'E_STATE_CHANGED' } };
  }
}

type IsVersioned<N extends TableName> = 'version' extends keyof Cols<N> ? ('version' extends Tables[N]['key'][number] ? false : true) : false;
type RepoFor<N extends TableName> = Tables[N]['appendOnly'] extends true ? Repo<N> : IsVersioned<N> extends true ? VersionedRepo<N> : MutableRepo<N>;
export type Repos = { readonly [N in TableName]: RepoFor<N> };

/** One repository per table. */
export function createRepos(): Repos {
  const out: Record<string, Repo<TableName>> = {};
  for (const name of Object.keys(TABLES) as TableName[]) {
    out[name] = TABLES[name].appendOnly ? new Repo(name) : isVersioned(name) ? new VersionedRepo(name) : new MutableRepo(name);
  }
  return out as unknown as Repos;
}

// ---- The repositories named by B-M24-02 (ARCH M24 "a typed repository per entity") ----
export type OrdersRepo = RepoFor<'order_intent'>;
export type AttemptsRepo = RepoFor<'tx_attempt'>;
export type PositionsRepo = RepoFor<'position'>;
export type FillsRepo = RepoFor<'fill'>;
export type TradesRepo = RepoFor<'trade'>;
export type CostItemsRepo = RepoFor<'cost_item'>;
export type CashFlowsRepo = RepoFor<'cash_flow'>;
export type ReservationsRepo = RepoFor<'reservation'>;
export type TokenAccountsRepo = RepoFor<'token_account'>;
export type MintClassRepo = RepoFor<'mint_class'>;
export type LimitsRepo = { defs: RepoFor<'limit_def'>; states: RepoFor<'limit_state'> };
export type BreakerEventsRepo = RepoFor<'breaker_event'>;
export type CommandsRepo = RepoFor<'command'>;
export type AuditRepo = RepoFor<'audit_event'>;
export type AlertsRepo = RepoFor<'alert'>;
// SessionsRepo and PreferencesRepo come with B-M28-02's login migration (Z02 round 2 ruling 1).
export type ConfigVersionsRepo = RepoFor<'config_version'>;
export type PriceRefRepo = RepoFor<'price_reference'>;
export type FixedCostRepo = RepoFor<'fixed_cost_item'>;
export type SandwichRepo = RepoFor<'sandwich_check'>;
export type ReconcileRepo = RepoFor<'reconcile_run'>;
export type WalletSnapshotRepo = RepoFor<'wallet_snapshot'>;
export type KvStateRepo = RepoFor<'kv_state'>;
export type RunRepo = RepoFor<'run'>;
export type TrialRegistryRepo = RepoFor<'trial_registry'>;
export type StrategyStageRepo = RepoFor<'strategy_stage'>;
export type GateEvaluationRepo = RepoFor<'gate_evaluation'>;
export type Bar1mRepo = RepoFor<'bar_1m'>;
export type EquityPointRepo = RepoFor<'equity_point'>;
export type ScreenResultRepo = RepoFor<'screen_result'>;
export type CandidateRepo = RepoFor<'candidate'>;
export type TokenRepo = RepoFor<'token'>;
export type PoolRepo = RepoFor<'pool'>;
export type QuarantineRepo = RepoFor<'quarantine'>;
export type MetricRollupRepo = RepoFor<'metric_rollup_1m'>;
export type SignalRepo = RepoFor<'signal'>;

/** Bytes a stored `metric_rollup_1m` row takes at most (measured 87; schema.test.ts asserts at most 100). */
export const ROLLUP_ROW_BYTES = 100;

export const M24_ROLLUP_LOG_CODES = {
  'm24.rollup_cap_reached': { fields: { dropped_rows: 'integer', stored_rows: 'integer', max_bytes: 'integer' } },
} as const;

export interface RollupSinkOptions {
  /** `m27.rollup_max_bytes`: at it, pool rows are dropped first, then aggregate rows, and an error is logged. */
  maxBytes: number;
  log?: Logger;
}

/**
 * B-M27-01 rollup sink: writes each minute's rollups to `metric_rollup_1m` in one transaction. The table's size is
 * tracked as rows x ROLLUP_ROW_BYTES (counted once at start, then per write and per retention delete); at the cap, rows
 * are dropped (pool rows first) and each dropping minute logs `m24.rollup_cap_reached` at error, which the alert hook copies to the
 * alert store (Z02 round 2 ruling 7). Aggregate rows have the room first; nothing is written past the cap.
 */
export function metricRollupSink(db: Db, repo: MetricRollupRepo, clock: Clock, opts: RollupSinkOptions): RollupSink & { expired(n: number): void; storedRows(): number } {
  if (!Number.isSafeInteger(opts.maxBytes) || opts.maxBytes < ROLLUP_ROW_BYTES) throw new RangeError('m24: rollup maxBytes too small');
  let stored = Number(db.reader().get('SELECT count(*) AS n FROM metric_rollup_1m')?.n ?? 0n);
  return {
    append(rows: readonly RollupRow[]): void {
      const room = Math.floor(opts.maxBytes / ROLLUP_ROW_BYTES) - stored;
      const aggregate = rows.filter((r) => r.scope === 'aggregate');
      const pool = rows.filter((r) => r.scope === 'pool');
      const keepAggregate = Math.max(0, Math.min(aggregate.length, room));
      const keepPool = Math.max(0, Math.min(pool.length, room - keepAggregate));
      const kept = [...aggregate.slice(0, keepAggregate), ...pool.slice(0, keepPool)];
      const createdAt = clock.nowMs();
      db.withTx((tx) => {
        for (const r of kept) {
          repo.insert(tx, { metric: r.metric, labelsHash: r.labelsHash, minute: r.minute as number, scope: r.scope, count: r.count, sum: r.sum,
            p50: r.p50, p95: r.p95, p99: r.p99, createdAt });
        }
      });
      stored += kept.length;
      const dropped = rows.length - kept.length;
      if (dropped > 0) opts.log?.event('error', 'm24.rollup_cap_reached', { dropped_rows: dropped, stored_rows: stored, max_bytes: opts.maxBytes });
    },
    expired(n: number): void { stored = Math.max(0, stored - n); },
    storedRows: () => stored,
  };
}
