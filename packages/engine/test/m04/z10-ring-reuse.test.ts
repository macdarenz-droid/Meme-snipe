// Ruling Z10-38 (2026-10-16): each new pool made a new ring (up to about 0.8 MiB) and each class change another; the
// old ones stayed in glibc's heap until a major GC and pushed the heap's high-water mark (RssAnon) up hour by hour
// at 60 pools. Ring buffers are now handed back and reused, so churn allocates nothing once the caps were reached.
import { strict as assert } from 'node:assert';
import type { Slot, UnixMs } from '@bot/types';
import { describe, it } from 'vitest';
import { RingBuffers, SnapshotRing } from '../../src/m04/ring.ts';
import type { PoolSnapshot } from '../../src/m04/types.ts';
import { createPoolTracker } from '../../src/m04/tracker.ts';
import { FakeTime } from '../m14/helpers.ts';
import { FakeChain, fakeModel, Logs, Metrics, Outputs, ScriptedReader, poolAccounts, type FakePool } from './fake.ts';

/** Counts `new Uint8Array(n)` with n at least `min` while `fn` runs. */
async function bigAllocations(min: number, fn: () => Promise<void>): Promise<number> {
  const Orig = globalThis.Uint8Array;
  let n = 0;
  globalThis.Uint8Array = new Proxy(Orig, { construct(t, args, nt) { if (typeof args[0] === 'number' && args[0] >= min) n++; return Reflect.construct(t, args, nt === globalThis.Uint8Array ? t : nt) as object; } });
  try { await fn(); } finally { globalThis.Uint8Array = Orig; }
  return n;
}

describe('Z10-38 ring buffers are reused', () => {
  it('30 candidate pools replaced 5 times: no new ring buffer after the first 30, and ring bytes unchanged (fails before: 150 more)', async () => {
    const time = new FakeTime();
    const reader = new ScriptedReader();
    const s = { reader, time, chain: new FakeChain(), outputs: new Outputs(), log: new Logs(), metrics: new Metrics() };
    reader.slot = () => s.chain.highest;
    const model64 = { ...fakeModel, recordBytes: 64 };
    const tracker = createPoolTracker<FakePool>({ model: model64, reader, scheduler: time, chain: s.chain, clock: time, outputs: s.outputs, log: s.log, metrics: s.metrics, providerOrder: () => ['primary'] });
    const stride = 64 + 52, ringBytes = stride * 7_200;
    const add = (id: string): void => { for (const [k, v] of poolAccounts(id, 1_000n, 2_000n)) reader.accounts.set(k, v); };
    for (let i = 0; i < 30; i++) { add(`p${i}`); tracker.watch(`p${i}`, 'candidate'); }
    await tracker.settled();
    assert.equal(tracker.ringBytes(), 30 * ringBytes);
    let gen = 0;
    const made = await bigAllocations(ringBytes, async () => {
      for (let round = 1; round <= 5; round++) {
        for (let i = 0; i < 30; i++) tracker.unwatch(`p${(round - 1) * 100 + i}`);
        for (let i = 0; i < 30; i++) { add(`p${round * 100 + i}`); tracker.watch(`p${round * 100 + i}`, 'candidate'); }
        await tracker.settled();
        gen += 30;
      }
    });
    assert.equal(gen, 150);
    assert.equal(made, 0, 'ring buffers allocated during churn');
    assert.equal(tracker.ringBytes(), 30 * ringBytes);
    tracker.stop();
  });

  it('a released ring takes nothing and gives its buffer back; resize gives the old one back; spares are capped', () => {
    const b = new RingBuffers(2);
    const addr = { poolId: 'a', baseVault: 'b', quoteVault: 'q', tokenMint: 'm' };
    const r = new SnapshotRing(addr, fakeModel, 10, [], b);
    const bytes = r.bytes;
    r.resize(20);                                                        // the 10-slot buffer is now a spare
    assert.equal(b.bytes, bytes);
    r.release();
    assert.equal(r.bytes, 0);
    assert.equal(b.bytes, bytes * 3);
    r.release();                                                        // twice is once
    assert.equal(b.bytes, bytes * 3);
    for (let i = 0; i < 5; i++) b.give(new Uint8Array(bytes).fill(7));
    assert.equal(b.bytes, bytes * 2 + bytes * 2, 'at most 2 spares per size');
    const t = b.take(bytes);
    assert.ok(t.every((x) => x === 0), 'a reused buffer is zeroed');
  });

  const addr = { poolId: 'r', baseVault: 'b', quoteVault: 'q', tokenMint: 'm' };
  const snap = (i: number): PoolSnapshot<FakePool> => ({
    pool: { poolId: 'r', asOfSlot: BigInt(i) as Slot, commitment: 'confirmed', observedAtMs: (i * 1_000) as UnixMs, base: BigInt(i), quote: 2n * BigInt(i) },
    effectiveQuoteLamports: 2n * BigInt(i), spotSolPerToken: '2/1', feeTotalBps: 30, providerLabel: 'primary',
    providerSlot: BigInt(i) as Slot, readLatencyMs: 7, observationLagSlots: 0, rawHash: i.toString(16).padStart(64, '0'),
  });

  it('Z10-56 (a): a dropped pool\'s ring stores nothing after release, and never writes into the buffer another pool now owns', () => {
    const b = new RingBuffers(4);
    const a = new SnapshotRing(addr, fakeModel, 10, [], b);
    a.push(snap(1));
    a.release();
    assert.equal(a.latest(), null);
    assert.equal(a.size, 0);
    const other = new SnapshotRing({ ...addr, poolId: 'o' }, fakeModel, 10, [], b);   // takes a's buffer
    assert.equal(b.bytes, 0);
    a.push(snap(2));                                                                  // a late read for the dropped pool
    assert.equal(a.latest(), null);
    assert.equal(a.size, 0);
    assert.deepEqual(a.history(0, Number.MAX_SAFE_INTEGER), []);
    assert.equal(other.size, 0);
    assert.deepEqual(other.history(0, Number.MAX_SAFE_INTEGER), []);
    a.resize(20);                                                                     // and resizing it takes nothing
    assert.equal(a.bytes, 0);
    assert.equal(b.bytes, 0);
    other.push(snap(3));
    assert.deepEqual(other.history(0, Number.MAX_SAFE_INTEGER).map((x) => x.pool.asOfSlot), [3n]);
  });

  it('Z10-56 (b): an empty buffer is never kept as a spare', () => {
    const b = new RingBuffers(4);
    b.give(new Uint8Array(0));
    assert.equal(b.bytes, 0);
  });
});
