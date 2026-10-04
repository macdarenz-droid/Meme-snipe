import { writeFileSync } from 'node:fs';
import { test } from 'vitest';
import { FILL_CONFIG, RESEARCH_CONFIG, TRIAL_POLICY } from '/home/user/Meme-snipe/packages/core/src/config/index.ts';
import { runBacktest } from '/home/user/Meme-snipe/packages/backtest/src/run.ts';
import { SOL_USD, syntheticRows, T0 } from '/home/user/Meme-snipe/packages/backtest/test/synthetic.ts';
const rows = syntheticRows({ mints: 4, slots: 2.5 * 3600 * 6 });
test('x', () => {
  const res: unknown[] = []; for (const seed of ['block-seed','b1','b2','b3','b4','b5','b6']) {
  const s = runBacktest({ rows: () => rows[Symbol.iterator](), series: [SOL_USD], seed, scenario: 'base', research: RESEARCH_CONFIG, windowEnd: T0 + 6 * 3_600_000,
    policy: { ...TRIAL_POLICY, exits: { ...TRIAL_POLICY.exits, ladder: { ...TRIAL_POLICY.exits.ladder, maxAttempts: 1 } } },
    fills: { ...FILL_CONFIG, scenarios: { ...FILL_CONFIG.scenarios, base: { ...FILL_CONFIG.scenarios.base, landPpm: { pumpswap: 600_000n, 'pump-curve': 0n } } } }, s0: { blockedRetries: 0 } });
  res.push(([seed, s.attempts.map((a) => `${a.purpose}:${a.outcome}:${a.reason}`), Object.values(s.book.positions).map((p) => p.status)])); }
  writeFileSync('/tmp/claude-0/-home-user-Meme-snipe/a40496c4-21ce-50b6-8295-c34fb8a211af/scratchpad/out.txt', JSON.stringify(res));
});
