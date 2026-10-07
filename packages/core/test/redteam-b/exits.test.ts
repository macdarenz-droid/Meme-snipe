// RED TEAM B: EXIT-1 attacks. Each test asserts the safe behaviour and FAILS at 959d801.
import { describe, expect, test } from 'vitest';
import type { PoolState } from '../../src/amm/index.ts';
import { FILL_CONFIG, TRIAL_POLICY } from '../../src/config/index.ts';
import { type EntryPlan, type Holding, decideExit, exitSettings, liquidationValue, newTracker } from '../../src/exits/index.ts';
import { type ObservedFees, observedFeeContext } from '../../src/fills/index.ts';
import { bps } from '../../src/units/index.ts';
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
