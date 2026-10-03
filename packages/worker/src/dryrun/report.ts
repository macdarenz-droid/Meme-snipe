// The dry-run report for pre-funding item 4 (docs/ARCHITECTURE.md §15): the share of paper entries and exits that
// simulate successfully, and how far the simulated amounts are from the local quote. Integer arithmetic only, so a
// value exactly on a bound is decided exactly.
import { type DryRunOutcome, type DryRunRecord, E4_PER_POINT } from './simulate.ts';

/** The owner's gate (CLAUDE.md, pre-funding item 4). Gate bounds, not trade limits; changed only by the owner. */
export const DRYRUN_GATE = {
  /** At least this percentage of trades simulate successfully. */
  minSuccessPercent: 95,
  /** Median amount error at most 0.5 percentage points. */
  maxMedianE4: 0.5 * E4_PER_POINT,
  /** Every trade's amount error at most 2 percentage points. */
  maxEachE4: 2 * E4_PER_POINT,
} as const;

export interface DryRunReport {
  readonly trades: number;
  readonly successes: number;
  /** successes / trades as a percentage, for display (the pass test uses integers). */
  readonly successPercent: number;
  readonly outcomes: Readonly<Partial<Record<DryRunOutcome, number>>>;
  /** Trades whose stand-in build left out the base-account close. */
  readonly closeOmitted: number;
  /** Amount errors of the successful trades, in percentage points. */
  readonly medianErrorPoints: number | null;
  readonly maxErrorPoints: number | null;
  readonly worst: { readonly id: string; readonly errorPoints: number } | null;
  readonly successPass: boolean;
  readonly medianPass: boolean;
  readonly eachPass: boolean;
  /** All three pass, on at least one trade. */
  readonly pass: boolean;
}

export const dryRunReport = (records: readonly DryRunRecord[]): DryRunReport => {
  const trades = records.length;
  const ok = records.filter((r) => r.success);
  const outcomes: Partial<Record<DryRunOutcome, number>> = {};
  for (const r of records) outcomes[r.outcome] = (outcomes[r.outcome] ?? 0) + 1;
  // A successful record always carries its error; one without it is treated as failing the amount bounds.
  const errors = ok.map((r) => r.amountErrorE4 ?? Number.POSITIVE_INFINITY).sort((a, b) => a - b);
  const n = errors.length;
  // Twice the median, so an even count needs no division.
  const median2 = n === 0 ? null : n % 2 === 1 ? 2 * errors[(n - 1) / 2]! : errors[n / 2 - 1]! + errors[n / 2]!;
  const max = n === 0 ? null : errors[n - 1]!;
  const worstRec = n === 0 ? null : ok.reduce((w, r) => ((r.amountErrorE4 ?? Number.POSITIVE_INFINITY) > (w.amountErrorE4 ?? Number.POSITIVE_INFINITY) ? r : w));
  const successPass = trades > 0 && ok.length * 100 >= DRYRUN_GATE.minSuccessPercent * trades;
  const medianPass = median2 !== null && median2 <= 2 * DRYRUN_GATE.maxMedianE4;
  const eachPass = max !== null && max <= DRYRUN_GATE.maxEachE4;
  return {
    trades,
    successes: ok.length,
    successPercent: trades === 0 ? 0 : (ok.length * 100) / trades,
    outcomes,
    closeOmitted: records.filter((r) => r.standIn?.closeOmitted).length,
    medianErrorPoints: median2 === null ? null : median2 / 2 / E4_PER_POINT,
    maxErrorPoints: max === null ? null : max / E4_PER_POINT,
    worst: worstRec === null ? null : { id: worstRec.id, errorPoints: (worstRec.amountErrorE4 ?? Number.POSITIVE_INFINITY) / E4_PER_POINT },
    successPass,
    medianPass,
    eachPass,
    pass: successPass && medianPass && eachPass,
  };
};
