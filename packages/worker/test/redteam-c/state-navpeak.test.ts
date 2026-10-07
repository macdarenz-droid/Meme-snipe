// RED TEAM C: R10's NAV high-water mark lives in account.json (navPeak, stamped with the worker's clock). When the
// clock steps back a little (NTP), the peak is dated "in the future" and account.fact() silently drops it: R10 then
// measures the kill line from the opening equity and an entry is allowed while NAV is far below 70% of its peak.
// Every other history time in the future refuses entries (bankroll_invalid); this one fails open.
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { startSession, TRIAL_POLICY } from '../../../core/src/config/index.ts';
import { openLedger } from '../../../core/src/ledger/index.ts';
import { emptyBook } from '../../../core/src/lifecycle/index.ts';
import { NO_LATCHES, evaluateEntry } from '../../../core/src/risk/index.ts';
import type { MicroUsd } from '../../../core/src/units/index.ts';
import { PaperAccount, accountFile } from '../../src/run/account.ts';
import { tempState } from '../worker-harness.ts';

const HOUR = 3_600_000;
const T = Date.UTC(2026, 9, 6, 4);
const usd = (x: number) => BigInt(Math.round(x * 1_000_000)) as MicroUsd;
const PRICE = usd(150);

const codesAt = (a: PaperAccount, ledger: ReturnType<typeof openLedger>, nowMs: number): string[] => {
  const fact = a.fact(ledger, emptyBook({ maxOpenPositions: 5 }), NO_LATCHES, PRICE, nowMs);
  const input = {
    session: startSession(TRIAL_POLICY), mode: 'paper' as const, clock: { now: () => ({ slot: 1n, txIndex: 0, ixIndex: 0, receivedAt: nowMs }) },
    account: fact.history, latches: NO_LATCHES, market: { solPrice: { value: PRICE, atMs: nowMs }, solBalance: fact.solBalance, regime: 'unknown' as const },
  };
  const req = { mint: 'MintY', requestedNotional: usd(2), network: { priorityFee: 0n, tip: 0n, baseFee: 5_000n }, rent: { ata: 0n, oneTime: 0n } };
  return evaluateEntry(input, req as unknown as Parameters<typeof evaluateEntry>[1]).reasons.map((r) => r.code);
};

describe('red team C: NAV peak and a clock stepped back', () => {
  it('R10 still refuses (kill_switch or bankroll_invalid) when the clock reads 1 s before the recorded NAV peak', () => {
    const dir = tempState();
    const ledger = openLedger(join(dir, 'ledger.sqlite'), 'paper');
    const file = accountFile(dir);
    const a0 = new PaperAccount(file, usd(20), T - 10 * HOUR, 0n);
    a0.price(PRICE, T - 10 * HOUR);
    // The NAV peaked at $30 at T (a winning open position, since sold at a loss back to the bankroll).
    a0.mark({ dayStartMs: 0, weekStartMs: 0, equity: usd(20), nav: usd(30) }, false, null, T);
    const a = new PaperAccount(file, usd(20), T, 0n);
    // Sanity: on the right clock R10 trips (NAV about $17.75 <= 70% of $30).
    expect(codesAt(a, ledger, T + 1_000)).toContain('kill_switch');
    // NTP steps the clock back 1 s: the peak is "in the future" and is dropped.
    const codes = codesAt(a, ledger, T - 1_000);
    expect(codes.some((c) => c === 'kill_switch' || c === 'bankroll_invalid'), `codes 1 s before the peak: ${JSON.stringify(codes)}`).toBe(true);
    ledger.close();
  });
});
