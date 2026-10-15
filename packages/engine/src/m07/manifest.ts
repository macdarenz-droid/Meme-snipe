// Segment naming, manifests and the day index (SPEC-A A-M07-02, card Z08): the pure part. The writer (segments.ts) does
// the file work.
//
// Layout (A-M07-02 logic 1; PATHS-FIX): `<dataDir>/YYYY-MM-DD/HH/<stream>.ndjson.<ext>`, its manifest
// `<stream>.manifest.json` beside it, and the day's index `<dataDir>/YYYY-MM-DD/index.json`. The codec is gzip by
// default (ruling Z08-4); zstd from node:zlib only when configured and present (VF-08: Experimental). Every manifest
// names its codec.
//
// The manifest is the frozen ARCH M07 `SegmentManifest` with A-M07-02's NEW fields (`codec`, `firstSeq`, `lastSeq`,
// `hourUtc`, `keyframes`) and, card Z08 (SPEC-A C-89), `firstRecvMs` and `lastRecvMs`, which a restart reads to place
// its `process_down` gap. Slots and seqs are written as decimal strings (canonical JSON has no bigint).
import type { UnixMs } from '@bot/types';

export type Codec = 'gzip' | 'zstd';
export const EXTENSION: Readonly<Record<Codec, string>> = { gzip: 'ndjson.gz', zstd: 'ndjson.zst' };
/** First bytes of a gzip member (RFC 1952: ID1 ID2 CM=8) and of a zstd frame (RFC 8878 magic 0xFD2FB528, little-endian). */
export const MAGIC: Readonly<Record<Codec, readonly number[]>> = { gzip: [0x1f, 0x8b, 0x08], zstd: [0x28, 0xb5, 0x2f, 0xfd] };

export type GapReason = 'backpressure' | 'crash' | 'process_down' | 'halted' | 'clock_step' | 'moved';
export interface ManifestGap { fromMs: UnixMs; toMs: UnixMs; reason: string; poolId?: string }

export interface SegmentManifest {
  path: string; stream: string; firstSlot: string | null; lastSlot: string | null; records: number; bytes: number;
  sha256: string; gaps: ManifestGap[]; codec: Codec; firstSeq: string | null; lastSeq: string | null; hourUtc: string; keyframes: number;
  firstRecvMs: UnixMs | null; lastRecvMs: UnixMs | null;
}

/** `YYYY-MM-DD` and `HH` of the UTC hour holding `ms`. */
export function hourOf(ms: UnixMs): { day: string; hour: string; hourUtc: string; startMs: UnixMs; endMs: UnixMs } {
  const iso = new Date(ms).toISOString();
  const day = iso.slice(0, 10);
  const hour = iso.slice(11, 13);
  const startMs = Math.floor(ms / 3_600_000) * 3_600_000;
  return { day, hour, hourUtc: `${day}T${hour}`, startMs: startMs as UnixMs, endMs: (startMs + 3_600_000) as UnixMs };
}

/** Relative paths of a stream's segment and manifest in an hour (`day/HH/...`). */
export function segmentPaths(day: string, hour: string, stream: string, codec: Codec): { segment: string; manifest: string; dir: string } {
  const dir = `${day}/${hour}`;
  return { dir, segment: `${dir}/${stream}.${EXTENSION[codec]}`, manifest: `${dir}/${stream}.manifest.json` };
}

/** Parses a segment file name back into its stream and codec (null when it is not one). */
export function parseSegmentName(name: string): { stream: string; codec: Codec } | null {
  for (const codec of ['gzip', 'zstd'] as const) {
    const suffix = `.${EXTENSION[codec]}`;
    if (name.endsWith(suffix) && name.length > suffix.length) {
      const stream = name.slice(0, -suffix.length);
      return /^[a-z_]+$/.test(stream) ? { stream, codec } : null;
    }
  }
  return null;
}

/** True for a `YYYY-MM-DD` folder name and an `HH` folder name. */
export const isDayName = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s);
export const isHourName = (s: string): boolean => /^([01]\d|2[0-3])$/.test(s);

/** What the writer learns from each line it writes, folded into the manifest's counts. */
export interface SegmentStats {
  records: number; keyframes: number; firstSeq: bigint | null; lastSeq: bigint | null;
  firstSlot: bigint | null; lastSlot: bigint | null; firstRecvMs: UnixMs | null; lastRecvMs: UnixMs | null;
}
export const emptyStats = (): SegmentStats => ({
  records: 0, keyframes: 0, firstSeq: null, lastSeq: null, firstSlot: null, lastSlot: null, firstRecvMs: null, lastRecvMs: null,
});

/** Folds one written record into the stats. The slot range is the least and greatest slot (records are in seq order, not slot order). */
export function addRecord(s: SegmentStats, r: { seq: bigint; slot: bigint | null; recvMs: UnixMs; keyframe: boolean }): void {
  s.records += 1;
  if (r.keyframe) s.keyframes += 1;
  s.firstSeq ??= r.seq;
  s.lastSeq = r.seq;
  if (r.slot !== null) {
    if (s.firstSlot === null || r.slot < s.firstSlot) s.firstSlot = r.slot;
    if (s.lastSlot === null || r.slot > s.lastSlot) s.lastSlot = r.slot;
  }
  if (s.firstRecvMs === null || r.recvMs < s.firstRecvMs) s.firstRecvMs = r.recvMs;
  if (s.lastRecvMs === null || r.recvMs > s.lastRecvMs) s.lastRecvMs = r.recvMs;
}

/** Reads the fields the stats need from one canonical record line (`recordLine` of the queue). */
export function statsOfLine(line: string): { seq: bigint; slot: bigint | null; recvMs: UnixMs; keyframe: boolean } {
  const o = JSON.parse(line) as { seq: string; slot: string | null; recvMs: number; payload: unknown };
  const p = o.payload;
  const keyframe = typeof p === 'object' && p !== null && (p as { kind?: unknown }).kind === 'keyframe';
  return { seq: BigInt(o.seq), slot: o.slot === null ? null : BigInt(o.slot), recvMs: o.recvMs as UnixMs, keyframe };
}

export function buildManifest(o: {
  path: string; stream: string; codec: Codec; hourUtc: string; bytes: number; sha256: string; stats: SegmentStats; gaps: readonly ManifestGap[];
}): SegmentManifest {
  const s = o.stats;
  return {
    path: o.path, stream: o.stream, firstSlot: s.firstSlot === null ? null : s.firstSlot.toString(), lastSlot: s.lastSlot === null ? null : s.lastSlot.toString(),
    records: s.records, bytes: o.bytes, sha256: o.sha256, gaps: mergeGaps(o.gaps), codec: o.codec,
    firstSeq: s.firstSeq === null ? null : s.firstSeq.toString(), lastSeq: s.lastSeq === null ? null : s.lastSeq.toString(),
    hourUtc: o.hourUtc, keyframes: s.keyframes, firstRecvMs: s.firstRecvMs, lastRecvMs: s.lastRecvMs,
  };
}

/** Gaps sorted by start; overlapping or touching gaps of the same reason and pool merge. Empty or inverted gaps drop out. */
export function mergeGaps(gaps: readonly ManifestGap[]): ManifestGap[] {
  const key = (g: ManifestGap): string => `${g.reason}\u0000${g.poolId ?? ''}`;
  const sorted = gaps.filter((g) => g.toMs > g.fromMs).map((g) => ({ ...g })).sort((a, b) => a.fromMs - b.fromMs || (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  const out: ManifestGap[] = [];
  const open = new Map<string, ManifestGap>();
  for (const g of sorted) {
    const k = key(g);
    const prev = open.get(k);
    if (prev !== undefined && g.fromMs <= prev.toMs) {
      if (g.toMs > prev.toMs) prev.toMs = g.toMs;
      continue;
    }
    out.push(g);
    open.set(k, g);
  }
  return out;
}

/** True when a parsed manifest has the shape `buildManifest` writes (a restart reads them back). */
export function isManifest(x: unknown): x is SegmentManifest {
  if (typeof x !== 'object' || x === null) return false;
  const m = x as Record<string, unknown>;
  const strOrNull = (v: unknown): boolean => v === null || typeof v === 'string';
  const numOrNull = (v: unknown): boolean => v === null || (typeof v === 'number' && Number.isFinite(v));
  return typeof m.path === 'string' && typeof m.stream === 'string' && typeof m.sha256 === 'string' && /^[0-9a-f]{64}$/.test(m.sha256)
    && Number.isSafeInteger(m.records) && Number.isSafeInteger(m.bytes) && (m.codec === 'gzip' || m.codec === 'zstd')
    && strOrNull(m.firstSeq) && strOrNull(m.lastSeq) && strOrNull(m.firstSlot) && strOrNull(m.lastSlot)
    && numOrNull(m.firstRecvMs) && numOrNull(m.lastRecvMs) && Array.isArray(m.gaps) && typeof m.hourUtc === 'string';
}

/**
 * Offsets in `buf` where a frame of `codec` could start (its magic bytes), after 0, in ascending order. Crash recovery
 * tries the file cut at each, from the end, and keeps the longest prefix that decodes completely (the codec's own check
 * sums reject a cut inside a frame).
 */
export function frameStarts(buf: Uint8Array, codec: Codec): number[] {
  const magic = MAGIC[codec];
  const out: number[] = [];
  outer: for (let i = 1; i + magic.length <= buf.length; i += 1) {
    for (let j = 0; j < magic.length; j += 1) if (buf[i + j] !== magic[j]) continue outer;
    out.push(i);
  }
  return out;
}
