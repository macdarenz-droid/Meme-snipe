// The recorder's 00:00 UTC jobs (card Z10): first the previous day's universe manifest (A-M05-03), then its
// CoverageReport (A-M07-03 logic 1), which carries the manifest's SHA-256. Each runs once a day: a day already in
// M24 (`universe_manifest`, `coverage_report`, both append-only) is never built again. A day the recorder was down
// for is built at the next start, marked `late`. Only days that end after the recorder's first start are built (an
// earlier day has no recording, and its report would only say so).
//
// The DexScreener cross-check (A-M03-04) is not called from the server in this card: its status is `unavailable`
// (Z10 plan Q10: a new external endpoint on the host waits for the supervisor's ruling).
import type { Db } from '../m24/db.ts';
import { createRepos } from '../m24/repos.ts';
import { buildUniverseManifest, eventsFromRows } from '../m05/manifest.ts';
import { limitSetHash, type UniverseLimits } from '../m05/universe.ts';
import { runDailyCoverage } from '../m07/daily.ts';
import type { CandidateState, CoverageReport, Pubkey, UnixMs } from '@bot/types';
import type { AppendInput, AppendResult } from '../recorder/queue.ts';
import type { EvictionLog } from './evictions.ts';

const DAY_MS = 86_400_000;
const FIRST_START_KEY = 'recorder.first_start_ms';
/** A manifest built more than this after its day ended is `late`. */
export const LATE_AFTER_MS = 600_000;

export interface DailyJob {
  /** Call every second or so; builds what is due, never twice. */
  tick(nowMs: UnixMs): void;
}

export function createDailyJob(o: {
  db: Db; dataDir: string; evictions: EvictionLog; limits: readonly UniverseLimits[]; limitSetId: string; prefilterOnly: boolean;
  migrationCoverage: () => { chainMigrations: number; seenByPumpPortal: number; gapBps: number };
  closedThrough: () => string; append: (r: AppendInput) => AppendResult | void; nowMs: () => UnixMs;
  log: { event(level: 'info' | 'warn' | 'error' | 'critical', code: string, fields: Readonly<Record<string, unknown>>): void };
}): DailyJob {
  const repos = createRepos();
  const firstStart = ((): number => {
    const r = repos.kv_state.get(o.db.reader(), { key: FIRST_START_KEY });
    if (r !== null) return Number(JSON.parse(String(r.valueJson)));
    const t = o.nowMs();
    o.db.withTx((tx) => { repos.kv_state.upsert(tx, { key: FIRST_START_KEY, valueJson: JSON.stringify(t), createdAt: t, updatedAt: t }); });
    return t;
  })();
  const has = (table: 'universe_manifest' | 'coverage_report', day: string): boolean =>
    o.db.reader().get(`SELECT 1 AS x FROM "${table}" WHERE "day_utc" = ?`, day) !== undefined;
  let lastDay = '';

  const manifest = (day: string, dayStart: number, now: number): string | null => {
    const row = o.db.reader().get('SELECT "sha256" FROM "universe_manifest" WHERE "day_utc" = ?', day) as { sha256: string } | undefined;
    if (row !== undefined) return row.sha256;
    const rows = (o.db.reader().all('SELECT "pool_id", "mint", "from_state", "to_state", "reason", "at" FROM "candidate_event" WHERE "at" < ? ORDER BY "at"', dayStart + DAY_MS) as Array<Record<string, unknown>>)
      .map((r) => ({ poolId: String(r.pool_id) as Pubkey, mint: String(r.mint) as Pubkey, fromState: (r.from_state ?? null) as CandidateState | null, toState: String(r.to_state) as CandidateState, reason: String(r.reason), at: Number(r.at) }));
    const m = buildUniverseManifest({
      dayUtc: day, events: eventsFromRows(rows), watchlistEvictions: o.evictions.between(0, dayStart + DAY_MS),
      crossCheck: { poolsOnlyInVendor: 0, otherDexPairs: 0, knownPoolsUnderOtherDex: 0, status: 'unavailable' },
      migrationCoverage: o.migrationCoverage(), limitSet: { id: o.limitSetId, paramHash: limitSetHash(o.limits) },
      enumerationCoverage: 'migrations_since_start', generatedAtMs: now, late: now > dayStart + DAY_MS + LATE_AFTER_MS, prefilterOnly: o.prefilterOnly,
    });
    // Finding Z10-F5: a manifest M07 refuses (too large, or the queue full) is never marked as saved: no M24 row points at
    // a record that does not exist, the day gets no coverage report (it needs the manifest), and ONE critical line says so.
    const appended = o.append({ stream: 'universe_manifest', recvMs: now as UnixMs, slot: null, commitment: null, source: 'm05', payload: m });
    if (appended === 'dropped' || (typeof appended === 'object' && appended !== null)) {
      o.log.event('critical', 'recorder.manifest_not_recorded', { day, eligible: m.a24.eligibleCount, error_code: appended === 'dropped' ? 'E_QUEUE_FULL' : appended.rejected });
      return null;
    }
    o.db.withTx((tx) => { repos.universe_manifest.insert(tx, { dayUtc: day, sha256: m.sha256, path: `md:universe_manifest/${day}`, createdAt: now as UnixMs }); });
    o.log.event('info', 'recorder.universe_manifest', { day, sha256: m.sha256, eligible: m.a24.eligibleCount, late: m.late });
    return m.sha256;
  };

  return {
    tick(nowMs: UnixMs): void {
      const day = new Date(nowMs - DAY_MS).toISOString().slice(0, 10);
      const dayStart = Date.parse(`${day}T00:00:00.000Z`);
      if (day === lastDay || dayStart + DAY_MS <= firstStart) return;
      const sha = manifest(day, dayStart, nowMs);
      if (sha === null || has('coverage_report', day)) { lastDay = day; return; }
      const done = runDailyCoverage({
        dataDir: o.dataDir, nowMs, universeManifestSha256: sha, closedThrough: o.closedThrough,
        append: (report: CoverageReport, atMs: UnixMs) => { o.append({ stream: 'coverage', recvMs: atMs, slot: null, commitment: null, source: 'm07', payload: report }); },
        save: (report: CoverageReport) => {
          o.db.withTx((tx) => { repos.coverage_report.insert(tx, { dayUtc: report.dayUtc, json: JSON.stringify(report), lowCoverage: report.lowCoverage, manifestSha256: sha, createdAt: nowMs }); });
        },
      });
      if (done !== null) {
        o.log.event('info', 'recorder.coverage_report', { day, low_coverage: done.report.lowCoverage });
        lastDay = day;
      }
    },
  };
}
