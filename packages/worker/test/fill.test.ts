// FILL-2: trade-stream gap fills for tracked pools, after a restart and in a run (docs/DECISIONS.md, FILL-2).
// Real mainnet PumpSwap transactions from DEC-1's fixtures (2026-10-03): pool QVCym… has trades in two slots, pool
// Hyg1u… three sells in one slot.
import { describe, expect, it } from 'vitest';
import type { TransactionRecord } from '../../core/src/chain/index.ts';
import { AsOfStore, OFF_CHAIN, SimClock, compareEvents, type MarketEvent, type Moment } from '../../core/src/engine/index.ts';
import { DAY_MS } from '../../core/src/config/time.ts';
import { createsCoverage } from '../../core/src/gates/index.ts';
import {
  DEFAULT_LIVE_FEED, FakeSocketHub, LiveFeed, RpcHttp, RpcStream, eventsOfFrame, rankIn, rpcHandler, scriptedHttp, TxFetcher, type Frame,
} from '../src/providers/index.ts';
import { ProviderError } from '../src/providers/http.ts';
import type { SignatureInfo } from '../src/providers/solana-http.ts';
import { HELIUS_FREE, ManualTimers, P1, P2, P3, Scheduler, type Timers } from '../src/scheduler/index.ts';
import { fillTradeGaps, ingestingFill, type SeedRpc, type TradeGap } from '../src/seed/index.ts';
import { blockNetwork, recordOf, settle, TXS } from './helpers.ts';

blockNetwork();

const QVC = 'QVCymnis5qQJEJRZPgbEJnNKrQdNkhJtTFk7v1xqu9D';
const HYG = 'Hyg1u7HjBpmne8MLZsKoVBB31nm276xy4E6dzGcaYni';
const poolTxs = (label: string) => TXS.filter((t) => t.label.startsWith(label));
const QVC_TXS = poolTxs('PumpSwap BuyEvent (negative'); // slots 452941197 and 452941172
const HYG_TXS = poolTxs('PumpSwap SellEvent'); // three in slot 452941205

const sig = (t: (typeof TXS)[number], over: Partial<SignatureInfo> = {}): SignatureInfo => ({ signature: t.signature, slot: BigInt(t.slot), err: null, blockTime: t.base64.blockTime ?? null, ...over });
const newestFirst = (xs: readonly SignatureInfo[]) => [...xs].sort((a, b) => (a.slot > b.slot ? -1 : a.slot < b.slot ? 1 : 0));
const OLDER = (slot: bigint): SignatureInfo => ({ signature: `Older${slot}`.padEnd(44, '1'), slot, err: null, blockTime: 1_791_032_000 });

/** A pool's signature history newest first; getTransaction answers from the fixtures (or `fault`). */
const fakeRpc = (sigs: readonly SignatureInfo[], fault: (sig: string) => Error | null = () => null): SeedRpc & { readonly fetched: string[]; readonly priorities: number[] } => {
  const fetched: string[] = [];
  const priorities: number[] = [];
  return {
    fetched, priorities,
    getSignaturesForAddress: async (_a, o, p) => {
      priorities.push(p);
      const from = o.before === undefined ? 0 : sigs.findIndex((s) => s.signature === o.before) + 1;
      return sigs.slice(from, from + o.limit);
    },
    getTransaction: async (s, p): Promise<TransactionRecord | null> => {
      fetched.push(s);
      priorities.push(p);
      const f = fault(s);
      if (f) throw f;
      const t = TXS.find((x) => x.signature === s);
      return t === undefined ? null : recordOf(t);
    },
  };
};
const instant = (now = 1_791_032_700_000): Timers => ({ now: () => now, setTimeout: (fn) => { queueMicrotask(fn); return { id: 0 }; }, clearTimeout: () => {} });

const UNTIL = 452_941_300n;
const ASOF: Moment = { slot: UNTIL + 20n, txIndex: OFF_CHAIN, ixIndex: OFF_CHAIN, receivedAt: 1_791_032_700_000 };
const LIVE: Moment = { slot: UNTIL, txIndex: OFF_CHAIN, ixIndex: OFF_CHAIN, receivedAt: ASOF.receivedAt - 1_000 };
const DOWN_FROM = 452_941_100n;
const DOWN_MS = 1_791_032_500_000;
const gapOf = (pool: string, over: Partial<TradeGap> = {}): TradeGap => ({
  pool, stream: `trades:${pool}`, kind: 'candidate', fromSlot: DOWN_FROM, fromMs: DOWN_MS, untilSlot: UNTIL,
  close: { via: `logs:${pool}`, fromSlot: DOWN_FROM }, liveStart: LIVE, ...over,
});
const QVC_HISTORY = [...newestFirst(QVC_TXS.map((t) => sig(t))), OLDER(DOWN_FROM - 5n)];

/** The saved coverage of a pool stream, the fill's facts and the restarted watch's start, through an as-of store. */
const covered = (stream: string, fill: readonly MarketEvent[], live: Moment = LIVE, savedGap: { fromSlot: bigint; at: Moment } = { fromSlot: DOWN_FROM, at: { slot: DOWN_FROM, txIndex: OFF_CHAIN, ixIndex: OFF_CHAIN, receivedAt: DOWN_MS } }) => {
  const wrapped = (value: Record<string, unknown>) => ({ value, source: 'worker', backfilled: false, seq: 1 });
  const via = `logs:${stream.slice('trades:'.length)}`;
  const events: MarketEvent[] = [
    { kind: 'market', id: 'saved-start', moment: { slot: 452_000_000n, txIndex: OFF_CHAIN, ixIndex: OFF_CHAIN, receivedAt: DOWN_MS - 2 * DAY_MS }, key: `coverage:${stream}:start`, value: wrapped({ fromSlot: 452_000_000n, via }) },
    { kind: 'market', id: 'zz-saved-gap', moment: savedGap.at, key: `coverage:${stream}:gap`, value: wrapped({ fromSlot: savedGap.fromSlot, toSlot: null, reason: 'shutdown', via }) },
    ...fill,
    // The feed's own id for an off-chain fact (`<key>#<seq>`), which sorts before the fill's `fill:…` ids on a tie.
    { kind: 'market', id: `coverage:${stream}:start#99`, moment: live, key: `coverage:${stream}:start`, value: wrapped({ fromSlot: UNTIL, via }) },
  ];
  const clock = new SimClock({ slot: 0n, txIndex: 0, ixIndex: 0, receivedAt: Number.MIN_SAFE_INTEGER });
  const store = new AsOfStore(clock);
  for (const e of events.sort(compareEvents)) {
    clock.advanceTo(e.moment);
    store.record(e.key, e.value, e.moment, e.id);
  }
  const now = { ...ASOF, slot: ASOF.slot + 10n };
  clock.advanceTo(now);
  return createsCoverage((k, f, t) => store.history(k, f, t), now, DOWN_MS - DAY_MS, stream);
};

describe('FILL-2 after a restart', () => {
  it('a complete fill releases the gap\'s events with chain moments and closes the saved gap: coverage continuous', async () => {
    const { fills } = await fillTradeGaps({ rpc: fakeRpc(QVC_HISTORY), timers: instant(), provider: 'helius', creditCap: 100, gaps: [gapOf(QVC)], asOf: ASOF });
    const f = fills[0]!;
    expect(f.complete).toBe(true);
    expect(f.report).toMatchObject({ stoppedBy: 'done', creditsUsed: 1 + QVC_TXS.length, calls: { getSignaturesForAddress: 1, getTransaction: QVC_TXS.length } });
    expect(f.events.map((e) => e.moment.slot)).toEqual([452_941_172n, 452_941_197n]);
    expect([...f.events].sort(compareEvents)).toEqual(f.events);
    expect(f.coverage.map((e) => e.key)).toEqual([`coverage:trades:${QVC}:resume`]);
    expect(compareEvents(f.coverage[0]!, { moment: LIVE, id: `coverage:trades:${QVC}:start#99` })).toBeLessThan(0);
    expect(covered(`trades:${QVC}`, f.coverage).covered).toBe(true);
    // Without the fill the restart settles the saved gap as lossy.
    expect(covered(`trades:${QVC}`, []).covered).toBe(false);
  });

  it('the close is first wherever the live start lands (at, below untilSlot, or just after the saved state)', async () => {
    // The last case: the restart's local receipt time is behind the downtime's first block time (clock skew), so the
    // close's time must come from liveStart - 1 ms, not from the block time.
    for (const [slot, receivedAt] of [[UNTIL, LIVE.receivedAt], [UNTIL - 1n, LIVE.receivedAt], [UNTIL - 2n, LIVE.receivedAt], [DOWN_FROM + 1n, LIVE.receivedAt], [UNTIL, DOWN_MS - 5_000]] as const) {
      const live: Moment = { ...LIVE, slot, receivedAt };
      const { fills } = await fillTradeGaps({ rpc: fakeRpc(QVC_HISTORY), timers: instant(), provider: 'helius', creditCap: 100, gaps: [gapOf(QVC, { liveStart: live })], asOf: ASOF });
      expect(covered(`trades:${QVC}`, fills[0]!.coverage, live).covered).toBe(true);
    }
  });

  it('a partial fill stays a gap: one unreadable transaction closes the saved gap as lossy', async () => {
    const bad = QVC_TXS[0]!.signature;
    const rpc = fakeRpc(QVC_HISTORY, (s) => (s === bad ? new ProviderError('helius', 'shape', 'bad') : null));
    const { fills } = await fillTradeGaps({ rpc, timers: instant(), provider: 'helius', creditCap: 100, gaps: [gapOf(QVC)], asOf: ASOF });
    expect(fills[0]!.complete).toBe(false);
    expect(fills[0]!.coverage[0]!.key).toBe(`coverage:trades:${QVC}:gap`);
    expect(covered(`trades:${QVC}`, fills[0]!.coverage).covered).toBe(false);
    // History ending before the gap's first slot is also partial.
    const short = await fillTradeGaps({ rpc: fakeRpc(QVC_HISTORY.slice(0, -1)), timers: instant(), provider: 'helius', creditCap: 100, gaps: [gapOf(QVC)], asOf: ASOF });
    expect(short.fills[0]).toMatchObject({ complete: false, report: { stoppedBy: 'history-end' } });
  });

  it('released events equal what the stream gives for the same transactions (ids, keys, positions, decoded events)', async () => {
    const history = [...newestFirst(HYG_TXS.map((t) => sig(t))), OLDER(DOWN_FROM - 5n)];
    // The signature list is newest first within the slot too: reverse the block order.
    history.splice(0, 3, ...HYG_TXS.map((t) => sig(t)).reverse());
    const { fills } = await fillTradeGaps({ rpc: fakeRpc(history), timers: instant(), provider: 'helius', creditCap: 100, gaps: [gapOf(HYG)], asOf: ASOF });
    // The stream: the same transactions fetched live in block order, ranked by arrival.
    const ranks = new Map<string, number>();
    const live = HYG_TXS.flatMap((t, seq) => {
      const r = recordOf(t);
      const frame: Frame = { seq, receivedAt: 1, source: 'helius', backfilled: false, place: { at: 'chain', slot: r.slot }, duplicate: false, body: { type: 'tx', record: r } };
      rankIn(ranks, frame);
      return eventsOfFrame(frame, ranks).filter((e): e is MarketEvent => e.kind === 'market');
    }).sort(compareEvents);
    const shape = (e: MarketEvent) => [e.id, e.key, e.moment.slot, e.moment.txIndex, e.moment.ixIndex, (e.value as { event: unknown }).event];
    expect(fills[0]!.events.map(shape)).toEqual(live.map(shape));
    expect(fills[0]!.events.length).toBeGreaterThanOrEqual(3);
  });

  it('nothing after the process start: the live watch\'s first slot is not read, and an event after asOf makes the fill partial', async () => {
    const atUntil: SignatureInfo = { ...sig(QVC_TXS[0]!), signature: 'AtUntil'.padEnd(44, '1'), slot: UNTIL };
    const rpc = fakeRpc([atUntil, ...QVC_HISTORY]);
    const { fills } = await fillTradeGaps({ rpc, timers: instant(), provider: 'helius', creditCap: 100, gaps: [gapOf(QVC)], asOf: ASOF });
    expect(rpc.fetched).not.toContain(atUntil.signature);
    expect(fills[0]!.report.droppedFuture).toBe(1);
    for (const e of fills[0]!.events) expect(e.moment.slot < UNTIL && e.moment.receivedAt <= ASOF.receivedAt).toBe(true);
    // asOf before the newer trade's block time: that event is held back and the gap is not closed as complete.
    const early: Moment = { ...ASOF, receivedAt: (QVC_TXS[0]!.base64.blockTime! - 1) * 1_000 };
    const r2 = await fillTradeGaps({ rpc: fakeRpc(QVC_HISTORY), timers: instant(), provider: 'helius', creditCap: 100, gaps: [gapOf(QVC)], asOf: early });
    expect(r2.fills[0]!.complete).toBe(false);
    for (const e of [...r2.fills[0]!.events, ...r2.fills[0]!.coverage]) expect(e.moment.receivedAt <= early.receivedAt).toBe(true);
  });

  it('over budget: open positions first, then candidates; a candidate past the cap keeps its gap', async () => {
    const rpc = fakeRpc(QVC_HISTORY);
    const hyg = fakeRpc([...HYG_TXS.map((t) => sig(t)).reverse(), OLDER(DOWN_FROM - 5n)]);
    const both: SeedRpc = {
      getSignaturesForAddress: (a, o, p) => (a === QVC ? rpc : hyg).getSignaturesForAddress(a, o, p),
      getTransaction: (s, p) => (QVC_TXS.some((t) => t.signature === s) ? rpc : hyg).getTransaction(s, p),
    };
    const gaps = [gapOf(HYG, { kind: 'candidate' }), gapOf(QVC, { kind: 'position' })];
    const { fills, creditsUsed } = await fillTradeGaps({ rpc: both, timers: instant(), provider: 'helius', creditCap: 1 + QVC_TXS.length, gaps, asOf: ASOF });
    expect(fills.map((f) => [f.gap.pool, f.complete])).toEqual([[QVC, true], [HYG, false]]);
    expect(fills[1]!.report.stoppedBy).toBe('skipped-no-budget');
    expect(fills[1]!.coverage[0]!.key).toBe(`coverage:trades:${HYG}:gap`);
    expect(covered(`trades:${HYG}`, fills[1]!.coverage).covered).toBe(false);
    expect(creditsUsed).toBe(1 + QVC_TXS.length);
    expect(rpc.priorities.every((p) => p === P2)).toBe(true);
    // A cap that runs out inside a gap stops it there: partial, lossy.
    const cut = await fillTradeGaps({ rpc: fakeRpc(QVC_HISTORY), timers: instant(), provider: 'helius', creditCap: 2, gaps: [gapOf(QVC)], asOf: ASOF });
    expect(cut.fills[0]).toMatchObject({ complete: false, report: { stoppedBy: 'credit-cap', creditsUsed: 2 } });
    expect(hyg.priorities.length).toBe(0);
    void P3;
  });

  it('reads from the saved gap\'s start when it is older than fromSlot; never restores an unread slot', async () => {
    const later = 452_941_180n; // after the older trade at 452941172
    const rpc = fakeRpc(QVC_HISTORY);
    const { fills } = await fillTradeGaps({ rpc, timers: instant(), provider: 'helius', creditCap: 100, gaps: [gapOf(QVC, { fromSlot: later })], asOf: ASOF });
    expect(fills[0]!.complete).toBe(true);
    expect(fills[0]!.events.map((e) => e.moment.slot)).toContain(452_941_172n);
    expect(covered(`trades:${QVC}`, fills[0]!.coverage).covered).toBe(true);
    const short = await fillTradeGaps({ rpc: fakeRpc(QVC_HISTORY.filter((x) => x.slot > later)), timers: instant(), provider: 'helius', creditCap: 100, gaps: [gapOf(QVC, { fromSlot: later })], asOf: ASOF });
    expect(short.fills[0]!.complete).toBe(false);
    expect(covered(`trades:${QVC}`, short.fills[0]!.coverage).covered).toBe(false);
    // An "empty" gap whose saved gap starts by untilSlot is read, not skipped.
    const e = await fillTradeGaps({ rpc: fakeRpc(QVC_HISTORY), timers: instant(), provider: 'helius', creditCap: 100, gaps: [gapOf(QVC, { fromSlot: UNTIL + 3n })], asOf: ASOF });
    expect(e.fills[0]!.report.stoppedBy).toBe('done');
  });

  it('a live start below the saved gap\'s report: fail safe without close.at, closed after the gap with it', async () => {
    const live: Moment = { ...LIVE, slot: DOWN_FROM - 1n, receivedAt: DOWN_MS - 1 };
    const without = await fillTradeGaps({ rpc: fakeRpc(QVC_HISTORY), timers: instant(), provider: 'helius', creditCap: 100, gaps: [gapOf(QVC, { liveStart: live })], asOf: ASOF });
    expect(covered(`trades:${QVC}`, without.fills[0]!.coverage, live).covered).toBe(false);
    const at: Moment = { slot: DOWN_FROM, txIndex: OFF_CHAIN, ixIndex: OFF_CHAIN, receivedAt: DOWN_MS };
    const withAt = await fillTradeGaps({ rpc: fakeRpc(QVC_HISTORY), timers: instant(), provider: 'helius', creditCap: 100, gaps: [gapOf(QVC, { liveStart: live, close: { via: `logs:${QVC}`, fromSlot: DOWN_FROM, at } })], asOf: ASOF });
    expect(compareEvents(withAt.fills[0]!.coverage[0]!, { moment: at, id: 'zz' })).toBeGreaterThan(0);
    expect(covered(`trades:${QVC}`, withAt.fills[0]!.coverage, live).covered).toBe(true);
  });

  it('as-of: a gap whose liveStart or close.at is after the process start is refused', async () => {
    const after: Moment = { slot: ASOF.slot + 1_000n, txIndex: OFF_CHAIN, ixIndex: OFF_CHAIN, receivedAt: ASOF.receivedAt + 60_000 };
    await expect(fillTradeGaps({ rpc: fakeRpc(QVC_HISTORY), timers: instant(), provider: 'helius', creditCap: 100, gaps: [gapOf(QVC, { liveStart: after })], asOf: ASOF })).rejects.toThrow(/after the process start/);
    await expect(fillTradeGaps({ rpc: fakeRpc(QVC_HISTORY), timers: instant(), provider: 'helius', creditCap: 100, gaps: [gapOf(QVC, { close: { via: `logs:${QVC}`, fromSlot: DOWN_FROM, at: after } })], asOf: ASOF })).rejects.toThrow(/after the process start/);
    // close.at exactly at asOf: the close would follow it by 1 ms, after asOf, so none is made (the gap stays open).
    const equal = await fillTradeGaps({ rpc: fakeRpc(QVC_HISTORY), timers: instant(), provider: 'helius', creditCap: 100, gaps: [gapOf(QVC, { liveStart: { ...ASOF }, close: { via: `logs:${QVC}`, fromSlot: DOWN_FROM, at: { ...ASOF } } })], asOf: ASOF });
    expect(equal.fills[0]!.coverage).toEqual([]);
  });

  it('a per-fill page cap stops a busy gap as partial: it stays a gap', async () => {
    // 1,000 failed signatures above the gap (no transaction to fetch), then the pool's real ones: two pages needed.
    const busy: SignatureInfo[] = Array.from({ length: 1_000 }, (_, k) => ({ signature: `Busy${k}`.padEnd(44, '1'), slot: UNTIL - 1n - BigInt(k % 50), err: { x: 1 }, blockTime: 1_791_032_690 }));
    const rpc = fakeRpc([...busy, ...QVC_HISTORY]);
    const { fills } = await fillTradeGaps({ rpc, timers: instant(), provider: 'helius', creditCap: 10_000, maxPagesPerFill: 1, gaps: [gapOf(QVC)], asOf: ASOF });
    expect(fills[0]).toMatchObject({ complete: false, report: { stoppedBy: 'page-cap', calls: { getSignaturesForAddress: 1 } } });
    expect(covered(`trades:${QVC}`, fills[0]!.coverage).covered).toBe(false);
    const two = await fillTradeGaps({ rpc: fakeRpc([...busy, ...QVC_HISTORY]), timers: instant(), provider: 'helius', creditCap: 10_000, maxPagesPerFill: 2, gaps: [gapOf(QVC)], asOf: ASOF });
    expect(two.fills[0]!.complete).toBe(true);
  });

  it('exits never wait: a long position fill at P2 leaves room for a P1 monitoring call on the same provider', async () => {
    const timers = new ManualTimers(1_791_032_700_000);
    const scheduler = new Scheduler(HELIUS_FREE, { timers });
    const many: SignatureInfo[] = Array.from({ length: 60 }, (_, k) => ({ signature: `Pos${k}`.padEnd(44, '1'), slot: UNTIL - 1n - BigInt(k), err: null, blockTime: 1_791_032_690 }));
    const http = scriptedHttp(rpcHandler((method) => {
      if (method === 'getSignaturesForAddress') return [...many, ...QVC_HISTORY].map((x) => ({ signature: x.signature, slot: Number(x.slot), err: x.err, blockTime: x.blockTime }));
      if (method === 'getAccountInfo') return { context: { slot: 1 }, value: null };
      return null; // getTransaction: not available, a one-slot gap each
    }));
    const rpc = new RpcHttp({ provider: 'helius', url: () => 'https://rpc.test/', http, scheduler, timeoutMs: 1_000 });
    let done = false;
    const fill = fillTradeGaps({ rpc, timers, provider: 'helius', creditCap: 1_000, gaps: [gapOf(QVC, { kind: 'position' })], asOf: ASOF }).then((r) => { done = true; return r; });
    await settle(500);
    // The fill has taken all this second lets it (P2 keeps P1's floor free) and waits for the clock.
    expect(scheduler.status().granted[2]).toBe(HELIUS_FREE.window.limit - HELIUS_FREE.floors[2]);
    expect(scheduler.status().queued[2]).toBe(1);
    // A P1 call is admitted at once, without the clock moving.
    let monitored = false;
    void rpc.getAccountInfo(QVC, P1).then(() => { monitored = true; });
    await settle(50);
    expect(monitored).toBe(true);
    expect(done).toBe(false);
    for (let k = 0; k < 200 && !done; k++) { timers.advance(1_000); await settle(20); }
    expect(done).toBe(true);
    expect((await fill).fills[0]!.complete).toBe(false); // the unavailable transactions are gaps
  });

  it('a gap with nothing between the saved state and the live start is empty and complete, with no call', async () => {
    const rpc = fakeRpc(QVC_HISTORY);
    const { fills } = await fillTradeGaps({ rpc, timers: instant(), provider: 'helius', creditCap: 100, gaps: [gapOf(QVC, { fromSlot: UNTIL, close: { via: `logs:${QVC}`, fromSlot: UNTIL } })], asOf: ASOF });
    expect(fills[0]).toMatchObject({ complete: true, events: [], report: { stoppedBy: 'empty' } });
    expect(rpc.priorities).toEqual([]);
    expect(covered(`trades:${QVC}`, fills[0]!.coverage, LIVE, { fromSlot: UNTIL, at: { slot: UNTIL - 1n, txIndex: OFF_CHAIN, ixIndex: OFF_CHAIN, receivedAt: DOWN_MS } }).covered).toBe(true);
  });
});

describe('FILL-2 in a run: FEED-1 asks before closing a reconnect gap', () => {
  const SOCKET = { initialMs: 1_000, maxMs: 8_000, idleMs: 30_000 };
  const setup = (fill: (gap: { address: string; fromSlot: bigint | null; toSlot: bigint }) => Promise<boolean>, sigs: unknown[] = []) => {
    const timers = new ManualTimers(1_000_000);
    const hub = new FakeSocketHub();
    const frames: Frame[] = [];
    const feed = new LiveFeed({ ...DEFAULT_LIVE_FEED, horizonSlots: 0, onFrame: (f) => frames.push(f) });
    const scheduler = new Scheduler(HELIUS_FREE, { timers });
    const http = scriptedHttp(rpcHandler((m) => (m === 'getSignaturesForAddress' ? sigs : undefined)));
    const rpc = new RpcHttp({ provider: 'helius', url: () => 'https://rpc.test/', http, scheduler, timeoutMs: 1_000 });
    const fetcher = new TxFetcher({ clients: [rpc], feed, timers, retries: 0, retryMs: 500, remember: 1_000 });
    const stream = new RpcStream({ provider: 'helius', url: () => 'wss://ws.test/', factory: hub.factory, timers, feed, scheduler, creditsPerByte: 0, creditsPerConnection: 0, http: rpc, fetcher, socket: SOCKET, backfillLimit: 100 });
    stream.watchSlots(P1);
    stream.watchLogs(QVC, { priority: P3, coverage: `trades:${QVC}`, fill });
    stream.start();
    hub.last.open();
    const ackAll = (from = 0): number[] => hub.last.requests().slice(from).flatMap((r, k) => {
      if (!r.method.endsWith('Subscribe') || r.id === undefined) return [];
      hub.last.push({ jsonrpc: '2.0', id: r.id, result: 100 + k + from });
      return [100 + k + from];
    });
    const [slotSub, logSub] = ackAll();
    hub.last.push({ jsonrpc: '2.0', method: 'slotNotification', params: { subscription: slotSub, result: { slot: 600, parent: 599, root: 568 } } });
    hub.last.push({ jsonrpc: '2.0', method: 'logsNotification', params: { subscription: logSub, result: { context: { slot: 603 }, value: { signature: QVC_TXS[1]!.signature, err: null, logs: ['Program log: x'] } } } });
    const settled = () => {
      feed.advance(timers.now() + 60_000);
      const out: [string, unknown][] = [];
      for (let e = feed.next(); e; e = feed.next()) if (e.kind === 'market' && e.key.startsWith(`coverage:trades:${QVC}:`) && !e.key.endsWith(':start')) out.push([e.key.split(':').at(-1)!, (e.value as { value: unknown }).value]);
      return out;
    };
    const reopen = async () => {
      timers.advance(8_000);
      hub.last.open();
      const [s] = ackAll();
      await settle(50);
      return s!;
    };
    const liveSlot = async (sub: number, slot: number) => {
      hub.last.push({ jsonrpc: '2.0', method: 'slotNotification', params: { subscription: sub, result: { slot, parent: slot - 1, root: slot - 32 } } });
      await settle(50);
    };
    return { timers, hub, feed, frames, stream, settled, reopen, liveSlot };
  };

  it('a complete fill closes the gap with a resume over the gap\'s range; the fill is asked once with that range', async () => {
    const asked: unknown[] = [];
    const t = setup(async (g) => { asked.push(g); return true; }, [{ signature: 'x'.padEnd(44, '1'), slot: 604, err: null }]);
    t.hub.last.drop();
    await t.liveSlot(await t.reopen(), 612);
    expect(asked).toEqual([{ address: QVC, fromSlot: 603n, toSlot: 612n }]);
    expect(t.settled()).toEqual([['gap', { fromSlot: 603n, toSlot: null, reason: 'disconnect', via: `logs:${QVC}` }], ['resume', { fromSlot: 603n, toSlot: 612n, via: `logs:${QVC}` }]]);
  });

  it('a false or failed fill closes the gap as lossy, even when the page backfill alone looked complete', async () => {
    for (const fill of [async () => false, async () => { throw new Error('rpc down'); }]) {
      const t = setup(fill);
      t.hub.last.drop();
      await t.liveSlot(await t.reopen(), 612);
      expect(t.settled()[1]).toEqual(['gap', { fromSlot: 603n, toSlot: 612n, reason: 'disconnect', via: `logs:${QVC}` }]);
    }
  });

  it('the gap stays open while the fill runs, and a drop during it discards its answer', async () => {
    const pending: ((ok: boolean) => void)[] = [];
    const t = setup(() => new Promise<boolean>((r) => { pending.push(r); }));
    t.hub.last.drop();
    await t.liveSlot(await t.reopen(), 612);
    expect(pending).toHaveLength(1);
    expect(t.settled()).toEqual([['gap', { fromSlot: 603n, toSlot: null, reason: 'disconnect', via: `logs:${QVC}` }]]); // still open
    t.hub.last.drop();
    pending[0]!(true); // the old connection's answer
    await settle(50);
    expect(t.settled()).toEqual([]);
    await t.liveSlot(await t.reopen(), 620);
    expect(pending).toHaveLength(2);
    pending[1]!(false);
    await settle(50);
    expect(t.settled()).toEqual([['gap', { fromSlot: 603n, toSlot: 620n, reason: 'disconnect', via: `logs:${QVC}` }]]);
  });

  it('ingestingFill reads the gap and puts its transactions into the live feed as backfilled lookups', async () => {
    const feedFrames: Frame[] = [];
    const feed = new LiveFeed({ ...DEFAULT_LIVE_FEED, horizonSlots: 0, onFrame: (f) => feedFrames.push(f) });
    const reports: unknown[] = [];
    const fill = ingestingFill({
      feed, rpc: fakeRpc(QVC_HISTORY), timers: instant(), provider: 'helius', creditCap: () => 100,
      streamOf: (a) => `trades:${a}`, kindOf: () => 'position', onReport: (f) => reports.push(f.report.stoppedBy),
    });
    expect(await fill({ address: QVC, fromSlot: DOWN_FROM, toSlot: 452_941_250n })).toBe(true);
    expect(feedFrames.map((f) => [f.backfilled, f.body.type === 'tx' ? f.body.record.signature : null])).toEqual(
      [...QVC_TXS].sort((a, b) => Number(BigInt(a.slot) - BigInt(b.slot))).map((x) => [true, x.signature]));
    expect(reports).toEqual(['done']);
    expect(await fill({ address: QVC, fromSlot: null, toSlot: 452_941_250n })).toBe(false);
    const broke = ingestingFill({ feed, rpc: fakeRpc(QVC_HISTORY, () => new ProviderError('helius', 'shape', 'bad')), timers: instant(), provider: 'helius', creditCap: () => 100, streamOf: (a) => `trades:${a}`, kindOf: () => 'candidate' });
    expect(await broke({ address: QVC, fromSlot: DOWN_FROM, toSlot: 452_941_250n })).toBe(false);
  });
});
