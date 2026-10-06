// RUN-1d: a retry killed before the run's end must have an outcome before the final report.
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { describe, expect, it, vi } from 'vitest';
import type { Health } from '../src/contract.ts';
import type { WorkerControl } from '../src/control.ts';
import type { DrillOutcome, Report, RunMeta } from '../src/report.ts';
import { runSegment } from '../src/runner.ts';

describe('restart recovery at the run deadline', () => {
  const run = async (lateReply: boolean, segmentEnd = Infinity, targetMs = 100, lateRecovery = false) => {
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
        now = 101;
        mono = 96;
        boot = 'third';
        start(boot, [{ trade: position.trade, universe: position.universe }]);
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
      const open = calls >= 3;
      return { seq: calls, ts: now, git_sha: 'c0ffee', policy_version: 'p', last_processed_slot: 1, feed_ages_ms: {}, open_position: open ? position : null, open_positions: open ? [position] : [], pending_exits: [], unresolved_intents: { count: 0, oldest_age_s: null, trades: [] }, signer: 'paper', lease_epoch: null, sol_reserve: null, paused: false, boot, pid: 1, uptime_s: 0, rss_bytes: 1, mode: 'paper', recorder: 'on', simulation: 'on', reconciled: true, exit_capable: true, quota: [], lookups: { counts: [] }, entries_halted: false, halt_reasons: [], critical: [], feeds: { f: { connected: true, age_ms: 0, critical: true, dropped_by_drill: false } }, journal_seq: seq, signing_key: false, stub: true };
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
});
