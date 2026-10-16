// A-M04-01 logic 6: the per-pool ring buffer of the last `history_ms` of snapshots, in compact form. One fixed-size
// byte record per snapshot (the pool model's record, then the snapshot fields below), in one preallocated buffer, so
// memory is bounded by capacity × record size whatever runs through it (bug "OOM" in docs/MIGRATION.md: Zeroed's
// per-pool maps grew without bound). `history()` rebuilds snapshot objects only for the range asked. Pure.
import type { Pubkey, Slot } from '@bot/types';
import type { PoolAddresses, PoolModelPort, PoolSnapshot, PoolStateLike } from './types.ts';

/** Snapshot fields after the pool record: provider slot u64, read latency f32, lag i32, fee u16, provider index u16, rawHash 32 bytes. */
export const SNAPSHOT_EXTRA_BYTES = 52;
const HASH_BYTES = 32;

/**
 * Ruling Z10-38: ring buffers handed back when a pool leaves (or changes class) and reused by the next ring of the same
 * size. A ring is large (up to about 0.8 MiB) and lives for hours, so a new one per pool left the dead ones in glibc's
 * heap until a major GC and pushed the heap's high-water mark up. At most `maxSpare` spare buffers are kept per size,
 * so live plus spare buffers of a size never exceed the watch caps (the tracker passes their sum).
 */
export class RingBuffers {
  private readonly spare = new Map<number, Uint8Array[]>();
  private readonly maxSpare: number;
  constructor(maxSpare: number) { this.maxSpare = maxSpare; }
  take(bytes: number): Uint8Array {
    const b = this.spare.get(bytes)?.pop();
    return b === undefined ? new Uint8Array(bytes) : b.fill(0);
  }
  give(buf: Uint8Array): void {
    if (buf.byteLength === 0) return;
    const list = this.spare.get(buf.byteLength) ?? [];
    if (list.length >= this.maxSpare) return;
    list.push(buf);
    this.spare.set(buf.byteLength, list);
  }
  /** Spare bytes held (for the soak's accounting). */
  get bytes(): number { let n = 0; for (const l of this.spare.values()) for (const b of l) n += b.byteLength; return n; }
}

export class SnapshotRing<P extends PoolStateLike> {
  private buf: Uint8Array;
  private cap: number;
  private head = 0;                                     // next write position
  private count = 0;
  private last: PoolSnapshot<P> | null = null;
  private readonly stride: number;
  private readonly addr: PoolAddresses;
  private readonly model: PoolModelPort<P>;
  /** Provider labels, shared by every ring of a tracker; a record holds the label's index. */
  private readonly providers: string[];
  private readonly buffers: RingBuffers | null;
  private released = false;

  constructor(addr: PoolAddresses, model: PoolModelPort<P>, capacity: number, providers: string[], buffers: RingBuffers | null = null) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new RangeError('ring capacity must be a positive integer');
    this.addr = addr;
    this.model = model;
    this.providers = providers;
    this.stride = model.recordBytes + SNAPSHOT_EXTRA_BYTES;
    this.cap = capacity;
    this.buffers = buffers;
    this.buf = buffers === null ? new Uint8Array(capacity * this.stride) : buffers.take(capacity * this.stride);
  }

  /** The pool left: the buffer goes back for reuse; this ring then holds and takes nothing. */
  release(): void {
    if (this.released) return;
    this.released = true;
    this.buffers?.give(this.buf);
    this.buf = new Uint8Array(0);
    this.count = 0;
    this.head = 0;
  }

  get capacity(): number { return this.cap; }
  get size(): number { return this.count; }
  get bytes(): number { return this.buf.byteLength; }
  get poolId(): Pubkey { return this.addr.poolId; }

  push(s: PoolSnapshot<P>): void {
    if (this.released) return;
    const at = this.head * this.stride;
    this.model.encode(s.pool, this.buf, at);
    const v = new DataView(this.buf.buffer, this.buf.byteOffset + at + this.model.recordBytes, SNAPSHOT_EXTRA_BYTES);
    v.setBigUint64(0, s.providerSlot, true);
    v.setFloat32(8, s.readLatencyMs, true);
    v.setInt32(12, s.observationLagSlots, true);
    v.setUint16(16, s.feeTotalBps, true);
    let p = this.providers.indexOf(s.providerLabel);
    if (p < 0) p = this.providers.push(s.providerLabel) - 1;
    v.setUint16(18, p, true);
    this.buf.set(Buffer.from(s.rawHash, 'hex').subarray(0, HASH_BYTES), at + this.model.recordBytes + 20);
    this.head = (this.head + 1) % this.cap;
    this.count = Math.min(this.count + 1, this.cap);
    this.last = s;
  }

  latest(): PoolSnapshot<P> | null { return this.last; }

  private read(i: number): PoolSnapshot<P> {
    const at = i * this.stride;
    const pool = this.model.decode(this.addr, this.buf, at);
    const v = new DataView(this.buf.buffer, this.buf.byteOffset + at + this.model.recordBytes, SNAPSHOT_EXTRA_BYTES);
    return {
      pool, effectiveQuoteLamports: this.model.effectiveQuote(pool), spotSolPerToken: this.model.spot(pool),
      providerSlot: v.getBigUint64(0, true) as Slot, readLatencyMs: v.getFloat32(8, true), observationLagSlots: v.getInt32(12, true),
      feeTotalBps: v.getUint16(16, true), providerLabel: this.providers[v.getUint16(18, true)] as string,
      rawHash: Buffer.from(this.buf.subarray(at + this.model.recordBytes + 20, at + this.model.recordBytes + 20 + HASH_BYTES)).toString('hex'),
    };
  }

  /** The snapshots observed in [fromMs, toMs], oldest first (read-only copies). */
  history(fromMs: number, toMs: number): Array<PoolSnapshot<P>> {
    const out: Array<PoolSnapshot<P>> = [];
    for (let k = 0; k < this.count; k++) {
      const s = this.read((this.head - this.count + k + this.cap) % this.cap);
      if (s.pool.observedAtMs >= fromMs && s.pool.observedAtMs <= toMs) out.push(s);
    }
    return out;
  }

  /** The newest snapshot with `providerSlot` strictly below `slot` (M01's orientation guard). */
  before(slot: Slot): PoolSnapshot<P> | null {
    for (let k = 1; k <= this.count; k++) {
      const s = this.read((this.head - k + this.cap) % this.cap);
      if (s.providerSlot < slot) return s;
    }
    return null;
  }

  /** A new capacity (a pool's class changed); keeps the newest snapshots that fit. */
  resize(capacity: number): void {
    if (capacity === this.cap || this.released) return;
    const keep = Math.min(this.count, capacity);
    const next = this.buffers === null ? new Uint8Array(capacity * this.stride) : this.buffers.take(capacity * this.stride);
    for (let k = 0; k < keep; k++) {
      const from = ((this.head - keep + k + this.cap) % this.cap) * this.stride;
      next.set(this.buf.subarray(from, from + this.stride), k * this.stride);
    }
    this.buffers?.give(this.buf);
    this.buf = next;
    this.cap = capacity;
    this.count = keep;
    this.head = keep % capacity;
  }
}
