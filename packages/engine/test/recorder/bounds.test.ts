// Review round 1 rulings (docs/reviews/Z04.md, round 2 rulings 1, 2, 3 and 9): the watched pool cap and idle
// unwatching, the work one tick may do, the source length and bytes, and gap seconds when gaps merge.
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';
import type { UnixMs } from '@bot/types';
import { DEFAULT_CONFIG, FLUSHED_UNTIL_MAX, GAPS_MAX_PER_STREAM, RECORD_OVERHEAD_BYTES, RecorderQueue, SOURCE_MAX_BYTES } from '../../src/index.ts';
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
    assert.equal(q.notePollFailed('e', 'normal', ms(T0), false), false);
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
    // Every 2 minutes 50 new pools appear, each polled once a second for 5 s, then never again: by the next wave the
    // last ones have been idle for over 60 s (ruling 17). 4,000 minutes.
    while (pool < 100_000) {
      const fresh = Array.from({ length: 50 }, () => `pool${pool++}`);
      for (let s = 0; s < 5; s++) for (const p of fresh) q.append(snap(p, s, t + s * 1_000));
      t += 120_000;
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
    // Every pool that left made way at the cap (idle by elapsed time) or went idle in tick(); none was refused, since
    // each new wave arrives after the last one has been idle for over 60 s (ruling 17).
    assert.ok(st.capUnwatched > 0, 'the cap was reached and pools made way');
    assert.equal(st.capUnwatched + st.idleUnwatched, 100_000 - st.watchedPools);
    assert.equal(st.rejectedTotal.E_POOL_CAP, 0);
  });
});

describe('tick work (ruling 2)', () => {
  // Measured 8 ms locally; the old code took 6 s. The 2 s budget is the timeout.
  it('a +3 day pause over 1,000 pools writes one record per pool within a time budget', { timeout: 2_000 }, async () => {
    const q = new RecorderQueue({ config: { maxWatchedPools: 1_000, idleUnwatchMinutes: 1_440 } });
    for (let i = 0; i < 1_000; i++) q.watch(`p${i}`, 'normal', ms(T0));
    // The feed comes back 3 days later (ruling 25: a tick never writes past the newest received minute + 1).
    q.append(rec('decision', T0 + 3 * 86_400_000));
    q.tick(ms(T0 + 3 * 86_400_000));
    await yieldToTimers();
    const out = q.take(Number.MAX_SAFE_INTEGER, SEG).filter((r) => r.stream === 'poll_counts');
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

describe('the cap makes way (round 3, ruling 12)', () => {
  const full = (q: RecorderQueue, t: number, idle: string | null): void => {
    for (let i = 0; i < DEFAULT_CONFIG.maxWatchedPools; i++) {
      const id = `w${i}`;
      q.append(snap(id, 1, id === idle ? t - 2 * 60_000 : t));
    }
  };

  it('60 watched with one idle for 2 min: a new pool is queued and the idle one makes way', () => {
    const q = new RecorderQueue();
    full(q, T0 + 10 * 60_000, 'w7');
    assert.equal(q.stats().watchedPools, DEFAULT_CONFIG.maxWatchedPools);
    assert.equal(q.append(snap('new', 1, T0 + 10 * 60_000 + 1)), 'queued');
    const st = q.stats();
    assert.equal(st.watchedPools, DEFAULT_CONFIG.maxWatchedPools);
    assert.equal(st.capUnwatched, 1);
    assert.equal(st.rejectedTotal.E_POOL_CAP, 0);
    // w7's counts were written before it was forgotten.
    const w7 = q.take(1_000, SEG).filter((r) => r.stream === 'poll_counts').map(payloadOf).filter((p) => p.poolId === 'w7');
    assert.equal(w7.reduce((a, p) => a + (p.successfulPolls as number), 0), 1);
  });

  it('60 watched, all polled this minute: a new candidate is refused and counted', () => {
    const q = new RecorderQueue();
    full(q, T0 + 10 * 60_000, null);
    assert.deepEqual(q.append(snap('new', 1, T0 + 10 * 60_000 + 1)), { rejected: 'E_POOL_CAP' });
    assert.equal(q.stats().rejectedTotal.E_POOL_CAP, 1);
    assert.equal(q.stats().capUnwatched, 0);
  });

  it('a position pool at a full cap is queued, past the cap', () => {
    const q = new RecorderQueue();
    full(q, T0 + 10 * 60_000, null);
    assert.equal(q.append(snap('pos', 1, T0 + 10 * 60_000 + 1, 'pool_snapshot_position', 'position')), 'queued');
    assert.equal(q.stats().watchedPools, DEFAULT_CONFIG.maxWatchedPools + 1);
    assert.equal(q.stats().rejectedTotal.E_POOL_CAP, 0);
  });
});

describe('idle by elapsed time (round 4, rulings 17-20)', () => {
  const pollCounts = (q: RecorderQueue): Array<Record<string, unknown>> =>
    q.take(Number.MAX_SAFE_INTEGER, SEG).filter((r) => r.stream === 'poll_counts').map(payloadOf);

  it("the red team's repro: 30 pools at 1 Hz, 30 at 0.1 Hz, cap 60, a candidate at minute start + 1 s", () => {
    const q = new RecorderQueue();
    const counts: Array<Record<string, unknown>> = [];
    let liveRefused = 0;
    const start = T0 + 60_000;
    // Three minutes of steady polling; states never change.
    for (let sec = 0; sec < 180; sec++) {
      const t = start + sec * 1_000;
      for (let i = 0; i < 30; i++) if (typeof q.append(snap(`fast${i}`, 1, t)) === 'object') liveRefused++;
      for (let i = 0; i < 30; i++) if ((sec + i) % 10 === 0 && typeof q.append(snap(`slow${i}`, 1, t)) === 'object') liveRefused++;
      // After a warm-up minute (all 60 pools watched), a new candidate at minute start + 1 s, every minute.
      if (sec >= 60 && sec % 60 === 1) q.append(snap(`cand${sec}`, 1, t));
      q.tick(ms(t));
      counts.push(...pollCounts(q));
    }
    q.tick(ms(start + 181_000));
    counts.push(...pollCounts(q));
    const st = q.stats();
    assert.equal(st.capUnwatched, 0, 'no live pool was evicted');
    assert.equal(liveRefused, 0, 'no live pool was refused');
    // Each candidate finds no idle pool, so it alone is refused and counted.
    assert.equal(st.watchedPools, 60);
    assert.equal(st.rejectedTotal.E_POOL_CAP, 2);
    const keys = counts.map((p) => `${String(p.poolId)}@${String(p.minuteStartMs)}`);
    assert.equal(new Set(keys).size, keys.length, 'no (pool, minute) written twice');
    assert.equal(counts.reduce((a, p) => a + (p.changedPolls as number), 0), 0, 'no false changedPolls');
  });

  it('a truly idle pool makes way, judged by its own interval; a position pool never does', () => {
    const q = new RecorderQueue({ config: { maxWatchedPools: 3 } });
    // a: 1 Hz, then silent for 61 s (idle: max(60 s, 3 x 1 s)). b: every 30 s, last 61 s ago (not idle: 3 x 30 s).
    q.append(snap('a', 1, T0));
    q.append(snap('a', 1, T0 + 1_000));
    q.append(snap('b', 1, T0 - 29_000));
    q.append(snap('b', 1, T0 + 1_000));
    q.append(snap('p', 1, T0 + 1_000, 'pool_snapshot_position', 'position'));
    assert.equal(q.append(snap('new1', 1, T0 + 62_000)), 'queued');
    let st = q.stats();
    assert.equal(st.capUnwatched, 1);
    assert.deepEqual(q.append(snap('a', 2, T0 + 62_500)), { rejected: 'E_POOL_CAP' }, 'a was the one evicted');
    // Five minutes later b and new1 are idle, the position pool is not: two new pools take b's and new1's places. The
    // writer's tick shows the clock moved on (else a 5-minute jump in producer time is a clock step, ruling 27).
    q.tick(ms(T0 + 399_000));
    assert.equal(q.append(snap('new2', 1, T0 + 400_000)), 'queued');
    assert.equal(q.append(snap('new3', 1, T0 + 400_001)), 'queued');
    assert.deepEqual(q.append(snap('new4', 1, T0 + 400_002)), { rejected: 'E_POOL_CAP' });
    st = q.stats();
    assert.equal(st.capUnwatched, 3);
    assert.equal(q.append(snap('p', 1, T0 + 400_003, 'pool_snapshot_position', 'position')), 'unchanged', 'p is still watched');
  });

  it('a failed poll of a position pool is counted at a full cap (ruling 19)', () => {
    const q = new RecorderQueue({ config: { maxWatchedPools: 3 } });
    for (const id of ['a', 'b', 'c']) q.append(snap(id, 1, T0 + 1_000));
    assert.equal(q.notePollFailed('pos', 'position', ms(T0 + 2_000), false), false, 'without the flag: refused');
    assert.equal(q.notePollFailed('pos', 'position', ms(T0 + 2_000), true), true);
    q.tick(ms(T0 + 60_000));
    const pos = pollCounts(q).filter((p) => p.poolId === 'pos');
    assert.deepEqual(pos.map((p) => p.failedPolls), [1]);
  });

  it('unwatched and watched again in the same minute: no (pool, minute) record twice (ruling 18)', () => {
    const q = new RecorderQueue();
    q.append(snap('a', 1, T0 + 1_000));
    q.unwatch('a', ms(T0 + 2_000));
    q.append(snap('a', 1, T0 + 3_000));
    // The writer ticks at minute 2; data reaches minute 3, so the tick may write minutes 0-2 (rulings 25 and 27).
    q.tick(ms(T0 + 120_000));
    q.append(rec('decision', T0 + 180_000));
    q.tick(ms(T0 + 180_000));
    const keys = pollCounts(q).filter((p) => p.poolId === 'a').map((p) => p.minuteStartMs);
    assert.deepEqual(keys, [T0, T0 + 60_000, T0 + 120_000]);
  });
});

describe('ruling 21: the no-repeat rule covers unwatch() too', () => {
  const pollCounts = (q: RecorderQueue): Array<Record<string, unknown>> =>
    q.take(Number.MAX_SAFE_INTEGER, SEG).filter((r) => r.stream === 'poll_counts').map(payloadOf);

  it('a boundary eviction (+60.1 s, 1 s polls, cap 3) is refused', () => {
    const q = new RecorderQueue({ config: { maxWatchedPools: 3 } });
    // Three pools polled once a second from T0 to T0 + 59 s; a candidate at T0 + 60.1 s, just past the minute
    // boundary. All three were polled 1.1 s ago, so none is idle, though none polled in the new minute.
    for (let sec = 0; sec < 60; sec++) for (const id of ['a', 'b', 'c']) q.append(snap(id, 1, T0 + sec * 1_000));
    assert.deepEqual(q.append(snap('cand', 1, T0 + 60_100)), { rejected: 'E_POOL_CAP' });
    assert.equal(q.stats().capUnwatched, 0);
  });

  it('a position pool is never a victim, however long it is silent', () => {
    const q = new RecorderQueue({ config: { maxWatchedPools: 1 } });
    q.append(snap('pos', 1, T0, 'pool_snapshot_position', 'position'));
    assert.deepEqual(q.append(snap('cand', 1, T0 + 3_600_000)), { rejected: 'E_POOL_CAP' });
    assert.equal(q.stats().capUnwatched, 0);
  });

  it('no (pool, minute) record twice after an eviction, a re-admission and an unwatch in one minute', () => {
    const q = new RecorderQueue({ config: { maxWatchedPools: 1 } });
    q.append(snap('a', 1, T0 + 1_000));
    // b takes a's place (a idle 70 s) in minute 1; a comes back in minute 1, taking b's place later in it; then unwatch.
    q.append(snap('b', 1, T0 + 71_000));
    q.append(snap('b', 1, T0 + 72_000));
    q.append(snap('a', 1, T0 + 119_000, 'pool_snapshot_position', 'position'));
    q.unwatch('a', ms(T0 + 119_500));
    q.append(snap('a', 2, T0 + 119_800, 'pool_snapshot_position', 'position'));
    q.tick(ms(T0 + 240_000));
    const keys = pollCounts(q).map((p) => `${String(p.poolId)}@${String(p.minuteStartMs)}`);
    assert.equal(new Set(keys).size, keys.length, `duplicates in ${keys.join(', ')}`);
  });
});

describe('round 5 (rulings 22 and 23)', () => {
  it('the tick race: a poll stamped in a written minute but appended after the tick writes no minute twice', () => {
    const q = new RecorderQueue();
    q.append(snap('p', 1, T0 + 10_000));
    q.unwatch('p', ms(T0 + 30_000));
    q.tick(ms(T0 + 60_100));
    q.append(snap('p', 1, T0 + 59_990));
    q.tick(ms(T0 + 120_100));
    const counts = (): string[] => q.take(Number.MAX_SAFE_INTEGER, SEG).filter((r) => r.stream === 'poll_counts').map(payloadOf)
      .map((p) => `${String(p.poolId)}@${String(p.minuteStartMs)}`);
    const keys = counts();
    // No record arrived in minute 2, so the second tick may not write minute 1 yet (ruling 25)...
    assert.deepEqual(keys, [`p@${T0}`]);
    // ...and once data reaches minute 2 it does, still once.
    q.append(rec('decision', T0 + 120_200));
    q.tick(ms(T0 + 120_300));
    keys.push(...counts());
    assert.equal(new Set(keys).size, keys.length, `duplicates in ${keys.join(', ')}`);
    assert.deepEqual(keys, [`p@${T0}`, `p@${T0 + 60_000}`]);
    assert.equal(q.stats().latePolls, 1);
  });

  it('a failed poll never clears the position mark: the position pool is not evicted', () => {
    const q = new RecorderQueue({ config: { maxWatchedPools: 2 } });
    q.append(snap('pos', 1, T0, 'pool_snapshot_position', 'position'));
    q.notePollFailed('pos', 'position', ms(T0 + 500), false);
    q.append(snap('a', 1, T0 + 1_000));
    assert.equal(q.append(snap('b', 1, T0 + 62_000)), 'queued');
    // a made way, not pos.
    assert.equal(q.append(snap('pos', 1, T0 + 62_100, 'pool_snapshot_position', 'position')), 'unchanged');
    assert.equal(q.stats().capUnwatched, 1);
  });
});

describe('round 5 (ruling 24): the forgotten pools map stays bounded without a tick', () => {
  it('100,000 unwatches with no tick keep the map at or under its cap', () => {
    const q = new RecorderQueue({ config: { maxWatchedPools: 10_000 } });
    let peak = 0;
    for (let i = 0; i < 100_000; i++) {
      const t = T0 + i * 10;
      q.append(snap(`u${i}`, 1, t));
      q.unwatch(`u${i}`, ms(t));
      peak = Math.max(peak, q.stats().flushedUntilHeld);
    }
    assert.ok(peak <= FLUSHED_UNTIL_MAX, `peak ${peak}`);
    assert.equal(q.stats().watchedPools, 0);
  });

  it('a pool whose entry the cap dropped writes no minute twice when it comes back in the same minute', () => {
    const q = new RecorderQueue();
    const collected: Array<Record<string, unknown>> = [];
    q.append(snap('p', 1, T0 + 1_000));
    q.unwatch('p', ms(T0 + 2_000));
    // Push p's entry out: more forgotten pools than the cap, all in minute 0, no tick.
    for (let i = 0; i <= FLUSHED_UNTIL_MAX; i++) {
      q.append(snap(`x${i}`, 1, T0 + 3_000));
      q.unwatch(`x${i}`, ms(T0 + 3_000));
      collected.push(...q.take(Number.MAX_SAFE_INTEGER, SEG).filter((r) => r.stream === 'poll_counts').map(payloadOf));
    }
    assert.ok(q.stats().flushedUntilHeld <= FLUSHED_UNTIL_MAX);
    q.append(snap('p', 1, T0 + 4_000));
    q.tick(ms(T0 + 180_000));
    collected.push(...q.take(Number.MAX_SAFE_INTEGER, SEG).filter((r) => r.stream === 'poll_counts').map(payloadOf));
    const p = collected.filter((c) => c.poolId === 'p').map((c) => c.minuteStartMs);
    assert.equal(new Set(p).size, p.length, `p minutes ${p.join(', ')}`);
  });
});

describe('round 6 (ruling 25): one wrong forward time cannot stop new pools\' per-minute counts', () => {
  const perMinute = (q: RecorderQueue, pool: string): Array<Record<string, unknown>> =>
    q.take(Number.MAX_SAFE_INTEGER, SEG).filter((r) => r.stream === 'poll_counts').map(payloadOf).filter((p) => p.poolId === pool);

  /** A fresh pool polled once a second from minute 1 to the end of minute 5, the writer ticking each second. */
  const fiveMinutes = (q: RecorderQueue): void => {
    for (let sec = 60; sec < 360; sec++) {
      q.append(snap('fresh', 1, T0 + sec * 1_000));
      q.tick(ms(T0 + sec * 1_000));
    }
    q.tick(ms(T0 + 360_000));
  };
  const expectMinutes = (rows: Array<Record<string, unknown>>): void => {
    assert.deepEqual(rows.map((p) => [p.minuteStartMs, p.successfulPolls, p.skippedMinutes]),
      [1, 2, 3, 4, 5].map((m) => [T0 + m * 60_000, 60, undefined]));
  };

  it('repro A: tick(T0 + 1 h), then 5 minutes of normal polls and ticks: the fresh pool gets per-minute records', () => {
    const logs: string[] = [];
    const q = new RecorderQueue({ log: (l, c) => logs.push(`${l}:${c}`) });
    q.append(snap('p', 1, T0));
    q.tick(ms(T0 + 3_600_000));
    fiveMinutes(q);
    expectMinutes(perMinute(q, 'fresh'));
    assert.equal(q.stats().clockSteps, 1);
    assert.ok(logs.includes('warning:M07.clock_step'));
  });

  it('repro B: unwatch(bad, T0 + 1 day), then 4,096 unwatches, then a fresh pool: per-minute records', () => {
    const q = new RecorderQueue();
    q.append(snap('bad', 1, T0));
    q.unwatch('bad', ms(T0 + 86_400_000));
    for (let i = 0; i < FLUSHED_UNTIL_MAX; i++) {
      q.append(snap(`u${i}`, 1, T0 + 1_000));
      q.unwatch(`u${i}`, ms(T0 + 1_000));
    }
    q.take(Number.MAX_SAFE_INTEGER, SEG);
    fiveMinutes(q);
    expectMinutes(perMinute(q, 'fresh'));
    assert.equal(q.stats().clockSteps, 1);
  });
});

describe('round 6 (ruling 26): polls moved late are never lost when the pool is forgotten', () => {
  it("the reviewer's repro: all 3 polls are counted, no (pool, minute) twice", () => {
    const q = new RecorderQueue();
    q.append(snap('a', 1, T0 + 1_000));
    q.unwatch('a', ms(T0 + 2_000));
    q.append(snap('a', 1, T0 + 3_000));
    q.append(snap('a', 1, T0 + 4_000));
    q.unwatch('a', ms(T0 + 5_000));
    q.tick(ms(T0 + 300_000));
    const rows = q.take(Number.MAX_SAFE_INTEGER, SEG).filter((r) => r.stream === 'poll_counts').map(payloadOf);
    const keys = rows.map((p) => `${String(p.poolId)}@${String(p.minuteStartMs)}`);
    assert.equal(new Set(keys).size, keys.length, `duplicates in ${keys.join(', ')}`);
    assert.equal(rows.reduce((a, p) => a + (p.successfulPolls as number), 0), 3);
  });
});

describe('round 7 (rulings 27-29): producer clock steps, forward and backward', () => {
  const perMinute = (q: RecorderQueue, pool: string): Array<Record<string, unknown>> =>
    q.take(Number.MAX_SAFE_INTEGER, SEG).filter((r) => r.stream === 'poll_counts').map(payloadOf).filter((p) => p.poolId === pool);

  it('a rejected record at +1 day does not move maxRecvMinute (ruling 27)', () => {
    const q = new RecorderQueue();
    q.append(snap('a', 1, T0 + 1_000));
    assert.equal(q.stats().maxRecvMinute, T0 / 60_000);
    assert.deepEqual(q.append(rec('decision', T0 + 86_400_000, new Map())), { rejected: 'E_PAYLOAD' });
    assert.deepEqual(q.append(rec('pool_snapshot', T0 + 86_400_000, { poolId: 'x', rawHash: 'h', priorityClass: 'n', fields: {}, extra: 1 })), { rejected: 'E_PAYLOAD' });
    assert.equal(q.stats().maxRecvMinute, T0 / 60_000);
  });

  it('one discovery record at +1 day, then a bad tick and normal polls: a new pool still gets per-minute records', () => {
    const q = new RecorderQueue();
    q.append(snap('a', 1, T0 + 1_000));
    q.tick(ms(T0 + 2_000));
    assert.equal(q.append(rec('discovery', T0 + 86_400_000)), 'queued', 'the record itself is kept');
    // With maxRecvMinute at +1 day, a tick 1 h ahead would no longer be capped.
    q.tick(ms(T0 + 3_600_000));
    for (let sec = 60; sec < 360; sec++) {
      q.append(snap('fresh', 1, T0 + sec * 1_000));
      q.tick(ms(T0 + sec * 1_000));
    }
    q.tick(ms(T0 + 360_000));
    assert.deepEqual(perMinute(q, 'fresh').map((p) => [p.minuteStartMs, p.successfulPolls, p.skippedMinutes]),
      [1, 2, 3, 4, 5].map((m) => [T0 + m * 60_000, 60, undefined]));
    assert.equal(q.stats().maxRecvMinute, (T0 + 359_000 - ((T0 + 359_000) % 60_000)) / 60_000);
    assert.ok(q.stats().clockSteps >= 2, 'the forward record and the forward tick each opened an episode');
  });

  it('a backward step: +1 h for 4 min (long enough to be adopted, ruling 37), then corrected for 8 min: a clock_step gap covers the late minutes (ruling 28)', () => {
    const logs: string[] = [];
    const q = new RecorderQueue({ log: (l, c) => logs.push(`${l}:${c}`) });
    const gaps: Array<{ fromMs: number; toMs: number; reason: string }> = [];
    const step = (t: number, pools: string[]): void => {
      for (const p of pools) q.append(snap(p, 1, t));
      q.tick(ms(t));
      gaps.push(...(q.drainGaps().poll_counts ?? []));
    };
    for (let s = 0; s < 120; s++) step(T0 + s * 1_000, ['a']);
    for (let s = 120; s < 360; s++) step(T0 + 3_600_000 + s * 1_000, ['a']);
    for (let s = 360; s < 840; s++) step(T0 + s * 1_000, ['a', 'n']);
    q.take(Number.MAX_SAFE_INTEGER, SEG);
    assert.ok(q.stats().clockSteps >= 1);
    // Logged once per episode, not once per poll.
    assert.ok(logs.filter((l) => l === 'warning:M07.clock_step').length <= 3, `${logs.length} logs`);
    const stepGaps = gaps.filter((g) => g.reason === 'clock_step');
    // Every corrected minute (6 to 13) is inside a clock_step gap.
    for (let m = 6; m < 14; m++) {
      const at = T0 + m * 60_000;
      assert.ok(stepGaps.some((g) => g.fromMs <= at && g.toMs >= at + 59_999), `minute ${m} not covered`);
    }
  });
});

describe('round 7 (ruling 31): the queue\'s own poll_counts never move maxRecvMinute', () => {
  const freshMinutes = (q: RecorderQueue): unknown[] => {
    for (let sec = 60; sec < 360; sec++) {
      q.append(snap('fresh', 1, T0 + sec * 1_000));
      q.tick(ms(T0 + sec * 1_000));
    }
    q.tick(ms(T0 + 360_000));
    return q.take(Number.MAX_SAFE_INTEGER, SEG).filter((r) => r.stream === 'poll_counts').map(payloadOf)
      .filter((p) => p.poolId === 'fresh').map((p) => [p.minuteStartMs, p.successfulPolls, p.skippedMinutes]);
  };
  const want = [1, 2, 3, 4, 5].map((m) => [T0 + m * 60_000, 60, undefined]);

  it('two forward-stepped ticks in a row: a fresh pool still gets per-minute records', () => {
    const q = new RecorderQueue();
    q.append(snap('a', 1, T0 + 1_000));
    // The first bad tick writes a's minute 0 as a poll_counts record stamped with the bad time.
    q.tick(ms(T0 + 3_600_000));
    q.tick(ms(T0 + 3_660_000));
    assert.deepEqual(freshMinutes(q), want);
    assert.equal(q.stats().maxRecvMinute, T0 / 60_000 + 5);
  });

  it('a bad tick followed by an unwatch: a fresh pool still gets per-minute records', () => {
    const q = new RecorderQueue();
    q.append(snap('a', 1, T0 + 1_000));
    q.tick(ms(T0 + 3_600_000));
    q.unwatch('a', ms(T0 + 3_600_000));
    assert.deepEqual(freshMinutes(q), want);
  });
});

describe('round 8 (rulings 33-36)', () => {
  it("the red team's repro: one pool's 20 ms boundary latency excludes nothing (ruling 33)", () => {
    const q = new RecorderQueue();
    const gaps: Array<{ fromMs: number; toMs: number; reason: string; poolId?: string }> = [];
    const rows: Array<Record<string, unknown>> = [];
    // 30 pools at 1 Hz for 120 minutes; each minute one p0 poll stamped 20 ms before the minute, appended after the
    // tick that wrote that minute.
    for (let sec = 0; sec < 7_200; sec++) {
      const t = T0 + sec * 1_000;
      for (let i = 0; i < 30; i++) q.append(snap(`p${i}`, 1, t));
      q.tick(ms(t));
      if (sec % 60 === 0 && sec > 0) q.append(snap('p0', 1, t - 20));
      if (sec % 600 === 0) {
        gaps.push(...(q.drainGaps().poll_counts ?? []));
        rows.push(...q.take(Number.MAX_SAFE_INTEGER, SEG).filter((r) => r.stream === 'poll_counts').map(payloadOf));
      }
    }
    gaps.push(...(q.drainGaps().poll_counts ?? []));
    rows.push(...q.take(Number.MAX_SAFE_INTEGER, SEG).filter((r) => r.stream === 'poll_counts').map(payloadOf));
    assert.deepEqual(gaps, [], 'no gap on poll_counts');
    assert.equal(q.stats().movedPolls, 0);
    // The moved polls are noted in p0's records instead: one per minute, from the minute before.
    const p0 = rows.filter((r) => r.poolId === 'p0' && r.latePolls !== undefined);
    assert.ok(p0.length >= 100, `${p0.length} p0 records with latePolls`);
    assert.ok(p0.every((r) => r.latePolls === 1 && r.lateFromMinuteStartMs === (r.minuteStartMs as number) - 60_000));
    assert.ok(rows.filter((r) => r.poolId !== 'p0').every((r) => r.latePolls === undefined));
  });

  it('a poll gap names its pool, and a poll simply 3 minutes late is `moved`, not a clock step (ruling 39)', () => {
    const q = new RecorderQueue();
    for (let sec = 0; sec < 300; sec++) {
      q.append(snap('a', 1, T0 + sec * 1_000));
      q.append(snap('b', 1, T0 + sec * 1_000));
      q.tick(ms(T0 + sec * 1_000));
    }
    // a's poll stamped 3 minutes back: moved more than one minute.
    q.append(snap('a', 1, T0 + 120_000));
    const gaps = q.drainGaps().poll_counts ?? [];
    assert.ok(gaps.length > 0 && gaps.every((g) => g.reason === 'moved' && g.poolId === 'a'), JSON.stringify(gaps));
    assert.equal(q.stats().movedPolls, 1);
  });

  it('1 Hz polls plus 600 discovery records at +1 day are one clock-step episode, not 600 (ruling 34)', () => {
    const logs: string[] = [];
    const q = new RecorderQueue({ log: (l, c) => logs.push(`${l}:${c}`) });
    for (let sec = 0; sec < 600; sec++) {
      const t = T0 + sec * 1_000;
      q.append(snap('a', 1, t));
      q.append(rec('discovery', t + 86_400_000));
      q.tick(ms(t));
    }
    assert.equal(q.stats().clockSteps, 1);
    assert.equal(logs.filter((l) => l === 'warning:M07.clock_step').length, 1);
    assert.equal(q.stats().maxRecvMinute, T0 / 60_000 + 9);
  });

  it('600 alternating good and bad ticks are one episode, and a +1 day record right after a bad tick is not taken (ruling 35)', () => {
    const q = new RecorderQueue();
    for (let i = 0; i < 600; i++) {
      const t = T0 + i * 1_000;
      q.append(snap('a', 1, t));
      q.tick(ms(i % 2 === 0 ? t : t + 86_400_000));
    }
    assert.equal(q.stats().clockSteps, 1);
    // The last tick (i = 599) was a bad one.
    const before = q.stats().maxRecvMinute;
    q.append(rec('discovery', T0 + 599_000 + 86_400_000));
    assert.equal(q.stats().maxRecvMinute, before);
  });

  it('a record rejected 2 minutes ahead (inside the step window) does not move maxRecvMinute (ruling 36)', () => {
    const q = new RecorderQueue();
    q.append(snap('a', 1, T0 + 1_000));
    assert.deepEqual(q.append(rec('decision', T0 + 120_000, new Map())), { rejected: 'E_PAYLOAD' });
    assert.deepEqual(q.append(rec('decision', T0 + 120_000, { s: 'y'.repeat(70_000) })), { rejected: 'E_TOO_LARGE' });
    assert.deepEqual(q.append({ ...rec('decision', T0 + 120_000), source: 's'.repeat(300) }), { rejected: 'E_ENVELOPE' });
    assert.equal(q.stats().maxRecvMinute, T0 / 60_000);
  });
});

describe('round 9 (ruling 37): the tick clock is trusted only when anchored or lasting', () => {
  it("the red team's repro: tick +1 d, tick +1 d + 1 s, a record at +1 d + 2 s does not move maxRecvMinute", () => {
    const q = new RecorderQueue();
    q.append(snap('a', 1, T0 + 1_000));
    q.tick(ms(T0 + 2_000));
    q.tick(ms(T0 + 86_400_000));
    q.tick(ms(T0 + 86_401_000));
    q.append(rec('discovery', T0 + 86_402_000));
    assert.equal(q.stats().maxRecvMinute, T0 / 60_000);
  });

  it('a short +1 h burst (2 minutes) is contained: the corrected minutes are recorded one by one with no gap', () => {
    const q = new RecorderQueue();
    const gaps: Array<{ fromMs: number; toMs: number; reason: string; poolId?: string }> = [];
    const step = (t: number): void => {
      q.append(snap('a', 1, t));
      q.tick(ms(t));
      gaps.push(...(q.drainGaps().poll_counts ?? []));
    };
    for (let s = 0; s < 120; s++) step(T0 + s * 1_000);
    for (let s = 120; s < 240; s++) step(T0 + 3_600_000 + s * 1_000);
    for (let s = 240; s < 720; s++) step(T0 + s * 1_000);
    q.tick(ms(T0 + 720_000));
    const rows = q.take(Number.MAX_SAFE_INTEGER, SEG).filter((r) => r.stream === 'poll_counts').map(payloadOf);
    // Minutes 4 to 11 are whole minutes of 60 polls each; only the burst's minutes carry a clock_step gap.
    for (let m = 4; m < 12; m++) {
      const r = rows.find((x) => x.minuteStartMs === T0 + m * 60_000);
      assert.equal(r?.successfulPolls, 60, `minute ${m}`);
      assert.ok(!gaps.some((g) => g.fromMs <= T0 + m * 60_000 && g.toMs >= T0 + m * 60_000), `minute ${m} has a gap`);
    }
    assert.ok(gaps.some((g) => g.reason === 'clock_step' && g.poolId === 'a'));
    assert.ok(q.stats().clockSteps >= 1);
  });

  it('a lasting clock change (ticks and records +1 h for 4 minutes) is adopted', () => {
    const q = new RecorderQueue();
    for (let s = 0; s < 60; s++) {
      q.append(snap('a', 1, T0 + s * 1_000));
      q.tick(ms(T0 + s * 1_000));
    }
    for (let s = 60; s < 300; s++) {
      q.append(snap('a', 1, T0 + 3_600_000 + s * 1_000));
      q.tick(ms(T0 + 3_600_000 + s * 1_000));
    }
    assert.ok((q.stats().maxRecvMinute ?? 0) >= T0 / 60_000 + 60, `maxRecvMinute ${q.stats().maxRecvMinute}`);
  });
});

describe('outage episodes close on the outage window or quiet (round 10, ruling 41)', () => {
  it('a tick clock running 7 min ahead of a live feed for 720 min is one outage episode, not one per record', () => {
    const logs: string[] = [];
    const q = new RecorderQueue({ log: (l, c) => logs.push(`${l}:${c}`) });
    for (let m = 0; m < 720; m++) {
      q.append(snap('a', m, T0 + m * 60_000 + 1_000));
      q.tick(ms(T0 + (m + 7) * 60_000 + 30_000));
      q.take(10_000, SEG);
    }
    assert.equal(q.stats().outages, 1);
    assert.equal(logs.filter((x) => x === 'warning:M07.outage').length, 1);
  });

  it('a feed that resumes closes the episode, so a later silence is a second outage', () => {
    const q = new RecorderQueue();
    q.append(snap('a', 0, T0 + 1_000));
    for (let m = 0; m <= 10; m++) q.tick(ms(T0 + m * 60_000 + 500));
    assert.equal(q.stats().outages, 1);
    // The feed resumes at minute 10; the next tick is back within outageMinutes.
    for (let m = 10; m <= 20; m++) {
      q.append(snap('a', m, T0 + m * 60_000 + 1_000));
      q.tick(ms(T0 + m * 60_000 + 30_000));
    }
    assert.equal(q.stats().outages, 1);
    // Silent again from minute 21.
    for (let m = 21; m <= 30; m++) q.tick(ms(T0 + m * 60_000 + 500));
    assert.equal(q.stats().outages, 2);
    assert.equal(q.stats().clockSteps, 0);
  });

  it('a tick back within outageMinutes of the data closes the episode with no new record', () => {
    const q = new RecorderQueue();
    q.append(snap('a', 0, T0 + 1_000));
    for (let m = 0; m <= 6; m++) q.tick(ms(T0 + m * 60_000 + 500));
    assert.equal(q.stats().outages, 1);
    // The tick clock steps back to 4 min past the data: inside the window, so the episode closes.
    q.tick(ms(T0 + 4 * 60_000 + 500));
    q.tick(ms(T0 + 6 * 60_000 + 500));
    assert.equal(q.stats().outages, 2);
  });
});
