// End to end against the stub worker: the real runner, real child processes, real SIGKILLs, short timings.
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
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
        ...envOver,
      },
    });
  return { dir, addr, stateDir, evidenceDir, control };
};

const quiet = (): void => {};

describe('runner with the stub worker', () => {
  it('runs restart and feed drills, survives a job handover, and writes complete evidence', async () => {
    const t = await setup();
    const newRun = { runId: 'run', label: 'rehearsal' as const, commit: 'c0ffee', targetMs: 16_000, entry: STUB_ENTRY, restarts: 3, restartWindowMs: 2500, feedDropMs: 600 };
    const common = { healthAddr: t.addr, stateDir: t.stateDir, evidenceDir: t.evidenceDir, keepRecorded: 'copy' as const, sampleMs: 100, recoverMs: 5000, log: quiet };
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
      newRun: { runId: 'run', label: 'rehearsal', commit: 'c0ffee', targetMs: 5000, entry: STUB_ENTRY }, segmentEnd: Number.POSITIVE_INFINITY,
    });
    expect(res.aborted).toBe(`refused to run: ${problem}`);
    expect(existsSync(join(t.evidenceDir, 'run.json'))).toBe(false);
  }, 30_000);
});
