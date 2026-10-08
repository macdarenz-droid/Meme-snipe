// M07 recorder queue (A-M07-01). Producers call append(); it validates, serialises and queues the record and returns
// at once; it never awaits I/O. One writer loop (A-M07-02) calls take(max, segmentId) to drain the queue in append
// order into the segment it is writing, tick() once a second or so for the per-minute poll counts, and drainGaps() for
// its segment manifests.
//
// Bounds (the 6 Oct restart loop and V8 out-of-memory, docs/MIGRATION.md "Bugs left behind"): the queue holds at most
// `queueMax` records and at most `queueMaxBytes` of serialised payload plus a fixed per-record allowance. When either
// is reached, the lowest-priority stream (the end of STREAM_NAMES) loses its newest records first, the incoming one
// included; order_event, fill, universe_manifest, coverage and venue_config are never dropped. Each stream that loses
// records gets a `backpressure` gap and a warning. Every other structure is bounded too: the watched pools (a cap, and
// pools with no poll for a while are unwatched), the work of one tick, gaps per stream, the per-pool poll buckets and
// the encoder's per-segment state.
//
// Sequence numbers are assigned when a record is taken for writing, not when it is appended, so the seq of each stream
// is dense over the records that reach disk (A-M07-02's manifests count firstSeq..lastSeq): a record dropped in the
// queue, or a snapshot the writer finds unchanged, never leaves a hole. Order within a stream is still append order.
//
// Metrics (A-M07-01 "Observability"), read through stats(): recorder_queue_depth = queueDepth;
// recorder_records_total{stream,written} = recordsTotal; recorder_dropped_total{stream} = droppedTotal;
// recorder_gap_seconds_total{stream} = gapSecondsTotal. The log hook receives M07.backpressure (warning).
import { Buffer } from 'node:buffer';
import { canonicalJson, type Commitment, type Slot, type UnixMs } from '@bot/types';
import { SnapshotEncoder, snapshotShapeError, type PoolSnapshotPayload } from './delta.ts';
import { Fifo } from './fifo.ts';
import { isSecretShaped, redactJson } from './redact.ts';
import { PROTECTED_STREAMS, SNAPSHOT_STREAMS, STREAM_NAMES, dropRank, isStreamName, type StreamName } from './streams.ts';

export const MINUTE_MS = 60_000;

/** ARCH M07 / A-M07-01. `stream` is a StreamName; `payload` must serialise with canonicalJson. */
export interface RecordEnvelope {
  stream: string;
  seq: bigint;
  recvMs: UnixMs;
  slot: Slot | null;
  commitment: Commitment | null;
  source: string;
  payload: unknown;
}

export type AppendInput = Omit<RecordEnvelope, 'seq'>;

/** A record ready for the segment writer. `payloadJson` is canonical JSON; snapshots are already keyframes or deltas. */
export interface EncodedRecord {
  stream: StreamName;
  seq: bigint;
  recvMs: UnixMs;
  slot: Slot | null;
  commitment: Commitment | null;
  source: string;
  payloadJson: string;
}

export interface Gap {
  fromMs: UnixMs;
  toMs: UnixMs;
  /**
   * `backpressure`: records dropped (any stream). On `poll_counts` only, for one pool (`poolId`): `clock_step`, minutes
   * whose polls a clock step moved more than one minute, and the minutes they were moved into (rulings 28 and 33);
   * `moved`, the same for a poll that was simply that late, with no clock step (ruling 39). A-M07-03 excludes a gap's
   * minutes from coverage: only that pool's when `poolId` is set, else the whole stream (ruling 40).
   */
  reason: 'backpressure' | 'clock_step' | 'moved';
  /** Set on poll_counts clock_step and moved gaps: the one pool whose minutes the gap covers (rulings 33 and 39). */
  poolId?: string;
}

/** One per watched pool per minute (A-M07-01 logic 3). */
export interface PollCounts {
  poolId: string;
  minuteStartMs: UnixMs;
  successfulPolls: number;
  changedPolls: number;
  failedPolls: number;
  priorityClass: string;
  /**
   * Present only after a pause longer than `pollCatchUpMaxMinutes`: the record then covers this many minutes from
   * `minuteStartMs`, with the counts summed over them, and no per-minute detail. A replay treats those minutes as
   * not observed minute by minute.
   */
  skippedMinutes?: number;
  /**
   * Present only when some of the counts were stamped in the minute before `minuteStartMs` and arrived after it was
   * written (ruling 33): how many, and that minute. A move of one minute gets no gap; a longer one gets a clock_step gap.
   */
  latePolls?: number;
  lateFromMinuteStartMs?: UnixMs;
}

export interface RecorderQueueConfig {
  /** `recorder.queue_max`: records, default 50,000, 1,000-500,000. */
  queueMax: number;
  /** `recorder.record_max_bytes`: serialised payload bytes, default 65,536. */
  recordMaxBytes: number;
  /**
   * Serialised bytes the queue may hold (payloads plus RECORD_OVERHEAD_BYTES each). Not in the ticket: 50,000 records
   * at the 64 KB cap would be 3.2 GB on a 2 GB host, so a count bound alone does not bound memory. Default 64 MiB.
   */
  queueMaxBytes: number;
  /** A drop this close (by recvMs) after a stream's last gap extends that gap instead of starting a new one. */
  gapMergeMs: number;
  /**
   * Pools watched for poll counts at once. At the cap a new pool takes the place of the idle watched pool with the
   * oldest last poll (idle: no poll for max(60 s, 3 x its poll interval), never a position pool); only when no watched
   * pool is idle is the new one refused (`E_POOL_CAP`, counted). `pool_snapshot_position` records are never refused and may take the set past the
   * cap. Default 60: M05's `max_watched` of 30 (ARCH.md:1007) plus up to 30 eviction-tail pools (ARCH.md:1027).
   * Range 1-10,000.
   */
  maxWatchedPools: number;
  /**
   * The slowest poll interval any watched pool has, used to judge idleness at the cap when the queue has not yet seen
   * two polls of a pool. Default 10,000 ms: the eviction tail's 0.1 Hz (ARCH.md:1027). Range 1,000-3,600,000.
   */
  slowestPollIntervalMs: number;
  /**
   * No producer record for more than this many minutes while tick() keeps a steady clock is an outage, logged as
   * `M07.outage` once per episode and counted apart from clock steps (ruling 29). Default 5: 30 missed polls of the
   * slowest (0.1 Hz) pool. Range 1-1,440.
   */
  outageMinutes: number;
  /**
   * A watched pool with no poll for more than this many minutes is unwatched by tick(). Default 10: the slowest poll
   * the design has is the eviction tail's 0.1 Hz, one poll every 10 s (ARCH.md:1027), so 10 minutes is 60 missed tail
   * polls. Range 1-1,440.
   */
  idleUnwatchMinutes: number;
  /**
   * Minutes one tick writes per pool one by one; a longer pause is written as one record per pool with
   * `skippedMinutes`. Default 10, so one tick writes at most maxWatchedPools x 10 = 600 records by default (1.2% of
   * queue_max). Range 1-1,440.
   */
  pollCatchUpMaxMinutes: number;
}

export const DEFAULT_CONFIG: RecorderQueueConfig = {
  queueMax: 50_000,
  recordMaxBytes: 65_536,
  queueMaxBytes: 64 * 1024 * 1024,
  gapMergeMs: 1_000,
  maxWatchedPools: 60,
  slowestPollIntervalMs: 10_000,
  outageMinutes: 5,
  idleUnwatchMinutes: 10,
  pollCatchUpMaxMinutes: 10,
};

/** Bytes counted per queued record on top of its payload and source: the envelope object and the queue slot. */
export const RECORD_OVERHEAD_BYTES = 256;
/** Longest `source` accepted, in UTF-8 bytes; a longer one is refused with E_ENVELOPE. */
export const SOURCE_MAX_BYTES = 256;
/** Closed gaps kept per stream before the oldest two are merged (which only widens a gap, never hides one). */
export const GAPS_MAX_PER_STREAM = 1_024;
/**
 * Forgotten pools whose flushed-up-to minute is kept when no tick has covered it yet (ruling 24). Normally a handful a
 * minute; the cap only matters if tick() stops while pools keep being unwatched.
 */
export const FLUSHED_UNTIL_MAX = 4_096;
/** A tick or unwatch time this many minutes past the newest received minute is a clock step (ruling 25). */
export const CLOCK_STEP_MINUTES = 2;
/** A pool is never idle at the cap sooner than this after its last poll (ruling 17). */
export const IDLE_MIN_MS = 60_000;

export type RejectCode = 'E_STREAM' | 'E_ENVELOPE' | 'E_PAYLOAD' | 'E_TOO_LARGE' | 'E_POOL_CAP';
export type AppendResult = 'queued' | 'unchanged' | 'dropped' | { rejected: RejectCode };
export type LogLevel = 'warning' | 'error' | 'critical';
export type LogFn = (level: LogLevel, code: string, fields: Record<string, string | number>) => void;

export class RecorderError extends Error {
  readonly code: 'E_QUEUE_FULL' | 'E_CONFIG';

  constructor(code: 'E_QUEUE_FULL' | 'E_CONFIG', message: string) {
    super(message);
    this.code = code;
  }
}

export interface RecorderStats {
  queueDepth: number;
  queueBytes: number;
  /** Highest depth and bytes ever reached, so a test can prove the bound held at every append. */
  peakDepth: number;
  peakBytes: number;
  recordsTotal: Record<StreamName, { written: number; notWritten: number }>;
  droppedTotal: Record<StreamName, number>;
  gapSecondsTotal: Record<StreamName, number>;
  rejectedTotal: Record<RejectCode, number>;
  redactedTotal: number;
  latePolls: number;
  skewedPolls: number;
  /** Minutes written as part of a `skippedMinutes` record instead of one by one. */
  skippedPollMinutes: number;
  /** Pools unwatched by tick() after idleUnwatchMinutes with no poll. */
  idleUnwatched: number;
  /**
   * Clock-step episodes (rulings 25, 27-29), each logged once as `M07.clock_step`: a tick or unwatch time, or a
   * producer recvMs, more than CLOCK_STEP_MINUTES ahead; or a producer recvMs that far behind the tick minute.
   */
  clockSteps: number;
  /** Outage episodes (ruling 29): no producer record for more than outageMinutes while the tick clock is steady. */
  outages: number;
  /** Polls counted more than one minute from their own minute; each marks at most two pool-minutes with a gap. */
  movedPolls: number;
  /** The newest minute of an accepted producer recvMs, or null before the first. */
  maxRecvMinute: number | null;
  /** Idle pools that made way for a new pool at the cap. */
  capUnwatched: number;
  watchedPools: number;
  acceptedHashes: number;
  /** Entries held in the forgotten pools' flushed-up-to map (bounded by FLUSHED_UNTIL_MAX). */
  flushedUntilHeld: number;
  encoderStates: number;
  gapsHeld: number;
}

interface Item {
  stream: StreamName;
  order: number;
  recvMs: UnixMs;
  slot: Slot | null;
  commitment: Commitment | null;
  source: string;
  json: string;
  bytes: number;
  poolId: string | null;
  /** Stream, priority class and rawHash of a snapshot (what "changed" compares), else null. */
  signature: string | null;
}

interface Bucket {
  successful: number;
  changed: number;
  failed: number;
  /** Polls counted here that were stamped in the minute before (moved by one minute, ruling 33). */
  late: number;
}

interface WatchedPool {
  priorityClass: string;
  nextMinute: number;
  /** Latest of the watch time and every poll's recvMs: idleness is measured from here. */
  seenMs: number;
  /** recvMs of the last poll, if any. */
  lastPollMs: number | null;
  /** The gap between the last two polls: the pool's own poll interval as far as the queue knows it. */
  intervalMs: number | null;
  /** True while the pool's last poll was a position poll (pool_snapshot_position, or a failed poll marked position). */
  position: boolean;
  /**
   * rawHash of the last successful poll in this watch. changedPolls counts a poll as changed only when there is one
   * and it differs: "changed" needs two hashes (ruling 18).
   */
  lastRawHash: string | null;
  buckets: Map<number, Bucket>;
}

const COMMITMENTS: ReadonlySet<unknown> = new Set(['processed', 'confirmed', 'finalized']);

/** A producer time judged against the queue's clocks: `effMs` is where its poll is counted. */
interface Clocked {
  status: 'ok' | 'ahead' | 'behind';
  effMs: number;
}

function maxOf(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}

function perStream<T>(make: () => T): Record<StreamName, T> {
  const o = {} as Record<StreamName, T>;
  for (const s of STREAM_NAMES) o[s] = make();
  return o;
}

export class RecorderQueue {
  private readonly cfg: RecorderQueueConfig;
  private readonly log: LogFn;
  private readonly queues = perStream(() => new Fifo<Item>());
  private readonly nextSeq: Record<StreamName, bigint>;
  private readonly encoder = new SnapshotEncoder();
  private nextOrder = 0;
  private depth = 0;
  private bytes = 0;

  /**
   * Per pool, the stream, priority class and rawHash of the newest snapshot accepted into the queue or written;
   * drives change-only appends. Held only for watched pools.
   */
  private readonly lastAccepted = new Map<string, string>();
  private readonly watched = new Map<string, WatchedPool>();
  /** Pools forgotten within the current minute: the minute their poll counts were written up to (ruling 18). */
  private readonly flushedUntil = new Map<string, number>();
  /**
   * The highest flushed-up-to minute of any entry dropped from `flushedUntil` by its cap: a new watch never starts
   * before it, so dropping an entry can make a poll count as late but never writes a (pool, minute) twice (ruling 24).
   */
  private flushedFloor: number | null = null;
  /**
   * The minute of the latest tick(): every minute before it may already be written for some pool, so a new watch
   * never starts before it (ruling 22). Null before the first tick.
   */
  private lastTickMinute: number | null = null;
  /**
   * The newest minute of any recvMs appended by a producer (snapshots, failed polls, every other record; not the
   * queue's own poll_counts). No flush, no tick minute and no floor ever passes maxRecvMinute + 1, so one wrong
   * forward time on tick() or unwatch() cannot stop new pools' per-minute counts (ruling 25).
   */
  private maxRecvMinute: number | null = null;
  /** True while the queue appends its own poll_counts, which must not move maxRecvMinute. */
  private emitting = false;
  /** The minute of the latest tick's own time, uncapped: the writer's clock (ruling 27). Null before the first tick. */
  private lastTickRawMinute: number | null = null;
  /**
   * True while the tick clock can be trusted (rulings 35 and 37): the latest tick moved at most CLOCK_STEP_MINUTES from
   * the one before, and the chain of such steady ticks either began within CLOCK_STEP_MINUTES of maxRecvMinute (a real
   * outage: the clock moved on steadily from where the data stopped) or has itself lasted more than
   * CLOCK_STEP_MINUTES (a lasting clock change). A jump followed by a tick or two right after it is neither.
   */
  private tickSteady = false;
  /** The minute the current chain of steady ticks began, and whether it began near maxRecvMinute. */
  private tickChainStart: number | null = null;
  private tickChainAnchored = false;
  /** Open episodes, so each is counted and logged once (ruling 29). */
  private readonly episode = { tickAhead: false, recvAhead: false, recvBehind: false, outage: false };
  /**
   * maxRecvMinute when each episode last saw a skewed time, or for an outage the last tick more than outageMinutes
   * ahead: it closes CLOCK_STEP_MINUTES after that (rulings 34 and 41).
   */
  private readonly episodeLast = { tickAhead: 0, recvAhead: 0, recvBehind: 0, outage: 0 };
  /** clock_step and late gaps on poll_counts, by minute (rulings 28 and 30). */
  private pollGaps: Gap[] = [];

  private readonly openGaps = new Map<StreamName, { fromMs: number; toMs: number }>();
  private readonly closedGaps = perStream<Gap[]>(() => []);
  private readonly loggedRejects = new Set<string>();

  private readonly s: RecorderStats;

  constructor(opts: { config?: Partial<RecorderQueueConfig>; firstSeq?: Partial<Record<StreamName, bigint>>; log?: LogFn } = {}) {
    this.cfg = { ...DEFAULT_CONFIG, ...opts.config };
    const c = this.cfg;
    if (!Number.isInteger(c.queueMax) || c.queueMax < 1_000 || c.queueMax > 500_000) {
      throw new RecorderError('E_CONFIG', 'recorder.queue_max must be an integer from 1,000 to 500,000');
    }
    if (!Number.isInteger(c.recordMaxBytes) || c.recordMaxBytes < 1) throw new RecorderError('E_CONFIG', 'recorder.record_max_bytes must be a positive integer');
    if (!Number.isInteger(c.queueMaxBytes) || c.queueMaxBytes < c.recordMaxBytes + RECORD_OVERHEAD_BYTES) {
      throw new RecorderError('E_CONFIG', 'queueMaxBytes must hold at least one record of record_max_bytes');
    }
    if (!Number.isFinite(c.gapMergeMs) || c.gapMergeMs < 0) throw new RecorderError('E_CONFIG', 'gapMergeMs must be a finite number from 0');
    const intIn = (v: number, lo: number, hi: number): boolean => Number.isInteger(v) && v >= lo && v <= hi;
    if (!intIn(c.maxWatchedPools, 1, 10_000)) throw new RecorderError('E_CONFIG', 'maxWatchedPools must be an integer from 1 to 10,000');
    if (!intIn(c.slowestPollIntervalMs, 1_000, 3_600_000)) throw new RecorderError('E_CONFIG', 'slowestPollIntervalMs must be an integer from 1,000 to 3,600,000');
    if (!intIn(c.outageMinutes, 1, 1_440)) throw new RecorderError('E_CONFIG', 'outageMinutes must be an integer from 1 to 1,440');
    if (!intIn(c.idleUnwatchMinutes, 1, 1_440)) throw new RecorderError('E_CONFIG', 'idleUnwatchMinutes must be an integer from 1 to 1,440');
    if (!intIn(c.pollCatchUpMaxMinutes, 1, 1_440)) throw new RecorderError('E_CONFIG', 'pollCatchUpMaxMinutes must be an integer from 1 to 1,440');
    this.nextSeq = perStream(() => 0n);
    for (const [stream, seq] of Object.entries(opts.firstSeq ?? {})) {
      if (!isStreamName(stream) || typeof seq !== 'bigint' || seq < 0n) throw new RecorderError('E_CONFIG', 'firstSeq must map stream names to bigints from 0');
      this.nextSeq[stream] = seq;
    }
    this.log = opts.log ?? (() => undefined);
    this.s = {
      queueDepth: 0,
      queueBytes: 0,
      peakDepth: 0,
      peakBytes: 0,
      recordsTotal: perStream(() => ({ written: 0, notWritten: 0 })),
      droppedTotal: perStream(() => 0),
      gapSecondsTotal: perStream(() => 0),
      rejectedTotal: { E_STREAM: 0, E_ENVELOPE: 0, E_PAYLOAD: 0, E_TOO_LARGE: 0, E_POOL_CAP: 0 },
      redactedTotal: 0,
      latePolls: 0,
      skewedPolls: 0,
      skippedPollMinutes: 0,
      idleUnwatched: 0,
      capUnwatched: 0,
      clockSteps: 0,
      outages: 0,
      movedPolls: 0,
      maxRecvMinute: null,
      watchedPools: 0,
      acceptedHashes: 0,
      flushedUntilHeld: 0,
      encoderStates: 0,
      gapsHeld: 0,
    };
  }

  /**
   * Non-blocking. Callers may ignore the result; a thrown E_QUEUE_FULL must not be ignored. It is thrown only for a
   * record of a never-dropped stream when the queue already holds nothing but never-dropped records: such a record is
   * refused loudly, never lost silently, and the queue never grows past its bound. The caller treats it as a failed
   * record: fail closed, block new entries, alert (B-M19-02).
   */
  append(e: AppendInput): AppendResult {
    const stream = e.stream;
    if (!isStreamName(stream)) return this.reject('unknown', 'E_STREAM', 'unknown stream');
    if (typeof e.recvMs !== 'number' || !Number.isFinite(e.recvMs)
      || !(e.slot === null || (typeof e.slot === 'bigint' && e.slot >= 0n))
      || !(e.commitment === null || COMMITMENTS.has(e.commitment))
      || typeof e.source !== 'string') {
      return this.reject(stream, 'E_ENVELOPE', 'envelope field of the wrong type');
    }
    const sourceBytes = Buffer.byteLength(e.source, 'utf8');
    if (sourceBytes > SOURCE_MAX_BYTES) return this.reject(stream, 'E_ENVELOPE', 'source over 256 bytes');
    const snapshot = SNAPSHOT_STREAMS.has(stream);
    if (snapshot) {
      const why = snapshotShapeError(e.payload);
      if (why !== null) return this.reject(stream, 'E_PAYLOAD', why);
    }
    let json: string;
    try {
      json = canonicalJson(e.payload);
    } catch {
      return this.reject(stream, 'E_PAYLOAD', 'payload does not serialise to JSON');
    }
    const red = redactJson(json);
    if (red.collision) return this.reject(stream, 'E_PAYLOAD', 'redaction key collision');
    json = red.json;
    let source = e.source;
    if (isSecretShaped(source)) {
      source = '[redacted]';
      this.s.redactedTotal++;
    }
    this.s.redactedTotal += red.redacted;
    const payloadBytes = Buffer.byteLength(json, 'utf8');
    if (payloadBytes > this.cfg.recordMaxBytes) return this.reject(stream, 'E_TOO_LARGE', 'payload over recorder.record_max_bytes');
    // A producer's time moves maxRecvMinute only once its record is accepted (ruling 27); a snapshot's after its pool
    // is admitted. The queue's own poll_counts never move it.
    const clock = this.classify(e.recvMs);
    if (!snapshot && !this.emitting) this.commitRecv(clock, e.recvMs);

    let poolId: string | null = null;
    let signature: string | null = null;
    if (snapshot) {
      const p = e.payload as PoolSnapshotPayload;
      poolId = p.poolId;
      // A new stream or priority class with the same rawHash is a change too (review round 1, red team m3).
      signature = `${stream}\u0000${p.priorityClass}\u0000${p.rawHash}`;
      const unchanged = this.lastAccepted.get(poolId) === signature;
      // A position pool is never refused (ruling 12): it may take the watched set past the cap.
      const position = stream === 'pool_snapshot_position';
      const w = this.admit(poolId, p.priorityClass, clock.effMs, position);
      if (w === null) return this.reject(stream, 'E_POOL_CAP', 'watched pool cap reached');
      this.commitRecv(clock, e.recvMs);
      // changedPolls counts a change of state only, not of stream or class (ruling 15), and needs a previous hash in
      // this watch (ruling 18).
      const changed = w.lastRawHash !== null && w.lastRawHash !== p.rawHash;
      w.lastRawHash = p.rawHash;
      this.countPoll(poolId, w, p.priorityClass, e.recvMs, clock, changed ? 'changed' : 'successful', position);
      if (unchanged) {
        this.s.recordsTotal[stream].notWritten++;
        return 'unchanged';
      }
    }

    const bytes = payloadBytes + Buffer.byteLength(source, 'utf8') + RECORD_OVERHEAD_BYTES;
    const item: Item = { stream, order: this.nextOrder++, recvMs: e.recvMs, slot: e.slot, commitment: e.commitment, source, json, bytes, poolId, signature };
    if (!this.makeRoom(item)) {
      this.onDrop(stream, e.recvMs);
      return 'dropped';
    }
    this.queues[stream].push(item);
    this.depth++;
    this.bytes += item.bytes;
    if (this.depth > this.s.peakDepth) this.s.peakDepth = this.depth;
    if (this.bytes > this.s.peakBytes) this.s.peakBytes = this.bytes;
    if (poolId !== null && signature !== null) this.lastAccepted.set(poolId, signature);
    this.closeGap(stream);
    return 'queued';
  }

  /**
   * A poll of a watched pool that failed (A-M07-01 logic 3, `failedPolls`). `position` (required, ruling 23) marks a
   * poll of a pool with an open position (M04's position class): such a pool is always admitted, past the cap (ruling
   * 19). A failed poll never clears a pool's position mark; only a successful non-position poll does. False when the
   * pool is new, not a position pool, and no watched pool is idle (counted as E_POOL_CAP).
   */
  notePollFailed(poolId: string, priorityClass: string, recvMs: UnixMs, position: boolean): boolean {
    const clock = this.classify(recvMs);
    const w = this.admit(poolId, priorityClass, clock.effMs, position);
    if (w === null) {
      this.reject('poll_counts', 'E_POOL_CAP', 'watched pool cap reached');
      return false;
    }
    this.commitRecv(clock, recvMs);
    this.countPoll(poolId, w, priorityClass, recvMs, clock, 'failed', position);
    return true;
  }

  /**
   * Starts the per-minute poll counts for a pool from the minute of `nowMs`. A pool is also watched from its first
   * snapshot or failed poll. False when the pool is new and no watched pool is idle (counted as E_POOL_CAP).
   */
  watch(poolId: string, priorityClass: string, nowMs: UnixMs): boolean {
    const w = this.admit(poolId, priorityClass, this.classify(nowMs).effMs, false);
    if (w === null) {
      this.reject('poll_counts', 'E_POOL_CAP', 'watched pool cap reached');
      return false;
    }
    w.priorityClass = priorityClass;
    return true;
  }

  /**
   * Stops watching a pool: emits its poll counts up to and including the minute of `nowMs` (the last one partial) and
   * forgets the pool, so its next snapshot is written again as a change.
   */
  unwatch(poolId: string, nowMs: UnixMs): void {
    const raw = Math.floor(nowMs / MINUTE_MS);
    const ref = maxOf(this.maxRecvMinute, this.tickSteady ? this.lastTickRawMinute : null);
    if (ref !== null && raw - ref > CLOCK_STEP_MINUTES) this.openEpisode('tickAhead', { direction: 'forward', from: 'unwatch', minutes: raw - ref });
    const w = this.watched.get(poolId);
    if (w !== undefined) this.flushPool(poolId, w, this.capMinute(raw + 1), nowMs);
    this.forget(poolId, nowMs);
  }

  /**
   * Emits `poll_counts` for every whole minute before `nowMs` not yet emitted, for every watched pool, then unwatches
   * pools with no poll for more than idleUnwatchMinutes. Work is bounded: at most pollCatchUpMaxMinutes records per
   * pool, or one `skippedMinutes` record after a longer pause.
   */
  tick(nowMs: UnixMs): void {
    const raw = Math.floor(nowMs / MINUTE_MS);
    const prevRaw = this.lastTickRawMinute;
    this.lastTickRawMinute = raw;
    const stepOk = prevRaw !== null && Math.abs(raw - prevRaw) <= CLOCK_STEP_MINUTES;
    if (!stepOk || this.tickChainStart === null) {
      this.tickChainStart = raw;
      this.tickChainAnchored = this.maxRecvMinute === null || Math.abs(raw - this.maxRecvMinute) <= CLOCK_STEP_MINUTES;
    }
    this.tickSteady = stepOk && (this.tickChainAnchored || raw - this.tickChainStart > CLOCK_STEP_MINUTES);
    // A tick before any record has nothing to write and must not set the tick minute from an unchecked clock.
    if (this.maxRecvMinute === null) return;
    const ahead = raw - this.maxRecvMinute;
    // An outage closes once the tick clock is back within outageMinutes of the data (ruling 41).
    if (ahead <= this.cfg.outageMinutes) this.episode.outage = false;
    if (ahead <= CLOCK_STEP_MINUTES) {
      this.closeIfQuiet('tickAhead');
    } else if (prevRaw === null || raw - prevRaw > CLOCK_STEP_MINUTES) {
      // The tick clock itself jumped: a clock step.
      this.openEpisode('tickAhead', { direction: 'forward', from: 'tick', minutes: ahead });
    } else if (ahead > this.cfg.outageMinutes) {
      // A steady tick clock and no producer record: an outage, not a clock step (ruling 29). Each such tick keeps the
      // episode open, so a tick clock running ahead of a live feed is one episode, not one per record (ruling 41).
      this.episodeLast.outage = this.maxRecvMinute;
      if (!this.episode.outage) {
        this.episode.outage = true;
        this.s.outages++;
        this.log('warning', 'M07.outage', { silentMinutes: ahead });
      }
    }
    const nowMinute = this.capMinute(raw);
    this.lastTickMinute = this.lastTickMinute === null ? nowMinute : Math.max(this.lastTickMinute, nowMinute);
    for (const [poolId, w] of this.watched) {
      this.flushPool(poolId, w, nowMinute, nowMs);
      if (nowMinute - Math.floor(w.seenMs / MINUTE_MS) > this.cfg.idleUnwatchMinutes) {
        this.forget(poolId, nowMs);
        this.s.idleUnwatched++;
      }
    }
    // A forgotten pool's flushed-up-to minute matters only until the last tick's minute covers it.
    for (const [poolId, m] of this.flushedUntil) if (m <= nowMinute) this.flushedUntil.delete(poolId);
  }

  /**
   * Judges a producer time against the newest accepted minute and the tick clock (rulings 27, 28 and 35), without
   * changing anything. `ahead`: more than CLOCK_STEP_MINUTES past max(maxRecvMinute, lastTickMinute, and the latest
   * tick's own minute while ticks move steadily); the poll is counted in that base minute (`effMs`) and maxRecvMinute
   * does not move. `behind`: more than CLOCK_STEP_MINUTES before lastTickMinute. A steady tick clock is in the base so
   * that the feed's first record after a real outage is taken; a tick that jumped is not, so one bad tick cannot let
   * a bad record through.
   */
  private classify(recvMs: number): Clocked {
    const m = Math.floor(recvMs / MINUTE_MS);
    const base = maxOf(maxOf(this.maxRecvMinute, this.tickSteady ? this.lastTickRawMinute : null), this.lastTickMinute);
    if (base !== null && m > base + CLOCK_STEP_MINUTES) return { status: 'ahead', effMs: (base + 1) * MINUTE_MS - 1 };
    if (this.lastTickMinute !== null && m < this.lastTickMinute - CLOCK_STEP_MINUTES) return { status: 'behind', effMs: recvMs };
    return { status: 'ok', effMs: recvMs };
  }

  /** Applies an accepted producer time: moves maxRecvMinute, and opens or closes clock-step and outage episodes. */
  private commitRecv(c: Clocked, recvMs: number): void {
    if (c.status === 'ahead') {
      this.openEpisode('recvAhead', { direction: 'forward', from: 'recv', minutes: Math.floor(recvMs / MINUTE_MS) - Math.floor(c.effMs / MINUTE_MS) });
      return;
    }
    if (c.status === 'behind') {
      this.openEpisode('recvBehind', { direction: 'backward', from: 'recv', minutes: (this.lastTickMinute ?? 0) - Math.floor(recvMs / MINUTE_MS) });
      return;
    }
    const m = Math.floor(recvMs / MINUTE_MS);
    if (this.maxRecvMinute === null || m > this.maxRecvMinute) this.maxRecvMinute = m;
    this.closeIfQuiet('outage');
    this.closeIfQuiet('recvAhead');
    this.closeIfQuiet('recvBehind');
  }

  /**
   * Counts and logs a clock-step episode once, at its start (ruling 29); every skewed time keeps it open, so a
   * steady skewed source or alternating bad ticks stay one episode (rulings 34 and 35).
   */
  private openEpisode(kind: 'tickAhead' | 'recvAhead' | 'recvBehind', fields: Record<string, string | number>): void {
    this.episodeLast[kind] = this.maxRecvMinute ?? 0;
    if (this.episode[kind]) return;
    this.episode[kind] = true;
    this.s.clockSteps++;
    this.log('warning', 'M07.clock_step', fields);
  }

  /**
   * Closes an episode once CLOCK_STEP_MINUTES of received data have passed with no skewed time from its source (for an
   * outage: no tick more than outageMinutes ahead). A single accepted record does not close it (ruling 41).
   */
  private closeIfQuiet(kind: 'tickAhead' | 'recvAhead' | 'recvBehind' | 'outage'): void {
    if (this.episode[kind] && (this.maxRecvMinute ?? 0) - this.episodeLast[kind] > CLOCK_STEP_MINUTES) this.episode[kind] = false;
  }

  /** A flush or tick minute, never past maxRecvMinute + 1 (ruling 25). */
  private capMinute(minute: number): number {
    return this.maxRecvMinute === null ? minute : Math.min(minute, this.maxRecvMinute + 1);
  }

  /**
   * Marks one pool's minute of poll_counts with a gap (rulings 33 and 39): a minute whose polls were moved more than
   * one minute, or that received them. Merged with an overlapping or adjacent gap of the same pool and reason; the list
   * is capped like the backpressure gaps (the oldest two merge, which only widens a gap).
   */
  private addPollGap(poolId: string, minute: number, reason: 'clock_step' | 'moved'): void {
    const fromMs = minute * MINUTE_MS;
    const toMs = fromMs + MINUTE_MS - 1;
    for (let i = this.pollGaps.length - 1; i >= Math.max(0, this.pollGaps.length - 8); i--) {
      const g = this.pollGaps[i] as Gap;
      if (g.poolId === poolId && g.reason === reason && fromMs <= g.toMs + 1 && toMs >= g.fromMs - 1) {
        this.pollGaps[i] = { fromMs: Math.min(g.fromMs, fromMs), toMs: Math.max(g.toMs, toMs), reason, poolId };
        return;
      }
    }
    this.pollGaps.push({ fromMs, toMs, reason, poolId });
    if (this.pollGaps.length > GAPS_MAX_PER_STREAM) {
      const a = this.pollGaps.shift() as Gap;
      const b = this.pollGaps[0] as Gap;
      const merged: Gap = { fromMs: Math.min(a.fromMs, b.fromMs), toMs: Math.max(a.toMs, b.toMs), reason: a.reason === 'moved' && b.reason === 'moved' ? 'moved' : 'clock_step' };
      // Two pools' gaps merged cover every pool, which only widens the exclusion.
      if (a.poolId !== undefined && a.poolId === b.poolId) merged.poolId = a.poolId;
      this.pollGaps[0] = merged;
    }
  }

  /** The minute every new watch starts at or after, whatever its pool: the last tick's minute and the cap's floor. */
  private coveredMinute(): number | null {
    if (this.lastTickMinute === null) return this.flushedFloor;
    if (this.flushedFloor === null) return this.lastTickMinute;
    return Math.max(this.lastTickMinute, this.flushedFloor);
  }

  /**
   * Keeps `flushedUntil` bounded without a tick (ruling 24). Entries are dropped from the oldest while the covered
   * minute already covers them; past FLUSHED_UNTIL_MAX the oldest are dropped anyway, raising `flushedFloor` to their
   * minute. Never judged by the minute of the call's own time: a poll appended late can carry an older recvMs, which
   * is ruling 22's race.
   */
  private pruneFlushed(): void {
    const covered = this.coveredMinute();
    for (const [poolId, m] of this.flushedUntil) {
      if (covered === null || m > covered) break;
      this.flushedUntil.delete(poolId);
    }
    while (this.flushedUntil.size > FLUSHED_UNTIL_MAX) {
      const [poolId, m] = this.flushedUntil.entries().next().value as [string, number];
      this.flushedUntil.delete(poolId);
      this.flushedFloor = this.flushedFloor === null ? m : Math.max(this.flushedFloor, m);
    }
  }

  /**
   * Takes up to `max` records in append order for the segment `segmentId` (A-M07-02 names it), with seq assigned and
   * snapshots encoded. When `segmentId` differs from the last call's, the first record of every pool is a keyframe.
   */
  take(max: number, segmentId: string): EncodedRecord[] {
    if (typeof segmentId !== 'string' || segmentId === '') throw new RecorderError('E_CONFIG', 'take needs a segment id');
    const out: EncodedRecord[] = [];
    while (out.length < max && this.depth > 0) {
      let best: Fifo<Item> | null = null;
      let bestOrder = Infinity;
      for (const s of STREAM_NAMES) {
        const head = this.queues[s].peekFront();
        if (head !== undefined && head.order < bestOrder) {
          bestOrder = head.order;
          best = this.queues[s];
        }
      }
      const item = (best as Fifo<Item>).popFront() as Item;
      this.depth--;
      this.bytes -= item.bytes;
      let payloadJson = item.json;
      if (SNAPSHOT_STREAMS.has(item.stream)) {
        const enc = this.encoder.encode(item.stream, segmentId, JSON.parse(item.json) as PoolSnapshotPayload);
        if (enc === null) {
          this.s.recordsTotal[item.stream].notWritten++;
          continue;
        }
        payloadJson = canonicalJson(enc);
      }
      const seq = this.nextSeq[item.stream];
      this.nextSeq[item.stream] = seq + 1n;
      this.s.recordsTotal[item.stream].written++;
      out.push({ stream: item.stream, seq, recvMs: item.recvMs, slot: item.slot, commitment: item.commitment, source: item.source, payloadJson });
    }
    return out;
  }

  /** The seq the next written record of `stream` gets; A-M07-02 stores `lastSeq` in manifests from this. */
  peekNextSeq(stream: StreamName): bigint {
    return this.nextSeq[stream];
  }

  /**
   * The gaps per stream since the last call: backpressure on any stream, and clock_step and late on poll_counts. A gap still open is reported as it stands and stays open, so
   * the next call may report it again with a later `toMs`: a manifest may overstate a gap, never understate one.
   */
  drainGaps(): Partial<Record<StreamName, Gap[]>> {
    const out: Partial<Record<StreamName, Gap[]>> = {};
    for (const s of STREAM_NAMES) {
      const list = this.closedGaps[s];
      const open = this.openGaps.get(s);
      if (list.length === 0 && open === undefined) continue;
      out[s] = open === undefined ? list : [...list, { fromMs: open.fromMs, toMs: open.toMs, reason: 'backpressure' }];
      this.closedGaps[s] = [];
    }
    if (this.pollGaps.length > 0) {
      out.poll_counts = [...(out.poll_counts ?? []), ...this.pollGaps];
      this.pollGaps = [];
    }
    return out;
  }

  stats(): RecorderStats {
    let gaps = this.openGaps.size;
    for (const s of STREAM_NAMES) gaps += this.closedGaps[s].length;
    return structuredClone({
      ...this.s,
      queueDepth: this.depth,
      queueBytes: this.bytes,
      watchedPools: this.watched.size,
      acceptedHashes: this.lastAccepted.size,
      flushedUntilHeld: this.flushedUntil.size,
      maxRecvMinute: this.maxRecvMinute,
      encoderStates: this.encoder.size(),
      gapsHeld: gaps,
    });
  }

  // --- internals ---

  private reject(stream: string, code: RejectCode, why: string): AppendResult {
    this.s.rejectedTotal[code]++;
    // One log line per stream and code: a producer bug must not flood the log.
    const key = `${isStreamName(stream) ? stream : 'unknown'}:${code}`;
    if (!this.loggedRejects.has(key)) {
      this.loggedRejects.add(key);
      this.log('error', 'M07.rejected', { stream: isStreamName(stream) ? stream : 'unknown', code, why });
    }
    return { rejected: code };
  }

  /** Frees room for `item`, dropping lower-priority records first. False when `item` itself is the one to drop. */
  private makeRoom(item: Item): boolean {
    const incomingRank = dropRank(item.stream);
    const incomingProtected = PROTECTED_STREAMS.has(item.stream);
    while (this.depth + 1 > this.cfg.queueMax || this.bytes + item.bytes > this.cfg.queueMaxBytes) {
      const victim = this.lowestDroppable();
      if (!incomingProtected && (victim === null || incomingRank >= dropRank(victim))) return false;
      if (victim === null) {
        this.log('critical', 'M07.queue_full', { stream: item.stream });
        throw new RecorderError('E_QUEUE_FULL', `queue full of never-dropped records; ${item.stream} refused`);
      }
      const gone = this.queues[victim].popBack() as Item;
      this.depth--;
      this.bytes -= gone.bytes;
      if (gone.poolId !== null && this.lastAccepted.get(gone.poolId) === gone.signature) this.lastAccepted.delete(gone.poolId);
      this.onDrop(victim, gone.recvMs);
    }
    return true;
  }

  private lowestDroppable(): StreamName | null {
    for (let i = STREAM_NAMES.length - 1; i >= 0; i--) {
      const s = STREAM_NAMES[i] as StreamName;
      if (PROTECTED_STREAMS.has(s)) return null;
      if (this.queues[s].length > 0) return s;
    }
    return null;
  }

  private onDrop(stream: StreamName, recvMs: number): void {
    this.s.droppedTotal[stream]++;
    const open = this.openGaps.get(stream);
    if (open !== undefined) {
      open.fromMs = Math.min(open.fromMs, recvMs);
      open.toMs = Math.max(open.toMs, recvMs);
      return;
    }
    const list = this.closedGaps[stream];
    const last = list[list.length - 1];
    if (last !== undefined && recvMs >= last.fromMs - this.cfg.gapMergeMs && recvMs <= last.toMs + this.cfg.gapMergeMs) {
      // Close to the last gap: reopen it, so a sustained overload stays one gap instead of thousands.
      list.pop();
      this.s.gapSecondsTotal[stream] -= (last.toMs - last.fromMs) / 1000;
      this.openGaps.set(stream, { fromMs: Math.min(last.fromMs, recvMs), toMs: Math.max(last.toMs, recvMs) });
      return;
    }
    this.openGaps.set(stream, { fromMs: recvMs, toMs: recvMs });
    this.log('warning', 'M07.backpressure', { stream, depth: this.depth, bytes: this.bytes });
  }

  /** A record of `stream` was accepted after drops: the stream's open gap ends. */
  private closeGap(stream: StreamName): void {
    const open = this.openGaps.get(stream);
    if (open === undefined) return;
    this.openGaps.delete(stream);
    const list = this.closedGaps[stream];
    list.push({ fromMs: open.fromMs, toMs: open.toMs, reason: 'backpressure' });
    this.s.gapSecondsTotal[stream] += (open.toMs - open.fromMs) / 1000;
    if (list.length > GAPS_MAX_PER_STREAM) {
      const a = list.shift() as Gap;
      const b = list[0] as Gap;
      const merged: Gap = { fromMs: Math.min(a.fromMs, b.fromMs), toMs: Math.max(a.toMs, b.toMs), reason: 'backpressure' };
      list[0] = merged;
      // The total stays the sum of the gaps held and drained: the merged gap replaces the two it came from.
      this.s.gapSecondsTotal[stream] += (merged.toMs - merged.fromMs - (a.toMs - a.fromMs) - (b.toMs - b.fromMs)) / 1000;
    }
  }

  /**
   * Forgets a pool: unwatched, its accepted hash and its encoder state gone, so its next snapshot is written in full.
   * The minute its counts were written up to is kept until that minute has passed, so a pool watched again in the
   * same minute never writes a (pool, minute) record twice (ruling 18). Counts still held for minutes the caller's
   * flush did not reach (polls moved late into a later minute) are written first, so every counted poll ends in
   * exactly one (pool, minute) record (ruling 26).
   */
  private forget(poolId: string, nowMs: number): void {
    const w = this.watched.get(poolId);
    if (w !== undefined) {
      let last = -Infinity;
      for (const m of w.buckets.keys()) if (m > last) last = m;
      if (last >= w.nextMinute) this.flushPool(poolId, w, last + 1, nowMs);
      // Re-inserted at the end, so the map's order stays oldest first for pruneFlushed().
      this.flushedUntil.delete(poolId);
      this.flushedUntil.set(poolId, w.nextMinute);
      this.pruneFlushed();
    }
    this.watched.delete(poolId);
    this.lastAccepted.delete(poolId);
    this.encoder.forget(poolId);
  }

  /**
   * True when a watched pool may make way at the cap (ruling 17): no position poll last, and no poll or watch for
   * max(60 s, 3 x its poll interval), measured in elapsed time, never by calendar minute. The interval is the pool's
   * own where the queue has seen two polls, else slowestPollIntervalMs.
   */
  private idle(w: WatchedPool, nowMs: number): boolean {
    if (w.position) return false;
    const interval = w.intervalMs ?? this.cfg.slowestPollIntervalMs;
    return nowMs - w.seenMs >= Math.max(IDLE_MIN_MS, 3 * interval);
  }

  /**
   * The watched entry for a pool, watching it if it is new. At the cap the idle pool with the oldest last sight makes
   * way: its counts are written and it is forgotten. Null only when no watched pool is idle. `always` admits past the
   * cap (position pools).
   */
  private admit(poolId: string, priorityClass: string, nowMs: number, always: boolean): WatchedPool | null {
    const known = this.watched.get(poolId);
    if (known !== undefined) return known;
    const minute = Math.floor(nowMs / MINUTE_MS);
    while (!always && this.watched.size >= this.cfg.maxWatchedPools) {
      let victim: string | null = null;
      let victimMs = Infinity;
      for (const [id, v] of this.watched) {
        if (v.seenMs < victimMs && this.idle(v, nowMs)) {
          victim = id;
          victimMs = v.seenMs;
        }
      }
      if (victim === null) return null;
      const v = this.watched.get(victim) as WatchedPool;
      // Up to the current minute; the current minute too only if it holds counts (a late poll), and then the pool's
      // flushed-up-to minute keeps a new watch from writing it again.
      this.flushPool(victim, v, v.buckets.has(minute) ? minute + 1 : minute, nowMs);
      this.forget(victim, nowMs);
      this.s.capUnwatched++;
    }
    const from = this.flushedUntil.get(poolId);
    this.flushedUntil.delete(poolId);
    this.pruneFlushed();
    const covered = this.coveredMinute();
    // Never before a minute already written for this pool, nor before the last tick's minute (a poll stamped earlier
    // but appended after that tick counts as late).
    const nextMinute = Math.max(minute, from ?? minute, covered ?? minute);
    const w: WatchedPool = {
      priorityClass, nextMinute, seenMs: nowMs, lastPollMs: null, intervalMs: null,
      position: false, lastRawHash: null, buckets: new Map(),
    };
    this.watched.set(poolId, w);
    return w;
  }

  /**
   * Counts one poll of a watched pool in its own minute, or, when that minute is already written (late) or the time is
   * a forward clock step, in the minute it can still go to; both minutes then get a gap on poll_counts (`clock_step`
   * when the time was a clock step either way, else `late`), so every moved poll is explained (rulings 28 and 30).
   */
  private countPoll(poolId: string, w: WatchedPool, priorityClass: string, recvMs: number, clock: Clocked, kind: 'successful' | 'changed' | 'failed', position: boolean): void {
    w.priorityClass = priorityClass;
    // A failed poll can set the position mark but never clears it (ruling 23).
    w.position = kind === 'failed' ? w.position || position : position;
    const t = clock.effMs;
    if (w.lastPollMs !== null && t > w.lastPollMs) w.intervalMs = t - w.lastPollMs;
    if (w.lastPollMs === null || t > w.lastPollMs) w.lastPollMs = t;
    w.seenMs = Math.max(w.seenMs, t);
    const own = Math.floor(recvMs / MINUTE_MS);
    let minute = Math.floor(t / MINUTE_MS);
    if (clock.status === 'ahead') this.s.skewedPolls++;
    if (minute < w.nextMinute) {
      // Its minute was already emitted: counted in the next one.
      minute = w.nextMinute;
      this.s.latePolls++;
    }
    // A move of one minute (ordinary latency at a minute boundary) is noted in the receiving record; a longer one
    // marks both of the pool's minutes with a clock_step gap (ruling 33).
    const oneMinute = minute !== own && Math.abs(minute - own) <= 1;
    if (minute !== own && !oneMinute) {
      // A clock step either way, or a poll simply that late (ruling 39).
      const reason = clock.status === 'ok' ? 'moved' : 'clock_step';
      this.s.movedPolls++;
      this.addPollGap(poolId, own, reason);
      this.addPollGap(poolId, minute, reason);
    }
    let b = w.buckets.get(minute);
    if (b === undefined) {
      b = { successful: 0, changed: 0, failed: 0, late: 0 };
      w.buckets.set(minute, b);
    }
    if (oneMinute) b.late++;
    if (kind === 'failed') {
      b.failed++;
    } else {
      b.successful++;
      if (kind === 'changed') b.changed++;
    }
  }

  /** Appends one of the queue's own poll_counts records, which does not move maxRecvMinute. */
  private emit(payload: PollCounts, nowMs: number): void {
    this.emitting = true;
    try {
      this.append({ stream: 'poll_counts', recvMs: nowMs as UnixMs, slot: null, commitment: null, source: 'M07', payload });
    } finally {
      this.emitting = false;
    }
  }

  /**
   * Emits the pool's minutes from nextMinute up to, not including, `untilMinute`: one record per minute, or one
   * `skippedMinutes` record with summed counts when there are more than pollCatchUpMaxMinutes of them.
   */
  private flushPool(poolId: string, w: WatchedPool, untilMinute: number, nowMs: number): void {
    const span = untilMinute - w.nextMinute;
    if (span > this.cfg.pollCatchUpMaxMinutes) {
      const sum: Bucket = { successful: 0, changed: 0, failed: 0, late: 0 };
      // Only polls moved into the span's first minute came from outside it.
      const firstLate = w.buckets.get(w.nextMinute)?.late ?? 0;
      for (const [m, b] of w.buckets) {
        if (m >= untilMinute) continue;
        sum.successful += b.successful;
        sum.changed += b.changed;
        sum.failed += b.failed;
        w.buckets.delete(m);
      }
      const payload: PollCounts = {
        poolId,
        minuteStartMs: w.nextMinute * MINUTE_MS,
        successfulPolls: sum.successful,
        changedPolls: sum.changed,
        failedPolls: sum.failed,
        priorityClass: w.priorityClass,
        skippedMinutes: span,
      };
      if (firstLate > 0) {
        payload.latePolls = firstLate;
        payload.lateFromMinuteStartMs = ((w.nextMinute - 1) * MINUTE_MS) as UnixMs;
      }
      this.s.skippedPollMinutes += span;
      w.nextMinute = untilMinute;
      this.emit(payload, nowMs);
      return;
    }
    for (; w.nextMinute < untilMinute; w.nextMinute++) {
      const b = w.buckets.get(w.nextMinute);
      w.buckets.delete(w.nextMinute);
      const payload: PollCounts = {
        poolId,
        minuteStartMs: w.nextMinute * MINUTE_MS,
        successfulPolls: b?.successful ?? 0,
        changedPolls: b?.changed ?? 0,
        failedPolls: b?.failed ?? 0,
        priorityClass: w.priorityClass,
      };
      if (b !== undefined && b.late > 0) {
        payload.latePolls = b.late;
        payload.lateFromMinuteStartMs = ((w.nextMinute - 1) * MINUTE_MS) as UnixMs;
      }
      this.emit(payload, nowMs);
    }
  }
}

/** The canonical JSON line of a written record (keys sorted, seq and slot as decimal strings), for A-M07-02. */
export function recordLine(r: EncodedRecord): string {
  return `{"commitment":${JSON.stringify(r.commitment)},"payload":${r.payloadJson},"recvMs":${JSON.stringify(r.recvMs)},"seq":"${r.seq}",`
    + `"slot":${r.slot === null ? 'null' : `"${r.slot}"`},"source":${JSON.stringify(r.source)},"stream":${JSON.stringify(r.stream)}}`;
}
