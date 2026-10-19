// Card SWITCH-FIX-3 SW-37/38/39: one rule for a damaged segment in every reader of the recording. A segment that does
// not decode to its end, or has a line that does not parse, is skipped whole (never part of it), the skip is reported
// (SW-37: m07.segment_unreadable), and the coverage report marks the hour (SW-38: a segment_unreadable gap on
// poll_counts), never a silently partial report. Phase 0's reader follows the same rule (SW-39): the same damaged
// segments are fed to both readers here.
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { describe, it } from 'vitest';
import { WatchLog } from '../../src/m07/watch-log.ts';
import { checkCoverageReport, dailyCoverageJob, eachPollCount, type SegmentSkip } from '../../src/m07/daily.ts';
import { computeCoverage } from '../../src/m07/coverage.ts';
import { segmentRecords } from '../../src/m07/frames.ts';
import type { UnixMs } from '@bot/types';
import type { SegmentManifest } from '../../src/m07/manifest.ts';
import { linesOf } from '../../src/m13/phase0-input.ts';
import { tempDir } from '../helpers.ts';

const DAY0 = '2026-10-15';
const T0 = Date.parse(`${DAY0}T00:00:00Z`);
const rec = (h: number, bar: number, seq: number): string => `${JSON.stringify({ seq: String(seq), recvMs: T0 + h * 3_600_000 + bar * 15_000 + 16_500, payload: { poolId: 'P0', barStartMs: T0 + h * 3_600_000 + bar * 15_000, durationMs: 15_000, minuteStartMs: T0 + h * 3_600_000, successfulPolls: 15, changedPolls: 0, failedPolls: 0, priorityClass: 'candidate' } })}\n`;
/** Three gzip members of 20 records each; `damage` breaks one segment. */
function file(h: number, damage: 'none' | 'torn' | 'bad_line' | 'no_payload'): Buffer {
  const parts = [0, 1, 2].map((k) => Array.from({ length: 20 }, (_, i) => rec(h, k * 20 + i, h * 100 + k * 20 + i)));
  if (damage === 'bad_line') parts[1]![5] = '{"seq":"1","recvMs":1,"payload":{"poolId":\n';             // a line in the middle that does not parse
  if (damage === 'no_payload') parts[2]![0] = '{"seq":"1","recvMs":1}\n';
  const bytes = Buffer.concat(parts.map((p) => gzipSync(Buffer.from(p.join('')))));
  return damage === 'torn' ? bytes.subarray(0, bytes.length - 7) : bytes;
}

function day(): { dir: string; manifests: SegmentManifest[] } {
  const dir = tempDir('sw38');
  new WatchLog(dir, () => undefined).watch('P0', 'candidate', T0 as never);
  const manifests: SegmentManifest[] = [];
  (['none', 'torn', 'bad_line', 'none', 'no_payload'] as const).forEach((damage, h) => {
    const hh = String(h).padStart(2, '0');
    fs.mkdirSync(join(dir, DAY0, hh), { recursive: true });
    const path = `${DAY0}/${hh}/poll_counts.ndjson.gz`;
    const bytes = file(h, damage);
    fs.writeFileSync(join(dir, path), bytes);
    manifests.push({ path, stream: 'poll_counts', firstSlot: null, lastSlot: null, records: 60, bytes: bytes.length, sha256: 'a'.repeat(64), gaps: [], codec: 'gzip',
      firstSeq: null, lastSeq: null, hourUtc: `${DAY0}T${hh}`, keyframes: 0, firstRecvMs: null, lastRecvMs: null } as SegmentManifest);
  });
  fs.writeFileSync(join(dir, DAY0, 'index.json'), JSON.stringify(manifests));
  return { dir, manifests };
}
const WANT: Array<[string, SegmentSkip['reason']]> = [[`${DAY0}T01`, 'torn'], [`${DAY0}T02`, 'parse_error'], [`${DAY0}T04`, 'parse_error']];

describe('SW-37/38/39: a damaged segment is skipped whole and reported, by every reader', () => {
  it('the coverage reader (eachPollCount) and Phase 0\'s (linesOf) both skip the same segments whole, for the same reasons (fails before: part of a file, or a throw)', () => {
    const { dir, manifests } = day();
    const covSkips: SegmentSkip[] = [];
    const counts = [...eachPollCount(dir, manifests, fs, (k) => covSkips.push(k))];
    assert.equal(counts.length, 2 * 60, 'only the two good hours, every record of each');
    assert.deepEqual(covSkips.map((k) => [k.hourUtc, k.reason]), WANT);
    const p0Skips: SegmentSkip[] = [];
    const per = manifests.map((m) => linesOf(dir, m, fs, (k) => p0Skips.push(k)));
    assert.deepEqual(per.map((x) => x.lines.length), [60, 0, 0, 60, 0]);
    assert.deepEqual(per.map((x) => x.decodedBytes === null), [false, true, true, false, true], 'a skipped segment is read as unread');
    assert.deepEqual(p0Skips, covSkips, 'the same damaged segments, the same reasons');
  });

  it('the daily coverage report marks each skipped hour with a segment_unreadable gap and lists the skips; its counts leave the hour out (fails before: partial and unmarked)', () => {
    const { dir } = day();
    const job = dailyCoverageJob({ dataDir: dir, dayUtc: DAY0, universeManifestSha256: 'x'.repeat(64), lines: 7 });
    let done = job.step();
    while (done === null) done = job.step();
    assert.deepEqual(job.skipped().map((k) => [k.hourUtc, k.reason]), WANT);
    const pc = done.report.streams.find((s) => s.stream === 'poll_counts');
    assert.ok(pc !== undefined);
    assert.deepEqual(pc.gaps.filter((g) => g.reason === 'segment_unreadable').map((g) => [g.fromMs - T0, g.toMs - T0]), [[1, 2], [2, 3], [4, 5]].map(([a, b]) => [a! * 3_600_000, b! * 3_600_000]));
    const polled = done.report.streams.find((s) => s.stream === 'pool_snapshot')?.recorded;
    assert.equal(polled, 2 * 60 * 15, 'the skipped hours\' polls are not counted, none of them');
  });
});

// SW-48 (a report format change): a stream's gaps are merged by reason where they overlap or touch. The report keeps no
// pool id, so per-pool gaps of the same bars were the same interval once per pool (60 pools × 5,760 bars on a bad clock
// day: over the 50,000 the coverage child's check allows, so the day lost its report).
describe('SW-48: the report merges a stream\'s gaps by reason', () => {
  it('60 pools × 2,880 one-bar gaps (every other bar) give 2,880 entries; the figures are the unmerged ones; the child\'s check takes it (fails before: 172,800 entries, refused)', () => {
    const bars = Array.from({ length: 2_880 }, (_, i) => T0 + i * 30_000);
    const gaps = Array.from({ length: 60 }, (_, p) => bars.map((b) => ({ stream: 'poll_counts', gap: { fromMs: b as UnixMs, toMs: (b + 15_000) as UnixMs, reason: 'moved', poolId: `P${p}` } }))).flat();
    const watched = Array.from({ length: 60 }, (_, p) => ({ poolId: `P${p}`, priorityClass: 'candidate' as const, fromMs: T0 as UnixMs, toMs: (T0 + 86_400_000) as UnixMs, pollIntervalMs: 1_000 }));
    const input = { dayUtc: DAY0, watched, pollCounts: [], gaps, records: { poll_counts: 0 }, universeManifestSha256: 'a'.repeat(64) };
    const { report, detail } = computeCoverage(input);
    const pc = report.streams.find((s) => s.stream === 'poll_counts');
    assert.equal(pc?.gaps.length, 2_880);
    assert.deepEqual(pc?.gaps[0], { fromMs: T0, toMs: T0 + 15_000, reason: 'moved' });
    assert.notEqual(checkCoverageReport(JSON.stringify(report), DAY0, 'a'.repeat(64)), null, 'within the child check');
    // The figures (missing time, low coverage, counts) come from the unmerged input: the same with one pool's gaps alone repeated.
    const one = computeCoverage({ ...input, gaps: gaps.filter((g) => g.gap.poolId === 'P0').flatMap((g) => watched.map((w) => ({ ...g, gap: { ...g.gap, poolId: w.poolId } }))) });
    assert.deepEqual([one.detail, one.report.lowCoverage], [detail, report.lowCoverage]);
  });

  it('touching or overlapping gaps of one reason merge; other reasons stay apart; a day with no overlap keeps its entries', () => {
    const g = (a: number, b: number, reason: string) => ({ stream: 'poll_counts', gap: { fromMs: (T0 + a) as UnixMs, toMs: (T0 + b) as UnixMs, reason } });
    const { report } = computeCoverage({ dayUtc: DAY0, watched: [], pollCounts: [], gaps: [g(0, 10, 'moved'), g(10, 20, 'moved'), g(15, 30, 'moved'), g(5, 8, 'clock_step'), g(40, 50, 'moved')], records: {}, universeManifestSha256: 'a'.repeat(64) });
    assert.deepEqual(report.streams.find((s) => s.stream === 'poll_counts')?.gaps.map((x) => [x.fromMs - T0, x.toMs - T0, x.reason]), [[0, 30, 'moved'], [5, 8, 'clock_step'], [40, 50, 'moved']]);
  });
});

describe('segmentRecords (the shared all-or-none reader)', () => {
  it('blank lines are skipped and not counted; every other line is parsed; a stop is the frame reason', () => {
    const buf = gzipSync(Buffer.from('{"a":1}\n\n{"a":2}\n\n'));
    const r = segmentRecords(buf, (l) => (JSON.parse(l) as { a: number }).a);
    assert.deepEqual(r, { records: [1, 2], decodedBytes: 2 * ('{"a":1}'.length + 1) });
    assert.deepEqual(segmentRecords(buf.subarray(0, buf.length - 3), (l) => l), { skipped: 'torn' });
    assert.deepEqual(segmentRecords(buf, () => { throw new Error('x'); }), { skipped: 'parse_error' });
  });
});
