// RED TEAM A, probe RT-A9 (budget leak across midnight UTC, the fills' daily budget `DailyBudget`, persist/state.ts).
//
// FACTS-REREAD's second review fixed "a refund goes back to its own day" for the re-read budget only (`rereadRefund`,
// `reserveBudget`). The fills' budget (FILL_CREDITS_PER_DAY = 20,000 Helius credits a UTC day) has the same
// reserve-then-refund pattern at every caller, and `DailyBudget.refund(n, now)` gives the credits back to the day of
// `now`, not to the day they were reserved on:
//   - worker.ts #downtimeMigrations: spend(min(3,000, remaining), now) ... refund(cap - used, timers.now()) after a
//     backfill that runs for seconds to minutes;
//   - worker.ts #liveCompletion: spend(6) ... refund(6 - used, timers.now()) after the curve read;
//   - seed-start.ts: the boot seed reserves min(SEED_CREDIT_CAP = 150,000, remaining) and refunds after the seed;
//   - sources.ts tradesFill / findCreate: the same.
// A reserve taken before midnight and refunded after it lowers the NEW day's count by what the old day reserved and
// did not use, so the new day spends past its cap by up to the old reserve (here the downtime read's 3,000; a seed
// running over midnight: up to 20,000 more). Helius credits are real money, and the Helius monthly halt also refuses
// the P1 reads held positions need.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type BudgetDay, DailyBudget } from '../../src/persist/state.ts';
import { FILL_CREDITS_PER_DAY } from '../../src/run/config.ts';
import { DOWNTIME_CREDIT_CAP, type SeedRequest } from '../../src/run/worker.ts';
import { runSeed } from '../../src/run/seed-start.ts';
import { findCreate, tradesFill } from '../../src/run/sources.ts';
import { LiveFeed, DEFAULT_LIVE_FEED } from '../../src/providers/live-feed.ts';
import type { Timers } from '../../src/scheduler/index.ts';
import { virtualTimers } from '../worker-harness.ts';
import { AT, CURVE, complete, migrate, run } from './reread-kit.ts';

const DAY_MS = 86_400_000;

describe('RT-A9: the fills\' budget refunds a pre-midnight reserve to the new day', () => {
  it('a downtime read reserved at 23:59:50 UTC and refunded at 00:00:30 does not let the new day spend past its cap', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'rt-a9-')), 'fill-budget.json');
    const midnight = 20_000 * DAY_MS;
    const b = DailyBudget.load(path, FILL_CREDITS_PER_DAY, midnight - 10_000);
    // #downtimeMigrations: the cap is booked before the backfill reads.
    const t0 = midnight - 10_000;
    const cap = Math.min(DOWNTIME_CREDIT_CAP, b.remaining(t0));
    const day0 = b.spend(cap, t0);
    // Past midnight, while the backfill still runs, the new day's readers (pool fills, completion reads) take all of
    // the new day's budget.
    const t1 = midnight + 5_000;
    const newDay = b.remaining(t1);
    expect(newDay).toBe(FILL_CREDITS_PER_DAY);
    const day1 = b.spend(newDay, t1);
    expect(b.remaining(t1)).toBe(0);
    // The backfill ends having used nothing (no downtime migrations), and gives back its reserve, named by the day its
    // spend answered (A-FACTS-FIXES: `spend` returns it and `refund` takes it, so no caller can name another day).
    const used = 0;
    b.refund(Math.max(0, cap - used), day0);
    // Correct: the old day's unused reserve never becomes new-day credit; the new day has spent its 20,000.
    expect(b.remaining(midnight + 31_000)).toBe(0);
    // A same-day refund still gives back (the new day's own reserve).
    b.refund(500, day1);
    expect(b.remaining(midnight + 32_000)).toBe(500);
  });

  it('a refund before any later spend rolls nothing: the old day takes it back, the new day starts at its full cap', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'rt-a9-')), 'fill-budget.json');
    const midnight = 20_000 * DAY_MS;
    const b = DailyBudget.load(path, FILL_CREDITS_PER_DAY, midnight - 10_000);
    const day = b.spend(3_000, midnight - 10_000);
    b.refund(3_000, day);
    expect(b.remaining(midnight - 9_000)).toBe(FILL_CREDITS_PER_DAY);
    expect(b.remaining(midnight + 1_000)).toBe(FILL_CREDITS_PER_DAY);
  });
});

/** Every call site books its refund to the moment of its own spend, read before the clock crosses midnight. */
describe('RT-A9: the fills\' budget callers refund to their reserve\'s moment', () => {
  const midnight = 20_000 * DAY_MS;
  /** A clock that moves 10 s at every read, from 5 s before midnight: the refund's own `now()` is a later day. */
  const ticking = (): Timers => {
    let t = midnight - 5_000;
    return { now: () => (t += 10_000) - 10_000, setTimeout: (f: () => void) => { setImmediate(f); return 0 as never; }, clearTimeout: () => {} } as unknown as Timers;
  };
  const spy = () => {
    const calls: [string, number, number][] = [];
    return { calls, budget: { remaining: () => 10_000, spend: (c: number, ms: number) => { calls.push(['spend', c, ms]); return String(ms) as BudgetDay; }, refund: (c: number, day: BudgetDay) => { calls.push(['refund', c, Number(day)]); } } };
  };
  const sameMoment = (calls: [string, number, number][]) => {
    const spend = calls.find((c) => c[0] === 'spend');
    const refund = calls.find((c) => c[0] === 'refund');
    expect(spend).toBeDefined();
    expect(refund).toBeDefined();
    expect(refund![2]).toBe(spend![2]);
    expect(Math.floor(spend![2] / DAY_MS)).toBe(Math.floor(midnight / DAY_MS) - 1);
  };

  it('runSeed', async () => {
    const { calls, budget } = spy();
    const r = { saved: { last: null }, close: null, untilSlot: 10n, liveStart: null, asOf: { slot: 10n, txIndex: 0, ixIndex: 0, receivedAt: midnight }, signal: new AbortController().signal } as unknown as SeedRequest;
    await runSeed(r, { rpc: { getSignaturesForAddress: async () => [], getTransaction: async () => null } as never, timers: ticking(), budget: budget as unknown as DailyBudget });
    sameMoment(calls);
  });

  it('findCreate', async () => {
    const { calls, budget } = spy();
    await findCreate('Mint1111111111111111111111111111111111111', { rpc: { getSignaturesForAddress: async () => [], getTransaction: async () => null }, ingest: () => false, timers: ticking(), budget });
    sameMoment(calls);
  });

  it('tradesFill', async () => {
    const { calls, budget } = spy();
    const f = tradesFill({ feed: new LiveFeed({ ...DEFAULT_LIVE_FEED, horizonSlots: 0 }), timers: ticking(), rpc: { getSignaturesForAddress: async () => [], getTransaction: async () => null } as never, budget, pools: () => new Map() });
    await f({ address: 'Poo11111111111111111111111111111111111111', fromSlot: 100n, toSlot: 110n });
    sameMoment(calls);
  });

  it('the worker\'s COMPLETION-READ (#liveCompletion)', async () => {
    const timers = virtualTimers(AT - 30_000);
    const { calls, budget } = spy();
    const rpc = {
      getSignaturesForAddress: async (address: string) => {
        // The read takes a while: the clock moves on a day.
        timers.set(timers.now() + DAY_MS);
        return address === CURVE ? [{ signature: complete.signature, slot: complete.slot, err: null, blockTime: complete.blockTime }] : [];
      },
      getTransaction: async (sig: string) => (sig === complete.signature ? complete : sig === migrate.signature ? migrate : null),
    };
    await run(rpc, { timers, budget, window: false, runMs: 10_000 });
    const spend = calls.find((c) => c[0] === 'spend');
    expect(spend).toBeDefined();
    expect(calls.find((c) => c[0] === 'refund')).toEqual(['refund', spend![1] - 2, spend![2]]);
  }, 60_000);
});
