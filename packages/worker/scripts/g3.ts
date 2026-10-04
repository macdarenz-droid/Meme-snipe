// The G3 consistency report of the qualifying dry run (docs/DECISIONS.md "G3 report"). Offline, after the run: it
// reads the run's state directory (never writes to it), scores each live-only-vetoed candidate as if entered from the
// run's recording, and runs STATS-1b's gateG3 against the backtest holdout.
//
//   node --no-warnings packages/worker/scripts/g3.ts --state <dir> --holdout <holdout.json> --registration <g3-registration.json> --parity <parity.json> --out <dir>
//
// holdout.json: BT-2's HoldoutSummary (research/g3.ts). g3-registration.json: the G3Registration made before the run.
// parity.json: TEST-1's result on this run's recorded data, `{ "ok": true }` when it passed; a missing or unreadable
// file counts as failed. Writes <out>/counterfactuals.jsonl and <out>/g3.json; exits 0 on pass, 1 otherwise.
import { existsSync, readFileSync } from 'node:fs';
import type { G3Registration } from '../../core/src/stats/index.ts';
import { g3Report, type HoldoutSummary } from '../src/research/g3.ts';

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
};
const need = (name: string): string => {
  const v = arg(name);
  if (v === undefined) throw new Error(`usage: g3.ts --state <dir> --holdout <file> --registration <file> --parity <file> --out <dir> (missing --${name})`);
  return v;
};
const json = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;
const parityFile = arg('parity');
let parityPassed = false;
try {
  parityPassed = parityFile !== undefined && existsSync(parityFile) && json<{ ok?: unknown }>(parityFile).ok === true;
} catch {
  parityPassed = false;
}
const report = await g3Report({ stateDir: need('state'), holdout: json<HoldoutSummary>(need('holdout')), registration: json<G3Registration>(need('registration')), parityPassed, out: need('out') });
const r = report.result;
console.log(`G3 ${r.status}: ${(r.notes ?? []).join('; ')}`);
for (const c of r.checks) console.log(`${c.passed ? 'pass' : 'FAIL'}  ${c.name}: ${c.detail}`);
console.log(`${report.counterfactuals.length} live-only vetoes scored; ${report.counterfactuals.filter((c) => c.entered).length} would have entered`);
process.exit(r.status === 'pass' ? 0 : 1);
