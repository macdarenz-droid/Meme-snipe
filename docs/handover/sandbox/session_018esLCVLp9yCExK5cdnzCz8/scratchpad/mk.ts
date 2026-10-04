import { writeFileSync } from 'node:fs';
import { writeDataset } from '/home/user/Meme-snipe/packages/backtest/test/dataset-writer.ts';
import { syntheticRows, SOL_USD, T0 } from '/home/user/Meme-snipe/packages/backtest/test/synthetic.ts';
const d = process.argv[2]!;
writeDataset(d + '/data', syntheticRows({ mints: 3, slots: 2.5 * 3600 * 6 }));
writeFileSync(d + '/sol.csv', ['# name: SOL/USD', '# tag: fixed', '# bar_ms: 3600000', `# fetched_at: ${new Date(T0).toISOString()}`, 'start,close', ...SOL_USD.bars.map((b) => `${new Date(b.start).toISOString()},${b.close}`)].join('\n'));
writeFileSync(d + '/window.json', JSON.stringify({ decisionFrom: '2026-09-19', decisionTo: '2026-10-01', holdoutFrom: '2026-09-25', embargoDays: 1, confirmedBy: 'test' }));
