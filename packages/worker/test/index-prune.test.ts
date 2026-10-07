// OOM-MINT (supervisor ruling): the deployer index holds in memory only what its save keeps, the H14 look-back plus a
// day; a creator's mints inside it still count after a prune, older ones are dropped exactly as the save drops them.
import { describe, expect, it } from 'vitest';
import { LOG_CREATE_PREFIX } from '../../core/src/gates/index.ts';
import { blockNetwork } from './helpers.ts';
import { T, makeWorker, passingMarket } from './worker-harness.ts';

blockNetwork();

const DAY = 86_400_000;
const OLD = 'OldDev111111111111111111111111111111111111';
const create = (mint: string, atMs: number) => ({ type: 'fact' as const, key: `${LOG_CREATE_PREFIX}${mint}`, value: { event: { program: 'pump', name: 'CreateEvent', data: { mint, creator: OLD, timestamp: BigInt(Math.floor(atMs / 1000)) } }, signature: `sig${mint}` } });

describe('the deployer index is pruned to its save line', () => {
  it('keeps a mint 14.5 days old, drops one 15 days and an hour old, as the save does', async () => {
    const h = makeWorker({});
    await h.worker.reconcile();
    const s = h.worker.strategy;
    const m = await passingMarket(h, {
      heldPoolFacts: true,
      before: {
        atMs: T - 14 * DAY,
        run: () => {
          h.worker.feed.ingest('helius', create('MintOld1', T - 15 * DAY - 3_600_000), { receivedAt: h.timers.now() });
          h.worker.feed.ingest('helius', create('MintNew1', T - 14 * DAY - 12 * 3_600_000), { receivedAt: h.timers.now() });
        },
      },
    });
    await m.run(4_000, 100, () => m.pool());
    const line = s.deployers.last!.receivedAt - 15 * DAY;
    const rows = (from: number) => new Map([...s.deployers.mintRows(from)].map(([c, r]) => [c, r.map(([mint]) => mint)]));
    // In memory (no save line): the old mint is gone, the newer one counts.
    expect(rows(Number.MIN_SAFE_INTEGER).get(OLD)).toEqual(['MintNew1']);
    expect(rows(Number.MIN_SAFE_INTEGER).get(OLD)).toEqual(rows(line).get(OLD));
    await h.worker.stop();
  });
});
