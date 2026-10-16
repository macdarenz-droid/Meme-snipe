// Card Z10: the 00:00 UTC jobs on the composition root: the previous day's universe manifest (A-M05-03), then its
// CoverageReport (A-M07-03), each once; the report carries the manifest's SHA-256.
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';
import { tempDir } from '../helpers.ts';
import { FakeChain, VirtualTime } from './fake-chain.ts';
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
});
