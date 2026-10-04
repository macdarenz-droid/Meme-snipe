// CI-1 review (#105): what the runner may take off "what had to be kept", and when a backup copy counts.
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { STUB_ENTRY, type Health, type JournalLine } from '../src/contract.ts';
import { LocalControl } from '../src/control.ts';
import type { DrillOutcome } from '../src/report.ts';
import { closedSince, heldAtKill, httpHealth, openedSince, runSegment } from '../src/runner.ts';

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

describe('a trade that closed between the reply and the kill', () => {
  it('nothing left held means no trade was open at the kill', () => {
    expect(heldAtKill({ pending_exits: [], positions: [] }, 0)).toBe(false);
    expect(heldAtKill({ pending_exits: [], positions: [] }, 1)).toBe(true);
    expect(heldAtKill({ pending_exits: ['t'], positions: [] }, 0)).toBe(true);
  });

  it('is not a mid-trade kill and exposes nothing (the reply still showed it open)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci1-closed-'));
    const addr = `127.0.0.1:${await freePort()}`;
    const stateDir = join(dir, 'state');
    const evidenceDir = join(dir, 'ev');
    // The first reply with an open position is handed back unchanged for 2 s: by the kill the stub (1 s cycle) has
    // closed that trade, as a reply delayed by a loaded runner would hide.
    let frozen: { h: Health; until: number } | null = null;
    const fetchHealth = async (a: string): Promise<Health | null> => {
      const h = await httpHealth(a);
      if (frozen && h?.boot === frozen.h.boot && Date.now() < frozen.until) return frozen.h;
      if (frozen === null && h?.open_position) frozen = { h, until: Date.now() + 2000 };
      return h;
    };
    const control = new LocalControl({
      entry: STUB_ENTRY, cwd: root, logPath: join(evidenceDir, 'w.log'), stateDir, restartDelayMs: 200,
      env: { PATH: process.env['PATH'] ?? '', ZEROED_STATE_DIR: stateDir, ZEROED_MODE: 'paper', ZEROED_RECORDER: 'on', ZEROED_SIMULATE: 'on', ZEROED_DRILLS: 'on', ZEROED_HEALTH_ADDR: addr, ZEROED_GIT_SHA: 'c0ffee', ZEROED_STUB_TICK_MS: '50', ZEROED_STUB_CYCLE_MS: '1000', ZEROED_STUB_EXIT_DELAY_MS: '300' },
    });
    await runSegment({
      identity: { label: 'rehearsal', commit: 'c0ffee' }, healthAddr: addr, stateDir, evidenceDir, keepRecorded: 'copy', sampleMs: 100, recoverMs: 6000,
      log: () => {}, control, segmentEnd: Date.now() + 8000, hostDrills: 'wipe', fetchHealth, handover: false,
      // The first crash falls due at once and waits for the frozen "in trade" reply.
      newRun: { runId: 'run', targetMs: 60_000, entry: STUB_ENTRY, restarts: 3, causes: ['crash', 'crash', 'crash'], restartWindowMs: 20_000, rpcDrops: 0 },
    });
    const drills = JSON.parse(readFileSync(join(evidenceDir, 'drills.json'), 'utf8')) as DrillOutcome[];
    const d = drills.find((x) => x.id === 'restart-1')!;
    expect(d.notes.join(' ')).toMatch(/closed between the last reply and the kill \(journal\)/);
    expect(d).toMatchObject({ pass: true, midTrade: false, keep: 0 });
    expect(d.exposure).toBeUndefined();
  }, 40_000);
});

describe('a trade opened between the reply and the kill (the mirror case)', () => {
  const line = (seq: number, kind: string, trade: string, extra: Record<string, unknown> = {}, boot = 'b'): JournalLine =>
    ({ seq, ts: '2026-10-04T00:00:00.000Z', boot, kind, trade, reasons: ['x'], ...extra }) as JournalLine;
  it('counts an entry after the reply, with its universe, unless it also closed', () => {
    expect(openedSince([line(5, 'entry', 't1', { universe: 'U2' })], 'b', 4)).toEqual([{ trade: 't1', universe: 'U2' }]);
    expect(openedSince([line(5, 'entry', 't1', { universe: 'U2' }), line(6, 'exit', 't1', { position: 'closed' })], 'b', 4)).toEqual([]);
    expect(openedSince([line(5, 'entry', 't1', { universe: 'U2' }), line(6, 'exit', 't1', { position: 'open' })], 'b', 4)).toEqual([{ trade: 't1', universe: 'U2' }]);
    expect(openedSince([line(4, 'entry', 't1', { universe: 'U2' })], 'b', 4)).toEqual([]);
    expect(openedSince([line(5, 'entry', 't1', { universe: 'U2' }, 'other')], 'b', 4)).toEqual([]);
    // No universe named: the restart is held to an unknown one, which fails the restored-universe check.
    expect(openedSince([line(5, 'entry', 't1')], 'b', 4)).toEqual([{ trade: 't1', universe: 'unknown' }]);
  });

  it.each([
    ['showed none', false],
    ['showed it as an entry in flight (counted once, not twice)', true],
  ])('is a trade the restart must keep, and the drill checks it (the reply %s)', async (_, inFlight) => {
    const dir = mkdtempSync(join(tmpdir(), 'ci1-opened-'));
    const addr = `127.0.0.1:${await freePort()}`;
    const stateDir = join(dir, 'state');
    const evidenceDir = join(dir, 'ev');
    // The first reconciled reply (flat: the stub opens its first trade one 6 s cycle after start) is handed back
    // unchanged for 8 s, so the kill at about 6.5 s comes after an entry the runner never saw.
    let frozen: { h: Health; until: number } | null = null;
    const fetchHealth = async (a: string): Promise<Health | null> => {
      const h = await httpHealth(a);
      if (frozen && h?.boot === frozen.h.boot && Date.now() < frozen.until) return frozen.h;
      if (frozen === null && h?.reconciled && !h.open_position) {
        // The stub's first trade is `<boot>-t1`: shown in flight, it lands before the kill.
        const shown: Health = inFlight ? { ...h, unresolved_intents: { ...h.unresolved_intents, count: 1, trades: [`${h.boot}-t1`] } } : h;
        frozen = { h: shown, until: Date.now() + (inFlight ? 10_000 : 8000) };
        return shown;
      }
      return h;
    };
    const control = new LocalControl({
      entry: STUB_ENTRY, cwd: root, logPath: join(evidenceDir, 'w.log'), stateDir, restartDelayMs: 200,
      env: { PATH: process.env['PATH'] ?? '', ZEROED_STATE_DIR: stateDir, ZEROED_MODE: 'paper', ZEROED_RECORDER: 'on', ZEROED_SIMULATE: 'on', ZEROED_DRILLS: 'on', ZEROED_HEALTH_ADDR: addr, ZEROED_GIT_SHA: 'c0ffee', ZEROED_STUB_TICK_MS: '50', ZEROED_STUB_CYCLE_MS: '6000', ZEROED_STUB_EXIT_DELAY_MS: '300' },
    });
    await runSegment({
      identity: { label: 'rehearsal', commit: 'c0ffee' }, healthAddr: addr, stateDir, evidenceDir, keepRecorded: 'copy', sampleMs: 100, recoverMs: 6000,
      log: () => {}, control, segmentEnd: Date.now() + 12_000, hostDrills: 'wipe', fetchHealth, handover: false,
      // restart-1 falls due at 3 s; the frozen reply shows no trade, so it kills when its 3.5 s window ends. Shown in
      // flight, the reply reads as mid-trade: it falls due at 7 s instead, after the entry (about 5.5 s) and before the exit.
      newRun: { runId: 'run', targetMs: inFlight ? 140_000 : 60_000, entry: STUB_ENTRY, restarts: 3, causes: ['crash', 'crash', 'crash'], restartWindowMs: 3500, rpcDrops: 0 },
    });
    const drills = JSON.parse(readFileSync(join(evidenceDir, 'drills.json'), 'utf8')) as DrillOutcome[];
    const d = drills.find((x) => x.id === 'restart-1')!;
    expect(d.notes.join(' ')).toMatch(/opened between the last reply and the kill \(journal\)/);
    expect(d).toMatchObject({ midTrade: true, keep: 1 });
    expect(d.state).toMatchObject({ state_ok: true, universe_ok: true, missing: [] });
    expect(d.exposure?.trades).toHaveLength(1);
  }, 40_000);
});

describe('a kill between the two writes of an exit', () => {
  it('never asks the restart for a position the state no longer holds', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci1-gap-'));
    const addr = `127.0.0.1:${await freePort()}`;
    const stateDir = join(dir, 'state');
    const evidenceDir = join(dir, 'ev');
    // The stub opens at start (6 s cycle), exits at 3.6 s and stalls 2.5 s between the exit's two writes. A reply showing
    // the open position is handed back unchanged; the crash falls due at 4 s, inside the stall.
    let frozen: { h: Health; until: number } | null = null;
    const fetchHealth = async (a: string): Promise<Health | null> => {
      if (frozen && Date.now() < frozen.until) return frozen.h;
      const h = await httpHealth(a);
      if (frozen === null && h?.reconciled && h.open_position) frozen = { h, until: Date.now() + 9000 };
      return h;
    };
    const control = new LocalControl({
      entry: STUB_ENTRY, cwd: root, logPath: join(evidenceDir, 'w.log'), stateDir, restartDelayMs: 200,
      env: { PATH: process.env['PATH'] ?? '', ZEROED_STATE_DIR: stateDir, ZEROED_MODE: 'paper', ZEROED_RECORDER: 'on', ZEROED_SIMULATE: 'on', ZEROED_DRILLS: 'on', ZEROED_HEALTH_ADDR: addr, ZEROED_GIT_SHA: 'c0ffee', ZEROED_STUB_TICK_MS: '50', ZEROED_STUB_CYCLE_MS: '6000', ZEROED_STUB_OPEN_AT_START: '1', ZEROED_STUB_EXIT_GAP_MS: '2500' },
    });
    await runSegment({
      identity: { label: 'rehearsal', commit: 'c0ffee' }, healthAddr: addr, stateDir, evidenceDir, keepRecorded: 'copy', sampleMs: 100, recoverMs: 8000,
      log: () => {}, control, segmentEnd: Date.now() + 14_000, hostDrills: 'wipe', fetchHealth, handover: false,
      newRun: { runId: 'run', targetMs: 80_000, entry: STUB_ENTRY, restarts: 3, causes: ['crash', 'crash', 'crash'], restartWindowMs: 3000, rpcDrops: 0 },
    });
    const drills = JSON.parse(readFileSync(join(evidenceDir, 'drills.json'), 'utf8')) as DrillOutcome[];
    const d = drills.find((x) => x.id === 'restart-1')!;
    expect(d.state).toMatchObject({ state_ok: true, missing: [] });
    expect(d.pass).toBe(true);
  }, 40_000);
});
