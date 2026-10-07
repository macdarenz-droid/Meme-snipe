// Round 4 red team, paralysis hunt. P-SOL-HOUR: FAILS on integration commit cd4d7a6.
// The regime's current check is the newest SOL/USD point, and it must be at most HOURLY_MAX_AGE_MS (2 h) old
// (regime.ts:190). The reader only accepts a Coinbase hourly bar 2 h after its start (readers.ts:986), so at the top
// of each hour the newest point is exactly 2 h old: the margin is zero, and the regime (judged in every mode, the S0
// diagnostic included) is off for every coin until that hour's single SOL/USD read lands. LiveFacts asks once per hour
// (source.ts:205) and never again within the hour, so ONE failed or thrown Coinbase candles call keeps the regime off
// for the whole hour. Non-paralysed behaviour asserted: a failed hourly read is asked again within the hour.
import { describe, expect, it } from 'vitest';
import { LiveFacts, type LiveReaders, type MintHistoryOptions } from '../../src/facts/index.ts';
import type { FactContext } from '../../src/run/facts.ts';
import { ManualTimers } from '../../src/scheduler/index.ts';
import { blockNetwork } from '../helpers.ts';

blockNetwork();

const T0 = Date.UTC(2026, 9, 3, 12, 30);
const MIN = 60_000;

describe('round 4 paralysis: SOL/USD hourly read', () => {
  it('P-SOL-HOUR: a failed hourly SOL/USD read is asked again within the hour', async () => {
    const timers = new ManualTimers(T0);
    const calls: unknown[][] = [];
    let ok = true;
    const answer = (c: unknown[]): Promise<boolean> => {
      calls.push(c);
      return ok ? Promise.resolve(true) : Promise.reject(new Error('coinbase 503'));
    };
    const readers: LiveReaders = {
      readAccounts: (m) => answer(['accounts', m]),
      readHolders: (m) => answer(['holders', m]),
      readHoldersAll: (m) => answer(['holders-all', m]),
      readCrossChecks: async (m) => [await answer(['xcheck', m]), false, false],
      readMintHistory: (m, o: MintHistoryOptions) => answer(['mint-history', m, o.asOfSlot]),
      readSolUsd: (h) => answer(['sol-usd', h]),
    };
    const ctx = {
      sink: { fact: () => undefined, now: () => timers.now() },
      timers, watched: () => new Set<string>(), candidates: () => new Map(), tip: () => 1_000n,
    } as unknown as FactContext;
    const src = new LiveFacts({
      readers: () => readers, tickMs: 1_000, minReadGapMs: MIN, survivalAfterMs: 30 * MIN, survivalReadDelayMs: 5_000, solUsdStartHours: 27,
      mintHistory: { maxPages: 20, funderPages: 3, funderTransactions: 10, insiderSlots: 2, firstBuyers: 20 },
    });
    const flush = async (): Promise<void> => {
      for (let k = 0; k < 5; k++) await Promise.resolve();
    };
    src.start(ctx);
    await flush();
    expect(calls).toEqual([['sol-usd', 27]]);
    // 13:00: the hour's read fails (one Coinbase error); from now until a read lands the regime is off for every coin.
    ok = false;
    timers.advance(30 * MIN);
    await flush();
    expect(calls.filter((c) => c[0] === 'sol-usd')).toHaveLength(2);
    ok = true;
    // 13:15: it must have been asked again by now.
    for (let k = 0; k < 15; k++) {
      timers.advance(MIN);
      await flush();
    }
    src.stop();
    expect(calls.filter((c) => c[0] === 'sol-usd').length).toBeGreaterThan(2);
  });
});
