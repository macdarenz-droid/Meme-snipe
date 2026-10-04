// End to end against the stub worker: the real runner, real child processes, real SIGKILLs, short timings.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type Health, STUB_ENTRY } from '../src/contract.ts';
import { LocalControl } from '../src/control.ts';
import { reportMarkdown, type DrillOutcome, type Report } from '../src/report.ts';
import { httpHealth, runSegment } from '../src/runner.ts';
import { scanPaths } from '../src/scan.ts';

const root = join(import.meta.dirname, '..', '..', '..');
const freePort = (): Promise<number> =>
  new Promise((res) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => res(p));
    });
  });

const FAKE = { HELIUS_API_KEY: 'test-helius-0123456789', ALCHEMY_API_KEY: 'test-alchemy-0123456789', JUPITER_API_KEY: 'test-jup-0123456789', TELEGRAM_BOT_TOKEN: '123:test-telegram-token' };

const setup = async (envOver: Record<string, string> = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'run1-'));
  const addr = `127.0.0.1:${await freePort()}`;
  const stateDir = join(dir, 'state');
  const evidenceDir = join(dir, 'evidence', 'run');
  const control = () =>
    new LocalControl({
      entry: STUB_ENTRY,
      cwd: root,
      logPath: join(evidenceDir, 'logs', 'worker.log'),
      stateDir,
      restartDelayMs: 200,
      env: {
        PATH: process.env['PATH'] ?? '',
        ...FAKE,
        ZEROED_STATE_DIR: stateDir,
        ZEROED_MODE: 'paper',
        ZEROED_RECORDER: 'on',
        ZEROED_SIMULATE: 'on',
        ZEROED_DRILLS: 'on',
        ZEROED_HEALTH_ADDR: addr,
        ZEROED_GIT_SHA: 'c0ffee',
        ZEROED_STUB_TICK_MS: '50',
        ZEROED_STUB_CYCLE_MS: '1000',
        ZEROED_STUB_EXIT_DELAY_MS: '300',
        ...envOver,
      },
    });
  return { dir, addr, stateDir, evidenceDir, control };
};

const quiet = (): void => {};
/** Health replies handed to the runner `ms` after the worker wrote them. */
const staleHealth = (ms: number) => async (addr: string) => {
  const h = await httpHealth(addr);
  if (ms > 0) await new Promise((r) => setTimeout(r, ms));
  return h;
};

describe('runner with the stub worker', () => {
  it('runs restart and feed drills, survives a job handover, and writes complete evidence', async () => {
    const t = await setup();
    const newRun = { runId: 'run', targetMs: 16_000, entry: STUB_ENTRY, restarts: 3, causes: ['crash', 'crash', 'crash'] as const, restartWindowMs: 2500, feedDropMs: 600, rpcDrops: 0 };
    const common = { identity: { label: 'rehearsal' as const, commit: 'c0ffee' }, healthAddr: t.addr, stateDir: t.stateDir, evidenceDir: t.evidenceDir, keepRecorded: 'copy' as const, sampleMs: 100, recoverMs: 5000, log: quiet };
    // Job 1 stops part-way, like a GitHub job at its time limit; job 2 restores and finishes.
    const first = await runSegment({ ...common, control: t.control(), newRun, segmentEnd: Date.now() + 8000, recordedDir: join(t.dir, 'rec1'), recordedArtifact: 'rec1' });
    expect(first).toMatchObject({ done: false, aborted: null, report: null });
    expect(existsSync(join(t.stateDir, 'clean_stop'))).toBe(true);
    const second = await runSegment({ ...common, control: t.control(), segmentEnd: Number.POSITIVE_INFINITY, recordedDir: join(t.dir, 'rec2'), recordedArtifact: 'rec2' });
    expect(second.done).toBe(true);
    const r = second.report as Report;

    const byKind = (k: string) => r.drills.filter((d) => d.kind === k);
    expect(byKind('restart')).toHaveLength(3);
    expect(byKind('restart').every((d) => d.pass && d.midTrade === true)).toBe(true);
    expect(byKind('handover')).toHaveLength(1);
    expect(byKind('handover')[0]!.pass).toBe(true);
    expect(r.drills_summary.feeds_passed).toEqual(['alchemy-ws', 'helius-ws', 'pumpportal']);
    expect(r.journal.complete).toBe(true);
    expect(r.journal.boots).toBeGreaterThanOrEqual(5);
    expect(r.journal.entries).toBeGreaterThan(3);
    expect(r.recorded.files).toBeGreaterThanOrEqual(5);
    expect(r.commit).toBe('c0ffee');
    expect(r.label).toBe('rehearsal');
    // Only three checks fail: it is the stub; in a 16 s run three kills and a handover are well over 1% down time;
    // and this run plans crashes only, so the other causes were not drilled (the all-causes run below covers them).
    expect(Object.entries(r.checks).filter(([, v]) => !v).map(([k]) => k).sort()).toEqual(['drills_by_cause', 'real_worker', 'uptime']);
    for (const d of r.drills.filter((x) => x.kind === 'restart')) {
      expect(d).toMatchObject({ cause: 'crash', state: { state_ok: true, universe_ok: true, source: 'state' } });
      expect(d.recovery!.clock).toBe('monotonic');
      expect(d.recovery!.exit_capable_ms!).toBeGreaterThanOrEqual(d.recovery!.reconciled_ms!);
    }
    expect(r.uptime).toBeGreaterThan(0.5);
    expect(r.item4).toMatchObject({ counts: false, bounds_pass: true, pass: false, note: 'Rehearsal: does not count for item 4.' });
    expect(r.item4.outcomes).toEqual({ simulated: r.journal.simulations });
    expect(r.item4.trades).toBe(r.journal.simulations);
    // RUN-1c: quota, coverage, rejections and exposure come through from the worker's health and journal.
    expect(r.ops.quota).toMatchObject({ reported: true, problems: [], within_free_tier: true, exit_capacity_shed: 0 });
    expect(r.ops.quota.providers.map((p) => p.provider)).toEqual(['alchemy', 'helius', 'jupiter']);
    expect(r.ops.coverage.problems).toEqual([]);
    // Every stream has at least its feed drop plus the kills' down windows.
    for (const s of ['creates', 'rugs', 'trades']) expect(r.ops.coverage.streams[s]!.gaps).toBeGreaterThan(1);
    expect(r.ops.lookups.count).toBeGreaterThan(0);
    expect(r.ops.rejections.decisions).toBeGreaterThan(0);
    const exposed = r.drills.filter((d) => d.exposure);
    expect(exposed.length).toBeGreaterThan(0);
    for (const d of exposed) {
      expect(d.exposure!.duration_ms).toBeGreaterThanOrEqual(300);
      expect(d.exposure!.duration_ms!).toBeGreaterThanOrEqual(d.exposure!.reconciled_ms!);
      expect(d.exposure!.worst_move_bps).toBe(0);
      expect(d.exposure!.chain_trades).toEqual([...d.exposure!.trades].sort());
      expect(d.exposure!.trades_complete).toBe(true);
    }
    expect(r.pass).toBe(false);
    expect(readFileSync(join(t.evidenceDir, 'REPORT.md'), 'utf8')).toContain('Rehearsal: counts for none of §15 items 3, 4 or G3');

    // Recorded data moved out of the state carried between jobs, listed with hashes.
    expect(readdirSync(join(t.stateDir, 'recorder'))).toEqual([]);
    const manifest = JSON.parse(readFileSync(join(t.evidenceDir, 'recorded.json'), 'utf8')) as { kept: string; sha256: string }[];
    expect(new Set(manifest.map((m) => m.kept))).toEqual(new Set(['rec1', 'rec2']));
    expect(manifest.every((m) => /^[0-9a-f]{64}$/.test(m.sha256))).toBe(true);

    // The secrets were in the worker's environment; none reached evidence, state, logs or recorded data.
    expect(scanPaths([t.dir], new Map(Object.entries(FAKE)))).toEqual([]);
    writeFileSync(join(t.evidenceDir, 'logs', 'planted.log'), `url=https://x/?api-key=${FAKE.HELIUS_API_KEY}`);
    expect(scanPaths([t.dir], new Map(Object.entries(FAKE))).map((f) => f.what)).toEqual(['HELIUS_API_KEY']);
  }, 60_000);

  // CI-1: under parallel load a reply describes the worker a moment before the runner acts on it (the trade it shows
  // may close before the kill or the copy). 150 ms old replies reproduced it every time; the runner must not care.
  it.each([['fresh replies', 0], ['replies 150 ms old (a loaded runner)', 150]])('drills every cause: crash, reboot, host loss from backup, chain rebuild and RPC loss, %s', async (_, staleMs) => {
    const t = await setup();
    const res = await runSegment({
      identity: { label: 'rehearsal', commit: 'c0ffee' }, healthAddr: t.addr, stateDir: t.stateDir, evidenceDir: t.evidenceDir, keepRecorded: 'copy', fetchHealth: staleHealth(staleMs),
      sampleMs: 100, recoverMs: 6000, log: quiet, control: t.control(), segmentEnd: Number.POSITIVE_INFINITY, hostDrills: 'wipe', backupEveryMs: 1500,
      newRun: { runId: 'run', targetMs: 24_000, entry: STUB_ENTRY, restarts: 6, restartWindowMs: 2000, feedDropMs: 500, rpcDrops: 1, rpcDropMs: 700 },
    });
    const r = res.report as Report;
    const c = r.recovery_by_cause;
    for (const cause of ['crash', 'reboot', 'host-loss', 'chain-rebuild', 'rpc']) {
      expect(c[cause]!.planned).toBeGreaterThan(0);
      expect(c[cause]!.passed).toBe(c[cause]!.drills);
      expect(c[cause]!.exit_capable_ms.worst).not.toBeNull();
    }
    expect(r.checks).toMatchObject({ drills_by_cause: true, recovered_state: true, restored_universe_kept: true, every_drill_passed: true, journal_complete: true });
    const byCause = (k: string) => r.drills.filter((d) => d.cause === k);
    for (const d of byCause('host-loss')) expect(d.state).toMatchObject({ state_ok: true, source: 'state' });
    for (const d of byCause('chain-rebuild')) {
      expect(d.state).toMatchObject({ state_ok: true, source: 'chain' });
      // A paper position open at the wipe is reported lost, never silently.
      if (d.midTrade) expect(d.state!.notes.join(' ')).toMatch(/paper position\(s\) lost|^reconciled/);
    }
    expect(reportMarkdown(r)).toContain("## Recovery by cause");
  }, 90_000);

  // Root cause of the intermittent "drills every cause" failure (supervisor card, 2026-10-05): under load a reply can
  // show a trade that closes before the kill. That drill has nothing to keep, so it passes but does not exercise its
  // cause, and a cause planned once then failed drills_by_cause. Here it happens on purpose: while the boot the reboot
  // drill kills is up, every trade is shown only once it has closed, so that kill always finds nothing to keep.
  it('a restart that kills with nothing to keep is tried again, so its cause is still exercised (drills_by_cause)', async () => {
    const t = await setup();
    const boots = new Set<string>();
    let held: Health | null = null;
    const lateTrades = async (addr: string): Promise<Health | null> => {
      const h = await httpHealth(addr);
      if (h === null) return h;
      boots.add(h.boot);
      // The second boot is the one the reboot drill kills (a crash first); every other boot is shown as it is.
      if (boots.size !== 2 || h.boot !== [...boots][1]) return h;
      const open = h.open_position !== null || h.unresolved_intents.count > 0;
      if (open) {
        held ??= h;
        return { ...h, open_position: null, open_positions: [], pending_exits: [], unresolved_intents: { ...h.unresolved_intents, count: 0, oldest_age_s: null, trades: [] } };
      }
      // Closed: the reply that showed it open arrives now, too late.
      const late = held;
      held = null;
      return late ?? h;
    };
    const res = await runSegment({
      identity: { label: 'rehearsal', commit: 'c0ffee' }, healthAddr: t.addr, stateDir: t.stateDir, evidenceDir: t.evidenceDir, keepRecorded: 'copy', fetchHealth: lateTrades,
      sampleMs: 100, recoverMs: 6000, log: quiet, control: t.control(), segmentEnd: Number.POSITIVE_INFINITY, hostDrills: 'wipe', backupEveryMs: 1500,
      newRun: { runId: 'run', targetMs: 24_000, entry: STUB_ENTRY, restarts: 4, causes: ['crash', 'reboot', 'host-loss', 'chain-rebuild'] as const, restartWindowMs: 2000, feedDropMs: 500, rpcDrops: 1, rpcDropMs: 700 },
    });
    const r = res.report as Report;
    const reboots = r.drills.filter((d) => d.kind === 'restart' && d.cause === 'reboot');
    // The planned reboot passed with nothing to keep, and was tried again.
    expect(reboots[0]).toMatchObject({ pass: true, keep: 0 });
    expect(reboots[0]!.notes.join(' ')).toContain('nothing to keep at the kill: tried again (try 1 of 3)');
    expect(reboots.length).toBeGreaterThan(1);
    expect(reboots.at(-1)!.id).toMatch(/^restart-2-retry-\d$/);
    expect(r.recovery_by_cause['reboot']!.exercised).toBeGreaterThan(0);
    expect(r.checks).toMatchObject({ drills_by_cause: true, every_drill_passed: true, recovered_state: true });
  }, 90_000);

  it.each([['fresh replies', 0], ['replies 150 ms old (a loaded runner)', 150]])('on the qualifying host, host loss and chain rebuild run as a reconcile-only tabletop beside the live worker, %s', async (_, staleMs) => {
    const t = await setup();
    const control = t.control();
    const res = await runSegment({
      identity: { label: 'rehearsal', commit: 'c0ffee' }, healthAddr: t.addr, stateDir: t.stateDir, evidenceDir: t.evidenceDir, keepRecorded: 'copy', fetchHealth: staleHealth(staleMs),
      sampleMs: 100, recoverMs: 6000, log: quiet, control, segmentEnd: Number.POSITIVE_INFINITY, hostDrills: 'tabletop', offsiteBackup: false, backupEveryMs: 1000,
      newRun: { runId: 'run', targetMs: 12_000, entry: STUB_ENTRY, restarts: 3, causes: ['host-loss', 'chain-rebuild', 'crash'], restartWindowMs: 1500, rpcDrops: 0 },
    });
    const r = res.report as Report;
    const table = r.drills.filter((d) => d.cause === 'host-loss' || d.cause === 'chain-rebuild');
    expect(table).toHaveLength(2);
    for (const d of table) {
      expect(d).toMatchObject({ off_run: true, pass: true, recovery: { clock: 'monotonic' } });
      expect(d.notes).toContain('tabletop beside the qualifying run: the live worker kept running');
      expect(d.notes.join(' ')).toMatch(/off-site backup is off/);
    }
    expect(table.find((d) => d.cause === 'chain-rebuild')!.state!.source).toBe('chain');
    // The live worker was never stopped by either tabletop: one boot until the crash drill.
    // One boot for the start and one for the live crash drill, plus one for each try of a live restart that passed with
    // nothing to keep (RUN-1d's unexercised retry); every such try follows a drill that kept nothing.
    const tries = r.drills.filter((d) => d.kind === 'restart' && d.off_run !== true && /-retry-\d+$/.test(d.id));
    for (const d of tries) {
      const n = Number(/-retry-(\d+)$/.exec(d.id)![1]);
      const root = d.id.replace(/-retry-\d+$/, '');
      const before = r.drills.find((x) => x.id === (n === 1 ? root : `${root}-retry-${n - 1}`))!;
      expect(before).toMatchObject({ pass: true, keep: 0 });
    }
    expect(r.journal.boots).toBe(2 + tries.length);
    expect(r.checks).toMatchObject({ recovered_state: true, restored_universe_kept: true, journal_complete: true });
    expect(reportMarkdown(r)).toContain('(tabletop beside the run)');
  }, 60_000);

  it('finishes a host reboot drill after the runner itself comes back, timed on the wall clock', async () => {
    const t = await setup();
    const common = { identity: { label: 'rehearsal' as const, commit: 'c0ffee' }, healthAddr: t.addr, stateDir: t.stateDir, evidenceDir: t.evidenceDir, keepRecorded: 'copy' as const, sampleMs: 100, recoverMs: 6000, log: quiet, handover: false };
    const newRun = { runId: 'run', targetMs: 60_000, entry: STUB_ENTRY, restarts: 3, causes: ['reboot', 'crash', 'crash'] as const, restartWindowMs: 500, rpcDrops: 0 };
    await runSegment({ ...common, control: t.control(), newRun, segmentEnd: Date.now() + 1500 });
    const meta = JSON.parse(readFileSync(join(t.evidenceDir, 'run.json'), 'utf8')) as { plan: { id: string }[] };
    const samples = readFileSync(join(t.evidenceDir, 'samples.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { boot: string });
    // What the runner wrote before the host went down (it dies with the host, so no monotonic time survives).
    writeFileSync(join(t.evidenceDir, 'pending-reboot.json'), JSON.stringify({
      kind: 'restart', drill: meta.plan.find((d) => d.id === 'restart-1'), since: Date.now() - 3000, killedAt: Date.now() - 2000,
      prevBoot: samples.at(-1)!.boot, midTrade: false, open: false, trades: [], tradesComplete: true, markBefore: null,
      atKill: { pending_exits: [], positions: [] }, expect: { pending_exits: [], positions: [] },
    }));
    await runSegment({ ...common, control: t.control(), segmentEnd: Date.now() + 2500 });
    const drills = JSON.parse(readFileSync(join(t.evidenceDir, 'drills.json'), 'utf8')) as DrillOutcome[];
    const d = drills.find((x) => x.id === 'restart-1')!;
    expect(d).toMatchObject({ cause: 'reboot', pass: true, recovery: { clock: 'wall' } });
    expect(d.recovery!.exit_capable_ms!).toBeGreaterThanOrEqual(2000);
    expect(d.notes).toContain('timed on the wall clock across the reboot, from the journal');
    expect(existsSync(join(t.evidenceDir, 'pending-reboot.json'))).toBe(false);
  }, 60_000);

  it.each([
    ['recorder', { ZEROED_RECORDER: 'off' }, 'recorder off'],
    ['simulation', { ZEROED_SIMULATE: 'off' }, 'simulation off'],
  ])('refuses to start a run with the %s off', async (_, env, problem) => {
    const t = await setup(env);
    const res = await runSegment({
      control: t.control(), healthAddr: t.addr, stateDir: t.stateDir, evidenceDir: t.evidenceDir, keepRecorded: 'copy', sampleMs: 100, log: quiet,
      identity: { label: 'rehearsal', commit: 'c0ffee' }, newRun: { runId: 'run', targetMs: 5000, entry: STUB_ENTRY }, segmentEnd: Number.POSITIVE_INFINITY,
    });
    expect(res.aborted).toBe(`refused to run: ${problem}`);
    expect(existsSync(join(t.evidenceDir, 'run.json'))).toBe(false);
  }, 30_000);

  it.each([
    ['a "vps" label', { label: 'vps' }],
    ['another commit', { commit: 'beef' }],
  ])('refuses to resume restored state that claims %s, before starting the worker', async (_, forged) => {
    const t = await setup();
    mkdirSync(t.evidenceDir, { recursive: true });
    writeFileSync(join(t.evidenceDir, 'run.json'), JSON.stringify({ runId: 'run', label: 'rehearsal', commit: 'c0ffee', startedAt: Date.now(), targetMs: 60_000, entry: STUB_ENTRY, plan: [], ...forged }));
    const control = t.control();
    const res = await runSegment({
      control, healthAddr: t.addr, stateDir: t.stateDir, evidenceDir: t.evidenceDir, keepRecorded: 'copy', sampleMs: 100, log: quiet,
      identity: { label: 'rehearsal', commit: 'c0ffee' }, segmentEnd: Number.POSITIVE_INFINITY,
    });
    expect(res.aborted).toMatch(/^refused to resume/);
    expect(res.report).toBeNull();
    expect(control.starts).toBe(0);
    expect(existsSync(join(t.stateDir, 'journal.jsonl'))).toBe(false);
    expect(existsSync(join(t.evidenceDir, 'report.json'))).toBe(false);
    expect(existsSync(join(t.evidenceDir, 'REPORT.md'))).toBe(false);
  }, 30_000);

  it('refuses to resume a run that already has its final report, and leaves that report alone', async () => {
    const t = await setup();
    mkdirSync(t.evidenceDir, { recursive: true });
    writeFileSync(join(t.evidenceDir, 'run.json'), JSON.stringify({ runId: 'run', label: 'rehearsal', commit: 'c0ffee', startedAt: Date.now(), targetMs: 60_000, entry: STUB_ENTRY, plan: [] }));
    writeFileSync(join(t.evidenceDir, 'report.json'), '{"final":true}');
    const control = t.control();
    const res = await runSegment({
      control, healthAddr: t.addr, stateDir: t.stateDir, evidenceDir: t.evidenceDir, keepRecorded: 'copy', sampleMs: 100, log: quiet,
      identity: { label: 'rehearsal', commit: 'c0ffee' }, segmentEnd: Number.POSITIVE_INFINITY,
    });
    expect(res.aborted).toBe('refused to resume: the run already has its final report');
    expect(control.starts).toBe(0);
    expect(readFileSync(join(t.evidenceDir, 'report.json'), 'utf8')).toBe('{"final":true}');
  }, 30_000);
});

describe('stub worker contract', () => {
  const run = (args: string[], env: Record<string, string>) =>
    spawnSync(process.execPath, ['--no-warnings', STUB_ENTRY, ...args], { cwd: root, encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '', ZEROED_STATE_DIR: mkdtempSync(join(tmpdir(), 'run1-stub-')), ...env }, timeout: 10_000 });
  it('exits 2 when ZEROED_MODE is unset or not paper', () => {
    expect(run(['--reconcile'], {}).status).toBe(2);
    expect(run(['--reconcile'], { ZEROED_MODE: 'live' }).status).toBe(2);
    expect(run(['--reconcile'], { ZEROED_MODE: 'paper' }).status).toBe(0);
  });
  it('exits 3 when reconcile fails, in --reconcile and at start, instead of serving reconciled: false', () => {
    const env = { ZEROED_MODE: 'paper', ZEROED_STUB_FAIL_RECONCILE: '1', ZEROED_HEALTH_ADDR: '127.0.0.1:18799' };
    expect(run(['--reconcile'], env).status).toBe(3);
    expect(run([], env).status).toBe(3);
  });
});

describe('recorded files', () => {
  it('lists the real worker\'s per-boot dataset folders by their path, and flat stub files', async () => {
    const { mkdtempSync, mkdirSync: mk, writeFileSync: wr } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { recordedFiles } = await import('../src/runner.ts');
    const dir = mkdtempSync(join(tmpdir(), 'recorded-'));
    mk(join(dir, 'b1', 'days', '2026-10-03'), { recursive: true });
    wr(join(dir, 'b1', 'manifest.json'), '{}');
    wr(join(dir, 'b1', 'days', '2026-10-03', 'frames-000.jsonl.zst'), 'x');
    wr(join(dir, 'stub.jsonl'), 'y');
    expect(recordedFiles(dir)).toEqual(['b1/days/2026-10-03/frames-000.jsonl.zst', 'b1/manifest.json', 'stub.jsonl']);
  });
});
