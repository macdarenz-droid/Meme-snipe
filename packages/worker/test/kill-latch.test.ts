// RISK-LATCH: an account-level trip (R10 kill switch, R9 weekly loss) is latched from the routine account valuation,
// not only when an entry or an exit is evaluated. Audit M1: the NAV fell from the $20 peak to about $8.77 with no
// candidate and no position; risk asked for the kill switch, the worker's latch stayed null, and after the recovery
// the breach tripped nothing.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MicroUsd } from '../../core/src/units/index.ts';
import { markedHistory } from '../src/engine/marks.ts';
import { SOL_PRICE_KEY, TRIPPED_PREFIX, TRIP_PREFIX } from '../src/engine/strategy.ts';
import { accountFile } from '../src/run/account.ts';
import { controlFile, NO_CONTROL } from '../src/run/state.ts';
import { rmSync } from 'node:fs';
import { HELD_PREFIX } from '../src/run/worker.ts';
import { killLatchHolds, weeklyLatchHolds } from '../../core/src/risk/index.ts';
import { MINT, Market, SOL_PRICE, T, makeWorker, passingMarket, tempState, until, virtualTimers } from './worker-harness.ts';

type H = ReturnType<typeof makeWorker>;
const latches = (h: H) => controlFile(h.stateDir).read(NO_CONTROL).latches;

/** A fresh SOL/USD price at `ppm` of the passing one, with a new slot, then one worker step. */
const priced = (h: H, m: Market, ppm: bigint): void => {
  m.slot();
  m.fact(SOL_PRICE_KEY, { value: (SOL_PRICE * ppm) / 1_000_000n, atMs: m.now - 50 });
  h.worker.step();
};

describe('account-level trips latch from the account valuation (RISK-LATCH)', () => {
  it('a NAV breach with no candidate and no position latches the kill switch, which holds after the recovery and a restart', async () => {
    const h = makeWorker();
    expect(await h.worker.reconcile()).toEqual({ ok: true });
    const m = new Market(h);
    priced(h, m, 1_000_000n);
    await m.run(4_000, 400, () => priced(h, m, 1_000_000n));
    // The NAV (the wallet's SOL above the operations floor) is recorded; the high-water mark is the $20 opening.
    expect(accountFile(h.stateDir).read(null as never).navPeak).toBeDefined();
    expect(latches(h).killTrippedAtMs).toBeNull();
    expect(Object.keys(h.worker.book.positions)).toHaveLength(0);

    // SOL at 44% of the price: NAV under $8, below the $14 kill line (70% of the $20 peak).
    await m.run(4_000, 400, () => priced(h, m, 440_000n));
    const at = latches(h).killTrippedAtMs;
    expect(at).not.toBeNull();

    // The price recovers: the latch stays, with the moment of the trip.
    await m.run(2_000, 400, () => priced(h, m, 1_000_000n));
    expect(latches(h).killTrippedAtMs).toBe(at);

    // A restart keeps it: the next process starts latched.
    await h.worker.stop();
    const h2 = makeWorker({ stateDir: h.stateDir, timers: h.timers });
    expect(await h2.worker.reconcile()).toEqual({ ok: true });
    expect(latches(h2).killTrippedAtMs).toBe(at);
    await h2.worker.stop();
  });

  it('a weekly loss already booked latches R9 on the next valuation, with no candidate and no position', async () => {
    const h = makeWorker();
    expect(await h.worker.reconcile()).toEqual({ ok: true });
    const m = new Market(h);
    await m.run(4_000, 400, () => priced(h, m, 1_000_000n));
    await h.worker.stop();
    // A closed trade this week lost $4.50 (the weekly limit is 20% of $20): written while stopped, as a restart finds it.
    const file = accountFile(h.stateDir);
    const a = file.read(null as never);
    const lost = 30_000_000n;
    file.write({ ...a, walletLamports: a.walletLamports! - lost, trades: [{ positionId: 'p:x:1', mint: 'MintX', openedAtMs: m.now - 7_200_000, notional: 5_000_000n, closedAtMs: m.now - 3_600_000, netLamports: -lost, netPnl: -4_500_000n, stoppedOut: true, booked: -lost }] } as never);
    const h2 = makeWorker({ stateDir: h.stateDir, timers: h.timers });
    expect(await h2.worker.reconcile()).toEqual({ ok: true });
    expect(latches(h2).weeklyTrippedAtMs).toBeNull();
    const m2 = new Market(h2);
    await m2.run(4_000, 400, () => priced(h2, m2, 1_000_000n));
    expect(latches(h2).weeklyTrippedAtMs).not.toBeNull();
    await h2.worker.stop();
  });

  it('a SOL price older than maxQuoteAgeMs latches nothing, even one that puts the NAV under the kill line', async () => {
    const h = makeWorker();
    expect(await h.worker.reconcile()).toEqual({ ok: true });
    const m = new Market(h);
    await m.run(4_000, 400, () => priced(h, m, 1_000_000n));
    // SOL at 44% (NAV under the kill line), but stamped older than maxQuoteAgeMs each time it is seen.
    const old = h.session.policy.gates.maxQuoteAgeMs + 1;
    await m.run(4_000, 400, () => {
      m.slot();
      m.fact(SOL_PRICE_KEY, { value: (SOL_PRICE * 440_000n) / 1_000_000n, atMs: m.now - old });
      h.worker.step();
    });
    expect(latches(h).killTrippedAtMs).toBeNull();
    // The same price, fresh, latches it.
    await m.run(2_000, 400, () => priced(h, m, 440_000n));
    expect(latches(h).killTrippedAtMs).not.toBeNull();
    await h.worker.stop();
  });

  it('a NAV above the kill line latches nothing', async () => {
    const h = makeWorker();
    expect(await h.worker.reconcile()).toEqual({ ok: true });
    const m = new Market(h);
    await m.run(800, 400, () => priced(h, m, 1_000_000n));
    // SOL at 85%: NAV about $14.9, above the $14 kill line.
    await m.run(800, 400, () => priced(h, m, 850_000n));
    expect(latches(h).killTrippedAtMs).toBeNull();
    await h.worker.stop();
  });
});

// Review of 23fc039: risk counts an unknown mark as a total loss, a stand-in for refusing entries. A latch is for the
// owner to review and lasts the week (R9) or until re-armed (R10), so it rests only on a fully marked valuation at a
// fresh SOL price; the exit path logs its tripped codes on a fallback account but latches nothing from it.
describe('a latch rests only on a fully marked valuation at a fresh SOL price (RISK-LATCH review)', () => {
  const position = (h: H) => Object.values(h.worker.book.positions).find((p) => String(p.mint) === MINT);
  const decisions = (h: H): string[][] => readFileSync(join(h.stateDir, 'journal.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l['kind'] === 'decision').map((l) => (l['reasons'] as string[]) ?? []);
  type Seam = 'real' | 'unmarked' | 'dip';
  /**
   * A worker whose marking the test steers: real, every mark null, or a fresh mark of a micro-dollar (a real fall).
   * Once steered, the account also holds a $2.01 loss closed an hour ago: with the position's cost (about $2-3) a total
   * loss of it crosses the $4 weekly line (20% of $20), a fall of the position alone stays under it.
   */
  const steered = () => {
    const seam = { mode: 'real' as Seam };
    const mark: typeof markedHistory = (h0, held, sol, nowMs, st) => {
      const lost = { mint: 'MintX' as never, openedAtMs: nowMs - 7_200_000, closedAtMs: nowMs - 3_600_000, notional: 3_000_000n as never, netPnl: -2_010_000n as never, stoppedOut: true };
      const h1 = seam.mode === 'real' ? h0 : { ...h0, closedTrades: [...h0.closedTrades, lost] };
      const r = markedHistory(h1, held, sol, nowMs, st);
      if (seam.mode === 'unmarked') return { ...r, openPositions: r.openPositions.map((o) => ({ ...o, mark: null, markAtMs: null })) };
      if (seam.mode === 'dip') return { ...r, openPositions: r.openPositions.map((o) => (o.mark === null ? o : { ...o, mark: 1n as MicroUsd })) };
      return r;
    };
    return { h: makeWorker({ markedHistory: mark }), seam };
  };
  /** One slot with a small buy on the pool (keeps it fresh) and a fresh SOL price. */
  const tick = (h: H, m: Market) => (): void => {
    m.slot();
    m.chainSwap('buy', m.chainState.baseReserve / 1_000_000n, h.worker.feed.openSlot);
    m.solPrice();
  };
  /** The entry, filled and held, with the account snapshot that risk reads holding it. */
  const entered = async (h: H): Promise<Market> => {
    expect(await h.worker.reconcile()).toEqual({ ok: true });
    const m = await passingMarket(h);
    const read = h.worker.feed.releasedThrough;
    m.tradesStart(read - 100n);
    m.accountsRead(read);
    expect(await until(m, 40_000, () => position(h)?.status === 'open', () => { m.slot(); m.pool(); })).toBe(true);
    await until(m, 2_000, () => false, tick(h, m));
    return m;
  };
  it('(a) a held position with no mark, whose total-loss stand-in crosses the weekly line, latches neither R9 nor R10', async () => {
    const { h, seam } = steered();
    const m = await entered(h);
    seam.mode = 'unmarked';
    await until(m, 4_000, () => false, tick(h, m));
    expect(position(h)?.status).toBe('open');
    // On 23fc039 this valuation latched R9: the stand-in crosses the weekly line.
    expect(h.logs.some((l) => l.includes('Risk tripped on the account valuation'))).toBe(false);
    expect(latches(h).weeklyTrippedAtMs).toBeNull();
    expect(latches(h).killTrippedAtMs).toBeNull();
    await h.worker.stop();
  });

  it('(b) the same position with a fresh mark showing a real fall latches R9 from the valuation', async () => {
    const { h, seam } = steered();
    const m = await entered(h);
    seam.mode = 'dip';
    await until(m, 4_000, () => latches(h).weeklyTrippedAtMs !== null, tick(h, m));
    expect(position(h)?.status).toBe('open');
    expect(latches(h).weeklyTrippedAtMs).not.toBeNull();
    expect(h.logs.some((l) => l.includes('Risk tripped on the account valuation: ') && l.includes('weekly_loss'))).toBe(true);
    await h.worker.stop();
  });

  it('(c) an exit judged on an unmarked account (as the fallback gives) logs its tripped codes and latches nothing', async () => {
    const { h, seam } = steered();
    const m = await entered(h);
    const pid = position(h)!.id;
    seam.mode = 'unmarked';
    m.chainSwap('sell', (m.chainState.baseReserve * 20n) / 100n, h.worker.feed.openSlot);
    expect(await until(m, 20_000, () => h.worker.book.positions[pid]!.status === 'closed', tick(h, m))).toBe(true);
    const exit = decisions(h).find((r) => r[0] === 'exit')!;
    expect(exit.find((x) => x.startsWith(TRIPPED_PREFIX))?.slice(TRIPPED_PREFIX.length).split(',')).toEqual(expect.arrayContaining(['mark_unknown', 'weekly_loss']));
    expect(exit.some((x) => x.startsWith(TRIP_PREFIX))).toBe(false);
    expect(latches(h).weeklyTrippedAtMs).toBeNull();
    expect(latches(h).killTrippedAtMs).toBeNull();
    await h.worker.stop();
  });
});

// RISK-LATCH-2 (AUDIT-RM2 F2): core holds a latch only until the owner re-arms (R10) or reviews after the week (R9).
// The worker stored a trip only while none was stored, so after one re-arm a later breach never latched again.
describe('a trip after an owner re-arm or review latches again (RISK-LATCH-2)', () => {
  it('R10: tripped at T1 and re-armed at R; a new NAV breach latches at T2 > R, which holds after the recovery', async () => {
    const timers = virtualTimers(T - 16 * 86_400_000);
    const stateDir = tempState();
    const t1 = timers.now() - 2 * 3_600_000;
    const r = timers.now() - 3_600_000;
    controlFile(stateDir).write({ ...NO_CONTROL, latches: { ...NO_CONTROL.latches, killTrippedAtMs: t1, killRearmedAtMs: r } });
    const h = makeWorker({ stateDir, timers });
    expect(await h.worker.reconcile()).toEqual({ ok: true });
    const m = new Market(h);
    await m.run(4_000, 400, () => priced(h, m, 1_000_000n));
    expect(killLatchHolds(latches(h))).toBe(false);
    await m.run(4_000, 400, () => priced(h, m, 440_000n));
    const t2 = latches(h).killTrippedAtMs!;
    expect(t2).toBeGreaterThan(r);
    expect(latches(h).killRearmedAtMs).toBe(r);
    await m.run(2_000, 400, () => priced(h, m, 1_000_000n));
    // Recovered, and still latched: entries stay refused until the owner re-arms again.
    expect(latches(h).killTrippedAtMs).toBe(t2);
    expect(killLatchHolds(latches(h))).toBe(true);
    await h.worker.stop();
  });

  it('R9: a trip reviewed after its week has ended latches again on a new weekly loss; one still held keeps its moment', async () => {
    const timers = virtualTimers(T - 16 * 86_400_000);
    const stateDir = tempState();
    const now = timers.now();
    // Tripped 9 days ago (its week is over) and reviewed 1 day ago: no longer held.
    controlFile(stateDir).write({ ...NO_CONTROL, latches: { ...NO_CONTROL.latches, weeklyTrippedAtMs: now - 9 * 86_400_000, weeklyReviewedAtMs: now - 86_400_000 } });
    const h = makeWorker({ stateDir, timers });
    expect(await h.worker.reconcile()).toEqual({ ok: true });
    const m = new Market(h);
    await m.run(4_000, 400, () => priced(h, m, 1_000_000n));
    expect(weeklyLatchHolds(latches(h), m.now)).toBe(false);
    await h.worker.stop();
    const file = accountFile(h.stateDir);
    const a = file.read(null as never);
    const lost = 30_000_000n;
    file.write({ ...a, walletLamports: a.walletLamports! - lost, trades: [{ positionId: 'p:x:1', mint: 'MintX', openedAtMs: m.now - 7_200_000, notional: 5_000_000n, closedAtMs: m.now - 3_600_000, netLamports: -lost, netPnl: -4_500_000n, stoppedOut: true, booked: -lost }] } as never);
    const h2 = makeWorker({ stateDir: h.stateDir, timers: h.timers });
    expect(await h2.worker.reconcile()).toEqual({ ok: true });
    const m2 = new Market(h2);
    await m2.run(4_000, 400, () => priced(h2, m2, 1_000_000n));
    const at = latches(h2).weeklyTrippedAtMs!;
    expect(at).toBeGreaterThan(now);
    expect(weeklyLatchHolds(latches(h2), m2.now)).toBe(true);
    // Held now: later valuations keep the first moment.
    await m2.run(2_000, 400, () => priced(h2, m2, 1_000_000n));
    expect(latches(h2).weeklyTrippedAtMs).toBe(at);
    await h2.worker.stop();
  });
});

// RISK-LATCH-2 (AUDIT-RM2 F4): a restore or cold start without the state that holds the latches and loss figures
// started from nothing (no control.json: no latch). Such a boot now holds entries (exits run) until the owner confirms.
describe('a boot that lost its latches or account holds entries until the owner confirms (RISK-LATCH-2)', () => {
  const held = (h: H) => (h.worker.health().halt_reasons as readonly string[]).filter((x) => x.startsWith(HELD_PREFIX));
  /** A run whose NAV breach latched the kill switch, stopped. */
  const latchedRun = async () => {
    const h = makeWorker();
    expect(await h.worker.reconcile()).toEqual({ ok: true });
    const m = new Market(h);
    await m.run(4_000, 400, () => priced(h, m, 1_000_000n));
    await m.run(4_000, 400, () => priced(h, m, 440_000n));
    expect(latches(h).killTrippedAtMs).not.toBeNull();
    await h.worker.stop();
    return h;
  };

  it('a host-loss restore whose backup lacks control.json holds entries, and the owner\'s pause then resume clears it', async () => {
    const h = await latchedRun();
    rmSync(controlFile(h.stateDir).path);
    const h2 = makeWorker({ stateDir: h.stateDir, timers: h.timers });
    expect(await h2.worker.reconcile()).toEqual({ ok: true });
    const m = new Market(h2);
    await m.run(2_000, 400, () => priced(h2, m, 1_000_000n));
    // The kill latch is gone with the file; the hold stops entries instead, and is saved for the next start.
    expect(latches(h2).killTrippedAtMs).toBeNull();
    expect(held(h2)).toEqual([expect.stringContaining('control.json')]);
    expect(controlFile(h2.stateDir).read(NO_CONTROL).held).not.toBeNull();
    await h2.worker.stop();
    // A pause that began before the hold (as saved) does not confirm it when lifted; a pause after it, then a resume, does.
    const ctl = controlFile(h.stateDir).read(NO_CONTROL);
    controlFile(h.stateDir).write({ ...ctl, paused: true, pausedAtMs: ctl.held!.atMs - 1 });
    const h3 = makeWorker({ stateDir: h.stateDir, timers: h.timers });
    expect(await h3.worker.reconcile()).toEqual({ ok: true });
    const m3 = new Market(h3);
    await m3.run(1_200, 400, () => priced(h3, m3, 1_000_000n));
    expect(held(h3)).toHaveLength(1);
    h3.worker.applyPause(false);
    await m3.run(800, 400, () => priced(h3, m3, 1_000_000n));
    expect(held(h3)).toHaveLength(1);
    h3.worker.applyPause(true);
    h3.worker.applyPause(false);
    await m3.run(800, 400, () => priced(h3, m3, 1_000_000n));
    expect(held(h3)).toEqual([]);
    expect(controlFile(h3.stateDir).read(NO_CONTROL).held).toBeNull();
    await h3.worker.stop();
  });

  it('a restore without account.json, or a cold start with no ledger, holds entries too', async () => {
    for (const gone of ['account.json', 'ledger'] as const) {
      const h = await latchedRun();
      if (gone === 'account.json') rmSync(accountFile(h.stateDir).path);
      else for (const f of ['ledger.sqlite', 'ledger.sqlite-wal', 'ledger.sqlite-shm', 'control.json', 'account.json']) rmSync(`${h.stateDir}/${f}`, { force: true });
      const h2 = makeWorker({ stateDir: h.stateDir, timers: h.timers });
      expect(await h2.worker.reconcile()).toEqual({ ok: true });
      const m = new Market(h2);
      await m.run(1_200, 400, () => priced(h2, m, 1_000_000n));
      expect(held(h2), gone).toHaveLength(1);
      await h2.worker.stop();
    }
  });

  it('a restore with every file holds nothing and keeps the kill latch; a first start on an empty folder holds nothing', async () => {
    const h = await latchedRun();
    const at = latches(h).killTrippedAtMs;
    const h2 = makeWorker({ stateDir: h.stateDir, timers: h.timers });
    expect(await h2.worker.reconcile()).toEqual({ ok: true });
    const m = new Market(h2);
    await m.run(1_200, 400, () => priced(h2, m, 1_000_000n));
    expect(held(h2)).toEqual([]);
    expect(latches(h2).killTrippedAtMs).toBe(at);
    await h2.worker.stop();
    const fresh = makeWorker();
    expect(await fresh.worker.reconcile()).toEqual({ ok: true });
    const m2 = new Market(fresh);
    await m2.run(1_200, 400, () => priced(fresh, m2, 1_000_000n));
    expect(held(fresh)).toEqual([]);
    await fresh.worker.stop();
    // A plain restart of a run that never latched, and one stopped before any SOL price: nothing was lost.
    const quiet = makeWorker();
    expect(await quiet.worker.reconcile()).toEqual({ ok: true });
    await quiet.worker.stop();
    const again = makeWorker({ stateDir: quiet.stateDir, timers: quiet.timers });
    expect(await again.worker.reconcile()).toEqual({ ok: true });
    const m3 = new Market(again);
    await m3.run(1_200, 400, () => priced(again, m3, 1_000_000n));
    expect(held(again)).toEqual([]);
    await again.worker.stop();
  });
});
