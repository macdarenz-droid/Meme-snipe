// PAPER-1: paper settlement matches the historical backtest's (audit of d92b73e, items M4, M5 and M8's rent part).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { FILL_CONFIG, TRIAL_POLICY, startSession } from '../../core/src/config/index.ts';
import { openLedger } from '../../core/src/ledger/index.ts';
import { emptyBook, isTerminal } from '../../core/src/lifecycle/index.ts';
import { NO_LATCHES, melbourneDay, melbourneWeek, riskSnapshot } from '../../core/src/risk/index.ts';
import { attemptFee, lateFillOf, tradeUsd } from '../../core/src/fills/index.ts';
import { type Lamports, type MicroUsd, lamportsToMicroUsd, microUsdToLamports } from '../../core/src/units/index.ts';
import type { Book } from '../../core/src/lifecycle/index.ts';
import { positionId, type Fill, type IntentId } from '../../core/src/domain/index.ts';
import { OFF_CHAIN, type LogRecord } from '../../core/src/engine/index.ts';
import type { BookEvent, ExitReason } from '../../core/src/lifecycle/index.ts';
import { raw } from '../../core/src/units/index.ts';
import { attempt as fxAttempt, entryToSubmitted, fill as fx, on, quote, sig } from '../../core/test/fixtures.ts';
import { PaperAccount, type PaperLegs, type PaperTrade, accountFile, paperTradeLamports, tradePnl, tradeSol } from '../src/run/account.ts';
import { Desk } from '../src/run/desk.ts';
import { LATE_BUY } from '../src/run/worker.ts';
import { type ApiInputs, moneyEvents, realisedLossToday, usdText, views } from '../src/run/api.ts';
import type { PaperAttempt } from '../src/run/paper-world.ts';
import { oneTimeRent } from '../src/run/settings.ts';
import { LANDS, Market, SOL_PRICE, T, makeWorker, passingMarket, tempState, until, noLegs } from './worker-harness.ts';

const HELD = { heldPoolFacts: true } as const;
const bigints = (_k: string, v: unknown) => (v !== null && typeof v === 'object' && '$n' in v ? BigInt((v as { $n: string }).$n) : v);
const read = <T>(dir: string, f: string): T => JSON.parse(readFileSync(join(dir, f), 'utf8'), bigints) as T;
const wallet = (dir: string) => read<{ walletLamports: bigint }>(dir, 'account.json').walletLamports;
const attempts = (dir: string) => Object.values(read<{ attempts: Record<string, PaperAttempt> }>(dir, 'paper.json').attempts);

describe('M4: a landed failed attempt is never free', () => {
  it('the shared fee function charges a landed failure its base and priority fee (the audit case: 505,000)', () => {
    expect(attemptFee(FILL_CONFIG.network, 500_000n, 'failed')).toBe(505_000n);
  });

  it('an entry whose every attempt lands failed costs the wallet each fee once, also after a restart', async () => {
    const scenario = { ...LANDS, landPpm: { pumpswap: 0n, 'pump-curve': 0n }, dropPpm: 0n };
    const h = makeWorker({ scenario });
    expect(await h.worker.reconcile()).toEqual({ ok: true });
    const m = await passingMarket(h, HELD);
    await m.run(4_000, 100, () => m.pool());
    const failed = () => attempts(h.stateDir).filter((a) => a.outcome === 'failed');
    expect(await until(m, 60_000, () => failed().length >= 1 && Object.values(h.worker.book.intents).every((i) => i.status === 'abandoned' || i.status === 'rejected' || i.status === 'cancelled' || i.status === 'reconciled'), () => {
      m.slot();
      m.pool();
    })).toBe(true);
    // No position ever opened.
    expect(Object.values(h.worker.book.positions).every((p) => p.quantity === 0n)).toBe(true);
    const fees = failed().reduce((s, a) => s + attemptFee(FILL_CONFIG.network, a.priorityFee, 'failed'), 0n);
    expect(fees).toBeGreaterThan(0n);
    const opening = microUsdToLamports(h.session.policy.capital.bankroll, SOL_PRICE as MicroUsd, 'floor');
    const expected = opening - oneTimeRent(FILL_CONFIG) - fees;
    expect(wallet(h.stateDir)).toBe(expected);
    await h.worker.stop();
    // A restart replays the same signatures: nothing is charged twice.
    const h2 = makeWorker({ stateDir: h.stateDir, timers: h.timers, scenario });
    expect(await h2.worker.reconcile()).toEqual({ ok: true });
    expect(wallet(h.stateDir)).toBe(expected);
    await h2.worker.stop();
  });
});

/** Runs the passing market to an entry, then drops the price 30% so the stop sells the whole holding. */
const roundTrip = async (h: ReturnType<typeof makeWorker>) => {
  expect(await h.worker.reconcile()).toEqual({ ok: true });
  const m = await passingMarket(h, HELD);
  await m.run(4_000, 100, () => m.pool());
  await m.run(10_000, 400, () => { m.slot(); m.pool(); });
  expect(await until(m, 120_000, () => Object.values(h.worker.book.positions).some((p) => p.status === 'closed'), () => { m.slot(); m.pool(700_000n); })).toBe(true);
  return m;
};
const closedTrade = (dir: string) => read<{ trades: { positionId: string; netLamports: bigint | null; closedAtMs: number | null }[] }>(dir, 'account.json').trades.find((t) => t.closedAtMs !== null)!;
/** The trade's lamports from its own attempts in paper.json, without rent. */
const flows = (dir: string, net = FILL_CONFIG.network) => {
  let v = 0n;
  for (const a of attempts(dir)) {
    if (a.outcome === 'filled') v += a.purpose === 'entry' ? -a.fill!.sol : a.fill!.sol;
    v -= attemptFee(net, a.priorityFee, a.outcome === 'filled' || a.outcome === 'failed' ? a.outcome : 'dropped');
  }
  return v;
};

describe('a restart books what account.json missed', () => {
  it('an open trade whose entry fill the saved account never booked is booked at the restart, once', async () => {
    const h = makeWorker({ scenario: { ...LANDS, dustPpm: 0n } });
    expect(await h.worker.reconcile()).toEqual({ ok: true });
    const m = await passingMarket(h, HELD);
    await m.run(4_000, 100, () => m.pool());
    expect(await until(m, 60_000, () => Object.values(h.worker.book.positions).some((p) => p.status === 'open' && p.quantity > 0n), () => {
      m.slot();
      m.pool();
    })).toBe(true);
    const settled = wallet(h.stateDir);
    await h.worker.stop();
    // A process that stopped after the fill reconciled but before account.json took it.
    const file = join(h.stateDir, 'account.json');
    const saved = JSON.parse(readFileSync(file, 'utf8')) as { walletLamports: { $n: string }; trades: { booked: { $n: string } }[] };
    const booked = BigInt(saved.trades[0]!.booked.$n);
    expect(booked).toBeLessThan(0n);
    saved.walletLamports = { $n: String(settled - booked) };
    saved.trades[0]!.booked = { $n: '0' };
    writeFileSync(file, JSON.stringify(saved));
    const h2 = makeWorker({ stateDir: h.stateDir, timers: h.timers, scenario: { ...LANDS, dustPpm: 0n } });
    expect(await h2.worker.reconcile()).toEqual({ ok: true });
    expect(wallet(h.stateDir)).toBe(settled);
    await h2.worker.stop();
  });
});

describe('a restart books a failed entry\'s fees at its first SOL price', () => {
  it('an entry that ends unfilled during the restart reconcile (no price yet) has its fee booked by the first price', async () => {
    const scenario = { ...LANDS, landPpm: { pumpswap: 0n, 'pump-curve': 0n }, dropPpm: 0n };
    const h = makeWorker({ scenario });
    expect(await h.worker.reconcile()).toEqual({ ok: true });
    const m = await passingMarket(h, HELD);
    await m.run(4_000, 100, () => m.pool());
    // Stop as soon as an entry attempt has landed failed, while its intent is still running.
    const failed = () => attempts(h.stateDir).filter((a) => a.outcome === 'failed');
    const running = () => Object.values(h.worker.book.intents).some((i) => i.intent.purpose === 'entry' && !isTerminal(i));
    expect(await until(m, 60_000, () => failed().length >= 1 && running(), () => {
      m.slot();
      m.pool();
    })).toBe(true);
    const fees = failed().reduce((s, a) => s + attemptFee(FILL_CONFIG.network, a.priorityFee, 'failed'), 0n);
    const unbooked = wallet(h.stateDir);
    await h.worker.stop();
    const h2 = makeWorker({ stateDir: h.stateDir, timers: h.timers, scenario });
    expect(await h2.worker.reconcile()).toEqual({ ok: true });
    // The reconcile ended the entry with no SOL price in this process: nothing booked yet.
    expect(Object.values(h2.worker.book.intents).every((i) => i.intent.purpose !== 'entry' || isTerminal(i))).toBe(true);
    expect(wallet(h.stateDir)).toBe(unbooked);
    // The first price, and nothing else: the fee is booked, once.
    const m2 = new Market(h2);
    m2.solPrice();
    m2.slot();
    await m2.run(400, 100);
    expect(wallet(h.stateDir)).toBe(unbooked - fees);
    m2.solPrice();
    m2.slot();
    await m2.run(400, 100);
    expect(wallet(h.stateDir)).toBe(unbooked - fees);
    await h2.worker.stop();
  });
});

describe('M8: paper rent follows the account-close outcome (RENT-1, shared with the backtest)', () => {
  it('a landed sell-and-close returns the rent: the trade nets its flows and fees only', async () => {
    const h = makeWorker({ scenario: { ...LANDS, closeSuccessPpm: 1_000_000n, dustPpm: 0n } });
    await roundTrip(h);
    expect(closedTrade(h.stateDir).netLamports).toBe(flows(h.stateDir));
    expect(h.legs.filter((l) => l.leg === 'exit').every((l) => l.closes)).toBe(true);
    await h.worker.stop();
  });

  it('a failed close fails the sell (fee paid), the sell-only retry fills and the rent stays locked', async () => {
    const h = makeWorker({ scenario: { ...LANDS, closeSuccessPpm: 0n, dustPpm: 0n } });
    await roundTrip(h);
    const exits = attempts(h.stateDir).filter((a) => a.purpose === 'exit');
    expect(exits.some((a) => a.outcome === 'failed' && a.reason === 'close failed')).toBe(true);
    expect(exits.some((a) => a.outcome === 'filled')).toBe(true);
    expect(closedTrade(h.stateDir).netLamports).toBe(flows(h.stateDir) - FILL_CONFIG.network.tokenAccountRent);
    // The retry's transaction no longer closes the account.
    expect(h.legs.filter((l) => l.leg === 'exit').at(-1)!.closes).toBe(false);
    await h.worker.stop();
  });

  it('a landed failed sell lowers the wallet by its fee as it lands, before the book hears of it', async () => {
    const h = makeWorker({ scenario: { ...LANDS, closeSuccessPpm: 0n, dustPpm: 0n } });
    expect(await h.worker.reconcile()).toEqual({ ok: true });
    const m = await passingMarket(h, HELD);
    await m.run(4_000, 100, () => m.pool());
    await m.run(10_000, 400, () => { m.slot(); m.pool(); });
    // The paper world reports the failure to the book through the feed; read the wallet the moment that report arrives.
    let seen: { before: bigint; after: bigint; fee: bigint } | null = null;
    let before = wallet(h.stateDir);
    const feed = h.worker.feed;
    const ingest = feed.ingest.bind(feed);
    vi.spyOn(feed, 'ingest').mockImplementation((...args: Parameters<typeof feed.ingest>) => {
      const e = args[1] as { type: string; event?: { type: string; intentId?: string; event?: { result?: string; signature?: string } } };
      const sig = e.type === 'world' && e.event?.type === 'intent' && e.event.event?.result === 'failed' ? e.event.event.signature : undefined;
      const a = sig === undefined ? undefined : attempts(h.stateDir).find((x) => x.signature === sig);
      if (seen === null && a?.purpose === 'exit') seen = { before, after: wallet(h.stateDir), fee: attemptFee(FILL_CONFIG.network, a.priorityFee, 'failed') };
      return ingest(...args);
    });
    expect(await until(m, 120_000, () => seen !== null, () => {
      before = wallet(h.stateDir);
      m.slot();
      m.pool(700_000n);
    })).toBe(true);
    expect(seen!.fee).toBeGreaterThan(0n);
    expect(seen!.after).toBe(seen!.before - seen!.fee);
    await h.worker.stop();
  });

  it('dust keeps the account open: the sell does not close it and the rent stays locked', async () => {
    const h = makeWorker({ scenario: { ...LANDS, closeSuccessPpm: 1_000_000n, dustPpm: 1_000_000n } });
    await roundTrip(h);
    expect(h.legs.filter((l) => l.leg === 'exit').every((l) => !l.closes)).toBe(true);
    expect(closedTrade(h.stateDir).netLamports).toBe(flows(h.stateDir) - FILL_CONFIG.network.tokenAccountRent);
    await h.worker.stop();
  });
});

describe('M5: paper dollar results use the backtest report rule (each cash flow at its own SOL price)', () => {
  // The audit's case: buy for 0.02 SOL at SOL $100 ($2), sell for 0.024 SOL at SOL $80 ($1.92). No fees or rent here.
  const net = { ...FILL_CONFIG.network, baseFeePerSignature: 0n, tip: 0n, tokenAccountRent: 0n };
  const fill = (intentId: string, signature: string, sol: bigint) => ({ intentId, signature, slot: 1n, commitment: 'confirmed', tokens: 1_000_000n, sol, fees: 0n });
  const attempt = (intentId: string, signature: string, purpose: 'entry' | 'exit', sol: bigint): PaperAttempt => ({
    intentId, signature, purpose, trade: 'p1', mint: 'M', inAmount: purpose === 'entry' ? sol : 1_000_000n, quotedOut: 0n, minOut: 0n, priorityFee: 0n,
    lastValidBlockHeight: 10n, fate: 'lands', landSlot: 1n, outcome: 'filled', reason: 'filled', landedSlot: 1n, simulated: true,
    fill: fill(intentId, signature, sol) as PaperAttempt['fill'],
    costs: { venueFee: 0n, creatorFee: 0n, slippage: 0n, base: 0n, priority: 0n, tip: 0n }, sentAtMs: 0,
  });
  const book = (closed: boolean) => ({
    positions: { p1: { id: 'p1', mint: 'M', entryIntentId: 'in', status: closed ? 'closed' : 'open', quantity: closed ? 0n : 1_000_000n, cost: 20_000_000n } },
    intents: {
      in: { intent: { id: 'in', purpose: 'entry', positionId: 'p1', mint: 'M' }, fills: [fill('in', 'e1', 20_000_000n)], attempts: [{ signature: 'e1' }] },
      ...(closed ? { out: { intent: { id: 'out', purpose: 'exit', positionId: 'p1', mint: 'M' }, fills: [fill('out', 'x1', 24_000_000n)], attempts: [{ signature: 'x1' }] } } : {}),
    },
  }) as unknown as Book;
  const legs = (closed: boolean): PaperLegs => ({
    network: net, closedAccount: () => true,
    attempts: new Map([['e1', attempt('in', 'e1', 'entry', 20_000_000n)], ...(closed ? [['x1', attempt('out', 'x1', 'exit', 24_000_000n)] as const] : [])]),
  });

  it('the closed trade books −$0.08, not +$0.32 at the closing price; SOL +0.004; the app splits the two parts', () => {
    const account = new PaperAccount(accountFile(tempState()), 20_000_000n as MicroUsd, 0, 0n);
    const px = (d: number) => BigInt(d * 1_000_000) as MicroUsd;
    account.price(px(100), 0);
    const base = { positionId: 'p1', mint: 'M', reasons: ['notional 2000000'] };
    account.filled({ ...base, purpose: 'entry', book: book(false), atMs: 1_000 }, px(100), legs(false));
    account.filled({ ...base, purpose: 'exit', book: book(true), atMs: 2_000 }, px(80), legs(true));
    const t = account.state.trades[0]!;
    expect(t.netLamports).toBe(4_000_000n);
    expect(t.netPnl).toBe(-80_000n);

    const inputs = { book: book(true), legs: legs(true), attempts: legs(true).attempts, trades: account.state.trades, symbol: () => 'M', strategyVersion: 's', policyVersion: 'p', accountCosts: [], solPrice: px(80) } as unknown as ApiInputs;
    const [r] = views.trades(inputs) as { netUsd: string; netSol: string; tradingUsd: string; solMoveUsd: string }[];
    expect(r).toMatchObject({ netUsd: '-0.08', netSol: '0.004000000', tradingUsd: '0.32', solMoveUsd: '-0.4' });
    expect(views.stats(inputs)).toMatchObject({ netUsd: '-0.08', netSol: '0.004000000', solMoveUsd: '-0.4' });
  });

  describe('the app shows the rent the trade paid, got back and kept', () => {
    // The same trade with the real rent (1,513,840 lamports): paid at the entry's SOL price, returned at the close's.
    const rented = { ...net, tokenAccountRent: FILL_CONFIG.network.tokenAccountRent };
    const px = (d: number) => BigInt(d * 1_000_000) as MicroUsd;
    const shown = (closes: boolean, pxOut: MicroUsd) => {
      const l: PaperLegs = { ...legs(true), network: rented, closedAccount: () => closes };
      const account = new PaperAccount(accountFile(tempState()), 20_000_000n as MicroUsd, T, 0n);
      account.price(px(100), T);
      const base = { positionId: 'p1', mint: 'M', reasons: ['notional 2000000'] };
      account.filled({ ...base, purpose: 'entry', book: book(false), atMs: T + 1_000 }, px(100), { ...legs(false), network: rented, closedAccount: () => closes });
      account.filled({ ...base, purpose: 'exit', book: book(true), atMs: T + 2_000 }, pxOut, l);
      const inputs = { book: book(true), legs: l, attempts: l.attempts, trades: account.state.trades, symbol: () => 'M', strategyVersion: 's', policyVersion: 'p', accountCosts: [], solPrice: pxOut } as unknown as ApiInputs;
      const [r] = views.trades(inputs) as { costs: { rentPaidUsd: string; rentReturnedUsd: string; totalUsd: string } }[];
      const kept = (views.charts(inputs) as { costsByKind: { kind: string; amountUsd: string }[] }).costsByKind.find((k) => k.kind === 'rentKeptUsd')!.amountUsd;
      return { ...r!.costs, kept, netLamports: account.state.trades[0]!.netLamports };
    };

    it('a sell that closes the account: the rent comes back, nothing is kept', () => {
      // $0.151384 out at $100, the same lamports back at $100.
      expect(shown(true, px(100))).toMatchObject({ rentPaidUsd: '0.151384', rentReturnedUsd: '0.151384', kept: '0', netLamports: 4_000_000n });
      // Back at $80 it is worth $0.121107: the $0.030277 between is SOL's move on the rent, kept as a cost.
      expect(shown(true, px(80))).toMatchObject({ rentPaidUsd: '0.151384', rentReturnedUsd: '0.121107', kept: '0.030277', netLamports: 4_000_000n });
    });

    it('a sell that leaves the account open (failed close or dust): nothing comes back, the whole rent is kept', () => {
      expect(shown(false, px(100))).toMatchObject({ rentPaidUsd: '0.151384', rentReturnedUsd: '0', kept: '0.151384', netLamports: 4_000_000n - 1_513_840n });
      expect(shown(false, px(80))).toMatchObject({ rentPaidUsd: '0.151384', rentReturnedUsd: '0', kept: '0.151384', totalUsd: '0.151384' });
    });
  });

  it('a sell that landed but is not yet in the book moves nothing: the position still holds those tokens', () => {
    const account = new PaperAccount(accountFile(tempState()), 20_000_000n as MicroUsd, 0, 0n);
    account.price(100_000_000n as MicroUsd, 0);
    const base = { positionId: 'p1', mint: 'M', reasons: ['notional 2000000'] };
    const fees = (l: PaperLegs): PaperLegs => ({ ...l, network: FILL_CONFIG.network });
    account.filled({ ...base, purpose: 'entry', book: book(false), atMs: 1_000 }, 100_000_000n as MicroUsd, fees(legs(false)));
    const after = account.state.walletLamports;
    // The paper world landed the sell (legs(true) holds its filled attempt); the book has not reconciled it.
    const b = book(false) as unknown as { intents: Record<string, unknown> };
    const pending = { ...b, intents: { ...b.intents, out: { intent: { id: 'out', purpose: 'exit', positionId: 'p1', mint: 'M' }, fills: [], attempts: [{ signature: 'x1' }] } } } as unknown as Book;
    expect(account.settle(pending, fees(legs(true)), 100_000_000n as MicroUsd, 1_500)).toBe(false);
    expect(account.state.walletLamports).toBe(after);
  });
});

describe('M4: fees of an entry that never filled are an account cost, booked once and kept bounded', () => {
  const PRICE = 150_000_000n as MicroUsd;
  const DAY = 86_400_000;
  const net = FILL_CONFIG.network;
  const failedAttempt = (signature: string, sentAtMs: number, priorityFee: bigint): PaperAttempt => ({
    intentId: `i-${signature}`, signature, purpose: 'entry', trade: `p-${signature}`, mint: 'M', inAmount: 1n, quotedOut: 1n, minOut: 1n, priorityFee,
    lastValidBlockHeight: 10n, fate: 'fails', landSlot: 1n, outcome: 'failed', reason: 'landed failed (drawn)', landedSlot: 1n, fill: null, simulated: true, sentAtMs,
  });
  const bookOf = (as: readonly PaperAttempt[], status = 'abandoned') => ({
    positions: {},
    intents: Object.fromEntries(as.map((a) => [a.intentId, { intent: { id: a.intentId, purpose: 'entry', positionId: a.trade, mint: 'M' }, status, fills: [], attempts: [{ signature: a.signature }] }])),
  }) as unknown as Book;
  const legsOf = (as: readonly PaperAttempt[]): PaperLegs => ({ network: net, attempts: new Map(as.map((a) => [a.signature, a])), closedAccount: () => false });

  it('a failed entry\'s fee lowers the wallet once, is a failed_entry cost, and trips the daily loss trigger when it reaches it', () => {
    const dir = tempState();
    const ledger = openLedger(join(dir, 'ledger.sqlite'), 'paper');
    const bankroll = 20_000_000n as MicroUsd;
    const account = new PaperAccount(accountFile(dir), bankroll, T - DAY, 0n);
    account.price(PRICE, T - DAY);
    const opening = account.state.walletLamports!;
    // $1.50 is the trial's daily trigger (7.5% of $20): a 10,000,000-lamport priority fee at $150 is $1.50075.
    const a = [failedAttempt('s1', T - 60_000, 10_000_000n)];
    expect(account.settle(bookOf(a, 'reconciled'), legsOf(a), PRICE, T)).toBe(false);
    expect(account.settle(bookOf(a), legsOf(a), PRICE, T)).toBe(true);
    expect(account.settle(bookOf(a), legsOf(a), PRICE, T)).toBe(false);
    const fee = attemptFee(net, 10_000_000n, 'failed');
    expect(account.state.walletLamports).toBe(opening - fee);
    const fact = account.fact(ledger, emptyBook({ maxOpenPositions: 5 }), NO_LATCHES, T, noLegs);
    // Sent a minute before it was booked: dated when booked (ACCOUNT-RATE F3). SOL-BOOKS: risk counts it in lamports.
    expect(fact.history.costs).toContainEqual({ atMs: T, amount: fee, kind: 'failed_entry' });
    expect(fact.history.closedTrades).toEqual([]);
    const s = riskSnapshot({
      session: startSession(TRIAL_POLICY), mode: 'paper', clock: { now: () => ({ slot: 1n, txIndex: 0, ixIndex: 0, receivedAt: T }) }, account: fact.history, latches: NO_LATCHES,
      market: { solBalance: fact.solBalance, regime: 'unknown' },
    })!;
    expect(s.dayLoss).toBeGreaterThanOrEqual(s.dailyLimit);
    ledger.close();
  });

  it('the app\'s totals count them through costs() (APP-MONEY): setup and one failed entry, no trades', () => {
    const dir = tempState();
    const ledger = openLedger(join(dir, 'ledger.sqlite'), 'paper');
    const account = new PaperAccount(accountFile(dir), 20_000_000n as MicroUsd, T - DAY, 2_000_000n);
    account.price(PRICE, T - 3_600_000);
    const a = [failedAttempt('s1', T - 60_000, 50_000n)];
    account.settle(bookOf(a, 'reconciled'), legsOf(a), PRICE, T);
    account.settle(bookOf(a), legsOf(a), PRICE, T);
    const fee = attemptFee(net, 50_000n, 'failed');
    const setup = account.state.setup!;
    const strayUsd = lamportsToMicroUsd(fee as Lamports, PRICE, 'ceil');
    // One list: what risk reads is what the app totals, each with its lamports. The fee is dated when booked (T), a
    // minute after its send (ACCOUNT-RATE F3). Risk reads lamports (SOL-BOOKS); the app's records carry dollars as well.
    const empty = emptyBook({ maxOpenPositions: 5 });
    expect(account.costs(empty, noLegs, T)).toEqual([{ atMs: setup.atMs, amount: setup.lamports, kind: 'wallet_setup' }, { atMs: T, amount: fee, kind: 'failed_entry' }]);
    expect(account.costRecords(empty, noLegs, PRICE, T).map((c) => c.usd)).toEqual([setup.cost, strayUsd]);
    expect(account.fact(ledger, empty, NO_LATCHES, T, noLegs).history.costs).toEqual(account.costs(empty, noLegs, T));
    expect(account.costRecords(empty, noLegs, PRICE, T).map((c) => c.lamports)).toEqual([2_000_000n, fee]);
    const h = makeWorker();
    const base = h.worker.apiInputs();
    void h.worker.stop();
    const i = { ...base, nowMs: T, trades: [], accountCosts: account.costRecords(empty, noLegs, PRICE, T) } as ApiInputs;
    const stats = views.stats(i) as { trades: number; netUsd: string; netSol: string };
    const total = setup.cost + strayUsd;
    expect(stats).toMatchObject({ trades: 0, netUsd: `-${total / 1_000_000n}.${String(total % 1_000_000n).padStart(6, '0').replace(/0+$/, '')}` });
    // In SOL, the setup's and the failed entry's lamports.
    expect(stats.netSol.startsWith('-')).toBe(true);
    const lam = 2_000_000n + fee;
    expect(stats.netSol).toBe(`-${lam / 1_000_000_000n}.${String(lam % 1_000_000_000n).padStart(9, '0')}`);
    const kinds = (views.charts(i) as { costsByKind: { kind: string; amountUsd: string }[] }).costsByKind.map((c) => c.kind).sort();
    expect(kinds).toEqual(['networkFeeUsd', 'rentKeptUsd']);
    ledger.close();
  });

  it('records from before the Melbourne week fold into one total; a signature seen again after the fold is not charged', () => {
    const dir = tempState();
    const ledger = openLedger(join(dir, 'ledger.sqlite'), 'paper');
    const file = accountFile(dir);
    const start = melbourneWeek(T).start;
    const account = new PaperAccount(file, 20_000_000n as MicroUsd, start - 20 * DAY, 0n);
    account.price(PRICE, start - 20 * DAY);
    const opening = account.state.walletLamports!;
    const old = [failedAttempt('a', start - 9 * DAY, 20_000n), failedAttempt('b', start - DAY, 30_000n)];
    const recent = [failedAttempt('c', start + 1_000, 40_000n)];
    const usdOf = (x: PaperAttempt) => lamportsToMicroUsd(attemptFee(net, x.priorityFee, 'failed') as Lamports, PRICE, 'ceil');
    // Each booked a second after it was sent (a record is dated when booked, ACCOUNT-RATE F3). In the last days of a
    // week: a (from the week before) folds at once, b stays a record.
    account.settle(bookOf([old[0]!]), legsOf([old[0]!]), PRICE, start - 9 * DAY + 1_000);
    account.settle(bookOf(old), legsOf(old), PRICE, start - DAY + 1_000);
    expect(Object.keys(account.state.strayFees!)).toEqual(['b']);
    expect(account.state.strayFolded).toEqual({ atMs: start - 9 * DAY + 1_000, lamports: attemptFee(net, 20_000n, 'failed'), cost: usdOf(old[0]!) });
    // In the new week: b folds into the total, c stays a record.
    const all = [...old, ...recent];
    account.settle(bookOf(all), legsOf(all), PRICE, start + 1_000);
    expect(Object.keys(account.state.strayFees!)).toEqual(['c']);
    const fees = (xs: readonly PaperAttempt[]) => xs.reduce((s, x) => s + attemptFee(net, x.priorityFee, 'failed'), 0n);
    expect(account.state.strayFolded).toEqual({ atMs: start - DAY + 1_000, lamports: fees(old), cost: usdOf(old[0]!) + usdOf(old[1]!) });
    expect(account.state.walletLamports).toBe(opening - fees(all));
    // A replay (the same signatures again, also after a reload) charges nothing more.
    const reloaded = new PaperAccount(file, 20_000_000n as MicroUsd, start + 3_000, 0n);
    expect(reloaded.settle(bookOf(all), legsOf(all), PRICE, start + 3_000)).toBe(false);
    expect(reloaded.state.walletLamports).toBe(opening - fees(all));
    // Equity keeps every fee: the folded total (before this week) and the record are both costs.
    const costs = reloaded.fact(ledger, emptyBook({ maxOpenPositions: 5 }), NO_LATCHES, start + 3_000, noLegs).history.costs.filter((c) => c.kind === 'failed_entry');
    expect(costs).toEqual([
      // SOL-BOOKS: in lamports.
      { atMs: start - DAY + 1_000, amount: fees(old), kind: 'failed_entry' },
      { atMs: start + 1_000, amount: fees(recent), kind: 'failed_entry' },
    ]);
    ledger.close();
  });

  it('a fee not yet booked (no SOL price) is never folded past: it is charged once when the price comes (risk review of #133)', () => {
    const dir = tempState();
    const file = accountFile(dir);
    const start = melbourneWeek(T).start;
    const account = new PaperAccount(file, 20_000_000n as MicroUsd, start - 20 * DAY, 0n);
    account.price(PRICE, start - 20 * DAY);
    const opening = account.state.walletLamports!;
    const a = failedAttempt('a', start - 9 * DAY, 20_000n);
    const b = failedAttempt('b', start - 2 * DAY, 30_000n);
    // b is booked in its week; a's entry has not ended yet then.
    const pendingA = { positions: {}, intents: { ...bookOf([b]).intents, ...bookOf([a], 'broadcast').intents } } as unknown as Book;
    account.settle(pendingA, legsOf([a, b]), PRICE, start - DAY);
    expect(Object.keys(account.state.strayFees!)).toEqual(['b']);
    // A new process in the next week, no SOL price yet: a's entry has ended, but its fee cannot be priced. The fold must
    // not pass it.
    const restarted = new PaperAccount(file, 20_000_000n as MicroUsd, start + 1_000, 0n);
    restarted.settle(bookOf([a, b]), legsOf([a, b]), null, start + 1_000);
    expect(restarted.state.strayFolded === undefined || restarted.state.strayFolded.atMs < a.sentAtMs!).toBe(true);
    // The first price: a is charged, once.
    restarted.settle(bookOf([a, b]), legsOf([a, b]), PRICE, start + 2_000);
    restarted.settle(bookOf([a, b]), legsOf([a, b]), PRICE, start + 3_000);
    const fees = attemptFee(net, 20_000n, 'failed') + attemptFee(net, 30_000n, 'failed');
    expect(restarted.state.walletLamports).toBe(opening - fees);
  });

  it('an ended entry whose attempt cost nothing (dropped) does not hold the fold back', () => {
    const dir = tempState();
    const start = melbourneWeek(T).start;
    const account = new PaperAccount(accountFile(dir), 20_000_000n as MicroUsd, start - 20 * DAY, 0n);
    account.price(PRICE, start - 20 * DAY);
    const paid = failedAttempt('a', start - 3 * DAY, 20_000n);
    const dropped: PaperAttempt = { ...failedAttempt('z', start - 5 * DAY, 20_000n), outcome: 'dropped', reason: 'never reached a block (drawn)', landedSlot: null };
    // a's fee is booked a second after its send (a record is dated when booked, ACCOUNT-RATE F3); in the new week it
    // folds, and the dropped attempt (sent earlier, cost nothing) does not hold the fold back.
    account.settle(bookOf([paid, dropped]), legsOf([paid, dropped]), null, start - 3 * DAY + 500);
    account.settle(bookOf([paid, dropped]), legsOf([paid, dropped]), PRICE, start - 3 * DAY + 1_000);
    account.settle(bookOf([paid, dropped]), legsOf([paid, dropped]), PRICE, start + 1_000);
    expect(account.state.strayFees).toEqual({});
    expect(account.state.strayFolded?.lamports).toBe(attemptFee(net, 20_000n, 'failed'));
  });

  it('a stray fee\'s dollar cost rounds up (a loss is never understated)', () => {
    const dir = tempState();
    const account = new PaperAccount(accountFile(dir), 20_000_000n as MicroUsd, T - DAY, 0n);
    account.price(PRICE, T - DAY);
    // 5,000 base + 20,001 priority = 25,001 lamports = $0.00375015 at $150: 3,751 micro-dollars, not 3,750.
    const x = failedAttempt('odd', T - 60_000, 20_001n);
    account.settle(bookOf([x]), legsOf([x]), PRICE, T);
    expect(attemptFee(net, 20_001n, 'failed')).toBe(25_001n);
    expect(account.state.strayFees!['odd']!.cost).toBe(3_751n);
  });

  it('an entry still unresolved holds the fold back to before its first attempt', () => {
    const dir = tempState();
    const start = melbourneWeek(T).start;
    const account = new PaperAccount(accountFile(dir), 20_000_000n as MicroUsd, start - 20 * DAY, 0n);
    account.price(PRICE, start - 20 * DAY);
    const done = [failedAttempt('a', start - 3 * DAY, 20_000n)];
    const pending = failedAttempt('z', start - 5 * DAY, 20_000n);
    const book = { positions: {}, intents: { ...bookOf(done).intents, ...bookOf([pending], 'broadcast').intents } } as unknown as Book;
    account.settle(book, legsOf([...done, pending]), PRICE, start + 1_000);
    expect(Object.keys(account.state.strayFees!)).toEqual(['a']);
    expect(account.state.strayFolded).toBeUndefined();
  });
});

describe('a late-landing sell reaches the paper account (risk review of #133)', () => {
  const E1 = 'e1' as IntentId;
  const X1 = 'x1' as IntentId;
  const X2 = 'x2' as IntentId;
  const P1 = positionId('p1');
  const status = (id: IntentId, n: number, result: 'succeeded' | 'not_found', h: bigint) =>
    on(id, { type: 'status', signature: sig(n), result, commitment: result === 'succeeded' ? 'finalized' : null, blockHeight: h, searchedHistory: true });
  /** Bought 1,000 tokens for 16,000,000 lamports. */
  const ENTRY: BookEvent[] = [
    ...entryToSubmitted(1, 1_000n),
    status(E1, 1, 'succeeded', 900n),
    on(E1, { type: 'reconcile', fills: [fx(E1, 1, 1_000n)], blockHeight: 900n }),
  ];
  /** Exit `x` for the whole holding is triggered by `reasons`, sent as attempt `n`, and ends unseen (abandoned). */
  const exitEndsUnseen = (x: IntentId, n: number, reasons: ExitReason[]): BookEvent[] => [
    { type: 'trigger_exit', positionId: P1, reasons, intentId: x, quantity: raw(1_000n) },
    on(x, { type: 'prepare', quote }),
    on(x, { type: 'sign', attempt: fxAttempt(x, n, 2_500n) }),
    on(x, { type: 'submit' }),
    status(x, n, 'not_found', 2_501n),
    on(x, { type: 'reconcile', fills: [], blockHeight: 2_501n }),
    on(x, { type: 'abandon' }),
  ];
  /** Attempt 11 of X1 found landed after all: 30,000,000 lamports for the 1,000 tokens. */
  const LATE_SELL: BookEvent[] = [status(X1, 11, 'succeeded', 2_600n), { type: 'orphan_fill', fill: fx(X1, 11, 1_000n, 30_000_000n) }];
  // Fees and rent off: the trade nets 30,000,000 − 16,000,000 lamports, $1.40 at SOL $100 both ways.
  const legs: PaperLegs = { network: { ...FILL_CONFIG.network, baseFeePerSignature: 0n, tip: 0n, tokenAccountRent: 0n }, attempts: new Map(), closedAccount: () => false };
  const PX = 100_000_000n as MicroUsd;

  /** A desk on a fresh ledger whose fills go to a real paper account. */
  const deskWithAccount = () => {
    // A backtest ledger takes the reservation as an event; the paper one only through the risk snapshot (not under test).
    const ledger = openLedger(join(tempState(), 'ledger.sqlite'), 'backtest');
    const account = new PaperAccount(accountFile(tempState()), 20_000_000n as MicroUsd, T, 0n);
    account.price(PX, T);
    const filled: { purpose: string; positionId: string; closes: boolean }[] = [];
    const late: string[] = [];
    const desk = new Desk({
      ledger, config: { maxOpenPositions: 5 }, restored: emptyBook({ maxOpenPositions: 5 }),
      journal: () => undefined, report: () => 'world#unused', accountChanged: () => undefined, intentsChanged: () => undefined,
      reserved: () => undefined, diverged: () => undefined, lateBuy: (r) => void late.push(r.positionId),
      filled: (r) => {
        filled.push({ purpose: r.purpose, positionId: r.positionId, closes: r.closes === true });
        account.filled(r, PX, legs);
      },
    });
    let seq = 0;
    const feed = (events: readonly BookEvent[]) => {
      const at = { slot: 1n, txIndex: OFF_CHAIN, ixIndex: 0, receivedAt: T + seq };
      // A proposal is the engine's decision (its reasons are kept for the entry line); the rest are world events.
      desk.consume(events.map((event) => (event.type === 'propose_entry'
        ? { type: 'decision', seq: seq++, at, eventId: `d${seq}`, inputs: [], action: event, reasons: ['enter', 'notional 2000000'], result: 'applied', effects: [] }
        : { type: 'world', seq: seq++, at, eventId: `w${seq}`, event, result: 'applied', effects: [] }) as unknown as LogRecord));
      expect(desk.illegal + desk.ledgerRefusals).toBe(0);
    };
    return { desk, account, filled, late, feed, close: () => ledger.close() };
  };
  const trade = (account: PaperAccount) => {
    const [t, ...rest] = account.state.trades;
    expect(rest).toEqual([]);
    return { closed: t!.closedAtMs !== null, netLamports: t!.netLamports, netPnl: t!.netPnl, stoppedOut: t!.stoppedOut, exitReasons: t!.exitReasons };
  };
  const CLOSED_STOP = { closed: true, netLamports: 14_000_000n, netPnl: 1_400_000n, stoppedOut: true, exitReasons: ['stop'] };

  it('a stop that sells in time closes the trade as a stop (the reference)', () => {
    const d = deskWithAccount();
    d.feed([...ENTRY, { type: 'trigger_exit', positionId: P1, reasons: ['stop'], intentId: X1, quantity: raw(1_000n) }, on(X1, { type: 'prepare', quote }),
      on(X1, { type: 'sign', attempt: fxAttempt(X1, 11, 2_500n) }), on(X1, { type: 'submit' }), status(X1, 11, 'succeeded', 2_400n),
      on(X1, { type: 'reconcile', fills: [fx(X1, 11, 1_000n, 30_000_000n)], blockHeight: 2_400n })]);
    expect(trade(d.account)).toEqual(CLOSED_STOP);
    d.close();
  });

  it('a stop whose sell is booked by orphan_fill after the exit ended closes the trade, still as a stop (B1)', () => {
    const d = deskWithAccount();
    d.feed([...ENTRY, ...exitEndsUnseen(X1, 11, ['stop']), ...LATE_SELL]);
    expect(d.desk.book.positions[P1]?.status).toBe('closed');
    expect(d.filled).toEqual([{ purpose: 'entry', positionId: 'p1', closes: false }, { purpose: 'exit', positionId: 'p1', closes: true }]);
    expect(trade(d.account)).toEqual(CLOSED_STOP);
    expect(d.late).toEqual([]);
    d.close();
  });

  it('a late sell while a second exit owns the position closes the trade once; that exit ending changes nothing (B2)', () => {
    const d = deskWithAccount();
    d.feed([...ENTRY, ...exitEndsUnseen(X1, 11, ['stop']), { type: 'trigger_exit', positionId: P1, reasons: ['max_hold'], intentId: X2, quantity: raw(1_000n) }, ...LATE_SELL]);
    // The second exit still owns the position, now holding nothing.
    expect(d.desk.book.positions[P1]).toMatchObject({ status: 'exit_requested', quantity: 0n });
    expect(trade(d.account)).toEqual(CLOSED_STOP);
    const closedAt = d.account.state.trades[0]!.closedAtMs;
    d.feed([on(X2, { type: 'prepare', quote }), on(X2, { type: 'sign', attempt: fxAttempt(X2, 12, 3_500n) }), on(X2, { type: 'submit' }),
      status(X2, 12, 'not_found', 3_501n), on(X2, { type: 'reconcile', fills: [], blockHeight: 3_501n }), on(X2, { type: 'abandon' })]);
    expect(trade(d.account)).toEqual(CLOSED_STOP);
    expect(d.account.state.trades[0]!.closedAtMs).toBe(closedAt);
    expect(d.filled.filter((f) => f.purpose === 'exit')).toHaveLength(1);
    d.close();
  });

  it('a restart between the exit ending and its late sell: the sell still counts as a stop (reasons from the ledger)', () => {
    const dir = tempState();
    const ledgerFile = join(dir, 'ledger.sqlite');
    const config = { maxOpenPositions: 5 };
    const account = new PaperAccount(accountFile(tempState()), 20_000_000n as MicroUsd, T, 0n);
    account.price(PX, T);
    const deps = (ledger: ReturnType<typeof openLedger>, restored: Book) => ({
      ledger, config, restored,
      journal: () => undefined, report: () => 'world#unused', accountChanged: () => undefined, intentsChanged: () => undefined,
      reserved: () => undefined, diverged: () => undefined, lateBuy: () => undefined,
      filled: (r: Parameters<ConstructorParameters<typeof Desk>[0]['filled']>[0]) => account.filled(r, PX, legs),
    });
    let seq = 0;
    const feed = (desk: Desk, events: readonly BookEvent[]) => {
      const at = { slot: 1n, txIndex: OFF_CHAIN, ixIndex: 0, receivedAt: T + seq };
      desk.consume(events.map((event) => ({ type: 'world', seq: seq++, at, eventId: `w${seq}`, event, result: 'applied', effects: [] }) as unknown as LogRecord));
      expect(desk.illegal + desk.ledgerRefusals).toBe(0);
    };
    const l1 = openLedger(ledgerFile, 'backtest');
    feed(new Desk(deps(l1, emptyBook(config))), [...ENTRY, ...exitEndsUnseen(X1, 11, ['stop'])]);
    l1.close();
    // A new process: the desk starts from the ledger's book and rebuilds the kept reasons from its events.
    const l2 = openLedger(ledgerFile, 'backtest');
    const stored = l2.storedBookEvents(config);
    const desk = new Desk(deps(l2, stored.book));
    desk.rebuild(stored.events, config);
    feed(desk, LATE_SELL);
    expect(trade(account)).toEqual(CLOSED_STOP);
    l2.close();
  });

  it('kept reasons stay bounded: over many trades, an ended entry\'s and an emptied position\'s exits are dropped', () => {
    const d = deskWithAccount();
    for (let n = 1; n <= 20; n++) {
      const e = `e${n}` as IntentId;
      const pid = positionId(`p${n}`);
      const xa = `xa${n}` as IntentId;
      const xb = `xb${n}` as IntentId;
      d.feed([
        // An entry that never fills and is abandoned.
        ...entryToSubmitted(100 + n, 1_000n),
        status(`e${100 + n}` as IntentId, 100 + n, 'not_found', 1_001n), on(`e${100 + n}` as IntentId, { type: 'reconcile', fills: [], blockHeight: 1_001n }), on(`e${100 + n}` as IntentId, { type: 'abandon' }),
        // A trade: bought, one exit ends unseen, the next sells everything.
        ...entryToSubmitted(n, 1_000n), status(e, n, 'succeeded', 900n), on(e, { type: 'reconcile', fills: [fx(e, n, 1_000n)], blockHeight: 900n }),
        { type: 'trigger_exit', positionId: pid, reasons: ['stop'], intentId: xa, quantity: raw(1_000n) },
        on(xa, { type: 'prepare', quote }), on(xa, { type: 'sign', attempt: fxAttempt(xa, 1000 + n, 2_500n) }), on(xa, { type: 'submit' }),
        status(xa, 1000 + n, 'not_found', 2_501n), on(xa, { type: 'reconcile', fills: [], blockHeight: 2_501n }), on(xa, { type: 'abandon' }),
        { type: 'trigger_exit', positionId: pid, reasons: ['stop'], intentId: xb, quantity: raw(1_000n) },
        on(xb, { type: 'prepare', quote }), on(xb, { type: 'sign', attempt: fxAttempt(xb, 2000 + n, 2_500n) }), on(xb, { type: 'submit' }),
        status(xb, 2000 + n, 'succeeded', 2_400n), on(xb, { type: 'reconcile', fills: [fx(xb, 2000 + n, 1_000n, 30_000_000n)], blockHeight: 2_400n }),
      ]);
      expect(d.desk.book.positions[pid]?.status).toBe('closed');
      // While a position holds tokens its ended exit is kept (a late sale may still be booked); none is left here.
      expect(d.desk.keptReasons).toBe(0);
    }
    d.close();
  });

  it('a stop that fills in part, then another of its own attempts lands late with the rest: the trade is still a stop', () => {
    const d = deskWithAccount();
    d.feed([
      ...ENTRY,
      { type: 'trigger_exit', positionId: P1, reasons: ['stop'], intentId: X1, quantity: raw(1_000n) },
      on(X1, { type: 'prepare', quote }), on(X1, { type: 'sign', attempt: fxAttempt(X1, 11, 2_500n) }), on(X1, { type: 'submit' }),
      // Attempt 11 is not found in time; its replacement, attempt 12, sells 600 of the 1,000 and the exit ends.
      status(X1, 11, 'not_found', 2_501n), on(X1, { type: 'reconcile', fills: [], blockHeight: 2_501n }),
      on(X1, { type: 'sign_replacement', attempt: fxAttempt(X1, 12, 2_700n), blockHeight: 2_501n }), on(X1, { type: 'submit' }),
      status(X1, 12, 'succeeded', 2_600n), on(X1, { type: 'reconcile', fills: [fx(X1, 12, 600n, 18_000_000n)], blockHeight: 2_600n }),
    ]);
    expect(d.desk.book.positions[P1]).toMatchObject({ status: 'open', quantity: 400n });
    // Attempt 11 landed after all, with the other 400: the trade closes, still as the stop it was sold for.
    d.feed([status(X1, 11, 'succeeded', 2_800n), { type: 'orphan_fill', fill: fx(X1, 11, 400n, 12_000_000n) }]);
    expect(d.desk.book.positions[P1]?.status).toBe('closed');
    expect(trade(d.account)).toMatchObject({ closed: true, stoppedOut: true, exitReasons: ['stop'] });
    d.close();
  });

  it('a late sell that leaves tokens keeps the trade open', () => {
    const d = deskWithAccount();
    d.feed([...ENTRY, ...exitEndsUnseen(X1, 11, ['stop']), status(X1, 11, 'succeeded', 2_600n), { type: 'orphan_fill', fill: fx(X1, 11, 400n, 12_000_000n) }]);
    expect(d.desk.book.positions[P1]).toMatchObject({ status: 'open', quantity: 600n });
    expect(d.filled.at(-1)).toEqual({ purpose: 'exit', positionId: 'p1', closes: false });
    expect(trade(d.account)).toMatchObject({ closed: false });
    d.close();
  });

  it('a late buy is no trade fill: the desk hands it to lateBuy and the worker halts entries with an alert', async () => {
    // Every attempt lands failed, so the entry ends unfilled; then its buy is found landed after all.
    const scenario = { ...LANDS, landPpm: { pumpswap: 0n, 'pump-curve': 0n }, dropPpm: 0n };
    const h = makeWorker({ scenario });
    expect(await h.worker.reconcile()).toEqual({ ok: true });
    const m = await passingMarket(h, HELD);
    await m.run(4_000, 100, () => m.pool());
    const ended = () => Object.values(h.worker.book.intents).find((i) => i.intent.purpose === 'entry' && isTerminal(i) && i.fills.length === 0);
    expect(await until(m, 60_000, () => ended() !== undefined, () => {
      m.slot();
      m.pool();
    })).toBe(true);
    const i = ended()!;
    const trades = () => read<{ trades: unknown[] }>(h.stateDir, 'account.json').trades.length;
    const before = trades();
    const fill = { intentId: i.intent.id, signature: i.attempts[0]!.signature, slot: 1n, commitment: 'confirmed', tokens: 1_000_000n, sol: 20_000_000n, fees: 0n } as Fill;
    h.worker.feed.ingest('worker', { type: 'world', event: { type: 'orphan_fill', fill } }, { receivedAt: m.now });
    m.slot();
    await m.run(800, 100, () => { m.slot(); m.pool(); });
    const pid = `${i.intent.positionId}.o1`;
    // The late position exists, and exits still run for it under the halt.
    expect(h.worker.book.positions[pid]).toBeDefined();
    const journal = readFileSync(join(h.stateDir, 'journal.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(journal.filter((l) => l['kind'] === 'alert' && l['code'] === 'late_buy').map((l) => l['trade'])).toEqual([pid]);
    expect(h.worker.health().halt_reasons).toContain(LATE_BUY);
    // No paper trade for the late position, and no entry line for it.
    expect(trades()).toBe(before);
    expect(journal.some((l) => l['kind'] === 'entry' && l['trade'] === i.intent.positionId)).toBe(false);
    await h.worker.stop();
    // A restart keeps entries off while the book holds the late position.
    const h2 = makeWorker({ stateDir: h.stateDir, timers: h.timers, scenario });
    expect(await h2.worker.reconcile()).toEqual({ ok: true });
    const m2 = new Market(h2);
    m2.slot();
    await m2.run(400, 100);
    expect(h2.worker.health().halt_reasons).toContain(LATE_BUY);
    // The restart's catch-up (WORKER-ORDER, at the first price) opens no trade for the late position either.
    expect(await until(m2, 10_000, () => h2.worker.apiInputs().solPrice !== null, () => {
      m2.solPrice();
      m2.slot();
    })).toBe(true);
    expect(trades()).toBe(before);
    await h2.worker.stop();
  });
});

describe('PAPER-2: a sell never goes beyond what is held', () => {
  /**
   * An open position; exit X1 sells `share` of it and is sent, then the book believes it dead (not found past its height)
   * and gives it up, and X2 is triggered for the whole position. The paper world lands X1 after all.
   */
  const lateSale = async (sharePct: bigint) => {
    const h = makeWorker({ scenario: { ...LANDS, closeSuccessPpm: 1_000_000n, dustPpm: 0n } });
    expect(await h.worker.reconcile()).toEqual({ ok: true });
    const m = await passingMarket(h, HELD);
    const open = () => Object.values(h.worker.book.positions).find((p) => p.status === 'open' && p.quantity > 0n);
    expect(await until(m, 60_000, () => open() !== undefined, () => { m.slot(); m.pool(); })).toBe(true);
    const p = open()!;
    const q = p.quantity;
    const sold = (q * sharePct) / 100n;
    const height = BigInt(h.worker.health().last_processed_slot!);
    const X1 = 'x-late-1' as IntentId;
    const X2 = 'x-late-2' as IntentId;
    const sellQuote = { ...quote, inAmount: sold, quotedOut: 1n, minOut: 1n, quotedAtSlot: height };
    const a1 = { ...fxAttempt(X1, 91, height + 150n), quote: sellQuote };
    const world = (events: BookEvent[]) => {
      for (const event of events) h.worker.feed.ingest('worker', { type: 'world', event }, { receivedAt: m.now });
    };
    world([
      { type: 'trigger_exit', positionId: p.id, reasons: ['stop'], intentId: X1, quantity: raw(sold) },
      on(X1, { type: 'prepare', quote: sellQuote }), on(X1, { type: 'sign', attempt: a1 }), on(X1, { type: 'submit' }),
    ]);
    m.slot();
    await m.run(100, 100);
    world([
      on(X1, { type: 'status', signature: a1.signature, result: 'not_found', commitment: null, blockHeight: height + 151n, searchedHistory: true }),
      on(X1, { type: 'reconcile', fills: [], blockHeight: height + 151n }),
      on(X1, { type: 'abandon' }),
      { type: 'trigger_exit', positionId: p.id, reasons: ['max_hold'], intentId: X2, quantity: raw(q) },
    ]);
    const done = () => { const x = h.worker.book.intents[X2]; return x !== undefined && isTerminal(x); };
    expect(await until(m, 60_000, done, () => { m.slot(); m.pool(); })).toBe(true);
    await m.run(4_000, 400, () => { m.slot(); m.pool(); });
    const exits = attempts(h.stateDir).filter((a) => a.trade === p.id && a.purpose === 'exit');
    const journal = readFileSync(join(h.stateDir, 'journal.jsonl'), 'utf8');
    return { h, p, q, sold, X1, X2, exits, journal };
  };

  it('X1 sold everything: X2\'s send is refused on landing (fee paid), then X2 is cancelled; the wallet holds the one sale', async () => {
    const r = await lateSale(100n);
    expect(r.h.worker.book.positions[r.p.id]?.quantity).toBe(0n);
    expect(r.h.worker.book.intents[r.X2]!.status).toBe('cancelled');
    expect(r.exits.filter((a) => a.outcome === 'filled').map((a) => a.intentId)).toEqual([r.X1]);
    expect(r.exits.filter((a) => a.intentId === r.X2).every((a) => a.outcome === 'failed' && a.reason === 'sell beyond balance')).toBe(true);
    expect(r.journal.includes('"oversold"')).toBe(false);
    // One sale's proceeds, every fee (X2's refused attempt included), the rent back.
    expect(closedTrade(r.h.stateDir).netLamports).toBe(flows(r.h.stateDir));
    await r.h.worker.stop();
  });

  it('X1 sold 40%: X2 sells only the 60% left, never the whole position', async () => {
    const r = await lateSale(40n);
    expect(r.h.worker.book.positions[r.p.id]).toMatchObject({ status: 'closed', quantity: 0n });
    const filled = r.exits.filter((a) => a.outcome === 'filled');
    expect(filled.map((a) => [a.intentId, a.fill!.tokens])).toEqual([[r.X1, r.sold], [r.X2, r.q - r.sold]]);
    expect(r.journal.includes('"oversold"')).toBe(false);
    expect(closedTrade(r.h.stateDir).netLamports).toBe(flows(r.h.stateDir));
    await r.h.worker.stop();
  });
});

describe('PAPER-2: late landings across a restart', () => {
  it('a paper sell in flight at a restart never lands (reachability); a late sale booked after the restart still counts as a stop', async () => {
    const scenario = { ...LANDS, closeSuccessPpm: 1_000_000n, dustPpm: 0n };
    const h = makeWorker({ scenario });
    expect(await h.worker.reconcile()).toEqual({ ok: true });
    const m = await passingMarket(h, HELD);
    const open = () => Object.values(h.worker.book.positions).find((p) => p.status === 'open' && p.quantity > 0n);
    expect(await until(m, 60_000, () => open() !== undefined, () => { m.slot(); m.pool(); })).toBe(true);
    const p = open()!;
    const q = p.quantity;
    const height = BigInt(h.worker.health().last_processed_slot!);
    const X1 = 'x-late-1' as IntentId;
    const sellQuote = { ...quote, inAmount: q, quotedOut: 1n, minOut: 1n, quotedAtSlot: height };
    const a1 = { ...fxAttempt(X1, 91, height + 150n), quote: sellQuote };
    const world = (hh: typeof h, at: number, events: BookEvent[]) => {
      for (const event of events) hh.worker.feed.ingest('worker', { type: 'world', event }, { receivedAt: at });
    };
    // X1 is sent (the paper world takes it in flight) and the book gives it up at once; the process stops before it lands.
    world(h, m.now, [
      { type: 'trigger_exit', positionId: p.id, reasons: ['stop'], intentId: X1, quantity: raw(q) },
      on(X1, { type: 'prepare', quote: sellQuote }), on(X1, { type: 'sign', attempt: a1 }), on(X1, { type: 'submit' }),
    ]);
    const sent = () => attempts(h.stateDir).find((a) => a.signature === a1.signature);
    expect(await until(m, 5_000, () => sent() !== undefined, () => m.slot())).toBe(true);
    expect(sent()?.outcome).toBe('in_flight');
    world(h, m.now, [
      on(X1, { type: 'status', signature: a1.signature, result: 'not_found', commitment: null, blockHeight: height + 151n, searchedHistory: true }),
      on(X1, { type: 'reconcile', fills: [], blockHeight: height + 151n }),
      on(X1, { type: 'abandon' }),
    ]);
    expect(await until(m, 5_000, () => h.worker.book.intents[X1]?.status === 'abandoned', () => m.slot())).toBe(true);
    expect(sent()?.outcome).toBe('in_flight');
    await h.worker.stop();

    const h2 = makeWorker({ stateDir: h.stateDir, timers: h.timers, scenario });
    expect(await h2.worker.reconcile()).toEqual({ ok: true });
    const m2 = new Market(h2, HELD);
    await m2.run(8_000, 400, () => { m2.slot(); m2.solPrice(); });
    // Paper attempts die with their process: X1 never lands, the position still holds everything.
    expect(attempts(h.stateDir).find((a) => a.signature === a1.signature)).toMatchObject({ outcome: 'expired', reason: 'lost in a restart (paper attempts die with the process)' });
    expect(h2.worker.book.positions[p.id]?.quantity).toBe(q);
    // A late sale reported now (as a live chain could): the trade closes with the stop it was sold for.
    world(h2, m2.now, [
      on(X1, { type: 'status', signature: a1.signature, result: 'succeeded', commitment: 'finalized', blockHeight: height + 160n, searchedHistory: true }),
      { type: 'orphan_fill', fill: { intentId: X1, signature: a1.signature, slot: height + 1n, commitment: 'confirmed', tokens: q, sol: 30_000_000n, fees: 0n } as Fill },
    ]);
    await m2.run(2_000, 400, () => { m2.slot(); m2.solPrice(); });
    expect(h2.worker.book.positions[p.id]?.quantity).toBe(0n);
    const t = read<{ trades: { positionId: string; closedAtMs: number | null; stoppedOut: boolean; exitReasons?: string[] }[] }>(h.stateDir, 'account.json').trades.find((x) => x.positionId === p.id)!;
    expect(t.closedAtMs).not.toBeNull();
    expect(t.stoppedOut).toBe(true);
    expect(t.exitReasons).toEqual(['stop']);
    await h2.worker.stop();
  });
});

describe('PAPER-2: a closed trade is settled again when something lands after it closed', () => {
  const NET = FILL_CONFIG.network;
  const PX = 100_000_000n as MicroUsd;
  const DAY = 86_400_000;
  const fillOf = (intentId: string, signature: string, tokens: bigint, sol: bigint) => ({ intentId, signature, slot: 1n, commitment: 'confirmed', tokens, sol, fees: 0n });
  const att = (intentId: string, signature: string, purpose: 'entry' | 'exit', outcome: 'filled' | 'failed', trade: string, f: ReturnType<typeof fillOf> | null): PaperAttempt => ({
    intentId, signature, purpose, trade, mint: 'M', inAmount: 0n, quotedOut: 0n, minOut: 0n, priorityFee: 10_000n,
    lastValidBlockHeight: 10n, fate: outcome === 'filled' ? 'lands' : 'fails', landSlot: 1n, outcome, reason: outcome, landedSlot: 1n, simulated: true,
    fill: f as PaperAttempt['fill'], sentAtMs: 0,
    ...(outcome === 'filled' ? { costs: { venueFee: 0n, creatorFee: 0n, slippage: 0n, base: 0n, priority: 0n, tip: 0n } } : {}),
  });
  type Pos = { id: string; status: string; quantity: bigint };
  const bookOf = (positions: Pos[], intents: { id: string; purpose: 'entry' | 'exit'; pid: string; fills: ReturnType<typeof fillOf>[]; sigs: string[] }[]) => ({
    positions: Object.fromEntries(positions.map((p) => [p.id, { id: p.id, mint: 'M', entryIntentId: 'in', status: p.status, quantity: p.quantity, cost: 20_000_000n }])),
    intents: Object.fromEntries(intents.map((i) => [i.id, { intent: { id: i.id, purpose: i.purpose, positionId: i.pid, mint: 'M' }, status: 'reconciled', fills: i.fills, attempts: i.sigs.map((signature) => ({ signature })) }])),
    orphans: {},
  }) as unknown as Book;
  const legsOf = (as: PaperAttempt[], closes: string[] = []): PaperLegs => ({ network: NET, attempts: new Map(as.map((a) => [a.signature, a])), closedAccount: (s) => closes.includes(s) });
  const base = { positionId: 'p1', mint: 'M', reasons: ['notional 2000000', 'stop'] };
  const eIn = fillOf('in', 'e1', 1_000n, 20_000_000n);
  const eOut = fillOf('out', 'x1', 1_000n, 30_000_000n);
  const opened = () => {
    const account = new PaperAccount(accountFile(tempState()), 20_000_000n as MicroUsd, T, 0n);
    account.price(PX, T);
    const entryBook = bookOf([{ id: 'p1', status: 'open', quantity: 1_000n }], [{ id: 'in', purpose: 'entry', pid: 'p1', fills: [eIn], sigs: ['e1'] }]);
    account.filled({ ...base, purpose: 'entry', book: entryBook, atMs: T + 1 }, PX, legsOf([att('in', 'e1', 'entry', 'filled', 'p1', eIn)]));
    return account;
  };
  const closedBook = (extra: { id: string; purpose: 'entry' | 'exit'; pid: string; fills: ReturnType<typeof fillOf>[]; sigs: string[] }[] = []) => bookOf(
    [{ id: 'p1', status: 'closed', quantity: 0n }],
    [{ id: 'in', purpose: 'entry', pid: 'p1', fills: [eIn], sigs: ['e1'] }, { id: 'out', purpose: 'exit', pid: 'p1', fills: [eOut], sigs: ['x1'] }, ...extra],
  );
  const closeLegs = [att('in', 'e1', 'entry', 'filled', 'p1', eIn), att('out', 'x1', 'exit', 'filled', 'p1', eOut)];
  const check = (account: PaperAccount) => {
    const t = account.state.trades.find((x) => x.positionId === 'p1')!;
    // The wallet always holds the opening balance plus each trade's whole settled net.
    expect(account.state.walletLamports).toBe(account.state.trades.reduce((w, x) => w + x.booked, opening(account)));
    expect(t.booked).toBe(tradeSol(t));
    return t;
  };
  let opening = (_a: PaperAccount): bigint => 0n;

  it('a failed sell that lands after the close: its fee is charged to the trade, the wallet and the result (item 2)', () => {
    const account = opened();
    const start = account.state.walletLamports! - account.state.trades[0]!.booked;
    opening = () => start;
    account.filled({ ...base, purpose: 'exit', book: closedBook(), atMs: T + 2 }, PX, legsOf(closeLegs, ['x1']));
    const before = { ...check(account) };
    const late = att('out', 'x2', 'exit', 'failed', 'p1', null);
    const fee = attemptFee(NET, late.priorityFee, 'failed');
    expect(account.resettle(closedBook(), 'p1', legsOf([...closeLegs, late], ['x1']), T + DAY)).toBe(true);
    const t = check(account);
    const feeUsd = lamportsToMicroUsd(fee as Lamports, PX, 'ceil');
    // The close's results stay; the fee is a late entry dated when it was booked, and the whole result includes it.
    expect([t.netLamports, t.netPnl, t.closedAtMs]).toEqual([before.netLamports, before.netPnl, before.closedAtMs]);
    expect(t.late).toEqual([{ atMs: T + DAY, lamports: -fee, usd: -feeUsd }]);
    expect(tradeSol(t)).toBe(before.netLamports! - fee);
    expect(tradePnl(t)).toBe(before.netPnl! - feeUsd);
    // Risk counts it on the day it was booked, not the day the trade closed.
    const ledger = openLedger(join(tempState(), 'ledger.sqlite'), 'paper');
    // SOL-BOOKS: in lamports.
    expect(account.fact(ledger, emptyBook({ maxOpenPositions: 5 }), NO_LATCHES, T + DAY, noLegs).history.costs.filter((c) => c.kind === 'late_settlement'))
      .toEqual([{ atMs: T + DAY, amount: fee, kind: 'late_settlement' }]);
    ledger.close();
    // The app shows the whole result.
    const legs = legsOf([...closeLegs, late], ['x1']);
    // Risk's late_settlement cost is in the account's costs, but the app counts the late entry once, as the trade's own.
    expect(account.costRecords(emptyBook({ maxOpenPositions: 5 }), noLegs, PX, T + DAY).filter((c) => c.kind === 'late_settlement')).toEqual([{ atMs: T + DAY, amount: fee, lamports: fee, usd: feeUsd, kind: 'late_settlement' }]);
    const inputs = { book: closedBook(), legs, attempts: legs.attempts, trades: account.state.trades, accountCosts: account.costRecords(emptyBook({ maxOpenPositions: 5 }), noLegs, PX, T + DAY), symbol: () => 'M', strategyVersion: 's', policyVersion: 'p', solPrice: PX } as unknown as ApiInputs;
    expect(views.trades(inputs)).toMatchObject([{ netUsd: usdText(tradePnl(t)!), netSol: (Number(tradeSol(t)!) / 1e9).toFixed(9) }]);
    expect(views.stats(inputs)).toMatchObject({ netUsd: usdText(tradePnl(t)!), netSol: (Number(tradeSol(t)!) / 1e9).toFixed(9), meanNetUsd: usdText(tradePnl(t)!) });
    // The late fee is in the trade's costs (read from its paper legs): the chart's priority fees are all three attempts'
    // (entry, sell, the late failed sell: 10,000 lamports each at $100), on the close's day, not again as an account cost.
    const kinds = views.charts(inputs).costsByKind;
    expect(kinds.find((k) => k.kind === 'priorityFeeUsd')?.amountUsd).toBe(usdText(3n * lamportsToMicroUsd(10_000n as Lamports, PX, 'ceil')));
    // The calendar: the close on its day, the late fee on the day it was booked.
    const month = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Melbourne', year: 'numeric', month: '2-digit' }).format(T + 2);
    expect(views.calendar(inputs, month).days.map((d) => d.netUsd)).toEqual([usdText(before.netPnl!), usdText(-feeUsd)]);
    // Nothing more lands: nothing moves.
    expect(account.resettle(closedBook(), 'p1', legs, T + DAY + 1)).toBe(false);
  });

  it('ACCOUNT-RATE x PAPER-2: a late fee on a close still unvalued is dated when it was booked once the first price values the trade', () => {
    // The same trade twice: closed at a known price, and closed with no price known (valued at the first price after).
    const priced = opened();
    priced.filled({ ...base, purpose: 'exit', book: closedBook(), atMs: T + 2 }, PX, legsOf(closeLegs, ['x1']));
    const account = opened();
    account.filled({ ...base, purpose: 'exit', book: closedBook(), atMs: T + 2 }, null, legsOf(closeLegs, ['x1']));
    const late = att('out', 'x2', 'exit', 'failed', 'p1', null);
    const fee = attemptFee(NET, late.priorityFee, 'failed');
    const legs = legsOf([...closeLegs, late], ['x1']);
    expect(priced.resettle(closedBook(), 'p1', legs, T + DAY)).toBe(true);
    expect(account.resettle(closedBook(), 'p1', legs, T + DAY)).toBe(true);
    const ledger = openLedger(join(tempState(), 'ledger.sqlite'), 'paper');
    // SOL-BOOKS: still no price, yet risk already counts the close and the late fee by their lamports (nothing unvalued).
    expect(account.fact(ledger, closedBook(), NO_LATCHES, T + DAY, legs).unvalued).toBe(0);
    expect(account.fact(ledger, closedBook(), NO_LATCHES, T + DAY, legs).history.costs.filter((c) => c.kind === 'late_settlement')).toEqual([{ atMs: T + DAY, amount: fee, kind: 'late_settlement' }]);
    expect(account.priceLate(closedBook(), legs, PX, T + DAY + 5)).toBe(true);
    const t = account.state.trades.find((x) => x.positionId === 'p1')!;
    const twin = priced.state.trades.find((x) => x.positionId === 'p1')!;
    const feeUsd = lamportsToMicroUsd(fee as Lamports, PX, 'ceil');
    // The late fee keeps the day it was booked: the close's own result leaves it out, as the priced twin's does.
    expect(t.late).toEqual([{ atMs: T + DAY, lamports: -fee, usd: -feeUsd }]);
    expect([t.netPnl, tradePnl(t), tradeSol(t)]).toEqual([twin.netPnl, tradePnl(twin), tradeSol(twin)]);
    const costs = (a: PaperAccount) => a.fact(ledger, closedBook(), NO_LATCHES, T + DAY + 5, legs).history.costs.filter((c) => c.kind === 'late_settlement');
    expect(costs(account)).toEqual([{ atMs: T + DAY, amount: fee, kind: 'late_settlement' }]);
    expect(costs(account)).toEqual(costs(priced));
    expect(account.fact(ledger, closedBook(), NO_LATCHES, T + DAY + 5, legs).unvalued).toBe(0);
    ledger.close();
  });

  it('ACCOUNT-RATE x PAPER-2: late changes on an unvalued close are valued at the first price, a loss rounded up and a gain down', () => {
    const account = opened();
    account.filled({ ...base, purpose: 'exit', book: closedBook(), atMs: T + 2 }, null, legsOf(closeLegs, ['x1']));
    const fail = att('out', 'x2', 'exit', 'failed', 'p1', null);
    const fee = attemptFee(NET, fail.priorityFee, 'failed');
    expect(account.resettle(closedBook(), 'p1', legsOf([...closeLegs, fail], ['x1']), T + DAY)).toBe(true);
    // A sale booked late, still with no price: a gain.
    const lateFill = fillOf('late', 'x3', 400n, 5_000_000n);
    const book = closedBook([{ id: 'late', purpose: 'exit', pid: 'p1', fills: [lateFill], sigs: ['x3'] }]);
    const legs = legsOf([...closeLegs, fail, att('late', 'x3', 'exit', 'filled', 'p1', lateFill)], ['x1']);
    account.filled({ ...base, purpose: 'exit', book, atMs: T + DAY + 1 }, null, legs);
    const t = account.state.trades.find((x) => x.positionId === 'p1')!;
    const gain = t.late![1]!.lamports;
    expect([t.late!.length, gain > 0n, t.late!.every((x) => x.usd === null)]).toEqual([2, true, true]);
    // A price where rounding shows: the fee rounds up, the gain down.
    const p2 = (PX + 1n) as MicroUsd;
    expect(lamportsToMicroUsd(fee as Lamports, p2, 'ceil')).not.toBe(lamportsToMicroUsd(fee as Lamports, p2, 'floor'));
    expect(lamportsToMicroUsd(gain as Lamports, p2, 'ceil')).not.toBe(lamportsToMicroUsd(gain as Lamports, p2, 'floor'));
    const whole = tradeUsd(paperTradeLamports(book, 'p1', legs)!, PX, p2).net;
    expect(account.priceLate(book, legs, p2, T + DAY + 5)).toBe(true);
    expect(t.late).toEqual([
      { atMs: T + DAY, lamports: -fee, usd: -lamportsToMicroUsd(fee as Lamports, p2, 'ceil') },
      { atMs: T + DAY + 1, lamports: gain, usd: lamportsToMicroUsd(gain as Lamports, p2, 'floor') },
    ]);
    // The whole result is the trade valued at its prices; the close's own result is that less what landed after.
    expect(tradePnl(t)).toBe(whole);
    expect(t.netPnl).toBe(whole - t.late![0]!.usd! - t.late![1]!.usd!);
  });

  it('two late losses on two Melbourne days: risk counts each exactly once on its own day, summing to the whole change', () => {
    const account = opened();
    const start = account.state.walletLamports! - account.state.trades[0]!.booked;
    opening = () => start;
    account.filled({ ...base, purpose: 'exit', book: closedBook(), atMs: T + 2 }, PX, legsOf(closeLegs, ['x1']));
    const atClose = { ...check(account) };
    // A failed sell lands a day after the close, another one a day later (each its own fee, 10,000 and 30,000 priority).
    const late1 = { ...att('out', 'x2', 'exit', 'failed', 'p1', null), priorityFee: 10_000n };
    const late2 = { ...att('out', 'x3', 'exit', 'failed', 'p1', null), priorityFee: 30_000n };
    const day1 = T + DAY;
    const day2 = T + 2 * DAY;
    expect(account.resettle(closedBook(), 'p1', legsOf([...closeLegs, late1], ['x1']), day1)).toBe(true);
    expect(account.resettle(closedBook(), 'p1', legsOf([...closeLegs, late1, late2], ['x1']), day2)).toBe(true);
    const t = check(account);
    const feeUsd = (x: PaperAttempt) => lamportsToMicroUsd(attemptFee(NET, x.priorityFee, 'failed') as Lamports, PX, 'ceil');
    const feeSol = (x: PaperAttempt) => attemptFee(NET, x.priorityFee, 'failed');
    const ledger = openLedger(join(tempState(), 'ledger.sqlite'), 'paper');
    const costs = account.fact(ledger, emptyBook({ maxOpenPositions: 5 }), NO_LATCHES, day2, noLegs).history.costs.filter((c) => c.kind === 'late_settlement');
    ledger.close();
    // Each loss once, on its own day (SOL-BOOKS: in lamports).
    expect(costs).toEqual([{ atMs: day1, amount: feeSol(late1), kind: 'late_settlement' }, { atMs: day2, amount: feeSol(late2), kind: 'late_settlement' }]);
    expect(melbourneDay(day1).start).not.toBe(melbourneDay(day2).start);
    // Together they are exactly the trade's whole-result change since its close.
    expect(costs.reduce((s, c) => s + c.amount, 0n)).toBe(atClose.netLamports! - tradeSol(t)!);
    expect(t.netPnl).toBe(atClose.netPnl);
    // The app's money events (its day-loss meter, calendar and totals): each late loss once, on its own day, never also
    // as an account cost.
    const inputs = { trades: account.state.trades, accountCosts: account.costRecords(emptyBook({ maxOpenPositions: 5 }), noLegs, PX, day2) } as unknown as ApiInputs;
    const all = moneyEvents(inputs);
    expect(all.filter((e) => e.kind === 'cost' && e.costKind === 'late_settlement')).toEqual([]);
    // The trade's own events (the account's other costs, its setup rent, aside).
    const events = all.filter((e) => e.kind !== 'cost');
    expect(events.filter((e) => e.kind === 'late').map((e) => [e.atMs, e.net])).toEqual([[day1, -feeUsd(late1)], [day2, -feeUsd(late2)]]);
    const realisedOn = (day: number) => -events.filter((e) => e.atMs >= melbourneDay(day).start && e.atMs < melbourneDay(day).end).reduce((s, e) => s + e.net, 0n);
    expect([realisedOn(day1), realisedOn(day2)]).toEqual([feeUsd(late1), feeUsd(late2)]);
    expect(events.reduce((s, e) => s + e.net, 0n)).toBe(tradePnl(t));
  });

  it('a sale booked after the close: the trade\'s net follows the wallet (item 3)', () => {
    const account = opened();
    const start = account.state.walletLamports! - account.state.trades[0]!.booked;
    opening = () => start;
    account.filled({ ...base, purpose: 'exit', book: closedBook(), atMs: T + 2 }, PX, legsOf(closeLegs, ['x1']));
    const before = { ...check(account) };
    const lateFill = fillOf('late', 'x3', 400n, 5_000_000n);
    const book = closedBook([{ id: 'late', purpose: 'exit', pid: 'p1', fills: [lateFill], sigs: ['x3'] }]);
    account.filled({ ...base, purpose: 'exit', book, atMs: T + 3 }, PX, legsOf([...closeLegs, att('late', 'x3', 'exit', 'filled', 'p1', lateFill)], ['x1']));
    const t = check(account);
    expect(tradeSol(t)).toBe(before.netLamports! + 5_000_000n - attemptFee(NET, 10_000n, 'filled'));
    expect([t.netLamports, t.closedAtMs]).toEqual([before.netLamports, before.closedAtMs]);
    // A late gain: in the trade's whole result, never a negative cost for risk.
    expect(t.late![0]!.usd! > 0n).toBe(true);
    expect(tradePnl(t)! > before.netPnl!).toBe(true);
    const ledger = openLedger(join(tempState(), 'ledger.sqlite'), 'paper');
    expect(account.fact(ledger, emptyBook({ maxOpenPositions: 5 }), NO_LATCHES, T + 3, noLegs).history.costs.filter((c) => c.kind === 'late_settlement')).toEqual([]);
    ledger.close();
  });

  it('a late gain shows in the app on its booking day (net, calendar, curve) but never in risk\'s costs or the day-loss meter', () => {
    const account = opened();
    const start = account.state.walletLamports! - account.state.trades[0]!.booked;
    opening = () => start;
    account.filled({ ...base, purpose: 'exit', book: closedBook(), atMs: T + 2 }, PX, legsOf(closeLegs, ['x1']));
    const atClose = { ...check(account) };
    // A day later a sale of this trade is booked late: a gain.
    const day = T + DAY;
    const lateFill = fillOf('late', 'x3', 400n, 5_000_000n);
    const book = closedBook([{ id: 'late', purpose: 'exit', pid: 'p1', fills: [lateFill], sigs: ['x3'] }]);
    const legs = legsOf([...closeLegs, att('late', 'x3', 'exit', 'filled', 'p1', lateFill)], ['x1']);
    account.filled({ ...base, purpose: 'exit', book, atMs: day }, PX, legs);
    const t = check(account);
    const gain = tradePnl(t)! - atClose.netPnl!;
    expect(gain > 0n).toBe(true);
    // Another loss booked the same day (an account cost), so the meter has something to measure.
    const other = { atMs: day + 60_000, amount: 0n, usd: gain * 3n, lamports: 0n, kind: 'wallet_setup' };
    const inputs = { book, legs, attempts: legs.attempts, trades: account.state.trades, accountCosts: [...account.costRecords(emptyBook({ maxOpenPositions: 5 }), noLegs, PX, day + 120_000), other], symbol: () => 'M', strategyVersion: 's', policyVersion: 'p', solPrice: PX, nowMs: day + 120_000 } as unknown as ApiInputs;
    // Net: the trade's whole result (and the other cost).
    expect(views.stats(inputs)).toMatchObject({ netUsd: usdText(tradePnl(t)! - other.usd) });
    // Calendar: the close on its day, the gain (less the other cost) on its booking day.
    const month = (ms: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Melbourne', year: 'numeric', month: '2-digit' }).format(ms);
    const days = month(T + 2) === month(day) ? views.calendar(inputs, month(day)).days : [...views.calendar(inputs, month(T + 2)).days, ...views.calendar(inputs, month(day)).days];
    expect(days.map((d) => d.netUsd)).toEqual([usdText(atClose.netPnl!), usdText(gain - other.usd)]);
    // Curve: after the close, the gain at its booking time.
    const curve = views.charts(inputs).cumulative;
    const at = curve.findIndex((c) => c.at === new Date(day).toISOString());
    expect(at > 0).toBe(true);
    const micro = (x: string) => BigInt(Math.round(Number(x) * 1e6));
    expect(micro(curve[at]!.cumNetUsd) - micro(curve[at - 1]!.cumNetUsd)).toBe(gain);
    expect(curve[at - 1]!.at).toBe(new Date(T + 2).toISOString());
    // Risk: no cost for a gain. The day-loss meter: the other cost alone, the late gain not offsetting it.
    expect(account.costs(emptyBook({ maxOpenPositions: 5 }), noLegs, T + 3).filter((c) => c.kind === 'late_settlement')).toEqual([]);
    expect(realisedLossToday(inputs)).toBe(other.usd);
  });

  it('a sibling\'s sell closes the shared account after the main trade closed: the rent comes back to the main trade (item 4)', () => {
    const account = opened();
    const start = account.state.walletLamports! - account.state.trades[0]!.booked;
    opening = () => start;
    // The entry's late buy (p1.o2, LEDGER-1b) shares the account; the main trade sells first and does not close it.
    const lateBuy = fillOf('in', 'e2', 500n, 9_000_000n);
    const sibSell = fillOf('sib', 'y1', 500n, 10_000_000n);
    const positions = (sib: string, q: bigint) => [{ id: 'p1', status: 'closed', quantity: 0n }, { id: 'p1.o2', status: sib, quantity: q }];
    const intents = (sold: boolean) => [
      { id: 'in', purpose: 'entry' as const, pid: 'p1', fills: [eIn, lateBuy], sigs: ['e1', 'e2'] },
      { id: 'out', purpose: 'exit' as const, pid: 'p1', fills: [eOut], sigs: ['x1'] },
      ...(sold ? [{ id: 'sib', purpose: 'exit' as const, pid: 'p1.o2', fills: [sibSell], sigs: ['y1'] }] : []),
    ];
    const legs1 = [...closeLegs, att('in', 'e2', 'entry', 'filled', 'p1.o2', lateBuy)];
    account.filled({ ...base, purpose: 'exit', book: bookOf(positions('open', 500n), intents(false)), atMs: T + 2 }, PX, legsOf(legs1));
    const before = { ...check(account) };
    expect(before.closedAtMs).not.toBeNull();
    // The sibling's sell closes the account: the rent the main trade paid is back.
    account.filled({ positionId: 'p1.o2', mint: 'M', reasons: ['exit filled (paper)'], purpose: 'exit', book: bookOf(positions('closed', 0n), intents(true)), atMs: T + 3 }, PX,
      legsOf([...legs1, att('sib', 'y1', 'exit', 'filled', 'p1.o2', sibSell)], ['y1']));
    const t = check(account);
    expect(tradeSol(t)).toBe(before.netLamports! + NET.tokenAccountRent);
    expect(t.late).toEqual([{ atMs: T + 3, lamports: NET.tokenAccountRent, usd: expect.any(BigInt) }]);
    expect(account.state.trades.map((x) => x.positionId)).toEqual(['p1']);
  });
});

describe('PAPER-2: a failed sell landing after its trade closed', () => {
  it('its fee is charged to the closed trade as it lands (landedFailed re-settles it)', async () => {
    const h = makeWorker({ scenario: { ...LANDS, closeSuccessPpm: 1_000_000n, dustPpm: 0n } });
    expect(await h.worker.reconcile()).toEqual({ ok: true });
    const m = await passingMarket(h, HELD);
    const open = () => Object.values(h.worker.book.positions).find((p) => p.status === 'open' && p.quantity > 0n);
    expect(await until(m, 60_000, () => open() !== undefined, () => { m.slot(); m.pool(); })).toBe(true);
    const p = open()!;
    const q = p.quantity;
    await h.worker.stop();
    // A new process in which every attempt lands failed, 30 slots after it is sent (time for X1's sale to close the trade).
    const scenario = { ...LANDS, landPpm: { pumpswap: 0n, 'pump-curve': 0n }, dropPpm: 0n, closeSuccessPpm: 1_000_000n, dustPpm: 0n, landingSlots: [30], landingTail: { ...LANDS.landingTail, ppm: 0n } };
    const h2 = makeWorker({ stateDir: h.stateDir, timers: h.timers, scenario });
    expect(await h2.worker.reconcile()).toEqual({ ok: true });
    const m2 = await passingMarket(h2, HELD);
    const height = BigInt(h2.worker.health().last_processed_slot!);
    const X1 = 'x-late-1' as IntentId;
    const X2 = 'x-late-2' as IntentId;
    const sellQuote = { ...quote, inAmount: q, quotedOut: 1n, minOut: 1n, quotedAtSlot: height };
    const a1 = { ...fxAttempt(X1, 91, height + 150n), quote: sellQuote };
    const world = (events: BookEvent[]) => { for (const event of events) h2.worker.feed.ingest('worker', { type: 'world', event }, { receivedAt: m2.now }); };
    // X1 is given up by the book at once (never in the paper world); X2 is triggered and goes out.
    world([
      { type: 'trigger_exit', positionId: p.id, reasons: ['stop'], intentId: X1, quantity: raw(q) },
      on(X1, { type: 'prepare', quote: sellQuote }), on(X1, { type: 'sign', attempt: a1 }), on(X1, { type: 'submit' }),
      on(X1, { type: 'status', signature: a1.signature, result: 'not_found', commitment: null, blockHeight: height + 151n, searchedHistory: true }),
      on(X1, { type: 'reconcile', fills: [], blockHeight: height + 151n }), on(X1, { type: 'abandon' }),
      { type: 'trigger_exit', positionId: p.id, reasons: ['max_hold'], intentId: X2, quantity: raw(q) },
    ]);
    const x2 = () => attempts(h.stateDir).find((a) => a.intentId === X2);
    expect(await until(m2, 10_000, () => x2() !== undefined, () => m2.slot())).toBe(true);
    expect(x2()!.outcome).toBe('in_flight');
    // X1's sale is found while X2 is in flight: the trade closes.
    world([
      on(X1, { type: 'status', signature: a1.signature, result: 'succeeded', commitment: 'finalized', blockHeight: height + 152n, searchedHistory: true }),
      { type: 'orphan_fill', fill: { intentId: X1, signature: a1.signature, slot: height + 1n, commitment: 'confirmed', tokens: q, sol: 30_000_000n, fees: 0n } as Fill },
    ]);
    const trade = () => read<{ trades: PaperTrade[] }>(h.stateDir, 'account.json').trades.find((t) => t.positionId === p.id)!;
    expect(await until(m2, 10_000, () => trade().closedAtMs !== null, () => m2.slot())).toBe(true);
    const closed = trade().netLamports!;
    // Attempts still in flight at the close (X2's, with X1's own if the paper world took it) land failed after it.
    const pending = attempts(h.stateDir).filter((a) => a.trade === p.id && a.outcome === 'in_flight').map((a) => a.signature);
    expect(pending).toContain(x2()!.signature);
    const now = () => attempts(h.stateDir).filter((a) => pending.includes(a.signature));
    expect(await until(m2, 30_000, () => now().every((a) => a.outcome === 'failed'), () => m2.slot())).toBe(true);
    const fees = now().reduce((t, a) => t + attemptFee(FILL_CONFIG.network, a.priorityFee, 'failed'), 0n);
    // Their fees are the closed trade's too: late entries in its whole result, and the wallet through it; the close's
    // own net stays.
    expect(trade().netLamports).toBe(closed);
    expect(tradeSol(trade())).toBe(closed - fees);
    expect(trade().booked).toBe(closed - fees);
    // The app's money events count them once, as the trade's late entries on the day they were booked (as risk does),
    // never again as account costs.
    const lateLoss = (trade().late ?? []).reduce((t, x) => t - (x.usd ?? 0n), 0n);
    expect(lateLoss > 0n).toBe(true);
    const events = moneyEvents(h2.worker.apiInputs()).filter((e) => e.kind !== 'cost' || e.costKind === 'late_settlement');
    expect(events.filter((e) => e.kind === 'cost')).toEqual([]);
    expect(events.filter((e) => e.kind === 'late').reduce((s, e) => s - e.net, 0n)).toBe(lateLoss);
    await h2.worker.stop();
  });
});

describe('a late buy cannot come from paper (reachability; risk review of #133)', () => {
  it('a paper buy still in flight at a restart is lost and never lands: no orphan_fill, no late_buy', async () => {
    // Buys land 30 slots after they are sent, so the process stops with one in flight.
    const scenario = { ...LANDS, landingSlots: [30], landingTail: { ...LANDS.landingTail, ppm: 0n } };
    const h = makeWorker({ scenario });
    expect(await h.worker.reconcile()).toEqual({ ok: true });
    const m = await passingMarket(h, HELD);
    const buy = () => (existsSync(join(h.stateDir, 'paper.json')) ? attempts(h.stateDir).find((a) => a.purpose === 'entry') : undefined);
    expect(await until(m, 60_000, () => buy() !== undefined, () => { m.slot(); m.pool(); })).toBe(true);
    expect(buy()!.outcome).toBe('in_flight');
    await h.worker.stop();
    const h2 = makeWorker({ stateDir: h.stateDir, timers: h.timers, scenario });
    expect(await h2.worker.reconcile()).toEqual({ ok: true });
    const m2 = new Market(h2, HELD);
    await m2.run(30_000, 400, () => { m2.slot(); m2.solPrice(); });
    expect(buy()).toMatchObject({ outcome: 'expired', reason: 'lost in a restart (paper attempts die with the process)', fill: null });
    // The entry ended unfilled; nothing was bought late.
    expect(Object.values(h2.worker.book.positions).every((p) => p.quantity === 0n && lateFillOf(p.id) === null)).toBe(true);
    expect(Object.values(h2.worker.book.orphans)).toEqual([]);
    const journal = readFileSync(join(h.stateDir, 'journal.jsonl'), 'utf8');
    expect(journal.includes('"late_buy"')).toBe(false);
    expect(h2.worker.health().halt_reasons).not.toContain(LATE_BUY);
    await h2.worker.stop();
  });
});
