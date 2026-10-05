// OOM-SWAPS and OOM-HEADS: the live worker's as-of store stays flat under a busy pool and many trade streams. Each swap on a watched pool left its trade event
// and a fresh pool fact in the store for the whole process (about 10 KB a swap with their addresses); at a few thousand
// swaps a minute the heap reached its 560 MB limit within minutes of every boot.
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { fromBase64, toBase64 } from '../../core/src/chain/index.ts';
import type { PoolState } from '../../core/src/amm/index.ts';
import { swapLog } from '../../core/test/facts/swaps.ts';
import { POOL_FACT_KEEP_MS, liveCollapse, liveRetention } from '../src/run/store-rules.ts';
import { DEV, POOL_ADDRESS, SUPPLY, makeWorker, passingMarket } from './worker-harness.ts';
import { candlesKey, carryKey, poolKey, poolTradeKeys, streamKey } from '../../core/src/gates/index.ts';
import { STREAMS } from '../../core/src/facts/index.ts';

setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc') as () => void;

/** A real swap log on the passing pool with the upgrade's 8-byte tail, all zeros (what every post-upgrade swap carries). */
const tailed = (pre: PoolState, side: 'buy' | 'sell', atMs: number): { logs: string[]; after: PoolState } => {
  const { logs, after } = swapLog({ pool: POOL_ADDRESS, coinCreator: DEV, supply: SUPPLY, pre, side, base: pre.baseReserve / 10_000_000n, atMs });
  const data = fromBase64(logs[1]!.slice('Program data: '.length));
  return { logs: [logs[0]!, `Program data: ${toBase64(Uint8Array.from([...data, 0, 0, 0, 0, 0, 0, 0, 0]))}`, logs[2]!], after };
};

describe('the live store under a busy pool (OOM-SWAPS)', () => {
  it('the worker and its parity replay use the live rules: trade keys collapse, pool facts keep a minute', () => {
    for (const k of poolTradeKeys(POOL_ADDRESS)) expect(liveCollapse(k)).not.toBeNull();
    expect(liveRetention(poolKey('M'))).toBe(POOL_FACT_KEEP_MS);
    expect(liveRetention('worker:sol-price')).toBeNull();
    expect(liveCollapse('worker:sol-price')).toBeNull();
  });

  it('12,000 swaps over two minutes after the first leave the heap flat (it grew about 10 KB a swap)', async () => {
    const h = makeWorker({});
    const m = await passingMarket(h);
    m.accountsRead(h.worker.feed.openSlot - 1n);
    let pre = m.chainState;
    let n = 0;
    const minute = () => m.run(60_000, 100, () => {
      m.slot();
      for (let k = 0; k < 10; k++) {
        const s = tailed(pre, k % 2 === 0 ? 'buy' : 'sell', m.now);
        h.worker.feed.ingest('helius', { type: 'logs', signature: `tailswap${++n}`, slot: h.worker.feed.openSlot, err: null, via: `logs:${POOL_ADDRESS}`, logs: s.logs, commitment: 'confirmed' }, { receivedAt: m.now });
        pre = s.after;
      }
      m.solPrice();
    });
    await minute();
    gc();
    const before = process.memoryUsage().heapUsed;
    await minute();
    await minute();
    gc();
    const grew = process.memoryUsage().heapUsed - before;
    expect(n).toBe(18_000);
    expect(grew).toBeLessThan(9 * 1024 * 1024);
    await h.worker.stop();
  }, 180_000);

  it('heads: the stream, candles and carry facts, the seen signatures, the slot notice, the account reads and the mint facts keep only their newest value; every other gate fact keeps its whole series', () => {
    for (const k of [streamKey(STREAMS.trades(POOL_ADDRESS)), streamKey('creates'), candlesKey('M'), carryKey('M'), `seen:logs:${POOL_ADDRESS}`, 'seen:pumpportal:create', 'chain:slot', 'read:accounts:M', 'gates/mint:M']) {
      const keepOlder = liveCollapse(k);
      expect(keepOlder, k).not.toBeNull();
      expect(keepOlder!({ moment: { slot: 1n, txIndex: 0, ixIndex: 0, receivedAt: 0 }, value: {}, source: 's' }), k).toBe(false);
    }
    for (const k of ['gates/holders:M', 'read:holders:M', 'gates/create:M', 'gates/migration:M', 'coverage:creates:start', 'chain:slots']) expect(liveCollapse(k), k).toBeNull();
  });

  it('240 pool trade streams at 2.5 slot notices a second and 4,050 swaps a minute leave the heap flat (it grew 19 MB in two minutes; live, about 20 MB a minute)', async () => {
    const h = makeWorker({});
    const m = await passingMarket(h);
    m.accountsRead(h.worker.feed.openSlot - 1n);
    // The catch-up wave after a restart: a trade stream per restored candidate pool, each a stream the producer
    // re-states at every slot notice.
    const from = h.worker.feed.openSlot;
    for (let i = 0; i < 240; i++) {
      const pool = `Pool${String(i).padStart(3, '1')}`.padEnd(44, 'z');
      m.offchain(`coverage:${STREAMS.trades(pool)}:start`, { fromSlot: from, via: `logs:${pool}` });
    }
    let pre = m.chainState;
    let n = 0;
    // Live rates: a slot notice every 400 ms; the swaps of 240 pools at about 17 a minute each, on the one pool whose
    // candles the producer keeps (each swap re-states them).
    const minute = () => m.run(60_000, 400, () => {
      m.slot();
      for (let k = 0; k < 27; k++) {
        const s = tailed(pre, k % 2 === 0 ? 'buy' : 'sell', m.now);
        // As the pool watch delivers a notification: the signature seen, then its log lines.
        h.worker.feed.ingest('helius', { type: 'seen', signature: `headswap${n + 1}`, slot: h.worker.feed.openSlot, err: null, via: `logs:${POOL_ADDRESS}`, detail: null }, { receivedAt: m.now });
        h.worker.feed.ingest('helius', { type: 'logs', signature: `headswap${++n}`, slot: h.worker.feed.openSlot, err: null, via: `logs:${POOL_ADDRESS}`, logs: s.logs, commitment: 'confirmed' }, { receivedAt: m.now });
        pre = s.after;
      }
      m.solPrice();
    });
    await minute();
    gc();
    const before = process.memoryUsage().heapUsed;
    await minute();
    await minute();
    gc();
    const grew = process.memoryUsage().heapUsed - before;
    expect(n).toBe(3 * 150 * 27);
    expect(grew).toBeLessThan(6 * 1024 * 1024);
    await h.worker.stop();
  }, 300_000);

  it('OOM-MINT: at three times the live rates (12,150 swaps a minute, 240 trade streams and 3 more a minute), the heap grows under 1 MB a minute once the feed\'s duplicate window is full', async () => {
    const h = makeWorker({});
    const m = await passingMarket(h);
    m.accountsRead(h.worker.feed.openSlot - 1n);
    let streams = 0;
    const stream = () => {
      const pool = `Pool${String(streams++).padStart(4, '1')}`.padEnd(44, 'z');
      m.offchain(`coverage:${STREAMS.trades(pool)}:start`, { fromSlot: h.worker.feed.openSlot, via: `logs:${pool}` });
    };
    for (let i = 0; i < 240; i++) stream();
    let pre = m.chainState;
    let n = 0;
    let step = 0;
    const minutes = (k: number) => m.run(k * 60_000, 400, () => {
      m.slot();
      if (++step % 50 === 0) stream();
      for (let j = 0; j < 81; j++) {
        const s = tailed(pre, j % 2 === 0 ? 'buy' : 'sell', m.now);
        const signature = `x3swap${++n}`.padEnd(88, 'q');
        h.worker.feed.ingest('helius', { type: 'seen', signature, slot: h.worker.feed.openSlot, err: null, via: `logs:${POOL_ADDRESS}`, detail: null }, { receivedAt: m.now });
        h.worker.feed.ingest('helius', { type: 'logs', signature, slot: h.worker.feed.openSlot, err: null, via: `logs:${POOL_ADDRESS}`, logs: s.logs, commitment: 'confirmed' }, { receivedAt: m.now });
        pre = s.after;
      }
      m.solPrice();
    });
    // The feed keeps duplicates for 1,500 slots (10 minutes): warm up past it, then measure four minutes.
    await minutes(11);
    gc();
    const before = process.memoryUsage().heapUsed;
    await minutes(4);
    gc();
    const grew = process.memoryUsage().heapUsed - before;
    console.log(`X3 grew ${(grew / 1048576).toFixed(2)} MB in 4 min, ${n} swaps, ${streams} streams`);
    expect(grew).toBeLessThan(4 * 1024 * 1024);
    await h.worker.stop();
  }, 900_000);
});

