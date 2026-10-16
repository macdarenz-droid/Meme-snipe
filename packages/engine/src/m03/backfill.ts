// A-M03-02 migration backfill and on-chain verification (card Z09; D12: chain backfill on by default, addendum A02).
// Every pump-to-PumpSwap migration is found from the chain: `getSignaturesForAddress` on the migration withdraw
// authority [EX-03], each successful transaction fetched at version 1 [LD-05] and decoded (A-M02-03), and each pool
// verified before use (canonical, wSOL-quoted, its base mint the migrated mint). Only verified pools are published;
// vendor or stream notices only trigger an earlier verification (security note: a spoofed notice creates nothing).
//
// Cursor (persisted through M24 `discovery_cursor`, one row): `until` = the newest signature fully processed. A run
// pages newest first down to `until`; when the page cap (`max_pages_per_run`) stops it first, it saves where it got
// to (`pendingTop`, `before`) and the next run continues from `before` down to `until`, so a long downtime is caught
// up page by page and nothing between is skipped. With no cursor (first start) only the newest page is read: the
// recorder's coverage is `migrations_since_start` (ruling Z08-1). A failed page or transaction read ends the run
// without moving the cursor; the `(signature, mint)` dedupe means the retried run publishes nothing twice.
//
// It is also A-M03-01's reconnect port (ruling Z08-2): `backfillSince`, `verifiedSlot` (the newest slot verified on
// chain, ruling Z08-20) and `migrationsSeenSince`.
//
// Round 2 (red team RT-1, RT-2; rulings Z09-12, Z09-13, Z09-20, Z09-21, Z09-23):
// - `fromSlot` is a hint only: a run completes, and `until` moves, only when paging reaches `until` (or the end).
// - A PumpPortal notice is verified from the chain: its transaction is fetched and decoded, so the slot and block time
//   come from the chain, never from the notice; a later chain sighting fills a missing migration time and re-publishes.
// - Published, verified, deferred and PumpPortal-seen state lives in `BackfillStore` (M24 `kv_state`), not in memory:
//   after a restart publication is idempotent, and deferred pools survive the cursor moving past them.
// - A run stopped by a missing transaction or -32015 logs `m03.backfill_stalled` (the cursor does not move).
import type { Pubkey, Result, Signature, Slot, UnixMs } from '@bot/types';
import type { AccountsReader, PoolModelPort, PoolStateLike, RawAccount } from '../m04/types.ts';
import type { LogPort, RpcError, RpcGateway } from '../m14/types.ts';

/** ARCH M03 `MigrationObserved`, plus `migratedAtMs` (NEW: the transaction's block time, for M05's age rule C-15). */
export interface MigrationObserved {
  mint: Pubkey; pool: Pubkey; slot: Slot; signature: Signature; source: 'chain_backfill' | 'pumpportal'; verifiedOnChain: boolean;
  migratedAtMs: UnixMs | null;
}
/** ARCH M03 `PoolDiscovered`. */
export interface PoolDiscovered {
  discoveryId: string; venue: 'pumpswap'; poolId: Pubkey; baseMint: Pubkey; quoteMint: Pubkey;
  source: 'pumpportal' | 'dexscreener' | 'chain_backfill' | 'chain_enumeration'; sourceCommitment: 'confirmed' | 'unknown';
  seenAtMs: UnixMs; slot: Slot | null; verifiedOnChain: boolean;
  /** NEW: when the migration landed (block time), the only proof of pool age while D30 is parked (C-15). */
  migratedAtMs: UnixMs | null;
}

/** One decoded transaction: its block time, whether it failed, and its migration events (A-M02-03). */
export interface DecodedMigrations {
  blockTimeS: number | null;
  failed: boolean;
  migrations: Array<{ mint: Pubkey; pool: Pubkey; slot: Slot; signature: Signature }>;
  /** Migration events dropped because the curve was not SOL-quoted (decoder gap `non_sol_quote`). */
  nonSolQuote: number;
}
export type DecodeMigrations = (signature: Signature, result: unknown) => Result<DecodedMigrations, { code: string }>;

export type VerifyCode = 'E_NOT_FOUND' | 'E_NOT_CANONICAL' | 'E_NOT_SOL_QUOTED' | 'E_RPC';
/** The pool fields verification reads. */
export interface VerifiableState extends PoolStateLike { baseMint: Pubkey; quoteMint: Pubkey; isCanonical: boolean | null }

export interface BackfillConfig {
  /** `discovery.backfill.interval_ms` (60,000; 15,000-600,000). */
  intervalMs: number;
  /** `discovery.backfill.max_pages_per_run` (20; 1-100). */
  maxPagesPerRun: number;
}
export const BACKFILL_DEFAULTS: BackfillConfig = { intervalMs: 60_000, maxPagesPerRun: 20 };
export const PAGE_LIMIT = 1_000;
export const NOTICE_RETRIES = 3;
export const NOTICE_RETRY_MS = 2_000;
/** A pool not visible yet is retried on this many later runs, then dropped with `not_found`. */
export const DEFERRED_RUNS = 10;
export const DEFERRED_MAX = 1_000;
export const COVERAGE_WINDOW_MS = 7 * 86_400_000;
/** D12 switch trigger: a 7-day PumpPortal gap above 100 bps. */
export const D12_GAP_BPS = 100;
const RPC_VERSION_UNSUPPORTED = -32_015;

export function checkBackfillConfig(c: BackfillConfig): string | null {
  if (!Number.isInteger(c.intervalMs) || c.intervalMs < 15_000 || c.intervalMs > 600_000) return 'discovery.backfill.interval_ms must be 15,000-600,000';
  if (!Number.isInteger(c.maxPagesPerRun) || c.maxPagesPerRun < 1 || c.maxPagesPerRun > 100) return 'discovery.backfill.max_pages_per_run must be 1-100';
  return null;
}

interface CursorState { until: Signature | null; pendingTop: Signature | null; before: Signature | null }
export interface CursorStore { load(): string | null; save(cursor: string): void }

/** A verified migration as kept: `atMs` when it was verified, `migratedAtMs` its block time (null: none recorded). */
export interface VerifiedMigration { mint: Pubkey; pool: Pubkey; slot: Slot; atMs: UnixMs; migratedAtMs: UnixMs | null }
/** The backfill's durable state (Z09-20); the database is the source of truth (Z09-23). */
export interface BackfillStore {
  cursor: CursorStore;
  getVerified(mint: Pubkey, pool: Pubkey): VerifiedMigration | null;
  putVerified(v: VerifiedMigration): void;
  /** Verified migrations whose time (`timeOf`: block time, else verification time) is ≥ `fromMs`. */
  verifiedSince(fromMs: number): VerifiedMigration[];
  newestVerifiedSlot(): Slot | null;
  markPumpPortal(mint: Pubkey, pool: Pubkey, atMs: UnixMs): void;
  seenByPumpPortal(mint: Pubkey, pool: Pubkey): boolean;
  deferred: { list(): Array<{ m: MigrationObserved; runsLeft: number }>; put(m: MigrationObserved, runsLeft: number): void; remove(m: MigrationObserved): void };
  /** The signature a run is stalled on (a getTransaction that stays null) and how many runs tried it (Z09-21). */
  stall: { get(): { signature: Signature; attempts: number } | null; put(v: { signature: Signature; attempts: number } | null): void };
  /** Drops verified and PumpPortal entries older than `beforeMs` (kept 8 days: the 7-day window plus a day). */
  prune(beforeMs: number): void;
}
export const KEEP_MS = 8 * 86_400_000;
/** Ruling Z09-21 (amended): runs that may find a transaction still null before the critical alert and health flag. */
export const NULL_TX_MAX_ATTEMPTS = 10;

export interface BackfillDeps<P extends VerifiableState> {
  config: BackfillConfig;
  gateway: Pick<RpcGateway, 'call'>;
  reader: AccountsReader;
  model: PoolModelPort<P>;
  decode: DecodeMigrations;
  withdrawAuthority: Pubkey;
  wsolMint: Pubkey;
  store: BackfillStore;
  /** M07 stream `discovery`: every decoded migration, before verification (`verifiedOnChain = false`). */
  record(m: MigrationObserved): void;
  publishMigration(m: MigrationObserved): void;
  publishPool(p: PoolDiscovered, state: P): void;
  /** Ids for `PoolDiscovered.discoveryId`. */
  newId(): string;
  nowMs(): UnixMs;
  scheduler: { set(fn: () => void, ms: number): () => void };
  log: LogPort;
}

export interface MigrationBackfill<P extends VerifiableState> {
  backfillSince(fromSlot: Slot | null): Promise<Result<{ found: number; newestSlot: Slot }, { code: 'E_RPC' }>>;
  verifyPool(pool: Pubkey, mint: Pubkey): Promise<Result<P, { code: VerifyCode }>>;
  coverage(windowMs: number): { chainMigrations: number; seenByPumpPortal: number; gapBps: number };
  /** A PumpPortal migration notice (A-M03-01): verified at once, retried 3 times at 2 s, then left to the backfill. */
  onNotice(n: { mint: Pubkey; pool: Pubkey | null; signature: Signature | null; slot: Slot | null }): void;
  /** Health (Z09-21): the signature the cursor is held at, its attempts, and whether the cap was reached (critical). */
  health(): { stalledSignature: Signature | null; attempts: number; critical: boolean };
  /** Reconnect port (Z08-2, Z08-20). */
  verifiedSlot(): Slot | null;
  migrationsSeenSince(ms: UnixMs): number;
  /** Verified chain migrations of the last `windowMs` (the cross-check's mints and pools, ruling Z08-9). */
  recentMigrations(windowMs: number): Array<{ mint: Pubkey; pool: Pubkey; atMs: UnixMs }>;
  start(): void;
  stop(): void;
}


function parseCursor(s: string | null): CursorState {
  const empty = { until: null, pendingTop: null, before: null };
  if (s === null) return empty;
  try {
    const o = JSON.parse(s) as Record<string, unknown>;
    const sig = (v: unknown): Signature | null => (typeof v === 'string' && /^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(v) ? v : null);
    return { until: sig(o.until), pendingTop: sig(o.pendingTop), before: sig(o.before) };
  } catch {
    return empty;
  }
}

export function createMigrationBackfill<P extends VerifiableState>(deps: BackfillDeps<P>): MigrationBackfill<P> {
  const problem = checkBackfillConfig(deps.config);
  if (problem !== null) throw { code: 'E_CONFIG', message: problem };
  const st = deps.store;
  let running: Promise<Result<{ found: number; newestSlot: Slot }, { code: 'E_RPC' }>> | null = null;
  let stopTimer: (() => void) | null = null;
  let stopped = true;
  /** Set by `stop()` only: notice retries continue before `start()` (a notice may come first). */
  let halted = false;

  async function verifyPool(pool: Pubkey, mint: Pubkey): Promise<Result<P, { code: VerifyCode }>> {
    const fail = (code: VerifyCode): { ok: false; error: { code: VerifyCode } } => ({ ok: false, error: { code } });
    const first = await deps.reader.read([pool], { priority: 4 });
    if (!first.ok) return fail('E_RPC');
    const acct = first.value.accounts[0] ?? null;
    if (acct === null) return fail('E_NOT_FOUND');
    const addr = deps.model.addresses(pool, acct);
    if (!addr.ok) return fail(addr.error.code === 'E_NOT_SOL_QUOTED' ? 'E_NOT_SOL_QUOTED' : 'E_NOT_FOUND');
    if (addr.value.tokenMint !== mint) return fail('E_NOT_CANONICAL');
    const rest = await deps.reader.read([addr.value.baseVault, addr.value.quoteVault, addr.value.tokenMint], { priority: 4 });
    if (!rest.ok) return fail('E_RPC');
    const [baseVault, quoteVault, mintAcct] = rest.value.accounts as [RawAccount | null, RawAccount | null, RawAccount | null];
    const mintInfo = deps.model.mint(mintAcct ?? null);
    if (mintInfo === null) return fail('E_NOT_FOUND');
    const canonicalCreator = await deps.model.canonicalCreator(addr.value.tokenMint);
    const built = deps.model.build(addr.value, { pool: acct, baseVault: baseVault ?? null, quoteVault: quoteVault ?? null }, mintInfo,
      { asOfSlot: rest.value.contextSlot, observedAtMs: deps.nowMs(), canonicalCreator });
    if (!built.ok) return fail(built.error.code === 'E_NOT_SOL_QUOTED' ? 'E_NOT_SOL_QUOTED' : 'E_NOT_FOUND');
    const p = built.value;
    if (p.quoteMint !== deps.wsolMint) return fail('E_NOT_SOL_QUOTED');
    if (p.isCanonical !== true || p.baseMint !== mint) return fail('E_NOT_CANONICAL');
    return { ok: true, value: p };
  }

  function publish(m: MigrationObserved, state: P, update: boolean): void {
    const now = deps.nowMs();
    deps.publishMigration({ ...m, verifiedOnChain: true });
    deps.publishPool({
      discoveryId: deps.newId(), venue: 'pumpswap', poolId: m.pool, baseMint: m.mint, quoteMint: state.quoteMint, source: m.source === 'pumpportal' ? 'pumpportal' : 'chain_backfill',
      sourceCommitment: 'confirmed', seenAtMs: now, slot: m.slot, verifiedOnChain: true, migratedAtMs: m.migratedAtMs,
    }, state);
    deps.log.event('info', update ? 'm03.migration_time_filled' : 'm03.migration_verified', { pool: m.pool, slot: m.slot });
  }

  /**
   * Verifies and publishes one chain-sourced migration (its slot and time are the chain's). A (mint, pool) already
   * verified publishes nothing, except that a migration time it lacked is filled and re-published (Z09-13).
   */
  async function verifyAndPublish(m: MigrationObserved): Promise<'published' | 'dropped' | 'deferred' | 'rpc'> {
    const known = st.getVerified(m.mint, m.pool);
    if (known !== null) {
      if (known.migratedAtMs === null && m.migratedAtMs !== null) {
        const v = await verifyPool(m.pool, m.mint);
        if (!v.ok) return v.error.code === 'E_RPC' ? 'rpc' : 'published';
        st.putVerified({ ...known, migratedAtMs: m.migratedAtMs });
        publish({ ...m, slot: known.slot }, v.value, true);
      }
      return 'published';
    }
    const v = await verifyPool(m.pool, m.mint);
    if (!v.ok) {
      if (v.error.code === 'E_NOT_FOUND') return 'deferred';
      if (v.error.code === 'E_RPC') return 'rpc';
      deps.log.event('info', 'm03.migration_rejected', { reason: v.error.code });
      return 'dropped';
    }
    if (st.getVerified(m.mint, m.pool) !== null) return 'published';                // a concurrent notice won the race
    st.putVerified({ mint: m.mint, pool: m.pool, slot: m.slot, atMs: deps.nowMs(), migratedAtMs: m.migratedAtMs });
    publish(m, v.value, false);
    return 'published';
  }

  async function page(before: Signature | null, until: Signature | null): Promise<Result<Array<{ signature: Signature; slot: Slot; err: unknown }>, RpcError>> {
    const opts: Record<string, unknown> = { commitment: 'confirmed', limit: PAGE_LIMIT };
    if (before !== null) opts.before = before;
    if (until !== null) opts.until = until;
    const r = await deps.gateway.call<unknown>('getSignaturesForAddress', [deps.withdrawAuthority, opts], { priority: 4, role: 'read', commitment: 'confirmed', timeoutMs: 30_000 });
    if (!r.ok) return r;
    if (!Array.isArray(r.value.value)) return { ok: false, error: { code: 'E_RPC', message: 'getSignaturesForAddress: not an array' } };
    const out: Array<{ signature: Signature; slot: Slot; err: unknown }> = [];
    for (const x of r.value.value) {
      if (typeof x !== 'object' || x === null) continue;
      const o = x as Record<string, unknown>;
      if (typeof o.signature !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(o.signature)) continue;
      const slot = typeof o.slot === 'bigint' ? o.slot : typeof o.slot === 'number' && Number.isSafeInteger(o.slot) && o.slot >= 0 ? BigInt(o.slot) : null;
      if (slot === null) continue;
      out.push({ signature: o.signature, slot: slot as Slot, err: o.err ?? null });
    }
    return { ok: true, value: out };
  }

  /** Fetches and decodes one transaction: its migrations (chain slot and block time), 'skip', or a failure that stops the run. */
  async function migrationsOf(signature: Signature, source: MigrationObserved['source']): Promise<MigrationObserved[] | 'skip' | 'stall' | 'rpc'> {
    const tx = await deps.gateway.call<unknown>('getTransaction', [signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 1, encoding: 'json' }],
      { priority: 4, role: 'read', commitment: 'confirmed', timeoutMs: 30_000 });
    if (!tx.ok) {
      if (tx.error.rpcCode === RPC_VERSION_UNSUPPORTED) {
        deps.log.event('critical', 'm03.tx_version_unsupported', { signature });
        deps.log.event('warn', 'm03.backfill_stalled', { reason: 'version_unsupported', signature });
        return 'stall';
      }
      deps.log.event('warn', 'm03.backfill_tx_failed', { error_code: tx.error.code });
      return 'rpc';
    }
    if (tx.value.value === null) {
      if (source === 'chain_backfill') {
        // A capped number of runs may find it null; then a critical alert and a health flag. It is never skipped and
        // the cursor never moves past it (Z09-21, amended).
        const cur = st.stall.get();
        const attempts = cur !== null && cur.signature === signature ? cur.attempts + 1 : 1;
        st.stall.put({ signature, attempts });
        if (attempts === NULL_TX_MAX_ATTEMPTS) deps.log.event('critical', 'm03.backfill_tx_missing', { signature, attempts });
      }
      deps.log.event('warn', 'm03.backfill_stalled', { reason: 'tx_not_visible', signature });
      return 'stall';
    }
    if (source === 'chain_backfill' && st.stall.get()?.signature === signature) st.stall.put(null);
    const d = deps.decode(signature, tx.value.value);
    if (!d.ok) { deps.log.event('warn', 'm03.migration_rejected', { reason: d.error.code }); return 'skip'; }
    if (d.value.failed) return 'skip';
    if (d.value.nonSolQuote > 0) deps.log.event('info', 'm03.migration_rejected', { reason: 'E_NOT_SOL_QUOTED' });
    const at = d.value.blockTimeS === null ? null : ((d.value.blockTimeS * 1_000) as UnixMs);
    return d.value.migrations.map((e) => ({ ...e, source, verifiedOnChain: false, migratedAtMs: at }));
  }

  async function runOnce(): Promise<Result<{ found: number; newestSlot: Slot }, { code: 'E_RPC' }>> {
    const state = parseCursor(st.cursor.load());
    const firstStart = state.until === null && state.pendingTop === null;
    const collected: Array<{ signature: Signature; slot: Slot; err: unknown }> = [];
    let before = state.pendingTop === null ? null : state.before;
    let complete = false;
    for (let i = 0; i < deps.config.maxPagesPerRun; i++) {
      const r = await page(before, state.until);
      if (!r.ok) {
        deps.log.event('warn', 'm03.backfill_page_failed', { error_code: r.error.code });
        return { ok: false, error: { code: 'E_RPC' } };
      }
      collected.push(...r.value);
      const last = r.value.at(-1);
      // Z09-12: only reaching `until` (a short page) or the first start's single page completes the run.
      if (r.value.length < PAGE_LIMIT || last === undefined || firstStart) { complete = true; break; }
      before = last.signature;
    }
    let found = 0;
    // Pools that were not visible on an earlier run (kept in the store, so they survive the cursor moving on and a restart).
    for (const d of st.deferred.list()) {
      const out = await verifyAndPublish(d.m);
      if (out === 'rpc') return { ok: false, error: { code: 'E_RPC' } };
      if (out === 'deferred' && d.runsLeft > 1) { st.deferred.put(d.m, d.runsLeft - 1); continue; }
      st.deferred.remove(d.m);
      if (out === 'deferred') deps.log.event('info', 'm03.migration_rejected', { reason: 'not_found' });
      if (out === 'published') found += 1;
    }
    for (const s of [...collected].reverse()) {
      if (s.err !== null) continue;                                             // failed transactions are common [EX-04]
      const ms = await migrationsOf(s.signature, 'chain_backfill');
      if (ms === 'rpc' || ms === 'stall') return { ok: false, error: { code: 'E_RPC' } };
      if (ms === 'skip') continue;
      for (const m of ms) {
        const known = st.getVerified(m.mint, m.pool);
        if (known !== null && (known.migratedAtMs !== null || m.migratedAtMs === null)) continue;
        if (known === null) deps.record(m);
        const out = await verifyAndPublish(m);
        if (out === 'rpc') return { ok: false, error: { code: 'E_RPC' } };
        if (out === 'deferred') st.deferred.put(m, DEFERRED_RUNS);
        if (out === 'published' && known === null) found += 1;
      }
    }
    const newest = collected[0]?.signature ?? null;
    const top = state.pendingTop ?? newest;
    const next: CursorState = complete
      ? { until: top ?? state.until, pendingTop: null, before: null }
      : { until: state.until, pendingTop: top, before: collected.at(-1)?.signature ?? state.before };
    st.cursor.save(JSON.stringify(next));
    st.prune(deps.nowMs() - KEEP_MS);
    const gap = coverage(COVERAGE_WINDOW_MS);
    if (gap.gapBps > D12_GAP_BPS) deps.log.event('warn', 'm03.d12_switch_condition', { gap_bps: gap.gapBps, chain_migrations: gap.chainMigrations });
    return { ok: true, value: { found, newestSlot: (collected[0]?.slot ?? st.newestVerifiedSlot() ?? 0n) as Slot } };
  }

  function coverage(windowMs: number): { chainMigrations: number; seenByPumpPortal: number; gapBps: number } {
    const all = st.verifiedSince(deps.nowMs() - windowMs);
    const both = all.filter((v) => st.seenByPumpPortal(v.mint, v.pool)).length;
    const chain = all.length;
    return { chainMigrations: chain, seenByPumpPortal: both, gapBps: chain === 0 ? 0 : Math.floor((10_000 * (chain - both)) / chain) };
  }

  function schedule(): void {
    if (stopped) return;
    stopTimer = deps.scheduler.set(() => { void api.backfillSince(null).finally(schedule); }, deps.config.intervalMs);
  }

  const api: MigrationBackfill<P> = {
    // Z09-12: `fromSlot` (PumpPortal's reconnect hint) never completes a run or moves the cursor; the run pages to `until`.
    backfillSince(_fromSlot) {
      if (running !== null) return running;                                     // one run at a time: a second trigger is a no-op
      running = runOnce().catch((e: unknown) => {
        deps.log.event('error', 'm03.backfill_error', { error_code: String((e as { code?: unknown }).code ?? 'unknown') });
        return { ok: false as const, error: { code: 'E_RPC' as const } };
      }).finally(() => { running = null; });
      return running;
    },
    verifyPool,
    coverage,
    onNotice(n) {
      if (n.pool === null) return;
      st.markPumpPortal(n.mint, n.pool, deps.nowMs());
      if (n.signature === null) return;                                         // the backfill will find it
      const signature = n.signature;
      let tries = 0;
      const attempt = (): void => {
        tries += 1;
        void (async (): Promise<'done' | 'retry'> => {
          // Z09-13: the notice names a transaction; the migration, its slot and its time are read from the chain.
          const ms = await migrationsOf(signature, 'pumpportal');
          if (ms === 'rpc' || ms === 'stall') return 'retry';
          if (ms === 'skip') return 'done';
          const m = ms.find((x) => x.mint === n.mint && x.pool === n.pool);
          if (m === undefined) { deps.log.event('info', 'm03.migration_rejected', { reason: 'notice_not_on_chain' }); return 'done'; }
          const out = await verifyAndPublish(m);
          return out === 'deferred' || out === 'rpc' ? 'retry' : 'done';
        })().then((r) => {
          if (r === 'retry' && tries < NOTICE_RETRIES && !halted) deps.scheduler.set(attempt, NOTICE_RETRY_MS);
        });
      };
      attempt();
    },
    health: () => {
      const v = st.stall.get();
      return { stalledSignature: v?.signature ?? null, attempts: v?.attempts ?? 0, critical: (v?.attempts ?? 0) >= NULL_TX_MAX_ATTEMPTS };
    },
    verifiedSlot: () => st.newestVerifiedSlot(),
    migrationsSeenSince: (ms) => st.verifiedSince(ms).length,
    recentMigrations: (windowMs) => st.verifiedSince(deps.nowMs() - windowMs).map((v) => ({ mint: v.mint, pool: v.pool, atMs: timeOf(v) as UnixMs })),
    start() {
      if (!stopped) return;
      stopped = false;
      halted = false;
      void api.backfillSince(null).finally(schedule);
    },
    stop() {
      stopped = true;
      halted = true;
      stopTimer?.();
      stopTimer = null;
    },
  };
  return api;
}

const keyOf = (mint: string, pool: string): string => `${mint}|${pool}`;
/** A migration's time: its block time, else when it was verified. */
export const timeOf = (v: VerifiedMigration): number => v.migratedAtMs ?? v.atMs;
const deferredKey = (m: MigrationObserved): string => `${m.signature}|${m.mint}`;

/** An in-memory BackfillStore (tests, and research runs with no database). */
export function memoryBackfillStore(): BackfillStore & { cursorValue: string | null } {
  const verified = new Map<string, VerifiedMigration>();
  const pp = new Map<string, number>();
  const deferred = new Map<string, { m: MigrationObserved; runsLeft: number }>();
  let stall: { signature: Signature; attempts: number } | null = null;
  const s = {
    stall: { get: () => stall, put: (v: { signature: Signature; attempts: number } | null) => { stall = v; } },
    cursorValue: null as string | null,
    cursor: { load: () => s.cursorValue, save: (c: string) => { s.cursorValue = c; } },
    getVerified: (mint: Pubkey, pool: Pubkey) => verified.get(keyOf(mint, pool)) ?? null,
    putVerified: (v: VerifiedMigration) => { verified.set(keyOf(v.mint, v.pool), v); },
    verifiedSince: (fromMs: number) => [...verified.values()].filter((v) => timeOf(v) >= fromMs),
    newestVerifiedSlot: () => [...verified.values()].reduce<Slot | null>((a, v) => (a === null || v.slot > a ? v.slot : a), null),
    markPumpPortal: (mint: Pubkey, pool: Pubkey, atMs: UnixMs) => { pp.set(keyOf(mint, pool), atMs); },
    seenByPumpPortal: (mint: Pubkey, pool: Pubkey) => pp.has(keyOf(mint, pool)),
    deferred: {
      list: () => [...deferred.values()].map((d) => ({ ...d })),
      put: (m: MigrationObserved, runsLeft: number) => { deferred.set(deferredKey(m), { m, runsLeft }); while (deferred.size > DEFERRED_MAX) deferred.delete(deferred.keys().next().value as string); },
      remove: (m: MigrationObserved) => { deferred.delete(deferredKey(m)); },
    },
    prune: (beforeMs: number) => {
      for (const [k, v] of verified) if (timeOf(v) < beforeMs) verified.delete(k);
      for (const [k, v] of pp) if (v < beforeMs) pp.delete(k);
    },
  };
  return s;
}
