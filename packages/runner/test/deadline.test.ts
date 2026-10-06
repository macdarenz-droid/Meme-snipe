// RUN-1d: a retry killed before the run's end must have an outcome before the final report.
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { describe, expect, it, vi } from 'vitest';
import type { Health } from '../src/contract.ts';
import type { WorkerControl } from '../src/control.ts';
import { checkJournal } from '../src/journal.ts';
import { item4 } from '../src/item4.ts';
import { makePlan } from '../src/plan.ts';
import { buildReport, type DrillOutcome, type Report, type RunMeta, type Sample } from '../src/report.ts';
import { runSegment } from '../src/runner.ts';
import { fullDrills, OPS_OK } from './fixtures.ts';

describe('restart recovery at the run deadline', () => {
  const run = async (lateReply: boolean, segmentEnd = Infinity, targetMs = 100, lateRecovery = false, recoveryTail = false, simulationTail?: 'good' | 'bad' | 'amount', delayedHealthAfterKill = false) => {
    const dir = mkdtempSync(join(tmpdir(), 'run1-deadline-'));
    const stateDir = join(dir, 'state');
    const evidenceDir = join(dir, 'evidence');
    mkdirSync(stateDir);
    mkdirSync(evidenceDir);
    let now = 90;
    let mono = 90;
    let seq = 0;
    let boot = 'second';
    let kills = 0;
    const position = { trade: 'held', mint: 'm', qty: '1', entry: '1', stop: '0.9', mark: '1', mark_slot: 1, mark_ts: 90, universe: 'U2' };
    const line = (b: string, kind: string, fields = {}) => appendFileSync(join(stateDir, 'journal.jsonl'), `${JSON.stringify({ seq: ++seq, ts: new Date(now).toISOString(), boot: b, kind, ...fields })}\n`);
    const start = (b: string, positions: unknown[]) => {
      line(b, 'start');
      line(b, 'reconcile', { ok: true });
      line(b, 'recovered', { source: 'state', positions, pending_exits: [] });
      line(b, 'exit_capable');
    };
    start('first', []);
    start('second', []);
    const simulation = { trade: 'simulation', leg: 'entry', outcome: 'simulated', success: true, error: null, standIn: null, quotedOut: '1000000', simulatedOut: '1000000', amountErrorE4: 0, quoteAgeSlots: '0', rentDeclared: '0', rentPaid: '0', balancesFrom: 'simulation' };
    const failedSimulation = { ...simulation, outcome: 'sim-error', success: false, simulatedOut: null, amountErrorE4: null };
    if (simulationTail) {
      line(boot, 'simulation', simulationTail === 'good' ? failedSimulation : simulation);
      line(boot, 'decision', { action: 'reject', reasons: ['not covered'], gate_reasons: [{ gate: 'H16', code: 'not-covered' }] });
    }
    const planned: DrillOutcome = { id: 'restart-1', kind: 'restart', cause: 'crash', plannedAt: 0, at: 0, pass: true, keep: 0, state: { source: 'state', expected_pending_exits: [], recovered_pending_exits: [], missing: [], lost: [], state_ok: true, universe_ok: true, notes: [] }, notes: [] };
    const meta: RunMeta = { runId: 'run', label: 'rehearsal', commit: 'c0ffee', startedAt: 0, targetMs, entry: 'stub', plan: [{ id: 'restart-1', kind: 'restart', cause: 'crash', atMs: 0, windowMs: 20 }, { id: 'feed-f', kind: 'feed', feed: 'f', atMs: 0, dropMs: 1 }] };
    writeFileSync(join(evidenceDir, 'run.json'), JSON.stringify(meta));
    writeFileSync(join(evidenceDir, 'drills.json'), JSON.stringify([planned, { id: 'feed-f', kind: 'feed', feed: 'f', plannedAt: 0, at: 0, pass: true, notes: [] }]));
    writeFileSync(join(evidenceDir, 'unexercised-retry.json'), JSON.stringify({ drill: 'restart-1', attempt: 1, dueAt: 90 }));
    const control: WorkerControl = {
      start: async () => {},
      kill: async () => {
        kills++;
        // The kill began before the deadline; the async supervisor/restart returned after it.
        now = delayedHealthAfterKill ? 96 : 101;
        mono = 96;
        boot = 'third';
        start(boot, [{ trade: position.trade, universe: position.universe }]);
        if (recoveryTail) line(boot, 'coverage_gap', { stream: 'creates', gap_id: 'tail-close', from_ts: new Date(0).toISOString(), to_ts: null });
      },
      reboot: async () => { throw new Error('unexpected reboot'); },
      wipe: async () => { throw new Error('unexpected wipe'); },
      tabletop: async () => { throw new Error('unexpected tabletop'); },
      endTabletop: async () => {},
      stop: async () => {},
    };
    let calls = 0;
    const fetchHealth = async (): Promise<Health> => {
      calls++;
      // First ready reply, then a flat sample, then the fresh trade the retry waits for.
      if (calls === 2) now = mono = 95;
      if (lateReply && calls === 3) now = 101;
      if (calls >= 4) mono = lateRecovery ? 6096 : 101;
      if (recoveryTail && calls >= 4) {
        now = delayedHealthAfterKill ? 201 : now + 10;
        mono = now - 5;
        if (now === 171) line(boot, 'coverage_gap', { stream: 'trades', gap_id: 'invalid-tail', from_ts: 'invalid', to_ts: null });
        if (now === 201) line(boot, 'coverage_gap', { stream: 'creates', gap_id: 'tail-close', from_ts: new Date(0).toISOString(), to_ts: new Date(now).toISOString() });
        if (now === 111 && simulationTail) {
          if (simulationTail === 'good') {
            for (let i = 0; i < 19; i++) {
              line(boot, 'simulation', { ...simulation, trade: `tail-${i}` });
              line(boot, 'decision', { action: 'enter', reasons: ['tail simulation'] });
            }
          } else line(boot, 'simulation', simulationTail === 'bad' ? failedSimulation : { ...simulation, simulatedOut: '1030000', amountErrorE4: 30_000 });
        }
      }
      const open = calls >= 3;
      const credits = calls >= 4 ? 1 : 0;
      const quota = recoveryTail ? [
        { provider: 'helius', credits_used: credits, credits_by_class: [credits, 0, 0, 0] as const, monthly_credits: 1_000_000, granted: [1, 0, 0, 0] as const, shed: [0, 0, 0, 0] as const, halted: false },
        { provider: 'alchemy', credits_used: 0, credits_by_class: [0, 0, 0, 0] as const, monthly_credits: 30_000_000, granted: [0, 0, 0, 0] as const, shed: [0, 0, 0, 0] as const, halted: false },
        { provider: 'jupiter', credits_used: 0, credits_by_class: [0, 0, 0, 0] as const, monthly_credits: null, granted: [0, 0, 0, 0] as const, shed: [0, 0, 0, 0] as const, halted: false },
      ] : [];
      return { seq: calls, ts: now, git_sha: 'c0ffee', policy_version: 'p', last_processed_slot: 1, feed_ages_ms: {}, open_position: open ? position : null, open_positions: open ? [position] : [], pending_exits: [], unresolved_intents: { count: 0, oldest_age_s: null, trades: [] }, signer: 'paper', lease_epoch: null, sol_reserve: null, paused: false, boot, pid: 1, uptime_s: 0, rss_bytes: recoveryTail && now === 181 ? 800 * 1024 * 1024 : 1, mode: 'paper', recorder: 'on', simulation: 'on', reconciled: true, exit_capable: !recoveryTail || calls < 4 || now >= 201, quota, lookups: { counts: [] }, entries_halted: false, halt_reasons: [], critical: [], feeds: { f: { connected: true, age_ms: 0, critical: true, dropped_by_drill: false } }, journal_seq: seq, signing_key: false, stub: true };
    };
    const date = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const monotonic = vi.spyOn(performance, 'now').mockImplementation(() => mono);
    try {
      const result = await runSegment({ control, stateDir, evidenceDir, healthAddr: 'scripted', identity: { label: 'rehearsal', commit: 'c0ffee' }, fetchHealth, sampleMs: 1, recoverMs: 6000, segmentEnd, keepRecorded: 'copy', handover: false, log: () => {} });
      return { result, kills, evidenceDir };
    } finally {
      date.mockRestore();
      monotonic.mockRestore();
    }
  };

  it('records a live retry recovery when its async kill crosses the final run deadline', async () => {
    const { result, kills } = await run(false);
    const r = result.report as Report;
    const tries = r.drills.filter((d) => /-retry-\d+$/.test(d.id));
    expect(kills).toBe(1);
    // The original tabletop assertion: two existing live boots plus each recorded retry.
    expect(r.journal.boots).toBe(2 + tries.length);
    expect(tries).toHaveLength(1);
    expect(tries[0]).toMatchObject({ id: 'restart-1-retry-1', pass: true, keep: 1, recovery: { clock: 'monotonic' } });
    expect(r.checks).toMatchObject({ recovered_state: true, restored_universe_kept: true, journal_complete: true });
  });

  it('does not start a retry kill when awaiting its health reply crosses the deadline', async () => {
    const { result, kills } = await run(true);
    expect(kills).toBe(0);
    expect(result.report!.journal.boots).toBe(2);
    expect(result.report!.drills.some((d) => /-retry-\d+$/.test(d.id))).toBe(false);
  });

  it('keeps the finite segment deadline and the pending retry file for the next segment', async () => {
    const { result, kills, evidenceDir } = await run(false, 100, 1000);
    expect(kills).toBe(1);
    expect(result).toMatchObject({ done: false, aborted: null, report: null });
    expect(existsSync(join(evidenceDir, 'unexercised-retry.json'))).toBe(true);
  });

  it('fails a late recovery at the existing monotonic recovery bound', async () => {
    const { result } = await run(false, Infinity, 100, true);
    const retry = result.report!.drills.find((d) => d.id === 'restart-1-retry-1')!;
    expect(retry).toMatchObject({ pass: false, recovery: { clock: 'monotonic', exit_capable_ms: null } });
    expect(retry.notes).toContain('not exit capable 6 s after the kill');
    expect(result.report!.checks.recovered_state).toBe(false);
  });

  it('scores the fixed run window while keeping late recovery, charges and negative evidence', async () => {
    const { result, evidenceDir } = await run(false, Infinity, 100, false, true);
    const r = result.report!;
    expect.soft(r.ended).toBe(new Date(100).toISOString());
    // The first two healthy replies arrive at95, not at the earlier request time90: only95→97 is credited.
    expect.soft(r.uptime).toBe(0.02);
    expect.soft(r.ops.quota.providers.find((p) => p.provider === 'helius')).toMatchObject({ credits_used: 1, projected_monthly: 25_920_000, within_free_tier: false });
    expect.soft(r.ops.coverage.streams['creates']).toMatchObject({ total_s: 0.1, open: 1 });
    expect(r.drills.find((d) => d.id === 'restart-1-retry-1')).toMatchObject({ pass: true, recovery: { exit_capable_ms: 101, clock: 'monotonic' } });
    expect(r.journal.boots).toBe(3);
    expect(r.memory.max_mb).toBe(800);
    expect(r.checks).toMatchObject({ memory: false, quota_within_free_tier: false, coverage_valid: false });
    expect(r.ops.coverage.problems.join(' ')).toContain('valid from_ts');
    expect(existsSync(join(evidenceDir, 'journal.jsonl'))).toBe(true);
  });

  it('late successful simulations and decisions cannot turn a failed in-window item4 gate or reject mix into a pass', async () => {
    const { result } = await run(false, Infinity, 100, false, true, 'good');
    expect.soft(result.report!.item4).toMatchObject({ trades: 1, successes: 0, bounds_pass: false, bounds: { success: { pass: false, percent: 0 } } });
    expect.soft(result.report!.ops.rejections).toMatchObject({ decisions: 1, rejected: 1, h16_not_covered: { count: 1, rate: 1 } });
    // Successful tail simulations remain in the full diagnostic journal.
    expect(result.report!.journal.simulations).toBe(20);
  });

  it.each(['bad', 'amount'] as const)('keeps a late %s simulation as negative item4 evidence', async (kind) => {
    const { result } = await run(false, Infinity, 100, false, true, kind);
    expect(result.report!.item4).toMatchObject({ trades: 1, successes: 1, bounds_pass: false });
    expect(result.report!.journal.simulations).toBe(2);
  });

  it('late-only healthy samples and drills cannot supply missing qualifying evidence', () => {
    const meta: RunMeta = { runId: 'run', name: 'qual-1', strategy: 'U2-v1', label: 'vps', commit: 'c0ffee', startedAt: 0, targetMs: 100, entry: 'worker', plan: makePlan({ durationMs: 100, feeds: ['f'], restarts: 3, causes: ['crash'], restartWindowMs: 1, feedDropMs: 1 }) };
    const late: Sample = { t: 101, kept: { pending_exits: [], positions: [] }, up: true, ready: true, boot: 'late', git_sha: 'c0ffee', rss_bytes: 1, in_trade: false, exit_capable: true, mark: null, entries_halted: false, recorder: true, simulation: true, stub: false, feeds: 'f', feeds_down: [] };
    const journal = checkJournal(JSON.stringify({ seq: 1, ts: new Date(101).toISOString(), boot: 'late', kind: 'start', entry_rule: 'U2-v1', qualifying: true, paper_edge_ppm: null, s0_salt: null }));
    const drills = fullDrills(meta.plan).map((d) => ({ ...d, at: 101 }));
    const r = buildReport(meta, [late], 1, 100, journal, drills, [], item4([], 'vps', false), OPS_OK, ['U2-v1']);
    expect(r.checks).toMatchObject({ memory: false, one_commit: false, recorder_and_simulation_from_start: false, qualifying_start: false, feeds_fixed: false, restart_drills: false, feed_drills: false, drills_by_cause: false });
    expect(r.drills).toEqual(drills);
    expect(r.journal.boots).toBe(1);
  });

  it('a ready recovery reply received after the cutoff cannot earn uptime at its earlier request time', async () => {
    const { result, evidenceDir } = await run(false, Infinity, 100, false, true, undefined, true);
    const samples = readFileSync(join(evidenceDir, 'samples.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Sample);
    expect(samples.at(-1)!.t).toBe(201);
    expect(result.report!.uptime).toBe(0.02);
    expect(result.report!.ended).toBe(new Date(100).toISOString());
    expect(result.report!.drills.find((d) => d.id === 'restart-1-retry-1')!.pass).toBe(true);
  });
});
