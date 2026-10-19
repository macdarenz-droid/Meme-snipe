// fills-4 (EXIT-FILL-FIXES, RB-11): the backtest's world counts the repeated-exit haircut only over the position's exit
// sends inside exitRetryHaircutWindowMs. The same replay with a window no exit ever leaves (fills-3's behaviour) is
// another log: with the window, exits need fewer attempts.
import { describe, expect, test } from 'vitest';
import { FILL_CONFIG, RESEARCH_CONFIG, TRIAL_POLICY } from '../../core/src/config/index.ts';
import { runBacktest } from '../src/run.ts';
import { SOL_USD, syntheticRows, T0 } from './synthetic.ts';

const RESEARCH = { ...RESEARCH_CONFIG, holdout: { ...RESEARCH_CONFIG.holdout, fromDay: '2026-09-20', entryCutoffDay: '2026-09-21', tailEndDay: '2026-09-21' } };
const crowd = syntheticRows({ mints: 30, slots: 2.5 * 3600 * 8, swapEvery: 60, seed: 'crowd' });
const run = (windowMs: number) => runBacktest({
  rows: () => crowd[Symbol.iterator](), series: [SOL_USD], seed: 's0', scenario: 'conservative', policy: TRIAL_POLICY, research: RESEARCH, windowEnd: T0 + 8 * 3_600_000,
  fills: { ...FILL_CONFIG, scenarios: { ...FILL_CONFIG.scenarios, conservative: { ...FILL_CONFIG.scenarios.conservative, exitRetryHaircutWindowMs: windowMs } } },
});

describe('the backtest applies the haircut window (fills-4)', () => {
  test('a 10-minute window and an endless one give different logs; the window needs fewer exit attempts', () => {
    expect(FILL_CONFIG.version).toBe('fills-4');
    const windowed = run(FILL_CONFIG.scenarios.conservative.exitRetryHaircutWindowMs);
    const endless = run(1e15);
    expect(windowed.logHash).not.toBe(endless.logHash);
    const exits = (r: typeof windowed) => r.attempts.filter((a) => a.purpose === 'exit');
    expect(exits(windowed).length).toBeLessThan(exits(endless).length);
    // Every multiple in the windowed run counts only sends inside the window: never more than the endless run's.
    expect(Math.max(...exits(windowed).map((a) => a.exitRetry))).toBeLessThanOrEqual(Math.max(...exits(endless).map((a) => a.exitRetry)));
  }, 300_000);
});
