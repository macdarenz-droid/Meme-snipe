// Pre-funding item 4 (docs/ARCHITECTURE.md §15) from the run's journal: every `simulation` line is TEST-2's
// DryRunRecord (bigints as decimal strings), scored by TEST-2's own dryRunReport so the bounds live in one place.
import { DRYRUN_GATE, dryRunReport, type DryRunReport } from '../../worker/src/dryrun/report.ts';
import { amountErrorE4, type DryRunOutcome, type DryRunRecord, E4_PER_POINT } from '../../worker/src/dryrun/simulate.ts';
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
  /** All three bounds met. */
  readonly bounds_pass: boolean;
  /** Item 4 passes: the run counts and the bounds are met. */
  readonly pass: boolean;
}

/** A bigint field: null when absent, the value when a non-negative decimal string, `bad` otherwise (amounts, slots and rent are never negative). */
const BAD = Symbol('bad');
const big = (x: unknown): bigint | null | typeof BAD => (x === undefined || x === null ? null : typeof x === 'string' && /^\d+$/.test(x) ? BigInt(x) : BAD);

/** Why a simulation line cannot be trusted as written, or null. Such a line is scored `malformed`, never dropped. */
export const malformedReason = (l: JournalLine): string | null => {
  if (!isOutcome(l['outcome'])) return 'missing or unknown outcome';
  for (const k of ['quotedOut', 'simulatedOut', 'quoteAgeSlots', 'rentDeclared', 'rentPaid'] as const) {
    if (big(l[k]) === BAD) return `${k} is not a decimal string`;
  }
  const e = l['amountErrorE4'];
  if (e !== undefined && e !== null && !(typeof e === 'number' && Number.isSafeInteger(e) && e >= 0)) return 'amountErrorE4 is not a non-negative integer';
  const simulated = l['outcome'] === 'simulated';
  if ((l['success'] === true) !== simulated) return 'success disagrees with outcome';
  if (simulated) {
    // The amount error is recomputed from the amounts with TEST-2's own formula; the written value must agree.
    const q = big(l['quotedOut']);
    const m = big(l['simulatedOut']);
    if (typeof q !== 'bigint' || typeof m !== 'bigint' || q <= 0n) return 'simulated without positive quotedOut and simulatedOut';
    if (e !== amountErrorE4(m, q)) return 'amountErrorE4 disagrees with the amounts';
  }
  return null;
};

const bigOrNull = (x: unknown): bigint | null => {
  const v = big(x);
  return v === BAD ? null : v;
};

/** One journal `simulation` line as a DryRunRecord; a line that fails malformedReason becomes TEST-2's `malformed`. */
export const toRecord = (l: JournalLine): DryRunRecord => {
  const bad = malformedReason(l);
  return {
    id: `${String(l.trade)}|${String(l['leg'])}`,
    side: l['leg'] === 'exit' ? 'sell' : 'buy',
    venue: l['venue'] === 'curve' ? 'curve' : 'pool',
    mint: String(l['mint'] ?? '') as DryRunRecord['mint'],
    outcome: bad === null ? (l['outcome'] as DryRunOutcome) : 'malformed',
    success: bad === null && l['outcome'] === 'simulated',
    error: bad ?? (typeof l['error'] === 'string' ? l['error'] : null),
    standIn: bad === null ? ((l['standIn'] ?? null) as DryRunRecord['standIn']) : null,
    policy: null,
    quotedOut: bigOrNull(l['quotedOut']),
    simulatedOut: bigOrNull(l['simulatedOut']),
    amountErrorE4: bad === null && typeof l['amountErrorE4'] === 'number' ? l['amountErrorE4'] : null,
    readSlot: null,
    quoteAgeSlots: bigOrNull(l['quoteAgeSlots']),
    rentDeclared: bigOrNull(l['rentDeclared']),
    rentPaid: bigOrNull(l['rentPaid']),
    balancesFrom: l['balancesFrom'] === 'simulation' || l['balancesFrom'] === 'read' ? l['balancesFrom'] : null,
    simulatedSlot: null,
    unitsConsumed: null,
    logsTail: [],
  };
};

export const item4 = (journal: readonly JournalLine[], label: Label, stub: boolean): Item4 => {
  // Every simulation line is scored: a bad line counts as a failed trade, so it can never leave the denominator.
  const records = journal.filter((l) => l.kind === 'simulation').map(toRecord);
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
    bounds_pass: r.pass,
    pass: counts && r.pass,
  };
};
