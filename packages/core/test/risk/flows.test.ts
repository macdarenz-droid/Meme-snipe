// RISK-1b item 1: deposits and withdrawals are neither profit nor loss at any limit. Drawdown (R10, R6a) and the weekly
// limit (R9, R6b) are time-weighted: a flow scales the high-water mark and the weekly base by the same proportion as
// equity, so the drawdown percentage is unchanged. The daily limit is a fixed dollar amount, so today's loss is counted
// in dollars, flow-neutral. Every test here uses a flow; the same figures without the flow are checked alongside.
import { describe, expect, test } from 'vitest';
import { TRIAL_POLICY, usd } from '../../src/config/index.ts';
import { type EntryAllowed, evaluateEntry, evaluateExit } from '../../src/risk/index.ts';
import { type MicroUsd, lamportsToMicroUsd, mulDiv } from '../../src/units/index.ts';
import { DAY_START, HOUR, NOW, PRICE, WEEK_START, account, baseInput, baseRequest, codes, trade } from './helpers.ts';

const ofBpsUsd = (amount: bigint, bps: number) => mulDiv(amount, BigInt(bps), 10_000n, 'floor');

const LAST_WEEK = WEEK_START - 30 * HOUR;
const THIS_WEEK = WEEK_START + 5 * HOUR;
const neg = (v: bigint) => -v as MicroUsd;
const flow = (atMs: number, amount: bigint) => ({ atMs, amount: amount as MicroUsd });

describe('R10 and R6a: drawdown is time-weighted', () => {
  test('withdrawing $4 at E $15 / HWM $20 does not trip the kill switch (drawdown stays 25%)', () => {
    const closed = [trade(LAST_WEEK - HOUR, '-5', { notional: usd('5') })];
    const input = baseInput({ account: account({ closedTrades: closed, flows: [flow(LAST_WEEK, neg(usd('4')))] }) });
    const d = evaluateEntry(input, baseRequest());
    expect(codes(d)).not.toContain('kill_switch');
    expect(d.trips).not.toContain('kill_switch');
    expect(evaluateExit(input).trips).toEqual([]);
    expect(d.snapshot).toMatchObject({ equity: usd('11') });
    expect(d.snapshot?.highWaterMark).toBe(usd('14.666667')); // 20 x 11/15, rounded up
  });
  test('a deposit during a drawdown does not hide it: the mark scales up with equity', () => {
    const closed = [trade(LAST_WEEK - HOUR, '-5', { notional: usd('5') })];
    const d = evaluateEntry(baseInput({ account: account({ closedTrades: closed, flows: [flow(LAST_WEEK, usd('5'))] }) }), baseRequest());
    expect(d.snapshot).toMatchObject({ equity: usd('20') });
    expect(d.snapshot?.highWaterMark).toBe(usd('26.666667')); // 20 x 20/15: still a 25% drawdown
  });
  test('the same 25% drawdown trips nothing with or without a flow, and 30% trips with or without one', () => {
    for (const f of [[], [flow(LAST_WEEK, neg(usd('4')))], [flow(LAST_WEEK, usd('10'))]]) {
      const at25 = baseInput({ account: account({ closedTrades: [trade(LAST_WEEK - HOUR, '-5', { notional: usd('5') })], flows: f }) });
      expect(codes(evaluateEntry(at25, baseRequest())), JSON.stringify(f, (_k, v) => (typeof v === 'bigint' ? `${v}` : v))).not.toContain('kill_switch');
      const at30 = baseInput({ account: account({ closedTrades: [trade(LAST_WEEK - HOUR, '-6', { notional: usd('5') })], flows: f }) });
      expect(codes(evaluateEntry(at30, baseRequest())), JSON.stringify(f, (_k, v) => (typeof v === 'bigint' ? `${v}` : v))).toContain('kill_switch');
    }
  });
  test('a withdrawal does not move the drawdown step-down (R2) either', () => {
    // 9% down, then a large withdrawal: still 9% down, so no reset to the minimum is forced by the withdrawal.
    const closed = [trade(LAST_WEEK - 2 * HOUR, '2'), trade(LAST_WEEK - HOUR, '-1.98', { notional: usd('5') })];
    const d = evaluateEntry(baseInput({ latches: { killTrippedAtMs: null, killRearmedAtMs: null, weeklyTrippedAtMs: null, weeklyReviewedAtMs: null, lossReviewedAtMs: null, sizeStepUpApproved: true },
      account: account({ closedTrades: closed, flows: [flow(LAST_WEEK, neg(usd('10')))] }) }), baseRequest());
    expect(d.allow && d.caps.some((c) => c.name.includes('drawdown'))).toBe(false);
  });
});

describe('R9 and R6b: the weekly limit is time-weighted, and never looser than counting in dollars', () => {
  test('a withdrawal after a weekly loss scales the base down: the remaining allowance shrinks with the capital', () => {
    // Week start $20, -$1, then withdraw $5: $14 left. In dollars $3 of the $4 allowance remains and q + C fits; time-
    // weighted, the base is 20 x 14/19 = $14.74, 20% of it is $2.95 and $0.74 of it is lost: $2.21 remains, and q + C
    // (about $2.79) does not fit. The tighter answer applies.
    const input = baseInput({ account: account({ closedTrades: [trade(THIS_WEEK, '-1', { notional: usd('5') })], flows: [flow(THIS_WEEK + HOUR, neg(usd('5')))] }) });
    expect(codes(evaluateEntry(input, baseRequest()))).toContain('full_loss_week');
  });
  test('a withdrawal with no loss this week does not trip the weekly trigger', () => {
    const input = baseInput({ account: account({ flows: [flow(THIS_WEEK, neg(usd('8')))] }) });
    const c = codes(evaluateEntry(input, baseRequest()));
    expect(c).not.toContain('weekly_loss');
    expect(evaluateExit(input).trips).toEqual([]);
  });
  test('a deposit after a weekly loss does not loosen the limit beyond the dollar count', () => {
    // Week start $20, -$3.30 (0.70 left in dollars), then deposit $10: in unitized terms more would remain, but the
    // dollar count still refuses: the tighter of the two applies.
    const input = baseInput({ account: account({ closedTrades: [trade(THIS_WEEK, '-3.3', { notional: usd('5') })], flows: [flow(THIS_WEEK + HOUR, usd('10'))] }) });
    expect(codes(evaluateEntry(input, baseRequest()))).toContain('full_loss_week');
  });
  test('a 20% unitized weekly loss trips after a withdrawal even when the dollar loss is under $4', () => {
    // Week start $20, -$2, withdraw $9 ($9 left, base 20 x 9/18 = $10), then -$1.50: $7.50 left, 25% of the base lost,
    // although only $3.50 (under $4) in dollars.
    const closed = [trade(THIS_WEEK, '-2', { notional: usd('5') }), trade(THIS_WEEK + 2 * HOUR, '-1.5', { notional: usd('5') })];
    const input = baseInput({ account: account({ closedTrades: closed, flows: [flow(THIS_WEEK + HOUR, neg(usd('9')))] }) });
    expect(evaluateExit(input).tripped.map((r) => r.code)).toContain('weekly_loss');
  });
});

describe('R7: the daily loss is counted in dollars, flow-neutral', () => {
  test('a withdrawal today is not a loss; a deposit today does not hide one', () => {
    expect(evaluateEntry(baseInput({ account: account({ flows: [flow(DAY_START + HOUR, neg(usd('10')))] }) }), baseRequest()).snapshot?.dayLoss).toBe(0n);
    const hidden = account({ closedTrades: [trade(DAY_START + HOUR, '-1.5')], flows: [flow(DAY_START + 2 * HOUR, usd('10'))] });
    expect(codes(evaluateEntry(baseInput({ account: hidden }), baseRequest()))).toContain('daily_loss');
  });
  test('a withdrawal after a loss today keeps the whole dollar loss', () => {
    const input = baseInput({ account: account({ closedTrades: [trade(DAY_START + HOUR, '-1')], flows: [flow(DAY_START + 2 * HOUR, neg(usd('10')))] }) });
    expect(evaluateEntry(input, baseRequest()).snapshot?.dayLoss).toBe(usd('1'));
    expect(NOW).toBeGreaterThan(DAY_START + 2 * HOUR);
  });
});

describe('RISK-1b item 2: planned R, stressed executable loss and reserved loss', () => {
  test('$2 at a 20% stop with 25% emergency slippage: stressed loss is $0.80 plus C; reserved is q + C', () => {
    const d = evaluateEntry(baseInput(), baseRequest({ stopBps: 2000 })) as EntryAllowed;
    expect(d.allow).toBe(true);
    const c = lamportsToMicroUsd(d.maxCostsLamports, PRICE, 'ceil');
    expect(d.loss.stressed).toBe(usd('0.8') + c);
    expect(d.loss.reserved).toBe(lamportsToMicroUsd(d.reservation.amount, PRICE, 'ceil'));
    expect(d.reservation.amount).toBe(d.spendLamports + d.maxCostsLamports);
  });
  test('for every stop the figures are ordered, and the reservation bounds the stressed loss', () => {
    for (const stopBps of [1, 100, 500, 1000, 1500, 1999, 2000]) {
      const d = evaluateEntry(baseInput(), baseRequest({ stopBps })) as EntryAllowed;
      if (!d.allow) continue;
      expect(d.loss.plannedRisk, String(stopBps)).toBeLessThanOrEqual(d.loss.stressed);
      expect(d.loss.stressed, String(stopBps)).toBeLessThanOrEqual(d.loss.reserved);
      expect(d.loss.plannedRisk, String(stopBps)).toBeLessThanOrEqual(ofBpsUsd(TRIAL_POLICY.capital.bankroll, TRIAL_POLICY.loss.plannedRiskBps));
    }
  });
});
