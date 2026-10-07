// EXIT-FILL-FIXES: the live paper fill (red team B, N1 and N2). Each test fails at 959d801.
// N1: a paper fill lands only on a pool read as fresh as the attempt's own quote had to be (gates.maxQuoteAgeMs), dated
// on the feed's clock at the landing slot; an older read fails the attempt (fee paid), never fills at the old price.
// N2: live paper draws and executes as the backtest's world does: the shared network state (congestion), send-path
// outages, and the repeated-exit haircut. Same tape, same fills.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import type { PoolState } from '../../core/src/amm/index.ts';
import { FILL_CONFIG, TRIAL_POLICY } from '../../core/src/config/index.ts';
import type { AttemptId, IntentId, Signature } from '../../core/src/domain/index.ts';
import { createRng } from '../../core/src/engine/index.ts';
import {
  attemptFee, drawAttempt, executeBuy, executeSell, type FillScenario, NetworkState, networkEnterPpm, type ObservedFees, observedFeeContext, providerDown, windowOf,
} from '../../core/src/fills/index.ts';
import type { Book, BookEvent, IntentState } from '../../core/src/lifecycle/index.ts';
import { bps } from '../../core/src/units/index.ts';
import { capVolume, type PaperAttempt, type PaperMarket, type PaperState, PaperWorld } from '../src/run/paper-world.ts';
import { StateFile } from '../src/run/state.ts';
import { PAPER_SCENARIO } from '../src/run/settings.ts';

const CONSERVATIVE = FILL_CONFIG.scenarios[PAPER_SCENARIO];
const NET = FILL_CONFIG.network;
const MAX_AGE = TRIAL_POLICY.gates.maxQuoteAgeMs;
const COIN = { mayhemMode: false, transferFee: false, transferHook: false } as const;
const FEES: ObservedFees = { split: { lp: bps(20), protocol: bps(5), creator: bps(95) }, buybackFeeBps: bps(5000), instruction: 'v1' };
const SUPPLY = 1_000_000_000_000_000n;
const CTX = observedFeeContext(FEES, SUPPLY, COIN);
const pool = (quoteVault: bigint): PoolState => ({ baseReserve: 200_000_000_000_000n, quoteVault, virtualQuoteReserves: 0n });
const VAULT = 80_000_000_000n;
const MINT = 'Mint1111111111111111111111111111111111111111';
const POS = 'pos:1';
/** Every attempt lands and executes, never congested, never down: the N1 tests isolate the read's age. */
const LANDS: FillScenario = {
  ...CONSERVATIVE, landPpm: { pumpswap: 1_000_000n, 'pump-curve': 1_000_000n }, landingTail: { ...CONSERVATIVE.landingTail, ppm: 0n }, closeSuccessPpm: 1_000_000n, dustPpm: 0n,
  congestion: { ...CONSERVATIVE.congestion, network: { enterPpm: 0n, activityEnterPpmPerSol: 0n, maxEnterPpm: 0n, stayPpm: 0n }, providerFailPpm: 0n },
};

interface Leg { readonly id: string; readonly purpose: 'entry' | 'exit'; readonly inAmount: bigint; readonly quotedOut: bigint; readonly minOut: bigint; readonly position?: string }

/** The paper world's wall clock (sends are timed by it); tests that move it set it back. */
let WALL = 0;

/** A paper world over a hand-made book: one position, its intents, one signed attempt each. */
const world = (scenario: FillScenario, legs: readonly Leg[], market: () => PaperMarket | null, seed = 'paper-fill', dir = mkdtempSync(join(tmpdir(), 'paper-fill-'))) => {
  const intents: Record<string, IntentState> = {};
  for (const l of legs) {
    intents[l.id] = {
      intent: { id: l.id, purpose: l.purpose, venue: 'pumpswap', mint: MINT, positionId: l.position ?? POS },
      attempts: [{ signature: `sig:${l.id}`, quote: { inAmount: l.inAmount, quotedOut: l.quotedOut, minOut: l.minOut }, lastValidBlockHeight: 1_000_000n }],
    } as unknown as IntentState;
  }
  const book = { intents, positions: {} } as unknown as Book;
  const failed: PaperAttempt[] = [];
  const reports: BookEvent[] = [];
  const w = new PaperWorld({
    report: (e) => reports.push(e), book: () => book, seed, scenario, network: NET,
    ladderFees: TRIAL_POLICY.exits.ladder.steps.map((s) => s.priorityFeeLamports as bigint), exitRung: () => 0,
    market: () => market(), maxQuoteAgeMs: MAX_AGE, maxSolOut: () => 0n, simulate: null, journal: () => undefined, now: () => WALL,
    file: new StateFile<PaperState>(dir, 'paper.json', (v) => v as PaperState), changed: () => undefined,
    landedFailed: (a) => failed.push(a),
  });
  return { w, failed, reports, send: (id: string) => w.run({ type: 'broadcast', intentId: id as IntentId, attemptId: `a:${id}` as AttemptId, signedBytesRef: '', signature: `sig:${id}` as Signature }, null as never) };
};

const SLOT_MS = 400;
const H0 = 1_000n;
/** The landing slot of a LANDS attempt sent at H0 (the conservative scenario's single landing delay). */
const LAND = H0 + BigInt(CONSERVATIVE.landingSlots[0]!);
const T0 = 1_700_000_000_000;
const at = (slot: bigint): number => T0 + Number(slot - H0) * SLOT_MS;

const SELL: Leg = { id: 'ex1', purpose: 'exit', inAmount: 10_000_000_000n, quotedOut: 4_000_000n, minOut: 1n };
const BUY: Leg = { id: 'en1', purpose: 'entry', inAmount: 20_000_000n, quotedOut: 50_000_000_000n, minOut: 1n };
/** The entry, sent and filled on a fresh read before H0, so our token account holds what the sells sell. */
const E0 = H0 - 20n;
const ELAND = E0 + BigInt(CONSERVATIVE.landingSlots[0]!);
const funded = (w: PaperWorld, send: (id: string) => void): void => {
  w.onSlot(E0, at(E0));
  send('en1');
  w.onSlot(ELAND, at(ELAND));
  expect(w.attempts.get('sig:en1')!.outcome).toBe('filled');
};

describe('N1 a paper fill needs a fresh pool read at landing', () => {
  test('N1a a feed gap: the last read is older than maxQuoteAgeMs at the landing slot, so the sell fails (fee paid), never fills at the pre-gap price', () => {
    // The read the quote was made from, then nothing (the feed died); the chain fell 40% meanwhile, unseen.
    let read: PaperMarket = { pool: pool(VAULT), ctx: CTX, atMs: at(ELAND) };
    const { w, failed, send } = world(LANDS, [BUY, SELL], () => read);
    funded(w, send);
    read = { pool: pool(VAULT), ctx: CTX, atMs: at(H0) };
    w.onSlot(H0, at(H0));
    send('ex1');
    w.onSlot(LAND, at(LAND));
    const a = w.attempts.get('sig:ex1')!;
    expect(at(LAND) - at(H0)).toBeGreaterThan(MAX_AGE);
    expect(a.fill).toBeNull();
    expect(a.outcome).toBe('failed');
    expect(a.reason).toMatch(/^pool state stale/);
    // A landed failure pays base and priority (PAPER-1, M4): the most a real failed landing costs.
    expect(failed.map((x) => x.signature)).toEqual(['sig:ex1']);
  });

  test('N1a the same for an entry: no buy at a stale price', () => {
    const { w, send } = world(LANDS, [BUY], () => ({ pool: pool(VAULT), ctx: CTX, atMs: at(H0) }));
    w.onSlot(H0, at(H0));
    send('en1');
    w.onSlot(LAND, at(LAND));
    expect(w.attempts.get('sig:en1')).toMatchObject({ outcome: 'failed', fill: null });
  });

  test('N1b a read inside the quote age at landing fills on that read (here 40% lower): the edge is exactly maxQuoteAgeMs', () => {
    for (const [age, fills] of [[MAX_AGE, true], [MAX_AGE + 1, false]] as const) {
      let read: PaperMarket = { pool: pool(VAULT), ctx: CTX, atMs: at(ELAND) };
      const { w, send } = world(LANDS, [BUY, SELL], () => read);
      funded(w, send);
      read = { pool: pool((VAULT * 6n) / 10n), ctx: CTX, atMs: at(LAND) - age };
      w.onSlot(H0, at(H0));
      send('ex1');
      w.onSlot(LAND, at(LAND));
      const a = w.attempts.get('sig:ex1')!;
      expect(a.outcome).toBe(fills ? 'filled' : 'failed');
      if (fills) {
        const x = executeSell({ pool: read.pool, fees: FEES, baseSupply: SUPPLY, coin: COIN, quotedOut: SELL.quotedOut, minOut: SELL.minOut, slippagePpm: LANDS.slippagePpm }, SELL.inAmount);
        expect(x.ok && a.fill!.sol).toBe(x.ok && x.out);
      }
    }
  });
});

describe('N2 live paper fills as the backtest fills (conservative scenario)', () => {
  test('N2a same tape, same fills: an entry and three exit attempts on one position give the backtest model\'s amounts, the repeated-exit haircut included', () => {
    const legs: Leg[] = [BUY, { ...SELL, id: 'ex1' }, { ...SELL, id: 'ex2' }, { ...SELL, id: 'ex3' }];
    const state = pool(VAULT);
    let read: PaperMarket = { pool: state, ctx: CTX, atMs: at(ELAND) };
    const { w, send } = world(LANDS, legs, () => read);
    funded(w, send);
    read = { pool: state, ctx: CTX, atMs: at(LAND) };
    w.onSlot(H0, at(H0));
    for (const l of legs.slice(1)) send(l.id);
    w.onSlot(LAND, at(LAND));
    const t = (l: Leg) => ({ pool: state, fees: FEES, baseSupply: SUPPLY, coin: COIN, quotedOut: l.quotedOut, minOut: l.minOut, slippagePpm: LANDS.slippagePpm });
    // The backtest world's call (world.ts #land): executeBuy, and executeSell with exitRetry × exitRetryHaircutPpm,
    // exitRetry counting the earlier exit attempts on the position.
    const buy = executeBuy(t(BUY), BUY.inAmount);
    if (!buy.ok) throw new Error('buy');
    expect(w.attempts.get('sig:en1')!.fill).toMatchObject({ tokens: buy.out, sol: buy.paid, fees: attemptFee(NET, NET.entryPriorityFee, 'filled') });
    expect(LANDS.exitRetryHaircutPpm).toBe(50_000n);
    for (const [k, id] of ['ex1', 'ex2', 'ex3'].entries()) {
      const x = executeSell(t(SELL), SELL.inAmount, BigInt(k) * LANDS.exitRetryHaircutPpm);
      if (!x.ok) throw new Error('sell');
      const a = w.attempts.get(`sig:${id}`)!;
      expect(a.exitRetry).toBe(k);
      expect(a.fill).toMatchObject({ tokens: SELL.inAmount, sol: x.out });
      expect(a.costs!.slippage).toBe(x.costs.extraSlippage);
    }
    // The haircut bites: each later exit attempt gets strictly less on the same pool.
    const sols = ['ex1', 'ex2', 'ex3'].map((id) => w.attempts.get(`sig:${id}`)!.fill!.sol);
    expect(sols[1]! < sols[0]! && sols[2]! < sols[1]!).toBe(true);
  });

  test('N2a the haircut counts earlier exit sends on the same position only, a send lost in a restart included', () => {
    const other: Leg = { ...SELL, id: 'ox1', position: 'pos:2' };
    const dir = mkdtempSync(join(tmpdir(), 'paper-fill-'));
    const legs: Leg[] = [other, { ...SELL, id: 'ex1' }, { ...SELL, id: 'ex2' }];
    const first = world(LANDS, legs, () => null, 'paper-fill', dir);
    first.w.onSlot(H0, at(H0));
    first.send('ox1');
    first.send('ex1');
    expect(first.w.attempts.get('sig:ox1')!.exitRetry).toBe(0);
    expect(first.w.attempts.get('sig:ex1')!.exitRetry).toBe(0);
    // A restart while ex1 is in flight: it is lost, and its re-made send under the same signature is a second send.
    const second = world(LANDS, legs, () => null, 'paper-fill', dir);
    expect(second.w.attempts.get('sig:ex1')!.outcome).toBe('expired');
    second.w.onSlot(H0 + 1n, at(H0 + 1n));
    second.send('ex1');
    expect(second.w.attempts.get('sig:ex1')).toMatchObject({ outcome: 'in_flight', exitRetry: 1 });
    second.send('ex2');
    expect(second.w.attempts.get('sig:ex2')!.exitRetry).toBe(2);
  });

  test('N2a the haircut window (fills-4): a slow retry an hour after a failed ladder starts from none; inside the window it compounds', () => {
    const W = CONSERVATIVE.exitRetryHaircutWindowMs;
    const legs: Leg[] = ['ex1', 'ex2', 'ex3', 'ex4', 'ex5'].map((id) => ({ ...SELL, id }));
    const { w, send } = world(LANDS, legs, () => null);
    try {
      w.onSlot(H0, at(H0));
      WALL = 0;
      send('ex1');
      WALL = 1_000;
      send('ex2');
      expect(w.attempts.get('sig:ex2')!.exitRetry).toBe(1);
      // A slow retry 64 minutes later: the earlier episode's sends are outside the window.
      WALL = 64 * 60_000;
      send('ex3');
      expect(w.attempts.get('sig:ex3')!.exitRetry).toBe(0);
      // The boundary: ex3 exactly one window back counts; one millisecond more does not.
      WALL = 64 * 60_000 + W;
      send('ex4');
      expect(w.attempts.get('sig:ex4')!.exitRetry).toBe(1);
      WALL = 64 * 60_000 + W + 1;
      send('ex5');
      expect(w.attempts.get('sig:ex5')!.exitRetry).toBe(1);
    } finally {
      WALL = 0;
    }
  });

  test('N2b congestion: the attempt draws as the backtest\'s does in a congested window (fewer land, later)', () => {
    const always: FillScenario = { ...CONSERVATIVE, congestion: { ...CONSERVATIVE.congestion, network: { enterPpm: 1_000_000n, activityEnterPpmPerSol: 0n, maxEnterPpm: 1_000_000n, stayPpm: 1_000_000n }, providerFailPpm: 0n } };
    const seed = 'n2b';
    const { w, send } = world(always, [SELL], () => null, seed);
    w.onSlot(H0, at(H0));
    send('ex1');
    const a = w.attempts.get('sig:ex1')!;
    const d = drawAttempt(createRng(`${seed}:sig:ex1`), always, 'pumpswap', true);
    expect(a.congested).toBe(true);
    expect(a.fate).toBe(d.fate);
    expect(a.landSlot).toBe(H0 + BigInt(Math.max(1, d.landingSlots)));
    expect(d.landingSlots).toBeGreaterThanOrEqual(CONSERVATIVE.landingSlots[0]! + CONSERVATIVE.congestion.extraLandingSlots);
  });

  test('N2c a send path that is down for the window: the attempt never reaches a block, whatever its draw', () => {
    const down: FillScenario = { ...LANDS, congestion: { ...LANDS.congestion, providerFailPpm: 1_000_000n } };
    const { w, failed, send } = world(down, [SELL], () => ({ pool: pool(VAULT), ctx: CTX, atMs: at(LAND) }));
    w.onSlot(H0, at(H0));
    // (No entry needed: the attempt never reaches a block, so the account is never read.)
    send('ex1');
    w.onSlot(LAND, at(LAND));
    expect(w.attempts.get('sig:ex1')).toMatchObject({ providerDown: true, outcome: 'dropped', reason: 'never reached a block (send path down)', fill: null });
    expect(failed).toEqual([]);
  });

  test('N2d the conservative network state, window by window, is the backtest\'s at the activity cap (live cannot see the whole market\'s volume)', () => {
    const cap = capVolume(CONSERVATIVE);
    expect(networkEnterPpm(CONSERVATIVE, cap)).toBe(CONSERVATIVE.congestion.network.maxEnterPpm);
    expect(networkEnterPpm(CONSERVATIVE, cap - 1_000_000_000n) < CONSERVATIVE.congestion.network.maxEnterPpm).toBe(true);
    const seed = 'n2d';
    const n = 300;
    const legs: Leg[] = Array.from({ length: n }, (_, i) => ({ ...SELL, id: `ex${i}` }));
    const { w, send } = world(CONSERVATIVE, legs, () => null, seed);
    const ref = new NetworkState(`${seed}:net`, CONSERVATIVE, () => cap);
    const slots = BigInt(CONSERVATIVE.congestion.windowSlots);
    let congested = 0;
    for (let i = 0; i < n; i++) {
      const h = H0 + BigInt(i) * slots;
      w.onSlot(h, at(h));
      send(`ex${i}`);
      const a = w.attempts.get(`sig:ex${i}`)!;
      const win = windowOf(h, CONSERVATIVE);
      expect(a.congested).toBe(ref.congested(win));
      expect(a.providerDown).toBe(providerDown(seed, win, CONSERVATIVE));
      if (a.congested === true) congested++;
    }
    // Both states occur on this tape, so the comparison above is not vacuous.
    expect(congested).toBeGreaterThan(0);
    expect(congested).toBeLessThan(n);
  });
});

describe('RB-8 a restart proves its own never-landed attempts dead before any slot', () => {
  const statusHeight = (reports: readonly BookEvent[]): bigint | null => {
    const r = reports.at(-1);
    return r?.type === 'intent' && r.event.type === 'status' ? r.event.blockHeight : null;
  };
  const down: FillScenario = { ...LANDS, congestion: { ...LANDS.congestion, providerFailPpm: 1_000_000n } };
  const ask = (w: PaperWorld) => w.run({ type: 'check_status', intentId: 'ex1' as IntentId, signatures: ['sig:ex1' as Signature], searchHistory: true }, null as never);

  test('RB-8a a dropped attempt: past its last valid height at the start reconcile; the live height once slots arrive', () => {
    const dir = mkdtempSync(join(tmpdir(), 'paper-fill-'));
    const first = world(down, [SELL], () => null, 'paper-fill', dir);
    first.w.onSlot(H0, at(H0));
    first.send('ex1');
    first.w.onSlot(LAND, at(LAND));
    expect(first.w.attempts.get('sig:ex1')!.outcome).toBe('dropped');
    // Same process, slots seen: a dropped attempt waits out its blockhash, as a real one does.
    ask(first.w);
    expect(statusHeight(first.reports)).toBe(LAND);
    // A restart, before any slot: its own record proves it can never land.
    const second = world(down, [SELL], () => null, 'paper-fill', dir);
    ask(second.w);
    expect(statusHeight(second.reports)).toBe(1_000_001n);
    second.w.onSlot(LAND + 1n, at(LAND + 1n));
    ask(second.w);
    expect(statusHeight(second.reports)).toBe(LAND + 1n);
  });

  test('RB-8a fail-closed: an attempt that landed (filled or failed) is never reported dead from the restart rule', () => {
    const dir = mkdtempSync(join(tmpdir(), 'paper-fill-'));
    let read: PaperMarket = { pool: pool(VAULT), ctx: CTX, atMs: at(ELAND) };
    const first = world(LANDS, [BUY, SELL], () => read, 'paper-fill', dir);
    funded(first.w, first.send);
    read = { pool: pool(VAULT), ctx: CTX, atMs: at(LAND) };
    first.w.onSlot(H0, at(H0));
    first.send('ex1');
    first.w.onSlot(LAND, at(LAND));
    expect(first.w.attempts.get('sig:ex1')!.outcome).toBe('filled');
    const second = world(LANDS, [BUY, SELL], () => null, 'paper-fill', dir);
    ask(second.w);
    const r = second.reports.at(-1);
    expect(r).toMatchObject({ type: 'intent', event: { type: 'status', result: 'succeeded', blockHeight: LAND } });
    // A landed failure is dated by its landing, not proven dead past its blockhash.
    const fails: FillScenario = { ...LANDS, landPpm: { pumpswap: 0n, 'pump-curve': 0n }, dropPpm: 0n };
    const dir2 = mkdtempSync(join(tmpdir(), 'paper-fill-'));
    const third = world(fails, [SELL], () => null, 'paper-fill', dir2);
    third.w.onSlot(H0, at(H0));
    third.send('ex1');
    third.w.onSlot(LAND, at(LAND));
    expect(third.w.attempts.get('sig:ex1')!.outcome).toBe('failed');
    const fourth = world(fails, [SELL], () => null, 'paper-fill', dir2);
    ask(fourth.w);
    expect(fourth.reports.at(-1)).toMatchObject({ type: 'intent', event: { type: 'status', result: 'failed', blockHeight: LAND } });
  });
});
