// WORKER-1c: the worker records marked equity at each Melbourne day and week start and the NAV peak since the last
// re-arm, keeps them in account.json, and hands them to risk, so the day and week loss use the stricter of the realized
// and the marked measure and R10 sees the peak.
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { startSession, TRIAL_POLICY } from '../../core/src/config/index.ts';
import { openLedger } from '../../core/src/ledger/index.ts';
import { emptyBook } from '../../core/src/lifecycle/index.ts';
import { NO_LATCHES, evaluateEntry, melbourneDay, melbourneWeek, riskSnapshot } from '../../core/src/risk/index.ts';
import type { Lamports, MicroUsd } from '../../core/src/units/index.ts';
import { PaperAccount, accountFile } from '../src/run/account.ts';
import { makeWorker, tempState } from './worker-harness.ts';

const HOUR = 3_600_000;
// 2026-10-06 15:00 Melbourne (AEDT, UTC+11): a Tuesday.
const T = Date.UTC(2026, 9, 6, 4);
const usd = (x: number) => BigInt(Math.round(x * 1_000_000)) as MicroUsd;
/** SOL-BOOKS: an amount in lamports, written as dollars at a $100 opening price ($1 = 10,000,000 lamports). */
const sol = (x: number) => BigInt(Math.round(x * 10_000_000)) as Lamports;
const snap = (at: number, equity: number, nav: number | null) => ({ dayStartMs: melbourneDay(at).start, weekStartMs: melbourneWeek(at).start, equity: sol(equity), nav: nav === null ? null : sol(nav) });

describe('PaperAccount marks', () => {
  const fresh = () => new PaperAccount(accountFile(tempState()), usd(20), T - 10 * HOUR, 0n);

  it('takes the day and week mark once, at the first look at or after the boundary, with the time it was taken', () => {
    const a = fresh();
    expect(a.mark(snap(T, 19.5, null), true, null, T)).toBe(true);
    expect(a.state.dayMark).toEqual({ startMs: melbourneDay(T).start, atMs: T, equity: sol(19.5) });
    expect(a.state.weekMark).toEqual({ startMs: melbourneWeek(T).start, atMs: T, equity: sol(19.5) });
    // Later the same day: unchanged.
    expect(a.mark(snap(T + HOUR, 18, null), true, null, T + HOUR)).toBe(false);
    expect(a.state.dayMark!.equity).toBe(sol(19.5));
    // The next Melbourne day (same week): a new day mark, the week mark kept.
    const next = melbourneDay(T).end + 5 * HOUR;
    expect(a.mark(snap(next, 17, null), true, null, next)).toBe(true);
    expect(a.state.dayMark).toEqual({ startMs: melbourneDay(next).start, atMs: next, equity: sol(17) });
    expect(a.state.weekMark!.equity).toBe(sol(19.5));
    // The next Melbourne week: a new week mark.
    const week = melbourneWeek(T).end + 2 * HOUR;
    expect(a.mark(snap(week, 16, null), true, null, week)).toBe(true);
    expect(a.state.weekMark).toEqual({ startMs: melbourneWeek(week).start, atMs: week, equity: sol(16) });
  });

  it('a boundary seen while an open position has no fresh mark is not recorded until every mark is fresh (RISK-MARK)', () => {
    const a = fresh();
    // Equity counts the unmarked position as a total loss: recording it would show a phantom gain later.
    expect(a.mark(snap(T, 2, null), false, null, T)).toBe(false);
    expect(a.state.dayMark).toBeUndefined();
    expect(a.state.weekMark).toBeUndefined();
    // The next look with every mark fresh records both, at that later moment.
    expect(a.mark(snap(T + 60_000, 19.5, 19.6), true, null, T + 60_000)).toBe(true);
    expect(a.state.dayMark).toEqual({ startMs: melbourneDay(T).start, atMs: T + 60_000, equity: sol(19.5) });
    expect(a.state.weekMark).toEqual({ startMs: melbourneWeek(T).start, atMs: T + 60_000, equity: sol(19.5) });
  });

  it('keeps the NAV peak: it only rises, and restarts after a kill-switch re-arm', () => {
    const a = fresh();
    a.mark(snap(T, 20, 21), true, null, T);
    expect(a.state.navPeak).toEqual({ atMs: T, nav: sol(21) });
    expect(a.mark(snap(T + 1, 20, 19), true, null, T + 1)).toBe(false);
    a.mark(snap(T + 2, 20, 22), true, null, T + 2);
    expect(a.state.navPeak).toEqual({ atMs: T + 2, nav: sol(22) });
    // No NAV (a position without a mark, a stale price): nothing recorded.
    expect(a.mark(snap(T + 3, 20, null), true, null, T + 3)).toBe(false);
    // A NAV of zero or less is never recorded (risk refuses a non-positive mark as an invalid bankroll), even as a
    // first value after a re-arm.
    expect(a.mark(snap(T + 4, 20, 0), true, T + 3, T + 4)).toBe(false);
    expect(a.state.navPeak).toEqual({ atMs: T + 2, nav: sol(22) });
    // Re-armed after the peak: the next NAV starts it again, even when lower.
    a.mark(snap(T + 5, 20, 15), true, T + 3, T + 5);
    expect(a.state.navPeak).toEqual({ atMs: T + 5, nav: sol(15) });
    expect(a.mark(snap(T + 6, 20, 14), true, T + 3, T + 6)).toBe(false);
  });

  it('survives a restart (kept in account.json)', () => {
    const dir = tempState();
    const a = new PaperAccount(accountFile(dir), usd(20), T - HOUR, 0n);
    a.mark(snap(T, 19, 19.25), true, null, T);
    const b = new PaperAccount(accountFile(dir), usd(20), T + HOUR, 0n);
    expect(b.state.dayMark).toEqual(a.state.dayMark);
    expect(b.state.navPeak).toEqual(a.state.navPeak);
  });

  it('hands risk this day\'s and week\'s marks only; a mark from an earlier boundary is not recorded for this one (realized only)', () => {
    const dir = tempState();
    const ledger = openLedger(join(dir, 'ledger.sqlite'), 'paper');
    const a = new PaperAccount(accountFile(dir), usd(20), T - 10 * HOUR, 0n);
    a.mark(snap(T, 19.5, 20.5), true, null, T);
    const book = emptyBook({ maxOpenPositions: 5 });
    const today = a.fact(ledger, book, NO_LATCHES, T + HOUR).history;
    expect(today).toMatchObject({ markedAtDayStart: sol(19.5), markedAtWeekStart: sol(19.5), navMarks: [{ atMs: T, nav: sol(20.5) }] });
    const tomorrow = a.fact(ledger, book, NO_LATCHES, melbourneDay(T).end + HOUR).history;
    expect(tomorrow.markedAtDayStart).toBeNull();
    expect(tomorrow.markedAtWeekStart).toBe(sol(19.5));
    // A peak taken after the moment asked about is not handed over.
    expect(a.fact(ledger, book, NO_LATCHES, T - 1).history.navMarks).toEqual([]);
    const nextWeek = a.fact(ledger, book, NO_LATCHES, melbourneWeek(T).end + HOUR).history;
    expect(nextWeek.markedAtWeekStart).toBeNull();
    ledger.close();
  });

  it('a recorded day mark makes risk use the stricter marked loss', () => {
    const dir = tempState();
    const ledger = openLedger(join(dir, 'ledger.sqlite'), 'paper');
    const file = accountFile(dir);
    const a = new PaperAccount(file, usd(20), T - 30 * 24 * HOUR, 0n);
    a.price(usd(100), T - 30 * 24 * HOUR);
    // One losing trade of $0.25 today (in lamports at the $100 opening price); the day-start valuation was recorded at
    // $21.30 (a gain closed before it).
    file.write({ ...a.state, trades: [{ positionId: 'p:x:1', mint: 'MintX', openedAtMs: T - 2 * HOUR, notional: sol(2), closedAtMs: T - HOUR, netLamports: -sol(0.25), netPnl: usd(-0.25), stoppedOut: true, booked: -sol(0.25) }] });
    const b = new PaperAccount(file, usd(20), T, 0n);
    b.mark({ ...snap(T, 21.3, null) }, true, null, T - 30 * 60_000);
    const fact = b.fact(ledger, emptyBook({ maxOpenPositions: 5 }), NO_LATCHES, T);
    const input = {
      session: startSession(TRIAL_POLICY), mode: 'paper' as const, clock: { now: () => ({ slot: 1n, txIndex: 0, ixIndex: 0, receivedAt: T }) },
      account: fact.history, latches: NO_LATCHES, market: { solBalance: fact.solBalance, regime: 'unknown' as const },
    };
    expect(riskSnapshot(input)!.dayLoss).toBe(sol(1.55));
    const req = { mint: 'MintY', requestedNotional: usd(2), network: { priorityFee: 0n, tip: 0n, baseFee: 5_000n }, rent: { ata: 0n, oneTime: 0n } };
    const d = evaluateEntry(input, req as unknown as Parameters<typeof evaluateEntry>[1]);
    expect(d.reasons.map((r) => r.code)).toContain('daily_loss');
    // Without the mark the realized loss alone ($0.25) leaves room.
    const unmarked = { ...input, account: { ...fact.history, markedAtDayStart: null } };
    expect(riskSnapshot(unmarked)!.dayLoss).toBe(sol(0.25));
    expect(evaluateEntry(unmarked, req as unknown as Parameters<typeof evaluateEntry>[1]).reasons.map((r) => r.code)).not.toContain('daily_loss');
    ledger.close();
  });
});

describe('SOL-BOOKS: an account.json from before is converted once at the opening SOL price', () => {
  it('marks and the NAV peak in micro-dollars become lamports rounded up, trade sizes rounded down; once', () => {
    const dir = tempState();
    const file = accountFile(dir);
    // A file as the dry run wrote it before SOL-BOOKS: no opening price, no `books`, dollar marks and sizes.
    file.write({
      openedAtMs: T - 30 * 24 * HOUR, openingEquity: usd(20), walletLamports: 133_000_000n, oneTimePaid: true, entries: [],
      dayMark: { startMs: melbourneDay(T).start, atMs: T, equity: usd(19.5) as never },
      weekMark: { startMs: melbourneWeek(T).start, atMs: T, equity: usd(19.5) as never },
      navPeak: { atMs: T, nav: usd(17.000003) as never },
      trades: [{ positionId: 'p:x:1', mint: 'MintX', openedAtMs: T - 2 * HOUR, notional: usd(2) as never, closedAtMs: T - HOUR, netLamports: -1_000n, netPnl: usd(-0.15), stoppedOut: true, booked: -1_000n }],
    });
    const a = new PaperAccount(file, usd(20), T, 0n);
    // Before the first price there is no opening price: the history says so, and risk refuses (R1) without latching.
    const ledger = openLedger(join(dir, 'ledger.sqlite'), 'paper');
    expect(a.fact(ledger, emptyBook({ maxOpenPositions: 5 }), NO_LATCHES, T).history.openingSolPrice).toBe(0n);
    a.price(usd(150), T);
    // $150: $19.50 is 130,000,000 lamports exactly; $17.000003 is 113,333,353.3, rounded up; $2 is 13,333,333.3, down.
    expect(a.state).toMatchObject({ openingSolPrice: usd(150), books: 'sol', walletLamports: 133_000_000n });
    expect(a.state.dayMark!.equity).toBe(130_000_000n);
    expect(a.state.weekMark!.equity).toBe(130_000_000n);
    expect(a.state.navPeak!.nav).toBe(113_333_354n);
    expect(a.state.trades[0]!.notional).toBe(13_333_333n);
    // A later price changes nothing, and a restart does not convert again.
    a.price(usd(90), T + HOUR);
    const b = new PaperAccount(file, usd(20), T + 2 * HOUR, 0n);
    b.price(usd(300), T + 2 * HOUR);
    expect(b.state).toMatchObject({ openingSolPrice: usd(150), books: 'sol' });
    expect(b.state.navPeak!.nav).toBe(113_333_354n);
    expect(b.state.trades[0]!.notional).toBe(13_333_333n);
    // Risk reads the lamports: the closed trade's result is its netLamports.
    const h = b.fact(ledger, emptyBook({ maxOpenPositions: 5 }), NO_LATCHES, T + 2 * HOUR).history;
    expect(h.openingSolPrice).toBe(usd(150));
    // B in lamports at the opening price, rounded down ($20 at $150 is 133,333,333.3).
    expect(h.openingEquity).toBe(133_333_333n);
    expect(h.closedTrades[0]).toMatchObject({ netPnl: -1_000n, notional: 13_333_333n });
    ledger.close();
  });

  it('a new account starts in SOL: the first price is the opening price, and later prices change no figure', () => {
    const dir = tempState();
    const a = new PaperAccount(accountFile(dir), usd(20), T, 0n);
    expect(a.state.books).toBe('sol');
    a.price(usd(100), T);
    expect(a.state).toMatchObject({ openingSolPrice: usd(100), walletLamports: 200_000_000n });
    a.price(usd(140), T + 1);
    expect(a.state).toMatchObject({ openingSolPrice: usd(100), walletLamports: 200_000_000n });
  });
});

describe('the worker records the marks', () => {
  it('after the reconcile, a step records this day\'s and week\'s marks in account.json', async () => {
    const h = makeWorker();
    expect(await h.worker.reconcile()).toEqual({ ok: true });
    h.worker.step();
    const now = h.timers.now();
    const s = accountFile(h.stateDir).read(null as never);
    expect(s.dayMark).toEqual({ startMs: melbourneDay(now).start, atMs: now, equity: expect.any(BigInt) });
    expect(s.weekMark).toMatchObject({ startMs: melbourneWeek(now).start, atMs: now });
    await h.worker.stop();
  });
});

describe('SOL-BOOKS: a closed trade with no dollar figure is shown from its lamports, never as zero', () => {
  it('values the lamports at the close, open or current price, a loss rounded up; null only without any price', async () => {
    const { tradeNetUsd } = await import('../src/run/api.ts');
    const t = { positionId: 'p', mint: 'm', openedAtMs: 0, notional: 1n, closedAtMs: 1, netLamports: -1_000_001n, netPnl: null, stoppedOut: true, booked: 0n } as never;
    // -1,000,001 lamports at $150 is -150,000.15 micro-dollars: shown as -150,001.
    expect(tradeNetUsd({ solPrice: usd(150) }, t)).toBe(-150_001n);
    expect(tradeNetUsd({ solPrice: usd(100) }, { ...(t as object), closeSolPrice: usd(150) } as never)).toBe(-150_001n);
    expect(tradeNetUsd({ solPrice: usd(100) }, { ...(t as object), openSolPrice: usd(150) } as never)).toBe(-150_001n);
    expect(tradeNetUsd({ solPrice: usd(150) }, { ...(t as object), netLamports: 1_000_001n } as never)).toBe(150_000n);
    expect(tradeNetUsd({ solPrice: null }, t)).toBeNull();
    // A trade with its own figure keeps it.
    expect(tradeNetUsd({ solPrice: usd(150) }, { ...(t as object), netPnl: -7n } as never)).toBe(-7n);
  });
});
