// A-M08-01 15 s bars and the 60 s bars of A-M08-03 (card Z09; rulings Z09-19 and Z09-32: one rule for live and
// replay, with M07's poll_counts per 15 s bar). The
// recorded-hour fixture of the spec (`fx/md/one_hour_pool_snapshot_segment.ndjson.gz`) does not exist yet and no live
// read is allowed from this container, so the hour is SYNTHETIC: a seeded 1 Hz poll stream with changes at random polls.
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';
import fc from 'fast-check';
import type { UnixMs } from '@bot/types';
import { BAR_DEFAULTS, barSnapshotOf, checkBarConfig, createBarEngine, parseSpot, renderSpot, type Bar, type BarEngine, type BarSnapshot, type PollCountsIn } from '../../src/m08/bars.ts';
import { RecorderQueue } from '../../src/index.ts';
import { replayBars, type ReplayEvent } from '../../src/m08/replay.ts';
import { createRng, nextBelow } from '../../src/m10/rng.ts';
import { startedQueue } from '../recorder/helpers.ts';

const T0 = Date.UTC(2026, 9, 16, 0, 0, 0);
const BAR = 15_000;
const CLOSE = BAR + 1_500;
const spot = (n: bigint): string => renderSpot(n);
const snap = (atMs: number, price: bigint, depth = 1_000n * 10n ** 9n, real = depth, poolId = 'pool-a'): BarSnapshot =>
  ({ poolId, observedAtMs: atMs as UnixMs, spotSolPerToken: spot(price), effectiveQuoteLamports: depth, realQuoteLamports: real });
/** One M07 poll_counts record for the 15 s bar at `barStartMs`, written on time: stamped with the bar's close. */
const counts = (barStartMs: number, successfulPolls: number, poolId = 'pool-a'): PollCountsIn =>
  ({ poolId, barStartMs: barStartMs as UnixMs, durationMs: BAR, successfulPolls, receivedAtMs: (barStartMs + CLOSE) as UnixMs });

type Poll = { at: number; s: BarSnapshot; state: number } | { at: number; failed: true };
type Ev = { at: number; s: BarSnapshot } | { at: number; c: PollCountsIn };
/**
 * One SYNTHETIC hour of one pool: polls at 1 Hz (up to 300 ms jitter; 1 in `failEvery` failed), a change at about 1
 * poll in 4.
 */
function hour(seed: number, failEvery = 0): Poll[] {
  const rng = createRng(seed);
  let price = 10n ** 20n, depth = 1_500n * 10n ** 9n, real = depth - 200n * 10n ** 9n, state = 0;
  const polls: Poll[] = [];
  for (let i = 0; i < 3_600; i++) {
    const at = T0 + i * 1_000 + nextBelow(rng, 300);
    if (failEvery > 0 && nextBelow(rng, failEvery) === 0) { polls.push({ at, failed: true }); continue; }
    if (nextBelow(rng, 4) === 0) {
      price += (price * (BigInt(nextBelow(rng, 2_001)) - 1_000n)) / 100_000n;
      const flow = BigInt(nextBelow(rng, 2_000_001)) - 1_000_000n;
      real += flow; depth += flow; state += 1;
    }
    polls.push({ at, s: snap(at, price, depth, real), state });
  }
  return polls;
}
const countsIn = (payloadJson: string, recvMs: number): PollCountsIn => {
  const p = JSON.parse(payloadJson) as { poolId: string; barStartMs: UnixMs; durationMs: number; successfulPolls: number; skippedBars?: number };
  return { poolId: p.poolId, barStartMs: p.barStartMs, durationMs: p.durationMs, successfulPolls: p.successfulPolls, ...(p.skippedBars === undefined ? {} : { skippedBars: p.skippedBars }), receivedAtMs: recvMs as UnixMs };
};
/**
 * LIVE: the real M07 queue gets every poll; once a second the worker calls queue.tick(t) and then closeDue(t), and the
 * engine gets every poll and every poll_counts record the moment the queue writes it. Returns every emitting
 * closeDue with its time, and the RECORDING: the changed snapshots and the poll_counts records with their recvMs.
 */
function live(polls: readonly Poll[], endMs: number): { out: Array<[number, Bar[]]>; recorded: Ev[] } {
  const q = startedQueue();
  const e = createBarEngine();
  const out: Array<[number, Bar[]]> = [];
  const recorded: Ev[] = [];
  let k = 0;
  for (let t = T0; t <= endMs; t += 1_000) {
    for (; k < polls.length && (polls[k] as Poll).at <= t; k++) {
      const p = polls[k] as Poll;
      if ('failed' in p) { q.notePollFailed('pool-a', 'normal', p.at as UnixMs, false); continue; }
      e.onSnapshot(p.s, 1_000);
      const r = q.append({ stream: 'pool_snapshot', recvMs: p.at as UnixMs, slot: null, commitment: 'confirmed', source: 'test',
        payload: { poolId: 'pool-a', rawHash: `h${p.state}`, priorityClass: 'normal', fields: { state: `${p.state}` } } });
      if (r === 'queued') recorded.push({ at: p.at, s: p.s });
    }
    q.tick(t as UnixMs);
    for (const r of q.take(Number.MAX_SAFE_INTEGER, 'seg')) {
      if (r.stream !== 'poll_counts') continue;
      const c = countsIn(r.payloadJson, r.recvMs);
      e.onPollCounts(c);
      recorded.push({ at: r.recvMs, c });
    }
    const b = e.closeDue(t as UnixMs);
    if (b.length > 0) out.push([t, b]);
  }
  return { out, recorded };
}
/**
 * REPLAY of the recording on the sim clock: at each event time and each second, every record with recvMs ≤ t is
 * delivered before closeDue(t). `readAhead` delivers every poll_counts record at the start instead (a leak probe).
 */
function replay(recorded: readonly Ev[], endMs: number, readAhead = false): Array<[number, Bar[]]> {
  const e = createBarEngine();
  const evs = [...recorded].sort((a, b) => a.at - b.at);
  if (readAhead) for (const ev of evs) if ('c' in ev) e.onPollCounts(ev.c);
  const times = [...new Set([...evs.map((ev) => ev.at), ...Array.from({ length: (endMs - T0) / 1_000 + 1 }, (_, i) => T0 + i * 1_000)])].sort((a, b) => a - b);
  const out: Array<[number, Bar[]]> = [];
  let k = 0;
  for (const t of times) {
    for (; k < evs.length && (evs[k] as Ev).at <= t; k++) {
      const ev = evs[k] as Ev;
      if ('s' in ev) e.onSnapshot(ev.s, 1_000); else if (!readAhead) e.onPollCounts(ev.c);
    }
    const b = e.closeDue(t as UnixMs);
    if (b.length > 0) out.push([t, b]);
  }
  return out;
}
const events = (r: Array<[number, Bar[]]>): Bar[] => r.flatMap(([, b]) => b);
/** A marker's first seqs: every marked stream (Z10 sets all four), 0 unless given. */
const first = (over: Record<string, bigint>): Record<string, bigint> => ({ poll_counts: 0n, pool_snapshot_position: 0n, pool_snapshot: 0n, pool_snapshot_tail: 0n, ...over });
/** The bars of a replay that must not be refused. */
const replayed = (r: ReturnType<typeof replayBars>): Bar[] => {
  if (!r.ok) assert.fail(`replay refused: ${r.error.code} at ${r.error.atMs} on ${r.error.stream}`);
  return events(r.value);
};

describe('A-M08-01 acceptance (SYNTHETIC hour, through the real M07 queue)', () => {
  it('Z09-32 parity: live (every poll) and replay (the recording) emit identical bar.closed events, times and snapshots included', () => {
    for (const seed of [1, 2, 3]) {
      const h = hour(seed, seed === 3 ? 20 : 0);
      const end = T0 + 3_605_000;
      const l = live(h, end);
      const r = replay(l.recorded, end);
      assert.deepEqual(events(r), events(l.out), `seed ${seed}`);
      assert.equal(events(l.out).length, 240, `seed ${seed}: every bar of the hour closed`);
      // Exact counts: each bar's snapshots are the successful polls received in it (no spreading, no ±1).
      const perBar = new Map<number, number>();
      for (const p of h) if (!('failed' in p)) perBar.set(Math.floor(p.at / BAR) * BAR, (perBar.get(Math.floor(p.at / BAR) * BAR) ?? 0) + 1);
      for (const b of events(l.out)) assert.equal(b.snapshots, perBar.get(b.startMs), `seed ${seed}, bar ${b.startMs - T0}`);
      // Every bar closes at start + 15 s + grace, and no run emits one before that.
      for (const b of events(l.out)) assert.equal(b.closedAtMs, b.startMs + CLOSE);
      for (const [t, bars] of [...l.out, ...r]) for (const b of bars) assert.ok(t >= b.closedAtMs);
      // Replay emits each bar exactly at its close; live at the first tick at or after it.
      for (const [t, bars] of r) for (const b of bars) assert.equal(t, b.closedAtMs);
    }
  });

  it('no leak: a poll_counts record is never used before its bar closes; delivering every count early changes nothing', () => {
    const h = hour(4, 25);
    const end = T0 + 3_605_000;
    const l = live(h, end);
    // Every per-bar record is stamped at or after its bar's close.
    for (const ev of l.recorded) if ('c' in ev) assert.ok(ev.at >= ev.c.barStartMs + CLOSE);
    assert.deepEqual(events(replay(l.recorded, end, true)), events(replay(l.recorded, end)));
    // A planted future count: in hand at T0, stamped with bar 0's close. Nothing closes before 16.5 s; then it is used.
    const e = createBarEngine();
    e.onSnapshot(snap(T0 + 1_000, 100n), 1_000);
    e.onPollCounts(counts(T0, 9));
    assert.deepEqual(e.closeDue((T0 + CLOSE - 1) as UnixMs), []);
    assert.deepEqual(e.closeDue((T0 + CLOSE) as UnixMs).map((b) => b.snapshots), [9]);
    // A count received after its bar's close is never used, live or replay: the bar counts its changes only.
    const late = createBarEngine();
    late.onSnapshot(snap(T0 + 1_000, 100n), 1_000);
    late.onPollCounts({ ...counts(T0, 9), receivedAtMs: (T0 + CLOSE + 1) as UnixMs });
    assert.deepEqual(late.closeDue((T0 + CLOSE) as UnixMs).map((b) => b.snapshots), [1]);
    assert.equal(late.stats().lateCounts, 1);
  });

  it('a bar with 11 of 15 snapshots: missing 4, incomplete (26.7% > 20%); 12 of 15 is complete', () => {
    for (const [n, complete] of [[11, false], [12, true]] as const) {
      const e = createBarEngine();
      for (let i = 0; i < n; i++) e.onSnapshot(snap(T0 + i * 1_000, 10n ** 20n + BigInt(i)), 1_000);
      e.onPollCounts(counts(T0, n));
      assert.equal(e.closeDue((T0 + CLOSE - 1) as UnixMs).length, 0);
      const [b] = e.closeDue((T0 + CLOSE) as UnixMs);
      assert.ok(b !== undefined);
      assert.equal(b.snapshots, n);
      assert.equal(b.missing, 15 - n);
      assert.equal(e.isComplete(b), complete);
    }
  });

  it('RT-7 (red team): live and replay close the same bar at the same sim time, start + 16.5 s', () => {
    const a = createBarEngine(), b = createBarEngine();
    const s = snap(T0 + 1_000, 1_000_000n);
    for (const e of [a, b]) { e.onSnapshot(s, 1_000); e.onPollCounts(counts(T0, 15)); }
    const [x, y] = [a.closeDue((T0 + CLOSE) as UnixMs), b.closeDue((T0 + CLOSE) as UnixMs)];
    assert.equal(x.length, 1);
    assert.deepEqual(x, y);
    assert.equal(x[0]?.closedAtMs, T0 + CLOSE);
  });
});

describe('A-M08-01 logic and edges', () => {
  it('property: high ≥ max(open, close) and low ≤ min(open, close)', () => {
    fc.assert(fc.property(fc.array(fc.tuple(fc.integer({ min: 0, max: 59_999 }), fc.bigInt({ min: 1n, max: 10n ** 30n })), { minLength: 1, maxLength: 60 }), (xs) => {
      const e = createBarEngine();
      for (const [t, p] of [...xs].sort((a, b) => a[0] - b[0])) e.onSnapshot(snap(T0 + t, p), 1_000);
      for (const b of e.closeDue((T0 + 400_000) as UnixMs)) {
        const [o, h, l, c] = [b.open, b.high, b.low, b.close].map((x) => parseSpot(x) as bigint) as [bigint, bigint, bigint, bigint];
        assert.ok(h >= o && h >= c && l <= o && l <= c);
      }
    }));
  });

  it('opens at the carried state, flow is the real-vault change from the previous bar, depth change rounds toward zero', () => {
    const e = createBarEngine();
    e.onSnapshot(snap(T0 + 1_000, 100n, 1_000n, 900n), 1_000);
    e.onSnapshot(snap(T0 + 14_000, 120n, 1_100n, 950n), 1_000);
    e.onSnapshot(snap(T0 + 16_000, 90n, 1_099n, 940n), 1_000);
    e.onPollCounts(counts(T0, 2));
    e.onPollCounts(counts(T0 + BAR, 1));
    const [a, b] = e.closeDue((T0 + 100_000) as UnixMs) as [Bar, Bar];
    assert.equal(a.open, spot(100n)); assert.equal(a.high, spot(120n)); assert.equal(a.close, spot(120n));
    assert.equal(a.netQuoteFlowLamports, 50n);
    assert.equal(a.depthChangeBps, 1_000);
    assert.equal(b.open, spot(120n)); assert.equal(b.low, spot(90n));
    assert.equal(b.netQuoteFlowLamports, -10n);
    assert.equal(b.depthChangeBps, -9);
    assert.deepEqual([a.snapshots, b.snapshots], [2, 1]);
  });

  it('an unchanged poll adds nothing; a late snapshot of a closed bar is dropped and counted', () => {
    const e = createBarEngine();
    e.onSnapshot(snap(T0 + 14_900, 100n), 1_000);
    e.onSnapshot(snap(T0 + 14_950, 100n), 1_000);
    assert.equal(e.stats().unchanged, 1);
    e.onPollCounts(counts(T0, 2));
    assert.equal(e.closeDue((T0 + 16_499) as UnixMs).length, 0);
    const [b] = e.closeDue((T0 + 16_500) as UnixMs);
    assert.deepEqual([b?.snapshots, b?.closedAtMs], [2, T0 + 16_500]);              // 2 polls, 1 change: the count is exact
    e.onSnapshot(snap(T0 + 14_990, 102n), 1_000);
    e.onSnapshot(snap(T0 + 14_980, 102n), 1_000);
    assert.equal(e.stats().droppedLate, 2);
  });

  it('no bar for a gap; no bar without decimals (counted); malformed snapshots counted; a stopped pool has no bars', () => {
    const e = createBarEngine();
    e.onSnapshot(snap(T0, 100n), 1_000);
    e.onSnapshot(snap(T0 + 45_000, 101n), 1_000);
    e.onPollCounts(counts(T0, 1));
    e.onPollCounts(counts(T0 + 15_000, 0));                                          // watched, no successful poll: a gap
    e.onPollCounts(counts(T0 + 45_000, 1));
    assert.deepEqual(e.closeDue((T0 + 70_000) as UnixMs).map((b) => b.startMs - T0), [0, 45_000]);
    e.onSnapshot({ ...snap(T0 + 75_000, 1n), spotSolPerToken: null }, 1_000);
    e.onSnapshot({ ...snap(T0 + 75_000, 1n), spotSolPerToken: '1e5' }, 1_000);
    e.onSnapshot(snap(T0 + 76_000, 0n), 1_000);
    assert.deepEqual([e.stats().skippedDecimals, e.stats().skippedMalformed], [1, 2]);
    e.onSnapshot(snap(T0 + 90_000, 102n), 1_000);
    e.stop('pool-a');
    e.onSnapshot(snap(T0 + 91_000, 103n), 1_000);
    e.onPollCounts(counts(T0 + 90_000, 30));
    e.onPollCounts({ ...counts(T0 + 120_000, 30), receivedAtMs: Number.NaN as UnixMs });   // no receipt time: ignored
    assert.equal(e.closeDue((T0 + 2_000_000) as UnixMs).length, 0);
    assert.equal(e.size(), 1);                                                         // a stopped pool is never forgotten
  });

  it('2 Hz pools expect 30 snapshots a bar; 60 s bars expect 60 at 1 Hz and sum their four windows', () => {
    const e = createBarEngine();
    e.onSnapshot(snap(T0, 100n), 500);
    e.onPollCounts(counts(T0, 30));
    assert.equal(e.closeDue((T0 + 200_000) as UnixMs)[0]?.missing, 0);
    const m = createBarEngine({ ...BAR_DEFAULTS, durationMs: 60_000 });
    for (let i = 0; i < 50; i++) m.onSnapshot(snap(T0 + i * 1_000, 100n + BigInt(i)), 1_000);
    // Windows 0-2 have their counts; window 3 has none, so its 5 changed snapshots count.
    for (const w of [0, 1, 2]) m.onPollCounts({ ...counts(T0 + w * BAR, 15), receivedAtMs: (T0 + 61_500) as UnixMs });
    assert.equal(m.closeDue((T0 + 61_499) as UnixMs).length, 0);
    const [b] = m.closeDue((T0 + 61_500) as UnixMs);
    assert.equal(b?.durationMs, 60_000); assert.equal(b?.snapshots, 50); assert.equal(b?.missing, 10); assert.equal(b?.close, spot(149n));
    assert.equal(b?.closedAtMs, T0 + 61_500);
  });

  it('without poll_counts a bar closes on time and counts its changes; a pause record is ignored; quiet bars come from the carried state', () => {
    const e = createBarEngine();
    e.onSnapshot(snap(T0 + 1_000, 100n), 1_000);
    assert.deepEqual(e.closeDue((T0 + CLOSE) as UnixMs).map((b) => [b.snapshots, b.closedAtMs]), [[1, T0 + CLOSE]]);
    const p = createBarEngine();
    p.onSnapshot(snap(T0 + 1_000, 100n), 1_000);
    p.onPollCounts({ ...counts(T0, 300), skippedBars: 20 });
    assert.deepEqual(p.closeDue((T0 + 300_000) as UnixMs).map((b) => b.snapshots), [1]);
    const q = createBarEngine();
    q.onSnapshot(snap(T0 + 1_000, 100n), 1_000);
    for (const w of [0, 1, 2, 3]) q.onPollCounts(counts(T0 + w * BAR, 15));
    q.onPollCounts(counts(T0 + 7, 1));                                              // not a bar start: ignored
    q.onPollCounts({ ...counts(T0 + 4 * BAR, 15), durationMs: 60_000 });             // not a 15 s window: ignored
    q.onPollCounts({ ...counts(T0 + 5 * BAR, 15), successfulPolls: -1 });            // bad count: ignored
    assert.deepEqual(q.closeDue((T0 + 200_000) as UnixMs).map((b) => [b.startMs - T0, b.snapshots, b.open]), [[0, 15, spot(100n)], [15_000, 15, spot(100n)], [30_000, 15, spot(100n)], [45_000, 15, spot(100n)]]);
    q.onPollCounts(counts(T0, 60));                                                 // a closed bar: ignored
    assert.equal(q.closeDue((T0 + 400_000) as UnixMs).length, 0);
    assert.equal(q.stats().lateCounts, 1);
  });

  it('a quiet pool skips its empty bars and closes a bar after the pause', () => {
    const e = createBarEngine();
    e.onSnapshot(snap(T0 + 1_000, 100n), 1_000);
    e.onPollCounts(counts(T0, 1));
    assert.deepEqual(e.closeDue((T0 + 3 * 3_600_000) as UnixMs).map((b) => b.snapshots), [1]);
    e.onSnapshot(snap(T0 + 4 * 3_600_000, 101n), 1_000);
    for (const w of [0, 1, 2, 3]) e.onPollCounts(counts(T0 + 4 * 3_600_000 + w * BAR, 15));
    // Idle for over 10 min, the pool was forgotten (bounded memory): its next bar opens at its first change, in both modes.
    assert.deepEqual(e.closeDue((T0 + 5 * 3_600_000) as UnixMs).map((b) => [b.startMs - T0 - 4 * 3_600_000, b.open, b.close]), [
      [0, spot(101n), spot(101n)], [15_000, spot(101n), spot(101n)], [30_000, spot(101n), spot(101n)], [45_000, spot(101n), spot(101n)]]);
  });

  it('Z09-23: memory is bounded: pools idle for idleForgetMs are forgotten while active ones stay', () => {
    const e = createBarEngine();
    for (let i = 0; i < 2_000; i++) {
      const t = T0 + i * 60_000;
      e.onSnapshot(snap(t, 100n + BigInt(i), 1n, 1n, `p${i}`), 1_000);
      e.onPollCounts(counts(t, 1, `p${i}`));
      e.onSnapshot(snap(t, 100n + BigInt(i), 1n, 1n, 'steady'), 1_000);
      e.onPollCounts(counts(t, 15, 'steady'));
      e.closeDue((t + 59_000) as UnixMs);
      assert.ok(e.size() <= 15, `${e.size()} pools held at ${i}`);
    }
    assert.ok(e.stats().forgotten >= 1_980);
  });

  it('bad expected interval keeps 1 Hz; depth 0 at the open gives depth change 0; bars of one start come out in pool order', () => {
    const e = createBarEngine();
    e.onSnapshot(snap(T0, 100n, 0n, 0n, 'pool-c'), Number.NaN);
    e.onSnapshot(snap(T0 + 1, 101n, 5n, 5n, 'pool-c'), -1);
    for (const p of ['pool-d', 'pool-a', 'pool-b']) e.onSnapshot(snap(T0, 100n, 9n, 9n, p), 1_000);
    for (const p of ['pool-a', 'pool-b', 'pool-c', 'pool-d']) e.onPollCounts(counts(T0, 2, p));
    const bars = e.closeDue((T0 + 200_000) as UnixMs);
    assert.deepEqual(bars.map((b) => b.poolId), ['pool-a', 'pool-b', 'pool-c', 'pool-d']);
    assert.deepEqual([bars[2]?.missing, bars[2]?.depthChangeBps], [13, 0]);
  });

  it('config checks and helpers', () => {
    assert.equal(checkBarConfig(BAR_DEFAULTS), null);
    for (const c of [{ durationMs: 30_000 }, { closeGraceMs: 5_001 }, { closeGraceMs: -1 }, { incompleteMissingBps: 5_001 }, { idleForgetMs: 1 }, { idleForgetMs: 1.5 }]) {
      assert.notEqual(checkBarConfig({ ...BAR_DEFAULTS, ...c } as never), null);
    }
    assert.throws(() => createBarEngine({ ...BAR_DEFAULTS, closeGraceMs: 9_999 }));
    assert.equal(parseSpot('1.5'), 15n * 10n ** 23n);
    assert.equal(parseSpot('x'), null);
    assert.equal(renderSpot(15n * 10n ** 23n), '1.500000000000000000000000');
    assert.deepEqual(barSnapshotOf({ pool: { poolId: 'p', observedAtMs: 5 as UnixMs, quoteReserveReal: 7n }, spotSolPerToken: '1', effectiveQuoteLamports: 9n }),
      { poolId: 'p', observedAtMs: 5, spotSolPerToken: '1', effectiveQuoteLamports: 9n, realQuoteLamports: 7n });
  });
});

export type { BarEngine };

describe('Z09-40 (RT-10): bars agree across a worker restart; Z09-42: early counts are refused', () => {
  /**
   * LIVE across a restart: process 1 starts with its marker and runs to `crashMs` (its last tick), with an unwatch 3 s
   * before (a partial bar stamped after the crash); process 2 starts at `restartMs` with a new queue (seqs continued,
   * as M07's recovery does), its marker and a cold engine. Returns both engines' bars and the recording, each record
   * with its stream seq.
   */
  function liveRestart(polls: readonly Poll[], crashMs: number, restartMs: number, endMs: number, reuseSeq = false): { out: Bar[]; recorded: ReplayEvent[] } {
    const out: Bar[] = [];
    const recorded: ReplayEvent[] = [];
    let q = new RecorderQueue();
    q.markProcessStart('release-1', T0 as UnixMs);
    let e = createBarEngine();
    // Appended snapshots in order; one the encoder finds unchanged at take is never written (and gets no seq).
    const pending: Array<{ at: number; s: BarSnapshot; hash: string }> = [];
    const take = (): void => {
      for (const r of q.take(Number.MAX_SAFE_INTEGER, 'seg')) {
        if (r.stream === 'pool_snapshot') {
          const hash = (JSON.parse(r.payloadJson) as { rawHash: string }).rawHash;
          while ((pending[0] as { hash: string }).hash !== hash) pending.shift();
          const p = pending.shift() as { at: number; s: BarSnapshot };
          recorded.push({ kind: 'snapshot', atMs: p.at, s: p.s, expectedIntervalMs: 1_000, stream: 'pool_snapshot', seq: r.seq });
        } else if (r.stream === 'poll_counts') {
          const c = countsIn(r.payloadJson, r.recvMs);
          e.onPollCounts(c);
          recorded.push({ kind: 'poll_counts', atMs: r.recvMs, seq: r.seq, partial: (JSON.parse(r.payloadJson) as { partial?: true }).partial === true, c });
        } else if (r.stream === 'process_start') {
          const first = (JSON.parse(r.payloadJson) as { firstSeq: Record<string, string> }).firstSeq;
          recorded.push({ kind: 'process_start', atMs: r.recvMs, firstSeq: Object.fromEntries(Object.entries(first).map(([k, v]) => [k, BigInt(v)])) });
        }
      }
    };
    let k = 0;
    for (let t = T0; t <= endMs; t += 1_000) {
      if (t > crashMs && t < restartMs) continue;                                 // down
      if (t >= restartMs && t - 1_000 < restartMs) {
        // reuseSeq: the new process restarts its seqs a little below the last written ones (the Z10 bug Z09-47 guards).
        const cont = (st: 'poll_counts' | 'pool_snapshot'): bigint => (reuseSeq ? q.peekNextSeq(st) - 3n : q.peekNextSeq(st));
        q = new RecorderQueue({ firstSeq: { poll_counts: cont('poll_counts'), pool_snapshot: cont('pool_snapshot') } });
        e = createBarEngine();
        q.markProcessStart('release-2', t as UnixMs);
        take();
        for (; k < polls.length && (polls[k] as Poll).at < t; k++);                 // polls while down were never made
      }
      for (; k < polls.length && (polls[k] as Poll).at <= t; k++) {
        const p = polls[k] as Poll;
        if ('failed' in p) { q.notePollFailed('pool-a', 'normal', p.at as UnixMs, false); continue; }
        e.onSnapshot(p.s, 1_000);
        const r = q.append({ stream: 'pool_snapshot', recvMs: p.at as UnixMs, slot: null, commitment: 'confirmed', source: 'test',
          payload: { poolId: 'pool-a', rawHash: `h${p.state}`, priorityClass: 'normal', fields: { state: `${p.state}` } } });
        if (r === 'queued') pending.push({ at: p.at, s: p.s, hash: `h${p.state}` });
      }
      if (t === crashMs - 3_000) q.unwatch('pool-a', t as UnixMs);                  // a partial bar, stamped after the crash
      q.tick(t as UnixMs);
      take();
      out.push(...e.closeDue(t as UnixMs));
    }
    return { out, recorded };
  }

  it('Z09-40: record across a restart, replay it: identical bar.closed events (the marker resets the engine)', () => {
    for (const seed of [5, 6]) {
      const h = hour(seed, seed === 6 ? 20 : 0);
      // The crash lands mid-bar (31 m 10 s); the worker is back 10 s later, after that bar's close (31 m 16.5 s), which
      // the stopped process never reached: the replay must not close it either (the close frontier).
      const crashMs = T0 + 1_870_000, restartMs = T0 + 1_880_000, end = T0 + 3_605_000;
      const l = liveRestart(h, crashMs, restartMs, end);
      assert.deepEqual(replayed(replayBars(createBarEngine(), l.recorded, { fromMs: T0, endMs: end, stepMs: 1_000 })), l.out, `seed ${seed}`);
      assert.ok(l.out.length > 200);
      assert.ok(l.recorded.some((x) => x.kind === 'poll_counts' && x.partial), 'the unwatch wrote a partial bar');
      // Without the marker (a continuous replay) the first bars after the restart differ: the red team's RT-10.
      const noMarker = replayBars(createBarEngine(), l.recorded.filter((x) => x.kind !== 'process_start'), { fromMs: T0, endMs: end, stepMs: 1_000 });
      assert.notDeepEqual(replayed(noMarker), l.out);
    }
  });

  it('Z09-40: a stopped process\'s count stamped after the marker is its own (by seq), never the restarted engine\'s', () => {
    const B = T0 + 30_000;                                                           // the bar the restart lands in
    const evs: ReplayEvent[] = [
      { kind: 'snapshot', atMs: T0 + 1_000, s: snap(T0 + 1_000, 100n), expectedIntervalMs: 1_000 },
      { kind: 'poll_counts', atMs: T0 + CLOSE, seq: 0n, partial: false, c: counts(T0, 1) },
      // Process 1 unwatched the pool in bar B, then stopped: a partial count stamped with B's close, after the restart.
      { kind: 'poll_counts', atMs: B + CLOSE, seq: 1n, partial: true, c: counts(B, 15) },
      { kind: 'process_start', atMs: B + 5_000, firstSeq: first({ poll_counts: 2n }) },
      { kind: 'snapshot', atMs: B + 6_000, s: snap(B + 6_000, 101n), expectedIntervalMs: 1_000 },
    ];
    const bars = replayed(replayBars(createBarEngine(), evs, { fromMs: T0, endMs: T0 + 120_000, stepMs: 1_000 }));
    // Bar 0 closed before the stop; bar B is the restarted engine's, counted from its own changes only (1), not 15.
    assert.deepEqual(bars.map((b) => [b.startMs - T0, b.snapshots]), [[0, 1], [30_000, 1]]);
  });

  it('Z09-47: a restart that reuses seqs (first seq from the last sealed manifest) is refused, not guessed at', () => {
    const h = hour(5);
    const l = liveRestart(h, T0 + 1_870_000, T0 + 1_880_000, T0 + 3_605_000, true);
    const r = replayBars(createBarEngine(), l.recorded, { fromMs: T0, endMs: T0 + 3_605_000, stepMs: 1_000 });
    assert.ok(!r.ok && r.error.code === 'E_MARKER_SEQ');
    // A marker whose first seq goes below an earlier marker's is refused too.
    const back = replayBars(createBarEngine(), [
      { kind: 'process_start', atMs: T0, firstSeq: first({ poll_counts: 5n }) }, { kind: 'process_start', atMs: T0 + 1_000, firstSeq: first({ poll_counts: 4n }) },
    ], { fromMs: T0, endMs: T0 + 2_000, stepMs: 1_000 });
    assert.deepEqual(back, { ok: false, error: { code: 'E_MARKER_SEQ', atMs: T0 + 1_000, stream: 'poll_counts' } });
  });

  it('Z09-55: seqs are checked per stream on the fly; a marker without every marked stream is refused', () => {
    const c = (at: number, seq: bigint): ReplayEvent => ({ kind: 'poll_counts', atMs: at, seq, partial: false, c: counts(T0, 1) });
    const o = { fromMs: T0, endMs: T0 + 60_000, stepMs: 1_000 };
    assert.ok(replayBars(createBarEngine(), [c(T0 + CLOSE, 1n), c(T0 + CLOSE + 1, 2n)], o).ok);
    assert.deepEqual(replayBars(createBarEngine(), [c(T0 + CLOSE, 2n), c(T0 + CLOSE + 1, 2n)], o), { ok: false, error: { code: 'E_MARKER_SEQ', atMs: T0 + CLOSE + 1, stream: 'poll_counts' } });
    assert.deepEqual(replayBars(createBarEngine(), [c(T0 + CLOSE, 3n), c(T0 + CLOSE + 1, 2n)], o), { ok: false, error: { code: 'E_MARKER_SEQ', atMs: T0 + CLOSE + 1, stream: 'poll_counts' } });
    // Different streams keep their own sequence.
    const snapAt = (seq: bigint): ReplayEvent => ({ kind: 'snapshot', atMs: T0 + 1_000, s: snap(T0 + 1_000, 100n), expectedIntervalMs: 1_000, stream: 'pool_snapshot', seq });
    assert.ok(replayBars(createBarEngine(), [c(T0 + CLOSE, 5n), snapAt(1n)], o).ok);
    assert.deepEqual(replayBars(createBarEngine(), [{ kind: 'process_start', atMs: T0, firstSeq: { poll_counts: 0n } }], o),
      { ok: false, error: { code: 'E_MARKER_SEQ', atMs: T0, stream: 'pool_snapshot_position' } });
  });

  it('Z09-48: snapshots are split by their seq, so a backward clock step across a restart does not misassign them', () => {
    const B = T0 + 30_000;
    const evs: ReplayEvent[] = [
      { kind: 'process_start', atMs: T0, firstSeq: first({}) },
      // Process 1's clock ran 20 s ahead: its last snapshot carries B + 20 s.
      { kind: 'snapshot', atMs: B + 20_000, s: snap(B + 20_000, 500n), expectedIntervalMs: 1_000, stream: 'pool_snapshot', seq: 0n },
      // Process 2 starts on a corrected clock at B + 10 s.
      { kind: 'process_start', atMs: B + 10_000, firstSeq: first({ pool_snapshot: 1n }) },
      { kind: 'snapshot', atMs: B + 12_000, s: snap(B + 12_000, 100n), expectedIntervalMs: 1_000, stream: 'pool_snapshot', seq: 1n },
    ];
    const bars = replayed(replayBars(createBarEngine(), evs, { fromMs: T0, endMs: T0 + 120_000, stepMs: 1_000 }));
    // Bar B is the restarted engine's alone: it opens and closes at process 2's state; process 1's later-stamped
    // snapshot belongs to process 1 and is dropped with it.
    assert.deepEqual(bars.map((b) => [b.startMs - T0, b.open, b.close, b.high]), [[30_000, spot(100n), spot(100n), spot(100n)]]);
    // Split by recvMs instead (no seq), the same input lets process 1's snapshot into process 2's bar.
    const bySeqLost = evs.map((e) => (e.kind === 'snapshot' ? { kind: e.kind, atMs: e.atMs, s: e.s, expectedIntervalMs: e.expectedIntervalMs } : e));
    assert.notDeepEqual(replayed(replayBars(createBarEngine(), bySeqLost, { fromMs: T0, endMs: T0 + 120_000, stepMs: 1_000 })), bars);
  });

  it('Z09-40: with no marker a replay starts cold at its first record, as before; reset() forgets every pool', () => {
    const h = hour(7);
    const l = live(h, T0 + 3_605_000);
    const evs: ReplayEvent[] = l.recorded.map((x) => ('s' in x ? { kind: 'snapshot' as const, atMs: x.at, s: x.s, expectedIntervalMs: 1_000 } : { kind: 'poll_counts' as const, atMs: x.at, seq: BigInt(x.at), partial: false, c: x.c }));
    assert.deepEqual(replayed(replayBars(createBarEngine(), evs, { fromMs: T0, endMs: T0 + 3_605_000, stepMs: 1_000 })), events(l.out));
    const e = createBarEngine();
    e.onSnapshot(snap(T0 + 1_000, 100n), 1_000);
    e.reset();
    assert.equal(e.size(), 0);
    assert.deepEqual(e.closeDue((T0 + 100_000) as UnixMs), []);
  });

  it('Z09-42: a count received before its window ends is refused, counted and logged', () => {
    const logs: string[] = [];
    const e = createBarEngine(BAR_DEFAULTS, { event: (_l, c) => logs.push(c) });
    e.onSnapshot(snap(T0 + 1_000, 100n), 1_000);
    e.onPollCounts({ ...counts(T0, 15), receivedAtMs: (T0 + 14_999) as UnixMs });
    assert.deepEqual([e.stats().earlyCounts, logs], [1, ['m08.poll_counts_early']]);
    assert.deepEqual(e.closeDue((T0 + CLOSE) as UnixMs).map((b) => b.snapshots), [1]);   // its changes only
    const quiet = createBarEngine();                                                 // no log port: counted only
    quiet.onPollCounts({ ...counts(T0, 15), receivedAtMs: T0 as UnixMs });
    assert.equal(quiet.stats().earlyCounts, 1);
  });
});
