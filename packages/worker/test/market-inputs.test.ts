// WORKER-1 market inputs (review of f679188, item 3): the live SOL/USD price for risk, and the swap stream of every
// watched pool (its fee terms and the deployer-sell trigger).
import { describe, expect, it } from 'vitest';
import { DEFAULT_LIVE_FEED, FakeSocketHub, LiveFeed, type Frame, CoinbaseSolPrice, COINBASE_WS_URL, dollarsToMicro } from '../src/providers/index.ts';
import { ManualTimers, P1, P3 } from '../src/scheduler/index.ts';
import { PoolWatch } from '../src/run/pool-watch.ts';
import { readdirSync, readFileSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';
import { join } from 'node:path';
import { rpcHandler, scriptedHttp } from '../src/providers/index.ts';
import { CreditBook, LiveProviders } from '../src/run/sources.ts';
import { blockNetwork, recordOf, settle, testSecrets, tx } from './helpers.ts';
import { makeWorker, tempState } from './worker-harness.ts';

blockNetwork();

describe('SOL/USD from the Coinbase ticker', () => {
  const setup = () => {
    const timers = new ManualTimers(Date.parse('2026-10-04T00:00:10Z'));
    const hub = new FakeSocketHub();
    const frames: Frame[] = [];
    const feed = new LiveFeed({ ...DEFAULT_LIVE_FEED, onFrame: (f) => frames.push(f) });
    const src = new CoinbaseSolPrice({ factory: hub.factory, timers, feed, key: 'worker:sol-price' });
    src.start();
    hub.last.open();
    const prices = () => frames.filter((f) => f.body.type === 'fact').map((f) => (f.body as { value: unknown }).value);
    return { timers, hub, prices, src };
  };
  const tick = (price: string, time: string) => ({ type: 'ticker', product_id: 'SOL-USD', price, time });

  it('subscribes to the SOL-USD ticker and turns each trade into micro-dollars, dated at the trade', () => {
    const { hub, prices } = setup();
    expect(hub.last.url).toBe(COINBASE_WS_URL);
    expect(hub.last.requests()).toEqual([{ type: 'subscribe', product_ids: ['SOL-USD'], channels: ['ticker'] }]);
    hub.last.push(tick('119.92', '2026-10-04T00:00:09.250Z'));
    hub.last.push(tick('119.93', '2026-10-04T00:00:09.300Z')); // within 500 ms of the last: skipped
    hub.last.push(tick('120.1', '2026-10-04T00:00:09.900Z'));
    hub.last.push({ type: 'ticker', product_id: 'BTC-USD', price: '1', time: '2026-10-04T00:00:09.990Z' });
    expect(prices()).toEqual([{ value: 119_920_000n, atMs: Date.parse('2026-10-04T00:00:09.250Z') }, { value: 120_100_000n, atMs: Date.parse('2026-10-04T00:00:09.900Z') }]);
  });

  it('a stall makes no fresh price: nothing is re-dated by its receipt, and a trade from the future is dated now', () => {
    const { hub, prices, timers } = setup();
    hub.last.push(tick('119.92', '2026-10-04T00:00:09.000Z'));
    timers.advance(20_000);
    // The same old trade again (a replayed message after a stall): still dated at its trade time, so still stale.
    hub.last.push(tick('119.92', '2026-10-04T00:00:09.000Z'));
    hub.last.push(tick('119.95', '2026-10-04T01:00:00.000Z'));
    expect(prices()).toEqual([{ value: 119_920_000n, atMs: Date.parse('2026-10-04T00:00:09.000Z') }, { value: 119_950_000n, atMs: timers.now() }]);
  });

  it('reads decimal prices exactly and refuses anything else', () => {
    expect(dollarsToMicro('119.916760')).toBe(119_916_760n);
    expect(dollarsToMicro('0.5')).toBe(500_000n);
    for (const bad of ['119.9167604', '-1', '1e3', '', ' 1']) expect(dollarsToMicro(bad), bad).toBeNull();
  });
});

describe('the swap stream of each watched pool', () => {
  const fake = () => {
    const calls: string[] = [];
    let next = 1;
    const stream = {
      watchLogs: (address: string, o: { priority: number; decodeLogs?: boolean; coverage?: string }) => {
        calls.push(`watch ${address} P${o.priority} ${String(o.decodeLogs)} ${o.coverage}`);
        return next++;
      },
      unwatch: (id: number, reason?: string) => void calls.push(`unwatch ${id} ${reason}`),
    };
    return { calls, stream };
  };

  it('follows the list: a candidate at P3, a held pool at P1, dropped pools unwatched', () => {
    const { calls, stream } = fake();
    let list = new Map([['poolA', { mint: 'mA', held: false }]]);
    const w = new PoolWatch({ stream, timers: new ManualTimers(0), pools: () => list, everyMs: 2_000 });
    w.sync();
    expect(calls).toEqual([`watch poolA P${P3} true trades:poolA`]);
    list = new Map([['poolA', { mint: 'mA', held: true }], ['poolB', { mint: 'mB', held: false }]]);
    w.sync();
    expect(calls.slice(1)).toEqual(['unwatch 1 priority changed', `watch poolA P${P1} true trades:poolA`, `watch poolB P${P3} true trades:poolB`]);
    list = new Map();
    w.sync();
    expect(calls.slice(4)).toEqual(['unwatch 2 not watched', 'unwatch 3 not watched']);
  });

  it('a refused watch (the budget halt) is retried at the next sync', () => {
    const { calls, stream } = fake();
    let refuse = true;
    const s = { ...stream, watchLogs: (a: string, o: { priority: number }) => {
      if (refuse) throw new Error('halted');
      return stream.watchLogs(a, o);
    } };
    const w = new PoolWatch({ stream: s, timers: new ManualTimers(0), pools: () => new Map([['poolA', { mint: 'mA', held: false }]]), everyMs: 2_000 });
    w.sync();
    expect(w.watching.size).toBe(0);
    refuse = false;
    w.sync();
    expect(calls).toEqual([`watch poolA P${P3} true trades:poolA`]);
    expect(w.watching.size).toBe(1);
  });
});

describe('LiveProviders on scripted sockets: a live migration reaches an entry decision (no scripted facts)', () => {
  it('slots, the migration from PumpPortal and its fetched transaction, the SOL price and the pool watch, through the real feeds', async () => {
    const mig = tx('migration CreatePoolEvent');
    const record = recordOf(mig);
    const blockMs = Number(record.blockTime) * 1000;
    // An hour and a bit after the migration: inside U2's window, so the candidate is judged.
    const manual = new ManualTimers(blockMs + 61 * 60_000);
    const timers = Object.assign(manual, { set: (ms: number) => manual.advance(Math.max(0, ms - manual.now())) });
    const hub = new FakeSocketHub();
    const http = scriptedHttp(rpcHandler((m) => (m === 'getTransaction' ? mig.base64 : m === 'getSignaturesForAddress' ? [] : null)));
    const stateDir = tempState();
    const providers = new LiveProviders({ tradeStreams: false, secrets: testSecrets, http, factory: hub.factory, credits: new CreditBook(stateDir, timers) });
    const h = makeWorker({ stateDir, timers, seedWaitMs: 0, sources: (ctx) => providers.feeds(ctx), config: { ZEROED_HEALTH_ADDR: '127.0.0.1:18860', ZEROED_API_ADDR: '127.0.0.1:18861' } });
    const socket = (part: string) => hub.sockets.filter((s) => s.url.includes(part)).at(-1);
    const acked = new Map<unknown, number>();
    const opened = new Set<unknown>();
    let slot = BigInt(mig.slot) + 50n;
    let migrated = false;
    const drive = async (ms: number, done?: () => boolean): Promise<void> => {
      for (let t = 0; t < ms && !(done?.() ?? false); t += 100) {
        for (const s of hub.sockets) {
          if (opened.has(s) || s.closed !== null) continue;
          opened.add(s);
          s.open();
        }
        const hel = socket('helius');
        if (hel !== undefined) {
          const reqs = hel.requests();
          for (let k = acked.get(hel) ?? 0; k < reqs.length; k++) {
            const r = reqs[k]!;
            if (typeof r.method === 'string' && r.method.endsWith('Subscribe') && r.id !== undefined) hel.push({ jsonrpc: '2.0', id: r.id, result: 500 + k });
          }
          acked.set(hel, reqs.length);
          if (t % 400 === 0) hel.push({ jsonrpc: '2.0', method: 'slotNotification', params: { subscription: 500, result: { slot: Number(slot++), parent: 0, root: 0 } } });
        }
        if (t % 500 === 0) socket('coinbase')?.push({ type: 'ticker', product_id: 'SOL-USD', price: '150.25', time: new Date(timers.now()).toISOString() });
        timers.advance(100);
        await settle(5);
        await new Promise<void>((r) => setImmediate(r));
      }
    };
    const started = h.worker.start();
    let result: unknown = null;
    void started.then((r) => (result = r));
    await drive(20_000, () => result !== null);
    expect(result).toEqual({ ok: true });
    socket('pumpportal')!.push({ signature: mig.signature, mint: 'So11111111111111111111111111111111111111112', txType: 'migrate', pool: 'pump-amm' });
    migrated = true;
    await drive(8_000);
    expect(migrated).toBe(true);
    const decisions = readFileSync(join(stateDir, 'journal.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { kind: string; reasons?: string[] }).filter((l) => l.kind === 'decision');
    const shortlist = decisions.find((d) => d.reasons?.[0] === 'shortlist');
    expect(shortlist).toBeDefined();
    const mint = shortlist!.reasons![2]!;
    // Judged: a reject naming the reason (the gate facts FACTS-1 produces are not wired in this test).
    expect(decisions.some((d) => d.reasons?.[0] === 'reject' && d.reasons[2] === mint)).toBe(true);
    // The candidate's pool is watched for swaps, under its own stream name.
    const pools = [...h.worker.strategy.watchedPools()];
    expect(pools).toHaveLength(1);
    const logs = socket('helius')!.requests().filter((r) => r.method === 'logsSubscribe').map((r) => (r.params as [{ mentions: string[] }])[0].mentions[0]);
    expect(logs).toContain(pools[0]![0]);
    // Every critical feed is up and fresh (helius-ws and coinbase-ws), so entries are not halted.
    expect(h.worker.health().halt_reasons).toEqual([]);
    expect(Object.keys(h.worker.health().feeds).sort()).toEqual(['coinbase-ws', 'helius-ws', 'pumpportal']);
    await h.worker.stop();
    // The SOL price went on the feed as a fact from Coinbase (the recorder holds every frame).
    const frames = readdirSync(join(stateDir, 'recorder'), { recursive: true, encoding: 'utf8' }).filter((f) => /frames-\d+\.jsonl\.zst$/.test(f))
      .flatMap((f) => zstdDecompressSync(readFileSync(join(stateDir, 'recorder', f))).toString('utf8').split('\n').filter((l) => l !== ''));
    expect(frames.some((l) => l.includes('"source":"coinbase"') && l.includes('"key":"worker:sol-price"'))).toBe(true);
  }, 60_000);
});
