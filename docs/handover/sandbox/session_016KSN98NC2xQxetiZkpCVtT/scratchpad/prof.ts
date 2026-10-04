import { FILL_CONFIG, TRIAL_POLICY } from '/home/user/Meme-snipe/packages/core/src/config/index.ts';
import { runBacktest } from '/home/user/Meme-snipe/packages/backtest/src/run.ts';
import { SOL_USD, syntheticRows, T0 } from '/home/user/Meme-snipe/packages/backtest/test/synthetic.ts';
const rows = syntheticRows({ mints: 4, slots: 2.5 * 3600 * 6 });
const t = performance.now();
const r = runBacktest({ rows: () => rows[Symbol.iterator](), series: [SOL_USD], seed: 's', scenario: 'base', policy: TRIAL_POLICY, fills: FILL_CONFIG, windowEnd: T0 + 6 * 3_600_000 });
console.log(performance.now() - t, r.stats, r.records.length);
