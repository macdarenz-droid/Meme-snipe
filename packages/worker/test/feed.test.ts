// The live Feed against the backtest Feed: ordering parity, dedup, late facts, lookups, the stale rule and gap holds.
import { describe, expect, it } from 'vitest';
import { PUMP_AMM_GLOBAL_CONFIG, PUMP_GLOBAL } from '../../core/src/chain/index.ts';
import { createReplay, Engine, runToEnd, type Feed, type FeedEvent, type MarketEvent, type Strategy, type Clock } from '../../core/src/engine/index.ts';
import { CONFIG } from '../../core/test/fixtures.ts';
import {
  ACCOUNT_TX_INDEX, DEFAULT_LIVE_FEED, dedupKey, frameEvents, LIVE_TX_BASE, LiveFeed, replayRecorded, type Frame, type FrameBody, type LiveFeedOptions, type Release, type Source,
} from '../src/providers/index.ts';
import { blockNetwork, recordOf, tx, TXS } from './helpers.ts';
import { SigRanks } from '../src/providers/canonical.ts';

blockNetwork();

/** Reads the slot and its own key on every market event, so the decision log records what the strategy saw. */
const reader = (): Strategy => ({
  onMarket: (e: MarketEvent, ctx) => {
    const slot = ctx.lookup('chain:slot');
    const own = ctx.lookup(e.key);
    return [{ action: null, reasons: [e.key, slot.ok ? `slot ${String((slot.value as { slot: bigint }).slot)}` : 'no slot', own.ok ? own.source : 'missing'] }];
  },
});

const engineOn = (clock: Clock, feed: Feed) => new Engine({ clock, feed, strategy: reader(), runner: { run: () => undefined }, seed: 'feed-parity', book: CONFIG });

interface Arrival {
  readonly at: number;
  readonly source: Source;
  readonly body: FrameBody;
  readonly lookup?: boolean;
  readonly backfilled?: boolean;
}

const run = (arrivals: readonly Arrival[], opts: Partial<LiveFeedOptions> = {}) => {
  const frames: Frame[] = [];
  const released: { id: string; late: boolean }[] = [];
  const releases: Release[] = [];
  const feed = new LiveFeed({ ...DEFAULT_LIVE_FEED, ...opts, onFrame: (f) => frames.push(f), onRelease: (e, r) => { released.push({ id: e.id, late: r.late }); releases.push(r); } });
  const engine = engineOn(feed.clock, feed);
  let last = 0;
  for (const a of arrivals) {
    feed.ingest(a.source, a.body, { receivedAt: a.at, lookup: a.lookup ?? false, backfilled: a.backfilled ?? false });
    feed.advance(a.at);
    engine.drain();
    last = a.at;
  }
  feed.advance(last + 60_000); // the stale rule flushes the rest
  engine.drain();
  return { feed, engine, frames, released, releases };
};

/** The parity replay of recorded live data: frames plus the recorded release sequence, through the same engine. */
const replayLive = (frames: readonly Frame[], releases: readonly Release[]) => {
  const r = replayRecorded(frames, releases);
  const ids: string[] = [];
  const feed: Feed = { next: () => { const e = r.feed.next(); if (e) ids.push(e.id); return e; } };
  const engine = engineOn(r.clock, feed);
  engine.drain();
  return { engine, ids };
};

/** Replays recorded frames through the backtest Feed (`createReplay`) and the same engine. */
const replay = (frames: readonly Frame[]) => {
  const r = createReplay(frameEvents(frames));
  const ids: string[] = [];
  const feed: Feed = { next: () => { const e = r.feed.next(); if (e) ids.push(e.id); return e; } };
  const engine = engineOn(r.clock, feed);
  runToEnd(r, engine);
  return { engine, ids };
};

const SLOTS = [...new Set(TXS.map((t) => BigInt(t.slot)))].sort((a, b) => (a < b ? -1 : 1));

/**
 * A realistic arrival script over real mainnet transactions: slot notices and log sightings from both providers
 * (the second copy a few ms later), each transaction fetched and decoded, account states from both providers,
 * a third-party fact per slot, and one sighting that arrives after a later slot's notice (within the horizon).
 */
const script = (): Arrival[] => {
  const out: Arrival[] = [];
  let t = 1_791_000_000_000;
  for (const slot of SLOTS) {
    t += 400;
    const txs = TXS.filter((x) => BigInt(x.slot) === slot);
    out.push({ at: t, source: 'helius', body: { type: 'slot', slot, parent: slot - 1n, root: slot - 32n } });
    out.push({ at: t + 3, source: 'alchemy', body: { type: 'slot', slot, parent: slot - 1n, root: slot - 32n } });
    txs.forEach((x, k) => {
      const err = x.base64.meta?.err ?? null;
      const seen = (source: Source, at: number): Arrival => ({ at, source, body: { type: 'seen', signature: x.signature, slot, err, via: `logs:${PUMP_GLOBAL}`, detail: null } });
      // Odd positions arrive Helius-first, even ones Alchemy-first: either provider can win.
      out.push(seen(k % 2 ? 'helius' : 'alchemy', t + 10 + 2 * k), seen(k % 2 ? 'alchemy' : 'helius', t + 11 + 2 * k));
      if (err === null) out.push({ at: t + 100 + k, source: 'helius', body: { type: 'tx', record: recordOf(x) }, lookup: true });
    });
    const acct = (source: Source, at: number): Arrival => ({ at, source, body: { type: 'account', slot, address: PUMP_AMM_GLOBAL_CONFIG, owner: PUMP_GLOBAL, lamports: slot, data: Uint8Array.of(1, 2, Number(slot % 256n)) } });
    out.push(acct('alchemy', t + 150), acct('helius', t + 151));
    out.push({ at: t + 160, source: 'rugcheck', body: { type: 'offchain', key: `rugcheck:${slot}`, value: { score: 1 } } });
  }
  // Slot 452941175's sighting, again from a third source, after slot 452941177's notice: still within a 4-slot horizon.
  const c = tx('pump CreateEvent (mayhem)');
  const i = out.findIndex((a) => a.body.type === 'slot' && a.body.slot === 452941177n);
  out.splice(i + 1, 0, { at: out[i]!.at + 1, source: 'pumpportal', body: { type: 'seen', signature: c.signature, slot: null, err: null, via: 'pumpportal:create', detail: {} } });
  return out;
};

describe('live Feed', () => {
  it('OOM-MINT: a kept dedupe key costs under 100 B and never keeps its frame\'s signature alive (it kept the whole 88 characters)', async () => {
    const { setFlagsFromString } = await import('node:v8');
    const { runInNewContext } = await import('node:vm');
    setFlagsFromString('--expose-gc');
    const gc = runInNewContext('gc') as () => void;
    const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    // A fresh signature string per frame, as each notification's JSON parse makes one; dropped once the key is built.
    const fresh = (i: number): string => JSON.parse(JSON.stringify(Array.from({ length: 88 }, (_, k) => B58[(i * 7 + k * 13 + (i >> k % 16)) % 58]).join(''))) as string;
    const N = 100_000;
    const keys = new Set<string>();
    gc();
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < N; i++) {
      const signature = fresh(i);
      keys.add(dedupKey({ type: 'seen', signature, slot: 1n, err: null, via: 'logs:x', detail: null })!);
    }
    gc();
    const perKey = (process.memoryUsage().heapUsed - before) / N;
    expect(keys.size).toBe(N);
    expect(perKey).toBeLessThan(100);
  });

  it('SEEN-TAGS: a slot rank costs under 110 B and never keeps its signature alive; ranks are as a Map\'s', async () => {
    const { setFlagsFromString } = await import('node:v8');
    const { runInNewContext } = await import('node:vm');
    setFlagsFromString('--expose-gc');
    const gc = runInNewContext('gc') as () => void;
    const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    const fresh = (i: number): string => JSON.parse(JSON.stringify(Array.from({ length: 88 }, (_, k) => B58[(i * 7 + k * 13 + (i >> k % 16)) % 58]).join(''))) as string;
    const N = 50_000;
    const ranks = new SigRanks();
    const plain = new Map<string, number>();
    gc();
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < N; i++) ranks.set(fresh(i), ranks.size);
    gc();
    const per = (process.memoryUsage().heapUsed - before) / N;
    expect(per).toBeLessThan(110);
    for (let i = 0; i < 2_000; i++) plain.set(fresh(i), plain.size);
    for (let i = 0; i < 2_000; i++) expect(ranks.get(fresh(i))).toBe(plain.get(fresh(i)));
    expect(ranks.has(fresh(N + 1))).toBe(false);
  });

  it('SEEN-TAGS, FEED-KEYS: the live feed keeps a released swap\'s signature in under 140 B (its seen and confirmed-logs dedupe tags and its slot rank; 252 B with key strings)', async () => {
    const { setFlagsFromString } = await import('node:v8');
    const { runInNewContext } = await import('node:vm');
    setFlagsFromString('--expose-gc');
    const gc = runInNewContext('gc') as () => void;
    const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    const fresh = (i: number): string => JSON.parse(JSON.stringify(Array.from({ length: 88 }, (_, k) => B58[(i * 7 + k * 13 + (i >> k % 16)) % 58]).join(''))) as string;
    const feed = new LiveFeed({ ...DEFAULT_LIVE_FEED });
    const S0 = 452_000_000n;
    let n = 0;
    let t = 1_000;
    const drain = () => { feed.advance(t); while (feed.next() !== null) { /* released */ } };
    // Warm the feed's own structures first, then measure 200 slots of 100 signatures each (inside its 1,500-slot window).
    const run = (slots: number, from: bigint) => {
      for (let k = 0n; k < BigInt(slots); k++) {
        const slot = from + k;
        feed.ingest('helius', { type: 'slot', slot, parent: slot - 1n, root: null }, { receivedAt: t });
        for (let j = 0; j < 100; j++) {
          const signature = fresh(n++);
          feed.ingest('helius', { type: 'seen', signature, slot, err: null, via: 'logs:x', detail: null }, { receivedAt: t });
          feed.ingest('helius', { type: 'logs', signature, slot, err: null, via: 'logs:x', logs: ['Program log: x'], commitment: 'confirmed' }, { receivedAt: t });
        }
        t += 400;
        drain();
      }
    };
    run(20, S0);
    gc();
    const before = process.memoryUsage().heapUsed;
    const n0 = n;
    run(200, S0 + 20n);
    gc();
    const per = (process.memoryUsage().heapUsed - before) / (n - n0);
    expect(feed.status().releasedThrough).toBeGreaterThan(S0 + 200n);
    expect(per).toBeLessThan(140);
  });

  it('OOM-MINT: every dedupe case still dedupes with the compact keys, and different facts stay apart', () => {
    const feed = new LiveFeed({ ...DEFAULT_LIVE_FEED });
    const t = tx('pump TradeEvent');
    const sig = t.signature;
    const other = (sig.startsWith('1') ? '2' : '1') + sig.slice(1);
    const at = { receivedAt: 1 };
    const seen = (signature: string, via: string): FrameBody => ({ type: 'seen', signature, slot: BigInt(t.slot), err: null, via, detail: null });
    const logs = (signature: string, commitment?: 'confirmed'): FrameBody => ({ type: 'logs', signature, slot: BigInt(t.slot), err: null, via: 'logs:x', logs: ['Program log: x'], ...(commitment === undefined ? {} : { commitment }) });
    const dup = (b: FrameBody) => feed.ingest('helius', b, at).duplicate;
    // The first copy of each fact is new; a second copy (from either provider) is a duplicate.
    expect([dup(seen(sig, 'logs:x')), dup(seen(sig, 'logs:y'))]).toEqual([false, true]);
    expect([dup(logs(sig)), dup(logs(sig))]).toEqual([false, true]);
    expect([dup(logs(sig, 'confirmed')), dup(logs(sig, 'confirmed'))]).toEqual([false, true]);
    expect([dup({ type: 'tx', record: recordOf(t) }), feed.ingest('alchemy', { type: 'tx', record: recordOf(t) }, at).duplicate]).toEqual([false, true]);
    // Another signature, or the same one under another kind or commitment, is another fact.
    expect([dup(seen(other, 'logs:x')), dup(logs(other)), dup(logs(other, 'confirmed'))]).toEqual([false, false, false]);
  });

  it('ordering parity: recorded frames and releases replay to the live release sequence and the same decision log', () => {
    const live = run(script(), { horizonSlots: 4 });
    const back = replayLive(live.frames, live.releases);
    expect(back.ids).toEqual(live.released.map((r) => r.id));
    expect(back.engine.logHash()).toBe(live.engine.logHash());
    // With nothing late, re-sorting the frames gives the same sequence too: the mapping is one.
    expect(replay(live.frames).engine.logHash()).toBe(live.engine.logHash());
    expect(live.engine.records.filter((r) => r.type === 'fault')).toEqual([]);
    // Real events came through DEC-1's decoder: every fixture's events, in execution order inside each transaction.
    const evs = live.released.filter((r) => r.id.startsWith('ev:'));
    expect(evs.length).toBeGreaterThan(20);
    expect(live.engine.records.filter((r) => r.type === 'decision').length).toBe(live.released.length);
  });

  it('the release sequence is the engine total order: slot, then rank of first arrival, then instruction position', () => {
    const live = run(script(), { horizonSlots: 4 });
    const back = createReplay(frameEvents(live.frames));
    const events: FeedEvent[] = [];
    while (back.advance()) for (let e = back.feed.next(); e; e = back.feed.next()) events.push(e);
    const slot = 452941205n;
    const inSlot = events.filter((e) => e.moment.slot === slot);
    // Transactions in the order their first copy arrived (the fixture order here), each contiguous, events after the sighting.
    const order = inSlot.filter((e) => e.id.startsWith('seen:')).map((e) => e.moment.txIndex - LIVE_TX_BASE);
    expect(order).toEqual(order.map((_, k) => k));
    const buy = tx('PumpSwap BuyEvent');
    const own = inSlot.filter((e) => e.id.includes(buy.signature));
    expect(own.map((e) => e.id.split(':')[0])).toEqual(['seen', ...own.slice(1).map(() => 'ev')]);
    expect(new Set(own.map((e) => e.moment.txIndex)).size).toBe(1);
    // Account state after every transaction of its slot; off-chain facts last.
    const acct = inSlot.find((e) => e.id.startsWith('acct:'))!;
    expect(acct.moment.txIndex).toBe(ACCOUNT_TX_INDEX);
    expect(inSlot.at(-1)!.id.startsWith('rugcheck:')).toBe(true);
  });

  it('dedup by signature: the first copy wins across providers and sources; later copies are recorded, never released', () => {
    const live = run(script(), { horizonSlots: 4 });
    const ids = live.released.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const t of TXS) expect(ids.filter((id) => id === `seen:${t.signature}`)).toHaveLength(1);
    const dups = live.frames.filter((f) => f.duplicate);
    // One duplicate per slot notice, per sighting and per account state.
    expect(dups.length).toBe(SLOTS.length * 2 + TXS.length + 1);
    // The winner is the earliest arrival: each seen event names the provider that sent it first.
    const c = tx('pump CreateEvent (mayhem)');
    const first = live.frames.find((f) => f.body.type === 'seen' && f.body.signature === c.signature)!;
    expect(first.duplicate).toBe(false);
    expect(live.frames.filter((f) => f.body.type === 'seen' && f.body.signature === c.signature && f.source === 'pumpportal')[0]!.duplicate).toBe(true);
  });

  it('parity with late, backfilled-late and cross-slot reordered frames: the recorded release sequence replays exactly', () => {
    const arrivals = script();
    const at = (slot: bigint) => arrivals.findIndex((a) => a.body.type === 'slot' && a.body.slot === slot);
    const early = tx('pump CreateEvent (mayhem)'); // slot 452941175
    const mid = tx('pump CreateEvent', 1); // slot 452941197
    // After slot 452941205 is released: a late account state, a backfilled-late sighting and a late sighting of an older slot.
    const i = at(452941205n);
    arrivals.splice(i + 1, 0,
      { at: arrivals[i]!.at + 1, source: 'alchemy', body: { type: 'account', slot: BigInt(mid.slot), address: PUMP_GLOBAL, owner: PUMP_GLOBAL, lamports: 1n, data: Uint8Array.of(9) } },
      { at: arrivals[i]!.at + 2, source: 'helius', backfilled: true, body: { type: 'seen', signature: tx('pump TradeEvent').signature, slot: BigInt(mid.slot), err: null, via: 'logs:x', detail: null } },
      { at: arrivals[i]!.at + 3, source: 'helius', body: { type: 'seen', signature: (early.signature.startsWith('1') ? '2' : '1') + early.signature.slice(1), slot: BigInt(early.slot), err: null, via: 'logs:y', detail: null } },
    );
    const live = run(arrivals, { horizonSlots: 4 });
    // LATE-LOG: the three late frames are placed off-chain and released in order: none is refused.
    expect(live.frames.filter((f) => f.late === true)).toHaveLength(3);
    expect(live.feed.status().late).toBe(3);
    expect(live.released.filter((r) => r.late)).toEqual([]);
    expect(live.engine.records.filter((r) => r.type === 'fault')).toEqual([]);
    const back = replayLive(live.frames, live.releases);
    expect(back.ids).toEqual(live.released.map((r) => r.id));
    expect(back.engine.logHash()).toBe(live.engine.logHash());
    // A tampered record is refused, not replayed.
    expect(() => replayRecorded(live.frames, live.releases.slice(1))).toThrow(/missing/);
  });

  it('LATE-LOG: a fact that arrives after its slot was released is placed off-chain, marked late, and accepted', () => {
    const arrivals = script();
    const late = tx('pump CreateEvent', 1);
    const pos = arrivals.findIndex((a) => a.body.type === 'slot' && a.body.slot === 452941205n);
    arrivals.splice(pos + 1, 0, { at: arrivals[pos]!.at + 1, source: 'alchemy', body: { type: 'account', slot: BigInt(late.slot), address: PUMP_GLOBAL, owner: PUMP_GLOBAL, lamports: 1n, data: Uint8Array.of(9) } });
    const live = run(arrivals, { horizonSlots: 4 });
    const frame = live.frames.find((f) => f.body.type === 'account' && f.body.lamports === 1n)!;
    expect(frame.late).toBe(true);
    expect(frame.place.at).toBe('offchain');
    expect(frame.place.slot).toBeGreaterThan(BigInt(late.slot));
    const id = live.released.find((r) => r.id.startsWith(`acct:${PUMP_GLOBAL}:${late.slot}:`))!;
    expect(id.late).toBe(false);
    expect(live.engine.records.filter((r) => r.type === 'fault')).toEqual([]);
    expect(live.feed.status().late).toBe(1);
    // A re-sort of the frames places it where live did: the backtest replay of the frames gives the same log.
    expect(replay(live.frames).engine.logHash()).toBe(live.engine.logHash());
  });

  it('LATE-LOG: whatever the delivery delays, the engine refuses nothing, and the recording replays exactly', () => {
    // Seeded delays of 0 to 3 s on every non-slot frame (horizons 0 to 2 slots, 400 ms a slot): many arrive late.
    for (let seed = 1; seed <= 12; seed++) {
      let x = seed;
      const rnd = (): number => ((x = (x * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648);
      const arrivals = script().map((a, k) => ({ ...a, at: a.body.type === 'slot' ? a.at : a.at + Math.floor(rnd() * 3_000), k }))
        .sort((a, b) => a.at - b.at || a.k - b.k);
      const live = run(arrivals, { horizonSlots: seed % 3 });
      expect(live.engine.records.filter((r) => r.type === 'fault')).toEqual([]);
      expect(live.released.filter((r) => r.late)).toEqual([]);
      if (seed === 1) expect(live.feed.status().late).toBeGreaterThan(0);
      const back = replayLive(live.frames, live.releases);
      expect(back.engine.logHash()).toBe(live.engine.logHash());
    }
  });

  it('a lookup answered after its slot was released enters as an off-chain fact at the open slot, and is accepted', () => {
    const arrivals = script().filter((a) => a.body.type !== 'tx');
    const t = tx('migration CreatePoolEvent');
    arrivals.push({ at: arrivals.at(-1)!.at + 5_000, source: 'alchemy', body: { type: 'tx', record: recordOf(t) }, lookup: true });
    const live = run(arrivals, { horizonSlots: 4 });
    expect(live.released.filter((r) => r.late)).toEqual([]);
    expect(live.engine.records.filter((r) => r.type === 'fault')).toEqual([]);
    const frame = live.frames.find((f) => f.body.type === 'tx')!;
    expect(frame.place.at).toBe('offchain');
    expect(frame.place.slot).toBeGreaterThan(BigInt(t.slot));
    const back = replay(live.frames);
    expect(back.engine.logHash()).toBe(live.engine.logHash());
  });

  it('holds facts behind the horizon and releases a stale feed after staleReleaseMs', () => {
    const feed = new LiveFeed({ ...DEFAULT_LIVE_FEED, horizonSlots: 2, staleReleaseMs: 2_000 });
    feed.ingest('helius', { type: 'slot', slot: 100n, parent: 99n, root: 68n }, { receivedAt: 0 });
    feed.ingest('rugcheck', { type: 'offchain', key: 'rugcheck:x', value: 1 }, { receivedAt: 10 });
    expect(feed.advance(10)).toBe(0);
    feed.ingest('helius', { type: 'slot', slot: 102n, parent: 101n, root: 70n }, { receivedAt: 800 });
    expect(feed.advance(800)).toBe(2);
    expect(feed.releasedThrough).toBe(100n);
    feed.ingest('rugcheck', { type: 'offchain', key: 'rugcheck:y', value: 2 }, { receivedAt: 900 });
    expect(feed.advance(2_700)).toBe(0); // the tip moved 1.9 s ago: not stale yet
    expect(feed.advance(2_800)).toBe(2); // stale: everything up to the tip goes
    expect(feed.status().stale).toBe(true);
    expect([feed.next()?.id, feed.next()?.id, feed.next()?.id, feed.next()?.id]).toEqual(['slot:100', 'rugcheck:x#000000000001', 'slot:102', 'rugcheck:y#000000000003']);
    expect(feed.next()).toBeNull();
  });

  it('a reconnect gap holds the release point below the missed slots until the backfill ends or the hold times out', () => {
    const feed = new LiveFeed({ ...DEFAULT_LIVE_FEED, horizonSlots: 0, maxGapHoldMs: 3_000 });
    for (const s of [100n, 101n]) feed.ingest('alchemy', { type: 'slot', slot: s, parent: null, root: null }, { receivedAt: Number(s) });
    feed.openGap('helius-ws', 101n, 200);
    feed.advance(200);
    expect(feed.releasedThrough).toBe(100n);
    feed.ingest('helius', { type: 'seen', signature: tx('pump TradeEvent').signature, slot: 101n, err: null, via: 'logs:x', detail: null }, { receivedAt: 300, backfilled: true });
    feed.closeGap('helius-ws');
    feed.advance(300);
    expect(feed.releasedThrough).toBe(101n);
    const ids: string[] = [];
    for (let e = feed.next(); e; e = feed.next()) ids.push(e.id);
    expect(ids).toEqual(['slot:100', `seen:${tx('pump TradeEvent').signature}`, 'slot:101']);
    // A hold that is never closed ends after maxGapHoldMs.
    feed.ingest('alchemy', { type: 'slot', slot: 105n, parent: null, root: null }, { receivedAt: 400 });
    feed.openGap('helius-ws', 102n, 400);
    feed.advance(3_399);
    expect(feed.releasedThrough).toBe(101n);
    feed.advance(3_400);
    expect(feed.releasedThrough).toBe(105n);
  });

  it('backfilled facts are marked in their event values', () => {
    const f = new LiveFeed({ ...DEFAULT_LIVE_FEED, horizonSlots: 0 });
    f.ingest('helius', { type: 'seen', signature: tx('pump TradeEvent').signature, slot: 7n, err: null, via: 'logs:x', detail: null }, { receivedAt: 1, backfilled: true });
    f.ingest('helius', { type: 'slot', slot: 7n, parent: null, root: null }, { receivedAt: 2 });
    f.advance(2);
    const seen = f.next() as MarketEvent;
    expect(seen.value).toMatchObject({ backfilled: true, source: 'helius' });
    expect((f.next() as MarketEvent).value).toMatchObject({ backfilled: false });
  });

  it('chain facts older than keepSlots enter off-chain, so dedup and ranks can be forgotten safely', () => {
    const feed = new LiveFeed({ ...DEFAULT_LIVE_FEED, horizonSlots: 0, keepSlots: 10 });
    feed.ingest('helius', { type: 'slot', slot: 1_000n, parent: null, root: null }, { receivedAt: 1 });
    feed.advance(1);
    const old = feed.ingest('helius', { type: 'seen', signature: tx('pump TradeEvent').signature, slot: 900n, err: null, via: 'logs:x', detail: null }, { receivedAt: 2 });
    expect(old.place).toEqual({ at: 'offchain', slot: 1_001n, arrival: true });
    // LATE-LOG: one inside keepSlots but already released is placed off-chain too, marked late (never released out of order).
    const recent = feed.ingest('helius', { type: 'seen', signature: tx('pump TradeEvent', 1).signature, slot: 995n, err: null, via: 'logs:x', detail: null }, { receivedAt: 3 });
    expect(recent.place).toEqual({ at: 'offchain', slot: 1_001n, arrival: true });
    expect(recent.late).toBe(true);
    // Not late: one of a slot still held stays on the chain.
    const held = feed.ingest('helius', { type: 'seen', signature: tx('pump TradeEvent', 2).signature, slot: 1_001n, err: null, via: 'logs:x', detail: null }, { receivedAt: 4 });
    expect(held.place).toEqual({ at: 'chain', slot: 1_001n });
    expect(held.late).toBeUndefined();
  });

  it('a copy that comes back after its dedup key was forgotten still gets a unique event id', () => {
    const frames: Frame[] = [];
    const feed = new LiveFeed({ ...DEFAULT_LIVE_FEED, horizonSlots: 0, keepSlots: 10, onFrame: (f) => frames.push(f) });
    const sig = tx('pump TradeEvent').signature;
    const seen = (slot: bigint, at: number) => feed.ingest('pumpportal', { type: 'seen', signature: sig, slot: null, err: null, via: 'pumpportal:create', detail: { slot } }, { receivedAt: at });
    feed.ingest('helius', { type: 'slot', slot: 100n, parent: null, root: null }, { receivedAt: 1 });
    seen(100n, 2);
    feed.ingest('helius', { type: 'slot', slot: 200n, parent: null, root: null }, { receivedAt: 3 });
    feed.advance(3);
    expect(seen(200n, 4).duplicate).toBe(false); // the first copy's key (slot 100) is gone
    feed.ingest('helius', { type: 'slot', slot: 201n, parent: null, root: null }, { receivedAt: 5 });
    feed.advance(5);
    const ids: string[] = [];
    for (let e = feed.next(); e; e = feed.next()) ids.push(e.id);
    expect(ids.filter((id) => id.startsWith('seen:'))).toEqual([`seen:${sig}#000000000001`, `seen:${sig}#000000000003`]);
    expect(() => createReplay(frameEvents(frames))).not.toThrow();
  });

  it('receipt times never go backwards, even when the wall clock does', () => {
    const feed = new LiveFeed(DEFAULT_LIVE_FEED);
    feed.ingest('rugcheck', { type: 'offchain', key: 'a', value: 1 }, { receivedAt: 1_000 });
    expect(feed.ingest('rugcheck', { type: 'offchain', key: 'b', value: 1 }, { receivedAt: 900 }).receivedAt).toBe(1_000);
  });
});

describe('BEHIND: shedding held frames', () => {
  it('drops only the named streams\' held frames, keeps transactions, slots, other streams and released frames, and returns each shed range', () => {
    const feed = new LiveFeed({ ...DEFAULT_LIVE_FEED, horizonSlots: 2 });
    const sig = (k: number) => `Shed${k}`.padEnd(88, '1');
    const seen = (k: number, slot: bigint, via: string) => feed.ingest('helius', { type: 'seen', signature: sig(k), slot, err: null, via, detail: null }, { receivedAt: k + 1 });
    // Released before the shed: slot 10, then the tip moves to 20 with a horizon of 2.
    seen(1, 10n, 'logs:CandPool');
    feed.ingest('helius', { type: 'slot', slot: 12n, parent: 11n, root: null }, { receivedAt: 2 });
    feed.advance(3);
    seen(2, 14n, 'logs:CandPool');
    seen(3, 15n, 'logs:HeldPool');
    seen(4, 17n, 'logs:CandPool');
    feed.ingest('helius', { type: 'tx', record: recordOf(tx('pump CreateEvent')) }, { receivedAt: 6 });
    feed.ingest('helius', { type: 'slot', slot: 20n, parent: 19n, root: null }, { receivedAt: 7 });
    const before = feed.heldFrames;
    const shed = feed.shed((via) => via === 'logs:CandPool');
    expect([...shed]).toEqual([['logs:CandPool', { fromSlot: 14n, toSlot: 17n }]]);
    expect(feed.heldFrames).toBe(before - 2);
    feed.advance(10);
    const vias: string[] = [];
    for (let e = feed.next(); e; e = feed.next()) if (e.kind === 'market' && e.key.startsWith('seen:')) vias.push(`${e.key}@${String((e.value as { slot: bigint }).slot)}`);
    expect(vias).toEqual(['seen:logs:CandPool@10', 'seen:logs:HeldPool@15']);
    expect(feed.shed(() => true).size).toBe(0);
  });
});

describe('BEHIND: a shed slot in live and in the recording\'s replay', () => {
  const sig = (k: number) => `Rank${[...String(k)].map((d) => 'abcdefghij'[Number(d)]).join('')}`.padEnd(88, '1');
  const live = () => {
    const frames: Frame[] = [];
    const releases: Release[] = [];
    const moments = new Map<string, unknown>();
    const feed = new LiveFeed({ ...DEFAULT_LIVE_FEED, horizonSlots: 2, onFrame: (f) => frames.push(f), onRelease: (e, r) => { releases.push(r); moments.set(e.id, e.moment); } });
    return { feed, frames, releases, moments };
  };
  const seen = (feed: LiveFeed, k: number, slot: bigint, via: string, at: number) => feed.ingest('helius', { type: 'seen', signature: sig(k), slot, err: null, via, detail: null }, { receivedAt: at });

  it('a frame released from a shed slot takes the same moment live and in replay (shed frames keep their rank: BT review B1)', () => {
    const l = live();
    for (let k = 0; k < 5; k++) seen(l.feed, k, 20n, 'logs:CandPool', 10 + k);
    l.feed.shed((via) => via === 'logs:CandPool');
    seen(l.feed, 9, 20n, 'logs:Other', 30);
    l.feed.ingest('helius', { type: 'slot', slot: 23n, parent: 22n, root: null }, { receivedAt: 31 });
    l.feed.advance(32);
    for (let e = l.feed.next(); e; e = l.feed.next()) void e;
    const r = replayRecorded(l.frames, l.releases);
    const replayed = new Map<string, unknown>();
    for (let e = r.feed.next(); e; e = r.feed.next()) replayed.set(e.id, e.moment);
    const other = [...l.moments.keys()].find((id) => id.startsWith(`seen:${sig(9)}`))!;
    expect(other).toBeDefined();
    expect(replayed.get(other)).toEqual(l.moments.get(other));
  });

  it('a gap placed first in a held slot is released before every event of that slot, at its first position; a released slot is refused', () => {
    const l = live();
    seen(l.feed, 1, 20n, 'logs:Other', 10);
    seen(l.feed, 2, 21n, 'logs:Other', 11);
    l.feed.ingest('worker', { type: 'offchain', key: 'coverage:trades:CandPool:gap', value: { fromSlot: 20n, toSlot: 21n, reason: 'shed', via: 'logs:CandPool' } }, { receivedAt: 12, firstIn: 20n });
    l.feed.ingest('helius', { type: 'slot', slot: 23n, parent: 22n, root: null }, { receivedAt: 13 });
    l.feed.advance(14);
    const order: string[] = [];
    for (let e = l.feed.next(); e; e = l.feed.next()) if (e.kind === 'market') order.push(e.key);
    expect(order.indexOf('coverage:trades:CandPool:gap')).toBeLessThan(order.indexOf('seen:logs:Other'));
    expect(order[0]).toBe('coverage:trades:CandPool:gap');
    const gap = [...l.moments.entries()].find(([id]) => id.startsWith('coverage:trades:CandPool:gap'))!;
    expect(gap[1]).toMatchObject({ slot: 20n, txIndex: 0, ixIndex: 0 });
    expect(() => l.feed.ingest('worker', { type: 'offchain', key: 'coverage:trades:X:gap', value: {} }, { receivedAt: 15, firstIn: 21n })).toThrow(/already released/);
  });
});
