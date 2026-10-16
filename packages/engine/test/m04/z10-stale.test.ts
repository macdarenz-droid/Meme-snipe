// Ruling Z10-17 (amends Z07 M04, card Z10): a pool's stale lag is `stale_lag_slots` + its class's poll interval in
// slots. Found by the Z10 soak (113,242 `m04.pool_stale` lines in 48 h): tail pools, polled every 10 s, crossed the
// fixed 12-slot lag between polls and turned stale and fresh at each poll.
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

  it('the watched (candidate) class threshold changes only by its 1 s interval: 12 + 4 slots at 250 ms a slot', async () => {
    /** Slots of missed polls until the first pool.stale (the chain moves one slot each step). */
    const firstStale = async (slotMs: number): Promise<{ slots: number; lag: number }> => {
      const s = await setup('candidate', {}, 0n, slotMs);
      await s.run(2_000);
      s.reader.fail = true;
      const from = s.chain.highest;
      while (s.outputs.staleEvents.length === 0) { s.chain.highest += 1n; await s.time.advance(250); }
      s.tracker.stop();
      return { slots: Number(s.chain.highest - from), lag: s.outputs.staleEvents[0]?.lagSlots as number };
    };
    const t = await firstStale(250);
    // The monitor runs every 500 ms (2 slots here), so the first stale lag is the first check past the limit.
    assert.ok(t.lag === 17 || t.lag === 18, `lag ${t.lag}`);                // past 16 = stale_lag_slots 12 + ceil(1,000 / 250)
    // No usable slot time (0, NaN, ∞): the interval adds nothing, so the limit is stale_lag_slots alone, never looser.
    for (const bad of [0, Number.NaN, Number.POSITIVE_INFINITY]) {
      const lag = (await firstStale(bad)).lag;
      assert.ok(lag === 13 || lag === 14, `slot time ${bad}: lag ${lag}`);
    }
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
