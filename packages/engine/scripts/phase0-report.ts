// Operator-side `phase0-report` (SPEC-A A-M13-01, card Z09): runs on the research machine over a pulled dataset.
//   node scripts/phase0-report.ts --data <dir> --days 2026-10-22,2026-10-23,... --out docs/phase0 [--sol-usd 150]
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { quoteExactIn } from '@bot/venue';
import { MINTS } from '@bot/venue/constants';
import { PRIOR_2026_10 } from '../src/m10/params.ts';
import { parsePhase0Args, runPhase0Report } from '../src/m13/phase0-cli.ts';
import { recordedPricing } from '../src/m13/phase0-input.ts';

const args = parsePhase0Args(process.argv.slice(2));
if (typeof args === 'string') {
  console.error(`phase0-report: ${args}`);
  process.exit(2);
}
const flat = (total: number) => {
  const fees = { lpBps: total, protocolBps: 0, creatorBps: 0 };
  const cfg = { account: 'recorded', asOfSlot: 0n, configHash: 'recorded-fee-total', tiers: [{ thresholdLamports: 0n, fees }], flat: fees, exoticFlat: fees };
  return { curve: null, pumpswap: cfg, creatorFeeConfigurable: false };
};
const pricing = recordedPricing({ quote: (p, side, amount, fees) => quoteExactIn(p as never, side, amount, fees as never), feesForTotal: flat, wsolMint: MINTS.wsol });
const { reportPath } = runPhase0Report(args, {
  pricing, simParams: PRIOR_2026_10,
  write: (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); },
});
console.log(`phase0-report: wrote ${reportPath}`);
