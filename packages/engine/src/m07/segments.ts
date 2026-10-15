// Segment writer, manifests and crash recovery (SPEC-A A-M07-02, card Z08). Adapted from Zeroed's recorder seal
// (`packages/worker/src/run/recorder.ts:340-350`: seal at next start, sha256 per sealed file), with the Blueprint's
// per-segment manifests and slot ranges; the Zeroed bug "a kill mid-segment leaves no partial manifest and duplicate
// records" (MIGRATION A-M07-02, OOM/RTC) has its fail-before test in test/m07/z08-segments.test.ts.
//
// - One writer. `pump()` drains the queue (A-M07-01 `take`) into the segment of the UTC hour open when the records are
//   dequeued; a new hour rotates every open segment first. `flush()` (every `recorder.flush_ms`, 10 s) appends one
//   complete compressed frame per stream and fsyncs, so a crash loses at most that interval.
// - `rotate()` (each UTC hour, or on demand): flush, fsync, SHA-256 of the file as it is on disk, the manifest written
//   atomically (temp, fsync, rename, fsync dir), then appended to the day's index the same way.
// - `SegmentWriter.recover()` (before the queue is built, so seqs continue): every segment without a manifest is cut
//   after its last complete frame, decoded, and given a manifest with a `crash` gap; the seq of each stream continues
//   from the newest manifest; the time since the newest record becomes a `process_down` gap on every stream.
// - A write or fsync failure halts every stream except `universe_manifest` and `coverage` (critical alert); records
//   of halted streams are discarded into `halted` gaps until `resume()` (A-M07-03's disk monitor calls it).
// Folders are made 0750 and files 0640, so the pull group reads them under the unit's UMask=0077 (A-M07-02 "Shared
// resources").
import { createHash } from 'node:crypto';
import * as nodeFs from 'node:fs';
import { join } from 'node:path';
import * as zlib from 'node:zlib';
import { FRAME_TARGET_BYTES, scanGzipFrames } from './frames.ts';
import type { UnixMs } from '@bot/types';
import type { EncodedRecord, Gap } from '../recorder/queue.ts';
import { recordLine } from '../recorder/queue.ts';
import { STREAM_NAMES, type StreamName } from '../recorder/streams.ts';
import {
  addRecord, buildManifest, emptyStats, hourOf, isDayName, isHourName, isManifest, manifestNameOf, parseSegmentName, segmentPaths, statsOfLine,
  type Codec, type ManifestGap, type SegmentManifest, type SegmentStats,
} from './manifest.ts';

export const DIR_MODE = 0o750;
export const FILE_MODE = 0o640;
/** Streams that keep recording while the writer is halted (A-M07-03 logic 2). */
export const KEEP_WHEN_HALTED: ReadonlySet<StreamName> = new Set<StreamName>(['universe_manifest', 'coverage']);
/** Ruling Z08-25: resumes after a failed write wait 60 s, then twice as long each time, at most 1 h. */
export const RESUME_BACKOFF_MIN_MS = 60_000;
export const RESUME_BACKOFF_MAX_MS = 3_600_000;
/** Records taken from the queue in one pump. */
export const TAKE_MAX = 5_000;

/** The node:fs functions the writer uses; tests inject failures through it. */
export type WriterFs = Pick<typeof nodeFs,
  'mkdirSync' | 'openSync' | 'writeSync' | 'fsyncSync' | 'closeSync' | 'renameSync' | 'readFileSync' | 'existsSync' | 'readdirSync'
  | 'ftruncateSync' | 'fchmodSync' | 'chmodSync' | 'unlinkSync'>;

export type WriterLogLevel = 'info' | 'warning' | 'error' | 'critical';
export type WriterLog = (level: WriterLogLevel, code: string, fields: Record<string, string | number>) => void;

export interface Compressor { compress(b: Uint8Array): Uint8Array; decompress(b: Uint8Array): Uint8Array }

/**
 * gzip (ruling Z08-4). zstd is not offered: besides being Experimental in node:zlib [VF-08], `zstdDecompressSync` on
 * Node 22 decodes only the first frame of a multi-frame file (measured on Node 22.22.0, card Z08; a test pins it), so a
 * segment of several flushed frames would read back short. `recorder.codec_preference = zstd` falls back to gzip
 * (`resolveCodec`, SPEC-A C-17 "otherwise gzip").
 */
export function compressorFor(codec: Codec): Compressor | null {
  if (codec === 'gzip') return { compress: (b) => zlib.gzipSync(b), decompress: (b) => zlib.gunzipSync(b) };
  return null;
}

/**
 * One flush's lines as gzip members of at most `target` decoded bytes each (ruling Z08-28: the readers treat a member over
 * 64 MiB as corrupt, so the writer stays at a quarter of that). Usually one member; a line is never split.
 */
export function frameOf(comp: Compressor, lines: readonly string[], target = FRAME_TARGET_BYTES): Uint8Array {
  const members: Uint8Array[] = [];
  let group: string[] = [];
  let bytes = 0;
  for (const line of lines) {
    const n = Buffer.byteLength(line, 'utf8') + 1;
    if (group.length > 0 && bytes + n > target) {
      members.push(comp.compress(Buffer.from(`${group.join('\n')}\n`, 'utf8')));
      group = [];
      bytes = 0;
    }
    group.push(line);
    bytes += n;
  }
  if (group.length > 0) members.push(comp.compress(Buffer.from(`${group.join('\n')}\n`, 'utf8')));
  return members.length === 1 ? members[0] as Uint8Array : Buffer.concat(members);
}

/** The codec the writer uses for a configured preference: gzip, logging once when zstd was asked for. */
export function resolveCodec(preference: Codec, log: WriterLog): Codec {
  if (preference !== 'gzip') log('warning', 'M07.codec_fallback', { wanted: preference, used: 'gzip' });
  return 'gzip';
}

export interface RecoveryResult {
  /** The seq each stream's next record gets (the newest manifest's lastSeq + 1). */
  nextSeq: Partial<Record<StreamName, bigint>>;
  /** The newest record time on disk (for the `process_down` gap). */
  lastRecordMs: UnixMs | null;
  recovered: SegmentManifest[];
}

interface Open {
  stream: StreamName; rel: string; manifestRel: string; abs: string; fd: number;
  /** Counts of the records on disk: a record counts only once its frame is written and fsynced (ruling Z08-14). */
  stats: SegmentStats;
  lines: Array<{ line: string; rec: ReturnType<typeof statsOfLine> }>; gaps: ManifestGap[];
  /** Bytes on disk after the last good frame; a failed write is cut back to this. */
  bytes: number;
  /** A failed write could not be cut back: no more writes, no manifest; the next start recovers the file. */
  broken: boolean;
}

export interface SegmentWriterDeps {
  dataDir: string;
  codec: Codec;
  queue: { take(max: number, segmentId: string): EncodedRecord[]; drainGaps(): Partial<Record<StreamName, Gap[]>> };
  nowMs: () => UnixMs;
  log: WriterLog;
  fs?: WriterFs;
  /** Called after each manifest is written (A-M07-03 reads them). */
  onManifest?: (m: SegmentManifest) => void;
}

const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

function writeAtomic(fs: WriterFs, path: string, dir: string, text: string): void {
  const tmp = `${path}.tmp`;
  const fd = fs.openSync(tmp, 'w', FILE_MODE);
  try {
    fs.fchmodSync(fd, FILE_MODE);
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, path);
  const dfd = fs.openSync(dir, 'r');
  try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
}

function mkdirs(fs: WriterFs, root: string, rel: string): void {
  let at = root;
  for (const part of rel.split('/')) {
    at = join(at, part);
    if (!fs.existsSync(at)) {
      fs.mkdirSync(at, { mode: DIR_MODE });
      fs.chmodSync(at, DIR_MODE);
    }
  }
}

/** Appends `m` to the day's index (`<day>/index.json`, a JSON array), atomically. */
export function appendIndex(fs: WriterFs, dataDir: string, m: SegmentManifest): void {
  const day = m.path.slice(0, 10);
  const path = join(dataDir, day, 'index.json');
  let list: unknown[] = [];
  if (fs.existsSync(path)) {
    const parsed: unknown = JSON.parse(fs.readFileSync(path, 'utf8'));
    if (Array.isArray(parsed)) list = parsed;
  }
  list.push(m);
  writeAtomic(fs, path, join(dataDir, day), `${JSON.stringify(list)}\n`);
}

export class SegmentWriter {
  private readonly fs: WriterFs;
  private readonly comp: Compressor;
  private readonly open = new Map<StreamName, Open>();
  private hour: ReturnType<typeof hourOf> | null = null;
  /** Segments closed without a manifest after a write that could not be cut back (recovered on resume). */
  private readonly broken: string[] = [];
  /** A failed-write episode: alerted once; resumes back off 60 s → 1 h; ends at the next successful write (Z08-25). */
  private episode: { halts: number; backoffMs: number; resumeAtMs: number } | null = null;
  private lastRotated: string;
  private halted: { since: UnixMs; reason: string } | null = null;
  private readonly haltGaps = new Map<StreamName, ManifestGap>();
  /** Gaps waiting for a segment of their stream (process_down at start, halted gaps). */
  private readonly pendingGaps = new Map<StreamName, ManifestGap[]>();
  private readonly deps: SegmentWriterDeps;

  constructor(deps: SegmentWriterDeps, recovery: RecoveryResult) {
    this.deps = deps;
    this.fs = deps.fs ?? nodeFs;
    const comp = compressorFor(deps.codec);
    if (comp === null) throw new RangeError(`recorder.codec_preference ${String(deps.codec)}: not available here; use gzip`);
    this.comp = comp;
    const now = deps.nowMs();
    // Every hour before the start hour is closed: recovery gave each file there a manifest, and this run never writes to it.
    this.lastRotated = hourOf((hourOf(now).startMs - 3_600_000) as UnixMs).hourUtc;
    if (recovery.lastRecordMs !== null && now > recovery.lastRecordMs) {
      for (const s of STREAM_NAMES) this.addPending(s, { fromMs: recovery.lastRecordMs, toMs: now, reason: 'process_down' });
    }
  }

  /** Crash recovery (logic 4 and 5). Call before building the queue; pass `nextSeq` to it as `firstSeq`. */
  static recover(o: { dataDir: string; nowMs: UnixMs; log: WriterLog; fs?: WriterFs; onManifest?: (m: SegmentManifest) => void }): RecoveryResult {
    const fs = o.fs ?? nodeFs;
    const recovered: SegmentManifest[] = [];
    const nextSeq: Partial<Record<StreamName, bigint>> = {};
    let lastRecordMs: UnixMs | null = null;
    if (!fs.existsSync(o.dataDir)) return { nextSeq, lastRecordMs, recovered };
    const days = (fs.readdirSync(o.dataDir) as string[]).filter(isDayName).sort();
    // Every manifest is read; the highest lastSeq of each stream wins (parts of one hour sort part 0 first).
    for (const day of [...days].reverse()) {
      const hours = (fs.readdirSync(join(o.dataDir, day)) as string[]).filter(isHourName).sort().reverse();
      for (const hour of hours) {
        const dir = join(o.dataDir, day, hour);
        for (const name of (fs.readdirSync(dir) as string[]).sort()) {
          const seg = parseSegmentName(name);
          if (seg === null) continue;
          const manifestPath = join(dir, manifestNameOf(name) as string);
          let m: SegmentManifest | null = null;
          if (fs.existsSync(manifestPath)) {
            const parsed: unknown = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            if (isManifest(parsed)) m = parsed;
          } else {
            m = SegmentWriter.recoverOne(fs, o.dataDir, `${day}/${hour}/${name}`, seg.stream, seg.codec, o.nowMs, o.log);
            recovered.push(m);
            o.onManifest?.(m);
          }
          if (m === null) continue;
          if (m.lastRecvMs !== null && (lastRecordMs === null || m.lastRecvMs > lastRecordMs)) lastRecordMs = m.lastRecvMs;
          if (m.lastSeq !== null) {
            const next = BigInt(m.lastSeq) + 1n;
            const had = nextSeq[seg.stream as StreamName];
            if (had === undefined || next > had) nextSeq[seg.stream as StreamName] = next;
          }
        }
      }
    }
    return { nextSeq, lastRecordMs, recovered };
  }

  private static recoverOne(fs: WriterFs, dataDir: string, rel: string, stream: string, codec: Codec, nowMs: UnixMs, log: WriterLog): SegmentManifest {
    const comp = compressorFor(codec);
    const abs = join(dataDir, rel);
    const buf = fs.readFileSync(abs);
    // A codec this Node cannot read keeps every byte (nothing is ever cut or deleted unread); its manifest counts 0 records.
    // Ruling Z08-23: gzip is read member by member (frames.ts), never as one string; the file is cut only at the first
    // member that fails its own check, so every intact frame is kept whatever the hour's size.
    const stats = emptyStats();
    let keep = buf.length;
    let stop: string | null = null;
    if (comp !== null) {
      const scan = scanGzipFrames(buf, (line) => { if (line !== '') addRecord(stats, statsOfLine(line)); });
      keep = scan.goodEnd;
      stop = scan.stop;
    }
    const fd = fs.openSync(abs, 'r+');
    try {
      fs.ftruncateSync(fd, keep);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    const kept = fs.readFileSync(abs);
    const hourUtc = `${rel.slice(0, 10)}T${rel.slice(11, 13)}`;
    const hourStart = Date.parse(`${hourUtc}:00:00Z`) as UnixMs;
    const m = buildManifest({
      path: rel, stream, codec, hourUtc, bytes: kept.length, sha256: sha256(kept), stats,
      gaps: [{ fromMs: stats.lastRecvMs ?? hourStart, toMs: Math.max(nowMs, (stats.lastRecvMs ?? hourStart) + 1) as UnixMs, reason: 'crash' }],
    });
    writeAtomic(fs, join(dataDir, rel.slice(0, 13), manifestNameOf(rel.slice(14)) as string), join(dataDir, rel.slice(0, 13)), `${JSON.stringify(m)}\n`);
    appendIndex(fs, dataDir, m);
    log('warning', 'M07.crash_recovered', { stream, path: rel, records: stats.records, cut_bytes: buf.length - keep, cut_reason: stop ?? 'none' });
    return m;
  }

  private addPending(s: StreamName, g: ManifestGap): void {
    const list = this.pendingGaps.get(s) ?? [];
    list.push(g);
    this.pendingGaps.set(s, list);
  }

  isHalted(): boolean { return this.halted !== null; }

  /** Why the writer is halted (`disk:…` or `write_failed:…`), or null. */
  haltReason(): string | null { return this.halted?.reason ?? null; }

  /** Segments open for writing now (relative paths); A-M07-03 never touches them (ruling Z08-16). */
  openPaths(): string[] { return [...this.open.values()].map((s) => s.rel); }

  /**
   * The last hour closed by the hour change (`YYYY-MM-DDTHH`): no record is written to it any more. An on-demand
   * `rotate()` inside an hour does not count. At start, the hour before the start hour (ruling Z08-19).
   */
  lastRotatedHourUtc(): string { return this.lastRotated; }

  /** Stops every stream except `keep` (default universe_manifest and coverage); A-M07-03 and write failures call it. */
  halt(reason: string): void {
    if (this.halted !== null) return;
    this.halted = { since: this.deps.nowMs(), reason };
    // Ruling Z08-25: one critical alert per failed-write episode, however many resumes fail again.
    if (this.episode === null || this.episode.halts === 0) this.deps.log('critical', 'M07.recording_halted', { reason });
    else this.deps.log('warning', 'M07.recording_halted_again', { reason, failures: this.episode.halts + 1 });
    if (this.episode !== null) this.episode.halts += 1;
  }

  /**
   * Ends a halt. After a failed write, resumes are spaced out (ruling Z08-25): the first after 60 s, then doubling up to
   * 1 h, until a write succeeds; an earlier call does nothing. Returns true when the writer resumed.
   */
  resume(): boolean {
    if (this.halted === null) return false;
    const now = this.deps.nowMs();
    if (this.episode !== null && now < this.episode.resumeAtMs) return false;
    for (const rel of this.broken.splice(0)) {
      const seg = parseSegmentName(rel.slice(14)) as { stream: string; codec: Codec };
      try {
        const m = SegmentWriter.recoverOne(this.fs, this.deps.dataDir, rel, seg.stream, seg.codec, now, this.deps.log);
        this.deps.onManifest?.(m);
      } catch {
        this.broken.push(rel);                                            // still failing: the next resume or start tries again
      }
    }
    for (const [s, g] of this.haltGaps) this.addPending(s, { ...g, toMs: Math.max(g.toMs, now) as UnixMs });
    this.haltGaps.clear();
    this.halted = null;
    this.deps.log('info', 'M07.recording_resumed', {});
    return true;
  }

  /** Drains the queue into the current hour's segments. Returns the number of records written to buffers. */
  pump(): number {
    const now = this.deps.nowMs();
    const h = hourOf(now);
    if (this.hour !== null && this.hour.hourUtc !== h.hourUtc) {
      const closing = this.hour.hourUtc;
      this.rotate();
      this.lastRotated = closing;                                         // that hour takes no more records
    }
    this.hour = h;
    let n = 0;
    for (;;) {
      const batch = this.deps.queue.take(TAKE_MAX, h.hourUtc);
      for (const r of batch) {
        if (this.halted !== null && !KEEP_WHEN_HALTED.has(r.stream)) {
          this.haltGap(r.stream, r.recvMs);
          continue;
        }
        const seg = this.segment(r.stream);
        if (seg === null) {
          this.haltGap(r.stream, r.recvMs);                               // a kept stream whose segment cannot take writes
          continue;
        }
        const line = recordLine(r);
        seg.lines.push({ line, rec: statsOfLine(line) });
        n += 1;
      }
      if (batch.length < TAKE_MAX) break;
    }
    for (const [s, gaps] of Object.entries(this.deps.queue.drainGaps()) as Array<[StreamName, Gap[]]>) {
      for (const g of gaps) this.addPending(s, { fromMs: g.fromMs, toMs: g.toMs, reason: g.reason, ...(g.poolId === undefined ? {} : { poolId: g.poolId }) });
    }
    if (this.halted === null) for (const s of [...this.pendingGaps.keys()]) this.segment(s);
    return n;
  }

  private haltGap(stream: StreamName, recvMs: UnixMs): void {
    const since = this.halted?.since ?? recvMs;
    const g = this.haltGaps.get(stream);
    if (g === undefined) this.haltGaps.set(stream, { fromMs: Math.min(recvMs, since) as UnixMs, toMs: recvMs, reason: 'halted' });
    else g.toMs = Math.max(g.toMs, recvMs) as UnixMs;
  }

  /** The open segment of `stream` in the current hour (made on first use). Null when the write fails (halts). */
  private segment(stream: StreamName): Open | null {
    const existing = this.open.get(stream);
    if (existing !== undefined) {
      this.takePending(existing);
      return existing;
    }
    const h = this.hour ?? hourOf(this.deps.nowMs());
    this.hour = h;
    try {
      // Ruling Z08-13: a file that already exists (a part closed with its manifest, or one an earlier run left) is never
      // reopened; the next part number is used, created exclusively.
      let part = 0;
      let p = segmentPaths(h.day, h.hour, stream, this.deps.codec, part);
      mkdirs(this.fs, this.deps.dataDir, p.dir);
      while (this.fs.existsSync(join(this.deps.dataDir, p.segment)) || this.fs.existsSync(join(this.deps.dataDir, p.manifest))) {
        part += 1;
        p = segmentPaths(h.day, h.hour, stream, this.deps.codec, part);
      }
      const abs = join(this.deps.dataDir, p.segment);
      const fd = this.fs.openSync(abs, 'ax', FILE_MODE);                    // O_APPEND: after a cut-back, writes go to the new end
      this.fs.fchmodSync(fd, FILE_MODE);
      const seg: Open = { stream, rel: p.segment, manifestRel: p.manifest, abs, fd, stats: emptyStats(), lines: [], gaps: [], bytes: 0, broken: false };
      this.open.set(stream, seg);
      this.takePending(seg);
      return seg;
    } catch (e) {
      this.failed('open', e);
      return null;
    }
  }

  private takePending(seg: Open): void {
    const pending = this.pendingGaps.get(seg.stream);
    if (pending === undefined) return;
    seg.gaps.push(...pending);
    this.pendingGaps.delete(seg.stream);
  }

  private failed(op: string, e: unknown): void {
    const code = typeof e === 'object' && e !== null && 'code' in e ? String((e as { code: unknown }).code) : 'unknown';
    const now = this.deps.nowMs();
    if (this.episode === null) {
      this.deps.log('critical', 'M07.write_failed', { op, code });
      this.episode = { halts: 0, backoffMs: RESUME_BACKOFF_MIN_MS, resumeAtMs: now + RESUME_BACKOFF_MIN_MS };
    } else if (this.halted === null) {
      // A resume that failed again: wait twice as long before the next one (at most 1 h).
      this.episode.backoffMs = Math.min(RESUME_BACKOFF_MAX_MS, this.episode.backoffMs * 2);
      this.episode.resumeAtMs = now + this.episode.backoffMs;
    }
    this.halt(`write_failed:${code}`);
  }

  /** Appends one compressed frame per stream with buffered lines, and fsyncs (logic 2). */
  flush(): void {
    for (const seg of this.open.values()) {
      if (seg.lines.length === 0 || seg.broken) continue;
      const pending = seg.lines;
      seg.lines = [];
      const frame = frameOf(this.comp, pending.map((x) => x.line));
      try {
        this.fs.writeSync(seg.fd, frame);
        this.fs.fsyncSync(seg.fd);
        seg.bytes += frame.length;
        if (this.halted === null) this.episode = null;                    // a write went through: the episode is over
        for (const x of pending) addRecord(seg.stats, x.rec);
      } catch (e) {
        // Ruling Z08-14: the frame may be half written. Cut the file back to its last good frame, so nothing is ever
        // appended after a torn one; the lost records become a `halted` gap and are not counted.
        const recv = pending.map((x) => x.rec.recvMs);
        const lost: ManifestGap = { fromMs: Math.min(...recv) as UnixMs, toMs: (Math.max(...recv) + 1) as UnixMs, reason: 'halted' };   // +1: never empty
        try {
          this.fs.ftruncateSync(seg.fd, seg.bytes);
          this.fs.fsyncSync(seg.fd);
          seg.gaps.push(lost);
        } catch {
          // Cannot be cut back now: the file is closed without a manifest and recovered (cut after its last complete
          // frame, with a crash gap) on resume or at the next start; the stream continues in a new part.
          seg.broken = true;
          try { this.fs.closeSync(seg.fd); } catch { /* already failing */ }
          this.open.delete(seg.stream);
          this.broken.push(seg.rel);
          for (const g of seg.gaps) this.addPending(seg.stream, g);
          this.addPending(seg.stream, lost);
        }
        this.failed('flush', e);
      }
    }
  }

  /** Closes every open segment with its manifest (logic 3). Returns the manifests written. */
  rotate(): SegmentManifest[] {
    this.flush();
    const out: SegmentManifest[] = [];
    const hourUtc = (this.hour ?? hourOf(this.deps.nowMs())).hourUtc;
    for (const seg of this.open.values()) {
      let closed = false;
      try {
        this.fs.fsyncSync(seg.fd);
        this.fs.closeSync(seg.fd);
        closed = true;
        const bytes = this.fs.readFileSync(seg.abs);
        if (bytes.length !== seg.bytes) throw Object.assign(new Error('segment size differs from the bytes written'), { code: 'E_SIZE' });
        const m = buildManifest({ path: seg.rel, stream: seg.stream, codec: this.deps.codec, hourUtc, bytes: bytes.length, sha256: sha256(bytes), stats: seg.stats, gaps: seg.gaps });
        const dir = join(this.deps.dataDir, seg.rel.slice(0, 13));
        writeAtomic(this.fs, join(this.deps.dataDir, seg.manifestRel), dir, `${JSON.stringify(m)}\n`);
        appendIndex(this.fs, this.deps.dataDir, m);
        this.deps.log('info', 'M07.segment_rotated', { stream: seg.stream, records: m.records, sha256: m.sha256 });
        this.deps.onManifest?.(m);
        out.push(m);
      } catch (e) {
        // Ruling Z08-24: no manifest was written. The file is closed and recovered (cut, `crash` gap) on resume or at the
        // next start.
        if (!closed) try { this.fs.closeSync(seg.fd); } catch { /* failing */ }   // never close a number twice
        this.broken.push(seg.rel);
        this.failed('rotate', e);
      }
    }
    this.open.clear();
    return out;
  }
}
