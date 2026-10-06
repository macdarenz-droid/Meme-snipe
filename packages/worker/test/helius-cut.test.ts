import { describe, expect, it } from 'vitest';
import { FILL_CONFIG, RESEARCH_CONFIG, RUG_CONFIG } from '../../core/src/config/index.ts';
import { emptyBook } from '../../core/src/lifecycle/book.ts';
import { newEntryIntent, newPosition } from '../../core/src/lifecycle/index.ts';
import { entryKey, intentId, mint, positionId } from '../../core/src/domain/index.ts';
import { lamports } from '../../core/src/units/index.ts';
import type { StrategyContext } from '../../core/src/engine/index.ts';
import { candlesKey, createKey, migrationKey, poolKey } from '../../core/src/gates/index.ts';
import { RAW } from '../../core/src/facts/raw.ts';
import { MINT, NOW, POOL_ADDRESS, T, contextOf, passingFacts, patch, session } from '../../core/test/gates/world.ts';
import { FakeSocketHub } from '../src/providers/index.ts';
import { DEFAULT_LIVE_FEED, LiveFeed, rpcHandler, scriptedHttp } from '../src/providers/index.ts';
import { RpcSocket } from '../src/providers/rpc-socket.ts';
import { SOCKET_BYTE_KINDS } from '../src/providers/rpc-socket.ts';
import { ALCHEMY_FREE, HELIUS_FREE, JUPITER_FREE, RUGCHECK_FREE, Scheduler, HELIUS_WS_CREDITS_PER_BYTE, HELIUS_WS_CREDITS_PER_CONNECTION, ManualTimers } from '../src/scheduler/index.ts';
import { HALT_KEY, LiveStrategy, RESTORE_KEY, type StrategyConfig } from '../src/engine/strategy.ts';
import { strategyConfig } from '../src/run/settings.ts';
import { CreditBook, LiveProviders, PUMP_CREATE_AUTHORITY, PUMP_MIGRATION_AUTHORITY } from '../src/run/sources.ts';
import { blockNetwork, testSecrets } from './helpers.ts';
import { makeWorker, passingMarket, tempState } from './worker-harness.ts';
import { checkJournal } from '../../runner/src/journal.ts';
import { emptySummaryState, foldLine } from '../src/run/summary.ts';
import { checkSession, loadSession } from '../src/run/parity.ts';
import { replayLedgerFile } from '../../core/src/ledger/replay/index.ts';
import { LiveFacts } from '../src/facts/source.ts';
import { PoolWatch } from '../src/run/pool-watch.ts';

blockNetwork();

describe('Helius socket waste', () => {
  it('unsubscribes a watch removed before its subscribe acknowledgement, without serving it', () => {
    const hub = new FakeSocketHub();
    const timers = new ManualTimers(T);
    let served = 0;
    const rpc = new RpcSocket('test', () => 'wss://ws.test', hub.factory, timers, { initialMs: 1_000, maxMs: 8_000, idleMs: 60_000 });
    const h = rpc.add({ method: 'logsSubscribe', params: [], unsubscribe: 'logsUnsubscribe', notification: 'logsNotification', onNotify: () => { throw new Error('removed watch delivered'); }, onSubscribed: () => served++ });
    rpc.start();
    hub.last.open();
    const id = hub.last.requests()[0]!.id;
    rpc.remove(h);
    hub.last.push({ jsonrpc: '2.0', id, result: 701 });
    expect(hub.last.requests().at(-1)).toMatchObject({ method: 'logsUnsubscribe', params: [701] });
    expect(served).toBe(0);
    expect(rpc.size).toBe(0);
    rpc.stop();
  });

  it('attributes every UTF-8 frame once, including removed pending acknowledgements and malformed traffic', () => {
    const hub = new FakeSocketHub();
    const totals: [number, string][] = [];
    const rpc = new RpcSocket('test', () => 'wss://ws.test', hub.factory, new ManualTimers(T), { initialMs: 1_000, maxMs: 8_000, idleMs: 60_000 }, { onBytes: (n, kind) => totals.push([n, kind]) });
    const h = rpc.add({ byteKind: 'trades', method: 'logsSubscribe', params: [], unsubscribe: 'logsUnsubscribe', notification: 'logsNotification', onNotify: () => {} });
    rpc.start();
    hub.last.open();
    const ack = { jsonrpc: '2.0', id: hub.last.requests()[0]!.id, result: 99 };
    hub.last.push(ack);
    const n = { jsonrpc: '2.0', method: 'logsNotification', params: { subscription: 99, result: 'é' } };
    hub.last.push(n);
    rpc.remove(h);
    const unmatched = { jsonrpc: '2.0', method: 'logsNotification', params: { subscription: 99, result: 'late' } };
    hub.last.push(unmatched);
    hub.last.push('{é');
    hub.last.push({ jsonrpc: '2.0', id: 5, result: true });
    expect(totals).toEqual([[Buffer.byteLength(JSON.stringify(ack)), 'trades'], [Buffer.byteLength(JSON.stringify(n)), 'trades'], [Buffer.byteLength(JSON.stringify(unmatched)), 'unattributed'], [3, 'unattributed'], [Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', id: 5, result: true })), 'control']]);
    rpc.stop();
  });

  it('removes an old watch after a replacement is served, in either acknowledgement order', () => {
    for (const reverse of [true, false]) {
      const hub = new FakeSocketHub();
      const rpc = new RpcSocket('test', () => 'wss://ws.test', hub.factory, new ManualTimers(T), { initialMs: 1_000, maxMs: 8_000, idleMs: 60_000 });
      const seen: unknown[] = [];
      const spec = { method: 'logsSubscribe', params: [{ mentions: [MINT] }], unsubscribe: 'logsUnsubscribe', notification: 'logsNotification', onNotify: (r: unknown) => seen.push(r) };
      const h = rpc.add(spec);
      rpc.start();
      hub.last.open();
      const oldId = hub.last.requests()[0]!.id;
      rpc.remove(h);
      rpc.add(spec);
      const newId = hub.last.requests()[1]!.id;
      for (const [id, result] of reverse ? [[newId, 902], [oldId, 901]] : [[oldId, 901], [newId, 902]]) hub.last.push({ jsonrpc: '2.0', id, result });
      expect(hub.last.requests().filter((r) => r.method === 'logsUnsubscribe').map((r) => r.params)).toEqual([[901]]);
      for (const subscription of [901, 902]) hub.last.push({ method: 'logsNotification', params: { subscription, result: subscription } });
      expect(seen).toEqual([902]);
      rpc.stop();
    }
  });

  it('a previous connection acknowledgement cannot unsubscribe a current held watch', () => {
    const hub = new FakeSocketHub();
    const timers = new ManualTimers(T);
    const rpc = new RpcSocket('test', () => 'wss://ws.test', hub.factory, timers, { initialMs: 1_000, maxMs: 8_000, idleMs: 60_000 });
    const seen: unknown[] = [];
    const spec = { method: 'logsSubscribe', params: [], unsubscribe: 'logsUnsubscribe', notification: 'logsNotification', onNotify: (r: unknown) => seen.push(r) };
    const h = rpc.add(spec);
    rpc.start();
    hub.last.open();
    const old = hub.last;
    const oldId = old.requests()[0]!.id;
    const staleHandler = old.onmessage!;
    rpc.remove(h);
    rpc.add(spec);
    old.drop();
    timers.advance(1_000);
    hub.last.open();
    hub.last.push({ jsonrpc: '2.0', id: hub.last.requests()[0]!.id, result: 77 });
    staleHandler({ data: JSON.stringify({ jsonrpc: '2.0', id: oldId, result: 77 }) });
    hub.last.push({ jsonrpc: '2.0', id: oldId, result: 77 });
    expect(hub.last.requests().some((r) => r.method === 'logsUnsubscribe')).toBe(false);
    hub.last.push({ method: 'logsNotification', params: { subscription: 77, result: 'held' } });
    expect(seen).toEqual(['held']);
    rpc.stop();
  });

  it('journals fixed buckets once a minute with the same wire-byte total and quota charge', () => {
    const hub = new FakeSocketHub();
    const timers = new ManualTimers(T);
    const providers = new LiveProviders({ tradeStreams: true, secrets: testSecrets, http: scriptedHttp(rpcHandler(() => null)), factory: hub.factory, credits: new CreditBook(tempState(), timers) });
    const lines: { kind: string; fields: Readonly<Record<string, unknown>> }[] = [];
    const sources = providers.feeds({ feed: new LiveFeed(DEFAULT_LIVE_FEED), timers, pools: () => new Map([[POOL_ADDRESS, { mint: MINT, held: false }]]), journal: (kind, fields) => lines.push({ kind, fields }) });
    const source = sources.find((s) => s.name === 'helius-ws')!;
    source.start();
    hub.last.open();
    let total = 0;
    const sent = (v: unknown) => {
      total += Buffer.byteLength(typeof v === 'string' ? v : JSON.stringify(v));
      hub.last.push(v);
    };
    const buckets = new Map<string, number>();
    hub.last.requests().forEach((r, i) => {
      sent({ jsonrpc: '2.0', id: r.id, result: i + 700 });
      const address = (r.params?.[0] as { mentions?: string[] } | undefined)?.mentions?.[0];
      const kind = r.method === 'slotSubscribe' ? 'slots' : address === PUMP_CREATE_AUTHORITY ? 'creates' : address === PUMP_MIGRATION_AUTHORITY ? 'migrations' : address === POOL_ADDRESS ? 'trades' : 'rugs';
      buckets.set(kind, i + 700);
    });
    for (const [kind, subscription] of buckets) sent({ method: kind === 'slots' ? 'slotNotification' : 'logsNotification', params: { subscription, result: 'é' } });
    timers.advance(20_000);
    sent('{é');
    timers.advance(20_000);
    sent({ jsonrpc: '2.0', id: 999, result: true });
    timers.advance(19_999);
    expect(lines).toEqual([]);
    timers.advance(1);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.kind).toBe('socket_bytes');
    const fields = lines[0]!.fields;
    expect(fields).toMatchObject({ provider: 'helius', fromMs: T, toMs: T + 60_000, totalBytes: total, credits: total * HELIUS_WS_CREDITS_PER_BYTE });
    const counted = fields['bytes'] as Record<string, number>;
    expect(Object.keys(counted)).toEqual([...SOCKET_BYTE_KINDS]);
    expect(Object.values(counted).reduce((a, n) => a + n, 0)).toBe(total);
    for (const k of ['slots', 'creates', 'migrations', 'rugs', 'trades', 'control', 'unattributed']) expect(counted[k]).toBeGreaterThan(0);
    expect(providers.helius.status().creditsUsed).toBeCloseTo(HELIUS_WS_CREDITS_PER_CONNECTION + total * HELIUS_WS_CREDITS_PER_BYTE, 8);
    const start = { kind: 'start', seq: 1, boot: 'bytes-test', ts: new Date(T).toISOString() };
    const row = { ...fields, kind: 'socket_bytes', seq: 2, boot: 'bytes-test', ts: new Date(T + 60_000).toISOString() };
    const report = checkJournal(`${JSON.stringify(start)}\n${JSON.stringify(row)}\n`);
    expect(report.complete).toBe(true);
    expect(report.trades_fill).toEqual({ lines: 0, complete: 0, transactions: 0, credits: 0 });
    expect(report.create_lookup.lines).toBe(0);
    const summary = emptySummaryState();
    foldLine(summary, start);
    const unchanged = JSON.stringify(summary);
    foldLine(summary, row);
    expect(JSON.stringify(summary)).toBe(unchanged);
    source.stop();
    timers.advance(60_000);
    expect(lines).toHaveLength(1);
  });
});

const world = (facts = passingFacts(), s = session(), over: Partial<StrategyConfig> = {}) => {
  const config = { ...strategyConfig(s.policy, FILL_CONFIG, RESEARCH_CONFIG, 0n, { timing: 'gates', salt: '' }), ...over };
  const strategy = new LiveStrategy({ session: s, rugs: RUG_CONFIG, config });
  let book = emptyBook({ maxOpenPositions: s.policy.positions.maxOpen });
  const step = (key = migrationKey(MINT), now = NOW, value?: unknown) => {
    const gctx = contextOf(facts, now);
    const ctx: StrategyContext = { ...gctx, book, rng: { next: () => 0 } as never };
    const r = gctx.lookup(key);
    return strategy.onMarket({ kind: 'market', id: `cut:${key}:${now.receivedAt}`, moment: now, key, value: value ?? (r.ok ? r.value : null) }, ctx);
  };
  return { strategy, step, facts, config, setBook: (b: typeof book) => { book = b; } };
};

const pendingEntry = () => newEntryIntent({ id: intentId('en:pending'), key: entryKey(mint(MINT), 'U2.1.1'), mint: mint(MINT), purpose: 'entry', side: 'buy', venue: 'pumpswap', positionId: positionId(`p:${MINT}:1`), spend: lamports(1n) });

describe('gate-proven pool retirement', () => {
  it('drops dust swaps from the actual H8 verdict and keeps the candidate and fact watches', () => {
    const w = world(patch(passingFacts(), migrationKey(MINT), { quoteAtMigration: 1n }));
    const decisions = w.step();
    expect(w.strategy.watchedPools().has(POOL_ADDRESS)).toBe(false);
    expect(w.strategy.watched().has(MINT)).toBe(true);
    expect(w.strategy.candidates().has(MINT)).toBe(true);
    expect(w.strategy.retired()).toEqual([]);
    expect(decisions.some((d) => d.reasons[0] === 'pool watch stopped' && d.reasons.includes('dust-at-migration'))).toBe(true);
  });

  it('drops instant graduation and create-expired using their existing verdicts', () => {
    const base = passingFacts();
    const migration = base.get(migrationKey(MINT))!.value as { graduatedAtMs: number; migratedAtMs: number };
    for (const createdAtMs of [migration.graduatedAtMs, migration.migratedAtMs - 12 * 3_600_000 - 1]) {
      const w = world(patch(base, createKey(MINT), { createdAtMs }));
      w.step();
      expect(w.strategy.watchedPools().has(POOL_ADDRESS)).toBe(false);
    }
  });

  it('keeps missing, processed and partial evidence even alongside an adverse result', () => {
    const dust = patch(passingFacts(), migrationKey(MINT), { quoteAtMigration: 1n });
    for (const change of ['missing', 'processed', 'partial']) {
      const f = new Map(dust);
      if (change === 'missing') f.delete(createKey(MINT));
      else {
        const cf = f.get(createKey(MINT))!.value as { obs: object };
        const obs = { ...cf.obs, ...(change === 'processed' ? { commitment: 'processed' } : { quality: ['partial'] }) };
        const row = f.get(createKey(MINT))!;
        f.set(createKey(MINT), { ...row, value: { ...cf, obs } });
      }
      const w = world(f);
      w.step();
      expect(w.strategy.watchedPools().has(POOL_ADDRESS), change).toBe(true);
    }
  });

  it('follows policy changes and leaves healthy pools watched', () => {
    for (const w of [world()]) {
      w.step();
      expect(w.strategy.watchedPools().has(POOL_ADDRESS)).toBe(true);
      expect(w.strategy.watchedPools().get(POOL_ADDRESS)?.held).toBe(false);
    }
    const f = patch(passingFacts(), migrationKey(MINT), { quoteAtMigration: 6_000_000_000n });
    const unchanged = world(f);
    unchanged.step();
    expect(unchanged.strategy.watchedPools().has(POOL_ADDRESS)).toBe(true);
    const tightened = world(f, session({ dustPoolMinAtMigration: 7_000_000_000n as never }));
    tightened.step();
    expect(tightened.strategy.watchedPools().has(POOL_ADDRESS)).toBe(false);
  });

  it('waits for the policy checkpoint and follows actual U2/U1 H11 behavior, including diagnostic mode', () => {
    const migratedAtMs = T - 4 * 60_000;
    let f = patch(passingFacts(), migrationKey(MINT), { migratedAtMs, graduatedAtMs: migratedAtMs });
    const p = { quote: 200_000_000_000n, base: 206_900_000_000_000n };
    f = patch(f, candlesKey(MINT), { candles: [{ startMs: migratedAtMs + 3 * 60_000, open: p, high: p, close: p }] });
    const w = world(f);
    w.step();
    expect(w.strategy.watchedPools().has(POOL_ADDRESS)).toBe(true);
    const at = { ...NOW, receivedAt: T + 60_000 };
    const d = w.step('chain:slot', at);
    expect(w.strategy.watchedPools().has(POOL_ADDRESS)).toBe(false);
    expect(d.some((x) => x.reasons.includes('chase-at-5m'))).toBe(true);
    const control = world(f, session(), { universe: 'U1', s0Diagnostic: true });
    control.step(migrationKey(MINT), at);
    expect(control.strategy.watchedPools().has(POOL_ADDRESS)).toBe(true);
    const diagnostic = world(f, session(), { s0Diagnostic: true });
    diagnostic.step(migrationKey(MINT), at);
    expect(diagnostic.strategy.watchedPools().has(POOL_ADDRESS)).toBe(false);
  });

  it('H16 on the checkpoint candles overrides even a known dust reject', () => {
    const f = patch(passingFacts(), migrationKey(MINT), { quoteAtMigration: 1n });
    f.delete(candlesKey(MINT));
    const w = world(f);
    w.step();
    expect(w.strategy.watchedPools().has(POOL_ADDRESS)).toBe(true);
  });

  it('waits for a coherent read batch to close and drops on that exact event', () => {
    const f = patch(passingFacts(), migrationKey(MINT), { quoteAtMigration: 1n });
    const w = world(f);
    w.step(RAW.batchOpen(MINT), NOW, { mint: MINT });
    w.step();
    expect(w.strategy.watchedPools().has(POOL_ADDRESS)).toBe(true);
    const d = w.step(RAW.batchClose(MINT), NOW, { mint: MINT, slot: NOW.slot });
    expect(w.strategy.watchedPools().has(POOL_ADDRESS)).toBe(false);
    expect(d.some((x) => x.reasons[0] === 'pool watch stopped')).toBe(true);
  });

  it('never stops a watch for a transient liquidity floor or candle spike', () => {
    const floor = world(patch(passingFacts(), poolKey(MINT), { quoteVault: 1n }));
    floor.step();
    expect(floor.strategy.watchedPools().has(POOL_ADDRESS)).toBe(true);
    const spike = world(patch(passingFacts(), candlesKey(MINT), { candles: [{ startMs: T - 60_000, open: { quote: 100n, base: 1_000_000n }, high: { quote: 500n, base: 1_000_000n }, close: { quote: 100n, base: 1_000_000n } }] }));
    spike.step();
    expect(spike.strategy.watchedPools().has(POOL_ADDRESS)).toBe(true);
  });

  it('a stopped migration still receives its +30 minute survival read and is never producer-retired early', async () => {
    const f = patch(passingFacts(), migrationKey(MINT), { migratedAtMs: T, graduatedAtMs: T, quoteAtMigration: 1n });
    const w = world(f);
    w.step();
    expect(w.strategy.watchedPools().has(POOL_ADDRESS)).toBe(false);
    const timers = new ManualTimers(T);
    const reads: string[] = [];
    const src = new LiveFacts({ readers: () => ({
      readAccounts: async (m) => { reads.push(m); return true; }, readHolders: async () => true, readHoldersAll: async () => true,
      readCrossChecks: async () => [], readMintHistory: async () => true, readSolUsd: async () => true,
    }), tickMs: 1_000, minReadGapMs: 60_000, survivalAfterMs: session().policy.regime.survivalAfterMs, survivalReadDelayMs: 5_000,
    solUsdStartHours: 27, mintHistory: { maxPages: 20, funderPages: 3, funderTransactions: 10, insiderSlots: 2, firstBuyers: 20 } });
    src.start({ sink: { fact: () => {}, now: () => timers.now() }, timers, schedulers: {
      helius: new Scheduler(HELIUS_FREE, { timers }), alchemy: new Scheduler(ALCHEMY_FREE, { timers }),
      jupiter: new Scheduler(JUPITER_FREE, { timers }), rugcheck: new Scheduler(RUGCHECK_FREE, { timers }),
    }, watched: () => w.strategy.watched(), candidates: () => w.strategy.candidates(), ingest: { ingest: () => {} }, tip: () => NOW.slot });
    for (let k = 0; k < 10; k++) await Promise.resolve();
    timers.advance(30 * 60_000 + 4_000);
    for (let k = 0; k < 10; k++) await Promise.resolve();
    expect(reads).toEqual([]);
    expect(w.strategy.retired()).toEqual([]);
    timers.advance(1_000);
    for (let k = 0; k < 10; k++) await Promise.resolve();
    expect(reads).toEqual([MINT]);
    w.step('chain:slot', { ...NOW, receivedAt: timers.now() });
    expect(w.strategy.candidates().has(MINT)).toBe(true);
    expect(w.strategy.retired()).toEqual([]);
    src.stop();
  });

  it('protects a pending seed and restores candidate drops only from proven gate facts', () => {
    const f = patch(passingFacts(), migrationKey(MINT), { quoteAtMigration: 1n });
    const migration = f.get(migrationKey(MINT))!.value as { migratedAtMs: number; obs: { slot: bigint } };
    const candidate = { mint: MINT, pool: POOL_ADDRESS, migratedAtMs: migration.migratedAtMs, migrationSlot: migration.obs.slot, tries: 0, lastEvalMs: null, lastReason: 'hard reject H8 dust-at-migration', bars: [], fees: null };
    const restore = { exits: {}, candidates: [candidate] };
    const dropped = world(f);
    dropped.step(RESTORE_KEY, NOW, restore);
    expect(dropped.strategy.watchedPools().has(POOL_ADDRESS)).toBe(false);
    const unknown = world(new Map());
    unknown.step(RESTORE_KEY, NOW, restore);
    expect(unknown.strategy.watchedPools().has(POOL_ADDRESS)).toBe(true);
    const protectedCoin = world(f);
    const book = emptyBook({ maxOpenPositions: 1 });
    protectedCoin.setBook({ ...book, intents: { 'en:pending': pendingEntry() } });
    const d = protectedCoin.step(RESTORE_KEY, NOW, { ...restore, seeds: { 'en:pending': { mint: MINT, universe: 'U2', notional: 1n, stopPrice: 1n, entryReserve: 1n } } });
    expect(d.some((x) => x.reasons[0] === 'pool watch stopped')).toBe(false);
    expect(protectedCoin.strategy.watchedPools().get(POOL_ADDRESS)?.held).toBe(true);
  });

  it('never sheds an entry intent, any nonclosed position or a late position on a stopped candidate', () => {
    const f = patch(passingFacts(), migrationKey(MINT), { quoteAtMigration: 1n });
    const empty = emptyBook({ maxOpenPositions: 1 });
    for (const status of ['candidate', 'cancelled'] as const) {
      const w = world(f);
      const entry = { ...pendingEntry(), status };
      w.setBook({ ...empty, intents: { [entry.intent.id]: entry } });
      expect(w.step().some((d) => d.reasons[0] === 'pool watch stopped')).toBe(false);
      expect(w.strategy.watchedPools().get(POOL_ADDRESS)?.held).toBe(true);
    }
    const position = newPosition({ id: positionId(`p:${MINT}:1`), mint: mint(MINT), venue: 'pumpswap', entryIntentId: intentId('en:pending') });
    for (const status of ['opening', 'open', 'exit_requested', 'exit_pending', 'exit_blocked'] as const) {
      const w = world(f);
      w.setBook({ ...empty, positions: { [position.id]: { ...position, status } } });
      expect(w.step().some((d) => d.reasons[0] === 'pool watch stopped'), status).toBe(false);
      expect(w.strategy.watchedPools().get(POOL_ADDRESS)?.held, status).toBe(true);
    }
    const late = world(f);
    late.step();
    expect(late.strategy.watchedPools().has(POOL_ADDRESS)).toBe(false);
    late.setBook({ ...empty, positions: { [position.id]: position } });
    late.step('chain:slot', { ...NOW, receivedAt: T + 400 });
    expect(late.strategy.watchedPools().get(POOL_ADDRESS)?.held).toBe(true);
  });

  it('keeps the normal reject log but never starts a swap tail for a proven immutable reject', () => {
    const f = patch(passingFacts(), migrationKey(MINT), { quoteAtMigration: 1n });
    f.set(HALT_KEY, { value: { halted: false, reasons: [] }, moment: NOW });
    const w = world(f);
    const before = w.step();
    expect(before.some((d) => d.reasons[0] === 'reject')).toBe(true);
    expect(w.strategy.candidates().get(MINT)?.lastEvalMs).not.toBeNull();
    const migratedAtMs = (f.get(migrationKey(MINT))!.value as { migratedAtMs: number }).migratedAtMs;
    w.step('chain:slot', { ...NOW, receivedAt: migratedAtMs + w.config.windowToMs });
    expect(w.strategy.candidates().has(MINT)).toBe(false);
    expect(w.strategy.tail.has(MINT)).toBe(false);
    expect(w.strategy.watchedPools().has(POOL_ADDRESS)).toBe(false);
  });

  it('never re-watches a stopped pool on repeated syncs and releases its memo with the retired candidate', () => {
    const w = world();
    w.step();
    let adds = 0;
    let removes = 0;
    const pools = new PoolWatch({ stream: { watchLogs: () => ++adds, unwatch: () => { removes++; }, setPriority: () => true },
      timers: new ManualTimers(T), pools: () => w.strategy.watchedPools(), everyMs: 2_000 });
    pools.sync();
    expect(adds).toBe(1);
    const row = w.facts.get(migrationKey(MINT))!;
    const migration = row.value as { migratedAtMs: number };
    w.facts.set(migrationKey(MINT), { ...row, value: { ...(row.value as object), quoteAtMigration: 1n } });
    w.step();
    for (let k = 0; k < 100; k++) pools.sync();
    expect([adds, removes, pools.watching.size]).toEqual([1, 1, 0]);
    const end = { ...NOW, receivedAt: migration.migratedAtMs + w.config.windowToMs };
    w.step('chain:slot', end);
    expect(w.strategy.sizes()).toMatchObject({ cands: 0, pool_of_mint: 0, mint_of_pool: 0 });
    // At the strategy boundary a later rediscovery is judged from its facts again, never suppressed by a stale ID.
    // The production producer's tombstone policy remains S1's; this checks only the swap-retirement memo lifecycle.
    const again = { ...end, receivedAt: end.receivedAt + 1 };
    w.facts.set(migrationKey(MINT), { moment: again, value: { ...(row.value as object), migratedAtMs: again.receivedAt, graduatedAtMs: again.receivedAt } });
    w.step(migrationKey(MINT), again);
    expect(w.strategy.watchedPools().get(POOL_ADDRESS)?.held).toBe(false);
    pools.sync();
    expect([adds, removes, pools.watching.size]).toEqual([2, 1, 1]);
  });

  it('recorded H8/H9/H11/create-expired drops replay at the identical event, ten times each', async () => {
    const base = passingFacts();
    const migration = base.get(migrationKey(MINT))!.value as { graduatedAtMs: number; migratedAtMs: number };
    const p = { quote: 200_000_000_000n, base: 206_900_000_000_000n };
    const cases: [string, string, Record<string, unknown>][] = [
      ['dust-at-migration', migrationKey(MINT), { quoteAtMigration: 1n }],
      ['instant-graduation', createKey(MINT), { createdAtMs: migration.graduatedAtMs }],
      ['chase-at-5m', candlesKey(MINT), { candles: [{ startMs: migration.migratedAtMs + 4 * 60_000, open: p, high: p, close: p }] }],
      ['create-expired', createKey(MINT), { createdAtMs: migration.migratedAtMs - 12 * 3_600_000 - 1 }],
    ];
    for (const [code, key, change] of cases) {
      const h = makeWorker({ strategy: { windowFromMs: 120 * 60_000 } });
      await h.worker.reconcile();
      const market = await passingMarket(h, { heldPoolFacts: true, omit: [key] });
      market.omit = new Set();
      market.fact(key, { ...(base.get(key)!.value as object), ...change });
      await market.run(3_000, 400, () => { market.slot(); market.pool(); });
      expect(h.worker.strategy.watchedPools().has(POOL_ADDRESS), code).toBe(false);
      expect(h.worker.strategy.candidates().has(MINT), code).toBe(true);
      await h.worker.stop();
      const live = loadSession(h.stateDir)[0]!.live;
      const drops = live.filter((l) => l.includes('"pool watch stopped"'));
      expect(drops, code).toHaveLength(1);
      expect(drops[0], code).toContain(code);
      const r = checkSession(h.stateDir, { session: h.session, rugs: RUG_CONFIG, strategy: h.worker.strategyConfig }, replayLedgerFile, 10);
      expect(r.ok, code).toBe(true);
      expect(r.boots[0], code).toMatchObject({ deterministic: true, divergence: null, replays: 10 });
    }
  });
});
