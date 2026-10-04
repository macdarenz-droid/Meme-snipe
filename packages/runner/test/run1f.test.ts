// RUN-1f: a host loss counts only when its restore was compared (VPS); a self-reported one retries after the next
// backup, labelled; the recovered line and the health fields the runner reads are typed in the contract.
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { STUB_ENTRY, type Health, type JournalKind, type RecoveredFields } from '../src/contract.ts';
import { LocalControl, snapshotState, type Tabletop } from '../src/control.ts';
import { checkJournal } from '../src/journal.ts';
import { item4 } from '../src/item4.ts';
import { makePlan } from '../src/plan.ts';
import { buildReport, reportMarkdown, type DrillOutcome, type Report, type RunMeta, type Sample } from '../src/report.ts';
import { HOST_LOSS_RETRIES, runSegment } from '../src/runner.ts';
import { fullDrills, OPS_OK } from './fixtures.ts';

const root = join(import.meta.dirname, '..', '..', '..');
const freePort = (): Promise<number> =>
  new Promise((res) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => res(p));
    });
  });

describe('a. host loss counts only when compared (VPS)', () => {
  const plan = makePlan({ durationMs: 100, feeds: ['f'], restartWindowMs: 1, feedDropMs: 1 });
  const samples: Sample[] = Array.from({ length: 11 }, (_, i) => ({ t: i * 10, up: true, ready: true, boot: 'a', git_sha: 'c0ffee', rss_bytes: 1, in_trade: false, entries_halted: false, recorder: true, simulation: true, stub: false, feeds: 'f', feeds_down: [] }));
  const start = JSON.stringify({ seq: 1, ts: '2026-10-04T00:00:00.000Z', boot: 'a', kind: 'start', entry_rule: 'U2-v1', paper_edge_ppm: null, s0_salt: null, qualifying: true });
  const report = (label: 'vps' | 'rehearsal', compared: boolean | undefined) => {
    const meta: RunMeta = { runId: 'r', name: 'qual-1', strategy: 'U2-v1', label, commit: 'c0ffee', startedAt: 0, targetMs: 100, entry: 'e', plan };
    const drills = fullDrills(plan).map((d): DrillOutcome => {
      if (d.cause !== 'host-loss') return d;
      const { compared: _, ...rest } = d;
      return compared === undefined ? rest : { ...rest, compared };
    });
    return buildReport(meta, samples, 10, 100, checkJournal(start), drills, [], item4([], label, false), OPS_OK, ['U2-v1']);
  };
  it('a self-reported host loss on a VPS run is listed and labelled, but does not exercise the cause', () => {
    const r = report('vps', false);
    expect(r.recovery_by_cause['host-loss']).toMatchObject({ drills: 1, passed: 1, exercised: 0, self_reported: 1 });
    expect(r.checks['drills_by_cause']).toBe(false);
    expect(reportMarkdown(r)).toMatch(/\| host-loss \(tabletop beside the run\) \(self-reported, not compared to the backup\) \| 1 \| 1 \| 1 \| not exercised \|/);
  });
  it('a VPS host loss with no compared flag does not count either', () => {
    expect(report('vps', undefined).recovery_by_cause['host-loss']!.exercised).toBe(0);
  });
  it('a compared one counts', () => {
    const r = report('vps', true);
    expect(r.recovery_by_cause['host-loss']!.exercised).toBe(1);
    expect(r.checks['drills_by_cause']).toBe(true);
  });
  it('a rehearsal\'s host loss (a wipe and restore in the run itself) still counts as before', () => {
    expect(report('rehearsal', undefined).recovery_by_cause['host-loss']!.exercised).toBe(1);
  });
});

// The host's tabletop with a stand-in for the hourly backup; the backup time is given from the n-th tabletop on.
class HostLike extends LocalControl {
  readonly backupDir: string;
  readonly liveDir: string;
  readonly namedFrom: number;
  calls = 0;
  constructor(o: ConstructorParameters<typeof LocalControl>[0], backupDir: string, namedFrom: number) {
    super(o);
    this.backupDir = backupDir;
    this.liveDir = o.stateDir!;
    this.namedFrom = namedFrom;
  }
  override async tabletop(o: { readonly restore: boolean; readonly restoreFrom?: string }): Promise<Tabletop> {
    this.calls += 1;
    snapshotState(this.liveDir, this.backupDir);
    const t = await super.tabletop({ restore: o.restore, restoreFrom: this.backupDir });
    return this.calls >= this.namedFrom ? { ...t, backup: { name: `zeroed-stand-in-${this.calls}.tar.age`, at: Date.now() - 50 } } : t;
  }
}

describe('a. a self-reported host loss retries after the next backup', () => {
  const run = async (namedFrom: number) => {
    const dir = mkdtempSync(join(tmpdir(), 'run1f-'));
    const addr = `127.0.0.1:${await freePort()}`;
    const stateDir = join(dir, 'state');
    const evidenceDir = join(dir, 'ev');
    const control = new HostLike({
      entry: STUB_ENTRY, cwd: root, logPath: join(evidenceDir, 'logs', 'w.log'), stateDir, restartDelayMs: 200,
      env: { PATH: process.env['PATH'] ?? '', ZEROED_STATE_DIR: stateDir, ZEROED_MODE: 'paper', ZEROED_RECORDER: 'on', ZEROED_SIMULATE: 'on', ZEROED_DRILLS: 'on', ZEROED_HEALTH_ADDR: addr, ZEROED_GIT_SHA: 'c0ffee', ZEROED_STUB_TICK_MS: '50', ZEROED_STUB_CYCLE_MS: '60000', ZEROED_STUB_OPEN_AT_START: '1' },
    }, join(dir, 'backup'), namedFrom);
    const res = await runSegment({
      identity: { label: 'vps', commit: 'c0ffee' }, healthAddr: addr, stateDir, evidenceDir, keepRecorded: 'copy', sampleMs: 100, log: () => {}, handover: false,
      control, recoverMs: 6000, segmentEnd: Number.POSITIVE_INFINITY, hostDrills: 'tabletop', offsiteBackup: true, backupWindowMs: 300, hostRetryAfterMs: 1500,
      newRun: { runId: 'run', name: 'qual-1', targetMs: 20_000, entry: STUB_ENTRY, restarts: 3, causes: ['host-loss', 'crash', 'crash'], restartWindowMs: 500, rpcDrops: 0 },
    });
    return { r: res.report as Report, control };
  };

  it('tries again, labelled, and the compared retry exercises host loss', async () => {
    const { r, control } = await run(2);
    const tries = r.drills.filter((d) => d.cause === 'host-loss');
    expect(tries.map((d) => d.id)).toEqual(['restart-1', 'restart-1-retry-1']);
    expect(tries[0]).toMatchObject({ compared: false });
    expect(tries[0]!.notes).toContain(`tried again after the next backup (try 1 of ${HOST_LOSS_RETRIES})`);
    expect(tries[1]).toMatchObject({ compared: true, pass: true, keep: 1 });
    expect(control.calls).toBe(2);
    expect(r.recovery_by_cause['host-loss']).toMatchObject({ planned: 1, drills: 2, exercised: 1, self_reported: 1 });
    // The self-reported try stays in the table's label.
    expect(reportMarkdown(r)).toContain('(self-reported, not compared to the backup)');
  }, 60_000);

  it(`stops after ${HOST_LOSS_RETRIES} retries and says so; host loss is never exercised`, async () => {
    const { r, control } = await run(Number.POSITIVE_INFINITY);
    const tries = r.drills.filter((d) => d.cause === 'host-loss');
    expect(tries).toHaveLength(1 + HOST_LOSS_RETRIES);
    expect(control.calls).toBe(1 + HOST_LOSS_RETRIES);
    expect(tries.at(-1)!.notes).toContain(`no compared restore after ${HOST_LOSS_RETRIES} retries`);
    expect(r.recovery_by_cause['host-loss']!.exercised).toBe(0);
    expect(r.checks['drills_by_cause']).toBe(false);
  }, 60_000);
});

describe('b. the contract types what the runner reads', () => {
  it('journals `recovered` and `exit_capable` lines, typed', () => {
    expectTypeOf<'recovered'>().toExtend<JournalKind>();
    expectTypeOf<'exit_capable'>().toExtend<JournalKind>();
    expectTypeOf<RecoveredFields['source']>().toEqualTypeOf<'state' | 'chain'>();
    expectTypeOf<RecoveredFields['pending_exits']>().toEqualTypeOf<readonly string[]>();
    expectTypeOf<RecoveredFields['positions'][number]>().toEqualTypeOf<{ readonly trade: string; readonly universe: string }>();
  });
  it('health carries pending_exits, the open position\'s universe, exit_capable and the in-flight trade ids, required', () => {
    expectTypeOf<Health['pending_exits']>().toEqualTypeOf<readonly string[]>();
    expectTypeOf<NonNullable<Health['open_position']>['universe']>().toEqualTypeOf<string>();
    expectTypeOf<Health['exit_capable']>().toEqualTypeOf<boolean>();
    expectTypeOf<Health['unresolved_intents']['trades']>().toEqualTypeOf<readonly string[]>();
  });
});
