import { it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { writeDataset } from '/home/user/Meme-snipe/packages/backtest/test/dataset-writer.ts';
import { studyWorld, W0 } from '/home/user/Meme-snipe/packages/backtest/test/study-world.ts';
import { SOL_USD } from '/home/user/Meme-snipe/packages/backtest/test/synthetic.ts';
const MIN = 150;
const reclaim = (since: number) => (since < 5 * MIN ? 0.5 : since < 50 * MIN ? 0.15 : 0.55);
it('mk', () => {
  const { rows } = studyWorld({ leadInDays: 1, blockEvery: 50, slots: 10 + 20 * MIN + 260 * MIN, mints: [{ label: 'a', createSlot: 10, graduateAfter: 20 * MIN, migrationQuote: 400_000_000_000n, buyBias: reclaim, swapEvery: 10, buySize: 3e9, sellDivisor: 8 }] });
  const d = '/tmp/claude-0/-home-user-Meme-snipe/406edd36-7a5c-567a-b0c4-521cf6e925a4/scratchpad/eds';
  writeDataset(d + '/ds', rows.filter((r) => r.kind !== 'raw'));
  const bars = Array.from({ length: 24 * 20 }, (_, k) => ({ start: W0 - 16 * 86_400_000 + k * 3_600_000, close: '120.00' }));
  writeFileSync(d + '/sol.csv', ['# name: SOL/USD', '# source: test', '# tag: fixed', '# bar_ms: 3600000', '# fetched_at: 2026-10-03T00:00:00Z', 'start,close', ...bars.map((b) => `${new Date(b.start).toISOString()},${b.close}`)].join('\n'));
  void SOL_USD;
});
