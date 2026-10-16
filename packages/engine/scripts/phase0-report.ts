// Operator-side `phase0-report` (SPEC-A A-M13-01, card Z09): runs on the research machine over a pulled dataset.
//   node scripts/phase0-report.ts --data <dir> --days 2026-10-22,2026-10-23,... --out docs/phase0 [--sol-usd 150]
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { PRIOR_2026_10 } from '../src/m10/params.ts';
import { parsePhase0Args, runPhase0Report } from '../src/m13/phase0-cli.ts';
import { venueRecordedPricing } from '../src/m13/venue-pricing.ts';

const args = parsePhase0Args(process.argv.slice(2));
if (typeof args === 'string') {
  console.error(`phase0-report: ${args}`);
  process.exit(2);
}
try {
  const { reportPath } = runPhase0Report(args, {
    pricing: venueRecordedPricing(), simParams: PRIOR_2026_10,
    write: (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); },
  });
  console.log(`phase0-report: wrote ${reportPath}`);
} catch (e) {
  const code = (e as { code?: unknown }).code;
  if (code !== 'E_NO_SNAPSHOTS' && code !== 'E_R0_DAY_MISSING') throw e;
  console.error(`phase0-report: ${String(code)}${code === 'E_R0_DAY_MISSING' ? ` (R0 is on ${String((e as { r0Day: string }).r0Day)}; add that day to --days)` : ''}`);
  process.exit(2);
}
