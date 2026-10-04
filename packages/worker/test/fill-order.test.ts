// FILL-ORDER (S0-ZERO follow-up, found by the persist builder on #170): a fill's transactions are placed off-chain at
// one moment (the open slot, one receipt time), and same-moment events are released in id order. Their ids start with
// the signature, so a catch-up reached the engine in signature order, not chain order, and the socket's `resume` (a
// `coverage:` id) came before them. The candles then took trades out of order: wrong open and close, and a trade
// stamped before the newest candle marks them partial for good, so H11 kept refusing. The live feed now keeps
// the slot's off-chain frames in arrival order (the fill oldest first, then the resume), after the slot's notice.
import { describe, expect, it } from 'vitest';
import { transactionEvents, type TransactionRecord } from '../../core/src/chain/index.ts';
import { startSession, TRIAL_POLICY } from '../../core/src/config/index.ts';
import { OFF_CHAIN, type MarketEvent, type Moment } from '../../core/src/engine/index.ts';
import { Evidence, candlesKey, parseCandles } from '../../core/src/gates/index.ts';
import { FactWorld, MINT, POOL, RECORDS, atOf, chainTx, coverage, txEvents } from '../../core/test/facts/helpers.ts';
import { DEFAULT_LIVE_FEED, LiveFeed, eventsOfFrame, type Frame } from '../src/providers/index.ts';
import { blockNetwork } from './helpers.ts';

blockNetwork();

const policy = startSession(TRIAL_POLICY).policy;
const create = RECORDS.find((r) => transactionEvents(r.rec).some((e) => e.name === 'CreateEvent' && e.data.mint === MINT))!.rec;
const complete = chainTx('pump CompleteEvent (curve filled)');
const migrate = chainTx('migration CreatePoolEvent');
/** The pool's swaps in chain order (slot, then position in the block), as the fill ingests them, oldest first. */
const swaps = RECORDS.filter((r) => r.label === 'pool swap after migration' && r.rec.signature !== migrate.signature && r.rec.signature !== complete.signature).map((r) => r.rec);
const stream = `trades:${POOL}`;
const head = swaps.at(-1)!.slot + 1n;
const at = atOf(swaps.at(-1)!) + 1_000;
const sigOrder = (recs: readonly TransactionRecord[]) => [...recs].map((r) => r.signature).sort();
/** The signatures whose transaction yields events (a swap the decoder reads nothing from releases none), once each, in the given order. */
const withEvents = (recs: readonly TransactionRecord[]) => [...new Set(recs.filter((r) => transactionEvents(r).length > 0).map((r) => r.signature))];

/** The worker's view before the fill lands: the migration, the pool watch's coverage from it, the open catch-up gap. */
const base = (): FactWorld => new FactWorld().push(
  ...txEvents(create), ...txEvents(complete), ...txEvents(migrate),
  coverage(stream, 'start', { fromSlot: migrate.slot, via: `logs:${POOL}` }, migrate.slot, atOf(migrate) + 2_000),
  coverage(stream, 'gap', { fromSlot: migrate.slot, toSlot: null, reason: 'catch-up', via: `logs:${POOL}` }, migrate.slot, atOf(migrate) + 2_001),
);

/** The catch-up as the socket hands it to the live feed: the fill's swaps (`after`), then `resume`, all at one moment. */
const released = (): MarketEvent[] => {
  const feed = new LiveFeed({ ...DEFAULT_LIVE_FEED, horizonSlots: 0 });
  feed.ingest('helius', { type: 'slot', slot: head, parent: head - 1n, root: null }, { receivedAt: at });
  for (const record of swaps) feed.ingest('helius', { type: 'tx', record }, { receivedAt: at, backfilled: true, lookup: true, after: true });
  feed.ingest('helius', { type: 'offchain', key: `coverage:${stream}:resume`, value: { fromSlot: migrate.slot, toSlot: head - 1n, via: `logs:${POOL}` } }, { receivedAt: at });
  feed.ingest('helius', { type: 'slot', slot: head + 1n, parent: head, root: null }, { receivedAt: at + 1 });
  feed.advance(at + 2);
  const out: MarketEvent[] = [];
  for (let e = feed.next(); e !== null; e = feed.next()) if (e.kind === 'market') out.push(e);
  return out;
};

const txOf = (e: MarketEvent): string | null => (/^ev:([1-9A-HJ-NP-Za-km-z]+):/.exec(e.id)?.[1] ?? null);

describe('a fill reaches the engine in chain order, before the resume that closes its gap', () => {
  it('the fixture is a real test: chain order is not signature order', () => {
    expect(withEvents(swaps)).not.toEqual(sigOrder(swaps.filter((r) => withEvents(swaps).includes(r.signature))));
  });

  it('the swaps are released oldest first, as ingested, and the resume after the last of them', () => {
    const out = released();
    const order = [...new Set(out.map(txOf).filter((s): s is string => s !== null))];
    expect(order).toEqual(withEvents(swaps));
    const resume = out.findIndex((e) => e.key === `coverage:${stream}:resume`);
    const lastTx = out.map(txOf).lastIndexOf(swaps.at(-1)!.signature);
    expect(resume).toBeGreaterThan(lastTx);
    // Each transaction's events keep their order inside it.
    for (const r of swaps) {
      const ids = out.filter((e) => txOf(e) === r.signature).map((e) => e.id);
      expect(ids).toEqual([...ids].sort());
    }
  });

  it('through the real producer: the candles equal the chain-order candles, not partial, and H11 passes', () => {
    const live = base().push(...released());
    const truth = base().push(...swaps.flatMap((s) => txEvents(s)));
    const candlesOf = (w: FactWorld) => w.last(candlesKey(MINT)) as { obs: { quality: readonly string[] }; candles: unknown[] };
    expect(candlesOf(live).obs.quality).toEqual([]);
    expect(candlesOf(live).candles).toEqual(candlesOf(truth).candles);
    const now: Moment = { slot: head + 1n, txIndex: OFF_CHAIN, ixIndex: OFF_CHAIN, receivedAt: at + 3 };
    expect(new Evidence(live.ctx(now), policy).read('candles', candlesKey(MINT), parseCandles, 'state', 'H11').ok).toBe(true);
  });

  it('off-chain frames keep arrival order in their slot: after its notice, a fact ingested before the fill stays before it', () => {
    const feed = new LiveFeed({ ...DEFAULT_LIVE_FEED, horizonSlots: 0 });
    feed.ingest('helius', { type: 'slot', slot: head, parent: head - 1n, root: null }, { receivedAt: at });
    feed.ingest('helius', { type: 'offchain', key: 'z:before', value: 1 }, { receivedAt: at });
    for (const record of [...swaps].reverse()) feed.ingest('helius', { type: 'tx', record }, { receivedAt: at, lookup: true, after: true });
    feed.ingest('helius', { type: 'offchain', key: 'a:after', value: 2 }, { receivedAt: at });
    feed.ingest('helius', { type: 'slot', slot: head + 1n, parent: head, root: null }, { receivedAt: at + 1 });
    feed.advance(at + 2);
    const out: MarketEvent[] = [];
    for (let e = feed.next(); e !== null; e = feed.next()) if (e.kind === 'market') out.push(e);
    const txs = [...new Set(out.map(txOf).filter((s): s is string => s !== null))];
    // Ingested newest first here: released newest first. Arrival order, whatever the signatures and keys.
    expect(txs).toEqual(withEvents([...swaps].reverse()));
    const notice = out.findIndex((e) => e.key === 'chain:slot' && (e.value as { slot: bigint }).slot === head);
    const before = out.findIndex((e) => e.key === 'z:before');
    const firstTx = out.findIndex((e) => txOf(e) !== null);
    const lastTx = out.map(txOf).lastIndexOf(txs.at(-1)!);
    const after = out.findIndex((e) => e.key === 'a:after');
    expect([notice < before, before < firstTx, lastTx < after]).toEqual([true, true, true]);
  });

  it('a reconnect gap opened in the same slot as its fill: H11 never passes while the fill lands, only after the resume', () => {
    // Before the drop: the catch-up done, the first swaps seen, H11 passing.
    const k = 8;
    const w = new FactWorld().push(
      ...txEvents(create), ...txEvents(complete), ...txEvents(migrate),
      coverage(stream, 'start', { fromSlot: migrate.slot, via: `logs:${POOL}` }, migrate.slot, atOf(migrate) + 2_000),
      ...swaps.slice(0, k).flatMap((s) => txEvents(s)),
    );
    const read = (m: Moment) => new Evidence(w.ctx(m), policy).read('candles', candlesKey(MINT), parseCandles, 'state', 'H11');
    // The socket drops and comes back with the slot unchanged (no notices while down): the gap, the fill, the resume,
    // all in the one open slot.
    const feed = new LiveFeed({ ...DEFAULT_LIVE_FEED, horizonSlots: 0 });
    feed.ingest('helius', { type: 'slot', slot: head, parent: head - 1n, root: null }, { receivedAt: at });
    feed.ingest('helius', { type: 'offchain', key: `coverage:${stream}:gap`, value: { fromSlot: swaps[k]!.slot, toSlot: null, reason: 'disconnect', via: `logs:${POOL}` } }, { receivedAt: at });
    for (const record of swaps.slice(k)) feed.ingest('helius', { type: 'tx', record }, { receivedAt: at, backfilled: true, lookup: true, after: true });
    feed.ingest('helius', { type: 'offchain', key: `coverage:${stream}:resume`, value: { fromSlot: swaps[k]!.slot, toSlot: head - 1n, via: `logs:${POOL}` } }, { receivedAt: at });
    feed.ingest('helius', { type: 'slot', slot: head + 1n, parent: head, root: null }, { receivedAt: at + 1 });
    feed.advance(at + 2);
    const verdicts: { key: string; ok: boolean }[] = [];
    for (let e = feed.next(); e !== null; e = feed.next()) {
      if (e.kind !== 'market') continue;
      w.push(e);
      if (txOf(e) !== null || e.key.startsWith('coverage:')) verdicts.push({ key: txOf(e) === null ? e.key : 'trade', ok: read(e.moment).ok });
    }
    const gap = verdicts.findIndex((v) => v.key.endsWith(':gap'));
    const resume = verdicts.findIndex((v) => v.key.endsWith(':resume'));
    expect(gap).toBe(0);
    // Every fill trade is judged with the gap open: H11 refuses until the resume.
    expect(verdicts.slice(0, resume).every((v) => !v.ok), JSON.stringify(verdicts)).toBe(true);
    expect(verdicts[resume]!.ok).toBe(true);
  });

  it('a frame recorded before FILL-ORDER (no `arrival`) keeps its old moment, so an old recording replays unchanged', () => {
    const old: Frame = { seq: 7, receivedAt: at, source: 'helius', backfilled: false, place: { at: 'offchain', slot: head }, duplicate: false, body: { type: 'offchain', key: 'k', value: 1 } };
    expect(eventsOfFrame(old, new Map()).map((e) => e.moment)).toEqual([{ slot: head, txIndex: OFF_CHAIN, ixIndex: OFF_CHAIN, receivedAt: at }]);
    const now: Frame = { ...old, place: { at: 'offchain', slot: head, arrival: true } };
    expect(eventsOfFrame(now, new Map()).map((e) => e.moment)).toEqual([{ slot: head, txIndex: OFF_CHAIN, ixIndex: 8, receivedAt: at }]);
    // Event ids do not change either way.
    expect(eventsOfFrame(now, new Map()).map((e) => e.id)).toEqual(eventsOfFrame(old, new Map()).map((e) => e.id));
  });
});
