// A-M04-01 batched poller and ring buffer, A-M04-02 freshRead and staleness (card Z07), on the fake pool model and a
// scripted reader (fake.ts). Acceptance criteria are "AC<n>". Bugs carried (docs/MIGRATION.md): B1 (lag in ms uses the
// measured slot time, never 400 ms), B4 (calls an hour for 30 watched pools) and the OOM finding (the ring is bounded).
import { strict as assert } from 'node:assert';
import fc from 'fast-check';
import { describe, it } from 'vitest';
import type { Slot, UnixMs } from '@bot/types';
import { SnapshotRing } from '../../src/m04/ring.ts';
import { checkM04Settings, M04_DEFAULTS, type M04Settings } from '../../src/m04/settings.ts';
import { createPoolTracker, BOOT_RETRY_MS } from '../../src/m04/tracker.ts';
import type { PoolSnapshot } from '../../src/m04/types.ts';
import { FakeTime } from '../m14/helpers.ts';
import { FakeChain, fakeModel, Logs, Metrics, Outputs, poolAccounts, ScriptedReader, u64, type FakePool } from './fake.ts';

function setup(settings: Partial<M04Settings> = {}, providers: string[] = ['primary', 'backup']) {
  const time = new FakeTime();
  const reader = new ScriptedReader();
  const chain = new FakeChain();
  const outputs = new Outputs();
  const log = new Logs();
  const metrics = new Metrics();
  const tracker = createPoolTracker<FakePool>({
    model: fakeModel, reader, scheduler: time, chain, clock: time, outputs, log, metrics, settings: { ...M04_DEFAULTS, ...settings }, providerOrder: () => providers,
  });
  reader.slot = () => chain.highest;
  return { time, reader, chain, outputs, log, metrics, tracker };
}
const add = (reader: ScriptedReader, id: string, base = 1_000n, quote = 2_000n): void => { for (const [k, v] of poolAccounts(id, base, quote)) reader.accounts.set(k, v); };

describe('A-M04-01 acceptance', () => {
  it('AC1: 30 candidate pools and 3 position pools: about 1 call a second for candidates (90 accounts) + 2 for positions (9 accounts) + supply reads (ARCH 11.2); B4: 3,660 calls an hour', async () => {
    const s = setup();
    for (let i = 0; i < 33; i++) { add(s.reader, `p${i}`); s.tracker.watch(`p${i}`, i < 30 ? 'candidate' : 'position'); }
    await s.tracker.settled();
    s.tracker.start();
    s.reader.calls = [];
    await s.time.advance(60_000);
    const byPriority = (p: number) => s.reader.calls.filter((c) => c.priority === p);
    const candidates = byPriority(2).filter((c) => c.keys.length === 90);
    const positions = byPriority(1);
    const supply = byPriority(2).filter((c) => c.keys.every((k) => k.endsWith(':m')));
    assert.equal(candidates.length, 60);
    assert.equal(positions.length, 120);
    assert.ok(positions.every((c) => c.keys.length === 9));
    assert.equal(supply.length, 1);
    assert.equal(supply[0]?.keys.length, 33);
    assert.equal(s.reader.calls.length, 181);
    // B4: an hour of 30 candidate pools is 3,600 batched calls plus 60 supply reads; Zeroed's per-pool log streams spent
    // about 80,000 Helius credits an hour on such a watchlist (MIGRATION "Bugs left behind").
    const h = setup();
    for (let i = 0; i < 30; i++) { add(h.reader, `p${i}`); h.tracker.watch(`p${i}`, 'candidate'); }
    await h.tracker.settled();
    h.tracker.start();
    h.reader.calls = [];
    await h.time.advance(3_600_000);
    assert.equal(h.reader.calls.length, 3_660);
    h.tracker.stop();
    s.tracker.stop();
  });

  it('AC2: a response with an older context slot than the stored snapshot is discarded; no pool.snapshot is published', async () => {
    const s = setup();
    add(s.reader, 'a');
    s.tracker.watch('a', 'candidate');
    await s.tracker.settled();
    s.chain.highest = 1_005n;
    await s.time.advance(1_000);
    assert.equal(s.outputs.snapshots.length, 1);
    s.reader.slot = () => 1_003n;                                // a lagging provider answers with an older slot
    await s.time.advance(1_000);
    assert.equal(s.outputs.snapshots.length, 1);
    assert.equal(s.metrics.count('snapshot_out_of_order_total'), 1);
    s.tracker.stop();
  });

  it('AC3: a pool account that returns null publishes pool.closed within one cycle; the pool is unwatched', async () => {
    const s = setup();
    add(s.reader, 'a');
    s.tracker.watch('a', 'candidate');
    await s.tracker.settled();
    await s.time.advance(1_000);
    s.reader.accounts.set('a', null);
    await s.time.advance(1_000);
    assert.deepEqual(s.outputs.closedEvents, [{ poolId: 'a', reason: 'closed' }]);
    assert.deepEqual(s.outputs.unwatchedPools, ['a']);
    assert.deepEqual(s.tracker.ready(), []);
    const n = s.reader.calls.length;
    await s.time.advance(5_000);
    assert.equal(s.reader.calls.length, n);
    s.tracker.stop();
  });
});

describe('A-M04-01 rules', () => {
  it('logic 5: a non-exit read more than 10 slots behind the highest slot seen is discarded and the provider reported', async () => {
    const s = setup();
    add(s.reader, 'a');
    s.tracker.watch('a', 'candidate');
    await s.tracker.settled();
    s.chain.highest = 2_000n;
    s.reader.slot = () => 1_989n;
    await s.time.advance(1_000);
    assert.deepEqual(s.outputs.snapshots, []);
    assert.deepEqual(s.outputs.lagging, [['primary', 11]]);
    s.reader.slot = () => 1_990n;
    await s.time.advance(1_000);
    assert.equal((s.outputs.snapshots as Outputs['snapshots'])[0]?.s.observationLagSlots, 10);
    s.tracker.stop();
  });

  it('logic 7 and edge 3: owner changed → quarantine and pool.closed owner_changed; a missing vault is skipped (partial_read_total); a negative effective reserve is quarantined', async () => {
    const s = setup();
    for (const id of ['own', 'part', 'neg', 'lay']) { add(s.reader, id); s.tracker.watch(id, 'candidate'); }
    await s.tracker.settled();
    s.reader.accounts.set('own:b', { owner: 'thief', data: u64(1n) });
    s.reader.accounts.set('part:q', null);
    s.reader.accounts.set('neg:q', { owner: 'tok', data: u64(-1n) });
    s.reader.accounts.set('lay', { owner: 'amm', data: new Uint8Array([9]) });
    await s.time.advance(1_000);
    assert.deepEqual(s.outputs.closedEvents, [{ poolId: 'own', reason: 'owner_changed' }]);
    assert.deepEqual(s.outputs.quarantines, [['own', 'owner_changed'], ['neg', 'negative_effective']]);
    assert.equal(s.metrics.count('partial_read_total'), 1);
    assert.ok(s.log.codes().includes('m04.pool_unreadable'));
    assert.deepEqual(s.outputs.snapshots, []);
    assert.deepEqual(s.tracker.ready().sort(), ['lay', 'neg', 'part']);
    s.tracker.stop();
  });

  it('edges 1-2: when every provider fails no snapshot is fabricated; a failed first read is retried after 10 s', async () => {
    const s = setup();
    add(s.reader, 'a');
    s.reader.fail = true;
    s.tracker.watch('a', 'candidate');
    await s.tracker.settled();
    s.tracker.start();
    await s.time.advance(BOOT_RETRY_MS - 500);
    assert.deepEqual(s.tracker.ready(), []);
    s.reader.fail = false;
    await s.time.advance(1_000);
    await s.tracker.settled();
    assert.deepEqual(s.tracker.ready(), ['a']);
    s.reader.fail = true;
    const before = s.outputs.snapshots.length;
    await s.time.advance(5_000);
    assert.equal(s.outputs.snapshots.length, before);
    assert.ok(s.log.codes().includes('m04.poll_failed'));
    s.tracker.stop();
  });

  it('first reads: a closed, changed or unreadable pool account, and a mint that does not read (then retried)', async () => {
    const s = setup();
    s.reader.accounts.set('gone', null);
    s.reader.accounts.set('moved', { owner: 'other', data: new Uint8Array(8) });
    s.reader.accounts.set('odd', { owner: 'amm', data: new Uint8Array([9]) });
    add(s.reader, 'nomint');
    s.reader.accounts.set('nomint:m', null);
    for (const id of ['gone', 'moved', 'odd', 'nomint']) s.tracker.watch(id, 'tail');
    await s.tracker.settled();
    assert.deepEqual(s.outputs.closedEvents, [{ poolId: 'gone', reason: 'closed' }, { poolId: 'moved', reason: 'owner_changed' }]);
    assert.deepEqual(s.outputs.unwatchedPools.sort(), ['gone', 'moved', 'odd']);
    assert.deepEqual(s.tracker.ready(), []);
    s.reader.accounts.set('nomint:m', { owner: 'tok', data: new Uint8Array(82) });
    s.tracker.start();
    await s.time.advance(BOOT_RETRY_MS + 500);
    await s.tracker.settled();
    assert.deepEqual(s.tracker.ready(), ['nomint']);
    s.tracker.stop();
  });

  it('edge 4: an unknown fee is published as 10,000 bps (C-08); the snapshot carries lag, provider, latency and a rawHash of the three accounts', async () => {
    const s = setup();
    add(s.reader, 'a', 7n, 2_000n);
    s.tracker.watch('a', 'position');
    await s.tracker.settled();
    s.chain.highest = 1_003n;
    s.reader.slot = () => 1_001n;
    await s.time.advance(500);
    const snap = s.outputs.snapshots[0]?.s as PoolSnapshot<FakePool>;
    assert.deepEqual([snap.feeTotalBps, snap.observationLagSlots, snap.providerLabel, snap.readLatencyMs, snap.providerSlot, snap.rawHash.length], [10_000, 2, 'primary', 7, 1_001n, 64]);
    assert.equal(s.outputs.snapshots[0]?.cls, 'position');
    s.reader.accounts.set('a:q', { owner: 'tok', data: u64(2_001n) });
    s.reader.slot = () => 1_002n;
    await s.time.advance(500);
    assert.notEqual(s.outputs.snapshots[1]?.s.rawHash, snap.rawHash);
    s.tracker.stop();
  });

  it('logic 2 and edge 5: a class tick never overlaps the previous one (poll_skipped_total); a late tick runs once, no burst', async () => {
    const s = setup();
    add(s.reader, 'a');
    s.tracker.watch('a', 'candidate');
    await s.tracker.settled();
    let release = (): void => {};
    s.reader.gate = new Promise((r) => { release = r; });
    await s.time.advance(3_000);
    assert.equal(s.metrics.count('poll_skipped_total', { class: 'candidate' }), 2);
    release();
    s.reader.gate = null;
    await s.time.advance(0);
    // A timer that fires 5 s late (event-loop lag) runs once, then the schedule continues from it.
    const calls = s.reader.calls.length;
    s.time.now += 5_000;
    await s.time.advance(0);
    assert.equal(s.reader.calls.length, calls + 1);
    await s.time.advance(999);
    assert.equal(s.reader.calls.length, calls + 1);
    await s.time.advance(1);
    assert.equal(s.reader.calls.length, calls + 2);
    s.tracker.stop();
  });

  it('watch() moves a pool between classes (its ring resized), unwatch() stops it and tells M07; supply is refreshed every 60 s', async () => {
    const s = setup();
    add(s.reader, 'a');
    s.tracker.watch('a', 'tail');
    s.tracker.watch('a', 'tail');
    await s.tracker.settled();
    s.tracker.start();
    await s.time.advance(10_000);
    assert.equal(s.outputs.snapshots.at(-1)?.cls, 'tail');
    s.tracker.watch('a', 'position');
    s.chain.highest = 1_001n;
    await s.time.advance(500);
    assert.equal(s.outputs.snapshots.at(-1)?.cls, 'position');
    assert.equal(s.reader.calls.at(-1)?.priority, 1);
    s.reader.calls = [];
    await s.time.advance(60_000);
    assert.ok(s.reader.calls.some((c) => c.keys.length === 1 && c.keys[0] === 'a:m'));
    s.tracker.unwatch('a');
    s.tracker.unwatch('a');
    assert.deepEqual(s.outputs.unwatchedPools, ['a']);
    assert.equal(s.tracker.latest('a'), null);
    assert.deepEqual(s.tracker.history('a', 0 as UnixMs, Number.MAX_SAFE_INTEGER as UnixMs), []);
    s.tracker.stop();
  });

  it('a supply read that fails or returns no mint keeps the last supply', async () => {
    const s = setup();
    add(s.reader, 'a');
    s.tracker.watch('a', 'candidate');
    await s.tracker.settled();
    s.tracker.start();
    s.reader.accounts.set('a:m', null);
    await s.time.advance(60_000);
    s.reader.fail = true;
    await s.time.advance(60_000);
    s.reader.fail = false;
    await s.time.advance(1_000);
    assert.ok(s.outputs.snapshots.length > 0);
    s.tracker.stop();
  });
});

describe('A-M04-01 lifecycle edges', () => {
  it('a pool unwatched during its first read is dropped quietly; a mint read that fails is retried; a delivery for an unknown pool is ignored', async () => {
    const s = setup();
    add(s.reader, 'a');
    s.tracker.watch('a', 'candidate');
    s.tracker.unwatch('a');
    await s.tracker.settled();
    assert.deepEqual(s.tracker.ready(), []);
    add(s.reader, 'b');
    const read = s.reader.read.bind(s.reader);
    s.reader.read = async (k, o) => (k[0] === 'b:m' ? { ok: false, error: { code: 'E_TIMEOUT', message: '' } } : read(k, o));
    s.tracker.watch('b', 'candidate');
    await s.tracker.settled();
    assert.ok(s.log.lines.some(([, c, f]) => c === 'm04.first_read_failed' && f.error_code === 'E_TIMEOUT'));
    s.reader.read = read;
    // Unwatched between the pool read and the mint read.
    let hold = (): void => {};
    s.reader.read = async (k, o) => { if (k[0] === 'c:m') await new Promise<void>((r) => { hold = r; }); return read(k, o); };
    add(s.reader, 'c');
    s.tracker.watch('c', 'candidate');
    await s.time.advance(0);
    s.tracker.unwatch('c');
    hold();
    await s.tracker.settled();
    assert.equal(s.tracker.ready().includes('c'), false);
  });

  it('a source that throws without a code is replaced by polling; deliveries for pools not watched are ignored', async () => {
    const s0 = setup();
    let handler: ((r: Parameters<Parameters<import('../../src/m04/source.ts').PoolSource['onAccounts']>[0]>[0]) => void) | null = null;
    const throwing = { kind: 'account_subscribe' as const, start() { throw new Error('boom'); }, stop() {}, onAccounts(h: never) { handler = h; return () => {}; } };
    const tracker = createPoolTracker<FakePool>({ model: fakeModel, reader: s0.reader, scheduler: s0.time, chain: s0.chain, clock: s0.time, outputs: s0.outputs, log: s0.log, source: throwing, providerOrder: () => ['primary'] });
    add(s0.reader, 'a');
    tracker.watch('a', 'candidate');
    await tracker.settled();
    assert.ok(s0.log.lines.some(([, c, f]) => c === 'm04.source_refused' && f.error_code === 'E_SOURCE'));
    (handler as unknown as (r: unknown) => void)({ entries: [{ poolId: 'nobody', accounts: [] }], contextSlot: 1n, providerLabel: 'x', latencyMs: 0, cls: 'candidate' });
    await s0.time.advance(1_000);
    assert.equal(s0.outputs.snapshots.length, 1);
    tracker.stop();
  });

  it('freshRead: a read that does not build gives E_RPC; the next provider after the last one wraps to the first; supply reads never overlap', async () => {
    const s = setup();
    add(s.reader, 'a');
    s.tracker.watch('a', 'candidate');
    await s.tracker.settled();
    s.reader.accounts.set('a:q', null);
    const r = await s.tracker.freshRead('a', 8);
    assert.ok(!r.ok && r.error.code === 'E_RPC');
    add(s.reader, 'a');
    s.chain.highest = 2_000n;
    s.reader.slot = (c) => (c.provider === 'primary' ? 1_999n : 1_980n);
    s.reader.provider = (c) => c.provider ?? 'backup';
    const w = await s.tracker.freshRead('a', 8);
    assert.ok(w.ok && w.value.providerLabel === 'primary');
    assert.deepEqual(s.reader.calls.slice(-2).map((c) => c.provider), [undefined, 'primary']);
    s.tracker.start();
    let release = (): void => {};
    s.reader.gate = new Promise((res) => { release = res; });
    await s.time.advance(130_000);
    const mintCalls = s.reader.calls.filter((c) => c.keys.length === 1 && c.keys[0] === 'a:m').length;
    assert.equal(mintCalls, 2);                                    // the first read, then one refresh while the gate holds
    release();
    s.reader.gate = null;
    s.tracker.stop();
  });
});

describe('A-M04-01 ring buffer (logic 6; the OOM finding)', () => {
  const addr = { poolId: 'r', baseVault: 'b', quoteVault: 'q', tokenMint: 'm' };
  const snap = (i: number): PoolSnapshot<FakePool> => ({
    pool: { poolId: 'r', asOfSlot: BigInt(i) as Slot, commitment: 'confirmed', observedAtMs: (i * 1_000) as UnixMs, base: BigInt(i), quote: 2n * BigInt(i) },
    effectiveQuoteLamports: 2n * BigInt(i), spotSolPerToken: i === 0 ? null : '2/1', feeTotalBps: 30, providerLabel: i % 2 === 0 ? 'primary' : 'backup',
    providerSlot: BigInt(i) as Slot, readLatencyMs: 7, observationLagSlots: i % 5, rawHash: i.toString(16).padStart(64, '0'),
  });

  it('a replayed day at 1 Hz (86,400 snapshots) keeps 2 h (7,200) in a fixed buffer; history returns them oldest first', () => {
    const ring = new SnapshotRing(addr, fakeModel, 7_200, []);
    const bytes = ring.bytes;
    for (let i = 1; i <= 86_400; i++) ring.push(snap(i));
    assert.equal(ring.size, 7_200);
    assert.equal(ring.bytes, bytes);
    assert.equal(bytes, 7_200 * (32 + 52));
    const h = ring.history(0, Number.MAX_SAFE_INTEGER);
    assert.equal(h.length, 7_200);
    assert.deepEqual(h[0], { ...snap(79_201), spotSolPerToken: '158402/79201', effectiveQuoteLamports: 158_402n });
    assert.equal(h.at(-1)?.pool.asOfSlot, 86_400n);
    assert.deepEqual(ring.history(86_000_000, 86_002_000).map((x) => x.pool.asOfSlot), [86_000n, 86_001n, 86_002n]);
    assert.equal(ring.before(79_201n as Slot), null);
    assert.equal(ring.before(80_000n as Slot)?.providerSlot, 79_999n);
  });

  it('resize keeps the newest that fit; a bad capacity is refused', () => {
    const ring = new SnapshotRing(addr, fakeModel, 10, []);
    for (let i = 1; i <= 15; i++) ring.push(snap(i));
    ring.resize(4);
    assert.deepEqual(ring.history(0, 1e12).map((x) => x.pool.asOfSlot), [12n, 13n, 14n, 15n]);
    ring.resize(4);
    ring.resize(8);
    ring.push(snap(16));
    assert.deepEqual(ring.history(0, 1e12).map((x) => x.pool.asOfSlot), [12n, 13n, 14n, 15n, 16n]);
    assert.equal(ring.poolId, 'r');
    assert.equal(ring.capacity, 8);
    assert.throws(() => new SnapshotRing(addr, fakeModel, 0, []));
  });

  it('the tracker holds history_ms of snapshots per pool: with a 10-minute history, 1,000 polls keep 600', async () => {
    const s = setup({ historyMs: 600_000 });
    add(s.reader, 'a');
    s.tracker.watch('a', 'candidate');
    await s.tracker.settled();
    for (let i = 0; i < 1_000; i++) { s.chain.highest += 1n; await s.time.advance(1_000); }
    assert.equal(s.tracker.history('a', 0 as UnixMs, Number.MAX_SAFE_INTEGER as UnixMs).length, 600);
    assert.equal(s.tracker.snapshotBefore('a', 1_500n as Slot)?.providerSlot, 1_499n);
    assert.equal(s.tracker.snapshotBefore('a', 1_401n as Slot), null);                // older than the 600 kept
    s.tracker.stop();
  });
});

describe('A-M04-02 freshRead, lag and staleness', () => {
  async function ready(providers?: string[]) {
    const s = setup({}, providers);
    add(s.reader, 'a');
    s.tracker.watch('a', 'candidate');
    await s.tracker.settled();
    s.chain.highest = 2_000n;
    return s;
  }
  const lags = (s: ReturnType<typeof setup>, m: Record<string, number>) => { s.reader.slot = (c) => s.chain.highest - BigInt(m[c.provider ?? 'primary'] as number); };

  it('AC1: a provider 11 slots behind and another 2 behind: freshRead(pool, 8) re-reads on the next provider and returns that read', async () => {
    const s = await ready();
    lags(s, { primary: 11, backup: 2 });
    const r = await s.tracker.freshRead('a', 8);
    assert.ok(r.ok);
    assert.deepEqual([r.value.providerLabel, s.tracker.lagNow(r.value)], ['backup', 2]);
    assert.deepEqual(s.reader.calls.slice(-2).map((c) => [c.priority, c.provider]), [[1, undefined], [1, 'backup']]);
  });

  it('AC2: every provider 20 slots behind: freshRead(pool, 8) is E_STALE and freshRead(pool, Infinity) is ok; past 40 slots it alerts', async () => {
    const s = await ready();
    lags(s, { primary: 20, backup: 20 });
    const e = await s.tracker.freshRead('a', 8);
    assert.ok(!e.ok && e.error.code === 'E_STALE');
    assert.equal(s.metrics.count('fresh_read_stale_total'), 1);
    const x = await s.tracker.freshRead('a', Number.POSITIVE_INFINITY);
    assert.ok(x.ok && s.tracker.lagNow(x.value) === 20);
    assert.ok(!s.log.codes().includes('m04.exit_read_lagging'));
    lags(s, { primary: 41, backup: 45 });
    const far = await s.tracker.freshRead('a', Number.POSITIVE_INFINITY);
    assert.ok(far.ok && far.value.providerLabel === 'primary');           // the freshest of the two attempts
    assert.ok(s.log.codes().includes('m04.exit_read_lagging'));
    assert.deepEqual(s.reader.calls.slice(-2).map((c) => c.priority), [0, 0]);
  });

  it('property: freshRead(_, Infinity) never returns E_STALE over a provider lag sweep of 0-60 slots (fixed seed)', async () => {
    const s = await ready();
    await fc.assert(fc.asyncProperty(fc.integer({ min: 0, max: 60 }), fc.integer({ min: 0, max: 60 }), async (a, b) => {
      lags(s, { primary: a, backup: b });
      const r = await s.tracker.freshRead('a', Number.POSITIVE_INFINITY);
      return r.ok;
    }), { numRuns: 300, seed: 7_042 });
  });

  it('E_RPC when every attempt fails or the pool is not ready; an entry read whose first attempt failed can still succeed', async () => {
    const s = await ready();
    s.reader.fail = true;
    const e = await s.tracker.freshRead('a', 8);
    assert.ok(!e.ok && e.error.code === 'E_RPC');
    const x = await s.tracker.freshRead('a', Number.POSITIVE_INFINITY);
    assert.ok(!x.ok && x.error.code === 'E_RPC');
    s.reader.fail = false;
    const none = await s.tracker.freshRead('nope', 8);
    assert.ok(!none.ok && none.error.code === 'E_RPC');
    let n = 0;
    const read = s.reader.read.bind(s.reader);
    s.reader.read = async (k, o) => (n++ === 0 ? { ok: false, error: { code: 'E_TIMEOUT', message: '' } } : read(k, o));
    lags(s, { primary: 1, backup: 1 });
    const second = await s.tracker.freshRead('a', 8);
    assert.ok(second.ok);
  });

  it('a successful fresh read updates latest() under the monotonic rule; a one-provider list re-reads on the same one', async () => {
    const s = await ready(['only']);
    lags(s, { primary: 3, only: 3 });
    const r = await s.tracker.freshRead('a', 8);
    assert.ok(r.ok);
    assert.equal(s.tracker.latest('a')?.providerSlot, 1_997n);
    lags(s, { primary: 30, only: 30 });
    const old = await s.tracker.freshRead('a', 8);
    assert.ok(!old.ok);
    assert.equal(s.tracker.latest('a')?.providerSlot, 1_997n);
  });

  it('edge 3: concurrent reads of one pool coalesce; an exit read in flight serves the entry caller, who applies its own limit', async () => {
    const s = await ready();
    lags(s, { primary: 1, backup: 1 });
    let release = (): void => {};
    s.reader.gate = new Promise((r) => { release = r; });
    const before = s.reader.calls.length;
    const a = s.tracker.freshRead('a', 8);
    const b = s.tracker.freshRead('a', 8);
    await Promise.resolve();
    release();
    s.reader.gate = null;
    const [ra, rb] = await Promise.all([a, b]);
    assert.ok(ra.ok && rb.ok && ra.value === rb.value);
    assert.equal(s.reader.calls.length - before, 1);
    // An exit read 10 slots behind is in flight: an entry caller with an 8-slot limit gets E_STALE from it.
    lags(s, { primary: 10, backup: 10 });
    s.reader.gate = new Promise((r) => { release = r; });
    const x = s.tracker.freshRead('a', Number.POSITIVE_INFINITY);
    const y = s.tracker.freshRead('a', 8);
    const z = s.tracker.freshRead('a', 12);
    await Promise.resolve();
    release();
    s.reader.gate = null;
    const [rx, ry, rz] = await Promise.all([x, y, z]);
    assert.ok(rx.ok && !ry.ok && ry.error.code === 'E_STALE' && rz.ok);
    // A shared entry read behind a second caller's tighter limit.
    lags(s, { primary: 6, backup: 6 });
    s.reader.gate = new Promise((r) => { release = r; });
    const p = s.tracker.freshRead('a', 8);
    const q = s.tracker.freshRead('a', 4);
    await Promise.resolve();
    release();
    s.reader.gate = null;
    const [rp, rq] = await Promise.all([p, q]);
    assert.ok(rp.ok && !rq.ok && rq.error.code === 'E_STALE');
  });

  it('AC3: with no successful poll for 13 slots exactly one pool.stale is published; pool.fresh when it recovers', async () => {
    const s = await ready();
    s.tracker.start();
    await s.time.advance(1_000);
    assert.equal(s.outputs.snapshots.length, 1);
    s.reader.fail = true;
    s.chain.highest += 12n;
    await s.time.advance(2_000);
    assert.deepEqual(s.outputs.staleEvents, []);
    s.chain.highest += 1n;
    await s.time.advance(5_000);
    assert.deepEqual(s.outputs.staleEvents, [{ poolId: 'a', lagSlots: 13 }]);
    s.reader.fail = false;
    await s.time.advance(1_000);
    assert.deepEqual(s.outputs.freshEvents, ['a']);
    assert.ok(s.metrics.gauges.size > 0);
    s.tracker.stop();
  });

  it('B1: lag in ms uses the measured slot time: 100 slots at 250 ms are 25,000 ms; the old fixed 400 ms (40,000 ms) is rejected', async () => {
    const s = await ready();
    s.reader.slot = () => 1_900n;
    const r = await s.tracker.freshRead('a', Number.POSITIVE_INFINITY);
    assert.ok(r.ok);
    const check = (ms: number) => assert.equal(ms, 25_000);
    check(s.tracker.lagMs(r.value));
    const oldRule = (lagSlots: number) => lagSlots * 400;            // Zeroed SLOT_MS = 400 (MIGRATION B1)
    assert.throws(() => check(oldRule(s.tracker.lagNow(r.value))));
    s.chain.highest = 1_000n;                                        // M15 behind the read: lag is 0, never negative
    assert.equal(s.tracker.lagNow(r.value), 0);
  });
});

describe('M04 settings', () => {
  it('ranges of the A-M04-01/02 config tables; the position interval must be below the candidate interval', () => {
    assert.ok(checkM04Settings(M04_DEFAULTS).ok);
    for (const bad of [{ candidateIntervalMs: 499 }, { positionIntervalMs: 1_001 }, { tailIntervalMs: 4_999 }, { maxAccountsPerCall: 101 }, { maxAccountsPerCall: 2 },
      { supplyRefreshMs: 9_999 }, { maxProviderLagSlots: 51 }, { historyMs: 599_999 }, { staleLagSlots: 3 }, { buildLagSlots: 21 }, { exitLagAlertSlots: 11 },
      { positionIntervalMs: 1_000, candidateIntervalMs: 1_000 }, { subscribeEnabled: 'yes' as unknown as boolean }, { staleCheckMs: 99 }, { readTimeoutMs: 1.5 }]) {
      assert.ok(!checkM04Settings({ ...M04_DEFAULTS, ...bad }).ok, JSON.stringify(bad));
    }
    assert.throws(() => setup({ historyMs: 1 }));
  });
});
