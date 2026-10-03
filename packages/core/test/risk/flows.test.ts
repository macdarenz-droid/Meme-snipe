// RISK-1b item 1: deposits and withdrawals are neither profit nor loss at any limit. Drawdown (R10, R6a) and the weekly
// limit (R9, R6b) are time-weighted: a flow scales the high-water mark and the weekly base by the same proportion as
// equity, so the drawdown percentage is unchanged. The daily limit is a fixed dollar amount, so today's loss is counted
// in dollars, flow-neutral. Every test here uses a flow; the same figures without the flow are checked alongside.
import { describe, expect, test } from 'vitest';
import { TRIAL_POLICY, usd } from '../../src/config/index.ts';
import { type EntryAllowed, NO_LATCHES, economicNav, evaluateEntry, evaluateExit, evaluateWithdrawal, maxTradeCosts, opsReserve } from '../../src/risk/index.ts';
import { type Lamports, type MicroUsd, lamports, lamportsToMicroUsd, microUsdToLamports, mulDiv } from '../../src/units/index.ts';
import { fixedCosts } from '../../src/costs/index.ts';
import { DAY_START, HOUR, MINUTE, MINT_A, MINT_B, NETWORK, NOW, PRICE, RENT, SOL, WEEK_START, account, baseInput, baseRequest, codes, latches, trade } from './helpers.ts';

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

describe('RISK-1b edges (mutation)', () => {
  const kill = (input: ReturnType<typeof baseInput>) => codes(evaluateEntry(input, baseRequest())).includes('kill_switch');
  test('a trade and a withdrawal at the same instant: the trade counts first', () => {
    // Trade first: E $15 at HWM $20, then the withdrawal scales the mark to $14.67 (25% down). Flow first would give
    // HWM $16 and E $11, a 31% drawdown and a false kill.
    const input = baseInput({ account: account({ closedTrades: [trade(LAST_WEEK, '-5', { notional: usd('5') })], flows: [flow(LAST_WEEK, neg(usd('4')))] }) });
    expect(evaluateEntry(input, baseRequest()).snapshot?.highWaterMark).toBe(usd('14.666667'));
    expect(kill(input)).toBe(false);
  });
  test('money added after equity reached zero does not erase the drawdown', () => {
    const input = baseInput({ account: account({ closedTrades: [trade(LAST_WEEK - HOUR, '-20', { notional: usd('5') })], flows: [flow(LAST_WEEK, usd('20'))] }) });
    expect(evaluateEntry(input, baseRequest()).snapshot).toMatchObject({ equity: usd('20'), highWaterMark: usd('40') });
    expect(kill(input)).toBe(true);
  });
  test('money added at one micro-dollar of equity scales the mark with it', () => {
    const input = baseInput({ account: account({ closedTrades: [trade(LAST_WEEK - HOUR, '-19.999999', { notional: usd('5') })], flows: [flow(LAST_WEEK, usd('1'))] }) });
    // 20 x 1.000001 / 0.000001
    expect(evaluateEntry(input, baseRequest()).snapshot?.highWaterMark).toBe(usd('20000020'));
  });
  test('a flow exactly at Monday 00:00 belongs to the new week and scales its base', () => {
    const input = baseInput({ account: account({ closedTrades: [trade(WEEK_START - HOUR, '-1', { notional: usd('5') })], flows: [flow(WEEK_START, neg(usd('9')))] }) });
    const d = evaluateEntry(input, baseRequest());
    expect(d.snapshot).toMatchObject({ weekStartEquity: usd('19'), weekBase: usd('10'), weekBaseLoss: 0n });
  });
  test('the weekly base follows equity through the week: a loss before a withdrawal sets the ratio', () => {
    const input = baseInput({ account: account({ closedTrades: [trade(THIS_WEEK, '-1', { notional: usd('5') })], flows: [flow(THIS_WEEK + HOUR, neg(usd('5')))] }) });
    expect(evaluateEntry(input, baseRequest()).snapshot?.weekBase).toBe(usd('14.736843')); // 20 x 14/19, rounded up
  });
  test('the dollar count alone trips at its exact limit (rounded down) after a deposit', () => {
    // $20.000001 at week start, +$10 deposit, then -$4: $4 = floor(20% of 20.000001) in dollars; the time-weighted
    // count ($4 of a $30.000001 base) is far from its limit.
    const closed = [trade(THIS_WEEK + 2 * HOUR, '-4', { notional: usd('5') })];
    const input = baseInput({ account: account({ openingEquity: usd('20.000001'), closedTrades: closed, flows: [flow(THIS_WEEK + HOUR, usd('10'))] }) });
    expect(evaluateExit(input).tripped.map((r) => r.code)).toContain('weekly_loss');
  });
  test('the time-weighted count alone trips at its exact limit (rounded down) after a withdrawal', () => {
    // $20, withdraw $9.999999 → base $10.000001; then -$2 = floor(20% of the base); in dollars $2 is far from $4.
    const closed = [trade(THIS_WEEK + 2 * HOUR, '-2', { notional: usd('5') })];
    const input = baseInput({ account: account({ closedTrades: closed, flows: [flow(THIS_WEEK + HOUR, neg(usd('9.999999')))] }) });
    const d = evaluateExit(input);
    expect(d.tripped.map((r) => r.code)).toContain('weekly_loss');
    expect(evaluateEntry(input, baseRequest()).snapshot?.weekBase).toBe(usd('10.000001'));
  });
  test('after a deposit the dollar count can be the tighter room', () => {
    // -$1.30 then +$10: in dollars $2.70 remains (q + C, about $2.79, does not fit); time-weighted about $4.14 would.
    const input = baseInput({ account: account({ closedTrades: [trade(THIS_WEEK, '-1.3', { notional: usd('5') })], flows: [flow(THIS_WEEK + HOUR, usd('10'))] }) });
    expect(codes(evaluateEntry(input, baseRequest()))).toEqual(['full_loss_week']);
  });
  test('the loss figures are exact: planned R rounded up with F, stressed loss rounded up with C', () => {
    const d = evaluateEntry(baseInput({ latches: { killTrippedAtMs: null, killRearmedAtMs: null, weeklyTrippedAtMs: null, weeklyReviewedAtMs: null, lossReviewedAtMs: null, sizeStepUpApproved: true } }), baseRequest({ stopBps: 1777 })) as EntryAllowed;
    expect(d.allow).toBe(true);
    const q = d.notional;
    const f = lamportsToMicroUsd(fixedCosts(NETWORK, RENT).total as Lamports, PRICE, 'ceil');
    const c = lamportsToMicroUsd(d.maxCostsLamports, PRICE, 'ceil');
    const plannedNum = q * BigInt(1777 + TRIAL_POLICY.costGate.maxRoundTripBps);
    expect(plannedNum % 10_000n).not.toBe(0n); // so rounding shows
    expect(d.loss.plannedRisk).toBe(mulDiv(q, BigInt(1777 + TRIAL_POLICY.costGate.maxRoundTripBps), 10_000n, 'ceil') + f);
    const e = 2500n;
    const stressedNum = q * (1777n * 10_000n + e * 10_000n - 1777n * e);
    expect(stressedNum % 100_000_000n).not.toBe(0n);
    expect(d.loss.stressed).toBe(mulDiv(q, 1777n * 10_000n + e * 10_000n - 1777n * e, 100_000_000n, 'ceil') + c);
  });
});

// ---------- Follow-up rulings (DECISIONS, second round): equity units, withdrawals, boundaries ----------
describe('equity units use one executable valuation before and after each flow', () => {
  test('a withdrawal while a position shows a marked loss scales the mark at the marked value', () => {
    // Realized $20, an open position marked $5 below cost (executable equity $15), withdraw $4: the mark scales by
    // 11/15 (not by realized 16/20), so the drawdown stays 25% and nothing trips.
    const f = { atMs: LAST_WEEK, amount: neg(usd('4')), navBefore: usd('15') };
    const input = baseInput({ account: account({ flows: [f] }) });
    expect(evaluateEntry(input, baseRequest()).snapshot?.highWaterMark).toBe(usd('14.666667'));
  });
  test('a flow without a positive valuation is refused (unknown is never assumed)', () => {
    for (const navBefore of [0n, -1n]) {
      const input = baseInput({ account: account({ flows: [{ atMs: LAST_WEEK, amount: usd('1'), navBefore: navBefore as MicroUsd }] }) });
      expect(codes(evaluateEntry(input, baseRequest())), String(navBefore)).toContain('bankroll_invalid');
    }
  });
  test('a deposit never resets a latched trigger', () => {
    const deposit = [{ atMs: NOW - HOUR, amount: usd('50'), navBefore: usd('20') }];
    const kill = baseInput({ account: account({ flows: deposit }), latches: { ...NO_LATCHES, killTrippedAtMs: NOW - 2 * HOUR } });
    expect(codes(evaluateEntry(kill, baseRequest()))).toContain('kill_switch');
    const weekly = baseInput({ account: account({ flows: deposit }), latches: { ...NO_LATCHES, weeklyTrippedAtMs: NOW - 2 * HOUR } });
    expect(codes(evaluateEntry(weekly, baseRequest()))).toContain('weekly_review');
  });
});

describe('withdrawals: queued while anything is open, never into the reserve', () => {
  const sol = (n: bigint) => lamports(n * SOL);
  const req = (amount: bigint, reconciled = true) => ({ amount: lamports(amount), network: NETWORK, rent: RENT, reconciled });
  test('allowed when flat and reconciled, up to the balance less the operations reserve', () => {
    const input = baseInput();
    const d = evaluateWithdrawal(input, req(SOL / 2n));
    expect(d).toMatchObject({ allow: true, reasons: [] });
    const reserve = opsReserve(TRIAL_POLICY, { rent: RENT }, maxTradeCosts(TRIAL_POLICY, { network: NETWORK, rent: RENT }).perExitAttempt);
    expect(d.maxAmount).toBe(SOL - reserve);
    expect(evaluateWithdrawal(input, req(SOL - reserve)).allow).toBe(true);
    expect(evaluateWithdrawal(input, req(SOL - reserve + 1n)).reasons.map((r) => r.code)).toEqual(['withdrawal_over_free_cash']);
  });
  test('queued while a position, an unresolved entry or a reservation is open, or before reconciliation', () => {
    const open = { mint: MINT_B, openedAtMs: NOW - HOUR, notional: usd('2'), mark: usd('2'), markAtMs: NOW - 100 };
    const cases: [string, ReturnType<typeof baseInput>, boolean][] = [
      ['position', baseInput({ account: account({ openPositions: [open] }) }), true],
      ['unresolved entry', baseInput({ account: account({ unresolvedEntries: [{ mint: MINT_A }] }) }), true],
      ['held reservation', baseInput({ account: account({ heldReservations: lamports(1n) }) }), true],
      ['not reconciled', baseInput(), false],
    ];
    for (const [name, input, reconciled] of cases) {
      const d = evaluateWithdrawal(input, req(1_000n, reconciled));
      expect(d.allow, name).toBe(false);
      expect(d.reasons.map((r) => r.code), name).toContain(name === 'not reconciled' ? 'withdrawal_unreconciled' : 'withdrawal_queued');
    }
  });
  test('an unknown or stale balance, or a non-positive amount, refuses', () => {
    const i = baseInput();
    expect(evaluateWithdrawal({ ...i, market: { ...i.market, solBalance: null } }, req(1_000n)).reasons.map((r) => r.code)).toContain('balance_unknown');
    expect(evaluateWithdrawal({ ...i, market: { ...i.market, solBalance: { value: sol(1n), atMs: NOW - 60_000 } } }, req(1_000n)).reasons.map((r) => r.code)).toContain('balance_stale');
    expect(evaluateWithdrawal(i, req(0n)).reasons.map((r) => r.code)).toContain('withdrawal_invalid');
  });
});

describe('daily and weekly boundaries: the realized-boundary loss (kept) and the marked-boundary change (reported)', () => {
  test('an open loss already counted yesterday is counted again today by the realized boundary, not by the marked one', () => {
    // The position was opened yesterday and was already $1 down at midnight (marked equity $19 then). It has not moved.
    const open = { mint: MINT_B, openedAtMs: DAY_START - 5 * HOUR, notional: usd('5'), mark: usd('4'), markAtMs: NOW - 100 };
    const input = baseInput({ account: account({ openPositions: [open], markedAtDayStart: usd('19'), markedAtWeekStart: usd('19') }) });
    const d = evaluateEntry(input, baseRequest());
    expect(d.snapshot?.dayLoss).toBe(usd('1')); // counted again today (stricter; kept until the owner changes it)
    expect(d.snapshot?.dayChangeMarked).toBe(0n); // no change since midnight at the same valuation
    expect(d.snapshot?.weekChangeMarked).toBe(0n);
  });
  test('the marked-boundary change is net of flows, and unknown when no boundary valuation was recorded', () => {
    const f = { atMs: DAY_START + HOUR, amount: neg(usd('5')), navBefore: usd('20') };
    const input = baseInput({ account: account({ flows: [f], closedTrades: [trade(DAY_START + 2 * HOUR, '-0.5')], markedAtDayStart: usd('20'), markedAtWeekStart: null }) });
    const d = evaluateEntry(input, baseRequest());
    expect(d.snapshot?.dayChangeMarked).toBe(neg(usd('0.5')));
    expect(d.snapshot?.weekChangeMarked).toBeNull();
  });
  test('neither boundary figure ever blocks a protective exit', () => {
    // Both figures far past the daily and weekly limits, with a position open: exits are always allowed.
    const open = { mint: MINT_B, openedAtMs: DAY_START - 5 * HOUR, notional: usd('5'), mark: usd('0'), markAtMs: NOW - 100 };
    const input = baseInput({ account: account({ openPositions: [open], closedTrades: [trade(DAY_START + HOUR, '-4')],
      markedAtDayStart: usd('25'), markedAtWeekStart: usd('25') }) });
    const e = evaluateExit(input);
    expect(e.allow).toBe(true);
    expect(e.tripped.map((r) => r.code)).toEqual(expect.arrayContaining(['daily_loss', 'weekly_loss']));
    const d = evaluateEntry(input, baseRequest());
    expect(d.snapshot?.dayLoss).toBe(usd('9'));
    expect(d.snapshot?.dayChangeMarked).toBe(neg(usd('14')));
    // Malformed boundary inputs cannot block one either.
    expect(evaluateExit(baseInput({ account: account({ markedAtDayStart: neg(usd('1000')), markedAtWeekStart: usd('1000000') }) })).allow).toBe(true);
  });
});

// ---------- Third-opinion rulings: capital measured in SOL as well ----------
describe('capital is the lower of ledger equity and wallet-marked equity', () => {
  // Wallet-marked equity: wallet SOL above the operations floor at a fresh SOL/USD price, plus open positions marked as
  // today. Ledger equity stays $20 throughout these tests; only the wallet's value moves.
  const walletAt = (usdValue: string, price = PRICE) => {
    const lamportsFor = microUsdToLamports(usd(usdValue), price, 'ceil') + TRIAL_POLICY.reserve.opsFloor;
    const i = baseInput();
    return { ...i, market: { ...i.market, solBalance: { value: lamports(lamportsFor), atMs: NOW }, solPrice: { value: price, atMs: NOW } } };
  };
  test('a 30% fall in SOL reaches the kill line: the kill switch trips on economic NAV and latches', () => {
    const d = evaluateEntry(walletAt('14'), baseRequest());
    expect(codes(d)).toEqual(expect.arrayContaining(['kill_switch', 'wallet_below_kill_line']));
    expect(d.snapshot?.walletEquity).toBe(usd('14'));
    expect(d.snapshot?.nav).toBe(usd('14'));
    expect(d.trips).toEqual(['kill_switch']); // supervisor, 2026-10-03: economic NAV in both directions, latched
  });
  test('a smaller fall tightens planned risk (R5) and the weekly room before anything trips', () => {
    // $17 of wallet capital: 2.75% is $0.4675, so 1R at a 20% stop (plus the 5% cost ceiling) no longer fits $2;
    // at $20 it does.
    expect(codes(evaluateEntry(walletAt('17'), baseRequest({ stopBps: 2000 })))).toEqual(['planned_risk']);
    expect(evaluateEntry(walletAt('20'), baseRequest({ stopBps: 2000 })).allow).toBe(true);
    // $12: 20% is $2.40, less than q + C.
    expect(codes(evaluateEntry(walletAt('12'), baseRequest()))).toContain('full_loss_week');
  });
  test('a rise in SOL loosens nothing', () => {
    const at20 = evaluateEntry(walletAt('20'), baseRequest()) as EntryAllowed;
    const at40 = evaluateEntry(walletAt('40'), baseRequest()) as EntryAllowed;
    expect(at20.allow && at40.allow).toBe(true);
    expect(at40.reservation.limits.maxHeld).toBe(at20.reservation.limits.maxHeld);
    expect(at40.caps.map((c) => [c.name, c.notional]).filter(([n]) => n !== 'cash after the operations reserve'))
      .toEqual(at20.caps.map((c) => [c.name, c.notional]).filter(([n]) => n !== 'cash after the operations reserve'));
  });
  test('a stale or missing SOL price, or no balance, means no entry', () => {
    const i = walletAt('20');
    expect(codes(evaluateEntry({ ...i, market: { ...i.market, solPrice: null } }, baseRequest()))).toContain('sol_price_unknown');
    expect(codes(evaluateEntry({ ...i, market: { ...i.market, solBalance: null } }, baseRequest()))).toContain('balance_unknown');
  });
  test('after a withdrawal the weekly room is at most 20% of what remains', () => {
    // No loss this week; $15 withdrawn leaves $5 of capital: the room is $1, so q + C cannot fit.
    const input = baseInput({ account: account({ flows: [flow(THIS_WEEK, neg(usd('15')))] }) });
    expect(codes(evaluateEntry(input, baseRequest()))).toContain('full_loss_week');
  });
});

// ---------- Supervisor refinement (DECISIONS 90fac89): three purposes, three measures ----------
describe('R10 on economic NAV per unit', () => {
  // Economic NAV: wallet SOL above the operations floor at the fresh price, plus positions at their executable marks,
  // gains included. Ledger equity stays $20 in these tests unless a trade says otherwise.
  const lamportsFor = (usdValue: string) => microUsdToLamports(usd(usdValue), PRICE, 'ceil') + TRIAL_POLICY.reserve.opsFloor;
  const at = (wallet: string, patch: Parameters<typeof account>[0] = {}, extra: Partial<Parameters<typeof baseInput>[0]> = {}) => {
    const i = baseInput({ account: account(patch), ...extra });
    return { ...i, market: { ...i.market, solBalance: { value: lamports(lamportsFor(wallet)), atMs: NOW }, solPrice: { value: PRICE, atMs: NOW } } };
  };
  const mark = (atMs: number, nav: string) => ({ atMs, nav: usd(nav) });

  test('a 30% fall from a recorded NAV peak trips and latches, with the ledger flat; one cent less does not', () => {
    const peak = { navMarks: [mark(LAST_WEEK, '30')] };
    const d = evaluateEntry(at('21', peak), baseRequest());
    expect(d.snapshot).toMatchObject({ nav: usd('21'), navHighWaterMark: usd('30'), equity: usd('20') });
    expect(codes(d)).toContain('kill_switch');
    expect(d.trips).toEqual(['kill_switch']);
    expect(evaluateExit(at('21', peak)).trips).toEqual(['kill_switch']);
    const above = evaluateEntry(at('21.01', peak), baseRequest());
    expect(codes(above)).not.toContain('kill_switch');
    expect(above.trips).toEqual([]);
  });

  test('a withdrawal is priced at NAV: it neither deepens the drawdown nor, as a deposit, hides it', () => {
    // Peak $30, then $10 withdrawn at a NAV of $25: the mark scales to 30 x 15/25 = $18 and NAV is $15 (16.7% down).
    const w = { navMarks: [mark(LAST_WEEK - HOUR, '30')], flows: [{ atMs: LAST_WEEK, amount: neg(usd('10')), navBefore: usd('25') }] };
    const dw = evaluateEntry(at('15', w), baseRequest());
    expect(dw.snapshot?.navHighWaterMark).toBe(usd('18'));
    expect(codes(dw)).not.toContain('kill_switch');
    // Peak $30, NAV $22 when $22 is deposited: the mark scales to 30 x 44/22 = $60, so $42 now is exactly 30% down.
    const dep = { navMarks: [mark(LAST_WEEK - HOUR, '30')], flows: [{ atMs: LAST_WEEK, amount: usd('22'), navBefore: usd('22') }] };
    const dd = evaluateEntry(at('42', dep), baseRequest());
    expect(dd.snapshot?.navHighWaterMark).toBe(usd('60'));
    expect(dd.trips).toEqual(['kill_switch']);
    expect(evaluateEntry(at('42.01', dep), baseRequest()).trips).toEqual([]);
  });

  test('a flow\'s own valuation is an observation: it can set the peak', () => {
    const f = { flows: [{ atMs: LAST_WEEK, amount: usd('5'), navBefore: usd('30') }] };
    expect(evaluateEntry(at('24.5', f), baseRequest()).snapshot?.navHighWaterMark).toBe(usd('35'));
  });

  test('positions count at their executable mark in both directions', () => {
    const up = { mint: MINT_B, openedAtMs: NOW - HOUR, notional: usd('5'), mark: usd('7'), markAtMs: NOW - 100 };
    const d = evaluateEntry(at('15', { openPositions: [up], entries: [{ mint: MINT_B, atMs: NOW - HOUR }] }), baseRequest());
    expect(d.snapshot?.nav).toBe(usd('22'));
    expect(d.snapshot?.openExposure).toBe(usd('5')); // ledger figures still count no unrealized gain
  });

  test('no NAV, and so no NAV trip, unless the valuation is consistent', () => {
    // Each case would trip at $15 against the $30 peak if the NAV were taken; the ledger kill line ($14) is not reached.
    const peak = [mark(LAST_WEEK, '30')];
    const stale = { mint: MINT_B, openedAtMs: NOW - HOUR, notional: usd('2'), mark: usd('2'), markAtMs: NOW - 60_000 };
    const cases: [string, ReturnType<typeof at>][] = [
      ['an entry still unresolved', at('15', { navMarks: peak, unresolvedEntries: [{ mint: MINT_B }] })],
      ['a stale position mark', at('15', { navMarks: peak, openPositions: [stale] })],
      ['a balance read before the latest close', (() => {
        const i = at('15', { navMarks: peak, closedTrades: [trade(NOW - 100, '0')] });
        return { ...i, market: { ...i.market, solBalance: { value: i.market.solBalance?.value ?? lamports(0n), atMs: NOW - 200 } } };
      })()],
      ['a stale SOL price', (() => {
        const i = at('15', { navMarks: peak });
        return { ...i, market: { ...i.market, solPrice: { value: PRICE, atMs: NOW - 60_000 } } };
      })()],
    ];
    for (const [name, input] of cases) {
      const d = evaluateEntry(input, baseRequest());
      expect(d.snapshot?.nav, name).toBeNull();
      expect(d.snapshot?.navHighWaterMark, name).toBeNull();
      expect(d.trips, name).toEqual([]);
      expect(evaluateExit(input).trips, name).toEqual([]);
    }
    // The same balance read at the close is consistent.
    expect(evaluateEntry(at('15', { navMarks: peak, closedTrades: [trade(NOW, '0')] }), baseRequest()).trips).toEqual(['kill_switch']);
  });

  test('an owner re-arm restarts the NAV mark at the first NAV seen at or after it; a deposit never clears the latch', () => {
    const tripped = { killTrippedAtMs: LAST_WEEK, killRearmedAtMs: THIS_WEEK };
    const before = [mark(LAST_WEEK - HOUR, '30')];
    expect(evaluateEntry(at('15', { navMarks: before }, { latches: latches(tripped) }), baseRequest()).snapshot?.navHighWaterMark).toBe(usd('15'));
    const after = [...before, mark(THIS_WEEK, '18'), mark(THIS_WEEK + HOUR, '16')];
    const d = evaluateEntry(at('12.6', { navMarks: after }, { latches: latches(tripped) }), baseRequest());
    expect(d.snapshot?.navHighWaterMark).toBe(usd('18'));
    expect(d.trips).toEqual(['kill_switch']);
    // Latched and not re-armed: a deposit that lifts NAV back above the line changes nothing.
    const latched = latches({ killTrippedAtMs: THIS_WEEK });
    const dep = { navMarks: before, flows: [{ atMs: THIS_WEEK + HOUR, amount: usd('30'), navBefore: usd('20') }] };
    expect(codes(evaluateEntry(at('50', dep, { latches: latched }), baseRequest()))).toContain('kill_switch');
  });

  test('a 10% NAV drawdown returns size to the minimum; 9.99% does not', () => {
    const peak = { navMarks: [mark(LAST_WEEK, '30')] };
    const step = { latches: latches({ sizeStepUpApproved: true }) };
    const reset = evaluateEntry(at('27', peak, step), baseRequest()) as EntryAllowed;
    expect(reset.caps.map((c) => c.name)).toContain('drawdown returns size to the minimum');
    const not = evaluateEntry(at('27.01', peak, step), baseRequest()) as EntryAllowed;
    expect(not.caps.map((c) => c.name)).not.toContain('drawdown returns size to the minimum');
  });

  test('the room above the NAV kill line caps the full loss when it is the tighter', () => {
    // NAV kill line $21; NAV $23 leaves $2, less than q + C. The ledger line ($14) would leave $6.
    const peak = { navMarks: [mark(LAST_WEEK, '30')] };
    expect(codes(evaluateEntry(at('23', peak), baseRequest()))).toEqual(['full_loss_kill_line']);
    const roomy = evaluateEntry(at('30', peak), baseRequest()) as EntryAllowed;
    expect(roomy.allow).toBe(true);
    // Equal room on both measures gives the same reservation limit as the ledger alone.
    const ledgerOnly = evaluateEntry(at('30'), baseRequest()) as EntryAllowed;
    expect(roomy.reservation.limits.maxHeld).toBeLessThanOrEqual(ledgerOnly.reservation.limits.maxHeld);
  });

  test('the ledger kill line still applies when a rise in SOL lifts NAV', () => {
    // A $6 trading loss: ledger equity $14, its kill line $14. NAV is $40 at a higher SOL price.
    const d = evaluateEntry(at('40', { closedTrades: [trade(LAST_WEEK, '-6', { notional: usd('5') })] }), baseRequest());
    expect(d.snapshot?.nav).toBe(usd('40'));
    expect(d.trips).toEqual(['kill_switch']);
  });

  test('daily and weekly loss count trading only: a fall in SOL is not a loss there', () => {
    const d = evaluateEntry(at('17'), baseRequest());
    expect(d.snapshot).toMatchObject({ dayLoss: 0n, weekLoss: 0n, weekBaseLoss: 0n, nav: usd('17') });
  });

  test('figures are reported in SOL as well, and not without a price', () => {
    const d = evaluateEntry(at('21', { navMarks: [mark(LAST_WEEK, '30')] }), baseRequest());
    const inSol = (v: string) => microUsdToLamports(usd(v), PRICE, 'floor');
    expect(d.snapshot).toMatchObject({ equitySol: inSol('20'), capitalSol: inSol('20'), navSol: inSol('21'), navHighWaterMarkSol: inSol('30') });
    const i = at('21');
    const none = evaluateEntry({ ...i, market: { ...i.market, solPrice: null } }, baseRequest());
    expect(none.snapshot).toMatchObject({ equitySol: null, capitalSol: null, navSol: null, navHighWaterMarkSol: null });
  });

  test('a recorded NAV that is not positive or from the future is refused', () => {
    expect(codes(evaluateEntry(at('20', { navMarks: [mark(LAST_WEEK, '0')] }), baseRequest()))).toContain('bankroll_invalid');
    expect(codes(evaluateEntry(at('20', { navMarks: [mark(NOW + 1, '20')] }), baseRequest()))).toContain('bankroll_invalid');
  });

  test('economicNav is the one definition: SOL above the floor plus every mark; no valid mark, no value', () => {
    const p = (m: MicroUsd | null) => ({ mint: MINT_B, openedAtMs: NOW, notional: usd('5'), mark: m, markAtMs: NOW });
    expect(economicNav(TRIAL_POLICY, lamports(lamportsFor('10')), PRICE, [p(usd('3')), p(usd('7'))])).toBe(usd('20'));
    expect(economicNav(TRIAL_POLICY, lamports(lamportsFor('10')), PRICE, [p(null)])).toBeNull();
    expect(economicNav(TRIAL_POLICY, lamports(lamportsFor('10')), PRICE, [p(neg(1n))])).toBeNull();
  });
});

describe('RISK-1b edges (mutation): NAV, capital in SOL, withdrawals', () => {
  const lamportsFor = (usdValue: string) => microUsdToLamports(usd(usdValue), PRICE, 'ceil') + TRIAL_POLICY.reserve.opsFloor;
  const at = (wallet: string, patch: Parameters<typeof account>[0] = {}, extra: Partial<Parameters<typeof baseInput>[0]> = {}) => {
    const i = baseInput({ account: account(patch), ...extra });
    return { ...i, market: { ...i.market, solBalance: { value: lamports(lamportsFor(wallet)), atMs: NOW }, solPrice: { value: PRICE, atMs: NOW } } };
  };
  const mark = (atMs: number, nav: string) => ({ atMs, nav: usd(nav) });
  const req = (amount: bigint, reconciled = true) => ({ amount: lamports(amount), network: NETWORK, rent: RENT, reconciled });
  const reserve = () => opsReserve(TRIAL_POLICY, { rent: RENT }, maxTradeCosts(TRIAL_POLICY, { network: NETWORK, rent: RENT }).perExitAttempt);

  test('NAV observations are taken in time order, whichever list they come from', () => {
    // A $10 withdrawal at $20, then a $30 peak: the mark is $30. The other way round, the $30 peak is halved to $15.
    const w = (atMs: number) => ({ atMs, amount: neg(usd('10')), navBefore: usd('20') });
    expect(evaluateEntry(at('25', { flows: [w(LAST_WEEK)], navMarks: [mark(THIS_WEEK, '30')] }), baseRequest()).snapshot?.navHighWaterMark).toBe(usd('30'));
    expect(evaluateEntry(at('12', { flows: [w(THIS_WEEK)], navMarks: [mark(LAST_WEEK, '30')] }), baseRequest()).snapshot?.navHighWaterMark).toBe(usd('15'));
  });

  test('a re-arm at this very instant restarts the NAV mark now; one in the future does not yet', () => {
    const peak = [mark(LAST_WEEK, '30')];
    const now = latches({ killTrippedAtMs: LAST_WEEK, killRearmedAtMs: NOW });
    expect(evaluateEntry(at('15', { navMarks: peak }, { latches: now }), baseRequest()).snapshot?.navHighWaterMark).toBe(usd('15'));
    const future = latches({ killTrippedAtMs: LAST_WEEK, killRearmedAtMs: NOW + 1 });
    expect(evaluateEntry(at('15', { navMarks: peak }, { latches: future }), baseRequest()).snapshot?.navHighWaterMark).toBe(usd('30'));
  });

  test('the NAV kill line rounds up, to the micro-dollar', () => {
    const peak = { navMarks: [mark(LAST_WEEK, '30.000001')] }; // 70% is 21.0000007
    expect(evaluateEntry(at('21.000001', peak), baseRequest()).trips).toEqual(['kill_switch']);
    expect(evaluateEntry(at('21.000002', peak), baseRequest()).trips).toEqual([]);
  });

  test('a zero mark is a valid mark, and a NAV of one micro-dollar is a valid record', () => {
    const p = { mint: MINT_B, openedAtMs: NOW, notional: usd('5'), mark: usd('0'), markAtMs: NOW };
    expect(economicNav(TRIAL_POLICY, lamports(lamportsFor('10')), PRICE, [p])).toBe(usd('10'));
    expect(codes(evaluateEntry(at('20', { navMarks: [{ atMs: LAST_WEEK, nav: 1n as MicroUsd }] }), baseRequest()))).not.toContain('bankroll_invalid');
  });

  test('wallet-marked equity adds the open positions, and a zero capital is reported as zero SOL', () => {
    const open = { mint: MINT_B, openedAtMs: NOW - HOUR, notional: usd('5'), mark: usd('3'), markAtMs: NOW - 100 };
    expect(evaluateEntry(at('10', { openPositions: [open] }), baseRequest()).snapshot?.walletEquity).toBe(usd('13'));
    const empty = evaluateEntry(at('0'), baseRequest()).snapshot;
    expect(empty).toMatchObject({ walletEquity: 0n, capital: 0n, capitalSol: 0n, navSol: 0n });
  });

  test('a price of one micro-dollar is still a price', () => {
    const i = baseInput();
    const d = evaluateEntry({ ...i, market: { ...i.market, solPrice: { value: 1n as MicroUsd, atMs: NOW } } }, baseRequest());
    expect(d.snapshot?.walletEquity).not.toBeNull();
  });

  test('the weekly room of 20% of capital rounds down, to the micro-dollar', () => {
    // Capital $19.000003: 20% is $3.8000006, the tightest room (kill room $5.000003, weekly room $4).
    const d = evaluateEntry(at('19.000003'), baseRequest()) as EntryAllowed;
    expect(d.allow).toBe(true);
    expect(d.reservation.limits.maxHeld).toBe(microUsdToLamports(usd('3.8'), PRICE, 'floor'));
  });

  test('the marked week change is net of this week\'s flows', () => {
    const f = { atMs: THIS_WEEK, amount: neg(usd('5')), navBefore: usd('20') };
    expect(evaluateEntry(baseInput({ account: account({ flows: [f], markedAtWeekStart: usd('20') }) }), baseRequest()).snapshot?.weekChangeMarked).toBe(0n);
  });

  test('a week that started at zero equity is refused even after a deposit', () => {
    const input = baseInput({ account: account({ closedTrades: [trade(LAST_WEEK, '-20', { notional: usd('20') })],
      flows: [{ atMs: THIS_WEEK, amount: usd('20'), navBefore: usd('1') }] }) });
    const d = evaluateEntry(input, baseRequest());
    expect(d.snapshot?.equity).toBe(usd('20'));
    expect(d.reasons.filter((r) => r.code === 'bankroll_invalid').map((r) => r.detail)).toEqual(['equity is not positive']);
  });

  test('withdrawals: one lamport is a valid amount; the most that may leave is exact in every case', () => {
    const i = baseInput();
    expect(evaluateWithdrawal(i, req(1n)).allow).toBe(true);
    // Over the free cash only: the most is the free cash.
    expect(evaluateWithdrawal(i, req(SOL)).maxAmount).toBe(SOL - reserve());
    // Unknown balance, or a balance inside the reserve: nothing.
    expect(evaluateWithdrawal({ ...i, market: { ...i.market, solBalance: null } }, req(1n)).maxAmount).toBe(0n);
    expect(evaluateWithdrawal({ ...i, market: { ...i.market, solBalance: { value: lamports(reserve() - 1n), atMs: NOW } } }, req(1n)).maxAmount).toBe(0n);
    // Not reconciled, or queued: nothing.
    expect(evaluateWithdrawal(i, req(1n, false)).maxAmount).toBe(0n);
    expect(evaluateWithdrawal(baseInput({ account: account({ heldReservations: lamports(1n) }) }), req(1n)).maxAmount).toBe(0n);
  });
});

describe('RISK-1b edges (mutation, left operands)', () => {
  test('after a re-arm the ledger mark restarts once, and later losses add up against it', () => {
    // Re-armed at $20; two $3 losses since: $14 is the kill line of the $20 restart.
    const l = latches({ killTrippedAtMs: LAST_WEEK - 2 * HOUR, killRearmedAtMs: LAST_WEEK });
    const closed = [trade(LAST_WEEK + HOUR, '-3'), trade(THIS_WEEK, '-3')];
    const d = evaluateEntry(baseInput({ account: account({ closedTrades: closed }), latches: l }), baseRequest());
    expect(d.snapshot?.highWaterMark).toBe(usd('20'));
    expect(d.trips).toContain('kill_switch');
  });
  test('a fractional stop distance is refused, never thrown on', () => {
    expect(codes(evaluateEntry(baseInput(), baseRequest({ stopBps: 1500.5 })))).toContain('stop_invalid');
  });
});

describe('account costs (WORKER-1 setup rent): realized equity and day and week loss, never a trade', () => {
  const setup = (atMs: number, amount: string) => ({ atMs, amount: usd(amount), kind: 'wallet_setup' as const });
  test('a setup cost lowers equity, leaves the high-water mark and counts in today\'s loss', () => {
    const d = evaluateEntry(baseInput({ account: account({ costs: [setup(DAY_START + HOUR, '0.5')] }) }), baseRequest());
    expect(d.snapshot).toMatchObject({ equity: usd('19.5'), highWaterMark: usd('20'), dayLoss: usd('0.5'), weekLoss: usd('0.5') });
    // Yesterday's cost is not today's loss.
    const y = evaluateEntry(baseInput({ account: account({ costs: [setup(DAY_START - HOUR, '0.5')] }) }), baseRequest());
    expect(y.snapshot).toMatchObject({ equity: usd('19.5'), dayLoss: 0n });
    // A cost at the very start of the day is today's.
    expect(evaluateEntry(baseInput({ account: account({ costs: [setup(DAY_START, '0.5')] }) }), baseRequest()).snapshot?.dayLoss).toBe(usd('0.5'));
  });
  test('a cost after a peak does not raise it, and a later winning trade is measured from the lower equity', () => {
    const d = evaluateEntry(baseInput({ account: account({ costs: [setup(LAST_WEEK, '1')], closedTrades: [trade(THIS_WEEK, '0.5')] }) }), baseRequest());
    expect(d.snapshot).toMatchObject({ equity: usd('19.5'), highWaterMark: usd('20') });
  });
  test('a cost is never a trade: streaks, cooldown, day pause, review count and R15 see only real trades', () => {
    const losses = [trade(NOW - 3 * HOUR, '-0.2'), trade(NOW - 2 * HOUR, '-0.2', { notional: usd('3') })];
    const win = [...losses.slice(0, 1), trade(NOW - 2 * HOUR, '0.1', { notional: usd('3') })];
    const cost = [setup(NOW - HOUR, '0.5')];
    // Two losses then a cost: still a streak of two (cooling down), and R15 caps at the last real trade's $3.
    const a = evaluateEntry(baseInput({ account: account({ closedTrades: losses, costs: cost }) }), baseRequest());
    const b = evaluateEntry(baseInput({ account: account({ closedTrades: losses }) }), baseRequest());
    expect(a.snapshot?.lossStreak).toBe(2);
    expect(codes(a).filter((c) => c.startsWith('loss_'))).toEqual(codes(b).filter((c) => c.startsWith('loss_')));
    // A loss then a win then a cost: the streak is zero, not one.
    expect(evaluateEntry(baseInput({ account: account({ closedTrades: win, costs: cost }) }), baseRequest()).snapshot?.lossStreak).toBe(0);
    // Three losses then a cost pause the day exactly as without it; four losses and a cost are not five in twenty.
    const three = [...losses, trade(NOW - 90 * MINUTE, '-0.2')];
    expect(codes(evaluateEntry(baseInput({ account: account({ closedTrades: three, costs: cost }) }), baseRequest()))).toContain('loss_day_pause');
    const four = Array.from({ length: 4 }, (_, i) => trade(LAST_WEEK + i * HOUR, '-0.1'));
    const many = Array.from({ length: 5 }, (_, i) => setup(LAST_WEEK + i * HOUR + MINUTE, '0.01'));
    expect(codes(evaluateEntry(baseInput({ account: account({ closedTrades: four, costs: many }) }), baseRequest()))).not.toContain('loss_review');
    // R15: the last real trade was a $3 loss; the cost is not a trade of any size.
    const caps = (evaluateEntry(baseInput({ account: account({ closedTrades: [trade(NOW - 3 * HOUR, '-0.2', { notional: usd('3') })], costs: cost }) }), baseRequest()) as EntryAllowed).caps;
    expect(caps.find((c) => c.control === 'R15')?.notional).toBe(usd('3'));
  });
  test('a negative or future cost is refused', () => {
    expect(codes(evaluateEntry(baseInput({ account: account({ costs: [setup(LAST_WEEK, '0.5')].map((c) => ({ ...c, amount: neg(c.amount) })) }) }), baseRequest()))).toContain('bankroll_invalid');
    expect(codes(evaluateEntry(baseInput({ account: account({ costs: [setup(NOW + 1, '0.5')] }) }), baseRequest()))).toContain('bankroll_invalid');
    expect(codes(evaluateEntry(baseInput({ account: account({ costs: [setup(LAST_WEEK, '0')] }) }), baseRequest()))).not.toContain('bankroll_invalid');
  });
  test('a cost is a change the balance must have seen before NAV counts', () => {
    const i = baseInput({ account: account({ costs: [setup(NOW - 100, '0.5')] }) });
    expect(evaluateEntry({ ...i, market: { ...i.market, solBalance: { value: lamports(SOL), atMs: NOW - 200 } } }, baseRequest()).snapshot?.nav).toBeNull();
    expect(evaluateEntry({ ...i, market: { ...i.market, solBalance: { value: lamports(SOL), atMs: NOW - 50 } } }, baseRequest()).snapshot?.nav).not.toBeNull();
  });
});
