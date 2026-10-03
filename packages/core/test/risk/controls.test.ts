// One test per control R1 to R16 (docs/ARCHITECTURE.md §8). Each refuses an entry for that control's reason and shows
// that an exit on the same inputs still passes: no risk control ever blocks an exit.
import { describe, expect, test } from 'vitest';
import { TRIAL_POLICY, startSession, usd } from '../../src/config/index.ts';
import { type EntryAllowed, evaluateEntry, evaluateExit, maxTradeCosts } from '../../src/risk/index.ts';
import { type MicroUsd, lamports, lamportsToMicroUsd } from '../../src/units/index.ts';
import {
  DAY_START, HOUR, MINT_A, MINT_B, MINUTE, NETWORK, NOW, PRICE, RENT, SHALLOW_POOL, SOL, WEEK_START,
  account, baseInput, baseRequest, clockAt, codes, expectRefusedButExitPasses, latches, quoterFor, trade,
} from './helpers.ts';

const allowed = (d: ReturnType<typeof evaluateEntry>): EntryAllowed => {
  if (!d.allow) throw new Error(`expected allow, got ${JSON.stringify(d.reasons)}`);
  return d;
};
const LAST_WEEK = WEEK_START - 30 * HOUR;
const EARLIER_THIS_WEEK = WEEK_START + 5 * HOUR;

describe('baseline', () => {
  test('a healthy account and a sound entry is allowed at the minimum size, with a reservation of q + C', () => {
    const d = allowed(evaluateEntry(baseInput(), baseRequest()));
    expect(d.notional).toBe(TRIAL_POLICY.capital.minNotional);
    expect(d.reservation.amount).toBe(d.spendLamports + d.maxCostsLamports);
    expect(d.reservation.limits.maxCount).toBe(TRIAL_POLICY.positions.maxOpen);
    expect(d.trips).toEqual([]);
    expect(evaluateExit(baseInput())).toEqual({ allow: true, tripped: [], trips: [] });
  });

  test('C counts fees, rent, priority fees and the exit ladder at its worst', () => {
    const c = maxTradeCosts(TRIAL_POLICY, { network: NETWORK, rent: RENT });
    const ladder = TRIAL_POLICY.exits.ladder;
    expect(c.perExitAttempt).toBe(NETWORK.baseFeePerSignature + ladder.maxFeePerAttempt + NETWORK.tip);
    expect(c.ladderWorst).toBe(BigInt(ladder.maxAttempts) * c.perExitAttempt);
    // entry landed + token account rent (locked if the exit is blocked) + every ladder attempt
    expect(c.total).toBe(NETWORK.baseFeePerSignature + NETWORK.entryPriorityFee + NETWORK.tip + RENT.tokenAccount + c.ladderWorst);
  });
});

describe('R1 bankroll and valuation', () => {
  test('no SOL price refuses', () => {
    const input = baseInput();
    expectRefusedButExitPasses({ ...input, market: { ...input.market, solPrice: null } }, baseRequest(), 'sol_price_unknown', true);
  });
  test('a stale SOL price refuses', () => {
    const input = baseInput();
    const stale = { value: PRICE, atMs: NOW - TRIAL_POLICY.gates.maxQuoteAgeMs - 1 };
    expectRefusedButExitPasses({ ...input, market: { ...input.market, solPrice: stale } }, baseRequest(), 'sol_price_stale', true);
  });
  test('an open position with no executable value refuses, and so does a stale one', () => {
    const open = { mint: MINT_B, openedAtMs: NOW - HOUR, notional: usd('2'), mark: null, markAtMs: null };
    expectRefusedButExitPasses(baseInput({ account: account({ openPositions: [open] }) }), baseRequest(), 'mark_unknown', true);
    const stale = { ...open, mark: usd('2'), markAtMs: NOW - 10 * MINUTE };
    expectRefusedButExitPasses(baseInput({ account: account({ openPositions: [stale] }) }), baseRequest(), 'mark_stale', true);
  });
  test('history from the future is refused', () => {
    const input = baseInput({ account: account({ closedTrades: [trade(NOW + 1, '1')] }) });
    expectRefusedButExitPasses(input, baseRequest(), 'bankroll_invalid', true);
  });
});

describe('R2 trade size range', () => {
  test('sizes stay at the minimum until the owner approves a step-up, then rise within the maximum', () => {
    expect(allowed(evaluateEntry(baseInput(), baseRequest())).notional).toBe(TRIAL_POLICY.capital.minNotional);
    const up = allowed(evaluateEntry(baseInput({ latches: latches({ sizeStepUpApproved: true }) }), baseRequest()));
    expect(up.notional).toBeGreaterThan(TRIAL_POLICY.capital.minNotional);
    expect(up.notional).toBeLessThanOrEqual(TRIAL_POLICY.capital.maxNotional);
  });
  test('a 10% drawdown from the high-water mark returns to the minimum', () => {
    const input = baseInput({
      latches: latches({ sizeStepUpApproved: true }),
      account: account({ closedTrades: [trade(LAST_WEEK - HOUR, '5'), trade(LAST_WEEK, '-2.5', { notional: usd('5') })] }),
    });
    const d = allowed(evaluateEntry(input, baseRequest()));
    expect(d.notional).toBe(TRIAL_POLICY.capital.minNotional);
    expect(d.caps.some((c) => c.name.includes('drawdown'))).toBe(true);
  });
  test('a pool too small for the minimum is refused (the size range is never broken)', () => {
    // 1,000 x q rule: a $14,999 pool cannot take $2 under a $15k floor; also nothing below q_min is ever sized.
    const d = expectRefusedButExitPasses(baseInput(), baseRequest({ poolLiquidity: usd('1999') }), 'liquidity_floor', false);
    expect(d.allow).toBe(false);
  });
});

describe('R3 open positions', () => {
  test('an unresolved entry counts as the one open position', () => {
    expectRefusedButExitPasses(baseInput({ account: account({ unresolvedEntries: [{ mint: MINT_B }] }) }), baseRequest(), 'max_open_positions', true);
  });
  test('an open position counts', () => {
    const open = { mint: MINT_B, openedAtMs: NOW - HOUR, notional: usd('2'), mark: usd('2'), markAtMs: NOW - 100 };
    expectRefusedButExitPasses(baseInput({ account: account({ openPositions: [open] }) }), baseRequest(), 'max_open_positions', true);
  });
});

describe('R4 SOL operations reserve', () => {
  test('unknown or stale balance refuses', () => {
    const input = baseInput();
    expectRefusedButExitPasses({ ...input, market: { ...input.market, solBalance: null } }, baseRequest(), 'balance_unknown', true);
    const stale = { value: lamports(SOL), atMs: NOW - TRIAL_POLICY.gates.maxQuoteAgeMs - 1 };
    expectRefusedButExitPasses({ ...input, market: { ...input.market, solBalance: stale } }, baseRequest(), 'balance_stale', true);
  });
  test('a balance under the floor refuses', () => {
    const input = baseInput();
    const low = { value: lamports(TRIAL_POLICY.reserve.opsFloor - 1n), atMs: NOW };
    expectRefusedButExitPasses({ ...input, market: { ...input.market, solBalance: low } }, baseRequest(), 'ops_reserve', true);
  });
  test('a balance above the floor but short of q + C + reserve refuses', () => {
    const input = baseInput();
    const thin = { value: lamports(TRIAL_POLICY.reserve.opsFloor + SOL / 100n), atMs: NOW };
    const d = expectRefusedButExitPasses({ ...input, market: { ...input.market, solBalance: thin } }, baseRequest(), 'ops_reserve', false);
    expect(evaluateExit({ ...input, market: { ...input.market, solBalance: thin } }).tripped).toEqual([]);
    expect(d.allow).toBe(false);
  });
});

describe('R5 planned risk per trade', () => {
  test('a stop wider than s_max refuses', () => {
    expectRefusedButExitPasses(baseInput(), baseRequest({ stopBps: TRIAL_POLICY.loss.stopMaxBps + 1 }), 'stop_too_wide', false);
  });
  test('a missing or nonsense stop refuses', () => {
    expectRefusedButExitPasses(baseInput(), baseRequest({ stopBps: 0 }), 'stop_invalid', false);
    expectRefusedButExitPasses(baseInput(), baseRequest({ stopBps: Number.NaN }), 'stop_invalid', false);
  });
  test('fixed costs that leave too little of 1R refuse', () => {
    // 0.004 SOL of one-time rent is about $0.48 of the $0.55 budget.
    expectRefusedButExitPasses(baseInput(), baseRequest({ rent: { ...RENT, oneTime: 4_000_000n } }), 'planned_risk', false);
  });
  test('the widest allowed stop at q_min fits', () => {
    allowed(evaluateEntry(baseInput(), baseRequest({ stopBps: TRIAL_POLICY.loss.stopMaxBps })));
  });
});

describe('R6 full-loss reservation', () => {
  test('(a) a full loss that would cross the kill line refuses', () => {
    // E = 14.50, HWM = 20: 0.50 above the kill line, less than q + C.
    const input = baseInput({ account: account({ closedTrades: [trade(LAST_WEEK, '-5.5', { notional: usd('5') })] }) });
    expectRefusedButExitPasses(input, baseRequest(), 'full_loss_kill_line', false);
  });
  test('(b) a full loss that would cross the weekly limit refuses', () => {
    const input = baseInput({ account: account({ closedTrades: [trade(EARLIER_THIS_WEEK, '-3', { notional: usd('5') })] }) });
    expectRefusedButExitPasses(input, baseRequest(), 'full_loss_week', false);
  });
  test('held reservations count against the allowance', () => {
    // 3.9 SOL held is far more than the $4 weekly allowance.
    const input = baseInput({ account: account({ heldReservations: lamports(SOL / 25n) }) });
    const d = evaluateEntry(input, baseRequest());
    expect(codes(d)).toContain('full_loss_week');
  });
});

describe('R7 daily loss', () => {
  test("today's realized loss at the trigger pauses entries", () => {
    const input = baseInput({ account: account({ closedTrades: [trade(DAY_START + HOUR, '-1.5', { notional: usd('5') })] }) });
    expectRefusedButExitPasses(input, baseRequest(), 'daily_loss', true);
  });
  test('a loss below the trigger refuses when the costs of the new trade would reach it', () => {
    const input = baseInput({ account: account({ closedTrades: [trade(DAY_START + HOUR, '-1.2', { notional: usd('5') })] }) });
    const d = expectRefusedButExitPasses(input, baseRequest(), 'daily_loss', false);
    expect(d.allow).toBe(false);
  });
  test('the trading day is Melbourne time: a loss at 23:59 yesterday does not count, 00:01 today does', () => {
    const yesterday = baseInput({ account: account({ closedTrades: [trade(DAY_START - MINUTE, '-1.2', { notional: usd('5') })] }) });
    expect(codes(evaluateEntry(yesterday, baseRequest()))).not.toContain('daily_loss');
    const today = baseInput({ account: account({ closedTrades: [trade(DAY_START + MINUTE, '-1.2', { notional: usd('5') })] }) });
    expect(codes(evaluateEntry(today, baseRequest()))).toContain('daily_loss');
  });
  test('across the 2026-10-04 change: the 23-hour day ends at 00:00 AEDT, 2026-10-04T13:00Z', () => {
    const at = (ms: number) => baseInput({
      clock: clockAt(ms), market: { solPrice: { value: PRICE, atMs: ms }, solBalance: { value: lamports(SOL), atMs: ms }, regime: 'on' },
      account: account({ closedTrades: [trade(Date.UTC(2026, 9, 3, 14, 30), '-1.5', { notional: usd('5') })] }),
    });
    const req = (ms: number) => baseRequest({ quoteAtMs: ms });
    const lastMinute = Date.UTC(2026, 9, 4, 12, 59);
    expect(codes(evaluateEntry(at(lastMinute), req(lastMinute)))).toContain('daily_loss');
    const nextDay = Date.UTC(2026, 9, 4, 13, 0);
    expect(codes(evaluateEntry(at(nextDay), req(nextDay)))).not.toContain('daily_loss');
  });
  test('a marked loss on an open position counts; an unrealized gain does not offset a realized loss', () => {
    const open = { mint: MINT_B, openedAtMs: NOW - HOUR, notional: usd('5'), mark: usd('3.4'), markAtMs: NOW - 100 };
    const input = baseInput({ account: account({ openPositions: [open] }) });
    expect(evaluateExit(input).tripped.map((r) => r.code)).toContain('daily_loss');
    const gain = { ...open, notional: usd('2'), mark: usd('4') };
    const mixed = baseInput({ account: account({ openPositions: [gain], closedTrades: [trade(DAY_START + HOUR, '-1.5', { notional: usd('5') })] }) });
    expect(evaluateExit(mixed).tripped.map((r) => r.code)).toContain('daily_loss');
  });
});

describe('R8 consecutive losses', () => {
  const small = (t: number) => trade(t, '-0.1');
  test('2 losses in a row: 2 h cooldown from the last', () => {
    const input = baseInput({ account: account({ closedTrades: [small(NOW - 3 * HOUR), small(NOW - HOUR)] }) });
    expectRefusedButExitPasses(input, baseRequest(), 'loss_cooldown', true);
    const later = baseInput({ account: account({ closedTrades: [small(NOW - 5 * HOUR), small(NOW - TRIAL_POLICY.loss.cooldownMs)] }) });
    expect(codes(evaluateEntry(later, baseRequest()))).not.toContain('loss_cooldown');
  });
  test('3 losses in a row: paused for the rest of the Melbourne day', () => {
    const input = baseInput({ account: account({ closedTrades: [small(DAY_START + MINUTE), small(DAY_START + 2 * MINUTE), small(NOW - 3 * HOUR)] }) });
    expectRefusedButExitPasses(input, baseRequest(), 'loss_day_pause', true);
    const tomorrow = DAY_START + 24 * HOUR + MINUTE;
    const next = baseInput({
      ...input, clock: clockAt(tomorrow),
      market: { solPrice: { value: PRICE, atMs: tomorrow }, solBalance: { value: lamports(SOL), atMs: tomorrow }, regime: 'on' },
    });
    expect(codes(evaluateEntry(next, baseRequest({ quoteAtMs: tomorrow })))).not.toContain('loss_day_pause');
  });
  test('5 losses in any 20 trades: paused until the owner reviews', () => {
    const closed = Array.from({ length: 9 }, (_, i) => trade(LAST_WEEK - (9 - i) * HOUR, i % 2 === 0 ? '-0.1' : '0.1'));
    const input = baseInput({ account: account({ closedTrades: closed }) });
    expectRefusedButExitPasses(input, baseRequest(), 'loss_review', true);
    const reviewed = baseInput({ account: account({ closedTrades: closed }), latches: latches({ lossReviewedAtMs: LAST_WEEK }) });
    expect(codes(evaluateEntry(reviewed, baseRequest()))).not.toContain('loss_review');
  });
});

describe('R9 weekly loss', () => {
  test('20% of week-start equity trips the weekly trigger and returns a trip to store', () => {
    const input = baseInput({ account: account({ closedTrades: [trade(EARLIER_THIS_WEEK, '-4', { notional: usd('5') })] }) });
    const d = expectRefusedButExitPasses(input, baseRequest(), 'weekly_loss', true);
    expect(d.trips).toContain('weekly_loss');
  });
  test('the week starts Monday 00:00 Melbourne time', () => {
    const before = baseInput({ account: account({ closedTrades: [trade(WEEK_START - MINUTE, '-4', { notional: usd('5') })] }) });
    expect(codes(evaluateEntry(before, baseRequest()))).not.toContain('weekly_loss');
  });
  test('a tripped week stays paused until the week is over and the owner has reviewed it', () => {
    const tripped = EARLIER_THIS_WEEK;
    const same = baseInput({ latches: latches({ weeklyTrippedAtMs: tripped, weeklyReviewedAtMs: tripped + HOUR }) });
    expectRefusedButExitPasses(same, baseRequest(), 'weekly_review', true);
    const nextWeek = WEEK_START + 7 * 24 * HOUR + HOUR;
    const mk = (l: ReturnType<typeof latches>) => baseInput({
      latches: l, clock: clockAt(nextWeek),
      market: { solPrice: { value: PRICE, atMs: nextWeek }, solBalance: { value: lamports(SOL), atMs: nextWeek }, regime: 'on' },
    });
    expect(codes(evaluateEntry(mk(latches({ weeklyTrippedAtMs: tripped })), baseRequest({ quoteAtMs: nextWeek })))).toContain('weekly_review');
    allowed(evaluateEntry(mk(latches({ weeklyTrippedAtMs: tripped, weeklyReviewedAtMs: tripped + HOUR })), baseRequest({ quoteAtMs: nextWeek })));
  });
  test('a deposit does not hide a weekly loss', () => {
    const input = baseInput({
      account: account({ closedTrades: [trade(EARLIER_THIS_WEEK, '-4', { notional: usd('5') })], flows: [{ atMs: EARLIER_THIS_WEEK + HOUR, amount: usd('10') }] }),
    });
    expect(codes(evaluateEntry(input, baseRequest()))).toContain('weekly_loss');
  });
});

describe('R10 kill switch', () => {
  test('equity at 70% of the high-water mark disables entries and returns a trip', () => {
    const input = baseInput({ account: account({ closedTrades: [trade(LAST_WEEK, '-6', { notional: usd('5') })] }) });
    const d = expectRefusedButExitPasses(input, baseRequest(), 'kill_switch', true);
    expect(d.trips).toContain('kill_switch');
  });
  test('the high-water mark follows gains, so the line rises with them', () => {
    const input = baseInput({ account: account({ closedTrades: [trade(LAST_WEEK - HOUR, '10'), trade(LAST_WEEK, '-9', { notional: usd('5') })] }) });
    expect(evaluateEntry(input, baseRequest()).snapshot?.highWaterMark).toBe(usd('30'));
    expect(codes(evaluateEntry(input, baseRequest()))).toContain('kill_switch');
  });
  test('a withdrawal lowers equity and the mark together and does not trip it', () => {
    const input = baseInput({ account: account({ flows: [{ atMs: LAST_WEEK, amount: -usd('4') as MicroUsd }] }) });
    const d = allowed(evaluateEntry(input, baseRequest()));
    expect(d.snapshot).toMatchObject({ equity: usd('16'), highWaterMark: usd('16') });
  });
  test('once tripped it stays off until the owner re-arms, which restarts the mark', () => {
    const closed = [trade(LAST_WEEK, '-6', { notional: usd('5') })];
    const latched = baseInput({ account: account({ closedTrades: closed }), latches: latches({ killTrippedAtMs: LAST_WEEK + HOUR }) });
    const d = expectRefusedButExitPasses(latched, baseRequest(), 'kill_switch', true);
    expect(d.trips).toEqual([]); // already latched: nothing new to store
    const rearmed = baseInput({
      account: account({ closedTrades: closed }), latches: latches({ killTrippedAtMs: LAST_WEEK + HOUR, killRearmedAtMs: LAST_WEEK + 2 * HOUR }),
    });
    const after = evaluateEntry(rearmed, baseRequest());
    expect(codes(after)).not.toContain('kill_switch');
    expect(after.snapshot?.highWaterMark).toBe(usd('14'));
  });
});

describe('item 2: exits return trips so a marked dip is latched', () => {
  test('an open position marked below the kill line trips R10 on the exit path', () => {
    const open = { mint: MINT_B, openedAtMs: NOW - HOUR, notional: usd('5'), mark: usd('0.5'), markAtMs: NOW - 100 };
    const closed = [trade(LAST_WEEK, '-2', { notional: usd('5') })];
    const exit = evaluateExit(baseInput({ account: account({ openPositions: [open], closedTrades: closed }) }));
    expect(exit.allow).toBe(true);
    expect(exit.trips).toContain('kill_switch');
  });
  test('a marked weekly loss trips R9 on the exit path', () => {
    const open = { mint: MINT_B, openedAtMs: NOW - HOUR, notional: usd('5'), mark: usd('0.9'), markAtMs: NOW - 100 };
    const exit = evaluateExit(baseInput({ account: account({ openPositions: [open] }) }));
    expect(exit.trips).toContain('weekly_loss');
    expect(exit.trips).not.toContain('kill_switch');
  });
  test('already latched trips are not returned again, and nothing is returned when nothing trips', () => {
    const open = { mint: MINT_B, openedAtMs: NOW - HOUR, notional: usd('5'), mark: usd('0.9'), markAtMs: NOW - 100 };
    const latched = baseInput({ account: account({ openPositions: [open] }), latches: latches({ weeklyTrippedAtMs: NOW - HOUR }) });
    expect(evaluateExit(latched).trips).toEqual([]);
    expect(evaluateExit(baseInput()).trips).toEqual([]);
  });
});

describe('R11 entries (live only)', () => {
  const entries = (n: number, m = MINT_B) => Array.from({ length: n }, (_, i) => ({ mint: m, atMs: DAY_START + (i + 1) * HOUR }));
  test('3 live entries a day', () => {
    expectRefusedButExitPasses(baseInput({ account: account({ entries: entries(3) }) }), baseRequest(), 'entries_per_day', true);
    allowed(evaluateEntry(baseInput({ account: account({ entries: entries(2) }) }), baseRequest()));
  });
  test('1 entry per mint per day', () => {
    expectRefusedButExitPasses(baseInput({ account: account({ entries: entries(1, MINT_A) }) }), baseRequest(), 'entries_per_mint', false);
  });
  test('no re-entry on a stopped mint for 24 h', () => {
    const stopped = trade(NOW - 23 * HOUR, '0.1', { mint: MINT_A, stoppedOut: true });
    expectRefusedButExitPasses(baseInput({ account: account({ closedTrades: [stopped] }) }), baseRequest(), 'reentry_after_stop', false);
    const old = trade(NOW - TRIAL_POLICY.positions.reentryBlockMs, '0.1', { mint: MINT_A, stoppedOut: true });
    allowed(evaluateEntry(baseInput({ account: account({ closedTrades: [old] }) }), baseRequest()));
  });
  test('paper and backtest have no entry caps', () => {
    const input = baseInput({ mode: 'paper', account: account({ entries: [...entries(3), ...entries(1, MINT_A)] }) });
    allowed(evaluateEntry(input, baseRequest()));
  });
});

describe('R12 liquidity floor', () => {
  test('unknown liquidity refuses', () => {
    expectRefusedButExitPasses(baseInput(), baseRequest({ poolLiquidity: null }), 'liquidity_unknown', false);
  });
  test('below $15k refuses; U1 needs $50k', () => {
    expectRefusedButExitPasses(baseInput(), baseRequest({ poolLiquidity: usd('14999.99') }), 'liquidity_floor', false);
    expectRefusedButExitPasses(baseInput(), baseRequest({ poolLiquidity: usd('49999'), universe: 'U1' }), 'liquidity_floor', false);
    allowed(evaluateEntry(baseInput(), baseRequest({ poolLiquidity: usd('15000') })));
  });
});

describe('R13 executable depth', () => {
  test('a pool whose round-trip impact at q_min passes 1% refuses', () => {
    expectRefusedButExitPasses(baseInput(), baseRequest({ quote: quoterFor(SHALLOW_POOL) }), 'depth_cap', false);
  });
  test('a stale quote refuses', () => {
    expectRefusedButExitPasses(baseInput(), baseRequest({ quoteAtMs: NOW - TRIAL_POLICY.gates.maxQuoteAgeMs - 1 }), 'quote_stale', false);
  });
  test('a pool that cannot be quoted refuses, whether the quote says so or throws', () => {
    const complete = () => ({ ok: false as const, reason: 'curve-complete' as const, detail: 'curve complete' });
    expectRefusedButExitPasses(baseInput(), baseRequest({ quote: complete }), 'quote_failed', false);
    const broken = () => { throw new RangeError('bad state'); };
    expectRefusedButExitPasses(baseInput(), baseRequest({ quote: broken }), 'quote_failed', false);
  });
});

describe('R14 cost gate', () => {
  test('a round trip above a third of the median target refuses', () => {
    expectRefusedButExitPasses(baseInput(), baseRequest({ medianTargetBps: 100 }), 'cost_gate', false);
  });
  test('no edge over costs refuses', () => {
    expectRefusedButExitPasses(baseInput(), baseRequest({ edgePpm: 0n }), 'expected_net_not_positive', false);
  });
  test('the round trip at the chosen size is reported and inside 5%', () => {
    const d = allowed(evaluateEntry(baseInput(), baseRequest()));
    expect(d.roundTripPpm).toBeGreaterThan(0n);
    expect(d.roundTripPpm).toBeLessThanOrEqual(BigInt(TRIAL_POLICY.costGate.maxRoundTripBps) * 100n);
  });
});

describe('R15 no martingale, policy locked', () => {
  test('an ended session refuses', () => {
    const session = startSession(TRIAL_POLICY);
    session.end();
    expectRefusedButExitPasses(baseInput({ session }), baseRequest(), 'session_not_running', true);
  });
  test('never add to an open position', () => {
    const open = { mint: MINT_A, openedAtMs: NOW - HOUR, notional: usd('2'), mark: usd('1.8'), markAtMs: NOW - 100 };
    expectRefusedButExitPasses(baseInput({ account: account({ openPositions: [open] }) }), baseRequest(), 'add_to_position', false);
  });
  test('never a larger size after a loss', () => {
    const input = baseInput({
      latches: latches({ sizeStepUpApproved: true }),
      account: account({ closedTrades: [trade(LAST_WEEK - 5 * HOUR, '1'), trade(LAST_WEEK, '-0.1', { notional: usd('2.5') })] }),
    });
    const d = allowed(evaluateEntry(input, baseRequest()));
    expect(d.notional).toBeLessThanOrEqual(usd('2.5'));
    expect(d.caps.find((c) => c.control === 'R15')?.notional).toBe(usd('2.5'));
  });
  test('the same minimum size after a loss at the minimum is allowed (lamport rounding of q_min is not a raise)', () => {
    const input = baseInput({ account: account({ closedTrades: [trade(LAST_WEEK, '-0.3')] }) });
    expect(allowed(evaluateEntry(input, baseRequest())).notional).toBe(TRIAL_POLICY.capital.minNotional);
  });
});

describe('R16 regime gate (live only)', () => {
  test('regime off or unknown refuses a live entry', () => {
    const input = baseInput();
    expectRefusedButExitPasses({ ...input, market: { ...input.market, regime: 'off' } }, baseRequest(), 'regime_off', true);
    expectRefusedButExitPasses({ ...input, market: { ...input.market, regime: 'unknown' } }, baseRequest(), 'regime_unknown', true);
  });
  test('paper keeps trading with the regime off', () => {
    const input = baseInput({ mode: 'paper' });
    allowed(evaluateEntry({ ...input, market: { ...input.market, regime: 'off' } }, baseRequest()));
  });
});

describe('every reason names its control, and exits survive anything', () => {
  test('several controls tripped at once are all reported', () => {
    const input = baseInput({ account: account({ unresolvedEntries: [{ mint: MINT_B }], closedTrades: [trade(LAST_WEEK, '-6', { notional: usd('5') })] }) });
    const d = evaluateEntry({ ...input, market: { ...input.market, regime: 'off' } }, baseRequest({ stopBps: 9000 }));
    expect(new Set(d.allow ? [] : d.reasons.map((r) => r.control))).toEqual(new Set(['R3', 'R5', 'R6', 'R10', 'R16']));
  });
  test('an exit passes even when the inputs are broken', () => {
    const input = baseInput({ clock: clockAt(Number.NaN) });
    expect(evaluateExit(input)).toEqual({ allow: true, tripped: [], trips: [] });
    const nonsense = baseInput({ account: { ...account(), closedTrades: null as never } });
    expect(evaluateExit(nonsense).allow).toBe(true);
  });
  test('a figure check: the snapshot reports loss in micro-dollars against Melbourne boundaries', () => {
    const input = baseInput({ account: account({ closedTrades: [trade(DAY_START + HOUR, '-0.75')] }) });
    const d = evaluateEntry(input, baseRequest());
    expect(d.snapshot).toMatchObject({ dayStartMs: DAY_START, weekStartMs: WEEK_START, dayLoss: usd('0.75'), weekLoss: usd('0.75') });
    expect(lamportsToMicroUsd(lamports(SOL), PRICE, 'floor')).toBe(PRICE);
  });
});
