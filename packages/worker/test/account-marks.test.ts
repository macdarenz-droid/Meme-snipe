// WORKER-1c: the worker records marked equity at each Melbourne day and week start and the NAV peak since the last
// re-arm, keeps them in account.json, and hands them to risk, so the day and week loss use the stricter of the realized
// and the marked measure and R10 sees the peak.
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { startSession, TRIAL_POLICY } from '../../core/src/config/index.ts';
import { openLedger } from '../../core/src/ledger/index.ts';
import { emptyBook } from '../../core/src/lifecycle/index.ts';
import { NO_LATCHES, evaluateEntry, melbourneDay, melbourneWeek, riskSnapshot } from '../../core/src/risk/index.ts';
import type { MicroUsd } from '../../core/src/units/index.ts';
import { PaperAccount, accountFile } from '../src/run/account.ts';
import { makeWorker, tempState } from './worker-harness.ts';

const HOUR = 3_600_000;
// 2026-10-06 15:00 Melbourne (AEDT, UTC+11): a Tuesday.
const T = Date.UTC(2026, 9, 6, 4);
const usd = (x: number) => BigInt(Math.round(x * 1_000_000)) as MicroUsd;
const snap = (at: number, equity: number, nav: number | null) => ({ dayStartMs: melbourneDay(at).start, weekStartMs: melbourneWeek(at).start, equity: usd(equity), nav: nav === null ? null : usd(nav) });

describe('PaperAccount marks', () => {
  const fresh = () => new PaperAccount(accountFile(tempState()), usd(20), T - 10 * HOUR, 0n);

  it('takes the day and week mark once, at the first look at or after the boundary, with the time it was taken', () => {
    const a = fresh();
    expect(a.mark(snap(T, 19.5, null), null, T)).toBe(true);
    expect(a.state.dayMark).toEqual({ startMs: melbourneDay(T).start, atMs: T, equity: usd(19.5) });
    expect(a.state.weekMark).toEqual({ startMs: melbourneWeek(T).start, atMs: T, equity: usd(19.5) });
    // Later the same day: unchanged.
    expect(a.mark(snap(T + HOUR, 18, null), null, T + HOUR)).toBe(false);
    expect(a.state.dayMark!.equity).toBe(usd(19.5));
    // The next Melbourne day (same week): a new day mark, the week mark kept.
    const next = melbourneDay(T).end + 5 * HOUR;
    expect(a.mark(snap(next, 17, null), null, next)).toBe(true);
    expect(a.state.dayMark).toEqual({ startMs: melbourneDay(next).start, atMs: next, equity: usd(17) });
    expect(a.state.weekMark!.equity).toBe(usd(19.5));
    // The next Melbourne week: a new week mark.
    const week = melbourneWeek(T).end + 2 * HOUR;
    expect(a.mark(snap(week, 16, null), null, week)).toBe(true);
    expect(a.state.weekMark).toEqual({ startMs: melbourneWeek(week).start, atMs: week, equity: usd(16) });
  });

  it('keeps the NAV peak: it only rises, and restarts after a kill-switch re-arm', () => {
    const a = fresh();
    a.mark(snap(T, 20, 21), null, T);
    expect(a.state.navPeak).toEqual({ atMs: T, nav: usd(21) });
    expect(a.mark(snap(T + 1, 20, 19), null, T + 1)).toBe(false);
    a.mark(snap(T + 2, 20, 22), null, T + 2);
    expect(a.state.navPeak).toEqual({ atMs: T + 2, nav: usd(22) });
    // No NAV (a position without a mark, a stale price): nothing recorded.
    expect(a.mark(snap(T + 3, 20, null), null, T + 3)).toBe(false);
    // A NAV of zero or less is never recorded (risk refuses a non-positive mark as an invalid bankroll), even as a
    // first value after a re-arm.
    expect(a.mark(snap(T + 4, 20, 0), T + 3, T + 4)).toBe(false);
    expect(a.state.navPeak).toEqual({ atMs: T + 2, nav: usd(22) });
    // Re-armed after the peak: the next NAV starts it again, even when lower.
    a.mark(snap(T + 5, 20, 15), T + 3, T + 5);
    expect(a.state.navPeak).toEqual({ atMs: T + 5, nav: usd(15) });
    expect(a.mark(snap(T + 6, 20, 14), T + 3, T + 6)).toBe(false);
  });

  it('survives a restart (kept in account.json)', () => {
    const dir = tempState();
    const a = new PaperAccount(accountFile(dir), usd(20), T - HOUR, 0n);
    a.mark(snap(T, 19, 19.25), null, T);
    const b = new PaperAccount(accountFile(dir), usd(20), T + HOUR, 0n);
    expect(b.state.dayMark).toEqual(a.state.dayMark);
    expect(b.state.navPeak).toEqual(a.state.navPeak);
  });

  it('hands risk this day\'s and week\'s marks only; a mark from an earlier boundary is not recorded for this one (realized only)', () => {
    const dir = tempState();
    const ledger = openLedger(join(dir, 'ledger.sqlite'), 'paper');
    const a = new PaperAccount(accountFile(dir), usd(20), T - 10 * HOUR, 0n);
    a.mark(snap(T, 19.5, 20.5), null, T);
    const book = emptyBook({ maxOpenPositions: 5 });
    const today = a.fact(ledger, book, NO_LATCHES, usd(150), T + HOUR).history;
    expect(today).toMatchObject({ markedAtDayStart: usd(19.5), markedAtWeekStart: usd(19.5), navMarks: [{ atMs: T, nav: usd(20.5) }] });
    const tomorrow = a.fact(ledger, book, NO_LATCHES, usd(150), melbourneDay(T).end + HOUR).history;
    expect(tomorrow.markedAtDayStart).toBeNull();
    expect(tomorrow.markedAtWeekStart).toBe(usd(19.5));
    const nextWeek = a.fact(ledger, book, NO_LATCHES, usd(150), melbourneWeek(T).end + HOUR).history;
    expect(nextWeek.markedAtWeekStart).toBeNull();
    ledger.close();
  });

  it('a recorded day mark makes risk use the stricter marked loss', () => {
    const dir = tempState();
    const ledger = openLedger(join(dir, 'ledger.sqlite'), 'paper');
    const file = accountFile(dir);
    const a = new PaperAccount(file, usd(20), T - 30 * 24 * HOUR, 0n);
    a.price(usd(150), T - 30 * 24 * HOUR);
    // One losing trade of $0.25 today; the day-start valuation was recorded at $21.30 (a gain closed before it).
    file.write({ ...a.state, trades: [{ positionId: 'p:x:1', mint: 'MintX', openedAtMs: T - 2 * HOUR, notional: usd(2), closedAtMs: T - HOUR, netLamports: -1_000n, netPnl: usd(-0.25), stoppedOut: true, booked: -1_000n }] });
    const b = new PaperAccount(file, usd(20), T, 0n);
    b.mark({ ...snap(T, 21.3, null) }, null, T - 30 * 60_000);
    const fact = b.fact(ledger, emptyBook({ maxOpenPositions: 5 }), NO_LATCHES, usd(150), T);
    const input = {
      session: startSession(TRIAL_POLICY), mode: 'paper' as const, clock: { now: () => ({ slot: 1n, txIndex: 0, ixIndex: 0, receivedAt: T }) },
      account: fact.history, latches: NO_LATCHES, market: { solPrice: { value: usd(150), atMs: T }, solBalance: fact.solBalance, regime: 'unknown' as const },
    };
    expect(riskSnapshot(input)!.dayLoss).toBe(usd(1.55));
    const req = { mint: 'MintY', requestedNotional: usd(2), network: { priorityFee: 0n, tip: 0n, baseFee: 5_000n }, rent: { ata: 0n, oneTime: 0n } };
    const d = evaluateEntry(input, req as unknown as Parameters<typeof evaluateEntry>[1]);
    expect(d.reasons.map((r) => r.code)).toContain('daily_loss');
    // Without the mark the realized loss alone ($0.25) leaves room.
    const unmarked = { ...input, account: { ...fact.history, markedAtDayStart: null } };
    expect(riskSnapshot(unmarked)!.dayLoss).toBe(usd(0.25));
    expect(evaluateEntry(unmarked, req as unknown as Parameters<typeof evaluateEntry>[1]).reasons.map((r) => r.code)).not.toContain('daily_loss');
    ledger.close();
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
