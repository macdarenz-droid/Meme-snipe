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
    s.chain.highest += 100n;                                       // the cluster moves on; both answers are newer than latest()
    lags(s, { primary: 41, backup: 45 });
    const far = await s.tracker.freshRead('a', Number.POSITIVE_INFINITY);
    assert.ok(far.ok && far.value.providerLabel === 'primary');           // the freshest of the two attempts
    assert.ok(s.log.codes().includes('m04.exit_read_lagging'));
    assert.deepEqual(s.reader.calls.slice(-2).map((c) => c.priority), [0, 0]);
    s.chain.highest += 100n;
    lags(s, { primary: 45, backup: 41 });
    const better = await s.tracker.freshRead('a', Number.POSITIVE_INFINITY);
    assert.ok(better.ok && better.value.providerLabel === 'backup');
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
    // #325 red team MINOR-3: a read older than latest() is never returned as fresh; the stored latest is.
    const old = await s.tracker.freshRead('a', 8);
    assert.ok(old.ok && old.value.providerSlot === 1_997n && old.value === s.tracker.latest('a'));
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
    s.chain.highest += 100n;
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
    s.chain.highest += 100n;
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
    s.chain.highest = 1_895n;                                        // the clock behind the read (under its ceiling): lag is 0, never negative
    assert.equal(s.tracker.lagNow(r.value), 0);
    s.chain.highest = 1_000n;                                        // the read past the clock's ceiling: never fresh (Z07-13.4)
    assert.equal(s.tracker.lagNow(r.value), Number.POSITIVE_INFINITY);
  });
});

describe('M04 settings', () => {
  it('ranges of the A-M04-01/02 config tables; the position interval must be below the candidate interval', () => {
    assert.ok(checkM04Settings(M04_DEFAULTS).ok);
    for (const bad of [{ candidateIntervalMs: 499 }, { positionIntervalMs: 1_001 }, { tailIntervalMs: 4_999 }, { maxAccountsPerCall: 101 }, { maxAccountsPerCall: 2 },
      { supplyRefreshMs: 9_999 }, { maxProviderLagSlots: 51 }, { historyMs: 599_999 }, { staleLagSlots: 3 }, { buildLagSlots: 21 }, { exitLagAlertSlots: 11 },
      { positionIntervalMs: 1_000, candidateIntervalMs: 1_000 }, { subscribeEnabled: 'yes' as unknown as boolean }, { staleCheckMs: 99 }, { readTimeoutMs: 1.5 },
      { staleAgeMs: 999 }, { maxCandidates: 34 }, { maxCandidates: 30, maxAccountsPerCall: 60 }, { maxTail: 101 }, { maxPositions: 0 }]) {
      assert.ok(!checkM04Settings({ ...M04_DEFAULTS, ...bad }).ok, JSON.stringify(bad));
    }
    assert.throws(() => setup({ historyMs: 1 }));
  });

  it('ruling Z07-12: max_tail below universe.tail_max_pools is refused (M05 could not keep its tails)', () => {
    assert.ok(checkM04Settings({ ...M04_DEFAULTS, maxTail: 30 }, { tailMaxPools: 30 }).ok);
    const low = checkM04Settings({ ...M04_DEFAULTS, maxTail: 29 }, { tailMaxPools: 30 });
    assert.ok(!low.ok && low.error.key === 'pool_tracker.max_tail');
    assert.ok(!checkM04Settings({ ...M04_DEFAULTS, maxTail: 40 }, { tailMaxPools: 60 }).ok);
    assert.ok(!checkM04Settings({ ...M04_DEFAULTS, maxTail: 29 }).ok);              // the default universe: 30
    const s = setup();
    assert.throws(() => createPoolTracker<FakePool>({ model: fakeModel, reader: s.reader, scheduler: s.time, chain: s.chain, clock: s.time, outputs: s.outputs, log: s.log, universe: { tailMaxPools: 60 }, providerOrder: () => ['primary'] }));
  });
});

describe('#325 red team round 1 (each test is the red team\'s probe)', () => {
  it('MAJOR-1: one future context slot (a bogus provider, M15 poisoned by it) is refused and counted against its provider; honest reads keep being stored', async () => {
    const s = setup();
    add(s.reader, 'a');
    s.tracker.watch('a', 'candidate');
    await s.tracker.settled();
    s.tracker.start();
    await s.time.advance(1_000);
    assert.equal(s.outputs.snapshots.length, 1);
    s.chain.expected = 1_000n;                                     // the slot clock's estimate stays honest
    s.reader.slot = () => 1_000_000_000n;
    s.reader.provider = () => 'bogus';
    s.chain.highest = 1_000_000_000n;                              // M15's highest seen takes the bogus provider's word
    await s.time.advance(1_000);
    assert.equal(s.outputs.snapshots.length, 1);
    assert.equal(s.metrics.count('snapshot_future_slot_total', { provider: 'bogus' }), 1);
    assert.ok(s.log.lines.some(([l, c, f]) => l === 'error' && c === 'm04.read_ahead_of_clock' && f.provider === 'bogus'));
    // Honest reads at the clock's slot: stored, with their lag measured against the clock, not the poisoned highest.
    s.reader.provider = () => 'primary';
    for (let t = 1; t <= 5; t++) {
      s.chain.expected = 1_000n + BigInt(t);
      s.reader.slot = () => s.chain.expected as bigint;
      await s.time.advance(1_000);
    }
    assert.equal(s.outputs.snapshots.length, 6);
    assert.equal(s.tracker.latest('a')?.providerSlot, 1_005n);
    assert.equal(s.tracker.lagNow(s.tracker.latest('a') as PoolSnapshot<FakePool>), 0);
    assert.deepEqual(s.outputs.staleEvents, []);
    // A future slot on an entry read is never used; on the exit grade, one unconfirmed provider is handed back
    // unstored as E_CLOCK (ruling Z07-9).
    s.reader.slot = () => 1_000_001_000n;
    const entry = await s.tracker.freshRead('a', 8);
    assert.ok(!entry.ok && entry.error.code !== 'E_CLOCK');
    const r = await s.tracker.freshRead('a', Number.POSITIVE_INFINITY);
    assert.ok(!r.ok && r.error.code === 'E_CLOCK' && r.error.snapshot?.providerSlot === 1_000_001_000n);
    assert.equal(s.tracker.latest('a')?.providerSlot, 1_005n);
    s.tracker.stop();
  });

  it('MAJOR-1: staleness also fires on wall-clock age, when no slot moves at all (the slot clock and M15 stuck)', async () => {
    const s = setup();
    add(s.reader, 'a');
    s.tracker.watch('a', 'candidate');
    await s.tracker.settled();
    s.tracker.start();
    await s.time.advance(1_000);
    s.reader.fail = true;
    await s.time.advance(5_500);                                    // 5.5 s < 5 s + the 1 s candidate interval
    assert.deepEqual(s.outputs.staleEvents, []);
    await s.time.advance(1_000);
    assert.deepEqual(s.outputs.staleEvents, [{ poolId: 'a', lagSlots: 0 }]);
    assert.ok(s.log.lines.some(([, c, f]) => c === 'm04.pool_stale' && (f.age_ms as number) > 6_000));
    s.reader.fail = false;
    await s.time.advance(1_000);
    assert.deepEqual(s.outputs.freshEvents, ['a']);
    s.tracker.stop();
  });

  it('MINOR-1: 500 watches are capped per class (30 candidates, 30 tail, 10 positions); at the caps the rings fit a small slice of the 2 GB host', async () => {
    const s = setup();
    const model64 = { ...fakeModel, recordBytes: 64 };            // the PumpSwap record size
    const tracker = createPoolTracker<FakePool>({ model: model64, reader: s.reader, scheduler: s.time, chain: s.chain, clock: s.time, outputs: s.outputs, log: s.log, metrics: s.metrics, providerOrder: () => ['primary'] });
    const accepted = { candidate: 0, tail: 0, position: 0 };
    for (let i = 0; i < 500; i++) {
      add(s.reader, `p${i}`);
      const cls = (['candidate', 'tail', 'position'] as const)[i % 3] as 'candidate' | 'tail' | 'position';
      if (tracker.watch(`p${i}`, cls)) accepted[cls]++;
    }
    assert.deepEqual(accepted, { candidate: 30, tail: 30, position: 10 });
    assert.equal(tracker.ringBytes(), 0);                          // nothing allocated before a pool's first read
    assert.ok(s.metrics.count('watch_refused_total', { class: 'candidate' }) > 0);
    assert.ok(s.log.lines.some(([l, c]) => l === 'critical' && c === 'm04.watch_refused'));
    await tracker.settled();
    // A move into a full class is refused too; the same class is a no-op.
    assert.equal(tracker.watch('p0', 'position'), false);
    assert.equal(tracker.watch('p0', 'candidate'), true);
    const bytes = tracker.ringBytes();
    const stride = 64 + 52;
    assert.equal(bytes, stride * (30 * 7_200 + 30 * 720 + 10 * 14_400));
    assert.ok(bytes <= 64 * 2 ** 20, `${bytes} bytes`);              // ≈ 44 MB: about 2% of 2 GB (Z10 alerts at 75%)
    tracker.stop();
  });

  it('MINOR-2: freshRead on an unwatched or dropped pool leaves no in-flight entry; settled reads leave none either', async () => {
    const s = setup();
    add(s.reader, 'a');
    s.tracker.watch('a', 'candidate');
    await s.tracker.settled();
    for (let i = 0; i < 50; i++) assert.ok(!(await s.tracker.freshRead(`ghost${i}`, 8)).ok);
    assert.equal(s.tracker.inflightCount(), 0);
    assert.ok((await s.tracker.freshRead('a', 8)).ok);
    assert.ok((await s.tracker.freshRead('a', Number.POSITIVE_INFINITY)).ok);
    assert.equal(s.tracker.inflightCount(), 0);
    let release = (): void => {};
    s.reader.gate = new Promise((r) => { release = r; });
    const pending = s.tracker.freshRead('a', 8);
    await Promise.resolve();
    assert.equal(s.tracker.inflightCount(), 1);
    s.tracker.unwatch('a');
    release();
    s.reader.gate = null;
    assert.ok(!(await pending).ok);
    assert.equal(s.tracker.inflightCount(), 0);
  });

  it('MINOR-3: a read that store() rejected as older is never returned as fresh: the caller gets the stored latest', async () => {
    const s = setup();
    add(s.reader, 'a');
    s.tracker.watch('a', 'candidate');
    await s.tracker.settled();
    s.chain.highest = 2_000n;
    s.reader.slot = () => 1_999n;
    const first = await s.tracker.freshRead('a', 8);
    assert.ok(first.ok);
    s.reader.slot = () => 1_995n;
    s.reader.accounts.set('a:q', { owner: 'tok', data: u64(9_999n) });
    const second = await s.tracker.freshRead('a', 8);
    assert.ok(second.ok && second.value.providerSlot === 1_999n && second.value.pool.quote === 2_000n);
    assert.equal(s.metrics.count('snapshot_out_of_order_total'), 1);
  });
});

describe('rulings Z07-9 and Z07-13: a slot clock that trails the tip', () => {
  /** Two providers, both honest, at the tip; the slot clock trails by 50 slots (past max_provider_lag_slots 10). */
  async function trailing() {
    const s = setup();
    add(s.reader, 'a');
    s.tracker.watch('a', 'candidate');
    await s.tracker.settled();
    s.tracker.start();
    s.chain.highest = 2_050n;
    s.chain.expected = 2_000n;
    s.reader.slot = (c) => 2_050n - (c.provider === 'backup' ? 1n : 0n);
    s.reader.provider = (c) => c.provider ?? 'primary';
    return s;
  }
  const alerts = (s: ReturnType<typeof setup>): number => s.log.lines.filter(([l, c, f]) => l === 'critical' && c === 'm04.clock_fault' && f.error_code === 'E_CLOCK').length;

  it('Z07-13.1-2: two providers agreeing past the ceiling are a clock fault: nothing stored, ONE critical E_CLOCK, no provider blamed; entries E_CLOCK, exits get the agreed read unstored', async () => {
    const s = await trailing();
    await s.time.advance(1_010);                                   // the primary's poll is past the ceiling: verified on the backup
    assert.equal(s.tracker.clockFault(), true);
    for (let i = 0; i < 5; i++) { s.chain.highest += 4n; s.reader.slot = () => s.chain.highest; await s.time.advance(1_000); }
    assert.deepEqual(s.outputs.snapshots, []);
    assert.equal(s.tracker.latest('a'), null);
    assert.equal(alerts(s), 1);
    assert.equal(s.metrics.count('snapshot_future_slot_total', { provider: 'primary' }) + s.metrics.count('snapshot_future_slot_total', { provider: 'backup' }), 0);
    const e = await s.tracker.freshRead('a', 8);
    assert.ok(!e.ok && e.error.code === 'E_CLOCK' && e.error.snapshot === null);
    const x = await s.tracker.freshRead('a', Number.POSITIVE_INFINITY);
    assert.ok(!x.ok && x.error.code === 'E_CLOCK' && x.error.snapshot?.providerSlot === s.chain.highest);
    assert.equal(s.tracker.latest('a'), null);
    assert.equal(alerts(s), 1);
    // Defence in depth (Z07-13.4): a slot past the ceiling has infinite lag.
    assert.equal(s.tracker.lagNow(x.error.snapshot as PoolSnapshot<FakePool>), Number.POSITIVE_INFINITY);
    s.tracker.stop();
  });

  it('agreement holds whichever provider is ahead of the other', async () => {
    const s = await trailing();
    s.reader.slot = (c) => (c.provider === 'backup' ? 2_052n : 2_050n);
    await s.time.advance(1_010);
    assert.equal(s.tracker.clockFault(), true);
    assert.equal(s.tracker.latest('a'), null);
    s.tracker.stop();
  });

  it('an entry read whose re-read on the next provider shows the clock fault is refused with E_CLOCK and no snapshot', async () => {
    const s = await trailing();
    s.tracker.stop();                                              // no polls: the entry read alone finds the fault
    const e = await s.tracker.freshRead('a', 8);
    assert.ok(!e.ok && e.error.code === 'E_CLOCK' && e.error.snapshot === null);
    assert.equal(s.tracker.clockFault(), true);
    assert.equal(s.tracker.latest('a'), null);
    assert.equal(alerts(s), 1);
  });

  it('R5 probe: a primary and a backup verify both at 1e12, then 60 s of honest polls: latest() follows the live quote; no fresh read returns a bogus slot', async () => {
    const s = setup();
    add(s.reader, 'a');
    s.tracker.watch('a', 'candidate');
    await s.tracker.settled();
    s.tracker.start();
    s.reader.provider = (c) => c.provider ?? 'primary';
    s.chain.expected = 1_000n;
    s.chain.highest = 1_000_000_000_000n;                          // M15 takes the bogus slot's word
    s.reader.slot = () => 1_000_000_000_000n;
    await s.time.advance(1_010);
    assert.equal(s.tracker.clockFault(), true);
    const during = await s.tracker.freshRead('a', 8);
    assert.ok(!during.ok && during.error.code === 'E_CLOCK' && during.error.snapshot === null);
    let quote = 2_000n;
    for (let t = 1; t <= 60; t++) {
      s.chain.expected = 1_000n + BigInt(4 * t);
      quote += 7n;
      s.reader.accounts.set('a:q', { owner: 'tok', data: u64(quote) });
      s.reader.slot = () => s.chain.expected as bigint;
      await s.time.advance(1_000);
      assert.equal(s.tracker.latest('a')?.pool.quote, quote, `t=${t}`);
    }
    assert.equal(s.tracker.latest('a')?.providerSlot, s.chain.expected);
    assert.ok(s.outputs.snapshots.every(({ s: x }) => x.providerSlot < 1_000_000n));
    assert.equal(s.tracker.clockFault(), false);
    const fresh = await s.tracker.freshRead('a', 8);
    assert.ok(fresh.ok && fresh.value.providerSlot === s.chain.expected && fresh.value.pool.quote === quote);
    const exit = await s.tracker.freshRead('a', Number.POSITIVE_INFINITY);
    assert.ok(exit.ok && exit.value.providerSlot === s.chain.expected);
    s.tracker.stop();
  });

  it('R6 probe: a trailing clock (5 slots) and a provider behind the tip by clock lag + 10: its lag is 15, measured against the newest accepted slot, and it is refused', async () => {
    const s = setup();
    add(s.reader, 'a');
    add(s.reader, 'b');
    s.tracker.watch('a', 'candidate');
    s.tracker.watch('b', 'candidate');
    await s.tracker.settled();
    s.chain.expected = 2_000n;                                     // the tip is 2,005
    s.chain.highest = 1_000_000_000_000n;                          // M15 poisoned: no help
    s.reader.provider = (c) => (c.keys[0] === 'b' ? 'backup' : 'primary');
    s.reader.slot = (c) => (c.keys[0] === 'b' ? 1_990n : 2_005n);
    const a = await s.tracker.freshRead('a', 8);
    assert.ok(a.ok && a.value.providerSlot === 2_005n);
    const b = await s.tracker.freshRead('b', 12);
    assert.ok(!b.ok && b.error.code === 'E_STALE');
    assert.equal(s.tracker.latest('b'), null);
    assert.deepEqual(s.outputs.lagging[0], ['backup', 15]);
    // Past PEER_WINDOW_MS the tip read no longer counts: the clock's own estimate stands.
    await s.time.advance(5_001);
    assert.ok((await s.tracker.freshRead('b', 12)).ok);
  });

  it('Z07-13.3 fault end: flip-flopping reads and under-ceiling reads from one provider keep the fault; 3 in a row from 2 providers end it', async () => {
    const s = await trailing();
    await s.time.advance(1_010);
    assert.equal(s.tracker.clockFault(), true);
    // Flip-flop: every other read is back past the ceiling, so no streak of 3 forms.
    let n = 0;
    s.reader.slot = () => (n++ % 2 === 0 ? 2_000n : 2_050n);
    await s.time.advance(10_000);
    assert.equal(s.tracker.clockFault(), true);
    assert.equal(s.tracker.latest('a')?.providerSlot ?? 2_000n, 2_000n);
    // Under the ceiling, but every answer from one provider: not enough.
    s.reader.slot = () => 2_000n;
    s.reader.provider = () => 'primary';
    await s.time.advance(10_000);
    assert.equal(s.tracker.clockFault(), true);
    assert.ok(!s.log.codes().includes('m04.clock_recovered'));
    assert.ok((await s.tracker.freshRead('a', 8)).ok === false);
    // A second provider confirms: the episode ends once, and entries work again.
    s.reader.provider = (c) => c.provider ?? 'primary';
    await s.time.advance(3_000);
    assert.equal(s.tracker.clockFault(), false);
    assert.equal(s.log.lines.filter(([, c]) => c === 'm04.clock_recovered').length, 1);
    assert.equal(alerts(s), 1);
    assert.ok((await s.tracker.freshRead('a', 8)).ok);
    // A new episode alerts again, once the backup's under-ceiling read has left the peer window (until then the
    // primary alone is ahead and blamed).
    s.reader.slot = () => 2_050n;
    await s.time.advance(8_000);
    assert.equal(s.tracker.clockFault(), true);
    assert.equal(alerts(s), 2);
    s.tracker.stop();
  });

  it('a lone provider ahead of both the clock and the other provider is refused and counted against it', async () => {
    const s = setup();
    add(s.reader, 'a');
    s.tracker.watch('a', 'candidate');
    await s.tracker.settled();
    s.chain.highest = 2_000n;
    s.reader.slot = (c) => (c.provider === 'backup' ? 2_500n : 2_000n);
    s.reader.provider = (c) => c.provider ?? 'primary';
    assert.ok((await s.tracker.freshRead('a', 8)).ok);              // the primary at the clock
    s.reader.slot = (c) => (c.provider === undefined ? 2_500n : 2_000n);
    s.reader.provider = (c) => (c.provider === undefined ? 'liar' : c.provider);
    const r = await s.tracker.freshRead('a', 8);
    assert.ok(r.ok && r.value.providerLabel !== 'liar');
    assert.equal(s.metrics.count('snapshot_future_slot_total', { provider: 'liar' }), 1);
    assert.equal(s.tracker.clockFault(), false);
    assert.ok(!s.log.codes().includes('m04.clock_fault'));
  });

  it('exit grade, one provider answers, past the ceiling: its read comes back UNSTORED as E_CLOCK with the alert; an exit is never blocked', async () => {
    const s = setup(undefined, ['only']);
    add(s.reader, 'a');
    s.tracker.watch('a', 'candidate');
    await s.tracker.settled();
    s.chain.highest = 2_050n;
    s.chain.expected = 2_000n;
    s.reader.slot = () => 2_050n;
    s.reader.provider = () => 'only';
    const x = await s.tracker.freshRead('a', Number.POSITIVE_INFINITY);
    assert.ok(!x.ok && x.error.code === 'E_CLOCK' && x.error.snapshot?.providerSlot === 2_050n);
    assert.equal(s.tracker.latest('a'), null);                      // unstored
    assert.equal(s.log.lines.filter(([l, c]) => l === 'critical' && c === 'm04.clock_fault').length, 1);
    const again = await s.tracker.freshRead('a', Number.POSITIVE_INFINITY);
    assert.ok(!again.ok && again.error.code === 'E_CLOCK');
    assert.equal(s.log.lines.filter(([, c]) => c === 'm04.clock_fault').length, 1);   // one alert per episode
    // Entry reads never use it, alone or sharing an exit read in flight.
    const e = await s.tracker.freshRead('a', 8);
    assert.ok(!e.ok && (e.error.code !== 'E_CLOCK' || e.error.snapshot === null));
    let release = (): void => {};
    s.reader.gate = new Promise((r) => { release = r; });
    const xs = s.tracker.freshRead('a', Number.POSITIVE_INFINITY);
    const es = s.tracker.freshRead('a', 8);
    await Promise.resolve();
    release();
    s.reader.gate = null;
    const [rx, re] = await Promise.all([xs, es]);
    assert.ok(!rx.ok && rx.error.code === 'E_CLOCK' && rx.error.snapshot !== null && !re.ok && re.error.code === 'E_CLOCK' && re.error.snapshot === null);
    assert.equal(s.metrics.count('snapshot_future_slot_total', { provider: 'only' }), 0);
    // Back under the ceiling, the next unconfirmed read alerts again.
    s.reader.slot = () => 2_000n;
    assert.ok((await s.tracker.freshRead('a', Number.POSITIVE_INFINITY)).ok);
    s.reader.slot = () => 2_050n;
    assert.ok(!(await s.tracker.freshRead('a', Number.POSITIVE_INFINITY)).ok);
    assert.equal(s.log.lines.filter(([, c]) => c === 'm04.clock_fault').length, 2);
  });

  it('verification reads of past-ceiling polls are spaced at least 2 s apart and never overlap', async () => {
    const s = setup(undefined, ['only']);
    add(s.reader, 'a');
    s.tracker.watch('a', 'position');
    await s.tracker.settled();
    s.chain.highest = 2_050n;
    s.chain.expected = 2_000n;
    s.reader.slot = () => 2_050n;
    s.reader.provider = () => 'only';
    s.reader.calls = [];
    await s.time.advance(5_000);                                    // 10 position polls, all unverified
    const verifies = s.reader.calls.filter((c) => c.priority === 2).length;
    assert.ok(verifies >= 2 && verifies <= 3, `${verifies}`);
    assert.equal(s.tracker.clockFault(), false);
    s.tracker.stop();
  });
});
