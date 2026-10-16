// Rulings Z10-24, Z10-41 and Z10-44: the heartbeat says when the recorder is unhealthy, for as long as it is. Codes only
// (D27(c)), deduplicated; state codes hold exactly while their condition does; the loop's age is monotonic; the newest
// stored slot is `last_processed_slot`, so the watchdog's slot_lag works.
import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { describe, it } from 'vitest';
import { STATE_CODES, UNANCHORED_MS } from '../../src/recorder-main/compose.ts';
import { heartbeatBody, heartbeatHealth, LOOP_STALE_MS, UNANCHORED_ALERT_MS, type HealthStatus } from '../../src/recorder-main/health.ts';
import { tempDir } from '../helpers.ts';
import { FakeChain, VirtualTime } from './fake-chain.ts';
import { startRig, WALL_START, type Rig } from './rig.ts';

/** Payloads of every `decision` record on disk (sealed or open; gzip members are concatenated frames). */
function decisions(dir: string): Array<{ kind?: string; anchored?: boolean }> {
  const out: Array<{ kind?: string; anchored?: boolean }> = [];
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) out.push(...decisions(p));
    else if (/^decision(\.p\d+)?\.ndjson\.gz$/.test(n)) for (const l of gunzipSync(readFileSync(p)).toString('utf8').split('\n')) if (l !== '') out.push((JSON.parse(l) as { payload: { kind?: string; anchored?: boolean } }).payload);
  }
  return out;
}

const beat = (r: Rig, h: ReturnType<typeof heartbeatHealth>): string[] => h.codes({ monoMs: r.time.elapsedMs(), status: r.rec.status(), memoryHigh: false });

describe('Z10-24, Z10-41, Z10-44 heartbeat health', () => {
  it('(a) the backup down from the start: never anchored, recorder.unanchored at 10 minutes and not before, and it stays (fails before: no code)', async () => {
    const time = new VirtualTime(WALL_START);
    const chain = new FakeChain(time, { seed: 24 });
    chain.provider('chainstack').down = true;
    const r = await startRig(tempDir('z10-hb-a'), { time, chain });
    try {
      const h = heartbeatHealth(time.elapsedMs());
      const seen: Array<{ s: number; codes: string[] }> = [];
      for (let s = 30; s <= 25 * 60; s += 30) { await r.run(30_000); seen.push({ s, codes: beat(r, h) }); }
      assert.equal(r.rec.status().anchored, false);
      const first = seen.find((x) => x.codes.includes('recorder.unanchored'));
      assert.ok(first !== undefined && first.s >= UNANCHORED_MS / 1_000 && first.s <= UNANCHORED_MS / 1_000 + 30, JSON.stringify(first));
      assert.ok(seen.filter((x) => x.s >= first.s).every((x) => x.codes.includes('recorder.unanchored')), 'held while the condition holds, past 15 minutes');
      assert.ok(seen.every((x) => x.codes.every((c) => /^[a-z0-9_]+(\.[a-z0-9_]+)+$/.test(c))), 'codes only');
    } finally {
      await r.rec.stop();
    }
  }, 180_000);

  it('Z10-41: Chainstack stopped after anchoring: the heartbeat turns critical (unanchored, provider stopped) within the limit and stays critical past 15 minutes (fails before: the anchor never aged, and codes cleared after 15 minutes)', async () => {
    const time = new VirtualTime(WALL_START);
    const chain = new FakeChain(time, { seed: 41 });
    const r = await startRig(tempDir('z10-hb-stop'), { time, chain });
    try {
      const h = heartbeatHealth(time.elapsedMs());
      await r.run(10_000);
      assert.ok(r.rec.status().anchored);
      assert.deepEqual(beat(r, h).filter((c) => c === 'recorder.unanchored'), []);
      chain.provider('chainstack').limited = true;                         // M14 stops it after its rate limits
      const seen: Array<{ s: number; codes: string[] }> = [];
      for (let s = 30; s <= 30 * 60; s += 30) { await r.run(30_000); seen.push({ s, codes: beat(r, h) }); }
      const first = seen.find((x) => x.codes.includes('recorder.unanchored'));
      assert.ok(first !== undefined && first.s <= UNANCHORED_MS / 1_000 + 60, `unanchored at ${first?.s} s`);
      const late = seen.filter((x) => x.s >= first.s);
      assert.ok(late.every((x) => x.codes.includes('recorder.unanchored')), 'still critical 30 minutes after the stop');
      assert.ok(seen.at(-1)!.codes.includes('m14.provider_stopped'), JSON.stringify(seen.at(-1)));
      assert.ok(r.lines.some((l) => l.includes('"code":"recorder.unanchored"') && l.includes('"level":"critical"')));
      // The recording says so: a decision record marks the change to unanchored.
      await r.rec.stop();
      assert.ok(decisions(r.paths.mdDir).some((x) => x.kind === 'recorder_clock' && x.anchored === false), 'the recording marks the change');
    } finally {
      await r.rec.stop();
    }
  }, 240_000);

  it('(b) a stopped loop is critical within 30 s on the monotonic clock; a forward wall-clock step is not (Z10-44)', () => {
    const h = heartbeatHealth(0);
    const st = (lastTickMonoMs: number, activeCodes: string[] = []): HealthStatus => ({ lastTickMonoMs, halted: null, criticalCodes: [], activeCodes });
    assert.deepEqual(h.codes({ monoMs: 10_000, status: st(10_000), memoryHigh: false }), []);
    assert.deepEqual(h.codes({ monoMs: 10_000 + LOOP_STALE_MS - 1, status: st(10_000), memoryHigh: false }), []);
    assert.deepEqual(h.codes({ monoMs: 10_000 + LOOP_STALE_MS, status: st(10_000), memoryHigh: false }), ['recorder.loop_stale']);
    const all = h.codes({ monoMs: 500_000, status: { lastTickMonoMs: 500_000, halted: 'write_failed:EPERM', criticalCodes: ['m07.recording_halted', 'm07.recording_halted', 'Pool 9xQ… lost 3 SOL'], activeCodes: ['recorder.unanchored'] }, memoryHigh: true });
    assert.deepEqual(all, ['m07.recording_halted', 'recorder.memory_high', 'recorder.recording_halted', 'recorder.unanchored']);
    assert.deepEqual(heartbeatHealth(0).codes({ monoMs: UNANCHORED_ALERT_MS, status: null, memoryHigh: false }), ['recorder.loop_stale', 'recorder.unanchored']);
    for (const c of ['m14.provider_stopped', 'm04.verify_cap_reached', 'recorder.clock_suspect', 'm07.unpulled_segments', 'recorder.manifest_not_recorded', 'recorder.unanchored']) assert.ok(STATE_CODES.has(c), c);
  });

  it('Z10-44 on the composition root: a 2 h forward wall-clock step raises no loop_stale (fails before: the tick age was wall time)', async () => {
    const time = new VirtualTime(WALL_START);
    const r = await startRig(tempDir('z10-hb-step'), { time, chain: new FakeChain(time, { seed: 44 }) });
    try {
      const h = heartbeatHealth(time.elapsedMs());
      await r.run(10_000);
      time.wallOffsetMs += 2 * 3_600_000;
      assert.ok(!beat(r, h).includes('recorder.loop_stale'));
      await r.run(5_000);
      assert.ok(!beat(r, h).includes('recorder.loop_stale'));
    } finally {
      await r.rec.stop();
    }
  }, 120_000);

  it('Z10-52: twelve or more active codes are all sent, the same list on every beat (fails before: the first 10 only)', () => {
    const h = heartbeatHealth(0);
    const active = ['m04.verify_cap_reached', 'm07.unpulled_segments', 'm14.provider_stopped', 'recorder.clock_suspect', 'recorder.manifest_not_recorded', 'recorder.unanchored', 'm07.recording_halted', 'm07.write_failed', 'm04.watch_refused', 'recorder.facts_read_failed', 'm05.retry_failed', 'm01.fee_config_refresh_failed'];
    const bodies = [0, 1, 2].map((k) => {
      const codes = h.codes({ monoMs: 600_000 + k * 1_000, status: { lastTickMonoMs: 600_000 + k * 1_000, halted: 'write_failed:EIO', criticalCodes: [], activeCodes: k === 1 ? [...active].reverse() : active }, memoryHigh: true });
      return (JSON.parse(heartbeatBody({ seq: k, boot: 'b', gitSha: 'g', lastSlot: null, critical: codes, ownerChat: null, uptimeS: 1 }, 1_000 + k, false)) as { critical: string[] }).critical;
    });
    assert.equal(bodies[0]?.length, 14);
    assert.deepEqual(bodies[0], [...active, 'recorder.memory_high', 'recorder.recording_halted'].sort());
    assert.deepEqual(bodies[1], bodies[0]);
    assert.deepEqual(bodies[2], bodies[0]);
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

  it('Z10-51: status() (and so /health) reads no database: the state codes come from the last loop tick', async () => {
    const time = new VirtualTime(WALL_START);
    const r = await startRig(tempDir('z10-hb-nodb'), { time, chain: new FakeChain(time, { seed: 51 }) });
    try {
      await r.run(5_000);
      const db = r.rec.parts.db;
      let reads = 0;
      const orig = db.reader.bind(db);
      db.reader = () => { reads++; return orig(); };
      for (let i = 0; i < 20; i++) r.rec.status();
      assert.equal(reads, 0);
      db.reader = orig;
    } finally {
      await r.rec.stop();
    }
  }, 60_000);
});
