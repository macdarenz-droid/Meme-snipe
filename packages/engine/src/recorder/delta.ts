// Change-only pool snapshots (A-M07-01 logic 2). A snapshot is written only when the pool's rawHash, stream or
// priority class differs from the last written state of that pool; then as a delta (changed fields only) against the
// last state written on the same stream, except the first record of a pool on a stream in each segment, which is a
// full keyframe, so every segment of every stream decodes on its own. The segment is the one the writer names in
// take(max, segmentId) (A-M07-02 edge case 3), never a clock hour. Deltas are taken against the last state the writer
// wrote, never the last state a producer appended, so a snapshot dropped in the queue can never break the chain.
import { canonicalJson } from '@bot/types';
import type { StreamName } from './streams.ts';

/** What M04 appends on a pool-snapshot stream. `fields` holds the decoded state (A-M04-01 shapes at integration). */
export interface PoolSnapshotPayload {
  poolId: string;
  rawHash: string;
  priorityClass: string;
  fields: Record<string, unknown>;
}

export interface SnapshotKeyframe {
  kind: 'keyframe';
  poolId: string;
  rawHash: string;
  priorityClass: string;
  fields: Record<string, unknown>;
}

export interface SnapshotDelta {
  kind: 'delta';
  poolId: string;
  rawHash: string;
  /** Present only when the priority class changed. */
  priorityClass?: string;
  /** Fields added or changed, with their new values. */
  set: Record<string, unknown>;
  /** Fields that were present in the last written state and are gone now, sorted. */
  unset: string[];
}

export type EncodedSnapshot = SnapshotKeyframe | SnapshotDelta;

/** A record whose key may be any string, `__proto__` included, without touching a prototype. */
function bag(): Record<string, unknown> {
  return Object.create(null) as Record<string, unknown>;
}

function put(o: Record<string, unknown>, k: string, v: unknown): void {
  Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
}

/** True for a plain JSON object (not an array, not null). */
export function isJsonObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

const SNAPSHOT_KEYS: ReadonlySet<string> = new Set(['poolId', 'rawHash', 'priorityClass', 'fields']);

/** Checks the shape of a snapshot payload; returns the reason it is wrong, or null. */
export function snapshotShapeError(p: unknown): string | null {
  if (!isJsonObject(p)) return 'payload is not an object';
  // Anything else at the top level would be dropped by the encoder, so it is refused instead (review round 1, M1).
  for (const k of Reflect.ownKeys(p)) if (typeof k !== 'string' || !SNAPSHOT_KEYS.has(k)) return 'unknown top-level key';
  if (typeof p.poolId !== 'string' || p.poolId === '') return 'poolId is not a non-empty string';
  if (typeof p.rawHash !== 'string' || p.rawHash === '') return 'rawHash is not a non-empty string';
  if (typeof p.priorityClass !== 'string') return 'priorityClass is not a string';
  if (!isJsonObject(p.fields)) return 'fields is not an object';
  return null;
}

interface WrittenState {
  rawHash: string;
  priorityClass: string;
  /** Canonical JSON of each field value, for change detection. */
  fieldJson: Map<string, string>;
}

/** What makes a written snapshot the same as the last one: stream, priority class and rawHash together. */
function signature(stream: StreamName, p: PoolSnapshotPayload): string {
  return `${stream}\u0000${p.priorityClass}\u0000${p.rawHash}`;
}

/**
 * The writer-side encoder. Memory: one state per (stream, pool) written in the current segment; all states are
 * dropped when the segment changes (the next record of each pool is a keyframe anyway), and a pool's states are
 * dropped when it is unwatched, so the encoder never grows past the pools watched in one segment.
 */
export class SnapshotEncoder {
  private segment: string | null = null;
  private readonly states = new Map<StreamName, Map<string, WrittenState>>();
  private readonly lastWritten = new Map<string, string>();

  /** Forgets one pool (unwatched): its next snapshot is written in full. */
  forget(poolId: string): void {
    this.lastWritten.delete(poolId);
    for (const m of this.states.values()) m.delete(poolId);
  }

  /** Entries held (per-stream states and per-pool hashes); for the memory-bound tests. */
  size(): number {
    let n = this.lastWritten.size;
    for (const m of this.states.values()) n += m.size;
    return n;
  }

  /**
   * Encodes a snapshot about to be written into `segmentId`, or returns null when the pool's last written record has
   * the same stream, priority class and rawHash (nothing to write). `p` must be JSON-normalised (parsed from
   * canonical JSON). A new segment id starts new keyframes for every pool.
   */
  encode(stream: StreamName, segmentId: string, p: PoolSnapshotPayload): EncodedSnapshot | null {
    if (segmentId !== this.segment) {
      this.states.clear();
      this.lastWritten.clear();
      this.segment = segmentId;
    }
    const sig = signature(stream, p);
    if (this.lastWritten.get(p.poolId) === sig) return null;
    this.lastWritten.set(p.poolId, sig);

    let perStream = this.states.get(stream);
    if (perStream === undefined) {
      perStream = new Map();
      this.states.set(stream, perStream);
    }
    const fieldJson = new Map<string, string>();
    for (const k of Object.keys(p.fields)) fieldJson.set(k, canonicalJson(p.fields[k]));
    const prev = perStream.get(p.poolId);
    perStream.set(p.poolId, { rawHash: p.rawHash, priorityClass: p.priorityClass, fieldJson });

    if (prev === undefined) {
      const fields = bag();
      for (const k of Object.keys(p.fields)) put(fields, k, p.fields[k]);
      return { kind: 'keyframe', poolId: p.poolId, rawHash: p.rawHash, priorityClass: p.priorityClass, fields };
    }
    const set = bag();
    for (const [k, json] of fieldJson) if (prev.fieldJson.get(k) !== json) put(set, k, p.fields[k]);
    const unset = [...prev.fieldJson.keys()].filter((k) => !fieldJson.has(k)).sort();
    const delta: SnapshotDelta = { kind: 'delta', poolId: p.poolId, rawHash: p.rawHash, set, unset };
    if (prev.priorityClass !== p.priorityClass) delta.priorityClass = p.priorityClass;
    return delta;
  }
}

export class DeltaDecodeError extends Error {
  readonly code = 'E_DELTA_NO_BASE';
}

/**
 * Rebuilds full snapshots from one stream's keyframes and deltas, in seq order (replay, A-M08-01, A-M11-03). Each
 * returned state is a fresh object. The decoded state equals the appended payload in its canonical-JSON form, which is
 * what parity checks compare: canonicalJson writes a bigint as its decimal string and -0 as 0, and sorts keys, so a
 * replay compares canonicalJson(decoded) with canonicalJson(appended), never the objects themselves.
 */
export class SnapshotDecoder {
  private readonly states = new Map<string, PoolSnapshotPayload>();

  apply(e: EncodedSnapshot): PoolSnapshotPayload {
    let next: PoolSnapshotPayload;
    if (e.kind === 'keyframe') {
      const fields = bag();
      for (const k of Object.keys(e.fields)) put(fields, k, e.fields[k]);
      next = { poolId: e.poolId, rawHash: e.rawHash, priorityClass: e.priorityClass, fields };
    } else {
      const prev = this.states.get(e.poolId);
      if (prev === undefined) throw new DeltaDecodeError(`delta for pool ${e.poolId} with no keyframe before it`);
      const fields = bag();
      for (const k of Object.keys(prev.fields)) if (!e.unset.includes(k)) put(fields, k, prev.fields[k]);
      for (const k of Object.keys(e.set)) put(fields, k, e.set[k]);
      next = { poolId: e.poolId, rawHash: e.rawHash, priorityClass: e.priorityClass ?? prev.priorityClass, fields };
    }
    this.states.set(e.poolId, next);
    return { ...next, fields: Object.assign(bag(), next.fields) };
  }
}
