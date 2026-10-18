// `phase0-report` (A-M13-01 "Interfaces"; card Z09): reads a pulled dataset, writes `docs/phase0/report-<D1>.md` and
// the CSVs beside it. Flags: --data <dir> --days <YYYY-MM-DD,...> --out <dir> [--sol-usd <price>] (overrides the
// recorded D1 price, said in the caveats). The kill check reads nothing from flags (it is not run: MR-01 parked).
// The operator script `scripts/phase0-report.ts` binds `recordedPricing` to @bot/venue's `quoteExactIn` (a runtime
// dependency of @bot/engine, ruling Z09-10).
import { join } from 'node:path';
import type { SimParamSet } from '../m10/params.ts';
import { phase0Report, renderPhase0Csv, renderPhase0Markdown } from './phase0.ts';
import { readPhase0Dataset, type RecordedPricing } from './phase0-input.ts';
import type { SegmentSkip } from '../m07/daily.ts';

export interface Phase0Args { data: string; days: string[]; out: string; solUsd: number | null }

export function parsePhase0Args(argv: readonly string[]): Phase0Args | string {
  const get = (k: string): string | undefined => { const i = argv.indexOf(k); return i === -1 ? undefined : argv[i + 1]; };
  const data = get('--data'), days = get('--days'), out = get('--out'), sol = get('--sol-usd');
  if (data === undefined || days === undefined || out === undefined) return 'usage: phase0-report --data <dir> --days <YYYY-MM-DD,...> --out <dir> [--sol-usd <price>]';
  const list = days.split(',');
  if (!list.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))) return '--days must be YYYY-MM-DD dates, comma separated';
  const solUsd = sol === undefined ? null : Number(sol);
  if (solUsd !== null && !(Number.isFinite(solUsd) && solUsd > 0)) return '--sol-usd must be a positive price';
  return { data, days: list, out, solUsd };
}

export function runPhase0Report(a: Phase0Args, deps: { pricing: RecordedPricing; simParams: SimParamSet; write(path: string, text: string): void }): { reportPath: string } {
  // SW-39: a damaged segment is skipped whole (the same rule as the recorder's coverage report) and named in the report.
  const skipped: SegmentSkip[] = [];
  const input = readPhase0Dataset({ dataDir: a.data, days: a.days, pricing: deps.pricing, onSkip: (k) => skipped.push(k) });
  const report = phase0Report({ ...input, solUsdD1: a.solUsd ?? input.solUsdD1, solUsdSource: a.solUsd === null ? input.solUsdSource : 'command line --sol-usd', simParams: deps.simParams });
  if (a.solUsd !== null) report.caveats.push(`SOL/USD given on the command line (${a.solUsd}), not the recorded D1 price.`);
  for (const k of skipped) report.caveats.push(`Segment ${k.path} skipped whole (${k.reason}): it does not decode to its end or a line does not parse.`);
  const reportPath = join(a.out, `report-${report.window.d1}.md`);
  const csv = renderPhase0Csv(report);
  deps.write(reportPath, renderPhase0Markdown(report));
  deps.write(join(a.out, `hurdle-${report.window.d1}.csv`), csv.hurdle);
  deps.write(join(a.out, `a48-${report.window.d1}.csv`), csv.a48);
  return { reportPath };
}
