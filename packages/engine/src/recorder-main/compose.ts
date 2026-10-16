// The recorder's composition root (card Z10; docs/MIGRATION.md "Z10 Recorder on the server"). It wires the keyless M1
// recorder: M14 reads (Shyft primary, Chainstack backup; read roles only), the M15 slot clock with a two-provider
// anchor (chain.ts, C-84), M01's fee-config cache, M04's pool tracker, M03's migration backfill, M05's universe and
// watchlist, M07's queue, segment writer, disk manager and watch log, M08's bars and the SOL/USD and venue-config
// records. Nothing here signs, builds or sends a transaction, and no strategy is enabled.
//
// The same function runs live (main.ts: real clock, timers, fetch and folders) and in the soak (scripts/soak.ts: a
// virtual clock and a fake RPC). The order at start is fixed by the Z09 obligations:
//   1. M07 recovery first (`SegmentWriter.recover`), and the queue's `firstSeq` for every stream from its `nextSeq`
//      (Z09-47: never from the last sealed manifest);
//   2. `markProcessStart` before M04 polls (Z09-49);
//   3. M04 starts only once two providers agreed on a slot-clock anchor (C-84, Z07-29).
// Each second: M07 `tick(now)`, the writer's `pump()` (which hands every written `poll_counts` record to M08 with its
// recvMs), then M08 `closeDue(now)`, all with the same `now` (Z09-32).
import { createPublicKey, type KeyObject } from 'node:crypto';
import { statfsSync } from 'node:fs';
import { base58, createDecoders, decodeEventsWithGaps, readRpcTransaction, verifyPinnedIdls, VENDORED_IDL_DIR } from '@bot/decoders';
import type { Clock, Config, Pubkey, Result, Slot, UnixMs } from '@bot/types';
import { createPumpSwapPoolModel, createVenueConfigCache, type CpPoolState, type VenueConfigCache } from '@bot/venue';
import { ACCOUNTS, MINTS, PROGRAMS, REFERENCE } from '@bot/venue/constants';
import { createMigrationBackfill, BACKFILL_DEFAULTS, type MigrationBackfill, type MigrationObserved, type PoolDiscovered } from '../m03/backfill.ts';
import { m24BackfillStore } from '../m03/backfill-store.ts';
import { migrationDecoder } from '../m03/decode-migrations.ts';
import { createPoolTracker, type PoolTracker } from '../m04/tracker.ts';
import { M04_DEFAULTS } from '../m04/settings.ts';
import type { AccountsReader, PoolSnapshot, RawAccount } from '../m04/types.ts';
import { m24CandidateStore } from '../m05/store.ts';
import { createUniverse, LIMIT_SETS, UNIVERSE_DEFAULTS, type PrefilterFacts, type Universe, type LimitSetId } from '../m05/universe.ts';
import { createWatchlist, WATCHLIST_DEFAULTS, type Watchlist } from '../m05/watchlist.ts';
import { DEFAULT_DISK_POLICY, DiskManager } from '../m07/disk.ts';
import { linkTrackerToRecorder } from '../m07/m04-link.ts';
import type { Codec } from '../m07/manifest.ts';
import { SegmentWriter } from '../m07/segments.ts';
import { createSolUsdReader } from '../m07/sol-usd.ts';
import { recordVenueConfig, type VenueConfigRecorder } from '../m07/venue-config.ts';
import { WatchLog } from '../m07/watch-log.ts';
import { barSnapshotOf, BAR_DEFAULTS, createBarEngine, type BarEngine, type PollCountsIn } from '../m08/bars.ts';
import { createBarStore, type BarStore } from '../m08/bar-store.ts';
import type { FetchLike, Scheduler, SecretSource } from '../m14/types.ts';
import { m14Settings } from '../m14/settings.ts';
import { m15Settings } from '../m15/settings.ts';
import { openDb, type Db } from '../m24/db.ts';
import { prepareDatabase } from '../m24/migrate.ts';
import { createRepos, metricRollupSink } from '../m24/repos.ts';
import { bootstrapConfig, type ConfigService } from '../m25/bootstrap.ts';
import type { StatFn } from '../m25/files.ts';
import { configValue } from '../m25/registry.ts';
import { createLogger, type Logger, type LogSink } from '../m27/log.ts';
import { MetricsRegistry } from '../m27/metrics.ts';
import { m27Settings } from '../m27/settings.ts';
import { RecorderQueue, type EncodedRecord } from '../recorder/queue.ts';
import { createAgreedChainState, ANCHOR_EVERY_MS, type AgreedChainState } from './chain.ts';
import { m07Log, RECORDER_LOG_TABLE } from './log-codes.ts';
import { createReadPath, type ReadPath } from './rpc.ts';
import { kvEvictionLog, type EvictionLog } from './evictions.ts';
import { ulid } from './ids.ts';

/** Where the recorder writes (ENGINE_PATHS on the host; a scratch folder in the smoke trial and the soak). */
export interface RecorderPaths {
  db: string; preMigrationBackup: string; initMarker: string; logDir: string; usageDb: string; mdDir: string; receiptsDir: string;
  ceilings: string; config: string;
}

export interface RecorderPorts {
  paths: RecorderPaths;
  secrets: SecretSource;
  fetch: FetchLike;
  /** Wall clock (record times, UTC hours and days). */
  clock: Clock;
  /** Monotonic timers (M14 pacing, M04 polls, the 1 s loop). */
  scheduler: Scheduler;
  /** The release (commit) running: the `process_start` marker and `/health`. */
  releaseId: string;
  euid: number;
  /** Creates the database when missing (first start with the init marker, the smoke trial and tests). */
  createDb: boolean;
  logSink: LogSink;
  readFile: (path: string) => string;
  /** M25's file trust check (tests: a root-owned fake; production: lstat). */
  stat?: StatFn;
  /** Total and free bytes of the filesystem holding `mdDir` (production: statfs). */
  diskUsage?: () => { totalBytes: number; freeBytes: number };
  /** The research public key, or null when absent (no segment is then ever deleted: fail closed, Q8). */
  researchKey?: () => KeyObject | null;
  /** Ids (candidates, discoveries); deterministic in the soak. */
  newId?: () => string;
}

export type StartRefusal = { code: 'E_START_REFUSED'; reason: string; message: string };

export interface RecorderStatus {
  releaseId: string; startedAtMs: UnixMs; anchored: boolean; anchor: { slot: string; providers: readonly string[] } | null;
  mode: string; providers: readonly string[]; watched: number; halted: string | null; queueDepth: number; lastTickMs: UnixMs | null;
}

export interface RunningRecorder {
  status(): RecorderStatus;
  stop(): Promise<void>;
  /** Internals for tests and the soak: never used by main.ts. */
  readonly parts: {
    db: Db; config: ConfigService; log: Logger; metrics: MetricsRegistry; read: ReadPath; chain: AgreedChainState; queue: RecorderQueue;
    writer: SegmentWriter; disk: DiskManager; tracker: PoolTracker<CpPoolState>; universe: Universe; watchlist: Watchlist; bars: BarEngine;
    barStore: BarStore; backfill: MigrationBackfill<CpPoolState>; venue: VenueConfigCache; venueRecorder: VenueConfigRecorder; evictions: EvictionLog;
    tickOnce(): Promise<void>;
  };
}

const WATCHLIST_EVERY_MS = 10_000;
const FLUSH_BAR_STORE_MS = 60_000;

/** M04 at the port M03 and M01 read through: one `getMultipleAccounts` at `confirmed` through M14. */
function accountsReader(read: ReadPath, timeoutMs: number): AccountsReader {
  return {
    async read(keys, o) {
      const r = await read.gateway.call<unknown>('getMultipleAccounts', [keys, { encoding: 'base64' }], {
        priority: o.priority, role: 'read', commitment: 'confirmed', timeoutMs, ...(o.provider === undefined ? {} : { provider: o.provider }),
      });
      if (!r.ok) return { ok: false, error: { code: r.error.code, message: r.error.message } };
      const accounts = parseAccounts(r.value.value, keys.length);
      if (accounts === null || r.value.contextSlot === null) return { ok: false, error: { code: 'E_RPC', message: 'getMultipleAccounts: unexpected result' } };
      return { ok: true, value: { contextSlot: r.value.contextSlot, providerLabel: r.value.providerLabel, latencyMs: r.value.latencyMs, accounts } };
    },
  };
}

/** `getMultipleAccounts` result `value`: one entry per key, null or `{ owner, data: [base64, 'base64'] }`. */
export function parseAccounts(v: unknown, n: number): Array<RawAccount | null> | null {
  const list = (v as { value?: unknown } | null)?.value ?? v;
  if (!Array.isArray(list) || list.length !== n) return null;
  const out: Array<RawAccount | null> = [];
  for (const a of list) {
    if (a === null) { out.push(null); continue; }
    const owner = (a as { owner?: unknown }).owner;
    const data = (a as { data?: unknown }).data;
    if (typeof owner !== 'string' || !Array.isArray(data) || data[1] !== 'base64' || typeof data[0] !== 'string') return null;
    out.push({ owner: owner as Pubkey, data: new Uint8Array(Buffer.from(data[0], 'base64')) });
  }
  return out;
}

/** A `poll_counts` record taken by the writer, as M08 reads it (its recvMs is when it was in hand). */
export function pollCountsOf(r: EncodedRecord): PollCountsIn | null {
  if (r.stream !== 'poll_counts') return null;
  const p = JSON.parse(r.payloadJson) as { poolId?: unknown; barStartMs?: unknown; durationMs?: unknown; successfulPolls?: unknown; skippedBars?: unknown };
  if (typeof p.poolId !== 'string' || typeof p.barStartMs !== 'number' || typeof p.successfulPolls !== 'number') return null;
  return {
    poolId: p.poolId as Pubkey, barStartMs: p.barStartMs as UnixMs, durationMs: Number(p.durationMs), successfulPolls: p.successfulPolls,
    ...(typeof p.skippedBars === 'number' ? { skippedBars: p.skippedBars } : {}), receivedAtMs: r.recvMs,
  };
}

const refuse = (log: Logger | null, reason: string, message: string): { ok: false; error: StartRefusal } => {
  log?.event('critical', 'recorder.start_refused', { reason, message });
  return { ok: false, error: { code: 'E_START_REFUSED', reason, message } };
};

export async function createRecorder(p: RecorderPorts): Promise<Result<RunningRecorder, StartRefusal>> {
  const clock = p.clock;
  const nowMs = (): UnixMs => clock.nowMs();
  const newId = p.newId ?? ((): string => ulid(nowMs()));

  // ---- M24, M25, M27: the database, the active config, the logger and metrics. ----
  const bootLog = createLogger({ clock, codes: RECORDER_LOG_TABLE, sink: p.logSink, runId: p.releaseId, mode: 'paper' });
  let db: Db;
  try {
    db = openDb({ path: p.paths.db, clock, log: bootLog, ...(p.createDb ? { create: true } : { initMarker: p.paths.initMarker }) });
  } catch (e) {
    return refuse(bootLog, 'database', String((e as { code?: unknown }).code ?? 'E_DATABASE'));
  }
  const prepared = await prepareDatabase(db, { clock, backupPath: p.paths.preMigrationBackup, log: bootLog });
  if (!prepared.ok) { db.close(); return refuse(bootLog, 'migration', prepared.error.code); }
  const repos = createRepos();
  const boot = bootstrapConfig({ db, repo: repos.config_version, clock, euid: p.euid, ceilingsPath: p.paths.ceilings, configPath: p.paths.config, readFile: p.readFile, log: bootLog, ...(p.stat === undefined ? {} : { stat: p.stat }) });
  if (!boot.ok) { db.close(); return refuse(bootLog, boot.error.reason, boot.error.message); }
  const config = boot.value;
  const cfg: Config = config.current();
  const m27 = m27Settings(cfg);
  const log = bootLog;
  const metrics = new MetricsRegistry({ clock, seriesCap: m27.seriesCap, ringBudgetBytes: m27.ringBudgetBytes, sink: metricRollupSink(db, repos.metric_rollup_1m, clock, { maxBytes: m27.rollupMaxBytes, log }), log });

  // ---- M14 and M15. ----
  let allocationRaw: unknown;
  try {
    allocationRaw = JSON.parse(p.readFile(configValue(cfg, 'rpc.allocation_file')));
  } catch {
    db.close();
    return refuse(log, 'allocation', 'rpc.allocation_file is missing or not JSON');
  }
  const allocation = allocationRaw as { shares?: unknown; credits?: unknown };
  const read = createReadPath({
    db, settings: m14Settings(cfg), slot: m15Settings(cfg), secrets: p.secrets, fetch: p.fetch, clock, scheduler: p.scheduler, log, metrics,
    allocation: { consumer: 'engine', shares: (allocation.shares ?? {}) as Record<string, Record<string, number>> }, credits: { credits: allocation.credits ?? {} },
    usageDbPath: p.paths.usageDb,
  });
  if (!read.ok) { db.close(); return refuse(log, read.error.code, read.error.message); }
  const rp = read.value;
  const settings = { ...M04_DEFAULTS };
  const chain = createAgreedChainState({
    clock: rp.clock, providers: rp.labels, maxProviderLagSlots: settings.maxProviderLagSlots, initialSlotMs: m15Settings(cfg).slotMsInitial, nowMs, log,
  });

  // ---- M01: the decoders, the fee-config cache and the PumpSwap pool model. ----
  const idls = verifyPinnedIdls(VENDORED_IDL_DIR);
  if (!idls.ok) { db.close(); return refuse(log, 'idl', 'the pinned IDLs do not verify'); }
  const decoders = createDecoders(idls.value, { tokenPrograms: { splToken: PROGRAMS.splToken, token2022: PROGRAMS.token2022 } });
  const reader = accountsReader(rp, settings.readTimeoutMs);
  const venue = createVenueConfigCache({
    reader: { read: (keys) => reader.read(keys, { priority: 3 }) }, decoder: decoders, clock, log,
  });
  const model = createPumpSwapPoolModel({ decoder: decoders, fees: () => { const f = venue.inputs('pumpswap'); return f.ok ? f.value : null; } });

  // ---- M07: recovery, then the queue with every stream's next seq, then the writer. ----
  const wlog = m07Log(log);
  const dataDir = configValue(cfg, 'recorder.data_dir') === p.paths.mdDir ? p.paths.mdDir : p.paths.mdDir;
  const recovery = SegmentWriter.recover({ dataDir, nowMs: nowMs(), log: wlog });
  const queue = new RecorderQueue({ firstSeq: recovery.nextSeq, log: wlog, config: { pollCloseGraceMs: configValue(cfg, 'bars.close_grace_ms') } });
  const bars = createBarEngine({ ...BAR_DEFAULTS, closeGraceMs: configValue(cfg, 'bars.close_grace_ms'), incompleteMissingBps: configValue(cfg, 'bars.incomplete_missing_bps') }, log);
  const barStore = createBarStore(db, { retentionDays: configValue(cfg, 'bars.bar_1m_retention_days'), log });
  const writer = new SegmentWriter({
    dataDir, codec: configValue(cfg, 'recorder.codec_preference') as Codec, nowMs, log: wlog,
    queue: {
      take(max, segmentId) {
        const taken = queue.take(max, segmentId);
        for (const r of taken) {
          const c = pollCountsOf(r);
          if (c !== null) bars.onPollCounts(c);
        }
        return taken;
      },
      drainGaps: () => queue.drainGaps(),
    },
  }, recovery);
  const researchKey = p.researchKey ?? (() => { try { return createPublicKey(p.readFile(configValue(cfg, 'recorder.research_pubkey'))); } catch { return null; } });
  const key = researchKey();
  const disk = new DiskManager({
    dataDir, receiptsDir: p.paths.receiptsDir,
    // Q8: with no research key no receipt can verify, so nothing is ever deleted (an all-zero key verifies nothing).
    publicKey: key ?? createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: 'A'.repeat(43) }, format: 'jwk' }),
    policy: {
      ...DEFAULT_DISK_POLICY, warnPct: configValue(cfg, 'recorder.disk_warn_pct'), stopPct: configValue(cfg, 'recorder.disk_stop_pct'),
      maxBytes: configValue(cfg, 'recorder.max_bytes'), minFreeBytes: configValue(cfg, 'recorder.min_free_bytes'), retentionDays: configValue(cfg, 'recorder.retention_days'),
    },
    usage: p.diskUsage ?? (() => { const s = statfsSync(dataDir); return { totalBytes: Number(s.blocks) * Number(s.bsize), freeBytes: Number(s.bavail) * Number(s.bsize) }; }),
    writer, nowMs, log: wlog,
  });
  const watchLog = new WatchLog(dataDir, () => log.event('error', 'recorder.internal_error', { where: 'watch_log', error_code: 'E_WRITE' }));
  const marker = queue.markProcessStart(p.releaseId, nowMs());
  if (marker !== 'queued') { db.close(); return refuse(log, 'process_start', `the process_start marker was not queued: ${JSON.stringify(marker)}`); }

  // ---- M05: the universe, the watchlist, and their persisted eviction records. ----
  const store = m24CandidateStore(db, { newId, nowMs });
  const evictions = kvEvictionLog(db, nowMs);
  const limitSetId = configValue(cfg, 'universe.phase0_limit_set') as LimitSetId;
  const facts = new Map<Pubkey, PrefilterFacts>();
  const factOf = (s: PoolSnapshot<CpPoolState>): PrefilterFacts => ({
    venue: 'pumpswap', quoteMint: MINTS.wsol, feeTotalBps: s.feeTotalBps, effectiveQuoteLamports: s.effectiveQuoteLamports, observedAtMs: s.pool.observedAtMs,
  });
  let tracker: PoolTracker<CpPoolState> | null = null;
  const universe = createUniverse({
    config: {
      ...UNIVERSE_DEFAULTS, screeningRequired: configValue(cfg, 'universe.screening_required'), limitSetId, limits: LIMIT_SETS[limitSetId],
      cooldownMs: configValue(cfg, 'universe.cooldown_ms'), prefilterRetryMs: configValue(cfg, 'universe.prefilter_retry_ms'),
      staleToStateMs: configValue(cfg, 'universe.stale_to_state_ms'), screenBacklogMax: configValue(cfg, 'universe.screen_backlog_max'),
      factsMaxAgeMs: configValue(cfg, 'universe.facts_max_age_ms'), factsRefreshMax: configValue(cfg, 'universe.facts_refresh_max'),
      factsRefreshPerHour: configValue(cfg, 'universe.facts_refresh_per_hour'), retireAfterFailedRetries: configValue(cfg, 'universe.retire_after_failed_retries'),
    },
    store, nowMs, newId, wsolMint: MINTS.wsol,
    facts: (id) => facts.get(id) ?? null,
    requestFacts: (ids) => { void factsRead(ids); },
    // Z09-44: fresh reads pause while M14 cannot serve P4 from the unmetered primary.
    readsAvailable: () => rp.monitor.mode() === 'normal',
    lists: { isWrittenOff: () => false, isUnsolicited: () => false },
    publish: () => { watchlist.recompute(universe.candidates()); },
    log,
  });
  const link = linkTrackerToRecorder<CpPoolState>({ recorder: queue, history: watchLog, model, nowMs });
  const watchlist: Watchlist = createWatchlist({
    config: {
      ...WATCHLIST_DEFAULTS, maxWatched: configValue(cfg, 'universe.max_watched'), maxAccountsPerCall: settings.maxAccountsPerCall,
      tailMaxPools: configValue(cfg, 'universe.tail_max_pools'), tailExtraMs: configValue(cfg, 'universe.tail_extra_ms'),
    },
    nowMs, maxHoldMs: () => 0, mode: () => rp.monitor.mode(),
    tracker: {
      watch: (id, cls) => (tracker === null ? false : link.watch(tracker, id, cls)),
      unwatch: (id) => { tracker?.unwatch(id); },
    },
    universe,
    depthOf: (id) => tracker?.latest(id)?.effectiveQuoteLamports ?? null,
    onEviction: (e) => evictions.append(e),
    restoreTails: () => evictions.restore(),
    log,
  });

  // ---- M04: the tracker, its outputs to M07, M05, M08 and M14. ----
  tracker = createPoolTracker<CpPoolState>({
    model, reader, scheduler: p.scheduler, chain, clock, settings, log,
    providerOrder: () => rp.labels,
    outputs: {
      snapshot(s, cls) {
        link.outputs.snapshot(s, cls);
        facts.set(s.pool.poolId, factOf(s));
        bars.onSnapshot(barSnapshotOf(s), cls === 'tail' ? settings.tailIntervalMs : settings.candidateIntervalMs);
      },
      unwatched(id) { link.outputs.unwatched(id); bars.stop(id); },
      closed(e) { bars.stop(e.poolId); universe.onQuarantine(e.poolId); },
      stale(e) { universe.onStale(e.poolId, e.sinceMs); },
      fresh(e) { universe.onFresh(e.poolId); },
      quarantine(id) { universe.onQuarantine(id); },
      providerLagging() { /* M14 health reads the lag from M15's context slots */ },
    },
  });

  /** Z09-34/39/44: one P4 read of slotless pools' facts through M14 (two calls: the pools, then their vaults and mints). */
  async function factsRead(ids: readonly Pubkey[]): Promise<void> {
    if (ids.length === 0) return;
    const pools = await reader.read(ids, { priority: 4 });
    if (!pools.ok) { log.event('warn', 'recorder.facts_read_failed', { error_code: pools.error.code, pools: ids.length }); return; }
    const addrs = ids.flatMap((id, i) => { const a = model.addresses(id, pools.value.accounts[i] ?? null); return a.ok ? [{ a: a.value, pool: pools.value.accounts[i] ?? null }] : []; });
    if (addrs.length === 0) return;
    const keys = addrs.flatMap(({ a }) => [a.baseVault, a.quoteVault, a.tokenMint]);
    const rest = await reader.read(keys, { priority: 4 });
    if (!rest.ok) { log.event('warn', 'recorder.facts_read_failed', { error_code: rest.error.code, pools: addrs.length }); return; }
    for (const [i, { a, pool }] of addrs.entries()) {
      const [bv, qv, mintRaw] = [rest.value.accounts[3 * i] ?? null, rest.value.accounts[3 * i + 1] ?? null, rest.value.accounts[3 * i + 2] ?? null];
      const mint = model.mint(mintRaw);
      if (mint === null) continue;
      // The fee schedule depends on whether the pool is canonical (A-M01-01), so the creator PDA is derived as M04 does.
      const canonicalCreator = await model.canonicalCreator(a.tokenMint);
      const built = model.build(a, { pool, baseVault: bv, quoteVault: qv }, mint, { asOfSlot: rest.value.contextSlot, observedAtMs: nowMs(), canonicalCreator });
      if (!built.ok) continue;
      const fee = model.feeTotalBps(built.value);
      facts.set(a.poolId, { venue: 'pumpswap', quoteMint: MINTS.wsol, feeTotalBps: fee ?? 10_000, effectiveQuoteLamports: model.effectiveQuote(built.value), observedAtMs: built.value.observedAtMs });
    }
  }

  // ---- M03: the migration backfill (chain data only; PumpPortal is not used, owner 7 Oct). ----
  const backfill = createMigrationBackfill<CpPoolState>({
    config: { ...BACKFILL_DEFAULTS, intervalMs: configValue(cfg, 'discovery.backfill.interval_ms'), maxPagesPerRun: configValue(cfg, 'discovery.backfill.max_pages_per_run') },
    gateway: rp.gateway, reader, model: model as never,
    decode: migrationDecoder({ readRpcTransaction, decodeEventsWithGaps: decodeEventsWithGaps as never }, idls.value, MINTS.wsol),
    withdrawAuthority: ACCOUNTS.migrationWithdrawAuthority, wsolMint: MINTS.wsol, store: m24BackfillStore(db, nowMs),
    record: (m: MigrationObserved) => { queue.append({ stream: 'discovery', recvMs: nowMs(), slot: m.slot ?? null, commitment: 'confirmed', source: 'm03', payload: m }); },
    publishMigration: () => undefined,
    publishPool: (d: PoolDiscovered, state: CpPoolState) => {
      universe.onDiscovery({ poolId: d.poolId, baseMint: d.baseMint, quoteMint: d.quoteMint, venue: d.venue, verifiedOnChain: d.verifiedOnChain, migratedAtMs: d.migratedAtMs },
        { venue: 'pumpswap', quoteMint: MINTS.wsol, feeTotalBps: model.feeTotalBps(state) ?? 10_000, effectiveQuoteLamports: model.effectiveQuote(state), observedAtMs: state.observedAtMs });
    },
    newId, nowMs, scheduler: p.scheduler, log,
  });

  // ---- M07 reference records: SOL/USD each minute (C-90) and the venue configs every 10 min. ----
  const solUsd = createSolUsdReader({ ids: {
      whirlpoolProgram: PROGRAMS.orcaWhirlpools, whirlpoolsConfig: REFERENCE.orcaWhirlpoolsConfig, pool: REFERENCE.solUsdcWhirlpool,
      wsol: MINTS.wsol, usdc: MINTS.usdc, splToken: PROGRAMS.splToken, encodeKey: (b) => base58.encode(b) as Pubkey,
    }, reader: { read: (keys, o) => reader.read(keys, o) }, append: (r) => { queue.append(r); }, nowMs });
  const venueRecorder = recordVenueConfig({
    cache: venue, accounts: [ACCOUNTS.feeConfigCurve, ACCOUNTS.feeConfigPumpSwap, ACCOUNTS.pumpSwapGlobalConfig, ACCOUNTS.pumpGlobal],
    append: (r) => { queue.append(r); }, nowMs,
  });

  // ---- The 1 s loop. ----
  const startedAtMs = nowMs();
  let lastTickMs: UnixMs | null = null;
  let lastFlushMs = -Infinity, lastDiskMs = -Infinity, lastWatchlistMs = -Infinity, lastAnchorMs = -Infinity, lastBarStoreMs = -Infinity, lastVenueMs = -Infinity;
  const flushMs = configValue(cfg, 'recorder.flush_ms');
  const diskMs = configValue(cfg, 'recorder.disk_check_ms');
  let started = false;
  let anchorTries = 0;
  const guard = async (where: string, fn: () => unknown): Promise<void> => {
    try { await fn(); } catch (e) { log.event('error', 'recorder.internal_error', { where, error_code: String((e as { code?: unknown })?.code ?? 'E_THROWN') }); }
  };

  async function tickOnce(): Promise<void> {
    const now = nowMs();
    const mono = p.scheduler.nowMs();
    lastTickMs = now;
    rp.tick();
    if (mono - lastAnchorMs >= (chain.ready() ? ANCHOR_EVERY_MS : 5_000)) {
      lastAnchorMs = mono;
      const ok = await chain.refresh();
      if (!chain.ready() && !ok && ++anchorTries % 12 === 1) log.event('warn', 'recorder.anchor_waiting', { tries: anchorTries });
    }
    if (!started && chain.ready()) {
      started = true;
      (tracker as PoolTracker<CpPoolState>).start();
      backfill.start();
      log.event('info', 'recorder.started', { release: p.releaseId, providers: rp.labels.join(','), primary: rp.primary });
    }
    if (mono - lastVenueMs >= 60_000) { lastVenueMs = mono; await guard('venue_config', () => venue.refresh()); }
    // Z09-32: the queue's tick, the writer's pump (poll counts to M08), then M08's closeDue, with one `now`.
    await guard('queue_tick', () => queue.tick(now));
    await guard('pump', () => writer.pump());
    await guard('bars', () => { barStore.add(bars.closeDue(now).filter((b) => b.durationMs === 60_000)); });
    if (started) {
      await guard('universe', () => universe.tick());
      if (mono - lastWatchlistMs >= WATCHLIST_EVERY_MS) { lastWatchlistMs = mono; await guard('watchlist', () => watchlist.recompute(universe.candidates())); }
      void guard('sol_usd', () => solUsd.tick(now));
    }
    await guard('venue_recorder', () => venueRecorder.tick(now));
    if (mono - lastFlushMs >= flushMs) { lastFlushMs = mono; await guard('flush', () => writer.flush()); }
    if (mono - lastDiskMs >= diskMs) { lastDiskMs = mono; await guard('disk', () => disk.check()); }
    if (mono - lastBarStoreMs >= FLUSH_BAR_STORE_MS) { lastBarStoreMs = mono; await guard('bar_store', () => barStore.flush(now)); }
    metrics.tick();
  }

  let cancel: (() => void) | null = null;
  let stopped = false;
  const loop = (): void => {
    if (stopped) return;
    cancel = p.scheduler.set(() => { void tickOnce().finally(loop); }, 1_000);
  };
  // Not awaited: M15's first reads go through M14's timers, which the loop's clock drives (and the virtual clock in tests).
  void rp.clock.start().catch(() => log.event('error', 'recorder.internal_error', { where: 'm15_start', error_code: 'E_THROWN' }));
  loop();

  return {
    ok: true,
    value: {
      status: () => ({
        releaseId: p.releaseId, startedAtMs, anchored: chain.ready(),
        anchor: chain.anchor() === null ? null : { slot: (chain.anchor() as { slot: Slot }).slot.toString(), providers: (chain.anchor() as { providers: readonly string[] }).providers },
        mode: rp.monitor.mode(), providers: rp.labels, watched: (tracker as PoolTracker<CpPoolState>).ready().length, halted: writer.haltReason(),
        queueDepth: queue.stats().queueDepth, lastTickMs,
      }),
      async stop(): Promise<void> {
        if (stopped) return;
        stopped = true;
        cancel?.();
        backfill.stop();
        (tracker as PoolTracker<CpPoolState>).stop();
        rp.clock.stop();
        try { writer.pump(); writer.flush(); } catch { /* a failed final flush is recovered at the next start (crash recovery) */ }
        try { barStore.flush(nowMs()); } catch { /* bars are re-derived from the recording */ }
        log.event('info', 'recorder.stopped', { reason: 'signal' });
        db.close();
      },
      parts: {
        db, config, log, metrics, read: rp, chain, queue, writer, disk, tracker: tracker as PoolTracker<CpPoolState>, universe, watchlist, bars, barStore,
        backfill, venue, venueRecorder, evictions, tickOnce,
      },
    },
  };
}
