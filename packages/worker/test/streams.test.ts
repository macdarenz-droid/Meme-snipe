// RPC streams on recorded frames: subscribe, notifications to frames, reconnect with backfill, halt, two providers.
import { describe, expect, it } from 'vitest';
import { PUMP_AMM_GLOBAL_CONFIG, PUMP_GLOBAL } from '../../core/src/chain/index.ts';
import type { MarketEvent } from '../../core/src/engine/index.ts';
import {
  DEFAULT_LIVE_FEED, FakeSocketHub, LiveFeed, RpcHttp, RpcStream, rpcHandler, scriptedHttp, TxFetcher, type Frame,
} from '../src/providers/index.ts';
import { HELIUS_FREE, ManualTimers, P0, P1, P2, P3, Scheduler } from '../src/scheduler/index.ts';
import { blockNetwork, settle, tx } from './helpers.ts';

blockNetwork();

const SOCKET = { initialMs: 1_000, maxMs: 8_000, idleMs: 30_000 };
const MINT_AUTH = 'TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM';

const setup = (results: (method: string, params: readonly unknown[]) => unknown, opts: { used?: number } = {}) => {
  const timers = new ManualTimers(1_000_000);
  const hub = new FakeSocketHub();
  const frames: Frame[] = [];
  const feed = new LiveFeed({ ...DEFAULT_LIVE_FEED, horizonSlots: 0, onFrame: (f) => frames.push(f) });
  const scheduler = new Scheduler(HELIUS_FREE, { timers, creditsUsed: opts.used ?? 0 });
  const http = scriptedHttp(rpcHandler(results));
  const rpc = new RpcHttp({ provider: 'helius', url: () => 'https://rpc.test/?api-key=k', http, scheduler, timeoutMs: 1_000 });
  const fetcher = new TxFetcher({ clients: [rpc], feed, timers, retries: 0, retryMs: 500, remember: 1_000 });
  const stream = new RpcStream({
    provider: 'helius', url: () => 'wss://ws.test/?api-key=k', factory: hub.factory, timers, feed, scheduler,
    creditsPerByte: 0.00002, creditsPerConnection: 1, http: rpc, fetcher, socket: SOCKET, backfillLimit: 100,
  });
  return { timers, hub, frames, feed, scheduler, http, stream };
};

/** Answers every subscribe request on the socket with a server id, in order. */
const ack = (hub: FakeSocketHub, from = 0): number[] => {
  const ids: number[] = [];
  hub.last.requests().slice(from).forEach((r, k) => {
    if (!r.method.endsWith('Subscribe') || r.id === undefined) return;
    const server = 100 + k + from;
    ids.push(server);
    hub.last.push({ jsonrpc: '2.0', id: r.id, result: server });
  });
  return ids;
};

const logs = (sub: number, slot: number, signature: string) => ({ jsonrpc: '2.0', method: 'logsNotification', params: { subscription: sub, result: { context: { slot }, value: { signature, err: null, logs: ['Program log: ignored'] } } } });
const slotNote = (sub: number, slot: number) => ({ jsonrpc: '2.0', method: 'slotNotification', params: { subscription: sub, result: { slot, parent: slot - 1, root: slot - 32 } } });

describe('RPC stream', () => {
  it('subscribes at processed and turns notifications into frames; log lines are never decoded', async () => {
    const t = tx('pump TradeEvent');
    const { hub, frames, stream } = setup(() => undefined);
    stream.watchSlots(P1);
    stream.watchLogs(MINT_AUTH, { priority: P3 });
    stream.watchAccount(PUMP_AMM_GLOBAL_CONFIG, P2);
    stream.start();
    hub.last.open();
    expect(hub.last.requests().map((r) => [r.method, r.params])).toEqual([
      ['slotSubscribe', []],
      ['logsSubscribe', [{ mentions: [MINT_AUTH] }, { commitment: 'processed' }]],
      ['accountSubscribe', [PUMP_AMM_GLOBAL_CONFIG, { encoding: 'base64', commitment: 'processed' }]],
    ]);
    const [slotSub, logSub, acctSub] = ack(hub);
    hub.last.push(slotNote(slotSub!, 500));
    hub.last.push(logs(logSub!, 500, t.signature));
    hub.last.push({ jsonrpc: '2.0', method: 'accountNotification', params: { subscription: acctSub, result: { context: { slot: 500 }, value: { owner: PUMP_GLOBAL, lamports: 5, data: ['AQID', 'base64'], executable: false } } } });
    await settle();
    expect(frames.map((f) => f.body.type)).toEqual(['slot', 'seen', 'account']);
    expect(frames[1]!.body).toEqual({ type: 'seen', signature: t.signature, slot: 500n, err: null, via: `logs:${MINT_AUTH}`, detail: null });
    expect(frames[2]!.body).toMatchObject({ type: 'account', slot: 500n, lamports: 5n, data: Uint8Array.of(1, 2, 3) });
  });

  it('reconnect with backfill: a drop holds the feed, the reopen resubscribes, missed signatures and states are read and marked', async () => {
    const t1 = tx('pump TradeEvent', 0);
    const t2 = tx('pump TradeEvent', 1);
    const t3 = tx('pump TradeEvent', 2);
    const calls: string[] = [];
    const { hub, frames, feed, stream, timers } = setup((method, params) => {
      calls.push(method);
      if (method === 'getSignaturesForAddress') {
        expect(params).toEqual([MINT_AUTH, { commitment: 'confirmed', limit: 100, until: t1.signature }]);
        return [{ signature: t3.signature, slot: 503, err: null }, { signature: t2.signature, slot: 502, err: null }];
      }
      if (method === 'getAccountInfo') return { context: { slot: 504 }, value: { owner: PUMP_GLOBAL, lamports: 9, data: ['CQ==', 'base64'] } };
      if (method === 'getTransaction') return null;
      return undefined;
    });
    stream.watchSlots(P1);
    stream.watchLogs(MINT_AUTH, { priority: P1, fetch: P1 });
    stream.watchAccount(PUMP_AMM_GLOBAL_CONFIG, P1);
    stream.start();
    hub.last.open();
    const [slotSub, logSub] = ack(hub);
    hub.last.push(slotNote(slotSub!, 501));
    hub.last.push(logs(logSub!, 501, t1.signature));
    await settle();
    feed.advance(timers.now());
    expect(feed.releasedThrough).toBe(501n);

    hub.last.drop();
    expect(feed.status().gaps).toEqual(['helius-ws']);
    // Another provider keeps the tip moving; the hold keeps slots >= 502 back.
    feed.ingest('alchemy', { type: 'slot', slot: 505n, parent: null, root: null }, { receivedAt: timers.now() });
    feed.advance(timers.now());
    expect(feed.releasedThrough).toBe(501n);

    timers.advance(1_000); // backoff
    expect(hub.sockets).toHaveLength(2);
    hub.last.open();
    expect(hub.last.requests().map((r) => r.method)).toEqual(['slotSubscribe', 'logsSubscribe', 'accountSubscribe']);
    await settle(50);
    expect(calls.filter((c) => c !== 'getTransaction')).toEqual(['getSignaturesForAddress', 'getAccountInfo']);
    const back = frames.filter((f) => f.backfilled);
    expect(back.map((f) => (f.body.type === 'seen' ? f.body.signature : f.body.type))).toEqual([t2.signature, t3.signature, 'account']);
    expect(feed.status().gaps).toEqual([]);
    feed.advance(timers.now());
    const released: MarketEvent[] = [];
    for (let e = feed.next(); e; e = feed.next()) if (e.kind === 'market') released.push(e);
    const seen = released.filter((e) => e.id.startsWith('seen:') && e.moment.slot > 501n);
    expect(seen.map((e) => [e.moment.slot, (e.value as { backfilled: boolean }).backfilled])).toEqual([[502n, true], [503n, true]]);
    const status = released.filter((e) => e.key === 'feed:status:helius').map((e) => (e.value as { value: { state: string } }).value.state);
    expect(status).toEqual(['down', 'up']);
  });

  it('a stream silent for idleMs is stale: it reconnects and backfills', async () => {
    const { hub, stream, timers } = setup((m) => (m === 'getSignaturesForAddress' ? [] : undefined));
    stream.watchSlots(P1);
    stream.watchLogs(MINT_AUTH, { priority: P1 });
    stream.start();
    hub.last.open();
    const [slotSub] = ack(hub);
    hub.last.push(slotNote(slotSub!, 10));
    timers.advance(30_000);
    expect(hub.sockets[0]!.closed).not.toBeNull();
    timers.advance(1_000);
    hub.last.open();
    await settle();
    expect(stream.backfills).toBe(1);
  });

  it('meters stream bytes and connections, and at 70% drops P2–P3 watches but keeps the open position (P0–P1)', async () => {
    const { hub, scheduler, stream } = setup(() => undefined, { used: 699_990 });
    const pos = stream.watchAccount(PUMP_AMM_GLOBAL_CONFIG, P1);
    stream.watchLogs(MINT_AUTH, { priority: P3 });
    stream.watchSlots(P2);
    stream.start();
    hub.last.open();
    ack(hub);
    expect(scheduler.status().creditsUsed).toBeCloseTo(699_991, 0); // one connection
    hub.last.push('x'.repeat(500_000)); // 0.5 MB = 10 credits: crosses 70%
    expect(scheduler.halted).toBe(true);
    const unsubs = hub.last.requests().filter((r) => r.method.endsWith('Unsubscribe')).map((r) => r.method);
    expect(unsubs.sort()).toEqual(['logsUnsubscribe', 'slotUnsubscribe']);
    expect(stream.socket.size).toBe(1);
    expect(() => stream.watchLogs(MINT_AUTH, { priority: P2 })).toThrow(/halted/);
    expect(stream.watchAccount(PUMP_GLOBAL, P0)).toBeGreaterThan(pos);
  });

  it('two providers carry the position: the first copy wins and the slower provider adds nothing', async () => {
    const t = tx('pump TradeEvent');
    const a = setup(() => undefined);
    const alchemy = new RpcStream({
      provider: 'alchemy', url: () => 'wss://alchemy.test/v2/k', factory: a.hub.factory, timers: a.timers, feed: a.feed, scheduler: a.scheduler,
      creditsPerByte: 0, creditsPerConnection: 0, http: new RpcHttp({ provider: 'alchemy', url: () => 'https://a.test', http: a.http, scheduler: a.scheduler, timeoutMs: 1 }), socket: SOCKET, backfillLimit: 10,
    });
    for (const s of [a.stream, alchemy]) {
      s.watchLogs(MINT_AUTH, { priority: P1 });
      s.start();
      a.hub.last.open();
      const [sub] = ack(a.hub);
      a.hub.last.push(logs(sub!, 77, t.signature));
    }
    expect(a.frames.map((f) => [f.source, f.duplicate])).toEqual([['helius', false], ['alchemy', true]]);
  });
});
