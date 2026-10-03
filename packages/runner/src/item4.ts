// Pre-funding item 4 (docs/ARCHITECTURE.md §15) from the run's journal: every `simulation` line is TEST-2's
// DryRunRecord (bigints as decimal strings), scored by TEST-2's own dryRunReport so the bounds live in one place.
import { DRYRUN_GATE, dryRunReport, type DryRunReport } from '../../worker/src/dryrun/report.ts';
import { type DryRunOutcome, type DryRunRecord, E4_PER_POINT } from '../../worker/src/dryrun/simulate.ts';
import type { JournalLine } from './contract.ts';
import type { Label } from './report.ts';

/** Every DryRunOutcome; the `satisfies` keeps this list in step with TEST-2's type. */
const OUTCOMES = {
  simulated: true,
  'sim-error': true,
  'not-simulable': true,
  'build-refused': true,
  'policy-violation': true,
  'structure-mismatch': true,
  'amount-check': true,
  'scheduler-refused': true,
  'rpc-error': true,
  malformed: true,
  'internal-error': true,
} as const satisfies Record<DryRunOutcome, true>;

export const isOutcome = (x: unknown): x is DryRunOutcome => typeof x === 'string' && Object.hasOwn(OUTCOMES, x);

export interface Item4 {
  /** Only a VPS run with the real worker can count for item 4; a rehearsal or the stub never does. */
  readonly counts: boolean;
  readonly note: string;
  readonly bounds: {
    readonly success: { readonly pass: boolean; readonly percent: number; readonly min_percent: number };
    readonly median: { readonly pass: boolean; readonly points: number | null; readonly max_points: number };
    readonly each: { readonly pass: boolean; readonly max_seen_points: number | null; readonly max_points: number };
  };
  readonly trades: number;
  readonly successes: number;
  readonly outcomes: DryRunReport['outcomes'];
  readonly close_omitted: number;
  /** Legs built for a stand-in account (the unfunded bot wallet), as TEST-2 designs. */
  readonly stand_ins: number;
  readonly median_quote_age_slots: number | null;
  readonly worst: DryRunReport['worst'];
  readonly pass: boolean;
}

const big = (x: unknown): bigint | null => (typeof x === 'string' && /^-?\d+$/.test(x) ? BigInt(x) : null);

/** One journal `simulation` line as a DryRunRecord; only the fields dryRunReport reads need to be exact. */
export const toRecord = (l: JournalLine): DryRunRecord => ({
  id: `${String(l.trade)}|${String(l['leg'])}`,
  side: l['leg'] === 'exit' ? 'sell' : 'buy',
  venue: l['venue'] === 'curve' ? 'curve' : 'pool',
  mint: String(l['mint'] ?? '') as DryRunRecord['mint'],
  outcome: l['outcome'] as DryRunOutcome,
  success: l['success'] === true && l['outcome'] === 'simulated',
  error: typeof l['error'] === 'string' ? l['error'] : null,
  standIn: (l['standIn'] ?? null) as DryRunRecord['standIn'],
  policy: null,
  quotedOut: big(l['quotedOut']),
  simulatedOut: big(l['simulatedOut']),
  amountErrorE4: typeof l['amountErrorE4'] === 'number' ? l['amountErrorE4'] : null,
  readSlot: null,
  quoteAgeSlots: big(l['quoteAgeSlots']),
  rentDeclared: big(l['rentDeclared']),
  rentPaid: big(l['rentPaid']),
  balancesFrom: l['balancesFrom'] === 'simulation' || l['balancesFrom'] === 'read' ? l['balancesFrom'] : null,
  simulatedSlot: null,
  unitsConsumed: null,
  logsTail: [],
});

export const item4 = (journal: readonly JournalLine[], label: Label, stub: boolean): Item4 => {
  const records = journal.filter((l) => l.kind === 'simulation' && isOutcome(l['outcome'])).map(toRecord);
  const r = dryRunReport(records);
  const counts = label === 'vps' && !stub;
  return {
    counts,
    note: counts
      ? 'VPS run with the real worker: item 4 is judged from these numbers.'
      : `${label === 'rehearsal' ? 'Rehearsal' : 'Stub worker'}: does not count for item 4.`,
    bounds: {
      success: { pass: r.successPass, percent: Math.round(r.successPercent * 100) / 100, min_percent: DRYRUN_GATE.minSuccessPercent },
      median: { pass: r.medianPass, points: r.medianErrorPoints, max_points: DRYRUN_GATE.maxMedianE4 / E4_PER_POINT },
      each: { pass: r.eachPass, max_seen_points: r.maxErrorPoints, max_points: DRYRUN_GATE.maxEachE4 / E4_PER_POINT },
    },
    trades: r.trades,
    successes: r.successes,
    outcomes: r.outcomes,
    close_omitted: r.closeOmitted,
    stand_ins: records.filter((x) => x.standIn !== null).length,
    median_quote_age_slots: r.medianQuoteAgeSlots,
    worst: r.worst,
    pass: r.pass,
  };
};
