// CI-1 review (#105): what the runner may take off "what had to be kept", and when a backup copy counts.
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { STUB_ENTRY, type Health, type JournalLine } from '../src/contract.ts';
import { LocalControl } from '../src/control.ts';
import type { DrillOutcome } from '../src/report.ts';
import { closedSince, httpHealth, runSegment } from '../src/runner.ts';

const root = join(import.meta.dirname, '..', '..', '..');
const freePort = (): Promise<number> =>
  new Promise((res) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => res(p));
    });
  });

describe('a trade counts as closed only when its exit line closed the position', () => {
  const exit = (seq: number, trade: string, position: unknown, boot = 'b'): JournalLine =>
    ({ seq, ts: '2026-10-04T00:00:00.000Z', boot, kind: 'exit', trade, position, reasons: ['x'] }) as JournalLine;
  it('a partial exit (position still open) is not a close: the restart still had to keep it', () => {
    expect(closedSince([exit(5, 'p1', 'open')], 'b', 4)).toEqual([]);
    expect(closedSince([exit(5, 'p1', 'exit_pending')], 'b', 4)).toEqual([]);
    expect(closedSince([exit(5, 'p1', undefined)], 'b', 4)).toEqual([]);
  });
  it('a closing exit after the reply counts; one before it, or in another boot, does not', () => {
    expect(closedSince([exit(5, 'p1', 'open'), exit(6, 'p1', 'closed')], 'b', 4)).toEqual(['p1']);
    expect(closedSince([exit(4, 'p1', 'closed')], 'b', 4)).toEqual([]);
    expect(closedSince([exit(5, 'p1', 'closed', 'other')], 'b', 4)).toEqual([]);
    expect(closedSince([exit(5, 'p1', 'closed')], null, 4)).toEqual([]);
  });
});

describe('a backup copy counts only when the reply after it holds the same state', () => {
  // Every reply differs from the one before it (a new pending exit, or another boot): no copy can be confirmed, so
  // no backup is kept and the host-loss drill fails as having nothing to restore.
  const flip = (change: (h: Health, n: number) => Health) => {
    let n = 0;
    return async (addr: string): Promise<Health | null> => {
      const h = await httpHealth(addr);
      n += 1;
      return h && change(h, n);
    };
  };
  it.each([
    ['a new pending exit', (h: Health, n: number): Health => ({ ...h, pending_exits: [...h.pending_exits, `ghost-${n}`] })],
    ['a different boot', (h: Health, n: number): Health => ({ ...h, boot: `${h.boot}-${n}` })],
  ])('%s after the copy: no backup is taken, and host loss has nothing to restore', async (_, change) => {
    const dir = mkdtempSync(join(tmpdir(), 'ci1-'));
    const addr = `127.0.0.1:${await freePort()}`;
    const stateDir = join(dir, 'state');
    const evidenceDir = join(dir, 'ev');
    const control = new LocalControl({
      entry: STUB_ENTRY, cwd: root, logPath: join(evidenceDir, 'w.log'), stateDir, restartDelayMs: 200,
      env: { PATH: process.env['PATH'] ?? '', ZEROED_STATE_DIR: stateDir, ZEROED_MODE: 'paper', ZEROED_RECORDER: 'on', ZEROED_SIMULATE: 'on', ZEROED_DRILLS: 'on', ZEROED_HEALTH_ADDR: addr, ZEROED_GIT_SHA: 'c0ffee', ZEROED_STUB_TICK_MS: '50', ZEROED_STUB_CYCLE_MS: '60000', ZEROED_STUB_OPEN_AT_START: '1' },
    });
    await runSegment({
      identity: { label: 'rehearsal', commit: 'c0ffee' }, healthAddr: addr, stateDir, evidenceDir, keepRecorded: 'copy', sampleMs: 100, recoverMs: 6000,
      log: () => {}, control, segmentEnd: Date.now() + 5000, hostDrills: 'wipe', backupEveryMs: 300, fetchHealth: flip(change), handover: false,
      newRun: { runId: 'run', targetMs: 10_000, entry: STUB_ENTRY, restarts: 3, causes: ['host-loss', 'crash', 'crash'], restartWindowMs: 500, rpcDrops: 0 },
    });
    expect(existsSync(join(evidenceDir, 'backup.json'))).toBe(false);
    const drills = JSON.parse(readFileSync(join(evidenceDir, 'drills.json'), 'utf8')) as DrillOutcome[];
    expect(drills.find((d) => d.id === 'restart-1')).toMatchObject({ cause: 'host-loss', pass: false, notes: ["no backup to restore: the worker's state never held still for a copy"] });
  }, 40_000);
});
