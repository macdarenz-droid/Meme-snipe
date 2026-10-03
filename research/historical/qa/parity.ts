// Decoder parity check of a historical dataset: its rows against the shared chain decoder on the raw records.
// Rules and summary fields: packages/backtest/src/dataset/parity.ts (tests: packages/backtest/test/parity.test.ts).
//
//   node --no-warnings research/historical/qa/parity.ts <dataset-dir>
//
// Prints the JSON summary, writes it to <dataset-dir>/qa/parity.json, exits 1 on any mismatch or missing row.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { failed, runParity } from '../../../packages/backtest/src/dataset/parity.ts';

const dir = process.argv[2];
if (!dir) {
  process.stderr.write('usage: node --no-warnings research/historical/qa/parity.ts <dataset-dir>\n');
  process.exit(2);
}
const summary = await runParity(dir);
const text = `${JSON.stringify(summary, null, 2)}\n`;
mkdirSync(join(dir, 'qa'), { recursive: true });
writeFileSync(join(dir, 'qa', 'parity.json'), text);
process.stdout.write(text);
process.exit(failed(summary) ? 1 : 0);
