// The dry-run report: uptime, memory, journal, drills, recorded data. Pure; the runner feeds it.
import { RESTART_CAUSES, type RestartCause } from './contract.ts';
import type { Item4 } from './item4.ts';
import type { JournalReport } from './journal.ts';
import { entryRule, type CoverageReport, type EntryRule, type LookupLatency, type QuotaReport, type Rejections } from './quota.ts';
import type { Drill } from './plan.ts';

export type Label = 'rehearsal' | 'vps';

export interface Sample {
  /** Wall time, ms since epoch. */
  readonly t: number;
  /** The health endpoint answered. */
  readonly up: boolean;
  /** Answered and reconciled: the worker is doing its job. */
  readonly ready: boolean;
  readonly boot: string | null;
  readonly git_sha: string | null;
  readonly rss_bytes: number | null;
  readonly in_trade: boolean;
  readonly entries_halted: boolean;
  readonly recorder: boolean;
  readonly simulation: boolean;
  readonly stub: boolean;
  /** Feed names the worker reported, sorted and comma-joined; fixed for the whole run. */
  readonly feeds: string | null;
  readonly feeds_down: readonly string[];
  readonly exit_capable?: boolean;
  /** Mark of the open position, decimal string. */
  readonly mark?: string | null;
}

/** Unprotected exposure of a restart drill with an open position: the watchdog can alert but cannot sell. */
export interface Exposure {
  /** `unknown`: no health reply at the window's end, so nothing can be said; it fails like an unmeasured one. */
  readonly status?: 'measured' | 'unmeasured' | 'unknown';
  /** Kill → the new boot is exit capable; null when it never got there within the recovery limit. */
  readonly duration_ms: number | null;
  readonly reconciled_ms: number | null;
  /** Trades open or in flight at the kill, and those the worker's chain rebuild (`exposure` lines) covered. */
  readonly trades: readonly string[];
  /** The health reply named every exposed trade (position trade set; one id per unresolved intent). */
  readonly trades_complete: boolean;
  readonly chain_trades: readonly string[];
  readonly mark_before: string | null;
  readonly mark_after: string | null;
  /** Worst price move over the window, basis points: from the two marks, or the worker's chain rebuild if worse. */
  readonly worst_move_bps: number | null;
  readonly move_source: 'marks' | 'chain';
}

export interface RecoveredState {
  readonly source: string | null;
  readonly expected_pending_exits: readonly string[];
  readonly recovered_pending_exits: readonly string[];
  /** Expected but not recovered: pending exits and positions a restart lost. */
  readonly missing: readonly string[];
  /** Chain rebuild: positions open at the kill that the chain could not give back (paper positions are not on chain). */
  readonly lost: readonly string[];
  readonly state_ok: boolean;
  readonly universe_ok: boolean;
  readonly notes: readonly string[];
}

export interface DrillOutcome {
  readonly id: string;
  readonly kind: 'restart' | 'feed' | 'handover' | 'rpc';
  readonly cause?: RestartCause;
  /** Recovery as "reconciled and able to exit", ms after the kill (rpc: after the providers came back). */
  readonly recovery?: { readonly reconciled_ms: number | null; readonly exit_capable_ms: number | null; readonly clock: 'monotonic' | 'wall' };
  readonly state?: RecoveredState;
  /** Qualifying host: host loss or chain rebuild ran as a tabletop worker beside the run, not in it. */
  readonly off_run?: boolean;
  /** Not run here; never counts as passed. */
  readonly skipped?: boolean;
  /** What the restart had to keep (positions, in-flight entries, pending exits; the backup's for host loss). 0: proved nothing. */
  readonly keep?: number;
  readonly plannedAt: number | null;
  readonly at: number;
  readonly pass: boolean;
  readonly midTrade?: boolean;
  readonly recoveredMs?: number | null;
  readonly exposure?: Exposure;
  readonly feed?: string;
  readonly notes: readonly string[];
}

export interface RecordedFile {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  /** Where the file is kept (an artifact name, or `host`). */
  readonly kept: string;
}

export interface RunMeta {
  readonly runId: string;
  /** Host runs: the requested name (packages/runner/qualifying-run.json). */
  readonly name?: string;
  /** The registered strategy id the worker must run (`none` until BT-2 registers one). */
  readonly strategy?: string;
  readonly label: Label;
  readonly commit: string;
  readonly startedAt: number;
  readonly targetMs: number;
  readonly entry: string;
  readonly plan: readonly Drill[];
}

export interface Report {
  readonly runId: string;
  readonly label: Label;
  readonly counts: string;
  /** The qualifying guard on a named host run's start lines; null for a run without a name. */
  readonly qualifying: EntryRule | null;
  readonly commit: string;
  readonly commits_seen: readonly string[];
  readonly started: string;
  readonly ended: string;
  readonly duration_h: number;
  readonly target_h: number;
  readonly uptime: number;
  readonly memory: { readonly max_mb: number | null; readonly p50_mb: number | null; readonly p95_mb: number | null; readonly limit_mb: number };
  readonly recorder_on_from_start: boolean;
  readonly simulation_on_from_start: boolean;
  readonly stub: boolean;
  readonly journal: JournalReport;
  readonly drills: readonly DrillOutcome[];
  readonly recovery_by_cause: Readonly<Record<string, CauseSummary>>;
  readonly drills_summary: {
    readonly restarts_mid_trade_passed: number;
    readonly feeds_planned: readonly string[];
    readonly feeds_passed: readonly string[];
    readonly handovers: number;
  };
  readonly recorded: { readonly files: number; readonly bytes: number };
  readonly checks: Readonly<Record<string, boolean>>;
  /** §15 item 3 (this report's checks). */
  readonly pass: boolean;
  /** §15 item 4, judged separately from the same run. */
  readonly item4: Item4;
  readonly ops: Ops;
  readonly exposure: { readonly drills: number; readonly worst_duration_ms: number | null; readonly worst_move_bps: number | null };
}

export interface CauseSummary {
  readonly planned: number;
  readonly drills: number;
  readonly passed: number;
  /** Passed drills that had something to keep: only these show the cause was exercised. */
  readonly exercised: number;
  readonly mid_trade: number;
  readonly off_run: number;
  readonly skipped: number;
  readonly exit_capable_ms: { readonly median: number | null; readonly worst: number | null };
  readonly exposure: { readonly drills: number; readonly worst_duration_ms: number | null; readonly worst_move_bps: number | null };
}

export interface Ops {
  readonly quota: QuotaReport;
  readonly lookups: LookupLatency;
  readonly coverage: CoverageReport;
  readonly rejections: Rejections;
}

/** systemd MemoryMax of the worker unit (OPS-1a). */
export const MEMORY_LIMIT_MB = 800;
const MB = 1024 * 1024;

/**
 * Uptime: each ready sample credits the time to the next sample, capped at 2 sample intervals, so a gap with no
 * samples (a crash of the runner, a GitHub job handover) counts as down. Denominator is wall time start → end.
 */
export const uptime = (samples: readonly Sample[], sampleMs: number, start: number, end: number): number => {
  if (end <= start) return 0;
  let credited = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]!;
    if (!s.ready) continue;
    const next = samples[i + 1]?.t ?? end;
    const from = Math.max(s.t, start);
    const to = Math.min(next, end, s.t + 2 * sampleMs);
    if (to > from) credited += to - from;
  }
  return Math.min(1, credited / (end - start));
};

const pct = (sorted: readonly number[], p: number): number | null =>
  sorted.length === 0 ? null : sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;

export const buildReport = (
  meta: RunMeta,
  samples: readonly Sample[],
  sampleMs: number,
  endedAt: number,
  journal: JournalReport,
  drills: readonly DrillOutcome[],
  recorded: readonly RecordedFile[],
  item4: Item4,
  ops: Ops,
  /** The registered strategies (contract.ts REGISTERED_STRATEGIES); tests pass their own. */
  registered?: readonly string[],
): Report => {
  const guard = meta.name === undefined ? null : entryRule(journal.starts, meta.strategy ?? 'none', registered);
  const up = uptime(samples, sampleMs, meta.startedAt, endedAt);
  const rss = samples.flatMap((s) => (s.rss_bytes === null ? [] : [s.rss_bytes / MB])).sort((a, b) => a - b);
  const commits = [...new Set(samples.flatMap((s) => (s.git_sha === null ? [] : [s.git_sha])))];
  const firstUp = samples.find((s) => s.up);
  const upSamples = samples.filter((s) => s.up);
  const stub = upSamples.some((s) => s.stub);
  // The accept's "kill mid-trade at least 3 times" counts process crashes; the other causes are counted per cause.
  const restartsMidTrade = drills.filter((d) => d.kind === 'restart' && (d.cause ?? 'crash') === 'crash' && d.pass && d.midTrade === true).length;
  const restarts = drills.filter((d) => d.kind === 'restart');
  const byCause = recoveryByCause(meta, drills);
  const feedsPlanned = meta.plan.flatMap((d) => (d.kind === 'feed' ? [d.feed] : []));
  const feedsPassed = [...new Set(drills.flatMap((d) => (d.kind === 'feed' && d.pass && d.feed !== undefined ? [d.feed] : [])))].sort();
  const durationMs = endedAt - meta.startedAt;
  const maxMb = rss.length ? rss[rss.length - 1]! : null;
  const checks: Record<string, boolean> = {
    duration: durationMs >= meta.targetMs,
    uptime: up >= 0.99,
    memory: maxMb !== null && maxMb < MEMORY_LIMIT_MB * 0.875,
    recorder_and_simulation_from_start: firstUp !== undefined && upSamples.every((s) => s.recorder && s.simulation),
    journal_complete: journal.complete,
    restart_drills: restartsMidTrade >= 3,
    feed_drills: feedsPlanned.length > 0 && feedsPlanned.every((f) => feedsPassed.includes(f)),
    every_drill_passed: drills.every((d) => d.pass),
    one_commit: commits.length === 1 && commits[0] === meta.commit,
    feeds_fixed: upSamples.every((s) => s.feeds === feedsPlanned.slice().sort().join(',')),
    real_worker: !stub,
    // RUN-1c: the free plans must last the month, and exits and position monitoring (P0, P1) are never shed.
    quota_reported: ops.quota.reported,
    quota_within_free_tier: ops.quota.within_free_tier,
    exit_capacity_never_shed: ops.quota.reported && ops.quota.exit_capacity_shed === 0,
    // Every exposed drill reaches exit capable with a measured move; the real worker also rebuilds every exposed trade from chain.
    exposure_measured: drills.every(
      (d) =>
        d.exposure === undefined ||
        (d.exposure.status !== 'unknown' &&
          d.exposure.duration_ms !== null &&
          d.exposure.worst_move_bps !== null &&
          // Exposed with no trade ids, or fewer ids than intents, cannot be checked: it fails, never passes vacuously.
          d.exposure.trades.length > 0 &&
          d.exposure.trades_complete &&
          // A chain rebuild cannot rebuild a paper position's path: those trades are reported lost instead (state.lost).
          (stub || d.cause === 'chain-rebuild' || d.exposure.trades.every((t) => d.exposure!.chain_trades.includes(t)))),
    ),
    coverage_valid: ops.coverage.problems.length === 0,
    // A rehearsal is never judged here. Any other run passes only as a named host run whose start lines pass the
    // guard: a start line, every boot on the run's registered --strategy with no paper edge and qualifying true, and
    // neither the rule nor the salt changed between boots. A 'vps' run without a name can never pass.
    qualifying_start: meta.label === 'rehearsal' || guard?.ok === true,
    // RUN-1d: every planned cause drilled and passed (a crash, a reboot, a host loss, a chain rebuild, RPC loss).
    // A restart cause counts only when a passed drill of it had something to keep; a skipped drill never counts.
    drills_by_cause: [...RESTART_CAUSES, 'rpc'].every((c) => byCause[c]!.planned > 0 && (c === 'rpc' ? byCause[c]!.passed > 0 : byCause[c]!.exercised > 0)),
    // Nothing a restart had to keep was lost, and every restored position kept its universe (CFG-2).
    recovered_state: restarts.every((d) => d.skipped === true || d.state?.state_ok === true),
    restored_universe_kept: restarts.every((d) => d.skipped === true || d.state?.universe_ok === true),
  };
  const exposed = drills.flatMap((d) => (d.exposure ? [d.exposure] : []));
  const maxOf = (xs: readonly (number | null)[]): number | null => xs.reduce<number | null>((m, x) => (x === null ? m : Math.max(m ?? x, x)), null);
  return {
    runId: meta.runId,
    label: meta.label,
    // The fallback never counts (ARCHITECTURE.md §15): it is labelled so in the report itself.
    counts:
      guard !== null && !guard.ok
        ? `NOT qualifying: ${guard.problems.join('; ')}.`
        : meta.label === 'rehearsal'
        ? 'Rehearsal: counts for none of §15 items 3, 4 or G3. The gaps between GitHub jobs count as down time, so a 48 h rehearsal fails the 99% uptime check by design.'
        : 'VPS run: candidate for §15 item 3 and the drills of item 5 only if every check passes; items 4 and G3 are judged from the same run by TEST-2 and STATS-1.',
    qualifying: guard,
    commit: meta.commit,
    commits_seen: commits,
    started: new Date(meta.startedAt).toISOString(),
    ended: new Date(endedAt).toISOString(),
    duration_h: round(durationMs / 3_600_000, 3),
    target_h: round(meta.targetMs / 3_600_000, 3),
    uptime: round(up, 5),
    memory: { max_mb: r1(maxMb), p50_mb: r1(pct(rss, 0.5)), p95_mb: r1(pct(rss, 0.95)), limit_mb: MEMORY_LIMIT_MB },
    recorder_on_from_start: firstUp?.recorder === true,
    simulation_on_from_start: firstUp?.simulation === true,
    stub,
    journal,
    drills,
    recovery_by_cause: byCause,
    drills_summary: {
      restarts_mid_trade_passed: restartsMidTrade,
      feeds_planned: feedsPlanned,
      feeds_passed: feedsPassed,
      handovers: drills.filter((d) => d.kind === 'handover').length,
    },
    recorded: { files: recorded.length, bytes: recorded.reduce((a, f) => a + f.bytes, 0) },
    checks,
    pass: Object.values(checks).every(Boolean),
    item4,
    ops,
    exposure: { drills: exposed.length, worst_duration_ms: maxOf(exposed.map((e) => e.duration_ms)), worst_move_bps: maxOf(exposed.map((e) => e.worst_move_bps)) },
  };
};

const median = (xs: readonly number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2);
};

/** Per restart cause and for RPC loss: how often it was drilled, and how long it took to be able to exit again. */
export const recoveryByCause = (meta: RunMeta, drills: readonly DrillOutcome[]): Record<string, CauseSummary> => {
  const out: Record<string, CauseSummary> = {};
  for (const c of [...RESTART_CAUSES, 'rpc'] as const) {
    const planned = meta.plan.filter((d) => (c === 'rpc' ? d.kind === 'rpc' : d.kind === 'restart' && (d.cause ?? 'crash') === c)).length;
    const ds = drills.filter((d) => (c === 'rpc' ? d.kind === 'rpc' : d.kind === 'restart' && (d.cause ?? 'crash') === c));
    const exits = ds.flatMap((d) => (d.recovery?.exit_capable_ms != null ? [Math.round(d.recovery.exit_capable_ms)] : []));
    const ex = ds.flatMap((d) => (d.exposure ? [d.exposure] : []));
    const worst = (xs: (number | null)[]): number | null => xs.reduce<number | null>((m, x) => (x === null ? m : Math.max(m ?? x, x)), null);
    out[c] = {
      planned,
      drills: ds.length,
      passed: ds.filter((d) => d.pass && d.skipped !== true).length,
      exercised: ds.filter((d) => d.pass && d.skipped !== true && (d.keep ?? 0) > 0).length,
      mid_trade: ds.filter((d) => d.midTrade === true).length,
      off_run: ds.filter((d) => d.off_run === true).length,
      skipped: ds.filter((d) => d.skipped === true).length,
      exit_capable_ms: { median: median(exits), worst: exits.length ? Math.max(...exits) : null },
      exposure: { drills: ex.length, worst_duration_ms: worst(ex.map((e) => e.duration_ms)), worst_move_bps: worst(ex.map((e) => e.worst_move_bps)) },
    };
  }
  return out;
};

const round = (x: number, d: number): number => Math.round(x * 10 ** d) / 10 ** d;
const r1 = (x: number | null): number | null => (x === null ? null : round(x, 1));

export const reportMarkdown = (r: Report): string => {
  const yes = (b: boolean): string => (b ? 'pass' : 'FAIL');
  const lines = [
    `# Dry run ${r.runId}`,
    '',
    `**${r.label === 'rehearsal' ? 'Rehearsal' : 'VPS run'}.** ${r.counts}`,
    '',
    `| Item | Value |`,
    `| --- | --- |`,
    `| Commit | \`${r.commit}\` |`,
    `| Window (UTC) | ${r.started} → ${r.ended} |`,
    `| Duration | ${r.duration_h} h of ${r.target_h} h |`,
    `| Uptime | ${(r.uptime * 100).toFixed(3)}% |`,
    `| Memory | max ${r.memory.max_mb ?? '-'} MB, p50 ${r.memory.p50_mb ?? '-'} MB, p95 ${r.memory.p95_mb ?? '-'} MB (limit ${r.memory.limit_mb} MB) |`,
    `| Journal | ${r.journal.lines} lines, ${r.journal.boots} boots, ${r.journal.entries} entries, ${r.journal.exits} exits, ${r.journal.simulations} simulations, ${r.journal.repairs} torn-tail repairs |`,
    `| Recorded data | ${r.recorded.files} files, ${r.recorded.bytes} bytes |`,
    `| Worker | ${r.stub ? 'stub (contract test only)' : 'real'} |`,
    '',
    '## Checks',
    '',
    ...Object.entries(r.checks).map(([k, v]) => `- ${k}: ${yes(v)}`),
    '',
    `Overall: **${r.pass ? 'pass' : 'not passed'}**`,
    '',
    '## Drills',
    '',
    '| Drill | Kind | Time (UTC) | Mid-trade | Recovery | Result | Notes |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...r.drills.map(
      (d) =>
        `| ${d.id} | ${d.kind}${d.feed ? ` (${d.feed})` : ''} | ${new Date(d.at).toISOString()} | ${d.midTrade === undefined ? '-' : d.midTrade ? 'yes' : 'no'} | ${
          d.recoveredMs === undefined || d.recoveredMs === null ? '-' : `${(d.recoveredMs / 1000).toFixed(1)} s`
        } | ${yes(d.pass)} | ${d.notes.join('; ').replace(/\|/g, '/')} |`,
    ),
  ];
  const sec = (ms: number | null): string => (ms === null ? '-' : `${(ms / 1000).toFixed(1)} s`);
  lines.push(
    '',
    '## Recovery by cause',
    '',
    'Recovered means reconciled and able to exit, timed from the kill on the monotonic clock (a host reboot is timed on the wall clock).',
    '',
    '| Cause | Planned | Drilled | Passed | Exercised | Mid-trade | Exit capable, median | Exit capable, worst | Exposed | Longest exposure | Worst move |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...Object.entries(r.recovery_by_cause).map(
      ([c, v]) =>
        `| ${c}${v.off_run ? ' (tabletop beside the run)' : ''}${v.skipped ? ' (not proven on this run)' : ''} | ${v.planned} | ${v.drills} | ${v.passed} | ${c === 'rpc' ? '-' : v.exercised === 0 ? 'not exercised' : v.exercised} | ${v.mid_trade} | ${sec(v.exit_capable_ms.median)} | ${sec(v.exit_capable_ms.worst)} | ${v.exposure.drills} | ${sec(v.exposure.worst_duration_ms)} | ${v.exposure.worst_move_bps === null ? '-' : `${v.exposure.worst_move_bps} bps`} |`,
    ),
  );
  const q = r.ops.quota;
  lines.push(
    '',
    '## Quota and coverage',
    '',
    '| Provider | Credits used | P0 / P1 / P2 / P3 | Projected month | Free plan | Shed P0 / P1 |',
    '| --- | --- | --- | --- | --- | --- |',
    ...q.providers.map(
      (p) =>
        `| ${p.provider} | ${p.credits_used} | ${p.credits_by_class.join(' / ')} | ${p.projected_monthly ?? '-'} | ${p.monthly_credits === null ? 'rate only' : `${p.monthly_credits} (${p.within_free_tier ? 'fits' : 'EXCEEDED'})`} | ${p.shed[0]} / ${p.shed[1]} |`,
    ),
    '',
    `Historical lookups: ${r.ops.lookups.count}, median ≤ ${r.ops.lookups.p50_ms_at_most ?? '-'} ms, p95 ≤ ${r.ops.lookups.p95_ms_at_most ?? '-'} ms, ${r.ops.lookups.slower_than_last_bound} slower than the last bucket.`,
    '',
    'Projections are linear: credits used so far, scaled from the run\'s wall time to 30 days.',
    'Down windows start at each boot\'s last journal line, so a quiet journal makes an outage look longer, never shorter.',
    ...q.problems.map((p) => `- Quota problem: ${p}`),
    '',
    `Coverage gaps (worker gaps and down windows): ${Object.entries(r.ops.coverage.streams).map(([k, v]) => `${k} ${v.gaps} (${v.open} open, ${v.total_s} s total, longest ${v.longest_s} s)`).join('; ') || 'none'}.`,
    '',
    ...r.ops.coverage.problems.map((p) => `- Coverage problem: ${p}`),
    '',
    `Rejections: ${r.ops.rejections.rejected} of ${r.ops.rejections.decisions} decisions; H16 not-covered ${r.ops.rejections.h16_not_covered.count} (${(r.ops.rejections.h16_not_covered.rate * 100).toFixed(2)}%).`,
    ...Object.entries(r.ops.rejections.by_reason).map(([k, v]) => `- ${k}: ${v.count} (${(v.rate * 100).toFixed(2)}%)`),
    '',
    '## Unprotected exposure',
    '',
    r.exposure.drills === 0
      ? 'No restart drill had an open position.'
      : `${r.exposure.drills} restart drills with an open position. Longest time from kill to exit capable: ${r.exposure.worst_duration_ms === null ? 'not reached' : `${(r.exposure.worst_duration_ms / 1000).toFixed(1)} s`}. Worst price move in that window: ${r.exposure.worst_move_bps === null ? 'not measured' : `${r.exposure.worst_move_bps} bps`}.`,
    ...r.drills.flatMap((d) =>
      d.exposure
        ? [`- ${d.id}: ${d.exposure.duration_ms === null ? 'not exit capable in time' : `${(d.exposure.duration_ms / 1000).toFixed(1)} s`} unprotected, reconciled after ${d.exposure.reconciled_ms === null ? '-' : `${(d.exposure.reconciled_ms / 1000).toFixed(1)} s`}, worst move ${d.exposure.worst_move_bps ?? 'not measured'} bps (${d.exposure.move_source}), chain rebuild for ${d.exposure.chain_trades.length} of ${d.exposure.trades.length} trades`]
        : [],
    ),
  );
  const i4 = r.item4;
  const pts = (x: number | null): string => (x === null ? '-' : `${x} pts`);
  lines.push(
    '',
    '## Item 4: dry-run simulation',
    '',
    `**${i4.counts ? 'Counts' : 'Does not count'}.** ${i4.note}`,
    '',
    '| Bound | Value | Limit | Result |',
    '| --- | --- | --- | --- |',
    `| Simulated successfully | ${i4.bounds.success.percent}% (${i4.successes} of ${i4.trades}) | ≥ ${i4.bounds.success.min_percent}% | ${yes(i4.bounds.success.pass)} |`,
    `| Median amount error | ${pts(i4.bounds.median.points)} | ≤ ${i4.bounds.median.max_points} pts | ${yes(i4.bounds.median.pass)} |`,
    `| Largest amount error | ${pts(i4.bounds.each.max_seen_points)} | ≤ ${i4.bounds.each.max_points} pts each | ${yes(i4.bounds.each.pass)} |`,
    '',
    `Outcomes: ${Object.entries(i4.outcomes).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}. Stand-in legs: ${i4.stand_ins}. Close omitted: ${i4.close_omitted}. Median quote age: ${i4.median_quote_age_slots ?? '-'} slots.`,
    '',
    i4.counts ? `Item 4: **${i4.pass ? 'pass' : 'not passed'}**` : `Item 4: **not counted** (bounds met: ${i4.bounds_pass ? 'yes' : 'no'})`,
  );
  if (r.journal.problems.length) lines.push('', '## Journal problems', '', ...r.journal.problems.map((p) => `- ${p}`));
  return `${lines.join('\n')}\n`;
};
