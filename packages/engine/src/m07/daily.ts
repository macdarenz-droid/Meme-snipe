// The daily coverage job (SPEC-A A-M07-03 logic 1, card Z08): at 00:00 UTC, after the universe manifest (A-M05-03,
// card Z09), the previous day's CoverageReport is computed from what is on disk (the day's index of manifests, its
// poll_counts segments and the watch log), written to the `coverage` stream and handed to M24 (`coverage_report`
// table; C-14). Until A-M05-03 writes the universe manifest, `universeManifestSha256` is the SHA-256 of the day's watch
// log, the file the denominator came from (ruling 14).
import { createHash } from 'node:crypto';
import * as nodeFs from 'node:fs';
import { join } from 'node:path';
import type { CoverageReport, UnixMs } from '@bot/types';
import { frameLines, scanGzipFrames } from './frames.ts';
import { coverageRun, DAY_MS, dayStartOf, type CoverageDetail, type PollCountRecord } from './coverage.ts';
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
    // SW-35: read one gzip member at a time, never the whole hour decoded as one buffer and one string: those large
    // transient allocations at each day's coverage raised the recorder's resident memory in steps (soak, DECISIONS).
    // A file that does not decode whole is skipped, as before; the first pass checks that.
    const bytes = fs.readFileSync(file) as Buffer;
    if (scanGzipFrames(bytes, () => undefined).stop !== null) continue;
    for (const line of frameLines(bytes)) if (line !== '') yield (JSON.parse(line) as { payload: PollCountRecord }).payload;
  }
}

/** poll_counts records of the given manifests' segments, as one array (see eachPollCount). */
export function pollCountsOf(dataDir: string, manifests: readonly SegmentManifest[], fs: ReadFs = nodeFs): PollCountRecord[] {
  return [...eachPollCount(dataDir, manifests, fs)];
}

export interface DailyCoverage { report: CoverageReport; detail: CoverageDetail }

export function dailyCoverage(o: { dataDir: string; dayUtc: string; universeManifestSha256: string | null; fs?: ReadFs }): DailyCoverage {
  const job = dailyCoverageJob(o);
  for (;;) {
    const done = job.step();
    if (done !== null) return done;
  }
}

/** SW-45: the most bytes a coverage child may print (a report is about 1 KB at 60 pools; far over any day's gaps). */
export const COVERAGE_REPORT_MAX_BYTES = 4_194_304;
const MAX_STREAMS = 64;
const MAX_GAPS = 50_000;

/**
 * SW-45: the coverage child's output, checked before the recorder uses it: exactly a CoverageReport of `dayUtc` with
 * the manifest hash it was given (null: any 64-hex hash), every field of the right type and size, and printed in the
 * form `JSON.stringify` gives (so the record and the saved row are the bytes the in-process job gave). Anything else
 * is null.
 */
export function checkCoverageReport(text: string, dayUtc: string, sha: string | null): CoverageReport | null {
  if (text.length > COVERAGE_REPORT_MAX_BYTES) return null;
  let v: unknown;
  try { v = JSON.parse(text); } catch { return null; }
  const obj = (x: unknown, keys: readonly string[]): x is Record<string, unknown> =>
    typeof x === 'object' && x !== null && !Array.isArray(x) && Object.keys(x).join(',') === keys.join(',');
  const count = (x: unknown): boolean => Number.isSafeInteger(x) && (x as number) >= 0;
  const str = (x: unknown, max: number): boolean => typeof x === 'string' && x.length > 0 && x.length <= max;
  if (!obj(v, ['dayUtc', 'streams', 'universeManifestSha256', 'lowCoverage'])) return null;
  if (v.dayUtc !== dayUtc || typeof v.lowCoverage !== 'boolean') return null;
  if (typeof v.universeManifestSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(v.universeManifestSha256) || (sha !== null && v.universeManifestSha256 !== sha)) return null;
  if (!Array.isArray(v.streams) || v.streams.length > MAX_STREAMS) return null;
  for (const st of v.streams as unknown[]) {
    if (!obj(st, ['stream', 'expected', 'recorded', 'gaps']) || !str(st.stream, 64) || !count(st.expected) || !count(st.recorded)) return null;
    if (!Array.isArray(st.gaps) || st.gaps.length > MAX_GAPS) return null;
    for (const g of st.gaps as unknown[]) if (!obj(g, ['fromMs', 'toMs', 'reason']) || !count(g.fromMs) || !count(g.toMs) || typeof g.reason !== 'string' || g.reason.length > 500) return null;
  }
  return JSON.stringify(v) === text ? (v as unknown as CoverageReport) : null;
}

/** SW-36: the most poll_counts lines one step of the daily coverage reads, and the most watched pools it works through. */
export const COVERAGE_STEP_LINES = 5_000;
export const COVERAGE_STEP_POOLS = 100;

export interface DailyCoverageJob {
  /** One bounded part of the job; the result once the last part is done, null before. */
  step(): DailyCoverage | null;
}

/**
 * SW-36: the daily coverage in bounded steps (one a recorder loop tick), so it never holds the loop for long (in one
 * call it took about 1.3-1.6 s at 60 pools): the setup (the day's manifests, the watch log), then each poll_counts
 * segment one gzip member at a time, first checked whole (a segment that does not decode whole adds nothing, as
 * before) and then read, at most COVERAGE_STEP_LINES lines a step, then the watched pools COVERAGE_STEP_POOLS at a
 * time, then the report. The same records in the same order as `dailyCoverage` always read.
 */
export function dailyCoverageJob(o: {
  dataDir: string; dayUtc: string; universeManifestSha256: string | null; fs?: ReadFs; lines?: number; pools?: number;
}): DailyCoverageJob {
  const fs = o.fs ?? nodeFs;
  const maxLines = o.lines ?? COVERAGE_STEP_LINES;
  const maxPools = o.pools ?? COVERAGE_STEP_POOLS;
  const start = dayStartOf(o.dayUtc);
  let run: ReturnType<typeof coverageRun> | null = null;
  // The day's poll_counts segments, then the next day's first hour (only its records of the day count: SW-12).
  let files: Array<{ m: SegmentManifest; next: boolean }> = [];
  let fileAt = 0;
  let open: { bytes: Buffer; lines: Generator<string, unknown, undefined>; checking: boolean; next: boolean } | null = null;
  let poolsDone = false;
  const setup = (): void => {
    const next = new Date(start + DAY_MS).toISOString().slice(0, 10);
    const manifests = dayManifests(o.dataDir, o.dayUtc, fs);
    // The next day's first hour holds the records of the day's last bar (23:59:45 is stamped with its close, 00:00:00
    // plus the grace; SW-12) and of any bar of the day whose counts were moved late, and its first bar may carry late
    // polls of 23:59:45 (ruling 38, in bars since Z09-32).
    const nextFirstHour = dayManifests(o.dataDir, next, fs).filter((m) => m.hourUtc === `${next}T00`);
    const pc = (m: SegmentManifest): boolean => m.stream === 'poll_counts' && m.codec === 'gzip';
    files = [...manifests.filter(pc).map((m) => ({ m, next: false })), ...nextFirstHour.filter(pc).map((m) => ({ m, next: true }))];
    const gaps: Array<{ stream: string; gap: ManifestGap }> = [];
    const records: Record<string, number> = {};
    for (const m of manifests) {
      records[m.stream] = (records[m.stream] ?? 0) + m.records;
      for (const g of m.gaps) gaps.push({ stream: m.stream, gap: g });
    }
    const watchFile = join(o.dataDir, 'watch', `${o.dayUtc}.ndjson`);
    const sha = o.universeManifestSha256 ?? createHash('sha256').update(fs.existsSync(watchFile) ? (fs.readFileSync(watchFile) as Buffer) : Buffer.alloc(0)).digest('hex');
    run = coverageRun({ dayUtc: o.dayUtc, watched: WatchLog.readDay(o.dataDir, o.dayUtc, fs), gaps, records, universeManifestSha256: sha });
  };
  return {
    step(): DailyCoverage | null {
      if (run === null) { setup(); return null; }
      if (open === null && fileAt < files.length) {
        const f = files[fileAt++] as { m: SegmentManifest; next: boolean };
        const file = join(o.dataDir, f.m.path);
        if (!fs.existsSync(file)) return null;
        const bytes = fs.readFileSync(file) as Buffer;
        open = { bytes, lines: frameLines(bytes), checking: true, next: f.next };
        return null;
      }
      if (open !== null) {
        const cur = open;
        for (let n = 0; n < maxLines; n++) {
          const r = cur.lines.next();
          if (r.done === true) {
            if (cur.checking && r.value === null) { open = { ...cur, lines: frameLines(cur.bytes), checking: false }; }
            else open = null;                                               // read, or it does not decode whole: skipped
            return null;
          }
          if (cur.checking || r.value === '') continue;
          const rec = (JSON.parse(r.value) as { payload: PollCountRecord }).payload;
          if (!cur.next || (rec.barStartMs >= start && rec.barStartMs <= start + DAY_MS)) run.add(rec);
        }
        return null;
      }
      if (!poolsDone) { poolsDone = run.pools(maxPools); return null; }
      return run.finish();
    },
  };
}

/**
 * Runs the job for the day before `nowMs`: appends the report to `coverage` and saves it (M24). Ruling Z08-19, moved
 * one hour by SW-12: it runs only once the writer has closed the NEXT day's hour 00 (`closedThrough()`, the writer's
 * `lastRotatedHourUtc`), because the day's last bar is written there; no record of the day is then still in an open
 * segment. Before that it returns null and the caller tries again.
 */
export function runDailyCoverage(o: {
  dataDir: string; nowMs: UnixMs; universeManifestSha256: string | null; closedThrough: () => string;
  append: (report: CoverageReport, atMs: UnixMs) => void; save: (report: CoverageReport) => void; fs?: ReadFs;
  /** SW-28: an earlier day (a catch-up after the recorder was down); the day before `nowMs` when absent. */
  dayUtc?: string;
}): DailyCoverage | null {
  const dayUtc = o.dayUtc ?? new Date(o.nowMs - DAY_MS).toISOString().slice(0, 10);
  const next = new Date(Date.parse(`${dayUtc}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);
  if (o.closedThrough() < `${next}T00`) return null;
  const c = dailyCoverage({ dataDir: o.dataDir, dayUtc, universeManifestSha256: o.universeManifestSha256, ...(o.fs === undefined ? {} : { fs: o.fs }) });
  o.append(c.report, o.nowMs);
  o.save(c.report);
  return c;
}
