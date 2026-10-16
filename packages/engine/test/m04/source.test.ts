// A-M04-03 transport seam (card Z07): a scripted source gives byte-identical snapshots and M07 records to a poll run;
// the subscription stub refuses to start by default and polling takes over; a closing transport falls back to polling
// once and never reconnects. Red team C's reconnect storm (C3; fixed in Zeroed by #274, so the old code passes it)
// is checked on the seam and on a mutant that reverts that fix, `reconnectingMutant`, which must fail (ruling Z07-3).
// Also: batch packing and the M14 reader adapter.
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';
import type { Result, Slot } from '@bot/types';
import { gatewayAccountsReader } from '../../src/m04/reader.ts';
import { snapshotRecord } from '../../src/m04/record.ts';
import { M04_DEFAULTS } from '../../src/m04/settings.ts';
import { createPollSource, createSubscribeSource, packBatches, SubscribeRefused, type PoolSource, type SourcePool, type SourceRecord, type SubscribeTransport } from '../../src/m04/source.ts';
import { createPoolTracker } from '../../src/m04/tracker.ts';
import type { CallOptions, CallValue, RpcError, RpcGateway } from '../../src/m14/types.ts';
import { FakeTime } from '../m14/helpers.ts';
import { FakeChain, fakeModel, Logs, Metrics, Outputs, poolAccounts, ScriptedReader, u64, type FakePool } from './fake.ts';
import { startedQueue } from '../recorder/helpers.ts';

const POOLS = ['a', 'b', 'c'];

/** A poll run over 20 s with reserves changing every second; returns the tracker's outputs and what the source delivered. */
async function pollRun(): Promise<{ outputs: Outputs; delivered: Array<{ at: number; r: SourceRecord }> }> {
  const time = new FakeTime();
  const reader = new ScriptedReader();
  for (const id of POOLS) for (const [k, v] of poolAccounts(id, 1_000n, 2_000n)) reader.accounts.set(k, v);
  const chain = new FakeChain();
  reader.slot = () => chain.highest;
  const outputs = new Outputs();
  const source = createPollSource({ reader, scheduler: time, settings: M04_DEFAULTS, log: new Logs() });
  const delivered: Array<{ at: number; r: SourceRecord }> = [];
  source.onAccounts((r) => delivered.push({ at: time.now, r }));
  const tracker = createPoolTracker<FakePool>({ model: fakeModel, reader, scheduler: time, chain, clock: time, outputs, log: new Logs(), source, providerOrder: () => ['primary'] });
  POOLS.forEach((id, i) => tracker.watch(id, i === 0 ? 'position' : 'candidate'));
  await tracker.settled();
  for (let t = 1; t <= 20; t++) {
    for (const id of POOLS) reader.accounts.set(`${id}:q`, { owner: 'tok', data: u64(2_000n + BigInt(t * 7)) });
    chain.highest += 2n;
    await time.advance(1_000);
  }
  tracker.stop();
  return { outputs, delivered };
}

/** A source that replays recorded deliveries at their times (stands in for a subscription). */
function scriptedSource(time: FakeTime, script: Array<{ at: number; r: SourceRecord }>): PoolSource {
  const handlers = new Set<(r: SourceRecord) => void>();
  let armed = false;
  return {
    kind: 'account_subscribe',
    start() {
      if (armed) return;
      armed = true;
      for (const { at, r } of script) time.set(() => { for (const h of handlers) h(r); }, at - time.now);
    },
    stop() {},
    onAccounts(h) { handlers.add(h); return () => handlers.delete(h); },
  };
}

const records = (outputs: Outputs): string[] => {
  const q = startedQueue();
  for (const { s, cls } of outputs.snapshots) assert.ok(['queued', 'unchanged'].includes(q.append(snapshotRecord(s, cls, fakeModel)) as string));
  return q.take(10_000, 'seg-1').map((r) => JSON.stringify(r, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
};

describe('A-M04-03 transport seam', () => {
  it('AC: with the poll source replaced by a scripted source, M04 snapshots and M07 records are byte-identical to the poll run', async () => {
    const poll = await pollRun();
    assert.equal(poll.outputs.snapshots.length, 80, `${poll.outputs.snapshots.length} ${poll.delivered.length}`);
    const time = new FakeTime();
    const reader = new ScriptedReader();
    for (const id of POOLS) for (const [k, v] of poolAccounts(id, 1_000n, 2_000n)) reader.accounts.set(k, v);
    const chain = new FakeChain();
    const outputs = new Outputs();
    const tracker = createPoolTracker<FakePool>({ model: fakeModel, reader, scheduler: time, chain, clock: time, outputs, log: new Logs(), source: scriptedSource(time, poll.delivered), providerOrder: () => ['primary'] });
    POOLS.forEach((id, i) => tracker.watch(id, i === 0 ? 'position' : 'candidate'));
    await tracker.settled();
    for (let t = 1; t <= 20; t++) { chain.highest += 2n; await time.advance(1_000); }
    assert.deepEqual(outputs.snapshots, poll.outputs.snapshots);
    assert.deepEqual(records(outputs), records(poll.outputs));
    tracker.stop();
  });

  it('the subscription stub refuses to start while disabled, and without a verified transport; the tracker then polls', async () => {
    const fallback = createPollSource({ reader: new ScriptedReader(), scheduler: new FakeTime(), settings: M04_DEFAULTS, log: new Logs() });
    assert.throws(() => createSubscribeSource({ enabled: false, fallback, log: new Logs() }).start([]), (e: unknown) => e instanceof SubscribeRefused && e.code === 'E_SUBSCRIBE_DISABLED');
    assert.throws(() => createSubscribeSource({ enabled: true, fallback, log: new Logs() }).start([]), (e: unknown) => e instanceof SubscribeRefused && e.code === 'E_SUBSCRIBE_UNVERIFIED');
    const time = new FakeTime();
    const reader = new ScriptedReader();
    for (const [k, v] of poolAccounts('a', 1n, 2n)) reader.accounts.set(k, v);
    const chain = new FakeChain();
    reader.slot = () => chain.highest;
    const outputs = new Outputs();
    const log = new Logs();
    const metrics = new Metrics();
    const stub = createSubscribeSource({ enabled: M04_DEFAULTS.subscribeEnabled, fallback: createPollSource({ reader, scheduler: time, settings: M04_DEFAULTS, log }), log });
    const tracker = createPoolTracker<FakePool>({ model: fakeModel, reader, scheduler: time, chain, clock: time, outputs, log, metrics, source: stub, providerOrder: () => ['primary'] });
    tracker.watch('a', 'candidate');
    await tracker.settled();
    await time.advance(1_000);
    assert.ok(log.codes().includes('m04.source_refused'));
    assert.equal(metrics.gauges.get('pool_source_kind{"kind":"poll"}'), 1);
    assert.equal(outputs.snapshots.length, 1);
    tracker.stop();
  });

  /** A transport that accepts every open and closes it 100 ms later: an open-then-close storm. */
  class StormTransport implements SubscribeTransport {
    opens = 0;
    private readonly time: FakeTime;
    constructor(time: FakeTime) { this.time = time; }
    open(_pools: readonly SourcePool[], _deliver: (r: SourceRecord) => void, closed: () => void): void {
      this.opens++;
      this.time.set(closed, 100);
    }
    close(): void {}
  }

  /** The pre-fix behaviour (red team C, C3): reopen on every close, no fallback. Named per ruling Z07-3. */
  function reconnectingMutant(transport: SubscribeTransport): PoolSource {
    const handlers = new Set<(r: SourceRecord) => void>();
    const open = (pools: readonly SourcePool[]): void => transport.open(pools, (r) => { for (const h of handlers) h(r); }, () => open(pools));
    return { kind: 'account_subscribe', start: open, stop: () => transport.close(), onAccounts(h) { handlers.add(h); return () => handlers.delete(h); } };
  }

  async function storm(make: (t: StormTransport, fallback: PoolSource) => PoolSource): Promise<{ opens: number; reads: number }> {
    const time = new FakeTime();
    const reader = new ScriptedReader();
    for (const [k, v] of poolAccounts('a', 1n, 2n)) reader.accounts.set(k, v);
    const transport = new StormTransport(time);
    const fallback = createPollSource({ reader, scheduler: time, settings: M04_DEFAULTS, log: new Logs() });
    const source = make(transport, fallback);
    source.start([{ poolId: 'a', accounts: ['a', 'a:b', 'a:q'], cls: 'candidate' }]);
    await time.advance(60_000);
    source.stop();
    return { opens: transport.opens, reads: reader.calls.length };
  }

  it('Z07-3 / red team C C3: under an open-then-close storm the seam opens once and falls back to polling at the poll budget; the reconnecting mutant fails the same check', async () => {
    const check = (r: { opens: number; reads: number }): void => {
      assert.equal(r.opens, 1);
      assert.ok(r.reads <= 60, `${r.reads} reads in 60 s`);             // one candidate poll a second, at most
    };
    const seam = await storm((t, fallback) => createSubscribeSource({ enabled: true, transport: t, fallback, log: new Logs() }));
    check(seam);
    assert.ok(seam.reads >= 59);
    const mutant = await storm((t) => reconnectingMutant(t));
    assert.throws(() => check(mutant));
    assert.ok(mutant.opens >= 600);
  });

  it('after falling back, a restart goes straight to polling; deliveries before the close reach the tracker', async () => {
    const time = new FakeTime();
    const reader = new ScriptedReader();
    const fallback = createPollSource({ reader, scheduler: time, settings: M04_DEFAULTS, log: new Logs() });
    let deliver: ((r: SourceRecord) => void) | null = null;
    let close: (() => void) | null = null;
    let opens = 0;
    const transport: SubscribeTransport = { open: (_p, d, c) => { opens++; deliver = d; close = c; }, close: () => {} };
    const src = createSubscribeSource({ enabled: true, transport, fallback, log: new Logs() });
    const got: SourceRecord[] = [];
    src.onAccounts((r) => got.push(r));
    src.start([]);
    const rec: SourceRecord = { entries: [], contextSlot: 1n as Slot, providerLabel: 'sub', latencyMs: 0, cls: 'candidate' };
    (deliver as unknown as (r: SourceRecord) => void)(rec);
    assert.deepEqual(got, [rec]);
    (close as unknown as () => void)();
    assert.equal(src.fellBack(), true);
    src.start([]);
    assert.equal(opens, 1);
    src.stop();
    const unsub = src.onAccounts(() => {});
    unsub();
  });
});

describe('A-M04-01 batches', () => {
  it('pools are packed whole into batches of at most max_accounts_per_call', () => {
    const p = (id: string, n = 3): SourcePool => ({ poolId: id, accounts: Array.from({ length: n }, (_, i) => `${id}${i}`), cls: 'candidate' });
    assert.deepEqual(packBatches([], 90), []);
    assert.deepEqual(packBatches([p('a'), p('b')], 6).map((b) => b.map((x) => x.poolId)), [['a', 'b']]);
    assert.deepEqual(packBatches([p('a'), p('b'), p('c')], 7).map((b) => b.map((x) => x.poolId)), [['a', 'b'], ['c']]);
    assert.deepEqual(packBatches([p('a', 1), p('b')], 3).map((b) => b.map((x) => x.poolId)), [['a'], ['b']]);
    const thirty = Array.from({ length: 31 }, (_, i) => p(`p${i}`));
    assert.deepEqual(packBatches(thirty, 90).map((b) => b.length), [30, 1]);
  });

  it('a stopped poll source reads nothing and a source with no pools of a class never reads for it', async () => {
    const time = new FakeTime();
    const reader = new ScriptedReader();
    const src = createPollSource({ reader, scheduler: time, settings: M04_DEFAULTS, log: new Logs() });
    src.start([]);
    await time.advance(20_000);
    assert.equal(reader.calls.length, 0);
    src.start([{ poolId: 'a', accounts: ['a'], cls: 'tail' }]);
    await time.advance(10_000);
    assert.deepEqual(reader.calls.map((c) => c.priority), [4]);
    src.stop();
    await time.advance(20_000);
    assert.equal(reader.calls.length, 1);
  });
});

describe('M14 reader adapter', () => {
  const gateway = (answer: Result<CallValue<unknown>, RpcError>): RpcGateway & { seen: Array<{ method: string; params: unknown[]; o: CallOptions }> } => {
    const g = {
      seen: [] as Array<{ method: string; params: unknown[]; o: CallOptions }>,
      async call<T>(method: string, params: unknown[], o: CallOptions): Promise<Result<CallValue<T>, RpcError>> { g.seen.push({ method, params, o }); return answer as Result<CallValue<T>, RpcError>; },
      mode: () => 'normal' as const,
    };
    return g;
  };
  const ok = (value: unknown, contextSlot: bigint | null = 5n): Result<CallValue<unknown>, RpcError> => ({ ok: true, value: { value, providerLabel: 'p', latencyMs: 3, contextSlot: contextSlot as Slot | null } });

  it('getMultipleAccounts at confirmed, base64, at the caller priority, pinned when asked; decodes owners and data', async () => {
    const g = gateway(ok({ context: { slot: 5 }, value: [{ owner: 'o', data: [Buffer.from([1, 2]).toString('base64'), 'base64'] }, null] }));
    const r = await gatewayAccountsReader(g, 2_000).read(['x', 'y'], { priority: 1, provider: 'backup' });
    assert.ok(r.ok);
    assert.deepEqual(r.value, { contextSlot: 5n, providerLabel: 'p', latencyMs: 3, accounts: [{ owner: 'o', data: new Uint8Array([1, 2]) }, null] });
    assert.deepEqual(g.seen[0], { method: 'getMultipleAccounts', params: [['x', 'y'], { encoding: 'base64' }], o: { priority: 1, role: 'read', commitment: 'confirmed', timeoutMs: 2_000, provider: 'backup' } });
    await gatewayAccountsReader(g, 2_000).read(['x', 'y'], { priority: 2 });
    assert.equal('provider' in (g.seen[1]?.o ?? {}), false);
  });

  it('errors: an RPC error, no context slot, a list that does not match the keys, an account not in base64', async () => {
    const code = async (answer: Result<CallValue<unknown>, RpcError>) => {
      const r = await gatewayAccountsReader(gateway(answer), 2_000).read(['x'], { priority: 2 });
      return r.ok ? null : r.error.code;
    };
    assert.equal(await code({ ok: false, error: { code: 'E_TIMEOUT', message: 'slow' } }), 'E_TIMEOUT');
    assert.equal(await code(ok({ value: [null] }, null)), 'E_SHAPE');
    assert.equal(await code(ok({ value: [null, null] })), 'E_SHAPE');
    assert.equal(await code(ok({})), 'E_SHAPE');
    assert.equal(await code(ok(null)), 'E_SHAPE');
    assert.equal(await code(ok({ value: [{ owner: 'o', data: ['not base64!', 'base64'] }] })), 'E_SHAPE');
    assert.equal(await code(ok({ value: [{ owner: 'o', data: ['AA==', 'jsonParsed'] }] })), 'E_SHAPE');
    assert.equal(await code(ok({ value: [{ owner: 1, data: ['AA==', 'base64'] }] })), 'E_SHAPE');
    assert.equal(await code(ok({ value: [7] })), 'E_SHAPE');
  });
});
