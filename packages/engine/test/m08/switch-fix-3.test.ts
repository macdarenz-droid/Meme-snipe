// Card SWITCH-FIX-3 SW-44 (red team 1 on #336; a spec change to A-M08-01's open rule): a bar whose previous bar had no
// successful poll for its pool (not watched, an outage's 0-poll records, the recorder down, or its counts refused as
// late) starts as a cold engine would: it opens at its own first change, its flow and range are its own changes', and
// with no change it is not emitted (no flat bar at the pre-gap state). Before, it opened at the state carried across
// the gap, so its flow took in the whole gap. Live (stop and resume) and replay (neither) give the same bars.
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';
import type { UnixMs } from '@bot/types';
import { BAR_DEFAULTS, createBarEngine, renderSpot, type Bar, type BarEngine, type BarSnapshot, type PollCountsIn } from '../../src/m08/bars.ts';
import { replayBars, type ReplayEvent } from '../../src/m08/replay.ts';

const T0 = Date.UTC(2026, 9, 16, 0, 0, 0);
const W = 15_000;                                                                        // one poll_counts window
const SOL = 10n ** 9n;
type Ev = { at: number; s: BarSnapshot } | { at: number; c: PollCountsIn };
const snap = (at: number, price: bigint, real: bigint): Ev => ({ at, s: { poolId: 'A', observedAtMs: at as UnixMs, spotSolPerToken: renderSpot(price), effectiveQuoteLamports: 1_000n * SOL, realQuoteLamports: real } });
const count = (w: number, polls: number): Ev => ({ at: w + W + 500, c: { poolId: 'A', barStartMs: w as UnixMs, durationMs: W, successfulPolls: polls, receivedAtMs: (w + W + 500) as UnixMs } });

/**
 * One pool: polled and changing for `before` windows, then a gap of `gap` windows (`kind`: unwatched, an outage with
 * 0-poll records, or nothing at all), then polled again with its first state `after` (the price it moved to meanwhile).
 */
function scenario(o: { before: number; gap: number; afterWindows: number; kind: 'unwatched' | 'outage' | 'down'; after: bigint }): { events: Ev[]; gapFrom: number; gapTo: number; end: number } {
  const events: Ev[] = [];
  let price = 100n, real = 500n * SOL;
  for (let w = 0; w < o.before; w++) {
    const t = T0 + w * W;
    if (w % 3 === 0) { price += 1n; real += SOL; events.push(snap(t + 2_000, price, real)); }
    events.push(count(t, 15));
  }
  const gapFrom = T0 + o.before * W, gapTo = gapFrom + o.gap * W;
  if (o.kind === 'outage') for (let w = 0; w < o.gap; w++) events.push(count(gapFrom + w * W, 0));
  price = o.after; real += 40n * SOL;                                                    // what happened during the gap
  for (let w = 0; w < o.afterWindows; w++) {
    const t = gapTo + w * W;
    if (w === 0) events.push(snap(t + 1_000, price, real));                              // the first poll after the gap
    if (w === 2) { price += 2n; real += 3n * SOL; events.push(snap(t + 4_000, price, real)); }
    events.push(count(t, 15));
  }
  return { events, gapFrom, gapTo, end: gapTo + o.afterWindows * W + 120_000 };
}

/** Live: events in time order, closeDue every second; `hooks` at their times (the recorder's stop and resume). */
function live(e: BarEngine, events: readonly Ev[], from: number, end: number, hooks: ReadonlyArray<[number, (e: BarEngine) => void]> = []): Bar[] {
  const evs = [...events].sort((a, b) => a.at - b.at);
  const out: Bar[] = [];
  let i = 0, h = 0;
  const hs = [...hooks].sort((a, b) => a[0] - b[0]);
  for (let t = from; t <= end; t += 1_000) {
    for (; h < hs.length && (hs[h] as [number, unknown])[0] <= t; h++) (hs[h] as [number, (e: BarEngine) => void])[1](e);
    for (; i < evs.length && (evs[i] as Ev).at <= t; i++) { const x = evs[i] as Ev; if ('s' in x) e.onSnapshot(x.s, 1_000); else e.onPollCounts(x.c); }
    out.push(...e.closeDue(t as UnixMs));
  }
  return out;
}
const replayed = (e: BarEngine, events: readonly Ev[], from: number, end: number): Bar[] => {
  let seq = 0n;
  const evs: ReplayEvent[] = events.map((x) => ('s' in x ? { kind: 'snapshot' as const, atMs: x.at, s: x.s, expectedIntervalMs: 1_000 } : { kind: 'poll_counts' as const, atMs: x.at, seq: seq++, partial: false, c: x.c }));
  const r = replayBars(e, evs, { fromMs: from, endMs: end, stepMs: 1_000 });
  assert.ok(r.ok);
  return r.value.flatMap(([, b]) => b);
};
const engine = (durationMs: 15_000 | 60_000): BarEngine => createBarEngine({ ...BAR_DEFAULTS, durationMs });

for (const D of [15_000, 60_000] as const) {
  describe(`SW-44 rule G, ${D / 1_000} s bars`, () => {
    // Gaps of 5 min (the pre-gap state still held: rule G itself) and 10 min (past idleForgetMs for a pool with no records).
    for (const [kind, gap] of (['unwatched', 'outage', 'down'] as const).flatMap((k) => [[k, 20], [k, 40]] as const)) {
      it(`${kind}, ${gap / 4} min: the first bar after the gap opens at its own first change, its flow is its own; live and replay agree (fails before: opened at the pre-gap state)`, () => {
        const sc = scenario({ before: 16, gap, afterWindows: 16, kind, after: 130n });
        const hooks: Array<[number, (e: BarEngine) => void]> = kind === 'unwatched' ? [[sc.gapFrom + 5_000, (e) => e.stop('A', (sc.gapFrom + 5_000) as UnixMs)], [sc.gapTo, (e) => e.resume('A')]] : [];
        const l = live(engine(D), sc.events, T0, sc.end, hooks);
        const first = l.find((b) => b.startMs >= sc.gapTo);
        assert.ok(first !== undefined);
        assert.equal(first.startMs, sc.gapTo);
        assert.equal(first.open, renderSpot(130n), 'opens at the first change after the gap');
        assert.equal(first.low, renderSpot(130n), 'its range is its own changes\'');
        const own = D === 60_000 ? 3n * SOL : 0n;                                       // a 60 s bar holds the second change too
        assert.equal(first.netQuoteFlowLamports, own, 'the gap\'s flow is not in it');
        assert.deepEqual(replayed(engine(D), sc.events, T0, sc.end), l, 'replay (no stop, no resume) gives the live bars');
      });

      it(`${kind}, ${gap / 4} min: from the bar after the gap on, the bars are a fresh engine's fed the same events from that bar (the cold-start oracle)`, () => {
        const sc = scenario({ before: 16, gap, afterWindows: 16, kind, after: 130n });
        const hooks: Array<[number, (e: BarEngine) => void]> = kind === 'unwatched' ? [[sc.gapFrom + 5_000, (e) => e.stop('A', (sc.gapFrom + 5_000) as UnixMs)], [sc.gapTo, (e) => e.resume('A')]] : [];
        const warm = live(engine(D), sc.events, T0, sc.end, hooks).filter((b) => b.startMs >= sc.gapTo);
        const cold = live(engine(D), sc.events.filter((x) => ('s' in x ? x.s.observedAtMs : x.c.barStartMs) >= sc.gapTo), sc.gapTo, sc.end);
        assert.deepEqual(warm, cold);
        assert.ok(warm.length >= 2);
      });
    }

    it('re-watched with no change: no flat bar at the pre-gap state for the first bar after the gap, then bars as before (fails before: a flat bar at the old price)', () => {
      // A 5 min gap: under idleForgetMs (10 min), so the engine still holds the pre-gap state (after a longer gap the pool
      // is forgotten, live and in replay alike, and its first snapshot opens a bar as at any cold start).
      const sc = scenario({ before: 16, gap: 20, afterWindows: 16, kind: 'unwatched', after: 0n });
      // The first poll after the gap repeats the last state before it (no change during the gap).
      const lastBefore = [...sc.events].reverse().find((x) => 's' in x && x.at < sc.gapFrom) as { at: number; s: BarSnapshot };
      const events = sc.events.map((x) => ('s' in x && x.at === sc.gapTo + 1_000 ? { at: x.at, s: { ...lastBefore.s, observedAtMs: x.at as UnixMs } } : x)).filter((x) => !('s' in x && x.at > sc.gapTo + 2 * W));
      const hooks: Array<[number, (e: BarEngine) => void]> = [[sc.gapFrom + 5_000, (e) => e.stop('A', (sc.gapFrom + 5_000) as UnixMs)], [sc.gapTo, (e) => e.resume('A')]];
      const l = live(engine(D), events, T0, sc.end, hooks);
      assert.equal(l.filter((b) => b.startMs === sc.gapTo).length, 0, 'no bar for the first bar after the gap');
      assert.ok(l.some((b) => b.startMs === sc.gapTo + D), 'the next bar carries the state as before');
      assert.deepEqual(replayed(engine(D), events, T0, sc.end), l);
    });

    it('a pool polled every bar (no gap) gives the same bars as before SW-44: each opens at the carried state', () => {
      const sc = scenario({ before: 64, gap: 0, afterWindows: 0, kind: 'down', after: 100n });
      const l = live(engine(D), sc.events.filter((x) => x.at < T0 + 64 * W), T0, T0 + 64 * W + 120_000);
      for (let k = 1; k < l.length; k++) assert.equal(l[k]?.open, l[k - 1]?.close, `bar ${k} opens at the carried close`);
      assert.ok(l.length >= (64 * W) / D - 1);
    });
  });
}

it('SW-44 (a): a count refused as late counts as missing (the next bar starts after a gap), the same live and in replay', () => {
  const e = createBarEngine();
  e.onSnapshot((snap(T0 + 1_000, 100n, 500n * SOL) as { s: BarSnapshot }).s, 1_000);
  e.onPollCounts((count(T0, 15) as { c: PollCountsIn }).c);
  e.closeDue((T0 + W + 1_500) as UnixMs);
  // The next bar's count arrives after that bar's close: refused (late), so that bar had no successful poll.
  e.onPollCounts({ poolId: 'A', barStartMs: (T0 + W) as UnixMs, durationMs: W, successfulPolls: 15, receivedAtMs: (T0 + 2 * W + 1_501) as UnixMs });
  e.closeDue((T0 + 2 * W + 1_501) as UnixMs);
  e.onSnapshot((snap(T0 + 2 * W + 3_000, 140n, 600n * SOL) as { s: BarSnapshot }).s, 1_000);
  e.onPollCounts((count(T0 + 2 * W, 15) as { c: PollCountsIn }).c);
  const bars = e.closeDue((T0 + 3 * W + 1_500) as UnixMs);
  assert.equal(bars.find((b) => b.startMs === T0 + 2 * W)?.open, renderSpot(140n));
  assert.equal(e.stats().lateCounts, 1);
});
