// The dry-run runner: samples the worker's health, runs the pre-set drills, and writes the evidence folder.
// One call runs one segment: the whole run on the VPS, or one ~5 h 50 min GitHub Actions job in the fallback,
// which resumes from the evidence folder and worker state the previous job saved.
import { createHash } from 'node:crypto';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { checkStartHealth, LOOKUP_BOUNDS_MS, MARK_MAX_AGE_MS, RUN_NAME, STATE_FILES, type Health, type JournalLine } from './contract.ts';
import type { WorkerControl } from './control.ts';
import { item4 } from './item4.ts';
import { checkQuota, coverageGaps, lookupLatency, quotaReport, rejections, type BootTotals } from './quota.ts';
import { checkJournal } from './journal.ts';
import { makePlan, type Drill } from './plan.ts';
import { buildReport, reportMarkdown, type DrillOutcome, type Label, type RecordedFile, type Report, type RunMeta, type Sample } from './report.ts';

export interface SegmentOptions {
  readonly control: WorkerControl;
  readonly healthAddr: string;
  readonly stateDir: string;
  /** The run's evidence folder: evidence/dryrun/<runId>. */
  readonly evidenceDir: string;
  /** Who this runner is: computed from where it runs, never read from restored state. A resumed run must match. */
  readonly identity: { readonly label: Label; readonly commit: string };
  /** New runs only. `entry` is the worker entry (local) or `systemd:<unit>` (host). */
  readonly newRun?: { readonly runId: string; readonly name?: string; readonly targetMs: number; readonly entry: string; readonly restarts?: number; readonly restartWindowMs?: number; readonly feedDropMs?: number };
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
  | {
      kind: 'restart'; drill: Extract<Drill, { kind: 'restart' }>; since: number; killedAt?: number; prevBoot?: string | null; midTrade?: boolean;
      /** A position was open at the kill: measure the unprotected exposure until the new boot is exit capable. */
      open?: boolean; trades?: readonly string[]; tradesComplete?: boolean; markBefore?: string | null; reconciledAt?: number; ok?: boolean;
    }
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
  const P = { meta: join(ev, 'run.json'), samples: join(ev, 'samples.jsonl'), drills: join(ev, 'drills.json'), segments: join(ev, 'segments.json'), manifest: join(ev, 'recorded.json'), boots: join(ev, 'boots.json') };
  const resumed = existsSync(P.meta);
  if (!resumed && !o.newRun) throw new Error(`no run in ${ev} and no new-run options`);

  const outcomes: DrillOutcome[] = readJson(P.drills, []);
  const boots: Record<string, BootTotals> = readJson(P.boots, {});
  const segments: { start: number; end: number | null; lastInTrade: boolean; lastBoot: string | null }[] = readJson(P.segments, []);
  const manifest: RecordedFile[] = readJson(P.manifest, []);
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
      minFeedDropMs: 2 * sampleMs,
    });
    meta = { runId: n.runId, ...(n.name === undefined ? {} : { name: n.name }), label: o.identity.label, commit: o.identity.commit, startedAt: segStart, targetMs: n.targetMs, entry: n.entry, plan };
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
    if (h) {
      // Last quota and lookup counters per boot: they restart at 0 each boot, so the run's totals sum the boots.
      // A sample with a missing or invalid quota never overwrites the boot's last valid counters; it marks the boot.
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
      const base = { id: p.drill.id, kind: 'restart' as const, plannedAt: meta.startedAt + p.drill.atMs, midTrade: p.midTrade === true };
      if (p.killedAt === undefined) {
        if (s.in_trade || t - p.since >= p.drill.windowMs) {
          p.prevBoot = s.boot;
          p.midTrade = s.in_trade;
          // An entry in flight (an intent, no position yet) is exposed too.
          p.open = h !== null && (h.open_position != null || h.unresolved_intents.count > 0);
          p.trades = h ? exposedTrades(h) : [];
          p.tradesComplete = h !== null && tradeIdsComplete(h);
          p.markBefore = h ? freshMark(h) : null;
          p.killedAt = Date.now();
          await o.control.kill();
          log(`Drill ${p.drill.id}: killed${p.midTrade ? ' mid-trade' : ' (no trade open in the window)'}.`);
        }
      } else if (p.reconciledAt === undefined && s.ready && s.boot !== p.prevBoot) {
        p.reconciledAt = t;
        p.ok = reconciledFirst(o.stateDir, s.boot!);
      }
      if (p.killedAt !== undefined && p.reconciledAt !== undefined && (!p.open || (s.exit_capable && s.boot !== p.prevBoot))) {
        const k = p.killedAt;
        const notes = [p.ok ? 'reconciled before any entry' : 'no successful reconcile before entry'];
        const exposure = p.open
          ? { duration_ms: t - k, reconciled_ms: p.reconciledAt - k, trades: p.trades ?? [], trades_complete: p.tradesComplete === true, chain_trades: [], mark_before: p.markBefore ?? null, mark_after: h ? freshMark(h) : null, worst_move_bps: moveBps(p.markBefore ?? null, h ? freshMark(h) : null), move_source: 'marks' as const }
          : undefined;
        if (exposure) notes.push(`exit capable ${(exposure.duration_ms / 1000).toFixed(1)} s after the kill`);
        record({ ...base, at: k, pass: p.ok === true, recoveredMs: p.reconciledAt - k, ...(exposure ? { exposure } : {}), notes });
        pending = null;
      } else if (p.killedAt !== undefined && t - p.killedAt > recoverMs) {
        const stage = p.reconciledAt === undefined ? 'not ready' : 'not exit capable';
        record({ ...base, at: p.killedAt, pass: false, recoveredMs: p.reconciledAt === undefined ? null : p.reconciledAt - p.killedAt, ...(p.open ? { exposure: { duration_ms: null, reconciled_ms: p.reconciledAt === undefined ? null : p.reconciledAt - p.killedAt, trades: p.trades ?? [], trades_complete: p.tradesComplete === true, chain_trades: [], mark_before: p.markBefore ?? null, mark_after: null, worst_move_bps: null, move_source: 'marks' as const } } : {}), notes: [`${stage} ${recoverMs / 1000} s after the kill`] });
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
