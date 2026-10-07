// M07 recorder queue (A-M07-01). Producers call append(); it validates, serialises and queues the record and returns
// at once; it never awaits I/O. One writer loop (A-M07-02) calls take() to drain the queue in append order, tick() once
// a second or so for the per-minute poll counts, and drainGaps() for its segment manifests.
//
// Bounds (the 6 Oct restart loop and V8 out-of-memory, docs/MIGRATION.md "Bugs left behind"): the queue holds at most
// `queueMax` records and at most `queueMaxBytes` of serialised payload plus a fixed per-record allowance. When either
// is reached, the lowest-priority stream (the end of STREAM_NAMES) loses its newest records first, the incoming one
// included; order_event, fill, universe_manifest, coverage and venue_config are never dropped. Each stream that loses
// records gets a `backpressure` gap and a warning. Every other structure is bounded too: gaps per stream, the per-pool
// poll buckets and the encoder's per-hour state.
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
  reason: 'backpressure';
}

/** One per watched pool per minute (A-M07-01 logic 3). */
export interface PollCounts {
  poolId: string;
  minuteStartMs: UnixMs;
  successfulPolls: number;
  changedPolls: number;
  failedPolls: number;
  priorityClass: string;
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
}

export const DEFAULT_CONFIG: RecorderQueueConfig = {
  queueMax: 50_000,
  recordMaxBytes: 65_536,
  queueMaxBytes: 64 * 1024 * 1024,
  gapMergeMs: 1_000,
};

/** Bytes counted per queued record on top of its payload: the envelope object, its strings and the queue slot. */
export const RECORD_OVERHEAD_BYTES = 256;
/** Closed gaps kept per stream before the oldest two are merged (which only widens a gap, never hides one). */
export const GAPS_MAX_PER_STREAM = 1_024;
/** Poll minutes a pool may run ahead of its next unflushed minute before the poll counts as clock skew. */
export const POLL_MINUTES_AHEAD_MAX = 1_440;
/** Minutes one tick emits per pool at most; a longer pause skips the older minutes and counts them. */
export const TICK_CATCH_UP_MAX = 1_440;

export type RejectCode = 'E_STREAM' | 'E_ENVELOPE' | 'E_PAYLOAD' | 'E_TOO_LARGE';
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
  skippedPollMinutes: number;
  watchedPools: number;
  acceptedHashes: number;
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
  rawHash: string | null;
}

interface Bucket {
  successful: number;
  changed: number;
  failed: number;
}

interface WatchedPool {
  priorityClass: string;
  nextMinute: number;
  buckets: Map<number, Bucket>;
}

const COMMITMENTS: ReadonlySet<unknown> = new Set(['processed', 'confirmed', 'finalized']);

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

  /** Per pool, the rawHash of the newest snapshot accepted into the queue or written; drives change-only appends. */
  private readonly lastAccepted = new Map<string, string>();
  private readonly watched = new Map<string, WatchedPool>();

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
      rejectedTotal: { E_STREAM: 0, E_ENVELOPE: 0, E_PAYLOAD: 0, E_TOO_LARGE: 0 },
      redactedTotal: 0,
      latePolls: 0,
      skewedPolls: 0,
      skippedPollMinutes: 0,
      watchedPools: 0,
      acceptedHashes: 0,
      encoderStates: 0,
      gapsHeld: 0,
    };
  }

  /**
   * Non-blocking. Returns what happened; callers may ignore it. Throws RecorderError E_QUEUE_FULL only for a record of
   * a never-dropped stream when the queue already holds nothing but never-dropped records: such a record is refused
   * loudly, never lost silently, and the queue never grows past its bound.
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
    json = red.json;
    let source = e.source;
    if (isSecretShaped(source)) {
      source = '[redacted]';
      this.s.redactedTotal++;
    }
    this.s.redactedTotal += red.redacted;
    const payloadBytes = Buffer.byteLength(json, 'utf8');
    if (payloadBytes > this.cfg.recordMaxBytes) return this.reject(stream, 'E_TOO_LARGE', 'payload over recorder.record_max_bytes');

    let poolId: string | null = null;
    let rawHash: string | null = null;
    if (snapshot) {
      const p = e.payload as PoolSnapshotPayload;
      poolId = p.poolId;
      rawHash = p.rawHash;
      const unchanged = this.lastAccepted.get(poolId) === rawHash;
      this.countPoll(poolId, p.priorityClass, e.recvMs, unchanged ? 'successful' : 'changed');
      if (unchanged) {
        this.s.recordsTotal[stream].notWritten++;
        return 'unchanged';
      }
    }

    const item: Item = { stream, order: this.nextOrder++, recvMs: e.recvMs, slot: e.slot, commitment: e.commitment, source, json, bytes: payloadBytes + RECORD_OVERHEAD_BYTES, poolId, rawHash };
    if (!this.makeRoom(item)) {
      this.onDrop(stream, e.recvMs);
      return 'dropped';
    }
    this.queues[stream].push(item);
    this.depth++;
    this.bytes += item.bytes;
    if (this.depth > this.s.peakDepth) this.s.peakDepth = this.depth;
    if (this.bytes > this.s.peakBytes) this.s.peakBytes = this.bytes;
    if (poolId !== null && rawHash !== null) this.lastAccepted.set(poolId, rawHash);
    this.closeGap(stream);
    return 'queued';
  }

  /** A poll of a watched pool that failed (A-M07-01 logic 3, `failedPolls`). */
  notePollFailed(poolId: string, priorityClass: string, recvMs: UnixMs): void {
    this.countPoll(poolId, priorityClass, recvMs, 'failed');
  }

  /**
   * Starts the per-minute poll counts for a pool from the minute of `nowMs`. A pool is also watched from its first
   * snapshot or failed poll.
   */
  watch(poolId: string, priorityClass: string, nowMs: UnixMs): void {
    const w = this.watched.get(poolId);
    if (w !== undefined) {
      w.priorityClass = priorityClass;
      return;
    }
    this.watched.set(poolId, { priorityClass, nextMinute: Math.floor(nowMs / MINUTE_MS), buckets: new Map() });
  }

  /**
   * Stops watching a pool: emits its poll counts up to and including the minute of `nowMs` (the last one partial) and
   * forgets the pool, so its next snapshot is written again as a change.
   */
  unwatch(poolId: string, nowMs: UnixMs): void {
    const w = this.watched.get(poolId);
    if (w !== undefined) this.flushPool(poolId, w, Math.floor(nowMs / MINUTE_MS) + 1, nowMs);
    this.watched.delete(poolId);
    this.lastAccepted.delete(poolId);
  }

  /** Emits one `poll_counts` record per watched pool for every whole minute before `nowMs` not yet emitted. */
  tick(nowMs: UnixMs): void {
    const nowMinute = Math.floor(nowMs / MINUTE_MS);
    for (const [poolId, w] of this.watched) this.flushPool(poolId, w, nowMinute, nowMs);
  }

  /** Takes up to `max` records in append order, with seq assigned and snapshots encoded. */
  take(max: number): EncodedRecord[] {
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
        const enc = this.encoder.encode(item.stream, item.recvMs, JSON.parse(item.json) as PoolSnapshotPayload);
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

  /** Forces a keyframe as the next record of every pool on every stream (segment rotation, A-M07-02). */
  resetKeyframes(): void {
    this.encoder.resetKeyframes();
  }

  /**
   * The backpressure gaps per stream since the last call. A gap still open is reported as it stands and stays open, so
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
      if (gone.poolId !== null && this.lastAccepted.get(gone.poolId) === gone.rawHash) this.lastAccepted.delete(gone.poolId);
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
      list[0] = { fromMs: Math.min(a.fromMs, b.fromMs), toMs: Math.max(a.toMs, b.toMs), reason: 'backpressure' };
    }
  }

  private countPoll(poolId: string, priorityClass: string, recvMs: number, kind: 'successful' | 'changed' | 'failed'): void {
    let w = this.watched.get(poolId);
    if (w === undefined) {
      w = { priorityClass, nextMinute: Math.floor(recvMs / MINUTE_MS), buckets: new Map() };
      this.watched.set(poolId, w);
    }
    w.priorityClass = priorityClass;
    let minute = Math.floor(recvMs / MINUTE_MS);
    if (minute < w.nextMinute) {
      // Its minute was already emitted: counted in the next one.
      minute = w.nextMinute;
      this.s.latePolls++;
    } else if (minute > w.nextMinute + POLL_MINUTES_AHEAD_MAX) {
      minute = w.nextMinute;
      this.s.skewedPolls++;
    }
    let b = w.buckets.get(minute);
    if (b === undefined) {
      b = { successful: 0, changed: 0, failed: 0 };
      w.buckets.set(minute, b);
    }
    if (kind === 'failed') {
      b.failed++;
    } else {
      b.successful++;
      if (kind === 'changed') b.changed++;
    }
  }

  /** Emits the pool's minutes from nextMinute up to, not including, `untilMinute`. */
  private flushPool(poolId: string, w: WatchedPool, untilMinute: number, nowMs: number): void {
    if (untilMinute - w.nextMinute > TICK_CATCH_UP_MAX) {
      const skip = untilMinute - TICK_CATCH_UP_MAX;
      for (const m of w.buckets.keys()) if (m < skip) w.buckets.delete(m);
      this.s.skippedPollMinutes += skip - w.nextMinute;
      w.nextMinute = skip;
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
      this.append({ stream: 'poll_counts', recvMs: nowMs, slot: null, commitment: null, source: 'M07', payload });
    }
  }
}

/** The canonical JSON line of a written record (keys sorted, seq and slot as decimal strings), for A-M07-02. */
export function recordLine(r: EncodedRecord): string {
  return `{"commitment":${JSON.stringify(r.commitment)},"payload":${r.payloadJson},"recvMs":${JSON.stringify(r.recvMs)},"seq":"${r.seq}",`
    + `"slot":${r.slot === null ? 'null' : `"${r.slot}"`},"source":${JSON.stringify(r.source)},"stream":${JSON.stringify(r.stream)}}`;
}
