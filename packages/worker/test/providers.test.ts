// PumpPortal, Parsed Streams, Jupiter, RugCheck and the fault-injection hooks, all on stubbed frames.
import { describe, expect, it } from 'vitest';
import { PUMP_PROGRAM } from '../../core/src/chain/index.ts';
import {
  alchemyRpcUrl, DEFAULT_LIVE_FEED, FakeSocketHub, heliusParsedUrl, heliusRpcUrl, JupiterClient, LiveFeed, ParsedStreamsSource,
  ProviderError, PumpPortalSource, response, RpcHttp, rpcHandler, RugCheckClient, scriptedHttp, TxFetcher, type Frame, type HttpFault,
} from '../src/providers/index.ts';
import {
  HELIUS_FREE, JUPITER_FREE, ManualTimers, P0, P2, P3, RUGCHECK_FREE, Scheduler, ScheduleRefused,
} from '../src/scheduler/index.ts';
import { blockNetwork, KEYS, recordOf, settle, testSecrets, tx } from './helpers.ts';

blockNetwork();

const MINT = 'So11111111111111111111111111111111111111112';
const TAKER = '6jduWNCTQzG91JGBchfGGxd55Vi5FxJCCJEV18RkXzJX';

const base = () => {
  const timers = new ManualTimers(5_000_000);
  const frames: Frame[] = [];
  const feed = new LiveFeed({ ...DEFAULT_LIVE_FEED, onFrame: (f) => frames.push(f) });
  return { timers, frames, feed };
};

describe('PumpPortal', () => {
  it('uses exactly one connection, subscribes to the two free streams, and keeps sightings off-chain', async () => {
    const { timers, frames, feed } = base();
    const hub = new FakeSocketHub();
    const create = tx('pump CreateEvent');
    const migration = tx('migration CreatePoolEvent');
    const rpcCalls: string[] = [];
    const scheduler = new Scheduler(HELIUS_FREE, { timers });
    const rpc = new RpcHttp({ provider: 'helius', url: () => 'https://h.test', http: scriptedHttp(rpcHandler((m, p) => { rpcCalls.push(`${m}:${String(p[0])}`); return migration.base64; })), scheduler, timeoutMs: 1_000 });
    const fetcher = new TxFetcher({ clients: [rpc], feed, timers, retries: 0, retryMs: 1, remember: 10 });
    const pp = new PumpPortalSource({ factory: hub.factory, timers, feed, fetcher });
    pp.start();
    expect(hub.sockets).toHaveLength(1);
    expect(hub.last.url).toBe('wss://pumpportal.fun/api/data');
    hub.last.open();
    expect(hub.last.requests()).toEqual([{ method: 'subscribeNewToken' }, { method: 'subscribeMigration' }]);
    hub.last.push({ message: 'Successfully subscribed to token creation events.' });
    hub.last.push({ signature: create.signature, mint: MINT, txType: 'create', name: 'X', symbol: 'X', uri: 'ipfs://x', extraField: 'dropped' });
    hub.last.push({ signature: migration.signature, mint: MINT, txType: 'migrate', pool: 'pump-amm' });
    await settle(30);
    const seen = frames.filter((f) => f.source === 'pumpportal');
    expect(seen.map((f) => f.place.at)).toEqual(['offchain', 'offchain']);
    expect(seen[0]!.body).toMatchObject({ type: 'seen', slot: null, via: 'pumpportal:create', detail: { signature: create.signature, mint: MINT, txType: 'create', name: 'X', symbol: 'X', uri: 'ipfs://x' } });
    expect((seen[0]!.body as { detail: Record<string, unknown> }).detail.extraField).toBeUndefined();
    // Only the migration is fetched and decoded (CompletePumpAmmMigrationEvent is the proof of a migration).
    expect(rpcCalls).toEqual([`getTransaction:${migration.signature}`]);
    expect(frames.filter((f) => f.body.type === 'tx')).toHaveLength(1);
    // A second source cannot open a second connection.
    const other = new PumpPortalSource({ factory: hub.factory, timers, feed });
    expect(() => other.start()).toThrow(/one connection only/);
    expect(hub.sockets).toHaveLength(1);
    pp.stop();
    other.start(); // allowed once the first is stopped
    other.stop();
  });

  it('reconnects one socket at a time, backs off, and waits out the one-hour ban after three failed opens', () => {
    const { timers, feed } = base();
    const hub = new FakeSocketHub();
    const pp = new PumpPortalSource({ factory: hub.factory, timers, feed });
    pp.start();
    hub.last.open();
    hub.last.drop();
    expect(hub.live()).toHaveLength(0);
    timers.advance(4_999);
    expect(hub.sockets).toHaveLength(1);
    timers.advance(1);
    expect(hub.sockets).toHaveLength(2);
    for (const wait of [10_000, 20_000]) {
      hub.last.drop(); // refused before opening
      timers.advance(wait);
      expect(hub.live().length).toBeLessThanOrEqual(1);
    }
    hub.last.drop(); // third failed open in a row
    timers.advance(3_599_999);
    expect(hub.sockets).toHaveLength(4);
    timers.advance(1);
    expect(hub.sockets).toHaveLength(5);
    expect(Math.max(...hub.sockets.map((_, k) => hub.sockets.slice(0, k + 1).filter((s) => s.closed === null).length))).toBe(1);
    pp.stop();
  });
});

describe('Helius Parsed Streams', () => {
  it('subscribes to graduations with raw details, meters 1 credit per event, and decodes only through DEC-1', async () => {
    const { timers, frames, feed } = base();
    const hub = new FakeSocketHub();
    const scheduler = new Scheduler(HELIUS_FREE, { timers });
    const migration = tx('migration CreatePoolEvent');
    const rpc = new RpcHttp({ provider: 'helius', url: () => 'https://h.test', http: scriptedHttp(rpcHandler(() => migration.base64)), scheduler, timeoutMs: 1_000 });
    const fetcher = new TxFetcher({ clients: [rpc], feed, timers, retries: 0, retryMs: 1, remember: 10 });
    const ps = new ParsedStreamsSource({ url: () => heliusParsedUrl(testSecrets), factory: hub.factory, timers, feed, scheduler, fetcher, socket: { initialMs: 1_000, maxMs: 8_000, idleMs: 600_000 } });
    ps.start();
    expect(hub.last.url).toBe(`wss://beta.helius-rpc.com/?api-key=${KEYS.HELIUS_API_KEY}`);
    hub.last.open();
    const req = hub.last.requests()[0]!;
    expect(req).toMatchObject({ method: 'parsedTransactionSubscribe', params: [{ programs: [PUMP_PROGRAM], instructionNames: ['migrate'], includeFailed: false }, { commitment: 'confirmed', details: 'raw' }] });
    hub.last.push({ jsonrpc: '2.0', id: req.id, result: 23 });
    const before = scheduler.status().creditsUsed;
    hub.last.push({ jsonrpc: '2.0', method: 'parsedTransactionNotification', params: { subscription: 23, result: { context: { slot: 452941614 }, value: { transaction: { signature: migration.signature, slot: 452941614, status: 'ok', error: null }, instructions: [{ instructionIndex: 3, programId: PUMP_PROGRAM, data: 'x' }] } } } });
    await settle(30);
    expect(scheduler.status().creditsUsed - before).toBeGreaterThanOrEqual(2); // 1 per event + bytes, + 1 getTransaction
    const seen = frames.find((f) => f.source === 'helius-parsed')!;
    expect(seen.place.at).toBe('offchain');
    expect(seen.body).toMatchObject({ type: 'seen', signature: migration.signature, slot: null, detail: { slot: 452941614n } });
    const decoded = frames.find((f) => f.body.type === 'tx')!;
    expect(decoded.body).toMatchObject({ type: 'tx', record: { signature: migration.signature } });
    ps.stop();
  });
});

describe('Jupiter', () => {
  const jup = (handler: Parameters<typeof scriptedHttp>[0], fault?: (r: Parameters<Parameters<typeof scriptedHttp>[0]>[0]) => HttpFault | null) => {
    const { timers, frames, feed } = base();
    const scheduler = new Scheduler(JUPITER_FREE, { timers });
    const http = scriptedHttp(handler, fault ? { fault } : {});
    return { timers, frames, scheduler, http, client: new JupiterClient({ http, secrets: testSecrets, scheduler, feed, timers, timeoutMs: 2_000 }) };
  };

  it('sends the key in x-api-key, sets our own slippage, and records the quote as a fact', async () => {
    const { frames, http, client } = jup(() => response(200, { outAmount: '123' }, { 'x-ratelimit-remaining': '59' }));
    const q = { inputMint: MINT, outputMint: TAKER, amount: '1000', slippageBps: 250, taker: TAKER };
    await client.order(q, P0);
    await client.build(q, P2);
    expect(http.calls.map((c) => [c.url.split('?')[0], c.headers])).toEqual([
      ['https://api.jup.ag/swap/v2/order', { 'x-api-key': KEYS.JUPITER_API_KEY }],
      ['https://api.jup.ag/swap/v2/build', { 'x-api-key': KEYS.JUPITER_API_KEY }],
    ]);
    expect(new URL(http.calls[0]!.url).searchParams.get('slippageBps')).toBe('250');
    expect(http.calls.every((c) => !c.url.includes(KEYS.JUPITER_API_KEY))).toBe(true);
    expect(frames.map((f) => f.body.type === 'offchain' && f.body.key)).toEqual([`jupiter:order:${MINT}:${TAKER}`, `jupiter:build:${MINT}:${TAKER}`]);
    await expect(client.order({ ...q, slippageBps: Number.NaN }, P0)).rejects.toThrow(/slippageBps/);
    await expect(client.order({ ...q, extra: { slippageBps: '9999' } }, P0)).rejects.toThrow(/cannot be overridden/);
  });

  it('reads x-ratelimit-remaining on every response and backs off a 429', async () => {
    let remaining = '3';
    const { scheduler, client } = jup(() => response(200, [], { 'x-ratelimit-remaining': remaining }));
    await client.tokensRecent(P3);
    expect(scheduler.check(P0)).toMatchObject({ ok: true });
    remaining = '0';
    await client.tokensSearch([MINT], P2);
    expect(scheduler.check(P0)).toMatchObject({ ok: false, reason: 'window' });
    const r429 = jup(() => response(429, 'slow down'));
    await expect(r429.client.tokensRecent(P3)).rejects.toMatchObject({ kind: 'rate_limited', status: 429 });
    expect(r429.scheduler.check(P0)).toMatchObject({ ok: false });
  });

  it('keeps Tokens calls to 6 a minute', async () => {
    const { client, http, timers } = jup(() => response(200, [{ id: MINT, name: 'Wrapped SOL' }]));
    const all = Promise.allSettled(Array.from({ length: 8 }, () => client.tokensRecent(P3)));
    await settle();
    expect(http.calls).toHaveLength(6);
    timers.advance(2_000); // the two over the cap wait past P3's 2 s and are refused, not sent
    const results = await all;
    expect(http.calls).toHaveLength(6);
    expect(results.map((r) => r.status === 'fulfilled' ? 'ok' : (r.reason as ScheduleRefused).reason)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'expired', 'expired']);
  });

  it('an error body is shortened and scrubbed of the key', async () => {
    const { client } = jup(() => response(400, `NO_ROUTES_FOUND for ${KEYS.JUPITER_API_KEY} ${'x'.repeat(500)}`));
    const e = (await client.build({ inputMint: MINT, outputMint: TAKER, amount: '1', slippageBps: 300, taker: TAKER }, P0).catch((x: unknown) => x)) as ProviderError;
    expect(e.message).toContain('NO_ROUTES_FOUND');
    expect(e.message).not.toContain(KEYS.JUPITER_API_KEY);
    expect(e.message.length).toBeLessThan(300);
  });
});

describe('RugCheck', () => {
  it('reads the summary keyless at one request per 4.5 s and records it as a fact', async () => {
    const { timers, frames, feed } = base();
    const scheduler = new Scheduler(RUGCHECK_FREE, { timers });
    const http = scriptedHttp(() => response(200, { score_normalised: 1, risks: [] }));
    const rc = new RugCheckClient({ http, scheduler, feed, timers, timeoutMs: 2_000 });
    await rc.summary(MINT, P2);
    const second = rc.summary(MINT, P2);
    await settle();
    expect(http.calls.map((c) => [c.url, c.headers])).toEqual([[`https://api.rugcheck.xyz/v1/tokens/${MINT}/report/summary`, undefined]]);
    timers.advance(4_500);
    await second;
    expect(http.calls).toHaveLength(2);
    expect(frames.map((f) => f.body.type === 'offchain' && f.body.key)).toEqual([`rugcheck:${MINT}`, `rugcheck:${MINT}`]);
  });
});

describe('fault injection hooks', () => {
  const rpcWith = (fault: (method: string) => HttpFault | null, results: (m: string) => unknown, provider: 'helius' | 'alchemy' = 'helius') => {
    const timers = new ManualTimers(0);
    const scheduler = new Scheduler(HELIUS_FREE, { timers });
    const http = scriptedHttp(rpcHandler((m) => results(m)), { fault: (r) => fault((JSON.parse(r.body!) as { method: string }).method) });
    return { scheduler, rpc: new RpcHttp({ provider, url: () => heliusRpcUrl(testSecrets), http, scheduler, timeoutMs: 1_500 }) };
  };

  it('a timeout, a network error and a 500 become ProviderErrors that name no URL or key', async () => {
    for (const [fault, kind] of [[{ kind: 'timeout' }, 'timeout'], [{ kind: 'network' }, 'network'], [{ kind: 'status', status: 500 }, 'http']] as const) {
      const { rpc } = rpcWith(() => fault, () => null);
      const e = (await rpc.getTransaction(tx('pump TradeEvent').signature, P0).catch((x: unknown) => x)) as ProviderError;
      expect(e).toBeInstanceOf(ProviderError);
      expect(e.kind).toBe(kind);
      expect(e.message).not.toMatch(/https?:|api-key|helius-test-key/);
    }
  });

  it('a 429 marks the provider window full', async () => {
    const { rpc, scheduler } = rpcWith(() => ({ kind: 'status', status: 429 }), () => null);
    await expect(rpc.getAccountInfo(MINT, P2)).rejects.toMatchObject({ kind: 'rate_limited' });
    expect(scheduler.check(P0)).toMatchObject({ ok: false, reason: 'window' });
  });

  it('the fetcher falls through to the second provider when the first fails, and retries a not-yet-confirmed answer', async () => {
    const t = tx('PumpSwap BuyEvent');
    const timers = new ManualTimers(0);
    const frames: Frame[] = [];
    const feed = new LiveFeed({ ...DEFAULT_LIVE_FEED, onFrame: (f) => frames.push(f) });
    const down = new RpcHttp({ provider: 'helius', url: () => 'https://h.test', http: scriptedHttp(() => response(200, ''), { fault: () => ({ kind: 'timeout' }) }), scheduler: new Scheduler(HELIUS_FREE, { timers }), timeoutMs: 1 });
    let n = 0;
    const slow = new RpcHttp({ provider: 'alchemy', url: () => alchemyRpcUrl(testSecrets), http: scriptedHttp(rpcHandler(() => (n++ === 0 ? null : t.base64))), scheduler: new Scheduler(HELIUS_FREE, { timers }), timeoutMs: 1 });
    const fetcher = new TxFetcher({ clients: [down, slow], feed, timers, retries: 2, retryMs: 400, remember: 10 });
    const p = fetcher.fetch(t.signature, P0);
    const again = fetcher.fetch(t.signature, P0); // the same signature is fetched once
    await settle();
    timers.advance(400);
    await settle(40);
    expect(await p).toMatchObject({ slot: recordOf(t).slot, at: 400, again: false });
    expect(await again).toBe(await p);
    expect(frames.map((f) => [f.source, f.body.type])).toEqual([['alchemy', 'tx']]);
    expect((frames[0]!.body as { record: unknown }).record).toEqual(recordOf(t));
    // Already ingested: found again (never null, which reads as not found), and not read or ingested twice.
    expect(await fetcher.fetch(t.signature, P0)).toEqual({ ...(await p)!, again: true });
    expect(frames).toHaveLength(1);
  });

  it('a halted scheduler refuses non-exit reads with ScheduleRefused', async () => {
    const timers = new ManualTimers(0);
    const scheduler = new Scheduler(HELIUS_FREE, { timers, creditsUsed: 700_000 });
    const rpc = new RpcHttp({ provider: 'helius', url: () => 'https://h.test', http: scriptedHttp(rpcHandler(() => ({ context: { slot: 1 }, value: null }))), scheduler, timeoutMs: 1 });
    await expect(rpc.getAccountInfo(MINT, P2)).rejects.toBeInstanceOf(ScheduleRefused);
    await expect(rpc.getAccountInfo(MINT, P0)).resolves.toEqual({ slot: 1n, value: null });
  });

  it('endpoints carry the key only in the URL built at use time', () => {
    expect(heliusRpcUrl(testSecrets)).toBe(`https://mainnet.helius-rpc.com/?api-key=${KEYS.HELIUS_API_KEY}`);
    expect(alchemyRpcUrl(testSecrets)).toBe(`https://solana-mainnet.g.alchemy.com/v2/${KEYS.ALCHEMY_API_KEY}`);
  });
});
