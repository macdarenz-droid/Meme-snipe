// ACCOUNT-RATE (golden rule: paper money is real money). A fill booked while no SOL price is known (a fill a restart's
// reconcile finds) was valued as a total loss of its notional: a winning exit then counted toward daily_loss and could
// halt entries. Now the leg stays unvalued until the first SOL price at or after its fill values it, flagged.
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FILL_CONFIG, TRIAL_POLICY, startSession } from '../../core/src/config/index.ts';
import { openLedger } from '../../core/src/ledger/index.ts';
import type { Book } from '../../core/src/lifecycle/index.ts';
import { NO_LATCHES, evaluateEntry, melbourneDay, riskSnapshot } from '../../core/src/risk/index.ts';
import { type Lamports, type MicroUsd, lamportsToMicroUsd } from '../../core/src/units/index.ts';
import { PaperAccount, type PaperLegs, accountFile } from '../src/run/account.ts';

const formatSolOf = (lamports: bigint): string => { const neg = lamports < 0n; const v = neg ? -lamports : lamports; return `${neg ? '-' : ''}${v / 1_000_000_000n}.${String(v % 1_000_000_000n).padStart(9, '0')}`; };
import type { PaperAttempt } from '../src/run/paper-world.ts';
import { makeWorker, tempState } from './worker-harness.ts';
import { type ApiInputs, views } from '../src/run/api.ts';

const HOUR = 3_600_000;
const T = Date.UTC(2026, 9, 6, 4);
const usd = (x: number) => BigInt(Math.round(x * 1_000_000)) as MicroUsd;
// Buy for 0.02 SOL, sell for 0.024 SOL, no fees or rent: at SOL $100 a win of $0.40. Notional $2.
const net = { ...FILL_CONFIG.network, baseFeePerSignature: 0n, tip: 0n, tokenAccountRent: 0n };
const fill = (intentId: string, signature: string, sol: bigint) => ({ intentId, signature, slot: 1n, commitment: 'confirmed', tokens: 1_000_000n, sol, fees: 0n });
const attempt = (intentId: string, signature: string, purpose: 'entry' | 'exit', sol: bigint): PaperAttempt => ({
  intentId, signature, purpose, trade: 'p1', mint: 'M', inAmount: purpose === 'entry' ? sol : 1_000_000n, quotedOut: 0n, minOut: 0n, priorityFee: 0n,
  lastValidBlockHeight: 10n, fate: 'lands', landSlot: 1n, outcome: 'filled', reason: 'filled', landedSlot: 1n, simulated: true,
  fill: fill(intentId, signature, sol) as PaperAttempt['fill'],
  costs: { venueFee: 0n, creatorFee: 0n, slippage: 0n, base: 0n, priority: 0n, tip: 0n }, sentAtMs: 0,
});
const book = (closed: boolean) => ({
  positions: { p1: { id: 'p1', mint: 'M', entryIntentId: 'in', status: closed ? 'closed' : 'open', quantity: closed ? 0n : 1_000_000n, bought: 1_000_000n, sold: closed ? 1_000_000n : 0n, cost: 20_000_000n } },
  intents: {
    in: { intent: { id: 'in', purpose: 'entry', positionId: 'p1', mint: 'M' }, fills: [fill('in', 'e1', 20_000_000n)], attempts: [{ signature: 'e1' }] },
    ...(closed ? { out: { intent: { id: 'out', purpose: 'exit', positionId: 'p1', mint: 'M' }, fills: [fill('out', 'x1', 24_000_000n)], attempts: [{ signature: 'x1' }] } } : {}),
  },
}) as unknown as Book;
const legs = (closed: boolean): PaperLegs => ({
  network: net, closedAccount: () => true,
  attempts: new Map([['e1', attempt('in', 'e1', 'entry', 20_000_000n)], ...(closed ? [['x1', attempt('out', 'x1', 'exit', 24_000_000n)] as const] : [])]),
});
// SOL-BOOKS: the decision's notional is q in lamports ($2 at $100).
const base = { positionId: 'p1', mint: 'M', reasons: ['notional 20000000'] };

describe('ACCOUNT-RATE: a leg booked with no SOL price', () => {
  it('a winning exit booked at a restart before any price is valued at the first price after it, and does not count toward daily_loss', () => {
    const dir = tempState();
    const file = accountFile(dir);
    const before = new PaperAccount(file, usd(20), T - 10 * HOUR, 0n);
    before.price(usd(100), T - 3 * HOUR);
    before.filled({ ...base, purpose: 'entry', book: book(false), atMs: T - 2 * HOUR }, usd(100), legs(false));
    // The restart: a new process, no SOL price yet; its reconcile books the exit that landed while it was down.
    const a = new PaperAccount(file, usd(20), T - HOUR, 0n);
    a.filled({ ...base, purpose: 'exit', book: book(true), atMs: T - HOUR }, null, legs(true));
    const pending = a.state.trades[0]!;
    expect(pending.closedAtMs).toBe(T - HOUR);
    expect(pending.netPnl).toBeNull();
    // The first price, after the fill.
    expect(a.priceLate(book(true), legs(true), usd(100), T - HOUR + 5_000)).toBe(true);
    const t = a.state.trades[0]!;
    expect(t.netPnl).toBe(usd(0.4));
    expect(t.closeSolPrice).toBe(usd(100));
    expect(t.pricedLate).toEqual(['close']);
    // Nothing more to value.
    expect(a.priceLate(book(true), legs(true), usd(100), T)).toBe(false);

    const ledger = openLedger(join(dir, 'ledger.sqlite'), 'paper');
    const fact = new PaperAccount(file, usd(20), T, 0n).fact(ledger, book(true), NO_LATCHES, T, legs(true));
    const input = {
      session: startSession(TRIAL_POLICY), mode: 'paper' as const, clock: { now: () => ({ slot: 1n, txIndex: 0, ixIndex: 0, receivedAt: T }) },
      account: fact.history, latches: NO_LATCHES, market: { solBalance: fact.solBalance, regime: 'unknown' as const },
    };
    // SOL-BOOKS: risk counts the trade's lamports (24,000,000 out less 20,000,000 in), known before any price.
    expect(fact.history.closedTrades.map((x) => x.netPnl)).toEqual([4_000_000n]);
    expect(riskSnapshot(input)!.dayLoss).toBe(0n);
    const req = { mint: 'MintY', requestedNotional: usd(2), network: { priorityFee: 0n, tip: 0n, baseFee: 5_000n }, rent: { ata: 0n, oneTime: 0n } };
    expect(evaluateEntry(input, req as unknown as Parameters<typeof evaluateEntry>[1]).reasons.map((r) => r.code)).not.toContain('daily_loss');
    // What the old valuation (a total loss of the notional) did to the same account: daily_loss tripped on a win.
    const old = { ...input, account: { ...fact.history, closedTrades: fact.history.closedTrades.map((x) => ({ ...x, netPnl: -x.notional as Lamports })) } };
    expect(evaluateEntry(old, req as unknown as Parameters<typeof evaluateEntry>[1]).reasons.map((r) => r.code)).toContain('daily_loss');
    ledger.close();
  });

  it('an entry booked before any price takes the first price after it as its open rate; a later close is valued from there', () => {
    const a = new PaperAccount(accountFile(tempState()), usd(20), T - 10 * HOUR, 0n);
    a.price(usd(100), T - 3 * HOUR);
    a.filled({ ...base, purpose: 'entry', book: book(false), atMs: T - 2 * HOUR }, null, legs(false));
    expect(a.state.trades[0]!.openSolPrice).toBeNull();
    // A price from before the fill does not value it.
    expect(a.priceLate(book(false), legs(false), usd(90), T - 2 * HOUR - 1)).toBe(false);
    expect(a.priceLate(book(false), legs(false), usd(100), T - 2 * HOUR + 1)).toBe(true);
    expect(a.state.trades[0]!.openSolPrice).toBe(usd(100));
    expect(a.state.trades[0]!.pricedLate).toEqual(['open']);
    a.filled({ ...base, purpose: 'exit', book: book(true), atMs: T - HOUR }, usd(80), legs(true));
    // Entry flows at $100, exit flows at $80: −$2.00 + $1.92 = −$0.08 (the backtest's rule), not −$2 (the notional).
    expect(a.state.trades[0]!.netPnl).toBe(usd(-0.08));
    expect(a.state.trades[0]!.pricedLate).toEqual(['open']);
  });

  it('a close booked before its entry was valued takes the close price for both legs, flagged', () => {
    const a = new PaperAccount(accountFile(tempState()), usd(20), T - 10 * HOUR, 0n);
    a.price(usd(100), T - 3 * HOUR);
    a.filled({ ...base, purpose: 'entry', book: book(false), atMs: T - 2 * HOUR }, null, legs(false));
    a.filled({ ...base, purpose: 'exit', book: book(true), atMs: T - HOUR }, null, legs(true));
    expect(a.state.trades[0]!.netPnl).toBeNull();
    // A price from before the close values nothing: both legs wait for one at or after the close.
    expect(a.priceLate(book(true), legs(true), usd(100), T - HOUR - 1)).toBe(false);
    expect(a.priceLate(book(true), legs(true), usd(100), T - HOUR + 1)).toBe(true);
    expect(a.state.trades[0]!.netPnl).toBe(usd(0.4));
    expect(a.state.trades[0]!.pricedLate).toEqual(['open', 'close']);
  });
});

describe('ACCOUNT-RATE F1: an open trade\'s costs outside its basis', () => {
  // The real network: base fee and token-account rent. An open trade (entry filled yesterday) with three exit attempts
  // that landed and failed today at 500,000 lamports priority each.
  const realNet = FILL_CONFIG.network;
  // A price at which rounding matters ($123.456789).
  const PX = 123_456_789n as MicroUsd;
  const failed = (signature: string, sentAtMs: number): PaperAttempt => ({ ...attempt('out', signature, 'exit', 0n), priorityFee: 500_000n, outcome: 'failed', reason: 'failed', fill: null, sentAtMs });
  const sigs = ['f1', 'f2', 'f3'];
  const openBook = {
    positions: { p1: { id: 'p1', mint: 'M', entryIntentId: 'in', status: 'open', quantity: 1_000_000n, bought: 1_000_000n, sold: 0n, cost: 20_000_000n } },
    intents: {
      in: { intent: { id: 'in', purpose: 'entry', positionId: 'p1', mint: 'M' }, fills: [fill('in', 'e1', 20_000_000n)], attempts: [{ signature: 'e1' }] },
      out: { intent: { id: 'out', purpose: 'exit', positionId: 'p1', mint: 'M' }, fills: [], attempts: sigs.map((signature) => ({ signature })) },
    },
  } as unknown as Book;
  const openLegs: PaperLegs = {
    network: realNet, closedAccount: () => false,
    attempts: new Map([['e1', { ...attempt('in', 'e1', 'entry', 20_000_000n), sentAtMs: T - 20 * HOUR }], ...sigs.map((x, k) => [x, failed(x, T - 3 * HOUR + k * 60_000)] as const)]),
  };

  it('three landed-failed exit attempts at 500k priority count in today\'s day loss while the trade is open, in lamports; the rent counts from the entry', () => {
    const dir = tempState();
    const a = new PaperAccount(accountFile(dir), usd(20), T - 30 * HOUR, 0n);
    a.price(usd(100), T - 25 * HOUR);
    a.filled({ ...base, purpose: 'entry', book: openBook, atMs: T - 20 * HOUR }, usd(100), openLegs);
    a.settle(openBook, openLegs, usd(100), T);
    const ledger = openLedger(join(dir, 'ledger.sqlite'), 'paper');
    const fact = a.fact(ledger, openBook, NO_LATCHES, T, openLegs);
    const each = realNet.signaturesPerTx * realNet.baseFeePerSignature + 500_000n;
    // Each failed attempt dated when the account first saw it (the settle at T, after its send); the rent at the entry
    // (yesterday). SOL-BOOKS: risk counts them in lamports, exactly (the app shows them in dollars too).
    const eachUsd = each as Lamports;
    const feesUsd = 3n * eachUsd;
    const rentUsd = realNet.tokenAccountRent as Lamports;
    expect(fact.history.costs.filter((c) => c.kind === 'open_trade')).toEqual([
      ...sigs.map(() => ({ atMs: T, amount: eachUsd, kind: 'open_trade' })),
      { atMs: T - 20 * HOUR, amount: rentUsd, kind: 'open_trade' },
    ]);
    // The position marked at its basis (no price move): only these costs make the day's and week's loss.
    const marked = { ...fact.history, openPositions: fact.history.openPositions.map((x) => ({ ...x, mark: x.notional, markAtMs: T })) };
    const input = {
      session: startSession(TRIAL_POLICY), mode: 'paper' as const, clock: { now: () => ({ slot: 1n, txIndex: 0, ixIndex: 0, receivedAt: T }) },
      account: marked, latches: NO_LATCHES, market: { solBalance: fact.solBalance, regime: 'unknown' as const },
    };
    const snap = riskSnapshot(input)!;
    const sameDay = melbourneDay(T).start <= T - 20 * HOUR;
    expect(snap.dayLoss).toBeGreaterThanOrEqual(feesUsd + (sameDay ? rentUsd : 0n));
    expect(snap.weekLoss).toBeGreaterThanOrEqual(feesUsd);
    ledger.close();
  });

  it('a failed fee sent before midnight and first seen after it counts in today\'s day loss, and a restart keeps that date', () => {
    const dir = tempState();
    const file = accountFile(dir);
    const day = melbourneDay(T);
    const a = new PaperAccount(file, usd(20), day.start - 30 * HOUR, 0n);
    a.price(usd(100), day.start - 25 * HOUR);
    const late: PaperLegs = { ...openLegs, attempts: new Map([['e1', { ...attempt('in', 'e1', 'entry', 20_000_000n), sentAtMs: day.start - 20 * HOUR }], ['f1', failed('f1', day.start - HOUR)]]) };
    const b = { ...openBook, intents: { ...openBook.intents, out: { ...(openBook.intents as Record<string, object>)['out'], attempts: [{ signature: 'f1' }] } } } as unknown as Book;
    a.filled({ ...base, purpose: 'entry', book: b, atMs: day.start - 20 * HOUR }, usd(100), late);
    // Resolved (seen) after midnight.
    a.settle(b, late, usd(100), day.start + HOUR);
    // SOL-BOOKS: risk counts the fee in lamports.
    const each = (realNet.signaturesPerTx * realNet.baseFeePerSignature + 500_000n) as Lamports;
    const ledger = openLedger(join(dir, 'ledger.sqlite'), 'paper');
    const at = (acct: PaperAccount, now: number) => acct.fact(ledger, b, NO_LATCHES, now, late).history.costs.filter((c) => c.kind === 'open_trade' && c.amount === each);
    expect(at(a, T)).toEqual([{ atMs: day.start + HOUR, amount: each, kind: 'open_trade' }]);
    // A restart (a new process on the same file, later): the same date.
    expect(at(new PaperAccount(file, usd(20), T, 0n), T)).toEqual([{ atMs: day.start + HOUR, amount: each, kind: 'open_trade' }]);
    const fact = a.fact(ledger, b, NO_LATCHES, T, late);
    const marked = { ...fact.history, openPositions: fact.history.openPositions.map((x) => ({ ...x, mark: x.notional, markAtMs: T })) };
    const input = {
      session: startSession(TRIAL_POLICY), mode: 'paper' as const, clock: { now: () => ({ slot: 1n, txIndex: 0, ixIndex: 0, receivedAt: T }) },
      account: marked, latches: NO_LATCHES, market: { solBalance: fact.solBalance, regime: 'unknown' as const },
    };
    expect(riskSnapshot(input)!.dayLoss).toBeGreaterThanOrEqual(each);
    ledger.close();
  });

  it('a failed entry attempt counts once: an open-trade cost while the entry may still be retried, a stray cost once it is abandoned', () => {
    const dir = tempState();
    const a = new PaperAccount(accountFile(dir), usd(20), T - 30 * HOUR, 0n);
    a.price(usd(100), T - 25 * HOUR);
    const att: PaperAttempt = { ...failed('s', T - HOUR), intentId: 'in', purpose: 'entry' };
    const l: PaperLegs = { network: realNet, closedAccount: () => false, attempts: new Map([['s', att]]) };
    const at = (intent: string, position: string) => ({
      positions: { p1: { id: 'p1', mint: 'M', entryIntentId: 'in', status: position, quantity: 0n, bought: 0n, sold: 0n, cost: 0n } },
      intents: { in: { intent: { id: 'in', purpose: 'entry', positionId: 'p1', mint: 'M' }, status: intent, fills: [], attempts: [{ signature: 's' }] } },
    }) as unknown as Book;
    const ledger = openLedger(join(dir, 'ledger.sqlite'), 'paper');
    const kinds = (b: Book) => a.fact(ledger, b, NO_LATCHES, T, l).history.costs.map((c) => c.kind).filter((k) => k !== 'wallet_setup');
    // Reconciled with no fill: it may still be replaced, so not a stray yet; its fee has left the wallet all the same.
    const retry = at('reconciled', 'opening');
    expect(a.settle(retry, l, usd(100), T)).toBe(false);
    expect(kinds(retry)).toEqual(['open_trade']);
    // Abandoned: the position closes unfilled and the fee is a stray cost instead.
    const done = at('abandoned', 'closed');
    expect(a.settle(done, l, usd(100), T)).toBe(true);
    expect(kinds(done)).toEqual(['failed_entry']);
    ledger.close();
  });

  it('a late buy\'s position (no paper trade; it halts entries) adds no open-trade costs', () => {
    const dir = tempState();
    const a = new PaperAccount(accountFile(dir), usd(20), T - 30 * HOUR, 0n);
    a.price(usd(100), T - 25 * HOUR);
    const late = {
      positions: { 'p1.o1': { id: 'p1.o1', mint: 'M', entryIntentId: 'in', status: 'open', quantity: 1_000_000n, bought: 1_000_000n, sold: 0n, cost: 20_000_000n } },
      intents: { out: { intent: { id: 'out', purpose: 'exit', positionId: 'p1.o1', mint: 'M' }, fills: [], attempts: [{ signature: 'f1' }] } },
    } as unknown as Book;
    const ledger = openLedger(join(dir, 'ledger.sqlite'), 'paper');
    expect(a.fact(ledger, late, NO_LATCHES, T, openLegs).history.costs.filter((c) => c.kind === 'open_trade')).toEqual([]);
    ledger.close();
  });

  it('the app: an open trade\'s failed sells are network fees and its kept rent is rent, in dollars and SOL; after the close only the trade\'s own costs show them', () => {
    const dir = tempState();
    const a = new PaperAccount(accountFile(dir), usd(20), T - 30 * HOUR, 0n);
    a.price(usd(100), T - 25 * HOUR);
    a.filled({ ...base, purpose: 'entry', book: openBook, atMs: T - 20 * HOUR }, usd(100), openLegs);
    a.settle(openBook, openLegs, usd(100), T - 2 * HOUR);
    const h = makeWorker();
    const apiBase = h.worker.apiInputs();
    void h.worker.stop();
    const inputs = (b: Book, l: PaperLegs) => ({ ...apiBase, nowMs: T, solPrice: usd(100), book: b, legs: l, attempts: l.attempts, trades: a.state.trades, accountCosts: a.costRecords(b, l, usd(100), T) }) as unknown as ApiInputs;
    const kind = (i: ApiInputs, k: string) => (views.charts(i) as { costsByKind: { kind: string; amountUsd: string }[] }).costsByKind.find((x) => x.kind === k)?.amountUsd ?? '0';
    const usdText = (v: bigint) => (Number(v) / 1_000_000).toString();
    const each = realNet.signaturesPerTx * realNet.baseFeePerSignature + 500_000n;
    const fees = 3n * lamportsToMicroUsd(each as Lamports, usd(100), 'ceil');
    const rent = lamportsToMicroUsd(realNet.tokenAccountRent as Lamports, usd(100), 'ceil');
    const open = inputs(openBook, openLegs);
    expect(open.accountCosts.filter((c) => c.kind === 'open_trade').map((c) => c.part).sort()).toEqual(['fee', 'fee', 'fee', 'rent']);
    expect(kind(open, 'networkFeeUsd')).toBe(usdText(fees));
    expect(kind(open, 'rentKeptUsd')).toBe(usdText(rent));
    // In SOL: their lamports are in the account's net (no trade closed yet).
    expect((views.stats(open) as { netSol: string }).netSol).toBe(formatSolOf(-(3n * each + realNet.tokenAccountRent)));
    // Closed: no open-trade record any more, and the costs chart is the trade's own costs, once.
    const closedBook = { ...openBook, positions: { p1: { ...(openBook.positions as Record<string, object>)['p1'], status: 'closed', quantity: 0n, sold: 1_000_000n } }, intents: { ...openBook.intents, out2: { intent: { id: 'out2', purpose: 'exit', positionId: 'p1', mint: 'M' }, fills: [fill('out2', 'x1', 24_000_000n)], attempts: [{ signature: 'x1' }] } } } as unknown as Book;
    const closedLegs: PaperLegs = { ...openLegs, attempts: new Map([...openLegs.attempts, ['x1', attempt('out2', 'x1', 'exit', 24_000_000n)]]) };
    a.filled({ ...base, purpose: 'exit', book: closedBook, atMs: T - HOUR }, usd(100), closedLegs);
    const closed = inputs(closedBook, closedLegs);
    expect(closed.accountCosts.filter((c) => c.kind === 'open_trade')).toEqual([]);
    const [row] = views.trades(closed) as { costs: { totalUsd: string } }[];
    const chartTotal = (views.charts(closed) as { costsByKind: { amountUsd: string }[] }).costsByKind.reduce((x, c) => x + Math.round(Number(c.amountUsd) * 1_000_000), 0);
    expect(chartTotal).toBe(Math.round(Number(row!.costs.totalUsd) * 1_000_000));
  });

  it('a closed trade\'s costs (a failed exit, rent kept) are in its net, not counted again as open-trade costs', () => {
    const dir = tempState();
    const a = new PaperAccount(accountFile(dir), usd(20), T - 30 * HOUR, 0n);
    a.price(usd(100), T - 25 * HOUR);
    const closedBook = { ...openBook, positions: { p1: { ...(openBook.positions as Record<string, object>)['p1'], status: 'closed', quantity: 0n } }, intents: { ...openBook.intents, out2: { intent: { id: 'out2', purpose: 'exit', positionId: 'p1', mint: 'M' }, fills: [fill('out2', 'x1', 24_000_000n)], attempts: [{ signature: 'x1' }] } } } as unknown as Book;
    const closedLegs: PaperLegs = { ...openLegs, attempts: new Map([...openLegs.attempts, ['x1', attempt('out2', 'x1', 'exit', 24_000_000n)]]) };
    a.filled({ ...base, purpose: 'entry', book: openBook, atMs: T - 20 * HOUR }, usd(100), openLegs);
    const ledger = openLedger(join(dir, 'ledger.sqlite'), 'paper');
    // While open, the failed fees and rent are open-trade costs.
    expect(a.fact(ledger, openBook, NO_LATCHES, T - HOUR, openLegs).history.costs.filter((c) => c.kind === 'open_trade').length).toBeGreaterThan(0);
    a.settle(openBook, openLegs, usd(100), T - 2 * HOUR);
    expect(Object.keys(a.state.openFeesSeen ?? {}).sort()).toEqual(sigs);
    a.filled({ ...base, purpose: 'exit', book: closedBook, atMs: T - HOUR }, usd(100), closedLegs);
    expect(a.state.trades[0]!.closedAtMs).toBe(T - HOUR);
    // The first-seen notes go with the open trade (account.json stays bounded).
    a.settle(closedBook, closedLegs, usd(100), T);
    expect(a.state.openFeesSeen).toEqual({});
    expect(a.fact(ledger, closedBook, NO_LATCHES, T, closedLegs).history.costs.filter((c) => c.kind === 'open_trade')).toEqual([]);
    ledger.close();
  });
});

describe('ACCOUNT-RATE F3: a stray fee booked after midnight', () => {
  it('a failed entry sent before the Melbourne day start but booked today is dated when booked, so it counts in today\'s day loss', () => {
    const dir = tempState();
    const day = melbourneDay(T);
    const a = new PaperAccount(accountFile(dir), usd(20), day.start - 30 * HOUR, 0n);
    a.price(usd(100), day.start - 30 * HOUR);
    const sent = day.start - HOUR;
    const att: PaperAttempt = { ...attempt('i-s', 's', 'entry', 1n), trade: 'p-s', priorityFee: 10_000_000n, outcome: 'failed', reason: 'failed', fill: null, sentAtMs: sent };
    const stray = { positions: {}, intents: { 'i-s': { intent: { id: 'i-s', purpose: 'entry', positionId: 'p-s', mint: 'M' }, status: 'abandoned', fills: [], attempts: [{ signature: 's' }] } } } as unknown as Book;
    const sLegs: PaperLegs = { network: FILL_CONFIG.network, attempts: new Map([['s', att]]), closedAccount: () => false };
    // Booked today: the entry was found ended (a restart's reconcile, or a late status read) after midnight.
    expect(a.settle(stray, sLegs, usd(100), T)).toBe(true);
    const fee = FILL_CONFIG.network.signaturesPerTx * FILL_CONFIG.network.baseFeePerSignature + 10_000_000n;
    const ledger = openLedger(join(dir, 'ledger.sqlite'), 'paper');
    const fact = a.fact(ledger, stray, NO_LATCHES, T, sLegs);
    expect(fact.history.costs.filter((c) => c.kind === 'failed_entry')).toEqual([{ atMs: T, amount: fee, kind: 'failed_entry' }]);
    const input = {
      session: startSession(TRIAL_POLICY), mode: 'paper' as const, clock: { now: () => ({ slot: 1n, txIndex: 0, ixIndex: 0, receivedAt: T }) },
      account: fact.history, latches: NO_LATCHES, market: { solBalance: fact.solBalance, regime: 'unknown' as const },
    };
    expect(riskSnapshot(input)!.dayLoss).toBeGreaterThanOrEqual(fee);
    ledger.close();
  });
});

describe('ACCOUNT-RATE: no-price loss paths count the entry fees', () => {
  it('an open position is costed at its entry SOL plus entry fees, in lamports, with or without a SOL price', () => {
    const dir = tempState();
    const a = new PaperAccount(accountFile(dir), usd(20), T - 30 * HOUR, 0n);
    a.price(usd(100), T - 25 * HOUR);
    // An entry of 0.02 SOL for a $2 notional ($100 a SOL), with 15,001 lamports of fill fees.
    const feeFill = { ...fill('in', 'e1', 20_000_000n), fees: 15_001n };
    const b = {
      positions: { p1: { id: 'p1', mint: 'M', entryIntentId: 'in', status: 'open', quantity: 1_000_000n, bought: 1_000_000n, sold: 0n, cost: 20_000_000n } },
      intents: { in: { intent: { id: 'in', purpose: 'entry', positionId: 'p1', mint: 'M' }, fills: [feeFill], attempts: [{ signature: 'e1' }] } },
    } as unknown as Book;
    // The paper legs carry the fee (the entry attempt's priority): the basis risk reads comes from them.
    const feeLegs: PaperLegs = { ...legs(false), attempts: new Map([['e1', { ...attempt('in', 'e1', 'entry', 20_000_000n), priorityFee: 15_001n }]]) };
    a.filled({ ...base, purpose: 'entry', book: b, atMs: T - 2 * HOUR }, usd(100), feeLegs);
    const ledger = openLedger(join(dir, 'ledger.sqlite'), 'paper');
    const [p] = a.fact(ledger, b, NO_LATCHES, T, feeLegs).history.openPositions;
    // SOL books: 20,000,000 lamports of entry SOL plus 15,001 of fees; no dollar rate is involved.
    expect(p!.notional).toBe(20_015_001n);
    ledger.close();
  });
});

describe('ACCOUNT-RATE with RISK-PARTIAL: each entry fee counts once', () => {
  it('an entry with a failed attempt, half sold: the part\'s basis share and the open remainder\'s basis add up to entry SOL and every entry fee, once', () => {
    const net = FILL_CONFIG.network;
    const PX = 123_456_789n as MicroUsd;
    const fee = (priority: bigint, outcome: 'filled' | 'failed') => net.signaturesPerTx * net.baseFeePerSignature + priority + (outcome === 'filled' ? net.tip : 0n);
    const at = (intentId: string, signature: string, purpose: 'entry' | 'exit', sol: bigint, priorityFee: bigint, outcome: 'filled' | 'failed'): PaperAttempt => ({
      ...attempt(intentId, signature, purpose, sol), priorityFee, outcome, reason: outcome, fill: outcome === 'failed' ? null : attempt(intentId, signature, purpose, sol).fill, sentAtMs: T - 3 * HOUR,
    });
    const e0 = at('in', 'e0', 'entry', 20_000_000n, 300_000n, 'failed');
    const e1 = at('in', 'e1', 'entry', 20_000_000n, 100_000n, 'filled');
    const x1 = at('out', 'x1', 'exit', 12_000_000n, 0n, 'filled');
    const entryFill = { ...fill('in', 'e1', 20_000_000n), fees: fee(100_000n, 'filled') };
    const bookAt = (sold: bigint) => ({
      positions: { p1: { id: 'p1', mint: 'M', entryIntentId: 'in', status: 'open', quantity: 1_000_000n - sold, bought: 1_000_000n, sold, cost: 20_000_000n } },
      intents: {
        in: { intent: { id: 'in', purpose: 'entry', positionId: 'p1', mint: 'M' }, status: 'reconciled', fills: [entryFill], attempts: [{ signature: 'e0' }, { signature: 'e1' }] },
        ...(sold > 0n ? { out: { intent: { id: 'out', purpose: 'exit', positionId: 'p1', mint: 'M' }, status: 'reconciled', fills: [{ ...fill('out', 'x1', 12_000_000n), tokens: sold, fees: fee(0n, 'filled') }], attempts: [{ signature: 'x1' }] } } : {}),
      },
    }) as unknown as Book;
    const legsAt = (sold: bigint): PaperLegs => ({ network: net, closedAccount: () => false, attempts: new Map([['e0', e0], ['e1', e1], ...(sold > 0n ? [['x1', x1] as const] : [])]) });
    const dir = tempState();
    const a = new PaperAccount(accountFile(dir), usd(20), T - 30 * HOUR, 0n);
    a.price(PX, T - 25 * HOUR);
    a.filled({ ...base, purpose: 'entry', book: bookAt(0n), atMs: T - 2 * HOUR }, PX, legsAt(0n));
    a.filled({ ...base, purpose: 'exit', book: bookAt(500_000n), atMs: T - HOUR, reasons: ['partial exit'] }, PX, legsAt(500_000n));
    const t = a.state.trades[0]!;
    expect(t.partials).toHaveLength(1);
    // Entry SOL and both entry attempts' fees, the failed one included.
    const full = 20_000_000n + fee(300_000n, 'failed') + fee(100_000n, 'filled');
    const exitNet = 12_000_000n - fee(0n, 'filled');
    const soldShare = exitNet - t.partials![0]!.lamports;
    const remaining = (full * 500_000n + 1_000_000n - 1n) / 1_000_000n;
    expect(soldShare + remaining).toBe(full);
    const ledger = openLedger(join(dir, 'ledger.sqlite'), 'paper');
    const fact = a.fact(ledger, bookAt(500_000n), NO_LATCHES, T, legsAt(500_000n));
    expect(fact.history.openPositions[0]!.notional).toBe(remaining);
    // No entry fee again as an open-trade cost: only the rent the open account still holds.
    expect(fact.history.costs.filter((c) => c.kind === 'open_trade').map((c) => c.amount)).toEqual([net.tokenAccountRent]);
    ledger.close();
  });

  it('a failed sell before a partial sale is realized in that part and counted once; a failed sell after it is an open-trade cost, once', () => {
    const net = FILL_CONFIG.network;
    const PX = 123_456_789n as MicroUsd;
    const fee = (priority: bigint, outcome: 'filled' | 'failed') => net.signaturesPerTx * net.baseFeePerSignature + priority + (outcome === 'filled' ? net.tip : 0n);
    const at = (intentId: string, signature: string, purpose: 'entry' | 'exit', sol: bigint, priorityFee: bigint, outcome: 'filled' | 'failed', sentAtMs: number): PaperAttempt => ({
      ...attempt(intentId, signature, purpose, sol), priorityFee, outcome, reason: outcome, fill: outcome === 'failed' ? null : attempt(intentId, signature, purpose, sol).fill, sentAtMs,
    });
    const e1 = at('in', 'e1', 'entry', 20_000_000n, 0n, 'filled', T - 3 * HOUR);
    const f1 = at('out0', 'f1', 'exit', 0n, 500_000n, 'failed', T - 2 * HOUR);
    const x1 = at('out1', 'x1', 'exit', 9_000_000n, 0n, 'filled', T - 2 * HOUR + 60_000);
    const f2 = at('out2', 'f2', 'exit', 0n, 700_000n, 'failed', T - HOUR);
    const entryFill = { ...fill('in', 'e1', 20_000_000n), fees: fee(0n, 'filled') };
    const exitIntent = (id: string, sig: string, fills: object[]) => ({ intent: { id, purpose: 'exit', positionId: 'p1', mint: 'M' }, status: 'reconciled', fills, attempts: [{ signature: sig }] });
    const bookAt = (stage: 0 | 1 | 2) => ({
      positions: { p1: { id: 'p1', mint: 'M', entryIntentId: 'in', status: 'open', quantity: stage === 0 ? 1_000_000n : 500_000n, bought: 1_000_000n, sold: stage === 0 ? 0n : 500_000n, cost: 20_000_000n } },
      intents: {
        in: { intent: { id: 'in', purpose: 'entry', positionId: 'p1', mint: 'M' }, status: 'reconciled', fills: [entryFill], attempts: [{ signature: 'e1' }] },
        out0: exitIntent('out0', 'f1', []),
        ...(stage >= 1 ? { out1: exitIntent('out1', 'x1', [{ ...fill('out1', 'x1', 9_000_000n), tokens: 500_000n, fees: fee(0n, 'filled') }]) } : {}),
        ...(stage >= 2 ? { out2: exitIntent('out2', 'f2', []) } : {}),
      },
    }) as unknown as Book;
    const legsAt = (stage: 0 | 1 | 2): PaperLegs => ({ network: net, closedAccount: () => false, attempts: new Map([['e1', e1], ['f1', f1], ...(stage >= 1 ? [['x1', x1] as const] : []), ...(stage >= 2 ? [['f2', f2] as const] : [])]) });
    const dir = tempState();
    const a = new PaperAccount(accountFile(dir), usd(20), T - 30 * HOUR, 0n);
    a.price(PX, T - 30 * HOUR);
    a.filled({ ...base, purpose: 'entry', book: bookAt(0), atMs: T - 3 * HOUR }, PX, legsAt(0));
    a.settle(bookAt(0), legsAt(0), PX, T - 2 * HOUR);
    a.filled({ ...base, purpose: 'exit', book: bookAt(1), atMs: T - 2 * HOUR + 60_000, reasons: ['partial exit'] }, PX, legsAt(1));
    const ledger = openLedger(join(dir, 'ledger.sqlite'), 'paper');
    // SOL-BOOKS: risk counts these in lamports.
    const rentUsd = net.tokenAccountRent as Lamports;
    const openCosts = (stage: 1 | 2) => a.fact(ledger, bookAt(stage), NO_LATCHES, T, legsAt(stage)).history.costs.filter((c) => c.kind === 'open_trade').map((c) => c.amount);
    const dayLoss = (stage: 1 | 2) => {
      const fact = a.fact(ledger, bookAt(stage), NO_LATCHES, T, legsAt(stage));
      const marked = { ...fact.history, openPositions: fact.history.openPositions.map((x) => ({ ...x, mark: x.notional, markAtMs: T })) };
      return riskSnapshot({
        session: startSession(TRIAL_POLICY), mode: 'paper' as const, clock: { now: () => ({ slot: 1n, txIndex: 0, ixIndex: 0, receivedAt: T }) },
        account: marked, latches: NO_LATCHES, market: { solBalance: fact.solBalance, regime: 'unknown' as const },
      })!.dayLoss;
    };
    // F is in the part: its realized result subtracts F, and F is no open-trade cost.
    const part = a.state.trades[0]!.partials![0]!;
    const soldShare = (20_000_000n + fee(0n, 'filled')) - ((20_000_000n + fee(0n, 'filled')) * 500_000n + 1_000_000n - 1n) / 1_000_000n;
    expect(part.lamports).toBe(9_000_000n - fee(0n, 'filled') - fee(500_000n, 'failed') - soldShare);
    expect(openCosts(1)).toEqual([rentUsd]);
    // Risk's day loss: the part's realized loss (F inside it) and the rent, nothing more (the remainder marked at its basis).
    expect(dayLoss(1)).toBe(-part.lamports + rentUsd);
    // A second failed sell after the part: an open-trade cost, once.
    a.settle(bookAt(2), legsAt(2), PX, T - HOUR);
    const f2Usd = fee(700_000n, 'failed') as Lamports;
    expect(openCosts(2).sort()).toEqual([f2Usd, rentUsd].sort());
    expect(dayLoss(2)).toBe(-part.lamports + rentUsd + f2Usd);
    ledger.close();
  });
});

