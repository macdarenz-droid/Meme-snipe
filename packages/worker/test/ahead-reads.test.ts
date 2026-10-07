// MEM-FIXES (S1 ruling on the review of #277, option b): a chain read answered at a slot past the tip (a simulation at
// processed whose context slot is the head) waits on the live feed until the tip passes it, then is released at its own
// slot and used: never dropped, never ahead of its moment. The facts producer's refusal stays as the backstop. The stale
// rule never releases such a slot past the tip, and the recording replays the same events.
import { describe, expect, it } from 'vitest';
import type { FeedEvent, MarketEvent } from '../../core/src/engine/index.ts';
import { RAW } from '../../core/src/facts/index.ts';
import { simKey } from '../../core/src/gates/index.ts';
import { startSession, TRIAL_POLICY } from '../../core/src/config/index.ts';
import { AHEAD_HOLD_SLOTS, DEFAULT_LIVE_FEED, LiveFeed, replayRecorded, type Frame, type Release } from '../src/providers/live-feed.ts';
import { engineFeed } from '../src/run/engine-feed.ts';
import { blockNetwork } from './helpers.ts';

blockNetwork();

const policy = startSession(TRIAL_POLICY).policy;
const MINT = 'Mint111111111111111111111111111111111111111';
const T0 = 1_791_100_000_000;
const sim = (slot: bigint) => ({ mint: MINT, slot, spend: 50_000_000n, ok: true, paid: 50_100_000n, proceeds: 48_000_000n, error: null });

const world = () => {
  const frames: Frame[] = [];
  const releases: Release[] = [];
  const feed = new LiveFeed({ ...DEFAULT_LIVE_FEED, horizonSlots: 2, staleReleaseMs: 2_000, onFrame: (f) => frames.push(f), onRelease: (_e, r) => void releases.push(r) });
  let now = T0;
  const slot = (s: bigint) => feed.ingest('helius', { type: 'slot', slot: s, parent: s - 1n, root: null }, { receivedAt: now });
  const drain = (into: FeedEvent[]) => {
    feed.advance(now);
    for (let e = feed.next(); e !== null; e = feed.next()) into.push(e);
  };
  return { feed, frames, releases, slot, drain, tick: (ms: number) => (now += ms) };
};

describe('MEM-FIXES: a read answered past the tip waits for it (LiveFeed notBefore)', () => {
  it('a sim read answered at tip + 2 is held until the tip passes it, released at its own slot, and made into the sim fact', () => {
    const w = world();
    for (let s = 100n; s <= 110n; s++) w.slot(s);
    const out: FeedEvent[] = [];
    w.drain(out);
    const f = w.feed.ingest('helius', { type: 'offchain', key: RAW.sim(MINT), value: sim(112n) }, { receivedAt: T0, notBefore: 112n });
    expect(f.place).toEqual({ at: 'offchain', slot: 112n, arrival: true });
    w.slot(111n);
    w.slot(113n);
    w.drain(out);
    expect(out.some((e) => e.kind === 'market' && e.key === RAW.sim(MINT))).toBe(false);
    w.slot(114n);
    w.drain(out);
    const read = out.find((e): e is MarketEvent => e.kind === 'market' && e.key === RAW.sim(MINT))!;
    expect(read.moment.slot).toBe(112n);
    // Through the facts producer, live and in the recording's replay: the sim fact is made at slot 112 (not refused).
    const factsOf = (events: readonly FeedEvent[]) => {
      let i = 0;
      const ef = engineFeed({ next: () => events[i++] ?? null }, policy);
      const got: MarketEvent[] = [];
      for (let e = ef.feed.next(); e !== null; e = ef.feed.next()) if (e.kind === 'market' && e.key === simKey(MINT)) got.push(e);
      return got;
    };
    const live = factsOf(out);
    expect(live.map((e) => e.moment.slot)).toEqual([112n]);
    const r = replayRecorded(w.frames, w.releases);
    const replayed: FeedEvent[] = [];
    for (let e = r.feed.next(); e !== null; e = r.feed.next()) replayed.push(e);
    expect(replayed.map((e) => e.id)).toEqual(out.map((e) => e.id));
    expect(factsOf(replayed)).toEqual(live);
  });

  it('while the slot notices stop, the stale rule releases the held facts but never a slot past the tip that holds only waiting reads', () => {
    const w = world();
    for (let s = 100n; s <= 110n; s++) w.slot(s);
    const out: FeedEvent[] = [];
    w.drain(out);
    w.feed.ingest('worker', { type: 'offchain', key: 'feed:status:x', value: { up: true } }, { receivedAt: T0 });
    w.feed.ingest('helius', { type: 'offchain', key: RAW.sim(MINT), value: sim(115n) }, { receivedAt: T0, notBefore: 115n });
    w.tick(5_000);
    w.drain(out);
    expect(out.some((e) => e.kind === 'market' && e.key === 'feed:status:x')).toBe(true);
    expect(out.some((e) => e.kind === 'market' && e.key === RAW.sim(MINT))).toBe(false);
    expect(w.feed.releasedThrough).toBeLessThan(115n);
    // The chain comes back: its slots are not late, and the read goes out once the tip has passed it.
    const late = w.releases.length;
    for (let s = 111n; s <= 117n; s++) w.slot(s);
    w.drain(out);
    expect(w.releases.slice(late).filter((r) => r.late)).toEqual([]);
    expect(out.find((e) => e.kind === 'market' && e.key === RAW.sim(MINT))?.moment.slot).toBe(115n);
  });

  it(`further than ${AHEAD_HOLD_SLOTS} slots ahead the read is placed as before, and the producer refuses it (fail closed)`, () => {
    const w = world();
    for (let s = 100n; s <= 110n; s++) w.slot(s);
    const open = w.feed.openSlot;
    const f = w.feed.ingest('helius', { type: 'offchain', key: RAW.sim(MINT), value: sim(open + AHEAD_HOLD_SLOTS + 1n) }, { receivedAt: T0, notBefore: open + AHEAD_HOLD_SLOTS + 1n });
    expect(f.place.slot).toBe(open);
    const g = w.feed.ingest('helius', { type: 'offchain', key: RAW.sim(MINT), value: sim(open + AHEAD_HOLD_SLOTS) }, { receivedAt: T0, notBefore: open + AHEAD_HOLD_SLOTS });
    expect(g.place.slot).toBe(open + AHEAD_HOLD_SLOTS);
  });
});
