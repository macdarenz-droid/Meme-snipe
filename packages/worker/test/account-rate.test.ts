// ACCOUNT-RATE (golden rule: paper money is real money). A fill booked while no SOL price is known (a fill a restart's
// reconcile finds) was valued as a total loss of its notional: a winning exit then counted toward daily_loss and could
// halt entries. Now the leg stays unvalued until the first SOL price at or after its fill values it, flagged.
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FILL_CONFIG, TRIAL_POLICY, startSession } from '../../core/src/config/index.ts';
import { openLedger } from '../../core/src/ledger/index.ts';
import type { Book } from '../../core/src/lifecycle/index.ts';
import { NO_LATCHES, evaluateEntry, riskSnapshot } from '../../core/src/risk/index.ts';
import type { MicroUsd } from '../../core/src/units/index.ts';
import { PaperAccount, type PaperLegs, accountFile } from '../src/run/account.ts';
import type { PaperAttempt } from '../src/run/paper-world.ts';
import { tempState } from './worker-harness.ts';

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
const base = { positionId: 'p1', mint: 'M', reasons: ['notional 2000000'] };

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
    const fact = new PaperAccount(file, usd(20), T, 0n).fact(ledger, book(true), NO_LATCHES, usd(100), T);
    const input = {
      session: startSession(TRIAL_POLICY), mode: 'paper' as const, clock: { now: () => ({ slot: 1n, txIndex: 0, ixIndex: 0, receivedAt: T }) },
      account: fact.history, latches: NO_LATCHES, market: { solPrice: { value: usd(100), atMs: T }, solBalance: fact.solBalance, regime: 'unknown' as const },
    };
    expect(fact.history.closedTrades.map((x) => x.netPnl)).toEqual([usd(0.4)]);
    expect(riskSnapshot(input)!.dayLoss).toBe(0n);
    const req = { mint: 'MintY', requestedNotional: usd(2), network: { priorityFee: 0n, tip: 0n, baseFee: 5_000n }, rent: { ata: 0n, oneTime: 0n } };
    expect(evaluateEntry(input, req as unknown as Parameters<typeof evaluateEntry>[1]).reasons.map((r) => r.code)).not.toContain('daily_loss');
    // What the old valuation (a total loss of the notional) did to the same account: daily_loss tripped on a win.
    const old = { ...input, account: { ...fact.history, closedTrades: fact.history.closedTrades.map((x) => ({ ...x, netPnl: -x.notional as MicroUsd })) } };
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
