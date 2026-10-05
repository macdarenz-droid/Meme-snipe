// A signature the fetcher already put on the feed is still found (review of the RUG-1 wiring and BT-1c's probe): a
// repeat ask used to resolve to null, read as "not found", so a cut trade log whose transaction the stream had already
// fetched became a false coverage:rugs:gap (H14 then not covered, the candidate wrongly refused), and the delay probe
// recorded found: false for a create the creates watch had already fetched.
import { describe, expect, it } from 'vitest';
import { DEFAULT_LIVE_FEED, LiveFeed, RpcHttp, rpcHandler, scriptedHttp, TxFetcher, type Frame } from '../src/providers/index.ts';
import { HELIUS_FREE, ManualTimers, P0, Scheduler } from '../src/scheduler/index.ts';
import { CreditBook, LiveProviders } from '../src/run/sources.ts';
import { DelayProbe } from '../src/run/delay-probe.ts';
import { blockNetwork, recordOf, settle, testSecrets, tx } from './helpers.ts';
import { tempState } from './worker-harness.ts';

blockNetwork();

describe('a repeat ask for a fetched signature', () => {
  it('resolves to the first arrival (slot, time, monotonic time), marked again, with no second read or frame', async () => {
    const t = tx('PumpSwap BuyEvent');
    const timers = new ManualTimers(5_000);
    const frames: Frame[] = [];
    const feed = new LiveFeed({ ...DEFAULT_LIVE_FEED, onFrame: (f) => frames.push(f) });
    let reads = 0;
    const rpc = new RpcHttp({ provider: 'helius', url: () => 'https://h.test', http: scriptedHttp(rpcHandler(() => (reads++, t.base64))), scheduler: new Scheduler(HELIUS_FREE, { timers }), timeoutMs: 1 });
    let mono = 100;
    const fetcher = new TxFetcher({ clients: [rpc], feed, timers, retries: 0, retryMs: 1, remember: 10, mono: () => (mono += 7) });
    const first = await fetcher.fetch(t.signature, P0);
    timers.advance(30_000);
    const again = await fetcher.fetch(t.signature, P0);
    expect(first).toEqual({ slot: recordOf(t).slot, at: 5_000, mono: 107, again: false });
    expect(again).toEqual({ slot: recordOf(t).slot, at: 5_000, mono: 107, again: true });
    expect(reads).toBe(1);
    expect(frames.filter((f) => f.body.type === 'tx')).toHaveLength(1);
  });

  it('fresh reads it again and puts it on the feed again (WORKER-GROW: a create the store let go)', async () => {
    const t = tx('PumpSwap BuyEvent');
    const timers = new ManualTimers(5_000);
    const frames: Frame[] = [];
    const feed = new LiveFeed({ ...DEFAULT_LIVE_FEED, onFrame: (f) => frames.push(f) });
    let reads = 0;
    const rpc = new RpcHttp({ provider: 'helius', url: () => 'https://h.test', http: scriptedHttp(rpcHandler(() => (reads++, t.base64))), scheduler: new Scheduler(HELIUS_FREE, { timers }), timeoutMs: 1 });
    const fetcher = new TxFetcher({ clients: [rpc], feed, timers, retries: 0, retryMs: 1, remember: 10, mono: () => 0 });
    await fetcher.fetch(t.signature, P0);
    timers.advance(30_000);
    expect(await fetcher.fetch(t.signature, P0, false, true)).toMatchObject({ at: 35_000, again: false });
    expect(reads).toBe(2);
    // Handed to the feed again. The feed drops a copy only as a duplicate within keepSlots (about 10 minutes); the
    // worker reads a create again only when it is hours old.
    expect(frames.filter((f) => f.body.type === 'tx')).toHaveLength(2);
    // The new arrival is the one remembered: a plain repeat resolves to it.
    expect(await fetcher.fetch(t.signature, P0)).toMatchObject({ at: 35_000, again: true });
    expect(reads).toBe(2);
  });

  it('a signature forgotten past `remember` is read again', async () => {
    const a = tx('PumpSwap BuyEvent');
    const b = tx('PumpSwap SellEvent');
    const timers = new ManualTimers(0);
    const feed = new LiveFeed(DEFAULT_LIVE_FEED);
    const asked: string[] = [];
    const rpc = new RpcHttp({
      provider: 'helius', url: () => 'https://h.test', scheduler: new Scheduler(HELIUS_FREE, { timers }), timeoutMs: 1,
      http: scriptedHttp(rpcHandler((_m, params) => {
        const sig = (params as unknown[])[0] as string;
        asked.push(sig);
        return sig === a.signature ? a.base64 : b.base64;
      })),
    });
    const fetcher = new TxFetcher({ clients: [rpc], feed, timers, retries: 0, retryMs: 1, remember: 1 });
    await fetcher.fetch(a.signature, P0);
    await fetcher.fetch(b.signature, P0);
    expect(await fetcher.fetch(a.signature, P0)).toMatchObject({ again: false });
    expect(asked).toEqual([a.signature, b.signature, a.signature]);
  });
});

describe('LiveProviders after the stream fetched a transaction', () => {
  const setup = (t: ReturnType<typeof tx>) => {
    const timers = new ManualTimers(1_000_000);
    let reads = 0;
    const http = scriptedHttp(rpcHandler((m) => (m === 'getTransaction' ? (reads++, t.base64) : null)));
    const providers = new LiveProviders({ tradeStreams: false, secrets: testSecrets, http, factory: () => { throw new Error('no sockets here'); }, credits: new CreditBook(tempState(), timers) });
    providers.feeds({ feed: new LiveFeed(DEFAULT_LIVE_FEED), timers, pools: () => new Map() });
    return { timers, providers, reads: () => reads };
  };

  it('fetchTx (a cut trade log, a shortlisted create) is true again, so no false rugs gap', async () => {
    const t = tx('PumpSwap SellEvent');
    const s = setup(t);
    expect(await s.providers.fetchTx(t.signature)).toBe(true);
    expect(await s.providers.fetchTx(t.signature)).toBe(true);
    expect(s.reads()).toBe(1);
  });

  it('the delay probe records found with the first confirmed arrival, not found: false', async () => {
    const t = tx('pump CreateEvent');
    const s = setup(t);
    const via = 'logs:TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM';
    const rows: Readonly<Record<string, unknown>>[] = [];
    const probe = new DelayProbe({ timers: s.timers, via, everyMs: 60_000, record: (row) => void rows.push(row), confirmed: (sig) => s.providers.confirmed(sig) });
    probe.frame({ seq: 0, receivedAt: 1_000_000, source: 'helius', backfilled: false, place: { at: 'chain', slot: recordOf(t).slot }, duplicate: false, body: { type: 'logs', signature: t.signature, slot: recordOf(t).slot, err: null, via, logs: [] } });
    s.timers.advance(2_000);
    expect(await s.providers.fetchTx(t.signature)).toBe(true); // the creates watch fetched it first
    probe.start();
    s.timers.advance(60_000);
    await settle();
    probe.stop();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ found: true, error: null, confirmed_at_ms: 1_002_000, confirmed_slot: recordOf(t).slot });
    expect(rows[0]!['delay_ms']).not.toBeNull();
    expect(s.reads()).toBe(1);
  });
});
