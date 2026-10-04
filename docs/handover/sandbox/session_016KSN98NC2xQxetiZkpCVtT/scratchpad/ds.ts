import { writeDataset } from '/home/user/Meme-snipe/packages/backtest/test/dataset-writer.ts';
import { syntheticRows, SOL_USD } from '/home/user/Meme-snipe/packages/backtest/test/synthetic.ts';
import { writeFileSync, rmSync } from 'node:fs';
rmSync('ds', { recursive: true, force: true });
writeDataset('ds', syntheticRows({ mints: 2, slots: 2.5 * 3600 * 5 }));
writeFileSync('sol.csv', ['# name: SOL/USD', '# source: test', '# tag: fixed', '# bar_ms: 3600000', '# fetched_at: 2026-10-03T00:00:00Z', 'start,close', ...SOL_USD.bars.map((b) => `${new Date(b.start).toISOString()},${b.close}`)].join('\n'));
