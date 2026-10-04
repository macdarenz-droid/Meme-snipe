// Volume-hours cross-check of one day: the dataset's volume_hours rows against the units' kept trade rows.
// Rules: packages/backtest/src/dataset/volume.ts (tests: packages/backtest/test/volume.test.ts).
//
//   node --no-warnings research/historical/qa/volume.ts <dataset-dir> <units-dir> <day>
//
// Prints the JSON result, writes it to <dataset-dir>/qa/volume.json, exits 1 on any mismatch.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runVolumeCheck, volumeFailed } from '../../../packages/backtest/src/dataset/volume.ts';

const [dir, units, day] = process.argv.slice(2);
if (!dir || !units || !day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
  process.stderr.write('usage: node --no-warnings research/historical/qa/volume.ts <dataset-dir> <units-dir> <day>\n');
  process.exit(2);
}
const result = runVolumeCheck(dir, units, day);
const text = `${JSON.stringify(result, null, 2)}\n`;
mkdirSync(join(dir, 'qa'), { recursive: true });
writeFileSync(join(dir, 'qa', 'volume.json'), text);
process.stdout.write(text);
process.exit(volumeFailed(result) ? 1 : 0);
