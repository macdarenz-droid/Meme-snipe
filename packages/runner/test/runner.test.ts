// End to end against the stub worker: the real runner, real child processes, real SIGKILLs, short timings.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { STUB_ENTRY } from '../src/contract.ts';
import { LocalControl } from '../src/control.ts';
import type { Report } from '../src/report.ts';
import { runSegment } from '../src/runner.ts';
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

describe('runner with the stub worker', () => {
  it('runs restart and feed drills, survives a job handover, and writes complete evidence', async () => {
    const t = await setup();
    const newRun = { runId: 'run', targetMs: 16_000, entry: STUB_ENTRY, restarts: 3, restartWindowMs: 2500, feedDropMs: 600 };
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
    // Only two checks fail: it is the stub, and in a 16 s run three kills and a handover are well over 1% down time.
    expect(Object.entries(r.checks).filter(([, v]) => !v).map(([k]) => k).sort()).toEqual(['real_worker', 'uptime']);
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
