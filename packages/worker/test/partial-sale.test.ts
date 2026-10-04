// RISK-PARTIAL (audit M3): a partial sale realizes its share of the cost basis and fees at once; the rest of the
// position keeps only its own share. Audit example: $20, buy $5, sell half for $3, the rest marked at $3: cash $18,
// NAV $21, and risk must not report $18 equity and a $2 daily loss. Whole-trade statistics stay per whole trade.
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { startSession, TRIAL_POLICY } from '../../core/src/config/index.ts';
import { openLedger } from '../../core/src/ledger/index.ts';
import type { Book } from '../../core/src/lifecycle/index.ts';
import { type AccountHistory, NO_LATCHES, melbourneDay, riskSnapshot } from '../../core/src/risk/index.ts';
import type { Lamports, MicroUsd } from '../../core/src/units/index.ts';
import { type IntentId, positionId } from '../../core/src/domain/index.ts';
import { OFF_CHAIN, type LogRecord } from '../../core/src/engine/index.ts';
import { type BookEvent, emptyBook } from '../../core/src/lifecycle/index.ts';
import { raw } from '../../core/src/units/index.ts';
import { attempt as fxAttempt, entryToSubmitted, fill as fx, on, quote, sig } from '../../core/test/fixtures.ts';
import { FILL_CONFIG } from '../../core/src/config/index.ts';
import type { FillNetwork } from '../../core/src/fills/index.ts';
import { PaperAccount, type PaperLegs, accountFile } from '../src/run/account.ts';
import type { PaperAttempt } from '../src/run/paper-world.ts';
import { Desk } from '../src/run/desk.ts';
import { tempState } from './worker-harness.ts';

const HOUR = 3_600_000;
// 2026-10-06 15:00 Melbourne (AEDT): a Tuesday.
const T = Date.UTC(2026, 9, 6, 4);
const usd = (x: number) => BigInt(Math.round(x * 1_000_000)) as MicroUsd;
const SOL = usd(100); // $100: 10,000,000 lamports per dollar, the opening SOL price
/** SOL-BOOKS: lamports, written as dollars at the $100 opening price. */
const lam = (x: number) => BigInt(Math.round(x * 10_000_000)) as Lamports;
const PID = 'p:MintX:1';

type Fill = { sol: bigint; fees: bigint };
/** The book as `filled` and `fact` read it: the position and its intents' fills. */
const book = (p: { quantity: bigint; sold: bigint; status: 'open' | 'closed'; bought?: bigint }, entry: Fill[], exits: Fill[][]): Book => ({
  positions: { [PID]: { id: PID, mint: 'MintX', entryIntentId: 'e', status: p.status, quantity: p.quantity, bought: p.bought ?? 1_000n, sold: p.sold, cost: entry.reduce((s, f) => s + f.sol, 0n) } },
  intents: Object.fromEntries([
    ['e', { intent: { id: 'e', positionId: PID, purpose: 'entry', mint: 'MintX' }, fills: entry.map((f, k) => ({ ...f, tokens: 1_000n, intentId: 'e', signature: `e.${k}` })), attempts: entry.map((_, k) => ({ signature: `e.${k}` })), status: 'reconciled' }],
    ...exits.map((x, i) => [`x${i}`, { intent: { id: `x${i}`, positionId: PID, purpose: 'exit', mint: 'MintX' }, fills: x.map((f, k) => ({ ...f, tokens: 500n, intentId: `x${i}`, signature: `x${i}.${k}` })), attempts: x.map((_, k) => ({ signature: `x${i}.${k}` })), status: 'reconciled' }]),
  ]),
  orphans: {},
}) as unknown as Book;

/**
 * The paper legs of that book (PAPER-1 settles from them): one landed attempt per fill, its fee the fill's (priority
 * only; no base fee, tip or rent here), so the book's fees are exactly what the account charges.
 */
const NET: FillNetwork = { ...FILL_CONFIG.network, baseFeePerSignature: 0n, tip: 0n, tokenAccountRent: 0n };
const legsOf = (b: Book): PaperLegs => ({
  network: NET, closedAccount: () => false,
  attempts: new Map(Object.values(b.intents).flatMap((i) => i.fills.map((f) => [f.signature as string, {
    intentId: i.intent.id, signature: f.signature, purpose: i.intent.purpose, trade: PID, mint: 'MintX', inAmount: 0n, quotedOut: 0n, minOut: 0n,
    priorityFee: f.fees, lastValidBlockHeight: 10n, fate: 'lands', landSlot: 1n, outcome: 'filled', reason: 'filled', landedSlot: 1n, simulated: true,
    fill: f, costs: { venueFee: 0n, creatorFee: 0n, slippage: 0n, base: 0n, priority: 0n, tip: 0n }, sentAtMs: 0,
  } as unknown as PaperAttempt] as const))),
});
const filled = (a: PaperAccount, r: Parameters<PaperAccount['filled']>[0], px: MicroUsd | null, legs = legsOf(r.book)): void => a.filled(r, px, legs);

const setup = () => {
  const dir = tempState();
  const ledger = openLedger(join(dir, 'ledger.sqlite'), 'paper');
  const a = new PaperAccount(accountFile(dir), usd(20), T - 30 * 24 * HOUR, 0n);
  a.price(SOL, T - 30 * 24 * HOUR);
  return { dir, ledger, a };
};

/** Risk's snapshot at `now`, the open position (if any) marked at `mark` dollars. */
const risk = (a: PaperAccount, ledger: ReturnType<typeof openLedger>, b: Book, now: number, mark: number | null) => {
  const fact = a.fact(ledger, b, NO_LATCHES, now, legsOf(b));
  const account: AccountHistory = { ...fact.history, openPositions: fact.history.openPositions.map((o) => ({ ...o, mark: mark === null ? null : lam(mark), markAtMs: now })) };
  return { history: account, snap: riskSnapshot({
    session: startSession(TRIAL_POLICY), mode: 'paper', clock: { now: () => ({ slot: 1n, txIndex: 0, ixIndex: 0, receivedAt: now }) },
    account, latches: NO_LATCHES, market: { solBalance: fact.solBalance, regime: 'unknown' },
  })! };
};

const entryFill = [{ sol: lam(5), fees: 0n }];

describe('partial sales (RISK-PARTIAL)', () => {
  it('the audit example: buy $5, sell half for $3, the rest marked at $3: equity $20.50, no daily loss', () => {
    const { ledger, a } = setup();
    const t0 = T - HOUR;
    filled(a, { purpose: 'entry', positionId: PID, mint: 'MintX', book: book({ quantity: 1_000n, sold: 0n, status: 'open' }, entryFill, []), atMs: t0, reasons: ['notional 50000000'] }, SOL);
    const half = book({ quantity: 500n, sold: 500n, status: 'open' }, entryFill, [[{ sol: lam(3), fees: 0n }]]);
    filled(a, { purpose: 'exit', positionId: PID, mint: 'MintX', book: half, atMs: t0 + 60_000, reasons: ['partial exit', 'take_profit'] }, SOL);
    expect(a.state.walletLamports).toBe(lam(18));
    const { history, snap } = risk(a, ledger, half, T, 3);
    // The rest carries half the basis; the sold half's $0.50 gain is realized now.
    expect(history.openPositions[0]!.notional).toBe(lam(2.5));
    expect(snap.equity).toBe(lam(20.5));
    expect(snap.dayLoss).toBe(0n);
    // SOL-BOOKS: NAV is the whole wallet (the operations floor included, as in opening equity) plus the mark.
    expect(snap.nav).toBe(lam(21));
    // No trade is closed yet: statistics see none.
    expect(history.closedTrades).toEqual([]);
    ledger.close();
  });

  it('a losing partial is realized at once: it counts toward the day loss before the trade closes', () => {
    const { ledger, a } = setup();
    filled(a, { purpose: 'entry', positionId: PID, mint: 'MintX', book: book({ quantity: 1_000n, sold: 0n, status: 'open' }, entryFill, []), atMs: T - HOUR, reasons: ['notional 50000000'] }, SOL);
    // Half sold for $2 with $0.10 of exit fees: the sold half lost $0.60.
    const half = book({ quantity: 500n, sold: 500n, status: 'open' }, entryFill, [[{ sol: lam(2), fees: lam(0.1) }]]);
    filled(a, { purpose: 'exit', positionId: PID, mint: 'MintX', book: half, atMs: T - HOUR / 2, reasons: ['partial exit'] }, SOL);
    // The rest marked at its basis: no marked loss; the realized $0.60 is the whole loss.
    const { snap } = risk(a, ledger, half, T, 2.5);
    expect(snap.equity).toBe(lam(19.4));
    expect(snap.dayLoss).toBe(lam(0.6));
    ledger.close();
  });

  it('the close books one whole trade; a partial before the day boundary stays in the day it was realized', () => {
    const { ledger, a } = setup();
    const day = melbourneDay(T).start;
    filled(a, { purpose: 'entry', positionId: PID, mint: 'MintX', book: book({ quantity: 1_000n, sold: 0n, status: 'open' }, entryFill, []), atMs: day - 2 * HOUR, reasons: ['notional 50000000'] }, SOL);
    // Yesterday: half sold for $3 (+$0.50). Today: the rest sold for $2 (-$0.50). The whole trade: $0.
    const s1 = [{ sol: lam(3), fees: 0n }];
    filled(a, { purpose: 'exit', positionId: PID, mint: 'MintX', book: book({ quantity: 500n, sold: 500n, status: 'open' }, entryFill, [s1]), atMs: day - HOUR, reasons: ['partial exit'] }, SOL);
    const closed = book({ quantity: 0n, sold: 1_000n, status: 'closed' }, entryFill, [s1, [{ sol: lam(2), fees: 0n }]]);
    filled(a, { purpose: 'exit', positionId: PID, mint: 'MintX', book: closed, atMs: T - HOUR, reasons: ['stop'] }, SOL);
    const { history, snap } = risk(a, ledger, closed, T, null);
    expect(history.closedTrades).toHaveLength(1);
    expect(history.closedTrades[0]).toMatchObject({ netPnl: 0n, notional: lam(5), stoppedOut: true });
    expect(snap.equity).toBe(lam(20));
    // Today's loss is the second half's $0.50 alone: yesterday's gain is not taken back into today.
    expect(snap.dayLoss).toBe(lam(0.5));
    ledger.close();
  });

  it('entry fees are allocated with the basis, each sale realizes only its own share and proceeds', () => {
    const { ledger, a } = setup();
    // $5 plus $0.10 of entry fees: a basis of $5.10.
    const entry = [{ sol: lam(5), fees: lam(0.1) }];
    filled(a, { purpose: 'entry', positionId: PID, mint: 'MintX', book: book({ quantity: 1_000n, sold: 0n, status: 'open' }, entry, []), atMs: T - 3 * HOUR, reasons: ['notional 50000000'] }, SOL);
    // A quarter for $2 (its share $1.275: +$0.725), then another quarter for $1 (-$0.275).
    const s1 = [{ sol: lam(2), fees: 0n }];
    filled(a, { purpose: 'exit', positionId: PID, mint: 'MintX', book: book({ quantity: 750n, sold: 250n, status: 'open' }, entry, [s1]), atMs: T - 2 * HOUR, reasons: ['partial exit'] }, SOL);
    const second = book({ quantity: 500n, sold: 500n, status: 'open' }, entry, [s1, [{ sol: lam(1), fees: 0n }]]);
    filled(a, { purpose: 'exit', positionId: PID, mint: 'MintX', book: second, atMs: T - HOUR, reasons: ['partial exit'] }, SOL);
    expect(a.state.trades[0]!.partials!.map((x) => x.lamports)).toEqual([lam(0.725), -lam(0.275)]);
    const { history } = risk(a, ledger, second, T, 2.55);
    expect(history.openPositions[0]!.notional).toBe(lam(2.55));
    ledger.close();
  });

  it('what is still held keeps its share of the basis rounded up', () => {
    const { ledger, a } = setup();
    const entry = [{ sol: 100n, fees: 0n }];
    filled(a, { purpose: 'entry', positionId: PID, mint: 'MintX', book: book({ quantity: 3n, sold: 0n, status: 'open', bought: 3n }, entry, []), atMs: T - HOUR, reasons: ['notional 1'] }, SOL);
    filled(a, { purpose: 'exit', positionId: PID, mint: 'MintX', book: book({ quantity: 2n, sold: 1n, status: 'open', bought: 3n }, entry, [[{ sol: 50n, fees: 0n }]]), atMs: T - HOUR / 2, reasons: ['partial exit'] }, SOL);
    // Two thirds of 100 lamports stay held as 67; the sold third carries 33 and realized 17.
    expect(a.state.trades[0]!.partials![0]!.lamports).toBe(17n);
    ledger.close();
  });

  it('a fill booked again adds no part; a loss of one lamport is one lamport', () => {
    const { ledger, a } = setup();
    const entry = [{ sol: 100n, fees: 0n }];
    filled(a, { purpose: 'entry', positionId: PID, mint: 'MintX', book: book({ quantity: 2n, sold: 0n, status: 'open', bought: 2n }, entry, []), atMs: T - HOUR, reasons: ['notional 1'] }, SOL);
    // Half for 49 lamports: one lamport lost.
    const half = book({ quantity: 1n, sold: 1n, status: 'open', bought: 2n }, entry, [[{ sol: 49n, fees: 0n }]]);
    filled(a, { purpose: 'exit', positionId: PID, mint: 'MintX', book: half, atMs: T - HOUR / 2, reasons: ['partial exit'] }, SOL);
    filled(a, { purpose: 'exit', positionId: PID, mint: 'MintX', book: half, atMs: T - HOUR / 4, reasons: ['partial exit'] }, SOL);
    expect(a.state.trades[0]!.partials).toEqual([{ atMs: T - HOUR / 2, lamports: -1n }]);
    ledger.close();
  });

  it('SOL-BOOKS: a part is its lamports and needs no SOL price; the same sale books the same part with or without one', () => {
    const half = book({ quantity: 500n, sold: 500n, status: 'open' }, entryFill, [[{ sol: lam(1), fees: 0n }]]);
    const open = book({ quantity: 1_000n, sold: 0n, status: 'open' }, entryFill, []);
    const parts = (price: typeof SOL | null) => {
      const x = setup();
      filled(x.a, { purpose: 'entry', positionId: PID, mint: 'MintX', book: open, atMs: T - HOUR, reasons: ['notional 50000000'] }, price);
      filled(x.a, { purpose: 'exit', positionId: PID, mint: 'MintX', book: half, atMs: T - HOUR / 2, reasons: ['partial exit'] }, price);
      const out = { parts: x.a.state.trades[0]!.partials, held: x.a.fact(x.ledger, half, NO_LATCHES, T, legsOf(half)).history.openPositions[0]!.notional };
      x.ledger.close();
      return out;
    };
    // Half of a 5-SOL-dollar position sold for 1: a loss of 1.5 in lamports, the rest keeps its 2.5 of basis.
    expect(parts(SOL)).toEqual({ parts: [{ atMs: T - HOUR / 2, lamports: -lam(1.5) }], held: lam(2.5) });
    expect(parts(null)).toEqual(parts(SOL));
  });

  it('a part sold at a loss counts its share of the entry and its entry fees, in lamports, the held rest rounded up', () => {
    const { ledger, a } = setup();
    // 5 SOL-dollars of SOL and 0.20 of entry fees; half sold for 1.
    const fees = [{ sol: lam(5), fees: lam(0.2) }];
    filled(a, { purpose: 'entry', positionId: PID, mint: 'MintX', book: book({ quantity: 1_000n, sold: 0n, status: 'open' }, fees, []), atMs: T - HOUR, reasons: ['notional 50000000'] }, null);
    filled(a, { purpose: 'exit', positionId: PID, mint: 'MintX', book: book({ quantity: 500n, sold: 500n, status: 'open' }, fees, [[{ sol: lam(1), fees: 0n }]]), atMs: T - HOUR / 2, reasons: ['partial exit'] }, null);
    expect(a.state.trades[0]!.partials![0]!.lamports).toBe(lam(1) - lam(2.6));
    // A third sold: the held two thirds keep 34,666,667 of the 52,000,000 basis (rounded up); the third carries 17,333,333.
    const b = setup();
    const third = [{ sol: lam(5), fees: lam(0.2) }];
    filled(b.a, { purpose: 'entry', positionId: PID, mint: 'MintX', book: book({ quantity: 999n, sold: 0n, status: 'open', bought: 999n }, third, []), atMs: T - HOUR, reasons: ['notional 50000000'] }, null);
    filled(b.a, { purpose: 'exit', positionId: PID, mint: 'MintX', book: book({ quantity: 666n, sold: 333n, status: 'open', bought: 999n }, third, [[{ sol: lam(0.1), fees: 0n }]]), atMs: T - HOUR / 2, reasons: ['partial exit'] }, null);
    expect(b.a.state.trades[0]!.partials![0]!.lamports).toBe(lam(0.1) - 17_333_333n);
    ledger.close();
    b.ledger.close();
  });
});

describe('a partial sale settles as paper does (merge of #132 into PAPER-1)', () => {
  it('a failed sell before the partial: its fee is part of what the partial realized, as the close would count it', () => {
    const { ledger, a } = setup();
    const open = book({ quantity: 1_000n, sold: 0n, status: 'open' }, entryFill, []);
    filled(a, { purpose: 'entry', positionId: PID, mint: 'MintX', book: open, atMs: T - HOUR, reasons: ['notional 50000000'] }, SOL);
    // Half sold for $3; before it, an attempt of the same exit landed failed and paid 1,000,000 lamports ($0.10).
    const half = book({ quantity: 500n, sold: 500n, status: 'open' }, entryFill, [[{ sol: lam(3), fees: 0n }]]);
    const legs = legsOf(half);
    const failed = { ...[...legs.attempts.values()].find((x) => x.purpose === 'exit')!, signature: 'x0.failed', outcome: 'failed', reason: 'landed failed (drawn)', fill: null, priorityFee: lam(0.1) } as PaperAttempt;
    filled(a, { purpose: 'exit', positionId: PID, mint: 'MintX', book: half, atMs: T - HOUR / 2, reasons: ['partial exit'] }, SOL, { ...legs, attempts: new Map([...legs.attempts, [failed.signature, failed]]) });
    // $3 − $2.50 of basis − $0.10 of the failed attempt: +$0.40, not +$0.50.
    expect(a.state.trades[0]!.partials!.map((x) => x.lamports)).toEqual([lam(0.4)]);
    expect(a.state.walletLamports).toBe(lam(20) - lam(5) + lam(3) - lam(0.1));
    ledger.close();
  });
});

describe('a late-landing sell after a partial books its part when it lands (risk review of #132)', () => {
  it('an exit\'s sell booked by orphan_fill on day D books its part at D; the close on D+1 shows only its own result', () => {
    const { dir, a } = setup();
    // A backtest ledger takes the reservation as an event (as the PAPER-1 orphan test does).
    const ledger = openLedger(join(dir, 'desk.sqlite'), 'backtest');
    const desk = new Desk({
      ledger, config: { maxOpenPositions: 5 }, restored: emptyBook({ maxOpenPositions: 5 }),
      journal: () => undefined, report: () => 'world#unused', accountChanged: () => undefined, intentsChanged: () => undefined,
      reserved: () => undefined, diverged: () => undefined, lateBuy: () => undefined, filled: (r) => filled(a, r, SOL),
    });
    const E1 = 'e1' as IntentId;
    const P = positionId('p1');
    const status = (id: IntentId, n: number, result: 'succeeded' | 'not_found', h: bigint) =>
      on(id, { type: 'status', signature: sig(n), result, commitment: result === 'succeeded' ? 'finalized' : null, blockHeight: h, searchedHistory: true });
    const exit = (id: IntentId, n: number, tokens: bigint): BookEvent[] => [
      { type: 'trigger_exit', positionId: P, reasons: ['take_profit'], intentId: id, quantity: raw(tokens) },
      on(id, { type: 'prepare', quote }),
      on(id, { type: 'sign', attempt: fxAttempt(id, n, 2_500n) }),
      on(id, { type: 'submit' }),
    ];
    const X1 = 'x1' as IntentId;
    const X2 = 'x2' as IntentId;
    const X3 = 'x3' as IntentId;
    // Day D: 1,000 tokens bought for 16,000,000 lamports (+10,000 fees); 500 sold for 9,000,000; then 250 more are
    // sold for 6,000,000 by an exit that expired unseen and ended, its sell found landed afterwards (orphan_fill).
    const dayD: BookEvent[] = [
      ...entryToSubmitted(1, 1_000n),
      status(E1, 1, 'succeeded', 900n),
      on(E1, { type: 'reconcile', fills: [fx(E1, 1, 1_000n)], blockHeight: 900n }),
      ...exit(X1, 11, 500n),
      status(X1, 11, 'succeeded', 2_400n),
      on(X1, { type: 'reconcile', fills: [fx(X1, 11, 500n, 9_000_000n)], blockHeight: 2_400n }),
      ...exit(X2, 12, 250n),
      status(X2, 12, 'not_found', 2_501n),
      on(X2, { type: 'reconcile', fills: [], blockHeight: 2_501n }),
      on(X2, { type: 'abandon' }),
      status(X2, 12, 'succeeded', 2_600n),
      { type: 'orphan_fill', fill: fx(X2, 12, 250n, 6_000_000n) },
    ];
    // Day D+1: the last 250 sold for 3,990,000 net of its fee... (4,000,000 less 10,000).
    const dayD1: BookEvent[] = [...exit(X3, 13, 250n), status(X3, 13, 'succeeded', 2_400n), on(X3, { type: 'reconcile', fills: [fx(X3, 13, 250n, 4_000_000n)], blockHeight: 2_400n })];
    const feed = (events: BookEvent[], at: number, from: number) => desk.consume(events.map((event, k) => ({ type: 'world', seq: from + k, at: { slot: 1n, txIndex: OFF_CHAIN, ixIndex: 0, receivedAt: at }, eventId: `w${from + k}`, event, result: 'applied', effects: [] }) as unknown as LogRecord));
    const D = T;
    const D1 = T + 24 * HOUR;
    expect(melbourneDay(D1).start).toBeGreaterThan(D);
    feed(dayD, D, 0);
    expect(desk.illegal + desk.ledgerRefusals).toBe(0);
    expect(desk.book.positions[P]?.status).toBe('open');
    const t = () => a.state.trades.find((x) => x.positionId === 'p1')!;
    // Both parts are booked at D, the late one with its own share of the basis (16,010,000 for 1,000 tokens).
    const basis = 16_010_000n;
    const left = (n: bigint) => (basis * n + 999n) / 1_000n;
    expect(t().partials!.map((x) => x.atMs)).toEqual([D, D]);
    expect(t().partials![1]!.lamports).toBe((6_000_000n - 10_000n) - (left(500n) - left(250n)));
    feed(dayD1, D1, dayD.length);
    expect(desk.illegal + desk.ledgerRefusals).toBe(0);
    expect(t().closedAtMs).toBe(D1);
    // What D+1 realizes is the last 250 tokens' result alone: a small loss, no gain carried over from day D's sale.
    const last = (4_000_000n - 10_000n) - left(250n);
    expect(last < 0n).toBe(true);
    // SOL-BOOKS: what risk realizes at D+1 is the whole trade's lamports less the parts already booked.
    const atD1 = t().netLamports! - t().partials!.reduce((s, x) => s + x.lamports, 0n);
    expect(atD1).toBe(last);
    ledger.close();
  });

  it('a late-landing buy (an entry\'s orphan_fill) opens its own position and is not booked as a paper trade', () => {
    const ledger = openLedger(join(tempState(), 'desk.sqlite'), 'backtest');
    const filled: string[] = [];
    const desk = new Desk({
      ledger, config: { maxOpenPositions: 5 }, restored: emptyBook({ maxOpenPositions: 5 }),
      journal: () => undefined, report: () => 'world#unused', accountChanged: () => undefined, intentsChanged: () => undefined,
      reserved: () => undefined, diverged: () => undefined, lateBuy: () => undefined, filled: (r) => void filled.push(`${r.purpose} ${r.positionId}`),
    });
    const E1 = 'e1' as IntentId;
    const events: BookEvent[] = [
      ...entryToSubmitted(1, 1_000n),
      on(E1, { type: 'status', signature: sig(1), result: 'not_found', commitment: null, blockHeight: 1_001n, searchedHistory: true }),
      on(E1, { type: 'reconcile', fills: [], blockHeight: 1_001n }),
      on(E1, { type: 'abandon' }),
      on(E1, { type: 'status', signature: sig(1), result: 'succeeded', commitment: 'finalized', blockHeight: 1_100n, searchedHistory: true }),
      { type: 'orphan_fill', fill: fx(E1, 1, 1_000n) },
    ];
    desk.consume(events.map((event, seq) => ({ type: 'world', seq, at: { slot: 1n, txIndex: OFF_CHAIN, ixIndex: 0, receivedAt: T }, eventId: `w${seq}`, event, result: 'applied', effects: [] }) as unknown as LogRecord));
    expect(desk.illegal + desk.ledgerRefusals).toBe(0);
    expect(Object.values(desk.book.positions).some((x) => x.status === 'open')).toBe(true);
    expect(filled).toEqual([]);
    ledger.close();
  });
});
