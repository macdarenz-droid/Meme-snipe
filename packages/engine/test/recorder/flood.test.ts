// A-M07-01 "failure injection: producer flood at 10x capacity", and the memory bound behind the 6 Oct out-of-memory
// restart loop (docs/MIGRATION.md "Bugs left behind": M07 recorder memory and disk bounds). The producers append ten
// records for every one the writer takes, for a sustained run, at the default queue_max of 50,000. The test proves
// that the queue, its bytes and every side structure stay inside their bounds, that the heap does not grow with the
// flood, that nothing on a never-dropped stream is lost, and that every dropped record is counted with a gap.
// With the bound removed (makeRoom never drops), the queue grows by 9 records per 10 appended and the test fails.
import { strict as assert } from 'node:assert';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { describe, it } from 'vitest';
import type { UnixMs } from '@bot/types';
import { DEFAULT_CONFIG, GAPS_MAX_PER_STREAM, PROTECTED_STREAMS, RECORD_OVERHEAD_BYTES, RecorderQueue, STREAM_NAMES, type StreamName } from '../../src/index.ts';
import { SEG, T0, rec, snap } from './helpers.ts';

setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc') as () => void;

function heapMb(): number {
  gc();
  gc();
  return process.memoryUsage().heapUsed / 1_048_576;
}

const POOLS = 60;
const ROUNDS = 40;
const TAKE_PER_ROUND = 5_000;
const IN_PER_ROUND = TAKE_PER_ROUND * 10;

describe('recorder flood at 10x the writer', () => {
  it('keeps the queue, its bytes and its side structures bounded and loses no order or fill', { timeout: 300_000 }, () => {
    const logs: string[] = [];
    const q = new RecorderQueue({ log: (level, code) => logs.push(`${level}:${code}`) });
    // poll_counts come from tick() only.
    const droppable = STREAM_NAMES.filter((s) => !PROTECTED_STREAMS.has(s) && s !== 'poll_counts');
    const appended = new Map<StreamName, number>();
    const written = new Map<StreamName, number>();
    let t = T0;
    let state = 0;
    // A 600-byte-ish payload, like a decoded snapshot (ARCH M07 budget).
    const filler = 'x'.repeat(500);

    let heapAfterWarmup = 0;
    let heapPeak = 0;
    for (let round = 0; round < ROUNDS; round++) {
      for (let k = 0; k < IN_PER_ROUND; k++) {
        t += 1;
        let stream: StreamName;
        if (k % 1_000 === 0) stream = k % 2_000 === 0 ? 'order_event' : 'fill';
        else stream = droppable[k % droppable.length] as StreamName;
        state++;
        const r = stream.startsWith('pool_snapshot') ? snap(`pool${state % POOLS}`, state, t, stream) : rec(stream, t, { n: state, filler });
        q.append(r);
        appended.set(stream, (appended.get(stream) ?? 0) + 1);
      }
      q.tick(t as UnixMs);
      for (const r of q.take(TAKE_PER_ROUND, SEG)) written.set(r.stream, (written.get(r.stream) ?? 0) + 1);
      const st = q.stats();
      assert.ok(st.queueDepth <= DEFAULT_CONFIG.queueMax, `round ${round}: depth ${st.queueDepth}`);
      if (round === 9) heapAfterWarmup = heapMb();
      if (round > 9 && round % 10 === 9) heapPeak = Math.max(heapPeak, heapMb());
    }

    const st = q.stats();
    // The bound held at every append, not only between rounds.
    assert.ok(st.peakDepth <= DEFAULT_CONFIG.queueMax, `peak depth ${st.peakDepth}`);
    assert.ok(st.peakBytes <= DEFAULT_CONFIG.queueMaxBytes, `peak bytes ${st.peakBytes}`);
    assert.equal(st.peakDepth, DEFAULT_CONFIG.queueMax, 'the flood did fill the queue');
    // Side structures: bounded by the pools watched and by the gap cap, not by the records appended.
    assert.ok(st.watchedPools <= POOLS && st.acceptedHashes <= POOLS);
    assert.ok(st.encoderStates <= 2 * POOLS * 3, `encoder states ${st.encoderStates}`);
    assert.ok(st.gapsHeld <= STREAM_NAMES.length * (GAPS_MAX_PER_STREAM + 1), `gaps held ${st.gapsHeld}`);
    // Heap: after warm-up the flood of 3,000,000 records adds no more than the queue's own worth of memory.
    const queueMb = (DEFAULT_CONFIG.queueMax * (RECORD_OVERHEAD_BYTES + 700)) / 1_048_576;
    assert.ok(heapPeak - heapAfterWarmup < queueMb, `heap grew ${(heapPeak - heapAfterWarmup).toFixed(1)} MB after warm-up`);

    // Nothing on a never-dropped stream is lost; every other loss is counted and has a gap.
    for (const r of q.take(Number.MAX_SAFE_INTEGER, SEG)) written.set(r.stream, (written.get(r.stream) ?? 0) + 1);
    const gaps = q.drainGaps();
    for (const s of STREAM_NAMES) {
      if (s === 'poll_counts') continue;
      const a = appended.get(s) ?? 0;
      const w = written.get(s) ?? 0;
      const fin = q.stats();
      if (PROTECTED_STREAMS.has(s)) {
        assert.equal(fin.droppedTotal[s], 0, `${s} dropped`);
        assert.equal(w, a, `${s}: ${w} written of ${a}`);
      } else {
        // Appended records are written, dropped, or found unchanged (snapshots and the writer's own check).
        assert.equal(w + fin.droppedTotal[s] + fin.recordsTotal[s].notWritten, a, `${s} does not reconcile`);
        if (fin.droppedTotal[s] > 0) assert.ok((gaps[s]?.length ?? 0) > 0, `${s} dropped without a gap`);
      }
    }
    assert.ok(q.stats().droppedTotal.pool_snapshot_tail > 0);
    assert.ok(logs.includes('warning:M07.backpressure'));
  });
});
