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
import { buildUniverseManifest, ELIGIBLE_STATES, eventsInOrder, parseEvictionReason } from '../m05/manifest.ts';
import { limitSetHash, type UniverseLimits } from '../m05/universe.ts';
import { spawn, type ChildProcess } from 'node:child_process';
import { constants as osConstants, setPriority } from 'node:os';
import { fileURLToPath } from 'node:url';
import { checkCoverageOutput, COVERAGE_REPORT_MAX_BYTES } from '../m07/daily.ts';
import type { CandidateState, Pubkey, UnixMs } from '@bot/types';
import type { AppendInput, AppendResult } from '../recorder/queue.ts';
import { KEEP_MS, type EvictionLog } from './evictions.ts';

const DAY_MS = 86_400_000;
/** Ruling Z10-53: rows read per page when a manifest is built. */
const PAGE_ROWS = 2_000;
const FIRST_START_KEY = 'recorder.first_start_ms';
/** A manifest built more than this after its day ended is `late`. */
export const LATE_AFTER_MS = 600_000;

/** SW-45: how the coverage child runs (tests replace the command); its output is capped and checked. */
export interface CoverageChildOptions {
  command: string; args(dataDir: string, day: string, sha: string): string[];
  /** Killed after this long (wall clock: a child runs in real time, also under a simulated clock). */
  timeoutMs: number; maxBytes: number;
  /** SW-49: starts the timeout (default: an unref'd wall-clock timer); tests pass one they fire themselves. */
  timer(fire: () => void, ms: number): { cancel(): void };
  /**
   * SW-48: a day whose child failed waits `retryMs` before its next try, doubling with each failure in a row up to
   * `retryMaxMs` (every reason, timeouts too: one vCPU), and back to `retryMs` once a report is saved.
   */
  retryMs: number; retryMaxMs: number;
}
const CHILD_ENTRY = fileURLToPath(new URL('../../scripts/coverage-child.ts', import.meta.url));
export const COVERAGE_CHILD: CoverageChildOptions = {
  command: process.execPath,
  args: (dataDir, day, sha) => ['--no-warnings', '--max-old-space-size=192', CHILD_ENTRY, dataDir, day, sha],
  timeoutMs: 15 * 60_000, maxBytes: COVERAGE_REPORT_MAX_BYTES, retryMs: 15 * 60_000, retryMaxMs: 6 * 3_600_000,
  timer: (fire, ms) => { const t = setTimeout(fire, ms); t.unref(); return { cancel: () => clearTimeout(t) }; },
};

export interface DailyJob {
  /** Call every second or so; builds what is due, never twice. */
  tick(nowMs: UnixMs): void;
  /**
   * Ruling Z10-41: true while a day that is due (ended `LATE_AFTER_MS` ago, after the first start, in the last 7) has no
   * universe manifest in M24: the `recorder.manifest_not_recorded` condition, read from the database, so a restart
   * rebuilds it.
   */
  manifestMissing(nowMs: UnixMs): boolean;
  /** SW-46: the pools and candidate events the last manifest build read (bounded-read tests). */
  lastManifestRead(): { pools: number; events: number } | null;
  /** SW-45: true while a day's coverage child has failed and the day has no report yet (`recorder.coverage_failed`). */
  coverageFailed(): boolean;
  /** SW-45: the running coverage child's pid, or null. */
  coverageChild(): number | null;
  /** SW-45: kills a running coverage child and resolves once it has exited (the recorder's stop: no orphan). */
  stop(): Promise<void>;
  /** Resolves once the running coverage child has exited (at once when none runs); the next tick takes it in. */
  childClosed(): Promise<void>;
}

export function createDailyJob(o: {
  db: Db; dataDir: string; evictions: EvictionLog; limits: readonly UniverseLimits[]; limitSetId: string; prefilterOnly: boolean;
  migrationCoverage: () => { chainMigrations: number; seenByPumpPortal: number; gapBps: number };
  closedThrough: () => string; append: (r: AppendInput) => AppendResult | void; nowMs: () => UnixMs; coverageChild?: Partial<CoverageChildOptions>;
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
  const child: CoverageChildOptions = { ...COVERAGE_CHILD, ...o.coverageChild };
  /** SW-45: the coverage report being built, in a child process (one at a time). */
  let job: Running | null = null;
  /** SW-45/48: days whose child failed (when, the wait before the next try, the last reason), until their report is saved
   * or they leave the catch-up window. */
  const failed = new Map<string, { atMs: number; waitMs: number; reason: string }>();
  let readStats: { pools: number; events: number } | null = null;
  let recordedCount = 0;
  let missingMemo: { minute: number; recorded: number; missing: boolean } | null = null;

  /**
   * SW-46 (ruling Z10-53 kept: never one array of the whole history): the events before the day's end of the pools that
   * can matter to the day, in (at, rowid) order, the order the whole-history read gave. A pool matters if it has an
   * event since the day's start, or its state at the day's start may be eligible: its candidate is in an eligible state
   * now (with no event since the start, that is its state then), or is evicted, was written in the last KEEP_MS (an
   * eviction's tail, `universe.tail_extra_ms` plus the longest hold, stays far under KEEP_MS, as the eviction log already
   * assumes) and its eviction's tail reaches the day's start. Every other pool is out at the day's start and has no event in the day, so it adds nothing to the
   * manifest. Each pool's whole history is read (its own candidates, along `candidate_event_candidate`), so its state at
   * the start is the one the whole read built. Bounded by the day's pools, not by the history (DECISIONS SW-46).
   */
  function dayPoolEvents(dayStart: number): Array<{ poolId: Pubkey; mint: Pubkey; fromState: CandidateState | null; toState: CandidateState; reason: string; at: number }> {
    const r = o.db.reader();
    /** Ruling Z10-53: every read in pages of PAGE_ROWS, keyed on rowid (`sql` ends with `rowid > ?`). */
    const paged = (sql: string, ...ps: Array<string | number>): Array<Record<string, unknown>> => {
      const out: Array<Record<string, unknown>> = [];
      for (let after = 0; ;) {
        const page = r.all(`${sql} ORDER BY rowid LIMIT ?`, ...ps, after, PAGE_ROWS);
        out.push(...page);
        if (page.length < PAGE_ROWS) return out;
        after = Number((page[page.length - 1] as Record<string, unknown>).rid);
      }
    };
    const pools = new Set<string>();
    const eligible = [...ELIGIBLE_STATES];
    for (const x of paged(`SELECT rowid AS "rid", "pool_id" FROM "candidate" INDEXED BY "candidate_state" WHERE "state" IN (${eligible.map(() => '?').join(', ')}) AND rowid > ?`, ...eligible)) pools.add(String(x.pool_id));
    // An evicted candidate's last event is its eviction (the state and the event are written together); it can count at
    // the day's start only through a tail that reaches the start (the builder caps the span at the tail's end).
    for (const x of paged('SELECT rowid AS "rid", "pool_id", "candidate_id" FROM "candidate" INDEXED BY "candidate_state_updated" WHERE "state" = ? AND "updated_at" >= ? AND rowid > ?', 'evicted', dayStart - KEEP_MS)) {
      const last = r.get('SELECT "reason" FROM "candidate_event" INDEXED BY "candidate_event_candidate" WHERE "candidate_id" = ? ORDER BY "at" DESC, rowid DESC LIMIT 1', String(x.candidate_id));
      const tail = last === undefined ? null : parseEvictionReason(String(last.reason)).tailUntilMs;
      if (tail !== null && tail >= dayStart) pools.add(String(x.pool_id));
    }
    for (const x of paged('SELECT rowid AS "rid", "pool_id" FROM "candidate_event" INDEXED BY "candidate_event_at" WHERE "at" >= ? AND rowid > ?', dayStart)) pools.add(String(x.pool_id));
    const rows: Array<{ rid: number; poolId: Pubkey; mint: Pubkey; fromState: CandidateState | null; toState: CandidateState; reason: string; at: number }> = [];
    for (const pool of pools) {
      for (const c of paged('SELECT rowid AS "rid", "candidate_id" FROM "candidate" INDEXED BY "candidate_pool" WHERE "pool_id" = ? AND rowid > ?', pool)) {
        for (const e of paged('SELECT rowid AS "rid", "pool_id", "mint", "from_state", "to_state", "reason", "at" FROM "candidate_event" INDEXED BY "candidate_event_candidate" WHERE "candidate_id" = ? AND "at" < ? AND rowid > ?', String(c.candidate_id), dayStart + DAY_MS)) {
          rows.push({ rid: Number(e.rid), poolId: String(e.pool_id) as Pubkey, mint: String(e.mint) as Pubkey, fromState: (e.from_state ?? null) as CandidateState | null, toState: String(e.to_state) as CandidateState, reason: String(e.reason), at: Number(e.at) });
        }
      }
    }
    rows.sort((a, b) => a.at - b.at || a.rid - b.rid);
    readStats = { pools: pools.size, events: rows.length };
    return rows;
  }

  const manifest = (day: string, dayStart: number, now: number): string | null => {
    const row = o.db.reader().get('SELECT "sha256" FROM "universe_manifest" WHERE "day_utc" = ?', day) as { sha256: string } | undefined;
    if (row !== undefined) return row.sha256;
    const m = buildUniverseManifest({
      dayUtc: day, events: eventsInOrder(dayPoolEvents(dayStart)), watchlistEvictions: o.evictions.between(0, dayStart + DAY_MS),
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
    lastManifestRead: () => readStats,
    coverageFailed: () => failed.size > 0,
    coverageChild: () => job?.child.pid ?? null,
    childClosed: () => new Promise<void>((resolve) => {
      const j = job;
      if (j === null || j.closed !== null) { resolve(); return; }
      j.child.once('close', () => resolve());
    }),
    stop: () => new Promise<void>((resolve) => {
      const j = job;
      if (j === null || j.closed !== null) { resolve(); return; }
      j.failure = 'stopped';                                                // shutdown, never the day's failure
      j.child.once('close', () => resolve());
      j.child.kill('SIGKILL');
    }),
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
    // SW-45: a coverage child that has exited is taken in; the manifests below go on while one runs (they have their
    // own alert), and a second report waits until this one is done.
    if (job !== null && job.closed !== null) finishCoverage(nowMs);
    for (const d of failed.keys()) if (Date.parse(`${d}T00:00:00Z`) < nowMs - 8 * DAY_MS) failed.delete(d);
    // Ruling Z10-49: every missing manifest of the 7-day window before yesterday, oldest first, so a recorder that was
    // down across a day boundary never leaves a day that cannot clear. A day found recorded, or refused once in this
    // process (its critical line already raised), is not looked at again.
    // SW-28: and its coverage report, once D+1's hour 00 is closed (until then the day is looked at again, without a
    // database read); a day whose manifest was refused gets none (Z10-F5).
    for (let k = 7; k >= 2; k--) {
      const ds = Math.floor(nowMs / DAY_MS) * DAY_MS - k * DAY_MS;
      const d = new Date(ds).toISOString().slice(0, 10);
      if (ds + DAY_MS <= firstStart || settled.has(d) || job?.day === d) continue;
      const sha = waiting.get(d) ?? manifest(d, ds, nowMs);
      if (sha !== null && o.closedThrough() < `${new Date(ds + DAY_MS).toISOString().slice(0, 10)}T00`) { waiting.set(d, sha); continue; }
      waiting.delete(d);
      // SW-36: its coverage is built over the next ticks; the day is settled once the report is saved.
      if (sha !== null && !has('coverage_report', d)) { coverage(d, sha, nowMs); continue; }
      settled.add(d);
    }
    const day = new Date(nowMs - DAY_MS).toISOString().slice(0, 10);
    const dayStart = Date.parse(`${day}T00:00:00.000Z`);
    if (day === lastDay || dayStart + DAY_MS <= firstStart || job?.day === day) return;
    const sha = manifest(day, dayStart, nowMs);
    if (sha === null || has('coverage_report', day)) { lastDay = day; return; }
    coverage(day, sha, nowMs);
  }

  /**
   * Starts day `day`'s CoverageReport once D+1's hour 00 is closed (SW-12; nothing before that). SW-45: it is built in a
   * child process (scripts/coverage-child.ts) with no environment, so its decode churn goes with the child; a day whose
   * child failed waits `retryMs` before its next try.
   */
  function coverage(day: string, sha: string, nowMs: UnixMs): void {
    if (job !== null) return;                                                 // one at a time
    const next = new Date(Date.parse(`${day}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);
    if (o.closedThrough() < `${next}T00`) return;
    const f = failed.get(day);
    if (f !== undefined && nowMs < f.atMs + f.waitMs) return;
    let c: ChildProcess;
    // SW-40 (a): a spawn that throws (a bad argument) is a failure of the day's child, under the same back-off.
    try { c = spawn(child.command, child.args(o.dataDir, day, sha), { env: {}, stdio: ['ignore', 'pipe', 'pipe'] }); } catch { fail(day, 'spawn_throw', '', nowMs); return; }
    // SW-50: below the recorder's loop from its first instruction (the child lowers itself too, but only once its modules
    // have loaded). A child that has not started has no pid; one the system refuses to lower runs on.
    if (c.pid !== undefined) { try { setPriority(c.pid, osConstants.priority.PRIORITY_BELOW_NORMAL); } catch { /* runs at the recorder's priority */ } }
    const r: Running = { day, sha, child: c, chunks: [], bytes: 0, stderr: '', failure: null, closed: null, timer: null };
    c.stdout?.on('data', (b: Buffer) => {
      if (r.failure !== null) return;
      r.bytes += b.length;
      if (r.bytes > child.maxBytes) { r.failure = 'oversized'; c.kill('SIGKILL'); } else r.chunks.push(b);
    });
    c.stderr?.on('data', (b: Buffer) => { if (r.stderr.length < 300) r.stderr += b.toString('utf8').slice(0, 300 - r.stderr.length); });
    c.on('error', (e: NodeJS.ErrnoException) => { r.failure ??= `spawn_${e.code ?? 'failed'}`; });
    // 'close' follows 'exit', or 'error' when the child could not start (Node docs), once its pipes are drained.
    c.on('close', (code, signal) => { r.closed = { code, signal }; r.timer?.cancel(); });
    r.timer = child.timer(() => { if (r.closed === null) { r.failure ??= 'timeout'; c.kill('SIGKILL'); } }, child.timeoutMs);
    job = r;
  }

  /**
   * SW-48: one more failure of `day`'s child. The next try waits `retryMs`, doubling to `retryMaxMs`; one line at the
   * first failure and one each time the reason changes (not one every try).
   */
  function fail(day: string, reason: string, stderr: string, nowMs: UnixMs): void {
    const prev = failed.get(day);
    const waitMs = prev === undefined ? child.retryMs : Math.min(prev.waitMs * 2, child.retryMaxMs);
    failed.set(day, { atMs: nowMs, waitMs, reason });
    if (prev === undefined || prev.reason !== reason) o.log.event('error', 'recorder.coverage_failed', { day, reason, detail: stderr.trim().slice(0, 200) });
  }

  function finishCoverage(nowMs: UnixMs): void {
    const j = job as Running;
    job = null;
    const closed = j.closed as { code: number | null; signal: NodeJS.Signals | null };
    let reason = j.failure;
    let report = null;
    if (reason === null && closed.code !== 0) reason = closed.signal !== null ? `signal_${closed.signal}` : `exit_${String(closed.code)}`;
    if (reason === null) {
      const out = checkCoverageOutput(Buffer.concat(j.chunks).toString('utf8'), j.day, j.sha);
      if (out === null) reason = 'bad_output';
      else {
        report = out.report;
        // SW-37: each segment the child skipped whole (the report marks its hour: SW-38).
        for (const k of out.skipped) o.log.event('warn', 'm07.segment_unreadable', { day: j.day, path: k.path, reason: k.reason });
      }
    }
    if (j.failure === 'stopped') return;                                     // our own stop(): shutdown, not a failure
    if (report === null) { fail(j.day, reason ?? 'unknown', j.stderr, nowMs); return; }
    failed.delete(j.day);
    o.append({ stream: 'coverage', recvMs: nowMs, slot: null, commitment: null, source: 'm07', payload: report });
    o.db.withTx((tx) => { repos.coverage_report.insert(tx, { dayUtc: report.dayUtc, json: JSON.stringify(report), lowCoverage: report.lowCoverage, manifestSha256: j.sha, createdAt: nowMs }); });
    o.log.event('info', 'recorder.coverage_report', { day: j.day, low_coverage: report.lowCoverage });
    settled.add(j.day);
    if (j.day === new Date(nowMs - DAY_MS).toISOString().slice(0, 10)) lastDay = j.day;
  }
}

/** SW-45: a running coverage child. */
interface Running {
  day: string; sha: string; child: ChildProcess; chunks: Buffer[]; bytes: number; stderr: string;
  failure: string | null; closed: { code: number | null; signal: NodeJS.Signals | null } | null; timer: { cancel(): void } | null;
}
