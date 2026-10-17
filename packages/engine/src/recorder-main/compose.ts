// The recorder's composition root (card Z10; docs/MIGRATION.md "Z10 Recorder on the server"). It wires the keyless M1
// recorder: M14 reads (Shyft primary, Chainstack backup; read roles only), the M15 slot clock with a two-provider
// anchor (chain.ts, C-84), M01's fee-config cache, M04's pool tracker, M03's migration backfill, M05's universe and
// watchlist, M07's queue, segment writer, disk manager and watch log, M08's bars and the SOL/USD and venue-config
// records. Nothing here signs, builds or sends a transaction, and no strategy is enabled.
//
// The same function runs live (run.ts: real clock, timers, fetch and folders) and in the soak (scripts/soak/soak.ts: a
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
import { createSolUsdReader, type RefPriceRecord } from '../m07/sol-usd.ts';
import { recordVenueConfig, type VenueConfigRecorder } from '../m07/venue-config.ts';
import { WatchLog } from '../m07/watch-log.ts';
import { barSnapshotOf, BAR_DEFAULTS, createBarEngine, type BarEngine, type PollCountsIn } from '../m08/bars.ts';
import { createBarStore, type BarStore } from '../m08/bar-store.ts';
import type { FetchLike, Scheduler, SecretSource } from '../m14/types.ts';
import { m14Settings } from '../m14/settings.ts';
import { parseEpochInfo } from '../m15/clock.ts';
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
import { RECORD_MAX_BYTES_CAP, RecorderQueue, type EncodedRecord } from '../recorder/queue.ts';
import { isStreamName, STREAM_NAMES, type StreamName } from '../recorder/streams.ts';
import { createAgreedChainState, ANCHOR_EVERY_MS, type AgreedChainState } from './chain.ts';
import { m07Log, RECORDER_LOG_TABLE } from './log-codes.ts';
import { createReadPath, type ReadPath } from './rpc.ts';
import { createDailyJob } from './daily.ts';
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
  /** C-90: 'pending' until the first SOL/USD read, then 'pass' or 'fail: <reason>'. */
  solUsdCheck: string;
  /** Ruling Z10-24: the newest slot of any stored snapshot (u64 as text), or null before the first. */
  newestStoredSlot: string | null;
  /** Ruling Z10-24: codes of the other critical lines raised in the last CRITICAL_ACTIVE_MS, sorted (codes only). */
  criticalCodes: string[];
  /** Ruling Z10-41: the STATE_CODES whose condition holds now. */
  activeCodes: string[];
  /** Ruling Z10-44: the monotonic clock (recorderTimers) now, at the last loop tick (null before the first) and at start. */
  monoMs: number; lastTickMonoMs: number | null; startedMonoMs: number;
  /** Ruling Z10-41: monotonic ms since the last two-provider agreement (since the start before the first). */
  anchorAgeMs: number;
}

export interface RunningRecorder {
  status(): RecorderStatus;
  stop(): Promise<void>;
  /** Internals for tests and the soak: never used by run.ts. */
  readonly parts: {
    db: Db; config: ConfigService; log: Logger; metrics: MetricsRegistry; read: ReadPath; chain: AgreedChainState; queue: RecorderQueue;
    writer: SegmentWriter; disk: DiskManager; tracker: PoolTracker<CpPoolState>; universe: Universe; watchlist: Watchlist; bars: BarEngine;
    barStore: BarStore; backfill: MigrationBackfill<CpPoolState>; venue: VenueConfigCache; venueRecorder: VenueConfigRecorder; evictions: EvictionLog;
    model: ReturnType<typeof createPumpSwapPoolModel>;
    tickOnce(): Promise<void>;
  };
}

const WATCHLIST_EVERY_MS = 10_000;
const FLUSH_BAR_STORE_MS = 60_000;
const METRICS_EVERY_MS = 10_000;
/** C-90: the kept first SOL/USD read on the server. */
export const SOL_USD_CHECK_KEY = 'recorder.sol_usd_first_check';
/** SW-11: every stream's next seq at the last rotation (`{ stream: "<u64>" }`), in `kv_state`. */
export const NEXT_SEQ_KEY = 'm07.next_seq';

/** SW-11: the saved next seqs; an unreadable or malformed row reads as none (the manifests then decide alone). */
export function savedNextSeq(db: Db): Partial<Record<StreamName, bigint>> {
  const r = createRepos().kv_state.get(db.reader(), { key: NEXT_SEQ_KEY });
  if (r === null) return {};
  try {
    const v = JSON.parse(String(r.valueJson)) as Record<string, unknown>;
    const out: Partial<Record<StreamName, bigint>> = {};
    for (const [k, x] of Object.entries(v)) if (isStreamName(k) && typeof x === 'string' && /^\d{1,20}$/.test(x)) out[k] = BigInt(x);
    return out;
  } catch {
    return {};
  }
}
/** Ruling Z10-41: M04's verification count of the day (`{ day, count }`), in `kv_state`. */
export const VERIFY_COUNT_KEY = 'm04.verify_count';
/**
 * Ruling Z10-41 (a new value; SPEC and ARCH give none): no two-provider agreement for this long, from the start or
 * since the last, is `recorder.unanchored`. SPEC says nothing about recording on an unverified clock, so the recorder
 * keeps recording and marks it: a `decision` record `{ kind: 'recorder_clock' }` at each change between anchored and
 * unanchored, so a replay knows which stretch was extrapolated from an old anchor.
 */
export const UNANCHORED_MS = 600_000;
/** Ruling Z10-41: critical codes that hold exactly while their condition does (never from the 15-minute window). */
export const STATE_CODES: ReadonlySet<string> = new Set(['m14.provider_stopped', 'm04.verify_cap_reached', 'recorder.clock_suspect', 'm07.unpulled_segments', 'recorder.manifest_not_recorded', 'recorder.unanchored']);
/**
 * Ruling Z10-24 (a new value: no SPEC or ARCH threshold exists): a critical line keeps the heartbeat critical for this
 * long after it was last raised. 15 minutes: at least three of the watchdog's 300 s repeats (`REPEAT_CRITICAL_S`).
 */
export const CRITICAL_ACTIVE_MS = 900_000;
/** A clock episode (Z10-F2) becomes one critical alert after this long (M04's DISAGREEMENT_ALERT_MS). */
export const CLOCK_ALERT_MS = 10_000;
/** The anchor is re-read this often before the first agreement and during a clock episode. */
export const ANCHOR_RETRY_MS = 5_000;

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
  // Ruling Z10-24: every critical line's code, with when it was last raised, for the heartbeat (codes only, D27(c)).
  const criticalAt = new Map<string, number>();
  const rawLog = createLogger({ clock, codes: RECORDER_LOG_TABLE, sink: p.logSink, runId: p.releaseId, mode: 'paper' });
  const bootLog: typeof rawLog = {
    ...rawLog,
    event(level, code, fields): void {
      if (level === 'critical') criticalAt.set(code, clock.nowMs());
      rawLog.event(level, code, fields);
    },
  };
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
    // P1 pinned to each provider (P0 stays the exits'); the answer must come from that provider, and parse as M15 does.
    readHeight: async (provider) => {
      const r = await rp.gateway.call<unknown>('getEpochInfo', [], { priority: 1, role: 'read', commitment: 'confirmed', timeoutMs: m15Settings(cfg).heightTimeoutMs, provider });
      if (!r.ok || r.value.providerLabel !== provider) return null;
      const e = parseEpochInfo(r.value.value);
      return e === null ? null : { slot: e.slot, atMs: nowMs() };
    },
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
  // The paths come from run.ts (ENGINE_PATHS on the host, the trial's scratch folder in worker-smoke), so the folder the
  // unit may write is always the one used; `recorder.data_dir` keeps its default, which is ENGINE_PATHS.mdDir.
  const dataDir = p.paths.mdDir;
  const recovery = SegmentWriter.recover({ dataDir, nowMs: nowMs(), log: wlog });
  // SW-11: each stream's next seq is also kept in M24 at every rotation, so a stream whose segments were all received
  // and deleted (DiskManager) never starts again at a seq it already used; the larger of that and the manifests wins.
  const firstSeq = { ...recovery.nextSeq };
  for (const [stream, seq] of Object.entries(savedNextSeq(db))) {
    const had = firstSeq[stream as keyof typeof firstSeq];
    if (had === undefined || seq > had) firstSeq[stream as keyof typeof firstSeq] = seq;
  }
  // Finding F5 (rulings Z10-20, Z10-29): a day's universe manifest is about 420 bytes per eligible pool (the soak's
  // second day: 239 pools, 100,566 bytes), past the 64 KiB default, so that stream alone gets M07's largest cap (1 MiB,
  // ruling Z08-28: about 2,490 pools); every other stream keeps `recorder.record_max_bytes`.
  const queue = new RecorderQueue({
    firstSeq, log: wlog,
    config: { pollCloseGraceMs: configValue(cfg, 'bars.close_grace_ms'), recordMaxBytes: configValue(cfg, 'recorder.record_max_bytes'), streamMaxBytes: { universe_manifest: RECORD_MAX_BYTES_CAP } },
  });
  // The stored 1-minute bars (M08 `bar_1m`). The 15 s base bars feed only features and strategies, none of which runs in
  // the recorder; replays rebuild them from the recording (A-M08-01, Z09-32).
  const bars = createBarEngine({ ...BAR_DEFAULTS, durationMs: 60_000, closeGraceMs: configValue(cfg, 'bars.close_grace_ms'), incompleteMissingBps: configValue(cfg, 'bars.incomplete_missing_bps') }, log);
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
      unwrite: (records, giveBackSeqs) => { queue.unwrite(records, giveBackSeqs); },
    },
    onManifest: () => { seqsRotated = true; },
  }, recovery);
  let seqsRotated = false;
  /** SW-11: every stream's next seq as of now (each at least what is on disk), after a rotation. */
  const saveNextSeq = (): void => {
    if (!seqsRotated) return;
    seqsRotated = false;
    const v = Object.fromEntries(STREAM_NAMES.map((st) => [st, queue.peekNextSeq(st).toString()]));
    const t = nowMs();
    db.withTx((tx) => { repos.kv_state.upsert(tx, { key: NEXT_SEQ_KEY, valueJson: JSON.stringify(v), createdAt: t, updatedAt: t }); });
  };
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
  // Z09-51: the queued_stale share of the hourly fresh-read ceiling. Asks are counted per minute over the last hour,
  // each split by whether the pool was waiting as queued_stale when it was asked.
  const asks: Array<{ minute: number; all: number; queuedStale: number }> = [];
  const noteAsks = (ids: readonly Pubkey[]): void => {
    const minute = Math.floor(nowMs() / 60_000);
    const qs = ids.filter((id) => store.get(id)?.reasons.includes('queued_stale') === true).length;
    const last = asks.at(-1);
    if (last?.minute === minute) { last.all += ids.length; last.queuedStale += qs; } else asks.push({ minute, all: ids.length, queuedStale: qs });
    while (asks.length > 0 && (asks[0] as { minute: number }).minute <= minute - 60) asks.shift();
  };
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
    requestFacts: (ids) => { noteAsks(ids); void factsRead(ids); },
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
  // Z10-F2 (ruling Z10-16): with polls only (no entry or exit reads), a provider whose reads sit past the clock's ceiling
  // gets a warn `m04.clock_suspect` from M04, and none of its reads is stored. The recorder watches for that: an episode
  // starts at M04's first clock event and ends when a snapshot from the suspect provider is stored again (the backup's
  // verification reads, P1 since ruling Z10-15, do not end it: the primary's polls are still refused); past
  // CLOCK_ALERT_MS it raises ONE critical `recorder.clock_suspect`, and while it lasts the anchor is re-read every
  // ANCHOR_RETRY_MS. When M04 raises its own critical clock alert (a confirmed `m04.clock_fault`, or a disagreement past
  // its own time), that is the episode's one alert and any stored snapshot ends it.
  const M04_CLOCK_CODES: ReadonlySet<string> = new Set(['m04.clock_suspect', 'm04.clock_fault', 'm04.clock_disagreement']);
  let clockTrouble: { sinceMs: number; alerted: boolean; source: string | null } | null = null;
  /** Ruling Z10-24: the newest slot M04 stored (any pool), the heartbeat's `last_processed_slot`. */
  let newestStoredSlot: Slot | null = null;
  const trackerLog = {
    event(level: 'info' | 'warn' | 'error' | 'critical', code: string, fields: Readonly<Record<string, unknown>>): void {
      log.event(level, code, fields);
      if (!M04_CLOCK_CODES.has(code)) return;
      const source = typeof fields.source === 'string' ? fields.source : null;
      if (clockTrouble === null) clockTrouble = { sinceMs: p.scheduler.nowMs(), alerted: false, source };
      if (level === 'critical') { clockTrouble.alerted = true; clockTrouble.source = null; }
    },
  };
  // A failed poll batch counts as a failed poll for each watched pool in it (A-M07-01 `failedPolls`; M04 only logs it).
  // A poll batch is [pool, baseVault, quoteVault] per pool at the class priority: position P1, candidate P2, tail P4.
  const CLASS_OF: Readonly<Record<number, 'position' | 'candidate' | 'tail'>> = { 1: 'position', 2: 'candidate', 4: 'tail' };
  const pollReader: AccountsReader = {
    async read(keys, o) {
      const r = await reader.read(keys, o);
      const cls = CLASS_OF[o.priority];
      // Ruling Z10-34: only M04's class polls count (source.ts marks them `purpose: 'poll'`). Its other reads (a
      // verification at P1, pinned or not, an entry or exit fresh read) must not count a poll that never happened, nor
      // mark a candidate or tail pool as a position (P1) and change its interval.
      if (!r.ok && o.purpose === 'poll' && cls !== undefined && keys.length % 3 === 0 && tracker !== null) {
        const ready = new Set(tracker.ready());
        const at = nowMs();
        for (let i = 0; i < keys.length; i += 3) {
          const id = keys[i] as Pubkey;
          if (ready.has(id)) queue.notePollFailed(id, cls, at, cls === 'position');
        }
      }
      return r;
    },
  };
  tracker = createPoolTracker<CpPoolState>({
    model, reader: pollReader, scheduler: p.scheduler, chain, clock, settings, log: trackerLog,
    providerOrder: () => rp.labels,
    // Ruling Z10-41: the day's verification count survives a restart (the cap is a budget, and its state is a code).
    verifyCount: {
      load: () => {
        const r = repos.kv_state.get(db.reader(), { key: VERIFY_COUNT_KEY });
        try { const v = r === null ? null : JSON.parse(String(r.valueJson)) as { day: number; count: number }; return v !== null && Number.isSafeInteger(v.day) && Number.isSafeInteger(v.count) ? v : null; } catch { return null; }
      },
      save: (v) => { const t = nowMs(); db.withTx((tx) => { repos.kv_state.upsert(tx, { key: VERIFY_COUNT_KEY, valueJson: JSON.stringify(v), createdAt: t, updatedAt: t }); }); },
    },
    // M04's metrics on the M27 registry (catalog names and labels A-M04-01..03).
    metrics: {
      counter: (name, labels) => { metrics.counter(name, labels as never).inc(); },
      observe: (name, labels, value) => { metrics.histogram(name, labels as never).observe(value); },
      gauge: (name, labels, value) => { metrics.gauge(name, labels as never).set(value); },
    },
    outputs: {
      snapshot(s, cls) {
        if (newestStoredSlot === null || s.providerSlot > newestStoredSlot) newestStoredSlot = s.providerSlot;
        if (clockTrouble !== null && (clockTrouble.source === null || clockTrouble.source === s.providerLabel)) clockTrouble = null;
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
      metrics.counter('discoveries_total', { source: d.source }).inc();
      universe.onDiscovery({ poolId: d.poolId, baseMint: d.baseMint, quoteMint: d.quoteMint, venue: d.venue, verifiedOnChain: d.verifiedOnChain, migratedAtMs: d.migratedAtMs },
        { venue: 'pumpswap', quoteMint: MINTS.wsol, feeTotalBps: model.feeTotalBps(state) ?? 10_000, effectiveQuoteLamports: model.effectiveQuote(state), observedAtMs: state.observedAtMs });
    },
    newId, nowMs, scheduler: p.scheduler, log,
  });

  // ---- M07 reference records: SOL/USD each minute (C-90) and the venue configs every 10 min. ----
  // C-90: the first SOL/USD read on the server is the live check. Its record (price, mints, vault balances, or why it
  // was unavailable) is kept once in M24 `kv_state` under SOL_USD_CHECK_KEY and shown on /health; every later read is
  // checked the same way by the reader and writes `unavailable`, never a stale price, until a reviewed pool change.
  const kvRepo = createRepos().kv_state;
  const solUsdCheck = (): { result: string; atMs: number } | null => {
    const r = kvRepo.get(db.reader(), { key: SOL_USD_CHECK_KEY });
    return r === null ? null : JSON.parse(String(r.valueJson)) as { result: string; atMs: number };
  };
  const keepFirstSolUsd = (r: RefPriceRecord): void => {
    // A read that never reached the pool (a provider error) is not a check of the pool: the next minute tries again.
    if (r.payload.kind === 'unavailable' && (r.payload.reason.startsWith('read:') || r.payload.reason === 'internal_error')) return;
    if (solUsdCheck() !== null) return;
    const result = r.payload.kind === 'price' ? 'pass' : `fail: ${r.payload.reason}`;
    const t = nowMs();
    db.withTx((tx) => { kvRepo.upsert(tx, { key: SOL_USD_CHECK_KEY, valueJson: JSON.stringify({ result, atMs: r.recvMs, slot: r.slot?.toString() ?? null, payload: r.payload }), createdAt: t, updatedAt: t }); });
    log.event(r.payload.kind === 'price' ? 'info' : 'critical', 'recorder.sol_usd_check', { result });
  };
  const solUsd = createSolUsdReader({ ids: {
      whirlpoolProgram: PROGRAMS.orcaWhirlpools, whirlpoolsConfig: REFERENCE.orcaWhirlpoolsConfig, pool: REFERENCE.solUsdcWhirlpool,
      wsol: MINTS.wsol, usdc: MINTS.usdc, splToken: PROGRAMS.splToken, encodeKey: (b) => base58.encode(b) as Pubkey,
    }, reader: { read: (keys, o) => reader.read(keys, o) }, append: (r) => { queue.append(r); void guard('sol_usd_check', () => keepFirstSolUsd(r)); }, nowMs });
  const venueRecorder = recordVenueConfig({
    cache: venue, accounts: [ACCOUNTS.feeConfigCurve, ACCOUNTS.feeConfigPumpSwap, ACCOUNTS.pumpSwapGlobalConfig, ACCOUNTS.pumpGlobal],
    append: (r) => { queue.append(r); }, nowMs,
  });

  // ---- 00:00 UTC: the universe manifest, then the coverage report (daily.ts). ----
  const daily = createDailyJob({
    db, dataDir, evictions, limits: LIMIT_SETS[limitSetId], limitSetId, prefilterOnly: !configValue(cfg, 'universe.screening_required'),
    migrationCoverage: () => backfill.coverage(86_400_000), closedThrough: () => writer.lastRotatedHourUtc(), append: (r) => queue.append(r), nowMs, log,
  });

  // ---- The 1 s loop. ----
  const startedAtMs = nowMs();
  let lastTickMs: UnixMs | null = null;
  /** Ruling Z10-44: the last tick on the monotonic clock (a wall-clock step never makes the loop look stale). */
  let lastTickMono: number | null = null;
  const startedMono = p.scheduler.nowMs();
  let lastAgreeMono: number | null = null;
  let unanchored = false;
  let lastDisk: ReturnType<DiskManager['check']> | null = null;
  /** Ruling Z10-51: the state codes as of the last loop tick, so /health and status() read no database. */
  let tickCodes: readonly string[] = [];
  let tickSolUsd = 'pending';
  /** Ruling Z10-41: the state codes, each exactly while its condition holds. */
  const activeCodes = (): string[] => {
    const out: string[] = [];
    if (rp.gateway.status().some((x) => x.stopped)) out.push('m14.provider_stopped');
    if (tracker?.verifyCapReached() === true) out.push('m04.verify_cap_reached');
    if (clockTrouble?.alerted === true) out.push('recorder.clock_suspect');
    if ((lastDisk?.unpulledOld ?? 0) > 0) out.push('m07.unpulled_segments');
    if (daily.manifestMissing(nowMs())) out.push('recorder.manifest_not_recorded');
    if (unanchored) out.push('recorder.unanchored');
    return out;
  };
  let lastMetricsMs = -Infinity, lastFlushMs = -Infinity, lastDiskMs = -Infinity, lastWatchlistMs = -Infinity, lastAnchorMs = -Infinity, lastBarStoreMs = -Infinity, lastVenueMs = -Infinity;
  const flushMs = configValue(cfg, 'recorder.flush_ms');
  const diskMs = configValue(cfg, 'recorder.disk_check_ms');
  let started = false;
  let anchorTries = 0;
  let anchoring = false;
  let venueRefreshing = false;
  const guard = async (where: string, fn: () => unknown): Promise<void> => {
    try { await fn(); } catch (e) { log.event('error', 'recorder.internal_error', { where, error_code: String((e as { code?: unknown })?.code ?? 'E_THROWN') }); }
  };

  const ceiling = configValue(cfg, 'universe.facts_refresh_per_hour');
  let barsSeen = { late: 0, early: 0 };
  /** Gauges and counters read from the modules' own stats (Z09-11), every METRICS_EVERY_MS. */
  function sample(): void {
    const byState = new Map<string, number>();
    for (const c of universe.candidates()) byState.set(c.state, (byState.get(c.state) ?? 0) + 1);
    for (const st of ['discovered', 'screening', 'eligible', 'watched', 'stale', 'signalled', 'in_position', 'cooldown']) metrics.gauge('candidates', { state: st }).set(byState.get(st) ?? 0);
    const all = asks.reduce((n, a) => n + a.all, 0), qs = asks.reduce((n, a) => n + a.queuedStale, 0);
    metrics.gauge('facts_refresh_pools', {}).set(all);
    metrics.gauge('facts_queued_stale_share_bps', {}).set(ceiling > 0 ? Math.floor((qs * 10_000) / ceiling) : 0);
    metrics.gauge('backfill_stalled', {}).set(backfill.health().critical ? 1 : 0);
    const st = bars.stats();
    if (st.lateCounts > barsSeen.late) metrics.counter('bars_counts_refused_total', { reason: 'late' }).inc(st.lateCounts - barsSeen.late);
    if (st.earlyCounts > barsSeen.early) metrics.counter('bars_counts_refused_total', { reason: 'early' }).inc(st.earlyCounts - barsSeen.early);
    barsSeen = { late: st.lateCounts, early: st.earlyCounts };
    const q = queue.stats();
    metrics.gauge('recorder_queue_depth', {}).set(q.queueDepth);
  }

  async function tickOnce(): Promise<void> {
    const now = nowMs();
    const mono = p.scheduler.nowMs();
    lastTickMs = now;
    lastTickMono = mono;
    // Ruling Z10-41: the anchor's age on the monotonic clock; a change between anchored and unanchored is logged and
    // written into the recording.
    const unanchoredNow = mono - (lastAgreeMono ?? startedMono) >= UNANCHORED_MS;
    if (unanchoredNow !== unanchored) {
      unanchored = unanchoredNow;
      const a = chain.anchor();
      const fields = { anchor_age_ms: Math.round(mono - (lastAgreeMono ?? startedMono)), anchor_slot: a === null ? 'none' : a.slot.toString() };
      if (unanchoredNow) log.event('critical', 'recorder.unanchored', fields); else log.event('info', 'recorder.anchored', fields);
      queue.append({ stream: 'decision', recvMs: now, slot: null, commitment: null, source: 'recorder', payload: { kind: 'recorder_clock', anchored: !unanchoredNow, anchorAgeMs: fields.anchor_age_ms, anchorSlot: a === null ? null : fields.anchor_slot } });
    }
    await guard('active_codes', () => { tickCodes = activeCodes(); if (tickSolUsd === 'pending') tickSolUsd = solUsdCheck()?.result ?? 'pending'; });
    rp.tick();
    const trouble = clockTrouble as { sinceMs: number; alerted: boolean } | null;
    if (trouble !== null && !trouble.alerted && mono - trouble.sinceMs >= CLOCK_ALERT_MS) {
      trouble.alerted = true;
      log.event('critical', 'recorder.clock_suspect', { error_code: 'E_CLOCK', since_ms: Math.round(mono - trouble.sinceMs) });
    }
    // Reads that wait on providers run beside the loop, one at a time each, so a slow provider never delays M07's
    // tick (a late tick would stamp poll counts after their bar's close, Z09-32).
    if (!anchoring && mono - lastAnchorMs >= (chain.ready() && trouble === null ? ANCHOR_EVERY_MS : ANCHOR_RETRY_MS)) {
      lastAnchorMs = mono;
      anchoring = true;
      void chain.refresh().then((ok) => {
        if (ok) lastAgreeMono = p.scheduler.nowMs();
        if (!chain.ready() && !ok && ++anchorTries % 12 === 1) log.event('warn', 'recorder.anchor_waiting', { tries: anchorTries });
      }).finally(() => { anchoring = false; });
    }
    if (!started && chain.ready()) {
      started = true;
      (tracker as PoolTracker<CpPoolState>).start();
      backfill.start();
      log.event('info', 'recorder.started', { release: p.releaseId, providers: rp.labels.join(','), primary: rp.primary });
    }
    if (!venueRefreshing && mono - lastVenueMs >= 60_000) {
      lastVenueMs = mono;
      venueRefreshing = true;
      void guard('venue_config', () => venue.refresh()).finally(() => { venueRefreshing = false; });
    }
    // Z09-32: the queue's tick, the writer's pump (poll counts to M08), then M08's closeDue, with one `now`.
    await guard('queue_tick', () => queue.tick(now));
    await guard('pump', () => writer.pump());
    await guard('next_seq', saveNextSeq);
    await guard('bars', () => { const closed = bars.closeDue(now); if (closed.length > 0) metrics.counter('bars_closed_total', {}).inc(closed.length); barStore.add(closed); });
    if (started) {
      await guard('universe', () => universe.tick());
      if (mono - lastWatchlistMs >= WATCHLIST_EVERY_MS) { lastWatchlistMs = mono; await guard('watchlist', () => watchlist.recompute(universe.candidates())); }
      void guard('sol_usd', () => solUsd.tick(now));
    }
    await guard('venue_recorder', () => venueRecorder.tick(now));
    await guard('daily', () => daily.tick(now));
    if (mono - lastFlushMs >= flushMs) { lastFlushMs = mono; await guard('flush', () => writer.flush()); }
    if (mono - lastDiskMs >= diskMs) { lastDiskMs = mono; await guard('disk', () => { lastDisk = disk.check(); }); }
    if (mono - lastMetricsMs >= METRICS_EVERY_MS) { lastMetricsMs = mono; await guard('metrics', () => sample()); }
    if (mono - lastBarStoreMs >= FLUSH_BAR_STORE_MS) { lastBarStoreMs = mono; await guard('bar_store', () => barStore.flush(now)); }
    metrics.tick();
  }

  let cancel: (() => void) | null = null;
  let stopped = false;
  // One tick a second on the monotonic clock: the next is due 1 s after this one started (never two at once).
  const loop = (delayMs = 1_000): void => {
    if (stopped) return;
    cancel = p.scheduler.set(() => {
      const t0 = p.scheduler.nowMs();
      void tickOnce().finally(() => loop(Math.max(0, 1_000 - (p.scheduler.nowMs() - t0))));
    }, delayMs);
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
        queueDepth: queue.stats().queueDepth, lastTickMs, solUsdCheck: tickSolUsd,
        newestStoredSlot: newestStoredSlot === null ? null : newestStoredSlot.toString(),
        criticalCodes: [...criticalAt].filter(([c, at]) => !STATE_CODES.has(c) && nowMs() - at <= CRITICAL_ACTIVE_MS).map(([c]) => c).sort(),
        activeCodes: [...tickCodes], lastTickMonoMs: lastTickMono, monoMs: p.scheduler.nowMs(), startedMonoMs: startedMono,
        anchorAgeMs: Math.round(p.scheduler.nowMs() - (lastAgreeMono ?? startedMono)),
      }),
      async stop(): Promise<void> {
        if (stopped) return;
        stopped = true;
        cancel?.();
        backfill.stop();
        (tracker as PoolTracker<CpPoolState>).stop();
        rp.clock.stop();
        try { writer.pump(); writer.flush(); } catch { /* a failed final flush is recovered at the next start (crash recovery) */ }
        try { seqsRotated = true; saveNextSeq(); } catch { /* the manifests still hold every seq on disk */ }
        try { barStore.flush(nowMs()); } catch { /* bars are re-derived from the recording */ }
        log.event('info', 'recorder.stopped', { reason: 'signal' });
        db.close();
      },
      parts: {
        db, config, log, metrics, read: rp, chain, queue, writer, disk, tracker: tracker as PoolTracker<CpPoolState>, universe, watchlist, bars, barStore,
        backfill, venue, venueRecorder, evictions, model, tickOnce,
      },
    },
  };
}
