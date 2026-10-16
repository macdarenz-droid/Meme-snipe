// The daily coverage job (SPEC-A A-M07-03 logic 1, card Z08): at 00:00 UTC, after the universe manifest (A-M05-03,
// card Z09), the previous day's CoverageReport is computed from what is on disk (the day's index of manifests, its
// poll_counts segments and the watch log), written to the `coverage` stream and handed to M24 (`coverage_report`
// table; C-14). Until A-M05-03 writes the universe manifest, `universeManifestSha256` is the SHA-256 of the day's watch
// log, the file the denominator came from (ruling 14).
import { createHash } from 'node:crypto';
import * as nodeFs from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { CoverageReport, UnixMs } from '@bot/types';
import { computeCoverage, DAY_MS, dayStartOf, type CoverageDetail, type PollCountRecord } from './coverage.ts';
import { isManifest, type ManifestGap, type SegmentManifest } from './manifest.ts';
import { WatchLog } from './watch-log.ts';

type ReadFs = Pick<typeof nodeFs, 'existsSync' | 'readFileSync'>;

/** The day's manifests from its index (the last entry per path wins: a recovered segment is listed once). */
export function dayManifests(dataDir: string, dayUtc: string, fs: ReadFs = nodeFs): SegmentManifest[] {
  const path = join(dataDir, dayUtc, 'index.json');
  if (!fs.existsSync(path)) return [];
  const list: unknown = JSON.parse(fs.readFileSync(path, 'utf8') as string);
  const byPath = new Map<string, SegmentManifest>();
  if (Array.isArray(list)) for (const m of list) if (isManifest(m)) byPath.set(m.path, m);
  return [...byPath.values()];
}

/**
 * poll_counts records of the given manifests' segments, one segment at a time (gzip only; a segment that cannot be
 * read adds nothing). Lazy: only the segment being read is in memory, so the daily job's heap is bounded by one hour of
 * poll_counts, not a whole day (card Z10: a day held at once kept about 100 MiB of RSS after the job).
 */
export function* eachPollCount(dataDir: string, manifests: readonly SegmentManifest[], fs: ReadFs = nodeFs): Generator<PollCountRecord> {
  for (const m of manifests) {
    if (m.stream !== 'poll_counts' || m.codec !== 'gzip') continue;
    const file = join(dataDir, m.path);
    if (!fs.existsSync(file)) continue;
    let text: string;
    try {
      text = gunzipSync(fs.readFileSync(file) as Buffer).toString('utf8');
    } catch {
      continue;
    }
    for (let at = 0; at < text.length;) {
      const nl = text.indexOf('\n', at);
      const end = nl === -1 ? text.length : nl;
      if (end > at) yield (JSON.parse(text.slice(at, end)) as { payload: PollCountRecord }).payload;
      at = end + 1;
    }
  }
}

/** poll_counts records of the given manifests' segments, as one array (see eachPollCount). */
export function pollCountsOf(dataDir: string, manifests: readonly SegmentManifest[], fs: ReadFs = nodeFs): PollCountRecord[] {
  return [...eachPollCount(dataDir, manifests, fs)];
}

export interface DailyCoverage { report: CoverageReport; detail: CoverageDetail }

export function dailyCoverage(o: { dataDir: string; dayUtc: string; universeManifestSha256: string | null; fs?: ReadFs }): DailyCoverage {
  const fs = o.fs ?? nodeFs;
  const start = dayStartOf(o.dayUtc);
  const next = new Date(start + DAY_MS).toISOString().slice(0, 10);
  const manifests = dayManifests(o.dataDir, o.dayUtc, fs);
  // The next day's first bar may carry late polls of the 23:59:45 bar (ruling 38, in bars since Z09-32).
  const nextFirstHour = dayManifests(o.dataDir, next, fs).filter((m) => m.hourUtc === `${next}T00`);
  const dataDir = o.dataDir;
  const pollCounts = (function* (): Generator<PollCountRecord> {
    yield* eachPollCount(dataDir, manifests, fs);
    for (const r of eachPollCount(dataDir, nextFirstHour, fs)) if (r.barStartMs === start + DAY_MS) yield r;
  })();
  const gaps: Array<{ stream: string; gap: ManifestGap }> = [];
  const records: Record<string, number> = {};
  for (const m of manifests) {
    records[m.stream] = (records[m.stream] ?? 0) + m.records;
    for (const g of m.gaps) gaps.push({ stream: m.stream, gap: g });
  }
  const watchFile = join(o.dataDir, 'watch', `${o.dayUtc}.ndjson`);
  const sha = o.universeManifestSha256 ?? createHash('sha256').update(fs.existsSync(watchFile) ? (fs.readFileSync(watchFile) as Buffer) : Buffer.alloc(0)).digest('hex');
  return computeCoverage({ dayUtc: o.dayUtc, watched: WatchLog.readDay(o.dataDir, o.dayUtc, fs), pollCounts, gaps, records, universeManifestSha256: sha });
}

/**
 * Runs the job for the day before `nowMs`: appends the report to `coverage` and saves it (M24). Ruling Z08-19: it runs
 * only once the writer has closed that day's hour 23 (`closedThrough()`, the writer's `lastRotatedHourUtc`), so no
 * record of the day is still in an open segment; before that it returns null and the caller tries again.
 */
export function runDailyCoverage(o: {
  dataDir: string; nowMs: UnixMs; universeManifestSha256: string | null; closedThrough: () => string;
  append: (report: CoverageReport, atMs: UnixMs) => void; save: (report: CoverageReport) => void; fs?: ReadFs;
}): DailyCoverage | null {
  const dayUtc = new Date(o.nowMs - DAY_MS).toISOString().slice(0, 10);
  if (o.closedThrough() < `${dayUtc}T23`) return null;
  const c = dailyCoverage({ dataDir: o.dataDir, dayUtc, universeManifestSha256: o.universeManifestSha256, ...(o.fs === undefined ? {} : { fs: o.fs }) });
  o.append(c.report, o.nowMs);
  o.save(c.report);
  return c;
}
