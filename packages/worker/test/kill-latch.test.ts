// RISK-LATCH: an account-level trip (R10 kill switch, R9 weekly loss) is latched from the routine account valuation,
// not only when an entry or an exit is evaluated. Audit M1: the NAV fell from the $20 peak to about $8.77 with no
// candidate and no position; risk asked for the kill switch, the worker's latch stayed null, and after the recovery
// the breach tripped nothing.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MicroUsd, Lamports } from '../../core/src/units/index.ts';
import { markedHistory } from '../src/engine/marks.ts';
import { SOL_PRICE_KEY, TRIPPED_PREFIX, TRIP_PREFIX } from '../src/engine/strategy.ts';
import { accountFile } from '../src/run/account.ts';
import { controlFile, NO_CONTROL } from '../src/run/state.ts';
import { microUsdToLamports } from '../../core/src/units/index.ts';
import { MINT, Market, SOL_PRICE, makeWorker, passingMarket, until, lam } from './worker-harness.ts';

type H = ReturnType<typeof makeWorker>;
const latches = (h: H) => controlFile(h.stateDir).read(NO_CONTROL).latches;

/** A fresh SOL/USD price at `ppm` of the passing one, with a new slot, then one worker step. */
const priced = (h: H, m: Market, ppm: bigint): void => {
  m.slot();
  m.fact(SOL_PRICE_KEY, { value: (SOL_PRICE * ppm) / 1_000_000n, atMs: m.now - 50 });
  h.worker.step();
};

describe('account-level trips latch from the account valuation (RISK-LATCH)', () => {
  it('SOL-BOOKS: SOL at -40% and +40% with no trade trips nothing; NAV stays at its high-water mark (owner, 2026-10-05)', async () => {
    const h = makeWorker();
    expect(await h.worker.reconcile()).toEqual({ ok: true });
    const m = new Market(h);
    await m.run(4_000, 400, () => priced(h, m, 1_000_000n));
    const before = accountFile(h.stateDir).read(null as never);
    for (const ppm of [600_000n, 1_400_000n, 1_000_000n]) {
      await m.run(4_000, 400, () => priced(h, m, ppm));
      expect(latches(h), `SOL at ${ppm} ppm`).toEqual(NO_CONTROL.latches);
      expect(h.logs.some((l) => l.startsWith('Risk tripped on the account valuation'))).toBe(false);
    }
    // The books are in SOL: the opening price, the wallet and the NAV peak are as they were at the opening.
    const after = accountFile(h.stateDir).read(null as never);
    expect(after.openingSolPrice).toBe(before.openingSolPrice);
    expect(after.walletLamports).toBe(before.walletLamports);
    expect(after.navPeak?.nav).toBe(after.walletLamports);
    await h.worker.stop();
  });

  it('a booked loss past the kill line latches R10 on the next valuation, with no candidate, and the latch holds across a restart', async () => {
    const h = makeWorker();
    expect(await h.worker.reconcile()).toEqual({ ok: true });
    const m = new Market(h);
    await m.run(4_000, 400, () => priced(h, m, 1_000_000n));
    await h.worker.stop();
    // A closed trade lost 35% of the SOL bankroll (beyond the 30% kill line), written while stopped, as a restart finds
    // it. Earlier than this week, so the weekly limit is not what trips.
    const file = accountFile(h.stateDir);
    const a = file.read(null as never);
    const lost = (microUsdToLamports(a.openingEquity, a.openingSolPrice!, 'floor') * 35n) / 100n;
    file.write({ ...a, walletLamports: a.walletLamports! - lost, trades: [{ positionId: 'p:x:1', mint: 'MintX', openedAtMs: m.now - 9 * 86_400_000, notional: lost, closedAtMs: m.now - 8 * 86_400_000, netLamports: -lost, netPnl: null, stoppedOut: true, booked: -lost }] } as never);
    const h2 = makeWorker({ stateDir: h.stateDir, timers: h.timers });
    expect(await h2.worker.reconcile()).toEqual({ ok: true });
    const m2 = new Market(h2);
    await m2.run(4_000, 400, () => priced(h2, m2, 1_000_000n));
    const at = latches(h2).killTrippedAtMs;
    expect(at).not.toBeNull();
    await h2.worker.stop();
    const h3 = makeWorker({ stateDir: h.stateDir, timers: h.timers });
    expect(await h3.worker.reconcile()).toEqual({ ok: true });
    expect(latches(h3).killTrippedAtMs).toBe(at);
    await h3.worker.stop();
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
    const mark: typeof markedHistory = (h0, held, nowMs, st) => {
      const lost = { mint: 'MintX' as never, openedAtMs: nowMs - 7_200_000, closedAtMs: nowMs - 3_600_000, notional: lam('3'), netPnl: -lam('2.01') as Lamports, stoppedOut: true };
      const h1 = seam.mode === 'real' ? h0 : { ...h0, closedTrades: [...h0.closedTrades, lost] };
      const r = markedHistory(h1, held, nowMs, st);
      if (seam.mode === 'unmarked') return { ...r, openPositions: r.openPositions.map((o) => ({ ...o, mark: null, markAtMs: null })) };
      if (seam.mode === 'dip') return { ...r, openPositions: r.openPositions.map((o) => (o.mark === null ? o : { ...o, mark: 1n as Lamports })) };
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
