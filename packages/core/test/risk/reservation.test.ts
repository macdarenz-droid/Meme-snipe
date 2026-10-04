// R6 reservation: the full possible loss plus all costs is reserved atomically before any entry. The store here is the
// in-memory stand-in for LEDGER-1; the property test runs random sequences through the real evaluator and checks the
// total reserved never exceeds the limit, computed independently from §8's formulas.
import { describe, expect, test } from 'vitest';
import { openLedger } from '../../src/ledger/index.ts';
import { entryIntent } from '../fixtures.ts';
import { tempPath } from '../ledger/helpers.ts';
import { PolicyError, TRIAL_POLICY, startSession } from '../../src/config/index.ts';
import { type Mint, intentId, reservationId } from '../../src/domain/index.ts';
import {
  type ClosedTrade, type EntryAllowed, type OpenPosition, type ReservationRequest, type ReservationStore, type RiskInput, evaluateEntry, maxTradeCosts,
  melbourneWeek, reserve,
} from '../../src/risk/index.ts';
import { type Lamports, lamports, lamportsToMicroUsd, microUsdToLamports, mulDiv } from '../../src/units/index.ts';
import {
  HOUR, MINT_A, MINT_B, MemoryReservationStore, NETWORK, NOW, PRICE, RENT, SOL, account, baseInput, baseRequest, clockAt, codes, trade, usd } from './helpers.ts';

const request = (amount: bigint, maxHeld: bigint, maxCount = 1, n = 1, accountVersion = 0n): ReservationRequest => ({
  reservationId: reservationId(`r-${n}`), intentId: intentId(`i-${n}`), amount: lamports(amount), limits: { maxHeld: lamports(maxHeld), maxCount },
  accountVersion,
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
    expect(reserve(s, request(600n, 1_000n, 2, 1, 0n), NOW).ok).toBe(true);
    expect(reserve(s, request(400n, 1_000n, 2, 2, 1n), NOW)).toEqual({ ok: true, heldAfter: 1_000n });
    expect(reserve(s, request(1n, 1_000n, 3, 3, 2n), NOW)).toEqual({ ok: false, reason: 'over_limit' });
  });
  test('the count limit, duplicates and empty amounts are refused', () => {
    const s = new MemoryReservationStore();
    expect(reserve(s, request(1n, 1_000n, 1, 1, 0n), NOW).ok).toBe(true);
    expect(reserve(s, request(1n, 1_000n, 1, 2, 1n), NOW)).toEqual({ ok: false, reason: 'too_many' });
    expect(reserve(s, request(1n, 1_000n, 5, 1, 1n), NOW)).toEqual({ ok: false, reason: 'already_reserved' });
    expect(reserve(s, request(0n, 1_000n, 5, 9, 1n), NOW)).toEqual({ ok: false, reason: 'not_an_entry' });
    expect(reserve(s, request(1n, 1_000n, 5, 10, 0n), NOW)).toEqual({ ok: false, reason: 'stale_snapshot' });
  });
  test('an allowed decision reserves q + C against the R6 allowance', () => {
    const d = evaluateEntry(baseInput(), baseRequest()) as EntryAllowed;
    expect(d.allow).toBe(true);
    // Allowance = min(E - 0.7 HWM, 0.2 E_week_start - L_week) = min($6, $4) = $4, in lamports.
    expect(d.reservation.limits.maxHeld).toBe(usd('4'));
    expect(reserve(new MemoryReservationStore(), d.reservation, NOW)).toEqual({ ok: true, heldAfter: d.reservation.amount });
  });
  test('an allowance that only just fits the minimum entry is allowed; one that misses by a cent is refused', () => {
    const probe = evaluateEntry(baseInput(), baseRequest()) as EntryAllowed;
    const needUsd = probe.reservation.amount;
    // Weekly allowance = 0.2 * 20 - L_week. A loss earlier this week leaves just enough, or a cent too little.
    const room = usd('4') - needUsd;
    const withLoss = (loss: bigint) => baseInput({
      account: account({ closedTrades: [{ ...trade(NOW - 30 * HOUR, '0'), netPnl: -loss as Lamports }] }),
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
  return allowance > 0n ? (allowance as Lamports) : 0n;
};

describe('property: no sequence of inputs lets the total reserved exceed the limit', () => {
  const ladderUsd = (lamports(maxTradeCosts(TRIAL_POLICY, { network: NETWORK, rent: RENT }).ladderWorst));
  test.each([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])('seed %i, 300 steps', (seed) => {
    const r = rng(seed);
    const store = new MemoryReservationStore();
    const session = startSession(TRIAL_POLICY);
    let now = NOW;
    const closed: ClosedTrade[] = [];
    const held: { id: string; mint: Mint; amount: bigint; notional: Lamports }[] = [];
    const open: (OpenPosition & { amount: bigint })[] = [];
    let n = 0;
    let reserved = 0;
    let staleRefused = 0;
    const snapshot = (): RiskInput => baseInput({
      session, mode: r() < 0.5 ? 'live' : 'paper', clock: clockAt(now),
      account: account({
        closedTrades: [...closed], unresolvedEntries: held.map((h) => ({ mint: h.mint })), heldReservations: lamports(store.total),
        openPositions: open.map((p) => ({ ...p, markAtMs: now })), version: store.version,
      }),
      market: { solBalance: { value: lamports(SOL * BigInt(1 + Math.floor(r() * 3))), atMs: now }, regime: 'on' },
    });
    let old = snapshot();
    for (let step = 0; step < 300; step++) {
      const fresh = snapshot();
      // A third of decisions use an older snapshot: entries the decision has not seen, positions it does not know.
      const input = r() < 0.33 ? old : fresh;
      if (r() < 0.3) old = fresh;
      const action = r();
      if (action < 0.4) {
        // Two entries decided from the same snapshot, reserved one after the other: the race the store must stop.
        const reqs = [0, 1].map(() => { n++; return baseRequest({ intentId: intentId(`p-${seed}-${n}`), reservationId: reservationId(`p-${seed}-${n}`), mint: r() < 0.5 ? MINT_A : MINT_B, quoteAtMs: input.clock.now().receivedAt, stopBps: 500 + Math.floor(r() * 1600) }); });
        for (const d of reqs.map((q) => evaluateEntry(input, q))) {
          if (!d.allow) continue;
          const res = reserve(store, d.reservation, now);
          if (!res.ok && res.reason === 'stale_snapshot') staleRefused++;
          if (!res.ok) continue;
          reserved++;
          held.push({ id: d.reservation.reservationId, mint: reqs[0]!.mint, amount: d.reservation.amount, notional: d.notional });
          // Checked against the account as it is now, not as the decision saw it.
          const limit = oracleLimitLamports(snapshot(), melbourneWeek(now).start);
          const openLamports = open.reduce((t, p) => t + ((p.notional + ladderUsd) as Lamports), 0n);
          expect(store.total + openLamports).toBeLessThanOrEqual(limit);
        }
      } else if (action < 0.6 && held.length > 0) {
        // The entry resolves: filled (the reservation ends and a position opens) or not filled (it ends).
        const h = held.shift()!;
        store.release(h.id);
        if (r() < 0.7) { open.push({ mint: h.mint, openedAtMs: now, notional: h.notional, mark: h.notional, markAtMs: now, amount: h.amount }); store.touch(); }
      } else if (action < 0.8 && open.length > 0) {
        // The position closes with a loss up to its full reservation, or a gain.
        const p = open.shift()!;
        store.touch();
        const worst = lamports(p.amount);
        closed.push({ ...trade(now, '0'), mint: p.mint, notional: p.notional, netPnl: BigInt(Math.floor((r() * 1.5 - 1) * Number(worst))) as Lamports });
      } else {
        now += Math.floor(r() * 30 * HOUR);
      }
      // R3: never more than one open or unresolved position, whatever the snapshots said.
      expect(open.length + held.length).toBeLessThanOrEqual(TRIAL_POLICY.positions.maxOpen);
    }
    expect(reserved).toBeGreaterThan(0);
    expect(staleRefused).toBeGreaterThan(0);
  });
});

describe('item 1: a decision from an old snapshot cannot reserve after the account changed', () => {
  test('A and B decided together; A reserves, fills and releases; B is refused', () => {
    const store = new MemoryReservationStore();
    const input = baseInput({ account: account({ version: store.version }) });
    const a = evaluateEntry(input, baseRequest()) as EntryAllowed;
    const b = evaluateEntry(input, baseRequest({ mint: MINT_B })) as EntryAllowed;
    expect(a.allow && b.allow).toBe(true);
    expect(reserve(store, a.reservation, NOW).ok).toBe(true);
    store.release(a.reservation.reservationId); // A filled: its reservation ends ...
    store.touch(); // ... and its position opens
    expect(store.total).toBe(0n);
    expect(reserve(store, b.reservation, NOW)).toEqual({ ok: false, reason: 'stale_snapshot' });
    // Decided again from the current account, B is refused by R3 before it reaches the store.
    const open = { mint: MINT_A, openedAtMs: NOW, notional: a.notional, mark: a.notional, markAtMs: NOW };
    const again = evaluateEntry(baseInput({ account: account({ openPositions: [open], version: store.version }) }), baseRequest({ mint: MINT_B }));
    expect(codes(again)).toContain('max_open_positions');
  });
  test('the request carries the snapshot version', () => {
    const d = evaluateEntry(baseInput({ account: account({ version: 41n }) }), baseRequest()) as EntryAllowed;
    expect(d.reservation.accountVersion).toBe(41n);
  });
});

describe('the real ledger is the reservation store (LEDGER-1c)', () => {
  test('a decision from a withSnapshot read reserves; a second decision from the same snapshot is refused', () => {
    const ledger = openLedger(tempPath(), 'paper');
    for (const n of [1, 2]) ledger.recordIntent(entryIntent(n), { status: 'risk_approved', ts: n });
    const store: ReservationStore = ledger;
    const { version } = ledger.withSnapshot((v) => v);
    const input = baseInput({ account: account({ version }) });
    const a = evaluateEntry(input, baseRequest({ intentId: entryIntent(1).id })) as EntryAllowed;
    const b = evaluateEntry(input, baseRequest({ intentId: entryIntent(2).id, mint: MINT_B })) as EntryAllowed;
    expect(reserve(store, a.reservation, NOW)).toMatchObject({ ok: true });
    expect(reserve(store, b.reservation, NOW)).toEqual({ ok: false, reason: 'stale_snapshot' });
    ledger.close();
  });
});
