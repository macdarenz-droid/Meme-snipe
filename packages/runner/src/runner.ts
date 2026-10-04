// The dry-run runner: samples the worker's health, runs the pre-set drills, and writes the evidence folder.
// One call runs one segment: the whole run on the VPS, or one ~5 h 50 min GitHub Actions job in the fallback,
// which resumes from the evidence folder and worker state the previous job saved.
import { createHash } from 'node:crypto';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { dirname, join } from 'node:path';
import { checkStartHealth, LOOKUP_BOUNDS_MS, type RestartCause, MARK_MAX_AGE_MS, RUN_NAME, STATE_FILES, type Health, type JournalLine } from './contract.ts';
import { snapshotState, type Tabletop, type WorkerControl } from './control.ts';
import { EXIT_UNIVERSES } from '../../core/src/config/index.ts';
import { item4 } from './item4.ts';
import { checkQuota, coverageGaps, lookupLatency, quotaReport, rejections, type BootTotals } from './quota.ts';
import { checkJournal } from './journal.ts';
import { makePlan, type Drill } from './plan.ts';
import { buildReport, reportMarkdown, type DrillOutcome, type Kept, type Label, type RecordedFile, type RecoveredState, type Report, type RunMeta, type Sample } from './report.ts';

export interface SegmentOptions {
  readonly control: WorkerControl;
  readonly healthAddr: string;
  readonly stateDir: string;
  /** The run's evidence folder: evidence/dryrun/<runId>. */
  readonly evidenceDir: string;
  /** Who this runner is: computed from where it runs, never read from restored state. A resumed run must match. */
  readonly identity: { readonly label: Label; readonly commit: string };
  /** New runs only. `entry` is the worker entry (local) or `systemd:<unit>` (host). */
  readonly newRun?: {
    readonly runId: string; readonly name?: string; readonly strategy?: string; readonly targetMs: number; readonly entry: string; readonly restarts?: number;
    readonly causes?: readonly RestartCause[]; readonly restartWindowMs?: number; readonly feedDropMs?: number; readonly rpcDrops?: number; readonly rpcDropMs?: number;
  };
  /** Wall-clock end of this segment (ms epoch). The run itself ends at startedAt + targetMs. */
  readonly segmentEnd: number;
  /** Where recorded data is kept: `copy` into evidenceDir/recorded (fallback artifacts), or `host` (left in place on the VPS). */
  readonly keepRecorded: 'copy' | 'host';
  /** With `copy`: the folder this job's recorded files are moved to, and the artifact name that folder ships as. */
  readonly recordedDir?: string;
  readonly recordedArtifact?: string;
  /**
   * Resuming means the previous segment stopped the worker (fallback job boundary): count it as a restart drill.
   * Off on the VPS, where a resumed runner finds the worker still running under systemd.
   */
  readonly handover?: boolean;
  readonly sampleMs?: number;
  /** Local only: take the runner's own backup of the bot state this often, for host-loss drills. */
  readonly backupEveryMs?: number;
  /** Host tabletop: how long before its file's time a backup may have read the database (default BACKUP_WINDOW_MS). */
  readonly backupWindowMs?: number;
  /**
   * Host: a host-loss tabletop that could only self-report is tried again this long after the backup it restored
   * (default HOST_RETRY_AFTER_MS: the hourly zeroed-backup.timer plus a margin, so the next backup exists and is done).
   */
  readonly hostRetryAfterMs?: number;
  /**
   * How host loss and chain rebuild are drilled. `wipe` (rehearsal): the bot state is deleted (and the backup restored
   * for host loss). `tabletop` (the qualifying host): a second worker in `--reconcile-only` mode cold-starts beside the
   * live one, from the newest backup or an empty state dir; the live worker and the evidence are untouched. On the
   * host a reboot drill also outlives this runner, so it is kept on disk and finished after boot.
   */
  readonly hostDrills?: 'wipe' | 'tabletop';
  /** The host's off-site backup switch (ops/host-config.json), reported with the restore drill. */
  readonly offsiteBackup?: boolean;
  readonly dropRpc?: (addr: string, token: string, ms: number) => Promise<boolean>;
  /** A restart counts as recovered when the new boot is ready within this time. */
  readonly recoverMs?: number;
  readonly startTimeoutMs?: number;
  readonly fetchHealth?: (addr: string) => Promise<Health | null>;
  readonly dropFeed?: (addr: string, token: string, feed: string, ms: number) => Promise<boolean>;
  readonly log?: (s: string) => void;
}

export interface SegmentResult {
  readonly done: boolean;
  readonly aborted: string | null;
  readonly report: Report | null;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export const httpHealth = async (addr: string): Promise<Health | null> => {
  try {
    const res = await fetch(`http://${addr}/health`, { signal: AbortSignal.timeout(3000) });
    return res.ok ? ((await res.json()) as Health) : null;
  } catch {
    return null;
  }
};

export const httpDropRpc = async (addr: string, token: string, ms: number): Promise<boolean> => {
  try {
    const res = await fetch(`http://${addr}/drill/drop-rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-zeroed-drill-token': token },
      body: JSON.stringify({ ms }),
      signal: AbortSignal.timeout(3000),
    });
    return res.status === 202;
  } catch {
    return false;
  }
};

export const httpDropFeed = async (addr: string, token: string, feed: string, ms: number): Promise<boolean> => {
  try {
    const res = await fetch(`http://${addr}/drill/drop-feed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-zeroed-drill-token': token },
      body: JSON.stringify({ feed, ms }),
      signal: AbortSignal.timeout(3000),
    });
    return res.status === 202;
  } catch {
    return false;
  }
};

const toSample = (t: number, h: Health | null): Sample => ({
  t,
  kept: killReplyValid(h) ? kept(h) : null,
  up: h !== null,
  ready: h !== null && h.reconciled === true,
  boot: h?.boot ?? null,
  git_sha: h?.git_sha ?? null,
  rss_bytes: h?.rss_bytes ?? null,
  in_trade: h !== null && (h.open_position !== null || h.unresolved_intents.count > 0),
  exit_capable: h?.exit_capable === true,
  mark: h?.open_position?.mark ?? null,
  entries_halted: h?.entries_halted ?? false,
  recorder: h?.recorder === 'on',
  simulation: h?.simulation === 'on',
  stub: h?.stub === true,
  feeds: h ? Object.keys(h.feeds).sort().join(',') : null,
  feeds_down: h ? Object.entries(h.feeds).flatMap(([n, f]) => (f.connected ? [] : [n])) : [],
});

const feedSet = (h: Health): string => Object.keys(h.feeds).sort().join(',');
const planFeeds = (m: RunMeta): string => m.plan.flatMap((d) => (d.kind === 'feed' ? [d.feed] : [])).sort().join(',');

const readJson = <T>(p: string, fallback: T): T => (existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as T) : fallback);
const readLines = <T>(p: string): T[] =>
  existsSync(p)
    ? readFileSync(p, 'utf8')
        .split('\n')
        .flatMap((l) => {
          try {
            return l ? [JSON.parse(l) as T] : [];
          } catch {
            return [];
          }
        })
    : [];

type Pending =
  | RestartPending
  | {
      kind: 'rpc'; drill: Extract<Drill, { kind: 'rpc' }>; since: number; sinceMono: number; requested: boolean; boot: string | null;
      sawIncapable: boolean; sawHalt: boolean; stayedUp: boolean; shedBefore: number | null; pendingBefore: readonly string[];
      /** The reply's journal_seq when pendingBefore was read: an exit journaled after it finished, it was not lost. */
      seqBefore: number | null;
    }
  | { kind: 'feed'; drill: Extract<Drill, { kind: 'feed' }>; since: number; sawDown: boolean; sawHalt: boolean; critical: boolean; boot: string | null; stayedUp: boolean; requested: boolean }
  | { kind: 'handover'; since: number; prevBoot: string | null; midTrade: boolean; plannedAt: number };

/** A restart drill in progress. Durations run on the monotonic clock, except across a host reboot (wall, from the journal). */
interface RestartPending {
  kind: 'restart';
  drill: Extract<Drill, { kind: 'restart' }>;
  since: number;
  killedAt?: number;
  killedMono?: number;
  prevBoot?: string | null;
  midTrade?: boolean;
  /** A position was open at the kill: measure the unprotected exposure until the new boot is exit capable. */
  open?: boolean;
  trades?: readonly string[];
  tradesComplete?: boolean;
  markBefore?: string | null;
  /** What the health reply before the kill held, and what the new boot must recover (null: nothing, chain rebuild). */
  atKill?: Kept;
  expect?: Kept | null;
  /** Host-loss or chain-rebuild tabletop on the qualifying host: the second worker's address and state dir. */
  table?: Tabletop;
  /** Tabletop host loss on the host: the live worker's state when the restored backup was taken, or why it is unknown. */
  backupKept?: Kept;
  notCompared?: string;
  /** Rehearsal host loss: the backup was taken at the first trade of the window; the host is lost one sample later. */
  snapped?: boolean;
  /** The health reply at the kill was present and valid (pending exits are ids; an open position names its universe). */
  killValid?: boolean;
  /** The reply's journal_seq: journal lines after it were written between the reply and the kill. */
  killSeq?: number | null;
  inFlight?: number;
  /** Things the restart had to keep: positions, in-flight entries and pending exits (for host loss, the backup's). */
  keep?: number;
  /** Opened after the backup (host loss): reported, not expected back. */
  afterBackup?: readonly string[];
  reconciledAt?: number;
  ok?: boolean;
}

const kept = (h: Health | null): Kept => ({
  pending_exits: h && Array.isArray(h.pending_exits) ? [...h.pending_exits] : [],
  positions: h?.open_position ? [{ trade: h.open_position.trade, universe: h.open_position.universe }] : [],
});

export const runSegment = async (o: SegmentOptions): Promise<SegmentResult> => {
  const log = o.log ?? ((s: string) => console.log(s));
  const sampleMs = o.sampleMs ?? 10_000;
  const recoverMs = o.recoverMs ?? 120_000;
  const fetchHealth = o.fetchHealth ?? httpHealth;
  const dropFeed = o.dropFeed ?? httpDropFeed;
  const ev = o.evidenceDir;
  mkdirSync(ev, { recursive: true });
  const P = { meta: join(ev, 'run.json'), samples: join(ev, 'samples.jsonl'), drills: join(ev, 'drills.json'), segments: join(ev, 'segments.json'), manifest: join(ev, 'recorded.json'), boots: join(ev, 'boots.json'), backup: join(ev, 'backup.json'), reboot: join(ev, 'pending-reboot.json'), retry: join(ev, 'host-loss-retry.json') };
  const resumed = existsSync(P.meta);
  if (!resumed && !o.newRun) throw new Error(`no run in ${ev} and no new-run options`);

  const outcomes: DrillOutcome[] = readJson(P.drills, []);
  const boots: Record<string, BootTotals> = readJson(P.boots, {});
  const segments: { start: number; end: number | null; lastInTrade: boolean; lastBoot: string | null }[] = readJson(P.segments, []);
  const manifest: RecordedFile[] = readJson(P.manifest, []);
  const backupDir = join(ev, 'backup');
  let backup = readJson<{ at: number; expect: Kept } | null>(P.backup, null);
  // A host-loss tabletop that could only self-report is tried again after the host's next backup (kept on disk across
  // segments). Each try is its own drill, labelled; only a compared one exercises host loss on a VPS run.
  let retry = readJson<HostLossRetry | null>(P.retry, null);
  const prev = segments[segments.length - 1];
  const segStart = Date.now();
  segments.push({ start: segStart, end: null, lastInTrade: false, lastBoot: null });
  const saveDrills = (): void => writeFileSync(P.drills, JSON.stringify(outcomes, null, 2));

  // Restored state is data from a previous job (an artifact): it cannot choose the label or the commit.
  // Neither refusal builds a report: the restored run.json is untrusted, and a finished run keeps its own report.
  if (resumed) {
    if (existsSync(join(ev, 'report.json'))) return finish('refused to resume: the run already has its final report', false);
    const m = readJson<RunMeta | null>(P.meta, null);
    if (!m || m.label !== o.identity.label || m.commit !== o.identity.commit) {
      return finish(`refused to resume: restored run is ${m?.label ?? '?'} at ${m?.commit ?? '?'}, this runner is ${o.identity.label} at ${o.identity.commit}`, false);
    }
  }

  await o.control.start();

  // First ready health: needed to fix the plan (feed names) and to refuse a run with recorder or simulation off.
  let first: Health | null = null;
  const deadline = Date.now() + (o.startTimeoutMs ?? 180_000);
  while (Date.now() < deadline) {
    const h = await fetchHealth(o.healthAddr);
    if (h?.reconciled) {
      first = h;
      break;
    }
    await sleep(Math.min(1000, sampleMs));
  }
  if (!first) return finish('worker never became ready');
  const startCheck = checkStartHealth(first);
  if (!startCheck.ok) return finish(`refused to run: ${startCheck.problems.join(', ')}`);

  let meta: RunMeta;
  if (resumed) {
    meta = readJson<RunMeta>(P.meta, null as unknown as RunMeta);
    if (feedSet(first) !== planFeeds(meta)) return finish(`feed names changed: plan has ${planFeeds(meta)}, worker reports ${feedSet(first)}`);
  } else {
    const n = o.newRun!;
    const plan = makePlan({
      durationMs: n.targetMs,
      feeds: Object.keys(first.feeds),
      ...(n.restarts === undefined ? {} : { restarts: n.restarts }),
      ...(n.restartWindowMs === undefined ? {} : { restartWindowMs: n.restartWindowMs }),
      ...(n.feedDropMs === undefined ? {} : { feedDropMs: n.feedDropMs }),
      ...(n.causes === undefined ? {} : { causes: n.causes }),
      ...(n.rpcDrops === undefined ? {} : { rpcDrops: n.rpcDrops }),
      ...(n.rpcDropMs === undefined ? {} : { rpcDropMs: n.rpcDropMs }),
      minFeedDropMs: 2 * sampleMs,
    });
    meta = { runId: n.runId, strategy: n.strategy ?? 'none', ...(n.name === undefined ? {} : { name: n.name }), label: o.identity.label, commit: o.identity.commit, startedAt: segStart, targetMs: n.targetMs, entry: n.entry, plan };
    writeFileSync(P.meta, JSON.stringify(meta, null, 2));
    log(`Run ${meta.runId}: ${meta.label}, commit ${meta.commit}, ${plan.length} drills planned.`);
  }
  const runEnd = meta.startedAt + meta.targetMs;
  const endAt = Math.min(runEnd, o.segmentEnd);

  // A fallback job boundary is a restart drill too: the previous job stopped the worker, this one restored state.
  let pending: Pending | null =
    resumed && prev && o.handover !== false ? { kind: 'handover', since: segStart, prevBoot: prev.lastBoot, midTrade: prev.lastInTrade, plannedAt: prev.end ?? segStart } : null;
  // Back from a host reboot drill: the runner died with the host, so this drill is timed on the wall clock.
  // Kept on disk until the drill is recorded, so a runner crash before then cannot lose it.
  const done = new Set(outcomes.map((d) => d.id));
  // A retry already recorded (the runner stopped between recording it and deleting the file) is never run twice.
  if (retry !== null && done.has(retryId(retry))) {
    rmSync(P.retry, { force: true });
    retry = null;
  }
  const rebooted = readJson<RestartPending | null>(P.reboot, null);
  // Already recorded (the runner stopped between recording it and deleting the file): never run it twice.
  if (rebooted && done.has(rebooted.drill.id)) rmSync(P.reboot, { force: true });
  else if (rebooted) pending = rebooted;
  const handovers = outcomes.filter((d) => d.kind === 'handover').length;

  let last: Sample | null = null;
  while (Date.now() < endAt) {
    const t = Date.now();
    const h = await fetchHealth(o.healthAddr);
    const s = toSample(t, h);
    if (h) noteBoot(h);
    appendFileSync(P.samples, `${JSON.stringify(s)}\n`);
    last = s;
    const rel = t - meta.startedAt;

    // The runner's own backup of the bot state for local host-loss drills, with what it should restore.
    if (o.backupEveryMs !== undefined && pending === null && h?.reconciled && (backup === null || t - backup.at >= o.backupEveryMs)) {
      await takeBackup(h, t);
    }

    if (pending === null) {
      const due = meta.plan.find((d) => !done.has(d.id) && d.atMs <= rel);
      if (due === undefined && retry !== null && t >= retry.dueAt) {
        const orig = meta.plan.find((d): d is Extract<Drill, { kind: 'restart' }> => d.id === retry!.drill && d.kind === 'restart');
        if (orig) pending = { kind: 'restart', drill: { ...orig, id: retryId(retry) }, since: t };
        // The file stays until the try is recorded, so a runner crash mid-try runs it again after the restart.
        retry = null;
      }
      if (due?.kind === 'restart') pending = { kind: 'restart', drill: due, since: t };
      else if (due?.kind === 'rpc') {
        pending = { kind: 'rpc', drill: due, since: t, sinceMono: performance.now(), requested: false, boot: s.boot, sawIncapable: false, sawHalt: false, stayedUp: true, shedBefore: h ? exitShed(h) : null, pendingBefore: kept(h).pending_exits, seqBefore: h?.journal_seq ?? null };
      } else if (due?.kind === 'feed') pending = { kind: 'feed', drill: due, since: t, sawDown: false, sawHalt: false, critical: false, boot: s.boot, stayedUp: true, requested: false };
    }

    if (pending?.kind === 'handover') {
      if (s.ready && s.boot !== pending.prevBoot) {
        const ok = reconciledFirst(o.stateDir, s.boot!);
        record({ id: `handover-${handovers + 1}`, kind: 'handover', plannedAt: pending.plannedAt, at: pending.since, pass: ok, midTrade: pending.midTrade, recoveredMs: t - pending.plannedAt, notes: [ok ? 'state restored, reconciled before any entry' : 'no successful reconcile before entry'] });
        pending = null;
      } else if (t - pending.since > recoverMs) {
        record({ id: `handover-${handovers + 1}`, kind: 'handover', plannedAt: pending.plannedAt, at: pending.since, pass: false, midTrade: pending.midTrade, recoveredMs: null, notes: ['worker not ready after restore'] });
        pending = null;
      }
    } else if (pending?.kind === 'restart') {
      const p = pending;
      const cause = p.drill.cause ?? 'crash';
      const base = { id: p.drill.id, kind: 'restart' as const, cause, plannedAt: meta.startedAt + p.drill.atMs, midTrade: p.midTrade === true };
      // Elapsed since the kill on the clock the drill started with.
      const since = (): number => (p.killedMono !== undefined ? performance.now() - p.killedMono : Date.now() - p.killedAt!);
      const clock = p.killedMono !== undefined ? ('monotonic' as const) : ('wall' as const);
      const hostLossWipe = cause === 'host-loss' && o.hostDrills !== 'tabletop';
      // The runner's own backups (a rehearsal, wipe or tabletop): host loss restores the copy it takes for the drill.
      const localHostLoss = cause === 'host-loss' && o.backupEveryMs !== undefined;
      if (p.killedAt === undefined) {
        const due = s.in_trade || t - p.since >= p.drill.windowMs;
        if (localHostLoss && !p.snapped && t - p.since >= 2 * p.drill.windowMs) {
          record({ ...base, at: t, pass: false, recoveredMs: null, notes: ['no backup to restore: the worker\'s state never held still for a copy'] });
          pending = null;
        } else if (localHostLoss && !p.snapped) {
          // Rehearsal host loss: back up at the first trade of the window (a copy the replies around it confirm) and
          // lose the host one sample later, so the backup always holds something to restore (a host loss with nothing
          // in the backup proves nothing).
          if (due && h?.reconciled) {
            p.snapped = await takeBackup(h, t);
          }
        } else if (due && hostLossWipe && backup === null) {
          record({ ...base, at: t, pass: false, recoveredMs: null, notes: ['no backup to restore'] });
          pending = null;
        } else if (due) {
          p.prevBoot = s.boot;
          p.midTrade = s.in_trade;
          p.killValid = killReplyValid(h);
          // An entry in flight (an intent, no position yet) is exposed too. Without a valid reply nothing is known.
          p.open = h === null || (h.open_position != null || h.unresolved_intents.count > 0);
          p.trades = h ? exposedTrades(h) : [];
          p.tradesComplete = h !== null && tradeIdsComplete(h);
          p.markBefore = h ? freshMark(h) : null;
          p.atKill = p.killValid ? kept(h) : { pending_exits: [], positions: [] };
          p.killSeq = h?.journal_seq ?? null;
          p.inFlight = h?.unresolved_intents.count ?? 0;
          p.expect = cause === 'chain-rebuild' ? null : cause === 'host-loss' ? (backup?.expect ?? { pending_exits: [], positions: [] }) : p.atKill;
          const inFlight = h?.unresolved_intents.count ?? 0;
          p.keep =
            cause === 'host-loss'
              ? (p.expect?.positions.length ?? 0) + (p.expect?.pending_exits.length ?? 0)
              : p.atKill.positions.length + p.atKill.pending_exits.length + inFlight;
          if (cause === 'host-loss' && p.expect) {
            const inBackup = new Set([...p.expect.positions.map((x) => x.trade), ...p.expect.pending_exits]);
            p.afterBackup = [...new Set([...p.atKill.positions.map((x) => x.trade), ...p.atKill.pending_exits])].filter((x) => !inBackup.has(x));
          }
          if ((cause === 'host-loss' || cause === 'chain-rebuild') && o.hostDrills === 'tabletop') {
            // The live worker keeps running: the tabletop worker is the one that "lost its host".
            p.killedAt = Date.now();
            p.killedMono = performance.now();
            p.open = false;
            p.prevBoot = null;
            try {
              p.table = await o.control.tabletop({ restore: cause === 'host-loss', restoreFrom: backupDir });
              if (cause === 'host-loss' && o.backupEveryMs === undefined) {
                // The host's own hourly backup: compare the restore with what the live worker held when it was taken.
                const at = p.table.backup ? keptAt(readLines<Sample>(P.samples), p.table.backup.at, sampleMs, o.backupWindowMs) : { why: 'the restored backup is not known' };
                if ('kept' in at) p.backupKept = at.kept;
                else p.notCompared = at.why;
              }
              log(`Drill ${p.drill.id} (${cause}): tabletop worker started beside the run.`);
            } catch (e) {
              record({ ...base, at: t, off_run: true, pass: false, recoveredMs: null, notes: [cause === 'host-loss' ? 'no backup to restore' : 'tabletop did not start', String((e as Error).message).slice(0, 200)] });
              pending = null;
            }
          } else {
            p.killedAt = Date.now();
            p.killedMono = performance.now();
            if (cause === 'reboot' && o.hostDrills === 'tabletop') {
              // The host reboots and takes this runner with it: keep the drill on disk to finish it after boot.
              const onDisk: RestartPending = { ...p };
              delete onDisk.killedMono;
              writeFileSync(P.reboot, JSON.stringify(onDisk));
            }
            if (cause === 'crash') await o.control.kill();
            else if (cause === 'reboot') await o.control.reboot();
            else if (cause === 'host-loss') await o.control.wipe({ restoreFrom: backupDir });
            else await o.control.wipe({});
            log(`Drill ${p.drill.id} (${cause}): down${p.midTrade ? ' mid-trade' : ' (no trade open in the window)'}.`);
          }
        }
      }
      // A tabletop drill watches the second worker; every other restart watches the live one.
      const th = pending !== null && p.table && p.killedAt !== undefined ? await fetchHealth(p.table.healthAddr) : null;
      if (th) noteBoot(th);
      const ws: { ready: boolean; boot: string | null; exit_capable: boolean } = p.table
        ? { ready: th?.reconciled === true, boot: th?.boot ?? null, exit_capable: th?.exit_capable === true }
        : { ready: s.ready, boot: s.boot, exit_capable: s.exit_capable === true };
      const wDir = p.table?.stateDir ?? o.stateDir;
      if (pending !== null && p.killedAt !== undefined && p.reconciledAt === undefined && ws.ready && ws.boot !== p.prevBoot) {
        p.reconciledAt = since();
        p.ok = reconciledFirst(wDir, ws.boot!);
      }
      // Recovered means reconciled and able to exit (DECISIONS, Standby), timed for every restart, open position or not.
      if (pending !== null && p.killedAt !== undefined && p.reconciledAt !== undefined && ws.exit_capable && ws.boot !== p.prevBoot) {
        const k = p.killedAt;
        const lines = journalLines(wDir);
        let recovery = { reconciled_ms: p.reconciledAt, exit_capable_ms: since(), clock };
        const notes: string[] = [];
        if (clock === 'wall') {
          // Across a host reboot the runner came back later than the worker: time from the worker's own journal.
          const fromJournal = journalTimes(lines, ws.boot!, k);
          if (fromJournal) recovery = { ...recovery, ...fromJournal };
          notes.push(fromJournal ? 'timed on the wall clock across the reboot, from the journal' : 'timed on the wall clock across the reboot (no exit_capable line: upper bound)');
        }
        const hostTable = p.table !== undefined && cause === 'host-loss' && o.backupEveryMs === undefined;
        // The reply came a moment before the kill: a trade the worker closed in between (its exit line is in the
        // journal, after the reply) was not there to keep. The journal is written synchronously, so it is exact.
        const closed = p.table ? [] : closedSince(lines, p.prevBoot ?? null, p.killSeq ?? null);
        if (closed.length) {
          const atKill = withoutTrades(p.atKill ?? { pending_exits: [], positions: [] }, closed);
          p.atKill = atKill;
          if (cause === 'crash' || cause === 'reboot') {
            p.expect = atKill;
            p.keep = atKill.positions.length + atKill.pending_exits.length + (p.inFlight ?? 0);
          }
          p.trades = (p.trades ?? []).filter((x) => !closed.includes(x));
          notes.push(`closed between the last reply and the kill (journal): ${closed.join(', ')}`);
        }
        let state = recoveredState(lines, ws.boot!, cause, hostTable ? (p.backupKept ?? { pending_exits: [], positions: [] }) : (p.expect ?? null), p.atKill ?? { pending_exits: [], positions: [] });
        if (p.table && cause === 'host-loss' && state.source !== 'state') state = { ...state, state_ok: false, notes: [...state.notes, `restored from the backup but reported source ${String(state.source)}`] };
        // Tabletop host loss: what the backup held is what the tabletop worker restored.
        // Compared: what the live worker held when the backup was taken. Otherwise only what the tabletop reports.
        if (hostTable && p.backupKept) {
          p.keep = p.backupKept.positions.length + p.backupKept.pending_exits.length;
          notes.push(`compared with the live worker's state when ${p.table!.backup!.name} was taken`);
        } else if (p.table && cause === 'host-loss') {
          const rl = lines.find((l) => l.boot === ws.boot && l.kind === 'recovered');
          p.keep = (Array.isArray(rl?.['positions']) ? (rl['positions'] as unknown[]).length : 0) + (Array.isArray(rl?.['pending_exits']) ? (rl['pending_exits'] as unknown[]).length : 0);
          if (hostTable) notes.push(`self-reported, not compared to the backup (${p.notCompared ?? 'no record'})`);
        }
        if (p.killValid === false) state = { ...state, state_ok: false, notes: [...state.notes, 'the reply at the kill was missing or invalid: what had to be kept is unknown'] };
        notes.unshift(p.ok ? 'reconciled before any entry' : 'no successful reconcile before entry', ...state.notes);
        if (p.afterBackup?.length) notes.push(`opened after the backup, not expected back: ${p.afterBackup.join(', ')}`);
        if (hostLossWipe) notes.push('rehearsal backup copied while the worker ran: a ledger database copied that way can be torn (the host backs up with the database\'s own online backup)');
        if (p.table) {
          await endTabletop(p.drill.id, p.table);
          notes.push('tabletop beside the qualifying run: the live worker kept running', offsiteNote(o.offsiteBackup));
        }
        const unknown = p.killValid === false;
        const exposure = p.open
          ? {
              status: unknown ? ('unknown' as const) : ('measured' as const), duration_ms: recovery.exit_capable_ms, reconciled_ms: recovery.reconciled_ms, trades: p.trades ?? [],
              trades_complete: p.tradesComplete === true, chain_trades: [], mark_before: p.markBefore ?? null, mark_after: h ? freshMark(h) : null,
              worst_move_bps: unknown ? null : moveBps(p.markBefore ?? null, h ? freshMark(h) : null), move_source: 'marks' as const,
            }
          : undefined;
        if (hostTable && p.backupKept === undefined) {
          const root = p.drill.id.replace(/-retry-\d+$/, '');
          const attempt = p.drill.id === root ? 1 : Number(p.drill.id.slice(root.length + '-retry-'.length)) + 1;
          if (attempt <= HOST_LOSS_RETRIES) {
            retry = { drill: root, attempt, dueAt: (p.table!.backup?.at ?? k) + (o.hostRetryAfterMs ?? HOST_RETRY_AFTER_MS) };
            writeFileSync(P.retry, JSON.stringify(retry));
            notes.push(`tried again after the next backup (try ${attempt} of ${HOST_LOSS_RETRIES})`);
          } else notes.push(`no compared restore after ${HOST_LOSS_RETRIES} retries`);
        }
        record({ ...base, at: k, pass: p.ok === true && state.state_ok && state.universe_ok && !unknown, ...(p.table ? { off_run: true } : {}), ...(hostTable ? { compared: p.backupKept !== undefined } : {}), keep: p.keep ?? 0, recoveredMs: recovery.reconciled_ms, recovery, state, ...(exposure ? { exposure } : {}), notes });
        pending = null;
      } else if (pending !== null && p.killedAt !== undefined && since() > recoverMs) {
        if (p.table) await endTabletop(p.drill.id, p.table);
        const stage = p.reconciledAt === undefined ? 'not ready' : 'not exit capable';
        // No reply at all at the window's end: the exposure is unknown, never assumed.
        const status = h === null || p.killValid === false ? ('unknown' as const) : ('unmeasured' as const);
        record({
          ...base, ...(p.table ? { off_run: true } : {}), at: p.killedAt, pass: false, keep: p.keep ?? 0, recoveredMs: p.reconciledAt ?? null, recovery: { reconciled_ms: p.reconciledAt ?? null, exit_capable_ms: null, clock },
          ...(p.open ? { exposure: { status, duration_ms: null, reconciled_ms: p.reconciledAt ?? null, trades: p.trades ?? [], trades_complete: p.tradesComplete === true, chain_trades: [], mark_before: p.markBefore ?? null, mark_after: null, worst_move_bps: null, move_source: 'marks' as const } } : {}),
          notes: [`${stage} ${recoverMs / 1000} s after the kill${status === 'unknown' ? ' (no health reply)' : ''}`],
        });
        pending = null;
      }
    } else if (pending?.kind === 'rpc') {
      const p = pending;
      const d = p.drill;
      if (!p.requested) {
        p.requested = true;
        const token = readToken(o.stateDir);
        const accepted = token !== null && (await (o.dropRpc ?? httpDropRpc)(o.healthAddr, token, d.dropMs));
        if (!accepted) {
          record({ id: d.id, kind: 'rpc', plannedAt: meta.startedAt + d.atMs, at: t, pass: false, notes: ['drop request refused or drill token missing'] });
          pending = null;
        } else {
          // The drop starts when the worker accepts it, not when the drill fell due (a loaded runner acts later).
          p.since = Date.now();
          p.sinceMono = performance.now();
          log(`Drill ${d.id}: all providers dropped for ${d.dropMs / 1000} s.`);
        }
      } else {
        if (!s.up || s.boot !== p.boot) p.stayedUp = false;
        if (h && !h.exit_capable) p.sawIncapable = true;
        if (s.entries_halted) p.sawHalt = true;
        const elapsed = performance.now() - p.sinceMono;
        const back = elapsed > d.dropMs && h !== null && h.exit_capable;
        if (back || elapsed > d.dropMs + recoverMs) {
          const notes: string[] = [];
          if (!p.sawHalt) notes.push('entries not halted while every provider was down');
          if (!p.sawIncapable) notes.push('worker reported itself exit capable with no provider');
          if (!p.stayedUp) notes.push('worker went down during the drop');
          if (!back) notes.push('not exit capable after the providers came back');
          const shedAfter = h ? exitShed(h) : null;
          if (p.shedBefore !== null && shedAfter !== null && shedAfter > p.shedBefore) notes.push(`${shedAfter - p.shedBefore} P0/P1 requests shed`);
          // A pending exit that finished (its exit is in the journal) was not lost.
          const finished = closedSince(journalLines(o.stateDir), p.boot, p.seqBefore);
          const lost = p.pendingBefore.filter((x) => !(h?.pending_exits ?? []).includes(x) && !finished.includes(x));
          if (lost.length) notes.push(`pending exits lost: ${lost.join(', ')}`);
          record({
            id: d.id, kind: 'rpc', plannedAt: meta.startedAt + d.atMs, at: p.since, pass: notes.length === 0,
            recoveredMs: back ? Math.max(0, Math.round(elapsed - d.dropMs)) : null,
            recovery: { reconciled_ms: null, exit_capable_ms: back ? Math.max(0, Math.round(elapsed - d.dropMs)) : null, clock: 'monotonic' },
            notes: notes.length ? notes : ['entries halted, no exit capacity shed, exit capable again'],
          });
          pending = null;
        }
      }
    } else if (pending?.kind === 'feed') {
      const p = pending;
      const d = p.drill;
      if (!p.requested) {
        p.requested = true;
        p.critical = first.feeds[d.feed]?.critical === true;
        const token = readToken(o.stateDir);
        const accepted = token !== null && (await dropFeed(o.healthAddr, token, d.feed, d.dropMs));
        if (!accepted) {
          record({ id: d.id, kind: 'feed', feed: d.feed, plannedAt: meta.startedAt + d.atMs, at: t, pass: false, notes: ['drop request refused or drill token missing'] });
          pending = null;
        } else {
          // The drop starts when the worker accepts it: entries are counted from then, not from when it fell due.
          p.since = Date.now();
          log(`Drill ${d.id}: dropped ${d.feed} for ${d.dropMs / 1000} s.`);
        }
      } else {
        if (!s.up || s.boot !== p.boot) p.stayedUp = false;
        if (s.feeds_down.includes(d.feed)) p.sawDown = true;
        if (s.entries_halted) p.sawHalt = true;
        const back = t - p.since > d.dropMs && s.up && !s.feeds_down.includes(d.feed);
        if (back || t - p.since > d.dropMs + recoverMs) {
          const entriesDuring = p.critical ? entriesBetween(o.stateDir, p.since + sampleMs, p.since + d.dropMs) : 0;
          const notes: string[] = [];
          if (!p.sawDown) notes.push('worker never reported the feed down');
          if (p.critical && !p.sawHalt) notes.push('entries not halted while a critical feed was down');
          if (entriesDuring > 0) notes.push(`${entriesDuring} entries while the feed was down`);
          if (!p.stayedUp) notes.push('worker went down during the drop');
          if (!back) notes.push('feed did not come back');
          record({ id: d.id, kind: 'feed', feed: d.feed, plannedAt: meta.startedAt + d.atMs, at: p.since, pass: notes.length === 0, recoveredMs: back ? t - p.since - d.dropMs : null, notes: notes.length ? notes : [p.critical ? 'down seen, entries halted, recovered' : 'down seen, worker stayed up, recovered'] });
          pending = null;
        }
      }
    }
    await sleep(Math.max(0, sampleMs - (Date.now() - t)));
  }

  return finish(null);

  /**
   * Last quota and lookup counters per boot (the live worker's and a tabletop worker's): they restart at 0 each boot,
   * so the run's totals sum the boots. A sample with a missing or invalid quota never overwrites the boot's last valid
   * counters; it marks the boot.
   */
  function noteBoot(h: Health): void {
    const prev = boots[h.boot] ?? { quota: [], lookups: { counts: [] }, problems: [] };
    const c = checkQuota(h.quota);
    const lk = lookupsOk(h.lookups);
    const problems = [...(prev.problems ?? []), ...(c.ok ? [] : c.problems), ...(lk ? [] : ['lookups.counts is not a list of non-negative integers'])];
    boots[h.boot] = {
      quota: c.ok ? c.quota : prev.quota,
      lookups: lk ? h.lookups : prev.lookups,
      problems: [...new Set(problems)].map((p) => (p.startsWith('boot ') ? p : `boot ${h.boot}: ${p}`)),
    };
    writeFileSync(P.boots, JSON.stringify(boots));
  }

  /**
   * The runner's own backup (local host-loss drills). A reply describes the worker a moment before the copy, and the
   * worker keeps trading while it runs, so the copy counts only when a second reply after it holds the same state:
   * a trade only moves forward (opened, exit planned, closed; a new trade has a new id), so equal before and after
   * means equal during the copy. Otherwise the previous backup stays and the next sample tries again.
   */
  async function takeBackup(h: Health, t: number): Promise<boolean> {
    if (!killReplyValid(h)) return false;
    const tmp = `${backupDir}.new`;
    snapshotState(o.stateDir, tmp);
    const after = await fetchHealth(o.healthAddr);
    if (after === null || after.boot !== h.boot || !killReplyValid(after) || keptKey(kept(after)) !== keptKey(kept(h))) {
      rmSync(tmp, { recursive: true, force: true });
      return false;
    }
    rmSync(backupDir, { recursive: true, force: true });
    renameSync(tmp, backupDir);
    backup = { at: t, expect: kept(h) };
    writeFileSync(P.backup, JSON.stringify(backup));
    return true;
  }

  /** Ends a tabletop drill: its worker's journal goes into the evidence folder first. */
  async function endTabletop(id: string, table: Tabletop): Promise<void> {
    const src = join(table.stateDir, STATE_FILES.journal);
    if (existsSync(src)) {
      mkdirSync(join(ev, 'tabletop'), { recursive: true });
      copyFileSync(src, join(ev, 'tabletop', `${id}-journal.jsonl`));
    }
    await o.control.endTabletop();
  }

  function record(d: DrillOutcome): void {
    // Any record of the drill on disk ends it, whether it was loaded at start or written in this segment.
    if (readJson<RestartPending | null>(P.reboot, null)?.drill.id === d.id) rmSync(P.reboot, { force: true });
    // A host-loss retry ends when its own try is recorded (a self-reported try has already written the next one).
    const r = readJson<HostLossRetry | null>(P.retry, null);
    if (r !== null && retryId(r) === d.id) rmSync(P.retry, { force: true });
    outcomes.push(d);
    done.add(d.id);
    saveDrills();
    log(`Drill ${d.id}: ${d.pass ? 'pass' : 'FAIL'} (${d.notes.join('; ')}).`);
  }

  async function finish(aborted: string | null, trusted = true): Promise<SegmentResult> {
    const m = readJson<RunMeta | null>(P.meta, null);
    const runDone = aborted === null && m !== null && Date.now() >= m.startedAt + m.targetMs;
    const seg = segments[segments.length - 1]!;
    // Last known trade state before the stop: the next job's handover drill reports whether it was mid-trade.
    const lastSample = readLines<Sample>(P.samples).at(-1);
    seg.lastInTrade = lastSample?.in_trade ?? false;
    seg.lastBoot = lastSample?.boot ?? null;
    await o.control.stop();
    seg.end = Date.now();
    writeFileSync(P.segments, JSON.stringify(segments, null, 2));
    if (aborted) {
      log(`Run aborted: ${aborted}`);
      writeFileSync(join(ev, 'ABORTED'), `${aborted}\n`);
    }
    if (!trusted) return { done: true, aborted, report: null };
    collectRecorded();
    let report: Report | null = null;
    if (m && (runDone || aborted)) {
      const journalPath = join(o.stateDir, STATE_FILES.journal);
      const jr = checkJournal(existsSync(journalPath) ? readFileSync(journalPath, 'utf8') : '', { allowTornTail: true });
      const samples = readLines<Sample>(P.samples);
      const i4 = item4(readLines<JournalLine>(journalPath), m.label, samples.some((s) => s.up && s.stub));
      const journal = readLines<JournalLine>(journalPath);
      const ops = {
        quota: quotaReport(Object.values(boots), seg.end - m.startedAt),
        lookups: lookupLatency(Object.values(boots)),
        coverage: coverageGaps(journal, seg.end),
        rejections: rejections(journal),
      };
      report = buildReport(m, samples, sampleMs, seg.end, jr, withChainMoves(outcomes, journal), manifest, i4, ops);
      if (aborted) report = { ...report, pass: false, checks: { ...report.checks, not_aborted: false } };
      writeFileSync(join(ev, 'report.json'), JSON.stringify(report, null, 2));
      writeFileSync(join(ev, 'REPORT.md'), reportMarkdown(report));
      if (existsSync(journalPath)) copyFileSync(journalPath, join(ev, 'journal.jsonl'));
    }
    return { done: runDone || aborted !== null, aborted, report };
  }

  function collectRecorded(): void {
    const dir = join(o.stateDir, STATE_FILES.recorder);
    if (!existsSync(dir)) return;
    // The real worker keeps one dataset folder per boot (DATA-1's layout: manifest.json and days/<day>/<table>-NNN files);
    // the stub writes flat files. Every file is listed by its path under recorder/.
    for (const name of recordedFiles(dir)) {
      const src = join(dir, name);
      const path = `recorder/${name}`;
      const data = readFileSync(src);
      const sha256 = createHash('sha256').update(data).digest('hex');
      if (o.keepRecorded === 'copy') {
        const out = join(o.recordedDir ?? join(ev, 'recorded'), name);
        mkdirSync(dirname(out), { recursive: true });
        copyFileSync(src, out);
        // Shipped with this job's recorded-data artifact; not carried forward in the state artifact.
        rmSync(src);
      }
      const entry = { path, bytes: data.length, sha256, kept: o.keepRecorded === 'copy' ? (o.recordedArtifact ?? 'artifact') : 'host' };
      const i = manifest.findIndex((f) => f.path === path);
      if (i >= 0) manifest[i] = entry;
      else manifest.push(entry);
    }
    if (o.keepRecorded === 'copy') removeEmptyDirs(dir);
    writeFileSync(P.manifest, JSON.stringify(manifest, null, 2));
  }
};

/** Every file under `dir`, as paths relative to it, sorted. */
export const recordedFiles = (dir: string): string[] => {
  const out: string[] = [];
  const walk = (rel: string): void => {
    for (const name of readdirSync(join(dir, rel)).sort()) {
      const r = rel === '' ? name : `${rel}/${name}`;
      const st = statSync(join(dir, r));
      if (st.isDirectory()) walk(r);
      else if (st.isFile()) out.push(r);
    }
  };
  walk('');
  return out;
};

/** Removes the folders under `dir` that are left empty (`dir` itself stays). */
const removeEmptyDirs = (dir: string): void => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (!statSync(p).isDirectory()) continue;
    removeEmptyDirs(p);
    if (readdirSync(p).length === 0) rmSync(p, { recursive: true });
  }
};

const readToken = (stateDir: string): string | null => {
  try {
    return readFileSync(join(stateDir, STATE_FILES.drillToken), 'utf8').trim();
  } catch {
    return null;
  }
};

const journalLines = (stateDir: string): JournalLine[] => readLines<JournalLine>(join(stateDir, STATE_FILES.journal));

/** The boot journaled a successful reconcile, and no entry came before it. */
export const reconciledFirst = (stateDir: string, boot: string): boolean => {
  for (const l of journalLines(stateDir)) {
    if (l.boot !== boot) continue;
    if (l.kind === 'reconcile' && l.ok === true) return true;
    if (l.kind === 'entry') return false;
  }
  return false;
};

const entriesBetween = (stateDir: string, from: number, to: number): number =>
  journalLines(stateDir).filter((l) => l.kind === 'entry' && Date.parse(l.ts) >= from && Date.parse(l.ts) <= to).length;

/** The host's start decision (cli vps-tick). Pure. `start` is the run name to start, or null. */
export const tickAction = (o: {
  readonly request: unknown;
  readonly started: readonly string[];
  readonly unfinished: string | null;
  readonly active: readonly string[];
}): { readonly start: string | null; readonly mark: boolean; readonly why: string } => {
  if (o.active.length) return { start: null, mark: false, why: `dry run ${o.active.join(', ')} already running` };
  if (o.unfinished !== null) return { start: o.unfinished, mark: false, why: `resuming run ${o.unfinished}` };
  if (typeof o.request !== 'string' || !RUN_NAME.test(o.request)) return { start: null, mark: false, why: 'no run requested' };
  if (o.started.includes(o.request)) return { start: null, mark: false, why: `run ${o.request} already started once` };
  return { start: o.request, mark: true, why: `starting run ${o.request}` };
};

/** A non-negative decimal string as an integer and its scale; null otherwise. */
const decimal = (x: string | null): { n: bigint; d: number } | null => {
  const m = x === null ? null : /^(\d+)(?:\.(\d+))?$/.exec(x);
  return m ? { n: BigInt(m[1]! + (m[2] ?? '')), d: (m[2] ?? '').length } : null;
};

/** |after − before| / before in basis points, rounded up, in exact decimal arithmetic; null when a mark is missing or before is 0. */
export const moveBps = (before: string | null, after: string | null): number | null => {
  const b = decimal(before);
  const a = decimal(after);
  if (!b || !a || b.n === 0n) return null;
  const d = Math.max(a.d, b.d);
  const bn = b.n * 10n ** BigInt(d - b.d);
  const an = a.n * 10n ** BigInt(d - a.d);
  const diff = an > bn ? an - bn : bn - an;
  return Number((diff * 10_000n + bn - 1n) / bn);
};

const lookupsOk = (x: unknown): x is { counts: number[] } => {
  const c = (x as { counts?: unknown } | null)?.counts;
  return Array.isArray(c) && c.length === LOOKUP_BOUNDS_MS.length + 1 && c.every((n) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0);
};

/** The trade ids exposed when the worker dies: the open position's and every unresolved intent's. */
export const exposedTrades = (h: Health): string[] =>
  [...new Set([...(h.open_position ? [h.open_position.trade] : []), ...(Array.isArray(h.unresolved_intents.trades) ? h.unresolved_intents.trades : [])])].filter(
    (t) => typeof t === 'string' && t !== '',
  );

/** Every exposed trade has an id: the open position's, and one per unresolved intent. */
export const tradeIdsComplete = (h: Health): boolean => {
  const id = (t: unknown): boolean => typeof t === 'string' && t !== '';
  const u = h.unresolved_intents;
  return (h.open_position === null || id(h.open_position.trade)) && Array.isArray(u.trades) && u.trades.length === u.count && u.trades.every(id);
};

/** The open position's mark when it is fresh (seen at most MARK_MAX_AGE_MS before the reply); otherwise unmeasured. */
export const freshMark = (h: Health): string | null => {
  const p = h.open_position;
  if (!p || typeof p.mark !== 'string' || typeof p.mark_ts !== 'number' || typeof h.ts !== 'number') return null;
  const age = h.ts - p.mark_ts;
  return age >= 0 && age <= MARK_MAX_AGE_MS ? p.mark : null;
};

/**
 * The marks only see the two ends of the down window. The worker rebuilds the path inside it from chain history and
 * journals one `exposure` line per exposed trade; the worse of the moves is reported, and the trades found are kept
 * so a missing rebuild fails the run (for the real worker).
 */
export const withChainMoves = (outcomes: readonly DrillOutcome[], journal: readonly JournalLine[]): DrillOutcome[] =>
  outcomes.map((d) => {
    const e = d.exposure;
    if (!e || e.duration_ms === null) return d;
    const lines = journal.filter((l) => {
      const from = Date.parse(String(l['from_ts']));
      return (
        l.kind === 'exposure' && typeof l.trade === 'string' && e.trades.includes(l.trade) &&
        typeof l['worst_move_bps'] === 'number' && Number.isSafeInteger(l['worst_move_bps']) && (l['worst_move_bps'] as number) >= 0 &&
        from >= d.at - 60_000 && from <= d.at + e.duration_ms! + 60_000
      );
    });
    const chain = lines.reduce<number | null>((m, l) => Math.max(m ?? 0, l['worst_move_bps'] as number), null);
    const chain_trades = [...new Set(lines.map((l) => l.trade as string))].sort();
    const worse = chain !== null && (e.worst_move_bps === null || chain > e.worst_move_bps);
    return { ...d, exposure: { ...e, chain_trades, ...(worse ? { worst_move_bps: chain, move_source: 'chain' as const } : {}) } };
  });

/** P0 and P1 requests shed so far in this boot (exits and position monitoring). */
export const exitShed = (h: Health): number | null =>
  Array.isArray(h.quota) ? h.quota.reduce((n, q) => n + (Array.isArray(q.shed) ? (q.shed[0] ?? 0) + (q.shed[1] ?? 0) : 0), 0) : null;

export const offsiteNote = (on: boolean | undefined): string =>
  on === true
    ? 'off-site backup is on'
    : 'off-site backup is off: a real host loss would lose the local snapshots too, and recovery would rebuild from chain (wallet balances, pending signatures by address) with a fresh seed';

/**
 * Compares the new boot's `recovered` line with what it had to recover: the state at the kill (crash, reboot), the
 * backup's (host loss), or nothing (chain rebuild, which must say it rebuilt from chain). Every restored position
 * must keep its universe (CFG-2), so its exit parameters still apply.
 */
export const recoveredState = (journal: readonly JournalLine[], boot: string, cause: RestartCause, expect: Kept | null, atKill: Kept): RecoveredState => {
  const line = journal.find((l) => l.boot === boot && l.kind === 'recovered');
  const strings = (x: unknown): string[] => (Array.isArray(x) ? x.filter((v): v is string => typeof v === 'string' && v !== '') : []);
  if (!line) {
    return { source: null, expected_pending_exits: expect?.pending_exits ?? [], recovered_pending_exits: [], missing: [], lost: [], state_ok: false, universe_ok: false, notes: ['no recovered line after the restart'] };
  }
  const recoveredExits = strings(line['pending_exits']);
  const positions = (Array.isArray(line['positions']) ? line['positions'] : []) as { trade?: unknown; universe?: unknown }[];
  const recoveredPos = new Map(positions.flatMap((x) => (typeof x?.trade === 'string' ? [[x.trade, x.universe] as const] : [])));
  const source = typeof line['source'] === 'string' ? line['source'] : null;
  const notes: string[] = [];
  const universesNamed = [...recoveredPos.values()].every(knownUniverse);
  if (!universesNamed) notes.push('a restored position has no known universe');
  if (expect === null) {
    const lost = atKill.positions.map((x) => x.trade).filter((t) => !recoveredPos.has(t));
    if (source !== 'chain') notes.push(`chain rebuild reported source ${String(source)}`);
    if (lost.length) notes.push(`${lost.length} paper position(s) lost: paper positions are not on chain`);
    return { source, expected_pending_exits: [], recovered_pending_exits: recoveredExits, missing: [], lost, state_ok: source === 'chain', universe_ok: universesNamed, notes };
  }
  const missing = [
    ...expect.pending_exits.filter((x) => !recoveredExits.includes(x)).map((x) => `exit ${x}`),
    ...expect.positions.filter((x) => !recoveredPos.has(x.trade)).map((x) => `position ${x.trade}`),
  ];
  const changed = expect.positions.filter((x) => recoveredPos.has(x.trade) && recoveredPos.get(x.trade) !== x.universe);
  if (missing.length) notes.push(`not recovered: ${missing.join(', ')}`);
  if (changed.length) notes.push(`universe changed for ${changed.map((x) => x.trade).join(', ')}`);
  if (cause === 'host-loss') notes.push('restored from the latest backup');
  return { source, expected_pending_exits: expect.pending_exits, recovered_pending_exits: recoveredExits, missing, lost: [], state_ok: missing.length === 0, universe_ok: universesNamed && changed.length === 0, notes };
};

interface HostLossRetry {
  /** The planned drill's id. */
  readonly drill: string;
  readonly attempt: number;
  readonly dueAt: number;
}

const retryId = (r: HostLossRetry): string => `${r.drill}-retry-${r.attempt}`;

/** Retries of a self-reported host-loss tabletop, at most; each starts the tabletop worker once. */
export const HOST_LOSS_RETRIES = 3;
/** The hourly host backup plus 2 min, so the next backup has finished and its window has samples on both sides. */
export const HOST_RETRY_AFTER_MS = 3_600_000 + 120_000;

/** How long before its file's time a host backup may have read the database (sqlite .backup, its check, packing). */
export const BACKUP_WINDOW_MS = 120_000;

const keptKey = (k: Kept): string =>
  JSON.stringify({ e: [...k.pending_exits].sort(), p: [...k.positions].map((x) => `${x.trade}\u0000${x.universe}`).sort() });

/**
 * What the live worker held when a host backup was taken at `at` (its file's time): the samples must cover
 * [at − BACKUP_WINDOW_MS, at] without a gap, every reply valid, and the state unchanged across it. Otherwise the
 * restore cannot be compared, and why.
 */
export const keptAt = (samples: readonly Sample[], at: number, sampleMs: number, windowMs = BACKUP_WINDOW_MS): { kept: Kept } | { why: string } => {
  const from = at - windowMs;
  const win = samples.filter((s) => s.t >= from - 2 * sampleMs && s.t <= at + 2 * sampleMs);
  if (!win.length || win[0]!.t > from || win.at(-1)!.t < at) return { why: 'no samples around the backup' };
  for (let i = 1; i < win.length; i++) if (win[i]!.t - win[i - 1]!.t > 2 * sampleMs) return { why: 'a gap in the samples around the backup' };
  if (win.some((s) => !s.kept)) return { why: 'a missing or invalid reply around the backup' };
  const keys = new Set(win.map((s) => keptKey(s.kept!)));
  return keys.size === 1 ? { kept: win[0]!.kept! } : { why: 'the state changed while the backup was taken' };
};

/** Trades whose exit the boot journaled after the given seq (after the reply, before the kill), sorted. */
export const closedSince = (journal: readonly JournalLine[], boot: string | null, seq: number | null): string[] =>
  boot === null || seq === null
    ? []
    : [...new Set(journal.filter((l) => l.boot === boot && l.seq > seq && l.kind === 'exit' && typeof l.trade === 'string').map((l) => l.trade!))].sort();

const withoutTrades = (k: Kept, gone: readonly string[]): Kept => ({
  pending_exits: k.pending_exits.filter((x) => !gone.includes(x)),
  positions: k.positions.filter((x) => !gone.includes(x.trade)),
});

/** A CFG-2 universe with its own exit parameters (U1, U2). 'unknown', or anything else, counts as missing. */
export const knownUniverse = (u: unknown): boolean => typeof u === 'string' && (EXIT_UNIVERSES as readonly string[]).includes(u);

/** The reply at a kill can be trusted: pending exits are ids, and an open position names a known universe. */
export const killReplyValid = (h: Health | null): boolean =>
  h !== null &&
  Array.isArray(h.pending_exits) &&
  h.pending_exits.every((x) => typeof x === 'string' && x !== '') &&
  (h.open_position === null || knownUniverse(h.open_position.universe));

/** Across a host reboot: reconciled and exit capable from the new boot's own journal lines, ms after the kill. */
export const journalTimes = (journal: readonly JournalLine[], boot: string, killedAt: number): { reconciled_ms: number; exit_capable_ms: number } | null => {
  const at = (kind: string, ok?: boolean): number | null => {
    const l = journal.find((x) => x.boot === boot && x.kind === kind && (ok === undefined || x.ok === ok));
    const v = l ? Date.parse(l.ts) : Number.NaN;
    return Number.isNaN(v) ? null : v;
  };
  const r = at('reconcile', true);
  const e = at('exit_capable');
  return r === null || e === null ? null : { reconciled_ms: r - killedAt, exit_capable_ms: e - killedAt };
};
