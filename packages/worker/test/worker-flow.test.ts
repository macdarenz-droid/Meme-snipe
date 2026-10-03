// WORKER-1 end to end on a scripted market: gates, risk, the ledger reservation, TEST-2's simulation, the paper fill,
// the exit engine, the journal the runner checks and the ledger the replay check reads; then a restart drill mid-trade.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { replayLedgerFile } from '../../core/src/ledger/replay/index.ts';
import { checkJournal } from '../../runner/src/journal.ts';
import { exitsFile } from '../src/run/state.ts';
import { LANDS, MINT, makeWorker, passingMarket } from './worker-harness.ts';

const journalText = (dir: string) => readFileSync(join(dir, 'journal.jsonl'), 'utf8');
const lines = (dir: string) => journalText(dir).trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
const kinds = (dir: string, kind: string) => lines(dir).filter((l) => l['kind'] === kind);
const positions = (h: ReturnType<typeof makeWorker>) => Object.values(h.worker.book.positions);

/** Enters at T (the passing market), then lets the entry land. */
const entered = async (h: ReturnType<typeof makeWorker>) => {
  const r = await h.worker.reconcile();
  expect(r).toEqual({ ok: true });
  const m = await passingMarket(h);
  await m.run(4_000, 100, () => m.pool());
  await m.run(10_000, 400, () => {
    m.slot();
    m.pool();
  });
  return m;
};

describe('a paper trade end to end', () => {
  it('enters through gates, risk and a ledger reservation, simulates each leg first, and exits on the stop', async () => {
    const h = makeWorker();
    const m = await entered(h);
    const open = positions(h).find((p) => p.status === 'open');
    expect(open?.mint).toBe(MINT);
    // The price falls 30%: the price stop fires and the paper exit lands.
    await m.run(6_000, 400, () => {
      m.slot();
      m.pool(700_000n);
    });
    expect(h.worker.book.positions[open!.id]!.status).toBe('closed');

    // The journal is what the runner scores: complete, every fill after its own simulation line.
    const report = checkJournal(journalText(h.stateDir));
    expect(report.problems).toEqual([]);
    expect(report.complete).toBe(true);
    expect(report.entries).toBeGreaterThanOrEqual(1);
    expect(report.exits).toBeGreaterThanOrEqual(1);
    const sims = kinds(h.stateDir, 'simulation');
    expect(sims.map((s) => s['leg'])).toEqual(expect.arrayContaining(['entry', 'exit']));
    for (const s of sims) {
      // TEST-2's DryRunRecord fields, bigints as decimal strings (RUN-1b scores these lines).
      expect(s).toMatchObject({ outcome: 'simulated', success: true, error: null, standIn: null, amountErrorE4: 0, balancesFrom: 'simulation' });
      for (const k of ['quotedOut', 'simulatedOut', 'quoteAgeSlots', 'rentDeclared', 'rentPaid']) expect(s[k], k).toMatch(/^\d+$/);
    }
    expect(h.legs.map((l) => l.leg)).toEqual(sims.map((s) => s['leg']));
    // The entry's decision chain carries its reasons onto the entry line; the exit line names the stop.
    const entry = kinds(h.stateDir, 'entry')[0]!;
    expect(entry['reasons']).toEqual(expect.arrayContaining(['entry filled (paper)', 'enter', 'U2', MINT]));
    expect(kinds(h.stateDir, 'exit')[0]!['reasons']).toEqual(expect.arrayContaining(['exit filled (paper)', 'stop']));
    // The ledger holds what the engine did: the replay check reproduces it, and nothing is left open.
    await h.worker.stop();
    expect(replayLedgerFile(join(h.stateDir, 'ledger.sqlite'))).toMatchObject({ ok: true, purpose: 'paper' });
    expect(readFileSync(join(h.stateDir, 'open_intents'), 'utf8')).toBe('0\n');
    expect(existsSync(join(h.stateDir, 'clean_stop'))).toBe(true);
    expect(h.worker.desk.illegal).toBe(0);
    expect(h.worker.desk.ledgerRefusals).toBe(0);
    const account = JSON.parse(readFileSync(join(h.stateDir, 'account.json'), 'utf8')) as { trades: { closedAtMs: number | null; stoppedOut: boolean }[] };
    expect(account.trades.some((t) => t.closedAtMs !== null && t.stoppedOut)).toBe(true);
  });

  it('makes no entry while no edge is proven (edge 0: risk refuses every entry)', async () => {
    const h = makeWorker({ edgePpm: 0n });
    await entered(h);
    expect(positions(h)).toEqual([]);
    expect(kinds(h.stateDir, 'decision').some((d) => String((d['reasons'] as string[])[3]).startsWith('risk '))).toBe(true);
    await h.worker.stop();
  });

  it('an attempt that lands failed is abandoned and its reservation released', async () => {
    const h = makeWorker({ scenario: { ...LANDS, landPpm: { pumpswap: 0n, 'pump-curve': 0n } } });
    await entered(h);
    expect(positions(h).every((p) => p.quantity === 0n && p.status !== 'open')).toBe(true);
    const abandoned = kinds(h.stateDir, 'decision').filter((d) => d['action'] === 'abandon');
    expect(abandoned.length).toBeGreaterThanOrEqual(1);
    await h.worker.stop();
    expect(replayLedgerFile(join(h.stateDir, 'ledger.sqlite'))).toMatchObject({ ok: true });
  });
});

describe('restart drill mid-trade (EXIT-1 restore acceptance)', () => {
  it('a kill with a runner open restores the same plan, trail, peak, flatMet and partials, and reconciles before any entry', async () => {
    const h = makeWorker();
    const m = await entered(h);
    const pid = positions(h).find((p) => p.status === 'open')!.id;
    // +15%: past 1.5R, so the first partial sells half; the runner's trail starts from the peak.
    await m.run(8_000, 400, () => {
      m.slot();
      m.pool(1_150_000n);
    });
    const p = h.worker.book.positions[pid]!;
    expect(p.status).toBe('open');
    expect(p.sold > 0n && p.quantity > 0n).toBe(true);
    const before = h.worker.strategy.saved()[pid]!;
    expect(before.tracker.partials).toBe(1);
    expect(before.tracker.trail).not.toBeNull();
    expect(before.tracker.flatMet).toBe(true);
    // What is on disk is what the strategy holds (saved after every step).
    expect(exitsFile(h.stateDir).read({})[pid]).toEqual(before);

    await h.worker.kill();
    const h2 = makeWorker({ stateDir: h.stateDir, timers: h.timers });
    const r = await h2.worker.reconcile();
    expect(r).toEqual({ ok: true });
    const after = h2.worker.strategy.saved()[pid]!;
    expect(after.plan).toEqual(before.plan);
    expect(after.tracker.trail).toBe(before.tracker.trail);
    expect(after.tracker.peak).toBe(before.tracker.peak);
    expect(after.tracker.flatMet).toBe(true);
    expect(after.tracker.partials).toBe(1);
    expect(after.tracker.partialSeq).toBe(before.tracker.partialSeq);
    expect(h2.worker.book.positions[pid]).toMatchObject({ status: 'open', quantity: p.quantity, sold: p.sold, exitSeq: p.exitSeq });

    // The journal across both boots: each boot opens with start; no entry before its own reconcile line.
    const report = checkJournal(journalText(h.stateDir));
    expect(report.problems).toEqual([]);
    expect(report.boots).toBe(2);
    const second = lines(h.stateDir).filter((l) => l['boot'] === h2.worker.boot);
    expect(second[0]!['kind']).toBe('start');
    expect(second.findIndex((l) => l['kind'] === 'reconcile')).toBeLessThan(Math.max(0, second.findIndex((l) => l['kind'] === 'entry')) || Number.MAX_SAFE_INTEGER);
    expect(second.find((l) => l['kind'] === 'reconcile')).toMatchObject({ ok: true, open_positions: [pid] });
    await h2.worker.stop();
    expect(replayLedgerFile(join(h.stateDir, 'ledger.sqlite'))).toMatchObject({ ok: true });
  });

  it('an attempt in flight at the kill never lands: the restart settles it before any entry', async () => {
    const h = makeWorker();
    await h.worker.reconcile();
    const m = await passingMarket(h);
    // Run until the entry is submitted, then kill before its landing slot.
    await m.run(4_000, 100, () => m.pool());
    const live = Object.values(h.worker.book.intents).filter((i) => i.status === 'pending' || i.status === 'submitted');
    expect(live).toHaveLength(1);
    await h.worker.kill();
    expect(readFileSync(join(h.stateDir, 'open_intents'), 'utf8')).toBe('1\n');

    // A reconcile with no time to settle exits 3 (contract), and journals why.
    const quick = makeWorker({ stateDir: h.stateDir, timers: h.timers, reconcileTimeoutMs: 0 });
    expect(await quick.worker.reconcile()).toMatchObject({ ok: false, code: 3 });
    expect(kinds(h.stateDir, 'reconcile').at(-1)).toMatchObject({ ok: false });
    await quick.worker.kill();

    const h2 = makeWorker({ stateDir: h.stateDir, timers: h.timers });
    expect(await h2.worker.reconcile()).toEqual({ ok: true });
    const i = h2.worker.book.intents[live[0]!.intent.id]!;
    expect(['abandoned', 'cancelled']).toContain(i.status);
    expect(i.reservation?.status).toBe('released');
    expect(readFileSync(join(h.stateDir, 'open_intents'), 'utf8')).toBe('0\n');
    await h2.worker.stop();
    expect(replayLedgerFile(join(h.stateDir, 'ledger.sqlite'))).toMatchObject({ ok: true });
  });
});

describe('the --reconcile entry (the host unit\'s ExecStartPre)', () => {
  it('settles what a killed worker left open, writes open_intents 0 and exits 0, as a separate process', async () => {
    const h = makeWorker();
    await h.worker.reconcile();
    const m = await passingMarket(h);
    await m.run(4_000, 100, () => m.pool());
    await h.worker.kill();
    expect(readFileSync(join(h.stateDir, 'open_intents'), 'utf8')).toBe('1\n');
    const root = join(import.meta.dirname, '..', '..', '..');
    const r = spawnSync(process.execPath, ['--no-warnings', 'packages/worker/src/main.ts', '--reconcile'], {
      cwd: root, encoding: 'utf8', timeout: 60_000,
      env: { PATH: process.env['PATH'] ?? '', ZEROED_STATE_DIR: h.stateDir, ZEROED_MODE: 'paper', ZEROED_RECORDER: 'on', ZEROED_SIMULATE: 'on', ZEROED_GIT_SHA: 'testsha' },
    });
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(join(h.stateDir, 'open_intents'), 'utf8')).toBe('0\n');
    const report = checkJournal(journalText(h.stateDir));
    expect(report.problems).toEqual([]);
    expect(lines(h.stateDir).filter((l) => l['kind'] === 'reconcile').at(-1)).toMatchObject({ ok: true });
    expect(replayLedgerFile(join(h.stateDir, 'ledger.sqlite'))).toMatchObject({ ok: true });
  });
});
