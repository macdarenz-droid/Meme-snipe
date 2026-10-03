// The dry-run runner: samples the worker's health, runs the pre-set drills, and writes the evidence folder.
// One call runs one segment: the whole run on the VPS, or one ~5 h 50 min GitHub Actions job in the fallback,
// which resumes from the evidence folder and worker state the previous job saved.
import { createHash } from 'node:crypto';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkStartHealth, STATE_FILES, type Health, type JournalLine } from './contract.ts';
import type { WorkerControl } from './control.ts';
import { checkJournal } from './journal.ts';
import { makePlan, type Drill } from './plan.ts';
import { buildReport, reportMarkdown, type DrillOutcome, type Label, type RecordedFile, type Report, type RunMeta, type Sample } from './report.ts';

export interface SegmentOptions {
  readonly control: WorkerControl;
  readonly healthAddr: string;
  readonly stateDir: string;
  /** The run's evidence folder: evidence/dryrun/<runId>. */
  readonly evidenceDir: string;
  /** New runs only. */
  readonly newRun?: { readonly runId: string; readonly label: Label; readonly commit: string; readonly targetMs: number; readonly entry: string; readonly restarts?: number; readonly restartWindowMs?: number; readonly feedDropMs?: number };
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
  up: h !== null,
  ready: h !== null && h.reconciled === true,
  boot: h?.boot ?? null,
  git_sha: h?.git_sha ?? null,
  rss_bytes: h?.rss_bytes ?? null,
  in_trade: h !== null && (h.open_position !== null || h.unresolved_intents.count > 0),
  entries_halted: h?.entries_halted ?? false,
  recorder: h?.recorder === 'on',
  simulation: h?.simulation === 'on',
  stub: h?.stub === true,
  feeds_down: h ? Object.entries(h.feeds).flatMap(([n, f]) => (f.connected ? [] : [n])) : [],
});

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
  | { kind: 'restart'; drill: Extract<Drill, { kind: 'restart' }>; since: number; killedAt?: number; prevBoot?: string | null; midTrade?: boolean }
  | { kind: 'feed'; drill: Extract<Drill, { kind: 'feed' }>; since: number; sawDown: boolean; sawHalt: boolean; critical: boolean; boot: string | null; stayedUp: boolean; requested: boolean }
  | { kind: 'handover'; since: number; prevBoot: string | null; midTrade: boolean; plannedAt: number };

export const runSegment = async (o: SegmentOptions): Promise<SegmentResult> => {
  const log = o.log ?? ((s: string) => console.log(s));
  const sampleMs = o.sampleMs ?? 10_000;
  const recoverMs = o.recoverMs ?? 120_000;
  const fetchHealth = o.fetchHealth ?? httpHealth;
  const dropFeed = o.dropFeed ?? httpDropFeed;
  const ev = o.evidenceDir;
  mkdirSync(ev, { recursive: true });
  const P = { meta: join(ev, 'run.json'), samples: join(ev, 'samples.jsonl'), drills: join(ev, 'drills.json'), segments: join(ev, 'segments.json'), manifest: join(ev, 'recorded.json') };
  const resumed = existsSync(P.meta);
  if (!resumed && !o.newRun) throw new Error(`no run in ${ev} and no new-run options`);

  const outcomes: DrillOutcome[] = readJson(P.drills, []);
  const segments: { start: number; end: number | null; lastInTrade: boolean; lastBoot: string | null }[] = readJson(P.segments, []);
  const manifest: RecordedFile[] = readJson(P.manifest, []);
  const prev = segments[segments.length - 1];
  const segStart = Date.now();
  segments.push({ start: segStart, end: null, lastInTrade: false, lastBoot: null });
  const saveDrills = (): void => writeFileSync(P.drills, JSON.stringify(outcomes, null, 2));

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
  } else {
    const n = o.newRun!;
    const plan = makePlan({
      durationMs: n.targetMs,
      feeds: Object.keys(first.feeds),
      ...(n.restarts === undefined ? {} : { restarts: n.restarts }),
      ...(n.restartWindowMs === undefined ? {} : { restartWindowMs: n.restartWindowMs }),
      ...(n.feedDropMs === undefined ? {} : { feedDropMs: n.feedDropMs }),
    });
    meta = { runId: n.runId, label: n.label, commit: n.commit, startedAt: segStart, targetMs: n.targetMs, entry: n.entry, plan };
    writeFileSync(P.meta, JSON.stringify(meta, null, 2));
    log(`Run ${meta.runId}: ${meta.label}, commit ${meta.commit}, ${plan.length} drills planned.`);
  }
  const runEnd = meta.startedAt + meta.targetMs;
  const endAt = Math.min(runEnd, o.segmentEnd);

  // A fallback job boundary is a restart drill too: the previous job stopped the worker, this one restored state.
  let pending: Pending | null =
    resumed && prev && o.handover !== false ? { kind: 'handover', since: segStart, prevBoot: prev.lastBoot, midTrade: prev.lastInTrade, plannedAt: prev.end ?? segStart } : null;
  const done = new Set(outcomes.map((d) => d.id));
  const handovers = outcomes.filter((d) => d.kind === 'handover').length;

  let last: Sample | null = null;
  while (Date.now() < endAt) {
    const t = Date.now();
    const h = await fetchHealth(o.healthAddr);
    const s = toSample(t, h);
    appendFileSync(P.samples, `${JSON.stringify(s)}\n`);
    last = s;
    const rel = t - meta.startedAt;

    if (pending === null) {
      const due = meta.plan.find((d) => !done.has(d.id) && d.atMs <= rel);
      if (due?.kind === 'restart') pending = { kind: 'restart', drill: due, since: t };
      else if (due?.kind === 'feed') pending = { kind: 'feed', drill: due, since: t, sawDown: false, sawHalt: false, critical: false, boot: s.boot, stayedUp: true, requested: false };
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
      if (p.killedAt === undefined) {
        if (s.in_trade || t - p.since >= p.drill.windowMs) {
          p.prevBoot = s.boot;
          p.midTrade = s.in_trade;
          p.killedAt = Date.now();
          await o.control.kill();
          log(`Drill ${p.drill.id}: killed${p.midTrade ? ' mid-trade' : ' (no trade open in the window)'}.`);
        }
      } else if (s.ready && s.boot !== p.prevBoot) {
        const ok = reconciledFirst(o.stateDir, s.boot!);
        record({ id: p.drill.id, kind: 'restart', plannedAt: meta.startedAt + p.drill.atMs, at: p.killedAt, pass: ok, midTrade: p.midTrade === true, recoveredMs: t - p.killedAt, notes: [ok ? 'reconciled before any entry' : 'no successful reconcile before entry'] });
        pending = null;
      } else if (t - p.killedAt > recoverMs) {
        record({ id: p.drill.id, kind: 'restart', plannedAt: meta.startedAt + p.drill.atMs, at: p.killedAt, pass: false, midTrade: p.midTrade === true, recoveredMs: null, notes: [`not ready ${recoverMs / 1000} s after the kill`] });
        pending = null;
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
        } else log(`Drill ${d.id}: dropped ${d.feed} for ${d.dropMs / 1000} s.`);
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

  function record(d: DrillOutcome): void {
    outcomes.push(d);
    done.add(d.id);
    saveDrills();
    log(`Drill ${d.id}: ${d.pass ? 'pass' : 'FAIL'} (${d.notes.join('; ')}).`);
  }

  async function finish(aborted: string | null): Promise<SegmentResult> {
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
    collectRecorded();
    let report: Report | null = null;
    if (m && (runDone || aborted)) {
      const journalPath = join(o.stateDir, STATE_FILES.journal);
      const jr = checkJournal(existsSync(journalPath) ? readFileSync(journalPath, 'utf8') : '', { allowTornTail: true });
      report = buildReport(m, readLines<Sample>(P.samples), sampleMs, seg.end, jr, outcomes, manifest);
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
    for (const name of readdirSync(dir).sort()) {
      const src = join(dir, name);
      if (!statSync(src).isFile()) continue;
      const path = `recorder/${name}`;
      const data = readFileSync(src);
      const sha256 = createHash('sha256').update(data).digest('hex');
      if (o.keepRecorded === 'copy') {
        const out = o.recordedDir ?? join(ev, 'recorded');
        mkdirSync(out, { recursive: true });
        copyFileSync(src, join(out, name));
        // Shipped with this job's recorded-data artifact; not carried forward in the state artifact.
        rmSync(src);
      }
      const entry = { path, bytes: data.length, sha256, kept: o.keepRecorded === 'copy' ? (o.recordedArtifact ?? 'artifact') : 'host' };
      const i = manifest.findIndex((f) => f.path === path);
      if (i >= 0) manifest[i] = entry;
      else manifest.push(entry);
    }
    writeFileSync(P.manifest, JSON.stringify(manifest, null, 2));
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

/** The host's start decision (cli vps-tick). Pure. */
export const tickAction = (o: { readonly request: unknown; readonly started: readonly string[]; readonly unfinished: boolean; readonly active: boolean }): { readonly start: boolean; readonly mark: string | null; readonly why: string } => {
  if (o.active) return { start: false, mark: null, why: 'dry run already running' };
  if (o.unfinished) return { start: true, mark: null, why: 'resuming the unfinished run' };
  if (typeof o.request !== 'string' || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(o.request)) return { start: false, mark: null, why: 'no run requested' };
  if (o.started.includes(o.request)) return { start: false, mark: null, why: `run ${o.request} already started once` };
  return { start: true, mark: o.request, why: `starting run ${o.request}` };
};
