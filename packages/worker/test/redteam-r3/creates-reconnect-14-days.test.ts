// RED TEAM A round 3, "never trades" class (merged base 9f7cf812): every reconnect of the creates watch blocks H14 for
// every coin for 14 days.
//
// The creates watch (run/sources.ts: PUMP_CREATE_AUTHORITY, decodeLogs, coverage 'creates', no `fill`, no `fetch`)
// opens a reconnect gap as lossy from the start (providers/solana-ws.ts:450, `lossy: w.opts.decodeLogs === true`). The
// backfill only puts the missed signatures on the feed as sightings (`#seen`); nothing decodes or fetches them, and
// with no `fill` the gap can never become a resume (`#closeCoverage`). So the reconnect closes as a bounded
// `coverage:creates:gap`, and `createsCoverage` (gates/deployer-index.ts) then reads H14 as not covered until that
// report is older than the look-back: 14 days (`deployerRugLookbackDays`), whatever the outage's length (a 2-second
// blip counts the same). Every coin is refused H16 not-covered (coverage, H14) for those 14 days.
// Fail-closed for bookkeeping, not for missing data: the missed signatures are known (the backfill read them, fewer
// than its 100 limit) and a getTransaction each (as the restart's downtime fill already does, SEED-1) would make the
// range complete.
import { describe, expect, it } from 'vitest';
import { DEFAULT_LIVE_FEED, FakeSocketHub, LiveFeed, RpcHttp, RpcStream, rpcHandler, scriptedHttp, TxFetcher, type Frame } from '../../src/providers/index.ts';
import { HELIUS_FREE, ManualTimers, P1, P3, Scheduler } from '../../src/scheduler/index.ts';
import { blockNetwork, settle, tx } from '../helpers.ts';

blockNetwork();
const MINT_AUTH = 'TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM';
const VIA = `logs:${MINT_AUTH}`;

describe('NT-2: a creates-watch reconnect with a complete backfill', () => {
  it('closes as a resume (the missed creates read), not as a lossy gap that blocks H14 for 14 days (fails on 9f7cf812)', async () => {
    const timers = new ManualTimers(1_000_000);
    const hub = new FakeSocketHub();
    const frames: Frame[] = [];
    const feed = new LiveFeed({ ...DEFAULT_LIVE_FEED, horizonSlots: 0, onFrame: (f) => frames.push(f) });
    const scheduler = new Scheduler(HELIUS_FREE, { timers, creditsUsed: 0 });
    const missed = tx('pump CreateEvent', 3);
    const http = scriptedHttp(rpcHandler((m) => (m === 'getSignaturesForAddress' ? [{ signature: missed.signature, slot: 604, err: null }] : m === 'getTransaction' ? missed : undefined)));
    const rpc = new RpcHttp({ provider: 'helius', url: () => 'https://rpc.test/?api-key=k', http, scheduler, timeoutMs: 1_000 });
    const fetcher = new TxFetcher({ clients: [rpc], feed, timers, retries: 0, retryMs: 500, remember: 1_000 });
    const stream = new RpcStream({ provider: 'helius', url: () => 'wss://ws.test/?api-key=k', factory: hub.factory, timers, feed, scheduler, creditsPerByte: 0.00002, creditsPerConnection: 1, http: rpc, fetcher, socket: { initialMs: 1_000, maxMs: 8_000, idleMs: 30_000 }, backfillLimit: 100 });
    // As production wires it (run/sources.ts).
    stream.watchSlots(P1);
    stream.watchLogs(MINT_AUTH, { priority: P3, decodeLogs: true, coverage: 'creates' });
    stream.start();
    const ack = (from = 0): number[] => {
      const ids: number[] = [];
      hub.last.requests().slice(from).forEach((r, k) => {
        if (!r.method.endsWith('Subscribe') || r.id === undefined) return;
        ids.push(100 + k + from);
        hub.last.push({ jsonrpc: '2.0', id: r.id, result: 100 + k + from });
      });
      return ids;
    };
    hub.last.open();
    const [slotSub, logSub] = ack();
    const slotNote = (sub: number, slot: number) => ({ jsonrpc: '2.0', method: 'slotNotification', params: { subscription: sub, result: { slot, parent: slot - 1, root: slot - 32 } } });
    hub.last.push(slotNote(slotSub!, 600));
    hub.last.push({ jsonrpc: '2.0', method: 'logsNotification', params: { subscription: logSub!, result: { context: { slot: 603 }, value: { signature: tx('pump CreateEvent', 2).signature, err: null, logs: ['Program log: ignored'] } } } });
    // A 2-second blip.
    hub.last.drop();
    timers.advance(2_000);
    hub.last.open();
    const [slotSub2] = ack();
    await settle(50);
    hub.last.push(slotNote(slotSub2!, 612));
    await settle(50);
    feed.advance(timers.now() + 60_000);
    const cov: [string, unknown][] = [];
    for (let e = feed.next(); e; e = feed.next()) if (e.kind === 'market' && e.key.startsWith('coverage:creates:')) cov.push([e.key, (e.value as { value: unknown }).value]);
    // What happens: the backfill saw the one missed create (1 of a 100 page), yet the gap closes bounded (lossy).
    expect(frames.some((f) => f.backfilled && f.body.type === 'seen' && 'signature' in f.body && f.body.signature === missed.signature)).toBe(true);
    const bounded = cov.filter(([k, v]) => k === 'coverage:creates:gap' && (v as { toSlot: unknown }).toSlot !== null);
    expect(bounded).toEqual([]);
  });
});
