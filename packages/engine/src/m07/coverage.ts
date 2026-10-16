// The daily CoverageReport (SPEC-A A-M07-03 logic 1, card Z08), with the recorder integration rules of the Z04 review
// (docs/MIGRATION.md Z08 row, rulings 1, 14 and 38-40). Pure: the caller passes the day's watch history, poll counts,
// manifest gaps and record counts.
//
// - Denominator (ruling 14): the watched pool-time comes from the watch history (M04's watchlist, or the universe
//   manifest once A-M05-03 writes it), never from `poll_counts`: the recorder unwatches idle pools and caps its set, so
//   poll counts alone can understate the pools that should have been seen.
// - `poll_counts` is one record per pool per 15-second bar (ruling Z09-32). Coverage stays measured per pool-minute: a
//   pool-minute is observed when one of its bars' records has a successful poll, or when a record carries `latePolls`
//   stamped in one of its bars (`lateFromBarStartMs`, ruling 38): a sparse pool's only late poll is not read as
//   missing, and a 0.1 Hz tail pool is not missing in the bars between its polls. A `skippedBars` record (a pause
//   longer than the catch-up limit) observes nothing bar by bar.
// - Gaps (ruling 40): a gap with `poolId` (`clock_step`, `moved`) excludes only that pool's minutes and counts toward
//   the 5% as that pool's share; a gap with no pool (backpressure, crash, process_down, halted, or gaps merged past
//   `GAPS_MAX_PER_STREAM`) on a pool-snapshot or poll-count stream excludes every watched pool for its time.
// - `lowCoverage` when the missing pool-time is above 5% of the watched pool-time (ARCH M07), or when nothing was
//   watched (edge case 3: such a day cannot support a gate).
// - Every length is in milliseconds of wall time; nothing is converted through a slot time (Zeroed bug B1:
//   `coverage-journal.ts:5` measured gaps with SLOT_MS = 400).
import type { CoverageReport, UnixMs } from '@bot/types';
import type { ManifestGap } from './manifest.ts';

export const DAY_MS = 86_400_000;
export const MINUTE_MS = 60_000;
/** ARCH M07: a day with gaps above 5% of watched pool-time is low coverage. */
export const LOW_COVERAGE_BPS = 500;

export type PriorityClass = 'position' | 'candidate' | 'tail';
export const STREAM_OF_CLASS: Readonly<Record<PriorityClass, string>> = {
  position: 'pool_snapshot_position', candidate: 'pool_snapshot', tail: 'pool_snapshot_tail',
};
const POOL_STREAMS = new Set(['pool_snapshot_position', 'pool_snapshot', 'pool_snapshot_tail', 'poll_counts']);

export interface WatchInterval { poolId: string; priorityClass: PriorityClass; fromMs: UnixMs; toMs: UnixMs; pollIntervalMs: number }
export interface PollCountRecord {
  poolId: string; barStartMs: UnixMs; successfulPolls: number; priorityClass: string;
  skippedBars?: number; latePolls?: number; lateFromBarStartMs?: UnixMs;
}

export interface CoverageInput {
  dayUtc: string;
  watched: readonly WatchInterval[];
  /**
   * The day's poll_counts records, plus the next day's first bar (its late polls may belong to 23:59:45). Read once,
   * in order, so the daily job can stream them (card Z10).
   */
  pollCounts: Iterable<PollCountRecord>;
  gaps: ReadonlyArray<{ stream: string; gap: ManifestGap }>;
  /** Records written per stream that day (from the manifests). */
  records: Readonly<Record<string, number>>;
  universeManifestSha256: string;
}

export interface CoverageDetail { watchedMs: number; missingMs: number; missingBps: number }

const clip = (from: number, to: number, a: number, b: number): number => Math.max(0, Math.min(to, b) - Math.max(from, a));

/** Total length of the union of intervals, clipped to [a, b). */
function unionLength(intervals: ReadonlyArray<{ fromMs: number; toMs: number }>, a: number, b: number): number {
  const xs = intervals.map((i) => [Math.max(a, i.fromMs), Math.min(b, i.toMs)] as const).filter(([f, t]) => t > f).sort((p, q) => p[0] - q[0]);
  let total = 0;
  let curF = Number.NaN;
  let curT = Number.NaN;
  for (const [f, t] of xs) {
    if (Number.isNaN(curF) || f > curT) {
      if (!Number.isNaN(curF)) total += curT - curF;
      curF = f;
      curT = t;
    } else if (t > curT) {
      curT = t;
    }
  }
  return Number.isNaN(curF) ? total : total + curT - curF;
}

/** Length of (watched ∩ gaps) within [a, b), where both are unions of intervals. */
function overlapLength(watched: ReadonlyArray<{ fromMs: number; toMs: number }>, gaps: ReadonlyArray<{ fromMs: number; toMs: number }>, a: number, b: number): number {
  const pieces: Array<{ fromMs: number; toMs: number }> = [];
  for (const w of watched) for (const g of gaps) {
    const f = Math.max(w.fromMs, g.fromMs, a);
    const t = Math.min(w.toMs, g.toMs, b);
    if (t > f) pieces.push({ fromMs: f, toMs: t });
  }
  return unionLength(pieces, a, b);
}

export function dayStartOf(dayUtc: string): UnixMs {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dayUtc)) throw new RangeError(`not a UTC day: ${dayUtc}`);
  const t = Date.parse(`${dayUtc}T00:00:00Z`);
  if (Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== dayUtc) throw new RangeError(`not a UTC day: ${dayUtc}`);
  return t as UnixMs;
}

export function computeCoverage(input: CoverageInput): { report: CoverageReport; detail: CoverageDetail } {
  const a = dayStartOf(input.dayUtc);
  const b = a + DAY_MS;
  const observed = new Set<string>();
  const minuteOf = (ms: number): number => Math.floor(ms / MINUTE_MS) * MINUTE_MS;
  const k = (poolId: string, ms: number): string => `${poolId}\u0000${minuteOf(ms)}`;
  // One pass over the poll counts (they may be a stream): observed minutes, and the day's successful polls per stream.
  const polledByStream = new Map<string, number>();
  for (const r of input.pollCounts) {
    if (r.barStartMs >= a && r.barStartMs < b) {
      const s = STREAM_OF_CLASS[r.priorityClass as PriorityClass];
      if (s !== undefined) polledByStream.set(s, (polledByStream.get(s) ?? 0) + r.successfulPolls);
    }
    if (r.skippedBars !== undefined) continue;
    if (r.successfulPolls > 0) observed.add(k(r.poolId, r.barStartMs));
    if (r.latePolls !== undefined && r.latePolls > 0 && r.lateFromBarStartMs !== undefined) observed.add(k(r.poolId, r.lateFromBarStartMs));
  }
  const poolGaps = new Map<string, Array<{ fromMs: number; toMs: number }>>();
  const streamGaps: Array<{ fromMs: number; toMs: number }> = [];
  for (const { stream, gap } of input.gaps) {
    if (!POOL_STREAMS.has(stream)) continue;
    if (gap.poolId !== undefined) {
      const list = poolGaps.get(gap.poolId) ?? [];
      list.push(gap);
      poolGaps.set(gap.poolId, list);
    } else {
      streamGaps.push(gap);
    }
  }
  const byPool = new Map<string, WatchInterval[]>();
  for (const w of input.watched) {
    const list = byPool.get(w.poolId) ?? [];
    list.push(w);
    byPool.set(w.poolId, list);
  }
  let watchedMs = 0;
  let missingMs = 0;
  for (const [poolId, intervals] of byPool) {
    const first = Math.max(a, Math.min(...intervals.map((i) => i.fromMs)));
    const last = Math.min(b, Math.max(...intervals.map((i) => i.toMs)));
    const pg = poolGaps.get(poolId) ?? [];
    for (let m = Math.floor((first - a) / MINUTE_MS) * MINUTE_MS + a; m < last; m += MINUTE_MS) {
      const inMinute = unionLength(intervals, m, m + MINUTE_MS);
      if (inMinute === 0) continue;
      watchedMs += inMinute;
      const poolGapHere = pg.some((g) => clip(g.fromMs, g.toMs, m, m + MINUTE_MS) > 0);
      if (!observed.has(k(poolId, m)) || poolGapHere) missingMs += inMinute;
      else missingMs += overlapLength(intervals, streamGaps, m, m + MINUTE_MS);
    }
  }
  const lowCoverage = watchedMs === 0 || missingMs * 10_000 > LOW_COVERAGE_BPS * watchedMs;

  const streams = new Map<string, { stream: string; expected: number; recorded: number; gaps: Array<{ fromMs: UnixMs; toMs: UnixMs; reason: string }> }>();
  const entry = (s: string): { stream: string; expected: number; recorded: number; gaps: Array<{ fromMs: UnixMs; toMs: UnixMs; reason: string }> } => {
    let e = streams.get(s);
    if (e === undefined) { e = { stream: s, expected: 0, recorded: 0, gaps: [] }; streams.set(s, e); }
    return e;
  };
  for (const [s, n] of Object.entries(input.records)) {
    if (s.startsWith('pool_snapshot')) { entry(s); continue; }
    const e = entry(s);
    e.expected += n;
    e.recorded += n;
  }
  for (const w of input.watched) {
    const ms = clip(w.fromMs, w.toMs, a, b);
    entry(STREAM_OF_CLASS[w.priorityClass]).expected += Math.floor(ms / w.pollIntervalMs);
  }
  for (const [s, n] of polledByStream) entry(s).recorded += n;
  for (const { stream, gap } of input.gaps) entry(stream).gaps.push({ fromMs: gap.fromMs, toMs: gap.toMs, reason: gap.reason });
  const report: CoverageReport = {
    dayUtc: input.dayUtc,
    streams: [...streams.values()].sort((x, y) => (x.stream < y.stream ? -1 : 1)),
    universeManifestSha256: input.universeManifestSha256,
    lowCoverage,
  };
  return { report, detail: { watchedMs, missingMs, missingBps: watchedMs === 0 ? 10_000 : Math.round((missingMs * 10_000) / watchedMs) } };
}
