// Fixtures for the risk tests: a locked trial session, a healthy account and an entry the policy allows.
import { expect } from 'vitest';
import { type PoolState } from '../../src/amm/index.ts';
import { TRIAL_POLICY, startSession, usd } from '../../src/config/index.ts';
import { BASE_FEE_PER_SIGNATURE, type NetworkPolicy, type RentInputs, pumpSwapRoundTrip } from '../../src/costs/index.ts';
import { type Mint, intentId, mint, reservationId } from '../../src/domain/index.ts';
import {
  type AccountHistory, type ClosedTrade, type EntryDecision, type EntryRequest, type Latches, type ReservationRequest,
  type ReservationStore, type ReserveResult, type RiskCode, type RiskInput, NO_LATCHES, evaluateEntry, evaluateExit,
} from '../../src/risk/index.ts';
import { type Lamports, type MicroUsd, lamports, solPriceMicroUsd } from '../../src/units/index.ts';
import { PUMP_CURVE_PARAMS } from '../../src/amm/index.ts';
import { AMM_FEE_CONFIG } from '../amm/helpers.ts';
import { key32 } from '../fixtures.ts';

export const SOL = 1_000_000_000n;
export const HOUR = 3_600_000;
export const MINUTE = 60_000;
/** Wednesday 7 October 2026, 13:00 AEDT. Monday of that week starts 2026-10-04T13:00Z. */
export const NOW = Date.UTC(2026, 9, 7, 2, 0);
export const WEEK_START = Date.UTC(2026, 9, 4, 13, 0);
export const DAY_START = Date.UTC(2026, 9, 6, 13, 0);
export const PRICE = solPriceMicroUsd('119.46');

export const MINT_A: Mint = mint(key32(11));
export const MINT_B: Mint = mint(key32(12));

/** A PumpSwap pool with about 400 SOL of quote: $2 to $5 moves it well under 1%. */
export const DEEP_POOL: PoolState = { baseReserve: 150_000_000_000_000n, quoteVault: 400n * SOL, virtualQuoteReserves: 0n };
/** One SOL of quote: $2 moves it more than 1% round trip. */
export const SHALLOW_POOL: PoolState = { baseReserve: 1_000_000_000_000n, quoteVault: SOL, virtualQuoteReserves: 0n };
const poolCtx = { feeConfig: AMM_FEE_CONFIG, canonical: true, quote: 'sol' as const, baseSupply: PUMP_CURVE_PARAMS.tokenTotalSupply, creatorFeeCharged: true };
export const quoterFor = (pool: PoolState) => pumpSwapRoundTrip(pool, poolCtx);

export const NETWORK: NetworkPolicy = {
  signaturesPerTx: 1n, baseFeePerSignature: BASE_FEE_PER_SIGNATURE, entryPriorityFee: 20_000n, exitPriorityFee: 20_000n,
  tip: 5_000n, entryFailurePpm: 0n, exitFailurePpm: 0n,
};
export const RENT: RentInputs = { tokenAccount: 1_513_840n, tokenAccountClosedOnExit: true, oneTime: 0n, transient: 0n };

export const clockAt = (ms: number) => ({ now: () => ({ receivedAt: ms }) });

export const account = (patch: Partial<AccountHistory> = {}): AccountHistory => ({
  openingEquity: usd('20'), openedAtMs: Date.UTC(2026, 8, 1), flows: [], closedTrades: [], openPositions: [], entries: [],
  unresolvedEntries: 0, heldReservations: lamports(0n), ...patch,
});

export const trade = (closedAtMs: number, netPnl: string, patch: Partial<ClosedTrade> = {}): ClosedTrade => ({
  mint: MINT_B, openedAtMs: closedAtMs - 10 * MINUTE, closedAtMs, notional: usd('2'),
  netPnl: (netPnl.startsWith('-') ? -usd(netPnl.slice(1)) : usd(netPnl)) as MicroUsd, stoppedOut: false, ...patch,
});

export const baseInput = (patch: Partial<RiskInput> = {}): RiskInput => ({
  session: startSession(TRIAL_POLICY),
  mode: 'live',
  clock: clockAt(NOW),
  account: account(),
  latches: NO_LATCHES,
  market: { solPrice: { value: PRICE, atMs: NOW - 500 }, solBalance: { value: lamports(SOL), atMs: NOW - 500 }, regime: 'on' },
  ...patch,
});

export const latches = (patch: Partial<Latches>): Latches => ({ ...NO_LATCHES, ...patch });

let seq = 0;
export const baseRequest = (patch: Partial<EntryRequest> = {}): EntryRequest => {
  seq++;
  return {
    intentId: intentId(`i-${seq}`), reservationId: reservationId(`r-${seq}`), mint: MINT_A, universe: 'U2', stopBps: 1500,
    edgePpm: 200_000n, medianTargetBps: 3000, quote: quoterFor(DEEP_POOL), quoteAtMs: NOW - 200,
    poolLiquidity: usd('100000'), network: NETWORK, rent: RENT, ...patch,
  };
};

export const codes = (d: EntryDecision): RiskCode[] => (d.allow ? [] : d.reasons.map((r) => r.code));

/**
 * The entry is refused for `code` (and the reason names that code's control), and an exit on the same inputs still
 * passes. Account-level controls must also show as tripped on the exit.
 */
export const expectRefusedButExitPasses = (input: RiskInput, request: EntryRequest, code: RiskCode, accountLevel: boolean): EntryDecision => {
  const d = evaluateEntry(input, request);
  expect(d.allow, `entry should be refused for ${code}`).toBe(false);
  expect(codes(d)).toContain(code);
  const exit = evaluateExit(input);
  expect(exit.allow).toBe(true);
  if (accountLevel) expect(exit.tripped.map((r) => r.code)).toContain(code);
  return d;
};

/** In-memory stand-in for LEDGER-1's atomic reservation: check and insert happen together. */
export class MemoryReservationStore implements ReservationStore {
  readonly held = new Map<string, Lamports>();
  readonly intents = new Set<string>();

  get total(): bigint {
    let t = 0n;
    for (const v of this.held.values()) t += v;
    return t;
  }

  reserveExposure(r: ReservationRequest & { readonly ts: number }): ReserveResult {
    if (this.intents.has(r.intentId) || this.held.has(r.reservationId)) return { ok: false, reason: 'already_reserved' };
    if (this.held.size + 1 > r.limits.maxCount) return { ok: false, reason: 'too_many' };
    if (this.total + r.amount > r.limits.maxHeld) return { ok: false, reason: 'over_limit' };
    this.held.set(r.reservationId, r.amount);
    this.intents.add(r.intentId);
    return { ok: true, heldAfter: lamports(this.total) };
  }

  release(reservationIdText: string): void {
    this.held.delete(reservationIdText);
  }
}
