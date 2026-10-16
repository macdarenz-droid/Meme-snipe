// Rulings Z10-17 and Z10-19 (amend Z07 M04, card Z10): a tail pool's stale lag is `stale_lag_slots` + its poll
// interval in slots; every other class keeps `stale_lag_slots` (M21 gates entries on watched pools,
// SPEC-A:905). Found by the Z10 soak (113,242 `m04.pool_stale` lines in 48 h): tail pools, polled every 10 s, crossed
// the fixed 12-slot lag between polls and turned stale and fresh at each poll.
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';
import { M04_DEFAULTS, type M04Settings } from '../../src/m04/settings.ts';
import { createPoolTracker } from '../../src/m04/tracker.ts';
import { FakeTime } from '../m14/helpers.ts';
import { FakeChain, fakeModel, Logs, Metrics, Outputs, poolAccounts, ScriptedReader } from './fake.ts';

async function setup(cls: 'candidate' | 'tail', settings: Partial<M04Settings> = {}, behindAtStart = 0n, slotMs = 250) {
  const time = new FakeTime();
  const reader = new ScriptedReader();
  const chain = new FakeChain();
  const outputs = new Outputs();
  const log = new Logs();
  const tracker = createPoolTracker({
    model: fakeModel, reader, scheduler: time, chain, clock: time, outputs, log, metrics: new Metrics(), settings: { ...M04_DEFAULTS, ...settings }, providerOrder: () => ['primary', 'backup'],
  });
  for (const [k, v] of poolAccounts('a', 1_000n, 2_000n)) reader.accounts.set(k, v);
  chain.slotMs = slotMs;
  let behind = behindAtStart;
  reader.slot = () => chain.highest - behind;
  tracker.watch('a', cls);
  await tracker.settled();
  tracker.start();
  /** Moves the chain on in real slot time (one slot each `chain.slotMs`) for `ms`. */
  const run = async (ms: number): Promise<void> => {
    const step = Number.isFinite(chain.slotMs) && chain.slotMs > 0 ? chain.slotMs : 250;
    for (let t = 0; t < ms; t += step) { chain.highest += 1n; await time.advance(step); }
  };
  return { time, reader, chain, outputs, log, tracker, run, setBehind: (n: bigint) => { behind = n; } };
}

describe('Z10-17 stale lag by class', () => {
  it('a tail pool polled every 10 s does not turn stale and fresh on schedule (fails before: stale at every poll)', async () => {
    const s = await setup('tail');
    await s.run(120_000);
    assert.deepEqual(s.outputs.staleEvents, []);
    assert.equal(s.log.lines.filter(([, c]) => c === 'm04.pool_stale').length, 0);
    s.tracker.stop();
  });

  it('a tail pool that misses 2 polls still turns stale, once', async () => {
    const s = await setup('tail');
    await s.run(20_000);
    s.reader.fail = true;
    await s.run(21_000);                                                    // two 10 s polls missed
    assert.equal(s.outputs.staleEvents.length, 1);
    s.reader.fail = false;
    await s.run(11_000);
    assert.deepEqual(s.outputs.freshEvents, ['a']);
    s.tracker.stop();
  });

  it('Z10-19: a watched (candidate) pool past stale_lag_slots is stale at once (lag 13 at the default 12), with any slot time; a tail pool within its interval is not (fails before: the watched pool waited to lag 17)', async () => {
    /** Missed polls until the first pool.stale (the chain moves one slot each step; the monitor runs every 2 slots). */
    const firstStale = async (cls: 'candidate' | 'tail', slotMs: number, maxSteps = 400): Promise<number | null> => {
      const s = await setup(cls, {}, 0n, slotMs);
      await s.run(2_000);
      s.reader.fail = true;
      for (let i = 0; i < maxSteps && s.outputs.staleEvents.length === 0; i++) { s.chain.highest += 1n; await s.time.advance(250); }
      s.tracker.stop();
      return s.outputs.staleEvents[0]?.lagSlots ?? null;
    };
    // Ruling Z10-36: pinned to exactly lag 13, one monitor tick (500 ms) each: lag 12 is not stale, lag 13 is.
    for (const slotMs of [250, 0, Number.NaN, Number.POSITIVE_INFINITY]) {
      const s = await setup('candidate', {}, 0n, slotMs);
      await s.run(2_000);
      s.reader.fail = true;
      const last = s.tracker.latest('a')?.providerSlot as bigint;
      s.chain.highest = last + 12n;
      await s.time.advance(M04_DEFAULTS.staleCheckMs);
      assert.equal(s.outputs.staleEvents.length, 0, `slot time ${slotMs}: stale at lag 12`);
      s.chain.highest = last + 13n;
      await s.time.advance(M04_DEFAULTS.staleCheckMs);
      assert.deepEqual(s.outputs.staleEvents.map((e) => e.lagSlots), [13], `slot time ${slotMs}`);
      s.tracker.stop();
    }
    // A tail pool 30 slots behind (inside its 12 + 40-slot limit at 250 ms, and within its 5 s + 10 s age) is not stale.
    assert.equal(await firstStale('tail', 250, 30), null);
  });

  it('entry-time freshness is not looser: freshRead(pool, 8) and freshRead(pool, 12) refuse a read one slot past', async () => {
    for (const limit of [8, 12]) {
      const s = await setup('candidate');
      s.setBehind(BigInt(limit + 1));
      await s.run(1_000);
      s.setBehind(BigInt(limit + 1));
      s.reader.slot = () => s.chain.highest - BigInt(limit + 1);
      const r = await s.tracker.freshRead('a', limit);
      assert.ok(!r.ok && r.error.code === 'E_STALE', `freshRead(pool, ${limit})`);
      s.tracker.stop();
    }
  });
});
