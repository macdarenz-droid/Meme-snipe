// A-M08-01 15 s bars and the 60 s bars of A-M08-03 (card Z09; ruling Z09-19: one rule for live and replay). The
// recorded-hour fixture of the spec (`fx/md/one_hour_pool_snapshot_segment.ndjson.gz`) does not exist yet and no live
// read is allowed from this container, so the hour is SYNTHETIC: a seeded 1 Hz poll stream with changes at random polls.
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';
import fc from 'fast-check';
import type { UnixMs } from '@bot/types';
import { BAR_DEFAULTS, barSnapshotOf, checkBarConfig, createBarEngine, parseSpot, renderSpot, spreadPolls, type Bar, type BarEngine, type BarSnapshot, type PollCountsIn } from '../../src/m08/bars.ts';
import { createRng, nextBelow } from '../../src/m10/rng.ts';

const T0 = Date.UTC(2026, 9, 16, 0, 0, 0);
const spot = (n: bigint): string => renderSpot(n);
const snap = (atMs: number, price: bigint, depth = 1_000n * 10n ** 9n, real = depth, poolId = 'pool-a'): BarSnapshot =>
  ({ poolId, observedAtMs: atMs as UnixMs, spotSolPerToken: spot(price), effectiveQuoteLamports: depth, realQuoteLamports: real });
/** The recorder writes a minute's poll_counts at the next minute tick. */
const COUNTS_DELAY = 60_000 + 50;
const counts = (minuteStartMs: number, successfulPolls: number, poolId = 'pool-a'): PollCountsIn =>
  ({ poolId, minuteStartMs: minuteStartMs as UnixMs, successfulPolls, receivedAtMs: (minuteStartMs + COUNTS_DELAY) as UnixMs });
const AFTER = (minute: number): UnixMs => (minute + COUNTS_DELAY) as UnixMs;

type Ev = { at: number; s: BarSnapshot } | { at: number; c: PollCountsIn };
/** One SYNTHETIC hour: polls at 1 Hz (up to 300 ms jitter; 1 in `failEvery` failed), a change at about 1 poll in 4. */
function hour(seed: number, failEvery = 0): { live: Ev[]; recorded: Ev[] } {
  const rng = createRng(seed);
  let price = 10n ** 20n, depth = 1_500n * 10n ** 9n, real = depth - 200n * 10n ** 9n;
  const polls: BarSnapshot[] = [], changed: BarSnapshot[] = [];
  const perMinute = new Map<number, number>();
  for (let i = 0; i < 3_600; i++) {
    if (failEvery > 0 && nextBelow(rng, failEvery) === 0) continue;
    const at = T0 + i * 1_000 + nextBelow(rng, 300);
    const change = nextBelow(rng, 4) === 0;
    if (change) {
      price += (price * (BigInt(nextBelow(rng, 2_001)) - 1_000n)) / 100_000n;
      const flow = BigInt(nextBelow(rng, 2_000_001)) - 1_000_000n;
      real += flow; depth += flow;
    }
    const s = snap(at, price, depth, real);
    polls.push(s);
    if (change || changed.length === 0) changed.push(s);
    const m = Math.floor(at / 60_000) * 60_000;
    perMinute.set(m, (perMinute.get(m) ?? 0) + 1);
  }
  const cs: Ev[] = [...perMinute].map(([m, n]) => ({ at: m + COUNTS_DELAY, c: counts(m, n) }));
  const order = (e: Ev[]): Ev[] => e.sort((a, b) => a.at - b.at);
  return { live: order([...polls.map((s) => ({ at: s.observedAtMs, s })), ...cs]), recorded: order([...changed.map((s) => ({ at: s.observedAtMs, s })), ...cs]) };
}
/** Runs a stream on a 1 s clock plus every event time; returns every closeDue call that emitted, with its time. */
function run(events: readonly Ev[], endMs: number): Array<[number, Bar[]]> {
  const e = createBarEngine();
  const out: Array<[number, Bar[]]> = [];
  const tick = (t: number): void => { const b = e.closeDue(t as UnixMs); if (b.length > 0) out.push([t, b]); };
  let k = 0;
  for (let t = T0; t <= endMs; t += 1_000) {
    for (; k < events.length && (events[k] as Ev).at <= t; k++) {
      const ev = events[k] as Ev;
      tick(ev.at);
      if ('s' in ev) e.onSnapshot(ev.s, 1_000); else e.onPollCounts(ev.c);
    }
    tick(t);
  }
  return out;
}

describe('A-M08-01 acceptance (SYNTHETIC hour)', () => {
  it('Z09-19 parity: live (every poll) and replay (changed snapshots only) of one stream emit identical bar.closed events at identical times', () => {
    for (const seed of [1, 2, 3]) {
      const h = hour(seed, seed === 3 ? 20 : 0);
      const live = run(h.live, T0 + 3_800_000), replay = run(h.recorded, T0 + 3_800_000);
      // The event stream: every bar.closed in order, with its event time.
      const events = (r: Array<[number, Bar[]]>): Bar[] => r.flatMap(([, b]) => b);
      assert.deepEqual(events(replay), events(live), `seed ${seed}`);
      assert.ok(events(live).length >= 235);
      // No run emits an event before its time.
      for (const [t, bars] of [...live, ...replay]) for (const b of bars) assert.ok(t >= b.closedAtMs);
    }
  });

  it('no leak: a bar never closes before its minute poll_counts is received, or before the wait ends', () => {
    const h = hour(4);
    for (const [t, bars] of run(h.recorded, T0 + 3_800_000)) {
      for (const b of bars) {
        const minute = Math.floor(b.startMs / 60_000) * 60_000;
        assert.ok(t >= minute + COUNTS_DELAY && b.closedAtMs === Math.max(minute + COUNTS_DELAY, b.startMs + 16_500), `bar ${b.startMs - T0} closed at ${t - T0} before its counts`);
      }
    }
  });

  it('a bar with 11 of 15 snapshots: missing 4, incomplete (26.7% > 20%); 12 of 15 is complete', () => {
    for (const [n, complete] of [[11, false], [12, true]] as const) {
      const e = createBarEngine();
      for (let i = 0; i < n; i++) e.onSnapshot(snap(T0 + i * 1_000, 10n ** 20n + BigInt(i)), 1_000);
      e.onPollCounts(counts(T0, n));
      assert.equal(e.closeDue((T0 + 16_500) as UnixMs).length, 0);                  // counts not received yet at 16.5 s
      const [b] = e.closeDue(AFTER(T0));
      assert.ok(b !== undefined);
      assert.equal(b.snapshots, n);
      assert.equal(b.missing, 15 - n);
      assert.equal(e.isComplete(b), complete);
    }
  });

  it('RT-7 (red team): live and replay close the same bar at the same sim time', () => {
    // The red team's repro closed live at T0 + 16.5 s and replay later; both now close once the minute's counts are in.
    const a = createBarEngine(), b = createBarEngine();
    const s = snap(T0 + 1_000, 1_000_000n);
    for (const e of [a, b]) { e.onSnapshot(s, 1_000); e.onPollCounts(counts(T0, 15)); }
    assert.deepEqual([a.closeDue((T0 + 16_500) as UnixMs), b.closeDue((T0 + 16_500) as UnixMs)], [[], []]);
    const [x, y] = [a.closeDue(AFTER(T0)), b.closeDue(AFTER(T0))];
    assert.equal(x.length, 3);                                                       // bars 0, 15 and 30 s; 45 s closes at 61.5 s
    assert.deepEqual(x, y);
    assert.equal(x[0]?.closedAtMs, AFTER(T0));
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
    e.onPollCounts(counts(T0, 3));
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
    e.onPollCounts({ ...counts(T0, 2), receivedAtMs: (T0 + 15_100) as UnixMs });
    assert.equal(e.closeDue((T0 + 16_499) as UnixMs).length, 0);
    const [b] = e.closeDue((T0 + 16_500) as UnixMs);
    assert.deepEqual([b?.snapshots, b?.closedAtMs], [1, T0 + 16_500]);              // 2 polls, 1 change: spread [1, 1, 0, 0]
    e.onSnapshot(snap(T0 + 14_990, 102n), 1_000);
    e.onSnapshot(snap(T0 + 14_980, 102n), 1_000);
    assert.equal(e.stats().droppedLate, 2);
  });

  it('no bar for a gap; no bar without decimals (counted); malformed snapshots counted; a stopped pool has no bars', () => {
    const e = createBarEngine();
    e.onSnapshot(snap(T0, 100n), 1_000);
    e.onSnapshot(snap(T0 + 45_000, 101n), 1_000);
    e.onPollCounts(counts(T0, 2));
    assert.deepEqual(e.closeDue((T0 + 70_000) as UnixMs).map((b) => b.startMs - T0), [0, 45_000]);
    e.onSnapshot({ ...snap(T0 + 75_000, 1n), spotSolPerToken: null }, 1_000);
    e.onSnapshot({ ...snap(T0 + 75_000, 1n), spotSolPerToken: '1e5' }, 1_000);
    e.onSnapshot(snap(T0 + 76_000, 0n), 1_000);
    assert.deepEqual([e.stats().skippedDecimals, e.stats().skippedMalformed], [1, 2]);
    e.onSnapshot(snap(T0 + 90_000, 102n), 1_000);
    e.stop('pool-a');
    e.onSnapshot(snap(T0 + 91_000, 103n), 1_000);
    e.onPollCounts(counts(T0 + 60_000, 30));
    e.onPollCounts({ ...counts(T0 + 120_000, 30), receivedAtMs: Number.NaN as UnixMs });   // no receipt time: ignored
    assert.equal(e.closeDue((T0 + 2_000_000) as UnixMs).length, 0);
    assert.equal(e.size(), 1);                                                         // a stopped pool is never forgotten
  });

  it('2 Hz pools expect 30 snapshots a bar; 60 s bars expect 60 at 1 Hz', () => {
    const e = createBarEngine();
    e.onSnapshot(snap(T0, 100n), 500);
    e.onPollCounts(counts(T0, 120));
    assert.equal(e.closeDue((T0 + 200_000) as UnixMs)[0]?.missing, 0);
    const m = createBarEngine({ ...BAR_DEFAULTS, durationMs: 60_000 });
    for (let i = 0; i < 50; i++) m.onSnapshot(snap(T0 + i * 1_000, 100n + BigInt(i)), 1_000);
    m.onPollCounts(counts(T0, 50));
    const [b] = m.closeDue((T0 + 70_000) as UnixMs);
    assert.equal(b?.durationMs, 60_000); assert.equal(b?.snapshots, 50); assert.equal(b?.missing, 10); assert.equal(b?.close, spot(149n));
  });

  it('without poll_counts a bar waits until the wait ends, then counts its changes; a pause counts changes only; quiet bars come from the carried state', () => {
    const e = createBarEngine();
    e.onSnapshot(snap(T0 + 1_000, 100n), 1_000);
    assert.equal(e.closeDue((T0 + 60_000 + 119_999) as UnixMs).length, 0);
    assert.equal(e.closeDue((T0 + 180_000) as UnixMs)[0]?.snapshots, 1);
    const p = createBarEngine();
    p.onSnapshot(snap(T0 + 1_000, 100n), 1_000);
    p.onPollCounts({ ...counts(T0, 300), skippedMinutes: 5 });
    assert.deepEqual(p.closeDue((T0 + 300_000) as UnixMs).map((b) => b.snapshots), [1]);
    const q = createBarEngine();
    q.onSnapshot(snap(T0 + 1_000, 100n), 1_000);
    q.onPollCounts(counts(T0, 60));
    q.onPollCounts(counts(T0 + 60_000, 0));
    q.onPollCounts(counts(7, 1));                                                   // not a minute start: ignored
    q.onPollCounts({ ...counts(T0, 60), skippedMinutes: 0 });                       // bad span: ignored
    assert.deepEqual(q.closeDue((T0 + 200_000) as UnixMs).map((b) => [b.startMs - T0, b.snapshots, b.open]), [[0, 15, spot(100n)], [15_000, 15, spot(100n)], [30_000, 15, spot(100n)], [45_000, 15, spot(100n)]]);
    q.onPollCounts(counts(T0, 60));                                                 // a closed minute: ignored
    assert.equal(q.closeDue((T0 + 400_000) as UnixMs).length, 0);
    // A count delivered for a time later than now is not used yet (leak rule): the bar waits.
    const r = createBarEngine();
    r.onSnapshot(snap(T0 + 1_000, 100n), 1_000);
    r.onPollCounts({ ...counts(T0, 60), receivedAtMs: (T0 + 500_000) as UnixMs });
    assert.equal(r.closeDue((T0 + 179_999) as UnixMs).length, 0);
    assert.deepEqual(r.closeDue((T0 + 180_000) as UnixMs).map((b) => [b.snapshots, b.closedAtMs]), [[1, T0 + 180_000]]);
  });

  it('a quiet pool skips its empty bars in one jump and closes a bar after the pause', () => {
    const e = createBarEngine();
    e.onSnapshot(snap(T0 + 1_000, 100n), 1_000);
    e.onPollCounts(counts(T0, 4));
    assert.deepEqual(e.closeDue((T0 + 3 * 3_600_000) as UnixMs).map((b) => b.snapshots), [1, 1, 1, 1]);
    e.onSnapshot(snap(T0 + 4 * 3_600_000, 101n), 1_000);
    e.onPollCounts(counts(T0 + 4 * 3_600_000, 60));
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
      e.onPollCounts(counts(t, 60, 'steady'));
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
    assert.deepEqual(bars.map((b) => b.poolId), ['pool-a', 'pool-b', 'pool-c', 'pool-d', 'pool-a', 'pool-b', 'pool-d']);
    assert.deepEqual([bars[2]?.missing, bars[2]?.depthChangeBps], [13, 0]);
  });

  it('spreadPolls fills the bars below an even share first', () => {
    assert.deepEqual(spreadPolls(60, [10, 0, 0, 0]), [15, 15, 15, 15]);
    assert.deepEqual(spreadPolls(60, [20, 0, 0, 0]), [20, 14, 13, 13]);
    assert.deepEqual(spreadPolls(10, [0, 0, 0, 0]), [3, 3, 2, 2]);
    assert.deepEqual(spreadPolls(2, [3, 0, 0, 0]), [3, 0, 0, 0]);
  });

  it('config checks and helpers', () => {
    assert.equal(checkBarConfig(BAR_DEFAULTS), null);
    for (const c of [{ durationMs: 30_000 }, { closeGraceMs: 5_001 }, { closeGraceMs: -1 }, { incompleteMissingBps: 5_001 }, { pollWaitMs: -1 }, { idleForgetMs: 1 }]) {
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
