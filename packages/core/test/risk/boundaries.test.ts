// Exact edges of each control: every comparison is tested on both sides of its boundary, and every latch term on its
// own, so a changed comparison or a dropped term fails a test (RISK-1 review, mutation testing).
import { describe, expect, test } from 'vitest';
import { TRIAL_POLICY, startSession, usd } from '../../src/config/index.ts';
import { costAtSize, feasibleSize, fixedCosts } from '../../src/costs/index.ts';
import { type EntryAllowed, evaluateEntry, evaluateExit, maxTradeCosts, melbourneWeek, opsReserve } from '../../src/risk/index.ts';
import { type Lamports, type MicroUsd, lamports, lamportsToMicroUsd, microUsdToLamports, mulDiv, solPriceMicroUsd } from '../../src/units/index.ts';
import {
  DAY_START, DEEP_POOL, HOUR, MINT_A, MINT_B, NETWORK, NOW, PRICE, RENT, SOL, WEEK_START, account, baseInput, baseRequest,
  clockAt, codes, latches, quoterFor, trade,
} from './helpers.ts';

const at = (ms: number, patch: Parameters<typeof baseInput>[0] = {}) => baseInput({
  clock: clockAt(ms),
  market: { solPrice: { value: PRICE, atMs: ms }, solBalance: { value: lamports(SOL), atMs: ms }, regime: 'on' },
  ...patch,
});
const req = (ms: number, patch: Parameters<typeof baseRequest>[0] = {}) => baseRequest({ quoteAtMs: ms, ...patch });

describe('R10 latch on its own (equity healthy)', () => {
  const tripped = NOW - 5 * HOUR;
  test('a stored trip refuses with no re-arm', () => {
    expect(codes(evaluateEntry(baseInput({ latches: latches({ killTrippedAtMs: tripped }) }), baseRequest()))).toContain('kill_switch');
  });
  test('a re-arm before the trip, or at the same moment, does not clear it', () => {
    for (const rearm of [tripped - 1, tripped]) {
      const input = baseInput({ latches: latches({ killTrippedAtMs: tripped, killRearmedAtMs: rearm }) });
      expect(codes(evaluateEntry(input, baseRequest())), `rearm ${rearm - tripped}`).toContain('kill_switch');
    }
  });
  test('a re-arm after the trip clears it', () => {
    const input = baseInput({ latches: latches({ killTrippedAtMs: tripped, killRearmedAtMs: tripped + 1 }) });
    expect(evaluateEntry(input, baseRequest()).allow).toBe(true);
  });
  test('a latched kill switch is not returned as a new trip; an unlatched one is', () => {
    const input = baseInput({ latches: latches({ killTrippedAtMs: tripped }) });
    expect(evaluateEntry(input, baseRequest()).trips).toEqual([]);
  });
});

describe('R9 latch on its own (no loss this week)', () => {
  const tripped = WEEK_START + 2 * HOUR;
  const weekEnd = melbourneWeek(tripped).end;
  test('no review: refused, this week and later weeks', () => {
    expect(codes(evaluateEntry(baseInput({ latches: latches({ weeklyTrippedAtMs: tripped }) }), baseRequest()))).toContain('weekly_review');
    const later = weekEnd + 30 * HOUR;
    expect(codes(evaluateEntry(at(later, { latches: latches({ weeklyTrippedAtMs: tripped }) }), req(later)))).toContain('weekly_review');
  });
  test('a review before the trip, or at the same moment, does not count', () => {
    const later = weekEnd + HOUR;
    for (const reviewed of [tripped - 1, tripped]) {
      const l = latches({ weeklyTrippedAtMs: tripped, weeklyReviewedAtMs: reviewed });
      expect(codes(evaluateEntry(at(later, { latches: l }), req(later))), `review ${reviewed - tripped}`).toContain('weekly_review');
    }
  });
  test('a review after the trip clears it once the week has ended, not before', () => {
    const l = latches({ weeklyTrippedAtMs: tripped, weeklyReviewedAtMs: tripped + 1 });
    expect(codes(evaluateEntry(at(weekEnd - 1, { latches: l }), req(weekEnd - 1)))).toContain('weekly_review');
    expect(evaluateEntry(at(weekEnd, { latches: l }), req(weekEnd)).allow).toBe(true);
  });
});

describe('R14 cost gate at its exact edges', () => {
  // The extra proportional cost moves the round trip about 1 ppm per ppm, so the tests can land on an exact value.
  const roundTripAt = (extraPpm: bigint) => {
    const spend = microUsdToLamports(TRIAL_POLICY.capital.minNotional, PRICE, 'ceil');
    const c = costAtSize(quoterFor(DEEP_POOL), spend, NETWORK, RENT, extraPpm);
    if (!c.ok) throw new Error('unquotable');
    const num = c.trade.totalLoss * 1_000_000n;
    return { ceil: mulDiv(c.trade.totalLoss, 1_000_000n, c.trade.roundTrip.paid, 'ceil'), exact: num % c.trade.roundTrip.paid === 0n };
  };
  /** Smallest extra cost whose round trip (rounded up) reaches `target` ppm, and whether that value is exact. */
  const findExtra = (target: bigint, wantExact: boolean | null): bigint => {
    let lo = 0n;
    let hi = 200_000n;
    while (hi - lo > 1n) { const mid = (lo + hi) / 2n; if (roundTripAt(mid).ceil < target) lo = mid; else hi = mid; }
    for (let e = hi; e < hi + 400n; e++) {
      const r = roundTripAt(e);
      if (r.ceil === target && (wantExact === null || r.exact === wantExact)) return e;
      if (r.ceil > target) break;
    }
    throw new Error(`no extra cost lands on ${target}`);
  };
  const gate = BigInt(TRIAL_POLICY.costGate.maxRoundTripBps) * 100n;
  const rich = { edgePpm: 400_000n, medianTargetBps: 9000 };

  test('a round trip of exactly 5% passes, one ppm more is refused', () => {
    const exactly = evaluateEntry(baseInput(), baseRequest({ ...rich, extraPpm: findExtra(gate, null) })) as EntryAllowed;
    expect(exactly.allow).toBe(true);
    expect(exactly.roundTripPpm).toBe(gate);
    const over = evaluateEntry(baseInput(), baseRequest({ ...rich, extraPpm: findExtra(gate + 1n, null) }));
    expect(codes(over)).toEqual(['cost_gate']);
  });
  test('the round trip is rounded up: a fraction over 5% is refused', () => {
    const e = findExtra(gate + 1n, false); // the exact value is a little above 50,000 ppm
    expect(codes(evaluateEntry(baseInput(), baseRequest({ ...rich, extraPpm: e })))).toEqual(['cost_gate']);
  });
  test('a third of the median target, exactly, passes; one ppm more is refused', () => {
    // 3,333 bps of a 1,200 bps target = 39,996 ppm.
    const target = 1200;
    const limit = BigInt(TRIAL_POLICY.costGate.maxShareOfMedianTargetBps) * BigInt(target) / 100n;
    const r = { edgePpm: 400_000n, medianTargetBps: target };
    expect((evaluateEntry(baseInput(), baseRequest({ ...r, extraPpm: findExtra(limit, null) })) as EntryAllowed).roundTripPpm).toBe(limit);
    expect(codes(evaluateEntry(baseInput(), baseRequest({ ...r, extraPpm: findExtra(limit + 1n, null) })))).toEqual(['cost_gate']);
  });
  test('the median target must be a positive whole number of bps', () => {
    for (const bad of [0, -5, 1.5, Number.NaN]) {
      expect(codes(evaluateEntry(baseInput(), baseRequest({ medianTargetBps: bad }))), String(bad)).toContain('median_target_invalid');
    }
    expect(evaluateEntry(baseInput(), baseRequest({ ...rich, medianTargetBps: 9000 })).allow).toBe(true);
  });
  test('fixed costs count in the round trip: one-time rent that makes it pass 5% is refused', () => {
    expect(codes(evaluateEntry(baseInput(), baseRequest({ ...rich, rent: { ...RENT, oneTime: 800_000n } })))).toEqual(['cost_gate']);
    expect(usd('0')).toBe(0n);
  });
});

// ---------- Exact cost figures used by the edge tests ----------
const costs = maxTradeCosts(TRIAL_POLICY, { network: NETWORK, rent: RENT });
const C_USD = lamportsToMicroUsd(costs.total, PRICE, 'ceil');
const LADDER_USD = lamportsToMicroUsd(lamports(costs.ladderWorst), PRICE, 'ceil');
const neg = (v: bigint) => -v as MicroUsd;
const LAST_WEEK = WEEK_START - 30 * HOUR;
const THIS_WEEK = WEEK_START + 5 * HOUR;

describe('R6 terms', () => {
  test('an open position counts against both allowances', () => {
    const open = { mint: MINT_B, openedAtMs: NOW - HOUR, notional: usd('5'), mark: usd('5'), markAtMs: NOW - 100 };
    const c = codes(evaluateEntry(baseInput({ account: account({ openPositions: [open] }) }), baseRequest()));
    expect(c).toEqual(expect.arrayContaining(['full_loss_kill_line', 'full_loss_week']));
  });
  test("an open position's exit ladder counts too", () => {
    // $6 above the kill line: $3.40 of position + C leaves $2.11, the ladder takes it under $2.
    const open = { mint: MINT_B, openedAtMs: NOW - HOUR, notional: usd('3.4'), mark: usd('3.4'), markAtMs: NOW - 100 };
    expect(usd('6') - usd('3.4') - C_USD).toBeGreaterThanOrEqual(usd('2'));
    expect(usd('6') - usd('3.4') - LADDER_USD - C_USD).toBeLessThan(usd('2'));
    expect(codes(evaluateEntry(baseInput({ account: account({ openPositions: [open] }) }), baseRequest()))).toContain('full_loss_kill_line');
  });
  test('held reservations count against both allowances', () => {
    const input = baseInput({ account: account({ heldReservations: lamports(45_000_000n) }) });
    expect(codes(evaluateEntry(input, baseRequest()))).toEqual(expect.arrayContaining(['full_loss_kill_line', 'full_loss_week']));
  });
  test('C is part of the full loss above the kill line', () => {
    // E = 16.30: $2.30 above the line; q + C does not fit, q alone would.
    const input = baseInput({ account: account({ closedTrades: [trade(LAST_WEEK, '-3.7', { notional: usd('5') })] }) });
    expect(codes(evaluateEntry(input, baseRequest()))).toEqual(['full_loss_kill_line']);
  });
  test('C is part of the full loss inside the weekly limit', () => {
    const input = baseInput({ account: account({ closedTrades: [trade(THIS_WEEK, '-1.7', { notional: usd('5') })] }) });
    expect(codes(evaluateEntry(input, baseRequest()))).toEqual(['full_loss_week']);
  });
});

describe('R10 kill line and high-water mark', () => {
  test('the kill line rounds up: equity a fraction above 70% of the mark still trips', () => {
    const at70 = baseInput({ account: account({ openingEquity: usd('20.000001'), closedTrades: [trade(LAST_WEEK, '-6', { notional: usd('5') })] }) });
    expect(codes(evaluateEntry(at70, baseRequest()))).toContain('kill_switch'); // 14.000001 <= ceil(14.0000007)
    const above = baseInput({ account: account({ openingEquity: usd('20.000004'), closedTrades: [trade(LAST_WEEK, '-6', { notional: usd('5') })] }) });
    expect(codes(evaluateEntry(above, baseRequest()))).not.toContain('kill_switch'); // 14.000004 > ceil(14.0000028)
  });
  test('after a re-arm the mark restarts and then follows gains', () => {
    const closed = [trade(LAST_WEEK, '-6', { notional: usd('5') }), trade(LAST_WEEK + 2 * HOUR, '1')];
    const l = latches({ killTrippedAtMs: LAST_WEEK + 10, killRearmedAtMs: LAST_WEEK + HOUR });
    expect(evaluateEntry(baseInput({ account: account({ closedTrades: closed }), latches: l }), baseRequest()).snapshot?.highWaterMark).toBe(usd('15'));
  });
  test('a loss at the very moment of the re-arm counts after the restart', () => {
    const rearm = LAST_WEEK + HOUR;
    const closed = [trade(LAST_WEEK, '-6', { notional: usd('5') }), trade(rearm, '-1')];
    const l = latches({ killTrippedAtMs: LAST_WEEK + 10, killRearmedAtMs: rearm });
    expect(evaluateEntry(baseInput({ account: account({ closedTrades: closed }), latches: l }), baseRequest()).snapshot?.highWaterMark).toBe(usd('14'));
  });
});

describe('R2 size range', () => {
  test('a tighter maximum caps a stepped-up size', () => {
    const session = startSession({ ...TRIAL_POLICY, capital: { ...TRIAL_POLICY.capital, maxNotional: usd('2.5') } });
    const d = evaluateEntry(baseInput({ session, latches: latches({ sizeStepUpApproved: true }) }), baseRequest()) as EntryAllowed;
    expect(d.allow).toBe(true);
    expect(d.notional).toBeLessThanOrEqual(usd('2.5'));
    expect(d.notional).toBeGreaterThan(usd('2.4'));
  });
  test('when the minimum does not clear its costs but larger sizes do, only a step-up trades', () => {
    const r = { stopBps: 500, edgePpm: 60_000n, medianTargetBps: 9000, rent: { ...RENT, oneTime: 600_000n } };
    expect(codes(evaluateEntry(baseInput(), baseRequest(r)))).toEqual(['expected_net_not_positive']);
    const up = evaluateEntry(baseInput({ latches: latches({ sizeStepUpApproved: true }) }), baseRequest(r)) as EntryAllowed;
    expect(up.allow).toBe(true);
    expect(up.notional).toBeGreaterThan(TRIAL_POLICY.capital.minNotional);
  });
});

describe('R4 reserve and cash', () => {
  test('a balance exactly at the floor is not below it', () => {
    const mk = (v: bigint) => { const i = baseInput(); return { ...i, market: { ...i.market, solBalance: { value: lamports(v), atMs: NOW } } }; };
    expect(evaluateExit(mk(TRIAL_POLICY.reserve.opsFloor)).tripped.map((x) => x.code)).not.toContain('ops_reserve');
    expect(evaluateExit(mk(TRIAL_POLICY.reserve.opsFloor - 1n)).tripped.map((x) => x.code)).toContain('ops_reserve');
  });
  test('the reserve is computed live and never below the floor', () => {
    const per = costs.perExitAttempt;
    const big = { ...RENT, oneTime: 3_000_000n, transient: 20_000_000n };
    expect(opsReserve(TRIAL_POLICY, { rent: big }, per)).toBe(big.tokenAccount + big.oneTime + big.transient + BigInt(TRIAL_POLICY.reserve.exitAttempts) * per);
    expect(opsReserve(TRIAL_POLICY, { rent: RENT }, per)).toBe(TRIAL_POLICY.reserve.opsFloor);
  });
  test('cash after the reserve must cover q_min, C and transient rent, to the lamport', () => {
    const rent = { ...RENT, transient: 20_000_000n };
    const reserve = opsReserve(TRIAL_POLICY, { rent }, costs.perExitAttempt);
    const c = maxTradeCosts(TRIAL_POLICY, { network: NETWORK, rent }).total;
    const minSpend = microUsdToLamports(usd('2.000001'), PRICE, 'ceil');
    const withBalance = (v: bigint) => { const i = baseInput(); return { ...i, market: { ...i.market, solBalance: { value: lamports(v), atMs: NOW } } }; };
    const enough = reserve + c + rent.transient + minSpend;
    expect(evaluateEntry(withBalance(enough), baseRequest({ rent })).allow).toBe(true);
    expect(codes(evaluateEntry(withBalance(enough - 20n), baseRequest({ rent })))).toEqual(['ops_reserve']);
  });
});

describe('R5 planned risk', () => {
  test('proportional costs at the cost-gate ceiling count in 1R', () => {
    // At s = 20%: (0.55 - F) / (s + 5%) < $2 although (0.55 - F) / s >= $2.
    expect(codes(evaluateEntry(baseInput(), baseRequest({ stopBps: 2000, rent: { ...RENT, oneTime: 800_000n } })))).toEqual(['planned_risk']);
  });
  test('a stop of 100% is too wide, more than 100% is not a stop', () => {
    const wide = codes(evaluateEntry(baseInput(), baseRequest({ stopBps: 10_000 })));
    expect(wide).toContain('stop_too_wide');
    expect(wide).not.toContain('stop_invalid');
    expect(codes(evaluateEntry(baseInput(), baseRequest({ stopBps: 10_001 })))).toEqual(['stop_invalid']);
  });
});

describe('R7 daily loss edges', () => {
  const limit = usd('1.5');
  test('L_day + C exactly at the trigger refuses; one micro-dollar less passes', () => {
    const at = (loss: bigint) => baseInput({ account: account({ closedTrades: [{ ...trade(DAY_START + HOUR, '0'), notional: usd('2'), netPnl: neg(loss) }] }) });
    expect(codes(evaluateEntry(at(limit - C_USD), baseRequest()))).toEqual(['daily_loss']);
    expect(evaluateEntry(at(limit - C_USD - 1n), baseRequest()).allow).toBe(true);
  });
  test('a trade closed exactly at midnight belongs to the new day', () => {
    expect(codes(evaluateEntry(baseInput({ account: account({ closedTrades: [trade(DAY_START, '-1.5')] }) }), baseRequest()))).toContain('daily_loss');
    expect(codes(evaluateEntry(baseInput({ account: account({ closedTrades: [trade(DAY_START - 1, '-1.5')] }) }), baseRequest()))).not.toContain('daily_loss');
  });
  test('deposits and withdrawals today are neither profit nor loss', () => {
    const hidden = account({ closedTrades: [trade(DAY_START + 2 * HOUR, '-1.5')], flows: [{ atMs: DAY_START + 3 * HOUR, amount: usd('10') }] });
    expect(codes(evaluateEntry(baseInput({ account: hidden }), baseRequest()))).toContain('daily_loss');
    const out = account({ flows: [{ atMs: DAY_START + HOUR, amount: neg(usd('5')) }] });
    expect(evaluateEntry(baseInput({ account: out }), baseRequest()).snapshot?.dayLoss).toBe(0n);
  });
  test('a deposit exactly at midnight is a flow of the new day, not equity of the old one', () => {
    const atMidnight = account({ flows: [{ atMs: DAY_START, amount: usd('10') }] });
    expect(evaluateEntry(baseInput({ account: atMidnight }), baseRequest()).snapshot?.dayLoss).toBe(0n);
    const withLoss = account({ flows: [{ atMs: DAY_START, amount: usd('10') }], closedTrades: [trade(DAY_START + HOUR, '-1.5')] });
    expect(codes(evaluateEntry(baseInput({ account: withLoss }), baseRequest()))).toContain('daily_loss');
  });
  test('the snapshot reports what open positions can still lose', () => {
    const open = { mint: MINT_B, openedAtMs: NOW - HOUR, notional: usd('2'), mark: usd('1.5'), markAtMs: NOW - 100 };
    expect(evaluateEntry(baseInput({ account: account({ openPositions: [open] }) }), baseRequest()).snapshot).toMatchObject({
      openExposure: usd('1.5'), equity: usd('19.5'),
    });
  });
});

describe('R8 edges', () => {
  const small = (t: number, patch: Parameters<typeof trade>[2] = {}) => trade(t, '-0.1', patch);
  test('the cooldown lasts exactly cooldownMs from the last loss', () => {
    const last = NOW - TRIAL_POLICY.loss.cooldownMs + 1;
    expect(codes(evaluateEntry(baseInput({ account: account({ closedTrades: [small(last - HOUR), small(last)] }) }), baseRequest()))).toContain('loss_cooldown');
  });
  test('two losses with a win between them are not a streak', () => {
    const closed = [small(NOW - 3 * HOUR), trade(NOW - 2 * HOUR, '0.1'), small(NOW - HOUR)];
    expect(codes(evaluateEntry(baseInput({ account: account({ closedTrades: closed }) }), baseRequest()))).not.toContain('loss_cooldown');
  });
  test('the streak is read in closing order, whatever order the ledger lists trades in', () => {
    const closed = [small(NOW - HOUR), trade(NOW - 4 * HOUR, '0.1'), small(NOW - 3 * HOUR)];
    expect(codes(evaluateEntry(baseInput({ account: account({ closedTrades: closed }) }), baseRequest()))).toContain('loss_cooldown');
    const winLast = [small(NOW - 4 * HOUR), trade(NOW - HOUR, '0.1'), small(NOW - 3 * HOUR)];
    expect(evaluateEntry(baseInput({ account: account({ closedTrades: winLast }) }), baseRequest()).snapshot?.lossStreak).toBe(0);
  });
  test('the day pause starts when the third loss closes at or after midnight', () => {
    const three = (t: number) => [small(t - 5 * HOUR), small(t - 4 * HOUR), small(t)];
    expect(codes(evaluateEntry(baseInput({ account: account({ closedTrades: three(DAY_START) }) }), baseRequest()))).toContain('loss_day_pause');
    expect(codes(evaluateEntry(baseInput({ account: account({ closedTrades: three(DAY_START - 1) }) }), baseRequest()))).not.toContain('loss_day_pause');
  });
  const series = (pattern: string, end: number) => [...pattern].map((ch, i) => trade(end - (pattern.length - i) * HOUR, ch === 'L' ? '-0.1' : '0.1'));
  test('5 losses inside 20 consecutive trades trip the review; spread over 21 they do not', () => {
    const in20 = series('L' + 'W'.repeat(4) + 'L' + 'W'.repeat(4) + 'L' + 'W'.repeat(4) + 'L' + 'WWWL' + 'W', LAST_WEEK); // 21 trades, losses span 20
    expect(codes(evaluateEntry(baseInput({ account: account({ closedTrades: in20 }) }), baseRequest()))).toContain('loss_review');
    const in21 = series('L' + 'W'.repeat(4) + 'L' + 'W'.repeat(4) + 'L' + 'W'.repeat(4) + 'L' + 'WWWWL', LAST_WEEK); // losses span 21
    expect(codes(evaluateEntry(baseInput({ account: account({ closedTrades: in21 }) }), baseRequest()))).not.toContain('loss_review');
    const four = series('LWLWLWLWWWWWWWWWWWWW', LAST_WEEK);
    expect(codes(evaluateEntry(baseInput({ account: account({ closedTrades: four }) }), baseRequest()))).not.toContain('loss_review');
  });
  test('a trade closed at the moment of the review counts before it', () => {
    const closed = series('LWLWLWLWL', LAST_WEEK);
    const reviewedAt = closed.at(-1)!.closedAtMs;
    const l = latches({ lossReviewedAtMs: reviewedAt });
    expect(codes(evaluateEntry(baseInput({ account: account({ closedTrades: closed }), latches: l }), baseRequest()))).not.toContain('loss_review');
    const before = latches({ lossReviewedAtMs: reviewedAt - 1 });
    expect(codes(evaluateEntry(baseInput({ account: account({ closedTrades: closed }), latches: before }), baseRequest()))).not.toContain('loss_review');
    const early = latches({ lossReviewedAtMs: closed[0]!.closedAtMs - 1 });
    expect(codes(evaluateEntry(baseInput({ account: account({ closedTrades: closed }), latches: early }), baseRequest()))).toContain('loss_review');
  });
});

describe('R11 edges', () => {
  test('an entry exactly at midnight counts for the new day, one just before does not', () => {
    const three = (t: number) => [{ mint: MINT_B, atMs: t }, { mint: MINT_B, atMs: NOW - 2 * HOUR }, { mint: MINT_B, atMs: NOW - HOUR }];
    expect(codes(evaluateEntry(baseInput({ account: account({ entries: three(DAY_START) }) }), baseRequest()))).toContain('entries_per_day');
    expect(codes(evaluateEntry(baseInput({ account: account({ entries: three(DAY_START - 1) }) }), baseRequest()))).not.toContain('entries_per_day');
    expect(codes(evaluateEntry(baseInput({ account: account({ entries: [{ mint: MINT_A, atMs: DAY_START }] }) }), baseRequest()))).toContain('entries_per_mint');
    expect(codes(evaluateEntry(baseInput({ account: account({ entries: [{ mint: MINT_A, atMs: DAY_START - 1 }] }) }), baseRequest()))).not.toContain('entries_per_mint');
  });
  test('only a stop in the same mint blocks re-entry, until exactly the end of the window', () => {
    const t = NOW - TRIAL_POLICY.positions.reentryBlockMs + 1;
    expect(codes(evaluateEntry(baseInput({ account: account({ closedTrades: [trade(t, '0.1', { mint: MINT_A, stoppedOut: true })] }) }), baseRequest()))).toContain('reentry_after_stop');
    expect(codes(evaluateEntry(baseInput({ account: account({ closedTrades: [trade(t, '0.1', { mint: MINT_B, stoppedOut: true })] }) }), baseRequest()))).not.toContain('reentry_after_stop');
    expect(codes(evaluateEntry(baseInput({ account: account({ closedTrades: [trade(t, '0.1', { mint: MINT_A, stoppedOut: false })] }) }), baseRequest()))).not.toContain('reentry_after_stop');
  });
});

describe('R12, R15, R16 edges', () => {
  test('a tighter notional multiple caps the size from pool liquidity', () => {
    const session = startSession({ ...TRIAL_POLICY, liquidity: { ...TRIAL_POLICY.liquidity, floorNotionalMultiple: 10_000 } });
    expect(codes(evaluateEntry(baseInput({ session }), baseRequest({ poolLiquidity: usd('15000') })))).toEqual(['liquidity_floor']);
    expect(evaluateEntry(baseInput({ session }), baseRequest({ poolLiquidity: usd('25000') })).allow).toBe(true);
  });
  test('U1 needs exactly the stricter floor', () => {
    expect(evaluateEntry(baseInput(), baseRequest({ universe: 'U1', poolLiquidity: usd('50000') })).allow).toBe(true);
  });
  test('after a win the size is not held to the last size', () => {
    const input = baseInput({ latches: latches({ sizeStepUpApproved: true }), account: account({ closedTrades: [trade(LAST_WEEK, '0.1', { notional: usd('2.2') })] }) });
    const d = evaluateEntry(input, baseRequest()) as EntryAllowed;
    expect(d.notional).toBeGreaterThan(usd('2.2'));
    expect(d.caps.some((c) => c.control === 'R15')).toBe(false);
  });
  test('paper trades with the regime unknown', () => {
    const input = baseInput({ mode: 'paper' });
    expect(evaluateEntry({ ...input, market: { ...input.market, regime: 'unknown' } }, baseRequest()).allow).toBe(true);
  });
});

describe('freshness edges', () => {
  const withPrice = (atMs: number) => { const i = baseInput(); return { ...i, market: { ...i.market, solPrice: { value: PRICE, atMs } } }; };
  test('a price exactly at the age limit is fresh; one from the future is not', () => {
    expect(evaluateEntry(withPrice(NOW - TRIAL_POLICY.gates.maxQuoteAgeMs), baseRequest()).allow).toBe(true);
    expect(codes(evaluateEntry(withPrice(NOW + 1), baseRequest()))).toContain('sol_price_stale');
  });
});

// ---------- Mutation survivors (second run): each test below kills a named mutant ----------

describe('history and marks', () => {
  test('a zero-P&L trade is not a loss', () => {
    const closed = [trade(NOW - 3 * HOUR, '-0.1'), trade(NOW - HOUR, '0')];
    const d = evaluateEntry(baseInput({ account: account({ closedTrades: closed }) }), baseRequest());
    expect(d.snapshot?.lossStreak).toBe(0);
  });
  test('the high-water mark walks events in time order, whatever order the ledger lists them in', () => {
    const closed = [trade(LAST_WEEK, '5'), trade(LAST_WEEK - HOUR, '-3')];
    expect(evaluateEntry(baseInput({ account: account({ closedTrades: closed }) }), baseRequest()).snapshot?.highWaterMark).toBe(usd('22'));
  });
  test('a re-arm at this very moment restarts the mark; one in the future is refused and restarts nothing', () => {
    const closed = [trade(LAST_WEEK, '-6', { notional: usd('5') })];
    const now = baseInput({ account: account({ closedTrades: closed }), latches: latches({ killTrippedAtMs: LAST_WEEK + 1, killRearmedAtMs: NOW }) });
    expect(evaluateEntry(now, baseRequest()).snapshot?.highWaterMark).toBe(usd('14'));
    const future = baseInput({ account: account({ closedTrades: closed }), latches: latches({ killTrippedAtMs: LAST_WEEK + 1, killRearmedAtMs: NOW + 1 }) });
    const d = evaluateEntry(future, baseRequest());
    expect(d.snapshot?.highWaterMark).toBe(usd('20'));
    expect(codes(d)).toContain('bankroll_invalid');
  });
  test('a gain before the re-arm does not survive it', () => {
    const closed = [trade(LAST_WEEK - 2 * HOUR, '5'), trade(LAST_WEEK - HOUR, '-9.5', { notional: usd('5') })];
    const l = latches({ killTrippedAtMs: LAST_WEEK - HOUR + 1, killRearmedAtMs: LAST_WEEK });
    expect(evaluateEntry(baseInput({ account: account({ closedTrades: closed }), latches: l }), baseRequest()).snapshot?.highWaterMark).toBe(usd('15.5'));
  });
  test('any latch time in the future is refused', () => {
    for (const k of ['killTrippedAtMs', 'killRearmedAtMs', 'weeklyTrippedAtMs', 'weeklyReviewedAtMs', 'lossReviewedAtMs'] as const) {
      expect(codes(evaluateEntry(baseInput({ latches: latches({ [k]: NOW + 1 }) }), baseRequest())), k).toContain('bankroll_invalid');
    }
  });
  test('a trade closed exactly now is valid; one a millisecond later is refused and left out of equity', () => {
    expect(codes(evaluateEntry(baseInput({ account: account({ closedTrades: [trade(NOW, '0.1')] }) }), baseRequest()))).not.toContain('bankroll_invalid');
    const d = evaluateEntry(baseInput({ account: account({ closedTrades: [trade(NOW + 1, '-1')] }) }), baseRequest());
    expect(codes(d)).toContain('bankroll_invalid');
    expect(d.snapshot?.equity).toBe(usd('20'));
  });
  test('negative held reservations are refused', () => {
    expect(codes(evaluateEntry(baseInput({ account: account({ heldReservations: -1n as Lamports }) }), baseRequest()))).toContain('bankroll_invalid');
  });
  const pos = (mark: MicroUsd | null, markAtMs: number | null) => ({ mint: MINT_B, openedAtMs: NOW - HOUR, notional: usd('2'), mark, markAtMs });
  test('a mark with no time, or a negative mark, is unknown and counts as a total loss', () => {
    for (const p of [pos(usd('2'), null), pos(-1n as MicroUsd, NOW - 100), pos(null, NOW - 100)]) {
      const d = evaluateEntry(baseInput({ account: account({ openPositions: [p] }) }), baseRequest());
      expect(codes(d)).toContain('mark_unknown');
      expect(d.snapshot).toMatchObject({ equity: usd('18'), openExposure: 0n });
    }
  });
  test('a mark of zero is a known total loss, not an unknown one', () => {
    const d = evaluateEntry(baseInput({ account: account({ openPositions: [pos(0n as MicroUsd, NOW - 100)] }) }), baseRequest());
    expect(codes(d)).not.toContain('mark_unknown');
    expect(d.snapshot).toMatchObject({ equity: usd('18'), openExposure: 0n });
  });
  test('a fresh mark is not stale, and a one-micro-dollar mark is worth one micro-dollar', () => {
    const d = evaluateEntry(baseInput({ account: account({ openPositions: [pos(1n as MicroUsd, NOW - 100)] }) }), baseRequest());
    expect(codes(d)).not.toContain('mark_stale');
    expect(codes(d)).not.toContain('mark_unknown');
    expect(d.snapshot?.openExposure).toBe(1n);
  });
  test('equity of zero is refused, one micro-dollar is not; so is a week-start equity of zero', () => {
    const zero = baseInput({ account: account({ closedTrades: [trade(THIS_WEEK, '-20', { notional: usd('5') })] }) });
    expect(codes(evaluateEntry(zero, baseRequest()))).toContain('bankroll_invalid');
    const tiny = baseInput({ account: account({ closedTrades: [trade(THIS_WEEK, '-19.999999', { notional: usd('5') })] }) });
    expect(codes(evaluateEntry(tiny, baseRequest()))).not.toContain('bankroll_invalid');
    const emptyWeek = baseInput({ account: account({ openingEquity: usd('0'), flows: [{ atMs: THIS_WEEK, amount: usd('20') }] }) });
    expect(codes(evaluateEntry(emptyWeek, baseRequest()))).toContain('bankroll_invalid');
    const tinyWeek = baseInput({ account: account({ openingEquity: 1n as MicroUsd, flows: [{ atMs: THIS_WEEK, amount: usd('20') }] }) });
    expect(codes(evaluateEntry(tinyWeek, baseRequest()))).not.toContain('bankroll_invalid');
  });
  test('a bad clock throws from an entry and never from an exit', () => {
    expect(() => evaluateEntry(baseInput({ clock: clockAt(Number.NaN) }), baseRequest())).toThrow(RangeError);
    expect(() => evaluateEntry(baseInput({ clock: clockAt(NOW + 0.5) }), baseRequest())).toThrow(RangeError);
    expect(evaluateExit(baseInput({ clock: clockAt(NOW + 0.5) })).allow).toBe(true);
  });
});

describe('price and costs', () => {
  const withPrice = (value: bigint) => { const i = baseInput(); return { ...i, market: { ...i.market, solPrice: { value: value as MicroUsd, atMs: NOW } } }; };
  test('a zero SOL price is refused without dividing by it', () => {
    expect(codes(evaluateEntry(withPrice(0n), baseRequest()))).toEqual(['sol_price_stale']);
  });
  test('a one-micro-dollar SOL price is a price (the trade then fails on cash, not on the price)', () => {
    const c = codes(evaluateEntry(withPrice(1n), baseRequest()));
    expect(c).not.toContain('sol_price_stale');
    expect(c).toContain('ops_reserve');
  });
  test('costs that cannot be computed refuse as quote_failed', () => {
    expect(codes(evaluateEntry(baseInput(), baseRequest({ network: { ...NETWORK, signaturesPerTx: 0n } })))).toContain('quote_failed');
  });
  test('C uses the modelled exit (with expected failures) when it is dearer than the ladder', () => {
    const net = { ...NETWORK, exitPriorityFee: 2_000_000n, exitFailurePpm: 500_000n };
    const fixed = fixedCosts(net, RENT);
    const ladder = maxTradeCosts(TRIAL_POLICY, { network: net, rent: RENT }).ladderWorst;
    expect(fixed.exit.landed + fixed.exit.expectedFailures).toBeGreaterThan(ladder);
    expect(fixed.exit.landed).toBeLessThan(ladder);
    expect(maxTradeCosts(TRIAL_POLICY, { network: net, rent: RENT }).total).toBe(fixed.total + fixed.recoverableRent);
  });
  test('the reported round trip has no hidden extra cost', () => {
    const d = evaluateEntry(baseInput(), baseRequest()) as EntryAllowed;
    const c = costAtSize(quoterFor(DEEP_POOL), d.spendLamports, NETWORK, RENT, 0n);
    if (!c.ok) throw new Error('unquotable');
    expect(d.roundTripPpm).toBe(mulDiv(c.trade.totalLoss, 1_000_000n, c.trade.roundTrip.paid, 'ceil'));
  });
  test('a quote that fails at the chosen size refuses as quote_failed', () => {
    const real = quoterFor(DEEP_POOL);
    let calls = 0;
    const counting = (spend: bigint) => { calls++; return real(spend); };
    evaluateEntry(baseInput(), baseRequest({ quote: counting }));
    const last = calls;
    let n = 0;
    const failsLast = (spend: bigint) => (++n === last ? { ok: false as const, reason: 'no-liquidity' as const, detail: 'gone' } : real(spend));
    const d = evaluateEntry(baseInput(), baseRequest({ quote: failsLast }));
    expect(codes(d)).toEqual(['quote_failed']);
    expect(d.allow ? '' : d.reasons[0]?.detail).toContain('no-liquidity');
  });
});

describe('each reason is listed once', () => {
  test('daily loss at the trigger', () => {
    const c = codes(evaluateEntry(baseInput({ account: account({ closedTrades: [trade(DAY_START + HOUR, '-1.5', { notional: usd('5') })] }) }), baseRequest()));
    expect(c.filter((x) => x === 'daily_loss')).toHaveLength(1);
  });
  test('a balance under the floor', () => {
    const i = baseInput();
    const low = { ...i, market: { ...i.market, solBalance: { value: lamports(TRIAL_POLICY.reserve.opsFloor - 1n), atMs: NOW } } };
    expect(codes(evaluateEntry(low, baseRequest())).filter((x) => x === 'ops_reserve')).toHaveLength(1);
  });
  test('six losses found by several windows', () => {
    const pattern = 'LWLWLWLWLWL' + 'W'.repeat(14); // 25 trades: windows 0, 1 and 2 each hold 5 or more losses
    const closed = [...pattern].map((ch, i) => trade(LAST_WEEK - (pattern.length - i) * HOUR, ch === 'L' ? '-0.1' : '0.1'));
    expect(codes(evaluateEntry(baseInput({ account: account({ closedTrades: closed }) }), baseRequest())).filter((x) => x === 'loss_review')).toHaveLength(1);
  });
});

describe('R8 review window', () => {
  const series = (pattern: string, end: number) => [...pattern].map((ch, i) => trade(end - (pattern.length - i) * HOUR, ch === 'L' ? '-0.1' : '0.1'));
  test('a review at the moment of the first loss leaves that loss before it', () => {
    const closed = series('LWLWLWLWL', LAST_WEEK);
    const l = latches({ lossReviewedAtMs: closed[0]!.closedAtMs });
    expect(codes(evaluateEntry(baseInput({ account: account({ closedTrades: closed }), latches: l }), baseRequest()))).not.toContain('loss_review');
  });
  test('the last window is checked: 5 losses in the last 5 of 22 trades', () => {
    const closed = series('W'.repeat(17) + 'LLLLL', LAST_WEEK);
    expect(codes(evaluateEntry(baseInput({ account: account({ closedTrades: closed }) }), baseRequest()))).toContain('loss_review');
  });
});

describe('rounding edges', () => {
  test('the daily trigger rounds down: with B = $19.999999 a loss of $1.499999 trips it', () => {
    const session = startSession({ ...TRIAL_POLICY, capital: { ...TRIAL_POLICY.capital, bankroll: usd('19.999999') } });
    const input = baseInput({ session, account: account({ closedTrades: [trade(DAY_START + HOUR, '-1.499999')] }) });
    expect(evaluateExit(input).tripped.map((r) => r.code)).toContain('daily_loss');
  });
  test('the weekly trigger rounds down: with $20.000001 at week start a $4 loss trips it', () => {
    const input = baseInput({ account: account({ openingEquity: usd('20.000001'), closedTrades: [trade(THIS_WEEK, '-4', { notional: usd('5') })] }) });
    expect(evaluateExit(input).tripped.map((r) => r.code)).toContain('weekly_loss');
  });
  test('R4 cash: one lamport short of the minimum spend refuses', () => {
    const rent = { ...RENT, transient: 20_000_000n };
    const reserve = opsReserve(TRIAL_POLICY, { rent }, costs.perExitAttempt);
    const c = maxTradeCosts(TRIAL_POLICY, { network: NETWORK, rent }).total;
    const minSpendUsd = lamportsToMicroUsd(microUsdToLamports(TRIAL_POLICY.capital.minNotional, PRICE, 'ceil'), PRICE, 'ceil');
    const need = reserve + c + rent.transient + microUsdToLamports(minSpendUsd, PRICE, 'ceil');
    const withBalance = (v: bigint) => { const i = baseInput(); return { ...i, market: { ...i.market, solBalance: { value: lamports(v), atMs: NOW } } }; };
    expect(evaluateEntry(withBalance(need), baseRequest({ rent })).allow).toBe(true);
    expect(codes(evaluateEntry(withBalance(need - 1n), baseRequest({ rent })))).toEqual(['ops_reserve']);
  });
  test('held reservations are valued rounded up: the first refused amount matches the exact rule', () => {
    // Weekly allowance binds: 4,000,000 - ceil(usd(held)) - C >= minimum spend (micro-dollars) to trade.
    const minSpendUsd = lamportsToMicroUsd(microUsdToLamports(TRIAL_POLICY.capital.minNotional, PRICE, 'ceil'), PRICE, 'ceil');
    const fits = (held: bigint) => usd('4') - lamportsToMicroUsd(lamports(held), PRICE, 'ceil') - C_USD >= minSpendUsd;
    const allowed = (held: bigint) => evaluateEntry(baseInput({ account: account({ heldReservations: lamports(held) }) }), baseRequest()).allow;
    let lo = 0n;
    let hi = SOL;
    while (hi - lo > 1n) { const mid = (lo + hi) / 2n; if (allowed(mid)) lo = mid; else hi = mid; }
    expect(fits(lo)).toBe(true);
    expect(fits(hi)).toBe(false);
  });
  test("an open position's exit ladder is valued rounded up", () => {
    // At $119.461 the ladder is not a whole number of micro-dollars, so the rounding shows.
    const price = solPriceMicroUsd('119.461');
    const ladder = lamportsToMicroUsd(lamports(costs.ladderWorst), price, 'ceil');
    expect(ladder).not.toBe(lamportsToMicroUsd(lamports(costs.ladderWorst), price, 'floor'));
    const c = lamportsToMicroUsd(costs.total, price, 'ceil');
    // full_loss_kill_line appears once 6,000,000 - x - ceil(ladder) - C < q_min.
    const appears = (x: bigint) => {
      const i = baseInput({ account: account({ openPositions: [
        { mint: MINT_B, openedAtMs: NOW - HOUR, notional: x as MicroUsd, mark: x as MicroUsd, markAtMs: NOW - 100 },
      ] }) });
      const input = { ...i, market: { ...i.market, solPrice: { value: price, atMs: NOW } } };
      return codes(evaluateEntry(input, baseRequest())).includes('full_loss_kill_line');
    };
    const first = usd('6') - ladder - c - TRIAL_POLICY.capital.minNotional + 1n;
    expect(appears(first)).toBe(true);
    expect(appears(first - 1n)).toBe(false);
    expect(appears(usd('0.01'))).toBe(false);
  });
  /**
   * First one-time rent (lamports) at which R5's cap, with the given roundings, falls below what a trade needs: q_min as
   * a whole number of lamports, valued rounded up.
   */
  const r5Edge = (bankroll: MicroUsd, qMinNotional: MicroUsd, stopBps: number, planned: 'floor' | 'ceil', division: 'floor' | 'ceil') => {
    const qMin = lamportsToMicroUsd(microUsdToLamports(qMinNotional, PRICE, 'ceil'), PRICE, 'ceil');
    const d = BigInt(stopBps + TRIAL_POLICY.costGate.maxRoundTripBps);
    const budget = mulDiv(bankroll, BigInt(TRIAL_POLICY.loss.plannedRiskBps), 10_000n, planned);
    const capAt = (oneTime: bigint) => {
      const fUsd = lamportsToMicroUsd(lamports(fixedCosts(NETWORK, { ...RENT, oneTime }).total), PRICE, 'ceil');
      return mulDiv(budget - fUsd, 10_000n, d, division);
    };
    let lo = 0n;
    let hi = 3_000_000n;
    while (hi - lo > 1n) { const mid = (lo + hi) / 2n; if (capAt(mid) >= qMin) lo = mid; else hi = mid; }
    return hi;
  };
  test('R5 divides rounding down: at the exact edge planned_risk refuses', () => {
    // Find a (q_min, stop) where rounding the division up would move the edge (it never can at q_min = $2).
    let found: { qMin: MicroUsd; stop: number; edge: bigint } | null = null;
    for (let q = 0; q < 60 && !found; q++) {
      const qMin = (usd('1.99999') + BigInt(q)) as MicroUsd;
      for (let stop = 1000; stop <= 2000 && !found; stop++) {
        const floorEdge = r5Edge(TRIAL_POLICY.capital.bankroll, qMin, stop, 'floor', 'floor');
        if (r5Edge(TRIAL_POLICY.capital.bankroll, qMin, stop, 'floor', 'ceil') > floorEdge) found = { qMin, stop, edge: floorEdge };
      }
    }
    expect(found).not.toBeNull();
    const { qMin, stop, edge } = found!;
    const session = startSession({ ...TRIAL_POLICY, capital: { ...TRIAL_POLICY.capital, minNotional: qMin } });
    expect(codes(evaluateEntry(baseInput({ session }), baseRequest({ stopBps: stop, rent: { ...RENT, oneTime: edge } })))).toContain('planned_risk');
    expect(codes(evaluateEntry(baseInput({ session }), baseRequest({ stopBps: stop, rent: { ...RENT, oneTime: edge - 1n } })))).not.toContain('planned_risk');
  });
  test('R5 takes 2.75% of the bankroll rounding down: at the exact edge planned_risk refuses', () => {
    const bankroll = usd('19.999999');
    const session = startSession({ ...TRIAL_POLICY, capital: { ...TRIAL_POLICY.capital, bankroll } });
    const floorEdge = r5Edge(bankroll, TRIAL_POLICY.capital.minNotional, 1500, 'floor', 'floor');
    const ceilEdge = r5Edge(bankroll, TRIAL_POLICY.capital.minNotional, 1500, 'ceil', 'floor');
    expect(ceilEdge).toBeGreaterThan(floorEdge);
    expect(codes(evaluateEntry(baseInput({ session }), baseRequest({ stopBps: 1500, rent: { ...RENT, oneTime: floorEdge } })))).toContain('planned_risk');
    expect(codes(evaluateEntry(baseInput({ session }), baseRequest({ stopBps: 1500, rent: { ...RENT, oneTime: floorEdge - 1n } })))).not.toContain('planned_risk');
  });
  test('sizing adds no hidden cost: the break-even edge matches CORE-2 exactly', () => {
    const minSpend = microUsdToLamports(TRIAL_POLICY.capital.minNotional, PRICE, 'ceil');
    const big = usd('100');
    // The same top of the range as the evaluator: its tightest cap other than the minimum-size stage.
    const ref = evaluateEntry(baseInput(), baseRequest()) as EntryAllowed;
    const qCap = ref.caps.filter((c) => !c.name.startsWith('minimum')).reduce((m, c) => (c.notional < m ? c.notional : m), big);
    const coreTrades = (edgePpm: bigint) => {
      const r = feasibleSize({
        quote: quoterFor(DEEP_POOL), solPrice: PRICE, edgePpm, network: NETWORK, rent: RENT, extraPpm: 0n,
        policy: { minNotional: TRIAL_POLICY.capital.minNotional, maxNotional: qCap, maxImpactPpm: 10_000n },
        caps: { lossAllowance: big, riskBudget: big, executableDepth: big, cash: big },
      });
      return r.trade && r.range.minLamports <= minSpend;
    };
    let lo = 0n;
    let hi = 200_000n;
    while (hi - lo > 1n) { const mid = (lo + hi) / 2n; if (coreTrades(mid)) hi = mid; else lo = mid; }
    expect(evaluateEntry(baseInput(), baseRequest({ edgePpm: hi })).allow).toBe(true);
    expect(codes(evaluateEntry(baseInput(), baseRequest({ edgePpm: lo })))).toEqual(['expected_net_not_positive']);
  });
  test('a policy with q_max = q_min still trades the minimum (its lamport rounding is not a raise)', () => {
    const session = startSession({ ...TRIAL_POLICY, capital: { ...TRIAL_POLICY.capital, maxNotional: TRIAL_POLICY.capital.minNotional } });
    for (const stepUp of [false, true]) {
      const d = evaluateEntry(baseInput({ session, latches: latches({ sizeStepUpApproved: stepUp }) }), baseRequest()) as EntryAllowed;
      expect(d.allow).toBe(true);
      expect(d.spendLamports).toBe(microUsdToLamports(TRIAL_POLICY.capital.minNotional, PRICE, 'ceil'));
    }
  });
  test('the caps list names the maximum notional', () => {
    const d = evaluateEntry(baseInput(), baseRequest()) as EntryAllowed;
    expect(d.caps.find((c) => c.name === 'maximum notional')?.notional).toBe(TRIAL_POLICY.capital.maxNotional);
  });
});

describe('risk re-review of 0f7d142', () => {
  test("today's profit does not offset the costs of the next trade: L_day is floored at zero", () => {
    // B = $6: the daily trigger is $0.45, below C (about $0.49). A +$0.20 day must not make room for C.
    const session = startSession({ ...TRIAL_POLICY, capital: { ...TRIAL_POLICY.capital, bankroll: usd('6'), minNotional: usd('0.5'), maxNotional: usd('1') } });
    const input = baseInput({ session, account: account({ openingEquity: usd('6'), closedTrades: [trade(NOW - HOUR, '0.2')] }) });
    const d = evaluateEntry(input, baseRequest());
    expect(d.snapshot?.dayLoss).toBe(0n);
    expect(codes(d)).toContain('daily_loss');
  });
  test('the notional multiple cap is liquidity / multiple, to the micro-dollar', () => {
    const session = startSession({ ...TRIAL_POLICY, liquidity: { ...TRIAL_POLICY.liquidity, floorNotionalMultiple: 10_000 } });
    const minSpendUsd = lamportsToMicroUsd(microUsdToLamports(TRIAL_POLICY.capital.minNotional, PRICE, 'ceil'), PRICE, 'ceil');
    const liquidity = (minSpendUsd * 10_000n) as MicroUsd;
    expect(evaluateEntry(baseInput({ session }), baseRequest({ poolLiquidity: liquidity })).allow).toBe(true);
    expect(codes(evaluateEntry(baseInput({ session }), baseRequest({ poolLiquidity: (liquidity - 1n) as MicroUsd })))).toEqual(['liquidity_floor']);
  });
});
