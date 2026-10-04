// PAPER-1: paper settlement matches the historical backtest's (audit of d92b73e, items M4, M5 and M8's rent part).
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { FILL_CONFIG, TRIAL_POLICY, startSession } from '../../core/src/config/index.ts';
import { openLedger } from '../../core/src/ledger/index.ts';
import { emptyBook, isTerminal } from '../../core/src/lifecycle/index.ts';
import { NO_LATCHES, melbourneWeek, riskSnapshot } from '../../core/src/risk/index.ts';
import { attemptFee } from '../../core/src/fills/index.ts';
import { type Lamports, type MicroUsd, lamportsToMicroUsd, microUsdToLamports } from '../../core/src/units/index.ts';
import type { Book } from '../../core/src/lifecycle/index.ts';
import { positionId, type Fill, type IntentId } from '../../core/src/domain/index.ts';
import { OFF_CHAIN, type LogRecord } from '../../core/src/engine/index.ts';
import type { BookEvent, ExitReason } from '../../core/src/lifecycle/index.ts';
import { raw } from '../../core/src/units/index.ts';
import { attempt as fxAttempt, entryToSubmitted, fill as fx, on, quote, sig } from '../../core/test/fixtures.ts';
import { PaperAccount, type PaperLegs, accountFile } from '../src/run/account.ts';
import { Desk } from '../src/run/desk.ts';
import { LATE_BUY } from '../src/run/worker.ts';
import { type ApiInputs, views } from '../src/run/api.ts';
import type { PaperAttempt } from '../src/run/paper-world.ts';
import { oneTimeRent } from '../src/run/settings.ts';
import { LANDS, Market, SOL_PRICE, T, makeWorker, passingMarket, tempState, until } from './worker-harness.ts';

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

    const inputs = { book: book(true), legs: legs(true), attempts: legs(true).attempts, trades: account.state.trades, symbol: () => 'M', strategyVersion: 's', policyVersion: 'p', solPrice: px(80) } as unknown as ApiInputs;
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
      const inputs = { book: book(true), legs: l, attempts: l.attempts, trades: account.state.trades, symbol: () => 'M', strategyVersion: 's', policyVersion: 'p', solPrice: pxOut } as unknown as ApiInputs;
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
    const fact = account.fact(ledger, emptyBook({ maxOpenPositions: 5 }), NO_LATCHES, PRICE, T);
    expect(fact.history.costs).toContainEqual({ atMs: T - 60_000, amount: lamportsToMicroUsd(fee as Lamports, PRICE, 'ceil'), kind: 'failed_entry' });
    expect(fact.history.closedTrades).toEqual([]);
    const s = riskSnapshot({
      session: startSession(TRIAL_POLICY), mode: 'paper', clock: { now: () => ({ slot: 1n, txIndex: 0, ixIndex: 0, receivedAt: T }) }, account: fact.history, latches: NO_LATCHES,
      market: { solPrice: { value: PRICE, atMs: T }, solBalance: fact.solBalance, regime: 'unknown' },
    })!;
    expect(s.dayLoss).toBeGreaterThanOrEqual((bankroll * BigInt(TRIAL_POLICY.loss.dailyBps)) / 10_000n);
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
    // Booked in the last days of a week: a (from the week before) folds at once, b stays a record.
    account.settle(bookOf(old), legsOf(old), PRICE, start - 1_000);
    expect(Object.keys(account.state.strayFees!)).toEqual(['b']);
    expect(account.state.strayFolded).toEqual({ atMs: start - 9 * DAY, lamports: attemptFee(net, 20_000n, 'failed'), cost: usdOf(old[0]!) });
    // In the new week: b folds into the total, c stays a record.
    const all = [...old, ...recent];
    account.settle(bookOf(all), legsOf(all), PRICE, start + 2_000);
    expect(Object.keys(account.state.strayFees!)).toEqual(['c']);
    const fees = (xs: readonly PaperAttempt[]) => xs.reduce((s, x) => s + attemptFee(net, x.priorityFee, 'failed'), 0n);
    expect(account.state.strayFolded).toEqual({ atMs: start - DAY, lamports: fees(old), cost: usdOf(old[0]!) + usdOf(old[1]!) });
    expect(account.state.walletLamports).toBe(opening - fees(all));
    // A replay (the same signatures again, also after a reload) charges nothing more.
    const reloaded = new PaperAccount(file, 20_000_000n as MicroUsd, start + 3_000, 0n);
    expect(reloaded.settle(bookOf(all), legsOf(all), PRICE, start + 3_000)).toBe(false);
    expect(reloaded.state.walletLamports).toBe(opening - fees(all));
    // Equity keeps every fee: the folded total (before this week) and the record are both costs.
    const costs = reloaded.fact(ledger, emptyBook({ maxOpenPositions: 5 }), NO_LATCHES, PRICE, start + 3_000).history.costs.filter((c) => c.kind === 'failed_entry');
    expect(costs).toEqual([
      { atMs: start - DAY, amount: usdOf(old[0]!) + usdOf(old[1]!), kind: 'failed_entry' },
      { atMs: start + 1_000, amount: usdOf(recent[0]!), kind: 'failed_entry' },
    ]);
    ledger.close();
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
      desk.consume(events.map((event) => ({ type: 'world', seq: seq++, at, eventId: `w${seq}`, event, result: 'applied', effects: [] }) as unknown as LogRecord));
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
    expect(h.worker.book.positions[pid]?.status).toBe('open');
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
    await h2.worker.stop();
  });
});
