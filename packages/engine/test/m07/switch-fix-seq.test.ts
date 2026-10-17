// Card SWITCH-FIX (red team 2 on bac1f88a): SW-10, records taken for a segment but never written; SW-11, seqs after
// DiskManager deleted a quiet stream's segments; SW-13, a manifest written but missing from its day's index.
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { describe, it } from 'vitest';
import type { Slot, UnixMs } from '@bot/types';
import { SegmentWriter, type WriterFs, type WriterLog } from '../../src/m07/segments.ts';
import { dayManifests } from '../../src/m07/daily.ts';
import { SnapshotDecoder, type EncodedSnapshot } from '../../src/recorder/delta.ts';
import type { RecorderQueue } from '../../src/recorder/queue.ts';
import { tempDir } from '../helpers.ts';
import { startedQueue } from '../recorder/helpers.ts';

const H0 = Date.UTC(2026, 9, 15, 10, 0, 0);
const log: WriterLog = () => undefined;

function writer(dir: string, now: { t: number }, wfs: WriterFs = fs, firstSeq?: Partial<Record<string, bigint>>) {
  const recovery = SegmentWriter.recover({ dataDir: dir, nowMs: now.t as UnixMs, log, fs: wfs });
  const q = startedQueue({ firstSeq: { ...recovery.nextSeq, ...(firstSeq ?? {}) } as never });
  const w = new SegmentWriter({ dataDir: dir, codec: 'gzip', queue: q, nowMs: () => now.t as UnixMs, log, fs: wfs }, recovery);
  return { q, w, recovery };
}
const snap = (q: RecorderQueue, t: number, x: number, y: number, hash: string): void => {
  const r = q.append({ stream: 'pool_snapshot', recvMs: t as UnixMs, slot: BigInt(t) as Slot, commitment: 'confirmed', source: 'test',
    payload: { poolId: 'P', rawHash: hash, priorityClass: 'candidate', fields: { x: String(x), y: String(y) } } });
  assert.equal(r, 'queued');
};
/** Every record of the stream in the hour folder, all parts, decoded in seq order. */
function decoded(dir: string, hour: string, stream: string): { seqs: string[]; states: Array<Record<string, unknown>> } {
  const names = fs.readdirSync(join(dir, hour)).filter((n) => n.startsWith(`${stream}.`) && n.endsWith('.ndjson.gz')).sort();
  const recs = names.flatMap((n) => gunzipSync(fs.readFileSync(join(dir, hour, n))).toString('utf8').split('\n').filter((l) => l !== '')
    .map((l) => JSON.parse(l) as { seq: string; payload: EncodedSnapshot }));
  recs.sort((a, b) => (BigInt(a.seq) < BigInt(b.seq) ? -1 : 1));
  const d = new SnapshotDecoder();
  return { seqs: recs.map((r) => r.seq), states: recs.map((r) => ({ ...d.apply(r.payload).fields })) };
}

describe('SW-10: a record taken but not written never leaves a delta against it, nor a seq hole', () => {
  it('halt-delta probe: {x1,y1} → halt → {x2,y2} discarded → resume → {x2,y3} decodes to {x:2,y:3}, seqs dense', () => {
    const dir = tempDir('sw10-halt');
    const now = { t: H0 + 1_000 };
    const { q, w } = writer(dir, now);
    snap(q, now.t, 1, 1, 'h1');
    w.pump(); w.flush();
    w.halt('disk:test');
    now.t += 1_000;
    snap(q, now.t, 2, 2, 'h2');
    w.pump();                                                             // discarded: halted
    assert.ok(w.resume());
    now.t += 1_000;
    snap(q, now.t, 2, 3, 'h3');
    w.pump(); w.flush(); w.rotate();
    const r = decoded(dir, '2026-10-15/10', 'pool_snapshot');
    assert.deepEqual(r.seqs, ['0', '1']);
    assert.deepEqual(r.states.at(-1), { x: '2', y: '3' });
  });

  it('the same snapshot as the discarded one is written again after a resume (not dropped as unchanged)', () => {
    const dir = tempDir('sw10-same');
    const now = { t: H0 + 1_000 };
    const { q, w } = writer(dir, now);
    snap(q, now.t, 1, 1, 'h1');
    w.pump(); w.flush();
    w.halt('disk:test');
    snap(q, now.t + 1, 2, 2, 'h2');
    w.pump();
    w.resume();
    snap(q, now.t + 2, 2, 2, 'h2');
    w.pump(); w.flush(); w.rotate();
    const r = decoded(dir, '2026-10-15/10', 'pool_snapshot');
    assert.deepEqual(r.seqs, ['0', '1']);
    assert.deepEqual(r.states.at(-1), { x: '2', y: '2' });
  });

  it('a failed flush that was cut back: the lost records give back their seqs and the next snapshot is a keyframe', () => {
    const dir = tempDir('sw10-flush');
    let failWrite = false;
    const faulty: WriterFs = { ...fs, writeSync: ((fd: number, b: Uint8Array) => { if (failWrite) throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }); return fs.writeSync(fd, b); }) as typeof fs.writeSync };
    const now = { t: H0 + 1_000 };
    const { q, w } = writer(dir, now, faulty);
    snap(q, now.t, 1, 1, 'h1');
    w.pump(); w.flush();
    snap(q, now.t + 1, 2, 2, 'h2');
    w.pump();
    failWrite = true;
    w.flush();                                                            // lost, cut back to the last good frame
    assert.ok(w.isHalted());
    failWrite = false;
    now.t += 61_000;
    assert.ok(w.resume());
    snap(q, now.t, 2, 3, 'h3');
    w.pump(); w.flush(); w.rotate();
    const r = decoded(dir, '2026-10-15/10', 'pool_snapshot');
    assert.deepEqual(r.seqs, ['0', '1']);
    assert.deepEqual(r.states.at(-1), { x: '2', y: '3' });
  });

  it('unwrite never gives back a seq that is not the newest taken (no seq is ever used twice)', () => {
    const q = startedQueue();
    for (const i of [1, 2]) q.append({ stream: 'decision', recvMs: (H0 + i) as UnixMs, slot: null, commitment: null, source: 't', payload: { i } });
    const [a, b] = q.take(2, 'seg');
    q.unwrite([a as never]);                                              // seq 0, but seq 1 was taken after it
    assert.equal(q.peekNextSeq('decision'), 2n);
    q.unwrite([b as never]);
    assert.equal(q.peekNextSeq('decision'), 1n);
  });
});

describe('SW-13: recovery adds a written manifest that its day index is missing', () => {
  it('a crash between the manifest and the index write: the next start lists it in the index', () => {
    const dir = tempDir('sw13');
    const now = { t: H0 + 1_000 };
    const { q, w } = writer(dir, now);
    snap(q, now.t, 1, 1, 'h1');
    w.pump(); w.flush();
    const [m] = w.rotate();
    assert.ok(m !== undefined);
    fs.writeFileSync(join(dir, '2026-10-15', 'index.json'), '[]\n');      // the index write never happened
    assert.equal(dayManifests(dir, '2026-10-15').length, 0);
    SegmentWriter.recover({ dataDir: dir, nowMs: (now.t + 5_000) as UnixMs, log });
    assert.deepEqual(dayManifests(dir, '2026-10-15').map((x) => x.path), [m.path]);
    SegmentWriter.recover({ dataDir: dir, nowMs: (now.t + 6_000) as UnixMs, log });   // never listed twice
    assert.equal(JSON.parse(fs.readFileSync(join(dir, '2026-10-15', 'index.json'), 'utf8')).length, 1);
  });

  it('an unreadable index is left as it is (never rewritten from a guess)', () => {
    const dir = tempDir('sw13-bad');
    const now = { t: H0 + 1_000 };
    const { q, w } = writer(dir, now);
    snap(q, now.t, 1, 1, 'h1');
    w.pump(); w.flush(); w.rotate();
    fs.writeFileSync(join(dir, '2026-10-15', 'index.json'), '{not json');
    SegmentWriter.recover({ dataDir: dir, nowMs: (now.t + 5_000) as UnixMs, log });
    assert.equal(fs.readFileSync(join(dir, '2026-10-15', 'index.json'), 'utf8'), '{not json');
  });
});
