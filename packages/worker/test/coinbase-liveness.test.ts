// COINBASE-LIVENESS: the SOL-USD feed's `heartbeat` channel (about one frame a second) keeps the feed live, so quiet
// trade minutes no longer trip "feed coinbase-ws stale". Liveness is not price freshness: a heartbeat never sets or
// dates the SOL price, and never becomes a frame on the feed (so it is never recorded or replayed).
import { describe, expect, it } from 'vitest';
import { evaluateEntry } from '../../core/src/risk/index.ts';
import { TRIAL_POLICY } from '../../core/src/config/index.ts';
import { CoinbaseSolPrice, DEFAULT_LIVE_FEED, FakeSocketHub, LiveFeed, type Frame } from '../src/providers/index.ts';
import { ManualTimers } from '../src/scheduler/index.ts';
import { baseInput, baseRequest, clockAt, codes } from '../../core/test/risk/helpers.ts';
import { Market, dueTimers, makeWorker, scriptedSource } from './worker-harness.ts';
import { T } from './worker-harness.ts';
import type { Source } from '../src/providers/index.ts';
import type { MicroUsd } from '../../core/src/units/index.ts';

const KEY = 'worker:sol-price';
const heartbeat = (extra: Record<string, unknown> = {}) => ({ type: 'heartbeat', sequence: 90, last_trade_id: 20, product_id: 'SOL-USD', time: '2026-10-06T00:00:00.000000Z', ...extra });

const setup = () => {
  const timers = new ManualTimers(Date.parse('2026-10-06T00:00:10Z'));
  const hub = new FakeSocketHub();
  const frames: Frame[] = [];
  const alive: number[] = [];
  const feed = new LiveFeed({ ...DEFAULT_LIVE_FEED, onFrame: (f) => frames.push(f) });
  const src = new CoinbaseSolPrice({ factory: hub.factory, timers, feed, key: KEY, onAlive: (at) => alive.push(at) });
  src.start();
  const socket = hub.sockets[0]!;
  socket.open();
  const prices = () => frames.filter((f) => f.body.type === 'fact').map((f) => (f.body as { value: { value: bigint; atMs: number } }).value);
  return { timers, socket, frames, alive, prices };
};

describe('the source', () => {
  it('subscribes to the heartbeat channel next to the ticker, for the same product', () => {
    const { socket } = setup();
    expect(socket.requests()).toEqual([{ type: 'subscribe', product_ids: ['SOL-USD'], channels: ['ticker', 'heartbeat'] }]);
  });

  it('a heartbeat reports liveness at its receipt time and puts nothing on the feed', () => {
    const { socket, timers, frames, alive } = setup();
    const before = frames.length;
    timers.advance(1_000);
    socket.push(heartbeat());
    expect(alive).toEqual([timers.now()]);
    expect(frames.length).toBe(before);
  });

  it('a heartbeat of another product, or without a product, is not liveness', () => {
    const { socket, alive, prices } = setup();
    socket.push(heartbeat({ product_id: 'BTC-USD' }));
    socket.push({ type: 'heartbeat' });
    socket.push({ type: 'ticker', product_id: 'BTC-USD', price: '60000.5', time: '2026-10-06T00:00:10.000000Z' });
    expect(alive).toEqual([]);
    expect(prices()).toEqual([]);
  });

  it('heartbeats never set or re-date the price: R1 still judges the ticker\'s own age', () => {
    const { socket, timers, prices, alive } = setup();
    const tickAt = timers.now();
    socket.push({ type: 'ticker', product_id: 'SOL-USD', price: '150.25', time: new Date(tickAt).toISOString() });
    expect(prices()).toHaveLength(1);
    for (let k = 0; k < 30; k++) {
      timers.advance(1_000);
      socket.push(heartbeat({ sequence: 91 + k }));
    }
    expect(alive).toHaveLength(30);
    // One price, still dated at the trade: nothing a heartbeat did reached it.
    expect(prices()).toEqual([{ value: 150_250_000n, atMs: tickAt }]);
    const price = prices()[0]!;
    const age = timers.now() - price.atMs;
    expect(age).toBeGreaterThan(TRIAL_POLICY.gates.maxQuoteAgeMs);
    const i = baseInput();
    const input = baseInput({ clock: clockAt(timers.now()), market: { ...i.market, solPrice: { value: price.value as MicroUsd, atMs: price.atMs } } });
    expect(codes(evaluateEntry(input, baseRequest({ quoteAtMs: timers.now() })))).toContain('sol_price_stale');
  });
});

describe('the worker\'s stale halt', () => {
  type H = ReturnType<typeof makeWorker>;
  const boot = async (port: number, beats: boolean) => {
    const hub = new FakeSocketHub();
    const helius = scriptedSource('helius-ws', true, ['helius']);
    let sol: CoinbaseSolPrice | null = null;
    const h: H = makeWorker({
      timers: dueTimers(T - 16 * 86_400_000),
      sources: (ctx) => {
        sol = new CoinbaseSolPrice({ factory: hub.factory, timers: ctx.timers, feed: ctx.feed, key: KEY, ...(beats ? { onAlive: (at: number) => ctx.alive?.('coinbase', at) } : {}) });
        return [helius, { name: 'coinbase-ws', critical: true, sources: ['coinbase'], start: () => sol!.start(), stop: () => sol!.stop() }];
      },
      config: { ZEROED_HEALTH_ADDR: `127.0.0.1:${port}`, ZEROED_API_ADDR: `127.0.0.1:${port + 1}` },
    });
    const m = new Market(h);
    const started = h.worker.start();
    let result: unknown = null;
    void started.then((r) => void (result = r));
    const opened = new Set<unknown>();
    const wait = async (done: () => boolean, each?: () => void): Promise<void> => {
      for (let k = 0; k < 1_000 && !done(); k++) {
        await m.run(100, 100, each);
        await new Promise<void>((r) => setTimeout(r, 1));
      }
    };
    // As the §18 tests boot: the sources start after the reconcile; then the feeds come up and the start completes.
    await wait(() => helius.starts === 1);
    for (const s of hub.sockets) if (!opened.has(s)) { opened.add(s); s.open(); }
    h.worker.feed.ingest('helius' as Source, { type: 'offchain', key: 'feed:status:helius', value: { state: 'up' } }, { receivedAt: m.now });
    await wait(() => result !== null);
    expect(result).toEqual({ ok: true });
    return { h, m, hub };
  };
  const run = async (m: Market, h: H, hub: FakeSocketHub, ms: number, beat: boolean, chain = true): Promise<void> => {
    await m.run(ms, 400, () => {
      if (chain) {
        m.slot();
        h.worker.feed.ingest('helius' as Source, { type: 'offchain', key: 'feed:status:helius', value: { state: 'up' } }, { receivedAt: m.now });
      }
      if (beat) hub.sockets.at(-1)?.push(heartbeat());
    });
  };
  const halted = (h: H) => h.worker.health().halt_reasons.includes('feed coinbase-ws stale');

  it('30 s of heartbeats and no trade: entries are not halted', async () => {
    const { h, m, hub } = await boot(18940, true);
    await run(m, h, hub, 30_000, true);
    expect(halted(h)).toBe(false);
    expect(h.worker.health().halt_reasons).toEqual([]);
    await h.worker.stop();
  }, 60_000);

  it('the same 30 s without the heartbeat signal halts entries (what the base did)', async () => {
    const { h, m, hub } = await boot(18942, false);
    await run(m, h, hub, 30_000, true);
    expect(halted(h)).toBe(true);
    await h.worker.stop();
  }, 60_000);

  it('Coinbase heartbeats never keep another feed fresh: a silent Helius still halts and cannot exit', async () => {
    const { h, m, hub } = await boot(18946, true);
    await run(m, h, hub, 15_000, true, false);
    const reasons = h.worker.health().halt_reasons;
    expect(reasons).toContain('feed helius-ws stale');
    expect(reasons).not.toContain('feed coinbase-ws stale');
    expect(h.worker.health().exit_capable).toBe(false);
    await h.worker.stop();
  }, 60_000);

  it('no frame at all for over 10 s: the halt still fires', async () => {
    const { h, m, hub } = await boot(18944, true);
    await run(m, h, hub, 12_000, false);
    expect(halted(h)).toBe(true);
    await h.worker.stop();
  }, 60_000);
});
