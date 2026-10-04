// RISK-LATCH: an account-level trip (R10 kill switch, R9 weekly loss) is latched from the routine account valuation,
// not only when an entry or an exit is evaluated. Audit M1: the NAV fell from the $20 peak to about $8.77 with no
// candidate and no position; risk asked for the kill switch, the worker's latch stayed null, and after the recovery
// the breach tripped nothing.
import { describe, expect, it } from 'vitest';
import { SOL_PRICE_KEY } from '../src/engine/strategy.ts';
import { accountFile } from '../src/run/account.ts';
import { controlFile, NO_CONTROL } from '../src/run/state.ts';
import { Market, SOL_PRICE, makeWorker } from './worker-harness.ts';

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
