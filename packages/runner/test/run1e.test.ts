// RUN-1e: the reviewer's follow-ups on #64 (tabletop ownership, a compared host-loss restore, pending-reboot cleanup,
// the tabletop worker's quota and journal, the no-strategy line).
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { STUB_ENTRY, type JournalLine } from '../src/contract.ts';
import { backupTime, LocalControl, SystemdControl } from '../src/control.ts';
import { HostLike } from './host-like.ts';
import { checkJournal } from '../src/journal.ts';
import { item4 } from '../src/item4.ts';
import { makePlan } from '../src/plan.ts';
import { buildReport, reportMarkdown, type DrillOutcome, type Kept, type Report, type RunMeta, type Sample } from '../src/report.ts';
import { keptAt, runSegment } from '../src/runner.ts';
import { OPS_OK } from './fixtures.ts';

const root = join(import.meta.dirname, '..', '..', '..');
const freePort = (): Promise<number> =>
  new Promise((res) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => res(p));
    });
  });
const quiet = (): void => {};

const setup = async (env: Record<string, string> = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'run1e-'));
  const addr = `127.0.0.1:${await freePort()}`;
  const stateDir = join(dir, 'state');
  const evidenceDir = join(dir, 'ev');
  const opts = {
    entry: STUB_ENTRY, cwd: root, logPath: join(evidenceDir, 'logs', 'w.log'), stateDir, restartDelayMs: 200,
    env: { PATH: process.env['PATH'] ?? '', ZEROED_STATE_DIR: stateDir, ZEROED_MODE: 'paper', ZEROED_RECORDER: 'on', ZEROED_SIMULATE: 'on', ZEROED_DRILLS: 'on', ZEROED_HEALTH_ADDR: addr, ZEROED_GIT_SHA: 'c0ffee', ZEROED_STUB_TICK_MS: '50', ...env },
  };
  const common = { identity: { label: 'rehearsal' as const, commit: 'c0ffee' }, healthAddr: addr, stateDir, evidenceDir, keepRecorded: 'copy' as const, sampleMs: 100, log: quiet, handover: false };
  return { dir, addr, stateDir, evidenceDir, opts, common };
};

describe('a. tabletop file ownership on the host', () => {
  it('hands the tabletop dir to zeroed-worker after every restore or empty start, so a second tabletop can read it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'run1e-table-'));
    const calls: string[] = [];
    const run = async (f: string, a: readonly string[]) => {
      calls.push(`${f} ${a.join(' ')}`);
      return f === '/bin/sh' ? { stdout: 'zeroed-20261004T010203Z.tar.age\n' } : undefined;
    };
    const c = new SystemdControl('zeroed-worker.service', run, dir);
    for (let i = 0; i < 2; i++) {
      calls.length = 0;
      expect(await c.tabletop({ restore: true })).toEqual({ healthAddr: '127.0.0.1:8789', stateDir: dir, backup: { name: 'zeroed-20261004T010203Z.tar.age', at: Date.parse('2026-10-04T01:02:03Z') } });
      expect(calls[0]).toMatch(/tar -x -C "\$1" --no-same-owner; basename "\$b"/);
      expect(calls.slice(1)).toEqual([`chown -R zeroed-worker:zeroed-worker ${dir}`, 'systemctl start zeroed-worker-tabletop.service']);
      await c.endTabletop();
    }
    calls.length = 0;
    await c.tabletop({ restore: false });
    expect(calls).toEqual([`chown -R zeroed-worker:zeroed-worker ${dir}`, 'systemctl start zeroed-worker-tabletop.service']);
  });
  it('reads a backup time only from the backup script\'s own name', () => {
    expect(backupTime('zeroed-20261004T010203Z.tar.age')).toBe(Date.parse('2026-10-04T01:02:03Z'));
    expect(backupTime('zeroed-latest.tar.age')).toBeNull();
    expect(backupTime('')).toBeNull();
  });
});

describe('b. the live worker\'s state when a host backup was taken', () => {
  const k = (trade: string | null, exits: string[] = []): Kept => ({ pending_exits: exits, positions: trade ? [{ trade, universe: 'U2' }] : [] });
  const s = (t: number, kept: Kept | null): Sample => ({ t, up: true, ready: true, boot: 'a', git_sha: 'c', rss_bytes: 1, in_trade: false, entries_halted: false, recorder: true, simulation: true, stub: true, feeds: 'f', feeds_down: [], kept });
  const at = 10_000;
  const steady = [8_600, 8_800, 9_000, 9_200, 9_400, 9_600, 9_800, 10_000, 10_200].map((t) => s(t, k('t1', ['t0'])));
  it('is the state the samples held, unchanged, across the backup window', () => {
    expect(keptAt(steady, at, 200, 1_000)).toEqual({ kept: k('t1', ['t0']) });
    // Order inside the lists does not matter.
    expect(keptAt(steady.map((x, i) => (i === 3 ? { ...x, kept: { pending_exits: ['t0'], positions: [{ trade: 't1', universe: 'U2' }] } } : x)), at, 200, 1_000)).toEqual({ kept: k('t1', ['t0']) });
  });
  it.each([
    ['the state changed during the backup', steady.map((x) => (x.t === 9_400 ? { ...x, kept: k(null, ['t0']) } : x)), /changed while the backup was taken/],
    ['a universe changed during the backup', steady.map((x) => (x.t === 9_400 ? { ...x, kept: { pending_exits: ['t0'], positions: [{ trade: 't1', universe: 'U3' }] } } : x)), /changed while the backup was taken/],
    ['an invalid reply in the window', steady.map((x) => (x.t === 9_400 ? { ...x, kept: null } : x)), /missing or invalid reply/],
    ['a gap in the samples', steady.filter((x) => x.t !== 9_400 && x.t !== 9_600), /gap in the samples/],
    ['samples that start after the window opens', steady.filter((x) => x.t >= 9_400), /no samples around the backup/],
    ['samples that end before the backup', steady.filter((x) => x.t <= 9_600), /no samples around the backup/],
  ])('cannot be known when %s', (_, samples, why) => {
    const r = keptAt(samples, at, 200, 1_000);
    expect('why' in r && r.why).toMatch(why);
  });
});

describe('b–d. a host-loss tabletop on the host, end to end', () => {
  const hostRun = async (restoreEmpty: boolean, named: boolean) => {
    // A position open from the first tick and held (no exit within the run), so the state is steady around the backup.
    const t = await setup({ ZEROED_STUB_CYCLE_MS: '60000', ZEROED_STUB_OPEN_AT_START: '1' });
    const control = new HostLike(t.opts, { backupDir: join(t.dir, 'backup'), evidenceDir: t.evidenceDir, restoreEmpty, namedFrom: named ? 1 : Number.POSITIVE_INFINITY, sampleMs: 100, windowMs: 300 });
    const res = await runSegment({
      ...t.common, control, recoverMs: 6000, segmentEnd: Number.POSITIVE_INFINITY, hostDrills: 'tabletop', offsiteBackup: true, backupWindowMs: 300,
      newRun: { runId: 'run', targetMs: 20_000, entry: STUB_ENTRY, restarts: 3, causes: ['host-loss', 'crash', 'crash'], restartWindowMs: 500, rpcDrops: 0 },
    });
    const r = res.report as Report;
    return { t, r, d: r.drills.find((x) => x.id === 'restart-1')! };
  };

  it('compares the restore with what the live worker held when the backup was taken', async () => {
    const { t, r, d } = await hostRun(false, true);
    expect(d).toMatchObject({ cause: 'host-loss', off_run: true, compared: true, pass: true, keep: 1 });
    expect(d.notes).toContain("compared with the live worker's state when zeroed-stand-in-1.tar.age was taken");
    expect(d.state!.missing).toEqual([]);
    expect(r.recovery_by_cause['host-loss']).toMatchObject({ exercised: 1, self_reported: 0 });
    // d. The tabletop worker's quota is sampled like any boot, and its journal is kept as evidence.
    const tj = readFileSync(join(t.evidenceDir, 'tabletop', 'restart-1-journal.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as JournalLine);
    const tableBoot = tj.find((l) => l.kind === 'recovered')!.boot;
    const boots = JSON.parse(readFileSync(join(t.evidenceDir, 'boots.json'), 'utf8')) as Record<string, { quota: unknown[] }>;
    expect(boots[tableBoot]?.quota.length).toBeGreaterThan(0);
  }, 60_000);

  it('fails a restore that lost what the live worker held at the backup', async () => {
    const { d } = await hostRun(true, true);
    expect(d).toMatchObject({ cause: 'host-loss', compared: true, pass: false, keep: 1 });
    expect(d.state!.missing.join(' ')).toMatch(/^position /);
  }, 60_000);

  it('without the backup\'s time, says the restore is self-reported, not compared', async () => {
    const { r, d } = await hostRun(false, false);
    expect(d).toMatchObject({ cause: 'host-loss', compared: false });
    expect(d.notes).toContain('self-reported, not compared to the backup (the restored backup is not known)');
    expect(r.recovery_by_cause['host-loss']!.self_reported).toBe(1);
    expect(reportMarkdown(r)).toMatch(/\| host-loss \(tabletop beside the run\) \(self-reported, not compared to the backup\) \|/);
  }, 60_000);
});

describe('c. pending-reboot.json', () => {
  it('is deleted when its drill is recorded in the same segment that wrote it (the reboot never came)', async () => {
    const t = await setup({ ZEROED_STUB_CYCLE_MS: '1000' });
    // On the host a reboot drill writes the file, then asks for the reboot. Here the reboot never happens.
    class NoReboot extends LocalControl {
      override async reboot(): Promise<void> {}
    }
    await runSegment({
      ...t.common, control: new NoReboot(t.opts), recoverMs: 800, segmentEnd: Date.now() + 4000, hostDrills: 'tabletop', offsiteBackup: false,
      newRun: { runId: 'r', targetMs: 20_000, entry: STUB_ENTRY, restarts: 3, causes: ['reboot', 'crash', 'crash'], restartWindowMs: 300, rpcDrops: 0 },
    });
    const drills = JSON.parse(readFileSync(join(t.evidenceDir, 'drills.json'), 'utf8')) as DrillOutcome[];
    expect(drills.find((d) => d.id === 'restart-1')).toMatchObject({ cause: 'reboot', pass: false });
    expect(existsSync(join(t.evidenceDir, 'pending-reboot.json'))).toBe(false);
  }, 40_000);

  it('a loaded drill already recorded is dropped, never run or recorded twice', async () => {
    const t = await setup({ ZEROED_STUB_CYCLE_MS: '1000' });
    await runSegment({ ...t.common, control: new LocalControl(t.opts), recoverMs: 6000, segmentEnd: Date.now() + 800, newRun: { runId: 'r', targetMs: 120_000, entry: STUB_ENTRY, restarts: 3, causes: ['reboot', 'crash', 'crash'], rpcDrops: 0 } });
    const plan = (JSON.parse(readFileSync(join(t.evidenceDir, 'run.json'), 'utf8')) as { plan: { id: string; atMs: number }[] }).plan;
    const done: DrillOutcome = { id: 'restart-1', kind: 'restart', cause: 'reboot', plannedAt: 0, at: Date.now() - 5000, pass: true, keep: 1, notes: ['recorded before the runner stopped'] };
    writeFileSync(join(t.evidenceDir, 'drills.json'), JSON.stringify([done]));
    writeFileSync(join(t.evidenceDir, 'pending-reboot.json'), JSON.stringify({ kind: 'restart', drill: plan.find((d) => d.id === 'restart-1'), since: Date.now() - 6000, killedAt: Date.now() - 5000, prevBoot: 'gone', open: false, trades: [], tradesComplete: true, killValid: true, keep: 1, atKill: { pending_exits: [], positions: [] }, expect: { pending_exits: [], positions: [] } }));
    await runSegment({ ...t.common, control: new LocalControl(t.opts), recoverMs: 6000, segmentEnd: Date.now() + 1500 });
    expect(existsSync(join(t.evidenceDir, 'pending-reboot.json'))).toBe(false);
    const drills = JSON.parse(readFileSync(join(t.evidenceDir, 'drills.json'), 'utf8')) as DrillOutcome[];
    expect(drills.filter((d) => d.id === 'restart-1')).toEqual([done]);
  }, 40_000);
});

describe('e. a VPS run on --strategy none', () => {
  const plan = makePlan({ durationMs: 100, feeds: ['f'], restartWindowMs: 1, feedDropMs: 1 });
  const meta = (o: Partial<RunMeta>): RunMeta => ({ runId: 'r', label: 'vps', commit: 'c0ffee', startedAt: 0, targetMs: 100, entry: 'e', plan, ...o });
  const start = (entry_rule: string, at: number) => checkJournal(JSON.stringify({ seq: 1, ts: new Date(at).toISOString(), boot: 'b1', kind: 'start', entry_rule, paper_edge_ppm: null, s0_salt: null, qualifying: true }));
  const md = (m: RunMeta, rule: string) => {
    const observed: Sample = { t: m.startedAt, up: true, ready: true, boot: 'b1', git_sha: 'c0ffee', rss_bytes: 1, in_trade: false, entries_halted: false, recorder: true, simulation: true, stub: false, feeds: 'f', feeds_down: [] };
    const r = buildReport(m, [observed], 10, 100, start(rule, m.startedAt), [], [], item4([], 'vps', false), OPS_OK);
    return { r, md: reportMarkdown(r) };
  };
  it('says "no registered strategy, not qualifying"', () => {
    const named = md(meta({ name: 'qual-1', strategy: 'none' }), 'none');
    expect(named.md).toContain('**No registered strategy, not qualifying.**');
    expect(named.r.counts).toBe('NOT qualifying: no registered strategy (--strategy none).');
    // A VPS run without a name says it too, and never passes qualifying_start.
    const unnamed = md(meta({}), 'none');
    expect(unnamed.md).toContain('**No registered strategy, not qualifying.**');
    expect(unnamed.r.checks['qualifying_start']).toBe(false);
  });
  it('not said for a rehearsal, or for a run on another strategy', () => {
    expect(md(meta({ label: 'rehearsal' }), 'none').md).not.toContain('No registered strategy');
    expect(md(meta({ name: 'qual-1', strategy: 'U2-v1' }), 'U2-v1').md).not.toContain('No registered strategy');
  });
});
