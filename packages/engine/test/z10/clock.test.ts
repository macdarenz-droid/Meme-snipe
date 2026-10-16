// Card Z10, SPEC-A C-84 on the composition root (rulings Z07-10, Z07-13, Z07-27, Z07-29, Z07-34): M04's chain port is
// M15's estimate anchored on two agreeing providers, never one; the skew test and the R6c probe run on the real wiring.
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';
import type { Pubkey, Slot, UnixMs } from '@bot/types';
import { createAgreedChainState } from '../../src/recorder-main/chain.ts';
import { tempDir } from '../helpers.ts';
import { FakeChain, VirtualTime } from './fake-chain.ts';
import { startRig, WALL_START, type Rig } from './rig.ts';

const crit = (r: Rig, code: string): number => r.lines.filter((l) => l.includes(`"level":"critical"`) && l.includes(`"code":"${code}"`)).length;
const ceiling = (r: Rig): bigint => r.rec.parts.chain.expectedSlot(r.time.nowMs()) + 10n;
const POOL = (r: Rig): Pubkey => r.chain.pools.find((p) => p.pool.startsWith('Dh39'))!.pool;

async function rigWith(label: string, set: (c: FakeChain) => void): Promise<Rig> {
  const time = new VirtualTime(WALL_START);
  const chain = new FakeChain(time, { seed: 3 });
  set(chain);
  return startRig(tempDir(label), { time, chain });
}

describe('Z10 C-84: the slot clock on the composition root', () => {
  // Ruling Z10-15 (finding Z10-F1): M04's verification reads go at P1, so the metered backup (M14 refuses P2+ there)
  // confirms or refutes a past-ceiling read; at most `pool_tracker.verify_daily_cap` a UTC day.
  const clockAlerts = (r: Rig): number => crit(r, 'm04.clock_fault') + crit(r, 'm04.clock_disagreement') + crit(r, 'recorder.clock_suspect');

  it('verification reads at P2 never reach the metered backup; P1 does (Z10-F1)', async () => {
    const r = await rigWith('z10-p2', () => {});
    try {
      await r.run(5_000);
      const call = (priority: 1 | 2) => r.rec.parts.read.gateway.call('getMultipleAccounts', [[POOL(r)], { encoding: 'base64' }], { priority, role: 'read', commitment: 'confirmed', timeoutMs: 2_000, provider: 'chainstack' });
      const p1 = call(1); await r.run(2_000);
      const p2 = call(2); await r.run(2_000);
      assert.equal((await p1).ok, true);
      const x = await p2;
      assert.ok(!x.ok && x.error.code === 'E_ALL_PROVIDERS_DOWN');
    } finally {
      await r.rec.stop();
    }
  }, 60_000);

  it('Z10-15: a primary lying far past the clock is excluded after strikes, the backup refuting it at P1; the backup is never blamed (fails before: verification at P2 never reached the backup)', async () => {
    // Shyft's reads run 300 slots ahead (past the ceiling + PLAUSIBLE_MARGIN_SLOTS); its height reading agrees at the tip.
    const r = await rigWith('z10-liar', (c) => { c.provider('shyft').slotOffset = 300; c.provider('shyft').heightOffset = -300; });
    try {
      await r.run(5_000);
      assert.ok(r.rec.status().anchored);
      assert.ok(r.rec.parts.tracker.watch(POOL(r), 'candidate'));
      await r.run(60_000);
      const blamed = r.lines.filter((l) => l.includes('"code":"m04.read_ahead_of_clock"'));
      assert.ok(blamed.length >= 1, 'the liar is blamed');
      assert.ok(blamed.every((l) => l.includes('"provider":"shyft"')), 'only the liar');
      const verifies = r.chain.byMethod.get('chainstack getMultipleAccounts') ?? 0;
      assert.ok(verifies >= 3, `the backup verified (${verifies} reads)`);
      const latest = r.rec.parts.tracker.latest(POOL(r));
      assert.ok(latest === null || latest.providerSlot <= ceiling(r), 'nothing past the ceiling stored');
      assert.equal(crit(r, 'm04.verify_cap_reached'), 0);
    } finally {
      await r.rec.stop();
    }
  }, 60_000);

  it('skew test: the clock trails the tip by more than max_provider_lag_slots: ONE critical clock alert, nothing past the ceiling stored, entries refused', async () => {
    const r = await rigWith('z10-skew', (c) => { c.provider('shyft').heightOffset = -30; c.provider('chainstack').heightOffset = -30; });
    try {
      await r.run(5_000);
      assert.ok(r.rec.status().anchored);
      assert.ok(r.chain.tipSlot() - BigInt(r.rec.status().anchor!.slot) >= 25n, 'the anchor is behind the tip');
      assert.ok(r.rec.parts.tracker.watch(POOL(r), 'candidate'));
      await r.run(60_000);
      assert.equal(clockAlerts(r), 1, 'one alert per episode');
      const latest = r.rec.parts.tracker.latest(POOL(r));
      assert.ok(latest === null || latest.providerSlot <= ceiling(r), 'nothing past the ceiling stored');
      const e = r.rec.parts.tracker.freshRead(POOL(r), 8);
      await r.run(3_000);
      const entry = await e;
      assert.ok(!entry.ok && entry.error.code === 'E_CLOCK', 'entries refused');
    } finally {
      await r.rec.stop();
    }
  }, 60_000);

  it('a lone provider ahead of the clock and of the other provider: nothing past the ceiling stored, entries refused, one critical alert, no clock fault', async () => {
    // Shyft's reads run 50 slots ahead; its height reading (the anchor) agrees with Chainstack at the tip.
    const r = await rigWith('z10-lone', (c) => { c.provider('shyft').slotOffset = 50; c.provider('shyft').heightOffset = -50; });
    try {
      await r.run(5_000);
      assert.ok(r.rec.status().anchored);
      assert.ok(r.rec.parts.tracker.watch(POOL(r), 'candidate'));
      await r.run(60_000);
      const latest = r.rec.parts.tracker.latest(POOL(r));
      assert.ok(latest === null || latest.providerSlot <= ceiling(r));
      assert.equal(crit(r, 'm04.clock_fault'), 0, 'nothing confirms the lone provider');
      assert.equal(clockAlerts(r), 1);
      const e = r.rec.parts.tracker.freshRead(POOL(r), 8);
      await r.run(3_000);
      assert.equal((await e).ok, false);
    } finally {
      await r.rec.stop();
    }
  }, 60_000);

  it('R6c on the composition root: the primary falls 20 behind, the backup stays at the tip: the anchor never follows the lagging primary, an entry read never uses its reads (it gets the backup fresh read instead), the backup is never blamed', async () => {
    const r = await rigWith('z10-r6c', () => {});
    try {
      await r.run(5_000);
      assert.ok(r.rec.status().anchored);
      assert.ok(r.rec.parts.tracker.watch(POOL(r), 'candidate'));
      await r.run(10_000);
      r.chain.provider('shyft').slotOffset = -20;                 // height and reads both 20 behind
      await r.run(120_000);
      // The two heights are 20 slots apart, so they never agree: the last agreed anchor stays and moves on at the slot
      // time.
      assert.deepEqual(r.rec.status().anchor?.providers, ['chainstack', 'shyft']);
      const est = r.rec.parts.chain.expectedSlot(r.time.nowMs());
      const tip = r.chain.tipSlot();
      assert.ok(tip - est >= -2n && tip - est <= 2n, `the clock stays at the tip (${tip - est} slots), never 15 or 20 behind`);
      const e = r.rec.parts.tracker.freshRead(POOL(r), 8);
      await r.run(3_000);
      // Never on the lagging primary's word (the R6c risk): an entry read gets the backup's fresh read instead.
      const x = await e;
      assert.ok(x.ok && x.value.providerLabel === 'chainstack', `entry read from ${x.ok ? x.value.providerLabel : x.error.code}`);
      const blamed = r.rec.parts.metrics.points('snapshot_future_slot_total', { provider: 'chainstack' }, 0, Number.MAX_SAFE_INTEGER);
      assert.ok(blamed.every((x) => x.value === 0), 'the backup is never blamed');
      assert.ok(!r.lines.some((l) => l.includes('m04.read_ahead_of_clock') && l.includes('chainstack')));
    } finally {
      await r.rec.stop();
    }
  }, 60_000);

  it('no anchor from one provider: two providers 20 slots apart never anchor, M04 does not start, one disagreement warning', async () => {
    const r = await rigWith('z10-noanchor', (c) => { c.provider('shyft').slotOffset = -20; });
    try {
      await r.run(120_000);
      assert.equal(r.rec.status().anchored, false);
      assert.ok(!r.codes().includes('recorder.started'));
      assert.equal(r.codes().filter((c) => c === 'recorder.anchor_disagreement').length, 1);
      // Agreement returns: the anchor is taken and the recorder starts.
      r.chain.provider('shyft').slotOffset = 0;
      await r.run(10_000);
      assert.equal(r.rec.status().anchored, true);
      assert.ok(r.codes().includes('recorder.started'));
    } finally {
      await r.rec.stop();
    }
  }, 60_000);
});

describe('Z10 anchor liveness', () => {
  it('the backup is read every minute although its context slot lags between reads (M15 heightOn would refuse it as lagging and never read it again)', async () => {
    const r = await rigWith('z10-live', () => {});
    try {
      await r.run(5_000);
      assert.ok(r.rec.status().anchored);
      const n0 = r.chain.byMethod.get('chainstack getEpochInfo') ?? 0;
      await r.run(5 * 60_000);
      const n1 = r.chain.byMethod.get('chainstack getEpochInfo') ?? 0;
      assert.ok(n1 - n0 >= 4, `chainstack heights read ${n1 - n0} times in 5 minutes`);
      assert.ok(r.rec.parts.chain.anchor()!.atMs >= r.time.nowMs() - 61_000, 'the anchor is fresh');
    } finally {
      await r.rec.stop();
    }
  }, 60_000);
});

describe('Z10 C-84 adapter (Z07-34): slot times of 0, NaN and Infinity', () => {
  const reading = (slot: bigint, atMs: number): { slot: Slot; atMs: number } => ({ slot: slot as Slot, atMs });
  for (const bad of [0, Number.NaN, Number.POSITIVE_INFINITY]) {
    it(`slotDurationMsEstimate ${bad}: passed through to M04 as it is; expectedSlot never throws, is never 0 and moves on at the last valid slot time`, async () => {
      let ms = 400;
      let now = 1_000_000;
      const chain = createAgreedChainState({
        clock: { highestSeenSlot: () => 5_000n as Slot, slotDurationMsEstimate: () => ms, providerSlotLag: () => 0 }, readHeight: async () => reading(5_000n, now),
        providers: ['a', 'b'], maxProviderLagSlots: 10, initialSlotMs: 400, nowMs: () => now as UnixMs, log: { event: () => {} },
      });
      assert.equal(await chain.refresh(), true);
      assert.equal(chain.expectedSlot(now), 5_000n);
      ms = bad;
      assert.ok(Object.is(chain.slotDurationMsEstimate(), bad) || chain.slotDurationMsEstimate() === bad, 'M04 sees the raw value');
      now += 4_000;
      const e = chain.expectedSlot(now);
      assert.equal(e, 5_010n, 'moved on at the last valid 400 ms');
      assert.ok(e > 0n);
      assert.doesNotThrow(() => chain.expectedSlot(Number.NaN));
    });
  }

  it('one reading alone never anchors (the other provider failed or answered slot 0); highestSeenBy is null unless exactly one provider holds the highest', async () => {
    const chain = createAgreedChainState({
      clock: { highestSeenSlot: () => 5_000n as Slot, slotDurationMsEstimate: () => 400, providerSlotLag: () => 0 },
      readHeight: async (p) => (p === 'a' ? reading(5_000n, 0) : null),
      providers: ['a', 'b'], maxProviderLagSlots: 10, initialSlotMs: 400, nowMs: () => 0 as UnixMs, log: { event: () => {} },
    });
    assert.equal(await chain.refresh(), false);
    assert.equal(chain.ready(), false);
    assert.throws(() => chain.expectedSlot(0), /no agreed slot-clock anchor/);
    assert.equal(chain.highestSeenBy(), null, 'both at lag 0: not independent');
    assert.throws(() => createAgreedChainState({ clock: { highestSeenSlot: () => 1n as Slot, slotDurationMsEstimate: () => 400, providerSlotLag: () => 0 }, readHeight: async () => reading(1n, 0), providers: ['a'], maxProviderLagSlots: 10, initialSlotMs: 400, nowMs: () => 0 as UnixMs, log: { event: () => {} } }), /two read providers/);
    const zero = createAgreedChainState({
      clock: { highestSeenSlot: () => 1n as Slot, slotDurationMsEstimate: () => 400, providerSlotLag: () => 0 }, readHeight: async () => reading(0n, 0),
      providers: ['a', 'b'], maxProviderLagSlots: 10, initialSlotMs: 400, nowMs: () => 0 as UnixMs, log: { event: () => {} },
    });
    assert.equal(await zero.refresh(), false, 'slot 0 is never an anchor');
  });

  it('the anchor is the lowest of the agreeing readings, so a provider ahead within the lag never moves the estimate forward', async () => {
    const chain = createAgreedChainState({
      clock: { highestSeenSlot: () => 5_008n as Slot, slotDurationMsEstimate: () => 400, providerSlotLag: (p) => (p === 'b' ? 0 : 8) },
      readHeight: async (p) => reading(p === 'a' ? 5_000n : 5_008n, 0),
      providers: ['a', 'b'], maxProviderLagSlots: 10, initialSlotMs: 400, nowMs: () => 0 as UnixMs, log: { event: () => {} },
    });
    assert.equal(await chain.refresh(), true);
    assert.equal(chain.anchor()?.slot, 5_000n);
    assert.equal(chain.highestSeenBy(), 'b');
  });
});
