// Review round 1 rulings (docs/reviews/Z04.md, round 2 rulings 1, 2, 3 and 9): the watched pool cap and idle
// unwatching, the work one tick may do, the source length and bytes, and gap seconds when gaps merge.
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';
import type { UnixMs } from '@bot/types';
import { DEFAULT_CONFIG, GAPS_MAX_PER_STREAM, RECORD_OVERHEAD_BYTES, RecorderQueue, SOURCE_MAX_BYTES } from '../../src/index.ts';
import { SEG, T0, payloadOf, rec, snap } from './helpers.ts';

const ms = (n: number): UnixMs => n as UnixMs;
/**
 * Lets the test runner's timer run. The time budgets are the tests' timeouts (the lint rule keeps clock reads out of
 * engine code and its tests): a timeout fires only when the test yields, so the long loops yield now and then.
 */
const yieldToTimers = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('watched pools (ruling 1)', () => {
  it('refuses a new pool past maxWatchedPools, counts it, and keeps polling the pools already watched', () => {
    const q = new RecorderQueue({ config: { maxWatchedPools: 3 } });
    for (const p of ['a', 'b', 'c']) assert.equal(q.append(snap(p, 1, T0)), 'queued');
    assert.deepEqual(q.append(snap('d', 1, T0)), { rejected: 'E_POOL_CAP' });
    assert.equal(q.notePollFailed('e', 'normal', ms(T0)), false);
    assert.equal(q.watch('f', 'normal', ms(T0)), false);
    assert.equal(q.append(snap('a', 2, T0 + 1)), 'queued');
    const st = q.stats();
    assert.equal(st.watchedPools, 3);
    assert.equal(st.rejectedTotal.E_POOL_CAP, 3);
    // An unwatched pool frees its place.
    q.unwatch('c', ms(T0 + 2));
    assert.equal(q.append(snap('d', 1, T0 + 3)), 'queued');
  });

  it('unwatches a pool after idleUnwatchMinutes with no poll and frees its state', () => {
    const q = new RecorderQueue({ config: { idleUnwatchMinutes: 2 } });
    q.append(snap('a', 1, T0));
    q.append(snap('b', 1, T0));
    for (let m = 1; m <= 4; m++) {
      q.append(snap('b', 1 + m, T0 + m * 60_000));
      q.tick(ms(T0 + m * 60_000 + 1));
    }
    const st = q.stats();
    assert.equal(st.watchedPools, 1);
    assert.equal(st.idleUnwatched, 1);
    assert.equal(st.acceptedHashes, 1);
    q.take(100, SEG);
    // The pool comes back: its first snapshot is a change again.
    assert.equal(q.append(snap('a', 1, T0 + 5 * 60_000)), 'queued');
  });

  // 500,000 appends; measured 4.3 s locally. The 60 s budget leaves room for a busy CI runner.
  it('a churn of 100,000 pools stays within the cap, the per-tick work and a time budget', { timeout: 60_000 }, async () => {
    const q = new RecorderQueue();
    const cap = DEFAULT_CONFIG.maxWatchedPools;
    let maxWatched = 0;
    let maxTick = 0;
    let pool = 0;
    let t: number = T0;
    // Each minute 50 new pools appear, each polled once a second for 5 s, then never again; 2,000 minutes.
    while (pool < 100_000) {
      const fresh = Array.from({ length: 50 }, () => `pool${pool++}`);
      for (let s = 0; s < 5; s++) for (const p of fresh) q.append(snap(p, s, t + s * 1_000));
      t += 60_000;
      const before = q.stats().recordsTotal.poll_counts.written + q.stats().droppedTotal.poll_counts + q.stats().queueDepth;
      q.tick(ms(t));
      const after = q.stats().recordsTotal.poll_counts.written + q.stats().droppedTotal.poll_counts + q.stats().queueDepth;
      maxTick = Math.max(maxTick, after - before);
      maxWatched = Math.max(maxWatched, q.stats().watchedPools);
      q.take(Number.MAX_SAFE_INTEGER, `seg-${Math.floor(t / 3_600_000)}`);
      if (pool % 5_000 === 0) await yieldToTimers();
    }
    const st = q.stats();
    assert.ok(maxWatched <= cap, `watched ${maxWatched}`);
    assert.ok(st.acceptedHashes <= cap && st.encoderStates <= 2 * cap, `hashes ${st.acceptedHashes}, encoder ${st.encoderStates}`);
    assert.ok(maxTick <= cap * DEFAULT_CONFIG.pollCatchUpMaxMinutes, `one tick wrote ${maxTick}`);
    assert.ok(st.rejectedTotal.E_POOL_CAP > 0, 'the cap was reached and counted');
    assert.ok(st.idleUnwatched > 0, 'idle pools were unwatched');
  });
});

describe('tick work (ruling 2)', () => {
  // Measured 8 ms locally; the old code took 6 s. The 2 s budget is the timeout.
  it('a +3 day pause over 1,000 pools writes one record per pool within a time budget', { timeout: 2_000 }, async () => {
    const q = new RecorderQueue({ config: { maxWatchedPools: 1_000, idleUnwatchMinutes: 1_440 } });
    for (let i = 0; i < 1_000; i++) q.watch(`p${i}`, 'normal', ms(T0));
    q.tick(ms(T0 + 3 * 86_400_000));
    await yieldToTimers();
    const out = q.take(Number.MAX_SAFE_INTEGER, SEG);
    assert.equal(out.length, 1_000);
    assert.ok(out.every((r) => payloadOf(r).skippedMinutes === 3 * 1_440));
  });
});

describe('source (ruling 3)', () => {
  it('refuses a source over 256 bytes and counts source bytes in the queue', () => {
    const q = new RecorderQueue();
    assert.deepEqual(q.append({ ...rec('decision', T0), source: 'é'.repeat(129) }), { rejected: 'E_ENVELOPE' });
    assert.equal(q.append({ ...rec('decision', T0), source: 's'.repeat(SOURCE_MAX_BYTES) }), 'queued');
    // {"n":1790848800000} is 19 bytes.
    assert.equal(q.stats().queueBytes, 19 + SOURCE_MAX_BYTES + RECORD_OVERHEAD_BYTES);
  });
});

describe('gap seconds (ruling 9)', () => {
  it('stay the sum of the gaps reported when gaps merge past the cap', () => {
    const q = new RecorderQueue({ config: { queueMax: 1_000, gapMergeMs: 0 } });
    for (let i = 0; i < 1_000; i++) q.append(rec('decision', T0));
    for (let g = 0; g < 3 * GAPS_MAX_PER_STREAM; g++) {
      // A 2 s drop, then the stream is accepted again, 10 s apart: one closed gap of 2 s each, until they merge.
      q.append(rec('discovery', T0 + g * 10_000));
      q.append(rec('discovery', T0 + g * 10_000 + 2_000));
      q.take(1, SEG);
      q.append(rec('discovery', T0 + g * 10_000 + 3_000));
      q.append(rec('decision', T0));
    }
    // Close the last gap, then compare.
    q.take(Number.MAX_SAFE_INTEGER, SEG);
    q.append(rec('discovery', T0 + 99_999_999));
    const gaps = q.drainGaps().discovery ?? [];
    const sum = gaps.reduce((a, g) => a + (g.toMs - g.fromMs) / 1000, 0);
    assert.ok(gaps.length <= GAPS_MAX_PER_STREAM, `${gaps.length} gaps`);
    assert.equal(q.stats().gapSecondsTotal.discovery, sum);
  });
});
