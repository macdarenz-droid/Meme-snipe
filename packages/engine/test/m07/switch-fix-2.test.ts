// Card SWITCH-FIX-2 (the three red teams on 3439ee02): SW-29, md-pull's copy of a day's watch log; SW-35, the daily
// coverage's poll_counts reader; SW-36, the daily coverage in bounded steps.
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import { gzipSync } from 'node:zlib';
import { computeCoverage, coverageRun } from '../../src/m07/coverage.ts';
import { dailyCoverageJob, dayManifests, eachPollCount, pollCountsOf } from '../../src/m07/daily.ts';
import { WatchLog } from '../../src/m07/watch-log.ts';
import { frameLines, scanGzipFrames } from '../../src/m07/frames.ts';
import { sftpTransport } from '../../src/m07/md-pull.ts';
import { tempDir } from '../helpers.ts';

const DAY = '2026-10-15';

/** A stand-in sftp: answers `ls` from the given listings, and `get` by writing its local target (or failing). */
function host(o: { md: string[]; watch?: string[]; get: 'ok' | 'torn' | 'fail'; lsFails?: boolean }) {
  const batches: string[] = [];
  const run = (_args: string[], batch: string): { status: number; stdout: string } => {
    batches.push(batch);
    const lines = batch.trim().split('\n');
    if (lines[0] === 'ls -1 md') return o.lsFails === true ? { status: 1, stdout: '' } : { status: 0, stdout: o.md.map((n) => `md/${n}\n`).join('') };
    if (lines[0] === 'ls -1 md/watch') return { status: 0, stdout: (o.watch ?? []).map((n) => `md/watch/${n}\n`).join('') };
    const lcd = /^lcd (\S+)$/.exec(lines[0] ?? '')?.[1] as string;
    const target = (lines[1] ?? '').split(' ')[2] as string;
    if (o.get === 'fail') return { status: 1, stdout: '' };
    fs.writeFileSync(join(lcd, target), o.get === 'torn' ? '{"e":"wat' : '{"e":"watch"}\n');
    return o.get === 'torn' ? { status: 1, stdout: '' } : { status: 0, stdout: '' };
  };
  return { run, batches };
}
const setup = () => {
  const root = tempDir('sw29');
  fs.mkdirSync(join(root, 'watch'));
  return { root, final: join(root, 'watch', `${DAY}.ndjson`), part: join(root, 'watch', `${DAY}.ndjson.part`) };
};

describe('SW-29: md-pull skips only a missing watch log; any other failure throws and leaves no copy', () => {
  it('no watch folder on the host yet, or no log for the day: nothing fetched, no error', () => {
    const { root, final } = setup();
    const a = host({ md: [DAY, 'receipts'], get: 'fail' });
    sftpTransport('h', a.run).fetchWatch?.(DAY, root);
    assert.deepEqual(a.batches, ['ls -1 md\n']);
    const b = host({ md: [DAY, 'watch'], watch: ['2026-10-14.ndjson'], get: 'fail' });
    sftpTransport('h', b.run).fetchWatch?.(DAY, root);
    assert.deepEqual(b.batches, ['ls -1 md\n', 'ls -1 md/watch\n']);
    assert.equal(fs.existsSync(final), false);
  });

  it('a listed log is fetched whole: into a .part file, then renamed', () => {
    const { root, final, part } = setup();
    const a = host({ md: ['watch'], watch: [`${DAY}.ndjson`], get: 'ok' });
    sftpTransport('h', a.run).fetchWatch?.(DAY, root);
    assert.equal(a.batches[2], `lcd ${root}\nget md/watch/${DAY}.ndjson watch/${DAY}.ndjson.part\n`);
    assert.equal(fs.readFileSync(final, 'utf8'), '{"e":"watch"}\n');
    assert.equal(fs.existsSync(part), false);
  });

  it('a failed get throws, removes its partial file and the older copy (the host still has the log)', () => {
    const { root, final, part } = setup();
    fs.writeFileSync(final, '{"e":"watch","old":true}\n');               // an earlier pull's copy, from mid-day
    const a = host({ md: ['watch'], watch: [`${DAY}.ndjson`], get: 'torn' });
    assert.throws(() => sftpTransport('h', a.run).fetchWatch?.(DAY, root), /sftp exited 1/);
    assert.equal(fs.existsSync(part), false);
    assert.equal(fs.existsSync(final), false);
  });

  it('a failed listing throws (never read as "no log")', () => {
    const { root } = setup();
    assert.throws(() => sftpTransport('h', host({ md: [], get: 'ok', lsFails: true }).run).fetchWatch?.(DAY, root), /sftp exited 1/);
  });
});

describe('SW-35: the daily coverage reads poll_counts one gzip member at a time', () => {
  const rec = (i: number) => `${JSON.stringify({ seq: String(i), payload: { poolId: 'P', barStartMs: i * 15_000, successfulPolls: 15 } })}\n`;
  const members = (n: number, per: number): Buffer => Buffer.concat(Array.from({ length: n }, (_, m) => gzipSync(Buffer.from(Array.from({ length: per }, (_, k) => rec(m * per + k)).join('')))));

  it('frameLines yields the lines of every member in order, lazily, and returns why it stopped (fails before: no frameLines)', () => {
    const buf = members(3, 4);
    const it = frameLines(buf);
    assert.equal(JSON.parse(it.next().value as string).seq, '0');               // the first member only, so far
    const rest = [...it];
    assert.equal(rest.length, 11);
    const all: string[] = [];
    scanGzipFrames(buf, (l) => all.push(l));
    assert.deepEqual(rest, all.slice(1));
    const torn = buf.subarray(0, buf.length - 5);
    const g = frameLines(torn);
    let r = g.next();
    while (r.done !== true) r = g.next();
    assert.equal(r.value, 'torn');
  });

  it('eachPollCount gives every record of a multi-member segment, and nothing for one that does not decode whole', () => {
    const dir = tempDir('sw35');
    fs.mkdirSync(join(dir, '2026-10-15', '10'), { recursive: true });
    const good = members(3, 5);
    fs.writeFileSync(join(dir, '2026-10-15', '10', 'poll_counts.ndjson.gz'), good);
    fs.writeFileSync(join(dir, '2026-10-15', '10', 'poll_counts.1.ndjson.gz'), good.subarray(0, good.length - 3));
    const m = (path: string) => ({ path, stream: 'poll_counts', codec: 'gzip' }) as never;
    assert.deepEqual([...eachPollCount(dir, [m('2026-10-15/10/poll_counts.ndjson.gz')])].map((p) => p.barStartMs), Array.from({ length: 15 }, (_, i) => i * 15_000));
    assert.deepEqual([...eachPollCount(dir, [m('2026-10-15/10/poll_counts.1.ndjson.gz')])], []);
  });
});

describe('SW-36: the daily coverage runs in bounded steps', () => {
  const DAY0 = '2026-10-15';
  const T0 = Date.parse(`${DAY0}T00:00:00Z`);
  /** A day of 6 pools, 4 hour-segments of 3 gzip members each, one poll_counts record per pool per 15 s bar. */
  function day(): string {
    const dir = tempDir('sw36');
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

  it('no step parses more than its line bound; the report is computeCoverage\'s over every record (fails before: one call did the whole day)', () => {
    const dir = day();
    const whole = computeCoverage({ dayUtc: DAY0, watched: WatchLog.readDay(dir, DAY0), pollCounts: pollCountsOf(dir, dayManifests(dir, DAY0)), gaps: [], records: { poll_counts: 4 * 240 * 6 },
      universeManifestSha256: 'x'.repeat(64) });
    const job = dailyCoverageJob({ dataDir: dir, dayUtc: DAY0, universeManifestSha256: 'x'.repeat(64), lines: 500, pools: 2 });
    const parse = JSON.parse;
    const perStep: number[] = [];
    let got = null;
    try {
      while (got === null) {
        let n = 0;
        JSON.parse = ((t: string, r?: never) => { n++; return parse(t, r); }) as typeof JSON.parse;
        got = job.step();
        JSON.parse = parse;
        perStep.push(n);
      }
    } finally {
      JSON.parse = parse;
    }
    assert.deepEqual(got, whole);
    assert.ok(perStep.length > 4 * 3 * 2, `${perStep.length} steps`);
    assert.ok(Math.max(...perStep.slice(1)) <= 500, `the most lines parsed in one step: ${Math.max(...perStep.slice(1))}`);
    assert.equal(perStep.slice(1).reduce((a, b) => a + b, 0), 4 * 240 * 6, 'every record read once');
  });

  it('coverageRun.pools(max) works through at most max pools a call, with the same result', () => {
    const dir = day();
    const input = { dayUtc: DAY0, watched: WatchLog.readDay(dir, DAY0), gaps: [], records: {}, universeManifestSha256: 'x'.repeat(64) };
    const whole = computeCoverage({ ...input, pollCounts: pollCountsOf(dir, dayManifests(dir, DAY0)) });
    const run = coverageRun(input);
    for (const r of pollCountsOf(dir, dayManifests(dir, DAY0))) run.add(r);
    let calls = 1;
    while (!run.pools(2)) calls++;
    assert.equal(calls, 4);                                                // 6 pools, 2 a call, then the call that finds none left
    assert.deepEqual(run.finish(), whole);
    assert.equal(whole.detail.missingBps, Math.round((1 - (5 / 6) * (4 / 24)) * 10_000)); // watched all day; 5 of 6 pools seen for 4 hours
  });
});
