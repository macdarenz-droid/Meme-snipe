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
const SEEN_MAX = 200_000;
const RPC_VERSION_UNSUPPORTED = -32_015;

export function checkBackfillConfig(c: BackfillConfig): string | null {
  if (!Number.isInteger(c.intervalMs) || c.intervalMs < 15_000 || c.intervalMs > 600_000) return 'discovery.backfill.interval_ms must be 15,000-600,000';
  if (!Number.isInteger(c.maxPagesPerRun) || c.maxPagesPerRun < 1 || c.maxPagesPerRun > 100) return 'discovery.backfill.max_pages_per_run must be 1-100';
  return null;
}

interface CursorState { until: Signature | null; pendingTop: Signature | null; before: Signature | null }
export interface CursorStore { load(): string | null; save(cursor: string): void }

export interface BackfillDeps<P extends VerifiableState> {
  config: BackfillConfig;
  gateway: Pick<RpcGateway, 'call'>;
  reader: AccountsReader;
  model: PoolModelPort<P>;
  decode: DecodeMigrations;
  withdrawAuthority: Pubkey;
  wsolMint: Pubkey;
  cursor: CursorStore;
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
  /** Reconnect port (Z08-2, Z08-20). */
  verifiedSlot(): Slot | null;
  migrationsSeenSince(ms: UnixMs): number;
  /** Verified chain migrations of the last `windowMs` (the cross-check's mints and pools, ruling Z08-9). */
  recentMigrations(windowMs: number): Array<{ mint: Pubkey; pool: Pubkey; atMs: UnixMs }>;
  start(): void;
  stop(): void;
}

const keyOf = (signature: string, mint: string): string => `${signature}\u0000${mint}`;
const poolKey = (mint: string, pool: string): string => `${mint}\u0000${pool}`;

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
  const seen = new Map<string, true>();                 // (signature, mint) of migrations already published
  const verified = new Map<string, { atMs: number; slot: Slot; mint: Pubkey; pool: Pubkey }>();   // (mint, pool) → verified at
  const ppSeen = new Map<string, number>();              // (mint, pool) → PumpPortal notice time
  const deferred = new Map<string, { m: MigrationObserved; runsLeft: number }>();
  let newestVerified: Slot | null = null;
  let running: Promise<Result<{ found: number; newestSlot: Slot }, { code: 'E_RPC' }>> | null = null;
  let stopTimer: (() => void) | null = null;
  let stopped = true;
  /** Set by `stop()` only: notice retries continue before `start()` (a notice may come first). */
  let halted = false;

  const bounded = <K, V>(m: Map<K, V>, max: number): void => { while (m.size > max) m.delete(m.keys().next().value as K); };

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

  /** Verifies and publishes one migration; returns 'deferred' when the pool is not visible yet. */
  async function verifyAndPublish(m: MigrationObserved): Promise<'published' | 'dropped' | 'deferred' | 'rpc'> {
    const k = keyOf(m.signature, m.mint);
    if (seen.has(k)) return 'published';
    const v = await verifyPool(m.pool, m.mint);
    if (!v.ok) {
      if (v.error.code === 'E_NOT_FOUND') return 'deferred';
      if (v.error.code === 'E_RPC') return 'rpc';
      deps.log.event('info', 'm03.migration_rejected', { reason: v.error.code });
      return 'dropped';
    }
    if (seen.has(k)) return 'published';                                    // a concurrent notice won the race
    seen.set(k, true);
    bounded(seen, SEEN_MAX);
    const now = deps.nowMs();
    const pm = poolKey(m.mint, m.pool);
    // The first sighting of a (mint, pool) publishes; another signature for the same pool (a notice and the chain)
    // is the same migration and publishes nothing more.
    if (!verified.has(pm)) {
      verified.set(pm, { atMs: m.migratedAtMs ?? now, slot: m.slot, mint: m.mint, pool: m.pool });
      bounded(verified, SEEN_MAX);
      if (newestVerified === null || m.slot > newestVerified) newestVerified = m.slot;
      const out = { ...m, verifiedOnChain: true };
      deps.publishMigration(out);
      deps.publishPool({
        discoveryId: deps.newId(), venue: 'pumpswap', poolId: m.pool, baseMint: m.mint, quoteMint: v.value.quoteMint, source: m.source === 'pumpportal' ? 'pumpportal' : 'chain_backfill',
        sourceCommitment: 'confirmed', seenAtMs: now, slot: m.slot, verifiedOnChain: true, migratedAtMs: m.migratedAtMs,
      }, v.value);
      deps.log.event('info', 'm03.migration_verified', { pool: m.pool, slot: m.slot });
    }
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

  async function runOnce(fromSlot: Slot | null): Promise<Result<{ found: number; newestSlot: Slot }, { code: 'E_RPC' }>> {
    const state = parseCursor(deps.cursor.load());
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
      const pastFrom = fromSlot !== null && last !== undefined && last.slot < fromSlot;
      if (r.value.length < PAGE_LIMIT || last === undefined || pastFrom || firstStart) { complete = true; break; }
      before = last.signature;
    }
    // Retry the pools that were not visible on an earlier run, then the new signatures, oldest first.
    let found = 0;
    for (const [k, d] of [...deferred]) {
      const out = await verifyAndPublish(d.m);
      if (out === 'rpc') return { ok: false, error: { code: 'E_RPC' } };
      if (out === 'deferred' && d.runsLeft > 1) { d.runsLeft -= 1; continue; }
      deferred.delete(k);
      if (out === 'deferred') deps.log.event('info', 'm03.migration_rejected', { reason: 'not_found' });
      if (out === 'published') found += 1;
    }
    for (const s of [...collected].reverse()) {
      if (s.err !== null) continue;                                             // failed transactions are common [EX-04]
      const tx = await deps.gateway.call<unknown>('getTransaction', [s.signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 1, encoding: 'json' }],
        { priority: 4, role: 'read', commitment: 'confirmed', timeoutMs: 30_000 });
      if (!tx.ok) {
        if (tx.error.rpcCode === RPC_VERSION_UNSUPPORTED) deps.log.event('critical', 'm03.tx_version_unsupported', { signature: s.signature });
        else deps.log.event('warn', 'm03.backfill_tx_failed', { error_code: tx.error.code });
        return { ok: false, error: { code: 'E_RPC' } };
      }
      if (tx.value.value === null) return { ok: false, error: { code: 'E_RPC' } };   // not visible at confirmed yet
      const d = deps.decode(s.signature, tx.value.value);
      if (!d.ok) { deps.log.event('warn', 'm03.migration_rejected', { reason: d.error.code }); continue; }
      if (d.value.failed) continue;
      if (d.value.nonSolQuote > 0) deps.log.event('info', 'm03.migration_rejected', { reason: 'E_NOT_SOL_QUOTED' });
      for (const e of d.value.migrations) {
        const m: MigrationObserved = { ...e, source: 'chain_backfill', verifiedOnChain: false, migratedAtMs: d.value.blockTimeS === null ? null : ((d.value.blockTimeS * 1_000) as UnixMs) };
        if (seen.has(keyOf(m.signature, m.mint))) continue;
        deps.record(m);
        const out = await verifyAndPublish(m);
        if (out === 'rpc') return { ok: false, error: { code: 'E_RPC' } };
        if (out === 'deferred') {
          deferred.set(keyOf(m.signature, m.mint), { m, runsLeft: DEFERRED_RUNS });
          bounded(deferred, DEFERRED_MAX);
        }
        if (out === 'published') found += 1;
      }
    }
    const newest = collected[0]?.signature ?? null;
    const top = state.pendingTop ?? newest;
    const next: CursorState = complete
      ? { until: top ?? state.until, pendingTop: null, before: null }
      : { until: state.until, pendingTop: top, before: collected.at(-1)?.signature ?? state.before };
    deps.cursor.save(JSON.stringify(next));
    const gap = coverage(COVERAGE_WINDOW_MS);
    if (gap.gapBps > D12_GAP_BPS) deps.log.event('warn', 'm03.d12_switch_condition', { gap_bps: gap.gapBps, chain_migrations: gap.chainMigrations });
    return { ok: true, value: { found, newestSlot: (collected[0]?.slot ?? newestVerified ?? 0n) as Slot } };
  }

  function coverage(windowMs: number): { chainMigrations: number; seenByPumpPortal: number; gapBps: number } {
    const from = deps.nowMs() - windowMs;
    let chain = 0, both = 0;
    for (const [k, v] of verified) {
      if (v.atMs < from) continue;
      chain += 1;
      if (ppSeen.has(k)) both += 1;
    }
    return { chainMigrations: chain, seenByPumpPortal: both, gapBps: chain === 0 ? 0 : Math.floor((10_000 * (chain - both)) / chain) };
  }

  function schedule(): void {
    if (stopped) return;
    stopTimer = deps.scheduler.set(() => { void api.backfillSince(null).finally(schedule); }, deps.config.intervalMs);
  }

  const api: MigrationBackfill<P> = {
    backfillSince(fromSlot) {
      if (running !== null) return running;                                     // one run at a time: a second trigger is a no-op
      running = runOnce(fromSlot).catch((e: unknown) => {
        deps.log.event('error', 'm03.backfill_error', { error_code: String((e as { code?: unknown }).code ?? 'unknown') });
        return { ok: false as const, error: { code: 'E_RPC' as const } };
      }).finally(() => { running = null; });
      return running;
    },
    verifyPool,
    coverage,
    onNotice(n) {
      if (n.pool === null) return;
      ppSeen.set(poolKey(n.mint, n.pool), deps.nowMs());
      bounded(ppSeen, SEEN_MAX);
      if (n.signature === null || n.slot === null) return;                       // the backfill will find it
      const m: MigrationObserved = { mint: n.mint, pool: n.pool, signature: n.signature, slot: n.slot, source: 'pumpportal', verifiedOnChain: false, migratedAtMs: null };
      let tries = 0;
      const attempt = (): void => {
        tries += 1;
        void verifyAndPublish(m).then((out) => {
          if ((out === 'deferred' || out === 'rpc') && tries < NOTICE_RETRIES && !halted) deps.scheduler.set(attempt, NOTICE_RETRY_MS);
        });
      };
      attempt();
    },
    verifiedSlot: () => newestVerified,
    migrationsSeenSince(ms) {
      let n = 0;
      for (const v of verified.values()) if (v.atMs >= ms) n += 1;
      return n;
    },
    recentMigrations(windowMs) {
      const from = deps.nowMs() - windowMs;
      return [...verified.values()].filter((v) => v.atMs >= from).map((v) => ({ mint: v.mint, pool: v.pool, atMs: v.atMs as UnixMs }));
    },
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
