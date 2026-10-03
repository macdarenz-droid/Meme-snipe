// R6 reservation: the full possible loss plus all costs is reserved atomically before any entry. The store here is the
// in-memory stand-in for LEDGER-1; the property test runs random sequences through the real evaluator and checks the
// total reserved never exceeds the limit, computed independently from §8's formulas.
import { describe, expect, test } from 'vitest';
import { PolicyError, TRIAL_POLICY, startSession, usd } from '../../src/config/index.ts';
import { intentId, reservationId } from '../../src/domain/index.ts';
import {
  type ClosedTrade, type EntryAllowed, type ReservationRequest, type RiskInput, evaluateEntry, melbourneWeek, reserve,
} from '../../src/risk/index.ts';
import { type MicroUsd, lamports, lamportsToMicroUsd, microUsdToLamports, mulDiv } from '../../src/units/index.ts';
import {
  HOUR, MINT_A, MINT_B, MemoryReservationStore, NOW, PRICE, SOL, account, baseInput, baseRequest, clockAt, codes, trade,
} from './helpers.ts';

const request = (amount: bigint, maxHeld: bigint, maxCount = 1, n = 1): ReservationRequest => ({
  reservationId: reservationId(`r-${n}`), intentId: intentId(`i-${n}`), amount: lamports(amount), limits: { maxHeld: lamports(maxHeld), maxCount },
});

describe('reservation edge cases', () => {
  test('exactly at the limit is accepted, one lamport over is refused and stores nothing', () => {
    const at = new MemoryReservationStore();
    expect(reserve(at, request(1_000n, 1_000n), NOW)).toEqual({ ok: true, heldAfter: 1_000n });
    const over = new MemoryReservationStore();
    expect(reserve(over, request(1_001n, 1_000n), NOW)).toEqual({ ok: false, reason: 'over_limit' });
    expect(over.total).toBe(0n);
  });
  test('the limit includes what is already held', () => {
    const s = new MemoryReservationStore();
    expect(reserve(s, request(600n, 1_000n, 2, 1), NOW).ok).toBe(true);
    expect(reserve(s, request(400n, 1_000n, 2, 2), NOW)).toEqual({ ok: true, heldAfter: 1_000n });
    expect(reserve(s, request(1n, 1_000n, 3, 3), NOW)).toEqual({ ok: false, reason: 'over_limit' });
  });
  test('the count limit, duplicates and empty amounts are refused', () => {
    const s = new MemoryReservationStore();
    expect(reserve(s, request(1n, 1_000n, 1, 1), NOW).ok).toBe(true);
    expect(reserve(s, request(1n, 1_000n, 1, 2), NOW)).toEqual({ ok: false, reason: 'too_many' });
    expect(reserve(s, request(1n, 1_000n, 5, 1), NOW)).toEqual({ ok: false, reason: 'already_reserved' });
    expect(reserve(s, request(0n, 1_000n, 5, 9), NOW)).toEqual({ ok: false, reason: 'not_an_entry' });
  });
  test('an allowed decision reserves q + C against the R6 allowance', () => {
    const d = evaluateEntry(baseInput(), baseRequest()) as EntryAllowed;
    expect(d.allow).toBe(true);
    // Allowance = min(E - 0.7 HWM, 0.2 E_week_start - L_week) = min($6, $4) = $4, in lamports.
    expect(d.reservation.limits.maxHeld).toBe(microUsdToLamports(usd('4'), PRICE, 'floor'));
    expect(reserve(new MemoryReservationStore(), d.reservation, NOW)).toEqual({ ok: true, heldAfter: d.reservation.amount });
  });
  test('an allowance that only just fits the minimum entry is allowed; one that misses by a cent is refused', () => {
    const probe = evaluateEntry(baseInput(), baseRequest()) as EntryAllowed;
    const needUsd = lamportsToMicroUsd(probe.reservation.amount, PRICE, 'ceil');
    // Weekly allowance = 0.2 * 20 - L_week. A loss earlier this week leaves just enough, or a cent too little.
    const room = usd('4') - needUsd;
    const withLoss = (loss: bigint) => baseInput({
      account: account({ closedTrades: [{ ...trade(NOW - 30 * HOUR, '0'), netPnl: -loss as MicroUsd }] }),
    });
    expect(codes(evaluateEntry(withLoss(room - usd('0.01')), baseRequest()))).toEqual([]);
    expect(codes(evaluateEntry(withLoss(room + usd('0.01')), baseRequest()))).toContain('full_loss_week');
  });
});

describe('limits only tighten in code', () => {
  test('a tighter session is obeyed, a looser one cannot start', () => {
    const tight = startSession({ ...TRIAL_POLICY, positions: { ...TRIAL_POLICY.positions, maxEntriesPerDay: 1 } });
    const one = [{ mint: MINT_B, atMs: NOW - HOUR }];
    expect(codes(evaluateEntry(baseInput({ session: tight, account: account({ entries: one }) }), baseRequest()))).toContain('entries_per_day');
    expect(evaluateEntry(baseInput({ account: account({ entries: one }) }), baseRequest()).allow).toBe(true);
    expect(() => startSession({ ...TRIAL_POLICY, loss: { ...TRIAL_POLICY.loss, dailyBps: 900 } })).toThrow(PolicyError);
  });
  test('the evaluator cannot change the policy it reads', () => {
    const input = baseInput();
    const before = JSON.stringify(input.session.policy, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
    evaluateEntry(input, baseRequest());
    expect(JSON.stringify(input.session.policy, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))).toBe(before);
    expect(Object.isFrozen(input.session.policy.loss)).toBe(true);
  });
});

/** Small seeded generator (xorshift32): the sequences are the same on every run. */
const rng = (seed: number) => {
  let x = seed >>> 0 || 1;
  return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 0x1_0000_0000; };
};

/** Independent oracle for the R6 limit: min(E - 0.7 HWM, 0.2 E_week_start - L_week), straight from the account. */
const oracleLimitLamports = (input: RiskInput, weekStart: number): bigint => {
  const trades = [...input.account.closedTrades].sort((a, b) => a.closedAtMs - b.closedAtMs);
  let eq = input.account.openingEquity as bigint;
  let hwm = eq;
  let weekStartEq = eq;
  for (const t of trades) {
    if (t.closedAtMs < weekStart) weekStartEq += t.netPnl;
    eq += t.netPnl;
    if (eq > hwm) hwm = eq;
  }
  const kill = eq - mulDiv(hwm, BigInt(TRIAL_POLICY.loss.killSwitchFloorBps), 10_000n, 'ceil');
  const week = mulDiv(weekStartEq, BigInt(TRIAL_POLICY.loss.weeklyBps), 10_000n, 'floor') - (weekStartEq - eq > 0n ? weekStartEq - eq : 0n);
  const allowance = kill < week ? kill : week;
  return allowance > 0n ? microUsdToLamports(allowance as MicroUsd, PRICE, 'floor') : 0n;
};

describe('property: no sequence of inputs lets the total reserved exceed the limit', () => {
  test.each([1, 2, 3, 4, 5, 6, 7, 8])('seed %i, 300 steps', (seed) => {
    const r = rng(seed);
    const store = new MemoryReservationStore();
    const session = startSession(TRIAL_POLICY);
    let now = NOW;
    const closed: ClosedTrade[] = [];
    const held: { id: string; amount: bigint; notional: MicroUsd }[] = [];
    let n = 0;
    let reserved = 0;
    for (let step = 0; step < 300; step++) {
      const input = baseInput({
        session, mode: r() < 0.5 ? 'live' : 'paper', clock: clockAt(now),
        // Sometimes the snapshot lags the store (an entry it has not seen yet): the store's own check must still hold.
        account: account({ closedTrades: [...closed], unresolvedEntries: r() < 0.7 ? held.length : 0, heldReservations: lamports(r() < 0.7 ? store.total : 0n) }),
        market: { solPrice: { value: PRICE, atMs: now }, solBalance: { value: lamports(SOL * BigInt(1 + Math.floor(r() * 3))), atMs: now }, regime: 'on' },
      });
      const action = r();
      if (action < 0.45) {
        // Two entries decided from the same snapshot, reserved one after the other: the race the store must stop.
        const reqs = [0, 1].map(() => { n++; return baseRequest({ intentId: intentId(`p-${seed}-${n}`), reservationId: reservationId(`p-${seed}-${n}`), mint: r() < 0.5 ? MINT_A : MINT_B, quoteAtMs: now, stopBps: 500 + Math.floor(r() * 1600) }); });
        const decisions = reqs.map((q) => evaluateEntry(input, q));
        const limit = oracleLimitLamports(input, melbourneWeek(now).start);
        for (const d of decisions) {
          if (!d.allow) continue;
          expect(d.reservation.limits.maxHeld).toBeLessThanOrEqual(limit);
          const res = reserve(store, d.reservation, now);
          if (res.ok) { held.push({ id: d.reservation.reservationId, amount: d.reservation.amount, notional: d.notional }); reserved++; }
          expect(store.total).toBeLessThanOrEqual(limit);
        }
      } else if (action < 0.75 && held.length > 0) {
        // The entry resolves: the reservation ends and the trade closes with a loss up to its full reservation, or a gain.
        const h = held.shift()!;
        store.release(h.id);
        const worst = lamportsToMicroUsd(lamports(h.amount), PRICE, 'ceil');
        const pnl = BigInt(Math.floor((r() * 1.5 - 1) * Number(worst)));
        closed.push({ ...trade(now, '0'), notional: h.notional, netPnl: pnl as MicroUsd, mint: MINT_B });
      } else {
        now += Math.floor(r() * 30 * HOUR);
      }
    }
    expect(reserved).toBeGreaterThan(0);
  });
});
