// Card SWITCH-FIX-2 SW-28 (RT2-d): a catch-up day (k = 7..2, the recorder was down across a day boundary) gets its
// coverage report too, once its D+1 hour 00 is closed, not only its universe manifest. SW-31 (RT1-4): the disk warning
// is a held state code.
import { strict as assert } from 'node:assert';
import { mkdirSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import type { UnixMs } from '@bot/types';
import { STATE_CODES } from '../../src/recorder-main/compose.ts';
import { createDailyJob } from '../../src/recorder-main/daily.ts';
import { kvEvictionLog } from '../../src/recorder-main/evictions.ts';
import { tempDir } from '../helpers.ts';
import { FakeChain, VirtualTime } from './fake-chain.ts';
import { startRig } from './rig.ts';

describe('SW-28: catch-up days get their coverage report', () => {
  it('down for all of D+1: at D+2 both D and D+1 get a report once each one\'s next hour 00 is closed, each once (fails before: D had none)', async () => {
    const time = new VirtualTime(Date.UTC(2026, 9, 6, 23, 40, 0));
    const r = await startRig(tempDir('sw28'), { time, chain: new FakeChain(time, { seed: 9 }) });
    try {
      await r.run(2_000);
      const db = r.rec.parts.db;
      const reports: string[] = [];
      const appended: string[] = [];
      let closed = '2026-10-06T23';                                         // the writer has not closed D+1/00 yet
      const job = createDailyJob({
        db, dataDir: r.paths.mdDir, evictions: kvEvictionLog(db, () => time.nowMs() as UnixMs), limits: [], limitSetId: 'x', prefilterOnly: true,
        migrationCoverage: () => ({ chainMigrations: 0, seenByPumpPortal: 0, gapBps: 0 }), closedThrough: () => closed,
        append: (a) => { appended.push(a.stream); return 'queued'; }, nowMs: () => time.nowMs() as UnixMs,
        log: { event: (_l, code, f) => { if (code === 'recorder.coverage_report') reports.push(String(f.day)); } },
      });
      const d2 = Date.UTC(2026, 9, 8, 0, 10, 0);
      let t = d2;
      // SW-36: a report is built over several ticks (one bounded step each); tick until it is saved, at most 100.
      const tickUntil = (n: number): void => { for (let i = 0; i < 100 && reports.length < n; i++) job.tick((t += 1_000) as UnixMs); };
      for (let i = 0; i < 20; i++) job.tick((t += 1_000) as UnixMs);
      assert.deepEqual(reports, [], 'no report while its D+1 hour 00 is open');
      closed = '2026-10-07T23';
      tickUntil(1);
      assert.deepEqual(reports, ['2026-10-06'], 'the catch-up day\'s report, once 2026-10-07T00 is closed');
      for (let i = 0; i < 20; i++) job.tick((t += 1_000) as UnixMs);
      assert.deepEqual(reports, ['2026-10-06'], 'D+1 waits for its own hour 00');
      closed = '2026-10-08T00';
      tickUntil(2);
      for (let i = 0; i < 20; i++) job.tick((t += 1_000) as UnixMs);
      assert.deepEqual(reports, ['2026-10-06', '2026-10-07'], 'each day once');
      const rows = db.reader().all('SELECT "day_utc", "manifest_sha256" FROM "coverage_report" ORDER BY "day_utc"') as Array<{ day_utc: string; manifest_sha256: string }>;
      const shas = db.reader().all('SELECT "day_utc", "sha256" FROM "universe_manifest" ORDER BY "day_utc"') as Array<{ day_utc: string; sha256: string }>;
      assert.deepEqual(rows.map((x) => [x.day_utc, x.manifest_sha256]), shas.map((x) => [x.day_utc, x.sha256]));
      assert.deepEqual(appended, ['universe_manifest', 'universe_manifest', 'coverage', 'coverage']);
    } finally {
      await r.rec.stop();
    }
  }, 60_000);

  it('a catch-up day whose manifest was refused gets no report (Z10-F5) and is not looked at again', async () => {
    const time = new VirtualTime(Date.UTC(2026, 9, 6, 23, 40, 0));
    const r = await startRig(tempDir('sw28-refused'), { time, chain: new FakeChain(time, { seed: 9 }) });
    try {
      await r.run(2_000);
      const db = r.rec.parts.db;
      let calls = 0;
      const job = createDailyJob({
        db, dataDir: r.paths.mdDir, evictions: kvEvictionLog(db, () => time.nowMs() as UnixMs), limits: [], limitSetId: 'x', prefilterOnly: true,
        migrationCoverage: () => ({ chainMigrations: 0, seenByPumpPortal: 0, gapBps: 0 }), closedThrough: () => '2026-10-08T00',
        append: () => { calls++; return { rejected: 'E_TOO_LARGE' }; }, nowMs: () => time.nowMs() as UnixMs, log: { event: () => undefined },
      });
      const d2 = Date.UTC(2026, 9, 8, 0, 10, 0);
      job.tick(d2 as UnixMs);
      job.tick((d2 + 1_000) as UnixMs);
      assert.equal(db.reader().all('SELECT 1 FROM "coverage_report"').length, 0);
      assert.equal(calls, 2, 'the catch-up day once, yesterday once');
    } finally {
      await r.rec.stop();
    }
  }, 60_000);
});

describe('SW-31: the 75% disk warning reaches the heartbeat as a held state code', () => {
  it('m07.disk_budget_high is an active code while the recorder is at or over 75% of recorder.max_bytes, and only then (fails before: log only)', async () => {
    const GIB = 1_073_741_824;
    const r = await startRig(tempDir('sw31'), { config: { 'recorder.max_bytes': GIB } });
    try {
      await r.run(65_000);                                                  // one disk check (recorder.disk_check_ms 60 s)
      assert.ok(!r.rec.status().activeCodes.includes('m07.disk_budget_high'));
      // A sparse watch-log file of yesterday (it counts against the cap, Z10-26, and is inside retention, so it is kept)
      // takes the recorder to 80% without using the disk.
      mkdirSync(join(r.paths.mdDir, 'watch'), { recursive: true });
      const big = join(r.paths.mdDir, 'watch', `${new Date(r.time.nowMs() - 86_400_000).toISOString().slice(0, 10)}.ndjson`);
      writeFileSync(big, '');
      truncateSync(big, Math.ceil(0.8 * GIB));
      await r.run(65_000);
      assert.ok(r.rec.status().activeCodes.includes('m07.disk_budget_high'), String(r.rec.status().activeCodes));
      assert.ok(STATE_CODES.has('m07.disk_budget_high'));
      truncateSync(big, Math.ceil(0.5 * GIB));
      await r.run(65_000);
      assert.ok(!r.rec.status().activeCodes.includes('m07.disk_budget_high'), 'cleared below 75%');
    } finally {
      await r.rec.stop();
    }
  }, 120_000);
});
