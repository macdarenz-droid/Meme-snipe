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
  /**
   * AUDIT-RM3 N2: the paper attempts' simulation time against their drawn landing (lines that carry it). A paper attempt
   * lands only once simulated: `held_landing` counts simulations still running at the drawn landing slot (the fill came
   * later than drawn), `expired_by_simulation` those still running past the blockhash (the attempt expired in our own
   * queue). Both should be zero; neither is a network fact.
   */
  readonly latency: { readonly timed: number; readonly median_ms: number | null; readonly median_slots: number | null; readonly held_landing: number; readonly expired_by_simulation: number };
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
  for (const k of ['quotedOut', 'simulatedOut', 'quoteAgeSlots', 'rentDeclared', 'rentPaid', 'simulatedSlot'] as const) {
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
    // A final exit (the sell closes the position's token account), for TEST-2's mechanics diagnostics.
    finalExit: l['leg'] === 'exit' && l['finalExit'] === true,
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
    simulatedSlot: bigOrNull(l['simulatedSlot']),
    unitsConsumed: null,
    logsTail: [],
  };
};

const lowerMedian = (xs: readonly number[]): number | null => (xs.length === 0 ? null : [...xs].sort((a, b) => a - b)[(xs.length - 1) >> 1]!);

/** N2: the simulation-time fields of `simulation` lines (paper-world `SimTiming`), summed. */
export const simulationLatency = (journal: readonly JournalLine[]): Item4['latency'] => {
  let timed = 0;
  let held = 0;
  let expired = 0;
  const ms: number[] = [];
  const slots: number[] = [];
  for (const l of journal) {
    if (l.kind !== 'simulation') continue;
    const sent = bigOrNull(l['sent_height']);
    const land = bigOrNull(l['land_slot']);
    const last = bigOrNull(l['last_valid']);
    const done = bigOrNull(l['sim_done_height']);
    const t = l['sim_ms'];
    if (sent === null || land === null || last === null || typeof t !== 'number' || !Number.isFinite(t)) continue;
    timed += 1;
    ms.push(t);
    if (done !== null) {
      slots.push(Number(done - sent));
      if (done > land) held += 1;
      if (done > last) expired += 1;
    }
  }
  return { timed, median_ms: lowerMedian(ms), median_slots: lowerMedian(slots), held_landing: held, expired_by_simulation: expired };
};

export const item4 = (journal: readonly JournalLine[], label: Label, stub: boolean, window?: { readonly start: number; readonly end: number }): Item4 => {
  // Within the observation window every simulation is scored, including every malformed or failed trade.
  const simulations = journal.filter((l) => l.kind === 'simulation');
  const inside = (l: JournalLine): boolean => window === undefined || (Date.parse(l.ts) >= window.start && Date.parse(l.ts) < window.end);
  const records = simulations.filter(inside).map(toRecord);
  const r = dryRunReport(records);
  // Late successes provide no qualifying credit. A late failure or bad amount still blocks its bound, without
  // letting other late successes dilute it. The raw journal and latency evidence remain complete.
  const tail = window === undefined ? [] : simulations.filter((l) => !inside(l) && !(Date.parse(l.ts) < window.start)).map((l) => dryRunReport([toRecord(l)]));
  const successPass = r.successPass && tail.every((t) => t.successPass);
  const medianPass = r.medianPass && tail.every((t) => t.medianPass);
  const eachPass = r.eachPass && tail.every((t) => t.eachPass);
  const pass = successPass && medianPass && eachPass;
  const counts = label === 'vps' && !stub;
  return {
    counts,
    note: (counts
      ? 'VPS run with the real worker: item 4 is judged from these numbers.'
      : `${label === 'rehearsal' ? 'Rehearsal' : 'Stub worker'}: does not count for item 4.`)
      + (tail.some((t) => !t.pass) ? ' Recovery-tail simulation faults block their bounds; late successes earn no credit.' : ''),
    bounds: {
      success: { pass: successPass, percent: Math.round(r.successPercent * 100) / 100, min_percent: DRYRUN_GATE.minSuccessPercent },
      median: { pass: medianPass, points: r.medianErrorPoints, max_points: DRYRUN_GATE.maxMedianE4 / E4_PER_POINT },
      each: { pass: eachPass, max_seen_points: r.maxErrorPoints, max_points: DRYRUN_GATE.maxEachE4 / E4_PER_POINT },
    },
    trades: r.trades,
    successes: r.successes,
    outcomes: r.outcomes,
    close_omitted: r.closeOmitted,
    stand_ins: records.filter((x) => x.standIn !== null).length,
    median_quote_age_slots: r.medianQuoteAgeSlots,
    worst: r.worst,
    latency: simulationLatency(journal),
    bounds_pass: pass,
    pass: counts && pass,
  };
};
