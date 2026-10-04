// S0-ZERO: a candidate's candles are observed from its pool's creation (the migration), but its trade watch can only
// start after the migration names the pool. The watch's coverage therefore starts at the migration slot with an open
// catch-up gap, closed by FILL-2's in-run fill: a resume only when the fill restored it in full, a lossy gap otherwise
// (H11 keeps rejecting). The live trades seen meanwhile are held back and reach the feed after the fill's.
import { describe, expect, it } from 'vitest';
import { transactionEvents, type TransactionRecord } from '../../core/src/chain/index.ts';
import { startSession, TRIAL_POLICY } from '../../core/src/config/index.ts';
import { OFF_CHAIN, type Moment } from '../../core/src/engine/index.ts';
import { Evidence, candlesKey, migrationKey, parseCandles, parseMigration } from '../../core/src/gates/index.ts';
import { MINT as MINT_H, POOL_ADDRESS, passingFacts } from '../../core/test/gates/world.ts';
import { makeWorker, passingMarket, tempState } from './worker-harness.ts';
import { FactWorld, MINT, POOL, RECORDS, atOf, chainTx, coverage, slotNotice, txEvents } from '../../core/test/facts/helpers.ts';
import { checkJournal } from '../../runner/src/journal.ts';
import {
  CATCH_UP_HOLD_MAX, DEFAULT_LIVE_FEED, FakeSocketHub, LiveFeed, RpcHttp, RpcStream, rpcHandler, scriptedHttp, TxFetcher, type Frame, type WatchOptions,
} from '../src/providers/index.ts';
import type { SignatureInfo } from '../src/providers/solana-http.ts';
import { HELIUS_FREE, ManualTimers, P1, P3, Scheduler, type Timers } from '../src/scheduler/index.ts';
import { CAPPED_READ_CREDITS_PER_DAY, FILL_CREDITS_PER_DAY } from '../src/run/seed-start.ts';
import { DEPLOYER_CHECK_CREDITS_PER_DAY } from '../src/facts/deployer-checks.ts';
import { holderScanCreditsPerDay } from '../src/facts/budget.ts';
import { fillTradeGaps, type SeedRpc } from '../src/seed/index.ts';
import { PoolWatch } from '../src/run/pool-watch.ts';
import { CreditBook, LiveProviders, TRADES_FILL_CREDITS, tradesFill } from '../src/run/sources.ts';
import type { DailyBudget } from '../src/persist/index.ts';
import { blockNetwork, recordOf, settle, testSecrets, tx, TXS } from './helpers.ts';

blockNetwork();

const QVC = 'QVCymnis5qQJEJRZPgbEJnNKrQdNkhJtTFk7v1xqu9D';
const SOCKET = { initialMs: 1_000, maxMs: 8_000, idleMs: 30_000 };
type Fill = NonNullable<WatchOptions['fill']>;

/** A stream with a slot watch and one pool watch; the pool's coverage must start at `coverFrom` (its migration). */
const setup = (o: { readonly fill?: Fill; readonly coverFrom?: bigint; readonly holdLive?: boolean } = {}) => {
  const timers = new ManualTimers(1_000_000);
  const hub = new FakeSocketHub();
  const frames: Frame[] = [];
  const feed = new LiveFeed({ ...DEFAULT_LIVE_FEED, horizonSlots: 0, onFrame: (f) => frames.push(f) });
  const scheduler = new Scheduler(HELIUS_FREE, { timers });
  const http = scriptedHttp(rpcHandler(() => undefined));
  const rpc = new RpcHttp({ provider: 'helius', url: () => 'https://rpc.test/', http, scheduler, timeoutMs: 1_000 });
  const fetcher = new TxFetcher({ clients: [rpc], feed, timers, retries: 0, retryMs: 500, remember: 1_000 });
  const stream = new RpcStream({ provider: 'helius', url: () => 'wss://ws.test/', factory: hub.factory, timers, feed, scheduler, creditsPerByte: 0, creditsPerConnection: 0, http: rpc, fetcher, socket: SOCKET, backfillLimit: 100 });
  stream.watchSlots(P1);
  stream.start();
  hub.last.open();
  const ack = (): number[] => hub.last.requests().flatMap((r, k) => {
    if (!r.method.endsWith('Subscribe') || r.id === undefined) return [];
    hub.last.push({ jsonrpc: '2.0', id: r.id, result: 100 + k });
    return [100 + k];
  });
  const [slotSub] = ack();
  const slot = async (n: number) => {
    hub.last.push({ jsonrpc: '2.0', method: 'slotNotification', params: { subscription: slotSub, result: { slot: n, parent: n - 1, root: n - 32 } } });
    await settle(20);
  };
  // The feed has seen slot 600 before the candidate's pool is watched; the migration was at slot 590.
  hub.last.push({ jsonrpc: '2.0', method: 'slotNotification', params: { subscription: slotSub, result: { slot: 600, parent: 599, root: 568 } } });
  const poolId = stream.watchLogs(QVC, { priority: P3, decodeLogs: true, coverage: `trades:${QVC}`, commitment: 'confirmed', ...(o.fill === undefined ? {} : { fill: o.fill }), ...(o.coverFrom === undefined ? {} : { coverFrom: o.coverFrom }), ...(o.holdLive === undefined ? {} : { holdLive: o.holdLive }) });
  const req = hub.last.requests().at(-1)!;
  hub.last.push({ jsonrpc: '2.0', id: req.id, result: 200 });
  const log = (n: number, signature: string) => hub.last.push({ jsonrpc: '2.0', method: 'logsNotification', params: { subscription: 200, result: { context: { slot: n }, value: { signature, err: null, logs: ['Program log: x'] } } } });
  const coverage = () => frames.filter((f) => f.body.type === 'offchain' && f.body.key.startsWith(`coverage:trades:${QVC}:`)).map((f) => {
    const b = f.body as { key: string; value: unknown };
    return [b.key.split(':').at(-1)!, b.value];
  });
  const logFrames = () => frames.filter((f) => f.body.type === 'logs' || f.body.type === 'seen');
  return { timers, hub, feed, frames, stream, poolId, slot, log, coverage, logFrames };
};

describe('a candidate pool watch starts its coverage at the migration', () => {
  it('a complete fill: coverage from the migration slot, closed with a resume over [migration, first live slot]', async () => {
    const asked: unknown[] = [];
    const t = setup({ coverFrom: 590n, fill: async (g) => { asked.push(g); return true; } });
    await settle(20);
    expect(t.coverage()).toEqual([
      ['start', { fromSlot: 590n, via: `logs:${QVC}` }],
      ['gap', { fromSlot: 590n, toSlot: null, reason: 'catch-up', via: `logs:${QVC}` }],
    ]);
    await t.slot(601);
    expect(asked).toEqual([{ address: QVC, fromSlot: 590n, toSlot: 601n }]);
    expect(t.coverage().at(-1)).toEqual(['resume', { fromSlot: 590n, toSlot: 601n, via: `logs:${QVC}` }]);
  });

  it('a false, failed or missing fill closes the catch-up as a lossy gap: the candles stay unproven', async () => {
    for (const fill of [async () => false, async () => { throw new Error('rpc down'); }, undefined]) {
      const t = setup({ coverFrom: 590n, ...(fill === undefined ? {} : { fill }) });
      await settle(20);
      await t.slot(601);
      expect(t.coverage().at(-1)).toEqual(['gap', { fromSlot: 590n, toSlot: 601n, reason: 'catch-up', via: `logs:${QVC}` }]);
      expect(t.coverage().some(([k]) => k === 'resume')).toBe(false);
    }
  });

  it('without coverFrom, or when it is not before the next slot, coverage starts at the first live slot as before', async () => {
    for (const coverFrom of [undefined, 601n, 700n]) {
      const t = setup({ ...(coverFrom === undefined ? {} : { coverFrom }), fill: async () => true });
      await settle(20);
      await t.slot(601);
      expect(t.coverage()).toEqual([['start', { fromSlot: 601n, via: `logs:${QVC}` }]]);
    }
  });

  it('live trades seen during the catch-up reach the feed after the fill\'s transactions, as lookups, in arrival order', async () => {
    const pending: ((ok: boolean) => void)[] = [];
    const fillFrames: string[] = [];
    let feedRef: LiveFeed | null = null;
    const t = setup({
      coverFrom: 590n,
      fill: (g) => new Promise<boolean>((resolve) => {
        pending.push((ok) => {
          // The fill puts its transactions on the feed before it answers (ingestingFill).
          feedRef!.ingest('helius', { type: 'tx', record: recordOf(TXS.find((x) => x.label.startsWith('PumpSwap SellEvent'))!) }, { receivedAt: 1_000_000, backfilled: true, lookup: true });
          fillFrames.push(`${g.fromSlot}-${g.toSlot}`);
          resolve(ok);
        });
      }),
    });
    feedRef = t.feed;
    await settle(20);
    t.log(602, 'A'.padEnd(88, '1'));
    t.log(603, 'B'.padEnd(88, '1'));
    await t.slot(604);
    expect(t.logFrames()).toEqual([]); // held while the fill runs
    expect(pending).toHaveLength(1);
    pending[0]!(true);
    await settle(20);
    const after = t.frames.filter((f) => ['tx', 'logs', 'seen'].includes(f.body.type));
    expect(after[0]!.body.type).toBe('tx');
    const live = after.slice(1).map((f) => [f.body.type, (f.body as { signature: string }).signature.slice(0, 1)]);
    expect(live).toEqual([['seen', 'A'], ['logs', 'A'], ['seen', 'B'], ['logs', 'B']]);
    // Placed after what is already released (lookups), never refused as late.
    expect(after.slice(1).every((f) => f.place.at === 'offchain')).toBe(true);
    expect(t.coverage().at(-1)?.[0]).toBe('resume');
    // Once the catch-up is closed, live notifications go straight to the feed again.
    t.log(605, 'C'.padEnd(88, '1'));
    await settle(20);
    expect(t.logFrames().at(-1)!.place.at).toBe('chain');
  });

  it('a held pool\'s catch-up (holdLive false, EXIT-KEEP) puts its live trades on the feed at once; the fill still decides the resume', async () => {
    const pending: ((ok: boolean) => void)[] = [];
    const t = setup({ coverFrom: 590n, holdLive: false, fill: () => new Promise<boolean>((resolve) => { pending.push(resolve); }) });
    await settle(20);
    t.log(602, 'A'.padEnd(88, '1'));
    await settle(20);
    // Not held for the fill: an exit never waits on a catch-up.
    expect(t.logFrames().map((f) => f.body.type)).toEqual(['seen', 'logs']);
    expect(t.coverage().map(([part]) => part)).toEqual(['start', 'gap']);
    await t.slot(604);
    expect(pending).toHaveLength(1);
    pending[0]!(false);
    await settle(20);
    // A lossy fill still closes the catch-up as a bounded gap: the held position's trade evidence is not complete.
    expect(t.coverage().at(-1)?.[0]).toBe('gap');
    expect((t.coverage().at(-1)?.[1] as { toSlot: unknown }).toSlot).not.toBeNull();
  });

  it('a hold that overflows releases at once and the catch-up stays lossy even if the fill says complete', async () => {
    const pending: ((ok: boolean) => void)[] = [];
    const t = setup({ coverFrom: 590n, fill: () => new Promise<boolean>((r) => { pending.push(r); }) });
    await settle(20);
    await t.slot(601);
    const b58 = (k: number) => [...String(k)].map((d) => 'abcdefghij'[Number(d)]).join('');
    for (let k = 0; k <= CATCH_UP_HOLD_MAX; k++) t.log(602, `S${b58(k)}`.padEnd(88, '1'));
    await settle(20);
    expect(t.logFrames().length).toBe(2 * (CATCH_UP_HOLD_MAX + 1));
    pending[0]!(true);
    await settle(20);
    expect(t.coverage().at(-1)).toEqual(['gap', { fromSlot: 590n, toSlot: 601n, reason: 'catch-up', via: `logs:${QVC}` }]);
  });

  it('a watch dropped during the catch-up puts what it held on the feed', async () => {
    const t = setup({ coverFrom: 590n, fill: () => new Promise<boolean>(() => {}) });
    await settle(20);
    t.log(602, 'A'.padEnd(88, '1'));
    await settle(20);
    expect(t.logFrames()).toEqual([]);
    t.stream.unwatch(t.poolId, 'not watched');
    expect(t.logFrames().map((f) => f.body.type)).toEqual(['seen', 'logs']);
  });

  it('a drop during the catch-up keeps it open from the migration; the fill is asked again on the new connection', async () => {
    const asked: unknown[] = [];
    const pending: ((ok: boolean) => void)[] = [];
    const t = setup({ coverFrom: 590n, fill: (g) => new Promise<boolean>((r) => { asked.push(g); pending.push(r); }) });
    await settle(20);
    await t.slot(601);
    expect(asked).toEqual([{ address: QVC, fromSlot: 590n, toSlot: 601n }]);
    t.hub.last.drop();
    pending[0]!(true); // the lost connection's answer is discarded
    await settle(20);
    expect(t.coverage().some(([k]) => k === 'resume')).toBe(false);
    t.timers.advance(8_000);
    t.hub.last.open();
    const subs = t.hub.last.requests().flatMap((r, k) => {
      if (!r.method.endsWith('Subscribe') || r.id === undefined) return [];
      t.hub.last.push({ jsonrpc: '2.0', id: r.id, result: 300 + k });
      return [300 + k];
    });
    await settle(50);
    t.hub.last.push({ jsonrpc: '2.0', method: 'slotNotification', params: { subscription: subs[0], result: { slot: 610, parent: 609, root: 578 } } });
    await settle(50);
    expect(asked.at(-1)).toEqual({ address: QVC, fromSlot: 590n, toSlot: 610n });
    pending.at(-1)!(true);
    await settle(20);
    expect(t.coverage().at(-1)).toEqual(['resume', { fromSlot: 590n, toSlot: 610n, via: `logs:${QVC}` }]);
  });
});

describe('the pool watch passes the migration to candidate watches only', () => {
  it('a candidate gets coverFrom and the fill; a held pool gets the fill, and coverFrom only after a restart with its live trades never held (EXIT-KEEP)', () => {
    const calls: [string, WatchOptions][] = [];
    const stream = { watchLogs: (a: string, o: WatchOptions) => { calls.push([a, o]); return calls.length; }, unwatch: () => {}, setPriority: () => true };
    const timers: Timers = { now: () => 0, setTimeout: () => ({ id: 0 }), clearTimeout: () => {} };
    const fill: Fill = async () => true;
    const w = new PoolWatch({
      stream, timers, everyMs: 1_000, fill,
      pools: () => new Map([['PoolCand1', { mint: 'M1', held: false, fromSlot: 590n }], ['PoolHeld1', { mint: 'M2', held: true, fromSlot: 580n }], ['PoolHeld2', { mint: 'M4', held: true }], ['PoolTail1', { mint: 'M3', held: false }]]),
    });
    w.sync();
    const by = new Map(calls);
    expect(by.get('PoolCand1')).toMatchObject({ priority: P3, coverFrom: 590n, fill, commitment: 'confirmed', coverage: 'trades:PoolCand1' });
    // A held pool restored after a restart catches up from its saved slot, its live trades put on the feed at once (an exit
    // never waits on a catch-up); one without a saved slot gets no catch-up at all.
    expect(by.get('PoolHeld1')).toMatchObject({ priority: P1, fill, coverFrom: 580n, holdLive: false });
    expect(by.get('PoolHeld2')).toMatchObject({ priority: P1, fill });
    expect(by.get('PoolHeld2')!.coverFrom).toBeUndefined();
    expect(by.get('PoolCand1')!.holdLive).toBeUndefined();
    expect(by.get('PoolTail1')!.coverFrom).toBeUndefined();
  });
});

describe('the in-run fill spends from the daily budget and is journaled', () => {
  const sigs = (n: number): SignatureInfo[] => [...TXS].filter((t) => t.label.startsWith('PumpSwap SellEvent')).slice(0, n).map((t) => ({ signature: t.signature, slot: BigInt(t.slot), err: null, blockTime: t.base64.blockTime ?? null }));
  const rpc = (calls: string[]): SeedRpc => ({
    getSignaturesForAddress: async (_a, o) => {
      calls.push('sigs');
      // A signature older than the gap proves the history before it was read (FILL-2's ordinary completeness).
      const all = [...sigs(2), { signature: 'Older452941100'.padEnd(44, '1'), slot: 452_941_100n, err: null, blockTime: 1_791_032_000 }];
      const from = o.before === undefined ? 0 : all.findIndex((x) => x.signature === o.before) + 1;
      return all.slice(from, from + o.limit);
    },
    getTransaction: async (s): Promise<TransactionRecord | null> => { calls.push(s); const t = TXS.find((x) => x.signature === s); return t === undefined ? null : recordOf(t); },
  });
  const now = 1_791_032_700_000;
  const timers: Timers = { now: () => now, setTimeout: (fn) => { queueMicrotask(fn); return { id: 0 }; }, clearTimeout: () => {} };
  const pool = 'Hyg1u7HjBpmne8MLZsKoVBB31nm276xy4E6dzGcaYni';

  it('books what it spent and journals the pool, mint, size, credits and outcome', async () => {
    let remaining = 10_000;
    const spent: number[] = [];
    const caps: number[] = [];
    const lines: [string, Record<string, unknown>][] = [];
    const placed: Frame[] = [];
    const feed = new LiveFeed({ ...DEFAULT_LIVE_FEED, horizonSlots: 0, onFrame: (f) => placed.push(f) });
    const calls: string[] = [];
    const fill = tradesFill({
      feed, rpc: rpc(calls), timers,
      budget: { remaining: () => { caps.push(remaining); return remaining; }, spend: (c) => { spent.push(c); remaining -= c; } },
      pools: () => new Map([[pool, { mint: 'MintX', held: false, fromSlot: 452_941_200n }]]),
      journal: (k, f) => lines.push([k, { ...f }]),
    });
    const ok = await fill({ address: pool, fromSlot: 452_941_200n, toSlot: 452_941_210n });
    expect(ok, JSON.stringify(lines, (_k, v) => (typeof v === 'bigint' ? String(v) : v))).toBe(true);
    expect(spent).toHaveLength(1);
    expect(spent[0]).toBeGreaterThan(0);
    expect(lines).toHaveLength(1);
    expect(lines[0]![0]).toBe('trades_fill');
    expect(lines[0]![1]).toMatchObject({ pool, mint: 'MintX', kind: 'candidate', from_slot: 452_941_200n, complete: true, credits: spent[0], transactions: 2 });
    // Placed after everything ingested so far, oldest first, even where their own slots are not yet released.
    expect(placed.filter((f) => f.body.type === 'tx').map((f) => f.place.at)).toEqual(['offchain', 'offchain']);
  });

  it('no budget left: no call at all, the fill answers false (the gap stays lossy), and it is journaled', async () => {
    const calls: string[] = [];
    const lines: Record<string, unknown>[] = [];
    const fill = tradesFill({
      feed: new LiveFeed({ ...DEFAULT_LIVE_FEED, horizonSlots: 0 }), rpc: rpc(calls), timers,
      budget: { remaining: () => 0, spend: () => {} },
      pools: () => new Map([[pool, { mint: 'MintX', held: false }]]),
      journal: (_k, f) => lines.push({ ...f }),
    });
    expect(await fill({ address: pool, fromSlot: 452_941_200n, toSlot: 452_941_210n })).toBe(false);
    expect(calls).toEqual([]);
    expect(lines[0]).toMatchObject({ complete: false, credits: 0, stopped_by: 'skipped-no-budget' });
  });

  it('a fill stops at TRADES_FILL_CREDITS, or at what the budget has left when that is less: partial, the gap stays lossy', async () => {
    const hyg = TXS.find((x) => x.label.startsWith('PumpSwap SellEvent'))!;
    const many: SignatureInfo[] = Array.from({ length: TRADES_FILL_CREDITS + 50 }, (_, k) => ({ signature: `Many${k}`.replace(/0/g, 'z').padEnd(44, '1'), slot: BigInt(hyg.slot), err: null, blockTime: 1_791_032_000 }));
    const busy: SeedRpc = {
      getSignaturesForAddress: async (_a, o) => { const from = o.before === undefined ? 0 : many.findIndex((x) => x.signature === o.before) + 1; return many.slice(from, from + o.limit); },
      getTransaction: async () => recordOf(hyg),
    };
    for (const [remaining, cap] of [[1_000_000, TRADES_FILL_CREDITS], [7, 7]] as const) {
      const spent: number[] = [];
      const lines: Record<string, unknown>[] = [];
      const fill = tradesFill({
        feed: new LiveFeed({ ...DEFAULT_LIVE_FEED, horizonSlots: 0 }), timers, rpc: busy,
        budget: { remaining: () => remaining, spend: (c) => spent.push(c) },
        pools: () => new Map(), journal: (_k, f) => lines.push({ ...f }),
      });
      expect(await fill({ address: pool, fromSlot: 452_941_200n, toSlot: 452_941_210n })).toBe(false);
      expect(lines[0]).toMatchObject({ complete: false, stopped_by: 'credit-cap' });
      expect(spent[0]).toBeLessThanOrEqual(cap);
      expect(spent[0]).toBeGreaterThan(cap - 3);
    }
  });

  it('the runner\'s journal summary counts the fills, their transactions and credits', () => {
    const line = (seq: number, kind: string, extra: Record<string, unknown> = {}) => JSON.stringify({ seq, ts: '2026-10-05T00:00:00.000Z', boot: 'b1', kind, ...extra });
    const text = [
      line(1, 'start', { entry_rule: 'S0', paper_edge_ppm: null, qualifying: false, s0_salt: 'S0' }),
      line(2, 'trades_fill', { complete: true, transactions: 3, credits: 4 }),
      line(3, 'trades_fill', { complete: false, transactions: 0, credits: 0 }),
    ].join('\n');
    expect(checkJournal(text).trades_fill).toEqual({ lines: 2, complete: 1, transactions: 3, credits: 4 });
  });
});

// ---------- With real mainnet transactions (core FACTS-1 fixtures: the coin's migration and its pool's swaps) ----------

describe('FILL-2 proves a catch-up complete when the pool\'s history starts at its own creation', () => {
  const migrate = chainTx('migration CreatePoolEvent');
  const swaps = RECORDS.filter((r) => r.label === 'pool swap after migration' && r.rec.signature !== migrate.signature).map((r) => r.rec);
  const sigOf = (r: TransactionRecord): SignatureInfo => ({ signature: r.signature, slot: r.slot, err: null, blockTime: r.blockTime });
  const history = (recs: readonly TransactionRecord[]) => [...recs].sort((a, b) => (a.slot > b.slot ? -1 : a.slot < b.slot ? 1 : 0)).map(sigOf);
  const rpcOf = (sigs: readonly SignatureInfo[]): SeedRpc => ({
    getSignaturesForAddress: async (_a, o) => {
      const from = o.before === undefined ? 0 : sigs.findIndex((x) => x.signature === o.before) + 1;
      return sigs.slice(from, from + o.limit);
    },
    getTransaction: async (s) => RECORDS.find((r) => r.rec.signature === s)?.rec ?? null,
  });
  const until = swaps.reduce((m, r) => (r.slot > m ? r.slot : m), migrate.slot) + 1n;
  const run = (sigs: readonly SignatureInfo[], pool = POOL) => fillTradeGaps({
    rpc: rpcOf(sigs), timers: { now: () => 1_791_100_000_000, setTimeout: (fn) => { queueMicrotask(fn); return { id: 0 }; }, clearTimeout: () => {} }, provider: 'helius', creditCap: 10_000,
    asOf: { slot: until + 10n, txIndex: OFF_CHAIN, ixIndex: OFF_CHAIN, receivedAt: 1_791_100_000_000 },
    gaps: [{ pool, stream: `trades:${pool}`, kind: 'candidate', fromSlot: migrate.slot, fromMs: 0, untilSlot: until, close: { via: `logs:${pool}`, fromSlot: migrate.slot } }],
  });

  it('the history ends at the transaction that created this pool: complete', async () => {
    const { fills } = await run(history([migrate, ...swaps]));
    expect(fills[0]!.report.stoppedBy).toBe('history-end');
    expect(fills[0]!.complete).toBe(true);
    expect(fills[0]!.records[0]!.signature).toBe(migrate.signature);
  });

  it('a transaction in the range that cannot be read keeps it incomplete, even when the history ends at the creation', async () => {
    const broken = swaps[0]!.signature;
    const rpc: SeedRpc = { ...rpcOf(history([migrate, ...swaps])), getTransaction: async (sg) => (sg === broken ? null : RECORDS.find((r) => r.rec.signature === sg)?.rec ?? null) };
    const { fills } = await fillTradeGaps({
      rpc, timers: { now: () => 1_791_100_000_000, setTimeout: (fn) => { queueMicrotask(fn); return { id: 0 }; }, clearTimeout: () => {} }, provider: 'helius', creditCap: 10_000,
      asOf: { slot: until + 10n, txIndex: OFF_CHAIN, ixIndex: OFF_CHAIN, receivedAt: 1_791_100_000_000 },
      gaps: [{ pool: POOL, stream: `trades:${POOL}`, kind: 'candidate', fromSlot: migrate.slot, fromMs: 0, untilSlot: until, close: { via: `logs:${POOL}`, fromSlot: migrate.slot } }],
    });
    expect(fills[0]!.report.stoppedBy).toBe('history-end');
    expect(fills[0]!.records[0]!.signature).toBe(migrate.signature);
    expect(fills[0]!.complete).toBe(false);
  });

  it('the history ends at anything else, or at another pool\'s creation: incomplete', async () => {
    expect((await run(history(swaps))).fills[0]!.complete).toBe(false);
    expect((await run(history([migrate, ...swaps]), 'Hyg1u7HjBpmne8MLZsKoVBB31nm276xy4E6dzGcaYni')).fills[0]!.complete).toBe(false);
  });
});

describe('H11 on the live path: migration, a late subscribe, then trades', () => {
  const policy = startSession(TRIAL_POLICY).policy;
  const create = RECORDS.find((r) => transactionEvents(r.rec).some((e) => e.name === 'CreateEvent' && e.data.mint === MINT))!.rec;
  const complete = chainTx('pump CompleteEvent (curve filled)');
  const migrate = chainTx('migration CreatePoolEvent');
  const swaps = RECORDS.filter((r) => r.label === 'pool swap after migration' && r.rec.signature !== migrate.signature && r.rec.signature !== complete.signature).map((r) => r.rec);
  const stream = `trades:${POOL}`;
  const head = swaps.at(-1)!.slot + 1n;
  const at = atOf(swaps.at(-1)!) + 1_000;
  const moment = (slot: bigint, receivedAt: number): Moment => ({ slot, txIndex: OFF_CHAIN, ixIndex: OFF_CHAIN, receivedAt });
  const h11 = (w: FactWorld, slot: bigint, ms: number) => new Evidence(w.ctx(moment(slot, ms)), policy).read('candles', candlesKey(MINT), parseCandles, 'state', 'H11');
  // As the live worker sees it: the migration (fetched at confirmed), then the pool watch's coverage from the migration
  // slot with the open catch-up gap (S0-ZERO), then the fill's swaps.
  const live = () => new FactWorld().push(
    ...txEvents(create), ...txEvents(complete), ...txEvents(migrate),
    coverage(stream, 'start', { fromSlot: migrate.slot, via: `logs:${POOL}` }, migrate.slot, atOf(migrate) + 2_000),
    coverage(stream, 'gap', { fromSlot: migrate.slot, toSlot: null, reason: 'catch-up', via: `logs:${POOL}` }, migrate.slot, atOf(migrate) + 2_001),
    ...swaps.flatMap((s) => txEvents(s)),
  );

  it('rejects while the catch-up is open, and passes once the fill resumed it in full', () => {
    const w = live().push(slotNotice(head, at));
    const open = h11(w, head, at + 1);
    expect(open.ok).toBe(false);
    w.push(coverage(stream, 'resume', { fromSlot: migrate.slot, toSlot: head - 1n, via: `logs:${POOL}` }, head, at + 2), slotNotice(head + 1n, at + 3));
    expect(h11(w, head + 1n, at + 4).ok).toBe(true);
  });

  it('a lossy catch-up (failed, partial or over budget) keeps H11 rejecting: H16 gap', () => {
    const w = live().push(slotNotice(head, at));
    w.push(coverage(stream, 'gap', { fromSlot: migrate.slot, toSlot: head - 1n, reason: 'catch-up', via: `logs:${POOL}` }, head, at + 2), slotNotice(head + 1n, at + 3));
    const r = h11(w, head + 1n, at + 4);
    expect(!r.ok && r.reason).toMatchObject({ gate: 'H16', code: 'gap', input: 'stream' });
  });

  it('a reconnect gap after the catch-up: filled in full H11 passes again; a lossy fill keeps it rejecting', () => {
    for (const filled of [true, false]) {
      const drop = swaps.at(-2)!.slot;
      const w = live().push(
        slotNotice(head, at - 40),
        coverage(stream, 'resume', { fromSlot: migrate.slot, toSlot: migrate.slot + 1n, via: `logs:${POOL}` }, head, at - 30),
        coverage(stream, 'gap', { fromSlot: drop, toSlot: null, reason: 'disconnect', via: `logs:${POOL}` }, head, at - 20),
      );
      expect(h11(w, head, at).ok).toBe(false); // open while the fill runs
      w.push(slotNotice(head + 1n, at + 1), coverage(stream, filled ? 'resume' : 'gap', { fromSlot: drop, toSlot: head, ...(filled ? {} : { reason: 'disconnect' }), via: `logs:${POOL}` }, head + 1n, at + 2));
      const r = h11(w, head + 1n, at + 3);
      if (filled) expect(r.ok).toBe(true);
      else expect(!r.ok && r.reason).toMatchObject({ gate: 'H16', code: 'gap', input: 'stream' });
    }
  });

  it('coverage that starts at the first live slot, as before S0-ZERO, never passes: H16 gap', () => {
    const w = new FactWorld().push(
      ...txEvents(create), ...txEvents(complete), ...txEvents(migrate),
      coverage(stream, 'start', { fromSlot: migrate.slot + 3n, via: `logs:${POOL}` }, migrate.slot + 3n, atOf(migrate) + 2_000),
      ...swaps.flatMap((s) => txEvents(s)), slotNotice(head, at),
    );
    const r = h11(w, head, at + 1);
    expect(!r.ok && r.reason).toMatchObject({ gate: 'H16', code: 'gap', input: 'stream' });
  });
});

describe('the strategy hands each candidate\'s migration slot to the pool watch', () => {
  it('a shortlisted candidate\'s pool is listed with its migration fact\'s slot; an open position\'s pool without one', async () => {
    const h = makeWorker();
    expect(await h.worker.reconcile()).toEqual({ ok: true });
    await passingMarket(h, { heldPoolFacts: true });
    const mig = parseMigration(passingFacts().get(migrationKey(MINT_H))!.value)!;
    const listed = h.worker.strategy.watchedPools().get(POOL_ADDRESS);
    expect(listed).toMatchObject({ mint: MINT_H, held: false });
    expect(listed!.fromSlot).toBe(mig.obs.slot);
    await h.worker.stop();
  });

  it('a mint sighted twice keeps the earliest slot: a later sighting of its migration does not move it', async () => {
    const h = makeWorker();
    expect(await h.worker.reconcile()).toEqual({ ok: true });
    const m = await passingMarket(h, { heldPoolFacts: true });
    const raw = passingFacts().get(migrationKey(MINT_H))!.value as { obs: { slot: bigint } };
    const first = raw.obs.slot;
    // The same migration seen again, observed at a later slot (a refetch, or a second provider's copy).
    m.fact(migrationKey(MINT_H), { ...raw, obs: { ...raw.obs, slot: first + 100n } });
    await m.run(4_000, 400, () => {
      m.slot();
      m.pool();
    });
    expect(h.worker.strategy.watchedPools().get(POOL_ADDRESS)!.fromSlot).toBe(first);
    await h.worker.stop();
  });
});

describe('the live providers wire the fill into the pool watches (the original bug: no fill was ever wired)', () => {
  const mig = tx('migration CreatePoolEvent');
  const record = recordOf(mig);
  const poolOf = transactionEvents(record).find((e) => e.name === 'CreatePoolEvent')!;
  const pool = (poolOf.data as { pool: string }).pool;
  const run = async (withBudget: boolean) => {
    const timers = new ManualTimers(Number(record.blockTime) * 1000 + 5_000);
    const hub = new FakeSocketHub();
    const http = scriptedHttp(rpcHandler((m) => (m === 'getTransaction' ? mig.base64 : m === 'getSignaturesForAddress' ? [{ signature: mig.signature, slot: Number(record.slot), err: null, blockTime: Number(record.blockTime) }] : undefined)));
    const stateDir = tempState();
    let spent = 0;
    const providers = new LiveProviders({
      tradeStreams: false, secrets: testSecrets, http, factory: hub.factory, credits: new CreditBook(stateDir, timers),
      ...(withBudget ? { fillBudget: { remaining: () => 20_000 - spent, spend: (c: number) => { spent += c; } } as unknown as DailyBudget } : {}),
    });
    const frames: Frame[] = [];
    const feed = new LiveFeed({ ...DEFAULT_LIVE_FEED, horizonSlots: 0, onFrame: (f) => frames.push(f) });
    const lines: unknown[] = [];
    const sources = providers.feeds({ feed, timers, pools: () => new Map([[pool, { mint: 'MintM', held: false, fromSlot: record.slot }]]), journal: (_k, f) => lines.push(f) });
    sources.find((s) => s.name === 'helius-ws')!.start();
    const hel = hub.sockets.find((s) => s.url.includes('helius'))!;
    hel.open();
    await settle(20);
    const subs = new Map<string, number>();
    hel.requests().forEach((r, k) => {
      if (typeof r.method === 'string' && r.method.endsWith('Subscribe') && r.id !== undefined) {
        hel.push({ jsonrpc: '2.0', id: r.id, result: 700 + k });
        subs.set(r.method === 'slotSubscribe' ? 'slot' : JSON.stringify(r.params), 700 + k);
      }
    });
    await settle(20);
    hel.push({ jsonrpc: '2.0', method: 'slotNotification', params: { subscription: subs.get('slot'), result: { slot: Number(record.slot) + 5, parent: 0, root: 0 } } });
    for (let k = 0; k < 20; k++) await settle(20);
    const cov = frames.filter((f) => f.body.type === 'offchain' && f.body.key.startsWith(`coverage:trades:${pool}:`)).map((f) => (f.body as { key: string }).key.split(':').at(-1));
    sources.find((s) => s.name === 'helius-ws')!.stop();
    return { cov, lines, spent };
  };

  it('with the fill budget: the catch-up from the migration closes with a resume, journaled and booked', async () => {
    const r = await run(true);
    expect(r.cov).toEqual(['start', 'gap', 'resume']);
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toMatchObject({ pool, complete: true, transactions: 1 });
    expect(r.spent).toBeGreaterThan(0);
  });

  it('without a fill budget: no fill, the catch-up closes lossy and H11 keeps rejecting', async () => {
    const r = await run(false);
    expect(r.cov).toEqual(['start', 'gap', 'gap']);
    expect(r.lines).toEqual([]);
  });
});

describe('the daily fill budget is derived from the Helius plan, not fixed', () => {
  it('fills plus the capped recurring reads stay inside the non-exit allowance of a 31-day month, with room left', () => {
    const allowance = HELIUS_FREE.budget!.monthlyCredits * HELIUS_FREE.budget!.haltShare;
    expect(allowance).toBe(700_000);
    // Five capped reads: H15 (5,760), the stand-in check (1,440), the delay probe (1,440), the deployer checks (5,000) and
    // the holder scans (100 a day × 12 credits).
    expect(CAPPED_READ_CREDITS_PER_DAY).toBe(120 * 24 * 2 + 1_440 + 1_440 + DEPLOYER_CHECK_CREDITS_PER_DAY + holderScanCreditsPerDay());
    expect(DEPLOYER_CHECK_CREDITS_PER_DAY).toBe(5_000);
    expect(holderScanCreditsPerDay()).toBe(1_200);
    expect(CAPPED_READ_CREDITS_PER_DAY).toBe(14_840);
    expect(FILL_CREDITS_PER_DAY).toBe(3_870);
    expect(31 * (CAPPED_READ_CREDITS_PER_DAY + FILL_CREDITS_PER_DAY)).toBeLessThan(allowance);
    // Half of what is left stays for the uncapped reads (socket bytes, migration fetches, fact reads).
    expect(allowance - 31 * (CAPPED_READ_CREDITS_PER_DAY + FILL_CREDITS_PER_DAY)).toBeGreaterThanOrEqual(31 * FILL_CREDITS_PER_DAY);
  });
});
