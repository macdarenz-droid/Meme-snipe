// Ruling Z10-24 (red team MAJOR-1 on 57d04e6a): the heartbeat says when the recorder is unhealthy. Codes only (D27(c)),
// deduplicated; the newest stored slot as `last_processed_slot`, so the watchdog's slot_lag works.
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';
import { heartbeatBody, heartbeatHealth, LOOP_STALE_MS, UNANCHORED_ALERT_MS } from '../../src/recorder-main/health.ts';
import { tempDir } from '../helpers.ts';
import { FakeChain, VirtualTime } from './fake-chain.ts';
import { startRig, WALL_START } from './rig.ts';

describe('Z10-24 heartbeat health', () => {
  it('(a) the backup down from the start (M14 stops it after its failures): never anchored, and the heartbeat turns critical within 5 minutes, not before (fails before: no code)', async () => {
    const time = new VirtualTime(WALL_START);
    const chain = new FakeChain(time, { seed: 24 });
    chain.provider('chainstack').down = true;
    const r = await startRig(tempDir('z10-hb-a'), { time, chain });
    try {
      const h = heartbeatHealth(time.nowMs());
      const seen: Array<{ s: number; codes: string[] }> = [];
      for (let s = 20; s <= 360; s += 20) {
        await r.run(20_000);
        seen.push({ s, codes: h.codes({ nowMs: time.nowMs(), status: r.rec.status(), memoryHigh: false }) });
      }
      assert.equal(r.rec.status().anchored, false);
      const first = seen.find((x) => x.codes.includes('recorder.unanchored'));
      assert.ok(first !== undefined && first.s <= UNANCHORED_ALERT_MS / 1_000 + 20, JSON.stringify(seen.at(-1)));
      assert.ok(first.s >= UNANCHORED_ALERT_MS / 1_000, `too early: ${first.s} s`);
      assert.ok(seen.every((x) => x.codes.every((c) => /^[a-z0-9_]+(\.[a-z0-9_]+)+$/.test(c))), 'codes only');
    } finally {
      await r.rec.stop();
    }
  }, 120_000);

  it('(b) a loop whose tick stops turns the heartbeat critical within 30 s; a lost anchor counts from its loss', () => {
    const h = heartbeatHealth(0);
    const st = (lastTickMs: number, anchored = true) => ({ anchored, lastTickMs, halted: null, criticalCodes: [] as string[] });
    assert.deepEqual(h.codes({ nowMs: 10_000, status: st(10_000), memoryHigh: false }), []);
    assert.deepEqual(h.codes({ nowMs: 10_000 + LOOP_STALE_MS - 1, status: st(10_000), memoryHigh: false }), []);
    assert.deepEqual(h.codes({ nowMs: 10_000 + LOOP_STALE_MS, status: st(10_000), memoryHigh: false }), ['recorder.loop_stale']);
    // Anchored, then lost at 100 s: critical only 5 minutes after the loss.
    assert.deepEqual(h.codes({ nowMs: 100_000, status: st(100_000, false), memoryHigh: false }), []);
    assert.deepEqual(h.codes({ nowMs: 100_000 + UNANCHORED_ALERT_MS, status: st(100_000 + UNANCHORED_ALERT_MS, false), memoryHigh: false }), ['recorder.unanchored']);
    // Codes from M27 and the recorder's own, deduplicated and sorted; anything not a code is dropped.
    const all = h.codes({ nowMs: 500_000, status: { anchored: true, lastTickMs: 500_000, halted: 'write_failed:EPERM', criticalCodes: ['m07.recording_halted', 'm07.recording_halted', 'Pool 9xQ… lost 3 SOL'] }, memoryHigh: true });
    assert.deepEqual(all, ['m07.recording_halted', 'recorder.memory_high', 'recorder.recording_halted']);
    // No status at all (the recorder never started): unanchored after 5 minutes, and the loop counts from the start.
    assert.deepEqual(heartbeatHealth(0).codes({ nowMs: UNANCHORED_ALERT_MS, status: null, memoryHigh: false }), ['recorder.loop_stale', 'recorder.unanchored']);
  });

  it('(c) last_processed_slot is the newest stored snapshot slot (fails before: always null)', async () => {
    const time = new VirtualTime(WALL_START);
    const chain = new FakeChain(time, { seed: 25 });
    const r = await startRig(tempDir('z10-hb-c'), { time, chain });
    try {
      await r.run(5_000);
      for (const p of chain.pools.slice(0, 3)) assert.ok(r.rec.parts.tracker.watch(p.pool, 'candidate'));
      await r.run(30_000);
      const newest = chain.pools.slice(0, 3).map((p) => r.rec.parts.tracker.latest(p.pool)?.providerSlot ?? 0n).reduce((a, b) => (b > a ? b : a), 0n);
      assert.ok(newest > 0n);
      const st = r.rec.status();
      assert.equal(st.newestStoredSlot, newest.toString());
      const body = JSON.parse(heartbeatBody({ seq: 1, boot: 'b', gitSha: 'g', lastSlot: BigInt(st.newestStoredSlot as string), critical: [], ownerChat: null, uptimeS: 1 }, time.nowMs(), false)) as { last_processed_slot: number };
      assert.equal(BigInt(body.last_processed_slot), newest);
    } finally {
      await r.rec.stop();
    }
  }, 120_000);
});
