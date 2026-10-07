// Change-only pool snapshots (A-M07-01 logic 2). A snapshot is written only when its rawHash differs from the last
// written state of that pool; then as a delta (changed fields only) against the last state written on the same
// stream, except the first record of a pool on a stream in each hour, which is a full keyframe, so every hourly
// segment of every stream decodes on its own. Deltas are taken against the last state the writer wrote, never the
// last state a producer appended, so a snapshot dropped in the queue can never break the chain.
import { canonicalJson, type UnixMs } from '@bot/types';
import type { StreamName } from './streams.ts';

export const HOUR_MS = 3_600_000;

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

/** Checks the shape of a snapshot payload; returns the reason it is wrong, or null. */
export function snapshotShapeError(p: unknown): string | null {
  if (!isJsonObject(p)) return 'payload is not an object';
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

/**
 * The writer-side encoder. Memory: one state per (stream, pool) written in the current hour; all states are dropped
 * when the hour changes (the next record of each pool is a keyframe anyway), so the encoder never grows past the pools
 * seen in one hour.
 */
export class SnapshotEncoder {
  private hour: number | null = null;
  private readonly states = new Map<StreamName, Map<string, WrittenState>>();
  private readonly lastWrittenHash = new Map<string, string>();

  /** Forces a keyframe for every pool on every stream (segment rotation, A-M07-02). */
  resetKeyframes(): void {
    this.states.clear();
    this.lastWrittenHash.clear();
  }

  /** Entries held (per-stream states and per-pool hashes); for the memory-bound tests. */
  size(): number {
    let n = this.lastWrittenHash.size;
    for (const m of this.states.values()) n += m.size;
    return n;
  }

  /**
   * Encodes a snapshot about to be written, or returns null when the pool's last written state already has this
   * rawHash (nothing to write). `p` must be JSON-normalised (parsed from canonical JSON).
   */
  encode(stream: StreamName, recvMs: UnixMs, p: PoolSnapshotPayload): EncodedSnapshot | null {
    // A change of hour, either way (a clock step back is an hour change too), starts new keyframes.
    const hour = Math.floor(recvMs / HOUR_MS);
    if (hour !== this.hour) {
      this.resetKeyframes();
      this.hour = hour;
    }
    if (this.lastWrittenHash.get(p.poolId) === p.rawHash) return null;
    this.lastWrittenHash.set(p.poolId, p.rawHash);

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
 * returned state is a fresh object.
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
