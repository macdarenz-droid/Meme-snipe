// RPC streams on recorded frames: subscribe, notifications to frames, reconnect with backfill, halt, two providers.
import { describe, expect, it } from 'vitest';
import { PUMP_AMM_GLOBAL_CONFIG, PUMP_GLOBAL, transactionEvents } from '../../core/src/chain/index.ts';
import { createReplay, Engine, type MarketEvent } from '../../core/src/engine/index.ts';
import { CONFIG } from '../../core/test/fixtures.ts';
import {
  DEFAULT_LIVE_FEED, FakeSocketHub, frameEvents, LiveFeed, RpcHttp, RpcStream, rpcHandler, scriptedHttp, TxFetcher, type Frame,
} from '../src/providers/index.ts';
import { HELIUS_FREE, ManualTimers, P0, P1, P2, P3, Scheduler } from '../src/scheduler/index.ts';
import { blockNetwork, recordOf, settle, tx } from './helpers.ts';
import { PoolWatch } from '../src/run/pool-watch.ts';

blockNetwork();

const SOCKET = { initialMs: 1_000, maxMs: 8_000, idleMs: 30_000 };
const MINT_AUTH = 'TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM';

const setup = (results: (method: string, params: readonly unknown[]) => unknown, opts: { used?: number; delayMs?: () => number; limit?: number } = {}) => {
  const timers = new ManualTimers(1_000_000);
  const hub = new FakeSocketHub();
  const frames: Frame[] = [];
  const feed = new LiveFeed({ ...DEFAULT_LIVE_FEED, horizonSlots: 0, onFrame: (f) => frames.push(f) });
  const scheduler = new Scheduler(HELIUS_FREE, { timers, creditsUsed: opts.used ?? 0 });
  const http = scriptedHttp(rpcHandler(results), opts.delayMs ? { timers, delayMs: opts.delayMs } : {});
  const rpc = new RpcHttp({ provider: 'helius', url: () => 'https://rpc.test/?api-key=k', http, scheduler, timeoutMs: 1_000 });
  const fetcher = new TxFetcher({ clients: [rpc], feed, timers, retries: 0, retryMs: 500, remember: 1_000 });
  const stream = new RpcStream({
    provider: 'helius', url: () => 'wss://ws.test/?api-key=k', factory: hub.factory, timers, feed, scheduler,
    creditsPerByte: 0.00002, creditsPerConnection: 1, http: rpc, fetcher, socket: SOCKET, backfillLimit: opts.limit ?? 100,
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
    // The first open reports the stream up at once.
    expect(frames.map((f) => f.body.type)).toEqual(['offchain', 'slot', 'seen', 'account']);
    expect(frames[0]!.body).toEqual({ type: 'offchain', key: 'feed:status:helius', value: { state: 'up', fromSlot: null, first: true } });
    expect(frames[2]!.body).toEqual({ type: 'seen', signature: t.signature, slot: 500n, err: null, via: `logs:${MINT_AUTH}`, detail: null });
    expect(frames[3]!.body).toMatchObject({ type: 'account', slot: 500n, lamports: 5n, data: Uint8Array.of(1, 2, 3) });
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
    expect(status).toEqual(['up', 'down', 'up']);
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

  it('creates stream: creator, mint and slot from the log lines with no RPC call, even when PumpPortal saw it first', async () => {
    const c = tx('pump CreateEvent');
    const slot = Number(c.slot);
    const calls: string[] = [];
    const { hub, frames, feed, stream, timers } = setup((m) => { calls.push(m); return undefined; });
    stream.watchLogs(MINT_AUTH, { priority: P3, decodeLogs: true });
    stream.start();
    hub.last.open();
    const [sub] = ack(hub);
    feed.ingest('pumpportal', { type: 'seen', signature: c.signature, slot: null, err: null, via: 'pumpportal:create', detail: {} }, { receivedAt: timers.now() });
    hub.last.push({ jsonrpc: '2.0', method: 'logsNotification', params: { subscription: sub, result: { context: { slot }, value: { signature: c.signature, err: null, logs: c.base64.meta!.logMessages } } } });
    feed.ingest('helius', { type: 'slot', slot: BigInt(slot) + 1n, parent: null, root: null }, { receivedAt: timers.now() + 1 });
    await settle();
    feed.advance(timers.now() + 10_000);
    const released: MarketEvent[] = [];
    for (let e = feed.next(); e; e = feed.next()) if (e.kind === 'market') released.push(e);
    expect(calls).toEqual([]);
    const create = released.find((e) => e.key.startsWith('logs:pump:CreateEvent:'))!;
    const v = create.value as { event: { name: string; data: { mint: string; creator: string } }; txSlot: bigint; truncated: boolean };
    const fromTx = recordOf(c);
    const decoded = transactionEvents(fromTx).find((e) => e.name === 'CreateEvent')!;
    expect(v.event.data).toEqual(decoded.data); // the log copy carries the same fields as DEC-1's instruction decode
    expect(create.key).toBe(`logs:pump:CreateEvent:${v.event.data.mint}`);
    expect(v.txSlot).toBe(BigInt(slot));
    expect(v.truncated).toBe(false);
    expect(create.moment.slot).toBe(BigInt(slot));
    // The PumpPortal sighting won dedup, and the log frame survived it.
    expect(frames.find((f) => f.body.type === 'seen' && f.source === 'helius')!.duplicate).toBe(true);
    expect(frames.find((f) => f.body.type === 'logs')!.duplicate).toBe(false);
    expect(frameEvents(frames).filter((e) => e.id.startsWith('log:')).map((e) => e.id)).toEqual(released.filter((e) => e.id.startsWith('log:')).map((e) => e.id));
    expect(() => createReplay(frameEvents(frames))).not.toThrow();
  });

  it('cut or malformed log lines are reported as such, never guessed past', () => {
    const feed = new LiveFeed({ ...DEFAULT_LIVE_FEED, horizonSlots: 0 });
    const sig = tx('pump CreateEvent').signature;
    feed.ingest('alchemy', { type: 'logs', signature: sig, slot: 9n, err: null, via: 'logs:x', logs: [`Program ${PUMP_GLOBAL} invoke [1]`, 'Log truncated'] }, { receivedAt: 1 });
    feed.ingest('alchemy', { type: 'logs', signature: tx('pump CreateEvent', 1).signature, slot: 9n, err: null, via: 'logs:x', logs: ['Program a invoke [2]'] }, { receivedAt: 2 });
    feed.ingest('alchemy', { type: 'slot', slot: 9n, parent: null, root: null }, { receivedAt: 3 });
    feed.advance(3);
    const keys: string[] = [];
    for (let e = feed.next(); e; e = feed.next()) if (e.kind === 'market') keys.push(e.key);
    expect(keys).toEqual(['logs:truncated:logs:x', 'logs:undecodable:logs:x', 'chain:slot']);
  });

  it('at the 70% halt, the open position still refills after a reconnect: its backfill runs at P0', async () => {
    const t1 = tx('pump TradeEvent', 0);
    const t2 = tx('pump TradeEvent', 1);
    const calls: string[] = [];
    const { hub, frames, scheduler, stream, timers } = setup((method) => {
      calls.push(method);
      if (method === 'getSignaturesForAddress') return [{ signature: t2.signature, slot: 702, err: null }];
      if (method === 'getAccountInfo') return { context: { slot: 703 }, value: { owner: PUMP_GLOBAL, lamports: 3, data: ['AA==', 'base64'] } };
      return undefined;
    }, { used: 699_000 });
    stream.watchSlots(P0);
    stream.watchLogs(MINT_AUTH, { priority: P1 });
    stream.watchAccount(PUMP_AMM_GLOBAL_CONFIG, P1);
    stream.start();
    hub.last.open();
    const [slotSub, logSub] = ack(hub);
    hub.last.push(slotNote(slotSub!, 701));
    hub.last.push(logs(logSub!, 701, t1.signature));
    scheduler.meter(1_000); // the position is open when the month crosses 70%
    expect(scheduler.halted).toBe(true);
    hub.last.drop();
    timers.advance(1_000);
    hub.last.open();
    await settle(50);
    expect(calls).toEqual(['getSignaturesForAddress', 'getAccountInfo']);
    expect(frames.filter((f) => f.backfilled).map((f) => f.body.type)).toEqual(['seen', 'account']);
    expect(scheduler.status().granted[0]).toBe(2);
  });

  describe('coverage of the creates stream', () => {
    const facts = (feed: LiveFeed, timers: ManualTimers, key: string) => {
      feed.advance(timers.now() + 60_000);
      const out: unknown[] = [];
      for (let e = feed.next(); e; e = feed.next()) if (e.kind === 'market' && e.key === key) out.push((e.value as { value: unknown }).value);
      return out;
    };
    const VIA = `logs:${MINT_AUTH}`;
    /** One provider, a slot watch and a creates watch; slot notices run ahead of log notifications. */
    const run = (sigs: (call: number) => unknown, opts: { decodeLogs?: boolean; limit?: number; delayMs?: () => number; used?: number } = {}) => {
      let calls = 0;
      const t = setup((m) => (m === 'getSignaturesForAddress' ? sigs(calls++) : undefined), { ...(opts.delayMs ? { delayMs: opts.delayMs } : {}), ...(opts.used !== undefined ? { used: opts.used } : {}), ...(opts.limit !== undefined ? { limit: opts.limit } : {}) });
      t.stream.watchSlots(P1);
      t.stream.watchLogs(MINT_AUTH, { priority: P3, coverage: 'creates', ...(opts.decodeLogs === false ? {} : { decodeLogs: true }) });
      t.stream.start();
      t.hub.last.open();
      const [slotSub, logSub] = ack(t.hub);
      t.hub.last.push(slotNote(slotSub!, 600));
      t.hub.last.push(logs(logSub!, 603, tx('pump CreateEvent', 2).signature));
      t.hub.last.push(slotNote(slotSub!, 605)); // ahead of the logs: creates in 603–605 may still be in flight
      const reopen = async () => {
        t.timers.advance(8_000);
        t.hub.last.open();
        return ack(t.hub);
      };
      return { ...t, reopen, drop: () => t.hub.last.drop() };
    };

    it('REC-1: at the budget halt a rejected candidate\'s tail pool (P3) is shed first, with an open gap recorded; an open position\'s pool (P1) stays', async () => {
      const TAIL = MINT_AUTH;
      const HELD = PUMP_AMM_GLOBAL_CONFIG;
      const t = setup(() => [], { used: 699_990 });
      t.stream.watchSlots(P1);
      // What the strategy hands the pool watch: the tail pool (not held, P3) and a held pool (P1).
      const pools = new Map([[TAIL, { mint: 'tail-mint', held: false }], [HELD, { mint: 'held-mint', held: true }]]);
      const watch = new PoolWatch({ stream: t.stream, timers: t.timers, pools: () => pools, everyMs: 2_000 });
      watch.sync();
      t.stream.start();
      t.hub.last.open();
      const [slotSub] = ack(t.hub);
      t.hub.last.push(slotNote(slotSub!, 600));
      await settle();
      expect(facts(t.feed, t.timers, `coverage:trades:${TAIL}:start`)).toHaveLength(1);
      t.hub.last.push('x'.repeat(500_000)); // 10 credits: the month crosses 70%
      expect(t.scheduler.halted).toBe(true);
      expect(facts(t.feed, t.timers, `coverage:trades:${TAIL}:gap`)).toEqual([expect.objectContaining({ toSlot: null, reason: 'halted', via: `logs:${TAIL}` })]);
      expect(facts(t.feed, t.timers, `coverage:trades:${HELD}:gap`)).toEqual([]);
      // The held pool's watch is still live: a swap on it is recorded, while the tail's gap stays open (unknown).
      expect(t.hub.last.requests().filter((r) => r.method === 'logsUnsubscribe')).toHaveLength(1);
    });

    it('starts at the first slot; a reconnect gap runs from the watch\'s own last log slot to a slot seen live after the resubscribe', async () => {
      const t = run(() => [{ signature: tx('pump CreateEvent').signature, slot: 604, err: null }]);
      t.drop();
      const [slotSub] = await t.reopen();
      await settle(50); // resubscribed and backfilled, with no new slot yet: the gap stays open
      t.feed.ingest('alchemy', { type: 'slot', slot: 640n, parent: null, root: null }, { receivedAt: t.timers.now() }); // another provider's tip does not end it
      // Only the open gap reported at the drop: the range is uncovered from that moment, and not yet bounded.
      expect(facts(t.feed, t.timers, 'coverage:creates:gap')).toEqual([{ fromSlot: 603n, toSlot: null, reason: 'disconnect', via: VIA }]);
      t.hub.last.push(slotNote(slotSub!, 612));
      expect(facts(t.feed, t.timers, 'coverage:creates:gap')).toEqual([{ fromSlot: 603n, toSlot: 612n, reason: 'disconnect', via: VIA }]);
      const again = run(() => []);
      expect(facts(again.feed, again.timers, 'coverage:creates:start')).toEqual([{ fromSlot: 600n, via: VIA }]);
    });

    it('an outage is visible to decisions while it lasts: an engine lookup during it sees the open gap', async () => {
      const t = run(() => []);
      const seen: unknown[] = [];
      const engine = new Engine({
        clock: t.feed.clock, feed: t.feed, runner: { run: () => undefined }, seed: 'outage', book: CONFIG,
        strategy: { onMarket: (e, ctx) => {
          if (e.key === 'chain:slot') {
            const g = ctx.lookup('coverage:creates:gap');
            seen.push(g.ok ? (g.value as { value: unknown }).value : g.reason);
          }
          return [];
        } },
      });
      t.feed.advance(t.timers.now());
      engine.drain();
      t.drop(); // the stream is down and stays down: no reconnect, no backfill
      t.feed.ingest('alchemy', { type: 'slot', slot: 630n, parent: null, root: null }, { receivedAt: t.timers.now() + 1 });
      t.feed.advance(t.timers.now() + 60_000);
      engine.drain();
      expect(seen.at(0)).toBe('missing');
      expect(seen.at(-1)).toEqual({ fromSlot: 603n, toSlot: null, reason: 'disconnect', via: VIA });
    });

    it('a sightings-only stream reports a gap only when backfill was cut short or failed', async () => {
      for (const [sigs, limit, expected] of [
        [() => [], 100, 0],
        [() => [{ signature: tx('pump CreateEvent').signature, slot: 604, err: null }], 1, 1],
        [() => { throw new Error('rpc down'); }, 100, 1],
      ] as const) {
        const t = run(sigs, { decodeLogs: false, limit });
        t.drop();
        const [slotSub] = await t.reopen();
        await settle(50);
        t.hub.last.push(slotNote(slotSub!, 612));
        t.feed.advance(t.timers.now() + 60_000);
        const settled: [string, unknown][] = [];
        for (let e = t.feed.next(); e; e = t.feed.next()) if (e.kind === 'market' && e.key.startsWith('coverage:creates:') && !e.key.endsWith(':start')) settled.push([e.key, (e.value as { value: unknown }).value]);
        // Always the open gap at the drop; then a bounded gap if anything may be missing, else a full resume.
        expect(settled[0]).toEqual(['coverage:creates:gap', { fromSlot: 603n, toSlot: null, reason: 'disconnect', via: VIA }]);
        expect(settled[1]).toEqual(expected
          ? ['coverage:creates:gap', { fromSlot: 603n, toSlot: 612n, reason: 'disconnect', via: VIA }]
          : ['coverage:creates:resume', { fromSlot: 603n, toSlot: 612n, via: VIA }]);
        expect(settled).toHaveLength(2);
      }
    });

    it('a reconnect during a backfill: the stale backfill cannot close the newer gap', async () => {
      for (const second of [() => { throw new Error('rpc down'); }, () => [{ signature: tx('pump CreateEvent').signature, slot: 604, err: null }]]) {
        // The first backfill is slow and complete; the second fails or fills a whole page.
        const t = run((call) => (call === 0 ? [] : second()), { decodeLogs: false, limit: 1, delayMs: () => 5_000 });
        t.drop();
        await t.reopen(); // first backfill starts, answer due in 5 s
        t.drop(); // drops again before it answers
        t.timers.advance(5_000); // the stale answer lands; the second connection is still waiting to reopen
        await settle(50);
        const [slotSub] = await t.reopen();
        t.hub.last.push(slotNote(slotSub!, 620)); // live again, but the second backfill has not answered
        expect(facts(t.feed, t.timers, 'coverage:creates:gap')).toEqual([{ fromSlot: 603n, toSlot: null, reason: 'disconnect', via: VIA }]); // one open gap for both drops
        expect(facts(t.feed, t.timers, 'coverage:creates:resume')).toEqual([]);
        t.timers.advance(5_000);
        await settle(50);
        t.hub.last.push(slotNote(slotSub!, 621));
        expect(facts(t.feed, t.timers, 'coverage:creates:gap')).toEqual([{ fromSlot: 603n, toSlot: 620n, reason: 'disconnect', via: VIA }]);
      }
    });

    it('a watch raised to P1 in place keeps its coverage (no gap, no new start) and survives the halt; lowered while halted, it is dropped', async () => {
      const t = run(() => [], { used: 699_000 });
      // The logs watch is the second one run() adds (the slot watch is first).
      expect(t.stream.setPriority(2, P1)).toBe(true);
      expect(t.stream.setPriority(1, P1)).toBe(false);
      t.scheduler.meter(1_000);
      t.hub.last.push(slotNote(100, 606)); // any traffic runs the budget check
      expect(t.scheduler.halted).toBe(true);
      expect(facts(t.feed, t.timers, 'coverage:creates:gap')).toEqual([]);
      expect(t.stream.setPriority(2, P3)).toBe(true);
      expect(facts(t.feed, t.timers, 'coverage:creates:gap')).toEqual([{ fromSlot: 603n, toSlot: null, reason: 'halted', via: VIA }]);
      expect(t.stream.setPriority(2, P1)).toBe(false);
    });

    it('a watch dropped at the 70% halt leaves an open-ended gap; after resetBudget it can watch again and starts anew', async () => {
      const t = run(() => [], { used: 699_000 });
      t.scheduler.meter(1_000);
      t.hub.last.push(slotNote(100, 606)); // any traffic runs the budget check
      expect(facts(t.feed, t.timers, 'coverage:creates:gap')).toEqual([{ fromSlot: 603n, toSlot: null, reason: 'halted', via: VIA }]);
      expect(() => t.stream.watchLogs(MINT_AUTH, { priority: P3, coverage: 'creates' })).toThrow(/halted/);
      t.scheduler.resetBudget(0);
      const id = t.stream.watchLogs(MINT_AUTH, { priority: P3, coverage: 'creates' });
      expect(id).toBeGreaterThan(0);
      const req = t.hub.last.requests().at(-1)!;
      t.hub.last.push({ jsonrpc: '2.0', id: req.id, result: 999 });
      expect(facts(t.feed, t.timers, 'coverage:creates:start')).toEqual([{ fromSlot: 607n, via: VIA }]);
    });
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
    expect(a.frames.filter((f) => f.source !== 'worker').map((f) => [f.source, f.duplicate])).toEqual([['helius', false], ['alchemy', true]]);
  });
});

describe('RPC stream stop and start (the feed drill, rehearsal 37142749019)', () => {
  it('a stop opens the gap like a drop; the next start backfills it and reports up again', async () => {
    const { hub, frames, stream, timers } = setup((method) => (method === 'getSignaturesForAddress' ? [] : undefined));
    stream.watchSlots(P1);
    stream.watchLogs(MINT_AUTH, { priority: P3, coverage: 'creates' });
    stream.start();
    hub.last.open();
    const [slotSub, logSub] = ack(hub);
    hub.last.push(slotNote(slotSub!, 500));
    hub.last.push(logs(logSub!, 500, 'sig-a'));
    await settle();
    stream.stop();
    const offchain = () => frames.filter((f) => f.body.type === 'offchain').map((f) => (f.body as { key: string; value: Record<string, unknown> }));
    expect(offchain().map((b) => [b.key, b.value['state'] ?? b.value['toSlot']])).toEqual([
      ['feed:status:helius', 'up'], ['coverage:creates:start', undefined], ['coverage:creates:gap', null], ['feed:status:helius', 'down'],
    ]);
    stream.start();
    hub.last.open();
    ack(hub);
    timers.advance(10);
    await settle();
    const last = offchain().filter((b) => b.key === 'feed:status:helius').at(-1)!;
    expect(last.value).toMatchObject({ state: 'up', fromSlot: 501n });
  });
});
