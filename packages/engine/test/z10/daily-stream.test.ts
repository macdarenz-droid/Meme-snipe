// Card Z10 (RSS ruling, 2026-10-16): the 00:00 UTC coverage job held a whole day of poll_counts at once (about 70 MiB
// of heap at the soak's size, and about 100 MiB of RSS kept after it). It now reads one segment at a time.
import { strict as assert } from 'node:assert';
import { gzipSync } from 'node:zlib';
import { describe, it } from 'vitest';
import type { UnixMs } from '@bot/types';
import { computeCoverage, dayStartOf, type PollCountRecord } from '../../src/m07/coverage.ts';
import { eachPollCount, pollCountsOf } from '../../src/m07/daily.ts';
import type { SegmentManifest } from '../../src/m07/manifest.ts';
import { POLL_INTERVAL_MS } from '../../src/m07/watch-log.ts';

const DAY = '2026-10-15';
const D0 = dayStartOf(DAY);
const BAR = 15_000;
const ms = (n: number): UnixMs => n as UnixMs;
const polls = (fromBar: number, n: number): PollCountRecord[] =>
  Array.from({ length: n }, (_, i) => ({ poolId: 'A', barStartMs: ms(D0 + (fromBar + i) * BAR), successfulPolls: 15, priorityClass: 'candidate' }));

describe('Z10 daily job memory: poll_counts are streamed', () => {
  it('eachPollCount reads a segment only when the records before it are used up', () => {
    const files = new Map([['a.gz', polls(0, 3)], ['b.gz', polls(3, 2)]].map(([p, rs]) => [p as string, gzipSync(`${(rs as PollCountRecord[]).map((payload) => JSON.stringify({ payload })).join('\n')}\n`)]));
    const reads: string[] = [];
    const fs = { existsSync: () => true, readFileSync: (f: string) => { reads.push(f.slice(-4)); return files.get(f.slice(-4)) as Buffer; } };
    const ms2 = ['a.gz', 'b.gz'].map((path) => ({ stream: 'poll_counts', codec: 'gzip', path }) as unknown as SegmentManifest);
    const it2 = eachPollCount('/d', ms2, fs as never);
    assert.equal(it2.next().value?.barStartMs, D0);
    assert.deepEqual(reads, ['a.gz']);                                      // the second segment is not read yet
    assert.equal([...it2].length, 4);
    assert.deepEqual(reads, ['a.gz', 'b.gz']);
    assert.deepEqual(pollCountsOf('/d', ms2, fs as never), [...polls(0, 3), ...polls(3, 2)]);
  });

  it('computeCoverage gives the same report from a one-pass stream as from an array (fails before: the second loop saw an empty stream)', () => {
    const watched = [{ poolId: 'A', priorityClass: 'candidate' as const, fromMs: ms(D0), toMs: ms(D0 + 3_600_000), pollIntervalMs: POLL_INTERVAL_MS.candidate }];
    const pcs = polls(0, 240);
    const base = { dayUtc: DAY, watched, gaps: [], records: {}, universeManifestSha256: 'a'.repeat(64) };
    const fromArray = computeCoverage({ ...base, pollCounts: pcs });
    const fromStream = computeCoverage({ ...base, pollCounts: (function* () { yield* pcs; })() });
    assert.deepEqual(fromStream, fromArray);
    assert.equal(fromArray.report.streams.find((s) => s.stream === 'pool_snapshot')?.recorded, 3_600);
  });
});
