// M04 pool state tracker: public types and ports (A-M04-01..03; ARCH M04, clarification C-06). M04 is generic over the
// pool state `P`: decoding, normalisation, fees and the compact record layout come in through `PoolModelPort`, which
// `@bot/venue` implements for PumpSwap (`createPumpSwapPoolModel`), so venue layouts stay in M01/M02.
import type { Commitment, DecimalStr, Lamports, Pubkey, Result, Slot, UnixMs } from '@bot/types';

export type PoolClass = 'position' | 'candidate' | 'tail';
export interface RawAccount { owner: Pubkey; data: Uint8Array }

/** The fields of a pool state M04 reads itself. */
export interface PoolStateLike { poolId: Pubkey; asOfSlot: Slot; commitment: Commitment; observedAtMs: UnixMs }
export interface PoolAddresses { poolId: Pubkey; baseVault: Pubkey; quoteVault: Pubkey; tokenMint: Pubkey }
export interface MintInfo { supply: bigint; decimals: number }
export type PoolReadErrorCode = 'E_CLOSED' | 'E_OWNER_CHANGED' | 'E_PARTIAL' | 'E_NEGATIVE_EFFECTIVE' | 'E_LAYOUT' | 'E_NOT_SOL_QUOTED';

/** `@bot/venue` `PoolModel`, structurally, plus the canonical-creator PDA and the recorder fields. */
export interface PoolModelPort<P extends PoolStateLike> {
  addresses(poolId: Pubkey, pool: RawAccount | null): Result<PoolAddresses, { code: PoolReadErrorCode; detail: string }>;
  mint(raw: RawAccount | null): MintInfo | null;
  build(addr: PoolAddresses, accounts: { pool: RawAccount | null; baseVault: RawAccount | null; quoteVault: RawAccount | null }, mint: MintInfo,
    ctx: { asOfSlot: Slot; observedAtMs: UnixMs; canonicalCreator: Pubkey | null }): Result<P, { code: PoolReadErrorCode; detail: string }>;
  effectiveQuote(p: P): Lamports;
  spot(p: P): DecimalStr | null;
  feeTotalBps(p: P): number | null;
  /** The record layout of the ring buffer: `recordBytes` per state. */
  recordBytes: number;
  encode(p: P, out: Uint8Array, at: number): void;
  decode(addr: PoolAddresses, buf: Uint8Array, at: number): P;
  /** `pumpPoolAuthorityPda(tokenMint)` (A-M01-01; asynchronous). */
  canonicalCreator(tokenMint: Pubkey): Promise<Pubkey>;
  /** The pool's fields as written to M07 (`pool_snapshot*` payload `fields`): JSON values, big integers as strings. */
  recordFields(p: P): Record<string, string | number | boolean | null>;
}

/**
 * ARCH M04 `PoolSnapshot`, with `rawHash` (C-06). `spotSolPerToken` is null when the base decimals are unknown (never a
 * guessed price); `feeTotalBps` is 10,000 when the fee is unknown (C-08: it fails every fee ceiling).
 */
export interface PoolSnapshot<P extends PoolStateLike> {
  pool: P; effectiveQuoteLamports: Lamports; spotSolPerToken: DecimalStr | null; feeTotalBps: number;
  providerLabel: string; providerSlot: Slot; readLatencyMs: number; observationLagSlots: number; rawHash: string;
}

/** One batched read at `confirmed` (`getMultipleAccounts`, base64) through M14. */
export interface ReadResult { contextSlot: Slot; providerLabel: string; latencyMs: number; accounts: Array<RawAccount | null> }
export interface AccountsReader {
  read(keys: readonly Pubkey[], o: { priority: 0 | 1 | 2 | 3 | 4; provider?: string }): Promise<Result<ReadResult, { code: string; message: string }>>;
}

/**
 * M15 (B-M15-01): the highest slot seen from any provider, the measured slot time (bug B1), and the slot clock's
 * estimate of the slot at a time (`timeToSlot(nowMs, slotTimeBasis())`, from the primary provider's reading and the
 * measured slot time, Z06). The estimate bounds what a provider may claim: one provider's future slot cannot poison it,
 * whereas the highest slot seen takes every provider's word (#325 red team, MAJOR-1).
 */
export interface ChainStatePort { highestSeenSlot(): Slot; slotDurationMsEstimate(): number; expectedSlot(nowMs: number): Slot }

/** Timers on the monotonic clock (M14 `Scheduler`). */
export interface SchedulerPort { nowMs(): number; set(fn: () => void, ms: number): () => void }

export type ClosedReason = 'closed' | 'owner_changed';
/** What M04 publishes (topics `pool.snapshot`, `pool.closed`, `pool.stale`, `pool.fresh`) and tells M01, M07 and M14. */
export interface TrackerOutputs<P extends PoolStateLike> {
  snapshot(s: PoolSnapshot<P>, cls: PoolClass): void;
  closed(e: { poolId: Pubkey; reason: ClosedReason }): void;
  stale(e: { poolId: Pubkey; lagSlots: number; sinceMs: UnixMs }): void;
  fresh(e: { poolId: Pubkey }): void;
  /** M01 `OrientationGuard.quarantine` (`venue.pool_quarantined`). */
  quarantine(poolId: Pubkey, reason: 'owner_changed' | 'negative_effective'): void;
  /** M14 health: a provider answered too far behind (ARCH M04 failure table, 8.5). */
  providerLagging(providerLabel: string, lagSlots: number): void;
  /** M07 `Recorder.unwatch` for every pool M04 stops watching (Z04 review, rulings 1 and 14). */
  unwatched(poolId: Pubkey): void;
}

export interface TrackerLog { event(level: 'info' | 'warn' | 'error' | 'critical', code: string, fields: Readonly<Record<string, unknown>>): void }
export interface TrackerMetrics {
  counter(name: 'poll_skipped_total' | 'partial_read_total' | 'snapshot_out_of_order_total' | 'fresh_read_stale_total' | 'snapshot_future_slot_total' | 'watch_refused_total', labels: Readonly<Record<string, string>>): void;
  observe(name: 'observation_lag_slots' | 'poll_batch_latency_ms' | 'fresh_read_latency_ms' | 'exit_read_lag_slots', labels: Readonly<Record<string, string>>, value: number): void;
  gauge(name: 'pool_snapshot_age_ms' | 'pool_source_kind', labels: Readonly<Record<string, string>>, value: number): void;
}
