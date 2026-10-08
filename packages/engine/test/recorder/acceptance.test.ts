// A-M07-01 acceptance criteria, one test each.
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';
import { canonicalJson, type UnixMs } from '@bot/types';
import { RecorderQueue, SnapshotDecoder, PROTECTED_STREAMS, STREAM_NAMES, type EncodedSnapshot, type StreamName } from '../../src/index.ts';
import { SEG, T0, payloadOf, rec, snap } from './helpers.ts';

describe('A-M07-01 acceptance', () => {
  it('3,600 polls in an hour with 40 state changes write 40 snapshot records (1 keyframe + 39 deltas) and 60 poll_counts', () => {
    const q = new RecorderQueue();
    // One poll a second; the state changes every 90 polls, so 40 distinct states (the first poll is the first state).
    // The writer ticks once a second, as A-M07-02's loop does.
    for (let i = 0; i < 3_600; i++) {
      q.append(snap('poolA', Math.floor(i / 90), T0 + i * 1_000));
      q.tick((T0 + i * 1_000) as UnixMs);
    }
    q.tick((T0 + 3_600_000) as UnixMs);
    const out = q.take(100_000, SEG);
    const snaps = out.filter((r) => r.stream === 'pool_snapshot');
    const counts = out.filter((r) => r.stream === 'poll_counts');
    assert.equal(snaps.length, 40);
    assert.equal(snaps.filter((r) => payloadOf(r).kind === 'keyframe').length, 1);
    assert.equal(snaps.filter((r) => payloadOf(r).kind === 'delta').length, 39);
    assert.equal(payloadOf(snaps[0]!).kind, 'keyframe');
    assert.equal(counts.length, 60);
    assert.equal(out.length, 100);
    // Each minute saw 60 successful polls; the changes sum to 40.
    let changed = 0;
    for (const [i, r] of counts.entries()) {
      const p = payloadOf(r);
      assert.equal(p.poolId, 'poolA');
      assert.equal(p.minuteStartMs, T0 + i * 60_000);
      assert.equal(p.successfulPolls, 60);
      assert.equal(p.failedPolls, 0);
      assert.equal(p.priorityClass, 'normal');
      changed += p.changedPolls as number;
    }
    // 40 states, so 39 changes between them: the first poll of a watch has no previous hash (ruling 18).
    assert.equal(changed, 39);
    // Seq is dense per stream from 0.
    assert.deepEqual(snaps.map((r) => r.seq), Array.from({ length: 40 }, (_, i) => BigInt(i)));
    // And the keyframe plus deltas decode back to every state.
    const dec = new SnapshotDecoder();
    for (const [i, r] of snaps.entries()) {
      const want = snap('poolA', i, 0).payload;
      assert.equal(canonicalJson(dec.apply(payloadOf(r) as unknown as EncodedSnapshot)), canonicalJson(want));
    }
  });

  it('a full queue with mixed streams never drops order_event or fill, and every dropped stream has a backpressure gap', () => {
    const q = new RecorderQueue({ config: { queueMax: 1_000 } });
    const appended = new Map<StreamName, number>();
    const written = new Map<StreamName, number>();
    const droppable = STREAM_NAMES.filter((s) => !PROTECTED_STREAMS.has(s));
    const protectedStreams = STREAM_NAMES.filter((s) => PROTECTED_STREAMS.has(s));
    let t = T0;
    let i = 0;
    const add = (stream: StreamName): void => {
      t++;
      i++;
      // 50 pools (under the default cap of 60), each append a new state.
      q.append(stream.startsWith('pool_snapshot') ? snap(`p${i % 50}`, i, t, stream) : rec(stream, t));
      appended.set(stream, (appended.get(stream) ?? 0) + 1);
    };
    const takeSome = (n: number): void => {
      for (const r of q.take(n, SEG)) written.set(r.stream, (written.get(r.stream) ?? 0) + 1);
    };
    // 20 rounds: 1,000 records in (10 on the never-dropped streams, 990 over the other nine), 100 taken out, so the
    // producers run at 10x the writer and the queue stays full from the second round on.
    for (let round = 0; round < 20; round++) {
      for (let k = 0; k < 1_000; k++) add(k < 10 ? protectedStreams[k % protectedStreams.length]! : droppable[k % droppable.length]!);
      takeSome(100);
    }
    const st = q.stats();
    assert.equal(st.peakDepth, 1_000);
    const gaps = q.drainGaps();
    takeSome(10_000);
    for (const s of STREAM_NAMES) {
      if (PROTECTED_STREAMS.has(s)) {
        assert.equal(st.droppedTotal[s], 0, `${s} dropped`);
        assert.equal(written.get(s), appended.get(s), `${s} not all written`);
      }
      if (st.droppedTotal[s] > 0) {
        const g = gaps[s];
        assert.ok(g !== undefined && g.length > 0, `${s} dropped without a gap`);
        assert.ok(g.every((x) => x.reason === 'backpressure'));
      }
      assert.equal((written.get(s) ?? 0) + st.droppedTotal[s], appended.get(s), `${s} does not reconcile`);
    }
    assert.ok(st.droppedTotal.pool_snapshot_tail > 0);
  });
});
