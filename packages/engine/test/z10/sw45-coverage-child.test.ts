// Card SWITCH-FIX-2 SW-45 (case (b) of the 192 h probe): the daily coverage report decoded a day's poll_counts in the
// recorder (one inflate a gzip member, about 12,660 a day), and the freed memory set glibc's [heap] high-water mark. It
// now runs in a short-lived child (m07/coverage-child.ts): the recorder makes no decode call, the report is the
// in-process job's byte for byte, a failed child is logged, held and retried without a tight loop, one child runs at
// a time, and the recorder's stop leaves no child behind.
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { describe, it, vi } from 'vitest';
import type { UnixMs } from '@bot/types';
import { WatchLog } from '../../src/m07/watch-log.ts';
import { checkCoverageReport, dailyCoverage } from '../../src/m07/daily.ts';
import { COVERAGE_CHILD, createDailyJob, type CoverageChildOptions } from '../../src/recorder-main/daily.ts';
import { STATE_CODES } from '../../src/recorder-main/compose.ts';
import { kvEvictionLog } from '../../src/recorder-main/evictions.ts';
import { openDb, type Db } from '../../src/m24/db.ts';
import { prepareDatabase } from '../../src/m24/migrate.ts';
import { fakeClock, tempDir } from '../helpers.ts';

// Every inflate the test process makes (the recorder's side), counted; the child is another process.
const inflates = vi.hoisted(() => ({ n: 0 }));
vi.mock('node:zlib', async (orig) => {
  const z = await orig<typeof import('node:zlib')>();
  return { ...z, inflateRawSync: (...a: Parameters<typeof z.inflateRawSync>) => { inflates.n++; return z.inflateRawSync(...a); } };
});

const DAY0 = '2026-10-15';
const T0 = Date.parse(`${DAY0}T00:00:00Z`);
const DAY = 86_400_000;
const ENTRY = fileURLToPath(new URL('../../src/m07/coverage-child.ts', import.meta.url));
const ms = (n: number): UnixMs => n as UnixMs;
const sleep = (n: number): Promise<void> => new Promise((r) => setTimeout(r, n));

/** A recorded day: 6 pools, 4 hour-segments of 3 gzip members each (as in SW-36). */
function day(): string {
  const dir = tempDir('sw45-md');
  const wl = new WatchLog(dir, () => undefined);
  for (let p = 0; p < 6; p++) wl.watch(`P${p}`, 'candidate', T0 as never);
  const index: object[] = [];
  for (let h = 0; h < 4; h++) {
    const hh = String(h).padStart(2, '0');
    fs.mkdirSync(join(dir, DAY0, hh), { recursive: true });
    const recs: string[] = [];
    for (let bar = 0; bar < 240; bar++) for (let p = 0; p < 6; p++) {
      const barStartMs = T0 + h * 3_600_000 + bar * 15_000;
      recs.push(`${JSON.stringify({ seq: String(recs.length), payload: { poolId: `P${p}`, barStartMs, durationMs: 15_000, minuteStartMs: barStartMs - (barStartMs % 60_000), successfulPolls: p === 5 ? 0 : 15, changedPolls: 0, failedPolls: 0, priorityClass: 'candidate' } })}\n`);
    }
    const third = Math.ceil(recs.length / 3);
    const bytes = Buffer.concat([0, 1, 2].map((k) => gzipSync(Buffer.from(recs.slice(k * third, (k + 1) * third).join('')))));
    const path = `${DAY0}/${hh}/poll_counts.ndjson.gz`;
    fs.writeFileSync(join(dir, path), bytes);
    index.push({ path, stream: 'poll_counts', firstSlot: null, lastSlot: null, records: recs.length, bytes: bytes.length, sha256: 'a'.repeat(64), gaps: [], codec: 'gzip',
      firstSeq: null, lastSeq: null, hourUtc: `${DAY0}T${hh}`, keyframes: 0, firstRecvMs: null, lastRecvMs: null });
  }
  fs.writeFileSync(join(dir, DAY0, 'index.json'), JSON.stringify(index));
  return dir;
}

async function rig(dataDir: string, child?: Partial<CoverageChildOptions>, firstStart = T0 + 1) {
  const path = join(tempDir('sw45-db'), 'm.db');
  const clock = { t: firstStart };
  const db: Db = openDb({ create: true, path, clock: fakeClock() });
  assert.equal((await prepareDatabase(db, { clock: fakeClock(), backupPath: `${path}.bak` })).ok, true);
  const logs: Array<{ code: string; f: Record<string, unknown> }> = [];
  const payloads: string[] = [];
  const job = createDailyJob({
    db, dataDir, evictions: kvEvictionLog(db, () => ms(clock.t)), limits: [], limitSetId: 'x', prefilterOnly: true,
    migrationCoverage: () => ({ chainMigrations: 0, seenByPumpPortal: 0, gapBps: 0 }), closedThrough: () => '2026-12-31T00',
    append: (r) => { if (r.stream === 'coverage') payloads.push(JSON.stringify(r.payload)); return 'queued'; }, nowMs: () => ms(clock.t),
    log: { event: (_l, code, f) => { logs.push({ code, f: { ...f } }); } }, ...(child === undefined ? {} : { coverageChild: child }),
  });
  /** Ticks (1 s of the job's clock each, 20 ms real) until `done` or 30 s. */
  const until = async (done: () => boolean, start = T0 + DAY + 700_000): Promise<void> => {
    clock.t = Math.max(clock.t, start);
    for (let i = 0; i < 1_500 && !done(); i++) { job.tick(ms((clock.t += 1_000))); await sleep(20); }
  };
  return { db, job, logs, payloads, clock, until, failures: () => logs.filter((l) => l.code === 'recorder.coverage_failed') };
}
const gone = (pid: number): boolean => { try { process.kill(pid, 0); return false; } catch (e) { return (e as { code?: string }).code === 'ESRCH'; } };
const node = (script: string): Partial<CoverageChildOptions> => ({ command: process.execPath, args: () => ['-e', script] });

describe('SW-45: the coverage report is built in a child process', () => {
  it('the recorder makes no decode call, and the record and saved row are the in-process job\'s bytes (fails before: the recorder decoded every member)', async () => {
    const dir = day();
    const r = await rig(dir);
    inflates.n = 0;
    await r.until(() => r.payloads.length > 0);
    assert.equal(r.payloads.length, 1, 'one report');
    assert.equal(inflates.n, 0, `${inflates.n} inflate calls in the recorder`);
    const row = r.db.reader().get('SELECT "json", "manifest_sha256" FROM "coverage_report" WHERE "day_utc" = ?', DAY0) as { json: string; manifest_sha256: string };
    const want = JSON.stringify(dailyCoverage({ dataDir: dir, dayUtc: DAY0, universeManifestSha256: row.manifest_sha256 }).report);
    assert.ok(inflates.n > 0, 'the in-process job decodes (the count works)');
    assert.equal(r.payloads[0], want);
    assert.equal(row.json, want);
    assert.equal(r.job.coverageFailed(), false);
  }, 60_000);

  it('a timeout kills the child, logs recorder.coverage_failed and holds it; the day is tried again only after retryMs, and a good try clears it', async () => {
    const dir = day();
    let spawns = 0;
    let hang = true;
    const r = await rig(dir, {
      timeoutMs: 300, retryMs: 600_000,
      args: (d, dd, sha) => { spawns++; return hang ? ['-e', 'setTimeout(() => {}, 60_000)'] : COVERAGE_CHILD.args(d, dd, sha); },
    });
    await r.until(() => r.failures().length > 0);
    assert.equal(r.failures()[0]?.f.reason, 'timeout');
    assert.equal(r.failures()[0]?.f.day, DAY0);
    assert.equal(r.job.coverageFailed(), true, 'held');
    assert.ok(STATE_CODES.has('recorder.coverage_failed'));
    assert.equal(r.job.coverageChild(), null, 'nothing running');
    // No tight loop: 590 s of ticks start nothing; the next try comes at 600 s.
    const failedAt = r.clock.t;
    for (let i = 0; i < 590; i++) r.job.tick(ms((r.clock.t += 1_000)));
    assert.equal(spawns, 1, 'no new child before retryMs');
    hang = false;
    await r.until(() => r.payloads.length > 0, failedAt + 600_000);
    assert.equal(spawns, 2);
    assert.equal(r.payloads.length, 1);
    assert.equal(r.job.coverageFailed(), false, 'cleared once the report is saved');
  }, 60_000);

  for (const [name, child, reason] of [
    ['a non-zero exit', node('process.exit(3)'), 'exit_3'],
    ['a crash', node('process.abort()'), 'signal_SIGABRT'],
    ['bad JSON', node('process.stdout.write("{not json")'), 'bad_output'],
    ['a report of another day', node(`process.stdout.write(JSON.stringify({ dayUtc: '2026-01-01', streams: [], universeManifestSha256: '${'0'.repeat(64)}', lowCoverage: false }))`), 'bad_output'],
    ['oversized output', { ...node('process.stdout.write("x".repeat(5000))'), maxBytes: 1_000 }, 'oversized'],
    ['a child that cannot start', { command: '/nonexistent/node', args: () => [] }, 'spawn_ENOENT'],
  ] as const) {
    it(`${name}: logged with reason ${reason}, held, no report`, async () => {
      const r = await rig(day(), child);
      await r.until(() => r.failures().length > 0);
      assert.equal(r.failures()[0]?.f.reason, reason);
      assert.equal(r.payloads.length, 0);
      assert.equal(r.db.reader().all('SELECT 1 FROM "coverage_report"').length, 0);
      assert.equal(r.job.coverageFailed(), true);
    }, 60_000);
  }

  it('one child at a time, and the manifest catch-up goes on while it runs', async () => {
    const dir = day();
    let spawns = 0;
    // First start 3 days back: two days need a manifest and a report.
    const r = await rig(dir, { args: () => { spawns++; return ['-e', 'setTimeout(() => {}, 60_000)']; } }, T0 - 2 * DAY);
    r.clock.t = T0 + DAY + 700_000;
    for (let i = 0; i < 30; i++) { r.job.tick(ms((r.clock.t += 1_000))); await sleep(5); }
    const shas = r.db.reader().all('SELECT "day_utc" FROM "universe_manifest" ORDER BY 1').map((x) => String(x.day_utc));
    assert.deepEqual(shas, ['2026-10-13', '2026-10-14', DAY0], 'every manifest built while a child runs');
    assert.equal(spawns, 1, 'one child');
    const pid = r.job.coverageChild();
    assert.ok(pid !== null);
    await r.job.stop();
    assert.ok(gone(pid), 'stopped with the job');
  }, 60_000);

  it('the recorder\'s stop kills a running child and leaves no orphan', async () => {
    const r = await rig(day(), { args: () => ['-e', 'setTimeout(() => {}, 60_000)'] });
    await r.until(() => r.job.coverageChild() !== null);
    const pid = r.job.coverageChild() as number;
    assert.ok(!gone(pid));
    await r.job.stop();
    assert.ok(gone(pid), `child ${pid} still running after stop`);
  }, 60_000);

  it('the child entry runs as a real child process: the report on stdout, nothing else; bad arguments exit 2', () => {
    const dir = day();
    const sha = 'b'.repeat(64);
    const out = execFileSync(process.execPath, ['--no-warnings', ENTRY, dir, DAY0, sha], { encoding: 'utf8', env: {} });
    assert.equal(out, JSON.stringify(dailyCoverage({ dataDir: dir, dayUtc: DAY0, universeManifestSha256: sha }).report));
    assert.notEqual(checkCoverageReport(out, DAY0, sha), null);
    assert.equal(checkCoverageReport(out, DAY0, 'c'.repeat(64)), null, 'another manifest hash is refused');
    assert.equal(checkCoverageReport(` ${out}`, DAY0, sha), null, 'not in JSON.stringify form');
    for (const args of [[dir, 'x', sha], [dir, DAY0, 'nothex'], [dir]]) {
      assert.throws(() => execFileSync(process.execPath, ['--no-warnings', ENTRY, ...args], { stdio: 'pipe', env: {} }), (e: unknown) => (e as { status: number }).status === 2);
    }
  }, 60_000);
});
