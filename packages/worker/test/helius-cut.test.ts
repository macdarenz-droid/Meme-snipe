import { describe, expect, it } from 'vitest';
import { exitsFor, FILL_CONFIG, RESEARCH_CONFIG, RUG_CONFIG } from '../../core/src/config/index.ts';
import { emptyBook } from '../../core/src/lifecycle/book.ts';
import { newEntryIntent, newPosition } from '../../core/src/lifecycle/index.ts';
import { entryKey, intentId, mint, positionId } from '../../core/src/domain/index.ts';
import { lamports, raw } from '../../core/src/units/index.ts';
import type { StrategyContext } from '../../core/src/engine/index.ts';
import { candlesKey, createKey, deployerKey, holdersKey, migrationKey, poolKey, stagedHardRejects } from '../../core/src/gates/index.ts';
import { RAW } from '../../core/src/facts/raw.ts';
import { account, DEV, FEE_CONTEXT, MINT, NOW, POOL, POOL_ADDRESS, T, contextOf, passingFacts, patch, request, session } from '../../core/test/gates/world.ts';
import { attempt } from '../../core/test/fixtures.ts';
import { FactProducer } from '../../core/src/facts/producer.ts';
import { OPTIONS } from '../../core/test/facts/helpers.ts';
import { FakeSocketHub } from '../src/providers/index.ts';
import { DEFAULT_LIVE_FEED, LiveFeed, rpcHandler, scriptedHttp } from '../src/providers/index.ts';
import { RpcSocket } from '../src/providers/rpc-socket.ts';
import { SOCKET_BYTE_KINDS } from '../src/providers/rpc-socket.ts';
import { ALCHEMY_FREE, HELIUS_FREE, JUPITER_FREE, RUGCHECK_FREE, Scheduler, HELIUS_WS_CREDITS_PER_BYTE, HELIUS_WS_CREDITS_PER_CONNECTION, ManualTimers } from '../src/scheduler/index.ts';
import { HALT_KEY, SOL_PRICE_KEY, feesKey, LiveStrategy, RESTORE_KEY, type StrategyConfig } from '../src/engine/strategy.ts';
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

  it.each([true, false])('preserves a held exit receipt with a shared server ID (new ACK first: %s)', (reverse) => {
      const w = world();
      w.step();
      const hub = new FakeSocketHub();
      const timers = new ManualTimers(T);
      const rpc = new RpcSocket('held', () => 'wss://ws.test', hub.factory, timers, { initialMs: 1_000, maxMs: 8_000, idleMs: 60_000 });
      const served: unknown[] = [];
      const priorities: number[] = [];
      const pools = new PoolWatch({ stream: {
        watchLogs: (pool, opts) => { priorities.push(opts.priority); return rpc.add({ method: 'logsSubscribe', params: [{ mentions: [pool] }, { commitment: opts.commitment }], unsubscribe: 'logsUnsubscribe', notification: 'logsNotification', onNotify: (r) => served.push(r) }); },
        unwatch: (id) => rpc.remove(id), setPriority: () => true,
      }, timers, pools: () => w.strategy.watchedPools(), everyMs: 2_000 });
      rpc.start(); hub.last.open(); pools.sync();
      const old = hub.last.requests()[0]!.id;
      // Create-expiry removes the candidate before its ACK; a later position needs the identical pool immediately.
      w.facts.set(createKey(MINT), expiryFacts().get(createKey(MINT))!);
      w.step(); pools.sync();
      const p = { ...newPosition({ id: positionId(`p:${MINT}:1`), mint: mint(MINT), venue: 'pumpswap', entryIntentId: intentId('en:late') }), status: 'exit_blocked' as const, quantity: raw(100n), bought: raw(100n), cost: lamports(100n) };
      const book = emptyBook({ maxOpenPositions: 1 });
      w.setBook({ ...book, positions: { [p.id]: p } });
      w.step('chain:slot', { ...NOW, receivedAt: T + 400 }); pools.sync();
      const next = hub.last.requests().findLast((r) => r.method === 'logsSubscribe')!.id;
      expect(next).not.toBe(old);
      for (const id of reverse ? [next, old] : [old, next]) hub.last.push({ jsonrpc: '2.0', id, result: 701 });
      expect(w.strategy.watchedPools().get(POOL_ADDRESS)?.held).toBe(true);
      expect(priorities.at(-1)).toBe(1);
      expect(hub.last.requests().filter((r) => r.method === 'logsUnsubscribe')).toEqual([]);
      hub.last.push({ method: 'logsNotification', params: { subscription: 701, result: 'exit-sell-trigger' } });
      expect(served).toEqual(['exit-sell-trigger']);
      rpc.stop();
  });

  it.each(['refused', 'removed', 'different ID'] as const)('cleans the deferred ghost after its replacement is %s', (outcome) => {
    const hub = new FakeSocketHub();
    const rpc = new RpcSocket('test', () => 'wss://ws.test', hub.factory, new ManualTimers(T), { initialMs: 1_000, maxMs: 8_000, idleMs: 60_000 });
    const seen: unknown[] = [];
    const spec = { method: 'logsSubscribe', params: [{ mentions: [MINT] }, { commitment: 'confirmed', encoding: 'json' }], unsubscribe: 'logsUnsubscribe', notification: 'logsNotification', onNotify: (r: unknown) => seen.push(r) };
    const old = rpc.add(spec); rpc.start(); hub.last.open(); const oldId = hub.last.requests()[0]!.id;
    rpc.remove(old); const next = rpc.add({ ...spec, params: [{ mentions: [MINT] }, { encoding: 'json', commitment: 'confirmed' }] }); const nextId = hub.last.requests()[1]!.id;
    hub.last.push({ jsonrpc: '2.0', id: oldId, result: 701 });
    expect(hub.last.requests().filter((r) => r.method === 'logsUnsubscribe')).toEqual([]);
    if (outcome === 'removed') rpc.remove(next);
    else hub.last.push({ jsonrpc: '2.0', id: nextId, ...(outcome === 'refused' ? { error: { code: -1 } } : { result: 702 }) });
    expect(hub.last.requests().filter((r) => r.method === 'logsUnsubscribe').map((r) => r.params)).toEqual([[701]]);
    hub.last.push({ method: 'logsNotification', params: { subscription: 701, result: 'ghost' } });
    expect(seen).toEqual([]);
    if (outcome === 'different ID') {
      hub.last.push({ method: 'logsNotification', params: { subscription: 702, result: 'desired' } });
      expect(seen).toEqual(['desired']); rpc.remove(next);
      expect(hub.last.requests().filter((r) => r.method === 'logsUnsubscribe').map((r) => r.params)).toEqual([[701], [702]]);
    }
    rpc.stop();
  });

  it('unsubscribes a shared server ID only when its last desired owner leaves', () => {
    const hub = new FakeSocketHub();
    let bytes = 0;
    const rpc = new RpcSocket('test', () => 'wss://ws.test', hub.factory, new ManualTimers(T), { initialMs: 1_000, maxMs: 8_000, idleMs: 60_000 }, { onBytes: (n) => { bytes += n; } });
    const seen: unknown[][] = [[], []];
    const handles = seen.map((s) => rpc.add({ method: 'logsSubscribe', params: [MINT], unsubscribe: 'logsUnsubscribe', notification: 'logsNotification', onNotify: (r) => s.push(r) }));
    rpc.start(); hub.last.open();
    for (const r of hub.last.requests()) hub.last.push({ jsonrpc: '2.0', id: r.id, result: 701 });
    const frame = { method: 'logsNotification', params: { subscription: 701, result: 'both' } };
    const before = bytes; hub.last.push(frame);
    expect(bytes - before).toBe(Buffer.byteLength(JSON.stringify(frame)));
    expect(seen).toEqual([['both'], ['both']]);
    rpc.remove(handles[0]!);
    expect(hub.last.requests().filter((r) => r.method === 'logsUnsubscribe')).toEqual([]);
    hub.last.push({ method: 'logsNotification', params: { subscription: 701, result: 'last' } });
    expect(seen).toEqual([['both'], ['both', 'last']]);
    rpc.remove(handles[1]!);
    expect(hub.last.requests().filter((r) => r.method === 'logsUnsubscribe').map((r) => r.params)).toEqual([[701]]);
    rpc.stop();
  });

  it('bounds abandoned ACK metadata by reconnecting and discards deferred IDs across stop/start', () => {
    const hub = new FakeSocketHub(); const timers = new ManualTimers(T);
    const rpc = new RpcSocket('test', () => 'wss://ws.test', hub.factory, timers, { initialMs: 1_000, maxMs: 8_000, idleMs: 60_000 });
    const seen: unknown[] = [];
    const spec = { method: 'logsSubscribe', params: [MINT], unsubscribe: 'logsUnsubscribe', notification: 'logsNotification', onNotify: (r: unknown) => seen.push(r) };
    rpc.start(); hub.last.open();
    for (let n = 0; n < 257; n++) rpc.remove(rpc.add(spec));
    expect(rpc.socket.state).toBe('waiting'); expect(rpc.size).toBe(0);
    timers.advance(1_000); hub.last.open();
    const old = rpc.add(spec); const oldId = hub.last.requests()[0]!.id;
    rpc.remove(old); rpc.add(spec);
    hub.last.push({ jsonrpc: '2.0', id: oldId, result: 701 });
    expect(hub.last.requests().filter((r) => r.method === 'logsUnsubscribe')).toEqual([]);
    const stale = hub.last.onmessage!;
    rpc.stop(); rpc.start(); hub.last.open();
    hub.last.push({ jsonrpc: '2.0', id: hub.last.requests()[0]!.id, result: 701 });
    stale({ data: JSON.stringify({ jsonrpc: '2.0', id: oldId, result: 701 }) });
    expect(hub.last.requests().filter((r) => r.method === 'logsUnsubscribe')).toEqual([]);
    hub.last.push({ method: 'logsNotification', params: { subscription: 701, result: 'held' } });
    expect(seen).toEqual(['held']); rpc.stop();
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

const world = (facts = passingFacts(), s = session(), over: Partial<StrategyConfig> = {}, observedCoverage = true) => {
  const config = { ...strategyConfig(s.policy, FILL_CONFIG, RESEARCH_CONFIG, 0n, { timing: 'gates', salt: '' }), ...over };
  const strategy = new LiveStrategy({ session: s, rugs: RUG_CONFIG, config });
  let book = emptyBook({ maxOpenPositions: s.policy.positions.maxOpen });
  const step = (key = migrationKey(MINT), now = NOW, value?: unknown) => {
    const gctx = contextOf(facts, now);
    const ctx: StrategyContext = { ...gctx, book, rng: { next: () => 0 } as never };
    const r = gctx.lookup(key);
    return strategy.onMarket({ kind: 'market', id: `cut:${key}:${now.receivedAt}`, moment: now, key, value: value ?? (r.ok ? r.value : null) }, ctx);
  };
  // The live evaluator uses the strategy's own deployer index; known fixtures must observe its real coverage start.
  const start = facts.get('coverage:creates:start');
  if (observedCoverage && start !== undefined) step('coverage:creates:start', start.moment, start.value);
  return { strategy, step, facts, config, setBook: (b: typeof book) => { book = b; } };
};

const pendingEntry = () => newEntryIntent({ id: intentId('en:pending'), key: entryKey(mint(MINT), 'U2.1.1'), mint: mint(MINT), purpose: 'entry', side: 'buy', venue: 'pumpswap', positionId: positionId(`p:${MINT}:1`), spend: lamports(1n) });
const instantFacts = (f = passingFacts()) => patch(f, createKey(MINT), { createdAtMs: (f.get(migrationKey(MINT))!.value as { graduatedAtMs: number }).graduatedAtMs });
const expiryFacts = (f = passingFacts()) => patch(f, createKey(MINT), { createdAtMs: (f.get(migrationKey(MINT))!.value as { migratedAtMs: number }).migratedAtMs - 12 * 3_600_000 - 1 });

describe('gate-proven pool retirement', () => {
  it('retains H9 producer inputs and actual worker reasons before and after restore, with no normal unwatch gap', () => {
    const f = passingFacts();
    const stream = `trades:${POOL_ADDRESS}`;
    const candles = f.get(candlesKey(MINT))!;
    const value = candles.value as { obs: object };
    f.set(candlesKey(MINT), { ...candles, value: { ...value, obs: { ...value.obs, stream } } });
    const producer = new FactProducer(OPTIONS);
    const writes = (key: string, value: unknown, now = NOW) => {
      for (const w of producer.observe({ kind: 'market', id: `producer:${key}:${now.receivedAt}`, moment: now, key, value })) f.set(w.key, { value: w.value, moment: now });
    };
    writes(`coverage:${stream}:start`, { value: { fromSlot: NOW.slot - 20_000n, via: `logs:${POOL_ADDRESS}` }, seq: 1 });
    writes('chain:slot', { slot: NOW.slot });
    const read = { mint: MINT, slot: NOW.slot - 1n, commitment: 'confirmed', accounts: [MINT, POOL_ADDRESS, POOL.poolBaseTokenAccount, POOL.poolQuoteTokenAccount].map((address) => {
      const a = account(address); return { address, owner: a.owner, data: a.dataBase64 };
    }) };
    writes(RAW.accounts(MINT), read);
    f.set(HALT_KEY, { value: { halted: false }, moment: NOW });
    f.set(SOL_PRICE_KEY, { value: { value: 150_000_000n, atMs: T }, moment: NOW });
    f.set(feesKey(MINT), { value: FEE_CONTEXT, moment: NOW });
    const w = world(f); w.step();
    const later = { ...NOW, slot: NOW.slot + 2n, receivedAt: T + 5_000 };
    const unwatch: string[] = [];
    const pools = new PoolWatch({ stream: { watchLogs: () => 1, setPriority: () => true, unwatch: (_id, reason) => {
      unwatch.push(reason ?? '');
      writes(`coverage:${stream}:gap`, { value: { fromSlot: NOW.slot + 1n, toSlot: null, reason, via: `logs:${POOL_ADDRESS}` }, seq: 2 }, later);
    } }, timers: new ManualTimers(T), pools: () => w.strategy.watchedPools(), everyMs: 2_000 });
    pools.sync(); expect(pools.watching.size).toBe(1);
    // Real account bytes initialize and refresh the actual reserve chain before the possible unwatch. No pool fact
    // is invented or refreshed afterward: the real producer must expose any gap's partial/flagged pool to the worker.
    writes(RAW.accounts(MINT), { ...read, slot: later.slot }, later);
    writes('chain:slot', { slot: later.slot }, later);
    f.set(createKey(MINT), instantFacts(f).get(createKey(MINT))!);
    const next = { ...later, receivedAt: later.receivedAt + w.config.evaluateEveryMs };
    // Execution-health/other off-chain observations are current on both sides; no pool account is refreshed here.
    for (const [key, row] of f) {
      const v = row.value as { obs?: { slot: bigint | null; receivedAt: number } };
      if (v.obs?.slot === null) f.set(key, { moment: next, value: { ...v, obs: { ...v.obs, receivedAt: next.receivedAt } } });
    }
    const control = world(new Map(f));
    w.step(createKey(MINT), later); pools.sync();
    control.step(migrationKey(MINT), next);
    w.step('chain:slot', next, { slot: next.slot });
    expect(control.strategy.candidates().get(MINT)?.gates?.[0]).toMatchObject({ gate: 'H9', code: 'instant-graduation' });
    expect(w.strategy.candidates().get(MINT)?.gates?.[0]).toMatchObject({ gate: 'H9', code: 'instant-graduation' });
    expect(unwatch).toEqual([]);
    const m = f.get(migrationKey(MINT))!.value as { migratedAtMs: number; obs: { slot: bigint } };
    const restored = world(new Map(f));
    restored.step(RESTORE_KEY, next, { exits: {}, candidates: [{ mint: MINT, pool: POOL_ADDRESS, migratedAtMs: m.migratedAtMs, migrationSlot: m.obs.slot, tries: 0, lastEvalMs: T - 5_000, lastReason: 'hard reject H9 instant-graduation', bars: [], fees: null }] });
    expect(restored.strategy.candidates().get(MINT)?.gates?.[0]).toMatchObject({ gate: 'H9', code: 'instant-graduation' });
    expect(restored.strategy.watchedPools().has(POOL_ADDRESS)).toBe(true);
  });

  it.each(['H9', 'create-expired'] as const)('restores the %s window that ended during downtime with the same tail protection as live', (kind) => {
    const config = strategyConfig(session().policy, FILL_CONFIG, RESEARCH_CONFIG, 0n, { timing: 'gates', salt: '' });
    const migratedAtMs = T - config.windowToMs + 1_000;
    let f = patch(passingFacts(), migrationKey(MINT), { migratedAtMs, graduatedAtMs: migratedAtMs });
    const price = (f.get(migrationKey(MINT))!.value as { price: object }).price;
    f = patch(f, candlesKey(MINT), { candles: [{ startMs: migratedAtMs + 4 * 60_000, open: price, high: price, close: price }] });
    f = kind === 'H9' ? instantFacts(f) : expiryFacts(f);
    f.set(HALT_KEY, { value: { halted: false }, moment: NOW });
    f.set(SOL_PRICE_KEY, { value: { value: 150_000_000n, atMs: T }, moment: NOW });
    f.set(feesKey(MINT), { value: FEE_CONTEXT, moment: NOW });
    const live = world(f); live.step();
    const m = f.get(migrationKey(MINT))!.value as { migratedAtMs: number; obs: { slot: bigint } };
    const saved = { exits: {}, candidates: [{ mint: MINT, pool: POOL_ADDRESS, migratedAtMs: m.migratedAtMs, migrationSlot: m.obs.slot, tries: 0, lastEvalMs: T, lastReason: kind === 'H9' ? 'hard reject H9 instant-graduation' : 'create expired', bars: [], fees: null }] };
    // The original locked window expires during a short downtime; the existing as-of facts are genuinely fresh.
    const now = { ...NOW, receivedAt: m.migratedAtMs + live.config.windowToMs + 1 };
    live.step('chain:slot', now);
    const restored = world(f); restored.step(RESTORE_KEY, now, saved);
    const expected = kind === 'H9' ? { pool: POOL_ADDRESS, untilMs: m.migratedAtMs + live.config.windowToMs + exitsFor(session().policy.exits, live.config.universe).tMaxMs } : undefined;
    expect(live.strategy.tail.get(MINT)).toEqual(expected);
    expect(restored.strategy.tail.get(MINT)).toEqual(expected);
    expect(restored.strategy.watchedPools().has(POOL_ADDRESS)).toBe(kind === 'H9');
    if (expected !== undefined) {
      expect(restored.strategy.retired()).toEqual([]);
      const end = { ...now, receivedAt: expected.untilMs + 1 };
      live.step('chain:slot', end); restored.step('chain:slot', end);
      expect(live.strategy.watchedPools().has(POOL_ADDRESS)).toBe(false);
      expect(restored.strategy.watchedPools().has(POOL_ADDRESS)).toBe(false);
      expect(restored.strategy.retired()).toContain(POOL_ADDRESS);
    }
  });

  it.each(['missing', 'partial', 'position', 'cancelled entry'] as const)('an expired-window restore preserves create-expiry pools protected by %s', (protection) => {
    const f = expiryFacts();
    if (protection === 'missing') f.delete(holdersKey(MINT));
    if (protection === 'partial') {
      const row = f.get(holdersKey(MINT))!; const value = row.value as { obs: object };
      f.set(holdersKey(MINT), { ...row, value: { ...value, obs: { ...value.obs, quality: ['partial'] } } });
    }
    const w = world(f);
    const book = emptyBook({ maxOpenPositions: 1 });
    if (protection === 'position') {
      const p = newPosition({ id: positionId(`p:${MINT}:1`), mint: mint(MINT), venue: 'pumpswap', entryIntentId: intentId('en:late') });
      w.setBook({ ...book, positions: { [p.id]: p } });
    }
    if (protection === 'cancelled entry') {
      const i = { ...pendingEntry(), status: 'cancelled' as const };
      w.setBook({ ...book, intents: { [i.intent.id]: i } });
    }
    const m = f.get(migrationKey(MINT))!.value as { migratedAtMs: number; obs: { slot: bigint } };
    const now = { ...NOW, receivedAt: m.migratedAtMs + w.config.windowToMs + 60_000 };
    const decisions = w.step(RESTORE_KEY, now, { exits: {}, candidates: [{ mint: MINT, pool: POOL_ADDRESS, migratedAtMs: m.migratedAtMs, migrationSlot: m.obs.slot, tries: 0, lastEvalMs: T, lastReason: 'create expired', bars: [], fees: null }] });
    expect(decisions.some((d) => d.reasons[0] === 'pool watch stopped')).toBe(false);
    expect(w.strategy.candidates().has(MINT)).toBe(false);
    expect(w.strategy.tail.has(MINT)).toBe(true);
    expect(w.strategy.watchedPools().get(POOL_ADDRESS)?.held).toBe(protection === 'position');
    expect(w.strategy.retired()).toEqual([]);
  });
  it('full stage-one H16 keeps H9 alongside missing or partial deployer evidence', () => {
    const base = passingFacts();
    const migration = base.get(migrationKey(MINT))!.value as { graduatedAtMs: number };
    for (const partial of [false, true]) {
      const f = patch(base, createKey(MINT), { createdAtMs: migration.graduatedAtMs });
      if (!partial) f.delete(deployerKey(DEV));
      else {
        const row = f.get(deployerKey(DEV))!;
        const value = row.value as { obs: object };
        f.set(deployerKey(DEV), { ...row, value: { ...value, obs: { ...value.obs, quality: ['partial'] } } });
      }
      const actual = stagedHardRejects(contextOf(f, NOW), { session: session(), mode: 'live', rugLabeller: 'RUG-1' }, request());
      expect(actual.hard.reasons.some((r) => r.gate === 'H9' && r.code === 'instant-graduation')).toBe(true);
      expect(actual.hard.reasons.some((r) => r.gate === 'H16' && r.neededBy === 'H14')).toBe(true);
      const w = world(f, session(), {}, false); const decisions = w.step();
      expect(w.strategy.watchedPools().has(POOL_ADDRESS)).toBe(true);
      expect(decisions.some((d) => d.reasons[0] === 'pool watch stopped')).toBe(false);
    }
  });

  it.each(['candidate', 'cancelled'] as const)('preserves a %s entry watch through its window, at canonical money priority', (status) => {
      const w = world(); const entry = { ...pendingEntry(), status };
      const book = emptyBook({ maxOpenPositions: 1 });
      w.setBook({ ...book, intents: { [entry.intent.id]: entry } }); w.step();
      expect(w.strategy.watchedPools().get(POOL_ADDRESS)?.held).toBe(status === 'candidate');
      const migration = w.facts.get(migrationKey(MINT))!.value as { migratedAtMs: number };
      w.step('chain:slot', { ...NOW, receivedAt: migration.migratedAtMs + w.config.windowToMs });
      expect(w.strategy.watchedPools().get(POOL_ADDRESS)?.held).toBe(status === 'candidate');
      expect(w.strategy.retired()).toEqual([]);
      w.setBook(book); w.step('chain:slot', { ...NOW, receivedAt: migration.migratedAtMs + w.config.windowToMs + 1 });
      expect(w.strategy.watchedPools().has(POOL_ADDRESS)).toBe(false);
      expect(w.strategy.retired()).toContain(POOL_ADDRESS);
  });

  it('full later-stage H16 keeps create-expiry watches with missing or partial holders', () => {
    const base = passingFacts();
    const migration = base.get(migrationKey(MINT))!.value as { migratedAtMs: number };
    for (const partial of [false, true]) {
      const f = patch(base, createKey(MINT), { createdAtMs: migration.migratedAtMs - 12 * 3_600_000 - 1 });
      if (!partial) f.delete(holdersKey(MINT));
      else {
        const row = f.get(holdersKey(MINT))!; const value = row.value as { obs: object };
        f.set(holdersKey(MINT), { ...row, value: { ...value, obs: { ...value.obs, quality: ['partial'] } } });
      }
      const actual = stagedHardRejects(contextOf(f, NOW), { session: session(), mode: 'live', rugLabeller: 'RUG-1' }, request());
      expect(actual.hard.reasons.some((r) => r.gate === 'H16' && r.neededBy === 'H12')).toBe(true);
      const w = world(f); const decisions = w.step();
      expect(w.strategy.watchedPools().has(POOL_ADDRESS)).toBe(true);
      expect(decisions.some((d) => d.reasons[0] === 'pool watch stopped')).toBe(false);
    }
  });

  it('a cancelled entry with a possibly broadcast attempt remains money traffic through its window', () => {
    const w = world(expiryFacts()); const pending = pendingEntry();
    const entry = { ...pending, status: 'cancelled' as const, attempts: [attempt(pending.intent.id, 1, NOW.slot + 1_000n)] };
    const book = emptyBook({ maxOpenPositions: 1 });
    w.setBook({ ...book, intents: { [entry.intent.id]: entry } });
    expect(w.step().some((d) => d.reasons[0] === 'pool watch stopped')).toBe(false);
    expect(w.strategy.committed(MINT)).toBe(true);
    expect(w.strategy.watchedPools().get(POOL_ADDRESS)?.held).toBe(true);
    const migration = w.facts.get(migrationKey(MINT))!.value as { migratedAtMs: number };
    w.step('chain:slot', { ...NOW, receivedAt: migration.migratedAtMs + w.config.windowToMs });
    expect(w.strategy.watchedPools().get(POOL_ADDRESS)?.held).toBe(true);
    expect(w.strategy.retired()).toEqual([]);
  });
  it('keeps H8 dust swaps observed for counterfactual evidence, with candidate and fact watches', () => {
    const w = world(patch(passingFacts(), migrationKey(MINT), { quoteAtMigration: 1n }));
    const decisions = w.step();
    expect(w.strategy.watchedPools().has(POOL_ADDRESS)).toBe(true);
    expect(w.strategy.watched().has(MINT)).toBe(true);
    expect(w.strategy.candidates().has(MINT)).toBe(true);
    expect(w.strategy.retired()).toEqual([]);
    expect(decisions.some((d) => d.reasons[0] === 'pool watch stopped')).toBe(false);
  });

  it('retains H9 and drops only the shared create-expired verdict', () => {
    const base = passingFacts();
    const migration = base.get(migrationKey(MINT))!.value as { graduatedAtMs: number; migratedAtMs: number };
    for (const createdAtMs of [migration.graduatedAtMs, migration.migratedAtMs - 12 * 3_600_000 - 1]) {
      const w = world(patch(base, createKey(MINT), { createdAtMs }));
      w.step();
      expect(w.strategy.watchedPools().has(POOL_ADDRESS)).toBe(createdAtMs === migration.graduatedAtMs);
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
    expect(tightened.strategy.watchedPools().has(POOL_ADDRESS)).toBe(true);
  });

  it('keeps H11 observations at the checkpoint in U2, U1 and diagnostic mode', () => {
    const migratedAtMs = T - 4 * 60_000;
    let f = patch(passingFacts(), migrationKey(MINT), { migratedAtMs, graduatedAtMs: migratedAtMs });
    const p = { quote: 200_000_000_000n, base: 206_900_000_000_000n };
    f = patch(f, candlesKey(MINT), { candles: [{ startMs: migratedAtMs + 3 * 60_000, open: p, high: p, close: p }] });
    const w = world(f);
    w.step();
    expect(w.strategy.watchedPools().has(POOL_ADDRESS)).toBe(true);
    const at = { ...NOW, receivedAt: T + 60_000 };
    const d = w.step('chain:slot', at);
    expect(w.strategy.watchedPools().has(POOL_ADDRESS)).toBe(true);
    expect(d.some((x) => x.reasons[0] === 'pool watch stopped')).toBe(false);
    const control = world(f, session(), { universe: 'U1', s0Diagnostic: true });
    control.step(migrationKey(MINT), at);
    expect(control.strategy.watchedPools().has(POOL_ADDRESS)).toBe(true);
    const diagnostic = world(f, session(), { s0Diagnostic: true });
    diagnostic.step(migrationKey(MINT), at);
    expect(diagnostic.strategy.watchedPools().has(POOL_ADDRESS)).toBe(true);
  });

  it('H16 on the checkpoint candles overrides even a known dust reject', () => {
    const f = patch(passingFacts(), migrationKey(MINT), { quoteAtMigration: 1n });
    f.delete(candlesKey(MINT));
    const w = world(f);
    w.step();
    expect(w.strategy.watchedPools().has(POOL_ADDRESS)).toBe(true);
  });

  it('waits for a coherent read batch to close and drops on that exact event', () => {
    const f = expiryFacts();
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
    const migratedAtMs = T - 5 * 60_000;
    let f = expiryFacts(patch(passingFacts(), migrationKey(MINT), { migratedAtMs, graduatedAtMs: migratedAtMs }));
    const price = (f.get(migrationKey(MINT))!.value as { price: object }).price;
    f = patch(f, candlesKey(MINT), { candles: [{ startMs: migratedAtMs + 4 * 60_000, open: price, high: price, close: price }] });
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
    timers.advance(25 * 60_000 + 4_000);
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
    const f = expiryFacts();
    const migration = f.get(migrationKey(MINT))!.value as { migratedAtMs: number; obs: { slot: bigint } };
    const candidate = { mint: MINT, pool: POOL_ADDRESS, migratedAtMs: migration.migratedAtMs, migrationSlot: migration.obs.slot, tries: 0, lastEvalMs: null, lastReason: 'create expired', bars: [], fees: null };
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
    const f = expiryFacts();
    const empty = emptyBook({ maxOpenPositions: 1 });
    for (const status of ['candidate', 'cancelled'] as const) {
      const w = world(f);
      const entry = { ...pendingEntry(), status };
      w.setBook({ ...empty, intents: { [entry.intent.id]: entry } });
      expect(w.step().some((d) => d.reasons[0] === 'pool watch stopped')).toBe(false);
      expect(w.strategy.watchedPools().get(POOL_ADDRESS)?.held).toBe(status === 'candidate');
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

  it('keeps H8 and H11 reject logs and counterfactual swap tails', () => {
    const base = passingFacts();
    const migratedAtMs = (base.get(migrationKey(MINT))!.value as { migratedAtMs: number }).migratedAtMs;
    const p = { quote: 200_000_000_000n, base: 206_900_000_000_000n };
    const cases = [
      { code: 'dust-at-migration', f: patch(base, migrationKey(MINT), { quoteAtMigration: 1n }) },
      { code: 'chase-at-5m', f: patch(base, candlesKey(MINT), { candles: [{ startMs: migratedAtMs + 4 * 60_000, open: p, high: p, close: p }] }) },
    ];
    for (const { f, code } of cases) {
      f.set(HALT_KEY, { value: { halted: false, reasons: [] }, moment: NOW });
      f.set(SOL_PRICE_KEY, { value: { value: 150_000_000n, atMs: T }, moment: NOW });
      f.set(feesKey(MINT), { value: FEE_CONTEXT, moment: NOW });
      expect(stagedHardRejects(contextOf(f, NOW), { session: session(), mode: 'live', rugLabeller: 'RUG-1' }, request()).hard.reasons.some((r) => r.code === code)).toBe(true);
      const w = world(f);
      const before = w.step();
      expect(before.some((d) => d.reasons[0] === 'reject' && d.reasons.some((r) => r.includes(code)))).toBe(true);
      expect(w.strategy.candidates().get(MINT)?.lastEvalMs).not.toBeNull();
      w.step('chain:slot', { ...NOW, receivedAt: migratedAtMs + w.config.windowToMs });
      expect(w.strategy.candidates().has(MINT)).toBe(false);
      expect(w.strategy.tail.has(MINT)).toBe(true);
      expect(w.strategy.watchedPools().has(POOL_ADDRESS)).toBe(true);
    }
  });

  it('keeps the normal H9 reject log and its counterfactual swap tail', () => {
    const f = instantFacts();
    f.set(HALT_KEY, { value: { halted: false, reasons: [] }, moment: NOW });
    const w = world(f); const before = w.step();
    expect(before.some((d) => d.reasons[0] === 'reject')).toBe(true);
    const migratedAtMs = (f.get(migrationKey(MINT))!.value as { migratedAtMs: number }).migratedAtMs;
    w.step('chain:slot', { ...NOW, receivedAt: migratedAtMs + w.config.windowToMs });
    expect(w.strategy.tail.has(MINT)).toBe(true);
    expect(w.strategy.watchedPools().has(POOL_ADDRESS)).toBe(true);
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
    w.facts.set(createKey(MINT), { ...w.facts.get(createKey(MINT))!, value: { ...(w.facts.get(createKey(MINT))!.value as object), createdAtMs: migration.migratedAtMs - 12 * 3_600_000 - 1 } });
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
    w.facts.set(createKey(MINT), { moment: again, value: { ...(row.value as object), ...(passingFacts().get(createKey(MINT))!.value as object) } });
    w.step(migrationKey(MINT), again);
    expect(w.strategy.watchedPools().get(POOL_ADDRESS)?.held).toBe(false);
    pools.sync();
    expect([adds, removes, pools.watching.size]).toEqual([2, 1, 1]);
  });

  it('recorded create-expired drops and retained H8/H9/H11 watches replay identically, ten times each', async () => {
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
      const retained = code !== 'create-expired';
      expect(h.worker.strategy.watchedPools().has(POOL_ADDRESS), code).toBe(retained);
      expect(h.worker.strategy.candidates().has(MINT), code).toBe(true);
      await h.worker.stop();
      const live = loadSession(h.stateDir)[0]!.live;
      const drops = live.filter((l) => l.includes('"pool watch stopped"'));
      expect(drops, code).toHaveLength(retained ? 0 : 1);
      if (!retained) expect(drops[0], code).toContain(code);
      const r = checkSession(h.stateDir, { session: h.session, rugs: RUG_CONFIG, strategy: h.worker.strategyConfig }, replayLedgerFile, 10);
      expect(r.ok, code).toBe(true);
      expect(r.boots[0], code).toMatchObject({ deterministic: true, divergence: null, replays: 10 });
    }
  });
});
