// The TxFetcher's remembered signatures (review of #184 and #179): a signature is remembered only once its transaction
// is on the feed, and the oldest is forgotten in O(1) however many were forgotten before.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TransactionRecord } from '../../core/src/chain/index.ts';
import { DEFAULT_LIVE_FEED, LiveFeed, TxFetcher, type RpcHttp } from '../src/providers/index.ts';
import { ManualTimers, P0 } from '../src/scheduler/index.ts';
import { recordOf, tx } from './helpers.ts';

const record = recordOf(tx('PumpSwap BuyEvent'));
/** A client that answers every signature at once with the same transaction, renamed. */
const instant = (asked: string[]): RpcHttp => ({ provider: 'helius', getTransaction: async (sig: string) => (asked.push(sig), { ...record, signature: sig } as TransactionRecord) }) as unknown as RpcHttp;

describe('remembered only once on the feed (review of #184)', () => {
  it('an ingest that throws leaves the signature unremembered: the next ask reads it again and puts it on the feed', async () => {
    const timers = new ManualTimers(0);
    let fail = true;
    const frames: string[] = [];
    const feed = new LiveFeed({ ...DEFAULT_LIVE_FEED, onFrame: (f) => void frames.push(f.body.type) });
    const realIngest = feed.ingest.bind(feed);
    feed.ingest = ((...a: Parameters<LiveFeed['ingest']>) => {
      if (fail) throw new Error('feed closed');
      return realIngest(...a);
    }) as LiveFeed['ingest'];
    const asked: string[] = [];
    const fetcher = new TxFetcher({ clients: [instant(asked)], feed, timers, retries: 0, retryMs: 1, remember: 10 });
    await expect(fetcher.fetch('S1', P0)).rejects.toThrow('feed closed');
    fail = false;
    expect(await fetcher.fetch('S1', P0)).toMatchObject({ again: false });
    expect(asked).toEqual(['S1', 'S1']);
    expect(frames).toEqual(['tx']);
    expect(await fetcher.fetch('S1', P0)).toMatchObject({ again: true });
  });
});

describe('forgetting the oldest signature', () => {
  it('keeps the newest `remember`; the oldest is read again', async () => {
    const asked: string[] = [];
    const fetcher = new TxFetcher({ clients: [instant(asked)], feed: new LiveFeed(DEFAULT_LIVE_FEED), timers: new ManualTimers(0), retries: 0, retryMs: 1, remember: 2 });
    for (const s of ['A', 'B', 'C']) await fetcher.fetch(s, P0);
    expect(await fetcher.fetch('C', P0)).toMatchObject({ again: true });
    expect(await fetcher.fetch('B', P0)).toMatchObject({ again: true });
    expect(await fetcher.fetch('A', P0)).toMatchObject({ again: false });
    expect(asked).toEqual(['A', 'B', 'C', 'A']);
  });

  it('costs O(1) however many were forgotten: 600,000 fetches remembering 50,000 in under 8 s (the old trim: about 20 s)', async () => {
    // Only the remembered set is timed: DEC-1's decode check (about 90 µs a transaction, WORKER-CRASH) is stubbed, as
    // the feed is, so its cost cannot hide or stand in for the trim's.
    const fetcher = new TxFetcher({ clients: [instant([])], feed: { ingest: () => undefined } as unknown as LiveFeed, timers: new ManualTimers(0), retries: 0, retryMs: 1, remember: 50_000, decodable: () => true });
    const t = performance.now();
    for (let i = 0; i < 600_000; i++) await fetcher.fetch(`S${i}`, P0);
    expect(performance.now() - t).toBeLessThan(8_000);
    expect(await fetcher.fetch('S599999', P0)).toMatchObject({ again: true });
  }, 30_000);

  it('the fetcher trims no map with keys().next() (guard)', () => {
    expect(readFileSync(join(import.meta.dirname, '..', 'src', 'providers', 'tx-fetcher.ts'), 'utf8')).not.toMatch(/keys\(\)\.next\(\)/);
  });
});
