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
import { buildUniverseManifest, eventsInOrder } from '../m05/manifest.ts';
import { limitSetHash, type UniverseLimits } from '../m05/universe.ts';
import { runDailyCoverage } from '../m07/daily.ts';
import type { CandidateState, CoverageReport, Pubkey, UnixMs } from '@bot/types';
import type { AppendInput, AppendResult } from '../recorder/queue.ts';
import type { EvictionLog } from './evictions.ts';

const DAY_MS = 86_400_000;
/** Ruling Z10-53: candidate events read per page when a manifest is built. */
const PAGE_ROWS = 2_000;
const FIRST_START_KEY = 'recorder.first_start_ms';
/** A manifest built more than this after its day ended is `late`. */
export const LATE_AFTER_MS = 600_000;

export interface DailyJob {
  /** Call every second or so; builds what is due, never twice. */
  tick(nowMs: UnixMs): void;
  /**
   * Ruling Z10-41: true while a day that is due (ended `LATE_AFTER_MS` ago, after the first start, in the last 7) has no
   * universe manifest in M24: the `recorder.manifest_not_recorded` condition, read from the database, so a restart
   * rebuilds it.
   */
  manifestMissing(nowMs: UnixMs): boolean;
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
  /** Ruling Z10-49: catch-up days already recorded or refused in this process. */
  const settled = new Set<string>();
  /** SW-28: catch-up days with a manifest whose D+1 hour 00 is not closed yet (day → the manifest's SHA-256). */
  const waiting = new Map<string, string>();
  let recordedCount = 0;
  let missingMemo: { minute: number; recorded: number; missing: boolean } | null = null;

  /**
   * Ruling Z10-53: the candidate events before `endMs`, in time order, read PAGE_ROWS at a time along the `at` index
   * (rowid breaks ties, which is insertion order), so a year of events is never one array in memory.
   */
  function* candidateEvents(endMs: number): Generator<{ poolId: Pubkey; mint: Pubkey; fromState: CandidateState | null; toState: CandidateState; reason: string; at: number }> {
    let at = 0, rowid = 0;
    for (;;) {
      const page = o.db.reader().all('SELECT rowid AS "rid", "pool_id", "mint", "from_state", "to_state", "reason", "at" FROM "candidate_event" INDEXED BY "candidate_event_at" WHERE "at" < ? AND ("at" > ? OR ("at" = ? AND rowid > ?)) ORDER BY "at", rowid LIMIT ?', endMs, at, at, rowid, PAGE_ROWS);
      for (const r of page) yield { poolId: String(r.pool_id) as Pubkey, mint: String(r.mint) as Pubkey, fromState: (r.from_state ?? null) as CandidateState | null, toState: String(r.to_state) as CandidateState, reason: String(r.reason), at: Number(r.at) };
      if (page.length < PAGE_ROWS) return;
      const end = page[page.length - 1] as Record<string, unknown>;
      at = Number(end.at); rowid = Number(end.rid);
    }
  }

  const manifest = (day: string, dayStart: number, now: number): string | null => {
    const row = o.db.reader().get('SELECT "sha256" FROM "universe_manifest" WHERE "day_utc" = ?', day) as { sha256: string } | undefined;
    if (row !== undefined) return row.sha256;
    const m = buildUniverseManifest({
      dayUtc: day, events: eventsInOrder(candidateEvents(dayStart + DAY_MS)), watchlistEvictions: o.evictions.between(0, dayStart + DAY_MS),
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
    recordedCount++;
    o.log.event('info', 'recorder.universe_manifest', { day, sha256: m.sha256, eligible: m.a24.eligibleCount, late: m.late });
    return m.sha256;
  };

  return {
    manifestMissing(nowMs: UnixMs): boolean {
      // At most one look a minute (the loop asks every second); a manifest recorded since clears it at once.
      const minute = Math.floor(nowMs / 60_000);
      if (missingMemo !== null && missingMemo.minute === minute && missingMemo.recorded === recordedCount) return missingMemo.missing;
      const missing = missingNow(nowMs);
      missingMemo = { minute, recorded: recordedCount, missing };
      return missing;
    },
    tick(nowMs: UnixMs): void {
      tickNow(nowMs);
    },
  };

  function missingNow(nowMs: UnixMs): boolean {
    for (let k = 1; k <= 7; k++) {
      const dayStart = Math.floor(nowMs / DAY_MS) * DAY_MS - k * DAY_MS;
      if (dayStart + DAY_MS <= firstStart) break;
      if (nowMs < dayStart + DAY_MS + LATE_AFTER_MS) continue;
      if (!has('universe_manifest', new Date(dayStart).toISOString().slice(0, 10))) return true;
    }
    return false;
  }

  function tickNow(nowMs: UnixMs): void {
    // Ruling Z10-49: every missing manifest of the 7-day window before yesterday, oldest first, so a recorder that was
    // down across a day boundary never leaves a day that cannot clear. A day found recorded, or refused once in this
    // process (its critical line already raised), is not looked at again.
    // SW-28: and its coverage report, once D+1's hour 00 is closed (until then the day is looked at again, without a
    // database read); a day whose manifest was refused gets none (Z10-F5).
    for (let k = 7; k >= 2; k--) {
      const ds = Math.floor(nowMs / DAY_MS) * DAY_MS - k * DAY_MS;
      const d = new Date(ds).toISOString().slice(0, 10);
      if (ds + DAY_MS <= firstStart || settled.has(d)) continue;
      const sha = waiting.get(d) ?? manifest(d, ds, nowMs);
      if (sha !== null && o.closedThrough() < `${new Date(ds + DAY_MS).toISOString().slice(0, 10)}T00`) { waiting.set(d, sha); continue; }
      waiting.delete(d);
      if (sha !== null && !has('coverage_report', d)) coverage(d, sha, nowMs);
      settled.add(d);
    }
    const day = new Date(nowMs - DAY_MS).toISOString().slice(0, 10);
    const dayStart = Date.parse(`${day}T00:00:00.000Z`);
    if (day === lastDay || dayStart + DAY_MS <= firstStart) return;
    const sha = manifest(day, dayStart, nowMs);
    if (sha === null || has('coverage_report', day)) { lastDay = day; return; }
    if (coverage(day, sha, nowMs)) lastDay = day;
  }

  /** Day `day`'s CoverageReport, appended and saved; false while D+1's hour 00 is still open. */
  function coverage(day: string, sha: string, nowMs: UnixMs): boolean {
    const done = runDailyCoverage({
      dataDir: o.dataDir, nowMs, dayUtc: day, universeManifestSha256: sha, closedThrough: o.closedThrough,
      append: (report: CoverageReport, atMs: UnixMs) => { o.append({ stream: 'coverage', recvMs: atMs, slot: null, commitment: null, source: 'm07', payload: report }); },
      save: (report: CoverageReport) => {
        o.db.withTx((tx) => { repos.coverage_report.insert(tx, { dayUtc: report.dayUtc, json: JSON.stringify(report), lowCoverage: report.lowCoverage, manifestSha256: sha, createdAt: nowMs }); });
      },
    });
    if (done === null) return false;
    o.log.event('info', 'recorder.coverage_report', { day, low_coverage: done.report.lowCoverage });
    return true;
  }
}
