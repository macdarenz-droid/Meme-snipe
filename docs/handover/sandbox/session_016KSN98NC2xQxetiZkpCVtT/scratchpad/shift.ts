import { FILL_CONFIG, TRIAL_POLICY } from '/home/user/Meme-snipe/packages/core/src/config/index.ts';
import { shiftTest } from '/home/user/Meme-snipe/packages/backtest/src/proofs.ts';
import { SOL_USD, syntheticRows, T0 } from '/home/user/Meme-snipe/packages/backtest/test/synthetic.ts';
const rows = syntheticRows({ mints: 4, slots: 2.5 * 3600 * 6 });
const r = shiftTest({ rows: () => rows[Symbol.iterator](), series: [SOL_USD], seed: 's', scenario: 'base', policy: TRIAL_POLICY, fills: FILL_CONFIG, windowEnd: T0 + 6 * 3_600_000 }, rows);
const v = r.violations[0] ?? 'ok'; const [a0, b] = v.split(' vs '); const a = a0!.replace(/^.*?: /, '');
for (let i = 0; i < (a ?? '').length; i++) if (a![i] !== b?.[i]) { console.log(a!.slice(Math.max(0, i - 200), i + 100)); console.log(b!.slice(Math.max(0, i - 200), i + 100)); break; }
