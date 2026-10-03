// The trial view (docs/ARCHITECTURE.md §17, supervisor 2026-10-04): a cumulative report over the practice days tested
// so far, in UI-2's report schema, labelled as a trial in progress and not a verdict. Each assembled window's `trial`
// run writes one part; the parts are merged here. A day of the fixed holdout window can never enter: a part naming
// one, or a trade that opens or closes at or after the holdout's first instant, is refused whole.
import type { FillConfig, Policy } from '../../../core/src/config/index.ts';
import type { BacktestReportV1, ReportGate } from '../../../core/src/report/index.ts';
import type { OffchainSeries } from '../dataset/offchain.ts';
import { buildReport } from '../report.ts';
import type { StudyConfig } from '../strategy/config.ts';
import type { TradeRecord } from '../trades.ts';
import { dayStart, holdoutDaysOf, windowDays } from './plan.ts';

/** One window's trial run, as written by `cli.ts trial` (bigints as decimal strings). */
export interface TrialPart {
  readonly kind: 'BT-2 trial part';
  readonly runId: string;
  readonly commit: string;
  readonly datasetId: string;
  readonly days: readonly string[];
  /** The regime gate was assumed on (a labelled diagnostic run). */
  readonly regimeAssumedOn?: boolean;
  readonly engine: { readonly replays: number; readonly identicalReplays: boolean; readonly crashes: number; readonly illegalStates: number; readonly unreconciledIntents: number; readonly leak: boolean; readonly ledgerReplay: boolean };
  readonly candidates: number;
  readonly entries: number;
  /** Strategy trades by universe tag (U1, U2) and S0's first seed (S0-U1, S0-U2). */
  readonly trades: readonly (Omit<TradeRecord, BigKey> & Record<BigKey, string> & { readonly tag: string })[];
}

type BigKey = 'entrySol' | 'tokens' | 'exitSol' | 'networkBase' | 'priority' | 'tip' | 'venueFee' | 'creatorFee' | 'slippage' | 'rentPaid' | 'rentReturned' | 'net';
const BIG: readonly BigKey[] = ['entrySol', 'tokens', 'exitSol', 'networkBase', 'priority', 'tip', 'venueFee', 'creatorFee', 'slippage', 'rentPaid', 'rentReturned', 'net'];

export const toPartTrade = (t: TradeRecord, tag: string): TrialPart['trades'][number] =>
  ({ ...t, ...Object.fromEntries(BIG.map((k) => [k, t[k].toString()])), tag } as unknown as TrialPart['trades'][number]);
const fromPartTrade = (t: TrialPart['trades'][number]): TradeRecord => ({ ...t, ...Object.fromEntries(BIG.map((k) => [k, BigInt(t[k])])) } as unknown as TradeRecord);

/** Refuses anything that touches the fixed holdout window. */
export const assertPractice = (c: StudyConfig, days: readonly string[], trades: readonly { openedAt: number; closedAt: number }[] = []): void => {
  const holdout = new Set(holdoutDaysOf(c));
  const first = dayStart(holdoutDaysOf(c)[0]!);
  const window = new Set(windowDays(c));
  for (const d of days) {
    if (holdout.has(d)) throw new RangeError(`${d} is a day of the sealed window: never run or shown before its one run`);
    if (!window.has(d)) throw new RangeError(`${d} is not a decision day of the window`);
  }
  for (const t of trades) if (t.openedAt >= first || t.closedAt >= first) throw new RangeError('a trial trade reaches the sealed window');
};

export interface TrialInput {
  readonly parts: readonly TrialPart[];
  readonly config: StudyConfig;
  readonly policy: Policy;
  readonly fills: FillConfig;
  readonly solUsd: OffchainSeries;
  readonly commit: string;
  readonly generatedAt: string;
}

/** The cumulative trial report. Throws on a holdout day, a day in two parts, parts of different commits, or a run that was not clean. */
export const trialReport = (i: TrialInput): BacktestReportV1 => {
  if (i.parts.length === 0) throw new RangeError('no trial parts');
  const days = i.parts.flatMap((p) => p.days).sort();
  if (new Set(days).size !== days.length) throw new RangeError('a day appears in two trial parts');
  for (const p of i.parts) {
    if (p.kind !== 'BT-2 trial part') throw new RangeError(`${p.runId} is not a trial part`);
    if (p.commit !== i.commit) throw new RangeError(`${p.runId} ran on ${p.commit}, the report is for ${i.commit}`);
    assertPractice(i.config, p.days, p.trades);
  }
  const all = i.parts.flatMap((p) => p.trades);
  const group = (tag: string) => all.filter((t) => t.tag === tag).map(fromPartTrade);
  const sum = (f: (p: TrialPart) => number) => i.parts.reduce((s, p) => s + f(p), 0);
  const ok = (f: (p: TrialPart) => boolean) => i.parts.every(f);
  const g0: ReportGate = {
    mode: 'backtest', gate: 'G0', state: ok((p) => p.engine.crashes === 0 && p.engine.illegalStates === 0 && p.engine.unreconciledIntents === 0 && p.engine.identicalReplays && p.engine.leak && p.engine.ledgerReplay) ? 'pass' : 'fail',
    checks: [
      { mode: 'backtest', label: 'Crashes', value: String(sum((p) => p.engine.crashes)), limit: '0', pass: sum((p) => p.engine.crashes) === 0 },
      { mode: 'backtest', label: 'Illegal states', value: String(sum((p) => p.engine.illegalStates)), limit: '0', pass: sum((p) => p.engine.illegalStates) === 0 },
      { mode: 'backtest', label: 'Unfinished orders', value: String(sum((p) => p.engine.unreconciledIntents)), limit: '0', pass: sum((p) => p.engine.unreconciledIntents) === 0 },
      { mode: 'backtest', label: 'Same result on every replay', value: ok((p) => p.engine.identicalReplays) ? 'yes' : 'no', limit: 'yes', pass: ok((p) => p.engine.identicalReplays) },
      { mode: 'backtest', label: 'Future data test', value: ok((p) => p.engine.leak) ? 'passed' : 'failed', limit: 'passed', pass: ok((p) => p.engine.leak) },
      { mode: 'backtest', label: 'Ledger replay', value: ok((p) => p.engine.ledgerReplay) ? 'passed' : 'failed', limit: 'passed', pass: ok((p) => p.engine.ledgerReplay) },
    ],
  };
  const g1: ReportGate = {
    mode: 'backtest', gate: 'G1', state: 'not-run',
    checks: [
      { mode: 'backtest', label: 'Trial in progress', value: `${days[0]} to ${days[days.length - 1]} (${days.length} days)`, limit: 'not a verdict', pass: true },
      { mode: 'backtest', label: 'Practice days only', value: `before ${holdoutDaysOf(i.config)[0]}`, limit: 'later days stay sealed', pass: true },
      ...(i.parts.some((p) => p.regimeAssumedOn === true) ? [{ mode: 'backtest' as const, label: 'Regime gate', value: 'assumed on', limit: 'inputs not produced yet', pass: false }] : []),
    ],
  };
  const from = dayStart(days[0]!);
  const to = dayStart(days[days.length - 1]!) + 86_400_000;
  const s0 = [...group('S0-U1'), ...group('S0-U2')].sort((a, b) => a.closedAt - b.closedAt || (a.id < b.id ? -1 : 1));
  const groups = [
    ...(['U1', 'U2'] as const).map((u) => ({ group: u, trades: group(u), stray: [] })),
    { group: 'S0' as const, trades: s0, stray: [] },
  ];
  return buildReport({
    runId: `trial-${days[0]}-${days[days.length - 1]}-${i.commit.slice(0, 8)}`, generatedAt: i.generatedAt, codeCommit: i.commit, policy: i.policy, fills: i.fills,
    dataset: { id: [...new Set(i.parts.map((p) => p.datasetId))].sort().join(','), from, to },
    engine: {
      replays: Math.min(...i.parts.map((p) => p.engine.replays)), identicalReplays: ok((p) => p.engine.identicalReplays),
      crashes: sum((p) => p.engine.crashes), illegalStates: sum((p) => p.engine.illegalStates), unreconciledIntents: sum((p) => p.engine.unreconciledIntents),
    },
    solUsd: i.solUsd, candidates: sum((p) => p.candidates), entries: sum((p) => p.entries), groups, gates: [g0, g1],
  });
};
