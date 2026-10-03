// RUN-1c: quota and coverage report, and the unprotected exposure of restart drills with an open position.
import { describe, expect, it } from 'vitest';
import type { JournalLine, QuotaStatus } from '../src/contract.ts';
import { checkJournal } from '../src/journal.ts';
import { item4 } from '../src/item4.ts';
import { makePlan } from '../src/plan.ts';
import { coverageGaps, lookupLatency, quotaReport, rejections, type BootTotals } from '../src/quota.ts';
import { buildReport, reportMarkdown, type DrillOutcome, type Ops, type RunMeta, type Sample } from '../src/report.ts';
import { moveBps, withChainMoves } from '../src/runner.ts';
import { OPS_OK } from './fixtures.ts';

const H = 3_600_000;
const q = (o: Partial<QuotaStatus> & { provider: string }): QuotaStatus => ({
  credits_used: 0, credits_by_class: [0, 0, 0, 0], monthly_credits: 1_000_000, granted: [0, 0, 0, 0], shed: [0, 0, 0, 0], halted: false, ...o,
});
const boot = (quota: QuotaStatus[], counts: number[] = []): BootTotals => ({ quota, lookups: { counts } });

describe('quota', () => {
  it('sums boots (counters restart each boot) and projects the month from the run time', () => {
    const r = quotaReport([boot([q({ provider: 'helius', credits_used: 10_000, credits_by_class: [1000, 4000, 3000, 2000] })]), boot([q({ provider: 'helius', credits_used: 6000, credits_by_class: [600, 2400, 1800, 1200] })])], 48 * H);
    expect(r.providers[0]).toMatchObject({ provider: 'helius', credits_used: 16_000, credits_by_class: [1600, 6400, 4800, 3200], projected_monthly: 240_000, within_free_tier: true });
    expect(r).toMatchObject({ reported: true, within_free_tier: true, exit_capacity_shed: 0 });
  });
  it('fails the free tier when the projection passes the monthly credits', () => {
    const r = quotaReport([boot([q({ provider: 'alchemy', credits_used: 2_000_001, monthly_credits: 30_000_000 })])], 48 * H);
    expect(r.providers[0]!.projected_monthly).toBe(30_000_015);
    expect(r.within_free_tier).toBe(false);
  });
  it('a rate-only provider has no projection check', () => {
    const r = quotaReport([boot([q({ provider: 'jupiter', credits_used: 99_999_999, monthly_credits: null })])], H);
    expect(r.providers[0]!.within_free_tier).toBeNull();
    expect(r.within_free_tier).toBe(true);
  });
  it('counts P0 and P1 shed across boots, never P2 or P3', () => {
    expect(quotaReport([boot([q({ provider: 'helius', shed: [0, 0, 5, 9] })])], H).exit_capacity_shed).toBe(0);
    expect(quotaReport([boot([q({ provider: 'helius', shed: [0, 1, 0, 0] })]), boot([q({ provider: 'helius', shed: [2, 0, 0, 0] })])], H).exit_capacity_shed).toBe(3);
  });
  it('nothing reported is not a pass', () => {
    expect(quotaReport([], H)).toMatchObject({ reported: false, within_free_tier: false });
  });
});

describe('lookup latency', () => {
  it('reads the median and p95 bucket from histograms summed over boots', () => {
    // 50 lookups ≤ 25 ms, 45 ≤ 100 ms, 5 slower than 6400 ms.
    const r = lookupLatency([boot([], [30, 0, 20]), boot([], [20, 0, 25, 0, 0, 0, 0, 0, 0, 5])]);
    expect(r).toEqual({ count: 100, p50_ms_at_most: 25, p95_ms_at_most: 100, slower_than_last_bound: 5 });
    expect(lookupLatency([]).p50_ms_at_most).toBeNull();
  });
});

const line = (kind: string, extra: Record<string, unknown>): JournalLine => ({ seq: 1, ts: '2026-10-04T00:00:00.000Z', boot: 'b', kind, ...extra }) as JournalLine;

describe('coverage gaps and rejections', () => {
  it('sums gap durations by stream; an open gap runs to the end of the run', () => {
    const t0 = Date.parse('2026-10-04T00:00:00.000Z');
    const r = coverageGaps(
      [
        line('coverage_gap', { stream: 'creates', from_ts: '2026-10-04T00:00:00.000Z', to_ts: '2026-10-04T00:00:30.000Z' }),
        line('coverage_gap', { stream: 'creates', from_ts: '2026-10-04T00:01:00.000Z', to_ts: '2026-10-04T00:01:10.000Z' }),
        line('coverage_gap', { stream: 'rugs', from_ts: '2026-10-04T00:02:00.000Z', to_ts: null }),
      ],
      t0 + 300_000,
    );
    expect(r).toEqual({ creates: { gaps: 2, open: 0, total_s: 40, longest_s: 30 }, rugs: { gaps: 1, open: 1, total_s: 180, longest_s: 180 } });
  });
  it('rates rejections by gate reason, H16 not-covered named', () => {
    const r = rejections([
      line('decision', { action: 'enter' }),
      line('decision', { action: 'skip', gate_reasons: [{ gate: 'H16', code: 'not-covered' }, { gate: 'H16', code: 'not-covered' }, { gate: 'H9', code: 'top10' }] }),
      line('decision', { action: 'skip', gate_reasons: [{ gate: 'H16', code: 'stale' }] }),
      line('decision', { action: 'skip', reasons: ['text only'] }),
    ]);
    expect(r).toEqual({
      decisions: 4,
      rejected: 3,
      by_reason: { 'H16:not-covered': { count: 1, rate: 0.25 }, 'H16:stale': { count: 1, rate: 0.25 }, 'H9:top10': { count: 1, rate: 0.25 }, untyped: { count: 1, rate: 0.25 } },
      h16_not_covered: { count: 1, rate: 0.25 },
    });
  });
});

const meta: RunMeta = { runId: 'r', label: 'vps', commit: 'c0ffee', startedAt: 0, targetMs: 100, entry: 'systemd:zeroed-worker.service', plan: makePlan({ durationMs: 100, feeds: ['f'], restartWindowMs: 1, feedDropMs: 1 }) };
const samples: Sample[] = Array.from({ length: 11 }, (_, i) => ({
  t: i * 10, up: true, ready: true, boot: 'a', git_sha: 'c0ffee', rss_bytes: 100 * 1024 * 1024, in_trade: false, entries_halted: false,
  recorder: true, simulation: true, stub: false, feeds: 'f', feeds_down: [],
}));
const restart = (i: number, exposure?: DrillOutcome['exposure']): DrillOutcome => ({ id: `restart-${i}`, kind: 'restart', plannedAt: 0, at: 0, pass: true, midTrade: true, recoveredMs: 1, notes: [], ...(exposure ? { exposure } : {}) });
const drills: DrillOutcome[] = [restart(1), restart(2), restart(3), { id: 'feed-f', kind: 'feed', plannedAt: 0, at: 0, pass: true, feed: 'f', notes: [] }];
const report = (ops: Ops, d = drills) => buildReport(meta, samples, 10, 100, checkJournal(''), d, [], item4([], 'vps', false), ops);

describe('report checks', () => {
  it('passes with quota inside the plan and nothing shed', () => {
    const r = report(OPS_OK);
    expect(Object.entries(r.checks).filter(([, v]) => !v)).toEqual([]);
  });
  it.each([
    ['the projection breaks the free tier', { ...OPS_OK, quota: quotaReport([boot([q({ provider: 'helius', credits_used: 2, monthly_credits: 1 })])], 100) }, 'quota_within_free_tier'],
    ['P0 was shed once', { ...OPS_OK, quota: quotaReport([boot([q({ provider: 'helius', shed: [1, 0, 0, 0] })])], 100) }, 'exit_capacity_never_shed'],
    ['P1 was shed once', { ...OPS_OK, quota: quotaReport([boot([q({ provider: 'helius', shed: [0, 1, 0, 0] })])], 100) }, 'exit_capacity_never_shed'],
    ['no quota reported', { ...OPS_OK, quota: quotaReport([], 100) }, 'quota_reported'],
  ])('fails the run when %s', (_, ops, check) => {
    const r = report(ops as Ops);
    expect(r.checks[check]).toBe(false);
    expect(r.pass).toBe(false);
  });
});

describe('unprotected exposure', () => {
  const e = (duration_ms: number | null, worst_move_bps: number | null): DrillOutcome['exposure'] => ({ duration_ms, reconciled_ms: 100, mark_before: '1', mark_after: '1', worst_move_bps, move_source: 'marks' });
  it('reports the longest window and the worst move, and fails when a drill never became exit capable', () => {
    const r = report(OPS_OK, [restart(1, e(4200, 30)), restart(2, e(9100, 12)), restart(3), drills[3]!]);
    expect(r.exposure).toEqual({ drills: 2, worst_duration_ms: 9100, worst_move_bps: 30 });
    expect(r.checks['exposure_measured']).toBe(true);
    expect(reportMarkdown(r)).toContain('Longest time from kill to exit capable: 9.1 s. Worst price move in that window: 30 bps.');
    const bad = report(OPS_OK, [restart(1, e(null, null)), restart(2), restart(3), drills[3]!]);
    expect(bad.checks['exposure_measured']).toBe(false);
    expect(reportMarkdown(bad)).toContain('not exit capable in time');
  });
  it('measures the move between marks, and takes the worker’s chain rebuild when it is worse', () => {
    expect(moveBps('2', '1.9')).toBe(500);
    expect(moveBps('2', '2.0001')).toBe(1);
    expect(moveBps(null, '1')).toBeNull();
    expect(moveBps('0', '1')).toBeNull();
    const d = restart(1, { ...e(5000, 20)!, });
    const chain = (bps: number, from: string) => line('exposure', { worst_move_bps: bps, from_ts: from });
    expect(withChainMoves([d], [chain(75, '1970-01-01T00:00:01.000Z')])[0]!.exposure).toMatchObject({ worst_move_bps: 75, move_source: 'chain' });
    expect(withChainMoves([d], [chain(5, '1970-01-01T00:00:01.000Z')])[0]!.exposure).toMatchObject({ worst_move_bps: 20, move_source: 'marks' });
    // A rebuild from another window, or a bad value, is ignored.
    expect(withChainMoves([d], [chain(900, '1970-01-02T00:00:00.000Z'), line('exposure', { worst_move_bps: -1, from_ts: '1970-01-01T00:00:01.000Z' })])[0]!.exposure!.worst_move_bps).toBe(20);
  });
});
