// OOM-SWAPS: the live worker's as-of store stays flat under a busy pool. Each swap on a watched pool left its trade event
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
import { poolKey, poolTradeKeys } from '../../core/src/gates/index.ts';

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
});
