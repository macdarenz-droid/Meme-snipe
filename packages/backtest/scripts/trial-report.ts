// Merges the trial parts in a folder into UI-2's report (the trial view, src/study/trial.ts). Refuses any day of the
// sealed window, a day in two parts, or parts from another commit.
//   node packages/backtest/scripts/trial-report.ts <parts dir> <sol-usd file> <out report.json>
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FILL_CONFIG, TRIAL_POLICY } from '../../core/src/config/index.ts';
import { readSeries } from '../src/dataset/offchain.ts';
import { STUDY_CONFIG } from '../src/strategy/config.ts';
import { trialReport, type TrialPart } from '../src/study/trial.ts';

const [dir, solFile, out] = process.argv.slice(2);
if (!dir || !solFile || !out) throw new Error('usage: trial-report.ts <parts dir> <sol-usd file> <out report.json>');
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', cwd: import.meta.dirname }).trim();
const parts = readdirSync(dir).filter((f) => /^trial-part-.*\.json$/.test(f)).sort().map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as TrialPart);
const report = trialReport({ parts, config: STUDY_CONFIG, policy: TRIAL_POLICY, fills: FILL_CONFIG, solUsd: readSeries(solFile), commit, generatedAt: new Date().toISOString() });
writeFileSync(out, `${JSON.stringify(report, null, 1)}\n`);
console.log(`${report.runId}: ${parts.length} parts, ${report.trades.length} trades`);
