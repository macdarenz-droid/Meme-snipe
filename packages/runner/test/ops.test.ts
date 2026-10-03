// RUN-1c: quota and coverage report, and the unprotected exposure of restart drills with an open position.
import { describe, expect, it } from 'vitest';
import type { Health, JournalLine, QuotaStatus } from '../src/contract.ts';
import { checkJournal } from '../src/journal.ts';
import { item4 } from '../src/item4.ts';
import { makePlan } from '../src/plan.ts';
import { checkQuota, coverageGaps, FREE_PLANS, lookupLatency, quotaReport, rejections, type BootTotals } from '../src/quota.ts';
import { buildReport, reportMarkdown, type DrillOutcome, type Ops, type RunMeta, type Sample } from '../src/report.ts';
import { exposedTrades, freshMark, moveBps, withChainMoves } from '../src/runner.ts';
import { OPS_OK } from './fixtures.ts';

const H = 3_600_000;
const q = (o: Partial<QuotaStatus> & { provider: string }): QuotaStatus => ({
  credits_used: 0, credits_by_class: [0, 0, 0, 0], monthly_credits: 1_000_000, granted: [0, 0, 0, 0], shed: [0, 0, 0, 0], halted: false, ...o,
});
const boot = (quota: QuotaStatus[], counts: number[] = []): BootTotals => ({ quota, lookups: { counts } });

const plans = (over: Partial<Record<'helius' | 'alchemy' | 'jupiter', Partial<QuotaStatus>>> = {}): QuotaStatus[] => [
  q({ provider: 'helius', ...over.helius }),
  q({ provider: 'alchemy', monthly_credits: 30_000_000, ...over.alchemy }),
  q({ provider: 'jupiter', monthly_credits: null, ...over.jupiter }),
];

describe('quota', () => {
  it('sums boots (counters restart each boot) and projects the month linearly from the run time', () => {
    const r = quotaReport([boot(plans({ helius: { credits_used: 10_000, credits_by_class: [1000, 4000, 3000, 2000] } })), boot(plans({ helius: { credits_used: 6000, credits_by_class: [600, 2400, 1800, 1200] } }))], 48 * H);
    expect(r.providers.find((p) => p.provider === 'helius')).toMatchObject({ credits_used: 16_000, credits_by_class: [1600, 6400, 4800, 3200], projected_monthly: 240_000, within_free_tier: true });
    expect(r).toMatchObject({ reported: true, problems: [], within_free_tier: true, exit_capacity_shed: 0 });
  });
  it('fails the free tier when the projection passes the plan', () => {
    const r = quotaReport([boot(plans({ alchemy: { credits_used: 2_000_001, credits_by_class: [0, 2_000_001, 0, 0] } }))], 48 * H);
    expect(r.providers.find((p) => p.provider === 'alchemy')!.projected_monthly).toBe(30_000_015);
    expect(r.within_free_tier).toBe(false);
  });
  it('probe A: judges against FREE_PLANS, so a worker-reported null limit cannot pass 5M Helius credits', () => {
    const r = quotaReport([boot(plans({ helius: { credits_used: 5_000_000, credits_by_class: [0, 5_000_000, 0, 0], monthly_credits: null } }))], 48 * H);
    expect(r.reported).toBe(false);
    expect(r.problems).toContain('helius: worker reports monthly_credits null, the free plan is 1000000');
    expect(r.within_free_tier).toBe(false);
    // Even with the right figure reported, the projection fails on the runner's own plan.
    const r2 = quotaReport([boot(plans({ helius: { credits_used: 5_000_000, credits_by_class: [0, 5_000_000, 0, 0] } }))], 48 * H);
    expect(r2.providers.find((p) => p.provider === 'helius')).toMatchObject({ monthly_credits: 1_000_000, within_free_tier: false });
    expect(FREE_PLANS['helius']!.monthly).toBe(1_000_000);
    expect(FREE_PLANS['alchemy']!.monthly).toBe(30_000_000);
    expect(FREE_PLANS['jupiter']!.monthly).toBeNull();
  });
  it('probe D: reporting only jupiter is not a pass', () => {
    const r = quotaReport([boot([q({ provider: 'jupiter', monthly_credits: null })])], H);
    expect(r).toMatchObject({ reported: false, within_free_tier: false });
    expect(r.problems).toEqual(['helius: not reported', 'alchemy: not reported']);
  });
  it.each([
    ['probe B: shed []', { shed: [] as unknown as [0, 0, 0, 0] }, 'helius: shed is not four non-negative integers'],
    ['probe C: shed missing', { shed: undefined as unknown as [0, 0, 0, 0] }, 'helius: shed is not four non-negative integers'],
    ['a fractional credit count', { credits_used: 1.5, credits_by_class: [0, 1.5, 0, 0] as [number, number, number, number] }, 'helius: credits_used is not a non-negative integer'],
    ['classes that do not sum', { credits_used: 10, credits_by_class: [1, 1, 1, 1] as [number, number, number, number] }, 'helius: credits_by_class does not sum to credits_used'],
    ['a negative grant count', { granted: [0, -1, 0, 0] as [number, number, number, number] }, 'helius: granted is not four non-negative integers'],
  ])('%s is a problem, never zero and never a crash', (_, over, problem) => {
    const r = quotaReport([boot(plans({ helius: over }))], H);
    expect(r.reported).toBe(false);
    expect(r.problems).toContain(problem);
  });
  it('counts P0 and P1 shed across boots, never P2 or P3', () => {
    expect(quotaReport([boot(plans({ helius: { shed: [0, 0, 5, 9] } }))], H).exit_capacity_shed).toBe(0);
    expect(quotaReport([boot(plans({ helius: { shed: [0, 1, 0, 0] } })), boot(plans({ alchemy: { shed: [2, 0, 0, 0] } }))], H).exit_capacity_shed).toBe(3);
  });
  it('a boot marked by a bad sample stays unreported though its last valid counters count', () => {
    const r = quotaReport([{ ...boot(plans()), problems: ['boot b: no quota in the health reply'] }], H);
    expect(r).toMatchObject({ reported: false, problems: ['boot b: no quota in the health reply'] });
    expect(quotaReport([], H).problems).toEqual(['no boot reported a quota']);
  });
  it('checkQuota names every problem', () => {
    expect(checkQuota(undefined)).toEqual({ ok: false, problems: ['no quota in the health reply'] });
    expect(checkQuota(plans()).ok).toBe(true);
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
  const T = (s: number): string => new Date(Date.parse('2026-10-04T00:00:00.000Z') + s * 1000).toISOString();
  const at = (s: number, bootId: string, kind: string, extra: Record<string, unknown> = {}): JournalLine => ({ ...line(kind, extra), ts: T(s), boot: bootId }) as JournalLine;
  const end = Date.parse(T(600));
  it('pairs open and close lines by gap_id, merges overlaps, and lists every stream', () => {
    const r = coverageGaps(
      [
        at(0, 'a', 'start'),
        at(10, 'a', 'coverage_gap', { stream: 'creates', gap_id: 'g1', from_ts: T(10), to_ts: null }),
        at(40, 'a', 'coverage_gap', { stream: 'creates', gap_id: 'g1', from_ts: T(10), to_ts: T(40) }),
        at(30, 'a', 'coverage_gap', { stream: 'creates', gap_id: 'g2', from_ts: T(30), to_ts: T(50) }),
        at(60, 'a', 'stop'),
      ],
      end,
    );
    expect(r).toEqual({ streams: { creates: { gaps: 1, open: 0, total_s: 40, longest_s: 40 }, rugs: { gaps: 0, open: 0, total_s: 0, longest_s: 0 }, trades: { gaps: 0, open: 0, total_s: 0, longest_s: 0 } }, problems: [] });
  });
  it('a kill loses no gap: an open gap runs to the next boot, and every down window is a gap in every stream', () => {
    const r = coverageGaps(
      [
        at(0, 'a', 'start'),
        at(100, 'a', 'coverage_gap', { stream: 'rugs', gap_id: 'g1', from_ts: T(100), to_ts: null }),
        at(120, 'a', 'decision', {}), // last line before the kill
        at(150, 'b', 'start'),
        at(200, 'b', 'coverage_gap', { stream: 'trades', gap_id: 'g2', from_ts: T(200), to_ts: null }), // open at the end
      ],
      end,
    );
    expect(r.streams['rugs']).toEqual({ gaps: 1, open: 0, total_s: 50, longest_s: 50 }); // 100 → 150, the down window merged in
    expect(r.streams['creates']).toEqual({ gaps: 1, open: 0, total_s: 30, longest_s: 30 }); // 120 → 150
    expect(r.streams['trades']).toEqual({ gaps: 2, open: 1, total_s: 430, longest_s: 400 }); // 120 → 150 and 200 → 600
  });
  it('a gap open at a clean stop ends at the next boot\'s start', () => {
    const r = coverageGaps([at(0, 'a', 'start'), at(10, 'a', 'coverage_gap', { stream: 'creates', gap_id: 'g', from_ts: T(10), to_ts: null }), at(20, 'a', 'stop'), at(80, 'b', 'start')], end);
    expect(r.streams['creates']).toEqual({ gaps: 1, open: 0, total_s: 70, longest_s: 70 });
  });
  it.each([
    ['a malformed from_ts', { stream: 'creates', gap_id: 'g', from_ts: 'yesterday', to_ts: null }],
    ['no gap_id', { stream: 'creates', from_ts: T(1), to_ts: T(2) }],
    ['a close before its open', { stream: 'creates', gap_id: 'g', from_ts: T(5), to_ts: T(1) }],
  ])('%s is a problem, never counted as 0 s', (_, extra) => {
    const r = coverageGaps([at(0, 'a', 'start'), at(1, 'a', 'coverage_gap', extra)], end);
    expect(r.problems).toHaveLength(1);
    expect(r.streams['creates']!.total_s).toBe(0);
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
    ['the projection breaks the free tier', { ...OPS_OK, quota: quotaReport([boot(plans({ helius: { credits_used: 2, credits_by_class: [0, 2, 0, 0] } }))], 1) }, 'quota_within_free_tier'],
    ['P0 was shed once', { ...OPS_OK, quota: quotaReport([boot(plans({ helius: { shed: [1, 0, 0, 0] } }))], 100) }, 'exit_capacity_never_shed'],
    ['P1 was shed once', { ...OPS_OK, quota: quotaReport([boot(plans({ helius: { shed: [0, 1, 0, 0] } }))], 100) }, 'exit_capacity_never_shed'],
    ['a coverage line is malformed', { ...OPS_OK, coverage: { streams: {}, problems: ['seq 1: bad'] } }, 'coverage_valid'],
    ['no quota reported', { ...OPS_OK, quota: quotaReport([], 100) }, 'quota_reported'],
  ])('fails the run when %s', (_, ops, check) => {
    const r = report(ops as Ops);
    expect(r.checks[check]).toBe(false);
    expect(r.pass).toBe(false);
  });
});

describe('unprotected exposure', () => {
  const e = (duration_ms: number | null, worst_move_bps: number | null, chain = true): DrillOutcome['exposure'] => ({
    duration_ms, reconciled_ms: 100, trades: ['t1'], chain_trades: chain ? ['t1'] : [], mark_before: '1', mark_after: '1', worst_move_bps, move_source: 'marks',
  });
  it('reports the longest window and the worst move, and fails when a drill never became exit capable', () => {
    const r = report(OPS_OK, [restart(1, e(4200, 30)), restart(2, e(9100, 12)), restart(3), drills[3]!]);
    expect(r.exposure).toEqual({ drills: 2, worst_duration_ms: 9100, worst_move_bps: 30 });
    expect(r.checks['exposure_measured']).toBe(true);
    expect(reportMarkdown(r)).toContain('Longest time from kill to exit capable: 9.1 s. Worst price move in that window: 30 bps.');
    const bad = report(OPS_OK, [restart(1, e(null, null)), restart(2), restart(3), drills[3]!]);
    expect(bad.checks['exposure_measured']).toBe(false);
    expect(reportMarkdown(bad)).toContain('not exit capable in time');
  });
  it('probe F: an open-position drill with no measured move fails', () => {
    expect(moveBps('1e-5', '1')).toBeNull();
    const r = report(OPS_OK, [restart(1, e(4000, null)), restart(2), restart(3), drills[3]!]);
    expect(r.checks['exposure_measured']).toBe(false);
    expect(reportMarkdown(r)).toContain('worst move not measured bps');
  });
  it('the real worker must rebuild every exposed trade from chain; the stub need not', () => {
    const missing = [restart(1, e(4000, 10, false)), restart(2), restart(3), drills[3]!];
    expect(report(OPS_OK, missing).checks['exposure_measured']).toBe(false);
    const stubSamples = samples.map((x) => ({ ...x, stub: true }));
    expect(buildReport(meta, stubSamples, 10, 100, checkJournal(''), missing, [], item4([], 'vps', false), OPS_OK).checks['exposure_measured']).toBe(true);
  });
  it('a stale mark is unmeasured; an entry in flight is exposed', () => {
    const h = (o: Record<string, unknown>): Health => ({ ts: 100_000, open_position: null, unresolved_intents: { count: 0, oldest_age_s: null, trades: [] }, ...o }) as unknown as Health;
    const pos = (mark_ts: number) => ({ trade: 't1', mint: 'm', qty: '1', entry: '1', stop: '0.9', mark: '1.2', mark_slot: 5, mark_ts });
    expect(freshMark(h({ open_position: pos(100_000 - 30_000) }))).toBe('1.2');
    expect(freshMark(h({ open_position: pos(100_000 - 30_001) }))).toBeNull();
    expect(freshMark(h({ open_position: pos(100_001) }))).toBeNull();
    expect(exposedTrades(h({ unresolved_intents: { count: 1, oldest_age_s: 0, trades: ['t2'] } }))).toEqual(['t2']);
    expect(exposedTrades(h({ open_position: pos(1), unresolved_intents: { count: 1, oldest_age_s: 0, trades: ['t1', 't3'] } }))).toEqual(['t1', 't3']);
  });
  it('measures the move between marks, and takes the worker’s chain rebuild when it is worse', () => {
    expect(moveBps('2', '1.9')).toBe(500);
    expect(moveBps('2', '2.0001')).toBe(1);
    expect(moveBps(null, '1')).toBeNull();
    expect(moveBps('0', '1')).toBeNull();
    const d = restart(1, { ...e(5000, 20, false)! });
    const chain = (bps: number, from: string, trade = 't1') => line('exposure', { worst_move_bps: bps, from_ts: from, trade });
    expect(withChainMoves([d], [chain(75, '1970-01-01T00:00:01.000Z')])[0]!.exposure).toMatchObject({ worst_move_bps: 75, move_source: 'chain', chain_trades: ['t1'] });
    // Matched by trade: another trade's rebuild does not count.
    expect(withChainMoves([d], [chain(75, '1970-01-01T00:00:01.000Z', 't9')])[0]!.exposure).toMatchObject({ worst_move_bps: 20, chain_trades: [] });
    expect(withChainMoves([d], [chain(5, '1970-01-01T00:00:01.000Z')])[0]!.exposure).toMatchObject({ worst_move_bps: 20, move_source: 'marks' });
    // A rebuild from another window, or a bad value, is ignored.
    expect(withChainMoves([d], [chain(900, '1970-01-02T00:00:00.000Z'), line('exposure', { worst_move_bps: -1, from_ts: '1970-01-01T00:00:01.000Z' })])[0]!.exposure!.worst_move_bps).toBe(20);
  });
});
