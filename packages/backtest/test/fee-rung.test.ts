// PAPER-FEE-RUNG: a backtest exit attempt pays the priority fee its strategy planned for it, never one the world
// re-derives from the intent's attempt count (a strategy whose rung climbs across exit intents would be under-charged).
import { describe, expect, test, vi } from 'vitest';
import { FILL_CONFIG, RESEARCH_CONFIG, TRIAL_POLICY } from '../../core/src/config/index.ts';
import { attemptFee } from '../../core/src/fills/index.ts';
import type { Strategy } from '../../core/src/engine/index.ts';
import { runBacktest, type RunOptions } from '../src/run.ts';
import { S0 } from '../src/strategy/s0.ts';
import { SOL_USD, syntheticRows, T0 } from './synthetic.ts';

const rows = syntheticRows({ mints: 4, slots: 2.5 * 3600 * 6 });
const opts = (over: Partial<RunOptions> = {}): RunOptions => ({
  rows: () => rows[Symbol.iterator](), series: [SOL_USD], seed: 'fee-seed', scenario: 'base', policy: TRIAL_POLICY, research: RESEARCH_CONFIG,
  windowEnd: T0 + 6 * 3_600_000,
  // Some attempts fail, so exits climb the ladder within an intent too.
  fills: { ...FILL_CONFIG, scenarios: { ...FILL_CONFIG.scenarios, base: { ...FILL_CONFIG.scenarios.base, landPpm: { pumpswap: 300_000n, 'pump-curve': 0n } } } },
  ...over,
});
vi.setConfig({ testTimeout: 180_000 });
const net = FILL_CONFIG.network;
const fees = TRIAL_POLICY.exits.ladder.steps.map((s) => s.priorityFeeLamports as bigint);

describe('a backtest exit pays its plan\'s priority fee (PAPER-FEE-RUNG)', () => {
  test('S0: every exit attempt pays the fee S0 planned for it, and its fee charge follows', () => {
    const planned = new Map<string, bigint | null>();
    const r = runBacktest(opts({
      strategy: (c) => {
        const s = new S0(c);
        return { onMarket: (e, ctx) => s.onMarket(e, ctx), exitFee: (sig: string) => { const f = s.exitFee(sig); planned.set(sig, f); return f; } } as Strategy;
      },
    }));
    expect(r.stats.crash).toBeNull();
    const exits = r.attempts.filter((a) => a.purpose === 'exit');
    expect(exits.length).toBeGreaterThan(0);
    for (const a of exits) {
      expect(planned.get(a.signature)).toBe(a.priorityFee);
      if (a.outcome === 'failed' || a.outcome === 'filled') expect(a.fee).toBe(attemptFee(net, a.priorityFee, a.outcome));
    }
    // S0 climbs within an intent: a replacement is planned at a higher rung than the first attempt.
    expect(exits.some((a) => a.priorityFee === fees[1])).toBe(true);
  });

  test('a strategy that planned a rung the attempt count would not give: that rung\'s fee is charged', () => {
    // A planner whose every exit goes at the third rung (one whose rung climbed across intents, say).
    const r = runBacktest(opts({
      strategy: (c) => {
        const s = new S0(c);
        return { onMarket: (e, ctx) => s.onMarket(e, ctx), exitFee: (sig: string) => (s.exitFee(sig) === null ? null : fees[2]!) } as Strategy;
      },
    }));
    const exits = r.attempts.filter((a) => a.purpose === 'exit');
    expect(exits.length).toBeGreaterThan(0);
    for (const a of exits) expect(a.priorityFee).toBe(fees[2]);
    expect(exits.filter((a) => a.outcome === 'filled').every((a) => a.fee === attemptFee(net, fees[2]!, 'filled'))).toBe(true);
  });

  test('a strategy that plans no fee: the highest rung\'s, never less', () => {
    const r = runBacktest(opts({ strategy: (c) => { const s = new S0(c); return { onMarket: (e, ctx) => s.onMarket(e, ctx) }; } }));
    const exits = r.attempts.filter((a) => a.purpose === 'exit');
    expect(exits.length).toBeGreaterThan(0);
    const top = fees.reduce((m, f) => (f > m ? f : m), 0n);
    for (const a of exits) expect(a.priorityFee).toBe(top);
  });
});
