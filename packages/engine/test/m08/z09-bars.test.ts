// A-M08-01 15 s bars and the 60 s bars of A-M08-03 (card Z09). The recorded-hour fixture of the spec
// (`fx/md/one_hour_pool_snapshot_segment.ndjson.gz`) does not exist yet and no live read is allowed from this
// container, so the hour is SYNTHETIC: a seeded 1 Hz poll stream with changes at random polls (Z09 plan, item 4).
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';
import fc from 'fast-check';
import type { UnixMs } from '@bot/types';
import { BAR_DEFAULTS, barSnapshotOf, checkBarConfig, createBarEngine, parseSpot, renderSpot, spreadPolls, type Bar, type BarSnapshot } from '../../src/m08/bars.ts';
import { createRng, nextBelow } from '../../src/m10/rng.ts';

const T0 = Date.UTC(2026, 9, 16, 0, 0, 0);
const spot = (n: bigint): string => renderSpot(n);
const snap = (atMs: number, price: bigint, depth = 1_000n * 10n ** 9n, real = depth, poolId = 'pool-a'): BarSnapshot =>
  ({ poolId, observedAtMs: atMs as UnixMs, spotSolPerToken: spot(price), effectiveQuoteLamports: depth, realQuoteLamports: real });

/** One synthetic hour: polls at 1 Hz (up to 300 ms jitter; 1 in `failEvery` failed), a change at about 1 poll in 4. */
function hour(seed: number, failEvery = 0): { polls: BarSnapshot[]; changed: BarSnapshot[]; counts: Array<{ poolId: string; minuteStartMs: UnixMs; successfulPolls: number }> } {
  const rng = createRng(seed);
  let price = 10n ** 20n, depth = 1_500n * 10n ** 9n, real = depth - 200n * 10n ** 9n;
  const polls: BarSnapshot[] = [], changed: BarSnapshot[] = [];
  const perMinute = new Map<number, number>();
  for (let i = 0; i < 3_600; i++) {
    if (failEvery > 0 && nextBelow(rng, failEvery) === 0) continue;                // a failed poll
    const at = T0 + i * 1_000 + nextBelow(rng, 300);
    const change = nextBelow(rng, 4) === 0;
    if (change) {
      const d = BigInt(nextBelow(rng, 2_001)) - 1_000n;
      price += (price * d) / 100_000n;
      const flow = BigInt(nextBelow(rng, 2_000_001)) - 1_000_000n;
      real += flow; depth += flow;
    }
    const s = snap(at, price, depth, real);
    polls.push(s);
    if (change || changed.length === 0) changed.push(s);
    const m = Math.floor(at / 60_000) * 60_000;
    perMinute.set(m, (perMinute.get(m) ?? 0) + 1);
  }
  return { polls, changed, counts: [...perMinute].map(([m, n]) => ({ poolId: 'pool-a', minuteStartMs: m as UnixMs, successfulPolls: n })) };
}

function runLive(polls: readonly BarSnapshot[]): Bar[] {
  const e = createBarEngine();
  const out: Bar[] = [];
  for (const s of polls) { out.push(...e.closeDue(s.observedAtMs)); e.onSnapshot(s, 1_000); }
  out.push(...e.closeDue((T0 + 3_700_000) as UnixMs));
  return out;
}
function runReplay(changed: readonly BarSnapshot[], counts: ReturnType<typeof hour>['counts']): Bar[] {
  const e = createBarEngine({ ...BAR_DEFAULTS, mode: 'replay' });
  const out: Bar[] = [];
  // The recorder writes a minute's poll_counts at the next minute tick: replay them in time order with the snapshots.
  const events = [...changed.map((s) => ({ at: s.observedAtMs, s })), ...counts.map((c) => ({ at: c.minuteStartMs + 60_000 + 50, c }))].sort((a, b) => a.at - b.at);
  for (const ev of events) {
    out.push(...e.closeDue(ev.at as UnixMs));
    if ('s' in ev) e.onSnapshot(ev.s, 1_000); else e.onPollCounts(ev.c);
  }
  out.push(...e.closeDue((T0 + 3_900_000) as UnixMs));
  return out;
}

describe('A-M08-01 acceptance (SYNTHETIC hour)', () => {
  it('an hour built live equals the same hour rebuilt in replay from changed snapshots plus poll_counts (OHLC, depth, flow; snapshots ±1)', () => {
    for (const seed of [1, 2, 3]) {
      const h = hour(seed);
      const live = runLive(h.polls);
      const replay = runReplay(h.changed, h.counts);
      assert.equal(live.length, replay.length);
      assert.ok(live.length >= 235);
      live.forEach((a, i) => {
        const b = replay[i] as Bar;
        assert.deepEqual({ ...b, snapshots: 0, missing: 0 }, { ...a, snapshots: 0, missing: 0 }, `seed ${seed} bar ${i}`);
        assert.ok(Math.abs(a.snapshots - b.snapshots) <= 1, `seed ${seed} bar ${i}: ${a.snapshots} vs ${b.snapshots}`);
      });
    }
  });

  it('with failed polls, OHLC, depth and flow stay identical and each minute total matches (where in the minute a poll failed is not recorded: Z09-B2)', () => {
    const h = hour(4, 20);
    const live = runLive(h.polls);
    const replay = runReplay(h.changed, h.counts);
    assert.equal(live.length, replay.length);
    const perMinute = (bars: Bar[]): Map<number, number> => {
      const m = new Map<number, number>();
      for (const b of bars) m.set(Math.floor(b.startMs / 60_000), (m.get(Math.floor(b.startMs / 60_000)) ?? 0) + b.snapshots);
      return m;
    };
    live.forEach((a, i) => assert.deepEqual({ ...replay[i], snapshots: 0, missing: 0 }, { ...a, snapshots: 0, missing: 0 }));
    assert.deepEqual(perMinute(replay), perMinute(live));
  });

  it('a bar with 11 of 15 snapshots: missing 4, incomplete (26.7% > 20%); 12 of 15 is complete', () => {
    for (const [n, complete] of [[11, false], [12, true]] as const) {
      const e = createBarEngine();
      for (let i = 0; i < n; i++) e.onSnapshot(snap(T0 + i * 1_000, 10n ** 20n), 1_000);
      const [b] = e.closeDue((T0 + 16_500) as UnixMs);
      assert.ok(b !== undefined);
      assert.equal(b.snapshots, n);
      assert.equal(b.missing, 15 - n);
      assert.equal(e.isComplete(b), complete);
    }
  });
});

describe('A-M08-01 logic and edges', () => {
  it('property: high ≥ max(open, close) and low ≤ min(open, close)', () => {
    fc.assert(fc.property(fc.array(fc.tuple(fc.integer({ min: 0, max: 59_999 }), fc.bigInt({ min: 1n, max: 10n ** 30n })), { minLength: 1, maxLength: 60 }), (xs) => {
      const e = createBarEngine();
      for (const [t, p] of [...xs].sort((a, b) => a[0] - b[0])) e.onSnapshot(snap(T0 + t, p), 1_000);
      for (const b of e.closeDue((T0 + 120_000) as UnixMs)) {
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
    const [a, b] = e.closeDue((T0 + 40_000) as UnixMs) as [Bar, Bar];
    assert.equal(a.open, spot(100n)); assert.equal(a.high, spot(120n)); assert.equal(a.close, spot(120n));
    assert.equal(a.netQuoteFlowLamports, 50n);                                      // 950 − 900 (first ever: from the first snapshot)
    assert.equal(a.depthChangeBps, 1_000);
    assert.equal(b.open, spot(120n)); assert.equal(b.high, spot(120n)); assert.equal(b.low, spot(90n));
    assert.equal(b.netQuoteFlowLamports, -10n);                                     // 940 − 950: from the previous bar's last snapshot
    assert.equal(b.depthChangeBps, -9);                                             // (1,099/1,100 − 1) × 10,000 = −9.09 → −9
    assert.equal(b.snapshots, 1);
  });

  it('closes only after start + 15 s + grace; a late snapshot of a closed bar is dropped and counted', () => {
    const e = createBarEngine();
    e.onSnapshot(snap(T0 + 14_900, 100n), 1_000);
    assert.equal(e.closeDue((T0 + 16_499) as UnixMs).length, 0);
    e.onSnapshot(snap(T0 + 14_950, 101n), 1_000);                                   // within grace: kept
    const [b] = e.closeDue((T0 + 16_500) as UnixMs);
    assert.equal(b?.close, spot(101n));
    e.onSnapshot(snap(T0 + 14_990, 102n), 1_000);                                   // its bar is closed
    e.onSnapshot(snap(T0 + 14_980, 102n), 1_000);
    assert.equal(e.stats().droppedLate, 2);
  });

  it('no bar for a gap; no bar without decimals (counted); malformed snapshots counted; a stopped pool has no bars', () => {
    const e = createBarEngine();
    e.onSnapshot(snap(T0, 100n), 1_000);
    e.onSnapshot(snap(T0 + 45_000, 100n), 1_000);
    assert.deepEqual(e.closeDue((T0 + 70_000) as UnixMs).map((b) => b.startMs - T0), [0, 45_000]);
    e.onSnapshot({ ...snap(T0 + 75_000, 1n), spotSolPerToken: null }, 1_000);
    e.onSnapshot({ ...snap(T0 + 75_000, 1n), spotSolPerToken: '1e5' }, 1_000);
    e.onSnapshot(snap(T0 + 76_000, 0n), 1_000);
    assert.deepEqual(e.stats(), { droppedLate: 0, skippedDecimals: 1, skippedMalformed: 2 });
    e.onSnapshot(snap(T0 + 90_000, 100n), 1_000);
    e.stop('pool-a');
    e.onSnapshot(snap(T0 + 91_000, 100n), 1_000);
    assert.equal(e.closeDue((T0 + 200_000) as UnixMs).length, 0);
  });

  it('2 Hz pools expect 30 snapshots a bar; 60 s bars expect 60 at 1 Hz', () => {
    const e = createBarEngine();
    for (let i = 0; i < 30; i++) e.onSnapshot(snap(T0 + i * 500, 100n), 500);
    assert.equal(e.closeDue((T0 + 20_000) as UnixMs)[0]?.missing, 0);
    const m = createBarEngine({ ...BAR_DEFAULTS, durationMs: 60_000 });
    for (let i = 0; i < 50; i++) m.onSnapshot(snap(T0 + i * 1_000, 100n + BigInt(i)), 1_000);
    const [b] = m.closeDue((T0 + 70_000) as UnixMs);
    assert.equal(b?.durationMs, 60_000); assert.equal(b?.snapshots, 50); assert.equal(b?.missing, 10); assert.equal(b?.close, spot(149n));
  });

  it('replay: a bar waits for its minute poll_counts, then counts changed snapshots only; a pause counts changed only', () => {
    const e = createBarEngine({ ...BAR_DEFAULTS, mode: 'replay' });
    e.onSnapshot(snap(T0 + 1_000, 100n), 1_000);
    assert.equal(e.closeDue((T0 + 60_000 + 119_999) as UnixMs).length, 0);
    assert.equal(e.closeDue((T0 + 180_000) as UnixMs)[0]?.snapshots, 1);
    const p = createBarEngine({ ...BAR_DEFAULTS, mode: 'replay' });
    p.onSnapshot(snap(T0 + 1_000, 100n), 1_000);
    p.onPollCounts({ poolId: 'pool-a', minuteStartMs: T0 as UnixMs, successfulPolls: 300, skippedMinutes: 5 });
    const bars = p.closeDue((T0 + 300_000) as UnixMs);
    assert.deepEqual(bars.map((b) => b.snapshots), [1]);
    // Unchanged-only bars are built from the carried state.
    const q = createBarEngine({ ...BAR_DEFAULTS, mode: 'replay' });
    q.onSnapshot(snap(T0 + 1_000, 100n), 1_000);
    q.onPollCounts({ poolId: 'pool-a', minuteStartMs: T0 as UnixMs, successfulPolls: 60 });
    q.onPollCounts({ poolId: 'pool-a', minuteStartMs: (T0 + 60_000) as UnixMs, successfulPolls: 0 });
    q.onPollCounts({ poolId: 'pool-a', minuteStartMs: 7 as UnixMs, successfulPolls: 1 });           // not a minute start: ignored
    const qb = q.closeDue((T0 + 200_000) as UnixMs);
    assert.deepEqual(qb.map((b) => [b.startMs - T0, b.snapshots, b.open, b.close]), [[0, 15, spot(100n), spot(100n)], [15_000, 15, spot(100n), spot(100n)], [30_000, 15, spot(100n), spot(100n)], [45_000, 15, spot(100n), spot(100n)]]);
    q.onPollCounts({ poolId: 'pool-a', minuteStartMs: T0 as UnixMs, successfulPolls: 60 });        // a closed minute: ignored
    assert.equal(q.closeDue((T0 + 400_000) as UnixMs).length, 0);
    // poll_counts in live mode are ignored.
    const l = createBarEngine();
    l.onPollCounts({ poolId: 'pool-a', minuteStartMs: T0 as UnixMs, successfulPolls: 60 });
    assert.equal(l.closeDue((T0 + 200_000) as UnixMs).length, 0);
  });

  it('spreadPolls fills the bars below an even share first', () => {
    assert.deepEqual(spreadPolls(60, [10, 0, 0, 0]), [15, 15, 15, 15]);
    assert.deepEqual(spreadPolls(60, [20, 0, 0, 0]), [20, 14, 13, 13]);
    assert.deepEqual(spreadPolls(10, [0, 0, 0, 0]), [3, 3, 2, 2]);
    assert.deepEqual(spreadPolls(2, [3, 0, 0, 0]), [3, 0, 0, 0]);
  });

  it('config checks and helpers', () => {
    assert.equal(checkBarConfig(BAR_DEFAULTS), null);
    for (const c of [{ durationMs: 30_000 }, { closeGraceMs: 5_001 }, { closeGraceMs: -1 }, { incompleteMissingBps: 5_001 }, { replayPollWaitMs: -1 }]) {
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

describe('A-M08-01 branch cases', () => {
  it('a bad expected interval keeps 1 Hz; depth 0 at the open gives depth change 0; two pools close in pool order', () => {
    const e = createBarEngine();
    e.onSnapshot(snap(T0, 100n, 0n, 0n, 'pool-b'), Number.NaN);
    e.onSnapshot(snap(T0 + 1, 100n, 5n, 5n, 'pool-b'), -1);
    e.onSnapshot(snap(T0, 100n, 9n, 9n, 'pool-a'), 1_000);
    const bars = e.closeDue((T0 + 20_000) as UnixMs);
    assert.deepEqual(bars.map((b) => [b.poolId, b.missing, b.depthChangeBps]), [['pool-a', 14, 0], ['pool-b', 13, 0]]);
  });

  it('replay: a bad skippedMinutes is ignored; a quiet pool skips its empty bars; a bar after a pause closes', () => {
    const e = createBarEngine({ ...BAR_DEFAULTS, mode: 'replay' });
    e.onSnapshot(snap(T0 + 1_000, 100n), 1_000);
    e.onPollCounts({ poolId: 'pool-a', minuteStartMs: T0 as UnixMs, successfulPolls: 60, skippedMinutes: 0 });
    e.onPollCounts({ poolId: 'pool-a', minuteStartMs: T0 as UnixMs, successfulPolls: 60, skippedMinutes: 1.5 });
    e.onPollCounts({ poolId: 'pool-a', minuteStartMs: T0 as UnixMs, successfulPolls: 4 });
    // Nothing more for hours, then one change: the empty bars between are skipped in one jump.
    assert.deepEqual(e.closeDue((T0 + 3 * 3_600_000) as UnixMs).map((b) => b.snapshots), [1, 1, 1, 1]);
    e.onSnapshot(snap(T0 + 4 * 3_600_000, 101n), 1_000);
    e.onPollCounts({ poolId: 'pool-a', minuteStartMs: (T0 + 4 * 3_600_000) as UnixMs, successfulPolls: 60 });
    const late = e.closeDue((T0 + 5 * 3_600_000) as UnixMs);
    assert.deepEqual(late.map((b) => [b.startMs - T0, b.snapshots, b.open, b.close]), [
      [4 * 3_600_000, 15, spot(100n), spot(101n)], [4 * 3_600_000 + 15_000, 15, spot(101n), spot(101n)],
      [4 * 3_600_000 + 30_000, 15, spot(101n), spot(101n)], [4 * 3_600_000 + 45_000, 15, spot(101n), spot(101n)],
    ]);
  });
});

describe('A-M08-01 order', () => {
  it('bars of one start come out in pool order whatever the arrival order', () => {
    const e = createBarEngine();
    for (const p of ['pool-c', 'pool-a', 'pool-d', 'pool-b']) e.onSnapshot(snap(T0, 100n, 1n, 1n, p), 1_000);
    assert.deepEqual(e.closeDue((T0 + 20_000) as UnixMs).map((b) => b.poolId), ['pool-a', 'pool-b', 'pool-c', 'pool-d']);
  });
});
