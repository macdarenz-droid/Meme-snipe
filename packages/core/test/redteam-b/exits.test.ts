// RED TEAM B: EXIT-1 attacks. Each test asserts the safe behaviour and FAILS at 959d801.
import { describe, expect, test } from 'vitest';
import type { PoolState } from '../../src/amm/index.ts';
import { FILL_CONFIG, TRIAL_POLICY } from '../../src/config/index.ts';
import { type EntryPlan, type ExitTracker, type Holding, decideExit, exitSettings, liquidationValue, newTracker, planAttempt, slowRetryWaitMs } from '../../src/exits/index.ts';
import { type ObservedFees, observedFeeContext } from '../../src/fills/index.ts';
import { bps, mulDiv } from '../../src/units/index.ts';
import { NORMAL_COIN } from '../amm/helpers.ts';

const G = TRIAL_POLICY.exits;
const S = exitSettings(TRIAL_POLICY, 'wick', FILL_CONFIG.network);
const FEES: ObservedFees = { split: { lp: bps(20), protocol: bps(5), creator: bps(95) }, buybackFeeBps: bps(5000), instruction: 'v1' };
const CTX = observedFeeContext(FEES, 1_000_000_000_000_000n, NORMAL_COIN);
const pool = (quoteVault: bigint): PoolState => ({ baseReserve: 200_000_000_000_000n, quoteVault, virtualQuoteReserves: 0n });
const QTY = 25_000_000_000n;
const VAULT = 80_000_000_000n;
const plan: EntryPlan = { universe: 'U2', openedAtMs: 0, notional: TRIAL_POLICY.capital.minNotional, riskUnit: 2_000_000n, stopPrice: 1n, entryReserve: VAULT };
const v = liquidationValue({ venue: 'pumpswap', pool: pool(VAULT), ctx: CTX }, QTY);
const value = v.ok ? v.value : 0n;

describe('RB-5 a blocked exit whose bounded retries are spent never sells again', () => {
  test('RB-5a healthy fresh market a day later, time_max long past: the position is held forever (and R3 blocks every entry)', () => {
    const spent = G.ladder.maxAttempts + G.blockedRetryAttempts;
    const h: Holding = { status: 'exit_blocked', quantity: QTY, sold: 0n, realized: 0n, costBasis: value, exitCost: 30_000n, exitSeq: 1 + G.blockedRetryAttempts, exitAttempts: spent, tokenAccountBalance: QTY, closeFailed: false };
    const now = 24 * 3_600_000;
    const step = decideExit(S, plan, h, { ...newTracker(), blockedRetries: G.blockedRetryAttempts, blockedAtMs: 0 }, {
      nowMs: now, slotClose: true, market: { atMs: now, value: { venue: 'pumpswap', pool: pool(VAULT), ctx: CTX } }, deployerSoldBps: null, sellRoute: null, flow: [], bars: [],
    });
    // At 959d801: { kind: 'hold', detail: 'exit blocked: retries used' } for ever; no owner command handles it
    // (ledger OPERATOR_COMMANDS lists close_position but nothing implements it).
    expect(step.decision.kind).toBe('exit');
  });
});

// EXIT-FILL-FIXES: the fix's two proofs. A slow retry can never become a fast loop, and it never sells below the ladder's
// last rung (the emergency rung) or without a fresh quote that pays for the attempt.
describe('RB-5 the slow retries after the bounded ones', () => {
  const LAST = G.ladder.steps.length - 1;
  const spentHolding = (attempts: number): Holding => ({
    status: 'exit_blocked', quantity: QTY, sold: 0n, realized: 0n, costBasis: value, exitCost: 30_000n, exitSeq: 1 + G.blockedRetryAttempts,
    exitAttempts: attempts, tokenAccountBalance: QTY, closeFailed: false,
  });
  const fresh = (now: number, vault = VAULT) => ({
    nowMs: now, slotClose: true, market: { atMs: now, value: { venue: 'pumpswap' as const, pool: pool(vault), ctx: CTX } }, deployerSoldBps: null, sellRoute: null, flow: [], bars: [],
  });

  /** Every retry fails; the position steps once a minute for `days`. `restartEveryMs` drops the tracker (a restart). */
  const drive = (days: number, restartEveryMs: number | null) => {
    let attempts = G.ladder.maxAttempts + G.blockedRetryAttempts;
    let t: ExitTracker = { ...newTracker(), blockedRetries: G.blockedRetryAttempts, blockedAtMs: 0 };
    const at: number[] = [];
    for (let now = 0; now <= days * 86_400_000; now += 60_000) {
      if (restartEveryMs !== null && now > 0 && now % restartEveryMs === 0) t = newTracker();
      const step = decideExit(S, plan, spentHolding(attempts), t, fresh(now));
      t = step.tracker;
      if (step.decision.kind !== 'exit') continue;
      at.push(now);
      // The single attempt is signed and fails: the book counts it, and the position is blocked again.
      attempts++;
    }
    return at;
  };

  test('RB-5b no fast loop: waits start at 64 × blockedRetryMs and double to 1,024 ×; a week holds at most 13 slow retries', () => {
    const at = drive(7, null);
    const gaps = at.map((x, i) => x - (i === 0 ? 0 : at[i - 1]!));
    // The first waits exactly its slot from the block at 0; each later one is counted from the step after the failure.
    expect(gaps[0]).toBe(slowRetryWaitMs(G.blockedRetryMs, 0));
    expect(slowRetryWaitMs(G.blockedRetryMs, 0)).toBe(64 * G.blockedRetryMs);
    for (let i = 1; i < gaps.length; i++) expect(gaps[i]).toBe(slowRetryWaitMs(G.blockedRetryMs, i) + 60_000);
    for (let i = 1; i < gaps.length; i++) expect(gaps[i]!).toBeGreaterThanOrEqual(gaps[i - 1]!);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(1_024 * G.blockedRetryMs + 60_000);
    expect(at.length).toBeGreaterThan(0);
    expect(at.length).toBeLessThanOrEqual(13);
    // The fee bound: each slow retry costs at most one last-rung attempt.
    expect(BigInt(at.length) * S.retryCost).toBeLessThanOrEqual(13n * 510_000n);
  });

  test('RB-5b restarts only delay the slow retries: the count comes from the book, the wait restarts', () => {
    const steady = drive(7, null).length;
    for (const every of [30 * 60_000, 3 * 3_600_000, 86_400_000]) expect(drive(7, every).length).toBeLessThanOrEqual(steady);
  });

  test('RB-5c the slow retry sells only at the last rung, from a fresh quote, one attempt, never below that rung\'s min-out', () => {
    const now = 24 * 3_600_000;
    const h = spentHolding(G.ladder.maxAttempts + G.blockedRetryAttempts);
    const t = { ...newTracker(), blockedRetries: G.blockedRetryAttempts, blockedAtMs: 0 };
    const d = decideExit(S, plan, h, t, fresh(now)).decision;
    expect(d).toMatchObject({ kind: 'exit', retry: true, partial: false, quantity: QTY, startRung: LAST, maxAttempts: 1, blocked: null, reasons: ['max_hold'] });
    if (d.kind !== 'exit' || !d.value.ok) throw new Error('expected an exit with a quote');
    expect(d.value.value).toBe(value);
    // The one attempt it may make: the last rung, min-out at that rung's distance below the fresh quote, never lower.
    const a = planAttempt(G.ladder, 1, d.value.value, d.value.value, d.startRung, d.maxAttempts, null);
    expect(a).toMatchObject({ ok: true, rung: LAST });
    if (!a.ok) throw new Error('expected a plan');
    expect(a.minOut).toBe(mulDiv(value, 10_000n - BigInt(G.ladder.steps[LAST]!.minOutBelowTriggerBps), 10_000n, 'floor'));
    expect(planAttempt(G.ladder, 2, d.value.value, d.value.value, d.startRung, d.maxAttempts, null)).toMatchObject({ ok: false, reason: 'ladder-exhausted' });
    // No fresh quote: held (a stale market state is not a quote).
    const stale = { ...fresh(now), market: { atMs: now - S.maxQuoteAgeMs - 1, value: { venue: 'pumpswap' as const, pool: pool(VAULT), ctx: CTX } } };
    expect(decideExit(S, plan, h, t, stale).decision).toMatchObject({ kind: 'hold', detail: 'exit blocked: market state is stale' });
    // Least proceeds at the last rung not above the attempt's cost: held.
    expect(decideExit({ ...S, retryCost: a.minOut }, plan, h, t, fresh(now)).decision).toMatchObject({ kind: 'hold', detail: 'exit blocked: the least accepted proceeds do not cover the attempt' });
    // A blocked exit still alerts the owner each time it is booked blocked (lifecycle, unchanged).
  });
});
