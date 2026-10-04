// R8-WHOLE (supervisor ruling on the risk review of #198 PAPER-2): R8 (the loss streak's cooldown and day pause, and
// "5 losses in any 20"), and R15 class a closed trade a win or a loss by its whole result as of the decision moment,
// late entries included. A loss is sticky from its loss moment (the close when the close lost, else the booking of
// the late entry that took it below zero); R8's timing anchors on the streak's latest loss moment; the review window
// counts a trade whose close or loss moment is after the review. The late entries never reach equity (the money is
// counted once, as a late_settlement cost).
import { describe, expect, test } from 'vitest';
import { TRIAL_POLICY, usd } from '../../src/config/index.ts';
import { type ClosedTrade, type EntryAllowed, type LateEntry, evaluateEntry, riskSnapshot } from '../../src/risk/index.ts';
import { type Lamports, type MicroUsd, lamports } from '../../src/units/index.ts';
import { DAY_START, HOUR, NOW, PRICE, SOL, WEEK_START, account, baseInput, baseRequest, clockAt, codes, latches, trade } from './helpers.ts';

const late = (atMs: number, pnl: MicroUsd | null, lam = -1_000_000n): LateEntry => ({ atMs, lamports: lam as Lamports, pnl });
const fee = (atMs: number) => late(atMs, -usd('0.2') as MicroUsd);
const gain = (atMs: number) => late(atMs, usd('0.5'), 3_000_000n);
const withLate = (t: ClosedTrade, ...xs: LateEntry[]): ClosedTrade => ({ ...t, late: xs });
const at = (ms: number, closedTrades: ClosedTrade[], patch: Parameters<typeof baseInput>[0] = {}) => baseInput({
  account: account({ closedTrades }), clock: clockAt(ms),
  market: { solPrice: { value: PRICE, atMs: ms }, solBalance: { value: lamports(SOL), atMs: ms }, regime: 'on' }, ...patch,
});
const req = (ms: number) => baseRequest({ quoteAtMs: ms });
const streak = (ms: number, closed: ClosedTrade[]) => riskSnapshot(at(ms, closed))!.lossStreak;
const LAST_WEEK = WEEK_START - 30 * HOUR;

describe('a win turned into a loss by a late entry', () => {
  test('counts as a loss for the streak from its booking moment, not before', () => {
    const closed = [trade(NOW - 4 * HOUR, '-0.1'), withLate(trade(NOW - 3 * HOUR, '0.1'), fee(NOW - 2 * HOUR))];
    expect(streak(NOW, closed)).toBe(2);
    // As of a moment before the booking the entry is not read (and the history is refused for its future time).
    expect(streak(NOW - 2.5 * HOUR, closed)).toBe(0);
  });

  test('R15: no larger size after it', () => {
    const last = withLate(trade(LAST_WEEK, '0.1', { notional: usd('2.2') }), fee(LAST_WEEK + HOUR));
    const d = evaluateEntry(at(NOW, [last], { latches: latches({ sizeStepUpApproved: true }) }), req(NOW)) as EntryAllowed;
    expect(d.caps.some((c) => c.control === 'R15')).toBe(true);
    expect(d.notional).toBeLessThanOrEqual(usd('2.2'));
  });

  test('R8: counted among the 5 losses in 20', () => {
    // Four losses and five wins, one win turned into a loss by a late fee: five losses.
    const closed = Array.from({ length: 9 }, (_, i) => trade(LAST_WEEK - (9 - i) * HOUR, i % 2 === 0 && i < 8 ? '-0.1' : '0.1'));
    closed[1] = withLate(closed[1]!, fee(LAST_WEEK));
    expect(codes(evaluateEntry(at(NOW, closed), req(NOW)))).toContain('loss_review');
    const plain = closed.map((t) => ({ ...t, late: [] }));
    expect(codes(evaluateEntry(at(NOW, plain), req(NOW)))).not.toContain('loss_review');
  });

  test('a late gain alone keeps a win a win; a late loss with no dollar value makes it a loss, a late gain with none changes nothing', () => {
    expect(streak(NOW, [withLate(trade(NOW - 3 * HOUR, '0.1'), gain(NOW - 2 * HOUR))])).toBe(0);
    expect(streak(NOW, [withLate(trade(NOW - 3 * HOUR, '0.1'), late(NOW - 2 * HOUR, null, -5_000n))])).toBe(1);
    expect(streak(NOW, [withLate(trade(NOW - 3 * HOUR, '0.1'), late(NOW - 2 * HOUR, null, 5_000n))])).toBe(0);
    // A small late fee that leaves it above zero is not a loss.
    expect(streak(NOW, [withLate(trade(NOW - 3 * HOUR, '0.3'), fee(NOW - 2 * HOUR))])).toBe(0);
  });
});

describe('sticky', () => {
  test('a late gain after a late loss does not make it a win again', () => {
    const t = withLate(trade(NOW - 4 * HOUR, '0.1'), fee(NOW - 3 * HOUR), gain(NOW - 2 * HOUR));
    expect(streak(NOW, [t])).toBe(1);
    const d = evaluateEntry(at(NOW, [{ ...t, notional: usd('2.2') }], { latches: latches({ sizeStepUpApproved: true }) }), req(NOW)) as EntryAllowed;
    expect(d.caps.some((c) => c.control === 'R15')).toBe(true);
  });
});

describe('R8 timed from the streak\'s latest loss moment', () => {
  test('a flip that completes a streak starts the cooldown when booked, after the last close\'s cooldown has passed', () => {
    const closed = [trade(NOW - 6 * HOUR, '-0.1'), withLate(trade(NOW - 5 * HOUR, '0.1'), fee(NOW - HOUR))];
    expect(codes(evaluateEntry(at(NOW, closed), req(NOW)))).toContain('loss_cooldown');
    // Two hours after the booking it has run out.
    const later = NOW - HOUR + TRIAL_POLICY.loss.cooldownMs;
    expect(codes(evaluateEntry(at(later, closed), req(later)))).not.toContain('loss_cooldown');
  });

  test('a flip booked today completes a streak of closes from yesterday: paused for today; the closes\' day is not rewritten', () => {
    const closed = [trade(DAY_START - 3 * HOUR, '-0.1'), trade(DAY_START - 2 * HOUR, '-0.1'), withLate(trade(DAY_START - HOUR, '0.1'), fee(DAY_START + HOUR))];
    expect(codes(evaluateEntry(at(NOW, closed), req(NOW)))).toContain('loss_day_pause');
    // Yesterday, after the closes and before the booking, the last trade was a win: no streak, no pause.
    const yesterday = DAY_START - 30 * 60_000;
    expect(riskSnapshot(at(yesterday, closed.map((t) => ({ ...t, late: [] }))))!.lossStreak).toBe(0);
    expect(codes(evaluateEntry(at(yesterday, closed.map((t) => ({ ...t, late: [] }))), req(yesterday)))).not.toContain('loss_day_pause');
  });
});

describe('the review window', () => {
  test('a trade closed before the review and turned into a loss after it counts', () => {
    const reviewed = LAST_WEEK;
    const after = Array.from({ length: 4 }, (_, i) => trade(reviewed + (i + 1) * HOUR, '-0.1'));
    const before = withLate(trade(reviewed - HOUR, '0.1'), fee(reviewed + 30 * 60_000));
    const l = latches({ lossReviewedAtMs: reviewed });
    expect(codes(evaluateEntry(at(NOW, [before, ...after], { latches: l }), req(NOW)))).toContain('loss_review');
    // Its fee booked before the review: the owner saw it; not counted again.
    const seen = withLate(trade(reviewed - HOUR, '0.1'), fee(reviewed - 30 * 60_000));
    expect(codes(evaluateEntry(at(NOW, [seen, ...after], { latches: l }), req(NOW)))).not.toContain('loss_review');
  });
});

describe('the money is counted once', () => {
  test('equity, the day\'s and the week\'s loss are the same with the late entries on the trade', () => {
    const t = trade(NOW - 3 * HOUR, '0.1');
    const cost = { atMs: NOW - 2 * HOUR, amount: usd('0.2'), kind: 'late_settlement' as const };
    const s0 = riskSnapshot(at(NOW, [t], { account: account({ closedTrades: [t], costs: [cost] }) }))!;
    const s1 = riskSnapshot(at(NOW, [t], { account: account({ closedTrades: [withLate(t, fee(NOW - 2 * HOUR))], costs: [cost] }) }))!;
    expect([s1.equity, s1.dayLoss, s1.weekLoss, s1.highWaterMark]).toEqual([s0.equity, s0.dayLoss, s0.weekLoss, s0.highWaterMark]);
    expect(s1.lossStreak).toBe(1);
    expect(s0.lossStreak).toBe(0);
  });
});

describe('blind to what has not been booked', () => {
  test('a late entry dated after now is never read: not a loss, and the history is refused for its future time', () => {
    const closed = [withLate(trade(NOW - 3 * HOUR, '0.1'), fee(NOW + HOUR))];
    expect(streak(NOW, closed)).toBe(0);
    expect(codes(evaluateEntry(at(NOW, closed), req(NOW)))).toContain('bankroll_invalid');
  });
});
