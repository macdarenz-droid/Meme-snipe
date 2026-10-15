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
import type { UnixMs } from '@bot/types';
import type { EncodedRecord, Gap } from '../recorder/queue.ts';
import { recordLine } from '../recorder/queue.ts';
import { STREAM_NAMES, type StreamName } from '../recorder/streams.ts';
import {
  addRecord, buildManifest, emptyStats, frameStarts, hourOf, isDayName, isHourName, isManifest, parseSegmentName, segmentPaths, statsOfLine,
  type Codec, type ManifestGap, type SegmentManifest, type SegmentStats,
} from './manifest.ts';

export const DIR_MODE = 0o750;
export const FILE_MODE = 0o640;
/** Streams that keep recording while the writer is halted (A-M07-03 logic 2). */
export const KEEP_WHEN_HALTED: ReadonlySet<StreamName> = new Set<StreamName>(['universe_manifest', 'coverage']);
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
  stream: StreamName; rel: string; manifestRel: string; abs: string; fd: number; stats: SegmentStats;
  lines: string[]; gaps: ManifestGap[]; bytes: number;
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
    const seen = new Set<string>();
    // Newest day first: the newest manifest of a stream holds its highest seq.
    for (const day of [...days].reverse()) {
      const hours = (fs.readdirSync(join(o.dataDir, day)) as string[]).filter(isHourName).sort().reverse();
      for (const hour of hours) {
        const dir = join(o.dataDir, day, hour);
        for (const name of (fs.readdirSync(dir) as string[]).sort()) {
          const seg = parseSegmentName(name);
          if (seg === null) continue;
          const manifestPath = join(dir, `${seg.stream}.manifest.json`);
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
          if (m.lastSeq !== null && !seen.has(seg.stream)) {
            seen.add(seg.stream);
            nextSeq[seg.stream as StreamName] = BigInt(m.lastSeq) + 1n;
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
    let keep = comp === null ? buf.length : 0;
    let text = '';
    if (comp !== null) {
      for (const cut of [buf.length, ...frameStarts(buf, codec).reverse()]) {
        try {
          text = new TextDecoder().decode(comp.decompress(buf.subarray(0, cut)));
          keep = cut;
          break;
        } catch { /* a cut inside a frame: try an earlier one */ }
      }
    }
    // A decoded frame always ends with a whole line; anything else is cut too.
    const lines = text === '' ? [] : text.split('\n').filter((l) => l !== '');
    const stats = emptyStats();
    for (const line of lines) addRecord(stats, statsOfLine(line));
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
      gaps: [{ fromMs: stats.lastRecvMs ?? hourStart, toMs: nowMs, reason: 'crash' }],
    });
    writeAtomic(fs, join(dataDir, rel.slice(0, 13), `${stream}.manifest.json`), join(dataDir, rel.slice(0, 13)), `${JSON.stringify(m)}\n`);
    appendIndex(fs, dataDir, m);
    log('warning', 'M07.crash_recovered', { stream, path: rel, records: stats.records, cut_bytes: buf.length - keep });
    return m;
  }

  private addPending(s: StreamName, g: ManifestGap): void {
    const list = this.pendingGaps.get(s) ?? [];
    list.push(g);
    this.pendingGaps.set(s, list);
  }

  isHalted(): boolean { return this.halted !== null; }

  /** Stops every stream except `keep` (default universe_manifest and coverage); A-M07-03 and write failures call it. */
  halt(reason: string): void {
    if (this.halted !== null) return;
    this.halted = { since: this.deps.nowMs(), reason };
    this.deps.log('critical', 'M07.recording_halted', { reason });
  }

  resume(): void {
    if (this.halted === null) return;
    const now = this.deps.nowMs();
    for (const [s, g] of this.haltGaps) this.addPending(s, { ...g, toMs: Math.max(g.toMs, now) as UnixMs });
    this.haltGaps.clear();
    this.halted = null;
    this.deps.log('info', 'M07.recording_resumed', {});
  }

  /** Drains the queue into the current hour's segments. Returns the number of records written to buffers. */
  pump(): number {
    const now = this.deps.nowMs();
    const h = hourOf(now);
    if (this.hour !== null && this.hour.hourUtc !== h.hourUtc) this.rotate();
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
          this.haltGap(r.stream, r.recvMs);                               // a kept stream whose segment cannot be opened
          continue;
        }
        const line = recordLine(r);
        seg.lines.push(line);
        addRecord(seg.stats, statsOfLine(line));
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
    const p = segmentPaths(h.day, h.hour, stream, this.deps.codec);
    try {
      mkdirs(this.fs, this.deps.dataDir, p.dir);
      const abs = join(this.deps.dataDir, p.segment);
      const fd = this.fs.openSync(abs, 'a', FILE_MODE);
      this.fs.fchmodSync(fd, FILE_MODE);
      const seg: Open = { stream, rel: p.segment, manifestRel: p.manifest, abs, fd, stats: emptyStats(), lines: [], gaps: [], bytes: 0 };
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
    // Once per halt episode: a full disk would otherwise log on every record of the streams still kept.
    if (this.halted === null) this.deps.log('critical', 'M07.write_failed', { op, code });
    this.halt(`write_failed:${code}`);
  }

  /** Appends one compressed frame per stream with buffered lines, and fsyncs (logic 2). */
  flush(): void {
    for (const seg of this.open.values()) {
      if (seg.lines.length === 0) continue;
      const frame = this.comp.compress(Buffer.from(`${seg.lines.join('\n')}\n`, 'utf8'));
      try {
        this.fs.writeSync(seg.fd, frame);
        this.fs.fsyncSync(seg.fd);
        seg.bytes += frame.length;
        seg.lines = [];
      } catch (e) {
        // The frame may be half written: recovery at the next start cuts it; this segment takes no more writes.
        seg.lines = [];
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
      try {
        this.fs.fsyncSync(seg.fd);
        this.fs.closeSync(seg.fd);
        const bytes = this.fs.readFileSync(seg.abs);
        const m = buildManifest({ path: seg.rel, stream: seg.stream, codec: this.deps.codec, hourUtc, bytes: bytes.length, sha256: sha256(bytes), stats: seg.stats, gaps: seg.gaps });
        const dir = join(this.deps.dataDir, seg.rel.slice(0, 13));
        writeAtomic(this.fs, join(this.deps.dataDir, seg.manifestRel), dir, `${JSON.stringify(m)}\n`);
        appendIndex(this.fs, this.deps.dataDir, m);
        this.deps.log('info', 'M07.segment_rotated', { stream: seg.stream, records: m.records, sha256: m.sha256 });
        this.deps.onManifest?.(m);
        out.push(m);
      } catch (e) {
        this.failed('rotate', e);                                         // no manifest: the next start recovers it
      }
    }
    this.open.clear();
    return out;
  }
}
