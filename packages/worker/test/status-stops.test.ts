// API-1 review (B1): the status serves the account's risk stops as halt reasons, read from the worker's risk state
// (core risk's tripped entry controls, nothing latched), so the app never shows "Entries: On" while a stop refuses
// every entry; and the regime evaluation counts only while current.
import { describe, expect, it } from 'vitest';
import { FILL_CONFIG, RESEARCH_CONFIG, RUG_CONFIG, TRIAL_POLICY, startSession, usd } from '../../core/src/config/index.ts';
import type { MarketEvent, StrategyContext } from '../../core/src/engine/index.ts';
import { emptyBook } from '../../core/src/lifecycle/book.ts';
import { type Latches, NO_LATCHES } from '../../core/src/risk/index.ts';
import { lamports } from '../../core/src/units/index.ts';
import { DAY_START, HOUR, MINUTE, NOW, PRICE, SOL, WEEK_START, account, latches, trade } from '../../core/test/risk/helpers.ts';
import { checkEnvelope } from '../../../apps/web/src/api/modes.ts';
import { schemaFor } from '../../../apps/web/src/api/schemas.ts';
import { statusRows } from '../../../apps/web/src/dashboard/Sections.tsx';
import type { WorkerStatus } from '../../../apps/web/src/api/contract.ts';
import { ACCOUNT_KEY, LiveStrategy, SOL_PRICE_KEY } from '../src/engine/strategy.ts';
import { STOPS_MAX_AGE_MS, stopHalts, views } from '../src/run/api.ts';
import { strategyConfig } from '../src/run/settings.ts';
import { makeWorker } from './worker-harness.ts';

type History = ReturnType<typeof account>;
const moment = (ms: number) => ({ slot: BigInt(ms), txIndex: 0, ixIndex: 0, receivedAt: ms });

/** The strategy's stops after one event at `now`, with this account (null: no account fact) and a fresh SOL price. */
const stopsOf = (h: History | null, l: Latches = NO_LATCHES, o: { now?: number; running?: boolean } = {}) => {
  const now = o.now ?? NOW;
  const base = startSession(TRIAL_POLICY);
  const session = o.running === false ? { ...base, running: false } : base;
  const s = new LiveStrategy({ session, rugs: RUG_CONFIG, config: strategyConfig(session.policy, FILL_CONFIG, RESEARCH_CONFIG) });
  const facts: Record<string, unknown> = {
    [SOL_PRICE_KEY]: { value: PRICE, atMs: now },
    ...(h === null ? {} : { [ACCOUNT_KEY]: { history: h, latches: l, solBalance: { value: lamports(SOL), atMs: now }, paper: true, oneTimeRent: 0n } }),
  };
  const ctx: StrategyContext = {
    now: moment(now), book: emptyBook({ maxOpenPositions: session.policy.positions.maxOpen }), rng: { next: () => 0 } as never,
    lookup: (k) => (k in facts ? { ok: true, moment: moment(now), value: facts[k], source: 'test' } : { ok: false, reason: 'missing' } as never),
    history: () => [],
  };
  const e: MarketEvent = { kind: 'market', id: 'e1', moment: moment(now), key: ACCOUNT_KEY, value: facts[ACCOUNT_KEY] ?? null };
  s.onMarket(e, ctx);
  return s.riskStops();
};
const codes = (...a: Parameters<typeof stopsOf>) => stopsOf(...a)?.codes;
const small = (t: number) => trade(t, '-0.1');

describe('the strategy reads the account stops from its risk state', () => {
  it('a clean account has none', () => {
    expect(stopsOf(account())).toEqual({ atMs: NOW, codes: [] });
  });
  it('daily loss reached (R7)', () => {
    expect(codes(account({ closedTrades: [trade(DAY_START + HOUR, '-1.5', { notional: usd('5') })] }))).toContain('daily_loss');
  });
  it('2 losses in a row: the 2 h cooldown (R8)', () => {
    expect(codes(account({ closedTrades: [small(NOW - 3 * HOUR), small(NOW - HOUR)] }))).toContain('loss_cooldown');
  });
  it('3 losses in a row: paused for the day (R8)', () => {
    expect(codes(account({ closedTrades: [small(DAY_START + MINUTE), small(DAY_START + 2 * MINUTE), small(NOW - 3 * HOUR)] }))).toContain('loss_day_pause');
  });
  it('5 losses in 20 trades: paused until reviewed (R8)', () => {
    const lastWeek = WEEK_START - 30 * HOUR;
    const closed = Array.from({ length: 9 }, (_, i) => trade(lastWeek - (9 - i) * HOUR, i % 2 === 0 ? '-0.1' : '0.1'));
    expect(codes(account({ closedTrades: closed }))).toContain('loss_review');
  });
  it('weekly loss reached, and the weekly latch until reviewed (R9)', () => {
    expect(codes(account({ closedTrades: [trade(WEEK_START + 5 * HOUR, '-4', { notional: usd('5') })] }))).toContain('weekly_loss');
    expect(codes(account(), latches({ weeklyTrippedAtMs: WEEK_START + 5 * HOUR }))).toContain('weekly_review');
  });
  it('the kill latch until re-armed (R10)', () => {
    expect(codes(account(), latches({ killTrippedAtMs: WEEK_START + 5 * HOUR }))).toContain('kill_switch');
  });
  it('the policy session ended (R15)', () => {
    expect(codes(account(), NO_LATCHES, { running: false })).toContain('session_not_running');
  });
  it('no account fact: unknown, never none', () => {
    expect(stopsOf(null)).toEqual({ atMs: NOW, codes: null });
  });
});

describe('the status serves them as halt reasons', () => {
  it.each([
    ['daily_loss', 'daily-loss'], ['weekly_loss', 'weekly-loss'], ['weekly_review', 'weekly-review'], ['kill_switch', 'kill-switch'],
    ['wallet_below_kill_line', 'wallet-below-kill-line'], ['loss_cooldown', 'loss-cooldown'], ['loss_day_pause', 'loss-day-pause'],
    ['loss_review', 'loss-review'], ['session_not_running', 'session-ended'], ['max_open_positions', 'max-open-positions'],
  ])('%s is %s', (core, code) => {
    expect(stopHalts({ atMs: NOW, codes: [core] }, NOW)).toEqual([{ code, source: null }]);
  });
  it('any other tripped control is "risk" with its code; unknown, missing or old stops are "risk-unknown"', () => {
    expect(stopHalts({ atMs: NOW, codes: ['sol_price_stale'] }, NOW)).toEqual([{ code: 'risk', source: 'sol_price_stale' }]);
    expect(stopHalts({ atMs: NOW, codes: [] }, NOW)).toEqual([]);
    expect(stopHalts({ atMs: NOW, codes: null }, NOW)).toEqual([{ code: 'risk-unknown', source: null }]);
    expect(stopHalts(null, NOW)).toEqual([{ code: 'risk-unknown', source: null }]);
    expect(stopHalts({ atMs: NOW - STOPS_MAX_AGE_MS - 1, codes: [] }, NOW)).toEqual([{ code: 'risk-unknown', source: null }]);
    expect(stopHalts({ atMs: NOW - STOPS_MAX_AGE_MS, codes: [] }, NOW)).toEqual([]);
  });
});

describe('the app never shows "Entries: On" while a stop is active or the regime evaluation is old', () => {
  const card = (patch: Record<string, unknown>) => {
    const h = makeWorker();
    const i = { ...h.worker.apiInputs(), halted: [], budgetHalted: [], nowMs: NOW, regime: { atMs: NOW - 1_000, on: true, reasons: [] }, stops: { atMs: NOW, codes: [] as string[] }, ...patch };
    const body = JSON.parse(JSON.stringify({ mode: 'paper', asOf: new Date(NOW).toISOString(), data: views.status(i as never) }));
    void h.worker.stop();
    return statusRows((checkEnvelope(body, 'paper', schemaFor('status', 'paper')) as { data: WorkerStatus }).data).map((r) => `${r.label}: ${r.value}`);
  };

  it('with no stop and a current regime on: On', () => {
    expect(card({})).toContain('Entries: On');
  });
  it.each(['daily_loss', 'weekly_loss', 'weekly_review', 'kill_switch', 'loss_cooldown', 'loss_day_pause', 'loss_review', 'session_not_running'])('%s: Off', (c) => {
    const rows = card({ stops: { atMs: NOW, codes: [c] } });
    expect(rows).not.toContain('Entries: On');
    expect(rows[0]).toMatch(/^Entries: Off: /);
  });
  it('stops unknown: Off', () => {
    expect(card({ stops: null })).toContain('Entries: Off: risk unknown');
  });
  it('the probe: daily loss used 2.00 of 1.00 on the meter is Off even before core risk reads it', () => {
    const t = { closedAtMs: NOW - MINUTE, netPnl: -2_000_000n };
    const rows = card({ trades: [t] });
    expect(rows).toContain('Entries: Off: daily loss');
  });
  it('a regime evaluation older than regimeMaxAgeMs: not On', () => {
    const h = makeWorker();
    const max = h.worker.apiInputs().regimeMaxAgeMs;
    void h.worker.stop();
    expect(max).toBe(2 * TRIAL_POLICY.gates.maxQuoteAgeMs);
    expect(card({ regime: { atMs: NOW - max, on: true, reasons: [] } })).toContain('Entries: On');
    const old = card({ regime: { atMs: NOW - max - 1, on: true, reasons: [] } });
    expect(old).not.toContain('Entries: On');
    expect(old).toContain('Regime: Not checked lately');
  });
});
