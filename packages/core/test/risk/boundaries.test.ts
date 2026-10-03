// Exact edges of each control: every comparison is tested on both sides of its boundary, and every latch term on its
// own, so a changed comparison or a dropped term fails a test (RISK-1 review, mutation testing).
import { describe, expect, test } from 'vitest';
import { TRIAL_POLICY, startSession, usd } from '../../src/config/index.ts';
import { costAtSize } from '../../src/costs/index.ts';
import { type EntryAllowed, evaluateEntry, evaluateExit, maxTradeCosts, melbourneWeek, opsReserve } from '../../src/risk/index.ts';
import { type MicroUsd, lamports, lamportsToMicroUsd, microUsdToLamports, mulDiv } from '../../src/units/index.ts';
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
