// RISK-PARTIAL (audit M3): a partial sale realizes its share of the cost basis and fees at once; the rest of the
// position keeps only its own share. Audit example: $20, buy $5, sell half for $3, the rest marked at $3: cash $18,
// NAV $21, and risk must not report $18 equity and a $2 daily loss. Whole-trade statistics stay per whole trade.
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { startSession, TRIAL_POLICY } from '../../core/src/config/index.ts';
import { openLedger } from '../../core/src/ledger/index.ts';
import type { Book } from '../../core/src/lifecycle/index.ts';
import { type AccountHistory, NO_LATCHES, melbourneDay, riskSnapshot } from '../../core/src/risk/index.ts';
import type { MicroUsd } from '../../core/src/units/index.ts';
import { PaperAccount, accountFile } from '../src/run/account.ts';
import { tempState } from './worker-harness.ts';

const HOUR = 3_600_000;
// 2026-10-06 15:00 Melbourne (AEDT): a Tuesday.
const T = Date.UTC(2026, 9, 6, 4);
const usd = (x: number) => BigInt(Math.round(x * 1_000_000)) as MicroUsd;
const SOL = usd(100); // $100: 10,000,000 lamports per dollar
const lam = (x: number) => BigInt(Math.round(x * 10_000_000));
const PID = 'p:MintX:1';

type Fill = { sol: bigint; fees: bigint };
/** The book as `filled` and `fact` read it: the position and its intents' fills. */
const book = (p: { quantity: bigint; sold: bigint; status: 'open' | 'closed'; bought?: bigint }, entry: Fill[], exits: Fill[][]): Book => ({
  positions: { [PID]: { id: PID, mint: 'MintX', status: p.status, quantity: p.quantity, bought: p.bought ?? 1_000n, sold: p.sold, cost: entry.reduce((s, f) => s + f.sol, 0n) } },
  intents: Object.fromEntries([
    ['e', { intent: { positionId: PID, purpose: 'entry', mint: 'MintX' }, fills: entry.map((f) => ({ ...f, tokens: 1_000n })), status: 'reconciled' }],
    ...exits.map((x, i) => [`x${i}`, { intent: { positionId: PID, purpose: 'exit', mint: 'MintX' }, fills: x.map((f) => ({ ...f, tokens: 500n })), status: 'reconciled' }]),
  ]),
}) as unknown as Book;

const setup = () => {
  const dir = tempState();
  const ledger = openLedger(join(dir, 'ledger.sqlite'), 'paper');
  const a = new PaperAccount(accountFile(dir), usd(20), T - 30 * 24 * HOUR, 0n);
  a.price(SOL, T - 30 * 24 * HOUR);
  return { dir, ledger, a };
};

/** Risk's snapshot at `now`, the open position (if any) marked at `mark` dollars. */
const risk = (a: PaperAccount, ledger: ReturnType<typeof openLedger>, b: Book, now: number, mark: number | null) => {
  const fact = a.fact(ledger, b, NO_LATCHES, SOL, now);
  const account: AccountHistory = { ...fact.history, openPositions: fact.history.openPositions.map((o) => ({ ...o, mark: mark === null ? null : usd(mark), markAtMs: now })) };
  return { history: account, snap: riskSnapshot({
    session: startSession(TRIAL_POLICY), mode: 'paper', clock: { now: () => ({ slot: 1n, txIndex: 0, ixIndex: 0, receivedAt: now }) },
    account, latches: NO_LATCHES, market: { solPrice: { value: SOL, atMs: now }, solBalance: fact.solBalance, regime: 'unknown' },
  })! };
};

const entryFill = [{ sol: lam(5), fees: 0n }];

describe('partial sales (RISK-PARTIAL)', () => {
  it('the audit example: buy $5, sell half for $3, the rest marked at $3: equity $20.50, no daily loss', () => {
    const { ledger, a } = setup();
    const t0 = T - HOUR;
    a.filled({ purpose: 'entry', positionId: PID, mint: 'MintX', book: book({ quantity: 1_000n, sold: 0n, status: 'open' }, entryFill, []), atMs: t0, reasons: ['notional 5000000'] }, SOL);
    const half = book({ quantity: 500n, sold: 500n, status: 'open' }, entryFill, [[{ sol: lam(3), fees: 0n }]]);
    a.filled({ purpose: 'exit', positionId: PID, mint: 'MintX', book: half, atMs: t0 + 60_000, reasons: ['partial exit', 'take_profit'] }, SOL);
    expect(a.state.walletLamports).toBe(lam(18));
    const { history, snap } = risk(a, ledger, half, T, 3);
    // The rest carries half the basis; the sold half's $0.50 gain is realized now.
    expect(history.openPositions[0]!.notional).toBe(usd(2.5));
    expect(snap.equity).toBe(usd(20.5));
    expect(snap.dayLoss).toBe(0n);
    expect(snap.nav).toBe(usd(21) - usd(Number(TRIAL_POLICY.reserve.opsFloor) / 10_000_000));
    // No trade is closed yet: statistics see none.
    expect(history.closedTrades).toEqual([]);
    ledger.close();
  });

  it('a losing partial is realized at once: it counts toward the day loss before the trade closes', () => {
    const { ledger, a } = setup();
    a.filled({ purpose: 'entry', positionId: PID, mint: 'MintX', book: book({ quantity: 1_000n, sold: 0n, status: 'open' }, entryFill, []), atMs: T - HOUR, reasons: ['notional 5000000'] }, SOL);
    // Half sold for $2 with $0.10 of exit fees: the sold half lost $0.60.
    const half = book({ quantity: 500n, sold: 500n, status: 'open' }, entryFill, [[{ sol: lam(2), fees: lam(0.1) }]]);
    a.filled({ purpose: 'exit', positionId: PID, mint: 'MintX', book: half, atMs: T - HOUR / 2, reasons: ['partial exit'] }, SOL);
    // The rest marked at its basis: no marked loss; the realized $0.60 is the whole loss.
    const { snap } = risk(a, ledger, half, T, 2.5);
    expect(snap.equity).toBe(usd(19.4));
    expect(snap.dayLoss).toBe(usd(0.6));
    ledger.close();
  });

  it('the close books one whole trade; a partial before the day boundary stays in the day it was realized', () => {
    const { ledger, a } = setup();
    const day = melbourneDay(T).start;
    a.filled({ purpose: 'entry', positionId: PID, mint: 'MintX', book: book({ quantity: 1_000n, sold: 0n, status: 'open' }, entryFill, []), atMs: day - 2 * HOUR, reasons: ['notional 5000000'] }, SOL);
    // Yesterday: half sold for $3 (+$0.50). Today: the rest sold for $2 (-$0.50). The whole trade: $0.
    const s1 = [{ sol: lam(3), fees: 0n }];
    a.filled({ purpose: 'exit', positionId: PID, mint: 'MintX', book: book({ quantity: 500n, sold: 500n, status: 'open' }, entryFill, [s1]), atMs: day - HOUR, reasons: ['partial exit'] }, SOL);
    const closed = book({ quantity: 0n, sold: 1_000n, status: 'closed' }, entryFill, [s1, [{ sol: lam(2), fees: 0n }]]);
    a.filled({ purpose: 'exit', positionId: PID, mint: 'MintX', book: closed, atMs: T - HOUR, reasons: ['stop'] }, SOL);
    const { history, snap } = risk(a, ledger, closed, T, null);
    expect(history.closedTrades).toHaveLength(1);
    expect(history.closedTrades[0]).toMatchObject({ netPnl: 0n, notional: usd(5), stoppedOut: true });
    expect(snap.equity).toBe(usd(20));
    // Today's loss is the second half's $0.50 alone: yesterday's gain is not taken back into today.
    expect(snap.dayLoss).toBe(usd(0.5));
    ledger.close();
  });

  it('entry fees are allocated with the basis, each sale realizes only its own share and proceeds', () => {
    const { ledger, a } = setup();
    // $5 plus $0.10 of entry fees: a basis of $5.10.
    const entry = [{ sol: lam(5), fees: lam(0.1) }];
    a.filled({ purpose: 'entry', positionId: PID, mint: 'MintX', book: book({ quantity: 1_000n, sold: 0n, status: 'open' }, entry, []), atMs: T - 3 * HOUR, reasons: ['notional 5000000'] }, SOL);
    // A quarter for $2 (its share $1.275: +$0.725), then another quarter for $1 (-$0.275).
    const s1 = [{ sol: lam(2), fees: 0n }];
    a.filled({ purpose: 'exit', positionId: PID, mint: 'MintX', book: book({ quantity: 750n, sold: 250n, status: 'open' }, entry, [s1]), atMs: T - 2 * HOUR, reasons: ['partial exit'] }, SOL);
    const second = book({ quantity: 500n, sold: 500n, status: 'open' }, entry, [s1, [{ sol: lam(1), fees: 0n }]]);
    a.filled({ purpose: 'exit', positionId: PID, mint: 'MintX', book: second, atMs: T - HOUR, reasons: ['partial exit'] }, SOL);
    expect(a.state.trades[0]!.partials!.map((x) => x.pnl)).toEqual([usd(0.725), -usd(0.275)]);
    const { history } = risk(a, ledger, second, T, 2.55);
    expect(history.openPositions[0]!.notional).toBe(usd(2.55));
    ledger.close();
  });

  it('what is still held keeps its share of the basis rounded up', () => {
    const { ledger, a } = setup();
    const entry = [{ sol: 100n, fees: 0n }];
    a.filled({ purpose: 'entry', positionId: PID, mint: 'MintX', book: book({ quantity: 3n, sold: 0n, status: 'open', bought: 3n }, entry, []), atMs: T - HOUR, reasons: ['notional 1'] }, SOL);
    a.filled({ purpose: 'exit', positionId: PID, mint: 'MintX', book: book({ quantity: 2n, sold: 1n, status: 'open', bought: 3n }, entry, [[{ sol: 50n, fees: 0n }]]), atMs: T - HOUR / 2, reasons: ['partial exit'] }, SOL);
    // Two thirds of 100 lamports stay held as 67; the sold third carries 33 and realized 17.
    expect(a.state.trades[0]!.partials![0]!.lamports).toBe(17n);
    ledger.close();
  });

  it('a fill booked again adds no part; a loss rounds up to the next micro-dollar', () => {
    const { ledger, a } = setup();
    const entry = [{ sol: 100n, fees: 0n }];
    a.filled({ purpose: 'entry', positionId: PID, mint: 'MintX', book: book({ quantity: 2n, sold: 0n, status: 'open', bought: 2n }, entry, []), atMs: T - HOUR, reasons: ['notional 1'] }, SOL);
    // Half for 49 lamports: one lamport lost, $0.0000001, booked as -1 micro-dollar.
    const half = book({ quantity: 1n, sold: 1n, status: 'open', bought: 2n }, entry, [[{ sol: 49n, fees: 0n }]]);
    a.filled({ purpose: 'exit', positionId: PID, mint: 'MintX', book: half, atMs: T - HOUR / 2, reasons: ['partial exit'] }, SOL);
    a.filled({ purpose: 'exit', positionId: PID, mint: 'MintX', book: half, atMs: T - HOUR / 4, reasons: ['partial exit'] }, SOL);
    expect(a.state.trades[0]!.partials).toEqual([{ atMs: T - HOUR / 2, lamports: -1n, pnl: -1n }]);
    ledger.close();
  });

  it('no SOL price at the sale: valued at the open\'s; no price at all: a gain counts as nothing, a loss as its whole share', () => {
    const half = book({ quantity: 500n, sold: 500n, status: 'open' }, entryFill, [[{ sol: lam(3), fees: 0n }]]);
    const open = book({ quantity: 1_000n, sold: 0n, status: 'open' }, entryFill, []);
    const x = setup();
    x.a.filled({ purpose: 'entry', positionId: PID, mint: 'MintX', book: open, atMs: T - HOUR, reasons: ['notional 5000000'] }, SOL);
    x.a.filled({ purpose: 'exit', positionId: PID, mint: 'MintX', book: half, atMs: T - HOUR / 2, reasons: ['partial exit'] }, null);
    expect(x.a.state.trades[0]!.partials![0]!.pnl).toBe(usd(0.5));
    // With no price the rest keeps its share of the dollar notional.
    expect(x.a.fact(x.ledger, half, NO_LATCHES, null, T).history.openPositions[0]!.notional).toBe(usd(2.5));
    x.ledger.close();
    const y = setup();
    y.a.filled({ purpose: 'entry', positionId: PID, mint: 'MintX', book: open, atMs: T - HOUR, reasons: ['notional 5000000'] }, null);
    y.a.filled({ purpose: 'exit', positionId: PID, mint: 'MintX', book: half, atMs: T - HOUR / 2, reasons: ['partial exit'] }, null);
    const lost = book({ quantity: 250n, sold: 750n, status: 'open' }, entryFill, [[{ sol: lam(3), fees: 0n }], [{ sol: lam(0.5), fees: 0n }]]);
    y.a.filled({ purpose: 'exit', positionId: PID, mint: 'MintX', book: lost, atMs: T - HOUR / 4, reasons: ['partial exit'] }, null);
    expect(y.a.state.trades[0]!.partials!.map((p) => p.pnl)).toEqual([0n, -usd(1.25)]);
    y.ledger.close();
  });
});
