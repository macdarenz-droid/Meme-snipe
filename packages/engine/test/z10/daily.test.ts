// Card Z10: the 00:00 UTC jobs on the composition root: the previous day's universe manifest (A-M05-03), then its
// CoverageReport (A-M07-03), each once; the report carries the manifest's SHA-256.
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';
import { tempDir } from '../helpers.ts';
import { FakeChain, VirtualTime } from './fake-chain.ts';
import { createDailyJob } from '../../src/recorder-main/daily.ts';
import { kvEvictionLog } from '../../src/recorder-main/evictions.ts';
import type { UnixMs } from '@bot/types';
import { startRig } from './rig.ts';

describe('Z10 daily jobs', () => {
  it('after 00:00 UTC: one universe_manifest row and one coverage_report row for the previous day, linked by the SHA-256; nothing for days before the first start', async () => {
    const time = new VirtualTime(Date.UTC(2026, 9, 6, 23, 40, 0));
    const chain = new FakeChain(time, { seed: 9 });
    const r = await startRig(tempDir('z10-daily'), { time, chain });
    try {
      await r.run(5_000);
      assert.ok(r.rec.parts.tracker.watch(chain.pools[0]!.pool, 'candidate'));
      await r.run(30 * 60_000);
      const rd = r.rec.parts.db.reader();
      const manifests = rd.all('SELECT "day_utc", "sha256" FROM "universe_manifest" ORDER BY "day_utc"') as Array<{ day_utc: string; sha256: string }>;
      assert.deepEqual(manifests.map((m) => m.day_utc), ['2026-10-06']);
      const reports = rd.all('SELECT "day_utc", "manifest_sha256", "low_coverage" FROM "coverage_report"') as Array<{ day_utc: string; manifest_sha256: string; low_coverage: unknown }>;
      assert.equal(reports.length, 1);
      assert.equal(reports[0]!.day_utc, '2026-10-06');
      assert.equal(reports[0]!.manifest_sha256, manifests[0]!.sha256);
      assert.equal(r.codes().filter((c) => c === 'recorder.universe_manifest').length, 1);
      assert.equal(r.codes().filter((c) => c === 'recorder.coverage_report').length, 1);
      assert.ok(!r.codes().includes('recorder.internal_error'), r.lines.filter((l) => l.includes('internal_error')).join('\n'));
    } finally {
      await r.rec.stop();
    }
  }, 120_000);

  it('finding Z10-F5: the recorder takes a manifest of 100 kB (the soak\'s second day was 100,566 bytes; fails before: E_TOO_LARGE at 64 KiB)', async () => {
    const time = new VirtualTime(Date.UTC(2026, 9, 6, 17, 30, 0));
    const r = await startRig(tempDir('z10-big'), { time, chain: new FakeChain(time, { seed: 9 }) });
    try {
      await r.run(2_000);
      const payload = { dayUtc: '2026-10-06', eligible: Array.from({ length: 240 }, (_, i) => ({ poolId: `p${i}`.padEnd(44, 'x'), reason: 'r'.repeat(300) })) };
      assert.ok(JSON.stringify(payload).length > 80_000);
      assert.equal(r.rec.parts.queue.append({ stream: 'universe_manifest', recvMs: time.nowMs() as UnixMs, slot: null, commitment: null, source: 'm05', payload }), 'queued');
    } finally {
      await r.rec.stop();
    }
  }, 60_000);

  it('finding Z10-F5: a manifest M07 refuses is never marked saved: no universe_manifest row, no coverage report, ONE critical line', async () => {
    const time = new VirtualTime(Date.UTC(2026, 9, 6, 23, 40, 0));
    const r = await startRig(tempDir('z10-refused'), { time, chain: new FakeChain(time, { seed: 9 }) });
    try {
      await r.run(2_000);
      const db = r.rec.parts.db;
      const lines: Array<[string, string]> = [];
      const job = createDailyJob({
        db, dataDir: r.paths.mdDir, evictions: kvEvictionLog(db, () => time.nowMs() as UnixMs), limits: [], limitSetId: 'x', prefilterOnly: true,
        migrationCoverage: () => ({ chainMigrations: 0, seenByPumpPortal: 0, gapBps: 0 }), closedThrough: () => '2026-10-06T23',
        append: () => ({ rejected: 'E_TOO_LARGE' }), nowMs: () => time.nowMs() as UnixMs, log: { event: (level, code) => { lines.push([level, code]); } },
      });
      for (let i = 0; i < 3; i++) job.tick(Date.UTC(2026, 9, 7, 0, 1, i) as UnixMs);
      const rd = db.reader();
      assert.equal(rd.all('SELECT 1 FROM "universe_manifest"').length, 0);
      assert.equal(rd.all('SELECT 1 FROM "coverage_report"').length, 0);
      assert.deepEqual(lines.filter(([, c]) => c === 'recorder.manifest_not_recorded'), [['critical', 'recorder.manifest_not_recorded']]);
    } finally {
      await r.rec.stop();
    }
  }, 60_000);
});
